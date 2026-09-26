/**
 * The procedure table.
 *
 * This is the complete set of operations the API exposes, and the reference
 * implementation the HTTP adapter mounts. Each entry declares its own scope
 * requirement through the guard, so adding a procedure cannot accidentally skip
 * an authorization check: there is no way to register one without a handler,
 * and every handler calls `requireCapability` or reads only the caller's own
 * memberships.
 */
import type { DataStore, Organization, Project } from "@cloud-wai/database";
import type { ApiKeyId, ExecutionModel, OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { OrgRole } from "@cloud-wai/authorization";
import {
  buildNotConfigured,
  databaseNotConfigured,
  domainVerifierNotConfigured,
  hostingNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  storageNotConfigured,
  type Engines,
  type JobQueue,
} from "@cloud-wai/adapters";
import { ApiError } from "../errors.js";
import type { Procedure } from "../router.js";
import {
  createOrganization,
  createProject,
  getOrganization,
  getProject,
  listOrganizationMembers,
  listOrganizations,
  listProjects,
  removeOrganizationMember,
  updateOrganizationMemberRole,
  updateProject,
  type OrgDeps,
} from "./organizations.js";
import {
  cancelDeployment,
  deploymentsLogs,
  promoteDeployment,
  requestDeployment,
  listAuditEvents,
  listDeployments,
  rollbackDeployment,
  redeployDeployment,
  type CancelDeploymentInput,
  type CreateDeploymentInput,
  type DeploymentDeps,
  type DeploymentLogsInput,
  type PromoteDeploymentRequest,
  type RedeployDeploymentInput,
  type RollbackDeploymentInput,
} from "./deployments.js";
import {
  createApiKey,
  listApiKeys,
  listDataResources,
  listDomains,
  revokeApiKey,
  type ConsoleLinkResolver,
  type SettingsDeps,
} from "./settings.js";
import {
  addDomain,
  removeDomain,
  verifyDomain,
  type AddDomainInput,
  type DomainDeps,
  type RemoveDomainInput,
  type VerifyDomainInput,
} from "./domains.js";
import {
  backupDataResource,
  listDataBackups,
  listDataRestores,
  provisionDataResource,
  readDataLogs,
  restoreDataResource,
  rotateDataCredentials,
  type BackupDataInput,
  type DataDeps,
  type ListBackupsInput,
  type ListRestoresInput,
  type ProvisionDataInput,
  type ReadDataLogsInput,
  type RestoreDataInput,
  type RotateCredentialsInput,
} from "./data.js";
import {
  addRateLimit,
  addSecurityRule,
  addTrustedSource,
  distributeSecurityPolicy,
  listRateLimits,
  listSecurityEvents,
  listSecurityIncidents,
  listSecurityRules,
  listTrustedSources,
  readSecurityPolicy,
  readVerifiedBots,
  removeRateLimit,
  removeSecurityRule,
  removeTrustedSource,
  saveSecurityPolicy,
  transitionSecurityIncident,
  type AddRateLimitInput,
  type AddSecurityRuleInput,
  type AddTrustedSourceInput,
  type DistributePolicyInput,
  type RemoveRateLimitInput,
  type RemoveSecurityRuleInput,
  type RemoveTrustedSourceInput,
  type SavePolicyInput,
  type SecurityDeps,
  type TransitionIncidentInput,
} from "./security.js";
import { providerHealth, type HealthDeps } from "./health.js";
import {
  connectGitLink,
  deployFromLink,
  disconnectGitLink,
  listGitLinks,
  type ConnectGitLinkInput,
  type DeployNowInput,
  type DisconnectGitLinkInput,
  type GitLinkDeps,
} from "./git-links.js";
import type { SecretCipher } from "@cloud-wai/auth";
import {
  listEnvVars,
  removeEnvVar,
  setEnvVar,
  type EnvVarDeps,
  type ListEnvVarsInput,
  type RemoveEnvVarInput,
  type SetEnvVarInput,
} from "./env-vars.js";
import { readUsage, readBudgets, saveBudget, removeBudget, type BillingDeps } from "./billing.js";
import { readObservability, type ObservabilityDeps } from "./observability.js";
import type { RequestContext } from "../context.js";

type WithInput<T> = (input: unknown) => T;

function inputOf<T>(input: unknown): T {
  return input as T;
}

/**
 * Engines for a deployment with none wired.
 *
 * These are the real not-configured adapters, not empty objects: an empty engine
 * set would be reported as *configured* by a  brand check and the
 * dashboard would show four healthy providers that cannot do anything.
 */
const missingEngines: Engines = {
  hosting: hostingNotConfigured("coolify"),
  serverless: serverlessNotConfigured("lambda"),
  database: databaseNotConfigured("postgres"),
  storage: storageNotConfigured("minio"),
  build: buildNotConfigured("railpack"),
  securityEdge: securityNotConfigured("envoy"),
  domainVerifier: domainVerifierNotConfigured("dns"),
};

export interface ProcedureExtras {
  /** Live engines, for the provider-health procedure. */
  readonly engines?: HealthDeps["engines"];
  /** Injected id source, so a new key gets a Cloud Wai UUID. */
  readonly newId?: () => string;
  /** Injected challenge source, so a domain token is deterministic in tests. */
  readonly newToken?: (() => string) | undefined;
  readonly now?: () => Date;
  /**
   * When wired, deploy and rollback commands become durable jobs executed by the
   * worker instead of running on the request path. Omitted in tests that pin the
   * synchronous behaviour.
   */
  readonly queue?: JobQueue;
  /**
   * The cipher for webhook secrets. Null (the default) means git links cannot be
   * stored: `git.connect` answers `engine_unavailable` rather than writing a
   * plaintext secret. Wired from `CLOUD_WAI_SECRET_ENCRYPTION_KEY` at bootstrap.
   */
  readonly secretCipher?: SecretCipher | null;
  /** Injected so a webhook secret is deterministic in tests. */
  readonly newSecret?: (() => string) | undefined;
  /**
   * Resolves a data resource's engine-console link from the deployment's own
   * engine configuration. Absent means `data.list` carries null links, which the
   * dashboard shows as "not configured" rather than a broken URL.
   */
  readonly consoleLink?: ConsoleLinkResolver | undefined;
}

export function buildProcedures(
  store: DataStore,
  extras: ProcedureExtras = {},
): readonly Procedure[] {
  const orgDeps: OrgDeps = { store };
  const newId =
    extras.newId ??
    (() => {
      throw new ApiError("engine_unavailable", "This deployment cannot issue Cloud Wai ids yet.");
    });
  const depDeps: DeploymentDeps = {
    store,
    engines: extras.engines ?? missingEngines,
    newId,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const settingsDeps: SettingsDeps = {
    store,
    newId,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.consoleLink ? { consoleLink: extras.consoleLink } : {}),
  };
  const domainDeps: DomainDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.newToken ? { newToken: extras.newToken } : {}),
  };
  const healthDeps: HealthDeps = {
    engines: extras.engines ?? missingEngines,
  };
  const dataDeps: DataDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const securityDeps: SecurityDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const billingDeps: BillingDeps = { store };
  const observabilityDeps: ObservabilityDeps = { store };
  const gitLinkDeps: GitLinkDeps = {
    store,
    newId,
    cipher: extras.secretCipher ?? null,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.newSecret ? { newSecret: extras.newSecret } : {}),
  };
  const envVarDeps: EnvVarDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    cipher: extras.secretCipher ?? null,
    ...(extras.now ? { now: extras.now } : {}),
  };

  return [
    {
      name: "organizations.list",
      handler: (ctx: RequestContext) => listOrganizations(ctx, orgDeps),
    },
    {
      name: "organizations.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createOrganization(ctx, orgDeps, inputOf<{ name: string; slug: string }>(input)),
    },
    {
      name: "organizations.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        getOrganization(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "organizations.members.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listOrganizationMembers(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "organizations.members.updateRole",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        updateOrganizationMemberRole(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId; memberId: string; role: OrgRole }>(input),
        ),
    },
    {
      name: "organizations.members.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeOrganizationMember(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId; memberId: string }>(input),
        ),
    },
    {
      name: "projects.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listProjects(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "projects.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        getProject(ctx, orgDeps, inputOf<{ projectId: ProjectId }>(input).projectId),
    },
    {
      name: "projects.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createProject(
          ctx,
          orgDeps,
          inputOf<{
            organizationId: OrganizationId;
            name: string;
            slug: string;
            executionModel?: ExecutionModel;
            rootDirectory?: string;
          }>(input),
        ),
    },
    {
      name: "projects.update",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        updateProject(
          ctx,
          orgDeps,
          inputOf<{
            projectId: ProjectId;
            name?: string;
            slug?: string;
            executionModel?: ExecutionModel;
            rootDirectory?: string | null;
          }>(input),
        ),
    },
    {
      name: "deployments.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDeployments(ctx, depDeps, inputOf<{ projectId: ProjectId }>(input).projectId),
    },
    {
      name: "deployments.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        requestDeployment(ctx, depDeps, inputOf<CreateDeploymentInput>(input)),
    },
    {
      name: "deployments.rollback",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        rollbackDeployment(ctx, depDeps, inputOf<RollbackDeploymentInput>(input)),
    },
    {
      name: "deployments.redeploy",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        redeployDeployment(ctx, depDeps, inputOf<RedeployDeploymentInput>(input)),
    },
    {
      name: "deployments.promote",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        promoteDeployment(ctx, depDeps, inputOf<PromoteDeploymentRequest>(input)),
    },
    {
      name: "deployments.logs",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        deploymentsLogs(ctx, depDeps, inputOf<DeploymentLogsInput>(input)),
    },
    {
      name: "deployments.cancel",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        cancelDeployment(ctx, depDeps, inputOf<CancelDeploymentInput>(input)),
    },
    {
      name: "audit.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listAuditEvents(
          ctx,
          depDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "git.links.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listGitLinks(ctx, gitLinkDeps, inputOf<{ projectId: ProjectId }>(input)),
    },
    {
      name: "git.connect",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        connectGitLink(ctx, gitLinkDeps, inputOf<ConnectGitLinkInput>(input)),
    },
    {
      name: "git.disconnect",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        disconnectGitLink(ctx, gitLinkDeps, inputOf<DisconnectGitLinkInput>(input)),
    },
    {
      name: "git.deployNow",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        deployFromLink(
          ctx,
          gitLinkDeps,
          (innerCtx, deployInput) => requestDeployment(innerCtx, depDeps, deployInput),
          inputOf<DeployNowInput>(input),
        ),
    },
    {
      name: "env.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listEnvVars(ctx, envVarDeps, inputOf<ListEnvVarsInput>(input)),
    },
    {
      name: "env.set",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        setEnvVar(ctx, envVarDeps, inputOf<SetEnvVarInput>(input)),
    },
    {
      name: "env.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeEnvVar(ctx, envVarDeps, inputOf<RemoveEnvVarInput>(input)),
    },
    {
      name: "domains.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) => {
        const parsed = inputOf<{ organizationId: OrganizationId; projectId?: ProjectId }>(input);
        return listDomains(ctx, settingsDeps, parsed.organizationId, parsed.projectId);
      },
    },
    {
      name: "domains.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addDomain(ctx, domainDeps, inputOf<AddDomainInput>(input)),
    },
    {
      name: "domains.verify",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        verifyDomain(ctx, domainDeps, inputOf<VerifyDomainInput>(input)),
    },
    {
      name: "domains.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeDomain(ctx, domainDeps, inputOf<RemoveDomainInput>(input)),
    },
    {
      name: "data.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataResources(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "data.provision",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        provisionDataResource(ctx, dataDeps, inputOf<ProvisionDataInput>(input)),
    },
    {
      name: "data.backup",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        backupDataResource(ctx, dataDeps, inputOf<BackupDataInput>(input)),
    },
    {
      name: "data.backups.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataBackups(ctx, dataDeps, inputOf<ListBackupsInput>(input)),
    },
    {
      name: "data.restore",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        restoreDataResource(ctx, dataDeps, inputOf<RestoreDataInput>(input)),
    },
    {
      name: "data.restores.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataRestores(ctx, dataDeps, inputOf<ListRestoresInput>(input)),
    },
    {
      name: "data.rotateCredentials",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        rotateDataCredentials(ctx, dataDeps, inputOf<RotateCredentialsInput>(input)),
    },
    {
      name: "data.logs",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readDataLogs(ctx, dataDeps, inputOf<ReadDataLogsInput>(input)),
    },
    {
      name: "security.policy.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readSecurityPolicy(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.policy.save",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        saveSecurityPolicy(ctx, securityDeps, inputOf<SavePolicyInput>(input)),
    },
    {
      name: "security.policy.distribute",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        distributeSecurityPolicy(ctx, securityDeps, inputOf<DistributePolicyInput>(input)),
    },
    {
      name: "security.rules.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listSecurityRules(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.rules.add",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addSecurityRule(ctx, securityDeps, inputOf<AddSecurityRuleInput>(input)),
    },
    {
      name: "security.rules.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeSecurityRule(ctx, securityDeps, inputOf<RemoveSecurityRuleInput>(input)),
    },
    {
      name: "security.trustedSources.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listTrustedSources(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.trustedSources.add",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addTrustedSource(ctx, securityDeps, inputOf<AddTrustedSourceInput>(input)),
    },
    {
      name: "security.trustedSources.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeTrustedSource(ctx, securityDeps, inputOf<RemoveTrustedSourceInput>(input)),
    },
    {
      name: "security.rateLimits.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listRateLimits(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.rateLimits.add",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addRateLimit(ctx, securityDeps, inputOf<AddRateLimitInput>(input)),
    },
    {
      name: "security.rateLimits.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeRateLimit(ctx, securityDeps, inputOf<RemoveRateLimitInput>(input)),
    },
    {
      name: "security.bots.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readVerifiedBots(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.events.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) => {
        const parsed = inputOf<{ organizationId: OrganizationId; limit?: number }>(input);
        return listSecurityEvents(ctx, securityDeps, parsed.organizationId, parsed.limit);
      },
    },
    {
      name: "security.incidents.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listSecurityIncidents(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.incidents.transition",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        transitionSecurityIncident(ctx, securityDeps, inputOf<TransitionIncidentInput>(input)),
    },
    {
      name: "apiKeys.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listApiKeys(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "apiKeys.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createApiKey(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId; name: string; scopes: readonly string[] }>(
            input,
          ),
        ),
    },
    {
      name: "apiKeys.revoke",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        revokeApiKey(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId; keyId: ApiKeyId }>(input),
        ),
    },
    {
      name: "providers.health",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        providerHealth(
          ctx,
          healthDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.usage",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readUsage(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.budgets.list",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readBudgets(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.budgets.save",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        saveBudget(
          ctx,
          billingDeps,
          inputOf<{
            organizationId: OrganizationId;
            metric: string;
            limitQuantity: number;
            hardCap: boolean;
          }>(input),
        ),
    },
    {
      name: "billing.budgets.remove",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeBudget(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId; metric: string }>(input),
        ),
    },
    {
      name: "observability.jobs",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readObservability(
          ctx,
          observabilityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
  ];
}

