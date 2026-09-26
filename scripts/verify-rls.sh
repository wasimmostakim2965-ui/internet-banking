#!/usr/bin/env bash
# Prove the control-plane RLS policies against a real PostgreSQL.
#
# Boots a throwaway Postgres, applies the auth shim (auth.uid() + Supabase
# roles), applies every migration in order, then runs the probes. Any
# cross-tenant read or write, any client-side deployment-status change, any
# client-written engine column, and any readable API-key hash makes a probe fail.
#
# Requires a working Docker daemon. DOCKER may be overridden, e.g.
# DOCKER="sudo docker" ./scripts/verify-rls.sh in environments where the socket
# is root-owned.
#
# If Docker is unavailable, point the script at an existing empty PostgreSQL
# with CLOUDWAI_RLS_DSN (a libpq connection string). That path is used in CI
# images and sandboxes where a daemon cannot run, and it runs the same SQL, so
# it is the same proof — only the way the server is obtained differs.

set -euo pipefail

DOCKER="${DOCKER:-docker}"
CONTAINER="${CONTAINER:-cw-rls-verify}"
IMAGE="${IMAGE:-postgres:17-alpine}"
PORT="${PORT:-55432}"
DB="${DB:-cloudwai}"
DSN="${CLOUDWAI_RLS_DSN:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One list, applied in order, by both modes below. It used to be written out
# twice — once per mode — and the two copies drifted, so a newly added probe ran
# in one mode and was silently skipped in the other. A single list cannot drift.
SQL_STEPS=(
  "auth shim|tests/isolation/rls/00_auth_shim.sql"
  "schema migration|supabase/migrations/0001_control_plane.sql"
  "rls policies|supabase/migrations/0002_rls.sql"
  "job lease/idempotency|supabase/migrations/0003_jobs_lease_and_idempotency.sql"
  "security policy events|supabase/migrations/0004_security_policy_events.sql"
  "domain verification|supabase/migrations/0005_domain_verification.sql"
  "engine column guards|supabase/migrations/0006_engine_column_guards.sql"
  "api key scope guard|supabase/migrations/0007_api_key_scope_guard.sql"
  "job claim/reap functions|supabase/migrations/0008_jobs_claim_and_reap_functions.sql"
  "deployment status guard|supabase/migrations/0009_deployment_status_guard.sql"
  "security protection and events|supabase/migrations/0010_security_protection_and_events.sql"
  "project git links|supabase/migrations/0011_project_git_links.sql"
  "data restores|supabase/migrations/0012_data_restores.sql"
  "organization budgets|supabase/migrations/0013_organization_budgets.sql"
  "deployment production pointer|supabase/migrations/0014_deployment_production_pointer.sql"
  "project env vars|supabase/migrations/0015_project_env_vars.sql"
  "security trusted sources|supabase/migrations/0016_security_trusted_sources.sql"
  "project execution model|supabase/migrations/0017_project_execution_model.sql"
  "security rate limits|supabase/migrations/0018_security_rate_limits.sql"
  "security incidents|supabase/migrations/0019_security_incidents.sql"
  "member management|supabase/migrations/0020_member_management.sql"
  "deployment source|supabase/migrations/0021_deployment_source.sql"
  "monorepo root directory|supabase/migrations/0022_project_root_directory.sql"
  "staged deployments|supabase/migrations/0023_staged_deployments.sql"
  "job queue probe|tests/isolation/rls/11_jobs_probe.sql"
  "job claim/reap probe|tests/isolation/rls/14_jobs_claim_probe.sql"
  "isolation probe|tests/isolation/rls/10_isolation_probe.sql"
  "engine column guard probe|tests/isolation/rls/12_domain_verification_probe.sql"
  "api key scope probe|tests/isolation/rls/13_api_key_scope_probe.sql"
  "deployment status guard probe|tests/isolation/rls/15_deployment_status_probe.sql"
  "security protection probe|tests/isolation/rls/16_security_protection_probe.sql"
  "git link probe|tests/isolation/rls/17_git_link_probe.sql"
  "data restore probe|tests/isolation/rls/18_data_restore_probe.sql"
  "budget probe|tests/isolation/rls/19_budget_probe.sql"
  "production pointer probe|tests/isolation/rls/20_production_pointer_probe.sql"
  "env var probe|tests/isolation/rls/21_env_var_probe.sql"
  "trusted source probe|tests/isolation/rls/22_trusted_source_probe.sql"
  "rate limit probe|tests/isolation/rls/23_rate_limit_probe.sql"
  "incident probe|tests/isolation/rls/24_incident_probe.sql"
  "member management probe|tests/isolation/rls/25_member_management_probe.sql"
  "staged deployment probe|tests/isolation/rls/26_staged_deployment_probe.sql"
)

run_all() {
  local label file
  for step in "${SQL_STEPS[@]}"; do
    label="${step%%|*}"
    file="$ROOT/${step#*|}"
    echo "== $label =="
    "$1" <"$file"
  done
}

if [ -n "$DSN" ]; then
  # Existing server: every statement is applied with psql, in order.
  run_psql() {
    psql "$DSN" -v ON_ERROR_STOP=1 -q -f -
  }
  run_all run_psql

  echo
  echo "RLS verification complete: migrations applied, isolation probe passed."
  exit 0
fi

cleanup() {
  $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
echo "== booting $IMAGE =="
$DOCKER run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" "$IMAGE" >/dev/null

echo "== waiting for postgres =="
# pg_isready alone is racy: it can report "rejecting connections" for a moment
# while the server finishes starting up. Wait for a real query instead.
ready=0
for _ in $(seq 1 90); do
  if $DOCKER exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: postgres did not become ready" >&2
  exit 1
fi

run_via_docker() {
  $DOCKER exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f -
}
run_all run_via_docker

echo
echo "RLS verification complete: migrations applied, isolation probe passed."
