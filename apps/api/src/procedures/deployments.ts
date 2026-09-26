/**
 * Deployment and audit procedures.
 *
 * A client can request a deployment and read its state; it can never set the
 * state. The status column is written with the service-role connection the
 * browser does not have, and the only `succeeded` a procedure writes is one the
 * hosting adapter itself reported. An engine this deployment has no credentials
 * for leaves the row `not_configured` with the engine's own reason — a fact
 * about the deployment, not a customer error.
 *
 * Two rules keep a request from inventing work:
 *   * the row is written before the engine is called, so a request that dies
 *     mid-flight leaves a record rather than an invisible half-deployment;
 *   * a repeated idempotency key returns the original row and does not call the
 *     engine again, so a retried request cannot create a second deployment.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import { parseRootDirectory } from "../root-directory.js";
import { assertWithinBudget } from "./billing.js";
import type {
  AdapterResult,
  DeploymentId,
  EngineStatus,
  ExecutionModel,
  OrganizationId,
  ProjectId,
  ProviderRef,
  UserId,
} from "@cloud-wai/contracts";
import type { BuildPack, Engines, JobQueue, ServerlessArtifact } from "@cloud-wai/adapters";
import { BUILD_PACKS, deploymentEngineFor, runBuildStep } from "@cloud-wai/adapters";
import { DEPLOYMENT_JOB_KIND, type DeploymentJobPayload } from "@cloud-wai/contracts";
import type { AuditEvent, ControlPlaneWrites, DataStore, Deployment } from "@cloud-wai/database";
import type { RequestContext } from "../context.js";

/** A hosting operation is bounded; a hung engine must not hang a request. */
const ADAPTER_TIMEOUT_MS = 30_000;

/** The hosting engine this build wires (ADR-0002: Coolify behind HostingAdapter). */
const HOSTING_PROVIDER = "coolify";

/** The serverless engine this build wires (ADR-0017: Lambda behind ServerlessAdapter). */
const SERVERLESS_PROVIDER = "lambda";

/** A git branch, tag or commit: enough to name a revision, not a shell string. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A clone URL. Only the schemes Coolify accepts; never free text. */
const REPO_PATTERN = /^(https:\/\/|http:\/\/|git@)[^\s]{3,297}$/;

type DeploymentWrites = Pick<
  ControlPlaneWrites,
  | "createDeployment"
  | "updateDeploymentStatus"
  | "findDeploymentByIdempotencyKey"
  | "getProjectDeploymentTarget"
  | "setProjectProviderResource"
> &
  Pick<ControlPlaneWrites, "getDeployment">;

const REQUIRED_WRITES = [
  "createDeployment",
  "updateDeploymentStatus",
  "findDeploymentByIdempotencyKey",
  "getProjectDeploymentTarget",
  "setProjectProviderResource",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface DeploymentDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  /** Injected so a deployment id is a Cloud Wai UUID, not a provider artifact. */
  readonly newId: () => string;
  readonly now?: () => Date;
  /**
   * When present, a deploy or rollback is recorded as a durable job and the
   * engine work is enqueued for the worker rather than performed on the request
   * path. When absent (a test double, a first deployment) the procedure runs the
   * engine synchronously, which is the behaviour the deployment tests pin.
   *
   * The row is always written first and always on the request path — the queue
   * only decides who *executes* it, never whether it is recorded.
   */
  readonly queue?: JobQueue;
}

/**
 * The write half of the store, or an honest refusal.
 *
 * A store that can only read (a report, a first deployment) must not answer `ok`
 * for a deployment it never recorded, so the missing capability is reported as
 * `engine_unavailable` rather than swallowed into an empty success.
 */
function writesFor(deps: DeploymentDeps): DeploymentWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as DeploymentWrites;
}

type PreviewWrites = Pick<
  ControlPlaneWrites,
  "getPreviewTargetForService" | "createPreviewTarget" | "setPreviewTargetProvider"
>;

const REQUIRED_PREVIEW_WRITES = [
  "getPreviewTargetForService",
  "createPreviewTarget",
  "setPreviewTargetProvider",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

/** Whether this store can record a preview target at all. */
function previewWritesAvailable(deps: DeploymentDeps): boolean {
  return REQUIRED_PREVIEW_WRITES.every(
    (name) => typeof (deps.store as Partial<ControlPlaneWrites>)[name] === "function",
  );
}

/**
 * The write half for preview targets.
 *
 * A preview requested against a store that cannot record one is refused rather
 * than silently deployed against the production application — the dangerous
 * failure, and the reason this raises instead of falling back.
 */
function previewWritesFor(deps: DeploymentDeps): PreviewWrites {
  if (!previewWritesAvailable(deps)) {
    throw new ApiError("engine_unavailable", "This deployment cannot record preview targets yet.");
  }
  return deps.store as unknown as PreviewWrites;
}

/**
 * The stable key for a preview target.
 *
 * A pull request number wins over a branch, because two PRs can share a branch
 * name (a fork's `main`) while a PR number is unique per repository. Without
 * either, the commit is the only thing that distinguishes one build from
 * another. The result matches the SQL check: lower-case `[a-z0-9-]`, so a
 * branch is slugged rather than pasted.
 */
export function previewKeyFor(
  pullRequest: number | null,
  branch: string | null,
  commit: string | null,
): string {
  if (pullRequest !== null) return `pr-${pullRequest}`;
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100);
  if (branch) {
    const key = `branch-${slug(branch)}`;
    return key === "branch-" ? "branch-unknown" : key;
  }
  if (commit) {
    const short = commit
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 40);
    return short ? `commit-${short}` : "commit-unknown";
  }
  // A preview with no branch, PR or commit cannot be addressed; the caller
  // always supplies at least one, and this is the honest name when not.
  return "preview-unknown";
}

