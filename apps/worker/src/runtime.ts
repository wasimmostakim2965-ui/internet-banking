/**
 * The worker's production wiring: read config, build the queue and handlers,
 * and run the loop.
 *
 * This is the process a deployment runs. It is the only place that drains the
 * durable queue, and it is deliberately separate from the API so that an API
 * process that is busy or restarting never stops a deployment from making
 * progress. It fails closed the same way the API does: with no control-plane
 * database there is no queue to drain, so it refuses to start rather than
 * looping over nothing and looking healthy.
 */
import {
  buildDeploymentEngines,
  controlPlaneConfig,
  createPostgrestClient,
  createSupabaseControlPlaneStore,
  SqlJobQueue,
} from "@cloud-wai/database";
import { secretCipherFromEnv, type SecretCipher } from "@cloud-wai/auth";
import { randomUUID } from "node:crypto";
import {
  InProcessWorker,
  buildApplier,
  buildBackupApplier,
  buildBackupJobHandler,
  buildDeploymentApplier,
  buildDeploymentJobHandler,
  buildEnvVarSync,
  buildPolicyApplier,
  buildPolicyJobHandler,
  buildRestoreApplier,
  buildRestoreJobHandler,
  BACKUP_JOB_KIND,
  DEPLOYMENT_JOB_KIND,
  POLICY_JOB_KIND,
  RESTORE_JOB_KIND,
  type JobHandler,
  type JobOutcomeWriter,
} from "./index.js";

export interface WorkerStartupOptions {
  readonly env?: Record<string, string | undefined>;
  readonly newId?: () => string;
  /** Overridable so tests can drive the loop deterministically. */
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly signal?: AbortSignal;
  readonly onCycle?: (outcomes: number) => void;
}

export interface RunningWorker {
  readonly stop: () => Promise<void>;
}

export type WorkerStartupResult = RunningWorker | { readonly reason: string };

type Store = ReturnType<typeof createSupabaseControlPlaneStore>;
type Engines = ReturnType<typeof buildDeploymentEngines>;

interface WorkerWiring {
  readonly handlers: Record<string, JobHandler>;
  readonly apply: JobOutcomeWriter;
}

/**
 * Wire every durable command the API writes: deploy/rollback, backup and policy
 * distribution. Each kind gets its own handler and its own applier, and the
 * appliers are combined into the one the processor calls.
 *
 * Every write here runs on the service-role client that drains the queue. The
 * worker has no session, so `organization_id` in each write is the tenant
 * boundary that keeps a job from reaching across organizations.
 */
