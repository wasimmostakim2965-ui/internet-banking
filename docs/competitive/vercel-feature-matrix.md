# Vercel feature matrix — Cloud Wai, row by row, with proof

This is the mechanical comparison the brief asks for: every deployment-related
feature Vercel ships, and for each one what Cloud Wai actually has — **wired**,
**partial**, **contract-only**, **mocked**, **honest n/c** (procedure real, engine
unconfigured), or **missing** — with our own file and line as evidence.

It supersedes nothing: ADR-0016 remains the positioning record and
`docs/audit/dashboard-inventory.md` the control list. This file is the flat,
auditable table and it is the one to update as rows close.

Status vocabulary is identical to `docs/audit/source-audit-2026-09.md`.

## Research basis (so the comparison is against the real product)

Two sources, kept separate:

1. **Vercel's product surface** — `vercel.com/docs` and its feature pages, read
   during this pass: Projects, Deployments, Environments, Environment Variables,
   Deployment Protection, Instant Rollback, Promoting Deployments, Observability,
   Firewall/WAF (custom rules, rate limiting, IP blocking, bot management, attack
   mode, DDoS), CLI, Cron Jobs, Webhooks, Monorepos.
2. **What users say** — G2, Trustpilot, Vercel Community, Reddit, AWS
   Marketplace and Gartner reviews read this pass. Used for the *why*, not for
   the feature list.

### What users love (and why it sets our bar)

| Loved | Why | Source |
|---|---|---|
| Git-based deploys, zero config | "Connect a GitHub repo and get a live deployment in under 2 minutes. Zero documentation required." | devtoolsreviewed.com, luckymedia.dev (2026) |
| Preview URL per branch/PR | "Stakeholder feedback loops that took days now take minutes." | devtoolsreviewed.com, Gartner (2026) |
| Instant rollback | "The dashboard makes it quick to recover from a bad release." | vercel.com/docs/instant-rollback; G2 |
| Build/runtime logs in the dashboard | "No CloudWatch tab-switching." | cadence blog, G2 |
| Observability out of the box | Logs, traces, queryable metrics without a separate tool | vercel.com/docs/observability |
| Spend Management / hard bill limits | "Hard bill limits prevent surprise invoices." | devtoolsreviewed.com (2026) |

### What users hate (and why we must do it better)

| Hated | Root cause | Cloud Wai's answer, and whether it is built |
|---|---|---|
| **Pricing surprises** — "$600 on a $20 plan", "bill jumped from $100 to $800", "$1,900 scraper spike on a dev URL" | Overage rates with no hard cap; alerts that fail silently; a dev/staging URL billed like production | Bill limits are now a *hard* control, not an alert: the worker records a usage row when an engine confirms work, and `assertWithinBudget` (`apps/api/src/procedures/billing.ts`) refuses a new deployment or backup at the cap, on the request path before anything is enqueued. `organization_budgets` (migration `0013`) is owner-write / member-read under RLS. **Built (W8, W9).** |
| **Scrapers/AI bots burning bill** on non-production URLs | Edge does not distinguish malicious automation from a normal visitor under attack mode without rules | This is our Security differentiator — but **the allow-list is missing** (S5). Honest: not built. |
| **Cancellation/opacity** — "can't find the project", "impossible to cancel" | Navigation and account closures buried | We have one URL-driven nav (`apps/web/src/navigation.ts`) with deep links; no dark patterns by construction. |
| **Env-var changes "take effect on the next deployment"** | UI implies immediacy the artifact does not have | We express a change that needs a redeploy *as a deployment*, never a silent edit — designed, but env vars themselves are **missing** (D5). |

**The lesson taken:** the thing Vercel's own users want is a dashboard whose every
figure is the truth of the system, and a bill that cannot surprise them. That is
exactly the honesty rule this repo already enforces (ADR-0010) plus a budget
object we have not built.

## Workspace / team level

