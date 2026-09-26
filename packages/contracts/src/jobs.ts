/**
 * Durable command kinds the API enqueues.
 *
 * A payload lives in `contracts` because both the API (which writes it) and the
 * worker (which reads it) depend on this package, and neither app may import the
 * other. Payloads are plain data: no adapter type, no engine SDK handle. Where a
 * job needs an engine-side reference (the deployment's application, the backup's
 * database), the worker resolves it from the row it was given rather than
 * trusting an id baked into a payload that may have gone stale.
 */
import type { OrganizationId, ProjectId } from "./ids.js";

export const DEPLOYMENT_JOB_KIND = "deployments.execute";

export interface DeploymentJobPayload {
  /** The deployment row this job advances. The API wrote it before enqueuing. */
  readonly deploymentId: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly action: "create" | "rollback";
  /** The project slug, used as the application name on first create. */
  readonly projectSlug: string;
  readonly gitRepository: string | null;
  readonly gitBranch: string | null;
  /** A `BuildPack` value, kept as a string so contracts stays adapter-free. */
  readonly buildPack: string | null;
  /**
   * The repository-relative directory to build from, for a monorepo, or null
   * for the repository root. A request attribute, replayed by a redeploy.
   */
  readonly rootDirectory: string | null;
  /** The git revision a rollback returns to. */
  readonly commit: string | null;
  /**
   * `production` builds the linked branch; `preview` builds a branch or commit
   * that is not the production one, and gets its own engine application.
   */
  readonly kind: "production" | "preview";
  /**
   * A stable key for a preview target — `pr-42` or `branch-feature-x` — so the
   * same branch reuses its application across pushes instead of creating a new
   * one per delivery. Null for a production deployment.
   */
  readonly previewKey: string | null;
}

export const BACKUP_JOB_KIND = "data.backup.execute";

/**
 * A backup requested against a provisioned data resource.
 *
 * It carries no engine handle: the worker re-reads the resource and takes the
 * handle from there, so a job cannot back up whatever a stale id happens to name.
 */
export interface BackupJobPayload {
  readonly backupId: string;
  readonly organizationId: OrganizationId;
  readonly dataResourceId: string;
  /** The member who asked, carried so the worker's audit row names the actor. */
  readonly actorId: string;
  readonly actorEmail: string;
}

export const RESTORE_JOB_KIND = "data.restore.execute";

/**
 * A restore requested against a provisioned data resource.
 *
 * It names the restore row the API wrote, the backup to read and the resource to
 * overwrite. As with a backup it carries no engine handle: the worker re-reads
 * both rows and takes the handles from them, so a stale id on a queued payload
 * cannot make it read a backup or overwrite a database the tenant does not own.
 */
export interface RestoreJobPayload {
  readonly restoreId: string;
  readonly organizationId: OrganizationId;
  readonly backupId: string;
  readonly dataResourceId: string;
  /** The member who asked, carried so the worker's audit row names the actor. */
  readonly actorId: string;
  readonly actorEmail: string;
}

export const POLICY_JOB_KIND = "policy.distribute.execute";
/** A distribution of the stored policy to the security edge. */
export interface PolicyJobPayload {
  readonly organizationId: OrganizationId;
  readonly policyId: string;
  /** The version the API saw. The worker re-reads and refuses a stale one. */
  readonly version: number;
  /** The member who asked, carried so the worker's audit rows name the actor. */
  readonly actorId: string;
  readonly actorEmail: string;
}
