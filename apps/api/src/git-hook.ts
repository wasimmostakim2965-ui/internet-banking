/**
 * The git webhook receiver.
 *
 * A push (or pull request) arrives at `POST /hooks/git/{organizationId}/{linkId}`.
 * This is the one HTTP route other than `/rpc` and `/healthz`, and it is
 * deliberately not an RPC procedure: the caller is a git provider, not a signed-
 * in member, so there is no session to resolve. Authentication is the delivery's
 * own HMAC over the raw body (or a shared token header), verified against the
 * secret stored for the link.
 *
 * What a verified delivery does is exactly what the Deploy button does: write a
 * deployment row and enqueue `deployments.execute`. Nothing about execution is
 * new here — only the trigger — so there is no second deploy path to keep
 * correct. `ensurePreviewTarget` and `previewKeyFor` are the same helpers the
 * procedure uses.
 *
 * Why the organization is in the URL path: the receiver must resolve the link,
 * and a link lookup that is not tenant-scoped would be a cross-tenant read. With
 * the organization in the path, every read in this module carries a tenant in
 * its where clause, and a delivery to `org A / link of org B` resolves nothing.
 *
 * The parse is deliberately small and shape-tolerant: providers disagree on
 * almost every field name, and a delivery whose shape is not understood is
 * ignored (2xx, no deployment) rather than guessed at.
 */
import type { ControlPlaneWrites, DataStore, ProjectGitLink } from "@cloud-wai/database";
import { DEPLOYMENT_JOB_KIND, type DeploymentJobPayload } from "@cloud-wai/contracts";
import type { JobQueue } from "@cloud-wai/adapters";
import type { SecretCipher } from "@cloud-wai/auth";
import { cloneUrlFor, verifyGitDelivery } from "./procedures/git-links.js";
import { ensurePreviewTarget, previewKeyFor } from "./procedures/deployments.js";

/** The hosting engine this build wires (ADR-0002: Coolify behind HostingAdapter). */
const HOSTING_PROVIDER = "coolify";

export interface GitHookDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly queue: JobQueue;
  readonly cipher: SecretCipher | null;
}

/** The writes the receiver needs. All service-scoped: it has no session. */
type HookWrites = Pick<
  ControlPlaneWrites,
  | "getGitLinkForService"
  | "getProjectForService"
  | "createDeployment"
  | "findDeploymentByIdempotencyKeyForService"
>;

const REQUIRED_WRITES = [
  "getGitLinkForService",
  "getProjectForService",
  "createDeployment",
  "findDeploymentByIdempotencyKeyForService",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

/**
 * The receiver's answer.
 *
 * The status codes are chosen so a provider's retry policy does the right thing:
 * a bad signature is 401 (do not retry; something is wrong), an unhandled event
 * is 202 (accepted and ignored), a replay is 200.
 */
export interface GitHookOutcome {
  readonly status: number;
  readonly body: { readonly ok: boolean; readonly reason?: string };
}

function writesFor(deps: GitHookDeps): HookWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`This deployment cannot receive a webhook: it cannot ${missing.join(", ")}.`);
  }
  return store as unknown as HookWrites;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A delivery parsed down to what a deployment needs. */
export interface ParsedGitDelivery {
  readonly branch: string | null;
  readonly commit: string | null;
  readonly pullRequest: number | null;
  readonly event: string;
  readonly isPullRequest: boolean;
}

/**
 * Parse a delivery body into the fields a deployment needs.
 *
 * Two families of shape are recognised: a push (`ref` for GitHub/GitLab,
 * `push.changes[]` for Bitbucket) and a pull request (`pull_request` for GitHub,
 * `object_attributes` for GitLab, `pullrequest` for Bitbucket). A body this does
 * not recognise parses to no branch and no commit, which the caller ignores —
 * never guesses.
 */
