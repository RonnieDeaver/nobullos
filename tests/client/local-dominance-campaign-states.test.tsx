/* test-registration
{
  "name": "LocalDominance campaign empty/unmatched states (Task #2223)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2223 — Frontend regression test for the SEMrush campaign empty /
 * unmatched states shipped in Task #2185 on
 * `client/src/components/LocalDominanceDashboard.tsx`.
 *
 * Two surfaces are covered:
 *
 *   1. no-campaigns-empty-state (full dashboard render). With SEMrush
 *      connected and healthy but zero campaigns returned, opening the
 *      Configure panel surfaces the explicit empty-state card
 *      (testid `no-campaigns-empty-state`) with its cache-bypassing
 *      "Refresh campaigns from SEMrush" action — never a silent dead end.
 *
 *   2. unmatched-location hint (the exported `LocationCampaignPicker` in
 *      isolation). For an unmatched location with no assigned campaigns the
 *      hint distinguishes:
 *        - still-enriching  ⇒ "Still loading campaign details from SEMrush…"
 *        - genuinely empty  ⇒ "No SEMrush campaigns are available to match…"
 *
 * LocalDominanceDashboard imports InteractiveHeatmap → maplibre-gl (a WebGL
 * library with a CSS side-effect import) through its dependency graph. Reuse
 * the heatmap render test's loader hook so `maplibre-gl` and its `.css`
 * import resolve to lightweight stubs instead of failing under tsx/jsdom.
 */

import { register } from "node:module";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

register("./maplibre-loader.mjs", import.meta.url);

const { JSDOM } = await import("jsdom");

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLSpanElement = dom.window.HTMLSpanElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
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
// Stub fetch — routes the dashboard's queries to a connected-but-empty SEMrush.
// ---------------------------------------------------------------------------
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: /\/api\/semrush\/status/, json: { connected: true, expired: false } },
    { path: /\/api\/semrush\/campaigns/, json: { status: "ready", campaigns: [] } },
    { path: /\/semrush-integration/, json: { syncStatus: "idle" } },
  ],
  // locations, mappings, keywords, location-snapshots, geojson, etc.
  defaultJson: [],
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const LocalDominanceModule = await import(
  "../../client/src/components/LocalDominanceDashboard"
);
const LocalDominanceDashboard = LocalDominanceModule.default;
const { LocationCampaignPicker } = LocalDominanceModule;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

function newClient(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

// ---------------------------------------------------------------------------
// Scenario 1 — no-campaigns-empty-state (full dashboard)
// ---------------------------------------------------------------------------
async function runEmptyState(): Promise<void> {
  const container = document.getElementById("root")!;
  const client = newClient();
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(LocalDominanceDashboard as any, {
          clientId: "client-2223",
          userRole: "ceo",
        }),
      ),
    );
  });
  await flush();

  // Open the Configure panel so the campaign queries enable and the
  // empty-state can render.
  const configureBtn = $("btn-configure-integration");
  assert(configureBtn !== null, "Configure button must render for an admin");
  await act(async () => {
    configureBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush();

  const emptyState = $("no-campaigns-empty-state");
  assert(emptyState !== null, "no-campaigns-empty-state must render when connected with zero campaigns");
  assert(
    $("btn-refresh-campaigns-empty") !== null,
    "empty-state must offer the cache-bypassing refresh action",
  );
  console.log("  ✓ connected + zero campaigns ⇒ no-campaigns-empty-state with refresh action");

  await act(async () => {
    root!.unmount();
  });
}

// ---------------------------------------------------------------------------
// Scenario 2 & 3 — unmatched-location hint (LocationCampaignPicker isolated)
// ---------------------------------------------------------------------------
const PICKER_LOCATION = { id: "loc-2223", name: "Austin Office" } as any;

async function mountPicker(props: Record<string, unknown>): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(LocationCampaignPicker as any, {
        location: PICKER_LOCATION,
        assignedCampaignIds: [],
        onAdd: () => {},
        onRemove: () => {},
        campaignsLoading: false,
        semrushConnected: true,
        semrushStatusResolved: true,
        semrushStatusError: false,
        campaignsError: false,
        isUnmatched: true,
        ...props,
      }),
    );
  });
  await flush(4);
  return root!;
}

