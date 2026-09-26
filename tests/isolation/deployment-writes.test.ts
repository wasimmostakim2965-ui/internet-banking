/**
 * Phase 1a acceptance: the deployment write path, end to end.
 *
 * The router the API actually mounts is exercised over the real registered
 * procedure table, with a real in-memory store that applies the same membership
 * filter the SQL policies apply, and the real hosting adapters. Nothing is
 * mocked away, because the properties that matter here are exactly the ones a
 * mock would hide:
 *
 *   * a deployment row is written before the engine is asked to act;
 *   * the row's status is the adapter's status — `not_configured` when no engine
 *     is wired, `succeeded` only when the engine said so;
 *   * a repeated idempotency key returns the original row and does not deploy
 *     twice;
 *   * a rollback with no engine-side application is honestly not_configured;
 *   * a non-member cannot deploy or roll back, and cannot learn that the
 *     organization exists.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeySummary,
  UsageRecord,
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataResource,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  PreviewTarget,
  Project,
  ProjectGitLink,
} from "@cloud-wai/database";
import type {
  AdapterResult,
  EngineStatus,
  OrganizationId,
  ProjectId,
  ProviderRef,
  UserId,
} from "@cloud-wai/contracts";
import { err, ok } from "@cloud-wai/contracts";
import {
  fakeHosting,
  hostingNotConfigured,
  databaseNotConfigured,
  storageNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  domainVerifierNotConfigured,
  InMemoryJobQueue,
  type Engines,
  type JobQueue,
} from "@cloud-wai/adapters";
import { buildProcedures, buildRouter, type Procedure, type RouterDeps } from "@cloud-wai/api";
import { cloneUrlFor } from "@cloud-wai/api";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "carol@example.com",
    displayName: "Carol",
    accessToken: TOKEN_CAROL,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [{ organizationId: ORG_A, userId: ALICE, role: "owner" }];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/**
 * A control plane with the write methods the deployment procedures need.
 *
 * It mirrors the SQL layer's scope rules: a write only lands on a row in an
 * organization the acting user belongs to, and the membership join decides
 * visibility. That is what makes the isolation assertions meaningful.
 */
