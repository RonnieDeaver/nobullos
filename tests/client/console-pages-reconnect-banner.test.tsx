/* test-registration
{
  "name": "Dedicated console reconnect banner shows + clears \u2014 Slack + SEMrush (Task #2231)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/setup-mocks.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2231 — Client-side regression test that the auth-breaker
 * "reconnect required" detail row (`BreakerDetailRow`: Disconnected at /
 * Auto-retry at / N trips) actually renders on the two *dedicated* admin
 * console surfaces — the Slack integration page
 * (`client/src/pages/admin/SlackIntegration.tsx`) and the SEMrush console
 * overview panel (`client/src/components/admin/SemrushConsolePanels.tsx`) —
 * when `/api/integrations/all-status` reports `breakerOpen=true`, and that it
 * clears when the breaker closes (reconnected).
 *
 * Task #2194 added this coverage for the Integrations Hub cards
 * (`tests/client/integrations-reconnect-banner.test.tsx`), but the standalone
 * console pages had no jsdom test, so a refactor could silently drop the
 * banner there. This mirrors that harness — mounts the real page/panel against
 * the real production queryClient with a stubbed fetch.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
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
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2231",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const TERMINAL_CODE = "invalid_grant";
const COOLDOWN_UNTIL = new Date(Date.now() + 5 * 60_000).toISOString();
const TRIPPED_AT = new Date(Date.now() - 60_000).toISOString();

type Scenario = { breakerOpen: boolean };

// Shape mirrors the Slack / SEMrush slices of GET /api/integrations/all-status.
function breakerSlice(open: boolean): any {
  if (open) {
    return {
      connected: false,
      breakerOpen: true,
      disconnectReason: TERMINAL_CODE,
      cooldownRemainingMs: 5 * 60_000,
      cooldownUntil: COOLDOWN_UNTIL,
      lastTrippedAt: TRIPPED_AT,
      tripCount: 3,
    };
  }
  return { connected: true, breakerOpen: false };
}

function allStatusPayload(s: Scenario): any {
  return {
    front: { connected: !s.breakerOpen, breakerOpen: false },
    slack: { ...breakerSlice(s.breakerOpen), team: s.breakerOpen ? null : "Acme" },
    zoom: { connected: true },
    pandadoc: { connected: true },
    stripe: { connected: true },
    googleAds: { configured: true, connected: !s.breakerOpen, breakerOpen: false },
    semrush: breakerSlice(s.breakerOpen),
    unmatchedCount: 0,
  };
}

// Minimal but complete OverviewResponse so the SEMrush panel's `{data && …}`
// branch (which contains the BreakerDetailRow) actually renders.
function semrushOverviewPayload(s: Scenario): any {
  return {
    connection: {
      status: s.breakerOpen ? "disconnected" : "connected",
      tokenExpiresAt: null,
      tokenExpiresInMs: null,
    },
    inventory: {
      isRunning: false,
      campaignCount: 0,
      lastFetchedAt: null,
      flags: { inventorySyncEnabled: true, reportRefreshEnabled: true },
      durability: "durable",
    },
    queues: [],
    locationSync: { counts: {}, awaitingAutoRetry: 0 },
    staleLease: { countInWindow: 0, windowMs: 600000, threshold: 5, durability: "in-memory" },
    generatedAt: new Date().toISOString(),
  };
}

function makeHandler(s: Scenario): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { test: (_url: string, method: string) => method !== "GET", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: allStatusPayload(s) },
      {
        path: "/api/integrations/slack/status",
        json: { connected: !s.breakerOpen, team: s.breakerOpen ? undefined : "Acme", valid: !s.breakerOpen },
      },
      { path: "/api/integrations/slack/sync-history", json: [] },
      { path: "/api/semrush/console/overview", json: semrushOverviewPayload(s) },
    ],
    // Permissive catch-all carrying the common list shapes so any child
    // panel query resolves without crashing the mount.
    defaultJson: {
      rows: [],
      runs: [],
      customers: [],
      items: [],
      jobs: [],
      entries: [],
      windows: [],
      history: [],
      messages: [],
    },
  });
}

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const SlackIntegration = (
  await import("../../client/src/pages/admin/SlackIntegration")
).default;
const { SemrushOverviewPanel } = await import(
  "../../client/src/components/admin/SemrushConsolePanels"
);

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mount(element: any): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        element,
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
  queryClient.clear();
}

function assertBreakerDetailRow(prefix: string, label: string): void {
  const details = $(`text-${prefix}-breaker-details`);
  assert(details !== null, `${label}: BreakerDetailRow must render when breaker open`);
  const cooldown = $(`text-${prefix}-breaker-cooldown-until`);
  assert(cooldown !== null, `${label}: breaker cooldown detail must render`);
  assert(
    (cooldown!.textContent || "").includes("Auto-retry at"),
    `${label}: cooldown must show an Auto-retry time, got: ${cooldown!.textContent}`,
  );
  const trippedAt = $(`text-${prefix}-breaker-tripped-at`);
  assert(trippedAt !== null, `${label}: breaker Disconnected-at detail must render`);
  assert(
    (trippedAt!.textContent || "").includes("Disconnected at"),
    `${label}: tripped-at must show "Disconnected at", got: ${trippedAt!.textContent}`,
  );
  const tripCount = $(`text-${prefix}-breaker-trip-count`);
  assert(tripCount !== null, `${label}: breaker trip-count detail must render`);
  assert(
    (tripCount!.textContent || "").includes("3 trips"),
    `${label}: trip-count must show "3 trips", got: ${tripCount!.textContent}`,
  );
}

function assertBreakerDetailRowGone(prefix: string, label: string): void {
  assert(
    $(`text-${prefix}-breaker-details`) === null,
    `${label}: BreakerDetailRow must disappear when breaker closed`,
  );
  assert(
    $(`text-${prefix}-breaker-cooldown-until`) === null,
    `${label}: cooldown detail must disappear when breaker closed`,
  );
}

// ── Slack dedicated console ─────────────────────────────────────────────
console.log("\n— Slack console: breaker OPEN —");
activeFetchHandler = makeHandler({ breakerOpen: true });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SlackIntegration as any));
  try {
    assertBreakerDetailRow("slack", "Slack console");
    const badge = $("badge-connection-status");
    assert(badge !== null, "Slack header badge must render");
    assert(
      (badge!.textContent || "").includes("Not Connected"),
      `Slack header badge must read "Not Connected" when breaker open, got: ${badge!.textContent}`,
    );
    console.log("  ✓ Slack console renders BreakerDetailRow (tripped-at / cooldown / trips) + Not Connected badge");
  } finally {
    await unmount(root);
  }
}

console.log("\n— Slack console: breaker CLOSED (reconnected) —");
activeFetchHandler = makeHandler({ breakerOpen: false });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SlackIntegration as any));
  try {
    assertBreakerDetailRowGone("slack", "Slack console");
    const badge = $("badge-connection-status");
    assert(badge !== null, "Slack header badge must render");
    assert(
      (badge!.textContent || "").includes("Connected") &&
        !(badge!.textContent || "").includes("Not Connected"),
      `Slack header badge must read "Connected" when reconnected, got: ${badge!.textContent}`,
    );
    console.log("  ✓ Slack console clears BreakerDetailRow, badge Connected");
  } finally {
    await unmount(root);
  }
}

// ── SEMrush dedicated console (overview panel) ──────────────────────────
console.log("\n— SEMrush console: breaker OPEN —");
activeFetchHandler = makeHandler({ breakerOpen: true });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SemrushOverviewPanel as any));
  try {
    assert($("section-semrush-overview") !== null, "SEMrush overview panel must mount");
    assertBreakerDetailRow("semrush", "SEMrush console");
    console.log("  ✓ SEMrush console renders BreakerDetailRow (tripped-at / cooldown / trips)");
  } finally {
    await unmount(root);
  }
}

console.log("\n— SEMrush console: breaker CLOSED (reconnected) —");
activeFetchHandler = makeHandler({ breakerOpen: false });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SemrushOverviewPanel as any));
  try {
    assert($("section-semrush-overview") !== null, "SEMrush overview panel must mount");
    assertBreakerDetailRowGone("semrush", "SEMrush console");
    console.log("  ✓ SEMrush console clears BreakerDetailRow when reconnected");
  } finally {
    await unmount(root);
  }
}

console.log("\nconsole-pages-reconnect-banner: breaker detail row shows and clears on the Slack + SEMrush dedicated consoles.");
