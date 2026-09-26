-- ---------------------------------------------------------------------------
-- 0022 — monorepo support: a project builds from a subdirectory
--
-- The gap this closes is P28 in `docs/competitive/vercel-feature-matrix.md`:
-- "Monorepo support (root dir, ignore-step)". Vercel's "Root Directory" is how
-- one repository hosts several deployable apps — the project points the build at
-- the directory that holds *its* app, and the engine runs every command relative
-- to it. Cloud Wai had no such field, so a monorepo's second app could not be
-- deployed at all: the engine would build the repository root.
--
-- Two columns, both *request* attributes, not engine observations:
--
--   * `projects.root_directory` — the project-level default. The same value the
--     caller sets on the Settings page, so every deploy of the project inherits
--     it rather than repeating it.
--   * `deployments.root_directory` — the value this build actually used,
--     recorded on the row exactly as `git_repository`/`build_pack` are (0021),
--     so a redeploy replays the directory it was built from and the build log
--     can be read against the right subdirectory.
--
-- Neither is guarded. `guard_engine_columns` (0006/0009) exists to stop a client
-- asserting an *outcome*; a root directory is the request, exactly like
-- `git_branch` in 0011 and `build_pack` in 0021. The API is the writer.
--
-- The engine maps this to Coolify's `base_directory` ("The base directory for
-- all commands", `PATCH /applications/{uuid}`), verified against Coolify's
-- published API reference. The value is a repository-relative path; the API
-- normalises it (no leading slash, no `..`) before it is stored, so a directory
-- that would escape the checkout is refused rather than forwarded to the engine.
-- ---------------------------------------------------------------------------

alter table projects
  add column if not exists root_directory text;

alter table deployments
  add column if not exists root_directory text;

comment on column projects.root_directory is
  'The repository-relative directory this project builds from, or null for the repository root. A request attribute, not an engine observation.';

comment on column deployments.root_directory is
  'The repository-relative directory this deployment was built from, recorded so a redeploy replays it. Null means the repository root.';