| # | Vercel feature | Cloud Wai surface (file:line) | Status |
|---|---|---|---|
| W1 | Teams / account switcher | `organizations.list/create/get` (`apps/api/src/procedures/index.ts:180-215`); workspace switcher in `apps/web/src/components/app-shell.tsx` | **Wired** |
| W2 | Projects list + create | `projects.list/create` (`index.ts:205-235`); `ProjectsPage` | **Wired** |
| W3 | Drill-in project navigation | `navigation.ts:40-110` (workspace→project→database) | **Wired** |
| W4 | Team members / roles | `organizations.members.list` (`index.ts:~220`); `SettingsPage` renders real rows | **Wired (read)** — invite/change/remove absent, page says so (no dead button) |
| W5 | API tokens | `apiKeys.list/create/revoke` (`index.ts:335-360`); secret shown once, hashed | **Wired** |
| W6 | Activity / audit log | `audit.list` (`index.ts:255`); `ActivityPage`; append-only in DB | **Wired** |
| W7 | Billing / usage (read) | `billing.usage` (`apps/api/src/procedures/billing.ts`); org roll-up | **Wired (read)** |
| W8 | Usage **recording** (the row behind the bill) | `recordUsage` writes a row when an engine confirms a deployment (`apps/worker/src/deployment-job.ts`) or a backup (`apps/worker/src/backup-job.ts`) | **Wired** |
| W9 | Budget / spend cap / hard limit | `organization_budgets` (migration `0013`); `billing.budgets.list/save/remove`; `assertWithinBudget` refuses at the cap; `BillingPage` spend-cap section | **Wired** |
| W10 | Webhooks (account-level) | none | **Missing** |
| W11 | Notifications (email/push/SMS) | none | **Missing** |
| W12 | 2FA enforcement / SAML SSO | none | **Missing** |
| W13 | Audit-log export / CSV / drains | `auditCsv` (`apps/web/src/view-model.ts`) renders the rows `audit.list` returns (org-scoped, membership-checked, append-only) as RFC-4180 CSV; `ActivityPage` (`apps/web/src/pages/pages.tsx`) offers an Export CSV button that downloads exactly the shown slice and says it is the recent 200, not the full history. No drains/push yet | **Partial** (CSV export wired; scheduled drains still missing) |
| W14 | Domain registration / claim | landing search box, registrar `not_configured` (`apps/web/src/pages/landing.tsx:120-160`) | **Honest n/c** |
| W15 | CLI | none | **Missing** |

## Project level

