/**
 * View models.
 *
 * Each loader turns an API response into a `Section`. The mapping is the only
 * place a response becomes something a component renders, and it follows one
 * rule: a failure and an unconfigured engine both produce a section with no
 * data. There is no code path that yields `ready` items from a non-ok response.
 */
import { errored, loading, ready, type Section } from "@cloud-wai/ui";
import type { ApiClient, ApiResponse } from "./api-client.js";
import type { Route } from "./routes.js";
import { databaseSectionTitle } from "./navigation.js";

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  /**
   * The engine application this project was created as, once one exists.
   *
   * The slug is that application's name, so the Settings page uses this to know
   * whether the slug is still free to change. Null before the first deployment.
   */
  readonly providerResourceId: string | null;
  /** Container (Coolify) or serverless (Lambda). A project's own choice. */
  readonly executionModel: "container" | "serverless";
  /**
   * The repository-relative directory this project builds from, or null for the
   * repository root.
   *
   * A monorepo project points the engine at the subdirectory holding its app.
   * The Settings page edits it, and locks it once the engine holds the
   * application (which cannot be re-targeted).
   */
  readonly rootDirectory: string | null;
}

export interface DeploymentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "degraded" | "not_configured";
  readonly url: string | null;
  readonly failureReason: string | null;
  /** `production` builds the project's domains; `preview` gets its own URL. */
  readonly kind: "production" | "preview";
  /**
   * Whether this production build was staged: built without being made live
   * (Vercel's `--skip-domain`), so it waits for a promote.
   */
  readonly staged: boolean;
  /**
   * Whether this is the deployment the project's domains currently serve.
   *
   * Vercel's model: a deployment is immutable, and "live" is a pointer to one of
   * them. Only the host may set this, so the badge here is the server's answer.
   */
  readonly isCurrent: boolean;
  readonly gitBranch: string | null;
  readonly gitCommit: string | null;
  readonly pullRequest: number | null;
  /**
   * The clone URL this build was requested from.
   *
   * Present so Redeploy can name what it will rebuild, and so the button can be
   * hidden on a row that recorded no source (a rollback) instead of being
   * offered and then refused. It is a plain public clone URL, never a credential.
   */
  readonly gitRepository: string | null;
}

/**
 * The answer to a promote (or an instant rollback, which is the same move).
 *
 * `previousDeploymentId` names what was live before, so the UI can say "X is now
 * live, replacing Y" rather than a bare success.
 */
export interface PromoteDeploymentSummary {
  readonly deployment: DeploymentSummary;
  readonly previousDeploymentId: string | null;
}

/**
 * The answer to a deployment request.
 *
 * `replayed` says the idempotency key matched an earlier deployment, so nothing
 * new was queued. `engineReason` is the engine's own words when it could not
 * act — shown as "not configured" rather than as a failure the operator caused.
 */
export interface DeploymentRequestSummary {
  readonly deployment: DeploymentSummary;
  readonly replayed: boolean;
  readonly engineReason: string | null;
}

/**
 * The build packs a deployment may pin.
 *
 * Declared here rather than imported from the adapters: the dashboard talks to
 * the API, and the API's contract keeps this as a string precisely so the web
 * bundle never pulls an engine package. The list must stay in step with
 * `BUILD_PACKS` in the adapters; a value the server does not accept is rejected
 * by the procedure, so a drift here fails loudly rather than silently.
 */
export const BUILD_PACK_OPTIONS = [
  "nixpacks",
  "railpack",
  "static",
  "dockerfile",
  "dockercompose",
] as const;
export type BuildPack = (typeof BUILD_PACK_OPTIONS)[number];

export interface AuditSummary {
  readonly id: string;
  readonly event: string;
  readonly actorEmail: string;
  readonly createdAt: string;
}

/** One metric's recorded total for an organization. */
export interface UsageTotalSummary {
  readonly metric: string;
  readonly total: number;
  readonly records: number;
  readonly lastRecordedAt: string | null;
}

interface UsageReportResponse {
  readonly totals: readonly UsageTotalSummary[];
}

/**
 * Load an organization's usage roll-up.
 *
 * This is the Billing page's data. Two existing states carry meaning and must
 * not be conflated: an empty `totals` list is a successful read that found no
 * usage yet, while a not-configured response is the engine being absent. The
 * page renders them differently because they say different things.
 */
export async function loadUsage(
  client: ApiClient,
  organizationId: string,
): Promise<Section<UsageTotalSummary>> {
  const response = await client.call<UsageReportResponse>("billing.usage", { organizationId });
  if (response.notConfigured) {
    return {
      title: "Usage",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Usage", response.error?.message ?? "Request failed.");
  }
  return ready("Usage", response.data?.totals ?? []);
}

/** One budget as the API reports it: the cap, and the period's spend beside it. */
export interface BudgetSummary {
  readonly metric: string;
  readonly limitQuantity: number;
  readonly period: "monthly";
  readonly hardCap: boolean;
  readonly usedQuantity: number;
  readonly ratio: number;
  readonly exceeded: boolean;
}

export interface BudgetReportResponse {
  readonly budgets: readonly BudgetSummary[];
  readonly periodStart: string;
}

/**
 * Load an organization's budgets with their current-period spend.
 *
 * `periodStart` rides along so the page can name the window it is measuring,
 * rather than asserting "this month" from the client's own clock, which would be
 * a second, possibly different, boundary.
 */
export async function loadBudgets(
  client: ApiClient,
  organizationId: string,
): Promise<Section<BudgetSummary>> {
  const response = await client.call<BudgetReportResponse>("billing.budgets.list", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Budgets",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Budgets", response.error?.message ?? "Request failed.");
  }
  return ready("Budgets", response.data?.budgets ?? []);
}

