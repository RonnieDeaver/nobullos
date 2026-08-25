/* test-registration
{
  "name": "Connection-lost lifecycle in the DOM — terminal network failure shows the single reconnecting banner (zero destructive toasts), probe success (any HTTP status) auto-refetches errored queries incl. meta.silent and dismisses the banner, offline cause + browser online-event recovery (Task #4791)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4791: end-to-end DOM proof of the connection-lost → reconnecting → recovered lifecycle through the REAL shared queryClient wiring (cache onError classification before meta.silent, banner via useSyncExternalStore, outage-window-only probe, recovery refetch). A drift here brings back the exact reported incident: a ~17-minute destructive 'server couldn't be reached' toast plus errored pages that never heal without a manual reload. DB-free, fetch fully stubbed, long timers captured and fired manually — deterministic and fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/connection-lost-recovery-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4791 — DOM lifecycle test for the connection-lost tracker + banner
 * through the REAL shared `queryClient` (so the cache onError classification,
 * the meta.silent ordering, the banner subscription, the probe, and the
 * recovery refetch are all genuinely in the loop).
 *
 * Scenario 1 (network class):
 *   two queries (one non-silent, one meta.silent, both retry:false) die with
 *   "Failed to fetch" → ONE "Connection problem — trying to reconnect…"
 *   banner, ZERO destructive toasts → two failed probes grow the backoff →
 *   server comes back, the next probe gets an HTTP 503 (any status counts as
 *   reachable) → "Connection restored" banner, BOTH errored queries refetch
 *   (silent included) and render healed data → the confirmation timer clears
 *   the banner.
 *
 * Scenario 2 (offline class + online event):
 *   navigator.onLine=false while a refetch fails → banner shows the offline
 *   copy → the browser "online" event (no probe involved) recovers, cancels
 *   the pending probe timer, refetches ONLY the errored query, and the
 *   confirmation clears back to ok.
 *
 * Long timers (probe backoff ≥1.6s, recovered-confirmation 4s) are captured
 * by a ≥500ms setTimeout harness installed BEFORE any client module loads and
 * fired manually; short waits (waitFor sleeps, rAF shim) pass through.
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
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Captured-timer harness (≥500ms) — BEFORE any client module loads ------
//
// Probe backoff (≥1.6s jittered) and the 4s recovered-confirmation must never
// tick on real time in a test; they are captured here and fired manually.
// Everything below 500ms (waitFor sleeps, the rAF shim, react-query
// bookkeeping) passes through to the native timer.

interface CapturedTimer {
  id: number;
  delayMs: number;
  fn: () => void;
  cleared: boolean;
  fired: boolean;
}
const NATIVE_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis);
const NATIVE_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis);
const capturedTimers: CapturedTimer[] = [];
let nextCapturedId = 1;

(globalThis as any).setTimeout = ((fn: any, delay?: number, ...args: any[]) => {
  const ms = Number(delay) || 0;
  if (ms >= 500) {
    const entry: CapturedTimer = {
      id: nextCapturedId++,
      delayMs: ms,
      fn: () => fn(...args),
      cleared: false,
      fired: false,
    };
    capturedTimers.push(entry);
    return {
      __capturedId: entry.id,
      unref() {
        return this;
      },
      ref() {
        return this;
      },
    };
  }
  return NATIVE_SET_TIMEOUT(fn, ms, ...args);
}) as any;

(globalThis as any).clearTimeout = ((handle: any) => {
  if (handle && typeof handle === "object" && typeof handle.__capturedId === "number") {
    const entry = capturedTimers.find((t) => t.id === handle.__capturedId);
    if (entry) entry.cleared = true;
    return;
  }
  return NATIVE_CLEAR_TIMEOUT(handle);
}) as any;

function pendingCaptured(): CapturedTimer[] {
  return capturedTimers.filter((t) => !t.cleared && !t.fired);
}

/**
 * The tracker's own timers: probe backoff (jittered, ≤144s) and the 4s
 * recovered-confirmation. react-query schedules its own long bookkeeping
 * timers alongside (gcTime 600s; staleTime 300s) — those are library
 * internals, not part of this lifecycle, so the assertions ignore them.
 */
function pendingTrackerTimers(): CapturedTimer[] {
  return pendingCaptured().filter((t) => t.delayMs < 200_000);
}

const jsonResponse = createJsonResponse(dom.window.Headers as any);

// ---- Fetch stub -------------------------------------------------------------