/** Names of every exposed procedure, sorted. Used by the boundary test. */
export function procedureNames(store: DataStore): readonly string[] {
  return buildProcedures(store)
    .map((p) => p.name)
    .sort();
}

/** Re-exported for callers building a router by hand. */
export const ROUTE_SHAPES = {
  "organizations.list": {},
  "organizations.create": { name: "string", slug: "string" },
  "organizations.get": { organizationId: "OrganizationId" },
  "organizations.members.list": { organizationId: "OrganizationId" },
  "organizations.members.updateRole": {
    organizationId: "OrganizationId",
    memberId: "string",
    role: "string",
  },
  "organizations.members.remove": { organizationId: "OrganizationId", memberId: "string" },
  "projects.list": { organizationId: "OrganizationId" },
  "projects.get": { projectId: "ProjectId" },
  "projects.create": {
    organizationId: "OrganizationId",
    name: "string",
    slug: "string",
    executionModel: "string?",
    rootDirectory: "string?",
  },
  "projects.update": {
    projectId: "ProjectId",
    name: "string?",
    slug: "string?",
    executionModel: "string?",
    rootDirectory: "string?",
  },
  "deployments.list": { projectId: "ProjectId" },
  "deployments.create": {
    projectId: "ProjectId",
    idempotencyKey: "string?",
    gitRepository: "string?",
    gitBranch: "string?",
    commit: "string?",
    buildPack: "BuildPack?",
    rootDirectory: "string?",
    kind: "string?",
    staged: "boolean?",
    pullRequest: "number?",
  },
  "deployments.rollback": {
    projectId: "ProjectId",
    commit: "string",
    idempotencyKey: "string?",
  },
  "deployments.redeploy": {
    projectId: "ProjectId",
    deploymentId: "string",
    idempotencyKey: "string?",
  },
  "deployments.logs": { projectId: "ProjectId", deploymentId: "string" },
  "deployments.promote": { projectId: "ProjectId", deploymentId: "string" },
  "deployments.cancel": { projectId: "ProjectId", deploymentId: "string" },
  "git.links.list": { projectId: "ProjectId" },
  "git.connect": {
    projectId: "ProjectId",
    provider: "string",
    repository: "string",
    productionBranch: "string?",
    previewsEnabled: "boolean?",
  },
  "git.disconnect": { projectId: "ProjectId", linkId: "string" },
  "git.deployNow": { projectId: "ProjectId", idempotencyKey: "string?" },
  "env.list": { projectId: "ProjectId" },
  "env.set": { projectId: "ProjectId", key: "string", value: "string", isBuildTime: "boolean?" },
  "env.remove": { projectId: "ProjectId", key: "string" },
  "audit.list": { organizationId: "OrganizationId" },
  "domains.list": { organizationId: "OrganizationId", projectId: "ProjectId?" },
  "domains.create": {
    organizationId: "OrganizationId",
    projectId: "ProjectId?",
    hostname: "string",
  },
  "domains.verify": { organizationId: "OrganizationId", domainId: "DomainId" },
  "domains.remove": { organizationId: "OrganizationId", domainId: "DomainId" },
  "data.list": { organizationId: "OrganizationId" },
  "data.provision": {
    organizationId: "OrganizationId",
    name: "string",
    kind: "postgres|object_storage",
    projectId: "ProjectId?",
  },
  "data.backup": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.backups.list": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.restore": {
    organizationId: "OrganizationId",
    resourceId: "DataResourceId",
    backupId: "string",
    confirmName: "string",
  },
  "data.restores.list": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.rotateCredentials": {
    organizationId: "OrganizationId",
    resourceId: "DataResourceId",
    confirmName: "string",
  },
  "data.logs": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "security.policy.get": { organizationId: "OrganizationId" },
  "security.policy.save": {
    organizationId: "OrganizationId",
    name: "string",
    riskLevel: "RiskLevel",
    action: "EnforcementAction",
    protectionMode: "normal|attack?",
    protectionExpiresAt: "string?",
  },
  "security.policy.distribute": { organizationId: "OrganizationId" },
  "security.rules.list": { organizationId: "OrganizationId" },
  "security.rules.add": {
    organizationId: "OrganizationId",
    kind: "ip|cidr|asn|user-agent",
    value: "string",
    note: "string?",
  },
  "security.rules.remove": { organizationId: "OrganizationId", ruleId: "string" },
  "security.trustedSources.list": { organizationId: "OrganizationId" },
  "security.trustedSources.add": {
    organizationId: "OrganizationId",
    kind: "ip|cidr",
    value: "string",
    note: "string?",
  },
  "security.trustedSources.remove": { organizationId: "OrganizationId", sourceId: "string" },
  "security.rateLimits.list": { organizationId: "OrganizationId" },
  "security.rateLimits.add": {
    organizationId: "OrganizationId",
    key: "ip|header|global",
    headerName: "string?",
    limit: "number",
    windowSeconds: "number",
    note: "string?",
  },
  "security.rateLimits.remove": { organizationId: "OrganizationId", rateLimitId: "string" },
  "security.bots.list": { organizationId: "OrganizationId" },
  "security.events.list": { organizationId: "OrganizationId", limit: "number?" },
  "security.incidents.list": { organizationId: "OrganizationId" },
  "security.incidents.transition": {
    organizationId: "OrganizationId",
    incidentId: "string",
    state: "triaged|resolved|false_positive",
    resolution: "string?",
  },
  "apiKeys.list": { organizationId: "OrganizationId" },
  "apiKeys.create": { organizationId: "OrganizationId", name: "string", scopes: "string[]" },
  "apiKeys.revoke": { organizationId: "OrganizationId", keyId: "ApiKeyId" },
  "providers.health": { organizationId: "OrganizationId" },
  "billing.usage": { organizationId: "OrganizationId" },
  "billing.budgets.list": { organizationId: "OrganizationId" },
  "billing.budgets.save": {
    organizationId: "OrganizationId",
    metric: "deployments|backups",
    limitQuantity: "number",
    hardCap: "boolean",
  },
  "billing.budgets.remove": { organizationId: "OrganizationId", metric: "string" },
  "observability.jobs": { organizationId: "OrganizationId" },
} as const;

export type { Organization, Project };
export type { ConsoleLinkResolver } from "./settings.js";
