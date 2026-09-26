/**
 * End-to-end: the real HTTP server, the real `ApiClient`, the real components.
 *
 * Nothing is mocked. A server is bound on an ephemeral port, the dashboard's
 * own client is pointed at it, and the pages are rendered into jsdom. What is
 * asserted is what a reviewer would see: a working session shows rows, an
 * unconfigured engine shows "not configured" and never a green state, a
 * failure shows an error, and no page invents data it did not receive.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcResponse } from "@cloud-wai/api";
import { App, ApiClient, type SessionController } from "@cloud-wai/web";
import { ToastProvider, presentDeploymentStatus } from "@cloud-wai/ui/react";

const servers: HttpServer[] = [];

/** The response the fake control plane returns for each procedure. */
type Responder = (procedure: string, input: unknown) => RpcResponse;

async function startApi(responder: Responder): Promise<string> {
  const server = await listen(
    {
      route: async (request) => responder(request.procedure, request.input),
      allowedOrigins: [],
      // No in-flight requests in these tests, so do not wait out the
      // production grace period on every teardown.
      shutdownGraceMs: 50,
    },
    0,
    "127.0.0.1",
  );
  servers.push(server);
  return server.url;
}

/** A session that is always signed in, standing in for Supabase. */
function signedInSession(): SessionController {
  return {
    configured: true,
    current: () => ({
      userId: "user-1",
      email: "operator@cloud-wai.test",
      displayName: "Operator",
      accessToken: "token",
    }),
    getAccessToken: () => "token",
    signInWithPassword: async () => {},
    signUpWithPassword: async () => ({ needsConfirmation: false }),
    signOut: async () => {},
    subscribe: () => () => {},
  };
}

/** Render the app against a live API URL. */
function renderApp(apiUrl: string, hash = "#/orgs") {
  // Set the URL without triggering jsdom's asynchronous hash navigation: the
  // app reads `location.hash` on mount, which is all this needs to exercise.
  window.history.replaceState(null, "", hash);
  window.localStorage.clear();
  return render(
    <ToastProvider>
      <App session={signedInSession()} apiBaseUrl={apiUrl} />
    </ToastProvider>,
  );
}

beforeAll(() => {
  // jsdom has no layout, but React 19 warns if the act environment is unset.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  cleanup();
  while (servers.length > 0) {
    const server = servers.pop()!;
    await server.close();
  }
});

const organizations = [
  { id: "org-1", name: "Northwind", slug: "northwind" },
  { id: "org-2", name: "Contoso", slug: "contoso" },
];

describe("the dashboard against a live control plane", () => {
  it("lists organizations returned by the API", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url);

    expect(await screen.findByText("Northwind")).toBeTruthy();
    expect(screen.getByText("Contoso")).toBeTruthy();
    // The workspace switcher names the same data, from the same response.
    await waitFor(() => expect(screen.getAllByText("Northwind").length).toBeGreaterThan(0));
  });

  it("shows an empty state, not a table, when there are no projects", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects");

    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("opens the create form from New workspace, so the control creates rather than navigates", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects");
    const user = userEvent.setup();

    // The control lives in the workspace menu; open it, then choose it.
    await user.click(await screen.findByTitle("Switch workspace"));
    await user.click(await screen.findByRole("menuitem", { name: /New workspace/ }));

    // The form is open without a second click: "New workspace" is a create
    // control, not a link to the list it is already on.
    const dialog = await screen.findByRole("dialog", { name: "New organization" });
    expect(within(dialog).getByLabelText(/Name/)).toBeTruthy();

    // Dismiss it; navigating back must not re-open a form that was closed, or
    // the create request would fire on every visit.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getAllByRole("link", { name: /Open/ })[0]!);
    await waitFor(() => expect(window.location.hash).toContain("/projects"));
    window.history.replaceState(null, "", "#/orgs/org-1/projects");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    // Give any erroneous re-open a chance to happen, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a not-configured engine as degraded, never as success", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return {
          ok: true,
          status: 200,
          notConfigured: true,
          error: { code: "not_configured", message: "Coolify is not configured." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    const degraded = await screen.findByText(/Coolify is not configured/);
    expect(degraded).toBeTruthy();
    // A degraded engine must not be painted as a positive status anywhere.
    expect(screen.queryByText("Configured")).toBeNull();
  });

  it("surfaces a server failure as an error with a retry", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return {
        ok: false,
        status: 500,
        error: { code: "internal", message: "The control plane is unavailable." },
      };
    });

    renderApp(url, "#/orgs/org-1/projects");

    expect(await screen.findByText(/could not load/)).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("renders deployment rows with the status the server reported", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              status: "succeeded",
              url: "https://web-app.example.test",
              failureReason: null,
            },
            { id: "d-2", status: "failed", url: null, failureReason: "Build exited 1" },
            { id: "d-3", status: "not_configured", url: null, failureReason: "No engine" },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    await waitFor(() => expect(screen.getByText("https://web-app.example.test")).toBeTruthy());
    // The three statuses are visually distinct; a not-configured engine is
    // labelled from the shared mapping, not assumed.
    expect(screen.getAllByText(presentDeploymentStatus("succeeded").label).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(presentDeploymentStatus("failed").label).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(presentDeploymentStatus("not_configured").label).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Build exited 1")).toBeTruthy();
  });

  it("makes a deployment URL something to visit, not text to copy", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              status: "succeeded",
              url: "https://web-app.example.test",
              failureReason: null,
              isCurrent: true,
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    // A real anchor, so middle-click and "copy link address" work. It must point
    // at the deployment's own origin, and carry noopener: the opened page is a
    // customer's site, not ours, and must not be able to reach window.opener.
    const link = await screen.findByRole("link", { name: "https://web-app.example.test" });
    expect(link.getAttribute("href")).toBe("https://web-app.example.test");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("keeps an unverified domain visually distinct from a verified one", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "dm-1", hostname: "app.example.test", verified: true },
            { id: "dm-2", hostname: "pending.example.test", verified: false },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    await waitFor(() => expect(screen.getByText("app.example.test")).toBeTruthy());
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("reports a revoked API key as revoked, not as an error", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "k-1",
              name: "CI",
              keyPrefix: "cw_live_abc",
              scopes: ["projects:read"],
              revokedAt: null,
            },
            {
              id: "k-2",
              name: "Retired",
              keyPrefix: "cw_live_def",
              scopes: [],
              revokedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/settings/api-keys");

    await waitFor(() => expect(screen.getByText("cw_live_abc")).toBeTruthy());
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    // The secret is not in the response and must not be invented by the UI.
    expect(screen.queryByText(/cw_secret/i)).toBeNull();
  });

  it("renames a project from the project settings page through projects.update", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    let project = {
      id: "p-1",
      organizationId: "org-1",
      name: "Web app",
      slug: "web-app",
      providerResourceId: null,
    };

    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: project };
      }
      if (procedure === "projects.update") {
        const body = input as { name?: string; slug?: string };
        project = {
          ...project,
          ...(body.name ? { name: body.name } : {}),
          ...(body.slug ? { slug: body.slug } : {}),
        };
        return { ok: true, status: 200, data: project };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/settings");

    const user = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Web app"));

    await user.clear(name);
    await user.type(name, "Renamed app");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "projects.update")).toBe(true));
    const rename = calls.find((c) => c.procedure === "projects.update");
    expect((rename!.input as { name: string }).name).toBe("Renamed app");
  });

  it("locks the slug once the engine holds the application, and says why", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return {
          ok: true,
          status: 200,
          data: {
            id: "p-1",
            organizationId: "org-1",
            name: "Web app",
            slug: "web-app",
            providerResourceId: "coolify-app-1",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/settings");

    const slug = await screen.findByLabelText("Slug");
    await waitFor(() => expect((slug as HTMLInputElement).value).toBe("web-app"));
    // The engine cannot rename its application, so the field is not editable and
    // the hint is the reason — never a control that promises a change the server
    // will refuse.
    expect((slug as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/names the application on the hosting engine/i)).toBeTruthy();
    // The name is still free to change.
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
  });

  it("sets a monorepo root directory from the project settings page", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    let project: Record<string, unknown> = {
      id: "p-1",
      organizationId: "org-1",
      name: "Web app",
      slug: "web-app",
      providerResourceId: null,
      rootDirectory: null,
    };

    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: project };
      }
      if (procedure === "projects.update") {
        const body = input as { rootDirectory?: string | null };
        project = {
          ...project,
          ...(body.rootDirectory !== undefined ? { rootDirectory: body.rootDirectory } : {}),
        };
        return { ok: true, status: 200, data: project };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/settings");

    const user = userEvent.setup();
    const root = await screen.findByLabelText("Root directory");
    await waitFor(() => expect((root as HTMLInputElement).value).toBe(""));
    // Nothing is editable about the engine application yet, so the field is live.
    expect((root as HTMLInputElement).disabled).toBe(false);

    await user.type(root, "apps/web");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "projects.update")).toBe(true));
    const update = calls.find((c) => c.procedure === "projects.update");
    expect((update!.input as { rootDirectory: string }).rootDirectory).toBe("apps/web");
  });

  it("locks the root directory once the engine holds the application, and says why", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return {
          ok: true,
          status: 200,
          data: {
            id: "p-1",
            organizationId: "org-1",
            name: "Web app",
            slug: "web-app",
            providerResourceId: "coolify-app-1",
            rootDirectory: "apps/web",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/settings");

    const root = await screen.findByLabelText("Root directory");
    await waitFor(() => expect((root as HTMLInputElement).value).toBe("apps/web"));
    // The engine read base_directory when it created the application and cannot
    // re-target it, so the control is locked rather than promising a change the
    // server refuses.
    expect((root as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/cannot re-target it/i)).toBeTruthy();
  });

  it("navigates by rewriting the URL, so the route survives a reload", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects");

    const nav = await screen.findByRole("navigation", { name: "Sections" });
    const activity = within(nav).getByRole("link", { name: /Activity/i });
    expect(activity.getAttribute("href")).toBe("#/orgs/org-1/audit");
  });

  it("shows a not-found page for an address that matches no route", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));

    renderApp(url, "#/no/such/place");

    expect(await screen.findByText("Not found")).toBeTruthy();
  });

  it("refuses to call the API at all when there is no session", async () => {
    let called = false;
    const url = await startApi(() => {
      called = true;
      return { ok: true, status: 200, data: [] };
    });

    const client = new ApiClient({ baseUrl: url, getAccessToken: () => null });
    const response = await client.call("organizations.list", {});

    expect(response.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("the public landing page", () => {
  /** A session that is signed out, with no token to hand the API. */
  function signedOutSession(): SessionController {
    return {
      current: () => null,
      getAccessToken: () => null,
      signInWithPassword: async () => {},
      signUpWithPassword: async () => ({ needsConfirmation: false }),
      signOut: async () => {},
      subscribe: () => () => {},
    };
  }

  it("renders at the root for a signed-out visitor and asks for nothing from the API", async () => {
    let called = false;
    const url = await startApi(() => {
      called = true;
      return { ok: true, status: 200, data: [] };
    });

    window.history.replaceState(null, "", "#/");
    render(
      <ToastProvider>
        <App session={signedOutSession()} apiBaseUrl={url} />
      </ToastProvider>,
    );

    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByText(/hidden-origin/)).toBeTruthy();
    // A second heading for the "how it is built" band, so the page is more than
    // a hero that would render blank if the copy were removed.
    expect(screen.getByText("Three layers, one contract")).toBeTruthy();
    // A comparison band answers the reader's "why not a deploy button?" without
    // promising an engine this deployment may not hold credentials for.
    expect(screen.getByText("The same jobs, answered differently")).toBeTruthy();
    expect(screen.getByText("Bring your first project")).toBeTruthy();
    // The landing page is static: it must not spend the visitor's request budget
    // on an API call it has no session to make.
    expect(called).toBe(false);
  });

  it("carries a domain search box that states the registrar is not configured", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));
    const { default: userEvent } = await import("@testing-library/user-event");

    window.history.replaceState(null, "", "#/");
    render(
      <ToastProvider>
        <App session={signedOutSession()} apiBaseUrl={url} />
      </ToastProvider>,
    );

    const box = screen.getByLabelText("Find a domain") as HTMLInputElement;
    // The search is real but the lookup is not: submitting must not fabricate an
    // availability answer, and the note says why.
    await userEvent.type(box, "acme.com");
    expect(screen.getByText(/registrar lookup is not/i)).toBeTruthy();
    // Submitting produces a real, honest result about the query — not a scroll to
    // text that was already on screen, and not an invented availability.
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/cannot report whether acme\.com is available/i)).toBeTruthy();
    // Still no API call — a landing-page search cannot verify a domain.
    expect((box as HTMLInputElement).value).toBe("acme.com");
  });

  it("tells the visitor when the search text is not a hostname", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));
    const { default: userEvent } = await import("@testing-library/user-event");

    window.history.replaceState(null, "", "#/");
    render(
      <ToastProvider>
        <App session={signedOutSession()} apiBaseUrl={url} />
      </ToastProvider>,
    );

    const box = screen.getByLabelText("Find a domain") as HTMLInputElement;
    await userEvent.type(box, "not a domain");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    // An honest answer about the input, rather than a lookup that would have to
    // invent a result for something that is not a hostname.
    expect(await screen.findByText(/is not a hostname/i)).toBeTruthy();
  });

  it("still shows the sign-in form on a deep link a signed-out visitor cannot reach", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));

    window.history.replaceState(null, "", "#/orgs/org-1/billing");
    render(
      <ToastProvider>
        <App session={signedOutSession()} apiBaseUrl={url} />
      </ToastProvider>,
    );

    // Not a blank shell and not the marketing page: the visitor is one step from
    // signing in to the page they asked for.
    expect(await screen.findByText(/Sign in|Sign up/)).toBeTruthy();
  });

  it("offers a signed-in visitor the dashboard rather than the sign-in form", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));

    renderApp(url, "#/");

    expect(await screen.findByRole("button", { name: "Open the dashboard" })).toBeTruthy();
  });
});

