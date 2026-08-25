/* test-registration
{
  "name": "Status-unknown 503 renders neutral checking state, genuine disconnect stays Not Connected — Slack + Zoom (Task #2820)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2820: mounts the REAL Slack + Zoom consoles against the production queryClient and asserts a Task #2811 status-unknown 503 from a dedicated status route renders the neutral \"Checking…\" state (no false Not Connected, no Connect button, no generic error toast), while a genuine 200 connected:false still renders Not Connected. Guards the client half of the status-unknown contract — a route regressing to a bare 503 or a card regressing to the not-connected fallback fails the routine gate. Fast, DB-free, deterministic jsdom render with fetch fully stubbed.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integration-status-unknown-neutral-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2820 — the dedicated integration console pages must recognize the
 * Task #2811 status-unknown 503 contract from their status routes
 * (`503 { statusUnknown: true, probeFailed: true, connected: null, reason }`)
 * and render a neutral "checking / temporarily unavailable" state instead of
 * a hard "Not Connected" (and instead of the generic error toast).
 *
 * Covered here:
 *   1. Slack console — 503 statusUnknown → badge "Checking…", neutral copy,
 *      NO "Connect Slack" button; and no "Request failed" toast is enqueued
 *      by the production QueryCache onError.
 *   2. Slack console — genuine 200 { connected: false } (confirmed-empty
 *      credential) → still renders "Not Connected" + Connect button.
 *   3. Zoom console — 503 statusUnknown → badge "Checking…", neutral copy,
 *      no "not connected" prose.
 *   4. Parser unit checks — parseIntegrationStatusUnknownError accepts only
 *      the "503: {statusUnknown:true}" error shape.
 *
 * Harness mirrors tests/client/console-pages-reconnect-banner.test.tsx:
 * real pages + the real production queryClient with a stubbed fetch.
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
  id: "admin-2820",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const STATUS_UNKNOWN_BODY = {
  statusUnknown: true,
  probeFailed: true,
  connected: null,
  reason: "simulated transient DB read failure (pool saturation)",
};

type Scenario = "unknown" | "confirmed-empty";

function makeHandler(provider: "slack" | "zoom", scenario: Scenario) {
  const statusRoute =
    scenario === "unknown"
      ? { path: `/api/integrations/${provider}/status`, status: 503, json: STATUS_UNKNOWN_BODY }
      : {
          path: `/api/integrations/${provider}/status`,
          json: provider === "zoom" ? { connected: false } : { connected: false, valid: false },
        };
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { test: (_url: string, method: string) => method !== "GET", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      statusRoute,
      {
        path: "/api/integrations/all-status",
        json: { front: {}, slack: {}, zoom: {}, semrush: {}, unmatchedCount: 0 },
      },
      { path: "/api/integrations/slack/sync-history", json: [] },
      { path: /\/api\/zoom\/review-queue/, json: { items: [] } },
    ],
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
const { toast: _toastModule } = await import("../../client/src/hooks/use-toast");
const { parseIntegrationStatusUnknownError, isIntegrationStatusUnknownPayload } =
  await import("../../shared/integrationStatusUnknown");
const SlackIntegration = (
  await import("../../client/src/pages/admin/SlackIntegration")
).default;
const ZoomIntegration = (
  await import("../../client/src/pages/admin/ZoomIntegration")
).default;

// ── Parser unit checks ───────────────────────────────────────────────────
{
  const hit = parseIntegrationStatusUnknownError(
    new Error(`503: ${JSON.stringify(STATUS_UNKNOWN_BODY)}`),
  );
  assert(hit !== null, "parser must accept the 503 statusUnknown error shape");
  assert(
    hit!.reason.includes("simulated transient"),
    "parser must forward the diagnostic reason",
  );
  assert(
    parseIntegrationStatusUnknownError(new Error("503: upstream flaked")) === null,
    "plain 503 without statusUnknown must NOT parse",
  );
  assert(
    parseIntegrationStatusUnknownError(
      new Error(`500: ${JSON.stringify(STATUS_UNKNOWN_BODY)}`),
    ) === null,
    "non-503 status must NOT parse even with a statusUnknown-ish body",
  );
  assert(
    parseIntegrationStatusUnknownError(new Error("503: {\"statusUnknown\":false}")) === null,
    "statusUnknown must be literal true",
  );
  assert(
    parseIntegrationStatusUnknownError(new Error("503: {\"statusUnknown\":true}")) === null,
    "statusUnknown without probeFailed:true must NOT parse (strict contract shape)",
  );
  assert(
    isIntegrationStatusUnknownPayload(STATUS_UNKNOWN_BODY) &&
      !isIntegrationStatusUnknownPayload({ connected: false }),
    "payload guard must split unknown vs confirmed-empty bodies",
  );
  console.log("  ✓ parseIntegrationStatusUnknownError accepts only the 503 statusUnknown shape");
}

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

// ── Slack console: status-unknown 503 → neutral, not "Not Connected" ────
console.log("\n— Slack console: status route 503 statusUnknown —");
activeFetchHandler = makeHandler("slack", "unknown");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SlackIntegration as any));
  try {
    const badge = $("badge-connection-status");
    assert(badge !== null, "Slack header badge must render");
    assert(
      (badge!.textContent || "").includes("Checking"),
      `Slack badge must read "Checking…" on status-unknown, got: ${badge!.textContent}`,
    );
    assert(
      !(badge!.textContent || "").includes("Not Connected"),
      "Slack badge must NOT read Not Connected on status-unknown",
    );
    assert(
      $("text-slack-status-unknown") !== null,
      "Slack connection card must show the neutral status-unknown copy",
    );
    assert(
      $("button-connect-slack") === null,
      "Slack Connect button must NOT render on status-unknown (false disconnect)",
    );
    // The production QueryCache onError must not have enqueued the generic
    // "Request failed" toast for the suppressed status-unknown error.
    const toastTitles = Array.from(
      document.querySelectorAll("[data-radix-collection-item], li"),
    ).map((el) => el.textContent || "");
    assert(
      !toastTitles.some((t) => t.includes("Request failed")),
      "status-unknown 503 must not raise the generic Request failed toast",
    );
    console.log("  ✓ Slack console renders neutral checking state, no Connect button, no toast");
  } finally {
    await unmount(root);
  }
}

// ── Slack console: genuine confirmed-empty → still Not Connected ────────
console.log("\n— Slack console: genuine 200 connected:false —");
activeFetchHandler = makeHandler("slack", "confirmed-empty");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(SlackIntegration as any));
  try {
    const badge = $("badge-connection-status");
    assert(badge !== null, "Slack header badge must render");
    assert(
      (badge!.textContent || "").includes("Not Connected"),
      `Slack badge must still read "Not Connected" on confirmed-empty, got: ${badge!.textContent}`,
    );
    assert(
      $("text-slack-status-unknown") === null,
      "neutral status-unknown copy must NOT render for a genuine disconnect",
    );
    assert(
      $("button-connect-slack") !== null,
      "Slack Connect button must render for a genuine disconnect",
    );
    console.log("  ✓ Slack console keeps genuine Not Connected rendering");
  } finally {
    await unmount(root);
  }
}

// ── Zoom console: status-unknown 503 → neutral, not "Not Connected" ─────
console.log("\n— Zoom console: status route 503 statusUnknown —");
activeFetchHandler = makeHandler("zoom", "unknown");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(ZoomIntegration as any));
  try {
    const badge = $("badge-connection-status");
    assert(badge !== null, "Zoom header badge must render");
    assert(
      (badge!.textContent || "").includes("Checking"),
      `Zoom badge must read "Checking…" on status-unknown, got: ${badge!.textContent}`,
    );
    assert(
      !(badge!.textContent || "").includes("Not Connected"),
      "Zoom badge must NOT read Not Connected on status-unknown",
    );
    assert(
      $("text-zoom-status-unknown") !== null,
      "Zoom connection card must show the neutral status-unknown copy",
    );
    assert(
      !(document.body.textContent || "").includes("Zoom is not connected"),
      "Zoom not-connected prose must NOT render on status-unknown",
    );
    console.log("  ✓ Zoom console renders neutral checking state instead of Not Connected");
  } finally {
    await unmount(root);
  }
}

// ── Zoom console: genuine confirmed-empty → still Not Connected ─────────
console.log("\n— Zoom console: genuine 200 connected:false —");
activeFetchHandler = makeHandler("zoom", "confirmed-empty");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mount(React.createElement(ZoomIntegration as any));
  try {
    const badge = $("badge-connection-status");
    assert(badge !== null, "Zoom header badge must render");
    assert(
      (badge!.textContent || "").includes("Not Connected"),
      `Zoom badge must still read "Not Connected" on confirmed-empty, got: ${badge!.textContent}`,
    );
    assert(
      $("text-zoom-status-unknown") === null,
      "neutral status-unknown copy must NOT render for a genuine Zoom disconnect",
    );
    console.log("  ✓ Zoom console keeps genuine Not Connected rendering");
  } finally {
    await unmount(root);
  }
}

console.log(
  "\nintegration-status-unknown-neutral: status-unknown 503s render neutral checking states; genuine disconnects still render Not Connected.",
);
