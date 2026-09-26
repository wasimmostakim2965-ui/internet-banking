/**
 * The execution router: one deployment port over two execution models.
 *
 * ADR-0017 lets a project run on the container engine (Coolify) or the
 * serverless engine (Lambda). Those are different machines with different APIs —
 * one builds from a git repository, the other is handed an already-built
 * artifact — so the control plane cannot call them through the same raw adapter
 * without either pretending the difference away or leaking it into every caller.
 *
 * This module is the seam. A caller asks for "the deployment engine for this
 * project's execution model" and gets a single `DeploymentEngine` port. Which
 * adapter is behind it is decided here, once, so no router, procedure or worker
 * imports an engine directly (the rule that routers never import adapters they
 * route to is kept).
 *
 * The honesty rule is structural, not a comment:
 *
 *   * A `serverless` project is NEVER handed to the container engine. If the
 *     serverless engine is not configured, the result is `not_configured` — not
 *     a Coolify build reported as a success, which would run the wrong execution
 *     model and call it done.
 *   * Lambda does not build from git. A serverless deploy needs a built
 *     artifact. Until a build engine supplies one, the router reports
 *     `not_configured` naming the missing step, rather than inventing an
 *     artifact or silently falling back to a container build.
 *   * A rollback or a cancel is a container concept. On serverless they are
 *     `not_configured` with that reason, never a fabricated success.
 */