| # | Vercel feature | Cloud Wai surface (file:line) | Status |
|---|---|---|---|
| P1 | Project overview + latest production deployment | `projects.get` + `deployments.list` + `audit.list`; `ProjectOverviewPage` | **Wired** |
| P2 | Deployments history | `deployments.list` (`index.ts:230`); `DeploymentsPage` | **Wired** |
| P3 | Create deployment | `deployments.create` (`index.ts:237`; `apps/api/src/procedures/deployments.ts:requestDeployment`) | **Wired** |
| P4 | Durable deploy execution (job + worker) | `apps/worker/src/deployment-executor.ts`; `sql-queue.ts` | **Wired** |
| P5 | Build vs runtime logs | `deployments.logs` (`index.ts:247`); `source` distinguishes them | **Wired** |
| P6 | Instant rollback | `deployments.rollback` (`index.ts:242`); Coolify needs a commit (`coolify.ts:353`) | **Wired** |
| P7 | Cancel an in-flight deployment | `deployments.cancel` (`index.ts:257`; `apps/api/src/procedures/deployments.ts:cancelDeployment`); adapter `cancelDeployment` (`coolify.ts:326`); Cancel action on pending/running rows | **Wired** |
| P8 | Git integration: auto-deploy on push | `git.connect` + HMAC-verified `/hooks/git` receiver enqueues the deploy job (`apps/api/src/git-hook.ts`); Project Settings → Git page connects a repo and shows the webhook URL (`apps/web/src/pages/pages.tsx`) | **Wired** (engine execution is honest n/c without Coolify) |
| P9 | Preview deployment per branch / PR | non-production branch/PR -> preview kind + `preview_targets`; `PreviewTarget` resolved by the worker; Deployments list labels a preview row `Preview · PR #n` and the Git page carries the previews toggle | **Wired** |
| P10 | Promote preview → production | `deployments.promote` (`apps/api/src/procedures/deployments.ts:promoteDeployment`), store `promoteDeployment` (`packages/database/src/index.ts`), single production pointer (`supabase/migrations/0014_deployment_production_pointer.sql`), Promote + Instant rollback share it (`PromoteDeploymentModal`, `apps/web/src/pages/pages.tsx`); a preview or un-succeeded build is refused | **Wired** |
| P11 | Staged production deployment (`--skip-domain`) | `deployments.staged` (`supabase/migrations/0023_staged_deployments.sql`); `deployments.create` accepts `staged` (`apps/api/src/procedures/deployments.ts:requestDeployment`), refuses it on a preview; the worker applier skips the auto-promote when staged (`apps/worker/src/deployment-job.ts`), so the build settles `succeeded` and not-current; `deployments.promote` makes it live in one click; the Deployments page carries the "Stage this release" checkbox and a `Production · staged` badge | **Wired** |
| P12 | Deployment protection (auth/password/IP) | none | **Missing (D7)** |
| P13 | Environment variables (per env) | `project_env_vars` table + RLS + guarded engine columns (`supabase/migrations/0015_project_env_vars.sql`); `env.list/set/remove` (`apps/api/src/procedures/env-vars.ts`); Coolify `/envs` through the adapter (`packages/adapters/src/coolify.ts`); worker reconciliation before each build (`apps/worker/src/env-sync.ts`); `EnvVarsPage` (`apps/web/src/pages/pages.tsx`); probe `21_env_var_probe.sql` | **Wired** (values encrypted, never returned) |
| P14 | Environments (Local/Preview/Production) model | `environments` table exists (`0001_control_plane.sql:133`), unused | **Missing (C3)** |
| P15 | Project settings: rename | `projects.update` (`index.ts:~240`); `ProjectSettingsPage` | **Wired** |
| P16 | Project settings: slug↔engine name sync | The slug *is* the engine application's name, so `projects.update` refuses a slug change once the worker has recorded the application (`provider_resource_id`), naming the reason; the Settings page disables the field with the same hint. A rename before the first deployment still works; the name stays freely editable. | **Wired** (honest refusal, no divergence) |
| P17 | Domains add / verify / remove | `domains.list/create/verify/remove`; project-scoped | **Wired**; direct-origin denial = gate 6 **open** |
| P18 | Automatic TLS / SSL | engine-side (Coolify); no control-plane surface | **Honest n/c** |
| P19 | Observability: metrics, traces, error tracking | `observability.jobs` (`apps/api/src/procedures/observability.ts`) = job roll-up from real rows, now with per-state/per-kind charts and a 14-day throughput series derived from `created_at`; host-level CPU/memory and traces panel states its absence | **Partial** (job-derived activity wired; resource metrics/traces missing) |
| P20 | Web Analytics / Speed Insights | none | **Missing** |
| P21 | Runtime logs / log drains | none (deployment logs only, P5) | **Missing** |
| P22 | Cron Jobs | none | **Missing** |
| P23 | Functions / serverless | a project's execution model is `container` or `serverless` (`projects.execution_model`, migration `0017`); the serverless engine is a distinct provider (`lambda`/`microvm`) behind `ServerlessAdapter` (SigV4-signed, per-org credentials) reached through the one `DeploymentEngine` port (`execution-router.ts`). A serverless deploy requires a built artifact and refuses without one; a serverless project is never handed to Coolify. Routes conformance-checked against botocore's pinned service models (`tests/fixtures/lambda-routes.json`, `tests/engines/lambda-routes.test.ts`) | **Wired (Honest n/c)** — no AWS credentials or build engine configured here, so a serverless deploy reports `not_configured` end to end |
| P24 | Edge Config | none | **Missing (out of model)** |
| P25 | Feature flags | none | **Missing** |
| P26 | Deployment states (Queued→Building→Ready→Error→Canceled) | `EngineStatus` vocabulary + `mapQueueStatus`/`mapDeploymentStatus` (`coolify.ts:67-115`) | **Wired** |
| P27 | Rollback-images / redeploy same commit | `rollback` with a commit (returns to a revision the engine already holds), and `redeploy` of a past row (`deployments.redeploy` → `redeployDeployment`, `apps/api/src/procedures/deployments.ts`), which replays the row's recorded `git_repository`/`git_branch`/`build_pack` into a fresh build. The row records its source because migration `0021` added `git_repository`/`build_pack`; a row that recorded no source (a rollback) is refused, and the dashboard hides the button rather than offering a dead action. A redeploy builds the branch head, so it is not a byte-for-byte replay — that is Rollback, and the dialog says so | **Wired** |
| P28 | Monorepo support (root dir, ignore-step) | **Root dir wired**: `projects.root_directory` + `deployments.root_directory` (migration `0022`), validated/normalised once in `apps/api/src/root-directory.ts` (no leading `/`, no `..`, no backslash), forwarded to Coolify as `base_directory` on create, recorded on the deployment row and replayed by `deployments.redeploy`. `projects.update` refuses a change once the engine holds the application (Coolify cannot re-target), matching the slug rule; the Settings page locks the field and says why. **Ignore-step missing** — Coolify has no ignore command on the create path, so a push that touches no files in the root directory still triggers a build | **Partially wired** |
| P29 | Framework detection / build pack | `BuildPack` (`adapters/src/index.ts:45-52`) passed through; default nixpacks | **Wired** |

