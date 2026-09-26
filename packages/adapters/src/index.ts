/**
 * @cloud-wai/adapters — the ONLY place Cloud Wai touches an execution engine.
 *
 * Provider SDKs and API shapes must not leak into the UI or generic API code.
 * Every operation is idempotent, timeout-bounded, retryable with backoff and
 * auditable, and every adapter reports an honest status when the engine behind
 * it is not configured — it must never fabricate success.
 */
import type {
  AdapterResult,
  OperationRef,
  ProviderRef,
  OrganizationId,
} from "@cloud-wai/contracts";

/**
 * Marked on every adapter that exists only to report `not_configured`.
 *
 * It lets the engine report say "this deployment cannot act on that engine"
 * without calling it, and without guessing from the shape of the object.
 */
export interface NotConfiguredBrand {
  readonly __notConfigured?: true;
}

/** Every adapter call carries the tenant it belongs to and an idempotency key. */
export interface AdapterContext {
  readonly organizationId: OrganizationId;
  /** Caller-supplied key; replaying the same key must not duplicate work. */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

export interface DeploymentState {
  readonly ref: ProviderRef;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "degraded" | "not_configured";
  readonly url: string | null;
}

/** The build packs Coolify accepts for a public application. */
export const BUILD_PACKS = [
  "nixpacks",
  "railpack",
  "static",
  "dockerfile",
  "dockercompose",
] as const;
export type BuildPack = (typeof BUILD_PACKS)[number];

/**
 * Input for creating a hosted application.
 *
 * `gitRepository` and `gitBranch` are required because Coolify's create
 * endpoint rejects a request without a source; the build pack defaults to
 * `nixpacks`.
 */
export interface CreateApplicationInput {
  readonly name: string;
  readonly gitRepository?: string | undefined;
  readonly gitBranch?: string | undefined;
  readonly buildPack?: BuildPack | undefined;
  readonly domains?: string | undefined;
  readonly portsExposes?: string | undefined;
  /**
   * The repository-relative directory the engine builds from, for a monorepo.
   *
   * Absent means the repository root. It maps to Coolify's `base_directory`
   * ("The base directory for all commands"), which the engine applies to every
   * install/build/start command it runs.
   */
  readonly rootDirectory?: string | undefined;
}

export interface LogPage {
  readonly lines: readonly string[];
  readonly cursor: string | null;
}

/**
 * One environment variable as the engine holds it.
 *
 * `key` and `isBuildTime` are the customer's own input; `value` is not returned
 * by the engine on a list (Coolify answers with a masked value), so a read is a
 * key inventory rather than a way to recover secrets. `engineRef` is the
 * engine's own handle, needed to update or delete that one variable.
 */
export interface EnvVarState {
  readonly key: string;
  readonly value: string;
  readonly isBuildTime: boolean;
  readonly engineRef: string | null;
}

export interface EnvVarWrite {
  readonly key: string;
  readonly value: string;
  readonly isBuildTime?: boolean | undefined;
}

/**
 * Where a serverless function's code comes from.
 *
 * The distinction the shape forces: a serverless engine does not build from a
 * git repository — it runs an artifact that is already built. Modelling the
 * artifact explicitly means a deploy with no artifact is refused at the type
 * level, so nobody can "deploy" a serverless function that has no code.
 */
export type ServerlessArtifact =
  | {
      readonly kind: "s3";
      /** The bucket holding the deployment package. */
      readonly bucket: string;
      /** The object key of the zip. */
      readonly key: string;
    }
  | {
      readonly kind: "image";
      /** An ECR image URI. */
      readonly uri: string;
    };

export interface CreateFunctionInput {
  readonly name: string;
  /**
   * The built code. Required: see `ServerlessArtifact`.
   */
  readonly artifact?: ServerlessArtifact | undefined;
  /** Required for a zip artifact; ignored for an image (the image carries it). */
  readonly runtime?: string | undefined;
  readonly handler?: string | undefined;
  /** Overrides the tenant credential's default execution role, when set. */
  readonly roleArn?: string | undefined;
  readonly memoryMb?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  /** Non-secret environment the function runs with. Secrets belong in a secret store. */
  readonly environment?: Record<string, string> | undefined;
}

/**
 * A serverless execution engine.
 *
 * A different execution model from `HostingAdapter`, so a different contract: a
 * container engine creates an application and builds a branch, while a
 * serverless engine publishes an already-built artifact to a function. Merging
 * the two would force one to lie about what it does.
 *
 * The tenant boundary is the same as every other adapter: credentials are
 * resolved per organization, so one tenant's function is unreachable with
 * another tenant's credentials.
 */
export interface ServerlessAdapter extends NotConfiguredBrand {
  createFunction(
    ctx: AdapterContext,
    input: CreateFunctionInput,
  ): Promise<AdapterResult<OperationRef>>;
  /**
   * Publish new code to an existing function.
   *
   * `artifact` is required; a deploy with no artifact is refused, never reported
   * as a success that changed nothing.
   */
  deploy(
    ctx: AdapterContext,
    input: {
      readonly functionRef: ProviderRef;
      readonly artifact?: ServerlessArtifact | undefined;
      readonly publish?: boolean | undefined;
    },
  ): Promise<AdapterResult<OperationRef>>;
  getDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
  deleteFunction(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  getLogs(ctx: AdapterContext, ref: ProviderRef, cursor?: string): Promise<AdapterResult<LogPage>>;
}

export interface HostingAdapter extends NotConfiguredBrand {
  createApplication(
    ctx: AdapterContext,
    input: CreateApplicationInput,
  ): Promise<AdapterResult<OperationRef>>;
  deploy(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  getDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
  cancelDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  /**
   * Roll back to a previously built revision.
   *
   * `commit` is required: Coolify refuses a rollback without a git ref, so an
   * adapter that omitted it would be reporting success for a request the engine
   * never performed.
   */
  rollback(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef; commit: string },
  ): Promise<AdapterResult<OperationRef>>;
  getLogs(ctx: AdapterContext, ref: ProviderRef, cursor?: string): Promise<AdapterResult<LogPage>>;
  /**
   * List an application's environment variables.
   *
   * Coolify answers with every variable's *masked* value, so this is a key
   * inventory: it says which variables exist and whether they apply at build
   * time, never what their secret values are. A deployment reads this to know
   * what it will inject; the dashboard shows keys, not secrets.
   */
  listEnvVars(
    ctx: AdapterContext,
    ref: ProviderRef,
  ): Promise<AdapterResult<readonly EnvVarState[]>>;
  /**
   * Create one environment variable.
   *
   * Coolify's create route returns the created variable; the reference it
   * carries is what a later delete addresses, so it is kept rather than
   * discarded.
   */
  createEnvVar(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef; variable: EnvVarWrite },
  ): Promise<AdapterResult<EnvVarState>>;
  /**
   * Update one environment variable.
   *
   * Coolify's update route identifies the variable by its `key`, not by its
   * uuid — so that is the identity here too. An adapter that pretended
   * otherwise would send a request the engine accepts but applies to the wrong
   * variable.
   */
  updateEnvVar(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef; variable: EnvVarWrite },
  ): Promise<AdapterResult<EnvVarState>>;
  /** Delete one environment variable by its engine reference (Coolify's uuid). */
  deleteEnvVar(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef; engineRef: string },
  ): Promise<AdapterResult<void>>;
  deleteApplication(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  reconcile(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
}

export interface DatabaseAdapter extends NotConfiguredBrand {
  provision(ctx: AdapterContext, input: { name: string }): Promise<AdapterResult<ProviderRef>>;
  rotateCredentials(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  backup(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<ProviderRef>>;
  restore(
    ctx: AdapterContext,
    input: { backupRef: ProviderRef; targetRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  destroy(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  /**
   * Read a database's container log.
   *
   * This is the engine's log for the resource it runs, not a SQL or query log:
   * Cloud Wai never connects to the tenant database (ADR-0011, Option A), so
   * this is the one database log that exists without entering the data plane.
   * The endpoint has no cursor, so a page's cursor is null rather than invented.
   */
  getLogs(
    ctx: AdapterContext,
    ref: ProviderRef,
    cursor?: string,
  ): Promise<AdapterResult<LogPage>>;
}

export interface StorageAdapter extends NotConfiguredBrand {
  createBucket(ctx: AdapterContext, input: { name: string }): Promise<AdapterResult<ProviderRef>>;
  deleteBucket(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
}

export interface SecurityEdgeAdapter extends NotConfiguredBrand {
  publishRoute(
    ctx: AdapterContext,
    input: { routeRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  removeRoute(ctx: AdapterContext, input: { routeRef: ProviderRef }): Promise<AdapterResult<void>>;
  applyPolicy(
    ctx: AdapterContext,
    input: { ref: ProviderRef },
  ): Promise<AdapterResult<{ version: number }>>;
  quarantine(ctx: AdapterContext, input: { ref: ProviderRef }): Promise<AdapterResult<void>>;
  inspectHealth(
    ctx: AdapterContext,
    input: { ref: ProviderRef },
  ): Promise<AdapterResult<{ healthy: boolean }>>;
}

export interface DomainResellerAdapter extends NotConfiguredBrand {
  search(ctx: AdapterContext, input: { query: string }): Promise<AdapterResult<readonly string[]>>;
  /** Registering requires credentials and legal approval; default is not_configured. */
  register(ctx: AdapterContext, input: { domain: string }): Promise<AdapterResult<OperationRef>>;
}

export interface DomainVerification {
  readonly hostname: string;
  /** The observed fact. False means "not confirmed", never "confirmed". */
  readonly verified: boolean;
  /** Which provider confirmed it. */
  readonly provider: string;
  readonly providerResourceId: string | null;
  /** A human-readable reason, safe to show: no engine internals. */
  readonly detail: string;
}

export interface DomainVerifier extends NotConfiguredBrand {
  resolveDomainVerification(
    ctx: AdapterContext,
    input: { hostname: string; expectedToken: string },
  ): Promise<AdapterResult<DomainVerification>>;
}

/**
 * Whether an adapter is the real engine or its not-configured stand-in.
 *
 * A single predicate so "is this engine wired" is answered one way everywhere
 * rather than re-derived (`__notConfigured !== true`) at each call site.
 */
export function isConfigured(adapter: NotConfiguredBrand): boolean {
  return adapter.__notConfigured !== true;
}

export * from "./http.js";
export * from "./aws-signature.js";
export * from "./coolify.js";
export * from "./serverless.js";
export * from "./postgres.js";
export * from "./minio.js";
export * from "./security-edge.js";
export * from "./build.js";
export * from "./build-railpack.js";
export * from "./build-run.js";
export * from "./execution-router.js";
export * from "./engines.js";
export * from "./conformance.js";
export * from "./fakes.js";
export * from "./queue.js";
export * from "./domain-verification.js";
export * from "./engine-console.js";
