/**
 * The worker's deployment job: run the shared executor, then mirror the result.
 *
 * This is the production half of ADR-0006 phase 3's "deploy is recorded in
 * `orchestration_jobs`": the API enqueues `deployments.execute`, and this runs
 * it off the request path. The handler does the engine work; the applier writes
 * the deployment row. They are split so the processor can guarantee the job's own
 * state is persisted before the customer-facing row is touched.
 */
import type { AdapterResult, EngineStatus, DeploymentJobPayload } from "@cloud-wai/contracts";
import { err, ok, DEPLOYMENT_JOB_KIND } from "@cloud-wai/contracts";
import type { Job } from "@cloud-wai/adapters";
import type { JobHandler } from "./processor.js";
import {
  executeDeployment,
  type DeploymentExecutionResult,
  type DeploymentExecutorDeps,
} from "./deployment-executor.js";

export interface DeploymentJobOutcomeWriter {
  /**
   * Advance the deployment row from the executor's honest result.
   *
   * Scoped by organization: the write runs on the service role, so the tenant in
   * the where clause is what keeps it from crossing a boundary.
   */
  updateDeploymentStatus(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: EngineStatus;
    readonly url: string | null;
    readonly failureReason: string | null;
    readonly providerResourceId: string | null;
    /** The engine's deployment handle, persisted so its build log is addressable. */
    readonly deploymentResourceId?: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
  }): Promise<unknown>;
  /**
   * Point the project's domains at a deployment that just succeeded.
   *
   * A production deployment that the engine confirmed is live the moment it is
   * promoted, and Vercel's model is that a new production build becomes the live
   * one without a second click. The move is the same one `deployments.promote`
   * performs: it sets the pointer atomically. A preview is never promoted.
   */
  promoteDeployment(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly deploymentId: string;
  }): Promise<unknown>;
  /**
   * Record one unit of usage when the engine confirmed the deployment.
   *
   * Only a `succeeded` deployment is a unit the organization consumed; a failed
   * or `not_configured` run is recorded on its own row but is not billed.
   */
  recordUsage(input: {
    readonly organizationId: string;
    readonly metric: string;
    readonly quantity: number;
  }): Promise<unknown>;
}

export interface DeploymentJobDeps extends DeploymentExecutorDeps {
  readonly outcome: DeploymentJobOutcomeWriter;
  readonly now?: () => Date;
}

/**
 * Build the handler for `deployments.execute`.
 *
 * A success carries the executor's result as `value`, so the applier can persist
 * the engine's own url and provider reference rather than re-deriving them. A
 * non-success is an `err` carrying the engine's own reason. Note that a
 * deploy the engine reports as still `running` is not a success: the processor
 * requeues it, which is the honest state of work not yet finished.
 */
export function buildDeploymentJobHandler(deps: DeploymentJobDeps): JobHandler {
  return async (payload, ctx) => {
    const input = payload as DeploymentJobPayload;
    const result = await executeDeployment(
      {
        engines: deps.engines,
        writes: deps.writes,
        ...(deps.envVars ? { envVars: deps.envVars } : {}),
      },
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectSlug: input.projectSlug,
        deploymentId: input.deploymentId,
        idempotencyKey: ctx.idempotencyKey,
        action: input.action,
        gitRepository: input.gitRepository,
        gitBranch: input.gitBranch,
        buildPack: input.buildPack,
        // An older job row has no root directory; the project's setting is read
        // by the executor from the target it already resolves, so a null here is
        // not a lost monorepo directory.
        rootDirectory: input.rootDirectory ?? null,
        commit: input.commit,
        timeoutMs: ctx.timeoutMs,
        // An older job row (enqueued before previews existed) has neither field;
        // it is a production deploy, which is what the defaults say.
        kind: input.kind ?? "production",
        previewKey: input.previewKey ?? null,
      },
    );

    // A success carries the executor's result as `value`, so the applier can
    // persist the engine's own url and provider reference rather than
    // re-deriving them. A *non-terminal* result — the engine accepted the build
    // and is still working on it — is carried as `ok` too, so the applier
    // persists the engine's own deployment handle. Without that handle a
    // requeued attempt could not poll the build it already started and would
    // start a second one (see `resumeRunningDeployment`). The processor still
    // requeues it: it only completes on `succeeded`. A terminal failure is an
    // `err` carrying the engine's own reason.
    if (
      result.reason === null &&
      (result.status === "succeeded" || result.status === "running" || result.status === "pending")
    ) {
      return ok<DeploymentExecutionResult>(result.status, result);
    }
    return err(result.status, result.reason ?? `Deployment ended ${result.status}.`);
  };
}

/**
 * The applier the processor calls after a job settles.
 *
 * Every branch writes a row, including the failure branches: a deployment that
 * did not happen still has to say so, or the customer sees `pending` forever.
 */
export function buildDeploymentApplier(
  deps: DeploymentJobDeps,
): (job: Job, result: AdapterResult<unknown>) => Promise<void> {
  const clock = deps.now ?? (() => new Date());
  return async (job, result) => {
    if (job.kind !== DEPLOYMENT_JOB_KIND) return;
    const payload = job.payload as DeploymentJobPayload;
    const finished = clock().toISOString();

    if (result.ok) {
      const value = result.value as DeploymentExecutionResult | undefined;
      const finalStatus = value?.status ?? result.status;
      await deps.outcome.updateDeploymentStatus({
        id: payload.deploymentId,
        organizationId: payload.organizationId,
        status: finalStatus,
        url: value?.url ?? null,
        failureReason: null,
        providerResourceId: value?.providerResourceId ?? null,
        deploymentResourceId: value?.deploymentResourceId ?? null,
        startedAt: finished,
        finishedAt: isTerminal(finalStatus) ? finished : null,
      });
      // A production build the engine confirmed becomes the live one, exactly as
      // Vercel auto-aliases a new production deployment. A preview is never
      // promoted: its own URL is the point of a preview. The move is best-effort
      // with respect to the job's own success — a pointer that could not move is
      // reported by `deployments.rollback`'s read model, not by failing a
      // deployment that genuinely built.
      if (finalStatus === "succeeded") {
        // A staged production build is deliberately *not* made live: that is
        // what `--skip-domain` means, and it is the whole point of staging —
        // produce the release, inspect it, promote it in one click later. A
        // preview is never promoted either: its own URL is the point.
        const staged = payload.staged === true;
        if ((payload.kind ?? "production") === "production" && !staged) {
          await deps.outcome.promoteDeployment({
            organizationId: payload.organizationId,
            projectId: payload.projectId,
            deploymentId: payload.deploymentId,
          });
        }
        // A deployment the engine confirmed is one unit of usage. A run that is
        // still `running` is not counted here: the job is requeued and will be
        // counted once, when it finally settles as succeeded.
        await deps.outcome.recordUsage({
          organizationId: payload.organizationId,
          metric: "deployments",
          quantity: 1,
        });
      }
      return;
    }

    await deps.outcome.updateDeploymentStatus({
      id: payload.deploymentId,
      organizationId: payload.organizationId,
      status: result.status,
      url: null,
      failureReason: result.reason,
      providerResourceId: null,
      startedAt: finished,
      finishedAt: isTerminal(result.status) ? finished : null,
    });
  };
}

function isTerminal(status: EngineStatus): boolean {
  return status !== "pending" && status !== "running";
}