function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  let projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      productionDeploymentId: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [];
  const deploymentKeys = new Map<string, string>();
  const audit: AuditEvent[] = [];
  const domains: Domain[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];
  const usage: UsageRecord[] = [];
  const gitLinks: ProjectGitLink[] = [];
  const previewTargets: PreviewTarget[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const store = {
    async listOrganizations(userId: UserId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input: { name: string; slug: string; createdBy: UserId }) {
      const org: Organization = {
        id: `org-${input.slug}` as OrganizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      organizations.push(org);
      memberships.push({ organizationId: org.id, userId: input.createdBy, role: "owner" });
      return org;
    },
    async listProjects(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async createProject(input: {
      organizationId: OrganizationId;
      name: string;
      slug: string;
      createdBy: UserId;
    }) {
      const p: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      projects.push(p);
      return p;
    },
    async listDeployments(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
    },
    async listAuditEvents(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },
    async listUsageRecords(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? usage.filter((u) => u.organizationId === org) : [];
    },
    async createApiKey(input: {
      id: string;
      organizationId: OrganizationId;
      name: string;
      keyPrefix: string;
      scopes: readonly string[];
    }) {
      const key: ApiKeySummary = {
        id: input.id as ApiKeySummary["id"],
        organizationId: input.organizationId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        scopes: input.scopes,
        createdAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      };
      apiKeys.push(key);
      return key;
    },
    async revokeApiKey(userId: UserId, org: OrganizationId, keyId: string) {
      if (!isMember(userId, org)) return false;
      const key = apiKeys.find((k) => k.id === keyId && k.organizationId === org);
      if (!key) return false;
      apiKeys[apiKeys.indexOf(key)] = { ...key, revokedAt: "2026-01-02T00:00:00Z" };
      return true;
    },
    async recordAuditEvent(input: AuditEventInput) {
      const e: AuditEvent = {
        ...input,
        id: `a-${audit.length + 1}`,
        createdAt: "2026-01-01T00:00:00Z",
      };
      audit.push(e);
      return e;
    },
    async listGitLinks(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? gitLinks.filter((l) => l.projectId === projectId)
        : [];
    },

    async createDeployment(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      idempotencyKey: string;
      requestedBy: UserId;
      status: EngineStatus;
      provider: string | null;
      providerResourceId: string | null;
      url: string | null;
      failureReason: string | null;
      kind?: "production" | "preview";
      staged?: boolean;
      gitBranch?: string | null;
      gitCommit?: string | null;
      pullRequest?: number | null;
      previewKey?: string | null;
      gitRepository?: string | null;
      buildPack?: string | null;
    }) {
      const d: Deployment = {
        id: `d-${deployments.length + 1}` as Deployment["id"],
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: input.status,
        url: input.url,
        kind: input.kind ?? "production",
        staged: input.staged ?? false,
        gitBranch: input.gitBranch ?? null,
        gitCommit: input.gitCommit ?? null,
        pullRequest: input.pullRequest ?? null,
        previewKey: input.previewKey ?? null,
        providerResourceId: input.providerResourceId,
        deploymentResourceId: null,
        isCurrent: false,
        failureReason: input.failureReason,
        createdAt: "2026-01-01T00:00:00Z",
        gitRepository: input.gitRepository ?? null,
        buildPack: input.buildPack ?? null,
      };
      deployments.push(d);
      deploymentKeys.set(`${input.organizationId}::${input.idempotencyKey}`, d.id);
      return d;
    },
    async findDeploymentByIdempotencyKey(
      userId: UserId,
      org: OrganizationId,
      idempotencyKey: string,
    ) {
      if (!isMember(userId, org)) return null;
      const id = deploymentKeys.get(`${org}::${idempotencyKey}`);
      return id ? (deployments.find((d) => d.id === id) ?? null) : null;
    },
    async getDeployment(userId: UserId, deploymentId: string) {
      const d = deployments.find((x) => x.id === deploymentId);
      return d && isMember(userId, d.organizationId) ? d : null;
    },
    async updateDeploymentStatus(input: {
      id: string;
      organizationId: OrganizationId;
      status: EngineStatus;
      url?: string | null;
      failureReason?: string | null;
    }) {
      const d = deployments.find(
        (x) => x.id === input.id && x.organizationId === input.organizationId,
      );
      if (!d) return null;
      const next: Deployment = {
        ...d,
        status: input.status,
        url: input.url ?? d.url,
        failureReason: input.failureReason ?? d.failureReason,
      };
      deployments[deployments.indexOf(d)] = next;
      return next;
    },
    async setProjectProviderResource(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      provider: string;
      providerResourceId: string;
    }) {
      const p = projects.find(
        (x) => x.id === input.projectId && x.organizationId === input.organizationId,
      );
      if (!p) return null;
      const next: Project = { ...p };
      projects[projects.indexOf(p)] = next;
      return next;
    },
    async getProjectDeploymentTarget(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return null;
      return { provider: null, providerResourceId: null };
    },
    async getPreviewTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
      previewKey: string,
    ) {
      return (
        previewTargets.find(
          (t) =>
            t.organizationId === organizationId &&
            t.projectId === projectId &&
            t.previewKey === previewKey,
        ) ?? null
      );
    },
    async createPreviewTarget(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      previewKey: string;
      branch: string | null;
      pullRequest: number | null;
      createdBy: UserId;
    }) {
      const target: PreviewTarget = {
        id: `pt-${previewTargets.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        previewKey: input.previewKey,
        branch: input.branch,
        pullRequest: input.pullRequest,
        provider: null,
        providerResourceId: null,
      };
      previewTargets.push(target);
      return target;
    },
    async setPreviewTargetProvider(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      previewKey: string;
      provider: string;
      providerResourceId: string;
    }) {
      const at = previewTargets.findIndex(
        (t) =>
          t.organizationId === input.organizationId &&
          t.projectId === input.projectId &&
          t.previewKey === input.previewKey,
      );
      if (at < 0) return null;
      const updated: PreviewTarget = {
        ...previewTargets[at]!,
        provider: input.provider,
        providerResourceId: input.providerResourceId,
      };
      previewTargets[at] = updated;
      return updated;
    },
    /**
     * The promote move, mirroring the SQL function's rules: only a succeeded
     * production deployment of this project in this organization becomes live,
     * the previous current row is cleared, and the pointer moves atomically.
     */
    async promoteDeployment(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      deploymentId: string;
    }) {
      const previous =
        projects.find((p) => p.id === input.projectId)?.productionDeploymentId ?? null;
      const target = deployments.find(
        (d) =>
          d.id === input.deploymentId &&
          d.projectId === input.projectId &&
          d.organizationId === input.organizationId &&
          d.kind === "production" &&
          d.status === "succeeded",
      );
      if (!target) return { deployment: null, previousDeploymentId: previous };
      deployments.forEach((d, i) => {
        if (d.projectId === input.projectId && d.isCurrent) {
          deployments[i] = { ...d, isCurrent: false };
        }
      });
      const at = deployments.findIndex((d) => d.id === input.deploymentId);
      const promoted: Deployment = { ...deployments[at]!, isCurrent: true };
      deployments[at] = promoted;
      const pAt = projects.findIndex((p) => p.id === input.projectId);
      projects[pAt] = { ...projects[pAt]!, productionDeploymentId: promoted.id };
      return { deployment: promoted, previousDeploymentId: previous };
    },
  } satisfies DataStoreLike;

  return { store, deployments, audit, projects, gitLinks };
}

type DataStoreLike = import("@cloud-wai/database").DataStore & Partial<ControlPlaneWrites>;

function deps(store: DataStoreLike): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** The engine set a deployment with no credentials actually wires. */
function unconfiguredEngines(): Engines {
  return {
    hosting: hostingNotConfigured("coolify", "Set COOLIFY_URL."),
    serverless: serverlessNotConfigured("lambda", "Set AWS credentials."),
    database: databaseNotConfigured("postgres", "Set COOLIFY_URL."),
    storage: storageNotConfigured("minio", "Set STORAGE_ENDPOINT."),
    securityEdge: securityNotConfigured("envoy", "Set SECURITY_EDGE_URL."),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

/** A hosting engine that actually deploys, so the success path is real. */
function workingEngines(): Engines {
  return {
    ...unconfiguredEngines(),
    hosting: fakeHosting(),
  };
}

function routerWith(
  store: DataStoreLike,
  engines: Engines,
  extras: { newId?: () => string; queue?: JobQueue } = {},
) {
  const procedures: readonly Procedure[] = buildProcedures(store, {
    engines,
    newId: extras.newId ?? (() => "gen-key"),
    ...(extras.queue ? { queue: extras.queue } : {}),
  });
  return buildRouter(deps(store), procedures);
}

describe("deployments.create through the registered procedures", () => {
  it("records a not_configured deployment when no hosting engine is wired", async () => {
    const { store, deployments, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-1", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    // The row exists and is honest: no engine, so not_configured — never success.
    expect(data.deployment.status).toBe("not_configured");
    expect(data.engineReason).toMatch(/not configured/i);
    expect(deployments).toHaveLength(1);
    expect(audit.some((a) => a.event === "deployment.created")).toBe(true);
  });

  it("writes succeeded only when the hosting engine reported success", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-2", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    expect(data.deployment.status).toBe("succeeded");
    expect(deployments[0]?.status).toBe("succeeded");
    expect(deployments[0]?.url).toMatch(/^https:\/\//);
  });

  it("replays an idempotency key without deploying twice", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const input = { projectId: PROJ_A, idempotencyKey: "same-key", gitBranch: "main" };
    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input,
    });
    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input,
    });

    expect((first.data as { replayed: boolean }).replayed).toBe(false);
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
    // One row, not two: a retried request cannot duplicate a deployment.
    expect(deployments).toHaveLength(1);
  });

  it("refuses an idempotency key already used for a different project", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    // A second project in the same organization: the deployment key is unique
    // per organization, so the same key is a real collision across projects.
    await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Beta", slug: "beta" },
    });

    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "shared-key" },
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);

    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: "proj-beta" as ProjectId, idempotencyKey: "shared-key" },
    });

    // Answering with PROJ_A's deployment would silently skip the beta deploy.
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(deployments).toHaveLength(1);
    expect(deployments.every((d) => d.projectId === PROJ_A)).toBe(true);
  });

  it("refuses a non-member without revealing the organization", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, idempotencyKey: "carol-1" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(deployments).toHaveLength(0);
  });

  it("rejects a repository that is not a clone URL", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, gitRepository: "not a url", idempotencyKey: "bad-repo" },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
    expect(deployments).toHaveLength(0);
  });

  it("refuses a build pack the engine does not accept, before any deploy", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    // The union stops a TypeScript caller, but this procedure is reachable over
    // HTTP. Forwarding an unknown pack would surface as the engine's own error
    // about its internals; it is refused here instead.
    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "bad-pack", buildPack: "webpack" },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
    expect(res.error?.message).toContain("nixpacks");
    expect(deployments).toHaveLength(0);
  });

  it("hands the caller's build pack to the engine, and omits it when unset", async () => {
    const { store } = makeStore();
    const seen: (string | null | undefined)[] = [];
    const base = fakeHosting();
    const recording: Engines = {
      ...unconfiguredEngines(),
      hosting: {
        ...base,
        createApplication: (ctx, input) => {
          seen.push(input.buildPack);
          return base.createApplication(ctx, input);
        },
      },
    };
    const router = routerWith(store, recording);

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "pack-1", buildPack: "static" },
    });
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "pack-2" },
    });

    // The pin is forwarded as chosen; an unset pack stays unset, so a project
    // that pins its own build pack in the engine keeps it rather than being
    // silently overwritten with a platform default.
    expect(seen[0]).toBe("static");
    expect(seen[1] ?? null).toBe(null);
  });

  it("reports engine_unavailable rather than a fake success when the store cannot write", async () => {
    // A read-only store: the procedure must not answer ok for a deployment it
    // never recorded.
    const { store } = makeStore();
    const readOnly = { ...store } as Record<string, unknown>;
    for (const name of [
      "createDeployment",
      "updateDeploymentStatus",
      "findDeploymentByIdempotencyKey",
      "getProjectDeploymentTarget",
      "setProjectProviderResource",
    ]) {
      delete readOnly[name];
    }
    const router = routerWith(readOnly as unknown as DataStoreLike, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "ro-1" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.error?.code).toBe("engine_unavailable");
  });
});

describe("deployments.rollback through the registered procedures", () => {
  it("is honestly not_configured when the project has no engine application", async () => {
    const { store, audit } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    expect(data.deployment.status).toBe("not_configured");
    expect(data.engineReason).toMatch(/nothing to roll back/i);
    expect(audit.some((a) => a.event === "deployment.rolled_back")).toBe(true);
  });

  it("requires the commit to return to", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "  " },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });

  it("refuses a non-member", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, commit: "abc123" },
    });

    expect(res.status).toBe(404);
    expect(deployments).toHaveLength(0);
  });

  it("rolls back through the engine when the project has an application", async () => {
    // A store where the project already has an engine-side application. The
    // handle is minted by the *real* fake adapter, not invented here: rollback
    // addresses the application by its `resourceId`, so a handle the engine
    // never issued would not resolve — the same rule Coolify enforces.
    const { store, deployments } = makeStore();
    const engines = workingEngines();
    const created = await engines.hosting.createApplication(
      { organizationId: ORG_A, idempotencyKey: "app-provision", timeoutMs: 100 },
      { name: "alpha" },
    );
    if (!created.ok) throw new Error("the fake engine refused to create the application");
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return {
          provider: "coolify" as const,
          providerResourceId: created.value.providerRef.resourceId,
        };
      },
    } as DataStoreLike;
    const router = routerWith(withTarget, engines);

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-2" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { deployment: Deployment }).deployment.status).toBe("succeeded");
    expect(deployments).toHaveLength(1);
  });

  it("surfaces a failing engine as a non-success, never as succeeded", async () => {
    const failing: Engines = {
      ...unconfiguredEngines(),
      hosting: fakeHosting({ behaviour: "failed" }),
    };
    const { store } = makeStore();
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: "coolify", providerResourceId: "app-1" };
      },
    } as DataStoreLike;
    const router = routerWith(withTarget, failing);

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-3" },
    });

    const data = res.data as { deployment: Deployment };
    expect(data.deployment.status).toBe("failed");
  });
});

describe("deployments.cancel through the registered procedures", () => {
  it("refuses a deployment that already reached a terminal state", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    // Deploy, so a row exists; the fake reports success, so it is terminal.
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "c-1" },
    });
    expect(deployments[0]?.status).toBe("succeeded");

    const res = await router.route({
      procedure: "deployments.cancel",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id },
    });

    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("conflict");
  });

  it("closes out a pending deployment that never reached the engine, honestly", async () => {
    const { store, deployments, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    // A deploy with no engine leaves a `not_configured` row; force it `pending`
    // to model a run that never got an engine handle.
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "c-2" },
    });
    deployments[0] = { ...deployments[0]!, status: "pending", deploymentResourceId: null };

    const res = await router.route({
      procedure: "deployments.cancel",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    expect(data.deployment.status).toBe("failed");
    expect(data.engineReason).toMatch(/never reached the hosting engine/i);
    expect(audit.some((a) => a.event === "deployment.cancelled")).toBe(true);
  });

  it("cancels through the engine when the run has a deployment handle", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "c-3" },
    });
    deployments[0] = {
      ...deployments[0]!,
      status: "running",
      deploymentResourceId: "dep-1",
    };

    const res = await router.route({
      procedure: "deployments.cancel",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    expect(data.deployment.status).toBe("failed");
    expect(data.engineReason).toMatch(/cancelled/i);
  });

  it("refuses a non-member with not_found, never a hint", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "c-4" },
    });

    const res = await router.route({
      procedure: "deployments.cancel",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id },
    });

    expect(res.status).toBe(404);
  });

  it("refuses a deployment id that belongs to another project", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "c-5" },
    });

    const res = await router.route({
      procedure: "deployments.cancel",
      accessToken: TOKEN_ALICE,
      input: { projectId: "proj-other", deploymentId: deployments[0]!.id },
    });

    expect(res.status).toBe(404);
  });
});

describe("execution-model routing through the registered procedures", () => {
  it("routes a serverless project to the serverless engine, never to Coolify", async () => {
    // The store reports the project's execution model as serverless. The
    // container engine is wired and, given the chance, would report success; the
    // serverless engine is not configured. The deploy must therefore end
    // not_configured — proof that the model, not the availability of Coolify,
    // decides the engine.
    const { store } = makeStore();
    const engines: Engines = {
      ...unconfiguredEngines(),
      hosting: fakeHosting(),
    };
    const serverlessProject = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: null, providerResourceId: null, executionModel: "serverless" as const };
      },
    } as DataStoreLike;
    const router = routerWith(serverlessProject, engines);

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "sl-1" },
    });

    expect(res.ok).toBe(true);
    const deployment = (res.data as { deployment: Deployment }).deployment;
    expect(deployment.status).toBe("not_configured");
    expect(deployment.failureReason ?? "").not.toMatch(/coolify/i);
  });

  it("routes a container project to the container engine", async () => {
    const { store } = makeStore();
    const containerProject = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: null, providerResourceId: null, executionModel: "container" as const };
      },
    } as DataStoreLike;
    const router = routerWith(containerProject, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "ct-1" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { deployment: Deployment }).deployment.status).toBe("succeeded");
  });
});

describe("the deployment adapters stay honest", () => {
  it("never returns a succeeded AdapterResult for an unconfigured engine", async () => {
    const engines = unconfiguredEngines();
    const ctx = { organizationId: ORG_A, idempotencyKey: "k", timeoutMs: 1000 };
    const results: AdapterResult<unknown>[] = [
      await engines.hosting.createApplication(ctx, { name: "x" }),
      await engines.hosting.deploy(ctx, {
        applicationRef: {
          organizationId: ORG_A,
          provider: "coolify",
          resourceType: "application",
          resourceId: "a",
        } as ProviderRef,
      }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe("not_configured");
    }
    // A sanity check that the helpers are not accidentally succeeding.
    expect(ok("succeeded", 1).ok).toBe(true);
    expect(err("failed", "x").status).toBe("failed");
  });
});

describe("the durable writer: deploy and rollback as orchestration jobs", () => {
  it("enqueues a jobs row for a deploy instead of calling the engine on the request path", async () => {
    const { store, deployments, audit } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-durable-1", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    // The row is written and stays pending: the engine has not answered yet, and
    // a `pending` row after an enqueue is the honest state, not a failure.
    expect(data.deployment.id).toBe(deployments[0]?.id);
    expect(data.deployment.status).toBe("pending");

    const job = await queue.get("job-1");
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("deployments.execute");
    expect(job?.state).toBe("queued");
    const payload = job?.payload as { deploymentId: string; action: string; projectId: string };
    expect(payload.deploymentId).toBe(data.deployment.id);
    expect(payload.action).toBe("create");
    expect(payload.projectId).toBe(PROJ_A);
    // The audit trail names the enqueue, so the job is traceable to its request.
    expect(audit.some((a) => a.event === "deployment.enqueued")).toBe(true);
  });

  it("does not enqueue a second job when the idempotency key is replayed", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-dup", gitBranch: "main" },
    });
    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-dup", gitBranch: "main" },
    });

    expect(second.ok).toBe(true);
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
    expect((second.data as { deployment: Deployment }).deployment.id).toBe(
      (first.data as { deployment: Deployment }).deployment.id,
    );
    // One deployment row, one job: a retried request cannot deploy twice.
    expect(deployments).toHaveLength(1);
    expect(await queue.get("job-2")).toBeNull();
  });

  it("enqueues a rollback job with the commit and keeps the row pending", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "rb-1", commit: "abc1234" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { deployment: Deployment }).deployment.status).toBe("pending");
    expect(deployments).toHaveLength(1);

    const job = await queue.get("job-1");
    const payload = job?.payload as { action: string; commit: string; deploymentId: string };
    expect(payload.action).toBe("rollback");
    expect(payload.commit).toBe("abc1234");
    expect(payload.deploymentId).toBe(deployments[0]?.id);
  });

  it("refuses a rollback job for a non-member before anything is enqueued", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, idempotencyKey: "rb-carol", commit: "abc1234" },
    });

    expect(res.ok).toBe(false);
    expect(deployments).toHaveLength(0);
    expect(await queue.get("job-1")).toBeNull();
  });
});

describe("deployments.logs through the registered procedures", () => {
  it("says there is nothing to read when the project has no engine application", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.logs",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { lines: readonly string[]; engineReason: string | null };
    // No application on the engine means no logs — reported as a reason, not as
    // fabricated or empty success.
    expect(data.lines).toEqual([]);
    expect(data.engineReason).toMatch(/no logs/i);
  });

  it("returns the engine's own lines for a project with an application", async () => {
    const { store } = makeStore();
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: "coolify", providerResourceId: "app-1" };
      },
    } as DataStoreLike;
    // The fake hosting engine stores whatever was created; create one so it has
    // a log to return.
    const engines = workingEngines();
    await engines.hosting.createApplication(
      { organizationId: ORG_A, idempotencyKey: "k", timeoutMs: 100 },
      { name: "app-1" },
    );
    const router = routerWith(withTarget, engines);

    const res = await router.route({
      procedure: "deployments.logs",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { lines: readonly string[]; cursor: string | null };
    expect(Array.isArray(data.lines)).toBe(true);
    // Coolify keeps no cursor, and the adapter reports null rather than a fake one.
    expect(data.cursor).toBeNull();
  });

  it("refuses a non-member without revealing the project", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.logs",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, deploymentId: "d-1" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("reports a not-configured engine as a reason, never as invented lines", async () => {
    const { store } = makeStore();
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: "coolify", providerResourceId: "app-1" };
      },
    } as DataStoreLike;
    const router = routerWith(withTarget, unconfiguredEngines());

    const res = await router.route({
      procedure: "deployments.logs",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { lines: readonly string[]; engineReason: string | null };
    expect(data.lines).toEqual([]);
    expect(data.engineReason).toMatch(/not configured/i);
  });
});

describe("deployments.promote — the production pointer", () => {
  it("makes a succeeded production deployment live and records the previous one", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    // Two production deploys; the second succeeds.
    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-1", gitBranch: "main" },
    });
    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-2", gitBranch: "main" },
    });
    const firstId = (first.data as { deployment: Deployment }).deployment.id;
    const secondId = (second.data as { deployment: Deployment }).deployment.id;

    // The fake engine reports succeeded, so the second deploy is already live
    // (auto-promote) and the first is not.
    expect(deployments.find((d) => d.id === secondId)?.isCurrent).toBe(true);

    // An explicit promote of the older deployment is a rollback-by-pointer.
    const promoted = await router.route({
      procedure: "deployments.promote",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: firstId },
    });
    expect(promoted.ok).toBe(true);
    const data = promoted.data as { deployment: Deployment; previousDeploymentId: string | null };
    expect(data.deployment.isCurrent).toBe(true);
    expect(data.previousDeploymentId).toBe(secondId);
    // Exactly one current row: the denormalised flag agrees with the pointer.
    expect(deployments.filter((d) => d.isCurrent).map((d) => d.id)).toEqual([firstId]);
  });

  it("refuses a deployment that is not a succeeded production build", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-1", gitBranch: "main" },
    });

    // A preview row of the same project must never become live.
    deployments.push({
      ...deployments[0]!,
      id: "d-preview" as Deployment["id"],
      kind: "preview",
      isCurrent: false,
      previewKey: "pr-7",
    });

    const res = await router.route({
      procedure: "deployments.promote",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-preview" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it("refuses a deployment in another project as not found", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-1", gitBranch: "main" },
    });
    // A same-tenant deployment of a *different* project (fabricated id).
    deployments.push({
      ...deployments[0]!,
      id: "d-other" as Deployment["id"],
      projectId: "proj-other" as ProjectId,
      isCurrent: false,
    });

    const res = await router.route({
      procedure: "deployments.promote",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-other" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("refuses a non-member without revealing the project", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.promote",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, deploymentId: "d-1" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe("staged production deployments (Vercel --skip-domain)", () => {
  it("builds a staged release without making it live, then promotes it", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "stage-1", gitBranch: "main", staged: true },
    });

    expect(res.ok).toBe(true);
    const deployment = (res.data as { deployment: Deployment }).deployment;
    // The engine confirmed the build, but staging means it is *not* live: the
    // whole point is to inspect a release before it serves traffic.
    expect(deployment.status).toBe("succeeded");
    expect(deployment.staged).toBe(true);
    expect(deployment.isCurrent).toBe(false);
    expect(deployments.every((d) => !d.isCurrent)).toBe(true);

    // The release is promotable — the pointer is the only thing missing.
    const promoted = await router.route({
      procedure: "deployments.promote",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: deployment.id },
    });
    expect(promoted.ok).toBe(true);
    expect((promoted.data as { deployment: Deployment }).deployment.isCurrent).toBe(true);
  });

  it("makes a normal production deployment live without the staged flag", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "live-1", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const deployment = (res.data as { deployment: Deployment }).deployment;
    expect(deployment.staged).toBe(false);
    expect(deployments.find((d) => d.id === deployment.id)?.isCurrent).toBe(true);
  });

  it("refuses to stage a preview, where 'live' has no meaning", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "stage-preview",
        gitBranch: "feature-x",
        kind: "preview",
        staged: true,
      },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
    // Nothing was written: a refused request must not leave a row behind.
    expect(deployments).toHaveLength(0);
  });

  it("keeps a redeployed staged row staged, so a replay cannot publish it", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "stage-2", gitBranch: "main", staged: true },
    });
    const stagedId = (first.data as { deployment: Deployment }).deployment.id;

    const replay = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: stagedId },
    });

    expect(replay.ok).toBe(true);
    const replayed = (replay.data as { deployment: Deployment }).deployment;
    expect(replayed.id).not.toBe(stagedId);
    expect(replayed.staged).toBe(true);
    expect(replayed.isCurrent).toBe(false);
    expect(deployments.every((d) => !d.isCurrent)).toBe(true);
  });
});

describe("git.deployNow through the registered procedures", () => {
  const LINK: ProjectGitLink = {
    id: "link-1",
    organizationId: ORG_A,
    projectId: PROJ_A,
    provider: "github",
    repository: "acme/site",
    productionBranch: "main",
    previewsEnabled: false,
    secretPrefix: "whsec_test",
    createdBy: ALICE as UserId,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("builds the connected repository without waiting for a push", async () => {
    const { store, deployments, gitLinks } = makeStore();
    gitLinks.push(LINK);
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "now-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; replayed: boolean };
    expect(data.replayed).toBe(false);
    expect(deployments).toHaveLength(1);
    // With a durable queue the row is honest about being queued, not built.
    expect(data.deployment.status).toBe("pending");
    expect(data.deployment.gitBranch).toBe("main");
    // Exactly one job, and it is the same `deployments.execute` the webhook and
    // the Deploy button enqueue — not a second execution path.
    const job = await queue.claim("w-1", 30_000);
    expect(job?.kind).toBe("deployments.execute");
    expect(job?.payload).toMatchObject({ gitRepository: "https://github.com/acme/site.git" });
  });

  it("builds synchronously and honestly when no queue is wired", async () => {
    const { store, deployments, gitLinks } = makeStore();
    gitLinks.push(LINK);
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "now-sync" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    expect(data.deployment.status).toBe("succeeded");
    expect(deployments).toHaveLength(1);
  });

  it("uses the link's production branch, not a caller-supplied one", async () => {
    const { store, gitLinks } = makeStore();
    gitLinks.push({ ...LINK, productionBranch: "release" });
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "now-2" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    expect(data.deployment.gitBranch).toBe("release");
  });

  it("refuses honestly when no repository is connected", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "now-3" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    // Nothing was queued or written: the refusal is not a partial deploy.
    expect(deployments).toHaveLength(0);
  });

  it("refuses a generic link with no derivable clone host", async () => {
    const { store, deployments, gitLinks } = makeStore();
    gitLinks.push({ ...LINK, provider: "generic" });
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "now-4" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(deployments).toHaveLength(0);
  });

  it("refuses a non-member without revealing the project", async () => {
    const { store, gitLinks } = makeStore();
    gitLinks.push(LINK);
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "git.deployNow",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, idempotencyKey: "now-5" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe("cloneUrlFor", () => {
  it("maps each provider to its public clone host, and generic to nothing", () => {
    expect(cloneUrlFor("github", "acme/site")).toBe("https://github.com/acme/site.git");
    expect(cloneUrlFor("gitlab", "acme/site")).toBe("https://gitlab.com/acme/site.git");
    expect(cloneUrlFor("bitbucket", "acme/site")).toBe("https://bitbucket.org/acme/site.git");
    expect(cloneUrlFor("generic", "acme/site")).toBeNull();
  });
});

describe("deployments.redeploy replays a past row's source", () => {
  it("records the source a deployment was requested with", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "src-1",
        gitRepository: "https://github.com/acme/site.git",
        gitBranch: "main",
        buildPack: "railpack",
      },
    });

    // Without this the row could not name its own source, and a redeploy would
    // have nothing to replay — the reason P27 was impossible.
    expect(deployments[0]!.gitRepository).toBe("https://github.com/acme/site.git");
    expect(deployments[0]!.buildPack).toBe("railpack");
  });

  it("requests a fresh build of the same repository, branch and pack", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "src-2",
        gitRepository: "https://github.com/acme/site.git",
        gitBranch: "main",
        buildPack: "railpack",
      },
    });
    const original = deployments[0]!;

    const res = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: original.id, idempotencyKey: "re-2" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; replayed: boolean };
    // A redeploy is a *new* deployment, not a replay of the original row: the
    // caller's fresh key is what makes that so.
    expect(data.replayed).toBe(false);
    expect(data.deployment.id).not.toBe(original.id);
    expect(deployments).toHaveLength(2);

    const replayed = deployments[1]!;
    expect(replayed.gitRepository).toBe(original.gitRepository);
    expect(replayed.gitBranch).toBe(original.gitBranch);
    expect(replayed.buildPack).toBe(original.buildPack);
    expect(replayed.kind).toBe("production");
    // The engine is handed the same source the original build used.
    const jobs = [await queue.claim("w-1", 30_000)];
    expect(jobs[0]?.payload).toMatchObject({
      gitRepository: "https://github.com/acme/site.git",
      gitBranch: "main",
      buildPack: "railpack",
    });
  });

  it("carries a preview row's kind and pull request so its target is reused", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "src-3",
        gitRepository: "https://github.com/acme/site.git",
        gitBranch: "feature-x",
        kind: "preview",
        pullRequest: 42,
      },
    });

    const res = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id, idempotencyKey: "re-3" },
    });

    expect(res.ok).toBe(true);
    const replayed = deployments[1]!;
    expect(replayed.kind).toBe("preview");
    expect(replayed.pullRequest).toBe(42);
    expect(replayed.previewKey).toBe("pr-42");
  });

  it("refuses a row that recorded no source, instead of building nothing", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "src-4" },
    });

    // A rollback row: it returns to a revision the engine already holds, so it
    // carries no repository of its own.
    deployments.push({
      ...deployments[0]!,
      id: "d-rollback" as Deployment["id"],
      gitRepository: null,
      gitBranch: null,
    });

    const res = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-rollback", idempotencyKey: "re-4" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(deployments).toHaveLength(2);
  });

  it("refuses a deployment in another project as not found", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "src-5",
        gitRepository: "https://github.com/acme/site.git",
        gitBranch: "main",
      },
    });
    deployments.push({
      ...deployments[0]!,
      id: "d-other" as Deployment["id"],
      projectId: "proj-other" as ProjectId,
    });

    const res = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, deploymentId: "d-other", idempotencyKey: "re-5" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("refuses a non-member without revealing the project", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());
    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: {
        projectId: PROJ_A,
        idempotencyKey: "src-6",
        gitRepository: "https://github.com/acme/site.git",
        gitBranch: "main",
      },
    });

    const res = await router.route({
      procedure: "deployments.redeploy",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, deploymentId: deployments[0]!.id, idempotencyKey: "re-6" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});