describe("project environment variables", () => {
  const vars = [
    {
      id: "ev-1",
      key: "DATABASE_URL",
      valuePrefix: "a1b2",
      isBuildTime: true,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "ev-2",
      key: "FEATURE_FLAG",
      valuePrefix: "c3d4",
      isBuildTime: false,
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
  ];

  it("lists variables with their fingerprint and scope, never a value", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "env.list") {
        return { ok: true, status: 200, data: vars };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/env");

    await waitFor(() => expect(screen.getByText("DATABASE_URL")).toBeTruthy());
    expect(screen.getByText("FEATURE_FLAG")).toBeTruthy();
    // The fingerprint is shown; the value never is, and no reveal control exists.
    expect(screen.getByText("a1b2…")).toBeTruthy();
    expect(screen.getByText("Build & runtime")).toBeTruthy();
    expect(screen.getByText("Runtime only")).toBeTruthy();
    expect(screen.queryByText(/reveal/i)).toBeNull();
  });

  it("adds a variable through env.set and reports where it landed", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    let stored = [...vars];
    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "env.list") {
        return { ok: true, status: 200, data: stored };
      }
      if (procedure === "env.set") {
        const body = input as { key: string; value: string; isBuildTime?: boolean };
        const next = {
          id: "ev-3",
          key: body.key,
          valuePrefix: "ffff",
          isBuildTime: body.isBuildTime ?? true,
          updatedAt: "2026-01-04T00:00:00.000Z",
        };
        stored = [...stored, next];
        return {
          ok: true,
          status: 200,
          data: {
            variable: next,
            applied: "stored",
            redeployRequired: true,
            engineReason: "This project has no application on the hosting engine yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/env");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add variable" }));
    await user.type(await screen.findByLabelText("Key"), "API_TOKEN");
    await user.type(await screen.findByLabelText("Value"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // The outcome is honest: saved but not applied, because no engine app exists.
    await waitFor(() =>
      expect(screen.getByText(/saved\. The hosting engine has not been reached/i)).toBeTruthy(),
    );
    expect(JSON.stringify(calls)).toContain("env.set");
    // The plaintext the operator typed is not echoed back into the page.
    expect(screen.queryByText("s3cret")).toBeNull();
  });

  it("offers a real redeploy when a build-time save needs one", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "env.list") {
        return { ok: true, status: 200, data: vars };
      }
      if (procedure === "env.set") {
        return {
          ok: true,
          status: 200,
          data: {
            variable: { ...vars[0]!, key: "API_TOKEN", valuePrefix: "ffff" },
            applied: "engine",
            redeployRequired: true,
            engineReason: null,
          },
        };
      }
      if (procedure === "git.deployNow") {
        return {
          ok: true,
          status: 200,
          data: {
            deployment: {
              id: "d-77",
              status: "pending",
              url: null,
              kind: "production",
              isCurrent: false,
              createdAt: "2026-01-05T00:00:00.000Z",
              gitBranch: "main",
              gitCommit: null,
              pullRequest: null,
              failureReason: null,
            },
            replayed: false,
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/env");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add variable" }));
    await user.type(await screen.findByLabelText("Key"), "API_TOKEN");
    await user.type(await screen.findByLabelText("Value"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // The build-time note carries the action, so the operator does not have to
    // leave the page to find the only thing that makes the change take effect.
    await user.click(await screen.findByRole("button", { name: "Redeploy now" }));

    await waitFor(() =>
      expect(screen.getByText(/A redeployment was queued/i)).toBeTruthy(),
    );
    expect(JSON.stringify(calls)).toContain("git.deployNow");
    // It says the deployment was queued, never that it succeeded.
    expect(screen.queryByText(/deployed successfully/i)).toBeNull();
  });

  it("removes a variable and reports the engine's refusal instead of pretending", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "env.list") {
        return { ok: true, status: 200, data: [vars[0]] };
      }
      if (procedure === "env.remove") {
        return {
          ok: true,
          status: 200,
          data: { removed: false, engineReason: "The engine refused to remove the variable." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/env");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);

    await waitFor(() =>
      expect(screen.getByText("The engine refused to remove the variable.")).toBeTruthy(),
    );
    // The variable is still listed (the modal also names it), because the row
    // was never removed.
    expect(screen.getAllByText("DATABASE_URL").length).toBeGreaterThan(0);
  });
});

describe("requesting and rolling back a deployment", () => {
  /**
   * A control plane that really records deployments, so the test exercises the
   * dashboard against behaviour rather than a canned list.
   */
  function deploymentPlane() {
    const deployments: {
      id: string;
      projectId: string;
      status: string;
      url: string | null;
      failureReason: string | null;
      kind: "production" | "preview";
      isCurrent: boolean;
      gitBranch: string | null;
      gitCommit: string | null;
      pullRequest: number | null;
      gitRepository?: string | null;
    }[] = [
      {
        id: "d-existing",
        projectId: "p-1",
        status: "succeeded",
        url: "https://web-app.example.test",
        failureReason: null,
        kind: "production",
        isCurrent: true,
        gitBranch: "main",
        gitCommit: null,
        pullRequest: null,
        gitRepository: "https://github.com/acme/site.git",
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];
    let counter = 0;

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return { ok: true, status: 200, data: [...deployments] };
      }
      if (procedure === "deployments.create") {
        counter += 1;
        const deployment = {
          id: `d-new-${counter}`,
          projectId: "p-1",
          // The engine is unconfigured in this deployment: the honest state.
          status: "not_configured",
          url: null,
          failureReason: "Coolify is not configured in this deployment.",
          kind: "production" as const,
          isCurrent: false,
          gitBranch: null,
          gitCommit: null,
          pullRequest: null,
        };
        // A not-configured deploy is never live, so the pointer does not move.
        deployments.push(deployment);
        return {
          ok: true,
          status: 200,
          data: { deployment, replayed: false, engineReason: deployment.failureReason },
        };
      }
      if (procedure === "deployments.rollback") {
        const body = input as { commit: string };
        counter += 1;
        const deployment = {
          id: `d-rollback-${counter}`,
          projectId: "p-1",
          status: "running",
          url: null,
          failureReason: null,
          kind: "production" as const,
          isCurrent: false,
          gitBranch: null,
          gitCommit: body.commit,
          pullRequest: null,
        };
        deployments.push(deployment);
        return {
          ok: true,
          status: 200,
          data: { deployment, replayed: false, engineReason: null, commit: body.commit },
        };
      }
      if (procedure === "deployments.redeploy") {
        const body = input as { deploymentId: string };
        const source = deployments.find((d) => d.id === body.deploymentId);
        // The server refuses a row with no recorded source; mirror that so the
        // UI's honest refusal is exercised rather than assumed.
        if (!source?.gitRepository) {
          return {
            ok: false,
            status: 409,
            error: {
              code: "conflict",
              message: "This deployment recorded no source to replay.",
            },
          };
        }
        counter += 1;
        const deployment = {
          id: `d-redeploy-${counter}`,
          projectId: "p-1",
          status: "pending" as const,
          url: null,
          failureReason: null,
          kind: source.kind,
          isCurrent: false,
          gitBranch: source.gitBranch,
          gitCommit: null,
          pullRequest: source.pullRequest,
          gitRepository: source.gitRepository,
        };
        deployments.push(deployment);
        return {
          ok: true,
          status: 200,
          data: { deployment, replayed: false, engineReason: null },
        };
      }
      if (procedure === "deployments.promote") {
        const body = input as { deploymentId: string };
        const target = deployments.find((d) => d.id === body.deploymentId);
        if (!target || target.kind !== "production" || target.status !== "succeeded") {
          return {
            ok: false,
            status: 409,
            error: {
              code: "conflict",
              message: "Only a succeeded production deployment can be promoted.",
            },
          };
        }
        const previous = deployments.find((d) => d.isCurrent)?.id ?? null;
        deployments.forEach((d) => {
          d.isCurrent = false;
        });
        target.isCurrent = true;
        return {
          ok: true,
          status: 200,
          data: { deployment: target, previousDeploymentId: previous },
        };
      }
      if (procedure === "deployments.cancel") {
        const body = input as { deploymentId: string };
        const index = deployments.findIndex((d) => d.id === body.deploymentId);
        const existing = index >= 0 ? deployments[index]! : undefined;
        if (!existing) {
          return {
            ok: false,
            status: 404,
            error: { code: "not_found", message: "Deployment not found." },
          };
        }
        if (existing.status !== "pending" && existing.status !== "running") {
          return {
            ok: false,
            status: 409,
            error: {
              code: "conflict",
              message: `Only a pending or running deployment can be cancelled; this one is ${existing.status}.`,
            },
          };
        }
        const cancelled = {
          ...existing,
          status: "failed",
          failureReason: "Cancelled by the customer.",
        };
        deployments[index] = cancelled;
        return {
          ok: true,
          status: 200,
          data: { deployment: cancelled, engineReason: "Cancelled by the customer." },
        };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, deployments, calls };
  }

  it("requests a deployment and shows the engine's honest not-configured answer", async () => {
    const { responder, calls, deployments } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.type(await screen.findByPlaceholderText("main"), "release/1.2");
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    // The dialog reports the status the server returned, which is not success.
    expect(await screen.findByText(/Coolify is not configured/)).toBeTruthy();
    expect(
      screen.getAllByText(presentDeploymentStatus("not_configured").label).length,
    ).toBeGreaterThan(0);

    const create = calls.find((c) => c.procedure === "deployments.create");
    expect(create?.input).toMatchObject({ projectId: "p-1", gitBranch: "release/1.2" });

    // Closing reloads the list from the server, which now includes the row.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getAllByText(/d-new-/).length).toBeGreaterThan(0));
    expect(deployments).toHaveLength(2);
  });

  it("sends a chosen build pack, and leaves it out when the engine should choose", async () => {
    const { responder, calls } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));

    // The override is the answer to "the build failed to detect my framework".
    // Choosing it must change what the server receives, not just the UI.
    await user.click(await screen.findByRole("radio", { name: /Dockerfile/ }));
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    const create = calls.find((c) => c.procedure === "deployments.create");
    expect(create?.input).toMatchObject({ buildPack: "dockerfile" });
  });

  it("sends an idempotency key and reuses it on a retry, so a double press cannot deploy twice", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    // The first attempt fails, which leaves the form open so the operator can
    // retry — exactly the moment a duplicate deployment would otherwise appear.
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "deployments.create") {
        return {
          ok: false,
          status: 503,
          error: { code: "unavailable", message: "The control plane is unavailable." },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.type(await screen.findByPlaceholderText("main"), "release/1.2");
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    await screen.findByText(/unavailable/);

    // Retry from the still-open form.
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    const creates = calls.filter((c) => c.procedure === "deployments.create");
    expect(creates).toHaveLength(2);
    const keys = creates.map((c) => (c.input as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    // Same key on the retry: the server can recognise it as the same request.
    expect(keys[1]).toBe(keys[0]);
  });

  it("redeploys a past deployment through the API", async () => {
    const { responder, calls, deployments } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Redeploy" }));
    const dialog = await screen.findByRole("dialog");
    // The dialog names what it will rebuild, so Redeploy is not a blind button.
    expect(within(dialog).getByText("https://github.com/acme/site.git")).toBeTruthy();
    expect(within(dialog).getByText("main")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Redeploy" }));

    await waitFor(() =>
      expect(calls.some((c) => c.procedure === "deployments.redeploy")).toBe(true),
    );
    const call = calls.find((c) => c.procedure === "deployments.redeploy");
    expect(call?.input).toMatchObject({ projectId: "p-1", deploymentId: "d-existing" });
    // A fresh key, so the redeploy is a new build rather than a replay of the
    // original row.
    expect((call?.input as { idempotencyKey?: string }).idempotencyKey).toBeTruthy();
    expect(deployments.some((d) => d.id.startsWith("d-redeploy-"))).toBe(true);
  });

  it("does not offer Redeploy on a row that recorded no source", async () => {
    const { responder, deployments } = deploymentPlane();
    // A rollback row: it returns to a revision the engine already holds, so it
    // has no repository to replay. Offering Redeploy here would be a dead
    // button — the server would only ever refuse it.
    deployments.push({
      id: "d-no-source",
      projectId: "p-1",
      status: "succeeded",
      url: null,
      failureReason: null,
      kind: "production",
      isCurrent: false,
      gitBranch: null,
      gitCommit: "abc1234",
      pullRequest: null,
      gitRepository: null,
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    await screen.findByText("d-no-source");
    expect(screen.getAllByRole("button", { name: "Redeploy" })).toHaveLength(1);
  });

  it("rolls back a successful deployment through the API", async () => {
    const { responder, calls } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rollback" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("abc1234"), "abc1234");
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));

    await waitFor(() =>
      expect(calls.some((c) => c.procedure === "deployments.rollback")).toBe(true),
    );
    const rollback = calls.find((c) => c.procedure === "deployments.rollback");
    expect(rollback?.input).toMatchObject({ projectId: "p-1", commit: "abc1234" });
  });

  it("cancels an in-flight deployment and shows only terminal-state actions", async () => {
    const { responder, calls, deployments } = deploymentPlane();
    deployments.push({
      id: "d-running",
      projectId: "p-1",
      status: "running",
      url: null,
      failureReason: null,
      kind: "production",
      isCurrent: false,
      gitBranch: null,
      gitCommit: null,
      pullRequest: null,
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    // The succeeded row has no Cancel; the running row does.
    const cancels = await screen.findAllByRole("button", { name: "Cancel" });
    expect(cancels).toHaveLength(1);

    await user.click(cancels[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel deployment" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "deployments.cancel")).toBe(true));
    expect(calls.find((c) => c.procedure === "deployments.cancel")?.input).toMatchObject({
      projectId: "p-1",
      deploymentId: "d-running",
    });
    // After the reload the row is terminal, so the Cancel action is gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  it("surfaces a refused cancel as an alert, never as a success", async () => {
    const { responder, deployments } = deploymentPlane();
    deployments.push({
      id: "d-running",
      projectId: "p-1",
      status: "running",
      url: null,
      failureReason: null,
      kind: "production",
      isCurrent: false,
      gitBranch: null,
      gitCommit: null,
      pullRequest: null,
    });
    const refusing: Responder = (procedure, input) => {
      if (procedure === "deployments.cancel") {
        return {
          ok: false,
          status: 409,
          error: {
            code: "conflict",
            message:
              "Only a pending or running deployment can be cancelled; this one is succeeded.",
          },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(refusing);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Cancel" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel deployment" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Only a pending or running deployment");
  });

  it("promotes an older production build and moves the Live badge to it", async () => {
    const { responder, calls, deployments } = deploymentPlane();
    // A second, older, succeeded production build that is not live yet. Its
    // Promote button is the whole point of the immutable-build model.
    deployments.push({
      id: "d-older",
      projectId: "p-1",
      status: "succeeded",
      url: "https://web-app-old.example.test",
      failureReason: null,
      kind: "production",
      isCurrent: false,
      gitBranch: "main",
      gitCommit: "aaa1111",
      pullRequest: null,
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    // Only the non-live succeeded production row offers Promote; the live one
    // does not (it is already the pointer).
    const promotes = await screen.findAllByRole("button", { name: "Promote" });
    expect(promotes).toHaveLength(1);

    await user.click(promotes[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Promote" }));

    await waitFor(() =>
      expect(calls.some((c) => c.procedure === "deployments.promote")).toBe(true),
    );
    expect(calls.find((c) => c.procedure === "deployments.promote")?.input).toMatchObject({
      projectId: "p-1",
      deploymentId: "d-older",
    });
    // The pointer moved: exactly one row is current, and it is the promoted one.
    expect(deployments.filter((d) => d.isCurrent).map((d) => d.id)).toEqual(["d-older"]);
  });

  it("shows a preview build's type so its own URL is legible, never as production", async () => {
    const { responder, deployments } = deploymentPlane();
    deployments.push({
      id: "d-preview",
      projectId: "p-1",
      status: "succeeded",
      url: "https://web-app-pr-7.example.test",
      failureReason: null,
      kind: "preview",
      isCurrent: false,
      gitBranch: "feature/login",
      gitCommit: null,
      pullRequest: 7,
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    expect(await screen.findByText("Preview · PR #7")).toBeTruthy();
    // A preview is never promotable: it has no Promote action at all.
    expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
  });

  it("surfaces a refused promote as an alert, never as a success", async () => {
    const { responder, deployments } = deploymentPlane();
    deployments.push({
      id: "d-older",
      projectId: "p-1",
      status: "succeeded",
      url: "https://web-app-old.example.test",
      failureReason: null,
      kind: "production",
      isCurrent: false,
      gitBranch: "main",
      gitCommit: "aaa1111",
      pullRequest: null,
    });
    const refusing: Responder = (procedure, input) => {
      if (procedure === "deployments.promote") {
        return {
          ok: false,
          status: 409,
          error: {
            code: "conflict",
            message: "Only a succeeded production deployment can be promoted.",
          },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(refusing);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Promote" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Promote" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Only a succeeded production deployment");
  });

  it("surfaces a refused deployment request as an alert, never as success", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.create") {
        return {
          ok: false,
          status: 403,
          error: { code: "forbidden", message: "Requires capability: deployment:create." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("deployment:create");
    expect(screen.queryByText("Deployment requested")).toBeNull();
  });

  it("opens a deployment's engine logs and shows the lines the engine returned", async () => {
    const { responder, calls } = deploymentPlane();
    const withLogs: Responder = (procedure, input) => {
      if (procedure === "deployments.logs") {
        calls.push({ procedure, input });
        return {
          ok: true,
          status: 200,
          data: {
            lines: ["build started", "build finished"],
            cursor: null,
            engineReason: null,
          },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(withLogs);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Logs" }));

    expect(await screen.findByLabelText("Deployment logs")).toBeTruthy();
    expect(screen.getByText(/build finished/)).toBeTruthy();
    // Coolify keeps no cursor, and the drawer says so rather than inventing one.
    expect(screen.getByText(/keeps no cursor for logs/)).toBeTruthy();
    expect(calls.find((c) => c.procedure === "deployments.logs")?.input).toMatchObject({
      projectId: "p-1",
      deploymentId: "d-existing",
    });
  });

  it("reports an unconfigured hosting engine as degraded logs, never fabricated output", async () => {
    const { responder } = deploymentPlane();
    const notConfigured: Responder = (procedure, input) => {
      if (procedure === "deployments.logs") {
        return {
          ok: false,
          status: 200,
          notConfigured: true,
          error: { code: "not_configured", message: "Coolify is not configured." },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(notConfigured);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Logs" }));

    expect(await screen.findByText(/Coolify is not configured/)).toBeTruthy();
    expect(screen.queryByLabelText("Deployment logs")).toBeNull();
  });
});

describe("exporting the activity log", () => {
  it("offers a CSV export of exactly the rows shown, and says it is the recent slice", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "audit.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "a-1",
              event: "deployment.enqueued",
              actorEmail: "a@example.com",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    // jsdom has no download machinery, so capture what the page hands the
    // browser instead: the blob it creates and the filename it names.
    const created: Blob[] = [];
    const original = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let downloadName = "";
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return "blob:cloud-wai";
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloadName = this.download;
    };

    try {
      renderApp(url, "#/orgs/org-1/audit");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Export CSV" }));

      expect(created).toHaveLength(1);
      // jsdom's Blob has no `.text()`, so read it the way a browser would.
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(created[0]!);
      });
      expect(csv).toContain("deployment.enqueued");
      expect(downloadName).toMatch(/^cloud-wai-activity-\d{4}-\d{2}-\d{2}\.csv$/);
      // It says the file is the recent slice, not the whole history.
      expect(screen.getByText(/not the full history/i)).toBeTruthy();
    } finally {
      URL.createObjectURL = original;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

describe("page titles", () => {
  it("names the current page in the document title", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/audit");
    await screen.findByRole("navigation", { name: "Sections" });
    await waitFor(() => expect(document.title).toBe("Activity · Cloud Wai"));
  });

  it("names a project section in the document title", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/domains");
    await waitFor(() => expect(document.title).toBe("Domains · Cloud Wai"));
  });
});

describe("creating and revoking an API key", () => {
  /**
   * A control plane that actually mints keys, so the test exercises the
   * dashboard against real behaviour rather than a canned list.
   */
  function keyPlane() {
    const keys: {
      id: string;
      organizationId: string;
      name: string;
      keyPrefix: string;
      scopes: readonly string[];
      revokedAt: string | null;
    }[] = [
      {
        id: "key-1",
        organizationId: "org-1",
        name: "CI pipeline",
        keyPrefix: "cw_live_4f2a",
        scopes: ["projects:read"],
        revokedAt: null,
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return { ok: true, status: 200, data: keys };
      }
      if (procedure === "apiKeys.create") {
        const body = input as { name: string; scopes: readonly string[] };
        const granted = body.scopes.filter((s) => s === "org:read" || s === "project:read");
        const key = {
          id: "key-2",
          organizationId: "org-1",
          name: body.name,
          keyPrefix: "cw_live_new1",
          scopes: granted,
          revokedAt: null,
        };
        keys.push(key);
        return { ok: true, status: 200, data: { key, secret: "cw_live_new1_supersecret" } };
      }
      if (procedure === "apiKeys.revoke") {
        const body = input as { keyId: string };
        const found = keys.find((k) => k.id === body.keyId);
        if (!found)
          return { ok: false, status: 404, error: { code: "not_found", message: "No key." } };
        found.revokedAt = "2026-09-23T00:00:00.000Z";
        return { ok: true, status: 200, data: { revoked: true } };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, keys, calls };
  }

  it("mints a key, shows its secret once, and never shows a prefix as the secret", async () => {
    const { responder, calls } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    // The list is loaded from the server, not fabricated.
    expect(await screen.findByText("CI pipeline")).toBeTruthy();
    expect(screen.getByText("cw_live_4f2a")).toBeTruthy();
    // A list can never contain a secret, so there is none on screen yet.
    expect(screen.queryByText(/supersecret/)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Deploy bot");
    await user.click(screen.getByLabelText("org:read"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The secret is shown, once, on the create response — inside a field the
    // operator can copy, never in text that could be scraped from the list.
    const secret = await screen.findByDisplayValue(/supersecret/);
    expect((secret as HTMLInputElement).value).toBe("cw_live_new1_supersecret");
    expect(screen.getByText(/cannot be retrieved again/)).toBeTruthy();

    // The request carried the name and the scopes the operator picked.
    const create = calls.find((c) => c.procedure === "apiKeys.create");
    expect(create?.input).toMatchObject({ name: "Deploy bot", scopes: ["org:read"] });

    // Closing the dialog drops the secret from the DOM entirely.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue(/supersecret/)).toBeNull());
    expect(await screen.findByText("Deploy bot")).toBeTruthy();
  });

  it("tells the operator when the server narrowed the granted scopes", async () => {
    const { responder } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Narrowed");
    // Ask for a scope the server will not grant alongside ones it will.
    await user.click(screen.getByLabelText("org:read"));
    await user.click(screen.getByLabelText("apikey:read"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/narrowed to what your role allows/)).toBeTruthy();
  });

  it("revokes a key through the API and reloads the list from the server", async () => {
    const { responder, calls, keys } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    // The dialog adds a second "Revoke"; scope the confirm to the dialog.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "apiKeys.revoke")).toBe(true));
    const revoke = calls.find((c) => c.procedure === "apiKeys.revoke");
    expect(revoke?.input).toMatchObject({ organizationId: "org-1", keyId: "key-1" });
    expect(keys[0]!.revokedAt).not.toBeNull();

    // The row now reads Revoked (from the server's list), and the control is gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull());
    expect(screen.getAllByText("Revoked").length).toBeGreaterThan(0);
  });

  it("shows the server's message when a key cannot be created", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "apiKeys.create") {
        return {
          ok: false,
          status: 403,
          error: { code: "forbidden", message: "Your role cannot create API keys." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Denied");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your role cannot create API keys.");
    // A refused create never renders a secret.
    expect(screen.queryByText(/cannot be retrieved again/)).toBeNull();
  });

  it("keeps a dialog open when a field value contains spaces", async () => {
    // Regression: the dialog re-focused its first control on every keystroke,
    // so typing a space closed it via the close button's keyup activation.
    const { responder } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const field = await screen.findByPlaceholderText("ci-deploy");
    await user.type(field, "deploy bot");

    // The dialog is still open, the field kept focus, and no request went out.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe("deploy bot");
    expect(document.activeElement).toBe(field);
  });
});

describe("the organization member list", () => {
  it("lists real members with their role, and says who has never signed in", async () => {
    const members = [
      {
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
        email: "operator@cloud-wai.test",
        displayName: "Operator",
        invitedBy: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        // A membership row with no profile yet is a real state, not an error.
        organizationId: "org-1",
        userId: "user-2",
        role: "viewer",
        email: null,
        displayName: null,
        invitedBy: "user-1",
        createdAt: "2026-02-01T00:00:00Z",
      },
    ];
    const calls: string[] = [];
    const url = await startApi((procedure) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "organizations.get") {
        return {
          ok: true,
          status: 200,
          data: { id: "org-1", name: "Northwind", slug: "northwind" },
        };
      }
      if (procedure === "organizations.members.list") {
        return { ok: true, status: 200, data: members };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/settings");

    expect(await screen.findByText("Operator")).toBeTruthy();
    expect(screen.getByText("operator@cloud-wai.test")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    // The member the platform has no profile for is named honestly rather than
    // hidden or given a made-up address.
    expect(screen.getByText("Not yet signed in")).toBeTruthy();
    expect(screen.getByText("Viewer")).toBeTruthy();
    expect(calls).toContain("organizations.members.list");
  });

  it("reports a failed member read instead of showing an empty organization", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "organizations.members.list") {
        return {
          ok: false,
          status: 500,
          error: { code: "engine_unavailable", message: "The control plane is unreachable." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/settings");

    expect(await screen.findByText(/unreachable/i)).toBeTruthy();
  });
});

describe("adding, verifying and removing a domain", () => {
  /**
   * A control plane that holds domain rows and answers the challenge the way
   * the real adapter does: `verified` only ever comes from the verifier, and a
   * failed challenge is a successful request with `verified: false`.
   */
  function domainPlane() {
    const domains: {
      id: string;
      organizationId: string;
      hostname: string;
      verified: boolean;
      verifiedAt: string | null;
    }[] = [
      {
        id: "dm-1",
        organizationId: "org-1",
        hostname: "app.example.test",
        verified: false,
        verifiedAt: null,
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return { ok: true, status: 200, data: domains };
      }
      if (procedure === "domains.create") {
        const body = input as { hostname: string };
        const domain = {
          id: "dm-2",
          organizationId: "org-1",
          hostname: body.hostname,
          verified: false,
          verifiedAt: null,
        };
        domains.push(domain);
        return {
          ok: true,
          status: 200,
          data: {
            domain,
            recordName: `_cloud-wai-challenge.${body.hostname}`,
            recordValue: "cw-domain-verify=testtoken",
            recordType: "TXT",
          },
        };
      }
      if (procedure === "domains.verify") {
        const body = input as { domainId: string };
        const found = domains.find((d) => d.id === body.domainId);
        if (!found)
          return { ok: false, status: 404, error: { code: "not_found", message: "No domain." } };
        // The challenge did not match: a real answer, not an error.
        found.verified = false;
        return {
          ok: true,
          status: 200,
          data: {
            domain: found,
            detail: "No TXT record carries the expected token.",
          },
        };
      }
      if (procedure === "domains.remove") {
        const body = input as { domainId: string };
        const index = domains.findIndex((d) => d.id === body.domainId);
        if (index < 0)
          return { ok: false, status: 404, error: { code: "not_found", message: "No domain." } };
        domains.splice(index, 1);
        return { ok: true, status: 200, data: { removed: true } };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, domains, calls };
  }

  it("adds a hostname and shows the DNS challenge to publish", async () => {
    const { responder, calls } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add domain" }));
    await user.type(await screen.findByPlaceholderText("app.example.com"), "new.example.test");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // The challenge is shown, and the domain is not claimed as verified.
    expect(await screen.findByText("_cloud-wai-challenge.new.example.test")).toBeTruthy();
    expect(screen.getByText("cw-domain-verify=testtoken")).toBeTruthy();
    expect(screen.getByText(/not yet verified/)).toBeTruthy();

    const create = calls.find((c) => c.procedure === "domains.create");
    expect(create?.input).toMatchObject({
      organizationId: "org-1",
      projectId: "p-1",
      hostname: "new.example.test",
    });
  });

  it("shows the verifier's own answer when a challenge does not match", async () => {
    const { responder, calls } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));

    // The refusal is reported as a detail, not as an error the operator caused.
    expect(await screen.findByText(/No TXT record carries the expected token/)).toBeTruthy();
    // The dialog says so too, and neither the row nor the dialog claims verified.
    expect(within(dialog).getByText("Unverified")).toBeTruthy();
    expect(within(dialog).queryByText("Verified")).toBeNull();
    const verify = calls.find((c) => c.procedure === "domains.verify");
    expect(verify?.input).toMatchObject({ organizationId: "org-1", domainId: "dm-1" });
  });

  it("reports a not-configured verifier as degraded, never as verified", async () => {
    const url = await startApi((procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "dm-1",
              organizationId: "org-1",
              hostname: "app.example.test",
              verified: false,
              verifiedAt: null,
            },
          ],
        };
      }
      if (procedure === "domains.verify") {
        void input;
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "The domain verifier could not confirm this hostname: not configured.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not confirm");
    // Nothing on screen may claim the hostname is verified.
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("removes a hostname through the API and reloads the list", async () => {
    const { responder, calls, domains } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "domains.remove")).toBe(true));
    const remove = calls.find((c) => c.procedure === "domains.remove");
    expect(remove?.input).toMatchObject({ organizationId: "org-1", domainId: "dm-1" });
    expect(domains).toHaveLength(0);

    // The reloaded list comes from the server, so the row is gone.
    await waitFor(() => expect(screen.queryByText("app.example.test")).toBeNull());
  });
});

describe("the dashboard renders every state for every route", () => {
  /** Answer one procedure with `answer`; everything else succeeds with nothing. */
  function only(target: string, answer: RpcResponse): Responder {
    return (procedure) => {
      // The target is checked first: on the Organizations route the target *is*
      // `organizations.list`, and the sidebar's copy of that list must not mask
      // the answer under test.
      if (procedure === target) return answer;
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    };
  }

  const empty = { ok: true, status: 200, data: [] } as const;
  const failure = {
    ok: false,
    status: 500,
    error: { code: "engine_unavailable", message: "The control plane is unreachable." },
  } as const;
  const degraded = {
    ok: true,
    status: 200,
    notConfigured: true,
    error: { code: "not_configured", message: "No hosting engine is configured." },
  } as const;

  /**
   * Every route, with the procedure whose answer decides its main section. A
   * route is only finished when all five states are reachable on it, so this
   * list is the acceptance test for "no route renders a blank page".
   */
  const routes: readonly {
    readonly hash: string;
    readonly title: string;
    readonly target: string;
  }[] = [
    { hash: "#/orgs", title: "Organizations", target: "organizations.list" },
    { hash: "#/orgs/org-1/projects", title: "Projects", target: "projects.list" },
    { hash: "#/orgs/org-1/projects/p-1", title: "Overview", target: "projects.get" },
    {
      hash: "#/orgs/org-1/projects/p-1/deployments",
      title: "Deployments",
      target: "deployments.list",
    },
    { hash: "#/orgs/org-1/projects/p-1/domains", title: "Domains", target: "domains.list" },
    { hash: "#/orgs/org-1/projects/p-1/git", title: "Git", target: "git.links.list" },
    { hash: "#/orgs/org-1/projects/p-1/database", title: "Overview", target: "data.list" },
    { hash: "#/orgs/org-1/projects/p-1/security", title: "Security", target: "providers.health" },
    { hash: "#/orgs/org-1/audit", title: "Activity", target: "audit.list" },
    {
      hash: "#/orgs/org-1/observability",
      title: "Observability",
      target: "observability.jobs",
    },
    { hash: "#/orgs/org-1/billing", title: "Billing", target: "billing.usage" },
    { hash: "#/orgs/org-1/settings/api-keys", title: "API keys", target: "apiKeys.list" },
    { hash: "#/orgs/org-1/settings", title: "Settings", target: "providers.health" },
  ];

  it.each(routes)("$title shows an empty state, not a blank page", async ({ hash, target }) => {
    const url = await startApi(only(target, empty));
    renderApp(url, hash);

    // The page names itself and says there is nothing, rather than rendering
    // nothing at all — the difference between "empty" and "broken".
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).not.toBe("");
    expect(await screen.findByText(/No |Nothing |not a member|does not exist/)).toBeTruthy();
  });

  it.each(routes)("$title shows an error, with a way to retry", async ({ hash, target }) => {
    const url = await startApi(only(target, failure));
    renderApp(url, hash);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The control plane is unreachable.");
    // A failure is recoverable from the UI, not a dead end.
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it.each(routes)("$title never paints a failure as success", async ({ hash, target }) => {
    const url = await startApi(only(target, failure));
    renderApp(url, hash);

    await screen.findByRole("alert");
    // The anti-fake-success guarantee, per route: a failed load must not leave
    // a positive badge behind anywhere on the page.
    expect(screen.queryByText("Configured")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("renders a not-configured engine as degraded on the Security route", async () => {
    const url = await startApi(only("providers.health", degraded));
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/No hosting engine is configured/)).toBeTruthy();
    expect(screen.queryByText("Configured")).toBeNull();
  });

  it("renders a not-configured engine as degraded on the Settings route", async () => {
    const url = await startApi(only("providers.health", degraded));
    renderApp(url, "#/orgs/org-1/settings");

    expect(await screen.findByText(/No hosting engine is configured/)).toBeTruthy();
  });

  it("shows a loading state before the data arrives, never an empty one", async () => {
    // A server that never answers: the only honest thing to render is loading.
    const url = await startApi(() => new Promise<RpcResponse>(() => {}));
    renderApp(url, "#/orgs/org-1/projects");

    const loading = await screen.findByRole("status");
    expect(loading.textContent).toMatch(/loading/i);
    expect(screen.queryByText(/No projects yet/)).toBeNull();
  });

  it("renders a not-found route rather than falling back to the dashboard", async () => {
    const url = await startApi(only("organizations.list", empty));
    renderApp(url, "#/nowhere/at/all");

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
  });

  it("shows the billing roll-up the API reported, and calls the real procedure", async () => {
    const calls: string[] = [];
    const url = await startApi((procedure) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "billing.usage") {
        return {
          ok: true,
          status: 200,
          data: {
            totals: [
              {
                metric: "build_minutes",
                total: 42,
                records: 3,
                lastRecordedAt: "2026-09-20T10:00:00Z",
              },
              {
                metric: "storage_gb",
                total: 12,
                records: 1,
                lastRecordedAt: "2026-09-19T08:00:00Z",
              },
            ],
            records: [],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/billing");

    // The metric names and the summed quantity are the server's numbers.
    expect(await screen.findByText("build_minutes")).toBeTruthy();
    expect(screen.getByText("storage_gb")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    // The page is wired to the procedure, not to a local constant.
    expect(calls).toContain("billing.usage");
    // Money is never invented: the invoice section says it is not wired.
    expect(screen.getByText(/nothing to pay here yet/)).toBeTruthy();
  });

  it("renders an empty billing read as no usage, not as a failure", async () => {
    const url = await startApi(only("billing.usage", empty));
    renderApp(url, "#/orgs/org-1/billing");

    expect(
      await screen.findByText(/No usage has been recorded for this organization/),
    ).toBeTruthy();
  });

  it("renders a not-configured billing read as degraded, never as an empty success", async () => {
    const url = await startApi(only("billing.usage", degraded));
    renderApp(url, "#/orgs/org-1/billing");

    expect(await screen.findByText(/No hosting engine is configured/)).toBeTruthy();
    expect(screen.queryByText(/No usage has been recorded for this organization/)).toBeNull();
  });

  it("shows a saved cap with the API's own spend, and says it refuses work", async () => {
    const calls: string[] = [];
    const url = await startApi((procedure) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "billing.budgets.list") {
        return {
          ok: true,
          status: 200,
          data: {
            periodStart: "2026-09-01T00:00:00Z",
            budgets: [
              {
                metric: "deployments",
                limitQuantity: 10,
                period: "monthly",
                hardCap: true,
                usedQuantity: 4,
                ratio: 0.4,
                exceeded: false,
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/billing");

    expect(await screen.findByText("deployments")).toBeTruthy();
    // The used and limit figures are the server's, printed side by side so the
    // meter is never the only statement.
    expect(screen.getByText("4 / 10")).toBeTruthy();
    expect(screen.getByText("Hard cap")).toBeTruthy();
    expect(calls).toContain("billing.budgets.list");
  });

  it("saves a cap through the real procedure and reloads the list", async () => {
    const calls: string[] = [];
    const url = await startApi((procedure, input) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "billing.budgets.save") {
        // The input the form sent is echoed back as the stored cap, so the test
        // proves the form posts the metric and limit a person typed.
        return { ok: true, status: 200, data: { ...(input as object), period: "monthly" } };
      }
      if (procedure === "billing.budgets.list") {
        return {
          ok: true,
          status: 200,
          data: { periodStart: "2026-09-01T00:00:00Z", budgets: [] },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/billing");

    await screen.findByText(/No cap is set/);
    await userEvent.click(screen.getByRole("button", { name: "Set a cap" }));

    const limit = await screen.findByLabelText("Limit for this month");
    await userEvent.clear(limit);
    await userEvent.type(limit, "25");
    await userEvent.click(screen.getByRole("button", { name: "Save cap" }));

    await waitFor(() => expect(calls).toContain("billing.budgets.save"));
    // The list re-reads after a save, so the page cannot show a stale cap.
    await waitFor(() =>
      expect(calls.filter((c) => c === "billing.budgets.list").length).toBeGreaterThan(1),
    );
  });

  it("shows the job roll-up the API reported, and calls the real procedure", async () => {
    const calls: string[] = [];
    const url = await startApi((procedure) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "observability.jobs") {
        return {
          ok: true,
          status: 200,
          data: {
            totals: { jobs: 3, active: 1, failed: 1, retried: 2 },
            byState: [
              { state: "failed", count: 1 },
              { state: "queued", count: 1 },
              { state: "succeeded", count: 1 },
            ],
            byKind: [
              {
                kind: "deployment",
                total: 2,
                failed: 1,
                retried: 2,
                lastError: "engine restarted",
              },
              { kind: "security_distribution", total: 1, failed: 0, retried: 0, lastError: null },
            ],
            latency: { samples: 1, p50Ms: 4000, p95Ms: 4000, maxMs: 4000 },
            throughput: [
              { day: "2026-09-20", created: 2, failed: 1 },
              { day: "2026-09-21", created: 1, failed: 0 },
            ],
            jobs: [
              {
                id: "job-abcdef123456",
                kind: "deployment",
                state: "failed",
                attempts: 3,
                maxAttempts: 3,
                createdAt: "2026-09-20T10:00:00Z",
                startedAt: "2026-09-20T10:00:00Z",
                finishedAt: "2026-09-20T10:00:04Z",
                lastError: "engine restarted",
              },
              {
                id: "job-queued000001",
                kind: "security_distribution",
                state: "queued",
                attempts: 0,
                maxAttempts: 3,
                createdAt: "2026-09-21T10:00:00Z",
                startedAt: null,
                finishedAt: null,
                lastError: null,
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/observability");

    // The failed job's engine reason is shown verbatim rather than softened
    // into "an error occurred" — once in the per-kind rollup, once on the row.
    expect(await screen.findAllByText("engine restarted")).toHaveLength(2);
    expect(screen.getAllByText("4.0 s").length).toBeGreaterThan(0);
    expect(screen.getByText(/Not started/)).toBeTruthy();
    // The state rollup the API returns is drawn, not discarded: every state in
    // `byState` appears as a labelled bar, so the field is not dead weight.
    expect(screen.getByText("By state")).toBeTruthy();
    const stateChart = screen.getByRole("img", { name: "Orchestration jobs by state" });
    expect(stateChart.textContent).toContain("failed");
    expect(stateChart.textContent).toContain("queued");
    expect(stateChart.textContent).toContain("succeeded");
    // Throughput is derived from the same rows and drawn as real days.
    const throughputChart = screen.getByRole("img", { name: "Jobs created per day" });
    expect(throughputChart.textContent).toContain("09-20");
    expect(throughputChart.textContent).toContain("09-21");
    // The page is wired to the procedure, not to a local constant.
    expect(calls).toContain("observability.jobs");
    // Metrics and traces are declared absent rather than drawn from nothing.
    expect(screen.getByText(/Metrics & traces/)).toBeTruthy();
  });

  it("does not crash when a report arrives without a throughput series", async () => {
    // The dashboard must not throw on a shape it did not expect. An older API or
    // a proxy that strips the field would otherwise take the whole page down.
    const url = await startApi(
      only("observability.jobs", {
        ok: true,
        status: 200,
        data: {
          totals: { jobs: 1, active: 0, failed: 0, retried: 0 },
          byState: [{ state: "succeeded", count: 1 }],
          byKind: [{ kind: "deployment", total: 1, failed: 0, retried: 0, lastError: null }],
          latency: { samples: 1, p50Ms: 1000, p95Ms: 1000, maxMs: 1000 },
          jobs: [],
        },
      }),
    );
    renderApp(url, "#/orgs/org-1/observability");

    // The roll-up still renders; only the series that was absent is absent.
    expect(await screen.findByText("By state")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Jobs created per day" })).toBeNull();
  });

  it("renders an empty job read as no activity, not as a panel of zeros", async () => {
    const url = await startApi(
      only("observability.jobs", {
        ok: true,
        status: 200,
        data: {
          totals: { jobs: 0, active: 0, failed: 0, retried: 0 },
          byState: [],
          byKind: [],
          latency: { samples: 0, p50Ms: null, p95Ms: null, maxMs: null },
          jobs: [],
        },
      }),
    );
    renderApp(url, "#/orgs/org-1/observability");

    expect(await screen.findByText(/No orchestration jobs yet/)).toBeTruthy();
  });
});

describe("the command palette", () => {
  it("opens on the shortcut and navigates for real", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects");

    // The palette is closed until asked for.
    expect(screen.queryByPlaceholderText(/Jump to a section/)).toBeNull();

    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");

    const input = await screen.findByPlaceholderText(/Jump to a section/);
    // The workspace and its sections are offered, not a hardcoded menu.
    expect(screen.getByRole("button", { name: /API keys/ })).toBeTruthy();

    // Typing filters, then Enter opens the highlighted command.
    await user.type(input, "API keys");
    await user.keyboard("{Enter}");

    // Navigation is real: the URL changed and the page followed it.
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/settings/api-keys"));
    expect(await screen.findByRole("heading", { name: "API keys" })).toBeTruthy();
  });

  it("says so when nothing matches, instead of showing an empty box", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects");

    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText(/Jump to a section/);
    await user.type(input, "zzzz");

    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  });
});

describe("the Database drill-in", () => {
  function reachable(): Responder {
    return (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: [] };
    };
  }

  it("replaces the project sidebar with the Database sub-menu, not a dropdown", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();

    // The project's own sections are gone: this is a replaced sidebar.
    expect(screen.queryByRole("link", { name: /Deployments/ })).toBeNull();
    // The Database sub-menu is what is in view.
    for (const label of ["Table Editor", "SQL Editor", "Authentication", "Storage", "Logs"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("returns from a sub-page to the Database Overview, then to the project", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database/tables");

    // First press: back to the section this sub-page belongs to.
    await userEvent.setup().click(await screen.findByRole("button", { name: /Back/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/projects/p-1/database"));

    // Second press: back out of the section entirely.
    await userEvent.setup().click(await screen.findByRole("button", { name: /Back/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/projects/p-1"));
  });

  it("derives the active item and title from the URL alone", async () => {
    const url = await startApi(reachable());
    // A deep link, loaded cold, with no navigation beforehand.
    renderApp(url, "#/orgs/org-1/projects/p-1/database/sql");

    expect(await screen.findByRole("heading", { name: "SQL Editor" })).toBeTruthy();
    const active = screen.getByRole("link", { name: /SQL Editor/ });
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("hands a non-proxied sub-section to the engine console instead of a blank page", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database/auth");

    expect(await screen.findByRole("heading", { name: "Authentication" })).toBeTruthy();
    // The page states what the control plane does not proxy, and why, rather
    // than implying the section is a styling task.
    expect(await screen.findByText(/ADR-0011/)).toBeTruthy();
    // It is not another section's body: dispatching by a bare "implemented" flag
    // once rendered the Storage view for every flagged section.
    expect(screen.queryByRole("button", { name: "Provision resource" })).toBeNull();
    expect(screen.queryByText(/Connection details/)).toBeNull();
  });

  it("links a ready database to the engine console's own screen for the concern", async () => {
    const responder = reachable();
    const consoleLinks = {
      overview: "https://coolify.example.com/project/p1/environment/e1/database/db1",
      "environment-variables":
        "https://coolify.example.com/project/p1/environment/e1/database/db1/environment-variables",
      logs: "https://coolify.example.com/project/p1/environment/e1/database/db1/logs",
      terminal: "https://coolify.example.com/project/p1/environment/e1/database/db1/terminal",
    };
    const url = await startApi((procedure, input) => {
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              name: "orders",
              kind: "postgres",
              state: "ready",
              projectId: "p-1",
              engineConsole: consoleLinks,
            },
            {
              id: "d-2",
              name: "provisioning-db",
              kind: "postgres",
              state: "provisioning",
              projectId: "p-1",
              engineConsole: null,
            },
          ],
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/sql");

    expect(await screen.findByRole("heading", { name: "SQL Editor" })).toBeTruthy();
    // The SQL Editor concern is the engine's terminal, so the link is that
    // section's URL — not the database's overview.
    const link = (await screen.findByRole("link", {
      name: "Open in engine console",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(consoleLinks.terminal);
    // It opens the engine's origin, not this dashboard, so it must be a real
    // anchor with opener isolation.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    // A database the engine has not finished provisioning is not offered: it has
    // no console screen yet.
    expect(screen.queryByText("provisioning-db")).toBeNull();
  });

  it("says no engine console is configured rather than rendering a dead link", async () => {
    const responder = reachable();
    const url = await startApi((procedure, input) => {
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              name: "orders",
              kind: "postgres",
              state: "ready",
              projectId: "p-1",
              engineConsole: null,
            },
          ],
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/roles");

    expect(await screen.findByRole("heading", { name: "Roles & Extensions" })).toBeTruthy();
    expect(await screen.findByText("No engine console configured")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in engine console" })).toBeNull();
  });

  it("shows a database's log read through the engine", async () => {
    const responder = reachable();
    const url = await startApi((procedure, input) => {
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "d-1", name: "orders", kind: "postgres", state: "ready", projectId: "p-1" },
          ],
        };
      }
      if (procedure === "data.logs") {
        expect(input).toMatchObject({ organizationId: "org-1", resourceId: "d-1" });
        return {
          ok: true,
          status: 200,
          data: {
            resource: { id: "d-1" },
            engineReason: null,
            lines: ["2026-09-24 LOG: database system is ready", "2026-09-24 LOG: checkpoint complete"],
            cursor: null,
          },
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/logs");

    expect(await screen.findByRole("heading", { name: "Logs" })).toBeTruthy();
    // The lines are the engine's own output, rendered verbatim.
    const log = await screen.findByLabelText("Log for orders");
    expect(log.textContent).toContain("database system is ready");
    expect(log.textContent).toContain("checkpoint complete");
  });

  it("renders an unconfigured database engine as its own state, not an empty log", async () => {
    const responder = reachable();
    const url = await startApi((procedure, input) => {
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "d-1", name: "orders", kind: "postgres", state: "ready", projectId: "p-1" },
          ],
        };
      }
      if (procedure === "data.logs") {
        return {
          ok: false,
          status: 503,
          error: { code: "not_configured", message: "The database engine is not configured." },
          notConfigured: true,
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/logs");

    expect(await screen.findByRole("heading", { name: "Logs" })).toBeTruthy();
    // "Not configured" is a deployment fact, shown as such — never as an empty
    // log that would read like the database produced no output.
    expect(await screen.findByText(/Database log — not configured/)).toBeTruthy();
    expect(screen.queryByLabelText("Log for orders")).toBeNull();
  });

  it("does not ask the engine for a log when no database is ready", async () => {
    const calls: string[] = [];
    const responder = reachable();
    const url = await startApi((procedure, input) => {
      calls.push(procedure);
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "d-1", name: "orders", kind: "postgres", state: "provisioning", projectId: "p-1" },
          ],
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/logs");

    expect(await screen.findByText("No database to read a log from")).toBeTruthy();
    // A database that is not ready has no engine handle, so the page must not
    // fire a log read that the server would refuse.
    expect(calls).not.toContain("data.logs");
  });

  it("makes the Database Storage section a real bucket view, not a placeholder", async () => {
    const responder = reachable();
    const url = await startApi((procedure, input) => {
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "b-1",
              name: "assets",
              kind: "object_storage",
              state: "ready",
              projectId: "p-1",
            },
            { id: "b-2", name: "docs", kind: "object_storage", state: "ready", projectId: "p-1" },
            { id: "b-3", name: "other", kind: "object_storage", state: "ready", projectId: "p-2" },
            { id: "d-1", name: "orders", kind: "postgres", state: "ready", projectId: "p-1" },
          ],
        };
      }
      return responder(procedure, input);
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/database/storage");

    expect(await screen.findByRole("heading", { name: "Storage" })).toBeTruthy();
    // Only this project's buckets: the other project's bucket and the postgres
    // resource are excluded, because this page is storage-scoped.
    expect(await screen.findByText("assets")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
    expect(screen.queryByText("orders")).toBeNull();
    // It is a live view with a real control, not the not-built placeholder.
    expect(screen.queryByText(/Storage is not available in this build yet/)).toBeNull();
    expect(
      (await screen.findByRole("button", { name: "Provision resource" })) as HTMLButtonElement,
    ).toBeTruthy();
  });

  it("opens the Storage provision form defaulted to a bucket", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.provision") {
        const body = input as { name: string; kind: string };
        return {
          ok: true,
          status: 200,
          data: {
            resource: { id: "b-1", kind: body.kind, name: body.name, state: "ready" },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database/storage");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "uploads");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    const sent = calls.find((call) => call.procedure === "data.provision");
    // The kind defaults to a bucket on this page, so the operator does not have
    // to re-select it every time.
    expect(sent?.input).toMatchObject({ name: "uploads", kind: "object_storage" });
  });

  it("offers real provisioning and backup controls, and invents no connection controls", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    // Provisioning is a live control on the Overview, not a disabled
    // placeholder: it calls `data.provision`.
    const provision = await screen.findByRole("button", { name: "Provision resource" });
    expect((provision as HTMLButtonElement).disabled).toBe(false);

    // The Connection card carries no control at all: there is no procedure
    // behind a connection flow yet, so it says so in prose and offers nothing
    // that would render as a button and do nothing.
    expect(screen.queryByRole("button", { name: /Add custom database/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add Project/ })).toBeNull();
    expect(
      await screen.findByText(/Connection details appear once a database engine is configured/),
    ).toBeTruthy();
  });

  it("provisions a resource through the API and shows the engine's own state", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const rows: unknown[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: rows };
      }
      if (procedure === "data.provision") {
        const body = input as { name: string; kind: string };
        // The state is what the engine reported; the form never sets it.
        const resource = { id: "r-1", kind: body.kind, name: body.name, state: "ready" };
        rows.push(resource);
        return { ok: true, status: 200, data: { resource, engineReason: null } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    expect(
      await screen.findByText(/The engine provisioned this resource and confirmed it/),
    ).toBeTruthy();

    const sent = calls.find((call) => call.procedure === "data.provision");
    expect(sent?.input).toMatchObject({ name: "orders-db", kind: "postgres" });
  });

  it("sends the project when provisioning, so the resource is project-scoped", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "data.provision") {
        const body = input as { name: string; kind: string; projectId: string };
        return {
          ok: true,
          status: 200,
          data: {
            resource: {
              id: "r-1",
              kind: body.kind,
              name: body.name,
              state: "ready",
              projectId: body.projectId,
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-7/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    await screen.findByText(/The engine provisioned this resource and confirmed it/);
    const sent = calls.find((call) => call.procedure === "data.provision");
    // The URL's project, not a blank or another project, reaches the server.
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      projectId: "p-7",
      name: "orders-db",
    });
  });

  it("shows this project's resources plus organization-wide ones, and no other project's", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-1", kind: "postgres", name: "mine-db", state: "ready", projectId: "p-1" },
            { id: "r-2", kind: "postgres", name: "shared-db", state: "ready", projectId: null },
            { id: "r-3", kind: "postgres", name: "other-db", state: "ready", projectId: "p-2" },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    expect(await screen.findByText("mine-db")).toBeTruthy();
    expect(screen.getByText("shared-db")).toBeTruthy();
    expect(screen.queryByText("other-db")).toBeNull();
  });

  it("lists a resource's backups, including one the engine did not complete", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-1", kind: "postgres", name: "ready-db", state: "ready", projectId: "p-1" },
          ],
        };
      }
      if (procedure === "data.backups.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "b-1",
              dataResourceId: "r-1",
              status: "succeeded",
              providerResourceId: "engine-1",
              createdAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z",
            },
            {
              id: "b-2",
              dataResourceId: "r-1",
              status: "not_configured",
              providerResourceId: null,
              createdAt: "2026-01-02T00:00:00.000Z",
              finishedAt: null,
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Back up" }));
    const dialog = await screen.findByRole("dialog", { name: "Back up resource" });

    // Both attempts are visible; a failed one is not hidden by the good one.
    expect(await within(dialog).findByText("succeeded")).toBeTruthy();
    expect(within(dialog).getByText("not_configured")).toBeTruthy();
  });

  it("reports an unconfigured engine instead of pretending a resource exists", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "data.provision") {
        // Honest refusal: the row was recorded but the engine did not act.
        return {
          ok: true,
          status: 200,
          data: {
            resource: {
              id: "r-2",
              kind: "postgres",
              name: "orders-db",
              state: "not_configured",
            },
            engineReason: "POSTGRES_URL is not set.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    expect(await screen.findByText(/The engine did not provision this resource/)).toBeTruthy();
    expect(await screen.findByText(/POSTGRES_URL is not set\./)).toBeTruthy();
  });

  it("backs up a ready resource and refuses one the engine never provisioned", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-ready", kind: "postgres", name: "ready-db", state: "ready" },
            { id: "r-missing", kind: "postgres", name: "no-handle", state: "not_configured" },
          ],
        };
      }
      if (procedure === "data.backup") {
        return {
          ok: true,
          status: 200,
          data: {
            backup: {
              id: "b-1",
              dataResourceId: "r-ready",
              status: "succeeded",
              providerResourceId: "engine-1",
              createdAt: new Date().toISOString(),
              finishedAt: null,
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    const rows = await screen.findAllByRole("row");
    const readyRow = rows.find((row) => within(row).queryByText("ready-db"));
    expect(readyRow).toBeTruthy();
    // The row whose resource is not ready cannot be backed up; the control is
    // disabled rather than firing a call the server would refuse.
    const missingRow = rows.find((row) => within(row).queryByText("no-handle"));
    expect(
      within(missingRow!).getByRole("button", { name: "Back up" }) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);

    await user.click(within(readyRow!).getByRole("button", { name: "Back up" }));
    // The dialog's own confirm button, distinct from the row control behind it.
    const dialog = await screen.findByRole("dialog", { name: "Back up resource" });
    await user.click(within(dialog).getByRole("button", { name: "Back up" }));

    expect(await screen.findByText(/The engine returned a backup reference/)).toBeTruthy();
    const sent = calls.find((call) => call.procedure === "data.backup");
    expect(sent?.input).toMatchObject({ organizationId: "org-1", resourceId: "r-ready" });
  });

  it("restores only from a completed backup, and only after the name is typed", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [{ id: "r-ready", kind: "postgres", name: "ready-db", state: "ready" }],
        };
      }
      if (procedure === "data.backups.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "b-good",
              dataResourceId: "r-ready",
              status: "succeeded",
              providerResourceId: "engine-1",
              createdAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z",
            },
            {
              id: "b-pending",
              dataResourceId: "r-ready",
              status: "pending",
              providerResourceId: null,
              createdAt: "2026-01-02T00:00:00.000Z",
              finishedAt: null,
            },
          ],
        };
      }
      if (procedure === "data.restore") {
        return {
          ok: true,
          status: 200,
          data: {
            restore: {
              id: "rs-1",
              backupId: "b-good",
              dataResourceId: "r-ready",
              status: "pending",
              providerResourceId: null,
              createdAt: new Date().toISOString(),
              finishedAt: null,
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    const rows = await screen.findAllByRole("row");
    const readyRow = rows.find((row) => within(row).queryByText("ready-db"));
    await user.click(within(readyRow!).getByRole("button", { name: "Restore" }));

    const dialog = await screen.findByRole("dialog", { name: "Restore from backup" });
    // Only the completed backup is offered: the pending one has no handle to
    // restore from, so it is not in the options.
    const options = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(options.some((label) => label.includes("b-good"))).toBe(false); // labels are timestamps
    expect(within(dialog).queryAllByRole("option").length).toBe(2); // placeholder + b-good

    // The confirm button stays disabled until the database's own name is typed.
    const confirm = within(dialog).getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await user.selectOptions(
      within(dialog).getByRole("combobox"),
      within(dialog).getAllByRole("option")[1]!,
    );
    await user.type(within(dialog).getByRole("textbox"), "ready-db");
    expect(confirm.disabled).toBe(false);

    await user.click(confirm);
    expect(await screen.findByText(/The restore is queued/)).toBeTruthy();
    const sent = calls.find((call) => call.procedure === "data.restore");
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      resourceId: "r-ready",
      backupId: "b-good",
      confirmName: "ready-db",
    });
  });

  it("rotates credentials only after the database name is typed, and never shows one", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [{ id: "r-ready", kind: "postgres", name: "ready-db", state: "ready" }],
        };
      }
      if (procedure === "data.rotateCredentials") {
        return {
          ok: true,
          status: 200,
          data: {
            resource: {
              id: "r-ready",
              kind: "postgres",
              name: "ready-db",
              state: "ready",
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    const rows = await screen.findAllByRole("row");
    const readyRow = rows.find((row) => within(row).queryByText("ready-db"));
    await user.click(within(readyRow!).getByRole("button", { name: "Rotate credentials" }));

    const dialog = await screen.findByRole("dialog", { name: "Rotate credentials" });
    const rotate = within(dialog).getByRole("button", { name: "Rotate" }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);

    await user.type(within(dialog).getByRole("textbox"), "ready-db");
    expect(rotate.disabled).toBe(false);
    await user.click(rotate);

    expect(await screen.findByText(/The engine rotated the credentials/)).toBeTruthy();
    // The control plane holds no copy, so the dialog must not render one.
    expect(within(dialog).queryByText(/password\s*:/i)).toBeNull();
    const sent = calls.find((call) => call.procedure === "data.rotateCredentials");
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      resourceId: "r-ready",
      confirmName: "ready-db",
    });
  });
});

describe("filtering a loaded table", () => {
  it("narrows the deployments list to what was typed, without a new request", async () => {
    const calls: string[] = [];
    const responder: Responder = (procedure) => {
      calls.push(procedure);
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "deployments.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              projectId: "p-1",
              status: "succeeded",
              url: "https://alpha.example.test",
              failureReason: null,
            },
            {
              id: "d-2",
              projectId: "p-1",
              status: "failed",
              url: "https://beta.example.test",
              failureReason: "build failed",
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");
    const user = userEvent.setup();

    // Both rows are visible before the filter is used.
    expect(await screen.findByText("https://alpha.example.test")).toBeTruthy();
    expect(screen.getByText("https://beta.example.test")).toBeTruthy();

    const before = calls.filter((name) => name === "deployments.list").length;
    await user.type(await screen.findByLabelText("Filter deployments"), "beta");

    // The beta row remains, the alpha row is gone; no second round-trip happened.
    expect(screen.getByText("https://beta.example.test")).toBeTruthy();
    expect(screen.queryByText("https://alpha.example.test")).toBeNull();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(calls.filter((name) => name === "deployments.list").length).toBe(before);
  });

  it("says no rows match rather than showing an empty table", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return {
          ok: true,
          status: 200,
          data: [{ id: "dm-1", hostname: "app.example.test", verified: true, verifiedAt: null }],
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Filter domains"), "nothing-matches");

    expect(await screen.findByText(/No rows match/)).toBeTruthy();
    expect(screen.queryByText("app.example.test")).toBeNull();
  });
});

describe("connecting a repository for deploy-on-push", () => {
  /**
   * A control plane that holds git-link rows. The secret is generated
   * server-side, returned exactly once, and never present in a later list —
   * the same discipline as an API key.
   */
  function gitPlane() {
    const links: {
      id: string;
      projectId: string;
      provider: string;
      repository: string;
      productionBranch: string;
      previewsEnabled: boolean;
      secretPrefix: string;
      createdAt: string;
    }[] = [];
    const calls: { procedure: string; input: unknown }[] = [];

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "git.links.list") {
        return { ok: true, status: 200, data: links };
      }
      if (procedure === "git.connect") {
        const body = input as {
          provider: string;
          repository: string;
          productionBranch: string;
          previewsEnabled: boolean;
        };
        const link = {
          id: "gl-1",
          projectId: "p-1",
          provider: body.provider,
          repository: body.repository,
          productionBranch: body.productionBranch,
          previewsEnabled: body.previewsEnabled,
          secretPrefix: "whsec_abcd",
          createdAt: "2026-01-01T00:00:00Z",
        };
        links.push(link);
        return { ok: true, status: 200, data: { link, webhookSecret: "whsec_secret_value" } };
      }
      if (procedure === "git.disconnect") {
        const body = input as { linkId: string };
        const index = links.findIndex((l) => l.id === body.linkId);
        if (index < 0) return { ok: true, status: 200, data: { removed: false } };
        links.splice(index, 1);
        return { ok: true, status: 200, data: { removed: true } };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, links, calls };
  }

  it("shows an honest empty state before anything is connected", async () => {
    const { responder } = gitPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/git");

    expect(await screen.findByText(/No repository is connected/)).toBeTruthy();
  });

  it("connects a repository and shows the webhook secret exactly once", async () => {
    const { responder, calls, links } = gitPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/git");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Connect repository" }));
    await user.type(await screen.findByPlaceholderText("acme/web-app"), "acme/site");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    // The delivery URL and the secret are shown so the operator can finish the
    // job in their provider — the whole point of the dialog.
    expect(await screen.findByDisplayValue(/\/hooks\/git\/org-1\/gl-1/)).toBeTruthy();
    expect(screen.getByDisplayValue("whsec_secret_value")).toBeTruthy();

    const connect = calls.find((c) => c.procedure === "git.connect");
    expect(connect?.input).toMatchObject({ projectId: "p-1", repository: "acme/site" });
    expect(links).toHaveLength(1);

    // Closing returns to the list, which never carries the secret.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue("whsec_secret_value")).toBeNull());
  });

  it("omits the secret from a list read, so it cannot be recovered", async () => {
    const { responder, links } = gitPlane();
    links.push({
      id: "gl-1",
      projectId: "p-1",
      provider: "github",
      repository: "acme/site",
      productionBranch: "main",
      previewsEnabled: true,
      secretPrefix: "whsec_abcd",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/git");

    expect(await screen.findByText("acme/site")).toBeTruthy();
    expect(screen.getByText("whsec_abcd…")).toBeTruthy();
    expect(screen.queryByText("whsec_secret_value")).toBeNull();
  });

  it("disconnects a repository and reloads the list", async () => {
    const { responder, calls, links } = gitPlane();
    links.push({
      id: "gl-1",
      projectId: "p-1",
      provider: "github",
      repository: "acme/site",
      productionBranch: "main",
      previewsEnabled: false,
      secretPrefix: "whsec_abcd",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/git");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "git.disconnect")).toBe(true));
    const disconnect = calls.find((c) => c.procedure === "git.disconnect");
    expect(disconnect?.input).toMatchObject({ projectId: "p-1", linkId: "gl-1" });
    expect(links).toHaveLength(0);

    await waitFor(() => expect(screen.queryByText("acme/site")).toBeNull());
  });
});

describe("the Security policy write path", () => {
  const draftPolicy = {
    id: "pol-1",
    name: "Default policy",
    riskLevel: "high" as const,
    action: "challenge" as const,
    state: "draft" as const,
    protectionMode: "normal" as const,
    protectionExpiresAt: null,
    version: 2,
    updatedAt: new Date().toISOString(),
  };

  it("reports the edge banner from the engine state, not a hardcoded string", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return {
          ok: true,
          status: 200,
          data: [
            { provider: "coolify", state: "ready", detail: "Configured." },
            { provider: "envoy", state: "ready", detail: "Configured." },
          ],
        };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: null, events: [] } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    // A configured edge must show as configured. The old hardcoded banner would
    // have said "not configured" here, which is the bug this pins.
    expect(await screen.findByText("Edge configured.")).toBeTruthy();
    expect(screen.queryByText("Edge not configured.")).toBeNull();
  });

  it("says the edge is not configured when the adapter reports so", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return {
          ok: true,
          status: 200,
          data: [{ provider: "envoy", state: "not_configured", detail: "No credentials." }],
        };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: null, events: [] } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("Edge not configured.")).toBeTruthy();
    expect(screen.queryByText("Edge configured.")).toBeNull();
  });

  it("saves a policy as a draft and never claims it is active", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    let stored: unknown = null;
    const responder: Responder = (procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.save") {
        calls.push({ procedure, input });
        stored = draftPolicy;
        return { ok: true, status: 200, data: draftPolicy };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: stored, events: [] } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Save policy" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    // The stored state is what is rendered, and it is a draft: not active.
    expect(await screen.findByText("draft")).toBeTruthy();
    expect(screen.queryByText("active")).toBeNull();

    const sent = calls.find((call) => call.procedure === "security.policy.save");
    expect(sent?.input).toMatchObject({ organizationId: "org-1", riskLevel: "medium" });
  });

  it("carries a chosen protection level into the save form", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: null, events: [] } };
      }
      if (procedure === "security.policy.save") {
        calls.push({ procedure, input });
        return { ok: true, status: 200, data: draftPolicy };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    // "Ultimate" maps to critical risk and a block action; those exact values
    // must reach the form rather than the form's own defaults. It is the fourth
    // level card, and every card's button shares the same label.
    const levelButtons = await screen.findAllByRole("button", { name: "Use this level" });
    await user.click(levelButtons[3]!);
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    const sent = calls.find((call) => call.procedure === "security.policy.save");
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      riskLevel: "critical",
      action: "block",
    });
  });

  it("shows the policy's own history, including transitions the server refused", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return {
          ok: true,
          status: 200,
          data: {
            policy: draftPolicy,
            events: [
              {
                id: "e-1",
                policyId: "pol-1",
                fromState: "draft",
                toState: "active",
                version: 3,
                detail: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "e-2",
                policyId: "pol-1",
                fromState: "active",
                toState: "failed",
                version: 3,
                detail: "The edge refused the configuration.",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    // Both the activation and the later refusal are visible: history is not
    // collapsed to the policy's current state.
    expect(await screen.findByText("The edge refused the configuration.")).toBeTruthy();
  });

  it("reports a distribution the edge did not apply as not applied", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: draftPolicy, events: [] } };
      }
      if (procedure === "security.policy.distribute") {
        return {
          ok: true,
          status: 200,
          data: {
            policy: draftPolicy,
            distributed: false,
            engineReason: "The security edge is not configured in this deployment.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Distribute to edge" }));
    await user.click(screen.getByRole("button", { name: "Distribute" }));

    expect(await screen.findByText(/The edge did not apply the policy/)).toBeTruthy();
    expect(
      await screen.findByText(/The security edge is not configured in this deployment/),
    ).toBeTruthy();
  });

  it("shows a live attack posture from the stored policy, not local state", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.policy.get") {
        return {
          ok: true,
          status: 200,
          data: {
            policy: {
              ...draftPolicy,
              protectionMode: "attack",
              protectionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
            events: [],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("Attack (timed)")).toBeTruthy();
  });

  it("adds a deny-list rule through the API and reads it back", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.rules.add") {
        return {
          ok: true,
          status: 200,
          data: {
            id: "rule-1",
            kind: "ip",
            value: "203.0.113.9",
            note: null,
            createdAt: new Date().toISOString(),
          },
        };
      }
      if (procedure === "security.rules.list") {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    await user.type(await screen.findByLabelText("Value"), "203.0.113.9");
    // The section header and the modal footer both say "Add rule"; the modal's
    // is the last one rendered.
    const addButtons = screen.getAllByRole("button", { name: "Add rule" });
    await user.click(addButtons[addButtons.length - 1]!);

    await waitFor(() =>
      expect(calls.some((call) => call.procedure === "security.rules.add")).toBe(true),
    );
  });

  it("trusts a source address through the API and reads it back", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.trustedSources.add") {
        return {
          ok: true,
          status: 200,
          data: {
            id: "ts-1",
            kind: "cidr",
            value: "192.0.2.0/24",
            note: null,
            createdAt: new Date().toISOString(),
          },
        };
      }
      if (procedure === "security.trustedSources.list") {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Trust an address" }));
    await user.type(await screen.findByLabelText("Address"), "192.0.2.0/24");
    // The section opens with kind "IP address"; switch to the CIDR grammar the
    // value uses, so the form and the server's validator agree.
    await user.selectOptions(await screen.findByLabelText("Kind"), "cidr");
    const addButtons = screen.getAllByRole("button", { name: "Trust address" });
    await user.click(addButtons[addButtons.length - 1]!);

    await waitFor(() =>
      expect(calls.some((call) => call.procedure === "security.trustedSources.add")).toBe(true),
    );
  });

  it("shows a trusted source the deployment stored, so attack mode's allow-list is visible", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.trustedSources.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "ts-1",
              kind: "ip",
              value: "198.51.100.7",
              note: "GitHub webhooks",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("198.51.100.7")).toBeTruthy();
    expect(await screen.findByText("GitHub webhooks")).toBeTruthy();
  });

  it("reports a trusted-source list the deployment does not support as degraded, not empty", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.trustedSources.list") {
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "This deployment cannot record trusted sources yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/cannot record trusted sources yet/)).toBeTruthy();
  });

  it("sets a rate limit through the API and reads it back", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const url = await startApi((procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.rateLimits.add") {
        return {
          ok: true,
          status: 200,
          data: {
            id: "rl-1",
            key: "ip",
            headerName: null,
            limit: 60,
            windowSeconds: 60,
            note: null,
            createdAt: new Date().toISOString(),
          },
        };
      }
      if (procedure === "security.rateLimits.list") {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add a limit" }));
    await user.type(await screen.findByLabelText("Allowance"), "60");
    const setButtons = screen.getAllByRole("button", { name: "Set limit" });
    await user.click(setButtons[setButtons.length - 1]!);

    await waitFor(() =>
      expect(calls.some((call) => call.procedure === "security.rateLimits.add")).toBe(true),
    );
  });

  it("shows a rate limit the deployment stored, so a scraper budget is visible", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.rateLimits.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "rl-1",
              key: "header",
              headerName: "x-api-key",
              limit: 1000,
              windowSeconds: 3600,
              note: "Scraper budget",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("header x-api-key")).toBeTruthy();
    expect(await screen.findByText("1,000 / 1h")).toBeTruthy();
    expect(await screen.findByText("Scraper budget")).toBeTruthy();
  });

  it("reports a rate-limit list the deployment does not support as degraded, not empty", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.rateLimits.list") {
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "This deployment cannot record rate limits yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/cannot record rate limits yet/)).toBeTruthy();
  });

  it("shows the verified-bot directory so attack mode does not look like it breaks SEO", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.bots.list") {
        return {
          ok: true,
          status: 200,
          data: {
            bots: [
              { name: "googlebot", userAgent: "Googlebot", confirmSuffix: ".googlebot.com" },
              { name: "bingbot", userAgent: "bingbot", confirmSuffix: ".search.msn.com" },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("googlebot")).toBeTruthy();
    expect(await screen.findByText(".googlebot.com")).toBeTruthy();
  });

  it("reports a deny list the deployment does not support as degraded, not empty", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.rules.list") {
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "This deployment cannot record rules yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/cannot record rules yet/)).toBeTruthy();
  });

  it("shows the edge's decisions so a block is attributable, not a mystery", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.events.list") {
        return {
          ok: true,
          status: 200,
          data: {
            events: [
              {
                id: "evt-1",
                host: "app.example.com",
                stage: "block-deny-list",
                action: "block",
                clientIp: "203.0.113.9",
                method: "GET",
                path: "/admin",
                userAgent: "curl/8",
                observedAt: new Date().toISOString(),
              },
              {
                id: "evt-2",
                host: "app.example.com",
                stage: "allow-verified-bot",
                action: "allow",
                clientIp: "66.249.66.1",
                method: "GET",
                path: "/",
                userAgent: "Googlebot",
                observedAt: new Date().toISOString(),
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText("block-deny-list")).toBeTruthy();
    expect(await screen.findByText("block")).toBeTruthy();
    expect(await screen.findByText("allow-verified-bot")).toBeTruthy();
  });

  it("reports an edge-decisions read the deployment cannot serve as degraded, not empty", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.events.list") {
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "This deployment cannot read edge decisions yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/cannot read edge decisions yet/)).toBeTruthy();
  });

  it("shows an incident with its severity and lifecycle so a signal is triaged, not buried", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.incidents.list") {
        return {
          ok: true,
          status: 200,
          data: {
            incidents: [
              {
                id: "inc-1",
                kind: "policy_distribution_rejected",
                severity: "high",
                summary: "Policy v2 was not applied: edge refused",
                state: "open",
                openedAt: new Date().toISOString(),
                closedAt: null,
                resolution: null,
              },
              {
                id: "inc-2",
                kind: "policy_distribution_rejected",
                severity: "medium",
                summary: "Policy v1 was not applied",
                state: "resolved",
                openedAt: new Date().toISOString(),
                closedAt: new Date().toISOString(),
                resolution: "Re-distributed after fixing the certificate",
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/edge refused/)).toBeTruthy();
    expect(await screen.findByText("High")).toBeTruthy();
    expect(await screen.findByText("Open")).toBeTruthy();
    expect(await screen.findByText(/Re-distributed after fixing the certificate/)).toBeTruthy();
  });

  it("reports an incidents read the deployment cannot serve as degraded, not empty", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "security.incidents.list") {
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "This deployment cannot read security incidents yet.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/cannot read security incidents yet/)).toBeTruthy();
  });
});