export function buildWorkerWiring(
  store: Store,
  engines: Engines,
  newId: () => string,
  now: () => Date,
  cipher: SecretCipher | null = null,
): WorkerWiring {
  const deploymentWrites = {
    getProjectDeploymentTargetForService: (organizationId: string, projectId: string) =>
      store.getProjectDeploymentTargetForService(organizationId, projectId),
    setProjectProviderResource: (input: Parameters<typeof store.setProjectProviderResource>[0]) =>
      store.setProjectProviderResource(input),
    getPreviewTargetForService: (organizationId: string, projectId: string, previewKey: string) =>
      store.getPreviewTargetForService(organizationId, projectId, previewKey),
    setPreviewTargetProvider: (input: Parameters<typeof store.setPreviewTargetProvider>[0]) =>
      store.setPreviewTargetProvider(input),
    // The resume read: a requeued deploy learns from its own row whether a build
    // is already in flight, so it polls that build instead of starting another.
    getDeploymentForService: async (organizationId: string, deploymentId: string) => {
      const found = await store.getDeploymentForService(organizationId, deploymentId);
      return found
        ? {
            status: found.status,
            providerResourceId: found.providerResourceId,
            deploymentResourceId: found.deploymentResourceId,
          }
        : null;
    },
  };
  const deploymentOutcome = {
    updateDeploymentStatus: (input: Parameters<typeof store.updateDeploymentStatus>[0]) =>
      store.updateDeploymentStatus(input),
    promoteDeployment: (input: Parameters<typeof store.promoteDeployment>[0]) =>
      store.promoteDeployment(input),
    recordUsage: (input: { organizationId: string; metric: string; quantity: number }) =>
      store.recordUsage(input),
  };
  const backupWrites = {
    getDataResourceForService: (organizationId: string, resourceId: string) =>
      store.getDataResourceForService(organizationId, resourceId),
    updateDataBackupStatus: (input: Parameters<typeof store.updateDataBackupStatus>[0]) =>
      store.updateDataBackupStatus(input),
    recordAuditEvent: (input: Parameters<typeof store.recordAuditEvent>[0]) =>
      store.recordAuditEvent(input),
    recordUsage: (input: { organizationId: string; metric: string; quantity: number }) =>
      store.recordUsage(input),
  };
  const restoreWrites = {
    getDataResourceForService: (organizationId: string, resourceId: string) =>
      store.getDataResourceForService(organizationId, resourceId),
    getDataBackupForService: (organizationId: string, backupId: string) =>
      store.getDataBackupForService(organizationId, backupId),
    updateDataRestoreStatus: (input: Parameters<typeof store.updateDataRestoreStatus>[0]) =>
      store.updateDataRestoreStatus(input),
    recordAuditEvent: (input: Parameters<typeof store.recordAuditEvent>[0]) =>
      store.recordAuditEvent(input),
  };
  const policyWrites = {
    getSecurityPolicyForService: (organizationId: string) =>
      store.getSecurityPolicyForService(organizationId),
    saveSecurityPolicy: (input: Parameters<typeof store.saveSecurityPolicy>[0]) =>
      store.saveSecurityPolicy(input),
    recordPolicyEvent: (input: Parameters<typeof store.recordPolicyEvent>[0]) =>
      store.recordPolicyEvent(input),
    recordAuditEvent: (input: Parameters<typeof store.recordAuditEvent>[0]) =>
      store.recordAuditEvent(input),
    // A rejected distribution becomes a grouped incident (S7). The store method
    // is service-role, matching the detector's sessionless position.
    openSecurityIncidentForService: (input: Parameters<
      typeof store.openSecurityIncidentForService
    >[0]) => store.openSecurityIncidentForService(input),
  };

  const handlers: Record<string, JobHandler> = {
    [DEPLOYMENT_JOB_KIND]: buildDeploymentJobHandler({
      engines,
      writes: deploymentWrites,
      outcome: deploymentOutcome,
      // Push the project's stored environment onto the application before it
      // builds, so a variable saved before the first deploy is present in it.
      // Null when no encryption key is set: nothing can be decrypted, so the
      // step is honestly absent rather than pretending to run.
      envVars: buildEnvVarSync({
        hosting: engines.hosting,
        store,
        cipher,
      }),
      now,
    }),
    [BACKUP_JOB_KIND]: buildBackupJobHandler({
      database: engines.database,
      writes: backupWrites,
      now,
    }),
    [RESTORE_JOB_KIND]: buildRestoreJobHandler({
      database: engines.database,
      writes: restoreWrites,
      now,
    }),
    [POLICY_JOB_KIND]: buildPolicyJobHandler({
      securityEdge: engines.securityEdge,
      writes: policyWrites,
      newId,
      now,
    }),
  };

  const apply = buildApplier(
    buildDeploymentApplier({
      engines,
      writes: deploymentWrites,
      outcome: deploymentOutcome,
      now,
    }),
    buildBackupApplier({ database: engines.database, writes: backupWrites, now }),
    buildRestoreApplier({ database: engines.database, writes: restoreWrites, now }),
    buildPolicyApplier({ securityEdge: engines.securityEdge, writes: policyWrites, newId, now }),
  );

  return { handlers, apply };
}

/**
 * Start the worker, or explain why it cannot start.
 *
 * The queue is drained in a loop with a reaper: a claim whose lease expired is
 * returned to the queue before the next claim, so a worker that dies mid-job
 * does not wedge that job forever.
 */
export async function startWorker(
  options: WorkerStartupOptions = {},
): Promise<WorkerStartupResult> {
  const env = options.env ?? process.env;

  const database = controlPlaneConfig(env);
  if (!database) {
    return {
      reason:
        "Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY so the worker can drain the control-plane queue.",
    };
  }

  const client = createPostgrestClient({
    url: database.url,
    serviceRoleKey: database.serviceRoleKey,
  });
  const newId = options.newId ?? (() => randomUUID());
  const store = createSupabaseControlPlaneStore({ client, newId });
  const engines = buildDeploymentEngines(env, store);
  const queue = new SqlJobQueue(client);
  const { handlers, apply } = buildWorkerWiring(
    store,
    engines,
    newId,
    () => new Date(),
    secretCipherFromEnv(env),
  );

  const worker = new InProcessWorker({
    queue,
    handlers,
    logger: consoleLogger(),
    workerId: `worker-${process.pid}`,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    apply,
  });

  const intervalMs = options.pollIntervalMs ?? 2_000;
  const signal = options.signal ?? new AbortController().signal;
  let stopped = false;

  const loop = async () => {
    while (!stopped && !signal.aborted) {
      try {
        // Return any expired lease to the queue before claiming, so a job from a
        // crashed worker is retried rather than stuck in `running` forever.
        const reaped = await queue.reapExpired();
        const outcomes = await worker.drain(50);
        options.onCycle?.(outcomes.length + reaped);
        if (outcomes.length === 0 && reaped === 0) {
          await delay(intervalMs, signal);
        }
      } catch (error) {
        process.stderr.write(
          `Cloud Wai worker cycle failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        await delay(intervalMs, signal);
      }
    }
  };

  void loop();

  return {
    stop: async () => {
      stopped = true;
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function consoleLogger() {
  return {
    debug: () => {},
    info: (message: string, fields?: Record<string, unknown>) =>
      process.stdout.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
    warn: (message: string, fields?: Record<string, unknown>) =>
      process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
    error: (message: string, fields?: Record<string, unknown>) =>
      process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
  };
}
