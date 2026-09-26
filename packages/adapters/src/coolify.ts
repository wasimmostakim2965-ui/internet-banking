/**
 * Coolify hosting adapter.
 *
 * Wraps Coolify's documented API (ADR-0002, pinned commit 7c86e53422ad). The
 * tenant mapping is explicit: a Cloud Wai organization has its own Coolify team
 * and its own API token, so one organization's applications are not merely
 * filtered out of a shared list — they are unreachable with another
 * organization's credentials.
 *
 * Every route and verb here is checked against the pinned upstream route table
 * by `tests/engines/coolify-routes.test.ts`. Two upstream facts shape this file:
 * Coolify has no generic `POST /applications` (creation goes through a
 * build-pack specific endpoint that requires a project, server and
 * environment), and queued work is addressed by *deployment* uuid rather than
 * application uuid.
 *
 * Coolify's UUIDs are stored only inside `ProviderRef` values. They are never a
 * tenant boundary.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type {
  AdapterContext,
  CreateApplicationInput,
  DeploymentState,
  EnvVarState,
  HostingAdapter,
  LogPage,
} from "./index.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "coolify";

export interface CoolifyCredentials {
  /** Base URL, e.g. `https://coolify.internal:8000`. */
  readonly baseUrl: string;
  /** A Sanctum token scoped to exactly one team. Never shared across tenants. */
  readonly token: string;
  /**
   * The Coolify project and server this organization's applications live in.
   * Coolify requires both on create, so they belong to the tenant's credential
   * record rather than to per-request input.
   */
  readonly projectUuid?: string | undefined;
  readonly serverUuid?: string | undefined;
  /** At least one of these is required on create. */
  readonly environmentName?: string | undefined;
  readonly environmentUuid?: string | undefined;
  readonly destinationUuid?: string | undefined;
}

export type CredentialResolver = (
  organizationId: AdapterContext["organizationId"],
) => CoolifyCredentials | null;

export interface CoolifyAdapterOptions extends HttpClientOptions {
  /**
   * Resolves per-organization credentials. When this returns null the adapter
   * reports `not_configured` for that organization rather than falling back to a
   * shared token.
   */
  readonly credentials: CredentialResolver;
}

/** Translate a Coolify application `status:health` value into Cloud Wai's. */
export function mapDeploymentStatus(raw: string | undefined): DeploymentState["status"] {
  // Coolify serialises application status as `state:health` (or `state (health)`).
  const parts = (raw ?? "")
    .toLowerCase()
    .replace(/[()]/g, ":")
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const state = parts[0] ?? "";
  const health = parts[1] ?? "";

  switch (state) {
    case "running":
      return health === "healthy" ? "succeeded" : "running";
    case "starting":
    case "restarting":
    case "created":
    case "deploying":
    case "removing":
      return "running";
    case "paused":
      return "degraded";
    case "dead":
    case "exited":
      return "failed";
    default:
      // Unknown upstream values are not success.
      return "pending";
  }
}