export function parseGitDelivery(eventHeader: string | null, body: string): ParsedGitDelivery {
  const unknown: ParsedGitDelivery = {
    branch: null,
    commit: null,
    pullRequest: null,
    event: "unknown",
    isPullRequest: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unknown;
  }
  const root = asRecord(parsed);
  if (!root) return unknown;

  // GitLab names the event in the body under `object_kind`; GitHub and Bitbucket
  // name it in a header. Either names the same thing.
  const objectKind = stringAt(root["object_kind"]);
  const event = (eventHeader ?? objectKind ?? "unknown").toLowerCase();

  const isPullRequest =
    event.includes("pull_request") ||
    event.includes("pullrequest") ||
    objectKind === "merge_request" ||
    root["pull_request"] !== undefined ||
    root["pullrequest"] !== undefined;

  if (isPullRequest) {
    const pr = asRecord(root["pull_request"]);
    const mr = asRecord(root["object_attributes"]);
    const bb = asRecord(root["pullrequest"]);
    const number = [pr?.["number"], mr?.["iid"], bb?.["id"]].find(
      (value) => typeof value === "number",
    );
    const branch =
      stringAt(asRecord(pr?.["head"])?.["ref"]) ??
      stringAt(mr?.["source_branch"]) ??
      stringAt(asRecord(asRecord(bb?.["source"])?.["branch"])?.["name"]);
    const commit =
      stringAt(asRecord(pr?.["head"])?.["sha"]) ??
      stringAt(asRecord(mr?.["last_commit"])?.["id"]) ??
      stringAt(asRecord(asRecord(bb?.["source"])?.["commit"])?.["hash"]);
    return {
      branch,
      commit,
      pullRequest: typeof number === "number" && number > 0 ? Math.floor(number) : null,
      event: "pull_request",
      isPullRequest: true,
    };
  }

  // A push. GitHub/GitLab name the ref `ref` (`refs/heads/main`); Bitbucket 1.x
  // names it `push.changes[].new.name`. Only a branch is taken, never a tag: a
  // tag push is not a deployment.
  const ref = stringAt(root["ref"]);
  let branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  if (branch === null) {
    const changes = asRecord(root["push"])?.["changes"];
    const first = Array.isArray(changes) ? changes[0] : undefined;
    branch = stringAt(asRecord(asRecord(first)?.["new"])?.["name"]);
  }
  const after = stringAt(root["after"]);
  const commit = after && /^[0-9a-f]{7,40}$/i.test(after) && !/^0+$/.test(after) ? after : null;
  return {
    branch,
    commit,
    pullRequest: null,
    event: event === "unknown" ? "push" : event,
    isPullRequest: false,
  };
}

/**
 * Handle a raw delivery for a link: verify it, then deploy what it asks for.
 *
 * The order is deliberate — verify first, resolve the project second, deploy
 * third — so an unauthenticated body can never cause a read or a write.
 */
export async function receiveGitDelivery(
  deps: GitHookDeps,
  input: {
    readonly organizationId: ProjectGitLink["organizationId"];
    readonly linkId: string;
    readonly event: string | null;
    readonly signature: string | null;
    readonly token: string | null;
    readonly body: string;
  },
): Promise<GitHookOutcome> {
  const verification = await verifyGitDelivery(
    { store: deps.store, newId: () => "", cipher: deps.cipher },
    {
      organizationId: input.organizationId,
      linkId: input.linkId,
      body: input.body,
      signature: input.signature,
      token: input.token,
    },
  );
  if (!verification.ok) {
    // One status for every signature refusal, so a prober learns only that the
    // delivery was not accepted — never which of the three things was wrong.
    if (verification.reason === "not_configured") {
      return { status: 503, body: { ok: false, reason: "not_configured" } };
    }
    return { status: 401, body: { ok: false, reason: "invalid_signature" } };
  }

  const delivery = parseGitDelivery(input.event, input.body);
  return deployFromDelivery(deps, verification.link, delivery);
}

/**
 * Deploy what an authenticated delivery asks for.
 *
 * Split from signature verification so both halves are testable without crypto:
 * this function is handed an already-verified link and decides only whether and
 * what to deploy.
 */