/**
 * One job row as the dashboard renders it.
 *
 * Mirrors the API's `OrchestrationJob`. It is a raw queue row; nothing here is
 * computed by the client, so two views of the same job cannot disagree.
 */
export interface OrchestrationJobSummary {
  readonly id: string;
  readonly kind: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "terminated";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
}

/**
 * The observability report.
 *
 * `latency` fields are null when nothing finished, which is why they are
 * nullable here rather than defaulted to zero — a zero would render as an
 * instant job that never existed. `jobs` is the same data the counts were
 * derived from, so the table cannot show a row the totals did not see.
 */
export interface ObservabilityReportSummary {
  readonly totals: {
    readonly jobs: number;
    readonly active: number;
    readonly failed: number;
    readonly retried: number;
  };
  readonly byState: readonly { readonly state: string; readonly count: number }[];
  readonly byKind: readonly {
    readonly kind: string;
    readonly total: number;
    readonly failed: number;
    readonly retried: number;
    readonly lastError: string | null;
  }[];
  readonly latency: {
    readonly samples: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly maxMs: number | null;
  };
  /** Job creation per day over a fixed trailing window, oldest first. */
  readonly throughput: readonly {
    readonly day: string;
    readonly created: number;
    readonly failed: number;
  }[];
  readonly jobs: readonly OrchestrationJobSummary[];
}

/**
 * Load the organization's job activity.
 *
 * A single call carries the rollup and the rows, so the stat boxes and the
 * table are always the same snapshot. An org with no jobs is `empty`, not a
 * panel of zeros that reads like a working system doing nothing.
 */
export async function loadObservability(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ObservabilityReportSummary>> {
  const response = await client.call<ObservabilityReportSummary>("observability.jobs", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Observability",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Observability", response.error?.message ?? "Request failed.");
  }
  // A payload that is not a report is treated as "nothing to show" rather than
  // dereferenced: the dashboard must not throw on a shape it did not expect.
  const report = response.data as ObservabilityReportSummary | undefined;
  if (!report?.totals) {
    return { title: "Observability", state: { kind: "empty", message: "Nothing here yet." } };
  }
  // No jobs is `empty`, not a success panel of zeros: the stat boxes would read
  // as a working system idling rather than one that has run nothing.
  return report.totals.jobs === 0
    ? { title: "Observability", state: { kind: "empty", message: "Nothing here yet." } }
    : ready("Observability", [report]);
}

/**
 * Convert a response to a section.
 *
 * `notConfigured` is checked before `ok`: the server may answer successfully
 * with an explicit "this deployment cannot do that" marker, and that must render
 * as degraded rather than as an empty list.
 */
export function sectionFrom<T>(title: string, response: ApiResponse<readonly T[]>): Section<T> {
  if (response.notConfigured) {
    return {
      title,
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored(title, response.error?.message ?? "Request failed.");
  }
  return ready(title, response.data ?? []);
}

/** Load the organization list. */
export async function loadOrganizations(client: ApiClient): Promise<Section<OrganizationSummary>> {
  const response = await client.call<readonly OrganizationSummary[]>("organizations.list");
  return sectionFrom("Organizations", response);
}

/** Load the projects of one organization. */
export async function loadProjects(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ProjectSummary>> {
  const response = await client.call<readonly ProjectSummary[]>("projects.list", {
    organizationId,
  });
  return sectionFrom("Projects", response);
}

/** Load the deployments of one project. */
export async function loadDeployments(
  client: ApiClient,
  projectId: string,
): Promise<Section<DeploymentSummary>> {
  const response = await client.call<readonly DeploymentSummary[]>("deployments.list", {
    projectId,
  });
  return sectionFrom("Deployments", response);
}

/**
 * Make a succeeded production deployment live.
 *
 * This is Vercel's "Promote" and its "Instant rollback" in one call: the build
 * already exists, so nothing is rebuilt. The server refuses a preview, an
 * in-flight build and a failed run, and the caller renders that refusal rather
 * than a fabricated success.
 */
export async function promoteDeployment(
  client: ApiClient,
  projectId: string,
  deploymentId: string,
): Promise<Section<PromoteDeploymentSummary>> {
  const response = await client.call<PromoteDeploymentSummary>("deployments.promote", {
    projectId,
    deploymentId,
  });
  return itemFrom("Deployment", response, "That deployment cannot be promoted.");
}

export interface DeploymentLogsSummary {
  readonly lines: readonly string[];
  readonly cursor: string | null;
  /** `deployment` = this run's build/deploy log; `application` = runtime tail. */
  readonly source: "deployment" | "application" | null;
  /** The engine's own words when it could not serve logs. */
  readonly engineReason: string | null;
}

/**
 * Rebuild a past deployment's source.
 *
 * Vercel's "Redeploy", and deliberately not a rollback: the server replays the
 * row's recorded repository and branch into a fresh build, so the engine builds
 * the branch's current head. The server refuses a row that recorded no source,
 * and its refusal is returned to the caller rather than retried into a success.
 */
export async function redeployDeployment(
  client: ApiClient,
  projectId: string,
  deploymentId: string,
  idempotencyKey: string,
): Promise<Section<DeploymentRequestSummary>> {
  const response = await client.call<DeploymentRequestSummary>("deployments.redeploy", {
    projectId,
    deploymentId,
    idempotencyKey,
  });
  return itemFrom("Deployment", response, "That deployment cannot be redeployed.");
}

/**
 * Load a deployment's engine logs.
 *
 * The lines are the engine's own output. A not-configured engine, or a project
 * that was never deployed, answers with an honest reason and no lines; there is
 * no path here that invents log output.
 */
export async function loadDeploymentLogs(
  client: ApiClient,
  projectId: string,
  deploymentId: string,
): Promise<DeploymentLogsSummary> {
  const response = await client.call<DeploymentLogsSummary>("deployments.logs", {
    projectId,
    deploymentId,
  });
  if (response.notConfigured) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: response.error?.message ?? "The hosting engine is not configured.",
    };
  }
  if (!response.ok || !response.data) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: response.error?.message ?? "The logs could not be loaded.",
    };
  }
  return response.data;
}

