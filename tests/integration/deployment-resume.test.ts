/**
 * A requeued deploy must not build twice (C7).
 *
 * The processor requeues a job whose handler reported `running` — the honest
 * state of a build the engine accepted but has not finished. Before this was
 * pinned, the re-execution ran the whole handler again and issued a *second*
 * `deploy` to the engine for the same request: two builds, two billed units,
 * one deployment. The fix makes a re-execution read its own row, find the
 * engine's in-flight deployment handle, and poll that build instead.
 *
 * The engine here is a hand-rolled adapter, not a mock: it serves the real
 * `HostingAdapter` interface, counts the `deploy` calls it receives, and reports
 * a build that is `running` on the first read and `succeeded` on the second —
 * exactly the sequence a real engine produces across a requeue.
 */
import { describe, expect, it } from "vitest";
import type { Engines, HostingAdapter, DeploymentState } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  storageNotConfigured,
  domainVerifierNotConfigured,
} from "@cloud-wai/adapters";
import { ok, err, type ProviderRef } from "@cloud-wai/contracts";
import {
  buildDeploymentJobHandler,
  buildDeploymentApplier,
  DEPLOYMENT_JOB_KIND,
} from "@cloud-wai/worker";
import type { DeploymentJobPayload } from "@cloud-wai/contracts";
import type { Job } from "@cloud-wai/adapters";

const ORG = "org-a";
const PROJECT = "proj-a";
const DEPLOYMENT = "dep-1";
const APP_HANDLE = "app-handle-1";
const ENGINE_DEPLOY_HANDLE = "engine-run-1";

/**
 * A hosting engine whose build is still running when the first attempt ends.
 *
 * `deploy` is counted so the test can prove the requeue did not call it again;
 * `getDeployment` walks a scripted status sequence so the second read (during the
 * requeue) settles the build the way a real engine eventually would.
 */
function runningThenSucceeded(): {
  hosting: HostingAdapter;
  deployCalls: () => number;
  statusReads: () => number;
} {
  let deploys = 0;
  let reads = 0;
  const appRef: ProviderRef = {
    organizationId: ORG as ProviderRef["organizationId"],
    provider: "coolify",
    resourceType: "application",
    resourceId: APP_HANDLE,
  };
  const runRef: ProviderRef = {
    ...appRef,
    resourceType: "deployment",
    resourceId: ENGINE_DEPLOY_HANDLE,
  };

  const hosting: HostingAdapter = {
    async createApplication() {
      return err("failed", "the application already exists; ensureTarget must not run here");
    },
    async deploy() {
      deploys += 1;
      // The engine accepts the build and answers with its own deployment handle.
      return ok("running", {
        jobId: "job-1" as never,
        providerRef: runRef,
      });
    },
    async getDeployment(_ctx, ref): Promise<ReturnType<HostingAdapter["getDeployment"]>> {
      reads += 1;
      // First read (still in-flight) stays running; the next settles.
      const status: DeploymentState["status"] = reads <= 1 ? "running" : "succeeded";
      return Promise.resolve(
        ok("succeeded", { ref, status, url: status === "succeeded" ? "https://alpha.test" : null }),
      );
    },
    async cancelDeployment() {
      return ok("succeeded", undefined);
    },
    async rollback() {
      return err("not_configured", "no rollback in this test");
    },
    async getLogs() {
      return ok("succeeded", { lines: [], cursor: null });
    },
    async listEnvVars() {
      return ok("succeeded", []);
    },
    async createEnvVar() {
      return err("not_configured", "no env vars in this test");
    },
    async updateEnvVar() {
      return err("not_configured", "no env vars in this test");
    },
    async deleteEnvVar() {
      return ok("succeeded", undefined);
    },
    async deleteApplication() {
      return ok("succeeded", undefined);
    },
    async reconcile() {
      return ok("succeeded", { ref: appRef, status: "running", url: null });
    },
  };

  return { hosting, deployCalls: () => deploys, statusReads: () => reads };
}

