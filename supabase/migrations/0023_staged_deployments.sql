-- ---------------------------------------------------------------------------
-- 0023 — staged production deployments (Vercel's `--skip-domain`)
--
-- The gap this closes is P11 in `docs/competitive/vercel-feature-matrix.md`:
-- "Staged production deployment (`--skip-domain`)". Vercel builds a production
-- deployment *without* assigning it to the domain, so a release can be produced,
-- inspected and then promoted in one click. Cloud Wai had no such step: a
-- production build that succeeded was auto-promoted to the production pointer by
-- the worker (`deployment-job.ts`), so there was no way to stage one.
--
-- One column, a *request* attribute:
--
--   * `deployments.staged` — true means "build this as a production deployment
--     but do not make it live". The worker still builds it through the same
--     application and still records usage; it only skips the promotion. The row
--     then sits `succeeded` and not-current until `deployments.promote` moves the
--     pointer, which is exactly the promote path that already exists.
--
-- It is not guarded. `guard_engine_columns` (0006/0009) exists to stop a client
-- asserting an *outcome*; "stage this build" is the request, like `kind` in 0011.
-- The API is the writer. A staged build that a client could mark live would be a
-- promotion without a promote, so `is_current` stays engine/service written.
-- ---------------------------------------------------------------------------

alter table deployments
  add column if not exists staged boolean not null default false;

comment on column deployments.staged is
  'True when this production deployment was built without being made live (Vercel --skip-domain). The worker skips the auto-promote; deployments.promote moves the pointer later. False for a preview and for a normal production deploy.';
