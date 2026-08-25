/* test-registration
{
  "name": "Ads Hygiene reconnect banner RENDERS on screen when Google Ads drops — pacing + LSA tabs (Tasks #2796/#2804)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2796 (+#2804): the on-screen counterpart of the #2794 contract — the /admin/ads-hygiene page must actually RENDER the reconnect banner (with the lastError line + Integrations link) and suppress the generic inline error card on BOTH the Budget Pacing and LSA tabs when a query fails with the structured disconnect 503. A page refactor could drop the banner or a card's guard without the route test noticing. Fast, deterministic jsdom render — no DB, fully stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-hygiene-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2796 — the /admin/ads-hygiene reconnect banner must actually render
 * on screen when Google Ads drops.
 *
 * Task #2794 added the page-level "Google Ads is disconnected — reconnect it
 * in Settings → Integrations" banner on GoogleAdsHygieneAudit, keyed off the
 * shared `parseGoogleAdsDisconnectedError` predicate. The route-level 503
 * contract and the parser are regression-tested
 * (tests/google-ads-hygiene-disconnected-503.test.ts), but nothing verified
 * the banner's on-screen rendering — a page refactor could drop it without
 * any test failing.
 *
 * This test mounts the REAL page against the real production queryClient with
 * a stubbed fetch (mirrors tests/client/integrations-reconnect-banner.test.tsx):
 *
 *   Scenario 1 — the pacing query rejects with the exact `"503: {json}"`
 *   disconnect error string the client's apiRequest would throw. Asserts:
 *     - `banner-google-ads-disconnected` renders,
 *     - the `Last error:` line surfaces the stored lastError,
 *     - the banner links to /admin/integrations,
 *     - the generic inline "Failed to load pacing data." card is SUPPRESSED
 *       (the banner owns the disconnected state).
 *
 *   Scenario 2 (control) — the pacing query rejects with a generic 500.
 *   Asserts the banner does NOT render and the generic pacing error card DOES,
 *   proving the banner is keyed to the structured disconnect code and the
 *   suppression doesn't hide real errors.
 *
 *   Scenario 3 (Task #2804) — the LSA query rejects with the structured
 *   disconnect 503. Asserts the banner renders while the generic
 *   "Failed to load LSA data." card is SUPPRESSED — the same
 *   `!parseGoogleAdsDisconnectedError(...)` guard protects the LSA tab's
 *   error card, and nothing else covers its rendered DOM.
 *
 *   Scenario 4 (control) — the LSA query rejects with a generic 500.
 *   Asserts the banner does NOT render and "Failed to load LSA data." DOES,
 *   proving the LSA suppression is disconnect-specific too.
 *
 * The page's account picker is a Popover + cmdk combobox (Task #3091). Radix
 * Popover never portals its content into the bare jsdom harness, so
 * `@radix-ui/react-popover` is redirected to the inline shim
 * `tests/client/ads-hygiene-popover-shim.mjs` (which renders the popover
 * content inline and unconditionally) via
 * `--import ./tests/client/ris-setup-bigquery-mock-setup.mjs` (the established
 * resolve-hook pattern — see .agents/memory/radix-portal-jsdom-tests.md).
 * cmdk itself renders inline and needs no shim.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/ads-hygiene" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || function () { return false; };
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture =
  (dom.window.HTMLElement.prototype as any).setPointerCapture || function () {};
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
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const CEO_USER = {
  id: "ceo-2796",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const CUSTOMER_ID = "1234567890";
const LAST_ERROR = "invalid_grant: Token has been expired or revoked.";

// The exact structured payload the server's respondGoogleAdsDisconnected
// emits (Task #2794, copy reshaped by Task #4008's env-credential model);
// apiRequest surfaces it as `Error("503: <json body>")`.
const DISCONNECT_BODY = {
  code: "google_ads_disconnected",
  message:
    "Google Ads credentials are missing or were rejected — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md).",
  reason: `Google Ads credential rejected by Google: ${LAST_ERROR} — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)`,
  lastError: LAST_ERROR,
};

// "disconnect" → the query rejects with the structured 503;
// "generic" → the query rejects with a plain 500;
// "ok" → the query resolves (empty payload).
type FailureMode = "disconnect" | "generic" | "ok";

type Scenario = {
  pacingFailure: FailureMode;
  lsaFailure: FailureMode;
};

function respondFor(mode: FailureMode): { status: number; json: any } {
  if (mode === "disconnect") return { status: 503, json: DISCONNECT_BODY };
  if (mode === "generic") return { status: 500, json: { error: "GAQL query failed" } };
  return { status: 200, json: {} };
}

function makeHandler(s: Scenario): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/auth/user", json: CEO_USER },
      {
        path: "/api/admin/google-ads-audit/accounts",
        json: {
          accounts: [
            {
              customerId: CUSTOMER_ID,
              descriptiveName: "NoBull Test Account",
              status: "ENABLED",
              nobullClientId: null,
            },
          ],
        },
      },
      { path: /\/api\/admin\/google-ads-audit\/[^/]+\/runs$/, json: { runs: [] } },
      {
        path: /\/api\/admin\/google-ads-hygiene\/[^/]+\/pacing$/,
        respond: () => respondFor(s.pacingFailure),
      },
      {
        path: /\/api\/admin\/google-ads-hygiene\/[^/]+\/lsa$/,
        respond: () => respondFor(s.lsaFailure),
      },
    ],
    // Permissive catch-all carrying the common list shapes so any other panel
    // query resolves without crashing the page mount.
    defaultJson: {
      rows: [],
      runs: [],
      accounts: [],
      items: [],
      alerts: [],
      results: [],
      runAt: null,
      clickupConfigured: false,
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
const GoogleAdsHygieneAudit = (
  await import("../../client/src/pages/admin/GoogleAdsHygieneAudit")
).default;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// The global transient-retry policy (client/src/lib/queryClient.ts) retries
// bare 5xx responses with real backoff (1s + 2s, TRANSIENT_QUERY_RETRY_LIMIT=2),
// so a generic-500 query only lands in error state ~3s after it fires. Poll
// real time (up to 10s) for the error card instead of relying on flush().
async function waitForBodyText(text: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((document.body.textContent || "").includes(text)) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
  }
  return (document.body.textContent || "").includes(text);
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function clickLikeUser(el: HTMLElement): Promise<void> {
  // Radix triggers activate on mousedown, not just click — dispatch the full
  // gesture so React's synthetic-event tree sees what a real user produces.
  await act(async () => {
    el.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.click();
  });
  await flush(8);
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(GoogleAdsHygieneAudit as any),
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

// Selects the seeded account (via the combobox rendered inline by the
// popover shim) and opens the given tab so its query fires against the
// active fetch handler.
async function driveToTab(tabTestId: string): Promise<void> {
  const trigger = $("select-account");
  assert(trigger !== null, "account combobox trigger must render");
  await clickLikeUser(trigger!);

  const option = $(`option-account-${CUSTOMER_ID}`);
  assert(option !== null, "account option must render inline via the popover shim");
  await clickLikeUser(option!);

  const tab = $(tabTestId);
  assert(tab !== null, `${tabTestId} trigger must render after picking an account`);
  await clickLikeUser(tab!);
}

// ── Scenario 1: structured disconnect 503 → banner renders, generic card suppressed ──
console.log("\n— Scenario 1: pacing rejects with the structured disconnect 503 —");
activeFetchHandler = makeHandler({ pacingFailure: "disconnect", lsaFailure: "ok" });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    await driveToTab("tab-pacing");

    const banner = $("banner-google-ads-disconnected");
    assert(banner !== null, "reconnect banner must render when a query fails with google_ads_disconnected");

    const message = $("text-google-ads-disconnected-message");
    assert(message !== null, "banner headline must render");
    assert(
      (message!.textContent || "").includes("rotate the GOOGLE_ADS_* secret trio"),
      `banner headline must carry the Task #4008 rotate-secrets copy, got: ${message!.textContent}`,
    );

    const link = $("link-reconnect-google-ads");
    assert(link !== null, "banner must render the Integrations Hub status link");
    assert(
      (link as HTMLAnchorElement).getAttribute("href") === "/admin/integrations",
      `reconnect link must point at /admin/integrations, got: ${(link as HTMLAnchorElement).getAttribute("href")}`,
    );
    assert(
      (link!.textContent || "").includes("Settings → Integrations"),
      `reconnect link must read "Settings → Integrations", got: ${link!.textContent}`,
    );

    const lastErrorLine = $("text-google-ads-last-error");
    assert(lastErrorLine !== null, "banner must render the Last error line when lastError is present");
    assert(
      (lastErrorLine!.textContent || "").includes(LAST_ERROR),
      `Last error line must surface the stored lastError "${LAST_ERROR}", got: ${lastErrorLine!.textContent}`,
    );

    // The banner owns the disconnected state — the generic inline pacing
    // error card must be suppressed.
    const pageText = document.body.textContent || "";
    assert(
      !pageText.includes("Failed to load pacing data."),
      "generic 'Failed to load pacing data.' card must be suppressed when the failure is the structured disconnect",
    );

    console.log("  ✓ banner + Last error line + /admin/integrations link render; generic pacing card suppressed");
  } finally {
    await unmount(root);
  }
}

// ── Scenario 2 (control): generic 500 → no banner, generic card renders ──
console.log("\n— Scenario 2: pacing rejects with a generic 500 —");
activeFetchHandler = makeHandler({ pacingFailure: "generic", lsaFailure: "ok" });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    await driveToTab("tab-pacing");

    assert(
      $("banner-google-ads-disconnected") === null,
      "reconnect banner must NOT render for a generic (non-disconnect) pacing failure",
    );

    assert(
      await waitForBodyText("Failed to load pacing data."),
      "generic 'Failed to load pacing data.' card must render for a generic pacing failure (after transient retries exhaust)",
    );
    assert(
      $("banner-google-ads-disconnected") === null,
      "reconnect banner must still be absent after the generic pacing failure settles",
    );

    console.log("  ✓ no banner; generic pacing error card renders (suppression is disconnect-specific)");
  } finally {
    await unmount(root);
  }
}

// ── Scenario 3 (Task #2804): LSA disconnect 503 → banner renders, LSA card suppressed ──
console.log("\n— Scenario 3: LSA rejects with the structured disconnect 503 —");
activeFetchHandler = makeHandler({ pacingFailure: "ok", lsaFailure: "disconnect" });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    await driveToTab("tab-lsa");

    const banner = $("banner-google-ads-disconnected");
    assert(
      banner !== null,
      "reconnect banner must render when the LSA query fails with google_ads_disconnected",
    );

    const link = $("link-reconnect-google-ads");
    assert(link !== null, "banner must render the reconnect link on the LSA tab too");
    assert(
      (link as HTMLAnchorElement).getAttribute("href") === "/admin/integrations",
      `reconnect link must point at /admin/integrations, got: ${(link as HTMLAnchorElement).getAttribute("href")}`,
    );

    // The banner owns the disconnected state — the generic inline LSA error
    // card must be suppressed by its !parseGoogleAdsDisconnectedError guard.
    const pageText = document.body.textContent || "";
    assert(
      !pageText.includes("Failed to load LSA data."),
      "generic 'Failed to load LSA data.' card must be suppressed when the failure is the structured disconnect",
    );

    console.log("  ✓ banner renders on the LSA tab; generic LSA error card suppressed");
  } finally {
    await unmount(root);
  }
}

// ── Scenario 4 (control): LSA generic 500 → no banner, LSA card renders ──
console.log("\n— Scenario 4: LSA rejects with a generic 500 —");
activeFetchHandler = makeHandler({ pacingFailure: "ok", lsaFailure: "generic" });
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    await driveToTab("tab-lsa");

    assert(
      $("banner-google-ads-disconnected") === null,
      "reconnect banner must NOT render for a generic (non-disconnect) LSA failure",
    );

    assert(
      await waitForBodyText("Failed to load LSA data."),
      "generic 'Failed to load LSA data.' card must render for a generic LSA failure (after transient retries exhaust)",
    );
    assert(
      $("banner-google-ads-disconnected") === null,
      "reconnect banner must still be absent after the generic LSA failure settles",
    );

    console.log("  ✓ no banner; generic LSA error card renders (suppression is disconnect-specific)");
  } finally {
    await unmount(root);
  }
}

console.log(
  "\nads-hygiene-reconnect-banner: the Task #2794 reconnect banner renders on screen (with lastError + Integrations link, generic cards suppressed) on both the Budget Pacing and LSA tabs, and stays absent for generic failures.",
);