/**
 * Convert a single-object response to a section.
 *
 * Same rule as `sectionFrom`: a missing row, a failure and an unconfigured
 * engine all produce a section that carries no item, so a detail page cannot
 * render a blank object as if it had loaded.
 */
export function itemFrom<T>(
  title: string,
  response: ApiResponse<T | null | undefined>,
  missingMessage = "Not found.",
): Section<T> {
  if (response.notConfigured) {
    return {
      title,
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored(title, response.error?.message ?? "Request failed.");
  }
  if (response.data === null || response.data === undefined) {
    return errored(title, missingMessage);
  }
  return ready(title, [response.data]);
}

/** Load one project by id. */
export async function loadProject(
  client: ApiClient,
  projectId: string,
): Promise<Section<ProjectSummary>> {
  const response = await client.call<ProjectSummary>("projects.get", { projectId });
  return itemFrom("Project", response, "This project does not exist, or you are not a member.");
}

/** Rename a project. Returns the updated project, or an honest error section. */
export async function updateProject(
  client: ApiClient,
  input: {
    projectId: string;
    name?: string;
    slug?: string;
    executionModel?: "container" | "serverless";
    rootDirectory?: string | null;
  },
): Promise<Section<ProjectSummary>> {
  const response = await client.call<ProjectSummary>("projects.update", input);
  return itemFrom("Project", response, "This project does not exist, or you are not a member.");
}

/** Load one organization by id. */
export async function loadOrganization(
  client: ApiClient,
  organizationId: string,
): Promise<Section<OrganizationSummary>> {
  const response = await client.call<OrganizationSummary>("organizations.get", {
    organizationId,
  });
  return itemFrom(
    "Organization",
    response,
    "This organization does not exist, or you are not a member.",
  );
}

/** Load the members of an organization. */
export async function loadOrganizationMembers(
  client: ApiClient,
  organizationId: string,
): Promise<Section<OrganizationMemberSummary>> {
  const response = await client.call<readonly OrganizationMemberSummary[]>(
    "organizations.members.list",
    { organizationId },
  );
  return sectionFrom("Members", response);
}

/**
 * Change a member's role.
 *
 * The server owns the rank rules (nobody edits their own role, an admin cannot
 * act on an owner, the last owner cannot be demoted) and re-checks them in the
 * policy; the dashboard only offers the choices a caller could be allowed to
 * make, and reports a refusal rather than hiding it.
 */
export async function updateMemberRole(
  client: ApiClient,
  input: { organizationId: string; memberId: string; role: OrganizationMemberSummary["role"] },
): Promise<ApiResponse<OrganizationMemberSummary>> {
  return client.call<OrganizationMemberSummary>("organizations.members.updateRole", input);
}

/**
 * Remove a member.
 *
 * A member removing themselves leaves the organization; anyone else needs to
 * outrank the row. The last owner is refused, so this cannot empty an
 * organization of everyone who can manage it.
 */
export async function removeMember(
  client: ApiClient,
  input: { organizationId: string; memberId: string },
): Promise<ApiResponse<{ removed: boolean }>> {
  return client.call<{ removed: boolean }>("organizations.members.remove", input);
}

export interface DomainSummary {
  readonly id: string;
  readonly hostname: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
}

/**
 * A member of the organization, as the settings page lists them.
 *
 * `email` and `displayName` can be null: a membership row exists before the
 * invited user has ever signed in and written a profile, and the page says
 * "not yet signed in" rather than inventing an address.
 */
export interface OrganizationMemberSummary {
  readonly userId: string;
  readonly role: "owner" | "admin" | "member" | "viewer";
  readonly email: string | null;
  readonly displayName: string | null;
  readonly createdAt: string;
}

/**
 * The answer to a domain request.
 *
 * `recordName` and `recordValue` are the DNS challenge the customer must
 * publish. It is a public value, so showing it is correct — unlike a key secret.
 */
export interface DomainChallengeSummary {
  readonly domain: DomainSummary;
  readonly recordName: string;
  readonly recordValue: string;
  readonly recordType: string;
}

export interface DomainVerificationSummary {
  readonly domain: DomainSummary;
  readonly detail: string;
}

export interface DataResourceSummary {
  readonly id: string;
  readonly kind: "postgres" | "object_storage";
  readonly name: string;
  /** The project this resource belongs to, or null when it is organization-wide. */
  readonly projectId?: string | null;
  /** Mirrors the `data_resource_state` enum. The server, never the client, writes it. */
  readonly state: "provisioning" | "ready" | "restoring" | "failed" | "not_configured";
  /**
   * The engine console's own pages for this resource, resolved by the server.
   *
   * Null means the deployment has no tenant-reachable console for this resource
   * — which the Database sub-pages report as "not configured" rather than
   * rendering a link that would 404. The browser never builds this URL itself:
   * the engine's URL grammar lives in the adapter layer, so the two cannot drift.
   * Keys are the console's section names (`overview`, `logs`, `terminal`, …).
   */
  readonly engineConsole?: Readonly<Record<string, string>> | null;
}

/** A provision or backup answer, with the engine's own words when it refused. */
export interface ProvisionDataSummary {
  readonly resource: DataResourceSummary;
  readonly engineReason: string | null;
}

export interface BackupDataSummary {
  readonly backup: DataBackupSummary;
  readonly engineReason: string | null;
}

export interface RestoreDataSummary {
  readonly restore: DataRestoreSummary;
  readonly engineReason: string | null;
}

/**
 * The answer to a credential rotation.
 *
 * It deliberately carries no credential: the engine writes the new password into
 * its own store and the control plane keeps no copy, so there is nothing here to
 * render beside the outcome.
 */
export interface RotateCredentialsSummary {
  readonly resource: DataResourceSummary;
  readonly engineReason: string | null;
}

/** One restore attempt, naming both the backup it read and the resource it wrote. */
export interface DataRestoreSummary {
  readonly id: string;
  readonly backupId: string;
  readonly dataResourceId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "not_configured";
  readonly providerResourceId: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** One backup attempt, with the engine's own status. */
export interface DataBackupSummary {
  readonly id: string;
  readonly dataResourceId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "not_configured";
  readonly providerResourceId: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/**
 * A database's log, as the engine answered.
 *
 * `engineReason` is null when the engine answered and the reason string when it
 * refused, so the page shows "the engine could not be read" as an engine state
 * rather than as a failure of the dashboard. `lines` is empty in that case; it
 * is never a placeholder. `cursor` is null because the database log endpoint has
 * no pagination.
 */
export interface DataLogSummary {
  readonly engineReason: string | null;
  readonly lines: readonly string[];
  readonly cursor: string | null;
}

export interface SecurityPolicySummary {
  readonly id: string;
  readonly name: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly action: "allow" | "log" | "challenge" | "block" | "quarantine";
  readonly state: "draft" | "compiled" | "distributed" | "active" | "rejected" | "degraded";
  /**
   * The protection posture. `normal` inspects and logs; `attack` challenges
   * browsers. It is stored and compiled, so it survives a page reload — the UI
   * never keeps it in local state.
   */
  readonly protectionMode: "normal" | "attack";
  /** When an attack posture lapses, or null when it does not. */
  readonly protectionExpiresAt: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

/** One row of a customer's deny list, as the server stores it. */
export interface SecurityRuleSummary {
  readonly id: string;
  readonly kind: "ip" | "cidr" | "asn" | "user-agent";
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/**
 * One trusted source address, as the server stores it.
 *
 * The allow half of the security policy: an address that is never challenged or
 * blocked, so a customer's own webhook senders and CI runners keep working while
 * attack mode is up.
 */
export interface TrustedSourceSummary {
  readonly id: string;
  readonly kind: "ip" | "cidr";
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** A crawler that keeps working when attack mode is on, with its proof. */
export interface VerifiedBotSummary {
  readonly name: string;
  readonly userAgent: string;
  readonly confirmSuffix: string;
}

/**
 * One per-route request rate limit, as the server stores it.
 *
 * The third arm of the security policy, beside the deny list (what to block) and
 * the trusted sources (what to let through): what to *throttle*. A scraper is
 * not necessarily hostile, only disproportionate, so a limit a normal visitor
 * never reaches keeps a human served and a scrape uneconomic. It is compiled
 * after the allow steps, so an allowed crawler is never counted.
 */
export interface RateLimitSummary {
  readonly id: string;
  readonly key: "ip" | "header" | "global";
  readonly headerName: string | null;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface SecurityPolicyReadSummary {
  readonly policy: SecurityPolicySummary | null;
  readonly events: readonly SecurityPolicyEventSummary[];
}

/** One transition in a policy's lifecycle, as the server recorded it. */
export interface SecurityPolicyEventSummary {
  readonly id: string;
  readonly toState: string;
  readonly fromState: string | null;
  readonly version: number;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface DistributePolicySummary {
  readonly policy: SecurityPolicySummary;
  readonly distributed: boolean;
  readonly engineReason: string | null;
}

export interface ApiKeySummaryRow {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly revokedAt: string | null;
}

/** The secret exists on the create response and nowhere else. */
export interface IssuedApiKey {
  readonly key: ApiKeySummaryRow;
  readonly secret: string;
}

/**
 * The scopes a key can be granted, offered in the create form.
 *
 * These mirror the server's capability list. The server narrows whatever is
 * requested to the caller's own role before it stores the key, so offering one
 * a member cannot hold is harmless: the request succeeds and the granted scopes
 * come back narrower than asked for.
 */
export const API_KEY_SCOPES: readonly string[] = [
  "org:read",
  "project:read",
  "project:create",
  "deployment:read",
  "deployment:create",
  "data:read",
  "domain:read",
  "security:read",
  "apikey:read",
  "audit:read",
];

/**
 * The metrics a cap can name, offered in the budget form.
 *
 * These mirror `USAGE_METRICS` on the API — the two quantities this build's
 * worker records. Offering anything else would let the form create a cap that
 * nothing can ever move.
 */
export const USAGE_METRIC_CHOICES: readonly string[] = ["deployments", "backups"];

/** An engine the dashboard shows, with the honest reason for its state. */
export interface ProviderHealthRow {
  readonly provider: string;
  readonly state: "ready" | "not_configured";
  readonly detail: string;
}

/** Load an organization's domains, narrowed to a project when one is given. */
export async function loadDomains(
  client: ApiClient,
  organizationId: string,
  projectId?: string | undefined,
): Promise<Section<DomainSummary>> {
  const response = await client.call<readonly DomainSummary[]>("domains.list", {
    organizationId,
    ...(projectId ? { projectId } : {}),
  });
  return sectionFrom("Domains", response);
}

/** Load an organization's data resources. */
export async function loadDataResources(
  client: ApiClient,
  organizationId: string,
): Promise<Section<DataResourceSummary>> {
  const response = await client.call<readonly DataResourceSummary[]>("data.list", {
    organizationId,
  });
  return sectionFrom("Databases and storage", response);
}

/**
 * Load a resource's backups.
 *
 * The server records every attempt with the engine's own status. Reading them
 * back is what makes a backup auditable: a `failed` or `not_configured` attempt
 * is visible as such rather than lost once the dialog closes.
 */
export async function loadDataBackups(
  client: ApiClient,
  organizationId: string,
  resourceId: string,
): Promise<Section<DataBackupSummary>> {
  const response = await client.call<readonly DataBackupSummary[]>("data.backups.list", {
    organizationId,
    resourceId,
  });
  return sectionFrom("Backups", response);
}

/**
 * Load a resource's restores.
 *
 * A restore is destructive and its history is what makes it auditable: the
 * server records every attempt with the engine's own status, and reading them
 * back keeps a `failed` or `not_configured` restore visible rather than lost
 * once the dialog closes.
 */
export async function loadDataRestores(
  client: ApiClient,
  organizationId: string,
  resourceId: string,
): Promise<Section<DataRestoreSummary>> {
  const response = await client.call<readonly DataRestoreSummary[]>("data.restores.list", {
    organizationId,
    resourceId,
  });
  return sectionFrom("Restores", response);
}

/**
 * Load a database's engine log.
 *
 * The lines are the engine's own container output. An unconfigured or
 * unreachable engine answers with an honest `engineReason` and no lines, and
 * that is what the page renders — there is no path here that invents output.
 * A not-configured response is normalized to the same shape as a refusal so the
 * page has one state to render, not two.
 */
export async function loadDataLogs(
  client: ApiClient,
  organizationId: string,
  resourceId: string,
): Promise<DataLogSummary> {
  const response = await client.call<DataLogSummary>("data.logs", {
    organizationId,
    resourceId,
  });
  if (response.notConfigured) {
    return {
      engineReason: response.error?.message ?? "The database engine is not configured.",
      lines: [],
      cursor: null,
    };
  }
  if (!response.ok || !response.data) {
    return {
      engineReason: response.error?.message ?? "The log could not be loaded.",
      lines: [],
      cursor: null,
    };
  }
  return response.data;
}

/** Load an organization's API keys. The secret is never in this list. */
export async function loadApiKeys(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ApiKeySummaryRow>> {
  const response = await client.call<readonly ApiKeySummaryRow[]>("apiKeys.list", {
    organizationId,
  });
  return sectionFrom("API keys", response);
}

/** Load provider health. A not-configured engine renders as degraded, not ready. */
export async function loadProviderHealth(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ProviderHealthRow>> {
  const response = await client.call<readonly ProviderHealthRow[]>("providers.health", {
    organizationId,
  });
  return sectionFrom("Engine status", response);
}

/**
 * Load the organization's security policy.
 *
 * A missing policy is not an error: it renders as an empty list under the same
 * rule as every other section, so "no policy yet" and "the load failed" stay
 * distinguishable. The policy state is the server's, never inferred here.
 */
export async function loadSecurityPolicy(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityPolicySummary>> {
  const response = await client.call<SecurityPolicyReadSummary>("security.policy.get", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Security policy",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Security policy", response.error?.message ?? "Request failed.");
  }
  const policy = response.data?.policy;
  return ready("Security policy", policy ? [policy] : []);
}

/**
 * Load a policy's transition history.
 *
 * The server records every move between states — a save to `draft`, a
 * distribution that became `active`, one the edge rejected. Dropping it would
 * leave an operator unable to see *why* a policy is not active, so it is
 * surfaced rather than discarded.
 */
export async function loadSecurityPolicyEvents(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityPolicyEventSummary>> {
  const response = await client.call<SecurityPolicyReadSummary>("security.policy.get", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Policy history",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Policy history", response.error?.message ?? "Request failed.");
  }
  return ready("Policy history", response.data?.events ?? []);
}

/** Load the audit log of one organization. */
export async function loadAudit(
  client: ApiClient,
  organizationId: string,
): Promise<Section<AuditSummary>> {
  const response = await client.call<readonly AuditSummary[]>("audit.list", { organizationId });
  return sectionFrom("Recent activity", response);
}

/**
 * Render audit rows as CSV.
 *
 * It exports exactly the rows the caller passes — the same rows the table shows,
 * which is the newest slice the API returns — so the file never claims to be the
 * whole history. Every field is quoted and internal quotes doubled (RFC 4180), so
 * an event name or an email containing a comma or a quote cannot shift a column.
 */
export function auditCsv(events: readonly AuditSummary[]): string {
  const cell = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const header = ["id", "event", "actor", "created_at"].map(cell).join(",");
  const lines = events.map((event) =>
    [event.id, event.event, event.actorEmail ?? "", event.createdAt].map(cell).join(","),
  );
  return [header, ...lines].join("\r\n");
}

/**
 * Load the customer's deny list.
 *
 * Unlike the engine-backed sections, a deployment that predates the deny list
 * answers with the honest `engine_unavailable`; that is surfaced as degraded
 * with the server's own reason rather than an empty list, so "none yet" and
 * "not supported here" stay distinguishable.
 */
export async function loadSecurityRules(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityRuleSummary>> {
  const response = await client.call<readonly SecurityRuleSummary[]>("security.rules.list", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Deny list",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  return sectionFrom("Deny list", response);
}

/**
 * Load the customer's trusted source addresses.
 *
 * A deployment that predates the table answers with the honest
 * `engine_unavailable`, surfaced as degraded so "none yet" and "not supported
 * here" stay distinguishable.
 */
export async function loadTrustedSources(
  client: ApiClient,
  organizationId: string,
): Promise<Section<TrustedSourceSummary>> {
  const response = await client.call<readonly TrustedSourceSummary[]>(
    "security.trustedSources.list",
    { organizationId },
  );
  return sectionFrom("Trusted sources", response);
}

/** Trust an address, so it is allowed through even in attack mode. */
export async function addTrustedSource(
  client: ApiClient,
  input: {
    organizationId: string;
    kind: "ip" | "cidr";
    value: string;
    note?: string;
  },
): Promise<ApiResponse<TrustedSourceSummary>> {
  return client.call<TrustedSourceSummary>("security.trustedSources.add", input);
}

/** Stop trusting an address. Idempotent: removing an absent one is not an error. */
export async function removeTrustedSource(
  client: ApiClient,
  input: { organizationId: string; sourceId: string },
): Promise<ApiResponse<{ removed: boolean }>> {
  return client.call<{ removed: boolean }>("security.trustedSources.remove", input);
}

/**
 * Load the organization's request rate limits.
 *
 * A deployment that predates the table answers with the honest
 * `engine_unavailable`, surfaced as degraded, so "no limits yet" and "not
 * supported here" stay distinguishable — the same shape the trusted sources use.
 */
export async function loadRateLimits(
  client: ApiClient,
  organizationId: string,
): Promise<Section<RateLimitSummary>> {
  const response = await client.call<readonly RateLimitSummary[]>("security.rateLimits.list", {
    organizationId,
  });
  return sectionFrom("Rate limits", response);
}

/** Set a rate limit, so a burst is throttled without affecting a normal visitor. */
export async function addRateLimit(
  client: ApiClient,
  input: {
    organizationId: string;
    key: "ip" | "header" | "global";
    headerName?: string;
    limit: number;
    windowSeconds: number;
    note?: string;
  },
): Promise<ApiResponse<RateLimitSummary>> {
  return client.call<RateLimitSummary>("security.rateLimits.add", input);
}

/** Remove a rate limit. Idempotent: removing an absent one is not an error. */
export async function removeRateLimit(
  client: ApiClient,
  input: { organizationId: string; rateLimitId: string },
): Promise<ApiResponse<{ removed: boolean }>> {
  return client.call<{ removed: boolean }>("security.rateLimits.remove", input);
}

/**
 * Load the edge's recent decisions — what it allowed, logged, challenged or
 * blocked, and at which stage of the ladder.
 *
 * This is the read that turns a block from a mystery into an attributable
 * event. A deployment whose store predates the read answers with the honest
 * `engine_unavailable`, surfaced as degraded rather than an empty list.
 */
export async function loadSecurityEvents(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityEventSummary>> {
  const response = await client.call<{ events: readonly SecurityEventSummary[] }>(
    "security.events.list",
    { organizationId },
  );
  if (response.notConfigured) {
    return {
      title: "Edge decisions",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Edge decisions", response.error?.message ?? "Request failed.");
  }
  return ready("Edge decisions", response.data?.events ?? []);
}

/** One request-level decision the edge made. */
export interface SecurityEventSummary {
  readonly id: string;
  readonly host: string;
  readonly stage: string;
  readonly action: "allow" | "log" | "challenge" | "block" | "quarantine";
  readonly clientIp: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly userAgent: string | null;
  readonly observedAt: string;
}

/**
 * Load the organization's security incidents.
 *
 * The decisions read answers "what did the edge do with this request". This is
 * the layer above it: the grouped signals that need a human — a rejected policy
 * distribution, and (later) an origin leak or a rule-volume spike — with their
 * lifecycle. A deployment whose store predates the incident table answers with
 * the honest `engine_unavailable`, surfaced as degraded rather than empty.
 */
export async function loadSecurityIncidents(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityIncidentSummary>> {
  const response = await client.call<{ incidents: readonly SecurityIncidentSummary[] }>(
    "security.incidents.list",
    { organizationId },
  );
  if (response.notConfigured) {
    return {
      title: "Incidents",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Incidents", response.error?.message ?? "Request failed.");
  }
  return ready("Incidents", response.data?.incidents ?? []);
}

/** A grouped security incident, with the lifecycle that makes it actionable. */
export interface SecurityIncidentSummary {
  readonly id: string;
  readonly kind: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly state: "open" | "triaged" | "resolved" | "false_positive";
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly resolution: string | null;
}

/**
 * Load the verified-bot directory.
 *
 * This is the answer to "will attack mode break my search ranking": the crawlers
 * whose requests carry a verifiable reverse-DNS confirmation, and therefore keep
 * working even while browsers are challenged.
 */
export async function loadVerifiedBots(
  client: ApiClient,
  organizationId: string,
): Promise<Section<VerifiedBotSummary>> {
  const response = await client.call<{ bots: readonly VerifiedBotSummary[] }>(
    "security.bots.list",
    { organizationId },
  );
  if (response.notConfigured) {
    return {
      title: "Verified bots",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Verified bots", response.error?.message ?? "Request failed.");
  }
  return ready("Verified bots", response.data?.bots ?? []);
}

/** A repository linked to a project. Never includes the webhook secret. */
export interface GitLinkSummary {
  readonly id: string;
  readonly projectId: string;
  readonly provider: "github" | "gitlab" | "bitbucket" | "generic";
  readonly repository: string;
  readonly productionBranch: string;
  readonly previewsEnabled: boolean;
  /** A short, non-secret fragment naming the stored secret. */
  readonly secretPrefix: string;
  readonly createdAt: string;
}

/** The moment a link is created: the link, and the secret exactly once. */
export interface ConnectedGitLinkSummary {
  readonly link: GitLinkSummary;
  readonly webhookSecret: string;
}

/**
 * The public clone URL for a stored link.
 *
 * Declared here rather than imported from the API: the dashboard talks to the
 * API over its contract, and the API keeps a link as `owner/name` precisely so
 * the web bundle never pulls server code. This mirrors `cloneUrlFor` in
 * `apps/api/src/procedures/git-links.ts`; the two must stay in step, and a
 * provider the server learns to clone but the client does not simply pre-fills
 * nothing (never a wrong host).
 */
export function cloneUrlFor(
  provider: GitLinkSummary["provider"],
  repository: string,
): string | null {
  switch (provider) {
    case "github":
      return `https://github.com/${repository}.git`;
    case "gitlab":
      return `https://gitlab.com/${repository}.git`;
    case "bitbucket":
      return `https://bitbucket.org/${repository}.git`;
    case "generic":
      return null;
  }
}

/** The repositories linked to a project. */
export async function loadGitLinks(
  client: ApiClient,
  projectId: string,
): Promise<Section<GitLinkSummary>> {
  const response = await client.call<readonly GitLinkSummary[]>("git.links.list", { projectId });
  return sectionFrom("Repositories", response);
}

/**
 * Build the repository a project has connected, now, without waiting for a push.
 *
 * This is the operator-triggered counterpart of a webhook delivery: the server
 * resolves the link's clone URL and branch and runs the one deploy path, so the
 * answer carries the same deployment shape a Deploy button returns. A project
 * with no link (or a `generic` link with no derivable clone host) answers with
 * the server's own words rather than a guessed repository.
 */
export async function deployFromLink(
  client: ApiClient,
  projectId: string,
  idempotencyKey: string,
): Promise<ApiResponse<DeploymentRequestSummary>> {
  return client.call<DeploymentRequestSummary>("git.deployNow", { projectId, idempotencyKey });
}

/** The clone URL and branch a connected repository resolves to, for prefill. */
export async function loadGitDeploySource(
  client: ApiClient,
  projectId: string,
): Promise<Section<GitDeploySource>> {
  const response = await client.call<readonly GitLinkSummary[]>("git.links.list", { projectId });
  const title = "Repositories";
  if (response.notConfigured) {
    return {
      title,
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored(title, response.error?.message ?? "Request failed.");
  }
  const link = (response.data ?? [])[0];
  const repository = link ? cloneUrlFor(link.provider, link.repository) : null;
  // A project with no link, or a `generic` link with no derivable host, has no
  // source to prefill. `ready` with an empty list is the honest shape: the
  // caller pre-fills nothing rather than a guessed URL.
  return ready(title, repository ? [{ repository, branch: link!.productionBranch }] : []);
}

/** A connected repository resolved to a clone URL and branch. */
export interface GitDeploySource {
  readonly repository: string;
  readonly branch: string;
}

/**
 * One environment variable, as the browser is allowed to see it.
 *
 * There is no `value` field and there never will be: the API returns a
 * fingerprint (`valuePrefix`) and the engine reference, so a page can show that
 * a variable exists and where it landed without ever holding the secret. That is
 * why this type is separate from the write input below rather than optional
 * fields on a shared shape.
 */
export interface EnvVarSummary {
  readonly id: string;
  readonly key: string;
  readonly valuePrefix: string;
  readonly isBuildTime: boolean;
  readonly updatedAt: string;
}

/** The project's environment variables. */
export async function loadEnvVars(
  client: ApiClient,
  projectId: string,
): Promise<Section<EnvVarSummary>> {
  const response = await client.call<readonly EnvVarSummary[]>("env.list", { projectId });
  return sectionFrom("Environment variables", response);
}

/** What the API reports after a variable is set or replaced. */
export interface SetEnvVarOutcome {
  readonly variable: EnvVarSummary;
  readonly applied: "engine" | "stored";
  readonly redeployRequired: boolean;
  readonly engineReason: string | null;
}

export interface DashboardModel {
  readonly title: string;
  readonly sections: readonly Section<unknown>[];
}

/**
 * Build the model for a route.
 *
 * Sections that are not relevant to the route are simply absent, so a view
 * cannot accidentally render data it was not meant to load.
 */
export async function loadRoute(client: ApiClient, route: Route): Promise<DashboardModel> {
  switch (route.name) {
    case "landing":
      // The landing page is static marketing copy: it reads nothing, so it has
      // no section and cannot show a state it did not load.
      return { title: "Cloud Wai", sections: [] };

    case "organizations":
      return { title: "Organizations", sections: [await loadOrganizations(client)] };

    case "organization":
      return {
        title: "Organization",
        sections: [loading("Projects"), await loadAudit(client, route.organizationId)],
      };

    case "projects":
      return { title: "Projects", sections: [await loadProjects(client, route.organizationId)] };

    case "project":
    case "deployments":
      return { title: "Deployments", sections: [await loadDeployments(client, route.projectId)] };

    case "domains":
      return {
        title: "Domains",
        sections: [await loadDomains(client, route.organizationId, route.projectId)],
      };

    case "database":
      return {
        title: databaseSectionTitle(route.section ?? "overview"),
        sections: [await loadDataResources(client, route.organizationId)],
      };

    case "security":
      // Security shows policy and incident state through the same
      // not-configured-or-ready lens as every other engine-backed view.
      return {
        title: "Security",
        sections: [await loadProviderHealth(client, route.organizationId)],
      };

    case "projectSettings":
      return {
        title: "Settings",
        sections: [await loadProject(client, route.projectId)],
      };

    case "git":
      return {
        title: "Git",
        sections: [await loadGitLinks(client, route.projectId)],
      };

    case "env":
      return {
        title: "Environment",
        sections: [await loadEnvVars(client, route.projectId)],
      };

    case "audit":
      return { title: "Activity", sections: [await loadAudit(client, route.organizationId)] };

    case "observability":
      return {
        title: "Observability",
        sections: [await loadObservability(client, route.organizationId)],
      };

    case "billing":
      return { title: "Billing", sections: [await loadUsage(client, route.organizationId)] };

    case "settings":
      return {
        title: "Settings",
        sections: [await loadProviderHealth(client, route.organizationId)],
      };

    case "apiKeys":
      return { title: "API keys", sections: [await loadApiKeys(client, route.organizationId)] };

    case "not_found":
      return {
        title: "Not found",
        sections: [errored("Page", `No route matches ${route.path}.`)],
      };
  }
}
