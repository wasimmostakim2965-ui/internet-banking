/**
 * Organization and project procedures.
 *
 * Every function follows the same order:
 *   1. the context already carries a verified principal;
 *   2. scope is resolved from server-side memberships via `@cloud-wai/authorization`;
 *   3. the store call passes the principal id, which is also what the database
 *      policy checks — the guard is not the only line of defence.
 *
 * A missing membership and a missing row both surface as `not_found`.
 */
import { allowed, requireCapability, roleFor } from "../guard.js";
import { ApiError } from "../errors.js";
import { parseRootDirectory } from "../root-directory.js";
import type { OrgRole } from "@cloud-wai/authorization";
import type {
  ControlPlaneWrites,
  DataStore,
  Organization,
  OrganizationMember,
  Project,
} from "@cloud-wai/database";
import type { ExecutionModel, OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface OrgDeps {
  readonly store: DataStore;
}

export async function listOrganizations(
  ctx: RequestContext,
  deps: OrgDeps,
): Promise<readonly Organization[]> {
  // Memberships are already scoped server-side; the store re-filters by user.
  return deps.store.listOrganizations(ctx.principal.userId);
}

export async function createOrganization(
  ctx: RequestContext,
  deps: OrgDeps,
  input: { name: string; slug: string },
): Promise<Organization> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "Organization name must be 1-120 characters.");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) {
    throw new ApiError(
      "invalid_input",
      "Organization slug must be lowercase alphanumeric with hyphens.",
    );
  }

  const org = await deps.store.createOrganization({
    name,
    slug: input.slug,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: org.id,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "organization.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { slug: org.slug },
  });

  return org;
}

export async function getOrganization(
  ctx: RequestContext,
  deps: OrgDeps,
  organizationId: OrganizationId,
): Promise<Organization> {
  requireCapability(ctx, organizationId, "org:read");
  const orgs = await deps.store.listOrganizations(ctx.principal.userId);
  const found = orgs.find((o) => o.id === organizationId);
  if (!found) {
    throw new ApiError("not_found", "Organization not found.");
  }
  return found;
}

export async function listProjects(
  ctx: RequestContext,
  deps: OrgDeps,
  organizationId: OrganizationId,
): Promise<readonly Project[]> {
  requireCapability(ctx, organizationId, "project:read");
  return deps.store.listProjects(ctx.principal.userId, organizationId);
}

export async function getProject(
  ctx: RequestContext,
  deps: OrgDeps,
  projectId: ProjectId,
): Promise<Project> {
  // A project id alone is not a scope we trust; the store joins through
  // membership and returns null for both "absent" and "other tenant".
  const project = await deps.store.getProject(ctx.principal.userId, projectId);
  if (!project) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, project.organizationId, "project:read");
  return project;
}

export async function createProject(
  ctx: RequestContext,
  deps: OrgDeps,
  input: {
    organizationId: OrganizationId;
    name: string;
    slug: string;
    /** The execution model the customer picks; defaults to `container`. */
    executionModel?: ExecutionModel | undefined;
    /** The monorepo subdirectory to build from; null is the repository root. */
    rootDirectory?: string | undefined;
  },
): Promise<Project> {
  requireCapability(ctx, input.organizationId, "project:create");

  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "Project name must be 1-120 characters.");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) {
    throw new ApiError(
      "invalid_input",
      "Project slug must be lowercase alphanumeric with hyphens.",
    );
  }
  const executionModel = parseExecutionModel(input.executionModel);
  const rootDirectory = parseRootDirectory(input.rootDirectory);

  const project = await deps.store.createProject({
    organizationId: input.organizationId,
    name,
    slug: input.slug,
    createdBy: ctx.principal.userId,
    ...(executionModel ? { executionModel } : {}),
    ...(rootDirectory ? { rootDirectory } : {}),
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "project.created",
    targetType: "project",
    targetId: project.id,
    metadata: {
      slug: project.slug,
      executionModel: project.executionModel,
      rootDirectory: project.rootDirectory,
    },
  });

  return project;
}

/**
 * Validate a customer-supplied execution model.
 *
 * An absent value is `undefined` (the store's default applies). A present value
 * must be one the platform knows: an unknown string is rejected at the boundary
 * rather than stored and then mis-routed by the worker, which would run the wrong
 * execution model for the project.
 */
function parseExecutionModel(value: ExecutionModel | undefined): ExecutionModel | undefined {
  if (value === undefined) return undefined;
  if (value === "container" || value === "serverless") return value;
  throw new ApiError("invalid_input", "Execution model must be 'container' or 'serverless'.");
}

