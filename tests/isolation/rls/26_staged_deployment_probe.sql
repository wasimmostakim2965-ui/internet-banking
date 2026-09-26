-- Probe: staging a build is a request, being live is not.
--
-- `deployments.staged` (0023) records that a production build was requested
-- *without* being made live — Vercel's `--skip-domain`. It is deliberately not a
-- guarded engine column: it is the caller's request, like `kind` (0011), not the
-- engine's answer. The two facts that have to hold, and only a real database can
-- prove them, are:
--
--   1. `staged` is a request attribute a client may set on its own INSERT, and
--      it defaults false — a row is not accidentally held back.
--
--   2. Being live is still the server's alone. A client cannot pair `staged`
--      with `is_current`, and it cannot move the production pointer afterwards;
--      a staged build reaches the pointer only through `promote_deployment`,
--      which is service_role-only. This is the invariant that stops "staged"
--      from becoming a back door to a promotion.
--
-- Self-contained: it sets up its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (as the invoking role: superuser or service_role, so the guards pass)
-- ===========================================================================

truncate deployments, projects, organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '22222222-2222-2222-2222-222222222222');

insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '22222222-2222-2222-2222-222222222222');

-- ===========================================================================
-- Probe 1: staged is a client request attribute, and it defaults false
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare defaulted boolean;
begin
  -- A client may stage its own build: the column is the request, not an outcome.
  insert into deployments
    (id, organization_id, project_id, idempotency_key, requested_by, kind, staged)
  values ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-staged',
          '11111111-1111-1111-1111-111111111111', 'production', true);

  -- A second row that says nothing about staging is not held back by accident.
  insert into deployments
    (id, organization_id, project_id, idempotency_key, requested_by, kind)
  values ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-live',
          '11111111-1111-1111-1111-111111111111', 'production');

  select staged into defaulted
  from deployments where id = 'aaaaaaaa-0000-0000-0000-0000000000e2';
  if defaulted is distinct from false then
    raise exception 'INTEGRITY FAIL: staged defaulted to % rather than false', defaulted;
  end if;

  -- A client may not combine staging with being live: the row cannot be born
  -- current, so "staged" can never mean "live".
  begin
    insert into deployments
      (id, organization_id, project_id, idempotency_key, requested_by, kind, staged, is_current)
    values ('aaaaaaaa-0000-0000-0000-0000000000e3', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-staged-current',
            '11111111-1111-1111-1111-111111111111', 'production', true, true);
    raise exception 'INTEGRITY FAIL: a client inserted a staged deployment that is already current';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- And it cannot move the pointer afterwards either.
  begin
    update projects set production_deployment_id = 'aaaaaaaa-0000-0000-0000-0000000000e1'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
    raise exception 'INTEGRITY FAIL: a client promoted a staged deployment by pointer';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: a staged build reaches the pointer only through promote_deployment
-- ===========================================================================

set role service_role;

do $$
declare
  moved boolean;
  current_count int;
begin
  -- The engine confirmed the staged build: succeeded, not current. That is the
  -- state staging produces, and it must not be live.
  update deployments
  set status = 'succeeded', url = 'https://alpha.test'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000e1';

  if exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and is_current
  ) then
    raise exception 'INTEGRITY FAIL: a staged build is current without a promote';
  end if;

  -- An explicit promote is what makes it live, and it is single-valued.
  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'aaaaaaaa-0000-0000-0000-0000000000e1');
  if moved is not true then
    raise exception 'REGRESSION FAIL: the service role could not promote a staged build';
  end if;

  select count(*) into current_count
  from deployments
  where project_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and is_current;
  if current_count <> 1 then
    raise exception 'INTEGRITY FAIL: % current deployments after promoting a staged build', current_count;
  end if;

  -- The staged flag is not cleared by the promote: the row still records that it
  -- was built as a staged release, which is the history the deployment list shows.
  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and is_current and staged
  ) then
    raise exception 'INTEGRITY FAIL: the promoted row lost its staged provenance';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 3: a staged row is tenant-scoped like any other
-- ===========================================================================

do $$
begin
  -- A staged deployment of another tenant is not promotable by this tenant's
  -- project id: promote_deployment carries organization_id in every where clause.
  insert into deployments
    (id, organization_id, project_id, idempotency_key, requested_by, kind, staged, status)
  values ('bbbbbbbb-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-00000000000b',
          'bbbbbbbb-0000-0000-0000-0000000000b1', 'key-b-staged',
          '22222222-2222-2222-2222-222222222222', 'production', true, 'succeeded');

  if public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'bbbbbbbb-0000-0000-0000-0000000000e1') then
    raise exception 'INTEGRITY FAIL: a staged build of another tenant was promoted across tenants';
  end if;
end;
$$;

reset role;

\echo 'staged deployments probe passed'
