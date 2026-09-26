/**
 * The router over the real registered procedure table.
 *
 * The scope tests elsewhere build procedures by hand to isolate a case. This
 * suite exercises the table the API actually mounts, so a procedure cannot be
 * registered without going through the guard.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeyCreateInput,
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  DataResource,
  DataStore,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  OrganizationMember,
  OrchestrationJob,
  Project,
  UsageRecord,
} from "@cloud-wai/database";
import type { ApiKeyId, DomainId, OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import { buildProcedures, buildRouter, procedureNames, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "a@x.test",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "c@x.test",
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

function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: "p-1" as ProjectId,
      organizationId: ORG_A,
      name: "P",
      slug: "p",
      providerResourceId: null,
      rootDirectory: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [];
  const audit: AuditEvent[] = [];
  const domains: Domain[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];
  const usage: UsageRecord[] = [];
  const jobs: OrchestrationJob[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const store: DataStore = {
    async listOrganizations(userId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async listOrganizationMembers(userId, org) {
      if (!isMember(userId, org)) return [];
      return memberships
        .filter((m) => m.organizationId === org)
        .map((m) => ({
          organizationId: m.organizationId,
          userId: m.userId,
          role: m.role,
          email: sessions[`t-${m.userId.replace("u-", "")}`]?.email ?? null,
          displayName: null,
          invitedBy: null,
          createdAt: "2026-01-01T00:00:00Z",
        }));
    },
    async createOrganization(input) {
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
    async updateOrganizationMemberRole(input) {
      if (!isMember(input.userId, input.organizationId)) return null;
      const m = memberships.find(
        (x) => x.organizationId === input.organizationId && x.userId === input.memberId,
      );
      if (!m) return null;
      m.role = input.role;
      return {
        organizationId: m.organizationId,
        userId: m.userId,
        role: m.role,
        email: null,
        displayName: null,
        invitedBy: null,
        createdAt: "2026-01-01T00:00:00Z",
      };
    },
    async removeOrganizationMember(input) {
      if (!isMember(input.userId, input.organizationId)) return false;
      const index = memberships.findIndex(
        (x) => x.organizationId === input.organizationId && x.userId === input.memberId,
      );
      if (index === -1) return false;
      memberships.splice(index, 1);
      return true;
    },
    async listProjects(userId, org) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async createProject(input) {
      const p: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        providerResourceId: null,
        rootDirectory: input.rootDirectory ?? null,
        createdAt: "2026-01-01T00:00:00Z",
      };
      projects.push(p);
      return p;
    },
    async updateProject(input) {
      const p = projects.find(
        (x) => x.id === input.projectId && x.organizationId === input.organizationId,
      );
      if (!p) return null;
      const next: Project = {
        ...p,
        name: input.name ?? p.name,
        slug: input.slug ?? p.slug,
        ...(input.executionModel ? { executionModel: input.executionModel } : {}),
        ...(input.rootDirectory !== undefined ? { rootDirectory: input.rootDirectory } : {}),
      };
      projects[projects.indexOf(p)] = next;
      return next;
    },
    async listDeployments(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
    },
    async listAuditEvents(userId, org) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId, org) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId, org) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId, org) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },
    async listUsageRecords(userId, org) {
      return isMember(userId, org) ? usage.filter((u) => u.organizationId === org) : [];
    },
    async listOrchestrationJobs(userId, org) {
      // The store contract is newest first; the fixture matches it so the
      // "most recent failure reason" rule is actually exercised.
      return isMember(userId, org)
        ? jobs
            .filter((j) => j.organizationId === org)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];
    },
    async createApiKey(input: ApiKeyCreateInput) {
      const key: ApiKeySummary = {
        id: input.id,
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
    async revokeApiKey(userId, org, keyId) {
      if (!isMember(userId, org)) return false;
      const key = apiKeys.find((k) => k.id === keyId && k.organizationId === org);
      if (!key) return false;
      const index = apiKeys.indexOf(key);
      apiKeys[index] = { ...key, revokedAt: "2026-01-02T00:00:00Z" };
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
  };
  return { store, audit, projects, usage, jobs };
}

function deps(store: DataStore): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe("the registered procedure table", () => {
  it("exposes exactly the documented procedures", () => {
    const { store } = makeStore();
    expect(procedureNames(store)).toEqual([
      "apiKeys.create",
      "apiKeys.list",
      "apiKeys.revoke",
      "audit.list",
      "billing.budgets.list",
      "billing.budgets.remove",
      "billing.budgets.save",
      "billing.usage",
      "data.backup",
      "data.backups.list",
      "data.list",
      "data.logs",
      "data.provision",
      "data.restore",
      "data.restores.list",
      "data.rotateCredentials",
      "deployments.cancel",
      "deployments.create",
      "deployments.list",
      "deployments.logs",
      "deployments.promote",
      "deployments.redeploy",
      "deployments.rollback",
      "domains.create",
      "domains.list",
      "domains.remove",
      "domains.verify",
      "env.list",
      "env.remove",
      "env.set",
      "git.connect",
      "git.deployNow",
      "git.disconnect",
      "git.links.list",
      "observability.jobs",
      "organizations.create",
      "organizations.get",
      "organizations.list",
      "organizations.members.list",
      "organizations.members.remove",
      "organizations.members.updateRole",
      "projects.create",
      "projects.get",
      "projects.list",
      "projects.update",
      "providers.health",
      "security.bots.list",
      "security.events.list",
      "security.incidents.list",
      "security.incidents.transition",
      "security.policy.distribute",
      "security.policy.get",
      "security.policy.save",
      "security.rateLimits.add",
      "security.rateLimits.list",
      "security.rateLimits.remove",
      "security.rules.add",
      "security.rules.list",
      "security.rules.remove",
      "security.trustedSources.add",
      "security.trustedSources.list",
      "security.trustedSources.remove",
    ]);
  });

  it("rejects every procedure without a session", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    for (const name of procedureNames(store)) {
      const res = await router.route({ procedure: name });
      expect(res.status).toBe(401);
    }
  });

  it("rejects every procedure for a valid session with no membership", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    // Carol is a real user but not a member of anything. Every scoped procedure
    // must refuse her; the two list procedures may succeed with an empty list.
    const scoped: Record<string, unknown> = {
      "organizations.get": { organizationId: ORG_A },
      "organizations.members.list": { organizationId: ORG_A },
      "organizations.members.updateRole": {
        organizationId: ORG_A,
        memberId: ALICE,
        role: "viewer",
      },
      "organizations.members.remove": { organizationId: ORG_A, memberId: ALICE },
      "projects.list": { organizationId: ORG_A },
      "projects.get": { projectId: "p-1" },
      "projects.create": { organizationId: ORG_A, name: "Sneak", slug: "sneak" },
      "deployments.list": { projectId: "p-1" },
      "deployments.create": { projectId: "p-1" },
      "deployments.cancel": { projectId: "p-1", deploymentId: "d-1" },
      "deployments.rollback": { projectId: "p-1", commit: "abc123" },
      "deployments.redeploy": { projectId: "p-1", deploymentId: "d-1" },
      "audit.list": { organizationId: ORG_A },
      "domains.list": { organizationId: ORG_A },
      "domains.create": { organizationId: ORG_A, hostname: "sneak.example.com" },
      "domains.verify": { organizationId: ORG_A, domainId: "d-1" as DomainId },
      "domains.remove": { organizationId: ORG_A, domainId: "d-1" as DomainId },
      "data.list": { organizationId: ORG_A },
      "data.logs": { organizationId: ORG_A, resourceId: "r-1" },
      "data.restore": {
        organizationId: ORG_A,
        resourceId: "r-1",
        backupId: "b-1",
        confirmName: "x",
      },
      "data.restores.list": { organizationId: ORG_A, resourceId: "r-1" },
      "data.rotateCredentials": { organizationId: ORG_A, resourceId: "r-1", confirmName: "x" },
      "apiKeys.list": { organizationId: ORG_A },
      "apiKeys.create": { organizationId: ORG_A, name: "Sneak", scopes: ["org:delete"] },
      "apiKeys.revoke": { organizationId: ORG_A, keyId: "k-1" as ApiKeyId },
      "providers.health": { organizationId: ORG_A },
      "billing.usage": { organizationId: ORG_A },
      "billing.budgets.list": { organizationId: ORG_A },
      "billing.budgets.save": {
        organizationId: ORG_A,
        metric: "deployments",
        limitQuantity: 10,
        hardCap: true,
      },
      "billing.budgets.remove": { organizationId: ORG_A, metric: "deployments" },
      "observability.jobs": { organizationId: ORG_A },
      "security.policy.get": { organizationId: ORG_A },
      "security.policy.save": {
        organizationId: ORG_A,
        name: "Sneak",
        riskLevel: "high",
        action: "block",
      },
      "security.policy.distribute": { organizationId: ORG_A },
      "security.rules.list": { organizationId: ORG_A },
      "security.rules.add": { organizationId: ORG_A, kind: "ip", value: "10.0.0.1" },
      "security.rules.remove": { organizationId: ORG_A, ruleId: "r-1" },
      "security.trustedSources.list": { organizationId: ORG_A },
      "security.trustedSources.add": {
        organizationId: ORG_A,
        kind: "ip",
        value: "10.0.0.1",
      },
      "security.trustedSources.remove": { organizationId: ORG_A, sourceId: "s-1" },
      "security.rateLimits.list": { organizationId: ORG_A },
      "security.rateLimits.add": {
        organizationId: ORG_A,
        key: "ip",
        limit: 60,
        windowSeconds: 60,
      },
      "security.rateLimits.remove": { organizationId: ORG_A, rateLimitId: "rl-1" },
      "security.bots.list": { organizationId: ORG_A },
      "security.events.list": { organizationId: ORG_A },
      "git.deployNow": { projectId: "p-1" },
    };

    for (const [procedure, input] of Object.entries(scoped)) {
      const res = await router.route({ procedure, accessToken: TOKEN_CAROL, input });
      expect(res.ok, `${procedure} should refuse a non-member`).toBe(false);
      expect([403, 404], `${procedure} status`).toContain(res.status);
    }
  });

  it("rolls usage up per metric, and never across a tenant", async () => {
    const { store, usage } = makeStore();
    usage.push(
      {
        id: "u-1",
        organizationId: ORG_A,
        metric: "build_minutes",
        quantity: 10,
        recordedAt: "2026-09-20T10:00:00Z",
      },
      {
        id: "u-2",
        organizationId: ORG_A,
        metric: "build_minutes",
        quantity: 32,
        recordedAt: "2026-09-21T10:00:00Z",
      },
      {
        id: "u-3",
        organizationId: ORG_A,
        metric: "storage_gb",
        quantity: 12,
        recordedAt: "2026-09-19T08:00:00Z",
      },
      {
        // Another tenant's row. It must never appear in Alice's report.
        id: "u-4",
        organizationId: "org-b" as OrganizationId,
        metric: "build_minutes",
        quantity: 999,
        recordedAt: "2026-09-22T10:00:00Z",
      },
    );

    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "billing.usage",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(true);
    const report = res.data as {
      totals: readonly {
        metric: string;
        total: number;
        records: number;
        lastRecordedAt: string | null;
      }[];
    };
    // Two build_minutes rows summed to 42, with the later timestamp kept.
    expect(report.totals).toEqual([
      {
        metric: "build_minutes",
        total: 42,
        records: 2,
        lastRecordedAt: "2026-09-21T10:00:00Z",
      },
      {
        metric: "storage_gb",
        total: 12,
        records: 1,
        lastRecordedAt: "2026-09-19T08:00:00Z",
      },
    ]);
    // The other tenant's 999 is absent, which is the isolation guarantee.
    expect(report.totals.some((t) => t.total === 999)).toBe(false);
  });

  it("rolls jobs up by state, kind and real duration, and never across a tenant", async () => {
    const { store, jobs } = makeStore();
    const base = {
      organizationId: ORG_A,
      idempotencyKey: "key",
      maxAttempts: 3,
      leaseExpiresAt: null,
    } as const;
    jobs.push(
      {
        ...base,
        id: "j-1",
        kind: "deployment",
        state: "succeeded",
        attempts: 1,
        createdAt: "2026-09-20T10:00:00Z",
        startedAt: "2026-09-20T10:00:00Z",
        finishedAt: "2026-09-20T10:00:02Z",
        lastError: null,
      },
      {
        // Retried once, then succeeded: counts as a retry, not a failure.
        ...base,
        id: "j-2",
        kind: "deployment",
        state: "succeeded",
        attempts: 2,
        createdAt: "2026-09-21T10:00:00Z",
        startedAt: "2026-09-21T10:00:00Z",
        finishedAt: "2026-09-21T10:00:04Z",
        lastError: "engine restarted",
      },
      {
        ...base,
        id: "j-3",
        kind: "backup",
        state: "failed",
        attempts: 3,
        createdAt: "2026-09-22T10:00:00Z",
        startedAt: "2026-09-22T10:00:00Z",
        finishedAt: "2026-09-22T10:00:06Z",
        lastError: "snapshot quota exceeded",
      },
      {
        // Queued: no duration is knowable, so it must not enter the latency
        // sample as a zero.
        ...base,
        id: "j-4",
        kind: "security_distribution",
        state: "queued",
        attempts: 0,
        createdAt: "2026-09-23T10:00:00Z",
        startedAt: null,
        finishedAt: null,
        lastError: null,
      },
      {
        // Another tenant's job. It must never appear in Alice's report.
        ...base,
        id: "j-5",
        organizationId: "org-b" as OrganizationId,
        kind: "deployment",
        state: "failed",
        attempts: 9,
        createdAt: "2026-09-24T10:00:00Z",
        startedAt: "2026-09-24T10:00:00Z",
        finishedAt: "2026-09-24T10:09:59Z",
        lastError: "other tenant",
      },
    );

    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "observability.jobs",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(true);
    const report = res.data as {
      totals: { jobs: number; active: number; failed: number; retried: number };
      byState: readonly { state: string; count: number }[];
      byKind: readonly {
        kind: string;
        total: number;
        failed: number;
        retried: number;
        lastError: string | null;
      }[];
      latency: {
        samples: number;
        p50Ms: number | null;
        p95Ms: number | null;
        maxMs: number | null;
      };
      throughput: readonly { day: string; created: number; failed: number }[];
      jobs: readonly { id: string }[];
    };

    expect(report.totals).toEqual({ jobs: 4, active: 1, failed: 1, retried: 2 });
    expect(report.byState).toEqual([
      { state: "failed", count: 1 },
      { state: "queued", count: 1 },
      { state: "succeeded", count: 2 },
    ]);
    // The failed backup carries the engine's own reason.
    expect(report.byKind.find((k) => k.kind === "backup")).toEqual({
      kind: "backup",
      total: 1,
      failed: 1,
      retried: 1,
      lastError: "snapshot quota exceeded",
    });
    // Three finished jobs have durations 2s, 4s, 6s; the queued one is excluded.
    expect(report.latency).toEqual({ samples: 3, p50Ms: 4000, p95Ms: 6000, maxMs: 6000 });
    // Throughput is one point per day in a fixed trailing window that ends on the
    // newest day this org acted (09-23), and the other tenant's job (09-24) is
    // absent from it — the same isolation guarantee the row list gives.
    expect(report.throughput).toHaveLength(14);
    expect(report.throughput.at(-1)).toEqual({ day: "2026-09-23", created: 1, failed: 0 });
    expect(report.throughput.at(-2)).toEqual({ day: "2026-09-22", created: 1, failed: 1 });
    expect(report.throughput.some((d) => d.day === "2026-09-24")).toBe(false);
    expect(report.throughput.reduce((sum, d) => sum + d.created, 0)).toBe(4);
    expect(report.jobs.map((j) => j.id).sort()).toEqual(["j-1", "j-2", "j-3", "j-4"]);
    // The other tenant's job is absent, which is the isolation guarantee.
    expect(report.jobs.some((j) => j.id === "j-5")).toBe(false);
  });

  it("reports no latency figure rather than zero when nothing has finished", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "observability.jobs",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok).toBe(true);
    const report = res.data as {
      totals: { jobs: number };
      latency: {
        samples: number;
        p50Ms: number | null;
        p95Ms: number | null;
        maxMs: number | null;
      };
    };
    expect(report.totals.jobs).toBe(0);
    // Null, not 0: there is no measurement, and 0 would read as instant work.
    expect(report.latency).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null });
  });

  it("serves the organization list to a member", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({ procedure: "organizations.list", accessToken: TOKEN_ALICE });
    expect(res.ok).toBe(true);
    expect((res.data as Organization[]).map((o) => o.id)).toEqual([ORG_A]);
  });

  it("lists the members of an organization to a member, with their role", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "organizations.members.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok).toBe(true);
    const members = res.data as OrganizationMember[];
    expect(members.map((m) => m.userId)).toEqual([ALICE]);
    expect(members[0]!.role).toBe("owner");
  });

  it("refuses the member list to a non-member rather than returning an empty tenant", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "organizations.members.list",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A },
    });
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
  });

  it("audits a creation through the registered create procedure", async () => {
    const { store, audit } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "organizations.create",
      accessToken: TOKEN_ALICE,
      input: { name: "New Org", slug: "new-org" },
    });
    expect(res.ok).toBe(true);
    expect(audit.some((a) => a.event === "organization.created" && a.actorId === ALICE)).toBe(true);
  });

  it("rejects a bad payload without touching the store", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Bad", slug: "Not Valid" },
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });
});

describe("projects.update through the registered procedures", () => {
  it("renames a project and records the change", async () => {
    const { store, audit, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", name: "Renamed", slug: "renamed" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as Project;
    expect(data.name).toBe("Renamed");
    expect(data.slug).toBe("renamed");
    expect(projects[0]?.name).toBe("Renamed");
    expect(audit.some((a) => a.event === "project.updated" && a.targetId === "p-1")).toBe(true);
  });

  it("reports not_found for a project the caller is not a member of", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_CAROL,
      input: { projectId: "p-1", name: "Hijacked" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(projects[0]?.name).toBe("P");
  });

  it("requires something to change", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1" },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });

  it("rejects an invalid slug", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", slug: "Not Valid" },
    });

    expect(res.status).toBe(400);
    expect(projects[0]?.slug).toBe("p");
  });

  it("refuses a slug change once the hosting engine holds the application", async () => {
    const { store, projects, audit } = makeStore();
    // The worker records the engine application against the project on the first
    // deployment. From then on the slug *is* that application's name, and the
    // engine offers no rename — so a slug change is refused rather than leaving
    // the two names silently different.
    projects[0] = { ...projects[0]!, providerResourceId: "coolify-app-1" };
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", slug: "renamed" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("conflict");
    expect(projects[0]?.slug).toBe("p");
    expect(audit.some((a) => a.event === "project.updated")).toBe(false);
  });

  it("still lets the name change when the slug cannot", async () => {
    const { store, projects } = makeStore();
    projects[0] = { ...projects[0]!, providerResourceId: "coolify-app-1" };
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", name: "Renamed" },
    });

    expect(res.ok).toBe(true);
    expect(projects[0]?.name).toBe("Renamed");
    expect(projects[0]?.slug).toBe("p");
  });

  it("allows a slug change before the engine application exists", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", slug: "renamed" },
    });

    expect(res.ok).toBe(true);
    expect(projects[0]?.slug).toBe("renamed");
  });

  it("sets a monorepo root directory and normalises it before storing", async () => {
    const { store, projects, audit } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      // A leading `./` and a trailing `/` are what a person types; the stored
      // value is the plain relative path the engine's base_directory wants.
      input: { projectId: "p-1", rootDirectory: "./apps/web/" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as Project).rootDirectory).toBe("apps/web");
    expect(projects[0]?.rootDirectory).toBe("apps/web");
    expect(
      audit.some(
        (a) => a.event === "project.updated" && a.metadata?.rootDirectory === "apps/web",
      ),
    ).toBe(true);
  });

  it("clears a root directory back to the repository root", async () => {
    const { store, projects } = makeStore();
    projects[0] = { ...projects[0]!, rootDirectory: "apps/web" };
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", rootDirectory: "" },
    });

    expect(res.ok).toBe(true);
    expect(projects[0]?.rootDirectory).toBeNull();
  });

  it("refuses a root directory that would escape the checkout", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    for (const rootDirectory of ["/etc", "../other-app", "apps/../../etc", "apps\\web"]) {
      const res = await router.route({
        procedure: "projects.update",
        accessToken: TOKEN_ALICE,
        input: { projectId: "p-1", rootDirectory },
      });
      expect(res.status, `expected ${rootDirectory} to be refused`).toBe(400);
      expect(res.error?.code).toBe("invalid_input");
    }
    // Nothing was written by any of the refused attempts.
    expect(projects[0]?.rootDirectory).toBeNull();
  });

  it("refuses a root directory change once the hosting engine holds the application", async () => {
    const { store, projects } = makeStore();
    // The engine reads base_directory when it creates the application and has no
    // re-target, so the value is frozen with the slug — same divergence, same
    // refusal.
    projects[0] = { ...projects[0]!, providerResourceId: "coolify-app-1" };
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", rootDirectory: "apps/web" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("conflict");
    expect(projects[0]?.rootDirectory).toBeNull();
  });

  it("allows re-sending the root directory a locked project already has", async () => {
    const { store, projects } = makeStore();
    projects[0] = {
      ...projects[0]!,
      providerResourceId: "coolify-app-1",
      rootDirectory: "apps/web",
    };
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.update",
      accessToken: TOKEN_ALICE,
      input: { projectId: "p-1", name: "Renamed", rootDirectory: "apps/web" },
    });

    expect(res.ok).toBe(true);
    expect(projects[0]?.name).toBe("Renamed");
    expect(projects[0]?.rootDirectory).toBe("apps/web");
  });
});

describe("projects.create with a root directory", () => {
  it("stores the directory a monorepo project builds from", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Web", slug: "web", rootDirectory: "apps/web" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as Project).rootDirectory).toBe("apps/web");
    expect(projects.some((p) => p.slug === "web" && p.rootDirectory === "apps/web")).toBe(true);
  });

  it("rejects an escaping directory before the project exists", async () => {
    const { store, projects } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    const res = await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Web", slug: "web", rootDirectory: "../x" },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
    expect(projects.some((p) => p.slug === "web")).toBe(false);
  });
});

describe("API keys through the registered procedures", () => {
  const extras = { newId: () => "k-1" };

  it("issues a key and returns the secret exactly once", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store, extras));
    const res = await router.route({
      procedure: "apiKeys.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "ci", scopes: ["project:read"] },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { key: ApiKeySummary; secret: string };
    expect(data.secret.startsWith("cw_live_")).toBe(true);
    expect(data.key.scopes).toEqual(["project:read"]);

    // The list procedure never carries the secret or the hash.
    const listed = await router.route({
      procedure: "apiKeys.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    const body = JSON.stringify(listed.data);
    expect(body).not.toContain(data.secret);
    expect(body).not.toContain("keyHash");
  });

  it("never keeps a scope the caller's role does not grant", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store, extras));
    // Alice is an owner here; an owner holds org:delete, so it survives. The
    // narrowing itself is proven in the auth suite; what matters at this layer
    // is that the stored key and the response agree.
    const res = await router.route({
      procedure: "apiKeys.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "boom", scopes: ["made:up", "project:read"] },
    });
    const data = res.data as { key: ApiKeySummary };
    expect(data.key.scopes).toEqual(["project:read"]);
  });

  it("revokes a key and refuses it afterwards", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store, extras));
    await router.route({
      procedure: "apiKeys.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "ci", scopes: ["project:read"] },
    });
    const res = await router.route({
      procedure: "apiKeys.revoke",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, keyId: "k-1" },
    });
    expect(res.ok).toBe(true);

    const listed = await router.route({
      procedure: "apiKeys.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    const rows = listed.data as readonly ApiKeySummary[];
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("rejects a name outside the allowed length", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store, extras));
    const res = await router.route({
      procedure: "apiKeys.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "   ", scopes: ["project:read"] },
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });

  it("audits creation with the prefix, never the secret or hash", async () => {
    const { store, audit } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store, extras));
    const res = await router.route({
      procedure: "apiKeys.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "ci", scopes: ["project:read"] },
    });
    const { secret, key } = res.data as { secret: string; key: ApiKeySummary };
    const created = audit.find((a) => a.event === "api_key.created");
    expect(created).toBeDefined();
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(secret);
    expect(JSON.stringify(created?.metadata)).toContain(key.keyPrefix);
  });
});