## Security / edge (differentiator two)

| # | Vercel feature | Cloud Wai surface (file:line) | Status |
|---|---|---|---|
| X1 | WAF policy model + levels (none/normal/high/ultimate analogue = low/med/high/critical) | `packages/security/src/index.ts`; `apps/api/src/procedures/security.ts` | **Wired (author/save)** |
| X2 | WAF applies at the edge | `applyPolicy` (`packages/adapters/src/security-edge.ts:240`) — **Honest n/c** until an edge adapter is injected | **Honest n/c** |
| X3 | Policy version monotonic (never roll back) | `mayDistribute` (`packages/security/src/index.ts`); `security-control` | **Wired** |
| X4 | Hostile input refused, not escaped | `validateEdgeRoute` (`security-edge.ts:78-100`) | **Wired** |
| X5 | Hidden origin (private origin required) | `PRIVATE_HOST` grammar (`security-edge.ts:55`) | **Wired (config)** |
| X6 | Deny direct origin (gate 6) | needs live Envoy | **Open gate** |
| X7 | Block CRS fixtures (gate 7) | needs live Coraza | **Open gate** |
| X8 | **Attack mode** (challenge browsers, pass known bots) | `protectionMode` on `security_policies` (`supabase/migrations/0010_security_protection_and_events.sql`), saved via `security.policy.save` (`apps/api/src/procedures/security.ts`), carried into the compiled `challenge` step (`packages/adapters/src/security-edge.ts:318`), and distributed to a **reachable** edge via `buildDeploymentEngines` (`packages/database/src/edge-loaders.ts`) | **Wired** — the edge is reachable when configured; live-edge application stays an open release gate (6/7) |
| X9 | **Known-bots allow-list** / verified bots | `VERIFIED_BOTS` → `security.bots.list` (`apps/api/src/procedures/security.ts:538`); compiled first in the ladder as a two-rule Coraza chain: the UA match, then a label-boundary suffix match of the forward-confirmed name the edge records in `tx.cloud_wai_bot_confirm` (`@rx (^|\.)suffix$`, so a bare `@endsWith` cannot be fooled by `evilgooglebot.com` and an exact match cannot silently never fire). A confirmed crawler is exempt from the deny list (`cloud_wai_bot` guard). Bot entries are validated (`validateVerifiedBot`) before they become directives. The operator overlay is now populated: `SECURITY_EDGE_BOT_ALLOWLIST` (`securityEdgeConfigFromEnv`) parses `name:userAgent:confirmSuffix` entries and `loadPolicy` carries them into the compiled artifact, so a deployment's own webhook sender is pre-allowed; a malformed entry is dropped (fail-closed) | **Wired** (the allow is only granted when the edge sets the confirm variable; the live-edge application stays gate 6/7) |
| X10 | Bot management managed rulesets | curated verified-bot directory only | **Partial** |
| X11 | Custom firewall rules | deny list: `security.rules.list/add/remove` (`security.ts:443-520`), `security_rules` table, org-scoped RLS; compiled as `block-deny-list` steps | **Wired** |
| X12 | WAF rate limiting | per-route limits keyed by `ip`, `header` (with header name) or `global`; stored in `security_rate_limits` + org RLS (`supabase/migrations/0018_security_rate_limits.sql`), read through `security.rateLimits.*` (`apps/api/src/procedures/security.ts`), loaded by `edge-loaders.ts` and compiled as a `ratelimit` ladder step after the allow steps (`security-edge.ts`). Validated by the same rule the compiler runs, so an accepted limit is always one the edge will emit | **Wired** |
| X13 | IP blocking / trusted IPs | deny list supports `ip`/`cidr`/`asn`/`user-agent` kinds (`packages/security`); trusted-IP allow-list via `security.trustedSources.*` (`apps/api/src/procedures/security.ts`), `security_trusted_sources` + org RLS (`supabase/migrations/0016_security_trusted_sources.sql`), compiled as `allow-trusted-ip` steps **before** the deny list, and each deny chain now fails when the trusted marker is set (`security-edge.ts`). The validated addresses also reach the Envoy fragment (`skipChallengeAddresses`) | **Wired** — a trusted address is exempt from the deny list and is named to the edge for the challenge skip; the Envoy-side application of that field needs a live host (see AGENTS.md) |
| X14 | DDoS mitigation | engine-side (edge host); no control-plane surface | **Honest n/c** |
| X15 | Security incidents surfaced | `security_incidents` table + org-scoped RLS (`supabase/migrations/0019_security_incidents.sql`); opened by the detector (policy rejection in `apps/worker/src/policy-job.ts` and the synchronous `distributeSecurityPolicy`); read/transitioned via `security.incidents.list/transition` (`apps/api/src/procedures/security.ts`), store `listSecurityIncidents`/`transitionSecurityIncident` (`packages/database/src/supabase-store.ts`), Dashboard "Incidents" table with triage/close (`apps/web/src/pages/pages.tsx`) | **Wired** — the detector opens an incident on a rejected distribution; the surface is honest n/c until one exists |
| X16 | Edge decided-traffic view (what was blocked) | `security_events` table + org-scoped RLS (`supabase/migrations/0010_security_protection_and_events.sql`); read via `security.events.list` (`apps/api/src/procedures/security.ts`), store `listSecurityEvents` (`packages/database/src/supabase-store.ts`), Dashboard "Edge decisions" table (`apps/web/src/pages/pages.tsx`) | **Wired (read)** — the edge writes rows; **Honest n/c** until a live edge populates them |
| X17 | Security dashboard (posture across projects) | the org Security page shows posture, deny list, verified bots, engine state | **Partial** |