/**
 * Record a preview target if one does not exist yet.
 *
 * Shared by the Deploy-button path and the webhook receiver so the two cannot
 * diverge on what a preview target is. `find or create` keeps the first writer's
 * row, so two deliveries that race redeploy one application instead of leaking
 * two.
 */
export async function ensurePreviewTarget(
  store: Partial<ControlPlaneWrites>,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly previewKey: string;
    readonly branch: string | null;
    readonly pullRequest: number | null;
    readonly createdBy: UserId;
  },
): Promise<void> {
  if (
    typeof store.getPreviewTargetForService !== "function" ||
    typeof store.createPreviewTarget !== "function"
  ) {
    throw new ApiError("engine_unavailable", "This deployment cannot record preview targets yet.");
  }
  const existing = await store.getPreviewTargetForService(
    input.organizationId,
    input.projectId,
    input.previewKey,
  );
  if (!existing) {
    await store.createPreviewTarget(input);
  }
}

function normaliseIdempotencyKey(value: string | undefined, newId: () => string): string {
  const key = value?.trim();
  if (!key) return newId();
  if (key.length > 200) throw new ApiError("invalid_input", "The idempotency key is too long.");
  return key;
}

/** An optional git ref: absent stays absent, present must be a real ref. */
function optionalRef(value: string | undefined, label: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!REF_PATTERN.test(trimmed)) {
    throw new ApiError("invalid_input", `${label} is not a valid git reference.`);
  }
  return trimmed;
}

function optionalRepository(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!REPO_PATTERN.test(trimmed)) {
    throw new ApiError("invalid_input", "Repository must be an https://, http:// or git@ URL.");
  }
  return trimmed;
}

/**
 * A build pack, checked against the list the engine accepts.
 *
 * The type is a union, so TypeScript callers cannot send a stray value — but the
 * procedure is reachable over HTTP, where the body is whatever the caller typed.
 * An unknown pack is refused here rather than forwarded to the engine, which
 * would reject it later with a message about its own internals.
 */
function optionalBuildPack(value: string | undefined): BuildPack | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!(BUILD_PACKS as readonly string[]).includes(trimmed)) {
    throw new ApiError("invalid_input", `Build pack must be one of: ${BUILD_PACKS.join(", ")}.`);
  }
  return trimmed as BuildPack;
}

export async function listDeployments(
  ctx: RequestContext,
  deps: DeploymentDeps,
  projectId: ProjectId,
): Promise<readonly Deployment[]> {
  const project = await deps.store.getProject(ctx.principal.userId, projectId);
  if (!project) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, project.organizationId, "deployment:read");
  return deps.store.listDeployments(ctx.principal.userId, projectId);
}

export async function listAuditEvents(
  ctx: RequestContext,
  deps: DeploymentDeps,
  organizationId: OrganizationId,
): Promise<readonly AuditEvent[]> {
  requireCapability(ctx, organizationId, "audit:read");
  return deps.store.listAuditEvents(ctx.principal.userId, organizationId);
}

export interface CreateDeploymentInput {
  readonly projectId: ProjectId;
  /** Client-supplied; replaying it returns the original deployment. */
  readonly idempotencyKey?: string | undefined;
  readonly gitRepository?: string | undefined;
  readonly gitBranch?: string | undefined;
  readonly commit?: string | undefined;
  readonly buildPack?: BuildPack | undefined;
  /**
   * The monorepo subdirectory to build from, for a repository that hosts several
   * apps. Absent means the project's own `rootDirectory`, and then the
   * repository root.
   */
  readonly rootDirectory?: string | undefined;
  /**
   * `production` (the default) or `preview`.
   *
   * A preview build gets its own engine application, keyed by the branch, so two
   * branches of one project do not overwrite each other. It is a request
   * attribute: the caller may choose to build a preview, but cannot claim the
   * engine succeeded.
   */
  readonly kind?: "production" | "preview" | undefined;
  /**
   * Build this production deployment without making it live (Vercel's
   * `--skip-domain`).
   *
   * The worker skips the auto-promote, so the build settles `succeeded` and
   * not-current until `deployments.promote` moves the pointer. It is refused on
   * a preview, where "live" has no meaning — a preview always has its own URL.
   */
  readonly staged?: boolean | undefined;
  /** The pull request a preview build came from, when it came from one. */
  readonly pullRequest?: number | undefined;
}

