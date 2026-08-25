/* test-registration
{
  "name": "Integrations Hub all-status status-unknown neutral rendering (Task #2830)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-hub-all-status-unknown-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2830 — Frontend regression test for the Integrations Hub when the
 * aggregate `/api/integrations/all-status` poll answers with the Task #2811
 * status-unknown 503 contract (`503 { statusUnknown: true, probeFailed:
 * true, reason }`, thrown transient DB blip on the server).
 *
 * A blip must NOT make every integration look broken:
 *   1. Cold mount during the blip → every card renders the neutral
 *      "Checking…" badge (never "Not Connected"), the SEMrush card renders
 *      its neutral status-unknown line instead of a false "Connect Semrush"
 *      button, and the page renders the neutral all-status banner.
 *   2. A genuine confirmed-empty credential (normal 200 with
 *      `connected: false`) still renders "Not Connected" — and no banner.
 *
 * Mounts the real `IntegrationsHub` page against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. A
 * `team_lead` user passes the admin gate without rendering the CEO-only
 * ProdActionsPanel. Prior-task harness pattern:
 * tests/client/integrations-hub-reconnect-required-badge.test.tsx (#2160).
 * Server-side degrade coverage lives in
 * tests/integrations-all-status-settings-read-blip.test.ts.
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2830",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "team_lead",
};

const STATUS_UNKNOWN_BODY = {
  statusUnknown: true,
  probeFailed: true,
  reason: "simulated transient DB read failure (pool saturation)",
};

// Genuine confirmed-empty: the normal 200 shape with committed
// connected:false everywhere it matters for the badges under test.
const ALL_DISCONNECTED = {
  front: { connected: false },
  slack: { connected: false },
  zoom: { connected: false },
  twilio: { connected: false },
  pandadoc: { connected: false },
  stripe: { connected: false },
  googleAds: { connected: false, configured: false },
  semrush: { connected: false },
};

function makeFetchHandler(allStatus: { status: number; json: unknown }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", status: allStatus.status, json: allStatus.json },
      // BackfillJobsPanel's list query expects { rows: [] }.
      { path: "/api/backfill-jobs", json: { rows: [] } },
    ],
    defaultJson: {},
  }) as any;
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
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

const BADGES = [
  "badge-front-status",
  "badge-slack-status",
  "badge-zoom-status",
  "badge-pandadoc-status",
  "badge-stripe-status",
  "badge-semrush-status",
];

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Integrations Hub all-status status-unknown neutral rendering (Task #2830)");

  // Case 1 — cold mount while all-status answers the status-unknown 503.
  activeFetchHandler = makeFetchHandler({ status: 503, json: STATUS_UNKNOWN_BODY });
  let root = await mountHub();
  try {
    const banner = $("text-all-status-unknown");
    assert(banner !== null, "neutral all-status banner must render during the blip");
    assert(
      /temporarily unavailable/i.test(banner!.textContent || ""),
      `banner must read as a temporary condition — got "${banner!.textContent}"`,
    );
    for (const id of BADGES) {
      const badge = $(id);
      assert(badge !== null, `${id} must render`);
      const text = badge!.textContent || "";
      assert(
        !text.includes("Not Connected") && !text.includes("Not Configured"),
        `${id} must NOT read Not Connected/Configured during a status-unknown blip — got "${text}"`,
      );
      assert(
        text.includes("Checking"),
        `${id} must render the neutral Checking… state on a cold blip — got "${text}"`,
      );
    }
    assert(
      $("button-semrush-connect") === null,
      "SEMrush card must NOT offer a false 'Connect Semrush' during the blip",
    );
    assert(
      $("text-semrush-status-unknown") !== null,
      "SEMrush card must render its neutral status-unknown line during the blip",
    );
    console.log("  ✓ status-unknown 503 → banner + Checking badges, no false Not-Connected / Connect CTA");
  } finally {
    await unmount(root);
  }

  // Case 2 — genuine confirmed-empty: Not Connected must still render.
  activeFetchHandler = makeFetchHandler({ status: 200, json: ALL_DISCONNECTED });
  root = await mountHub();
  try {
    assert(
      $("text-all-status-unknown") === null,
      "neutral banner must NOT render on a normal 200 payload",
    );
    const front = $("badge-front-status");
    assert(front !== null, "front badge must render (confirmed-empty case)");
    assert(
      (front!.textContent || "").includes("Not Connected"),
      `confirmed-empty front badge must still read Not Connected — got "${front!.textContent}"`,
    );
    console.log("  ✓ confirmed-empty 200 → genuine Not Connected still renders, no banner");
  } finally {
    await unmount(root);
  }

  console.log("\nintegrations-hub-all-status-unknown: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
