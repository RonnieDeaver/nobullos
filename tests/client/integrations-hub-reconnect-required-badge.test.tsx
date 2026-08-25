/* test-registration
{
  "name": "Integrations Hub SEMrush reconnect-required badge precedence (Task #2160; Google Ads cases retired by Task #4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-hub-reconnect-required-badge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2160 — Frontend regression test for the Integrations Hub
 * "Reconnect Required" badge precedence on the SEMrush card.
 *
 * The amber "Reconnect Required" badge is driven by the live, reconciled auth
 * breaker (`semrush.reconnectRequired` on `/api/integrations/all-status`).
 * The breaker is the authoritative signal, but `connected` is *probe-cache
 * driven* and can remain `true` for a window after the breaker trips. If the
 * badge ternary checked `connected === true` first, the UI would keep showing
 * "Connected" and hide the reconnect signal — exactly the probe-driven blind
 * spot this task exists to eliminate.
 *
 * This locks the UI contract: when `connected: true` AND
 * `reconnectRequired: true` arrive together, the card must render the amber
 * "Reconnect Required" badge, not "Connected". It also checks the inverse
 * (reconnectRequired:false + connected:true → "Connected") so the precedence
 * change can't accidentally mask a genuinely healthy integration.
 *
 * Task #4008 retired the Google Ads half of this suite: the platform
 * connection + auth breaker are gone, so `googleAds` no longer carries
 * `reconnectRequired`/`breakerOpen` and its card has no reconnect badge at
 * all (env-credential lane covered by
 * tests/client/integrations-hub-google-ads-single-lane.test.tsx). This suite
 * pins that retirement: the Google Ads badge must NOT read "Reconnect
 * Required" even if a stale payload still carries those fields.
 *
 * Mounts the real `IntegrationsHub` page against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. A
 * `team_lead` user passes the admin gate without rendering the CEO-only
 * ProdActionsPanel. Prior-task harness pattern: #2091 / #2058 / #2021
 * (jsdom page-mount). API field coverage lives in
 * tests/integrations-all-status-reconnect-required-fields.test.ts.
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
// wouter's browser-location hook reads the global `location`/`history` and
// subscribes via the global `addEventListener`/`removeEventListener`.
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2160",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "team_lead",
};

// Build an all-status payload where SEMrush carries the `reconnectRequired`
// value under test alongside a stale cached `connected: true`. The googleAds
// payload deliberately smuggles the RETIRED breaker fields in too (as a
// stale/wedged server might): the card must ignore them (Task #4008 — no
// reconnect concept on the env-credential card). Other integrations are
// minimal/benign.
function allStatus(reconnectRequired: boolean): Record<string, unknown> {
  return {
    front: { connected: true, breakerOpen: false, tripCount: 0 },
    slack: { connected: true, breakerOpen: false, tripCount: 0 },
    zoom: { connected: true },
    twilio: { connected: true },
    pandadoc: { connected: true },
    stripe: { connected: true },
    googleAds: {
      connected: true,
      configured: true,
      loginCustomerId: "8578363654",
      adsOs: {
        configured: true,
        refreshTokenSource: "env",
        health: "healthy",
        healthDetail: null,
        lastDataUpdateAt: new Date().toISOString(),
      },
      // Retired fields (Task #4008) — must be inert if they ever reappear.
      reconnectRequired,
      breakerOpen: reconnectRequired,
    },
    semrush: {
      connected: true,
      reconnectRequired,
      breakerOpen: reconnectRequired,
    },
  };
}

function makeFetchHandler(reconnectRequired: boolean): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: allStatus(reconnectRequired) },
      // BackfillJobsPanel's list query expects { rows: [] }.
      { path: "/api/backfill-jobs", json: { rows: [] } },
    ],
    // Benign empty payloads for every other incidental request the page makes.
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
// IntegrationsHub.tsx compiles its JSX with the classic runtime, which
// references a `React` global at render time — expose it before importing.
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const IntegrationsHub = (await import("../../client/src/pages/admin/IntegrationsHub")).default;

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountHub(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(IntegrationsHub as any),
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

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Integrations Hub SEMrush reconnect-required badge precedence (Task #2160; GA retired by #4008)");

  // Case 1 — breaker open while connected stayed cached-true: reconnect wins
  // on SEMrush; the Google Ads card has no reconnect concept anymore and must
  // ignore the retired fields entirely.
  activeFetchHandler = makeFetchHandler(true);
  let root = await mountHub();
  try {
    const ga = $("badge-google-ads-status");
    const sem = $("badge-semrush-status");
    assert(ga !== null, "Google Ads status badge must render");
    assert(sem !== null, "SEMrush status badge must render");
    assert(
      (sem!.textContent || "").includes("Reconnect Required"),
      `SEMrush badge must say "Reconnect Required" when breaker open despite connected:true — got "${sem!.textContent}"`,
    );
    assert(
      (sem!.className || "").includes("bg-amber-50"),
      `SEMrush reconnect badge must carry amber styling — got "${sem!.className}"`,
    );
    assert(
      !(ga!.textContent || "").includes("Reconnect Required"),
      `Google Ads badge must NEVER say "Reconnect Required" (Task #4008 retired the breaker/reconnect flow) — got "${ga!.textContent}"`,
    );
    assert(
      (ga!.textContent || "").includes("Connected"),
      `Google Ads badge stays env-credential-driven ("Connected") even when a stale payload carries retired breaker fields — got "${ga!.textContent}"`,
    );
    console.log("  ✓ breaker open + connected cached-true → SEMrush shows Reconnect Required; Google Ads ignores retired fields");
  } finally {
    await unmount(root);
  }

  // Case 2 — breaker closed: healthy integrations still read Connected.
  activeFetchHandler = makeFetchHandler(false);
  root = await mountHub();
  try {
    const ga = $("badge-google-ads-status");
    const sem = $("badge-semrush-status");
    assert(ga !== null, "Google Ads status badge must render (closed case)");
    assert(sem !== null, "SEMrush status badge must render (closed case)");
    assert(
      (sem!.textContent || "").includes("Connected") &&
        !(sem!.textContent || "").includes("Reconnect Required"),
      `SEMrush badge must say "Connected" when breaker closed — got "${sem!.textContent}"`,
    );
    assert(
      (ga!.textContent || "").includes("Connected") &&
        !(ga!.textContent || "").includes("Reconnect Required"),
      `Google Ads badge must say "Connected" when healthy — got "${ga!.textContent}"`,
    );
    console.log("  ✓ breaker closed + connected:true → both cards show Connected");
  } finally {
    await unmount(root);
  }

  console.log("\nintegrations-hub-reconnect-required-badge: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