async function runEnrichingHint(): Promise<void> {
  const root = await mountPicker({ campaigns: [], semrushEnriching: true, isRefreshing: false });
  const hint = $(`unmatched-hint-${PICKER_LOCATION.id}`);
  assert(hint !== null, "unmatched hint must render for an unmatched, unassigned location");
  assert(
    (hint!.textContent || "").includes("Still loading campaign details from SEMrush"),
    `enriching hint expected (got "${hint!.textContent}")`,
  );
  console.log("  ✓ unmatched + enriching ⇒ \"Still loading campaign details…\"");
  await act(async () => {
    root.unmount();
  });
}

async function runNoMatchHint(): Promise<void> {
  const root = await mountPicker({ campaigns: [], semrushEnriching: false, isRefreshing: false });
  const hint = $(`unmatched-hint-${PICKER_LOCATION.id}`);
  assert(hint !== null, "unmatched hint must render for an unmatched, unassigned location");
  assert(
    (hint!.textContent || "").includes("No SEMrush campaigns are available to match"),
    `no-match hint expected (got "${hint!.textContent}")`,
  );
  console.log("  ✓ unmatched + no campaigns ⇒ \"No SEMrush campaigns are available to match…\"");
  await act(async () => {
    root.unmount();
  });
}

// ---------------------------------------------------------------------------
// Task #2630 — resolved-state messaging in the Configure panel.
// ---------------------------------------------------------------------------
async function mountDashboardWithRoutes(routes: any[]): Promise<{ root: Root; openConfig: () => Promise<void> }> {
  (globalThis as any).fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes,
    defaultJson: [],
  });
  const container = document.getElementById("root")!;
  const client = newClient();
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(LocalDominanceDashboard as any, {
          clientId: "client-2630",
          userRole: "ceo",
        }),
      ),
    );
  });
  await flush();
  const openConfig = async () => {
    const configureBtn = $("btn-configure-integration");
    assert(configureBtn !== null, "Configure button must render for an admin");
    await act(async () => {
      configureBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };
  return { root: root!, openConfig };
}

async function runGenuinelyDisconnected(): Promise<void> {
  const { root, openConfig } = await mountDashboardWithRoutes([
    { path: /\/api\/semrush\/status/, json: { connected: false, expired: false } },
    { path: /\/semrush-integration/, json: { syncStatus: "idle" } },
  ]);
  await openConfig();

  const notConnected = $("semrush-not-connected");
  assert(notConnected !== null, "resolved + disconnected ⇒ semrush-not-connected must render");
  assert(
    (notConnected!.textContent || "").includes("Integrations Hub"),
    `disconnected copy must point to the Integrations Hub (got "${notConnected!.textContent}")`,
  );
  assert($("semrush-checking") === null, "checking state must NOT render once the status query has resolved");
  assert($("semrush-client-not-configured") === null, "client-not-configured must NOT render when the global integration is down");
  console.log("  ✓ resolved + disconnected ⇒ \"SEMrush is not connected — reconnect in the Integrations Hub.\"");

  await act(async () => {
    root.unmount();
  });
}

async function runClientNotConfigured(): Promise<void> {
  const { root, openConfig } = await mountDashboardWithRoutes([
    { path: /\/api\/semrush\/status/, json: { connected: true, expired: false } },
    {
      path: /\/api\/semrush\/campaigns/,
      json: { status: "ready", campaigns: [{ id: "camp-1", businessName: "Acme Law", campaignName: "Acme", location: "Austin, TX", keywords: [] }] },
    },
    { path: /\/semrush-integration/, json: { syncStatus: "idle" } },
  ]);
  await openConfig();

  const clientNotConfigured = $("semrush-client-not-configured");
  assert(clientNotConfigured !== null, "global up + account has campaigns + client has no mappings ⇒ semrush-client-not-configured must render");
  assert(
    (clientNotConfigured!.textContent || "").includes("isn't set up yet"),
    `client-not-configured copy must be client-scoped (got "${clientNotConfigured!.textContent}")`,
  );
  assert($("semrush-not-connected") === null, "global-outage message must NOT render when the integration is connected");
  assert($("no-campaigns-empty-state") === null, "account-empty state must NOT render when the account has campaigns");
  console.log("  ✓ connected + account campaigns + unmapped client ⇒ client-scoped setup message (no false outage)");

  await act(async () => {
    root.unmount();
  });
}

async function run(): Promise<void> {
  await runEmptyState();
  await runEnrichingHint();
  await runNoMatchHint();
  await runGenuinelyDisconnected();
  await runClientNotConfigured();
}

run()
  .then(() => {
    console.log("local-dominance-campaign-states: all scenarios passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