export interface RollbackDeploymentInput {
  readonly projectId: ProjectId;
  /** Coolify refuses a rollback without the git ref to return to. */
  readonly commit?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface DeploymentLogsInput {
  readonly projectId: ProjectId;
  readonly deploymentId: string;
}

export interface CancelDeploymentInput {
  readonly projectId: ProjectId;
  readonly deploymentId: string;
}

export interface PromoteDeploymentRequest {
  readonly projectId: ProjectId;
  /** The succeeded production deployment to make live. */
  readonly deploymentId: string;
}

export interface PromoteDeploymentOutcome {
  readonly deployment: Deployment;
  /** The deployment that was live before, so the UI can name what changed. */
  readonly previousDeploymentId: string | null;
}

export interface CancelDeploymentResult {
  readonly deployment: Deployment;
  /** The engine's own words when it could not act, for an honest UI. */
  readonly engineReason: string | null;
}

export interface RedeployDeploymentInput {
  readonly projectId: ProjectId;
  /** The past deployment whose source is being replayed. */
  readonly deploymentId: string;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Request a fresh build of a past deployment's source.
 *
 * This is Vercel's "Redeploy" (P27), and it is deliberately not a rollback: a
 * rollback returns the engine to a revision it already built, while a redeploy
 * asks for a new build of the same source. They are different operations and the
 * dashboard keeps them apart.
 *
 * The procedure is a *replay*, not a second deploy path. It reads the source the
 * row recorded (repository, branch, build pack, preview target) and hands it to
 * the same `requestDeployment` the Deploy button uses, so authorization,
 * idempotency, the budget check, preview bookkeeping and the audit row are the
 * one set of rules — a redeploy cannot drift from a deploy because it does not
 * reimplement any of them.
 *
 * Two honest refusals, neither a fabricated success:
 *
 *   * a row with no recorded source (a rollback, or one written before the
 *     source was stored) cannot be replayed — the operator is told to deploy
 *     with an explicit repository instead of being handed a build of nothing;
 *   * the caller gets a fresh idempotency key, so a redeploy is a new deployment
 *     rather than a replay of the original row (which would return the old row
 *     and deploy nothing).
 *
 * The engine builds the *branch's current head*, not the original commit: that
 * is what a redeploy is, and the UI says so rather than implying a
 * byte-for-byte reproduction. Pinning the exact revision is Rollback's job.
 */
export async function redeployDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: RedeployDeploymentInput,
): Promise<DeploymentRequestResult> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:create");

  const store = writesFor(deps);
  if (typeof store.getDeployment !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read a deployment yet.");
  }

  const source = await store.getDeployment(
    ctx.principal.userId,
    input.deploymentId as DeploymentId,
  );
  // A deployment outside the tenant, or one that does not exist, is the same
  // answer: `not_found`, never a hint that another tenant's id is real.
  if (!source || source.projectId !== project.id) {
    throw new ApiError("not_found", "Deployment not found.");
  }

  // A row with no repository and no branch has nothing to replay. A rollback is
  // exactly that: it returns to a revision of a source the engine already holds,
  // so there is no repository recorded on the row itself.
  if (!source.gitRepository && !source.gitBranch) {
    throw new ApiError(
      "conflict",
      "This deployment recorded no source to replay. Deploy with an explicit repository instead.",
    );
  }

  return requestDeployment(ctx, deps, {
    projectId: project.id,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(source.gitRepository ? { gitRepository: source.gitRepository } : {}),
    ...(source.gitBranch ? { gitBranch: source.gitBranch } : {}),
    ...(source.buildPack ? { buildPack: source.buildPack as BuildPack } : {}),
    ...(source.rootDirectory ? { rootDirectory: source.rootDirectory } : {}),
    kind: source.kind,
    // A redeploy repeats what the row was: a staged build stays staged, so the
    // replay does not silently make a release live that was deliberately held.
    ...(source.staged ? { staged: true } : {}),
    ...(source.pullRequest !== null ? { pullRequest: source.pullRequest } : {}),
  });
}

/**
 * Cancel an in-flight deployment.
 *
 * The row is the precondition: a terminal deployment has nothing left to cancel,
 * so the request is refused rather than sent to an engine that would no-op. The
 * cancel is addressed by the row's *deployment* handle — Coolify cancels a
 * deployment by uuid — so a run that never reached the engine reports honestly
 * instead of cancelling an unrelated build.
 *
 * Cloud Wai has no `canceled` engine status; a cancelled run is written `failed`
 * with the reason, which is what it is: the work did not complete.
 */