/** Non-throwing variant, for callers that want a boolean and no error. */
export function mayReadProject(ctx: RequestContext, organizationId: OrganizationId): boolean {
  return allowed(ctx, organizationId, "project:read");
}

/**
 * The members of an organization.
 *
 * `member:read` already exists in the capability matrix and the members table
 * already has a policy, so this closes the gap between the contract and the
 * running system rather than adding a new permission. The guard runs first; the
 * store then re-filters by the caller's own membership, so a service-role
 * connection cannot turn this into a cross-tenant read.
 */
export async function listOrganizationMembers(
  ctx: RequestContext,
  deps: OrgDeps,
  organizationId: OrganizationId,
): Promise<readonly OrganizationMember[]> {
  requireCapability(ctx, organizationId, "member:read");
  return deps.store.listOrganizationMembers(ctx.principal.userId, organizationId);
}

/**
 * Change a member's role.
 *
 * The guard order is deliberate. The caller's own role is read first, so a
 * non-member gets `not_found` before anything about the target is disclosed.
 * Then the *rank* rules, which mirror the policy in `0020`: nobody edits their
 * own role (promotion and demotion both need a second party), an admin may not
 * act on an owner, and the last owner cannot be demoted. Only after those does
 * the store call run; the policy re-checks the same facts, so a caller who
 * bypasses the API still cannot escalate.
 */
export async function updateOrganizationMemberRole(
  ctx: RequestContext,
  deps: OrgDeps,
  input: { organizationId: OrganizationId; memberId: string; role: OrgRole },
): Promise<OrganizationMember> {
  requireCapability(ctx, input.organizationId, "member:invite");

  const callerRole = roleFor(ctx, input.organizationId);
  if (callerRole === null) throw new ApiError("not_found", "Organization not found.");

  if (input.memberId === ctx.principal.userId) {
    throw new ApiError("invalid_input", "You cannot change your own role.");
  }

  const members = await deps.store.listOrganizationMembers(
    ctx.principal.userId,
    input.organizationId,
  );
  const target = members.find((m) => m.userId === input.memberId);
  if (!target) throw new ApiError("not_found", "Member not found.");

  // Rank, not just capability: an admin holds `member:invite`, but must not be
  // able to demote the owner who appointed them or mint a second owner.
  if (callerRole !== "owner") {
    if (target.role === "owner") {
      throw new ApiError("forbidden", "Only an owner can change an owner's role.");
    }
    if (input.role === "owner") {
      throw new ApiError("forbidden", "Only an owner can grant the owner role.");
    }
  }

  if (target.role === "owner" && input.role !== "owner") {
    const otherOwners = members.filter((m) => m.role === "owner" && m.userId !== input.memberId);
    if (otherOwners.length === 0) {
      throw new ApiError("conflict", "The last owner cannot be demoted.");
    }
  }

  const updated = await deps.store.updateOrganizationMemberRole({
    userId: ctx.principal.userId,
    organizationId: input.organizationId,
    memberId: input.memberId,
    role: input.role,
  });
  if (!updated) throw new ApiError("not_found", "Member not found.");

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "member.role_changed",
    targetType: "member",
    targetId: input.memberId,
    metadata: { from: target.role, to: input.role },
  });

  return updated;
}

/**
 * Remove a member.
 *
 * A member may always remove themselves — leaving an organization is a normal
 * action — and anyone else needs to outrank the row. The last owner is refused
 * either way, so an organization cannot be left with nobody who can manage it.
 */
export async function removeOrganizationMember(
  ctx: RequestContext,
  deps: OrgDeps,
  input: { organizationId: OrganizationId; memberId: string },
): Promise<{ removed: boolean }> {
  const removingSelf = input.memberId === ctx.principal.userId;
  requireCapability(ctx, input.organizationId, removingSelf ? "org:read" : "member:remove");

  const callerRole = roleFor(ctx, input.organizationId);
  if (callerRole === null) throw new ApiError("not_found", "Organization not found.");

  const members = await deps.store.listOrganizationMembers(
    ctx.principal.userId,
    input.organizationId,
  );
  const target = members.find((m) => m.userId === input.memberId);
  if (!target) throw new ApiError("not_found", "Member not found.");

  if (!removingSelf && callerRole !== "owner" && target.role === "owner") {
    throw new ApiError("forbidden", "Only an owner can remove an owner.");
  }

  if (target.role === "owner") {
    const otherOwners = members.filter((m) => m.role === "owner" && m.userId !== input.memberId);
    if (otherOwners.length === 0) {
      throw new ApiError("conflict", "The last owner cannot be removed.");
    }
  }

  const removed = await deps.store.removeOrganizationMember({
    userId: ctx.principal.userId,
    organizationId: input.organizationId,
    memberId: input.memberId,
  });
  if (!removed) throw new ApiError("not_found", "Member not found.");

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "member.removed",
    targetType: "member",
    targetId: input.memberId,
    metadata: { role: target.role, self: removingSelf },
  });

  return { removed: true };
}