## Database (differentiator one — Vercel has no equivalent surface)

| # | Capability | Cloud Wai surface (file:line) | Status |
|---|---|---|---|
| B1 | Provision tenant Postgres / bucket | `data.provision` (`apps/api/src/procedures/data.ts`) | **Wired** (Honest n/c without creds) |
| B2 | List resources | `data.list` (`index.ts:~285`) | **Wired** |
| B3 | Back up a database | `data.backup`; bucket backup refused honestly | **Wired** |
| B4 | Backup history | `data.backups.list` (`index.ts:302`) | **Wired** |
| B5 | Restore from a backup (gate 9) | `data.restore` / `data.restores.list` (`apps/api/src/procedures/data.ts`), `data_restores` + RLS (`supabase/migrations/0012_data_restores.sql`), worker `buildRestoreJobHandler`/`buildRestoreApplier` (`apps/worker/src/restore-job.ts`), Dashboard `RestoreResourceModal` (`apps/web/src/pages/database.tsx`); name-confirmation + completed-backup-only refusals | **Wired** (Honest n/c without creds) |
| B6 | Rotate credentials | adapter `rotateCredentials` (`packages/adapters/src/postgres.ts:256`), `data.rotateCredentials` (`apps/api/src/procedures/data.ts`), registered (`apps/api/src/procedures/index.ts`), Dashboard `RotateCredentialsModal` with name-confirmation (`apps/web/src/pages/database.tsx`); postgres-only, requires a ready resource with an engine handle, and the new secret is never returned | **Wired** (Honest n/c without creds) |
| B7 | Table editor | `DatabaseTables` console handoff (`apps/web/src/pages/database.tsx`); deep link per ready database via `engineConsole.terminal` (`packages/adapters/src/engine-console.ts`) | **Wired (handoff)** — ADR-0011 Option A: the control plane never opens the tenant DB, so rows are edited on the engine console |
| B8 | SQL editor | `DatabaseSql` console handoff, same deep link | **Wired (handoff)** — SQL runs in the engine, never through the control plane |
| B9 | Authentication (GoTrue surface) | `DatabaseAuth` console handoff; app-level auth is configured where the app is deployed | **Wired (handoff)** — no tenant data-plane access (ADR-0011) |
| B10 | Storage buckets | `DatabaseStorage` from `data.list` | **Wired** |
| B11 | REST/API endpoint list | `DatabaseApi` console handoff | **Wired (handoff)** — no generated REST layer over tenant tables (ADR-0011) |
| B12 | Roles & extensions | `DatabaseRoles` console handoff | **Wired (handoff)** — role introspection needs data-plane access (ADR-0011) |
| B13 | Database logs | `data.logs` (`apps/api/src/procedures/data.ts`), `DatabaseAdapter.getLogs` (`packages/adapters/src/index.ts`, `postgres.ts`), `DatabaseLogs`/`DatabaseLogPanel` (`apps/web/src/pages/database.tsx`); unconfigured engine renders as its own state | **Wired** (Honest n/c without creds) |
| B14 | Database settings | `DatabaseSettings` console handoff (`engineConsole["environment-variables"]`) | **Wired (handoff)** — engine config lives on the engine (ADR-0011) |