export async function cancelDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: CancelDeploymentInput,
): Promise<CancelDeploymentResult> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:cancel");

  const store = writesFor(deps);
  if (typeof store.getDeployment !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read a deployment yet.");
  }

  const deployment = await store.getDeployment(
    ctx.principal.userId,
    input.deploymentId as DeploymentId,
  );
  // A deployment outside the tenant, or one that does not exist, is the same
  // answer: `not_found`, never a hint that another tenant's id is real.
  if (!deployment || deployment.projectId !== project.id) {
    throw new ApiError("not_found", "Deployment not found.");
  }

  if (deployment.status !== "pending" && deployment.status !== "running") {
    throw new ApiError(
      "conflict",
      `Only a pending or running deployment can be cancelled; this one is ${deployment.status}.`,
    );
  }

  const clock = deps.now ?? (() => new Date());
  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey: `cancel-${deployment.id}`,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  let engineReason: string | null = null;

  // Which engine can be asked to cancel is the project's execution model: a
  // serverless run is not a Coolify deployment, and asking Coolify to cancel it
  // would report on an engine that never ran it.
  const engine = deploymentEngineFor(deps.engines, project.executionModel);

  if (!deployment.deploymentResourceId) {
    // Nothing was sent to the engine, so there is no build to stop. The row is
    // still closed out honestly: a pending row that never reached the engine
    // must not sit `pending` forever.
    engineReason =
      "This deployment never reached the hosting engine, so there was no build to cancel.";
  } else {
    const ref: ProviderRef = {
      organizationId: project.organizationId,
      provider: (engine.model === "serverless"
        ? SERVERLESS_PROVIDER
        : HOSTING_PROVIDER) as ProviderRef["provider"],
      resourceType: "deployment",
      resourceId: deployment.deploymentResourceId,
    };
    const result = await engine.cancel(adapterCtx, ref);
    if (!result.ok) {
      // The engine refused or is unconfigured: keep the row where it is and
      // report why, rather than claiming a cancellation that did not happen.
      const unchanged = await store.updateDeploymentStatus({
        id: deployment.id,
        organizationId: project.organizationId,
        status: deployment.status,
        url: deployment.url,
        failureReason: result.reason,
        providerResourceId: deployment.providerResourceId,
        deploymentResourceId: deployment.deploymentResourceId,
        startedAt: clock().toISOString(),
        finishedAt: null,
      });
      return { deployment: unchanged ?? deployment, engineReason: result.reason };
    }
    engineReason = "Cancelled by the customer.";
  }

  // A cancelled run did not complete, so `failed` — never `succeeded`.
  const updated = await store.updateDeploymentStatus({
    id: deployment.id,
    organizationId: project.organizationId,
    status: "failed",
    url: deployment.url,
    failureReason: engineReason,
    providerResourceId: deployment.providerResourceId,
    deploymentResourceId: deployment.deploymentResourceId,
    startedAt: clock().toISOString(),
    finishedAt: clock().toISOString(),
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.cancelled",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: { projectId: project.id, status: updated?.status ?? "failed" },
  });

  return { deployment: updated ?? deployment, engineReason };
}

/**
 * Make one of a project's deployments live.
 *
 * This is Vercel's "Promote" and its "Instant Rollback" in one operation,
 * because they are the same move: point the production pointer at a build that
 * already succeeded. Nothing is rebuilt, so the artifact that goes live is byte
 * for byte the one that was reviewed — which is the entire reason the deployment
 * record is immutable.
 *
 * The rules that keep it honest:
 *   * only a `succeeded` `production` deployment may be promoted. A preview, a
 *     build still in flight, and a failed run are each refused with the reason,
 *     never silently promoted;
 *   * the row must belong to the project, and the project to the caller's
 *     organization — a deployment outside the tenant is `not_found`, exactly as
 *     everywhere else;
 *   * the move itself is one database transaction, so a reader never sees zero
 *     or two live deployments.
 */
export async function promoteDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: PromoteDeploymentRequest,
): Promise<PromoteDeploymentOutcome> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:rollback");

  const store = writesFor(deps);
  if (typeof store.getDeployment !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read a deployment yet.");
  }
  const promote = (deps.store as Partial<ControlPlaneWrites>).promoteDeployment;
  if (typeof promote !== "function") {
    throw new ApiError(
      "engine_unavailable",
      "This deployment cannot move a production pointer yet.",
    );
  }

  const deployment = await store.getDeployment(
    ctx.principal.userId,
    input.deploymentId as DeploymentId,
  );
  // A deployment outside the tenant, or one that does not exist, is the same
  // answer: `not_found`, never a hint that another tenant's id is real.
  if (!deployment || deployment.projectId !== project.id) {
    throw new ApiError("not_found", "Deployment not found.");
  }

  if (deployment.kind !== "production") {
    throw new ApiError(
      "conflict",
      "Only a production deployment can be live. A preview has its own URL and is never promoted.",
    );
  }
  if (deployment.status !== "succeeded") {
    throw new ApiError(
      "conflict",
      `Only a succeeded deployment can be promoted; this one is ${deployment.status}.`,
    );
  }

  const result = await promote({
    organizationId: project.organizationId,
    projectId: project.id,
    deploymentId: deployment.id,
  });

  // A refused move (an unexpected store answer) is reported as a conflict, not
  // as a promotion that happened.
  if (!result.deployment) {
    throw new ApiError("conflict", "The production pointer could not be moved.");
  }

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.promoted",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: {
      projectId: project.id,
      previousDeploymentId: result.previousDeploymentId,
    },
  });

  return {
    deployment: result.deployment,
    previousDeploymentId: result.previousDeploymentId,
  };
}