function enginesWith(hosting: HostingAdapter): Engines {
  return {
    hosting,
    serverless: serverlessNotConfigured("lambda", "x"),
    database: databaseNotConfigured("postgres", "x"),
    storage: storageNotConfigured("minio", "x"),
    securityEdge: securityNotConfigured("envoy", "x"),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

const payload: DeploymentJobPayload = {
  deploymentId: DEPLOYMENT,
  organizationId: ORG as DeploymentJobPayload["organizationId"],
  projectId: PROJECT as DeploymentJobPayload["projectId"],
  action: "create",
  projectSlug: "alpha",
  gitRepository: "https://github.com/acme/alpha.git",
  gitBranch: "main",
  buildPack: null,
  commit: null,
  kind: "production",
  previewKey: null,
};

const job: Job = {
  id: "job-row-1" as Job["id"],
  organizationId: ORG,
  kind: DEPLOYMENT_JOB_KIND,
  idempotencyKey: "durable-1",
  state: "running",
  payload,
  attempts: 1,
  maxAttempts: 3,
  lastError: null,
  leaseExpiresAt: null,
} as Job;

const ctx = { organizationId: ORG, idempotencyKey: "durable-1", timeoutMs: 1000 };
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A row that the applier mutates, so the second attempt sees what the first one
 * persisted. This is the whole point: the resume decision is taken from the
 * stored row, not from a variable the test holds.
 */
function makeRow() {
  const row: {
    status: string;
    providerResourceId: string | null;
    deploymentResourceId: string | null;
  } = { status: "pending", providerResourceId: null, deploymentResourceId: null };
  const writes = {
    getProjectDeploymentTargetForService: async () => ({
      provider: "coolify",
      providerResourceId: APP_HANDLE,
      executionModel: "container" as const,
    }),
    setProjectProviderResource: async () => ({}),
    getPreviewTargetForService: async () => null,
    setPreviewTargetProvider: async () => ({}),
    getDeploymentForService: async () => ({
      status: row.status as never,
      providerResourceId: row.providerResourceId,
      deploymentResourceId: row.deploymentResourceId,
    }),
  };
  const outcome = {
    updateDeploymentStatus: async (input: {
      status: string;
      providerResourceId?: string | null;
      deploymentResourceId?: string | null;
    }) => {
      row.status = input.status;
      if (input.providerResourceId != null) row.providerResourceId = input.providerResourceId;
      if (input.deploymentResourceId != null) row.deploymentResourceId = input.deploymentResourceId;
    },
    promoteDeployment: async () => ({}),
    recordUsage: async () => ({}),
  };
  return { row, writes, outcome };
}

describe("a requeued deploy polls its in-flight build instead of rebuilding", () => {
  it("calls deploy once across two attempts and settles on the engine's second read", async () => {
    const { hosting, deployCalls, statusReads } = runningThenSucceeded();
    const engines = enginesWith(hosting);
    const { row, writes, outcome } = makeRow();

    const handler = buildDeploymentJobHandler({ engines, writes, outcome });
    const apply = buildDeploymentApplier({ engines, writes, outcome });

    // Attempt 1: the engine accepts the build and answers `running`.
    const first = await handler(payload, ctx);
    expect(first.ok).toBe(true);
    expect(first.status).toBe("running");
    expect(deployCalls()).toBe(1);
    // The applier persists the engine's own handles, which is what lets the
    // requeue find the build rather than start another.
    await apply(job, first);
    expect(row.status).toBe("running");
    expect(row.deploymentResourceId).toBe(ENGINE_DEPLOY_HANDLE);

    // Attempt 2 (the requeue): no second build; the in-flight one is polled.
    const second = await handler(payload, ctx);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("succeeded");
    expect(deployCalls()).toBe(1);
    expect(statusReads()).toBeGreaterThanOrEqual(2);

    await apply(job, second);
    expect(row.status).toBe("succeeded");
  });

  it("runs the ordinary path for a new row, even while an older one is running", async () => {
    const { hosting, deployCalls } = runningThenSucceeded();
    const engines = enginesWith(hosting);
    // A brand-new deployment row: pending, with no engine handle yet. A redeploy
    // creates exactly this shape while an earlier row is still `running`, so if
    // the resume keyed off the project rather than the row it would swallow a
    // legitimate new build.
    const { row, writes, outcome } = makeRow();
    row.status = "pending";
    row.providerResourceId = null;
    row.deploymentResourceId = null;

    const handler = buildDeploymentJobHandler({ engines, writes, outcome });
    const result = await handler(payload, ctx);
    expect(deployCalls()).toBe(1);
    expect(result.status).toBe("running");
    expect(result.ok).toBe(true);
    expect(row.status).toBe("pending");
  });
});
