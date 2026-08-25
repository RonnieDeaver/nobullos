/* test-registration
{
  "name": "Dashboard transient/terminal data-load resilience — retry self-heal, no global toast, inline retryable error, no misleading empty/zero (Task #2675)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2675: the main dashboard's transient/terminal data-load resilience is the fix for the recurring \"Network error toast + zeros / 'No clients yet' while still signed in\" reports. A regression in the per-query backoff retry, the `meta.silent` toast suppression, or the inline retryable error (vs the misleading empty/zero state) would silently bring the false-failure UX back. Gate this fast, DB-free, deterministic jsdom render (fetch fully stubbed, toast captured) so any drift on the dashboard resilience contract fails fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/dashboard-resilience-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2675 — The main dashboard (`client/src/pages/Dashboard.tsx`, route `/`)
 * must SELF-HEAL transient partial data-load failures instead of flashing the
 * global "Network error" / "Request failed" toast and collapsing to
 * zeros / "Unknown" / "No clients yet" while the user is still signed in.
 *
 * This mirrors the resilience contract MERGED Task #1625 shipped for the DB
 * Health dashboard:
 *   - Each dashboard data query carries `meta.silent` so a recovered blip never
 *     fires the shared QueryCache.onError toast.
 *   - A status-carrying error type drives a backoff retry on transient (network
 *     / 5xx) failures and NO retry on terminal 4xx.
 *   - When `/api/dashboard/client-summaries` fails terminally (while
 *     `/api/reports` succeeds and auth holds), the UI shows an inline, RETRYABLE
 *     "Couldn't load your accounts" state — NOT the misleading "No clients yet."
 *     empty state — the client count / health stats show "—" not 0, and report
 *     rows whose client can't be resolved read "Account unavailable" not
 *     "Unknown". Clicking Retry refetches and recovers.
 *
 * Two end-to-end scenarios are exercised against the REAL Dashboard mounted in
 * jsdom with the REAL shared `queryClient` (so `meta.silent` + the global
 * onError toast path are genuinely in the loop):
 *
 *   A. TRANSIENT: client-summaries fails (network) twice, then succeeds → the
 *      account table renders, NO toast fired, NO error banner.
 *   B. TERMINAL: client-summaries fails (network) on every attempt → inline
 *      "Couldn't load your accounts" + Retry button, count "—", report row
 *      "Account unavailable", NO toast, NO "No clients yet". Then the next
 *      attempt is wired to succeed and Retry recovers the table.
 *
 * The toast surface is captured via a use-toast stub loader; Radix primitives
 * and the heavy DismissReasonDialog leaf are shimmed by the heavyClientLoader.
 * See `tests/dashboard-resilience-setup.mjs`.
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createJsonResponse } from "../helpers/createFetchStub.mjs";

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
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const jsonResponse = createJsonResponse(dom.window.Headers as any);

// ---- Fixtures ---------------------------------------------------------------

const TEST_USER = {
  id: "user-1",
  email: "lead@example.com",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead",
  profileImageUrl: null,
};

const CLIENT_SUMMARY = {
  id: "client-1",
  clientCode: "ACME",
  firmName: "Acme Law Firm",
  contactName: "Jane Doe",
  products: [] as string[],
  practiceAreas: [] as string[],
  clientStartDate: "2025-01-01",
  ownerId: "user-1",
  ownerName: "Lead User",
  ownerAvatar: null,
  lastCommDate: "2026-06-01T00:00:00.000Z",
  commCount30d: 5,
  commCountTotal: 50,
  touchpointCount30d: 2,
  touchpointCountTotal: 20,
  lastTouchpointDate: "2026-06-01T00:00:00.000Z",
  judgmentStatus: "Healthy",
  relationshipHealth: "good",
  judgmentHeadline: "All good",
  judgmentDate: "2026-06-01T00:00:00.000Z",
  lastReviewedAt: "2026-06-01T00:00:00.000Z",
  budgetPosture: null,
};

// A report whose clientId is NOT in the (failed) summaries set, so its rendered
// firm name must fall through to the failure-aware "Account unavailable".
const ORPHAN_REPORT = {
  id: "report-1",
  clientId: "client-unknown",
  reportMonth: "2026-05",
  status: "final",
};

// ---- Per-attempt client-summaries controller -------------------------------

type Verdict = "network" | "ok";
const summariesController = {
  attempts: 0,
  queue: [] as Verdict[],
  next(): Verdict {
    this.attempts++;
    // Once the queue is drained, keep returning its last verdict (so a
    // "terminal" scenario stays failed, and a recovered scenario stays ok).
    return this.queue.length > 1 ? (this.queue.shift() as Verdict) : this.queue[0];
  },
};

// ---- Fetch stub -------------------------------------------------------------

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = (init?.method || "GET").toUpperCase();

  // Task #4791 — the connection-lost tracker probes reachability with
  // `HEAD /` after a terminal network-class failure (scenario B). Keep the
  // outage "real" for the tracker by rejecting the probe too; otherwise a
  // jittered probe success mid-scenario would refetch errored queries and
  // race this suite's inline-error assertions.
  if (method === "HEAD") {
    throw new TypeError("Failed to fetch");
  }

  if (url.includes("/api/dashboard/client-summaries")) {
    const verdict = summariesController.next();
    if (verdict === "network") {
      // Browser network failure: fetch rejects with a TypeError.
      throw new TypeError("Failed to fetch");
    }
    return jsonResponse(200, [CLIENT_SUMMARY]);
  }
  if (url.includes("/api/auth/user")) return jsonResponse(200, TEST_USER);
  if (url.includes("/api/reports")) return jsonResponse(200, [ORPHAN_REPORT]);
  if (url.includes("/api/notifications/unread-count")) return jsonResponse(200, { count: 0 });
  // WinFeedCard expects an array; the `{}` fallthrough below crashes its render.
  if (url.includes("/api/dashboard/wins")) return jsonResponse(200, []);
  if (url.includes("/api/monthly-review-stats"))
    return jsonResponse(200, { reviewed: 0, needsReview: 0, total: 0 });
  if (url.includes("/api/monthly-review-notifications") && method === "POST")
    return jsonResponse(200, {});
  return jsonResponse(200, {});
};

// ---- Helpers ----------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function bodyText(): string {
  return dom.window.document.body.textContent || "";
}

function byTestId(id: string): Element | null {
  return dom.window.document.querySelector(`[data-testid="${id}"]`);
}

// ---- Run --------------------------------------------------------------------

async function run() {
  (globalThis as any).__capturedToasts = [];

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const { queryClient } = (await import("@/lib/queryClient")) as any;
  const { __test_resetConnectionLostTracker } = (await import("@/lib/connectionLost")) as any;
  const Dashboard = (await import("@/pages/Dashboard")).default as any;

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  function mount() {
    act(() => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Dashboard),
        ),
      );
    });
  }

  // ===========================================================================
  // Scenario A — transient: fail (network) x2, then succeed. No toast, no banner.
  // ===========================================================================
  // Reset the module-level connectionLostTracker singleton so Scenario A
  // starts from a clean "ok" state — no stale probe/recovery timers from a
  // prior run can race against the retry assertions.
  __test_resetConnectionLostTracker();
  summariesController.attempts = 0;
  summariesController.queue = ["network", "network", "ok"];
  queryClient.clear();
  (globalThis as any).__capturedToasts = [];

  mount();

  await waitFor(
    "account table renders after transient failure recovers",
    () => bodyText().includes("Acme Law Firm"),
  );

  // The retry path must have actually been exercised (>=3 attempts: 2 fail + 1 ok).
  assert.ok(
    summariesController.attempts >= 3,
    `expected >=3 client-summaries attempts (retry engaged), got ${summariesController.attempts}`,
  );
  // No global toast for a recovered blip.
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    `expected NO toast on transient recovery, got ${JSON.stringify((globalThis as any).__capturedToasts)}`,
  );
  // No top-level error banner, no inline accounts error.
  assert.equal(byTestId("error-banner"), null, "error banner must be absent after recovery");
  assert.equal(byTestId("clients-load-error"), null, "inline accounts error must be absent after recovery");
  // Genuine-empty state must NOT be shown when data is present.
  assert.equal(byTestId("text-no-clients"), null, "'No clients yet' must not show when accounts loaded");

  console.log("  ✓ Scenario A: transient client-summaries failure self-heals (retry, no toast, table renders)");

  // ===========================================================================
  // Scenario B — terminal: fail (network) every attempt → inline retryable
  // error, "—" stats, "Account unavailable" report row, no toast, no
  // "No clients yet". Then Retry (next attempt succeeds) recovers.
  // ===========================================================================
  // Reset the tracker between scenarios: after Scenario A's recovery the
  // tracker is in "recovered" state with a 4 s confirmation timer pending.
  // Without this reset the recoveredTimer can fire mid-Scenario-B and call
  // refetchQueries on errored queries, briefly flipping "Account unavailable"
  // back to "Unknown" and racing the inline-error assertions.
  __test_resetConnectionLostTracker();
  summariesController.attempts = 0;
  summariesController.queue = ["network"]; // sticky-fail until we flip it below
  queryClient.clear();
  (globalThis as any).__capturedToasts = [];

  mount();

  await waitFor(
    "inline accounts load error appears after terminal failure",
    () => byTestId("clients-load-error") !== null,
  );

  // No misleading empty state and no toast.
  assert.equal(byTestId("text-no-clients"), null, "'No clients yet' must not show on load failure");
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    `expected NO toast on terminal failure (meta.silent), got ${JSON.stringify((globalThis as any).__capturedToasts)}`,
  );

  // A recoverable Retry control is present.
  const retryBtn = byTestId("button-retry-summaries");
  assert.ok(retryBtn, "inline Retry button must be present");

  // Client count stat degrades to "—", not a misleading 0.
  const countEl = byTestId("text-client-count");
  assert.ok(countEl, "client count stat must render");
  assert.equal((countEl!.textContent || "").trim(), "—", "client count must be '—' on load failure, not 0");

  // Report row whose client can't be resolved reads the failure-aware label.
  assert.ok(
    bodyText().includes("Account unavailable"),
    "report row must read 'Account unavailable' (not 'Unknown') when summaries failed",
  );
  assert.ok(
    !bodyText().includes("Unknown"),
    "report row must not read 'Unknown' when summaries failed",
  );

  // Flip the source to healthy and click Retry → table recovers.
  summariesController.queue = ["ok"];
  await act(async () => {
    (retryBtn as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });

  await waitFor(
    "account table renders after Retry",
    () => bodyText().includes("Acme Law Firm"),
  );
  assert.equal(byTestId("clients-load-error"), null, "inline error must clear after successful Retry");
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    "still no toast after Retry recovery",
  );

  console.log("  ✓ Scenario B: terminal failure → inline retryable error (no toast, '—', 'Account unavailable') → Retry recovers");

  act(() => root.unmount());
}

run()
  .then(() => {
    console.log("\nPASS tests/client/dashboard-transient-resilience.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/dashboard-transient-resilience.test.tsx");
    console.error(err);
    process.exit(1);
  });