export interface DeploymentLogsResult {
  /** The engine's own log lines, verbatim — either a build log or a runtime tail. */
  readonly lines: readonly string[];
  /** The engine's cursor, or null when it has none (Coolify has none). */
  readonly cursor: string | null;
  /**
   * Which engine log this is. `deployment` is the build/deploy log for the
   * specific run (where a failed build is explained); `application` is the
   * running container's output; null when neither was resolvable.
   */
  readonly source: "deployment" | "application" | null;
  /** The engine's own words when it could not serve logs. */
  readonly engineReason: string | null;
}

/**
 * Read a deployment's engine logs.
 *
 * Logs live at the hosting engine, so this resolves the project's engine-side
 * application and asks the adapter. An engine this deployment has no credentials
 * for, or a project that was never deployed, returns an honest reason with no
 * lines — never fabricated output. The lines are the customer's own application
 * logs; they are returned verbatim, exactly as the engine reports them.
 */
export async function deploymentsLogs(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: DeploymentLogsInput,
): Promise<DeploymentLogsResult> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:read");

  // Prefer the engine's *deployment* handle recorded on the row: only it
  // addresses the build/deploy log, which is what a failed build writes to.
  // `getDeployment` is a member-scoped read, so asking for another tenant's
  // deployment id returns null rather than its logs.
  const writes = writesFor(deps);
  const deployment =
    typeof writes.getDeployment === "function"
      ? await writes.getDeployment(ctx.principal.userId, input.deploymentId as DeploymentId)
      : null;

  const applicationTarget = await writes.getProjectDeploymentTarget(
    ctx.principal.userId,
    project.id,
  );

  let ref: ProviderRef | null = null;
  let source: "deployment" | "application" | null = null;
  const model = applicationTarget?.executionModel ?? project.executionModel;
  const provider = model === "serverless" ? SERVERLESS_PROVIDER : HOSTING_PROVIDER;
  if (deployment?.deploymentResourceId) {
    ref = {
      organizationId: project.organizationId,
      provider: provider as ProviderRef["provider"],
      resourceType: "deployment",
      resourceId: deployment.deploymentResourceId,
    };
    source = "deployment";
  } else if (applicationTarget?.providerResourceId) {
    ref = {
      organizationId: project.organizationId,
      provider: (applicationTarget.provider ?? provider) as ProviderRef["provider"],
      resourceType: "application",
      resourceId: applicationTarget.providerResourceId,
    };
    source = "application";
  }

  if (!ref || !source) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: "This project has no application on the hosting engine yet, so it has no logs.",
    };
  }

  // Logs come from the project's own execution model: a serverless function's
  // logs live on the serverless engine, never on Coolify.
  const engine = deploymentEngineFor(deps.engines, model);
  const result = await engine.getLogs(
    {
      organizationId: project.organizationId,
      idempotencyKey: `logs-${input.deploymentId}`,
      timeoutMs: ADAPTER_TIMEOUT_MS,
    },
    ref,
  );

  if (!result.ok) {
    return { lines: [], cursor: null, source, engineReason: result.reason };
  }
  return { lines: result.value.lines, cursor: result.value.cursor, source, engineReason: null };
}

export interface DeploymentRequestResult {
  readonly deployment: Deployment;
  /** True when this call replayed an existing idempotency key. */
  readonly replayed: boolean;
  /** The engine's own words when it could not act, for an honest UI. */
  readonly engineReason: string | null;
}

/**
 * Request a deployment.
 *
 * The engine-side application is created on the first deployment and its
 * reference is remembered on the project, so a second deployment does not create
 * a second application. Whatever the adapter reports becomes the row's status —
 * including `not_configured`, which is the honest state of a deployment with no
 * hosting credentials.
 */