import {
  err,
  ok,
  type AdapterResult,
  type EngineStatus,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type {
  AdapterContext,
  BuildPack,
  DeploymentState,
  HostingAdapter,
  LogPage,
  NotConfiguredBrand,
  ServerlessAdapter,
  ServerlessArtifact,
} from "./index.js";

/**
 * Whether an adapter is a real engine rather than its not-configured stand-in.
 *
 * Local to this module so the router does not import a runtime value from
 * `index.js`, which re-exports this file — that cycle would be a load-order bug
 * waiting to happen. The predicate is the adapter's own brand, not a guess.
 */
function configured(adapter: NotConfiguredBrand): boolean {
  return adapter.__notConfigured !== true;
}

/**
 * The uniform deployment operations the control plane needs, whichever engine is
 * behind them.
 *
 * Deliberately narrower than either adapter: it is the intersection the API and
 * worker actually use, so adding an engine cannot quietly widen what a caller can
 * do. Env-var management and preview-application bookkeeping stay with the
 * container adapter and are not part of the shared port.
 */
export interface DeploymentEngine {
  /** Which execution model this port drives, for honest reporting. */
  readonly model: "container" | "serverless";
  /**
   * Create the engine-side target for a project, if it has none.
   *
   * The container engine creates an application from a git repository. The
   * serverless engine creates a function from a built artifact; when none is
   * available it reports `not_configured`, naming the missing build step.
   */
  ensureTarget(
    ctx: AdapterContext,
    input: {
      readonly name: string;
      readonly gitRepository: string | null;
      readonly gitBranch: string | null;
      readonly buildPack: string | null;
      /**
       * The repository-relative directory to build from, for a monorepo.
       *
       * Container-only: Coolify applies it to the commands it runs
       * (`base_directory`). A serverless engine consumes an already-built
       * artifact, so the directory belongs to the build step, not here.
       */
      readonly rootDirectory?: string | null;
      /** Where a pre-built serverless artifact comes from, when there is one. */
      readonly artifact?: ServerlessArtifact | undefined;
    },
  ): Promise<AdapterResult<OperationRef>>;
  deploy(
    ctx: AdapterContext,
    ref: ProviderRef,
    /**
     * The built code for this deploy, when there is one.
     *
     * The container engine ignores it — it builds from the project's git
     * repository. The serverless engine requires it: publishing code is the
     * whole of a serverless deploy, so a deploy without it is refused.
     */
    artifact?: ServerlessArtifact | undefined,
  ): Promise<AdapterResult<OperationRef>>;
  getDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
  getLogs(ctx: AdapterContext, ref: ProviderRef, cursor?: string): Promise<AdapterResult<LogPage>>;
  /**
   * Return to a previously built revision.
   *
   * Container-only: Coolify rolls back to a git commit. A serverless function
   * has no such operation — a "rollback" would be re-publishing a prior artifact
   * version, a different action — so serverless reports `not_configured` rather
   * than performing something the customer did not ask for.
   */
  rollback(
    ctx: AdapterContext,
    input: { readonly ref: ProviderRef; readonly commit: string | null },
  ): Promise<AdapterResult<OperationRef>>;
  /** Cancel an in-flight deployment. Container-only, as rollback is. */
  cancel(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  /**
   * Delete the engine-side target. Both engines can do this; it is how a project
   * is torn down.
   */
  destroy(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
}

/** The engines the router may choose between. */
export interface RouterEngines {
  readonly hosting: HostingAdapter;
  readonly serverless: ServerlessAdapter;
}

/** A rollback/cancel the serverless engine does not have. */
function unsupported(operation: string): Promise<AdapterResult<never>> {
  return Promise.resolve(
    err(
      "not_configured",
      `The serverless engine has no ${operation}: that operation belongs to the container engine, ` +
        `and this project's execution model is serverless.`,
    ),
  );
}

/** A serverless action with no artifact to perform it on. */
function missingArtifact(action: string): Promise<AdapterResult<never>> {
  return Promise.resolve(
    err(
      "not_configured",
      `This project runs serverless, and ${action} needs a built artifact (an S3 object or an ECR image). ` +
        `None reached the deploy, so the step is not performed rather than faked.`,
    ),
  );
}

/** Wrap the container engine as the uniform port. */
export function containerDeploymentEngine(hosting: HostingAdapter): DeploymentEngine {
  return {
    model: "container",
    async ensureTarget(ctx, input): Promise<AdapterResult<OperationRef>> {
      return hosting.createApplication(ctx, {
        name: input.name,
        ...(input.gitRepository ? { gitRepository: input.gitRepository } : {}),
        ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
        ...(input.buildPack ? { buildPack: input.buildPack as BuildPack } : {}),
        ...(input.rootDirectory ? { rootDirectory: input.rootDirectory } : {}),
      });
    },
    deploy: (ctx, ref) => hosting.deploy(ctx, { applicationRef: ref }),
    getDeployment: (ctx, ref) => hosting.getDeployment(ctx, ref),
    getLogs: (ctx, ref, cursor) => hosting.getLogs(ctx, ref, cursor),
    rollback: async (ctx, input) =>
      input.commit
        ? hosting.rollback(ctx, { applicationRef: input.ref, commit: input.commit })
        : err(
            "not_configured",
            "A rollback needs the git revision to return to, and none was resolved.",
          ),
    cancel: (ctx, ref) => hosting.cancelDeployment(ctx, ref),
    destroy: (ctx, ref) => hosting.deleteApplication(ctx, ref),
  };
}

/**
 * Wrap a configured serverless engine as the uniform port.
 */
export function serverlessDeploymentEngine(serverless: ServerlessAdapter): DeploymentEngine {
  return {
    model: "serverless",
    ensureTarget: (ctx, input) =>
      serverless.createFunction(ctx, {
        name: input.name,
        ...(input.artifact ? { artifact: input.artifact } : {}),
      }),
    async deploy(ctx, ref, artifact): Promise<AdapterResult<OperationRef>> {
      if (!artifact) return missingArtifact("publishing new code");
      return serverless.deploy(ctx, { functionRef: ref, artifact, publish: true });
    },
    getDeployment: (ctx, ref) => serverless.getDeployment(ctx, ref),
    getLogs: (ctx, ref, cursor) => serverless.getLogs(ctx, ref, cursor),
    rollback: () => unsupported("rollback"),
    cancel: () => unsupported("cancel"),
    destroy: (ctx, ref) => serverless.deleteFunction(ctx, ref),
  };
}

/**
 * A serverless port whose every operation reports the engine's own
 * `not_configured` reason.
 *
 * Each method delegates to the matching method of the not-configured adapter, so
 * the reason a customer sees is that adapter's single source of truth for why it
 * is unavailable — one copy, and it stays correct if the credential rule changes.
 * The methods are `async` so a delegated `AdapterErr` widens to the port's return
 * type without a cast.
 */
function notConfiguredServerless(serverless: ServerlessAdapter): DeploymentEngine {
  return {
    model: "serverless",
    async ensureTarget(ctx, input) {
      return serverless.createFunction(ctx, {
        name: input.name,
        ...(input.artifact ? { artifact: input.artifact } : {}),
      });
    },
    async deploy(ctx, ref, artifact) {
      return artifact
        ? serverless.deploy(ctx, { functionRef: ref, artifact })
        : serverless.deploy(ctx, { functionRef: ref });
    },
    async getDeployment(ctx, ref) {
      return serverless.getDeployment(ctx, ref);
    },
    async getLogs(ctx, ref, cursor) {
      return serverless.getLogs(ctx, ref, cursor);
    },
    async rollback(ctx, input) {
      // A rollback is not a serverless operation. Delegating to `deploy` on the
      // stand-in yields its `not_configured` error, already typed as an
      // operation result, without a second copy of the reason sentence.
      return serverless.deploy(ctx, { functionRef: input.ref });
    },
    async cancel(ctx, ref) {
      return serverless.deleteFunction(ctx, ref);
    },
    async destroy(ctx, ref) {
      return serverless.deleteFunction(ctx, ref);
    },
  };
}

/**
 * The deployment engine for one project's execution model.
 *
 * `serverless` that is not configured yields a port whose every operation is
 * `not_configured`. That is the point: a caller cannot accidentally reach the
 * container engine by asking for the serverless one, and cannot mistake the
 * absence of an engine for a success.
 */
export function deploymentEngineFor(
  engines: RouterEngines,
  model: "container" | "serverless",
): DeploymentEngine {
  if (model === "serverless") {
    if (configured(engines.serverless)) return serverlessDeploymentEngine(engines.serverless);
    return notConfiguredServerless(engines.serverless);
  }
  return containerDeploymentEngine(engines.hosting);
}
