/* test-registration
{
  "name": "Integrations Hub Google Ads single-lane card — env-credential states (Task #4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4008 consolidated every Google Ads surface onto the single env-trio credential and removed the in-app Connect/Reconnect OAuth flow, so this card is the operator's ONLY Google Ads auth surface. Asserts the header badge precedence (Secrets Missing > Credentials Rejected > Connected > Checking…), the powered-surfaces caption, the rotate-the-trio attention box (rotation = secrets edit + restart, not a button), Discover/Sync gating on connected, and that the retired two-lane/platform-connect UI never resurfaces. Pure jsdom render against the real IntegrationsHub — fast, no DB.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-hub-google-ads-single-lane-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4008 — the Google Ads hub card renders ONE credential lane: the
 * GOOGLE_ADS_* env-secret trio that powers EVERY Google Ads surface
 * (Ads Hygiene, Discover Customers, campaign sync, pacing, dashboards,
 * account alerts). The platform-managed google_ads_connection and its
 * Connect/Reconnect OAuth flow are retired.
 *
 * All-status `googleAds` payload shape (server contract, Task #4008):
 *   { configured, connected, loginCustomerId, adsOs: <lane summary|null> }
 *
 * DOM cases:
 *   A. configured=false → amber "Secrets Missing" header badge, the
 *      5-secret setup text, lane badge "Env Credentials Missing", and the
 *      stalled-surfaces attention box. No Discover/Sync buttons.
 *   B. token_rejected → red "Credentials Rejected" header badge, the
 *      healthDetail line, and the rotate-the-trio attention box naming the
 *      GOOGLE_ADS_* secrets + runbook. No Discover/Sync buttons.
 *   C. connected + healthy → green "Connected" badge, MCC line,
 *      Discover Customers + Sync Now buttons, lane "Healthy", the
 *      powered-surfaces caption, freshness line, and NO attention box.
 *   D. lane unavailable (adsOs:null, connected:null — server-side lane
 *      blip) → neutral "Checking…" header badge and "Checking…" lane badge,
 *      never a committed disconnect state.
 *   E. (all cases) the retired two-lane UI is gone: no platform lane, no
 *      "unaffected" note, no Connect/Reconnect buttons.
 *
 * Harness pattern: tests/client/integrations-hub-all-status-unknown.test.tsx.
 * Server-side lane coverage: tests/google-ads-status-adsos-lane.test.ts.
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
  id: "admin-4008",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "team_lead",
};

const HOURS = 60 * 60 * 1000;

// Base payload: everything else quiet/disconnected so only the Google Ads
// card's states vary between cases.
function makeAllStatus(googleAds: Record<string, unknown>): Record<string, unknown> {
  return {
    front: { connected: false },
    slack: { connected: false },
    zoom: { connected: false },
    twilio: { connected: false },
    pandadoc: { connected: false },
    stripe: { connected: false },
    semrush: { connected: false },
    googleAds,
  };
}

function adsOsLane(overrides: Partial<{
  configured: boolean;
  refreshTokenSource: "env" | "none";
  health: string;
  healthDetail: string | null;
  lastDataUpdateAt: string | null;
}>): Record<string, unknown> {
  return {
    configured: true,
    refreshTokenSource: "env",
    health: "unknown",
    healthDetail: null,
    lastDataUpdateAt: null,
    ...overrides,
  };
}

function makeFetchHandler(allStatusJson: unknown): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: allStatusJson },
      { path: "/api/integrations/google-ads/customers", json: { customers: [] } },
      { path: "/api/integrations/google-ads/sync-runs", json: { runs: [] } },
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
const { QueryClientProvider } = await import("@tanstack/react-query");
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

/** The two-lane / platform-connection UI must never resurface (Task #4008). */
function assertRetiredUiAbsent(caseName: string): void {
  for (const id of [
    "lane-google-ads-platform",
    "badge-google-ads-platform-lane",
    "text-google-ads-platform-powers",
    "text-google-ads-adsos-unaffected",
    "button-google-ads-connect",
    "button-google-ads-reconnect",
    "text-google-ads-disconnect-reason",
    "text-google-ads-breaker-cooldown-until",
  ]) {
    assert($(id) === null, `${caseName}: retired testid "${id}" must not render`);
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub Google Ads single-lane card (Task #4008)");

  // Case A — env secrets incomplete.
  activeFetchHandler = makeFetchHandler(
    makeAllStatus({
      configured: false,
      connected: false,
      loginCustomerId: null,
      adsOs: adsOsLane({ configured: false, refreshTokenSource: "none", health: "not_configured" }),
    }),
  );
  let root = await mountHub();
  try {
    const badge = $("badge-google-ads-status");
    assert(badge !== null, "header badge must render");
    assert(
      (badge!.textContent || "").includes("Secrets Missing"),
      `configured:false must badge "Secrets Missing" — got "${badge!.textContent}"`,
    );
    assert(
      /amber/.test(badge!.className),
      `Secrets Missing badge must carry amber styling — got "${badge!.className}"`,
    );
    const setup = $("text-google-ads-not-configured");
    assert(setup !== null, "not-configured setup text must render");
    const setupText = setup!.textContent || "";
    for (const secret of [
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    ]) {
      assert(setupText.includes(secret), `setup text names ${secret} — got "${setupText}"`);
    }
    assert(setupText.includes("GOOGLE_ADS.md"), "setup text points at the GOOGLE_ADS.md runbook");
    assert(
      ($("badge-google-ads-adsos-status")?.textContent || "").includes("Env Credentials Missing"),
      `lane badge must read Env Credentials Missing — got "${$("badge-google-ads-adsos-status")?.textContent}"`,
    );
    const attention = $("text-google-ads-adsos-attention");
    assert(attention !== null, "missing secrets must render the stalled-surfaces attention box");
    assert(
      /every Google Ads surface/i.test(attention!.textContent || "") &&
        /GOOGLE_ADS_\* secrets/.test(attention!.textContent || ""),
      `attention box says every surface is stalled until the secrets are set — got "${attention!.textContent}"`,
    );
    assert($("button-google-ads-discover") === null, "no Discover button when secrets are missing");
    assert($("button-google-ads-sync-now") === null, "no Sync Now button when secrets are missing");
    assertRetiredUiAbsent("A");
    console.log("  ✓ A: secrets missing → amber badge + 5-secret setup text + stalled attention box");
  } finally {
    await unmount(root);
  }

  // Case B — Google terminally rejected the env credential.
  activeFetchHandler = makeFetchHandler(
    makeAllStatus({
      configured: true,
      connected: false,
      loginCustomerId: "8578363654",
      adsOs: adsOsLane({
        health: "token_rejected",
        healthDetail: "OAuth token exchange failed (HTTP 400): invalid_grant",
        lastDataUpdateAt: new Date(Date.now() - 20 * HOURS).toISOString(),
      }),
    }),
  );
  root = await mountHub();
  try {
    const badge = $("badge-google-ads-status");
    assert(
      (badge?.textContent || "").includes("Credentials Rejected"),
      `token_rejected must badge "Credentials Rejected" — got "${badge?.textContent}"`,
    );
    assert(
      /red/.test(badge!.className),
      `Credentials Rejected badge must carry red styling — got "${badge!.className}"`,
    );
    assert(
      ($("badge-google-ads-adsos-status")?.textContent || "").includes("Token Rejected"),
      `lane badge must read Token Rejected — got "${$("badge-google-ads-adsos-status")?.textContent}"`,
    );
    assert(
      /invalid_grant/.test($("text-google-ads-adsos-health-detail")?.textContent || ""),
      "healthDetail line surfaces the rejection detail",
    );
    const attention = $("text-google-ads-adsos-attention");
    assert(attention !== null, "terminal rejection must render the rotation attention box");
    const attentionText = attention!.textContent || "";
    assert(
      /rotate the GOOGLE_ADS_\* secret trio/i.test(attentionText) &&
        /GOOGLE_ADS\.md/.test(attentionText),
      `attention box points rotation at the matching-trio runbook — got "${attentionText}"`,
    );
    assert(
      /every Google Ads surface/i.test(attentionText),
      `attention box names the single-point-of-failure blast radius — got "${attentionText}"`,
    );
    assert($("button-google-ads-discover") === null, "no Discover button when the credential is rejected");
    assert($("button-google-ads-sync-now") === null, "no Sync Now button when the credential is rejected");
    assertRetiredUiAbsent("B");
    console.log("  ✓ B: token_rejected → red badge + healthDetail + rotate-the-trio attention box");
  } finally {
    await unmount(root);
  }

  // Case C — healthy: connected surfaces + powered-surfaces caption.
  activeFetchHandler = makeFetchHandler(
    makeAllStatus({
      configured: true,
      connected: true,
      loginCustomerId: "8578363654",
      adsOs: adsOsLane({
        health: "healthy",
        lastDataUpdateAt: new Date(Date.now() - 2 * HOURS).toISOString(),
      }),
    }),
  );
  root = await mountHub();
  try {
    assert(
      ($("badge-google-ads-status")?.textContent || "").includes("Connected"),
      `connected:true must badge "Connected" — got "${$("badge-google-ads-status")?.textContent}"`,
    );
    assert(
      /8578363654/.test($("text-google-ads-mcc")?.textContent || ""),
      "MCC line renders the login customer id",
    );
    assert($("button-google-ads-discover") !== null, "Discover Customers button renders when connected");
    assert($("button-google-ads-sync-now") !== null, "Sync Now button renders when connected");
    assert(
      ($("badge-google-ads-adsos-status")?.textContent || "").includes("Healthy"),
      `lane badge must read Healthy — got "${$("badge-google-ads-adsos-status")?.textContent}"`,
    );
    const powers = $("text-google-ads-adsos-powers");
    const powersText = powers?.textContent || "";
    for (const surface of [
      "Ads Hygiene",
      "Discover Customers",
      "campaign sync",
      "pacing",
      "dashboards",
      "account alerts",
    ]) {
      assert(powersText.includes(surface), `powered-surfaces caption names "${surface}" — got "${powersText}"`);
    }
    assert(
      /Last data update:/.test($("text-google-ads-adsos-freshness")?.textContent || ""),
      "freshness line renders the last pull timestamp",
    );
    assert($("text-google-ads-adsos-attention") === null, "no attention box when healthy");
    assertRetiredUiAbsent("C");
    console.log("  ✓ C: connected → green badge + MCC + Discover/Sync + powers caption + freshness");
  } finally {
    await unmount(root);
  }

  // Case D — lane unavailable server-side (adsOs:null → connected:null):
  // neutral "Checking…", never a committed disconnect.
  activeFetchHandler = makeFetchHandler(
    makeAllStatus({
      configured: true,
      connected: null,
      loginCustomerId: "8578363654",
      adsOs: null,
    }),
  );
  root = await mountHub();
  try {
    assert(
      ($("badge-google-ads-status")?.textContent || "").includes("Checking"),
      `lane-blip must badge "Checking…" — got "${$("badge-google-ads-status")?.textContent}"`,
    );
    assert(
      ($("badge-google-ads-adsos-status")?.textContent || "").includes("Checking"),
      `lane badge must read Checking… while the lane is unavailable — got "${$("badge-google-ads-adsos-status")?.textContent}"`,
    );
    assert($("button-google-ads-discover") === null, "no Discover button while checking");
    assert($("text-google-ads-adsos-attention") === null, "no attention box while checking");
    assertRetiredUiAbsent("D");
    console.log("  ✓ D: lane blip → neutral Checking… badges, no committed disconnect state");
  } finally {
    await unmount(root);
  }

  console.log("\nintegrations-hub-google-ads-single-lane: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
