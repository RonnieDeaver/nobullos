/* test-registration
{
  "name": "Report editor Back button target (Task #2507)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-form-heavy-deps-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2507 — Regression test for the report editor "Back" button target.
 *
 * Task #2506 changed `ReportForm.tsx` so the header "Back" link returns to the
 * originating client's Reports tab (`/clients/<clientId>?tab=reports`) instead
 * of the Dashboard. That navigation had no automated coverage, so a future
 * refactor of the `backHref` computation could silently regress it.
 *
 * The `backHref` is:
 *   const backClientId = existingReport?.clientId || formData.clientId || preselectedClientId;
 *   const backHref     = backClientId ? `/clients/${backClientId}?tab=reports` : "/";
 *
 * These three scenarios pin every branch of that expression by mounting the
 * REAL `ReportForm` page inside a wouter `Route` (so `useParams` / `useSearch`
 * resolve from the jsdom location) and reading the rendered
 * `data-testid="link-back"` anchor's href:
 *
 *   1. Editing an existing report (`/reports/:id`) → the loaded report's
 *      `clientId` wins → `/clients/<reportClientId>?tab=reports`.
 *   2. The new-report flow (`/reports/new?clientId=...`) → `preselectedClientId`
 *      (via `formData.clientId`) → `/clients/<preselectedClientId>?tab=reports`.
 *   3. Fallback to `/` (Dashboard) when no client id can be resolved (the
 *      report fetch fails and there is no `?clientId`).
 *
 * Heavy leaf components (`ObjectUploader`, `InteractiveHeatmap`,
 * `HeatmapPicker`) pull in `@uppy/*` / `maplibre-gl` + `.css` side-effects that
 * the bare jsdom harness can't evaluate; they're stubbed to no-ops by
 * `report-form-heavy-deps-loader.mjs` (registered via `--import`). The
 * `?tab=reports` query the Back link emits is the same key `ClientDetail.tsx`
 * reads through its `TAB_MAP`, so the destination resolves to the Reports tab.
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

// Task #2829 — fail loudly if ANY rendered list in the report editor logs
// React's missing-key warning (redraw/flicker risk, see Task #2813). Scoped
// to the key warning only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Stub fetch — answers the small set of endpoints ReportForm hits on mount.
// A per-scenario override controls what `/api/reports/:id` returns.
// ---------------------------------------------------------------------------

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

const testUser = {
  id: "user-2507",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

// Set per scenario: given the requested report id, return a Response (or null
// to signal "no report endpoint configured" → 404).
let reportResponder: (id: string) => Response = () => jsonResponse(404, {});

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      test: (url: string) => /^\/api\/reports\/([^/?]+)$/.test(url),
      respond: ({ url }: any) =>
        reportResponder(decodeURIComponent(url.match(/^\/api\/reports\/([^/?]+)$/)[1])),
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/locations"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access/detection"),
      json: {},
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/command-panel"),
      json: null,
    },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  // Default: empty 200 so incidental requests don't error the page.
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ReportForm = (await import("../../client/src/pages/ReportForm")).default;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

function setLocation(path: string): void {
  dom.window.history.replaceState({}, "", path);
}

async function mountAt(routePath: string): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const qc = makeClient();
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(
          Router as any,
          null,
          React.createElement(Route as any, { path: routePath, component: ReportForm }),
        ),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  dom.window.localStorage.clear();
}

function backHref(): string {
  const link = $("link-back") as HTMLAnchorElement | null;
  assert(link !== null, "link-back anchor must render once auth resolves");
  return link!.getAttribute("href") || "";
}

// ---------------------------------------------------------------------------
// Scenario 1: editing an existing report → that report's client Reports tab.
// ---------------------------------------------------------------------------

async function scenarioExistingReport(): Promise<void> {
  console.log("\n— Scenario 1: /reports/:id Back → the report's client Reports tab —");

  const REPORT_ID = "report-abc";
  const CLIENT_ID = "client-from-report-123";
  reportResponder = (id) =>
    id === REPORT_ID
      ? jsonResponse(200, {
          id: REPORT_ID,
          clientId: CLIENT_ID,
          reportMonth: "2026-05",
          status: "draft",
          shareToken: null,
          privacyMode: false,
          hideLeadQuality: false,
          webhookImportLogId: null,
          sections: [],
        })
      : jsonResponse(404, {});

  setLocation(`/reports/${REPORT_ID}`);
  const root = await mountAt("/reports/:id");
  try {
    const href = backHref();
    assert(
      href === `/clients/${CLIENT_ID}?tab=reports`,
      `existing-report Back href must be /clients/${CLIENT_ID}?tab=reports (got '${href}')`,
    );
    console.log(`  ✓ Back href → ${href}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: new-report flow with ?clientId → that client's Reports tab.
// ---------------------------------------------------------------------------

async function scenarioNewReport(): Promise<void> {
  console.log("\n— Scenario 2: /reports/new?clientId=... Back → that client's Reports tab —");

  const CLIENT_ID = "client-preselected-456";
  // No report endpoint is relevant here (no :id); guard against any stray call.
  reportResponder = () => jsonResponse(404, {});

  setLocation(`/reports/new?clientId=${CLIENT_ID}`);
  const root = await mountAt("/reports/new");
  try {
    const href = backHref();
    assert(
      href === `/clients/${CLIENT_ID}?tab=reports`,
      `new-report Back href must be /clients/${CLIENT_ID}?tab=reports (got '${href}')`,
    );
    console.log(`  ✓ Back href → ${href}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: no resolvable client id → fall back to the Dashboard ("/").
// ---------------------------------------------------------------------------

async function scenarioFallbackToDashboard(): Promise<void> {
  console.log("\n— Scenario 3: unresolvable client id → Back falls back to '/' —");

  const REPORT_ID = "report-missing";
  // The report fetch fails (404) → existingReport stays undefined, and there is
  // no ?clientId, so backClientId is falsy → backHref must be "/".
  reportResponder = () => jsonResponse(404, {});

  setLocation(`/reports/${REPORT_ID}`);
  const root = await mountAt("/reports/:id");
  try {
    const href = backHref();
    assert(
      href === "/",
      `fallback Back href must be '/' when no client id resolves (got '${href}')`,
    );
    console.log(`  ✓ Back href → ${href}`);
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioExistingReport();
  await scenarioNewReport();
  await scenarioFallbackToDashboard();
  keyWarningGuard.assertNoKeyWarnings("report-editor-back-button.test.tsx");
  console.log("\nreport-editor-back-button: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
