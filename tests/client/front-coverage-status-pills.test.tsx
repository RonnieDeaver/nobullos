/* test-registration
{
  "name": "Coverage table error / pending / search source pills (Task #2138)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-status-pills-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend regression test for the *secondary* pills in the Front Analytics
 * coverage table's Status cell. The completeness Status badge + finalized
 * sub-label are already locked by
 * tests/client/front-coverage-completeness-badge.test.tsx (Task #2091); the
 * same Status <td> also renders several other pills that previously had no UI
 * render coverage:
 *
 *   1. The retriable "error" pill + the "unrecoverable" pill
 *      (badge-fa-unrecoverable-${month}) when frontAnalyticsError is set and
 *      status !== "pending".
 *   2. The "pending" pill when status === "pending".
 *   3. The denominator-source pill badge-fa-source-${month} on a search
 *      fallback (plan-limited) month — text "search", or "search (truncated)"
 *      when status === "search_truncated".
 *
 * Locking these means a refactor of the Status cell can't silently drop them.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that serves a
 * coverage payload whose `months` exercise each pill. The close-state filter
 * defaults to "all", so all rows render.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2091 (the sibling completeness-badge render test + jsdom panel-mount
 *   harness this copies), #2087 (completenessStatus classifier / Status cell),
 *   #1783 (error / unrecoverable pills), #1681 (denominator-source "search" /
 *   "search (truncated)" pill), #1691 (plan-limited month definition),
 *   #1837 / #1974 (denominator source/unit semantics behind the row).
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
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
  id: "admin-2138",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

function coverageMonth(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    frontTotalMessages: 1000,
    fetchedIntoNobull: 1000,
    appliedIntoNobull: 1000,
    ingestGap: 0,
    applyGap: 0,
    fetchedCoveragePct: 100,
    appliedCoveragePct: 100,
    messagesInboundCoveragePct: 100,
    messagesOutboundCoveragePct: 100,
    unitsComparable: true,
    frontAnalyticsStatus: "ok",
    frontAnalyticsError: null,
    reasonHuman: null,
    needsReconnect: false,
    unrecoverable: false,
    pulledAt: "2026-04-01T00:00:00.000Z",
    denominatorSource: "analytics_reports",
    denominatorUnit: "inbound_messages",
    closedVia: null,
    ...overrides,
  };
}

const MONTHS = [
  // Error + unrecoverable: err set and status !== "pending".
  coverageMonth({
    month: "2026-06",
    frontAnalyticsStatus: "error",
    frontAnalyticsError: "Front API returned 500 after exhausting retries.",
    unrecoverable: true,
    completenessStatus: "apply-gap",
    completenessReason: "Fetched but not yet applied.",
    isFinalizedMonth: true,
  }),
  // Pending: status === "pending" — shows the pending pill, not error.
  coverageMonth({
    month: "2026-07",
    frontAnalyticsStatus: "pending",
    frontAnalyticsError: null,
    completenessStatus: "in-progress",
    completenessReason: "Current / non-finalized month.",
    isFinalizedMonth: false,
  }),
  // Search fallback (plan-limited): source pill reads "search".
  coverageMonth({
    month: "2026-08",
    frontAnalyticsStatus: "ok",
    denominatorSource: "search_conversations",
    denominatorUnit: "conversations_all",
    completenessStatus: "covered",
    completenessReason: "Finalized month, no material gap.",
    isFinalizedMonth: true,
  }),
  // Search fallback truncated: source pill reads "search (truncated)".
  coverageMonth({
    month: "2026-09",
    frontAnalyticsStatus: "search_truncated",
    denominatorSource: "search_conversations",
    denominatorUnit: "conversations_all",
    completenessStatus: "in-progress",
    completenessReason: "Current / non-finalized month.",
    isFinalizedMonth: false,
  }),
];

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
        json: {
          adoptionDate: "2025-01-01",
          lastRefreshedAt: "2026-05-29T00:00:00.000Z",
          thresholds: { monthFloorPct: 95 },
          allTime: {
            appliedCoveragePct: 100,
            fetchedCoveragePct: 100,
            appliedIntoNobull: 0,
            fetchedIntoNobull: 0,
            frontTotalMessages: 0,
            ingestGap: 0,
            applyGap: 0,
          },
          months: MONTHS,
        },
      },
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: { config: { enabled: false, paused: false }, lastRun: null, gapMonths: [] },
      },
      // Benign empty payloads for incidental requests the panel makes.
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

// The "error" / "pending" pills carry no data-testid, so locate them inside
// the month's Status cell by exact (trimmed) text. The Status <td> is the one
// containing the completeness badge.
function statusCell(month: string): HTMLElement {
  const badge = $(`badge-fa-completeness-${month}`);
  assert(badge !== null, `completeness badge for ${month} must render (anchors the Status cell)`);
  const cell = badge!.closest("td");
  assert(cell !== null, `completeness badge for ${month} must live inside a <td>`);
  return cell as unknown as HTMLElement;
}

function pillByText(cell: HTMLElement, text: string): HTMLElement | null {
  return (
    (Array.from(cell.querySelectorAll("*")).find(
      (el) => (el.textContent || "").trim() === text,
    ) as HTMLElement | undefined) ?? null
  );
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
  const root = await mountPanel();
  try {
    assert(
      $("table-front-analytics-monthly") !== null,
      "the monthly analytics coverage table must render for an admin with Front connected",
    );

    // 1. Error + unrecoverable month.
    console.log("\n— error + unrecoverable (2026-06) —");
    {
      const cell = statusCell("2026-06");
      const errorPill = pillByText(cell, "error");
      assert(errorPill !== null, "the retriable 'error' pill must render when frontAnalyticsError is set");
      assert(
        (errorPill!.className || "").includes("bg-rose-50"),
        `'error' pill must carry the rose token — got "${errorPill!.className}"`,
      );

      const unrecoverable = $("badge-fa-unrecoverable-2026-06");
      assert(unrecoverable !== null, "badge-fa-unrecoverable must render when unrecoverable=true");
      assert(
        (unrecoverable!.textContent || "").trim() === "unrecoverable",
        `unrecoverable pill text must be "unrecoverable" — got "${unrecoverable!.textContent}"`,
      );

      // The error month must NOT show a pending pill.
      assert(pillByText(cell, "pending") === null, "error month must not render the 'pending' pill");
      console.log("  ✓ 'error' + 'unrecoverable' pills present, no 'pending' pill");
    }

    // 2. Pending month.
    console.log("\n— pending (2026-07) —");
    {
      const cell = statusCell("2026-07");
      const pendingPill = pillByText(cell, "pending");
      assert(pendingPill !== null, "the 'pending' pill must render when status === 'pending'");
      assert(
        (pendingPill!.className || "").includes("bg-muted/50"),
        `'pending' pill must carry the muted token — got "${pendingPill!.className}"`,
      );

      // A pending month must NOT also render the error pill.
      assert(pillByText(cell, "error") === null, "pending month must not render the 'error' pill");
      assert($("badge-fa-unrecoverable-2026-07") === null, "pending month must not render unrecoverable");
      console.log("  ✓ 'pending' pill present, no 'error'/'unrecoverable' pills");
    }

    // 3. Search fallback (plan-limited) month → "search".
    console.log("\n— search fallback / plan-limited (2026-08) —");
    {
      const source = $("badge-fa-source-2026-08");
      assert(source !== null, "badge-fa-source must render for a search_conversations month");
      assert(
        (source!.textContent || "").trim() === "search",
        `source pill text must be "search" — got "${source!.textContent}"`,
      );
      console.log("  ✓ 'search' source pill present");
    }

    // 4. Search fallback truncated → "search (truncated)".
    console.log("\n— search fallback truncated (2026-09) —");
    {
      const source = $("badge-fa-source-2026-09");
      assert(source !== null, "badge-fa-source must render for a search_truncated month");
      assert(
        (source!.textContent || "").trim() === "search (truncated)",
        `source pill text must be "search (truncated)" — got "${source!.textContent}"`,
      );
      console.log("  ✓ 'search (truncated)' source pill present");
    }

    // A non-search month must NOT render a source pill.
    assert($("badge-fa-source-2026-06") === null, "analytics_reports month must not render a source pill");

    console.log("\nfront-coverage-status-pills: all DOM cases passed");
  } finally {
    await unmount(root);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