/**
 * Rename a project.
 *
 * The project id is resolved through membership first, so the organization the
 * capability is checked against comes from the row, not from the caller — the
 * same reason `getProject` reads before it guards. Only `name` and `slug` can
 * change: the engine-owned columns are not accepted here and the `projects`
 * trigger from `0006` would reject them anyway.
 */
export async function updateProject(
  ctx: RequestContext,
  deps: OrgDeps,
  input: {
    projectId: ProjectId;
    name?: string | undefined;
    slug?: string | undefined;
    executionModel?: ExecutionModel | undefined;
    /** The monorepo subdirectory to build from; null clears it to the root. */
    rootDirectory?: string | null | undefined;
  },
): Promise<Project> {
  const existing = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!existing) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, existing.organizationId, "project:update");

  if (
    input.name === undefined &&
    input.slug === undefined &&
    input.executionModel === undefined &&
    input.rootDirectory === undefined
  ) {
    throw new ApiError(
      "invalid_input",
      "Nothing to update: provide a name, a slug, an execution model or a root directory.",
    );
  }

  let name: string | undefined;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new ApiError("invalid_input", "Project name must be 1-120 characters.");
    }
  }

  let slug: string | undefined;
  if (input.slug !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) {
      throw new ApiError(
        "invalid_input",
        "Project slug must be lowercase alphanumeric with hyphens.",
      );
    }
    slug = input.slug;
  }

  const executionModel = parseExecutionModel(input.executionModel);

  // A root directory is written into the engine application at create time
  // (`base_directory`) and applied to every command the engine runs. Coolify has
  // no re-target, so changing it once the application exists would leave the
  // engine building the old directory while the dashboard shows the new one —
  // the same divergence the slug rule below refuses. The honest answer is to
  // refuse the change and say why; a fresh project can still set it before the
  // first deployment.
  let rootDirectory: string | null | undefined;
  if (input.rootDirectory !== undefined) {
    rootDirectory = parseRootDirectory(input.rootDirectory);
    if (rootDirectory !== existing.rootDirectory && existing.providerResourceId != null) {
      throw new ApiError(
        "conflict",
        "This project's root directory is set on the hosting engine when the application " +
          "is created, and the engine cannot re-target it. It can only change before the " +
          "first deployment.",
      );
    }
  }

  // The slug *is* the engine application's name — the worker creates the
  // application as `projectSlug` and resolves it afterwards by the stored
  // provider reference. Renaming the slug once that application exists would
  // leave the engine running under the old name while the dashboard shows the
  // new one: a silent divergence, and the next application a lost reference
  // produced would be a duplicate rather than a rename. The engine has no
  // rename the control plane is allowed to call, so the honest answer is to
  // refuse the slug change and say why. A name change stays free.
  if (slug !== undefined && slug !== existing.slug && existing.providerResourceId != null) {
    throw new ApiError(
      "conflict",
      "This project's slug names the application on the hosting engine, and the engine " +
        "cannot rename it. The slug can only change before the first deployment creates " +
        "the application; rename the project's name instead.",
    );
  }

  const writes = deps.store as Partial<ControlPlaneWrites>;
  if (typeof writes.updateProject !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot rename projects yet.");
  }

  const updated = await writes.updateProject({
    organizationId: existing.organizationId,
    projectId: input.projectId,
    name,
    slug,
    executionModel,
    ...(rootDirectory !== undefined ? { rootDirectory } : {}),
  });
  if (!updated) {
    throw new ApiError("not_found", "Project not found.");
  }

  await deps.store.recordAuditEvent({
    organizationId: updated.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "project.updated",
    targetType: "project",
    targetId: updated.id,
    metadata: {
      slug: updated.slug,
      ...(executionModel ? { executionModel } : {}),
      ...(rootDirectory !== undefined ? { rootDirectory: updated.rootDirectory } : {}),
    },
  });

  return updated;
}