## Where Cloud Wai is ahead (the honest version)

| Guarantee | Evidence | Why Vercel cannot claim it |
|---|---|---|
| No fabricated success | `tests/adapters/honesty.test.ts`, `tests/contract/status.test.ts`, ADR-0010 | A closed platform's status is its own word |
| Tenant isolation at two layers | `tests/isolation/*`, `rls/10_isolation_probe.sql` | RLS is ours to prove, and it is proven |
| Adapter cannot invent an engine route | `tests/engines/coolify.test.ts`, `tests/fixtures/coolify-routes.json` (gate 14) | No equivalent check exists on a closed platform |
| Policy never rolls backwards + hidden origin | `packages/security/src/index.ts`, `security-edge.ts` | Structural, not a toggle |
| Engines are OURS and replaceable | ADR-0001, `packages/adapters/*` | Vercel is not self-hostable behind a customer's engines |

## The honest gap summary (what closing the brief requires)

Ranked against the brief. Each row is a workstream, not a wish:

| Rank | Gap | Rows | Effort | Unblocks |
|---|---|---|---|---|
| 1 | Git integration + preview deployments | P8, P9, P10 | Large | "Vercel-grade deploy" claim |
| 2 | Known-bot allow-list + attack mode | X8 ✅, X9 ✅, X13 ✅ | Medium | **Closed** — the compile, the control-plane surface and the production edge wiring are done (`buildDeploymentEngines`); the live-edge application stays an open release gate (6/7) |
| 3 | Environment variables | P13, P14 | Medium | Day-one usability |
| 4 | Usage recording + hard spend cap | W8 ✅, W9 ✅ | Medium | **Closed** — the top user complaint |
| 5 | Cancel / restore / edge traffic view | P7 ✅, B5 ✅, X16 ✅, X15 ✅ | Medium | **Closed** — cancel, restore, the edge decided-traffic view and the incident lifecycle (X15) are all wired |
| 6 | Database sub-pages | B7–B14 | Large | Requires the ADR-0011 decision |
| 7 | Observability metrics/traces, analytics | P19–P21 | Large | Largest surface gap (ADR-0013) |

## Method and honesty

Vercel rows come from Vercel's own docs pages named above; user rows come from the
review sources named above. Our rows were read in the file cited, in this
session. `pnpm verify` (694 tests) and `pnpm verify:rls` were green when this was
written. A row moves to **Wired** only with a procedure, a page and a test in the
same commit.