/** Translate a Coolify deployment-queue status into Cloud Wai's. */
export function mapQueueStatus(raw: string | undefined): DeploymentState["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
    case "in_progress":
      return "running";
    case "finished":
      return "succeeded";
    // Coolify retries the build itself; one failed attempt is not a dead engine.
    case "failed":
      return "degraded";
    case "cancelled-by-user":
    case "cancelled":
    case "exited":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Map one Coolify environment-variable row to `EnvVarState`.
 *
 * Coolify serialises a variable as `{ key, value, is_buildtime, uuid, ... }`
 * with `value` masked unless the token carries `read:sensitive`. The mask is
 * kept as-is rather than treated as the real value: reporting a masked string
 * as a secret would be worse than reporting nothing.
 */
function toEnvVarState(row: Record<string, unknown>): EnvVarState {
  const value = row["value"] ?? row["real_value"];
  return {
    key: String(row["key"] ?? ""),
    value: typeof value === "string" ? value : "",
    isBuildTime: row["is_buildtime"] !== false,
    engineRef: typeof row["uuid"] === "string" && row["uuid"] !== "" ? row["uuid"] : null,
  };
}

/** Fields `POST /applications/public` requires that we must supply. */
function missingCreateConfig(creds: CoolifyCredentials): readonly string[] {
  const missing: string[] = [];
  if (!creds.projectUuid) missing.push("projectUuid");
  if (!creds.serverUuid) missing.push("serverUuid");
  if (!creds.environmentName && !creds.environmentUuid) missing.push("environmentName");
  return missing;
}

export function createCoolifyHosting(options: CoolifyAdapterOptions): HostingAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const notConfigured = <T>(org: string, hint?: string): AdapterResult<T> =>
    err(
      "not_configured",
      `Coolify is not configured for organization ${org}.${
        hint ? ` ${hint}` : " Provision a team token for this organization."
      }`,
    );

  /** Resolve credentials, or return the honest refusal. */
  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: CoolifyCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.baseUrl.trim() === "" || creds.token.trim() === "") {
      return { ok: false, result: notConfigured<T>(ctx.organizationId) };
    }
    return { ok: true, creds };
  };

  const call = <T>(
    ctx: AdapterContext,
    creds: CoolifyCredentials,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    request<T>(
      { fetchImpl: doFetch, classify: options.classify },
      {
        method,
        url: `${creds.baseUrl.replace(/\/$/, "")}${path}`,
        headers: { authorization: `Bearer ${creds.token}` },
        body,
        timeoutMs: ctx.timeoutMs,
      },
    );

  const opRef = (
    ctx: AdapterContext,
    uuid: string,
    resourceType: string,
    jobId?: string,
  ): OperationRef => ({
    jobId: (jobId ?? `coolify-${resourceType}-${uuid}`) as OperationRef["jobId"],
    providerRef: {
      organizationId: ctx.organizationId,
      provider: ENGINE,
      resourceType,
      resourceId: uuid,
    },
  });

  return {
    /**
     * Coolify has no generic create endpoint. A public application is created at
     * `POST /applications/public`, which requires the project, server, an
     * environment and the git source.
     */
    async createApplication(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;

      const missingInfra = missingCreateConfig(creds);
      if (missingInfra.length > 0) {
        return notConfigured(
          ctx.organizationId,
          `The Coolify credential record is missing ${missingInfra.join(", ")}.`,
        );
      }

      const required: readonly (keyof CreateApplicationInput)[] = ["gitRepository", "gitBranch"];
      const missingInput = required.filter((key) => {
        const value = input[key];
        return value === undefined || value.trim() === "";
      });
      if (missingInput.length > 0) {
        // A request that cannot satisfy Coolify's schema is a caller error, not
        // a misconfiguration — and it is never reported as success.
        return err(
          "failed",
          `Coolify requires ${missingInput.join(", ")} to create an application.`,
        );
      }

      const response = await call<{ uuid?: string; message?: string }>(
        ctx,
        creds,
        "POST",
        "/api/v1/applications/public",
        {
          name: input.name,
          project_uuid: creds.projectUuid,
          server_uuid: creds.serverUuid,
          ...(creds.environmentUuid
            ? { environment_uuid: creds.environmentUuid }
            : { environment_name: creds.environmentName }),
          ...(creds.destinationUuid ? { destination_uuid: creds.destinationUuid } : {}),
          git_repository: input.gitRepository,
          git_branch: input.gitBranch,
          build_pack: input.buildPack ?? "nixpacks",
          ...(input.rootDirectory ? { base_directory: input.rootDirectory } : {}),
          ...(input.domains ? { domains: input.domains } : {}),
          ...(input.portsExposes ? { ports_exposes: input.portsExposes } : {}),
        },
      );
      if (!response.ok) return response;

      const uuid = response.value.value?.uuid;
      if (!uuid) {
        return err("degraded", "Coolify created an application but returned no uuid.");
      }
      return ok("succeeded", opRef(ctx, uuid, "application"));
    },

    /**
     * Queue a deployment.
     *
     * Coolify queues asynchronously and answers with a `deployment_uuid`. The
     * operation is therefore `running`, never `succeeded` — the deployment has
     * not finished when this returns.
     */
    async deploy(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{
        deployments?: readonly { deployment_uuid?: string; message?: string }[];
      }>(ctx, resolved.creds, "POST", "/api/v1/deploy", {
        uuid: input.applicationRef.resourceId,
      });
      if (!response.ok) return response;

      const queued = response.value.value?.deployments?.find((d) => d.deployment_uuid);
      if (!queued?.deployment_uuid) {
        return err(
          "degraded",
          "Coolify accepted the deploy request but returned no deployment_uuid.",
        );
      }
      return ok(
        "running",
        opRef(ctx, queued.deployment_uuid, "deployment", queued.deployment_uuid),
      );
    },

    /**
     * Read the state of either an application or a queued deployment.
     *
     * The resource type decides the endpoint: a deployment ref is answered by
     * the deployment queue, an application ref by the application record.
     */
    async getDeployment(ctx, ref) {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;

      if (ref.resourceType === "deployment") {
        const response = await call<{ status?: string }>(
          ctx,
          resolved.creds,
          "GET",
          `/api/v1/deployments/${encodeURIComponent(ref.resourceId)}`,
        );
        if (!response.ok) return response;
        return ok("succeeded", {
          ref,
          status: mapQueueStatus(response.value.value?.status),
          url: null,
        });
      }

      const response = await call<{ status?: string; fqdn?: string | null }>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;

      const app = response.value.value ?? {};
      return ok("succeeded", {
        ref,
        status: mapDeploymentStatus(app.status),
        url: app.fqdn ?? null,
      });
    },

    /**
     * Cancel a deployment.
     *
     * Coolify cancels by `deployment_uuid`, so an application ref cannot be
     * cancelled — saying so is better than reporting success for a request
     * Coolify would reject.
     */
    async cancelDeployment(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      if (ref.resourceType !== "deployment") {
        return err(
          "failed",
          `Coolify cancels a deployment by deployment uuid; got a '${ref.resourceType}' ref.`,
        );
      }

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `/api/v1/deployments/${encodeURIComponent(ref.resourceId)}/cancel`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    /**
     * Roll back to a git ref.
     *
     * Coolify requires `commit` and rejects the request without it, so a missing
     * commit is reported rather than sent as a body Coolify will refuse.
     */
    async rollback(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const commit = input.commit?.trim();
      if (!commit) {
        return err("failed", "Coolify rollback requires the commit to roll back to.");
      }

      const response = await call<{ deployment_uuid?: string; message?: string }>(
        ctx,
        resolved.creds,
        "POST",
        `/api/v1/applications/${encodeURIComponent(input.applicationRef.resourceId)}/rollback`,
        { commit },
      );
      if (!response.ok) return response;

      const uuid = response.value.value?.deployment_uuid;
      return ok(
        "running",
        opRef(ctx, uuid ?? input.applicationRef.resourceId, "deployment", uuid ?? undefined),
      );
    },

    /**
     * Read container logs.
     *
     * Coolify's endpoint takes `lines` and `show_timestamps`; it has no cursor,
     * so the page cursor is always null rather than an invented value.
     */
    async getLogs(ctx, ref) {
      const resolved = credentialsFor<LogPage>(ctx);
      if (!resolved.ok) return resolved.result;

      // A deployment ref is answered by the deployment queue, which carries the
      // build/deploy log; an application ref by the application record, which
      // carries the running container's output. They are different logs, and a
      // build failure only appears in the first.
      const path =
        ref.resourceType === "deployment"
          ? `/api/v1/deployments/${encodeURIComponent(ref.resourceId)}`
          : `/api/v1/applications/${encodeURIComponent(ref.resourceId)}/logs?lines=100`;

      const response = await call<{ logs?: string }>(ctx, resolved.creds, "GET", path);
      if (!response.ok) return response;

      const body = response.value.value ?? {};
      return ok("succeeded", {
        lines: body.logs ? body.logs.split("\n") : [],
        // The deployment endpoint has no cursor either; the page cursor stays
        // null rather than an invented value.
        cursor: null,
      });
    },

    /**
     * List an application's environment variables.
     *
     * Coolify returns each variable with its `value` masked unless the token has
     * `read:sensitive`, so this is a key inventory by construction — it says
     * which variables exist and whether they are build-time, never their
     * secret values. `removeSensitiveData` also hides `id`/`uuid` only when
     * `is_shown_once`; where a uuid is present it is kept as the engine handle a
     * delete addresses.
     */
    async listEnvVars(ctx, ref) {
      const resolved = credentialsFor<readonly EnvVarState[]>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<readonly Record<string, unknown>[]>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}/envs`,
      );
      if (!response.ok) return response;

      const rows = Array.isArray(response.value.value) ? response.value.value : [];
      return ok("succeeded", rows.map(toEnvVarState));
    },

    /**
     * Create one environment variable.
     *
     * `is_buildtime` follows Coolify's own default (true) so a variable a
     * customer adds is available at build time unless they say otherwise; a
     * create that returns no key is reported `degraded` rather than invented.
     */
    async createEnvVar(ctx, input) {
      const resolved = credentialsFor<EnvVarState>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<Record<string, unknown>>(
        ctx,
        resolved.creds,
        "POST",
        `/api/v1/applications/${encodeURIComponent(input.applicationRef.resourceId)}/envs`,
        {
          key: input.variable.key,
          value: input.variable.value,
          is_buildtime: input.variable.isBuildTime ?? true,
        },
      );
      if (!response.ok) return response;

      const created = response.value.value ?? {};
      if (typeof created["key"] !== "string" || created["key"] === "") {
        return err("degraded", "Coolify accepted the environment variable but returned no key.");
      }
      return ok("succeeded", toEnvVarState(created));
    },

    /**
     * Update one environment variable by key.
     *
     * Coolify's update route matches the variable by `key` (see
     * `update_env_by_uuid` in the pinned controller), so the key is the identity
     * sent; sending a uuid instead would update the wrong variable or 404.
     */
    async updateEnvVar(ctx, input) {
      const resolved = credentialsFor<EnvVarState>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<Record<string, unknown>>(
        ctx,
        resolved.creds,
        "PATCH",
        `/api/v1/applications/${encodeURIComponent(input.applicationRef.resourceId)}/envs`,
        {
          key: input.variable.key,
          value: input.variable.value,
          ...(input.variable.isBuildTime === undefined
            ? {}
            : { is_buildtime: input.variable.isBuildTime }),
        },
      );
      if (!response.ok) return response;

      const updated = response.value.value ?? {};
      if (typeof updated["key"] !== "string" || updated["key"] === "") {
        return err(
          "degraded",
          "Coolify accepted the environment variable update but returned no key.",
        );
      }
      return ok("succeeded", toEnvVarState(updated));
    },

    /**
     * Delete one environment variable by its uuid.
     *
     * A missing handle is a caller error, reported rather than sent as a request
     * Coolify would reject: the delete route identifies the variable by uuid.
     */
    async deleteEnvVar(ctx, input) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const engineRef = input.engineRef?.trim();
      if (!engineRef) {
        return err("failed", "Deleting an environment variable requires its engine reference.");
      }

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "DELETE",
        `/api/v1/applications/${encodeURIComponent(input.applicationRef.resourceId)}/envs/${encodeURIComponent(engineRef)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async deleteApplication(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "DELETE",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    /**
     * Reconcile against the engine.
     *
     * A 404 means Coolify does not have this application: report
     * `not_configured` for that ref rather than inventing a state.
     * Reconciliation is read-only — it never deploys.
     */
    async reconcile(ctx, ref) {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{ status?: string; fqdn?: string | null }>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) {
        if (response.status === "failed" && response.reason.includes("404")) {
          return err("not_configured", `Coolify has no application ${ref.resourceId}.`);
        }
        return response;
      }

      const app = response.value.value ?? {};
      return ok("succeeded", {
        ref,
        status: mapDeploymentStatus(app.status),
        url: app.fqdn ?? null,
      });
    },
  };
}
