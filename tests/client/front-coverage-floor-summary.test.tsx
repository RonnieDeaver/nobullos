/* test-registration
{
  "name": "Denominator-floor reconciliation summary banner (Task #2802)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2802: mounts the REAL FrontHistoricalRecoveryPanel and asserts the denominator-floor reconciliation summary banner renders (count + summed excess + plain-English reason), the per-month breakdown shows only excess>0 months with the server note confined to title tooltips, and the banner is absent when no month has excess — including the guard that no conversation vocabulary from the search-variant note leaks into visible text. Fast, DB-free, deterministic jsdom render with fetch fully stubbed.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-floor-summary-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend render test for the denominator-floor reconciliation summary
 * (`FrontHistoricalRecoveryPanel`, testid `details-fa-floor-summary`).
 * Task #2802 surfaces Task #2795's per-month floor data as a console-level
 * banner: a headline count of months whose denominator was raised
 * (denominatorFloorExcess > 0) with an expandable per-month breakdown.
 * Task #2818 makes the full server reconciliation note touch-friendly:
 * expanding the banner (a tap/click on the <details> summary) reveals the
 * note as VISIBLE text under each floor-month row — no hover tooltip
 * required. That is safe against the Task #2603 no-conversation-vocabulary
 * guard (tests/client/front-coverage-rendered-metrics.test.tsx scenario 4)
 * because buildFloorReconciliationNote's search variant was reworded
 * server-side to say "threads" instead of "conversations".
 *
 * Task #2826 extends the same touch-readability to the monthly coverage
 * table: the per-month "⚠ floor applied +N" marker in the Applied % cell is
 * now a tap-expandable <details> disclosure (summary = the marker, body =
 * the full reconciliation note as visible text), so a phone/tablet operator
 * scanning the table can read the explanation in place instead of relying
 * on the hover `title` tooltip or scrolling up to the banner.
 *
 * Locks three behaviors:
 *   1. PRESENT branch: with 2 floor months (+1 zero-excess, +1 null-excess
 *      row in the payload) the banner renders, the summary line states
 *      "2 months had their denominator raised" with the summed excess and
 *      the plain-English reason (local count exceeded Front's reported
 *      total), and — after expanding the disclosure (the touch
 *      interaction) — the per-month rows show the excess AND the full
 *      reconciliation note as visible text.
 *   2. VOCAB guard: the banner's rendered textContent (including the now
 *      visible notes) contains no "conversation"/"convo" wording, and the
 *      fixture notes match the reworded server phrasing ("threads").
 *   3. ABSENT branch: with no floor months (zero/null excess only) the
 *      banner does not render at all.
 *   4. TABLE CELL disclosure (Task #2826): each floor month's Applied %
 *      cell renders the "⚠ floor applied +N" marker as the <summary> of a
 *      <details> disclosure whose body is the FULL reconciliation note as
 *      real DOM text (tap to expand — no hover required); zero/null-excess
 *      months render no disclosure; the cell's text stays vocab-safe.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * jsdom + fetch harness is copied from
 * tests/client/front-coverage-in-scope-confirmation.test.tsx (Task #2474).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2795 (floor invariant + denominatorFloorExcess /
 *   denominatorFloorReconciliationNote fields and the inline Applied % cell
 *   note this banner complements), #2802 (the banner itself), #2603 (no
 *   conversation vocabulary in the Front console's visible text), #2685
 *   (three-lens reconciliation banner sibling), #2474 / #2218 / #2182 /
 *   #2138 (the jsdom panel-mount + stubbed-fetch harness this copies).
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
// wouter's useLocation (reached via the real use-auth hook once @clerk/react is
// stubbed) reads the global `location`/`history` and subscribes to navigation
// events — bind them to this suite's jsdom window before react-dom evaluates.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2802",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// Realistic server-generated notes (buildFloorReconciliationNote wording).
// Task #2818 reworded the search variant to say "threads" (never
// "conversations") so the notes can render as visible text without tripping
// the Task #2603 vocabulary guard. These fixtures mirror that exact wording.
const NOTE_ANALYTICS =
  "1,132 local messages exceed Front Analytics — likely imported via Front's Import Message endpoint (excluded from Analytics Reports).";
const NOTE_SEARCH =
  "45 local messages exceed Front's search-enumerated count — likely in threads that no longer appear in search (deleted, spam, or imported).";

function monthRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    frontTotalMessages: 1000,
    fetchedIntoNobull: 900,
    appliedIntoNobull: 900,
    ingestGap: 100,
    applyGap: 100,
    fetchedCoveragePct: 90,
    appliedCoveragePct: 90,
    frontAnalyticsStatus: "ok",
    frontAnalyticsError: null,
    unitsComparable: true,
    denominatorUnit: "messages_all",
    denominatorSource: "search_conversations",
    planLimitedFallback: null,
    pulledAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// The only payload field that varies between the two cases.
let currentMonths: Record<string, unknown>[] = [];

const ALL_TIME = {
  appliedCoveragePct: 90,
  fetchedCoveragePct: 90,
  appliedIntoNobull: 900,
  fetchedIntoNobull: 900,
  frontTotalMessages: 1000,
  ingestGap: 100,
  applyGap: 100,
  inScopeMonths: 4,
  inScopeCountedMonths: 4,
  inScopeExcludedMonths: 0,
  totalMonths: 4,
  includedMonths: 4,
  excludedWrongGrainMonths: 0,
  excludedPreFloorMonths: 0,
};

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      {
        path: "/api/auth/user",
        respond: () =>
          opts.user ? { status: 200, json: opts.user } : { status: 401, json: {} },
      },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      {
        path: /\/api\/admin\/front\/analytics-coverage$/,
        json: () => ({
          adoptionDate: "2025-07-01",
          lastRefreshedAt: "2026-06-29T00:00:00.000Z",
          thresholds: { monthFloorPct: 95 },
          allTime: ALL_TIME,
          months: currentMonths,
        }),
      },
      {
        path: /\/analytics-coverage\/finish-message-grain-status$/,
        json: {
          state: "not-needed",
          running: false,
          detail: "",
          floorMonth: null,
          excludedMonths: 0,
          months: [],
        },
      },
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: { config: { enabled: false, paused: false }, lastRun: null, gapMonths: [] },
      },
      { path: /\/historical-recovery\/jobs/, json: { jobs: [] } },
      { path: /\/historical-recovery\/coverage/, json: { windows: [] } },
      {
        path: /\/historical-recovery\/sweep-status/,
        json: {
          running: false,
          inFlight: false,
          intervalMs: 60000,
          lastSweepAt: null,
          lastPrunedCount: 0,
          lastError: null,
        },
      },
      { path: /\/historical-recovery\/manual-sweep-history/, json: { entries: [] } },
    ],
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { FrontHistoricalRecoveryPanel } = await import(
  "../../client/src/components/admin/FrontHistoricalRecoveryPanel"
);

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

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

async function mountPanel(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(FrontHistoricalRecoveryPanel as any),
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

  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });

  // --- PRESENT branch: two floor months among four rows ---------------------
  console.log("\n— PRESENT: 2 months with denominatorFloorExcess > 0 —");
  currentMonths = [
    monthRow({
      month: "2025-07",
      denominatorFloorExcess: 1132,
      denominatorFloorReconciliationNote: NOTE_ANALYTICS,
    }),
    monthRow({
      month: "2025-08",
      denominatorFloorExcess: 0,
      denominatorFloorReconciliationNote: null,
    }),
    monthRow({
      month: "2025-09",
      denominatorFloorExcess: null,
      denominatorFloorReconciliationNote: null,
    }),
    monthRow({
      month: "2025-10",
      denominatorFloorExcess: 45,
      denominatorFloorReconciliationNote: NOTE_SEARCH,
    }),
  ];
  {
    const root = await mountPanel();
    try {
      const banner = $("details-fa-floor-summary");
      assert(banner !== null, "the floor reconciliation summary banner must render");

      const summary = $("text-fa-floor-summary");
      assert(summary !== null, "the summary line must render");
      const summaryText = (summary!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        summaryText.includes("2 months had their denominator raised"),
        `summary must state the floor-month count — got "${summaryText}"`,
      );
      assert(
        summaryText.includes("1,177"),
        `summary must state the summed excess (1,132 + 45 = 1,177) — got "${summaryText}"`,
      );
      assert(
        /local message count exceeded Front's reported total/i.test(summaryText),
        `summary must explain WHY the denominator was raised — got "${summaryText}"`,
      );

      // Expand the disclosure and check the per-month breakdown.
      (banner as any).open = true;
      const list = $("list-fa-floor-months");
      assert(list !== null, "the per-month breakdown list must render");
      assert(
        list!.querySelectorAll("[data-testid^='row-fa-floor-month-']").length === 2,
        "exactly the 2 floor months must appear in the breakdown",
      );

      const rowJul = $("row-fa-floor-month-2025-07");
      const rowOct = $("row-fa-floor-month-2025-10");
      assert(rowJul !== null && rowOct !== null, "both floor-month rows must render");
      assert(
        $("row-fa-floor-month-2025-08") === null &&
          $("row-fa-floor-month-2025-09") === null,
        "zero-excess and null-excess months must NOT appear in the breakdown",
      );

      const julText = (rowJul!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        julText.includes("2025-07") && julText.includes("+1,132"),
        `2025-07 row must show its month + excess — got "${julText}"`,
      );
      const octText = (rowOct!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        octText.includes("2025-10") && octText.includes("+45"),
        `2025-10 row must show its month + excess — got "${octText}"`,
      );

      // Task #2818 — expanding the disclosure (the tap/click interaction)
      // must reveal the FULL server reconciliation note as VISIBLE text
      // under each floor-month row, so phones/tablets (no hover) can read
      // the explanation.
      const noteJul = $("text-fa-floor-month-note-2025-07");
      const noteOct = $("text-fa-floor-month-note-2025-10");
      assert(
        noteJul !== null && noteOct !== null,
        "both floor-month rows must render their reconciliation note as visible text",
      );
      const noteJulText = (noteJul!.textContent || "").replace(/\s+/g, " ").trim();
      const noteOctText = (noteOct!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        noteJulText === NOTE_ANALYTICS,
        `2025-07 must show the full Analytics-variant note as visible text — got "${noteJulText}"`,
      );
      assert(
        noteOctText === NOTE_SEARCH,
        `2025-10 must show the full search-variant note as visible text — got "${noteOctText}"`,
      );
      // The note is inside the row, so a tap that expands the banner is all
      // a touch operator needs — no title attribute is required to see it.
      assert(
        (rowJul!.textContent || "").includes(NOTE_ANALYTICS) &&
          (rowOct!.textContent || "").includes(NOTE_SEARCH),
        "each row's textContent must include its full reconciliation note",
      );

      // Vocab guard (Task #2603): the banner's visible text — now INCLUDING
      // the full notes — must contain no conversation vocabulary. The
      // reworded search variant says "threads"; make sure the fixture really
      // exercises that (a "conversations" note here would fail this guard).
      assert(
        /threads/i.test(NOTE_SEARCH) && !/conversation/i.test(NOTE_SEARCH),
        "the search-variant fixture must use the reworded 'threads' phrasing",
      );
      const bannerText = banner!.textContent || "";
      assert(
        !/conversation/i.test(bannerText) && !/\bconvos?\b/i.test(bannerText),
        `the banner's visible text must contain NO conversation vocabulary — got "${bannerText}"`,
      );

      console.log("  ✓ summary count + total, per-month rows, tap-visible notes, vocab guard");

      // --- Task #2826 — table-cell floor-note disclosure ------------------
      // The Applied % cell's "⚠ floor applied +N" marker must be the
      // <summary> of a <details> disclosure whose body carries the FULL
      // reconciliation note as real DOM text, so a tap (not a hover) reveals
      // the explanation right in the table row.
      for (const [month, excessLabel, note] of [
        ["2025-07", "+1,132", NOTE_ANALYTICS],
        ["2025-10", "+45", NOTE_SEARCH],
      ] as const) {
        const cellDetails = $(`details-fa-floor-note-${month}`);
        assert(
          cellDetails !== null,
          `the ${month} Applied %% cell must render a floor-note disclosure`,
        );
        assert(
          cellDetails!.tagName.toLowerCase() === "details",
          `the ${month} cell disclosure must be a <details> element (tap-expandable) — got <${cellDetails!.tagName.toLowerCase()}>`,
        );

        const marker = $(`text-fa-floor-note-${month}`);
        assert(marker !== null, `the ${month} floor marker must render`);
        assert(
          marker!.tagName.toLowerCase() === "summary" &&
            marker!.parentElement === cellDetails,
          `the ${month} marker must be the <summary> of its cell disclosure`,
        );
        const markerText = (marker!.textContent || "").replace(/\s+/g, " ").trim();
        assert(
          markerText.includes("floor applied") && markerText.includes(excessLabel),
          `the ${month} marker must keep the "floor applied ${excessLabel}" wording — got "${markerText}"`,
        );

        // Simulate the tap: expanding the disclosure. The note must already
        // be real DOM text inside the details body (no title-only tooltip).
        (cellDetails as any).open = true;
        const fullNote = $(`text-fa-floor-note-full-${month}`);
        assert(
          fullNote !== null,
          `the ${month} disclosure must contain the full note element`,
        );
        const fullNoteText = (fullNote!.textContent || "").replace(/\s+/g, " ").trim();
        assert(
          fullNoteText === note,
          `the ${month} disclosure body must show the FULL reconciliation note as visible text — got "${fullNoteText}"`,
        );

        // Vocab guard on the cell itself (Task #2603): the whole disclosure's
        // text — marker + now-visible note — must stay conversation-free.
        const cellText = cellDetails!.textContent || "";
        assert(
          !/conversation/i.test(cellText) && !/\bconvos?\b/i.test(cellText),
          `the ${month} cell disclosure text must contain NO conversation vocabulary — got "${cellText}"`,
        );
      }

      // Zero-excess and null-excess months must render no cell disclosure.
      assert(
        $("details-fa-floor-note-2025-08") === null &&
          $("details-fa-floor-note-2025-09") === null,
        "zero/null-excess months must NOT render a cell floor-note disclosure",
      );

      console.log("  ✓ table-cell disclosure: tap reveals full note in the Applied % cell");
    } finally {
      await unmount(root);
    }
  }

  // --- ABSENT branch: no floor months ---------------------------------------
  console.log("\n— ABSENT: no months with denominatorFloorExcess > 0 —");
  currentMonths = [
    monthRow({
      month: "2025-07",
      denominatorFloorExcess: 0,
      denominatorFloorReconciliationNote: null,
    }),
    monthRow({
      month: "2025-08",
      denominatorFloorExcess: null,
      denominatorFloorReconciliationNote: null,
    }),
  ];
  {
    const root = await mountPanel();
    try {
      // Sanity: the coverage table itself rendered (so the absence of the
      // banner is a real branch, not an empty/loading screen).
      assert(
        $("row-fa-month-2025-07") !== null,
        "the monthly coverage table must render in the absent case",
      );
      assert(
        $("details-fa-floor-summary") === null,
        "the floor summary banner must NOT render when no month has excess > 0",
      );
      // Task #2826 — no table-cell disclosure either when no month has excess.
      assert(
        $("details-fa-floor-note-2025-07") === null &&
          $("details-fa-floor-note-2025-08") === null,
        "no Applied % cell floor-note disclosure may render without excess",
      );
      console.log("  ✓ banner absent when no floor month exists");
    } finally {
      await unmount(root);
    }
  }

  console.log("\nfront-coverage-floor-summary: all render cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
