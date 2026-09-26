/**
 * The dashboard pages.
 *
 * Each page loads exactly the sections its route names and renders them through
 * `SectionView`, which is the single place a section state becomes UI. There is
 * no page here that renders a value it did not load, and no page that turns a
 * `not_configured` engine into a success.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  type Column,
  BarChart,
  ChoiceGroup,
  DegradedState,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  LoadingSkeleton,
  Modal,
  PageShell,
  SectionShell,
  SectionView,
  StatBox,
  StatusBadge,
  Table,
  TextInput,
  presentDeploymentStatus,
} from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import { newRequestId } from "../ids.js";
import type { Route } from "../routes.js";
import {
  loadApiKeys,
  loadAudit,
  auditCsv,
  loadBudgets,
  loadDeployments,
  loadDeploymentLogs,
  loadDomains,
  loadEnvVars,
  loadGitLinks,
  deployFromLink,
  loadGitDeploySource,
  loadOrganization,
  loadOrganizationMembers,
  updateMemberRole,
  removeMember,
  loadObservability,
  loadOrganizations,
  loadProject,
  loadProjects,
  updateProject,
  loadProviderHealth,
  loadSecurityRules,
  loadSecurityEvents,
  loadSecurityIncidents,
  loadTrustedSources,
  addTrustedSource,
  removeTrustedSource,
  loadRateLimits,
  addRateLimit,
  removeRateLimit,
  loadVerifiedBots,
  loadUsage,
  loadSecurityPolicy,
  loadSecurityPolicyEvents,
  API_KEY_SCOPES,
  USAGE_METRIC_CHOICES,
  type ApiKeySummaryRow,
  type AuditSummary,
  type BudgetSummary,
  type BuildPack,
  type DeploymentRequestSummary,
  type DeploymentLogsSummary,
  type DeploymentSummary,
  type PromoteDeploymentSummary,
  type DistributePolicySummary,
  type DomainChallengeSummary,
  type DomainSummary,
  type DomainVerificationSummary,
  type GitLinkSummary,
  type EnvVarSummary,
  type SetEnvVarOutcome,
  type ConnectedGitLinkSummary,
  type IssuedApiKey,
  type OrganizationSummary,
  type OrganizationMemberSummary,
  type ProjectSummary,
  type ProviderHealthRow,
  type SecurityPolicyEventSummary,
  type SecurityEventSummary,
  type SecurityIncidentSummary,
  type SecurityRuleSummary,
  type TrustedSourceSummary,
  type RateLimitSummary,
  type ObservabilityReportSummary,
  type OrchestrationJobSummary,
  type SecurityPolicySummary,
  type UsageTotalSummary,
  type VerifiedBotSummary,
} from "../view-model.js";
import {
  ApiKeyStateBadge,
  Link,
  Timestamp,
  VerifiedBadge,
  VisitLink,
} from "../components/page-parts.js";

/* ------------------------------------------------------------------ cards */