const serverState = {
  /** Controls the HEAD reachability probe: false → fetch rejects. */
  reachable: false,
  /** Controls the two API endpoints: false → fetch rejects (network class). */
  apiHealthy: false,
};
const attempts = { main: 0, silent: 0, head: 0 };

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = (init?.method || "GET").toUpperCase();
  if (method === "HEAD") {
    attempts.head++;
    if (!serverState.reachable) throw new TypeError("Failed to fetch");
    // ANY HTTP response proves reachability — return a boot-gate-style 503 to
    // pin the "status is irrelevant" contract of the probe.
    return jsonResponse(503, { error: "booting" });
  }
  if (url.includes("/api/conn-main")) {
    attempts.main++;
    if (!serverState.apiHealthy) throw new TypeError("Failed to fetch");
    return jsonResponse(200, { value: "healed-main" });
  }
  if (url.includes("/api/conn-silent")) {
    attempts.silent++;
    if (!serverState.apiHealthy) throw new TypeError("Failed to fetch");
    return jsonResponse(200, { value: "healed-silent" });
  }
  return jsonResponse(200, {});
};

// ---- Helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => NATIVE_SET_TIMEOUT(r, ms));
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function byTestId(id: string): Element | null {
  return dom.window.document.querySelector(`[data-testid="${id}"]`);
}

function bannerText(): string {
  return byTestId("banner-connection-lost")?.textContent || "";
}

function setNavigatorOnLine(value: boolean): void {
  Object.defineProperty(dom.window.navigator, "onLine", {
    value,
    configurable: true,
  });
}

// ---- Run --------------------------------------------------------------------