export async function requestDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: CreateDeploymentInput,
): Promise<DeploymentRequestResult> {
  const clock = deps.now ?? (() => new Date());

  // Authorization first. A stranger must get `not_found`, never a hint about
  // whether this deployment can write.
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:create");

  const store = writesFor(deps);

  const gitBranch = optionalRef(input.gitBranch, "Branch");
  const commit = optionalRef(input.commit, "Commit");
  const gitRepository = optionalRepository(input.gitRepository);
  const buildPack = optionalBuildPack(input.buildPack);
  // The request's own value wins; otherwise the project's setting; otherwise the
  // repository root. Resolved once here so the row, the job payload and the
  // engine all see the same directory.
  const rootDirectory =
    input.rootDirectory !== undefined
      ? parseRootDirectory(input.rootDirectory)
      : project.rootDirectory;

  // A preview build is identified by its *target* — the pull request, or the
  // branch — not by the delivery, so pushing twice to one branch redeploys the
  // same engine application rather than creating a second one. A production
  // build has no preview key.
  const kind = input.kind === "preview" ? "preview" : "production";
  const pullRequest =
    kind === "preview" && typeof input.pullRequest === "number" && input.pullRequest > 0
      ? Math.floor(input.pullRequest)
      : null;
  const previewKey = kind === "preview" ? previewKeyFor(pullRequest, gitBranch, commit) : null;

  // A staged build is a production build that is not made live. Staging a
  // preview is meaningless — a preview is never live — so it is refused rather
  // than silently accepted and ignored.
  if (input.staged === true && kind !== "production") {
    throw new ApiError(
      "invalid_input",
      "Only a production deployment can be staged; a preview always has its own URL.",
    );
  }
  const staged = kind === "production" && input.staged === true;

  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey, deps.newId);
  const existing = await store.findDeploymentByIdempotencyKey(
    ctx.principal.userId,
    project.organizationId,
    idempotencyKey,
  );
  if (existing) {
    // A key names one request. If it was first used for another project, the
    // stored row is not this caller's operation: returning it would answer a
    // deploy of project B with a deployment of project A and skip B entirely.
    // The unique key is per organization, so the collision is real and refused.
    if (existing.projectId !== project.id) {
      throw new ApiError(
        "conflict",
        "This idempotency key was already used for a deployment in another project.",
      );
    }
    return { deployment: existing, replayed: true, engineReason: existing.failureReason };
  }

  // A hard spend cap is checked *before* the row is written and before any job
  // is enqueued: the point of a cap is that the work does not start. A soft
  // budget blocks nothing, so this is a no-op unless a hard cap is reached.
  await assertWithinBudget({ store: deps.store }, project.organizationId, "deployments");

  // The row exists before the engine is called: a request that dies mid-flight
  // leaves a record, not an invisible half-deployment.
  let deployment = await store.createDeployment({
    organizationId: project.organizationId,
    projectId: project.id,
    idempotencyKey,
    requestedBy: ctx.principal.userId,
    status: "pending",
    provider: HOSTING_PROVIDER,
    providerResourceId: null,
    url: null,
    failureReason: null,
    kind,
    staged,
    gitBranch,
    gitCommit: commit,
    pullRequest,
    previewKey,
    gitRepository,
    buildPack,
    rootDirectory,
  });

  // A preview build needs its target recorded before the worker runs, so two
  // deliveries that race cannot each create an engine application. `find or
  // create` keeps the first writer's row; the loser redeploys the same app.
  if (kind === "preview" && previewKey) {
    await ensurePreviewTarget(deps.store, {
      organizationId: project.organizationId,
      projectId: project.id,
      previewKey,
      branch: gitBranch,
      pullRequest,
      createdBy: ctx.principal.userId,
    });
  }

  // Durable path: record the command as a job and let the worker execute it.
  // The deployment stays `pending` — that is its honest state until the engine
  // answers. The idempotency key is shared, so a retried request replays the row
  // above and never enqueues a second job.
  if (deps.queue) {
    const payload: DeploymentJobPayload = {
      deploymentId: deployment.id,
      organizationId: project.organizationId,
      projectId: project.id,
      action: "create",
      projectSlug: project.slug,
      gitRepository,
      gitBranch,
      buildPack,
      rootDirectory,
      commit,
      kind,
      staged,
      previewKey,
    };
    await deps.queue.enqueue({
      organizationId: project.organizationId,
      kind: DEPLOYMENT_JOB_KIND,
      payload,
      idempotencyKey,
    });
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "deployment.enqueued",
      targetType: "deployment",
      targetId: deployment.id,
      metadata: {
        projectId: project.id,
        idempotencyKey,
        ...(gitBranch ? { branch: gitBranch } : {}),
        ...(commit ? { commit } : {}),
      },
    });
    return { deployment, replayed: false, engineReason: null };
  }

  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  // A preview build resolves its application from the preview target, and a
  // production build from the project. The two must not share a handle: a
  // preview deploy that reused the production application would ship a feature
  // branch to the production URL, which is the whole thing previews exist to
  // avoid.
  let application: ProviderRef | null = null;
  const applicationName =
    kind === "preview" && previewKey ? `${project.slug}-${previewKey}` : project.slug;

  /**
   * The execution model for this deploy.
   *
   * A production deploy runs the project's own model. A preview is a container
   * concept — a branch build of a long-lived application — so it is container
   * even when the project's production model is serverless, and it is never
   * routed to the serverless engine that has no notion of a preview.
   */
  let executionModel: ExecutionModel = "container";

  if (kind === "preview" && previewKey && previewWritesAvailable(deps)) {
    const targetWrites = previewWritesFor(deps);
    const target = await targetWrites.getPreviewTargetForService(
      project.organizationId,
      project.id,
      previewKey,
    );
    if (target?.providerResourceId) {
      application = {
        organizationId: project.organizationId,
        provider: (target.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
        resourceType: "application",
        resourceId: target.providerResourceId,
      };
    }
  } else {
    const probe = await store.getProjectDeploymentTarget(ctx.principal.userId, project.id);
    executionModel = probe?.executionModel ?? project.executionModel;
    application = probe?.providerResourceId
      ? {
          organizationId: project.organizationId,
          provider: (probe.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
          resourceType: "application",
          resourceId: probe.providerResourceId,
        }
      : null;
  }

  // Which engine runs this deploy is decided once, from the execution model, and
  // never by the caller. A serverless project is not handed to the container
  // engine, and a serverless engine that is not configured reports its own
  // `not_configured` rather than a container build reported as a success.
  const engine = deploymentEngineFor(deps.engines, executionModel);

  let engineReason: string | null = null;
  let nextStatus: EngineStatus = "pending";
  let url: string | null = null;
  let deploymentResourceId: string | null = null;

  if (!application) {
    const created = await engine.ensureTarget(adapterCtx, {
      name: applicationName,
      gitRepository: gitRepository ?? null,
      gitBranch: gitBranch ?? null,
      buildPack,
      rootDirectory,
    });
    if (!created.ok) {
      engineReason = created.reason;
      nextStatus = created.status;
    } else {
      application = created.value.providerRef;
      if (kind === "preview" && previewKey && previewWritesAvailable(deps)) {
        await previewWritesFor(deps).setPreviewTargetProvider({
          organizationId: project.organizationId,
          projectId: project.id,
          previewKey,
          provider: application.provider,
          providerResourceId: application.resourceId,
        });
      } else {
        await store.setProjectProviderResource({
          organizationId: project.organizationId,
          projectId: project.id,
          provider: application.provider,
          providerResourceId: application.resourceId,
        });
      }
    }
  }

  if (application) {
    // A serverless deploy needs a built artifact; the container engine builds for
    // itself, so the step runs only where it is required. Both the synchronous
    // path here and the worker's durable path call the same shared step, so the
    // two cannot diverge on how a build is run (ADR-0018).
    let artifact: ServerlessArtifact | undefined;
    if (engine.model === "serverless") {
      const built = await runBuildStep(
        { build: deps.engines.build },
        {
          organizationId: project.organizationId,
          idempotencyKey: `${idempotencyKey}:build`,
          timeoutMs: adapterCtx.timeoutMs,
          repository: gitRepository ?? null,
          branch: gitBranch ?? null,
          buildPack,
          rootDirectory,
        },
      );
      if (!built.ok) {
        // No artifact means nothing to deploy. Deploying anyway would publish
        // whatever the function last held and report it as this build's result.
        engineReason = built.reason;
        nextStatus = "failed";
      } else {
        artifact = built.artifact;
      }
    }

    const deployed: AdapterResult<{ providerRef: ProviderRef }> =
      artifact === undefined && engine.model === "serverless"
        ? { ok: false, status: "failed", reason: engineReason ?? "The build produced no artifact." }
        : await engine.deploy(adapterCtx, application, artifact);
    if (!deployed.ok) {
      engineReason = deployed.reason;
      nextStatus = deployed.status;
    } else {
      // A queued deployment is `running`, never `succeeded`: the engine has not
      // finished when it answers. Read the state back so the row reflects the
      // engine rather than the request.
      nextStatus = deployed.status;
      // The engine returns a *deployment* ref here; its uuid is what addresses
      // the build/deploy log, so it is recorded for the logs procedure.
      deploymentResourceId = deployed.value.providerRef.resourceId;
      const state = await engine.getDeployment(adapterCtx, deployed.value.providerRef);
      if (state.ok) {
        nextStatus = state.value.status;
        url = state.value.url;
      }
    }
  }

  deployment = await persistTransition(store, clock, deployment, {
    organizationId: project.organizationId,
    status: nextStatus,
    url,
    failureReason: engineReason,
    providerResourceId: application?.resourceId ?? null,
    deploymentResourceId,
  });

  // A production build the engine confirmed is live immediately — the same move
  // `deployments.promote` makes, so the synchronous and durable paths agree. A
  // preview is never promoted, and a *staged* production build is deliberately
  // held back (`--skip-domain`) until someone promotes it.
  if (nextStatus === "succeeded" && kind === "production" && !staged) {
    const promote = (deps.store as Partial<ControlPlaneWrites>).promoteDeployment;
    if (typeof promote === "function") {
      await promote({
        organizationId: project.organizationId,
        projectId: project.id,
        deploymentId: deployment.id,
      });
    }
  }

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.created",
    targetType: "deployment",
    targetId: deployment.id,
    // Branch and commit only. The repository URL can carry credentials in its
    // userinfo, so it never reaches an audit row.
    metadata: {
      projectId: project.id,
      status: nextStatus,
      idempotencyKey,
      ...(gitBranch ? { branch: gitBranch } : {}),
      ...(commit ? { commit } : {}),
    },
  });

  return { deployment, replayed: false, engineReason };
}