function DeploymentColumns(): readonly Column<DeploymentSummary>[] {
  return [
    {
      key: "status",
      header: "Status",
      render: (item) => {
        const presentation = presentDeploymentStatus(item.status);
        // A succeeded deployment that is also the one the domains serve carries
        // a "Live" marker: Vercel's whole model is immutable builds plus a
        // pointer, and this is where that pointer is legible.
        return (
          <div className="row" style={{ alignItems: "center" }}>
            <StatusBadge label={presentation.label} tone={presentation.tone} />
            {item.isCurrent ? <StatusBadge label="Live" tone="positive" /> : null}
          </div>
        );
      },
    },
    {
      key: "kind",
      header: "Type",
      render: (item) =>
        item.kind === "preview" ? (
          <StatusBadge
            label={item.pullRequest ? `Preview · PR #${String(item.pullRequest)}` : "Preview"}
            tone="neutral"
          />
        ) : (
          <StatusBadge label="Production" tone="neutral" />
        ),
    },
    {
      key: "id",
      header: "Deployment",
      render: (item) => <span className="mono small">{item.id.slice(0, 12)}</span>,
    },
    {
      key: "branch",
      header: "Branch",
      render: (item) =>
        item.gitBranch ? (
          <span className="mono small">{item.gitBranch}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: "url",
      header: "URL",
      render: (item) =>
        item.url ? (
          <span className="mono small truncate" style={{ display: "inline-block", maxWidth: 320 }}>
            <VisitLink url={item.url} label={item.url} />
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: "reason",
      header: "Detail",
      render: (item) =>
        item.failureReason ? (
          <span className="small">{item.failureReason}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];
}

/* ------------------------------------------------------------ organizations */

export function OrganizationsPage({
  createRequest = 0,
  onCreateRequestHandled,
}: {
  /** Non-zero when the shell asked for the create form; consumed then reset. */
  readonly createRequest?: number;
  readonly onCreateRequestHandled?: () => void;
}) {
  const { client, router } = useApp();
  const { section, reload } = useSection(
    () => loadOrganizations(client),
    [client],
    "Organizations",
  );
  const [creating, setCreating] = useState(false);

  // A request from the sidebar or the palette opens the form here, so "New
  // workspace" creates rather than merely landing on the list. The request is
  // consumed as it is acted on, so a later remount of this page does not reopen
  // a form the operator already dismissed.
  useEffect(() => {
    if (createRequest > 0) {
      setCreating(true);
      onCreateRequestHandled?.();
    }
  }, [createRequest, onCreateRequestHandled]);

  return (
    <PageShell
      title="Organizations"
      subtitle="A workspace is the tenant boundary. Everything you deploy belongs to one."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New organization
        </Button>
      }
    >
      <SectionView<OrganizationSummary>
        section={section}
        onRetry={reload}
        emptyMessage="You are not a member of any organization yet. Create one to begin."
        renderReady={(items) => (
          <div className="grid">
            {items.map((organization) => (
              <Card
                key={organization.id}
                title={organization.name}
                actions={
                  <Link to={{ name: "projects", organizationId: organization.id }}>Open →</Link>
                }
              >
                <dl className="dl">
                  <dt>Slug</dt>
                  <dd className="mono">{organization.slug}</dd>
                  <dt>Id</dt>
                  <dd className="mono small">{organization.id}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )}
      />

      <NewOrganizationModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(organizationId) => {
          setCreating(false);
          router.navigate({ name: "projects", organizationId });
        }}
      />
    </PageShell>
  );
}

function NewOrganizationModal({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (organizationId: string) => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<OrganizationSummary>("organizations.create", { name, slug });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The organization could not be created.");
      return;
    }
    setName("");
    setSlug("");
    onCreated(response.data.id);
  };

  return (
    <Modal
      title="New organization"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            busy={busy}
            disabled={!name || !slug}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" hint="Shown throughout the console.">
          {(id) => <TextInput id={id} value={name} onChange={setName} placeholder="Acme Inc." />}
        </Field>
        <Field
          label="Slug"
          hint="Lowercase letters, digits and hyphens. Used in URLs."
          {...(error ? { error } : {})}
        >
          {(id) => (
            <TextInput
              id={id}
              value={slug}
              onChange={(value) => setSlug(value.toLowerCase())}
              placeholder="acme"
              error={Boolean(error)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ projects */

export function ProjectsPage({ organizationId }: { readonly organizationId: string }) {
  const { client, router } = useApp();
  const { section, reload } = useSection(
    () => loadProjects(client, organizationId),
    [client, organizationId],
    "Projects",
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [executionModel, setExecutionModel] = useState<"container" | "serverless">("container");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<ProjectSummary>("projects.create", {
      organizationId,
      name,
      slug,
      executionModel,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The project could not be created.");
      return;
    }
    setCreating(false);
    setName("");
    setSlug("");
    setExecutionModel("container");
    router.navigate({ name: "project", organizationId, projectId: response.data.id });
  };

  return (
    <PageShell
      title="Projects"
      subtitle="An application you deploy, with its own deployments, domains, data and security policy."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    >
      <SectionView<ProjectSummary>
        section={section}
        onRetry={reload}
        emptyMessage="No projects yet. Create one to deploy your first application."
        emptyActions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            Create your first project
          </Button>
        }
        renderReady={(items) => (
          <div className="grid">
            {items.map((project) => (
              <Card
                key={project.id}
                title={project.name}
                actions={
                  <Link to={{ name: "project", organizationId, projectId: project.id }}>
                    Open →
                  </Link>
                }
              >
                <dl className="dl">
                  <dt>Slug</dt>
                  <dd className="mono">{project.slug}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )}
      />

      <Modal
        title="New project"
        open={creating}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              busy={busy}
              disabled={!name || !slug}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Name">
            {(id) => <TextInput id={id} value={name} onChange={setName} placeholder="Web app" />}
          </Field>
          <Field
            label="Slug"
            hint="Lowercase letters, digits and hyphens."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={slug}
                onChange={(value) => setSlug(value.toLowerCase())}
                placeholder="web-app"
                error={Boolean(error)}
              />
            )}
          </Field>
          <Field
            label="Execution model"
            hint="How this project's workload runs. Container builds from git and keeps a long-lived server; serverless runs on demand. This can be changed later in project settings."
          >
            {() => (
              <ChoiceGroup<"container" | "serverless">
                name="execution-model"
                value={executionModel}
                onChange={setExecutionModel}
                options={[
                  {
                    value: "container",
                    label: "Container",
                    hint: "A long-lived application built from your git repository.",
                  },
                  {
                    value: "serverless",
                    label: "Serverless",
                    hint: "Runs on demand from a published build; scales to zero.",
                  },
                ]}
              />
            )}
          </Field>
        </div>
      </Modal>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ project */

export function ProjectOverviewPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const project = useSection(() => loadProject(client, projectId), [client, projectId], "Project");
  const deployments = useSection(
    () => loadDeployments(client, projectId),
    [client, projectId],
    "Deployments",
  );
  const audit = useSection(
    () => loadAudit(client, organizationId),
    [client, organizationId],
    "Recent activity",
  );

  const projectItem =
    project.section.state.kind === "ready" ? project.section.state.items[0] : undefined;
  const deploymentItems =
    deployments.section.state.kind === "ready" ? deployments.section.state.items : [];
  const live = deploymentItems.filter((item) => item.status === "succeeded").length;
  const unconfigured = deploymentItems.filter((item) => item.status === "not_configured").length;
  const model = projectItem?.executionModel;
  // The address the project's domains currently serve: the one deployment marked
  // current that also has a URL. Vercel puts this at the top of the project, and
  // it is the answer to "where is my site", so it belongs in the header rather
  // than only in the table below.
  const liveUrl = deploymentItems.find((item) => item.isCurrent && item.url)?.url ?? null;

  return (
    <PageShell
      title={projectItem?.name ?? "Project"}
      subtitle={
        projectItem
          ? `Slug ${projectItem.slug} · ${model === "serverless" ? "Serverless" : "Container"} execution`
          : undefined
      }
      actions={
        <div className="row">
          {liveUrl ? (
            <Button
              variant="primary"
              onClick={() => window.open(liveUrl, "_blank", "noopener,noreferrer")}
            >
              Visit site
            </Button>
          ) : null}
          <Link to={{ name: "deployments", organizationId, projectId }}>Deployments →</Link>
        </div>
      }
      breadcrumb={
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to={{ name: "projects", organizationId }}>Projects</Link>
          <span className="breadcrumb__sep">/</span>
          <span aria-current="page">{projectItem?.name ?? projectId.slice(0, 8)}</span>
        </nav>
      }
    >
      {project.section.state.kind === "error" || project.section.state.kind === "degraded" ? (
        <SectionView<ProjectSummary> section={project.section} onRetry={project.reload} />
      ) : null}

      {liveUrl ? (
        <p className="small muted" style={{ marginBottom: "var(--space-4)" }}>
          Serving at <VisitLink url={liveUrl} label={liveUrl.replace(/^https?:\/\//, "")} />
        </p>
      ) : deployments.section.state.kind === "ready" && deploymentItems.length > 0 ? (
        <p className="small muted" style={{ marginBottom: "var(--space-4)" }}>
          No deployment is live yet. Promote a succeeded build on the Deployments page, or connect a
          domain, to give this project an address.
        </p>
      ) : null}

      <div className="grid grid--stats" style={{ marginBottom: "var(--space-6)" }}>
        <StatBox
          label="Deployments"
          value={deployments.section.state.kind === "loading" ? "…" : deploymentItems.length}
          note="Total recorded for this project"
        />
        <StatBox label="Live" value={live} note="Reported succeeded by the engine" />
        <StatBox
          label="Not configured"
          value={unconfigured}
          note="Requested, but no hosting engine is wired"
        />
      </div>

      <SectionShell title="Deployments" hint="Newest first">
        <Card flush>
          <SectionView<DeploymentSummary>
            section={deployments.section}
            columns={DeploymentColumns()}
            rowKey={(item) => item.id}
            onRetry={deployments.reload}
            emptyMessage="Nothing has been deployed yet."
          />
        </Card>
      </SectionShell>

      <SectionShell title="Recent activity">
        <Card flush>
          <SectionView<AuditSummary>
            section={audit.section}
            onRetry={audit.reload}
            emptyMessage="No recorded activity for this organization yet."
            renderReady={(items) => (
              <Table
                items={items.slice(0, 8)}
                rowKey={(item) => item.id}
                columns={[
                  {
                    key: "event",
                    header: "Event",
                    render: (item) => <span className="mono small">{item.event}</span>,
                  },
                  { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                  {
                    key: "when",
                    header: "When",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>
    </PageShell>
  );
}

/**
 * A project's settings page.
 *
 * Distinct from the workspace Settings page: this one edits the project the
 * caller is currently inside. Renaming goes through `projects.update`, which
 * resolves the organization from the row (not the request) before it guards.
 * Engine-owned fields are not shown as editable because they are not — the
 * adapter writes them.
 */
export function ProjectSettingsPage({
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadProject(client, projectId),
    [client, projectId],
    "Project",
  );

  const project = section.state.kind === "ready" ? section.state.items[0] : undefined;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [executionModel, setExecutionModel] = useState<"container" | "serverless">("container");
  const [rootDirectory, setRootDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Seed once per project. Keying on the id (rather than priming on empty
  // strings) means a keystroke after a save is never overwritten by a reload.
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (project && seededFor.current !== project.id) {
      seededFor.current = project.id;
      setName(project.name);
      setSlug(project.slug);
      setExecutionModel(project.executionModel);
      setRootDirectory(project.rootDirectory ?? "");
    }
  }, [project]);

  const dirty =
    Boolean(project) &&
    (name !== project!.name ||
      slug !== project!.slug ||
      executionModel !== project!.executionModel ||
      rootDirectory.trim().replace(/^\.\/+/, "").replace(/\/+$/, "") !==
        (project!.rootDirectory ?? ""));

  // The slug names the engine application once one exists, and the engine has no
  // rename the API is allowed to call — `projects.update` refuses the change. The
  // field is disabled and the hint says why, so the control cannot promise
  // something the server will reject.
  const slugLocked = project?.providerResourceId != null;

  // The root directory is written into the application as `base_directory` when
  // it is created, and Coolify cannot re-target it — the API refuses the change
  // for the same reason it refuses a slug change. The field locks with the slug.
  const rootLocked = project?.providerResourceId != null;

  const submit = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    const trimmedRoot = rootDirectory.trim();
    const result = await updateProject(client, {
      projectId,
      name,
      slug,
      executionModel,
      // Only send it when it changed, so a locked project's save does not carry
      // a field the server would refuse.
      ...(rootLocked || trimmedRoot === (project.rootDirectory ?? "")
        ? {}
        : { rootDirectory: trimmedRoot === "" ? null : trimmedRoot }),
    });
    setBusy(false);
    if (result.state.kind !== "ready" || !result.state.items[0]) {
      setError(
        result.state.kind === "error" ? result.state.message : "The project could not be updated.",
      );
      return;
    }
    setSaved(true);
    reload();
  };

  return (
    <PageShell
      title="Settings"
      subtitle="Rename this project. Engine-owned fields are written by the adapters, not here."
    >
      <SectionShell title="Project">
        <Card>
          <div className="stack">
            <Field label="Name" {...(error ? { error } : {})}>
              {(id) => (
                <TextInput
                  id={id}
                  value={name}
                  onChange={(value) => {
                    setSaved(false);
                    setName(value);
                  }}
                  placeholder="Web app"
                />
              )}
            </Field>
            <Field
              label="Slug"
              hint={
                slugLocked
                  ? "This slug names the application on the hosting engine, and the engine cannot rename it. It can only change before the first deployment creates the application — rename the project's name instead."
                  : "Lowercase letters, digits and hyphens. Used in URLs."
              }
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={slug}
                  disabled={slugLocked}
                  onChange={(value) => {
                    setSaved(false);
                    setSlug(value.toLowerCase());
                  }}
                  placeholder="web-app"
                />
              )}
            </Field>
            <Field
              label="Execution model"
              hint="Which engine runs this project. Changing it takes effect on the next deployment."
            >
              {() => (
                <ChoiceGroup<"container" | "serverless">
                  name="project-execution-model"
                  value={executionModel}
                  onChange={(value) => {
                    setSaved(false);
                    setExecutionModel(value);
                  }}
                  options={[
                    {
                      value: "container",
                      label: "Container",
                      hint: "A long-lived application built from your git repository.",
                    },
                    {
                      value: "serverless",
                      label: "Serverless",
                      hint: "Runs on demand from a published build; scales to zero.",
                    },
                  ]}
                />
              )}
            </Field>
            <Field
              label="Root directory"
              hint={
                rootLocked
                  ? "This project's root directory is set on the hosting engine when the application is created, and the engine cannot re-target it. It can only change before the first deployment."
                  : "Optional. For a monorepo, the subdirectory that holds this app's code — the engine runs its build there. Leave empty to build from the repository root."
              }
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={rootDirectory}
                  disabled={rootLocked}
                  onChange={(value) => {
                    setSaved(false);
                    setRootDirectory(value);
                  }}
                  placeholder="apps/web"
                />
              )}
            </Field>
            <dl className="dl">
              <dt>Project ID</dt>
              <dd className="mono">{projectId}</dd>
            </dl>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {saved ? <span className="muted small">Saved.</span> : null}
              <Button
                variant="primary"
                onClick={() => void submit()}
                busy={busy}
                disabled={!dirty || !name || !slug}
              >
                Save changes
              </Button>
            </div>
          </div>
        </Card>
      </SectionShell>
    </PageShell>
  );
}

export function DeploymentsPage({
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDeployments(client, projectId),
    [client, projectId],
    "Deployments",
  );
  const [deploying, setDeploying] = useState(false);
  const [rollingBack, setRollingBack] = useState<DeploymentSummary | null>(null);
  const [viewingLogs, setViewingLogs] = useState<DeploymentSummary | null>(null);
  const [cancelling, setCancelling] = useState<DeploymentSummary | null>(null);
  const [promoting, setPromoting] = useState<DeploymentSummary | null>(null);
  const [redeploying, setRedeploying] = useState<DeploymentSummary | null>(null);

  return (
    <PageShell
      title="Deployments"
      subtitle="Every deployment this project has requested, newest first. A status is the hosting engine's, never the request's. The Live badge marks the immutable build the domains currently serve."
      actions={
        <Button variant="primary" onClick={() => setDeploying(true)}>
          New deployment
        </Button>
      }
    >
      <Card flush>
        <SectionView<DeploymentSummary>
          section={section}
          columns={[
            ...DeploymentColumns(),
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div className="row">
                  {item.url ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => window.open(item.url!, "_blank", "noopener,noreferrer")}
                    >
                      Visit
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setViewingLogs(item)}>
                    Logs
                  </Button>
                  {item.status === "succeeded" && item.kind === "production" && !item.isCurrent ? (
                    <Button variant="ghost" size="sm" onClick={() => setPromoting(item)}>
                      Promote
                    </Button>
                  ) : null}
                  {item.status === "succeeded" ? (
                    <Button variant="ghost" size="sm" onClick={() => setRollingBack(item)}>
                      Rollback
                    </Button>
                  ) : null}
                  {item.gitRepository ? (
                    <Button variant="ghost" size="sm" onClick={() => setRedeploying(item)}>
                      Redeploy
                    </Button>
                  ) : null}
                  {item.status === "pending" || item.status === "running" ? (
                    <Button variant="ghost" size="sm" onClick={() => setCancelling(item)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="Nothing has been deployed yet."
          filterText={(item) =>
            `${item.status} ${item.kind} ${item.gitBranch ?? ""} ${item.url ?? ""} ${item.id}`
          }
          filterLabel="Filter deployments"
        />
      </Card>

      <NewDeploymentModal
        // Remount per open so the idempotency key is fresh for a new request
        // but stays put for a retry within the same open form.
        key={`deploy-${String(deploying)}`}
        projectId={projectId}
        open={deploying}
        onClose={() => setDeploying(false)}
        onRequested={() => {
          setDeploying(false);
          reload();
        }}
      />

      <RollbackDeploymentModal
        key={`rollback-${rollingBack?.id ?? "none"}`}
        projectId={projectId}
        deployment={rollingBack}
        onClose={() => setRollingBack(null)}
        onRolledBack={() => {
          setRollingBack(null);
          reload();
        }}
      />

      <DeploymentLogsDrawer
        key={`logs-${viewingLogs?.id ?? "none"}`}
        projectId={projectId}
        deployment={viewingLogs}
        onClose={() => setViewingLogs(null)}
      />

      <CancelDeploymentModal
        key={`cancel-${cancelling?.id ?? "none"}`}
        projectId={projectId}
        deployment={cancelling}
        onClose={() => setCancelling(null)}
        onCancelled={() => {
          setCancelling(null);
          reload();
        }}
      />

      <PromoteDeploymentModal
        key={`promote-${promoting?.id ?? "none"}`}
        projectId={projectId}
        deployment={promoting}
        onClose={() => setPromoting(null)}
        onPromoted={() => {
          setPromoting(null);
          reload();
        }}
      />

      <RedeployDeploymentModal
        // Remount per open, as the deploy form does: the idempotency key must be
        // fresh for a new redeploy but stable for a retry within one open dialog.
        key={`redeploy-${redeploying?.id ?? "none"}`}
        projectId={projectId}
        deployment={redeploying}
        onClose={() => setRedeploying(null)}
        onRedeployed={() => {
          setRedeploying(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * Rebuild a past deployment's source.
 *
 * Vercel's "Redeploy": the same repository and branch are built again, so the
 * engine builds the branch's current head rather than re-shipping the original
 * artifact. The dialog says that, and points to Rollback for the other intent,
 * because the two are easy to confuse and mean different things.
 */
function RedeployDeploymentModal({
  projectId,
  deployment,
  onClose,
  onRedeployed,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
  readonly onRedeployed: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newRequestId);

  const submit = async () => {
    if (!deployment) return;
    setBusy(true);
    setError(null);
    const response = await client.call<DeploymentRequestSummary>("deployments.redeploy", {
      projectId,
      deploymentId: deployment.id,
      idempotencyKey,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The redeploy could not be requested.");
      return;
    }
    onRedeployed();
  };

  return (
    <Modal
      title="Redeploy"
      open={deployment !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Redeploy
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          This builds the recorded source again, so it picks up the branch&apos;s latest commit.
          To return to the exact artifact this row built, use Rollback instead.
        </p>
        {deployment ? (
          <dl className="dl">
            <div>
              <dt>Repository</dt>
              <dd>{deployment.gitRepository ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{deployment.gitBranch ?? "Default branch"}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{deployment.kind === "preview" ? "Preview" : "Production"}</dd>
            </div>
          </dl>
        ) : null}
        {error ? <p className="small error">{error}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * Promote a build to production, or roll the pointer back to it.
 *
 * Vercel's "Promote" and its "Instant rollback" are the same operation: point
 * production at a build that already succeeded. Nothing is rebuilt, so the
 * dialog says that plainly. The server is the one that decides whether the move
 * is allowed (a preview or an un-succeeded build is refused), and its refusal is
 * shown verbatim rather than retried into a success.
 */
function PromoteDeploymentModal({
  projectId,
  deployment,
  onClose,
  onPromoted,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
  readonly onPromoted: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!deployment) return;
    setBusy(true);
    setError(null);
    const response = await client.call<PromoteDeploymentSummary>("deployments.promote", {
      projectId,
      deploymentId: deployment.id,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The deployment could not be promoted.");
      return;
    }
    onPromoted();
  };

  return (
    <Modal
      title="Promote to production"
      open={deployment !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Promote
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          This points the project&apos;s domains at this build. Nothing is rebuilt, so what goes
          live is exactly the artifact that was already verified.
        </p>
        {deployment ? (
          <dl className="dl">
            <dt>Deployment</dt>
            <dd className="mono small">{deployment.id}</dd>
            {deployment.gitBranch ? (
              <>
                <dt>Branch</dt>
                <dd className="mono small">{deployment.gitBranch}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Show a deployment's engine logs.
 *
 * The lines come from the hosting engine through `deployments.logs`. When the
 * engine is not configured, or the project was never deployed, the drawer says
 * so in the engine's own words instead of showing an empty or fabricated log.
 */
function DeploymentLogsDrawer({
  projectId,
  deployment,
  onClose,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
}) {
  const { client } = useApp();
  // A local, data-carrying state: the drawer needs the fetched summary back out
  // of the success arm, which the shapes-only `ViewState` does not carry.
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "degraded"; readonly reason: string }
    | { readonly kind: "success"; readonly data: DeploymentLogsSummary }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    if (!deployment) return;
    setState({ kind: "loading" });
    const logs = await loadDeploymentLogs(client, projectId, deployment.id);
    if (logs.engineReason && logs.lines.length === 0) {
      setState({ kind: "degraded", reason: logs.engineReason });
      return;
    }
    setState({ kind: "success", data: logs });
  }, [client, projectId, deployment]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Drawer
      title={deployment ? `Logs — ${deployment.id.slice(0, 8)}` : "Logs"}
      open={deployment !== null}
      onClose={onClose}
    >
      {state.kind === "loading" ? <LoadingSkeleton title="Logs" rows={5} /> : null}
      {state.kind === "degraded" ? (
        <DegradedState title="Deployment logs" reason={state.reason} />
      ) : null}
      {state.kind === "success" && state.data ? (
        <>
          <p className="small muted">
            {state.data.source === "deployment"
              ? "This is the build and deploy log for this run, as the hosting engine recorded it."
              : state.data.source === "application"
                ? "This is the running application's log tail. This deployment has no build log recorded from the engine, so the container's output is shown instead."
                : "The hosting engine returned no log source for this deployment."}
          </p>
          {state.data.cursor === null ? (
            <p className="small muted">
              The hosting engine keeps no cursor for logs, so this is the full tail it returned.
            </p>
          ) : null}
          {state.data.lines.length === 0 ? (
            <EmptyState
              title="No output yet"
              message="The engine returned no log lines for this deployment."
            />
          ) : (
            <pre className="log" aria-label="Deployment logs">
              {state.data.lines.join("\n")}
            </pre>
          )}
        </>
      ) : null}
      {state.kind === "error" ? (
        <ErrorState title="Deployment logs" message={state.message} onRetry={() => void load()} />
      ) : null}
    </Drawer>
  );
}

/**
 * Request a deployment.
 *
 * The branch and repository are optional because the engine may already hold
 * them; whatever is submitted is validated on the server. The result is shown
 * with the engine's own words, so a deployment with no hosting credentials reads
 * as "not configured" rather than as a failure the operator caused.
 */
function NewDeploymentModal({
  projectId,
  open,
  onClose,
  onRequested,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRequested: () => void;
}) {
  const { client } = useApp();
  const [gitRepository, setGitRepository] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [commit, setCommit] = useState("");
  // Empty means "let the engine decide": the server omits the field rather than
  // sending a default, so a project that pins its own build pack keeps it.
  const [buildPack, setBuildPack] = useState<"" | BuildPack>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeploymentRequestSummary | null>(null);
  // One key per open form: pressing "Deploy" twice, or after a failure, replays
  // the same request instead of queuing a second deployment.
  const [idempotencyKey] = useState(newRequestId);

  // A connected repository is the obvious default, so the operator does not
  // retype what the project already holds. It only pre-fills the fields the
  // operator has not touched, and a load failure leaves them empty rather than
  // blocking the form: the engine may still hold a source of its own.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!open || prefilled) return;
    let cancelled = false;
    void (async () => {
      const source = await loadGitDeploySource(client, projectId);
      if (cancelled || source.state.kind !== "ready") return;
      const item = source.state.items[0];
      if (!item) return;
      setGitRepository((current) => (current === "" ? item.repository : current));
      setGitBranch((current) => (current === "" ? item.branch : current));
      setPrefilled(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, open, prefilled]);

  const reset = () => {
    setGitRepository("");
    setGitBranch("");
    setCommit("");
    setBuildPack("");
    setError(null);
    setResult(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DeploymentRequestSummary>("deployments.create", {
      projectId,
      idempotencyKey,
      ...(gitRepository ? { gitRepository } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(commit ? { commit } : {}),
      ...(buildPack ? { buildPack } : {}),
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The deployment could not be requested.");
      return;
    }
    setResult(response.data);
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal
      title={result ? "Deployment requested" : "New deployment"}
      open={open}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onRequested}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Deploy
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <dl className="dl">
            <dt>Status</dt>
            <dd>
              <StatusBadge
                label={presentDeploymentStatus(result.deployment.status).label}
                tone={presentDeploymentStatus(result.deployment.status).tone}
              />
            </dd>
            <dt>Deployment</dt>
            <dd className="mono small">{result.deployment.id}</dd>
            {result.deployment.url ? (
              <>
                <dt>URL</dt>
                <dd className="mono small">
                  <VisitLink url={result.deployment.url} />
                  <span className="faint"> · </span>
                  {result.deployment.url}
                </dd>
              </>
            ) : (
              <>
                <dt>URL</dt>
                <dd className="small muted">
                  No URL was issued. Connect a domain on the Domains page, or check the engine's
                  state — a deployment that did not run has no address to visit.
                </dd>
              </>
            )}
          </dl>
          {result.engineReason ? (
            <p className="small muted" role="status">
              The hosting engine did not act: {result.engineReason}
            </p>
          ) : null}
          {result.replayed ? (
            <p className="small muted">
              This request matched an earlier deployment, so nothing new was queued.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            Leave a field blank to use what the engine already holds for this project.
          </p>
          <Field label="Repository" hint="https:// or git@ clone URL.">
            {(id) => (
              <TextInput
                id={id}
                value={gitRepository}
                onChange={setGitRepository}
                placeholder="https://github.com/acme/web-app.git"
              />
            )}
          </Field>
          <Field label="Branch">
            {(id) => (
              <TextInput id={id} value={gitBranch} onChange={setGitBranch} placeholder="main" />
            )}
          </Field>
          <Field label="Commit" hint="Optional; a specific revision to deploy.">
            {(id) => (
              <TextInput id={id} value={commit} onChange={setCommit} placeholder="abc1234" />
            )}
          </Field>
          <Field
            label="Build pack"
            hint="Optional. Leave as the engine's choice unless a build fails to detect the framework — this is the override for that case."
          >
            {() => (
              <ChoiceGroup<"" | BuildPack>
                name="build-pack"
                value={buildPack}
                onChange={setBuildPack}
                options={[
                  {
                    value: "",
                    label: "Engine's choice",
                    hint: "The hosting engine detects the build pack from the source.",
                  },
                  {
                    value: "nixpacks",
                    label: "Nixpacks",
                    hint: "Language auto-detection from the repository's own files.",
                  },
                  {
                    value: "railpack",
                    label: "Railpack",
                    hint: "The build engine this platform ships, for a detected framework.",
                  },
                  {
                    value: "static",
                    label: "Static",
                    hint: "No server build: the output directory is served as-is.",
                  },
                  {
                    value: "dockerfile",
                    label: "Dockerfile",
                    hint: "Build from the repository's own Dockerfile.",
                  },
                  {
                    value: "dockercompose",
                    label: "Docker Compose",
                    hint: "Build and run from the repository's compose file.",
                  },
                ]}
              />
            )}
          </Field>
          {error ? (
            <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/**
 * Roll a project back.
 *
 * Coolify refuses a rollback without the git ref to return to, so the commit is
 * required here too — the dialog asks for it rather than sending a request the
 * engine will reject.
 */
function RollbackDeploymentModal({
  projectId,
  deployment,
  onClose,
  onRolledBack,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
  readonly onRolledBack: () => void;
}) {
  const { client } = useApp();
  const [commit, setCommit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same reasoning as a deployment: a second press must not queue a second
  // rollback of the same commit.
  const [idempotencyKey] = useState(newRequestId);

  const submit = async () => {
    if (!deployment) return;
    setBusy(true);
    setError(null);
    const response = await client.call<DeploymentRequestSummary>("deployments.rollback", {
      projectId,
      commit,
      idempotencyKey,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The rollback could not be requested.");
      return;
    }
    setCommit("");
    onRolledBack();
  };

  return (
    <Modal
      title="Roll back"
      open={deployment !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            busy={busy}
            disabled={commit.trim() === ""}
          >
            Roll back
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Rolling back records a new deployment at an earlier revision. The deployment you are
          undoing is kept in the history.
        </p>
        <Field label="Commit" hint="The git revision to return to." {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={commit}
              onChange={setCommit}
              placeholder="abc1234"
              error={Boolean(error)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Cancel an in-flight deployment.
 *
 * The button appears only for a pending or running row, because a terminal
 * deployment has nothing to cancel and the server refuses it too. The result is
 * the row the server wrote back — a cancelled run reads `failed` with the
 * engine's reason, never a fabricated success.
 */
function CancelDeploymentModal({
  projectId,
  deployment,
  onClose,
  onCancelled,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
  readonly onCancelled: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!deployment) return;
    setBusy(true);
    setError(null);
    const response = await client.call<{
      deployment: DeploymentSummary;
      engineReason: string | null;
    }>("deployments.cancel", { projectId, deploymentId: deployment.id });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The deployment could not be cancelled.");
      return;
    }
    onCancelled();
  };

  return (
    <Modal
      title="Cancel deployment"
      open={deployment !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep running</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            Cancel deployment
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          This asks the hosting engine to stop the build. The deployment is kept in the history and
          is marked failed, because the work did not complete.
        </p>
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ domains */

export function DomainsPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId?: string | undefined;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDomains(client, organizationId, projectId),
    [client, organizationId, projectId],
    "Domains",
  );

  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<DomainSummary | null>(null);
  const [removing, setRemoving] = useState<DomainSummary | null>(null);

  return (
    <PageShell
      title="Domains"
      subtitle="Hostnames routed through the security edge. Only the edge can verify a hostname."
      actions={
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add domain
        </Button>
      }
    >
      <Card flush>
        <SectionView<DomainSummary>
          section={section}
          columns={[
            {
              key: "hostname",
              header: "Hostname",
              render: (item) => <span className="mono">{item.hostname}</span>,
            },
            {
              key: "verified",
              header: "State",
              render: (item) => <VerifiedBadge verified={item.verified} />,
            },
            {
              key: "verifiedAt",
              header: "Last verified",
              render: (item) =>
                item.verifiedAt ? (
                  <Timestamp value={item.verifiedAt} />
                ) : (
                  <span className="muted">Never</span>
                ),
            },
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button size="sm" onClick={() => setVerifying(item)}>
                    Verify
                  </Button>
                  <Button size="sm" onClick={() => setRemoving(item)}>
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No domains registered. A domain is created unverified and the edge confirms it."
          filterText={(item) => `${item.hostname} ${item.verified ? "verified" : "unverified"}`}
          filterLabel="Filter domains"
        />
      </Card>

      <AddDomainModal
        organizationId={organizationId}
        projectId={projectId}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          reload();
        }}
      />

      <VerifyDomainModal
        organizationId={organizationId}
        domain={verifying}
        onClose={() => setVerifying(null)}
        onVerified={() => {
          setVerifying(null);
          reload();
        }}
      />

      <RemoveDomainModal
        organizationId={organizationId}
        domain={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * Add a hostname.
 *
 * The server creates it unverified and answers with the DNS challenge to
 * publish; this dialog shows that record rather than claiming the domain is
 * live. The final state is the verifier's to decide, not this form's.
 */
function AddDomainModal({
  organizationId,
  projectId,
  open,
  onClose,
  onAdded,
}: {
  readonly organizationId: string;
  readonly projectId?: string | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { client } = useApp();
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<DomainChallengeSummary | null>(null);

  const close = () => {
    setHostname("");
    setError(null);
    setChallenge(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DomainChallengeSummary>("domains.create", {
      organizationId,
      hostname,
      ...(projectId ? { projectId } : {}),
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The domain could not be added.");
      return;
    }
    setChallenge(response.data);
  };

  return (
    <Modal
      title={challenge ? "Publish this DNS record" : "Add domain"}
      open={open}
      onClose={close}
      footer={
        challenge ? (
          <Button variant="primary" onClick={onAdded}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Add
            </Button>
          </>
        )
      }
    >
      {challenge ? (
        <div className="stack">
          <p>
            The domain is registered but not yet verified. Publish this record, then use Verify.
          </p>
          <dl className="dl">
            <dt>Type</dt>
            <dd className="mono">{challenge.recordType}</dd>
            <dt>Name</dt>
            <dd className="mono">{challenge.recordName}</dd>
            <dt>Value</dt>
            <dd className="mono">{challenge.recordValue}</dd>
          </dl>
        </div>
      ) : (
        <div className="stack">
          <Field
            label="Hostname"
            hint="A hostname you control, e.g. app.example.com."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={hostname}
                onChange={setHostname}
                placeholder="app.example.com"
                error={Boolean(error)}
                autoFocus
              />
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

/**
 * Verify a hostname.
 *
 * The request asks the verifier to look; the answer is the verifier's. A
 * refusal is shown as its own detail, not as a failure the operator caused.
 */
function VerifyDomainModal({
  organizationId,
  domain,
  onClose,
  onVerified,
}: {
  readonly organizationId: string;
  readonly domain: DomainSummary | null;
  readonly onClose: () => void;
  readonly onVerified: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DomainVerificationSummary | null>(null);

  if (!domain) return null;

  const close = () => {
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DomainVerificationSummary>("domains.verify", {
      organizationId,
      domainId: domain.id,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The domain could not be verified.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title="Verify domain"
      open={domain !== null}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onVerified}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Verify
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p className="mono">{domain.hostname}</p>
        {result ? (
          <>
            <VerifiedBadge verified={result.domain.verified} />
            <p>{result.detail}</p>
          </>
        ) : (
          <p>The edge will look for the challenge record you published.</p>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** Remove a hostname. */
function RemoveDomainModal({
  organizationId,
  domain,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly domain: DomainSummary | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!domain) return null;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<{ removed: boolean }>("domains.remove", {
      organizationId,
      domainId: domain.id,
    });
    setBusy(false);
    if (!response.ok || !response.data?.removed) {
      setError(response.error?.message ?? "The domain could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Remove domain"
      open={domain !== null}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <span className="mono">{domain.hostname}</span>? Traffic to it will stop being
          routed.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ git */

const GIT_PROVIDERS = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "generic", label: "Other (HMAC)" },
] as const;

/**
 * The header a provider puts its signature in.
 *
 * The server reads all of these and picks whichever the provider sent, so the
 * page only needs to tell the operator *where* to paste the secret. Naming the
 * real header is the difference between "configure a webhook" and an action.
 */
function webhookHeader(provider: GitLinkSummary["provider"]): string {
  switch (provider) {
    case "github":
      return "X-Hub-Signature-256";
    case "gitlab":
      return "X-Gitlab-Token";
    case "bitbucket":
      return "X-Hub-Signature";
    case "generic":
      return "X-Cloud-Wai-Signature";
  }
}

/**
 * Repositories that deploy this project.
 *
 * A link is inert until the operator pastes the secret into the provider, so the
 * connect dialog shows the delivery URL and the header to set — the same
 * "shown once" shape as an API key, because the secret is the same kind of
 * thing. `git.links.list` never returns it again.
 */
export function GitPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadGitLinks(client, projectId),
    [client, projectId],
    "Repositories",
  );

  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<GitLinkSummary | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeploymentRequestSummary | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployKey] = useState(newRequestId);

  const hasLink = section.state.kind === "ready" && section.state.items.length > 0;

  const deployNow = async () => {
    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);
    const response = await deployFromLink(client, projectId, deployKey);
    setDeploying(false);
    if (!response.ok || !response.data) {
      setDeployError(response.error?.message ?? "The deployment could not be requested.");
      return;
    }
    setDeployResult(response.data);
  };

  return (
    <PageShell
      title="Git"
      subtitle="Connect a repository and a push deploys this project. A non-production branch is a preview."
      actions={
        <>
          {hasLink ? (
            <Button onClick={() => void deployNow()} busy={deploying}>
              Deploy now
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => setConnecting(true)}>
            Connect repository
          </Button>
        </>
      }
    >
      <Card flush>
        <SectionView<GitLinkSummary>
          section={section}
          columns={[
            {
              key: "repository",
              header: "Repository",
              render: (item) => <span className="mono">{item.repository}</span>,
            },
            { key: "provider", header: "Provider", render: (item) => providerLabel(item.provider) },
            {
              key: "productionBranch",
              header: "Production branch",
              render: (item) => <span className="mono">{item.productionBranch}</span>,
            },
            {
              key: "previews",
              header: "Previews",
              render: (item) => (
                <StatusBadge
                  label={item.previewsEnabled ? "On" : "Off"}
                  tone={item.previewsEnabled ? "positive" : "neutral"}
                />
              ),
            },
            {
              key: "secret",
              header: "Webhook secret",
              render: (item) => <span className="mono muted">{item.secretPrefix}…</span>,
            },
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button size="sm" onClick={() => setDisconnecting(item)}>
                    Disconnect
                  </Button>
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No repository is connected. Connect one and every push deploys this project."
          filterText={(item) => `${item.repository} ${item.provider} ${item.productionBranch}`}
          filterLabel="Filter repositories"
        />
      </Card>

      {deployResult || deployError ? (
        <Card title="Deploy now">
          <DeployNowResult result={deployResult} error={deployError} onRefresh={reload} />
        </Card>
      ) : null}

      <ConnectRepositoryModal
        key={`connect-${String(connecting)}`}
        organizationId={organizationId}
        projectId={projectId}
        open={connecting}
        onClose={() => setConnecting(false)}
        onConnected={() => {
          setConnecting(false);
          reload();
        }}
      />

      <DisconnectRepositoryModal
        projectId={projectId}
        link={disconnecting}
        onClose={() => setDisconnecting(null)}
        onDisconnected={() => {
          setDisconnecting(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * The answer to "Deploy now".
 *
 * A build that reached the engine shows its status and, when one was issued, the
 * URL to visit. A refusal is the server's own words — "connect a repository
 * first" or the engine's reason — never a bare failure the operator cannot act
 * on.
 */
function DeployNowResult({
  result,
  error,
  onRefresh,
}: {
  readonly result: DeploymentRequestSummary | null;
  readonly error: string | null;
  readonly onRefresh: () => void;
}) {
  if (error) {
    return (
      <p className="field__error" role="alert">
        {error}
      </p>
    );
  }
  if (!result) return null;
  const status = presentDeploymentStatus(result.deployment.status);
  return (
    <div className="stack">
      <dl className="dl">
        <dt>Status</dt>
        <dd>
          <StatusBadge label={status.label} tone={status.tone} />
        </dd>
        {result.deployment.url ? (
          <>
            <dt>URL</dt>
            <dd className="mono small">
              <VisitLink url={result.deployment.url} />
            </dd>
          </>
        ) : null}
      </dl>
      {result.engineReason ? (
        <p className="small muted" role="status">
          The hosting engine did not act: {result.engineReason}
        </p>
      ) : null}
      {result.replayed ? (
        <p className="small muted">
          This request matched an earlier deployment, so nothing new was queued.
        </p>
      ) : (
        <p className="small muted">
          The build runs in the background. Follow it on the Deployments page.
        </p>
      )}
      <div className="row">
        <Button size="sm" onClick={onRefresh}>
          Refresh repositories
        </Button>
      </div>
    </div>
  );
}

function providerLabel(provider: GitLinkSummary["provider"]): string {
  return GIT_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

/**
 * Connect a repository.
 *
 * The answer is the link and, exactly once, the webhook secret. This dialog
 * shows the delivery URL and the signature header beside it, so the operator
 * leaves with everything the provider needs — or with an honest error, if no
 * encryption key is configured server-side.
 */
function ConnectRepositoryModal({
  organizationId,
  projectId,
  open,
  onClose,
  onConnected,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) {
  const { client } = useApp();
  const [provider, setProvider] = useState<GitLinkSummary["provider"]>("github");
  const [repository, setRepository] = useState("");
  const [productionBranch, setProductionBranch] = useState("main");
  const [previewsEnabled, setPreviewsEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<ConnectedGitLinkSummary | null>(null);

  const reset = () => {
    setRepository("");
    setProductionBranch("main");
    setPreviewsEnabled(false);
    setError(null);
    setConnected(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<ConnectedGitLinkSummary>("git.connect", {
      projectId,
      provider,
      repository,
      productionBranch,
      previewsEnabled,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The repository could not be connected.");
      return;
    }
    setConnected(response.data);
  };

  const close = () => {
    // The secret leaves state when the dialog does; there is no second chance.
    reset();
    onClose();
  };

  return (
    <Modal
      title={connected ? "Webhook ready" : "Connect repository"}
      open={open}
      onClose={close}
      footer={
        connected ? (
          <Button variant="primary" onClick={onConnected}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              busy={busy}
              disabled={!repository.trim()}
            >
              Connect
            </Button>
          </>
        )
      }
    >
      {connected ? (
        <div className="stack">
          <p className="small">
            Copy this secret into your provider now. It is shown once and cannot be retrieved again
            — Cloud Wai stores it encrypted, and no list returns it.
          </p>
          <Field label="Payload URL">
            {(id) => (
              <TextInput
                id={id}
                value={webhookUrl(organizationId, connected.link.id)}
                onChange={() => {}}
              />
            )}
          </Field>
          <Field label="Content type">
            {(id) => <TextInput id={id} value="application/json" onChange={() => {}} />}
          </Field>
          <Field label={`Secret (${webhookHeader(connected.link.provider)} header)`}>
            {(id) => <TextInput id={id} value={connected.webhookSecret} onChange={() => {}} />}
          </Field>
          <p className="small muted">
            Send a <span className="mono">push</span> event. A push to{" "}
            <span className="mono">{connected.link.productionBranch}</span> deploys production
            {connected.link.previewsEnabled
              ? "; any other branch or a pull request deploys a preview."
              : "; previews are off for this repository."}
          </p>
        </div>
      ) : (
        <div className="stack">
          <Field label="Provider">
            {(id) => (
              <select
                id={id}
                className="select"
                value={provider}
                onChange={(event) => setProvider(event.target.value as GitLinkSummary["provider"])}
              >
                {GIT_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Repository"
            hint="owner/name, e.g. acme/web-app. A clone URL is accepted and normalised."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={repository}
                onChange={setRepository}
                placeholder="acme/web-app"
                error={Boolean(error)}
                autoFocus
              />
            )}
          </Field>
          <Field label="Production branch" hint="Pushes to this branch deploy to production.">
            {(id) => (
              <TextInput
                id={id}
                value={productionBranch}
                onChange={setProductionBranch}
                placeholder="main"
              />
            )}
          </Field>
          <label className="row small">
            <input
              type="checkbox"
              aria-label="Enable preview deployments"
              checked={previewsEnabled}
              onChange={(event) => setPreviewsEnabled(event.target.checked)}
            />
            <span>Deploy a preview for every other branch and pull request.</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/** The delivery URL a provider posts to. Derived, never stored. */
function webhookUrl(organizationId: string, linkId: string): string {
  const base =
    typeof window !== "undefined" && window.location
      ? `${window.location.origin}`
      : "https://app.cloudwai.example";
  return `${base}/hooks/git/${encodeURIComponent(organizationId)}/${encodeURIComponent(linkId)}`;
}

/**
 * Disconnect a repository.
 *
 * Idempotent server-side: removing an already-absent link is a success, not an
 * error, so a double-click cannot fail confusingly.
 */
function DisconnectRepositoryModal({
  projectId,
  link,
  onClose,
  onDisconnected,
}: {
  readonly projectId: string;
  readonly link: GitLinkSummary | null;
  readonly onClose: () => void;
  readonly onDisconnected: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    const response = await client.call<{ removed: boolean }>("git.disconnect", {
      projectId,
      linkId: link.id,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The repository could not be disconnected.");
      return;
    }
    onDisconnected();
  };

  return (
    <Modal
      title="Disconnect repository"
      open={link !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            Disconnect
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Stop deploying <span className="mono">{link?.repository}</span> on push. Existing
          deployments are not affected, and a delivery signed with the old secret is refused once
          the link is gone.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- environment */

/**
 * Project environment variables.
 *
 * The variables injected into this project's builds and runtime. A value is
 * write-only: the API stores it encrypted and returns only a fingerprint, so
 * this page can show that a key exists and where it landed but never reveal it —
 * the same promise Vercel makes, and the reason there is no "reveal" button
 * here. A variable a project has never deployed is stored and honestly reported
 * as `stored` rather than applied, because a project with no application has
 * nowhere to push it; the deploy that creates that application reconciles it.
 */
export function EnvVarsPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadEnvVars(client, projectId),
    [client, projectId],
    "Environment variables",
  );

  const [editing, setEditing] = useState<EnvVarSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<EnvVarSummary | null>(null);

  return (
    <PageShell
      title="Environment"
      subtitle="Variables injected into this project's builds and runtime. Values are encrypted and never shown again."
      actions={
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={reload} aria-label="Refresh variables">
            Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add variable
          </Button>
        </div>
      }
    >
      <Card flush>
        <SectionView<EnvVarSummary>
          section={section}
          columns={[
            {
              key: "key",
              header: "Key",
              render: (item) => <span className="mono">{item.key}</span>,
            },
            {
              key: "value",
              header: "Value",
              render: (item) => <span className="mono muted">{item.valuePrefix}…</span>,
            },
            {
              key: "scope",
              header: "Scope",
              render: (item) => (
                <StatusBadge
                  label={item.isBuildTime ? "Build & runtime" : "Runtime only"}
                  tone="neutral"
                />
              ),
            },
            {
              key: "updatedAt",
              header: "Updated",
              render: (item) => <Timestamp value={item.updatedAt} />,
            },
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button size="sm" onClick={() => setEditing(item)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRemoving(item)}>
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No environment variables yet. Add one and it is injected into the next build."
          filterText={(item) => item.key}
          filterLabel="Filter variables"
        />
      </Card>

      <EnvVarModal
        key={`create-${String(creating)}`}
        open={creating}
        projectId={projectId}
        existing={null}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          reload();
        }}
      />

      <EnvVarModal
        key={`edit-${editing?.id ?? "none"}`}
        open={editing !== null}
        projectId={projectId}
        existing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />

      <RemoveEnvVarModal
        projectId={projectId}
        variable={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * Add or edit one variable.
 *
 * A value is write-only, so editing never pre-fills it: the form states the
 * value must be re-entered and does not pretend the stored one is readable. The
 * outcome is reported from what the server actually did — `engine` when the
 * adapter confirmed the write, `stored` when it could only be saved — and a
 * build-time save offers a redeploy, because that is the only thing that makes a
 * build-time change take effect.
 */
function EnvVarModal({
  open,
  projectId,
  existing,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly projectId: string;
  readonly existing: EnvVarSummary | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useApp();
  const [key, setKey] = useState(existing?.key ?? "");
  const [value, setValue] = useState("");
  const [isBuildTime, setIsBuildTime] = useState(existing?.isBuildTime ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SetEnvVarOutcome | null>(null);
  const [redeploying, setRedeploying] = useState(false);
  const [redeployOutcome, setRedeployOutcome] = useState<string | null>(null);
  const [redeployError, setRedeployError] = useState<string | null>(null);
  const [redeployKey] = useState(newRequestId);

  const editing = existing !== null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<SetEnvVarOutcome>("env.set", {
      projectId,
      key,
      value,
      isBuildTime,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The variable could not be saved.");
      return;
    }
    setOutcome(response.data);
  };

  const close = () => {
    setValue("");
    setError(null);
    setOutcome(null);
    setRedeployOutcome(null);
    setRedeployError(null);
    onClose();
  };

  // A build-time variable only reaches a running build through a new deployment,
  // so the note that says so carries the action rather than sending the operator
  // to another page to find it. It reuses the connected repository (the same
  // `git.deployNow` the Git page calls), and reports the queued deployment or the
  // reason there is nothing to deploy — it never claims a build started.
  const redeploy = async () => {
    setRedeploying(true);
    setRedeployError(null);
    setRedeployOutcome(null);
    const response = await deployFromLink(client, projectId, redeployKey);
    setRedeploying(false);
    if (!response.ok || !response.data) {
      setRedeployError(
        response.error?.message ?? "The redeploy could not be requested. Is a repository connected?",
      );
      return;
    }
    setRedeployOutcome(response.data.deployment.id);
  };

  return (
    <Modal
      title={editing ? `Edit ${existing.key}` : "Add environment variable"}
      open={open}
      onClose={close}
      footer={
        outcome ? (
          <Button variant="primary" onClick={onSaved}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              busy={busy}
              disabled={!key.trim() || value.length === 0}
            >
              {editing ? "Save" : "Add"}
            </Button>
          </>
        )
      }
    >
      {outcome ? (
        <div className="stack">
          <p className="small">
            <span className="mono">{outcome.variable.key}</span>{" "}
            {outcome.applied === "engine"
              ? "was saved and applied to the hosting engine."
              : "was saved. The hosting engine has not been reached yet."}
          </p>
          {outcome.engineReason ? <p className="small muted">{outcome.engineReason}</p> : null}
          {outcome.redeployRequired ? (
            <div className="stack">
              <p className="small muted">
                This is a build-time variable, so it takes effect on the next deployment. Redeploy
                the project to apply it to the running output.
              </p>
              {redeployOutcome ? (
                <p className="small" role="status">
                  A redeployment was queued. Its status is the hosting engine&apos;s to report, on the
                  Deployments page.
                </p>
              ) : (
                <>
                  <Button onClick={() => void redeploy()} busy={redeploying} size="sm">
                    Redeploy now
                  </Button>
                  {redeployError ? (
                    <p className="small" role="alert">
                      {redeployError}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          {editing ? (
            <p className="small muted">
              The stored value cannot be read back — Cloud Wai keeps it encrypted. Enter the value
              again to replace it.
            </p>
          ) : null}
          <Field
            label="Key"
            hint="Uppercase letters, digits and underscores, e.g. DATABASE_URL."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={key}
                onChange={(next) => setKey(next.toUpperCase())}
                placeholder="DATABASE_URL"
                error={Boolean(error)}
                autoFocus={!editing}
              />
            )}
          </Field>
          <Field label="Value" hint="Encrypted before it is stored. Never shown again.">
            {(id) => (
              <TextInput
                id={id}
                value={value}
                onChange={setValue}
                placeholder="postgres://…"
                autoFocus={editing}
                onEnter={() => {
                  if (key.trim() && value.length > 0) void submit();
                }}
              />
            )}
          </Field>
          <label className="row small">
            <input
              type="checkbox"
              aria-label="Available at build time"
              checked={isBuildTime}
              onChange={(event) => setIsBuildTime(event.target.checked)}
            />
            <span>Available during the build (a change needs a redeploy).</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/**
 * Remove one variable.
 *
 * The engine's copy is deleted before the row, so a failure leaves a variable
 * the customer can still see and retry rather than an invisible engine variable
 * still fed to a build. That is why a failure here surfaces the engine's reason
 * instead of a generic error.
 */
function RemoveEnvVarModal({
  projectId,
  variable,
  onClose,
  onRemoved,
}: {
  readonly projectId: string;
  readonly variable: EnvVarSummary | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!variable) return;
    setBusy(true);
    setError(null);
    const response = await client.call<{ removed: boolean; engineReason: string | null }>(
      "env.remove",
      { projectId, key: variable.key },
    );
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The variable could not be removed.");
      return;
    }
    if (!response.data.removed) {
      setError(response.data.engineReason ?? "The engine refused to remove the variable.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Remove environment variable"
      open={variable !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <span className="mono">{variable?.key}</span> from this project and from the
          hosting engine. A build-time variable stops affecting the build after the next deployment.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ security */

/**
 * A protection level, as the page describes it.
 *
 * The level is client-side vocabulary: it maps to a risk level and an
 * enforcement action that the *same* save form would let an operator pick. The
 * type keeps a glyph, a description and a mapping from drifting apart.
 */
interface ProtectionLevel {
  readonly id: string;
  readonly name: string;
  readonly riskLevel: SecurityPolicySummary["riskLevel"];
  readonly action: SecurityPolicySummary["action"];
  readonly summary: string;
  readonly enables: readonly string[];
}

/**
 * Security.
 *
 * This page reports what the deployment can actually do. The protection levels
 * below are a preview of the vocabulary Cloud Wai compiles; the *policy* is a
 * real row, saved as a draft and activated only when the edge accepts a
 * distribution. Until an edge is wired, the honest answer is "not configured",
 * and nothing here claims a policy is active that the edge never confirmed.
 */
export function SecurityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Security engines",
  );
  const policy = useSection(
    () => loadSecurityPolicy(client, organizationId),
    [client, organizationId],
    "Security policy",
  );
  const events = useSection(
    () => loadSecurityPolicyEvents(client, organizationId),
    [client, organizationId],
    "Policy history",
  );
  const rules = useSection(
    () => loadSecurityRules(client, organizationId),
    [client, organizationId],
    "Deny list",
  );
  const trusted = useSection(
    () => loadTrustedSources(client, organizationId),
    [client, organizationId],
    "Trusted sources",
  );
  const bots = useSection(
    () => loadVerifiedBots(client, organizationId),
    [client, organizationId],
    "Verified bots",
  );
  const rateLimits = useSection(
    () => loadRateLimits(client, organizationId),
    [client, organizationId],
    "Rate limits",
  );
  const edgeEvents = useSection(
    () => loadSecurityEvents(client, organizationId),
    [client, organizationId],
    "Edge decisions",
  );
  const incidents = useSection(
    () => loadSecurityIncidents(client, organizationId),
    [client, organizationId],
    "Incidents",
  );
  const [saving, setSaving] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [removingRule, setRemovingRule] = useState<SecurityRuleSummary | null>(null);
  const [addingTrusted, setAddingTrusted] = useState(false);
  const [removingTrusted, setRemovingTrusted] = useState<TrustedSourceSummary | null>(null);
  const [addingRateLimit, setAddingRateLimit] = useState(false);
  const [removingRateLimit, setRemovingRateLimit] = useState<RateLimitSummary | null>(null);
  // The incident being triaged or closed. Its lifecycle is enforced server-side;
  // this only decides which modal is open.
  const [incidentAction, setIncidentAction] = useState<{
    readonly incident: SecurityIncidentSummary;
    readonly mode: "triage" | "close";
  } | null>(null);
  // A level card preselects the risk and action the form opens with; it is a
  // convenience over the same save, never a separate write. Null means "open
  // with the policy's own values".
  const [prefill, setPrefill] = useState<ProtectionLevel | null>(null);

  const current =
    policy.section.state.kind === "ready" ? (policy.section.state.items[0] ?? null) : null;

  // The banner is the deployment's own answer, not a slogan. It used to be a
  // hardcoded "Edge not configured yet." that would keep saying so after an edge
  // was wired. It is derived from `providers.health` — the adapter's report of
  // the security edge — and says which engine it is talking about.
  const edgeConfigured: boolean | null =
    health.section.state.kind === "ready"
      ? health.section.state.items.find((item) => item.provider === "envoy")?.state === "ready"
      : null;

  const levels: readonly ProtectionLevel[] = [
    {
      id: "none",
      name: "None",
      riskLevel: "low",
      action: "allow",
      summary: "No inspection. The origin is reachable directly.",
      enables: ["Host firewall only"],
    },
    {
      id: "normal",
      name: "Normal",
      riskLevel: "medium",
      action: "log",
      summary: "Hidden origin, TLS termination, managed rule set.",
      enables: [
        "Origin hidden behind the edge",
        "TLS termination and HSTS",
        "OWASP Core Rule Set (generic detections)",
        "Access logging",
      ],
    },
    {
      id: "high",
      name: "High",
      riskLevel: "high",
      action: "challenge",
      summary: "Normal plus behaviour-based blocking and rate limits.",
      enables: [
        "Everything in Normal",
        "CrowdSec behavioural signals",
        "Per-route rate limits",
        "Challenge on suspicious traffic",
      ],
    },
    {
      id: "ultimate",
      name: "Ultimate",
      riskLevel: "critical",
      action: "block",
      summary: "High plus advanced anomaly scoring and quarantine.",
      enables: [
        "Everything in High",
        "Anomaly scoring thresholds",
        "Automatic quarantine",
        "Deny direct origin access (gate 6)",
      ],
    },
  ];

  return (
    <PageShell
      title="Security"
      subtitle="Choose a protection level. Cloud Wai compiles it to an edge policy; the edge applies and confirms it. The policy is organization-wide, not per project."
      actions={
        <Button variant="primary" onClick={() => setSaving(true)}>
          {current ? "Edit policy" : "Save policy"}
        </Button>
      }
    >
      <div className="banner" role="status">
        {edgeConfigured === true ? (
          <>
            <strong>Edge configured.</strong>
            <span>
              The security edge engine reports itself ready, so a saved policy can be distributed
              and confirmed by it. The engine status below is the adapter&apos;s report, not an
              assumption.
            </span>
          </>
        ) : edgeConfigured === false ? (
          <>
            <strong>Edge not configured.</strong>
            <span>
              No Envoy/Coraza edge is registered for this deployment, so no policy is compiled or
              claimed as active. Levels below describe what each level enables once an edge is
              wired.
            </span>
          </>
        ) : (
          <>
            <strong>Edge status unknown.</strong>
            <span>
              The engine status could not be read, so whether an edge is configured is unknown. What
              each level enables is described below; nothing here claims a policy is active.
            </span>
          </>
        )}
      </div>

      <SectionShell
        title="Policy"
        hint="Saved as a draft; the edge is what makes it active"
        actions={
          current ? (
            <Button size="sm" onClick={() => setDistributing(true)}>
              Distribute to edge
            </Button>
          ) : undefined
        }
      >
        <Card flush>
          <SectionView<SecurityPolicySummary>
            section={policy.section}
            onRetry={policy.reload}
            emptyMessage="No policy saved yet. Saving writes a draft; the edge activates it."
            columns={[
              { key: "name", header: "Name", render: (item) => item.name },
              {
                key: "riskLevel",
                header: "Risk",
                render: (item) => <span className="mono small">{item.riskLevel}</span>,
              },
              {
                key: "action",
                header: "Action",
                render: (item) => <span className="mono small">{item.action}</span>,
              },
              {
                key: "state",
                header: "State",
                render: (item) => <PolicyStateBadge state={item.state} />,
              },
              {
                key: "protection",
                header: "Protection",
                render: (item) => <ProtectionBadge policy={item} />,
              },
              {
                key: "version",
                header: "Version",
                render: (item) => <span className="mono small">{item.version}</span>,
              },
              {
                key: "updatedAt",
                header: "Updated",
                render: (item) => <Timestamp value={item.updatedAt} />,
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Protection level" hint="Selecting a level does not apply it yet">
        <div className="grid">
          {levels.map((level) => (
            <Card key={level.id} title={level.name}>
              <p className="muted small">{level.summary}</p>
              <ul className="small" style={{ margin: "var(--space-3) 0 0", paddingLeft: "1.1rem" }}>
                {level.enables.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <div style={{ marginTop: "var(--space-4)" }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setPrefill(level);
                    setSaving(true);
                  }}
                  title="Opens the policy form with this level's risk and action; saving writes a draft."
                >
                  Use this level
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </SectionShell>

      <SectionShell
        title="Deny list"
        hint="Your own rules, compiled alongside the managed set. A rule is validated before it is stored, so a hostile value never becomes edge syntax."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAddingRule(true)}>
            Add rule
          </Button>
        }
      >
        <Card flush>
          <SectionView<SecurityRuleSummary>
            section={rules.section}
            onRetry={rules.reload}
            emptyMessage="No rules yet. Add an IP, CIDR, ASN or user-agent to block it at the edge."
            columns={[
              {
                key: "kind",
                header: "Kind",
                render: (item) => <span className="mono small">{item.kind}</span>,
              },
              {
                key: "value",
                header: "Value",
                render: (item) => (
                  <span
                    className="mono small truncate"
                    style={{ display: "inline-block", maxWidth: 360 }}
                  >
                    {item.value}
                  </span>
                ),
              },
              {
                key: "note",
                header: "Note",
                render: (item) => <span className="small">{item.note ?? "—"}</span>,
              },
              {
                key: "createdAt",
                header: "Added",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
              {
                key: "actions",
                header: "",
                render: (item) => (
                  <Button size="sm" onClick={() => setRemovingRule(item)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Trusted sources"
        hint="Your own webhook senders and CI runners, allowed before the deny list and before any challenge — so enabling attack mode never locks out your integrations. Address literals only; a hostname would have to be resolved and could be forged."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAddingTrusted(true)}>
            Trust an address
          </Button>
        }
      >
        <Card flush>
          <SectionView<TrustedSourceSummary>
            section={trusted.section}
            onRetry={trusted.reload}
            emptyMessage="No trusted addresses yet. Add one so a known sender keeps working while attack mode is on."
            columns={[
              {
                key: "kind",
                header: "Kind",
                render: (item) => <span className="mono small">{item.kind}</span>,
              },
              {
                key: "value",
                header: "Address",
                render: (item) => (
                  <span
                    className="mono small truncate"
                    style={{ display: "inline-block", maxWidth: 360 }}
                  >
                    {item.value}
                  </span>
                ),
              },
              {
                key: "note",
                header: "Note",
                render: (item) => <span className="small">{item.note ?? "—"}</span>,
              },
              {
                key: "createdAt",
                header: "Added",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
              {
                key: "actions",
                header: "",
                render: (item) => (
                  <Button size="sm" onClick={() => setRemovingTrusted(item)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Rate limits"
        hint="Throttle the disproportionate, not the hostile. A limit a normal visitor never reaches keeps a human served while a scraper walking a catalogue is made uneconomic. Compiled after the allow steps, so a verified crawler or a trusted address is never counted. An engine that has no rate primitive reports not_configured rather than a fake pass."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAddingRateLimit(true)}>
            Add a limit
          </Button>
        }
      >
        <Card flush>
          <SectionView<RateLimitSummary>
            section={rateLimits.section}
            onRetry={rateLimits.reload}
            emptyMessage="No rate limits yet. Add one to cap a burst from a single address, a header value, or the route as a whole."
            columns={[
              {
                key: "key",
                header: "Counted by",
                render: (item) => (
                  <span className="mono small">
                    {item.key === "header" ? `header ${item.headerName ?? ""}` : item.key}
                  </span>
                ),
              },
              {
                key: "limit",
                header: "Allowance",
                render: (item) => (
                  <span className="small">
                    {item.limit.toLocaleString()} / {formatWindow(item.windowSeconds)}
                  </span>
                ),
              },
              {
                key: "note",
                header: "Note",
                render: (item) => <span className="small">{item.note ?? "—"}</span>,
              },
              {
                key: "createdAt",
                header: "Added",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
              {
                key: "actions",
                header: "",
                render: (item) => (
                  <Button size="sm" onClick={() => setRemovingRateLimit(item)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Verified bots"
        hint="Crawlers whose identity is confirmed by reverse DNS. They keep working even while attack mode challenges browsers."
      >
        <Card flush>
          <SectionView<VerifiedBotSummary>
            section={bots.section}
            onRetry={bots.reload}
            emptyMessage="No verified bots reported."
            columns={[
              {
                key: "name",
                header: "Crawler",
                render: (item) => <span className="small">{item.name}</span>,
              },
              {
                key: "userAgent",
                header: "User-Agent",
                render: (item) => (
                  <span
                    className="mono small truncate"
                    style={{ display: "inline-block", maxWidth: 280 }}
                  >
                    {item.userAgent}
                  </span>
                ),
              },
              {
                key: "confirmSuffix",
                header: "Verified by",
                render: (item) => <span className="mono small">{item.confirmSuffix}</span>,
              },
            ]}
            rowKey={(item) => item.name}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Engine status" hint="Read from the adapters, not assumed">
        <Card flush>
          <SectionView<ProviderHealthRow>
            section={health.section}
            onRetry={health.reload}
            emptyMessage="No engines reported."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.provider}
                columns={[
                  {
                    key: "provider",
                    header: "Engine",
                    render: (item) => <span className="mono">{item.provider}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (item) =>
                      item.state === "ready" ? (
                        <StatusBadge label="Configured" tone="positive" />
                      ) : (
                        <StatusBadge label="Not configured" tone="neutral" />
                      ),
                  },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (item) => <span className="small">{item.detail}</span>,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Incidents"
        hint="Grouped security signals that need a human: a policy the edge refused, and later an origin leak or a rule-volume spike. An incident is triaged, then closed with a resolution — it never disappears without one."
        actions={
          <Button size="sm" onClick={() => incidents.reload()}>
            Refresh
          </Button>
        }
      >
        <Card flush>
          <SectionView<SecurityIncidentSummary>
            section={incidents.section}
            onRetry={incidents.reload}
            emptyMessage="No security incidents. When the edge rejects a distribution, or a detector raises a signal, it appears here to triage."
            columns={[
              {
                key: "severity",
                header: "Severity",
                render: (item) => <IncidentSeverityBadge severity={item.severity} />,
              },
              {
                key: "summary",
                header: "Signal",
                render: (item) => (
                  <span className="small" style={{ display: "inline-block", maxWidth: 360 }}>
                    {item.summary}
                  </span>
                ),
              },
              {
                key: "kind",
                header: "Kind",
                render: (item) => <span className="mono small">{item.kind}</span>,
              },
              {
                key: "state",
                header: "State",
                render: (item) => <IncidentStateBadge state={item.state} />,
              },
              {
                key: "openedAt",
                header: "Opened",
                render: (item) => <Timestamp value={item.openedAt} />,
              },
              {
                key: "resolution",
                header: "Resolution",
                render: (item) => <span className="small">{item.resolution ?? "—"}</span>,
              },
              {
                key: "actions",
                header: "",
                render: (item) =>
                  item.state === "open" || item.state === "triaged" ? (
                    <div className="row-gap">
                      {item.state === "open" ? (
                        <Button
                          size="sm"
                          onClick={() => setIncidentAction({ incident: item, mode: "triage" })}
                        >
                          Triage
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setIncidentAction({ incident: item, mode: "close" })}
                      >
                        Close
                      </Button>
                    </div>
                  ) : (
                    <span className="small muted">Closed</span>
                  ),
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Edge decisions"
        hint="What the edge did with recent requests: allowed, logged, challenged or blocked, and at which stage. Written by the edge, read-only here."
        actions={
          <Button size="sm" onClick={() => edgeEvents.reload()}>
            Refresh
          </Button>
        }
      >
        <Card flush>
          <SectionView<SecurityEventSummary>
            section={edgeEvents.section}
            onRetry={edgeEvents.reload}
            emptyMessage="No edge decisions recorded yet. Once the edge is enforcing, each request's outcome appears here."
            columns={[
              {
                key: "action",
                header: "Decision",
                render: (item) => <EdgeActionBadge action={item.action} />,
              },
              {
                key: "stage",
                header: "Stage",
                render: (item) => <span className="mono small">{item.stage}</span>,
              },
              {
                key: "request",
                header: "Request",
                render: (item) => (
                  <span
                    className="mono small truncate"
                    style={{ display: "inline-block", maxWidth: 300 }}
                  >
                    {item.method ?? "—"} {item.path ?? ""}
                  </span>
                ),
              },
              {
                key: "host",
                header: "Host",
                render: (item) => <span className="mono small">{item.host}</span>,
              },
              {
                key: "clientIp",
                header: "Client",
                render: (item) => <span className="mono small">{item.clientIp ?? "—"}</span>,
              },
              {
                key: "observedAt",
                header: "When",
                render: (item) => <Timestamp value={item.observedAt} />,
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Policy history"
        hint="Every transition the server recorded, including refusals"
      >
        <Card flush>
          <SectionView<SecurityPolicyEventSummary>
            section={events.section}
            onRetry={events.reload}
            emptyMessage="No policy transitions recorded yet."
            columns={[
              {
                key: "toState",
                header: "State",
                render: (item) => <PolicyStateBadge state={item.toState} />,
              },
              {
                key: "from",
                header: "From",
                render: (item) => <span className="mono small">{item.fromState ?? "—"}</span>,
              },
              {
                key: "version",
                header: "Version",
                render: (item) => <span className="mono small">{item.version}</span>,
              },
              {
                key: "detail",
                header: "Detail",
                render: (item) => <span className="small">{item.detail ?? "—"}</span>,
              },
              {
                key: "createdAt",
                header: "When",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SavePolicyModal
        // Remount on each open so the form starts from the chosen level or the
        // stored policy, never from a previous visit's keystrokes.
        key={`save-${String(saving)}-${prefill?.id ?? "none"}-${current?.version ?? "new"}`}
        organizationId={organizationId}
        policy={current}
        prefill={prefill}
        open={saving}
        onClose={() => {
          setSaving(false);
          setPrefill(null);
        }}
        onSaved={() => {
          setSaving(false);
          setPrefill(null);
          policy.reload();
          events.reload();
        }}
      />

      <DistributePolicyModal
        organizationId={organizationId}
        policy={current}
        open={distributing}
        onClose={() => setDistributing(false)}
        onDone={() => {
          setDistributing(false);
          policy.reload();
          events.reload();
        }}
      />

      <AddSecurityRuleModal
        organizationId={organizationId}
        open={addingRule}
        onClose={() => setAddingRule(false)}
        onAdded={() => {
          setAddingRule(false);
          rules.reload();
        }}
      />

      <RemoveSecurityRuleModal
        organizationId={organizationId}
        rule={removingRule}
        open={removingRule !== null}
        onClose={() => setRemovingRule(null)}
        onRemoved={() => {
          setRemovingRule(null);
          rules.reload();
        }}
      />

      <AddTrustedSourceModal
        organizationId={organizationId}
        open={addingTrusted}
        onClose={() => setAddingTrusted(false)}
        onAdded={() => {
          setAddingTrusted(false);
          trusted.reload();
        }}
      />

      <RemoveTrustedSourceModal
        organizationId={organizationId}
        source={removingTrusted}
        open={removingTrusted !== null}
        onClose={() => setRemovingTrusted(null)}
        onRemoved={() => {
          setRemovingTrusted(null);
          trusted.reload();
        }}
      />
      <AddRateLimitModal
        organizationId={organizationId}
        open={addingRateLimit}
        onClose={() => setAddingRateLimit(false)}
        onAdded={() => {
          setAddingRateLimit(false);
          rateLimits.reload();
        }}
      />
      <RemoveRateLimitModal
        organizationId={organizationId}
        rateLimit={removingRateLimit}
        open={removingRateLimit !== null}
        onClose={() => setRemovingRateLimit(null)}
        onRemoved={() => {
          setRemovingRateLimit(null);
          rateLimits.reload();
        }}
      />
      <IncidentActionModal
        organizationId={organizationId}
        action={incidentAction}
        onClose={() => setIncidentAction(null)}
        onDone={() => {
          setIncidentAction(null);
          incidents.reload();
        }}
      />
    </PageShell>
  );
}

/** A human window: seconds folded into the largest whole unit that fits. */
function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A policy's lifecycle. `active` is the edge's answer, never a form's. */
function PolicyStateBadge({ state }: { readonly state: string }) {
  const tone = state === "active" ? "positive" : state === "rejected" ? "danger" : "warning";
  return <StatusBadge label={state} tone={tone} />;
}

/**
 * One edge decision, coloured by what the edge did.
 *
 * A block is danger, a challenge is a warning, an allow is positive, and a log
 * is neutral — the tone tracks the customer's exposure, not the tone of voice.
 */
function EdgeActionBadge({ action }: { readonly action: SecurityEventSummary["action"] }) {
  const tone =
    action === "block" || action === "quarantine"
      ? "danger"
      : action === "challenge"
        ? "warning"
        : action === "allow"
          ? "positive"
          : "neutral";
  return <StatusBadge label={action} tone={tone} />;
}

/**
 * The protection posture.
 *
 * An attack posture that has already lapsed is shown as "Normal" — the compile
 * step treats a past expiry as normal, so the badge says what the edge will
 * actually do rather than what was once asked for.
 */
function ProtectionBadge({ policy }: { readonly policy: SecurityPolicySummary }) {
  const active =
    policy.protectionMode === "attack" &&
    (policy.protectionExpiresAt === null || Date.parse(policy.protectionExpiresAt) > Date.now());
  if (!active) return <StatusBadge label="Normal" tone="neutral" />;
  return (
    <StatusBadge label={policy.protectionExpiresAt ? "Attack (timed)" : "Attack"} tone="danger" />
  );
}

/**
 * Save a policy as a draft.
 *
 * The form changes the name, risk level, action and the protection posture. It
 * cannot set the state: the server always writes `draft`, and the badge
 * afterwards is read back from the server rather than assumed here.
 */
function SavePolicyModal({
  organizationId,
  policy,
  prefill,
  open,
  onClose,
  onSaved,
}: {
  readonly organizationId: string;
  readonly policy: SecurityPolicySummary | null;
  readonly prefill: ProtectionLevel | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useApp();
  // A chosen level wins over the stored policy, so "Use this level" actually
  // carries the level the operator clicked. Without one the form opens on the
  // policy's own values.
  const [name, setName] = useState(policy?.name ?? "Default policy");
  const [riskLevel, setRiskLevel] = useState<SecurityPolicySummary["riskLevel"]>(
    prefill?.riskLevel ?? policy?.riskLevel ?? "medium",
  );
  const [action, setAction] = useState<SecurityPolicySummary["action"]>(
    prefill?.action ?? policy?.action ?? "log",
  );
  // The posture defaults to what is stored, so opening the form never quietly
  // drops a live attack mode.
  const [protectionMode, setProtectionMode] = useState<"normal" | "attack">(
    policy?.protectionMode ?? "normal",
  );
  const [protectionExpiresAt, setProtectionExpiresAt] = useState(policy?.protectionExpiresAt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<SecurityPolicySummary>("security.policy.save", {
      organizationId,
      name,
      riskLevel,
      action,
      protectionMode,
      // An empty expiry means "until turned off"; the server keeps it as null.
      protectionExpiresAt:
        protectionMode === "attack" && protectionExpiresAt !== ""
          ? new Date(protectionExpiresAt).toISOString()
          : null,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The policy could not be saved.");
      return;
    }
    onSaved();
  };

  return (
    <Modal
      title="Save policy"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={setName}
              placeholder="Default policy"
              error={Boolean(error)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Risk level">
          {(id) => (
            <select
              id={id}
              className="input"
              value={riskLevel}
              onChange={(event) =>
                setRiskLevel(event.target.value as SecurityPolicySummary["riskLevel"])
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          )}
        </Field>
        <Field label="Enforcement action" hint="How the edge treats a matching request.">
          {(id) => (
            <select
              id={id}
              className="input"
              value={action}
              onChange={(event) => setAction(event.target.value as SecurityPolicySummary["action"])}
            >
              <option value="allow">Allow</option>
              <option value="log">Log</option>
              <option value="challenge">Challenge</option>
              <option value="block">Block</option>
              <option value="quarantine">Quarantine</option>
            </select>
          )}
        </Field>
        <Field
          label="Protection posture"
          hint="Normal inspects and logs. Attack challenges browsers — search engines and verified bots keep working."
        >
          {(id) => (
            <select
              id={id}
              className="input"
              value={protectionMode}
              onChange={(event) => setProtectionMode(event.target.value as "normal" | "attack")}
            >
              <option value="normal">Normal</option>
              <option value="attack">Attack (challenge browsers)</option>
            </select>
          )}
        </Field>
        {protectionMode === "attack" ? (
          <Field
            label="Attack window ends (optional)"
            hint="Leave empty to keep it on until you switch back. At most 24 hours ahead."
          >
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className="input"
                value={protectionExpiresAt === "" ? "" : toLocalInputValue(protectionExpiresAt)}
                onChange={(event) =>
                  setProtectionExpiresAt(
                    event.target.value === "" ? "" : new Date(event.target.value).toISOString(),
                  )
                }
              />
            )}
          </Field>
        ) : null}
        <p className="muted small">
          Saving writes a draft with a version one higher than the current one. The edge is what
          activates it.
        </p>
      </div>
    </Modal>
  );
}

/** Format an ISO timestamp for a `datetime-local` input, in the viewer's zone. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * Distribute the policy to the edge.
 *
 * The answer is the adapter's. A not-configured edge is reported as the reason
 * the policy stayed a draft, never as an activation.
 */
function DistributePolicyModal({
  organizationId,
  policy,
  open,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly policy: SecurityPolicySummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DistributePolicySummary | null>(null);

  if (!policy) return null;

  const close = () => {
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DistributePolicySummary>("security.policy.distribute", {
      organizationId,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The policy could not be distributed.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title="Distribute policy"
      open={policy !== null && open}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Distribute
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p>
          Send <span className="mono">{policy.name}</span> (version {policy.version}) to the edge.
        </p>
        {result ? (
          <>
            <PolicyStateBadge state={result.policy.state} />
            {result.distributed ? (
              <p className="small">The edge accepted the policy and it is now active.</p>
            ) : (
              <p className="muted small">
                {result.engineReason
                  ? `The edge did not apply the policy: ${result.engineReason}`
                  : "The distribution is queued. The edge applies it shortly and the policy becomes active when it does."}
              </p>
            )}
          </>
        ) : (
          <p className="muted small">
            The edge confirms its own version; a lower version is refused before the call.
          </p>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The rule kinds, with the shape each value must have.
 *
 * The hint is the same description the server's validator enforces, so the form
 * and the refusal speak the same language and a reject is never a surprise.
 */
const RULE_KIND_OPTIONS: readonly {
  readonly kind: SecurityRuleSummary["kind"];
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}[] = [
  {
    kind: "ip",
    label: "IP address",
    hint: "A single address, e.g. 203.0.113.9.",
    placeholder: "203.0.113.9",
  },
  {
    kind: "cidr",
    label: "CIDR range",
    hint: "A network in CIDR form, e.g. 203.0.113.0/24.",
    placeholder: "203.0.113.0/24",
  },
  {
    kind: "asn",
    label: "ASN",
    hint: "An autonomous system number, e.g. AS64500 or 64500.",
    placeholder: "AS64500",
  },
  {
    kind: "user-agent",
    label: "User-Agent",
    hint: "A substring of the User-Agent header, up to 200 characters.",
    placeholder: "BadBot/1.0",
  },
];

/** Add one rule to the customer's deny list. */
function AddSecurityRuleModal({
  organizationId,
  open,
  onClose,
  onAdded,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { client } = useApp();
  const [kind, setKind] = useState<SecurityRuleSummary["kind"]>("ip");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected =
    RULE_KIND_OPTIONS.find((option) => option.kind === kind) ?? RULE_KIND_OPTIONS[0]!;

  const close = () => {
    setError(null);
    setValue("");
    setNote("");
    onClose();
  };

  const submit = async () => {
    if (value.trim() === "") {
      setError("Enter a value to block.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await client.call<SecurityRuleSummary>("security.rules.add", {
      organizationId,
      kind,
      value: value.trim(),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The rule could not be added.");
      return;
    }
    setValue("");
    setNote("");
    onAdded();
  };

  return (
    <Modal
      title="Add a deny-list rule"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Add rule
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Kind">
          {(id) => (
            <select
              id={id}
              className="input"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as SecurityRuleSummary["kind"]);
                setError(null);
              }}
            >
              {RULE_KIND_OPTIONS.map((option) => (
                <option key={option.kind} value={option.kind}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Value" hint={selected.hint} {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={value}
              onChange={setValue}
              placeholder={selected.placeholder}
              error={Boolean(error)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Note (optional)" hint="Why this rule exists, for the next operator.">
          {(id) => (
            <TextInput
              id={id}
              value={note}
              onChange={setNote}
              placeholder="Abuse report 2026-09-24"
            />
          )}
        </Field>
        <p className="muted small">
          The value is validated before it is stored. A value that could break out of a directive is
          refused here, so it can never reach the edge as syntax.
        </p>
      </div>
    </Modal>
  );
}

/** Remove one rule from the deny list. */
function RemoveSecurityRuleModal({
  organizationId,
  rule,
  open,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly rule: SecurityRuleSummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!rule) return null;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<{ removed: boolean }>("security.rules.remove", {
      organizationId,
      ruleId: rule.id,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The rule could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Remove rule"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <span className="mono">{rule.value}</span> ({rule.kind}) from the deny list?
        </p>
        <p className="muted small">
          The edge stops blocking it on the next compile. Provisioned traffic is not affected
          retroactively.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Triage or close one incident.
 *
 * Triage records that a human has seen it. Closing requires a resolution — the
 * server refuses a close without one, because an incident that vanishes with no
 * reason is worse than one left open. The API is the source of the lifecycle
 * rules; this form mirrors them so the buttons it offers are always valid.
 */
function IncidentActionModal({
  organizationId,
  action,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly action: {
    readonly incident: SecurityIncidentSummary;
    readonly mode: "triage" | "close";
  } | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [resolution, setResolution] = useState("");
  const [closeAs, setCloseAs] = useState<"resolved" | "false_positive">("resolved");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!action) return null;
  const { incident, mode } = action;

  const close = () => {
    setError(null);
    setResolution("");
    setCloseAs("resolved");
    onClose();
  };

  const submit = async () => {
    if (mode === "close" && resolution.trim() === "") {
      setError("A resolution is required to close an incident.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await client.call<SecurityIncidentSummary>("security.incidents.transition", {
      organizationId,
      incidentId: incident.id,
      state: mode === "triage" ? "triaged" : closeAs,
      ...(mode === "close" ? { resolution: resolution.trim() } : {}),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The incident could not be updated.");
      return;
    }
    setResolution("");
    onDone();
  };

  return (
    <Modal
      title={mode === "triage" ? "Triage incident" : "Close incident"}
      open={action !== null}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            {mode === "triage" ? "Mark triaged" : "Close incident"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">{incident.summary}</p>
        {mode === "triage" ? (
          <p className="muted small">
            Triage records that a human has seen this. It stays open for resolution afterwards.
          </p>
        ) : (
          <>
            <Field label="Outcome">
              {(id) => (
                <div className="row-gap" id={id}>
                  <Button
                    size="sm"
                    variant={closeAs === "resolved" ? "primary" : "default"}
                    onClick={() => setCloseAs("resolved")}
                  >
                    Resolved
                  </Button>
                  <Button
                    size="sm"
                    variant={closeAs === "false_positive" ? "primary" : "default"}
                    onClick={() => setCloseAs("false_positive")}
                  >
                    False positive
                  </Button>
                </div>
              )}
            </Field>
            <Field
              label="Resolution"
              hint="What was done, in the operator's own words. Shown on the incident afterwards."
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={resolution}
                  onChange={setResolution}
                  placeholder="e.g. Re-distributed after fixing the edge certificate"
                />
              )}
            </Field>
          </>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** The severity of an incident, in the platform's tone vocabulary. */
function IncidentSeverityBadge({
  severity,
}: {
  readonly severity: SecurityIncidentSummary["severity"];
}) {
  const tone =
    severity === "critical" || severity === "high"
      ? "danger"
      : severity === "medium"
        ? "warning"
        : "neutral";
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return <StatusBadge label={label} tone={tone} />;
}

/** An incident's lifecycle state. */
function IncidentStateBadge({ state }: { readonly state: SecurityIncidentSummary["state"] }) {
  const presentation: Record<
    SecurityIncidentSummary["state"],
    { readonly label: string; readonly tone: "danger" | "warning" | "positive" | "neutral" }
  > = {
    open: { label: "Open", tone: "danger" },
    triaged: { label: "Triaged", tone: "warning" },
    resolved: { label: "Resolved", tone: "positive" },
    false_positive: { label: "False positive", tone: "neutral" },
  };
  const { label, tone } = presentation[state];
  return <StatusBadge label={label} tone={tone} />;
}

/**
 * The trusted-source kinds, with the shape each value must have.
 *
 * Deliberately shorter than the deny-list kinds: only address literals can be
 * trusted. A hostname would have to be resolved, and the DNS answer is
 * attacker-influenced, so a name could be forged into an allow.
 */
const TRUSTED_KIND_OPTIONS: readonly {
  readonly kind: TrustedSourceSummary["kind"];
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}[] = [
  {
    kind: "ip",
    label: "IP address",
    hint: "A single address, e.g. 198.51.100.7 (your webhook sender or CI runner).",
    placeholder: "198.51.100.7",
  },
  {
    kind: "cidr",
    label: "CIDR range",
    hint: "A network in CIDR form, e.g. 192.0.2.0/24.",
    placeholder: "192.0.2.0/24",
  },
];

/** Trust one address, so attack mode never locks out a known sender. */
function AddTrustedSourceModal({
  organizationId,
  open,
  onClose,
  onAdded,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { client } = useApp();
  const [kind, setKind] = useState<TrustedSourceSummary["kind"]>("ip");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected =
    TRUSTED_KIND_OPTIONS.find((option) => option.kind === kind) ?? TRUSTED_KIND_OPTIONS[0]!;

  const close = () => {
    setError(null);
    setValue("");
    setNote("");
    onClose();
  };

  const submit = async () => {
    if (value.trim() === "") {
      setError("Enter an address to trust.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await addTrustedSource(client, {
      organizationId,
      kind,
      value: value.trim(),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The address could not be trusted.");
      return;
    }
    setValue("");
    setNote("");
    onAdded();
  };

  return (
    <Modal
      title="Trust a source address"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Trust address
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Kind">
          {(id) => (
            <select
              id={id}
              className="input"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as TrustedSourceSummary["kind"]);
                setError(null);
              }}
            >
              {TRUSTED_KIND_OPTIONS.map((option) => (
                <option key={option.kind} value={option.kind}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Address" hint={selected.hint} {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={value}
              onChange={setValue}
              placeholder={selected.placeholder}
              error={Boolean(error)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Note (optional)" hint="What this address is, for the next operator.">
          {(id) => (
            <TextInput id={id} value={note} onChange={setNote} placeholder="GitHub webhooks" />
          )}
        </Field>
        <p className="muted small">
          A trusted address is allowed through before the deny list and before any browser
          challenge. It is validated when stored, so a hostile value can never become edge syntax.
        </p>
      </div>
    </Modal>
  );
}

/** Stop trusting one address. */
function RemoveTrustedSourceModal({
  organizationId,
  source,
  open,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly source: TrustedSourceSummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!source) return null;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await removeTrustedSource(client, {
      organizationId,
      sourceId: source.id,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The address could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Stop trusting address"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <span className="mono">{source.value}</span> ({source.kind}) from the trusted
          sources?
        </p>
        <p className="muted small">
          The address will be challenged and denied like any other sender once attack mode is on.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The rate-limit keys, with the shape each requires.
 *
 * `ip` counts one source address — the scraper case. `header` counts a request
 * header's value, so a customer can budget one API key or tenant without
 * touching the others. `global` counts the route as a whole, for a hard ceiling.
 * These are the three Vercel's firewall exposes for a custom rule, and the three
 * the edge's descriptor can key on without new state.
 */
const RATE_LIMIT_KEY_OPTIONS: readonly {
  readonly key: RateLimitSummary["key"];
  readonly label: string;
  readonly hint: string;
  readonly needsHeader: boolean;
}[] = [
  {
    key: "ip",
    label: "Per source address",
    hint: "One budget per client IP — the scraper case. A normal visitor never reaches it.",
    needsHeader: false,
  },
  {
    key: "header",
    label: "Per request header",
    hint: "One budget per header value, so you can cap a single API key or tenant without capping the rest.",
    needsHeader: true,
  },
  {
    key: "global",
    label: "Whole route",
    hint: "One budget for the route as a whole, across every caller. A hard ceiling, not a per-caller one.",
    needsHeader: false,
  },
];

/** Set a rate limit, so a burst is throttled without touching a normal visitor. */
function AddRateLimitModal({
  organizationId,
  open,
  onClose,
  onAdded,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { client } = useApp();
  const [key, setKey] = useState<RateLimitSummary["key"]>("ip");
  const [headerName, setHeaderName] = useState("x-api-key");
  const [limit, setLimit] = useState("60");
  const [windowSeconds, setWindowSeconds] = useState("60");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected =
    RATE_LIMIT_KEY_OPTIONS.find((option) => option.key === key) ?? RATE_LIMIT_KEY_OPTIONS[0]!;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    const limitNumber = Number(limit);
    const windowNumber = Number(windowSeconds);
    if (!Number.isInteger(limitNumber) || limitNumber < 1) {
      setError("The allowance must be a whole number of requests, at least 1.");
      return;
    }
    if (!Number.isInteger(windowNumber) || windowNumber < 1 || windowNumber > 86_400) {
      setError("The window must be a whole number of seconds, 1 to 86400.");
      return;
    }
    if (selected.needsHeader && headerName.trim() === "") {
      setError("A header-keyed limit needs a header name.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await addRateLimit(client, {
      organizationId,
      key,
      ...(selected.needsHeader ? { headerName: headerName.trim() } : {}),
      limit: limitNumber,
      windowSeconds: windowNumber,
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The rate limit could not be set.");
      return;
    }
    setNote("");
    onAdded();
  };

  return (
    <Modal
      title="Add a rate limit"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Set limit
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Counted by" hint={selected.hint}>
          {(id) => (
            <select
              id={id}
              className="input"
              value={key}
              onChange={(event) => {
                setKey(event.target.value as RateLimitSummary["key"]);
                setError(null);
              }}
            >
              {RATE_LIMIT_KEY_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {selected.needsHeader ? (
          <Field
            label="Header name"
            hint="The header whose value is budgeted, e.g. x-api-key. Letters, digits and dashes only."
          >
            {(id) => (
              <TextInput
                id={id}
                value={headerName}
                onChange={setHeaderName}
                placeholder="x-api-key"
              />
            )}
          </Field>
        ) : null}
        <Field
          label="Allowance"
          hint="Requests allowed in the window. 60 per minute is invisible to a visitor."
        >
          {(id) => <TextInput id={id} value={limit} onChange={setLimit} placeholder="60" />}
        </Field>
        <Field
          label="Window (seconds)"
          hint="How long the allowance lasts before it resets. 60 to 86400."
        >
          {(id) => (
            <TextInput id={id} value={windowSeconds} onChange={setWindowSeconds} placeholder="60" />
          )}
        </Field>
        <Field label="Note (optional)" hint="What this limit is for, for the next operator.">
          {(id) => (
            <TextInput id={id} value={note} onChange={setNote} placeholder="Scraper budget" />
          )}
        </Field>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted small">
          A rate limit is compiled after the allow steps, so a verified crawler or a trusted address
          is never counted. It throttles the disproportionate rather than blocking the hostile.
        </p>
      </div>
    </Modal>
  );
}

/** Remove one rate limit. */
function RemoveRateLimitModal({
  organizationId,
  rateLimit,
  open,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly rateLimit: RateLimitSummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!rateLimit) return null;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await removeRateLimit(client, {
      organizationId,
      rateLimitId: rateLimit.id,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The rate limit could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Remove rate limit"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove the limit of{" "}
          <span className="mono">
            {rateLimit.limit.toLocaleString()} / {formatWindow(rateLimit.windowSeconds)}
          </span>{" "}
          counted by{" "}
          <span className="mono">
            {rateLimit.key === "header" ? `header ${rateLimit.headerName ?? ""}` : rateLimit.key}
          </span>
          ?
        </p>
        <p className="muted small">
          The route stops throttling this traffic once the edge compiles the change. A scraper would
          no longer be capped.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function ActivityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadAudit(client, organizationId),
    [client, organizationId],
    "Recent activity",
  );

  // Export the rows already on screen. It is the newest slice the API returns
  // (200 rows), not the whole history, and the button says so — a file that
  // silently stopped at the cap while looking complete would be a lie.
  const exportCsv = (items: readonly AuditSummary[]) => {
    const blob = new Blob([auditCsv(items)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `cloud-wai-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageShell
      title="Activity"
      subtitle="An append-only record. No role can edit or delete an entry."
    >
      <Card flush>
        <SectionView<AuditSummary>
          section={section}
          onRetry={reload}
          emptyMessage="Nothing recorded yet."
          renderReady={(items) => (
            <div className="stack">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <Button size="sm" onClick={() => exportCsv(items)} disabled={items.length === 0}>
                  Export CSV
                </Button>
              </div>
              <Table
                items={items}
                rowKey={(item) => item.id}
                filterText={(item) => `${item.event} ${item.actorEmail ?? ""}`}
                filterLabel="Filter activity"
                columns={[
                  {
                    key: "event",
                    header: "Event",
                    render: (item) => <span className="mono small">{item.event}</span>,
                  },
                  { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                  {
                    key: "when",
                    header: "When",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                ]}
              />
              <p className="muted small" style={{ margin: 0 }}>
                The export contains the {items.length} most recent entries shown here, not the full
                history.
              </p>
            </div>
          )}
        />
      </Card>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ billing */

/**
 * Billing.
 *
 * An organization-level roll-up of what the engines actually reported, read
 * from `usage_records`. Every number shown is a real recorded quantity, so an
 * empty organization says "no usage recorded yet" rather than rendering a fake
 * zero-balance card. The page makes no claim about money: it reports usage, and
 * the invoice side is a contract the deployment has not wired yet.
 */
export function BillingPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadUsage(client, organizationId),
    [client, organizationId],
    "Usage",
  );
  const budgets = useSection(
    () => loadBudgets(client, organizationId),
    [client, organizationId],
    "Budgets",
  );
  const [editing, setEditing] = useState(false);

  const totals = section.state.kind === "ready" ? section.state.items : [];
  const grandTotal = totals.reduce((sum, item) => sum + item.total, 0);

  return (
    <PageShell
      title="Billing"
      subtitle="Usage recorded for this organization. Every figure comes from an engine's own report."
    >
      <SectionShell title="Recorded usage" hint="Grouped by metric, newest first">
        <div className="grid grid--stats">
          <StatBox label="Metrics" value={String(totals.length)} />
          <StatBox label="Records" value={String(totals.reduce((s, t) => s + t.records, 0))} />
          <StatBox label="Total quantity" value={String(grandTotal)} />
        </div>
        <Card flush>
          <SectionView<UsageTotalSummary>
            section={section}
            onRetry={reload}
            emptyMessage="No usage has been recorded for this organization yet. A deployment or a backup that an engine confirms records one unit here; until one succeeds, this list is empty."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.metric}
                columns={[
                  {
                    key: "metric",
                    header: "Metric",
                    render: (item) => <span className="mono small">{item.metric}</span>,
                  },
                  {
                    key: "total",
                    header: "Total",
                    render: (item) => <span className="mono">{String(item.total)}</span>,
                  },
                  {
                    key: "records",
                    header: "Records",
                    render: (item) => String(item.records),
                  },
                  {
                    key: "last",
                    header: "Last recorded",
                    render: (item) =>
                      item.lastRecordedAt ? (
                        <Timestamp value={item.lastRecordedAt} />
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Spend caps"
        hint="A hard cap refuses new work at the limit"
        actions={
          <Button variant="primary" onClick={() => setEditing(true)}>
            Set a cap
          </Button>
        }
      >
        <Card flush>
          <SectionView<BudgetSummary>
            section={budgets.section}
            onRetry={budgets.reload}
            emptyMessage="No cap is set. Usage is recorded and shown above, but nothing is refused at a limit. Set a hard cap to make the platform stop new deployments or backups once the limit is reached."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.metric}
                columns={[
                  {
                    key: "metric",
                    header: "Metric",
                    render: (item) => <span className="mono small">{item.metric}</span>,
                  },
                  {
                    key: "used",
                    header: "Used this month",
                    render: (item) => (
                      <span className="mono">
                        {item.usedQuantity} / {item.limitQuantity}
                      </span>
                    ),
                  },
                  {
                    key: "ratio",
                    header: "",
                    render: (item) => <BudgetMeter ratio={item.ratio} exceeded={item.exceeded} />,
                  },
                  {
                    key: "enforcement",
                    header: "Enforcement",
                    render: (item) => (
                      <StatusBadge
                        label={item.hardCap ? "Hard cap" : "Soft (informational)"}
                        tone={item.exceeded ? "danger" : item.hardCap ? "progress" : "neutral"}
                      />
                    ),
                  },
                  {
                    key: "actions",
                    header: "",
                    render: (item) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(true)}
                        title="Replace this cap"
                      >
                        Edit
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Invoicing" hint="Not wired in this deployment">
        <Card>
          <p className="small" style={{ margin: 0 }}>
            Usage above is real. Payment collection and invoices need a billing provider this
            deployment has not configured, so there is nothing to pay here yet — and no placeholder
            balance is shown in its place.
          </p>
        </Card>
      </SectionShell>

      <SetBudgetModal
        organizationId={organizationId}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          budgets.reload();
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * A cap's fill level.
 *
 * The bar exists because a ratio is the one number a person reads at a glance,
 * but the exact `used / limit` is printed beside it, so the bar is never the
 * only statement. It is capped at 100% width while the text keeps the true
 * figure, because a bar that overflows its track would misrepresent the ratio.
 */
function BudgetMeter({ ratio, exceeded }: { readonly ratio: number; readonly exceeded: boolean }) {
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div
      className="meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}
    >
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: "var(--border, #333)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: exceeded ? "var(--danger, #f55)" : "var(--accent, #5b8def)",
          }}
        />
      </div>
      <span className="mono small faint">{pct}%</span>
    </div>
  );
}

/**
 * Set or replace one metric's cap.
 *
 * The metric is chosen from the two the worker actually records, so the form
 * cannot create a cap on a quantity nothing writes. A hard cap is the default
 * because that is the control a person came to this page for; turning it off is
 * an explicit, labelled choice.
 */
function SetBudgetModal({
  organizationId,
  open,
  onClose,
  onSaved,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useApp();
  const [metric, setMetric] = useState<string>(USAGE_METRIC_CHOICES[0] ?? "deployments");
  const [limit, setLimit] = useState("10");
  const [hardCap, setHardCap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const close = () => {
    setError(null);
    setBusy(false);
    onClose();
  };

  const submit = async () => {
    const limitQuantity = Number(limit);
    if (!Number.isFinite(limitQuantity) || limitQuantity < 0) {
      setError("Enter a limit of zero or more.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await client.call("billing.budgets.save", {
      organizationId,
      metric,
      limitQuantity,
      hardCap,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The cap could not be saved.");
      return;
    }
    onSaved();
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    const response = await client.call<{ readonly removed: boolean }>("billing.budgets.remove", {
      organizationId,
      metric,
    });
    setRemoving(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The cap could not be removed.");
      return;
    }
    if (!response.data?.removed) {
      setError("There was no cap on that metric to remove.");
      return;
    }
    onSaved();
  };

  return (
    <Modal
      title="Spend cap"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="ghost"
            onClick={() => void remove()}
            busy={removing}
            title="Remove this metric's cap"
          >
            Remove cap
          </Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Save cap
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Metric" hint="Only metrics the platform records can be capped.">
          {(id) => (
            <select
              id={id}
              className="input"
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
            >
              {USAGE_METRIC_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Limit for this month"
          hint="The most units of this metric the organization may record this calendar month."
          {...(error ? { error } : {})}
        >
          {(id) => (
            <TextInput
              id={id}
              value={limit}
              onChange={setLimit}
              type="number"
              error={Boolean(error)}
            />
          )}
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hardCap}
            onChange={(event) => setHardCap(event.target.checked)}
          />
          <span>
            Hard cap — refuse new deployments and backups once the limit is reached. Uncheck for a
            soft, informational budget that blocks nothing.
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ observability */

/**
 * How a job state is labelled and toned.
 *
 * `queued` is progress rather than neutral, and `terminated` is distinct from
 * `failed`: the queue stops a job for a reason of its own (a lease that kept
 * expiring), which is a different fact from the engine reporting an error.
 */
function JobStateBadge({ state }: { readonly state: string }) {
  const presentation: {
    label: string;
    tone: "neutral" | "progress" | "positive" | "warning" | "danger";
  } =
    state === "succeeded"
      ? { label: "Succeeded", tone: "positive" }
      : state === "running"
        ? { label: "Running", tone: "progress" }
        : state === "queued"
          ? { label: "Queued", tone: "progress" }
          : state === "failed"
            ? { label: "Failed", tone: "danger" }
            : state === "terminated"
              ? { label: "Terminated", tone: "warning" }
              : { label: state, tone: "neutral" };
  return <StatusBadge label={presentation.label} tone={presentation.tone} />;
}

/** A duration in a unit a person reads, or an explicit "—" when unknown. */
function Duration({ ms }: { readonly ms: number | null }) {
  if (ms === null) return <span className="faint">—</span>;
  if (ms < 1000) return <span className="mono small">{ms} ms</span>;
  if (ms < 60000) return <span className="mono small">{(ms / 1000).toFixed(1)} s</span>;
  return <span className="mono small">{(ms / 60000).toFixed(1)} min</span>;
}

/** The wall-clock a finished job took, or "not finished" when it has not. */
function JobDuration({ job }: { readonly job: OrchestrationJobSummary }) {
  if (!job.startedAt || !job.finishedAt) {
    return (
      <span className="faint small">{job.state === "queued" ? "Not started" : "In flight"}</span>
    );
  }
  const started = Date.parse(job.startedAt);
  const finished = Date.parse(job.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return <span className="faint">—</span>;
  }
  return <Duration ms={finished - started} />;
}

export function ObservabilityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadObservability(client, organizationId),
    [client, organizationId],
    "Observability",
  );

  const report = section.state.kind === "ready" ? (section.state.items[0] ?? null) : null;

  return (
    <PageShell
      title="Observability"
      subtitle="Every figure here is derived from this organization's own orchestration jobs — the queue rows the worker and the engines wrote. Nothing is sampled or synthetic."
      actions={
        <Button size="sm" onClick={reload}>
          Refresh
        </Button>
      }
    >
      <SectionShell title="Job activity" hint="Since this deployment began recording jobs">
        <Card flush>
          <SectionView<ObservabilityReportSummary>
            section={section}
            onRetry={reload}
            emptyMessage="No orchestration jobs yet. Deployments, backups and policy distributions appear here as soon as this organization runs one. No engine work has been recorded for it so far."
            renderReady={(items) => {
              const current = items[0];
              if (!current) return null;
              return (
                <>
                  <div className="grid grid--stats">
                    <StatBox label="Jobs" value={String(current.totals.jobs)} />
                    <StatBox
                      label="In flight"
                      value={String(current.totals.active)}
                      note="Queued or running"
                    />
                    <StatBox
                      label="Failed"
                      value={String(current.totals.failed)}
                      note="Terminal, engine-reported"
                    />
                    <StatBox
                      label="Retried"
                      value={String(current.totals.retried)}
                      note="More than one attempt"
                    />
                  </div>
                  <div className="grid grid--stats">
                    <StatBox
                      label="Latency p50"
                      value={<Duration ms={current.latency.p50Ms} />}
                      note={`${current.latency.samples} finished ${current.latency.samples === 1 ? "job" : "jobs"}`}
                    />
                    <StatBox label="Latency p95" value={<Duration ms={current.latency.p95Ms} />} />
                    <StatBox label="Slowest" value={<Duration ms={current.latency.maxMs} />} />
                  </div>
                </>
              );
            }}
          />
        </Card>
      </SectionShell>

      {report ? (
        <>
          {(report.throughput ?? []).length > 0 ? (
            <SectionShell
              title="Job throughput"
              hint={`Jobs created per day over the last ${String(report.throughput.length)} days of this organization's activity, newest day last`}
            >
              <Card flush>
                <BarChart
                  ariaLabel="Jobs created per day"
                  unit="jobs"
                  bars={report.throughput.map((entry) => ({
                    label: entry.day.slice(5),
                    value: entry.created,
                    ...(entry.failed > 0 ? { tone: "danger" as const } : {}),
                  }))}
                />
              </Card>
            </SectionShell>
          ) : null}

          <div className="grid">
            <SectionShell
              title="By state"
              hint="Every job in the queue, grouped by its recorded state"
            >
              <Card flush>
                <BarChart
                  ariaLabel="Orchestration jobs by state"
                  bars={report.byState.map((entry) => ({
                    label: entry.state,
                    value: entry.count,
                    ...(entry.state === "failed"
                      ? { tone: "danger" as const }
                      : entry.state === "succeeded"
                        ? { tone: "ok" as const }
                        : {}),
                  }))}
                />
              </Card>
            </SectionShell>

            <SectionShell title="By kind" hint="Most active first">
              <Card flush>
                <BarChart
                  ariaLabel="Orchestration jobs by kind"
                  bars={report.byKind.map((entry) => ({
                    label: entry.kind,
                    value: entry.total,
                    ...(entry.failed > 0 ? { tone: "danger" as const } : {}),
                  }))}
                />
              </Card>
            </SectionShell>
          </div>

          <SectionShell
            title="Failures and retries by kind"
            hint="A kind that fails or retries is visible here rather than averaged into the totals"
          >
            <Card flush>
              <Table
                items={report.byKind}
                rowKey={(item) => item.kind}
                columns={[
                  {
                    key: "kind",
                    header: "Kind",
                    render: (item) => <span className="mono small">{item.kind}</span>,
                  },
                  { key: "total", header: "Jobs", render: (item) => String(item.total) },
                  {
                    key: "failed",
                    header: "Failed",
                    render: (item) =>
                      item.failed > 0 ? (
                        <StatusBadge label={String(item.failed)} tone="danger" dot={false} />
                      ) : (
                        <span className="faint">0</span>
                      ),
                  },
                  {
                    key: "retried",
                    header: "Retried",
                    render: (item) =>
                      item.retried > 0 ? (
                        <StatusBadge label={String(item.retried)} tone="warning" dot={false} />
                      ) : (
                        <span className="faint">0</span>
                      ),
                  },
                  {
                    key: "lastError",
                    header: "Last failure",
                    render: (item) =>
                      item.lastError ? (
                        <span className="small">{item.lastError}</span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                ]}
              />
            </Card>
          </SectionShell>

          <SectionShell title="Jobs" hint="Newest first; filter over the loaded rows">
            <Card flush>
              <Table
                items={report.jobs}
                rowKey={(job) => job.id}
                filterText={(job) => `${job.kind} ${job.state} ${job.lastError ?? ""}`}
                filterLabel="Filter jobs"
                columns={[
                  {
                    key: "state",
                    header: "State",
                    render: (job) => <JobStateBadge state={job.state} />,
                  },
                  {
                    key: "kind",
                    header: "Kind",
                    render: (job) => <span className="mono small">{job.kind}</span>,
                  },
                  {
                    key: "id",
                    header: "Job",
                    render: (job) => <span className="mono small">{job.id.slice(0, 12)}</span>,
                  },
                  {
                    key: "attempts",
                    header: "Attempts",
                    render: (job) => (
                      <span className="mono small">
                        {job.attempts}/{job.maxAttempts}
                      </span>
                    ),
                  },
                  {
                    key: "duration",
                    header: "Duration",
                    render: (job) => <JobDuration job={job} />,
                  },
                  {
                    key: "createdAt",
                    header: "Queued",
                    render: (job) => <Timestamp value={job.createdAt} />,
                  },
                  {
                    key: "lastError",
                    header: "Last error",
                    render: (job) =>
                      job.lastError ? (
                        <span className="small">{job.lastError}</span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                ]}
              />
            </Card>
          </SectionShell>
        </>
      ) : null}

      <SectionShell title="Metrics & traces" hint="Partly derived, partly not wired">
        <Card>
          <p className="small" style={{ margin: 0 }}>
            Job state, throughput, failures and durations above are derived from this organization's
            own queue rows, so they are real without a metrics engine. What is <em>not</em> drawn is
            host-level resource use (CPU, memory) and distributed traces: those need an engine this
            deployment has not configured, so no chart is drawn and no series is invented to fill
            the space. The honest state is that they are absent until an engine is wired.
          </p>
        </Card>
      </SectionShell>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ API keys */

export function ApiKeysPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadApiKeys(client, organizationId),
    [client, organizationId],
    "API keys",
  );
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeySummaryRow | null>(null);

  return (
    <PageShell
      title="API keys"
      subtitle="A key's secret is shown once, at creation, and stored only as a hash. This list can never contain it."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          Create key
        </Button>
      }
    >
      <Card flush>
        <SectionView<ApiKeySummaryRow>
          section={section}
          columns={[
            { key: "name", header: "Name", render: (item) => item.name },
            {
              key: "prefix",
              header: "Prefix",
              render: (item) => <span className="mono small">{item.keyPrefix}</span>,
            },
            {
              key: "scopes",
              header: "Scopes",
              render: (item) => <span className="small">{item.scopes.join(", ") || "—"}</span>,
            },
            {
              key: "state",
              header: "State",
              render: (item) => <ApiKeyStateBadge revokedAt={item.revokedAt} />,
            },
            {
              key: "actions",
              header: "",
              render: (item) =>
                item.revokedAt ? (
                  <span className="small muted">—</span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(item)}>
                    Revoke
                  </Button>
                ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No API keys yet."
        />
      </Card>

      <CreateApiKeyModal
        organizationId={organizationId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      <RevokeApiKeyModal
        organizationId={organizationId}
        apiKey={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * The secret is rendered here and nowhere else.
 *
 * It arrives on the create response, is shown once in a block the operator can
 * copy, and is dropped from component state when the dialog closes. No list, no
 * reload and no audit row ever carries it.
 */
function CreateApiKeyModal({
  organizationId,
  open,
  onClose,
  onCreated,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);

  const reset = () => {
    setName("");
    setScopes([]);
    setError(null);
    setIssued(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<IssuedApiKey>("apiKeys.create", {
      organizationId,
      name,
      scopes,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The key could not be created.");
      return;
    }
    setIssued(response.data);
  };

  const close = () => {
    // The secret leaves state when the dialog does; there is no second chance.
    reset();
    onClose();
  };

  return (
    <Modal
      title={issued ? "Key created" : "Create API key"}
      open={open}
      onClose={close}
      footer={
        issued ? (
          <Button variant="primary" onClick={onCreated}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy} disabled={!name}>
              Create
            </Button>
          </>
        )
      }
    >
      {issued ? (
        <div className="stack">
          <p className="small">
            Copy this secret now. It is shown once and cannot be retrieved again — Cloud Wai stores
            only its hash.
          </p>
          <Field label="Secret">
            {(id) => <TextInput id={id} value={issued.secret} onChange={() => {}} />}
          </Field>
          {issued.key.scopes.length !== scopes.length ? (
            <p className="small muted">
              Granted scopes were narrowed to what your role allows:{" "}
              <span className="mono">{issued.key.scopes.join(", ") || "none"}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <Field label="Name" hint="What this key is for." {...(error ? { error } : {})}>
            {(id) => (
              <TextInput
                id={id}
                value={name}
                onChange={setName}
                placeholder="ci-deploy"
                error={Boolean(error)}
              />
            )}
          </Field>
          <fieldset className="field">
            <legend className="field__label">Scopes</legend>
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope} className="row small">
                  <input
                    type="checkbox"
                    aria-label={scope}
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((s) => s !== scope),
                      )
                    }
                  />
                  <span className="mono">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="small muted">
            Leave every scope unchecked to request none. The server narrows the request to your role
            before storing the key.
          </p>
        </div>
      )}
    </Modal>
  );
}

function RevokeApiKeyModal({
  organizationId,
  apiKey,
  onClose,
  onRevoked,
}: {
  readonly organizationId: string;
  readonly apiKey: ApiKeySummaryRow | null;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!apiKey) return;
    setBusy(true);
    setError(null);
    const response = await client.call<{ revoked: boolean }>("apiKeys.revoke", {
      organizationId,
      keyId: apiKey.id,
    });
    setBusy(false);
    if (!response.ok || !response.data?.revoked) {
      setError(response.error?.message ?? "The key could not be revoked.");
      return;
    }
    onRevoked();
  };

  return (
    <Modal
      title="Revoke API key"
      open={apiKey !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy} disabled={!apiKey}>
            Revoke
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Revoking <span className="mono">{apiKey?.name}</span> takes effect immediately and cannot
          be undone. The key is kept in this list so the record survives.
        </p>
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ settings */

export function SettingsPage({ organizationId }: { readonly organizationId: string }) {
  const { client, session } = useApp();
  const organization = useSection(
    () => loadOrganization(client, organizationId),
    [client, organizationId],
    "Organization",
  );
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Engine status",
  );
  const members = useSection(
    () => loadOrganizationMembers(client, organizationId),
    [client, organizationId],
    "Members",
  );

  const [editing, setEditing] = useState<OrganizationMemberSummary | null>(null);
  const [removing, setRemoving] = useState<OrganizationMemberSummary | null>(null);

  const currentUserId = session.current()?.userId ?? null;
  const memberRows =
    members.section.state.kind === "ready" ? members.section.state.items : [];
  const myRole = memberRows.find((m) => m.userId === currentUserId)?.role ?? null;
  const isOwner = myRole === "owner";
  const canInvite = isOwner || myRole === "admin";

  // The dashboard mirrors the server's rank rules so a control is only offered
  // where it could succeed. It is a courtesy, not the guard: the procedure and
  // the policy both re-check, and a refusal is surfaced if they disagree.
  const canChangeRole = (item: OrganizationMemberSummary) =>
    canInvite && item.userId !== currentUserId && (isOwner || item.role !== "owner");
  const canRemove = (item: OrganizationMemberSummary) => {
    if (item.userId === currentUserId) {
      // Leaving is always allowed, except when you are the last owner.
      return item.role === "owner"
        ? memberRows.filter((m) => m.role === "owner").length > 1
        : true;
    }
    return canInvite && (isOwner || item.role !== "owner");
  };

  const org =
    organization.section.state.kind === "ready" ? organization.section.state.items[0] : undefined;

  return (
    <PageShell
      title="Settings"
      subtitle="Organization profile and the engines this deployment can act on."
    >
      <SectionShell title="Organization">
        <Card>
          {organization.section.state.kind === "loading" ? (
            <LoadingSkeleton title="Organization" />
          ) : org ? (
            <dl className="dl">
              <dt>Name</dt>
              <dd>{org.name}</dd>
              <dt>Slug</dt>
              <dd className="mono">{org.slug}</dd>
              <dt>Id</dt>
              <dd className="mono small">{org.id}</dd>
            </dl>
          ) : (
            <SectionView<OrganizationSummary>
              section={organization.section}
              onRetry={organization.reload}
            />
          )}
        </Card>
      </SectionShell>

      <SectionShell
        title="Members"
        hint="Everyone with access to this organization, and the role that decides what they can do"
      >
        <Card flush>
          <SectionView<OrganizationMemberSummary>
            section={members.section}
            rowKey={(item) => item.userId}
            onRetry={members.reload}
            emptyMessage="This organization has no members recorded."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.userId}
                filterText={(item) => `${item.displayName ?? ""} ${item.email ?? ""} ${item.role}`}
                filterLabel="Filter members"
                columns={[
                  {
                    key: "member",
                    header: "Member",
                    render: (item) => (
                      <span>
                        {item.displayName ?? item.email ?? "Not yet signed in"}
                        {item.userId === currentUserId ? (
                          <span className="faint small"> (you)</span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: "email",
                    header: "Email",
                    render: (item) =>
                      item.email ? (
                        <span className="mono small">{item.email}</span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    render: (item) => (
                      <StatusBadge label={roleLabel(item.role)} tone="neutral" />
                    ),
                  },
                  {
                    key: "since",
                    header: "Added",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                  {
                    key: "actions",
                    header: "",
                    render: (item) => (
                      <div className="row">
                        <Button
                          size="sm"
                          disabled={!canChangeRole(item)}
                          title={
                            item.userId === currentUserId
                              ? "You cannot change your own role."
                              : item.role === "owner" && !isOwner
                                ? "Only an owner can change an owner's role."
                                : undefined
                          }
                          onClick={() => setEditing(item)}
                        >
                          Change role
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={!canRemove(item)}
                          title={
                            item.role === "owner" && !isOwner && item.userId !== currentUserId
                              ? "Only an owner can remove an owner."
                              : undefined
                          }
                          onClick={() => setRemoving(item)}
                        >
                          {item.userId === currentUserId ? "Leave" : "Remove"}
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
          />
        </Card>
        <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
          {canInvite
            ? "Changing a role and removing a member take effect immediately. A member can always remove themselves, which is how you leave an organization. The last owner cannot be demoted or removed, and nobody can change their own role — promotion needs a second party."
            : "Your role can see this list but not change it. Changing roles and removing members needs the admin role; leaving the organization is always available to you."}
        </p>
      </SectionShell>

      <SectionShell
        title="Engine status"
        hint="An engine with no credentials reports not configured"
      >
        <Card flush>
          <SectionView<ProviderHealthRow>
            section={health.section}
            onRetry={health.reload}
            emptyMessage="No engines reported."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.provider}
                columns={[
                  {
                    key: "provider",
                    header: "Engine",
                    render: (item) => <span className="mono">{item.provider}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (item) =>
                      item.state === "ready" ? (
                        <StatusBadge label="Configured" tone="positive" />
                      ) : (
                        <StatusBadge label="Not configured" tone="neutral" />
                      ),
                  },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (item) => <span className="small">{item.detail}</span>,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Release gates" hint="What still needs a real server">
        <Card>
          <ul className="small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
            <li>Deny direct origin access — needs a deployed edge.</li>
            <li>Block CRS attacks — needs Envoy/Coraza on a real VPS.</li>
            <li>Tenant runtime isolation — needs a container runtime.</li>
            <li>Verified backup restore — needs Postgres/MinIO credentials.</li>
          </ul>
        </Card>
      </SectionShell>

      <ChangeMemberRoleModal
        organizationId={organizationId}
        member={editing}
        canGrantOwner={isOwner}
        onClose={() => setEditing(null)}
        onChanged={() => {
          setEditing(null);
          members.reload();
        }}
      />
      <RemoveMemberModal
        organizationId={organizationId}
        member={removing}
        self={removing !== null && removing.userId === currentUserId}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          members.reload();
        }}
      />
    </PageShell>
  );
}

/**
 * Change a member's role.
 *
 * Only the roles the caller could actually grant are offered: an admin sees
 * admin/member/viewer, an owner additionally sees owner. The server is the
 * authority — this modal narrows the choice, it does not replace the guard.
 */
function ChangeMemberRoleModal({
  organizationId,
  member,
  canGrantOwner,
  onClose,
  onChanged,
}: {
  readonly organizationId: string;
  readonly member: OrganizationMemberSummary | null;
  readonly canGrantOwner: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { client } = useApp();
  const [role, setRole] = useState<OrganizationMemberSummary["role"]>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles: readonly OrganizationMemberSummary["role"][] = canGrantOwner
    ? ["owner", "admin", "member", "viewer"]
    : ["admin", "member", "viewer"];

  // The picker opens on the member's current role, so a no-op submit is visible.
  useEffect(() => {
    if (member) {
      setRole(member.role);
      setError(null);
    }
  }, [member]);

  const submit = async () => {
    if (!member) return;
    setBusy(true);
    setError(null);
    const response = await updateMemberRole(client, {
      organizationId,
      memberId: member.userId,
      role,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The role could not be changed.");
      return;
    }
    onChanged();
  };

  return (
    <Modal
      title="Change role"
      open={member !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            busy={busy}
            disabled={!member || member.role === role}
          >
            Save role
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          {member?.displayName ?? member?.email ?? "This member"} is currently{" "}
          <strong>{member ? roleLabel(member.role) : ""}</strong>. The change takes effect
          immediately; the new role decides what they can see and do in this organization.
        </p>
        <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="small muted">New role</legend>
          {roles.map((option) => (
            <label key={option} className="row small" style={{ gap: "var(--space-2)" }}>
              <input
                type="radio"
                name="member-role"
                checked={role === option}
                onChange={() => setRole(option)}
              />
              <span>{roleLabel(option)}</span>
            </label>
          ))}
        </fieldset>
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Remove a member, or leave the organization.
 *
 * The wording changes when the target is the caller: "Leave" is a normal
 * action, and saying so is the difference between a scary dialog and an honest
 * one. The last owner cannot be removed, and the server says so if it is tried.
 */
function RemoveMemberModal({
  organizationId,
  member,
  self,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly member: OrganizationMemberSummary | null;
  readonly self: boolean;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [member]);

  const submit = async () => {
    if (!member) return;
    setBusy(true);
    setError(null);
    const response = await removeMember(client, { organizationId, memberId: member.userId });
    setBusy(false);
    if (!response.ok || !response.data?.removed) {
      setError(response.error?.message ?? "The member could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title={self ? "Leave organization" : "Remove member"}
      open={member !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy} disabled={!member}>
            {self ? "Leave" : "Remove"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          {self ? (
            <>
              You will lose access to this organization and everything in it. This takes effect
              immediately and cannot be undone — an owner would have to add you back.
            </>
          ) : (
            <>
              {member?.displayName ?? member?.email ?? "This member"} will lose access to this
              organization immediately. The membership row is deleted; their other organizations are
              unaffected.
            </>
          )}
        </p>
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** A membership role, spelled for a reader. */
function roleLabel(role: OrganizationMemberSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    case "viewer":
      return "Viewer";
  }
}

/* ------------------------------------------------------------------ not found */

export function NotFoundPage({ path }: { readonly path: string }) {
  return (
    <PageShell title="Not found" subtitle={`No route matches ${path}.`}>
      <EmptyState
        title="Nothing here"
        message="The address does not match any section. Use the sidebar or the command palette to navigate."
      />
    </PageShell>
  );
}

export type { Route };
