/* test-registration
{
  "name": "Integrations Hub reconnect banner shows + clears \u2014 SEMrush / Front / Slack (Tasks #2166 / #2194; Google Ads retired by Task #4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-reconnect-banner-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2166 / #2194 — Client-side regression test that the auth-breaker
 * "reconnect" banner + cooldown detail actually render on the
 * Integrations Hub for SEMrush / Front / Slack when
 * `/api/integrations/all-status` reports `breakerOpen=true`, and that
 * they clear when the breaker closes (connected again).
 *
 * Task #2136 added a server route-shape test
 * (`tests/integrations-other-breaker-fields.test.ts`) proving the breaker
 * fields reach the JSON payload, but nothing verified the client renders
 * them. A future refactor could drop the banner without any test failing.
 * Task #2194 extends that coverage to the Front and Slack cards, which
 * render the same breaker surfaces (Front: text-front-disconnect-reason /
 * text-front-breaker-cooldown-until; Slack: text-slack-disconnect-reason +
 * the shared BreakerDetailRow with prefix `slack`).
 *
 * Task #4008 retired the Google Ads half: the platform connection + auth
 * breaker are gone (single env-credential model), so the Google Ads card
 * has no breaker banner/cooldown surfaces at all. This suite keeps a
 * negative pin: even in the breaker-open world the retired
 * text-google-ads-disconnect-reason / -breaker-cooldown-until testids must
 * not render (card coverage:
 * tests/client/integrations-hub-google-ads-single-lane.test.tsx).
 *
 * Mirrors `tests/client/front-autoheal-banner.test.tsx` (Task #1708) —
 * mounts the real page against the real production queryClient with a
 * stubbed fetch.
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
  id: "admin-2166",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const TERMINAL_CODE = "invalid_grant";
// Slack's card only echoes the raw reason code when it's one of its known
// terminal token-rejection reasons; pick one so the banner surfaces it.
const SLACK_TERMINAL_CODE = "invalid_auth";
const COOLDOWN_UNTIL = new Date(Date.now() + 5 * 60_000).toISOString();
const TRIPPED_AT = new Date(Date.now() - 60_000).toISOString();

type Scenario = {
  // When true, SEMrush + Front + Slack report an open auth-dead breaker;
  // when false they report a healthy reconnected state. Google Ads stays
  // healthy in BOTH worlds (Task #4008 — no breaker on the env-credential
  // card; its banner testids must never render).
  breakerOpen: boolean;
};

// Task #4008 unified env-credential shape — no breaker fields.
const GOOGLE_ADS_HEALTHY = {
  configured: true,
  connected: true,
  loginCustomerId: "8578363654",
  adsOs: {
    configured: true,
    refreshTokenSource: "env",
    health: "healthy",
    healthDetail: null,
    lastDataUpdateAt: new Date().toISOString(),
  },
};

function allStatusPayload(s: Scenario): any {
  if (s.breakerOpen) {
    return {
      front: {
        connected: false,
        breakerOpen: true,
        disconnectReason: TERMINAL_CODE,
        cooldownRemainingMs: 5 * 60_000,
        cooldownUntil: COOLDOWN_UNTIL,
        lastTrippedAt: TRIPPED_AT,
        tripCount: 3,
      },
      slack: {
        connected: false,
        team: null,
        breakerOpen: true,
        disconnectReason: SLACK_TERMINAL_CODE,
        cooldownRemainingMs: 5 * 60_000,
        cooldownUntil: COOLDOWN_UNTIL,
        lastTrippedAt: TRIPPED_AT,
        tripCount: 3,
      },
      zoom: { connected: true },
      pandadoc: { connected: true },
      stripe: { connected: true },
      googleAds: GOOGLE_ADS_HEALTHY,
      semrush: {
        connected: false,
        breakerOpen: true,
        disconnectReason: TERMINAL_CODE,
        cooldownRemainingMs: 5 * 60_000,
        cooldownUntil: COOLDOWN_UNTIL,
        lastTrippedAt: TRIPPED_AT,
        tripCount: 3,
      },
      unmatchedCount: 0,
    };
  }
  return {
    front: { connected: true, breakerOpen: false },
    slack: { connected: true, team: null, breakerOpen: false },
    zoom: { connected: true },
    pandadoc: { connected: true },
    stripe: { connected: true },
    googleAds: GOOGLE_ADS_HEALTHY,
    semrush: { connected: true, breakerOpen: false },
    unmatchedCount: 0,
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
        path: "/api/semrush/status",
        json: {
          configured: true,
          connected: !s.breakerOpen,
          expired: false,
        },
      },
      {
        path: "/api/semrush/console/sync-state",
        json: {
          outcomeTotals: {
            freshlySynced: 0,
            alreadyCurrent: 0,
            partiallyRefreshed: 0,
            failed: 0,
            neverRun: 0,
            totalIntegrations: 0,
            pausedAuth: 0,
          },
        },
      },
      { path: "/api/integrations/google-ads/customers", json: { customers: [] } },
      { path: "/api/integrations/google-ads/sync-runs", json: { runs: [] } },
      { path: "/api/admin/zoom/review-queue", json: { items: [] } },
      { path: "/api/admin/booking/health", json: {} },
      { path: "/api/backfill-jobs", json: { rows: [] } },
    ],
    // Permissive catch-all carrying the common list shapes so any child
    // panel query resolves without crashing the page mount.
    defaultJson: {
      rows: [],
      runs: [],
      customers: [],
      items: [],
      jobs: [],
      entries: [],
      windows: [],
      history: [],
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
const IntegrationsHub = (
  await import("../../client/src/pages/admin/IntegrationsHub")
).default;

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

// ── Scenario 1: breaker OPEN → banner + cooldown + terminal code render ──
console.log("\n— Reconnect banner: breaker OPEN —");
activeFetchHandler = makeHandler({ breakerOpen: true });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountHub();
  try {
    // Google Ads — retired breaker surfaces must NOT render even while the
    // other integrations' breakers are open (Task #4008).
    assert(
      $("text-google-ads-disconnect-reason") === null,
      "Google Ads breaker banner is retired (Task #4008) and must never render",
    );
    assert(
      $("text-google-ads-breaker-cooldown-until") === null,
      "Google Ads breaker cooldown detail is retired (Task #4008) and must never render",
    );
    const gaBadge = $("badge-google-ads-status");
    assert(gaBadge !== null, "Google Ads header badge must render");
    assert(
      (gaBadge!.textContent || "").includes("Connected"),
      `Google Ads badge stays env-credential-driven while sibling breakers are open, got: ${gaBadge!.textContent}`,
    );

    // SEMrush breaker banner with the terminal code.
    const semBanner = $("text-semrush-disconnect-reason");
    assert(semBanner !== null, "SEMrush disconnect-reason banner must render when breaker open");
    assert(
      (semBanner!.textContent || "").includes(TERMINAL_CODE),
      `SEMrush banner must surface the terminal code "${TERMINAL_CODE}", got: ${semBanner!.textContent}`,
    );
    const semCooldown = $("text-semrush-breaker-cooldown-until");
    assert(semCooldown !== null, "SEMrush breaker cooldown detail must render");
    assert(
      (semCooldown!.textContent || "").includes("Auto-retry at"),
      "SEMrush cooldown must show an Auto-retry time",
    );
    const semBadge = $("badge-semrush-status");
    assert(semBadge !== null, "SEMrush header badge must render");
    assert(
      (semBadge!.textContent || "").includes("Not Connected"),
      `SEMrush header badge must read "Not Connected" when breaker open, got: ${semBadge!.textContent}`,
    );

    // Front breaker banner — the breaker-open copy is generic ("reconnect
    // required"), so assert the banner + cooldown render rather than a code.
    const frontBanner = $("text-front-disconnect-reason");
    assert(frontBanner !== null, "Front disconnect-reason banner must render when breaker open");
    assert(
      (frontBanner!.textContent || "").toLowerCase().includes("reconnect required"),
      `Front banner must surface the reconnect-required copy, got: ${frontBanner!.textContent}`,
    );
    const frontCooldown = $("text-front-breaker-cooldown-until");
    assert(frontCooldown !== null, "Front breaker cooldown detail must render");
    assert(
      (frontCooldown!.textContent || "").includes("Auto-retry at"),
      "Front cooldown must show an Auto-retry time",
    );
    const frontBadge = $("badge-front-status");
    assert(frontBadge !== null, "Front header badge must render");
    assert(
      (frontBadge!.textContent || "").includes("Not Connected"),
      `Front header badge must read "Not Connected" when breaker open, got: ${frontBadge!.textContent}`,
    );

    // Slack breaker banner — its card echoes the terminal reason code.
    const slackBanner = $("text-slack-disconnect-reason");
    assert(slackBanner !== null, "Slack disconnect-reason banner must render when breaker open");
    assert(
      (slackBanner!.textContent || "").includes(SLACK_TERMINAL_CODE),
      `Slack banner must surface the terminal code "${SLACK_TERMINAL_CODE}", got: ${slackBanner!.textContent}`,
    );
    const slackCooldown = $("text-slack-breaker-cooldown-until");
    assert(slackCooldown !== null, "Slack breaker cooldown detail must render");
    assert(
      (slackCooldown!.textContent || "").includes("Auto-retry at"),
      "Slack cooldown must show an Auto-retry time",
    );
    const slackBadge = $("badge-slack-status");
    assert(slackBadge !== null, "Slack header badge must render");
    assert(
      (slackBadge!.textContent || "").includes("Not Connected"),
      `Slack header badge must read "Not Connected" when breaker open, got: ${slackBadge!.textContent}`,
    );
    console.log("  ✓ banners + cooldown + terminal code + header badges render (SEMrush / Front / Slack); retired Google Ads surfaces stay absent");
  } finally {
    await unmount(root);
  }
}

// ── Scenario 2: breaker CLOSED → banner + cooldown clear ──
console.log("\n— Reconnect banner: breaker CLOSED (reconnected) —");
activeFetchHandler = makeHandler({ breakerOpen: false });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountHub();
  try {
    assert(
      $("text-google-ads-disconnect-reason") === null,
      "Google Ads disconnect-reason banner must disappear when breaker closed",
    );
    assert(
      $("text-google-ads-breaker-cooldown-until") === null,
      "Google Ads cooldown detail must disappear when breaker closed",
    );
    const gaBadge = $("badge-google-ads-status");
    assert(gaBadge !== null, "Google Ads header badge must render");
    assert(
      (gaBadge!.textContent || "").includes("Connected") &&
        !(gaBadge!.textContent || "").includes("Not Connected"),
      `Google Ads header badge must read "Connected" when reconnected, got: ${gaBadge!.textContent}`,
    );

    assert(
      $("text-semrush-disconnect-reason") === null,
      "SEMrush disconnect-reason banner must disappear when breaker closed",
    );
    assert(
      $("text-semrush-breaker-cooldown-until") === null,
      "SEMrush cooldown detail must disappear when breaker closed",
    );
    const semBadge = $("badge-semrush-status");
    assert(semBadge !== null, "SEMrush header badge must render");
    assert(
      (semBadge!.textContent || "").includes("Connected") &&
        !(semBadge!.textContent || "").includes("Not Connected"),
      `SEMrush header badge must read "Connected" when reconnected, got: ${semBadge!.textContent}`,
    );

    assert(
      $("text-front-disconnect-reason") === null,
      "Front disconnect-reason banner must disappear when breaker closed",
    );
    assert(
      $("text-front-breaker-cooldown-until") === null,
      "Front cooldown detail must disappear when breaker closed",
    );
    const frontBadge = $("badge-front-status");
    assert(frontBadge !== null, "Front header badge must render");
    assert(
      (frontBadge!.textContent || "").includes("Connected") &&
        !(frontBadge!.textContent || "").includes("Not Connected"),
      `Front header badge must read "Connected" when reconnected, got: ${frontBadge!.textContent}`,
    );

    assert(
      $("text-slack-disconnect-reason") === null,
      "Slack disconnect-reason banner must disappear when breaker closed",
    );
    assert(
      $("text-slack-breaker-cooldown-until") === null,
      "Slack cooldown detail must disappear when breaker closed",
    );
    const slackBadge = $("badge-slack-status");
    assert(slackBadge !== null, "Slack header badge must render");
    assert(
      (slackBadge!.textContent || "").includes("Connected") &&
        !(slackBadge!.textContent || "").includes("Not Connected"),
      `Slack header badge must read "Connected" when reconnected, got: ${slackBadge!.textContent}`,
    );
    console.log("  ✓ banners + cooldown cleared, header badges Connected (SEMrush / Front / Slack; Google Ads env lane)");
  } finally {
    await unmount(root);
  }
}

console.log("\nintegrations-reconnect-banner: breaker banner shows and clears for SEMrush + Front + Slack; Google Ads breaker UI stays retired.");