/**
 * Roll a project back to a git revision.
 *
 * The rollback is recorded as its own deployment row, so the history shows the
 * rollback rather than silently rewriting the deployment it undid. An engine
 * that refuses (or is unconfigured) leaves the row honestly non-successful.
 */
export async function rollbackDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: RollbackDeploymentInput,
): Promise<DeploymentRequestResult> {
  const clock = deps.now ?? (() => new Date());

  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:rollback");

  const store = writesFor(deps);

  const commit = input.commit?.trim() ?? "";
  if (!REF_PATTERN.test(commit)) {
    throw new ApiError("invalid_input", "A rollback needs the commit to return to.");
  }

  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey, deps.newId);
  const existing = await store.findDeploymentByIdempotencyKey(
    ctx.principal.userId,
    project.organizationId,
    idempotencyKey,
  );
  if (existing) {
    // Same rule as a deploy: a key reused across projects must not answer a
    // rollback of project B with an operation from project A.
    if (existing.projectId !== project.id) {
      throw new ApiError(
        "conflict",
        "This idempotency key was already used for a deployment in another project.",
      );
    }
    return { deployment: existing, replayed: true, engineReason: existing.failureReason };
  }

  let deployment = await store.createDeployment({
    organizationId: project.organizationId,
    projectId: project.id,
    idempotencyKey,
    requestedBy: ctx.principal.userId,
    status: "pending",
    provider: HOSTING_PROVIDER,
    providerResourceId: null,
    url: null,
    failureReason: null,
  });

  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  const target = await store.getProjectDeploymentTarget(ctx.principal.userId, project.id);

  // Durable path: same shape as a deploy. A rollback is recorded as a job and
  // executed by the worker; the row stays `pending` until the engine answers.
  if (deps.queue) {
    const payload: DeploymentJobPayload = {
      deploymentId: deployment.id,
      organizationId: project.organizationId,
      projectId: project.id,
      action: "rollback",
      projectSlug: project.slug,
      gitRepository: null,
      gitBranch: null,
      buildPack: null,
      // A rollback returns to a revision the engine already holds, so it has no
      // source of its own to build from — and no root directory either.
      rootDirectory: null,
      commit,
      // A rollback targets the production application, never a preview.
      kind: "production",
      // A rollback is the opposite of staging: it returns the live pointer to a
      // revision, so it always takes effect.
      staged: false,
      previewKey: null,
    };
    await deps.queue.enqueue({
      organizationId: project.organizationId,
      kind: DEPLOYMENT_JOB_KIND,
      payload,
      idempotencyKey,
    });
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "deployment.rollback_enqueued",
      targetType: "deployment",
      targetId: deployment.id,
      metadata: { projectId: project.id, commit, idempotencyKey },
    });
    return { deployment, replayed: false, engineReason: null };
  }

  let engineReason: string | null = null;
  let nextStatus: EngineStatus = "pending";
  let url: string | null = null;
  let providerResourceId: string | null = target?.providerResourceId ?? null;
  let deploymentResourceId: string | null = null;

  // A rollback goes to the engine that owns the project's execution model. On a
  // serverless project the router reports `not_configured` (a rollback is a
  // container operation), never a Coolify rollback of a project that runs on
  // Lambda.
  const engine = deploymentEngineFor(
    deps.engines,
    target?.executionModel ?? project.executionModel,
  );

  if (!target?.providerResourceId) {
    engineReason =
      "This project has no application on the hosting engine yet, so there is nothing to roll back.";
    nextStatus = "not_configured";
  } else {
    const applicationRef: ProviderRef = {
      organizationId: project.organizationId,
      provider: (target.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
      resourceType: "application",
      resourceId: target.providerResourceId,
    };
    const result = await engine.rollback(adapterCtx, { ref: applicationRef, commit });
    if (!result.ok) {
      engineReason = result.reason;
      nextStatus = result.status;
    } else {
      nextStatus = result.status;
      providerResourceId = result.value.providerRef.resourceId;
      if (result.value.providerRef.resourceType === "deployment") {
        deploymentResourceId = result.value.providerRef.resourceId;
      }
      const state = await engine.getDeployment(adapterCtx, result.value.providerRef);
      if (state.ok) {
        nextStatus = state.value.status;
        url = state.value.url;
      }
    }
  }

  deployment = await persistTransition(store, clock, deployment, {
    organizationId: project.organizationId,
    status: nextStatus,
    url,
    failureReason: engineReason,
    providerResourceId,
    deploymentResourceId,
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.rolled_back",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: { projectId: project.id, status: nextStatus, commit, idempotencyKey },
  });

  return { deployment, replayed: false, engineReason };
}

