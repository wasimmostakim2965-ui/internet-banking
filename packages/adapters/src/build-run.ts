/**
 * The build step, shared by both deploy paths.
 *
 * This is the layer `execution-router.ts` was written expecting and did not have.
 * The container engine builds from the project's git repository itself, so it
 * needs no artifact. The serverless engine is handed an already-built artifact
 * and cannot build one, so without this step a serverless deploy could only ever
 * report `not_configured` for a missing build (ADR-0018).
 *
 * It lives here rather than in the worker because the API's synchronous deploy
 * path and the worker's durable one must not diverge on how a build is run: two
 * copies of the polling rule would drift, and the divergence would surface as a
 * deploy that succeeds on one path and fails on the other.
 *
 * Two rules shape it, and both exist to keep a deploy honest:
 *
 * 1. **A build is only run when the engine cannot build for itself.** Running a
 *    build for a container deploy would produce an artifact nothing consumes,
 *    and would make a container deploy fail when the *builder* is down even
 *    though the container engine is healthy.
 * 2. **A build that produces nothing is a failure, not a deploy of nothing.**
 *    The artifact is polled until the builder reports one; a build that finished
 *    without an artifact, was cancelled, or timed out ends the deploy as a
 *    failure carrying the builder's own reason. It never proceeds to deploy with
 *    an absent artifact.
 */
import type { AdapterResult, OperationRef, ProviderRef } from "@cloud-wai/contracts";
import type { BuildArtifact, BuildEngine } from "./build.js";
import { toServerlessArtifact } from "./build.js";
import type { ServerlessArtifact } from "./index.js";

export interface BuildStepDeps {
  readonly build: BuildEngine;
  /** How long to wait between artifact polls. Injected so tests do not sleep. */
  readonly pollIntervalMs?: number | undefined;
  /** How many times to poll before giving up. Injected for the same reason. */
  readonly maxPolls?: number | undefined;
  /** Injected so a test does not spend real time. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface BuildStepInput {
  readonly organizationId: ProviderRef["organizationId"];
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly buildPack: string | null;
  /** The monorepo subdirectory to build from, when the app is not at the root. */
  readonly rootDirectory?: string | null;
}

export type BuildStepResult =
  | { readonly ok: true; readonly artifact: ServerlessArtifact; readonly buildRef: ProviderRef }
  | { readonly ok: false; readonly reason: string };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build the source into a deployable serverless artifact.
 *
 * Returns the artifact and the build's own reference (so a caller can read the
 * build logs), or the builder's reason when there is no artifact to deploy.
 */
export async function runBuildStep(
  deps: BuildStepDeps,
  input: BuildStepInput,
): Promise<BuildStepResult> {
  if (!input.repository) {
    // A serverless deploy needs code, and code needs a source. A project with no
    // repository is a configuration fact, not an engine fault.
    return {
      ok: false,
      reason: "This project has no git repository, so there is nothing to build.",
    };
  }

  const ctx = {
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    timeoutMs: input.timeoutMs,
  };

  const started: AdapterResult<OperationRef> = await deps.build.build(ctx, {
    source: {
      kind: "git",
      repository: input.repository,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.rootDirectory ? { rootDirectory: input.rootDirectory } : {}),
    },
    ...(input.buildPack ? { buildPack: input.buildPack as never } : {}),
  });
  if (!started.ok) return { ok: false, reason: started.reason };

  const buildRef = started.value.providerRef;
  const sleep = deps.sleep ?? defaultSleep;
  const interval = deps.pollIntervalMs ?? 2_000;
  const maxPolls = deps.maxPolls ?? 150;

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const artifact: AdapterResult<BuildArtifact> = await deps.build.getArtifact(ctx, buildRef);
    if (artifact.ok) {
      const code = toServerlessArtifact(artifact.value);
      if (!code) {
        // The build succeeded but produced nothing a serverless engine can
        // publish. Deploying that would be a deploy of nothing.
        return {
          ok: false,
          reason:
            "The build finished but produced no artifact a serverless engine can publish " +
            "(no image and no function bundle).",
        };
      }
      return { ok: true, artifact: code, buildRef };
    }
    // `degraded` is the builder saying "still running". Anything else is a
    // finished failure and polling again would not change it.
    if (artifact.status !== "degraded") return { ok: false, reason: artifact.reason };
    await sleep(interval);
  }

  return {
    ok: false,
    reason: `The build did not produce an artifact within ${maxPolls} polls of ${interval}ms.`,
  };
}
