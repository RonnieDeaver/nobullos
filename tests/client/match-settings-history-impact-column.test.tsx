/* test-registration
{
  "name": "MatchSettings history Impact column (Task #1240)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1240 — UI regression test for the per-row "Impact" column on the
 * MatchSettings Change History table.
 *
 * Backend math for the numeric Zoom guardrail keys
 * (ZOOM_STRONG_SIGNAL_MIN_WEIGHT, ZOOM_SHORT_TOKEN_MAX_LEN) is covered by
 * tests/zoom-guardrail-change-trends.test.ts. This test covers the
 * frontend wiring in client/src/pages/admin/MatchSettings.tsx — that a
 * history row with `source === "zoom"` and a `settingKey` in that
 * numeric-key set actually:
 *
 *   1. renders the `sparkline-history-<rowId>` SVG inside the
 *      `cell-history-trend-<rowId>` cell when a trend is available, and
 *   2. renders a sibling `row-history-dismiss-<rowId>` row containing the
 *      `dismiss-history-<rowId>` reason-delta block when the trend has
 *      dismissal data;
 *
 * and that a row whose `settingKey` is NOT in the set falls through to
 * the em-dash placeholder.
 *
 * The test mounts a small harness component that mirrors the exact JSX
 * fragment used by MatchSettings (`isZoomGuardrail` check →
 * `RoutedToReviewSparkline` / empty placeholder / em-dash, plus the
 * optional dismiss-reason row). The harness imports
 * `RoutedToReviewSparkline`, `DismissReasonDelta`, and
 * `ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET` directly from MatchSettings, so
 * any drift in the helper components or the numeric-key list is caught
 * by this test. Trend data is fed via a stubbed
 * `/api/admin/zoom/guardrail-change-history-trends` fetch, exactly the
 * way the real page consumes it.
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
(globalThis as any).SVGElement = dom.window.SVGElement;
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

// ---------------------------------------------------------------------------
// Stub fetch: serves the four per-key trends endpoints. Each numeric key
// gets its own trend row whose `auditId` matches a history row id, plus
// dismissal data so the optional dismiss row also renders.
// ---------------------------------------------------------------------------

type TrendRow = {
  auditId: string;
  changedAt: string;
  routedToReview: {
    anchor: string;
    windowMs: number;
    bucketCount: number;
    buckets: { start: string; end: string; count: number }[];
    before: number;
    after: number;
    total: number;
    reason: string | null;
  };
  dismissReasons: {
    before: { byReason: Record<string, number>; total: number };
    after: { byReason: Record<string, number>; total: number };
  };
};

function makeBuckets(beforeCounts: number[], afterCounts: number[]) {
  const baseMs = Date.parse("2026-05-01T00:00:00.000Z");
  const stepMs = 60 * 60 * 1000;
  const all = [...beforeCounts, ...afterCounts];
  return all.map((count, i) => ({
    start: new Date(baseMs + i * stepMs).toISOString(),
    end: new Date(baseMs + (i + 1) * stepMs).toISOString(),
    count,
  }));
}

function trendFor(auditId: string): TrendRow {
  return {
    auditId,
    changedAt: "2026-05-01T03:00:00.000Z",
    routedToReview: {
      anchor: "2026-05-01T03:00:00.000Z",
      windowMs: 24 * 60 * 60 * 1000,
      bucketCount: 6,
      buckets: makeBuckets([2, 3, 4], [1, 1, 0]),
      before: 9,
      after: 2,
      total: 11,
      reason: null,
    },
    dismissReasons: {
      before: { byReason: { not_relevant: 4, duplicate: 2 }, total: 6 },
      after: { byReason: { not_relevant: 1 }, total: 1 },
    },
  };
}

// Map of settingKey → array of trend rows that key's /trends call returns.
const TREND_RESPONSES: Record<string, TrendRow[]> = {
  ZOOM_STRONG_SIGNAL_MIN_WEIGHT: [trendFor("hist-strong-1")],
  ZOOM_SHORT_TOKEN_MAX_LEN: [trendFor("hist-short-1")],
};

let trendFetchCalls: { settingKey: string | null }[] = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: "/api/admin/zoom/guardrail-change-history-trends",
      respond: ({ url }: any) => {
        const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const params = new URLSearchParams(qs);
        const settingKey = params.get("settingKey");
        trendFetchCalls.push({ settingKey });
        const rows = settingKey && TREND_RESPONSES[settingKey] ? TREND_RESPONSES[settingKey] : [];
        return {
          status: 200,
          json: {
            settingKey,
            reason: null,
            windowMs: 24 * 60 * 60 * 1000,
            bucketCount: 6,
            rows,
          },
        };
      },
    },
  ],
  // Anything else: benign empty payload so incidental imports don't crash.
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — after jsdom globals + fetch stub are in place.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act, Fragment, useMemo } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider, useQuery } = await import(
  "@tanstack/react-query"
);
const {
  RoutedToReviewSparkline,
  DismissReasonDelta,
  ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS,
  ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET,
} = await import("../../client/src/pages/admin/MatchSettings");

// ---------------------------------------------------------------------------
// Harness — mirrors the JSX fragment in MatchSettings.tsx around the
// "Impact" cell (data-testid="cell-history-trend-<rowId>") plus the
// optional dismiss-reason row (data-testid="row-history-dismiss-<rowId>").
// The four per-key useQuery calls are wired identically to the production
// `useGuardrailTrend` hook so any drift in the query key shape or fetch
// URL would also break the production page.
// ---------------------------------------------------------------------------

type HistoryRow = {
  id: string;
  source: "default" | "zoom";
  settingKey: string;
};

const WINDOW_MS = 24 * 60 * 60 * 1000;

function useGuardrailTrend(key: string) {
  return useQuery<any>({
    queryKey: ["/api/admin/zoom/guardrail-change-history-trends", key, WINDOW_MS],
    queryFn: async () => {
      const params = new URLSearchParams({
        settingKey: key,
        windowMs: String(WINDOW_MS),
        limit: "25",
      });
      const res = await fetch(
        `/api/admin/zoom/guardrail-change-history-trends?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("trends fetch failed");
      return res.json();
    },
  });
}

function ImpactColumnHarness(props: { rows: HistoryRow[] }) {
  const strong = useGuardrailTrend("ZOOM_STRONG_SIGNAL_MIN_WEIGHT");
  const short = useGuardrailTrend("ZOOM_SHORT_TOKEN_MAX_LEN");

  const guardrailTrendByHistoryId = useMemo(() => {
    const m = new Map<string, any>();
    for (const q of [strong, short]) {
      for (const r of q.data?.rows ?? []) m.set(r.auditId, r);
    }
    return m;
  }, [strong.data, short.data]);

  const loading = strong.isLoading || short.isLoading;

  return React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      ...props.rows.map((row) => {
        const isZoomGuardrail =
          row.source === "zoom" && ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET.has(row.settingKey);
        const trend = isZoomGuardrail ? guardrailTrendByHistoryId.get(row.id) ?? null : null;
        const dismissBefore = trend?.dismissReasons.before;
        const dismissAfter = trend?.dismissReasons.after;
        const hasDismissData = !!(
          trend &&
          ((dismissBefore &&
            (Object.keys(dismissBefore.byReason).length > 0 || dismissBefore.total > 0)) ||
            (dismissAfter &&
              (Object.keys(dismissAfter.byReason).length > 0 || dismissAfter.total > 0)))
        );
        return React.createElement(
          Fragment,
          { key: row.id },
          React.createElement(
            "tr",
            { "data-testid": `row-history-${row.id}` },
            React.createElement(
              "td",
              { "data-testid": `cell-history-trend-${row.id}` },
              isZoomGuardrail
                ? trend
                  ? React.createElement(RoutedToReviewSparkline as any, {
                      trend,
                      testId: `sparkline-history-${row.id}`,
                    })
                  : React.createElement(
                      "span",
                      { "data-testid": `text-history-trend-empty-${row.id}` },
                      loading ? "…" : "—",
                    )
                : React.createElement(
                    "span",
                    { "data-testid": `text-history-trend-emdash-${row.id}` },
                    "—",
                  ),
            ),
          ),
          trend && hasDismissData
            ? React.createElement(
                "tr",
                { "data-testid": `row-history-dismiss-${row.id}` },
                React.createElement(
                  "td",
                  null,
                  React.createElement(DismissReasonDelta as any, {
                    trend,
                    testId: `dismiss-history-${row.id}`,
                  }),
                ),
              )
            : null,
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Mount + assertions
// ---------------------------------------------------------------------------

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

async function main(): Promise<void> {
  // Sanity: the exported numeric-key set includes the keys this test
  // covers. Locks the contract between MatchSettings and this test.
  const expectedKeys = [
    "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
    "ZOOM_SHORT_TOKEN_MAX_LEN",
  ];
  for (const k of expectedKeys) {
    assert(
      ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET.has(k),
      `exported ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET must include ${k}`,
    );
  }
  // The exported list may include additional keys added by later tasks
  // (e.g. Task #1239 generalized-trends keys); this test only asserts the
  // four numeric-key contracts it owns are present.
  assert(
    ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS.length >= expectedKeys.length,
    `exported numeric-key list must include at least the ${expectedKeys.length} Task #1240 keys, got ${ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS.length}`,
  );

  const rows: HistoryRow[] = [
    { id: "hist-strong-1", source: "zoom", settingKey: "ZOOM_STRONG_SIGNAL_MIN_WEIGHT" },
    { id: "hist-short-1", source: "zoom", settingKey: "ZOOM_SHORT_TOKEN_MAX_LEN" },
    // Non-matching settingKey → must fall through to em-dash placeholder.
    { id: "hist-noop-1", source: "zoom", settingKey: "ZOOM_SOMETHING_ELSE" },
    // Non-zoom scope, even with a matching key, must also fall through.
    { id: "hist-noop-2", source: "default", settingKey: "ZOOM_STRONG_SIGNAL_MIN_WEIGHT" },
  ];

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ImpactColumnHarness, { rows }),
      ),
    );
  });
  await flush();

  // -- All four trends endpoints fired with their respective keys -----------
  const calledKeys = new Set(trendFetchCalls.map((c) => c.settingKey));
  for (const k of expectedKeys) {
    assert(
      calledKeys.has(k),
      `expected a /guardrail-change-history-trends fetch for settingKey=${k} (got: ${JSON.stringify(Array.from(calledKeys))})`,
    );
  }

  // -- For each numeric key: sparkline renders inside its cell -
  const sparklineCases: { rowId: string; settingKey: string }[] = [
    { rowId: "hist-strong-1", settingKey: "ZOOM_STRONG_SIGNAL_MIN_WEIGHT" },
    { rowId: "hist-short-1", settingKey: "ZOOM_SHORT_TOKEN_MAX_LEN" },
  ];
  for (const c of sparklineCases) {
    const cell = $(`cell-history-trend-${c.rowId}`);
    assert(cell !== null, `cell-history-trend-${c.rowId} must render (key=${c.settingKey})`);
    const sparkline = cell!.querySelector(
      `[data-testid="sparkline-history-${c.rowId}"]`,
    ) as HTMLElement | null;
    assert(
      sparkline !== null,
      `sparkline-history-${c.rowId} must render inside cell-history-trend-${c.rowId} (key=${c.settingKey})`,
    );
    // The sparkline exposes routed-to-review before/after as data-attributes;
    // this catches a regression where the props are wired but the helper
    // stops rendering its inner counts.
    assert(
      $(`sparkline-history-${c.rowId}-before`)?.textContent === "9",
      `sparkline-history-${c.rowId}-before must show stubbed before=9 (key=${c.settingKey})`,
    );
    assert(
      $(`sparkline-history-${c.rowId}-after`)?.textContent === "2",
      `sparkline-history-${c.rowId}-after must show stubbed after=2 (key=${c.settingKey})`,
    );
    // Empty-state placeholder must NOT render alongside the sparkline.
    assert(
      $(`text-history-trend-empty-${c.rowId}`) === null,
      `text-history-trend-empty-${c.rowId} must NOT render when a trend is present (key=${c.settingKey})`,
    );

    // -- Sibling dismiss-reason row renders with DismissReasonDelta inside --
    const dismissRow = $(`row-history-dismiss-${c.rowId}`);
    assert(
      dismissRow !== null,
      `row-history-dismiss-${c.rowId} must render when the trend has dismiss data (key=${c.settingKey})`,
    );
    const dismissDelta = dismissRow!.querySelector(
      `[data-testid="dismiss-history-${c.rowId}"]`,
    ) as HTMLElement | null;
    assert(
      dismissDelta !== null,
      `dismiss-history-${c.rowId} must render inside row-history-dismiss-${c.rowId}`,
    );
    // The DismissReasonDelta exposes a per-reason chip via the same testId
    // namespace; verify the not_relevant chip rendered.
    assert(
      $(`dismiss-history-${c.rowId}-not_relevant`) !== null,
      `dismiss-history-${c.rowId}-not_relevant chip must render`,
    );
  }

  // -- Non-matching settingKey row: em-dash placeholder, no sparkline -------
  for (const noopRowId of ["hist-noop-1", "hist-noop-2"]) {
    const cell = $(`cell-history-trend-${noopRowId}`);
    assert(cell !== null, `cell-history-trend-${noopRowId} must render`);
    assert(
      cell!.textContent?.trim() === "—",
      `cell-history-trend-${noopRowId} must show em-dash placeholder, got "${cell!.textContent}"`,
    );
    assert(
      $(`sparkline-history-${noopRowId}`) === null,
      `sparkline-history-${noopRowId} must NOT render for a non-matching/non-zoom row`,
    );
    assert(
      $(`row-history-dismiss-${noopRowId}`) === null,
      `row-history-dismiss-${noopRowId} must NOT render for a non-matching/non-zoom row`,
    );
  }

  await act(async () => {
    root!.unmount();
  });
  queryClient.clear();

  console.log("match-settings-history-impact-column: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