/**
 * Write a state transition, keeping the row if the write is refused.
 *
 * A store that declines the update (a row outside the tenant, a race) must not
 * turn into a thrown 500 after the engine was already asked to act: the
 * deployment that exists is the more useful answer, and its status is still the
 * honest one from the engine.
 */
async function persistTransition(
  store: DeploymentWrites,
  clock: () => Date,
  current: Deployment,
  input: {
    readonly organizationId: OrganizationId;
    readonly status: EngineStatus;
    readonly url: string | null;
    readonly failureReason: string | null;
    readonly providerResourceId: string | null;
    readonly deploymentResourceId?: string | null;
  },
): Promise<Deployment> {
  const startedAt = clock().toISOString();
  const terminal = input.status !== "pending" && input.status !== "running";
  const updated = await store.updateDeploymentStatus({
    id: current.id,
    organizationId: input.organizationId,
    status: input.status,
    url: input.url,
    failureReason: input.failureReason,
    providerResourceId: input.providerResourceId,
    deploymentResourceId: input.deploymentResourceId ?? null,
    startedAt,
    finishedAt: terminal ? startedAt : null,
  });
  return updated ?? current;
}

/** Exported for the boundary test: the deployment states a procedure may write. */
export const DEPLOYMENT_PROCEDURE_STATES: readonly EngineStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "degraded",
  "not_configured",
];

export type { AdapterResult };