export async function deployFromDelivery(
  deps: GitHookDeps,
  link: ProjectGitLink,
  delivery: ParsedGitDelivery,
): Promise<GitHookOutcome> {
  const writes = writesFor(deps);

  const project = await writes.getProjectForService(link.organizationId, link.projectId);
  if (!project) {
    // A link whose project is gone is a stale row, not a reason to guess.
    return { status: 202, body: { ok: true, reason: "project_not_found" } };
  }

  if (delivery.branch === null && delivery.pullRequest === null) {
    // No branch and no PR: a shape this receiver does not deploy. Ignored, not
    // failed — the provider is not wrong, this delivery is simply not a build.
    return { status: 202, body: { ok: true, reason: "not_a_deployable_event" } };
  }

  // A push to the production branch is production; a pull request, or a push to
  // any other branch, is a preview.
  const kind: "production" | "preview" =
    delivery.pullRequest !== null || delivery.branch !== link.productionBranch
      ? "preview"
      : "production";

  if (kind === "preview" && !link.previewsEnabled) {
    return { status: 202, body: { ok: true, reason: "previews_disabled" } };
  }

  // A redelivered webhook must not build twice. The key is derived from what the
  // delivery *is* (the link, the target and the commit), not from the delivery
  // id, so a provider that retries still replays.
  const target =
    delivery.pullRequest !== null ? `pr-${delivery.pullRequest}` : `branch-${delivery.branch}`;
  const idempotencyKey = `webhook:${link.id}:${target}:${delivery.commit ?? "latest"}`;

  const existing = await writes.findDeploymentByIdempotencyKeyForService(
    link.organizationId,
    idempotencyKey,
  );
  if (existing) {
    return { status: 200, body: { ok: true, reason: "replayed" } };
  }

  const previewKey =
    kind === "preview"
      ? previewKeyFor(delivery.pullRequest, delivery.branch, delivery.commit)
      : null;

  // The engine is handed a *clone URL*, not the stored `owner/name`. The link
  // stores a normalised repository name (0011); Coolify clones from a URL, so
  // the two must not be conflated. `deploymentSourceForProject` makes the same
  // conversion for the Deploy button, and both go through `cloneUrlFor` so a
  // webhook and a manual deploy build from the same source.
  //
  // A `generic` link has no derivable host, so there is nothing honest to hand
  // the engine. The delivery is accepted (the provider is not wrong) and no
  // deployment is created, rather than a build attempted against a repository
  // name Coolify cannot resolve.
  const gitRepository = cloneUrlFor(link.provider, link.repository);
  if (!gitRepository) {
    return { status: 202, body: { ok: true, reason: "repository_url_unknown" } };
  }

  const deployment = await writes.createDeployment({
    organizationId: link.organizationId,
    projectId: link.projectId,
    idempotencyKey,
    // The provider is not a Cloud Wai member: the person who linked the
    // repository is the accountable actor for what it deploys.
    requestedBy: link.createdBy,
    status: "pending",
    provider: HOSTING_PROVIDER,
    providerResourceId: null,
    url: null,
    failureReason: null,
    kind,
    gitBranch: delivery.branch,
    gitCommit: delivery.commit,
    pullRequest: delivery.pullRequest,
    previewKey,
    gitRepository,
    // The webhook carries no root directory of its own: the project's setting is
    // the monorepo directory its builds use, whichever path triggered them.
    rootDirectory: project.rootDirectory,
  });

  if (kind === "preview" && previewKey) {
    await ensurePreviewTarget(deps.store, {
      organizationId: link.organizationId,
      projectId: link.projectId,
      previewKey,
      branch: delivery.branch,
      pullRequest: delivery.pullRequest,
      createdBy: link.createdBy,
    });
  }

  const payload: DeploymentJobPayload = {
    deploymentId: deployment.id,
    organizationId: link.organizationId,
    projectId: link.projectId,
    action: "create",
    projectSlug: project.slug,
    gitRepository,
    gitBranch: delivery.branch,
    buildPack: null,
    // A webhook builds the project's configured directory, if it has one.
    rootDirectory: project.rootDirectory,
    commit: delivery.commit,
    kind,
    // A push deploys the way the button does: it goes live on success. Staging
    // is a deliberate human step (`deployments.create` with `staged`).
    staged: false,
    previewKey,
  };
  await deps.queue.enqueue({
    organizationId: link.organizationId,
    kind: DEPLOYMENT_JOB_KIND,
    payload,
    idempotencyKey,
  });

  await deps.store.recordAuditEvent({
    organizationId: link.organizationId,
    // No member acted: a provider delivered. `actor_id` is null and the audit
    // row records that the trigger was a webhook, not a person.
    actorId: null,
    actorEmail: null,
    event: kind === "preview" ? "deployment.preview.triggered" : "deployment.triggered",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: {
      projectId: link.projectId,
      linkId: link.id,
      provider: link.provider,
      branch: delivery.branch,
      ...(delivery.commit ? { commit: delivery.commit } : {}),
      ...(delivery.pullRequest ? { pullRequest: delivery.pullRequest } : {}),
    },
  });

  return { status: 202, body: { ok: true } };
}