async function run() {
  (globalThis as any).__capturedToasts = [];

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClientProvider, useQuery } = (await import("@tanstack/react-query")) as any;
  const { queryClient } = (await import("@/lib/queryClient")) as any;
  const { __test_resetConnectionLostTracker } = await import("@/lib/connectionLost");
  const ConnectionStatusBanner = (await import("@/components/ConnectionStatusBanner"))
    .default as any;

  // Defensive: a fresh outage ledger even if a batched sibling touched the
  // singleton earlier in this realm.
  __test_resetConnectionLostTracker();
  queryClient.clear();

  function Harness() {
    const main = useQuery({ queryKey: ["/api/conn-main"], retry: false });
    const silent = useQuery({
      queryKey: ["/api/conn-silent"],
      retry: false,
      meta: { silent: true },
    });
    return React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { "data-testid": "main-status" },
        `${main.status}:${(main.data as any)?.value ?? ""}`,
      ),
      React.createElement(
        "div",
        { "data-testid": "silent-status" },
        `${silent.status}:${(silent.data as any)?.value ?? ""}`,
      ),
      React.createElement(ConnectionStatusBanner),
    );
  }

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Harness),
      ),
    );
    await sleep(0);
  });

  // ===========================================================================
  // Scenario 1 — network class: banner in, backoff probes, 503 probe success,
  // errored queries (incl. silent) refetch, confirmation clears the banner.
  // ===========================================================================

  await waitFor(
    "reconnecting banner appears after terminal network failures",
    () => byTestId("banner-connection-lost") !== null,
  );
  assert.ok(
    bannerText().includes("Connection problem"),
    `network cause shows the reconnect copy, got: ${bannerText()}`,
  );
  assert.equal(
    dom.window.document.querySelectorAll('[data-testid="banner-connection-lost"]').length,
    1,
    "exactly ONE banner — two failing queries must not stack indicators",
  );
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    `network-class failures must fire ZERO destructive toasts, got ${JSON.stringify(
      (globalThis as any).__capturedToasts,
    )}`,
  );
  await waitFor("main query reaches error state", () =>
    (byTestId("main-status")?.textContent || "").startsWith("error"),
  );

  // Exactly one pending probe, at the quick-first-probe delay (2s ±20%).
  assert.equal(
    pendingTrackerTimers().length,
    1,
    `one pending probe timer while lost — got delays ${JSON.stringify(
      pendingTrackerTimers().map((t) => t.delayMs),
    )}`,
  );
  const probe1 = pendingTrackerTimers()[0];
  assert.ok(
    probe1.delayMs >= 1600 && probe1.delayMs <= 2400,
    `first probe delay within jittered initial window, got ${probe1.delayMs}`,
  );

  // Fire probe #1 while still unreachable → rejected → backoff grows (5s ±20%).
  await act(async () => {
    probe1.fired = true;
    probe1.fn();
    await sleep(10);
  });
  assert.equal(attempts.head, 1, "probe #1 hit the HEAD reachability path");
  assert.ok(byTestId("banner-connection-lost"), "still lost after failed probe");
  assert.equal(pendingTrackerTimers().length, 1, "failed probe reschedules exactly one timer");
  const probe2 = pendingTrackerTimers()[0];
  assert.ok(
    probe2.delayMs >= 4000 && probe2.delayMs <= 6000,
    `second probe delay follows the 5s backoff step, got ${probe2.delayMs}`,
  );

  // Fire probe #2 still down → third step doubles again (10s ±20%).
  await act(async () => {
    probe2.fired = true;
    probe2.fn();
    await sleep(10);
  });
  assert.equal(attempts.head, 2, "probe #2 ran");
  const probe3 = pendingTrackerTimers()[0];
  assert.ok(
    probe3.delayMs >= 8000 && probe3.delayMs <= 12000,
    `third probe delay doubles, got ${probe3.delayMs}`,
  );

  // Server returns (behind a boot-gate 503) — probe success recovers.
  serverState.reachable = true;
  serverState.apiHealthy = true;
  await act(async () => {
    probe3.fired = true;
    probe3.fn();
    await sleep(10);
  });

  await waitFor(
    "restored banner replaces the reconnecting banner",
    () => byTestId("banner-connection-restored") !== null,
  );
  assert.equal(byTestId("banner-connection-lost"), null, "lost banner dismissed on recovery");

  // Auto-heal: BOTH errored queries (silent included) refetched to success.
  await waitFor("non-silent query healed without reload", () =>
    (byTestId("main-status")?.textContent || "") === "success:healed-main",
  );
  await waitFor("meta.silent query healed without reload", () =>
    (byTestId("silent-status")?.textContent || "") === "success:healed-silent",
  );
  assert.equal(attempts.main, 2, "main query: initial failure + exactly one recovery refetch");
  assert.equal(attempts.silent, 2, "silent query: initial failure + exactly one recovery refetch");
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    "recovery stays toast-free",
  );

  // Confirmation timer (exact 4s, no jitter) clears the restored banner.
  const confirmation = pendingTrackerTimers().find((t) => t.delayMs === 4000);
  assert.ok(confirmation, "recovered-confirmation timer scheduled at exactly 4000ms");
  await act(async () => {
    confirmation!.fired = true;
    confirmation!.fn();
    await sleep(10);
  });
  assert.equal(byTestId("banner-connection-restored"), null, "confirmation clears the banner");
  assert.equal(byTestId("banner-connection-lost"), null, "no banner in ok phase");

  console.log(
    "  ✓ Scenario 1: network loss → single banner (0 toasts) → backoff probes → 503 probe success → silent+non-silent queries healed → banner cleared",
  );

  // ===========================================================================
  // Scenario 2 — offline class: offline copy, then browser `online` event
  // recovery (no probe run), refetching ONLY the errored query.
  // ===========================================================================

  serverState.reachable = false;
  serverState.apiHealthy = false;
  setNavigatorOnLine(false);
  const headBefore = attempts.head;

  await act(async () => {
    void queryClient.refetchQueries({ queryKey: ["/api/conn-main"] });
    await sleep(10);
  });

  await waitFor(
    "offline banner appears",
    () => bannerText().includes("offline"),
  );
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    "offline-class failure fires no destructive toast",
  );
  const offlineProbe = pendingTrackerTimers().find((t) => t.delayMs >= 1600 && t.delayMs <= 2400);
  assert.ok(offlineProbe, "a probe is scheduled while offline too");

  // Connection returns: browser fires `online` — recovery WITHOUT a probe.
  setNavigatorOnLine(true);
  serverState.reachable = true;
  serverState.apiHealthy = true;
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("online"));
    await sleep(10);
  });

  await waitFor(
    "restored banner after online event",
    () => byTestId("banner-connection-restored") !== null,
  );
  assert.equal(offlineProbe!.cleared, true, "online recovery cancels the pending probe");
  assert.equal(attempts.head, headBefore, "no probe ran — the online event recovered first");
  await waitFor("errored query healed after online event", () =>
    (byTestId("main-status")?.textContent || "") === "success:healed-main",
  );
  assert.equal(
    attempts.silent,
    2,
    "healthy silent query NOT refetched again — recovery targets errored queries only",
  );

  const confirmation2 = pendingTrackerTimers().find((t) => t.delayMs === 4000);
  assert.ok(confirmation2, "second recovered-confirmation scheduled");
  await act(async () => {
    confirmation2!.fired = true;
    confirmation2!.fn();
    await sleep(10);
  });
  assert.equal(byTestId("banner-connection-restored"), null, "banner fully cleared");

  console.log(
    "  ✓ Scenario 2: offline copy → online event recovery (probe cancelled, errored-only refetch) → banner cleared",
  );

  await act(async () => {
    root.unmount();
  });
  __test_resetConnectionLostTracker();
}

run()
  .then(() => {
    console.log("\nPASS tests/client/connection-lost-recovery.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/connection-lost-recovery.test.tsx");
    console.error(err);
    process.exit(1);
  });
