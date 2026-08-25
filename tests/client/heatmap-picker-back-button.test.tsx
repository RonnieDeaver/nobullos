/* test-registration
{
  "name": "HeatmapPicker Back button unsticks + mid-fetch campaign re-entry never sticks or double-fetches (Tasks #2886, #2888)",
  "regression": true,
  "sweepOnlyReason": "Task #2886 — pure client-side state regression (no DB/network); HeavyClientLoader+dialog-shim jsdom render, not a smoke-gate candidate (not in the shared DB-heavy or time-bounded slow tier).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/heatmap-picker-back-button-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/HeatmapPicker.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Regression test for the dead "← Back to campaigns" button in HeatmapPicker.
 *
 * Scenario: a client has exactly one mapped SEMrush campaign.  An
 * auto-select effect fires on open and selects it, which immediately triggers
 * the auto bulk-fetch.  Before this fix, pressing "← Back to campaigns" set
 * selectedCampaignId to null, but the same auto-select effect re-fired on the
 * next render and re-selected the lone campaign — making the button look
 * completely dead, especially while the fetch spinner was running.
 *
 * The fix introduces a `userWentBack` ref that:
 *   1. Blocks the auto-select effect from re-selecting after explicit Back.
 *   2. Causes late bulk-fetch results (for the campaign the user left) to be
 *      discarded rather than re-populating the campaign view.
 *
 * Assertions:
 *   a. On open, the lone campaign is auto-selected (campaign view shown).
 *   b. Pressing Back returns to the campaign list and stays there.
 *   c. A late-arriving bulk-fetch completion for the deselected campaign does
 *      NOT push the user back into the campaign view.
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
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = (dom.window as any).FocusEvent || dom.window.Event;
(globalThis as any).PointerEvent = (dom.window as any).PointerEvent || (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
    dispatchEvent() { return false; },
  }));
if (!(dom.window.HTMLElement.prototype as any).hasPointerCapture) {
  (dom.window.HTMLElement.prototype as any).hasPointerCapture = () => false;
}
if (!(dom.window.HTMLElement.prototype as any).releasePointerCapture) {
  (dom.window.HTMLElement.prototype as any).releasePointerCapture = () => {};
}
if (!(dom.window.HTMLElement.prototype as any).setPointerCapture) {
  (dom.window.HTMLElement.prototype as any).setPointerCapture = () => {};
}
if (!(dom.window.HTMLElement.prototype as any).scrollIntoView) {
  (dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

// ---------------------------------------------------------------------------
// Deferred fetch-all-heatmaps latch — lets the test control when the
// in-flight POST resolves without a real network call.
// ---------------------------------------------------------------------------
let resolveHeatmapFetch: ((value: any) => void) | null = null;
let heatmapFetchCallCount = 0;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: /\/api\/semrush\/status/, json: { configured: true, connected: true, expired: false } },
    {
      path: /\/api\/clients\/client-2886\/semrush-mapped-campaigns/,
      json: {
        campaigns: [
          {
            semrushCampaignId: "camp-2886",
            semrushCampaignName: "Personal Injury – Austin",
            locationId: "loc-2886",
            locationName: "Austin Office",
            locationAddress: null,
            locationCity: null,
            locationState: null,
          },
        ],
        semrushAvailable: true,
      },
    },
    {
      path: /\/api\/semrush\/campaigns\/camp-2886\/keywords/,
      json: [{ id: "kw-2886", name: "personal injury lawyer", status: "COLLECTED" }],
    },
    {
      // The bulk-fetch POST — deferred so we can simulate an in-flight request.
      method: "POST",
      path: /\/api\/semrush\/campaigns\/camp-2886\/fetch-all-heatmaps/,
      respond: () => {
        heatmapFetchCallCount++;
        return new Promise<any>((resolve) => {
          resolveHeatmapFetch = resolve;
        });
      },
    },
    // Swallow auth/notifications/etc. with safe defaults.
    { path: /\/api\/auth\/user/, json: { id: "u1", role: "ceo" } },
  ],
  defaultJson: [],
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch stub are installed.
// ---------------------------------------------------------------------------
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const HeatmapPicker = (await import("../../client/src/components/HeatmapPicker")).default;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function newClient(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

// ---------------------------------------------------------------------------
// Main test scenario
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const container = document.getElementById("root")!;
  const qc = newClient();

  // ---- 1. Mount the picker open with a single mapped campaign ----
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(HeatmapPicker as any, {
          open: true,
          onClose: () => {},
          onSelect: () => {},
          clientId: "client-2886",
          locationId: "loc-2886",
          locationName: "Austin Office",
        }),
      ),
    );
  });

  // Let the semrush/status + mapped-campaigns queries resolve, the auto-select
  // effect fire, the keywords query enable + resolve, and the auto bulk-fetch
  // trigger (POST is intentionally deferred — still in flight).
  await flush(20);

  // ---- 2. Verify auto-select worked: we should be in the campaign view ----
  const backBtn = $("semrush-back-campaigns");
  assert(
    backBtn !== null,
    "REGRESSION: auto-select did not fire — campaign view (Back button) never appeared after opening with a single mapped campaign",
  );
  assert(
    heatmapFetchCallCount === 1,
    `expected exactly 1 bulk-fetch call after auto-select, got ${heatmapFetchCallCount}`,
  );
  console.log("  ✓ lone campaign auto-selected on open → campaign view (Back button visible)");

  // ---- 3. Press Back while the bulk fetch is still in flight ----
  await act(async () => {
    backBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(8);

  // ---- 4. Campaign list must now be showing ----
  assert(
    $("semrush-back-campaigns") === null,
    "REGRESSION: Back button is still visible after clicking Back — campaign was immediately re-selected (the 'dead Back button' bug)",
  );
  const campaignItem = $(`semrush-mapped-campaign-camp-2886`);
  assert(
    campaignItem !== null,
    "campaign list item must be visible after clicking Back (picker is back at campaign-selection stage)",
  );
  console.log("  ✓ Back click during in-flight bulk-fetch returns to campaign list and stays there");

  // ---- 5. Let the deferred bulk fetch complete ----
  assert(resolveHeatmapFetch !== null, "deferred fetch resolver must be set (POST was called)");
  await act(async () => {
    resolveHeatmapFetch!({
      ok: true,
      status: 200,
      headers: new dom.window.Headers({ "Content-Type": "application/json" }),
      json: async () => ({
        successCount: 1,
        errorCount: 0,
        totalKeywords: 1,
        results: [{ snapshotId: "snap-late", keywordId: "kw-2886", keywordName: "personal injury lawyer", pointCount: 9 }],
      }),
      text: async () => "{}",
    });
  });
  await flush(8);

  // ---- 6. Late completion must not yank the user back into the campaign view ----
  assert(
    $("semrush-back-campaigns") === null,
    "REGRESSION: late bulk-fetch completion re-entered the campaign view for the campaign the user already left",
  );
  assert(
    $(`semrush-mapped-campaign-camp-2886`) !== null,
    "campaign list must still be showing after late bulk-fetch completion",
  );
  assert(
    heatmapFetchCallCount === 1,
    `bulk fetch must have been called exactly once (no double-fire), got ${heatmapFetchCallCount}`,
  );
  console.log("  ✓ late bulk-fetch completion is discarded — user stays on campaign list");

  await act(async () => {
    root!.unmount();
  });

  console.log("heatmap-picker-back-button: scenario A passed");
}

// ---------------------------------------------------------------------------
// Scenario B (Task #2888): re-entering the SAME campaign while the original
// bulk fetch is still in flight must not leave the picker stuck.
//
//   1. Open → lone campaign auto-selected → bulk fetch #1 in flight.
//   2. Back (autoFetchTriggered reset to null, results/progress cleared).
//   3. Re-enter the same campaign while fetch #1 is STILL in flight.
//      The auto-fetch effect must NOT fire a second, duplicate fetch
//      (fetchAllPending gate) — call count stays 1.
//   4. Fetch #1 completes. Because the user is back on the same campaign,
//      the completion is for the live campaign (selectedCampaignIdRef
//      matches), so its results populate the view — no re-fetch needed,
//      call count stays exactly 1. The user is NOT stuck.
//   5. Back again, then re-enter once more (no fetch in flight now):
//      the auto-fetch effect re-triggers exactly once (call count → 2).
// ---------------------------------------------------------------------------
async function scenarioB(): Promise<void> {
  // Fresh mount + fresh counters.
  heatmapFetchCallCount = 0;
  resolveHeatmapFetch = null;
  const container = document.getElementById("root")!;
  const qc = newClient();

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(HeatmapPicker as any, {
          open: true,
          onClose: () => {},
          onSelect: () => {},
          clientId: "client-2886",
          locationId: "loc-2886",
          locationName: "Austin Office",
        }),
      ),
    );
  });
  await flush(20);

  // ---- 1. Auto-select fired, bulk fetch #1 in flight ----
  let backBtn = $("semrush-back-campaigns");
  assert(backBtn !== null, "scenario B: auto-select did not fire on open");
  assert(
    heatmapFetchCallCount === 1,
    `scenario B: expected 1 bulk-fetch call after auto-select, got ${heatmapFetchCallCount}`,
  );
  const resolveFirstFetch = resolveHeatmapFetch;
  assert(resolveFirstFetch !== null, "scenario B: deferred fetch #1 resolver must be set");

  // ---- 2. Back while fetch #1 is in flight ----
  await act(async () => {
    backBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(8);
  assert($("semrush-back-campaigns") === null, "scenario B: Back must return to campaign list");

  // ---- 3. Re-enter the SAME campaign while fetch #1 is STILL in flight ----
  const campaignItem = $(`semrush-mapped-campaign-camp-2886`);
  assert(campaignItem !== null, "scenario B: campaign list item must be visible after Back");
  await act(async () => {
    campaignItem!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(10);

  assert(
    $("semrush-back-campaigns") !== null,
    "scenario B: re-entering the campaign must show the campaign view again",
  );
  assert(
    heatmapFetchCallCount === 1,
    `scenario B REGRESSION: re-entering mid-fetch double-fired the bulk fetch — expected 1 call, got ${heatmapFetchCallCount}`,
  );
  console.log("  ✓ re-entering the same campaign mid-fetch does not double-fire the bulk fetch");

  // ---- 4. Let the ORIGINAL fetch complete now that the user is back in ----
  await act(async () => {
    resolveFirstFetch!({
      ok: true,
      status: 200,
      headers: new dom.window.Headers({ "Content-Type": "application/json" }),
      json: async () => ({
        successCount: 1,
        errorCount: 0,
        totalKeywords: 1,
        results: [{ snapshotId: "snap-b1", keywordId: "kw-2886", keywordName: "personal injury lawyer", pointCount: 9 }],
      }),
      text: async () => "{}",
    });
  });
  await flush(10);

  // The completion belongs to the campaign the user is currently viewing, so
  // its results populate the view (not stuck on a spinner, no extra fetch).
  assert(
    $("semrush-bulk-fetch-result") !== null,
    "scenario B REGRESSION: picker is stuck — original fetch completed for the re-entered campaign but no results are shown",
  );
  assert(
    heatmapFetchCallCount === 1,
    `scenario B: completion of the original fetch must not trigger a redundant re-fetch — expected 1 call, got ${heatmapFetchCallCount}`,
  );
  console.log("  ✓ original fetch completion populates the re-entered campaign view (no stuck state, no redundant fetch)");

  // ---- 5. Back again, re-enter with NO fetch in flight → fresh auto-fetch ----
  backBtn = $("semrush-back-campaigns");
  assert(backBtn !== null, "scenario B: Back button must be visible in the campaign view");
  await act(async () => {
    backBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(8);
  const campaignItem2 = $(`semrush-mapped-campaign-camp-2886`);
  assert(campaignItem2 !== null, "scenario B: campaign list must be visible after second Back");
  await act(async () => {
    campaignItem2!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(10);

  assert(
    heatmapFetchCallCount === 2,
    `scenario B REGRESSION: re-entering after the old fetch settled must re-trigger the auto-fetch exactly once — expected 2 total calls, got ${heatmapFetchCallCount}`,
  );
  // Resolve the new fetch so nothing dangles.
  assert(resolveHeatmapFetch !== null, "scenario B: fetch #2 resolver must be set");
  await act(async () => {
    resolveHeatmapFetch!({
      ok: true,
      status: 200,
      headers: new dom.window.Headers({ "Content-Type": "application/json" }),
      json: async () => ({
        successCount: 1,
        errorCount: 0,
        totalKeywords: 1,
        results: [{ snapshotId: "snap-b2", keywordId: "kw-2886", keywordName: "personal injury lawyer", pointCount: 9 }],
      }),
      text: async () => "{}",
    });
  });
  await flush(8);
  assert(
    $("semrush-bulk-fetch-result") !== null,
    "scenario B: fresh auto-fetch results must render after re-entry",
  );
  assert(
    heatmapFetchCallCount === 2,
    `scenario B: no extra fetches after fetch #2 settles — expected 2 total, got ${heatmapFetchCallCount}`,
  );
  console.log("  ✓ re-entering after the old fetch settled re-fires the auto-fetch exactly once (no double-fetch)");

  await act(async () => {
    root!.unmount();
  });

  console.log("heatmap-picker-back-button: scenario B passed");
}

main()
  .then(() => scenarioB())
  .then(() => {
    console.log("heatmap-picker-back-button: all cases passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
