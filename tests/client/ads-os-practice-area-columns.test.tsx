/* test-registration
{
  "name": "Ads OS dashboard tables + ownership-filtered metric tiles — real Main, Google Ads, and LSA pages preserve Practice Area behavior and make Doer/Checker summary metrics reconcile to the selected ownership slice",
  "regression": true,
  "smoke": true,
  "smokeReason": "Practice Area and sticky ownership filters cross three independent Ads OS client tables: a page can render canonical labels yet omit them from search or sorting, or display portfolio-wide tiles after an operator selects a Doer/Checker slice. This real-component jsdom suite mounts all three pages against stubbed responses, including intersected and zero-match ownership fixtures, with no DB or vendor egress; expected cold runtime is under 10s.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-proofs-gating-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small",
  "tierReason": "The loader forces a solo process and mechanically classifies this as medium, but the suite is a fully stubbed, DB-free and vendor-free jsdom mount that exercises all three pages in one 7s process (measured focused run on 2026-08-24), well below the 30s small-tier ceiling."
}
test-registration */
/**
 * Stage 2 Practice Area UI contract.
 *
 * Mounts the real Main, Google Ads, and LSA dashboard pages against one
 * network-free fetch stub. Each page receives the same semantic three-row
 * fixture: two populated canonical-order labels and one blank row. The suite
 * proves display, search, both sort directions with blank-last semantics,
 * accessible aria-sort state, existing name-ascending default sort, and the
 * table-wide colSpans that must grow with the new column.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/ads-os" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? dom.window.MouseEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
(dom.window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type DashboardKind = "main" | "gads" | "lsa";
type AnyPage = React.ComponentType;

const EMPTY_CLIENT_ALERTS = {
  critical: 0,
  high: 0,
  medium: 0,
  total: 0,
  needs_attention: false,
  items: [],
  items_truncated: 0,
  accounts: [],
};

const combinedRows = [
  combinedRow("Alpha Law", ["Family", "Criminal Defense"]),
  combinedRow("Bravo Law", []),
  combinedRow("Zulu Law", ["Immigration"]),
];

const gadsRows = [
  gadsRow("1000000001", "Alpha Law", ["Family", "Criminal Defense"]),
  gadsRow("1000000002", "Bravo Law", []),
  gadsRow("1000000003", "Zulu Law", ["Immigration"]),
];

const lsaRows = [
  lsaRow("2000000001", "Alpha Law", ["Family", "Criminal Defense"]),
  lsaRow("2000000002", "Bravo Law", []),
  lsaRow("2000000003", "Zulu Law", ["Immigration"]),
];

function ownershipMetrics(client: string) {
  switch (client) {
    case "Alpha Law":
      return {
        doer: "Avery Doe",
        checker: "Casey Checker",
        spend: 100,
        leads: 4,
        spendPrev: 90,
        leadsPrev: 3,
        needsAttention: true,
      };
    case "Bravo Law":
      return {
        doer: "Avery Doe",
        checker: "Blake Checker",
        spend: 200,
        leads: 10,
        spendPrev: 100,
        leadsPrev: 4,
        needsAttention: false,
      };
    case "Zulu Law":
      return {
        doer: "Jordan Doer",
        checker: "Casey Checker",
        spend: 300,
        leads: 6,
        spendPrev: 200,
        leadsPrev: 2,
        needsAttention: true,
      };
    default:
      throw new Error(`No ownership metric fixture for ${client}`);
  }
}

function combinedRow(client: string, practiceAreas: string[]) {
  const metrics = ownershipMetrics(client);
  return {
    client,
    doer: metrics.doer,
    checker: metrics.checker,
    practice_areas: practiceAreas,
    currency_code: "USD",
    has_gads: true,
    has_lsa: false,
    has_active_monitoring: true,
    spend_30d: metrics.spend,
    leads_30d: metrics.leads,
    cpl_30d: metrics.spend / metrics.leads,
    spend_prev: metrics.spendPrev,
    leads_prev: metrics.leadsPrev,
    cpl_prev: metrics.spendPrev / metrics.leadsPrev,
    gads_spend_30d: metrics.spend,
    gads_leads_30d: metrics.leads,
    lsa_spend_30d: 0,
    lsa_leads_30d: 0,
    members: [],
    metrics_partial: false,
    pacing_pct: null,
    pacing_budget: null,
    pacing_mtd: null,
    pacing_hit: false,
    alerts: metrics.needsAttention
      ? { ...EMPTY_CLIENT_ALERTS, high: 1, total: 1, needs_attention: true }
      : EMPTY_CLIENT_ALERTS,
  };
}

function gadsRow(customerId: string, clientName: string, practiceAreas: string[]) {
  const metrics = ownershipMetrics(clientName);
  return {
    customer_id: customerId,
    descriptive_name: `${clientName} Ads`,
    client_name: clientName,
    practice_areas: practiceAreas,
    currency_code: "USD",
    doer: metrics.doer,
    checker: metrics.checker,
    spend_30d: metrics.spend,
    conversions_30d: metrics.leads,
    cpa_30d: metrics.spend / metrics.leads,
    spend_prev: metrics.spendPrev,
    conversions_prev: metrics.leadsPrev,
    cpa_prev: metrics.spendPrev / metrics.leadsPrev,
    ads_running: true,
    health_score: null,
    health_band: null,
    health_at: null,
    budget_pacing_pct: null,
    monthly_budget: null,
    mtd_spend: null,
    recommended_daily_budget: null,
    traffic_quality: null,
    quality_at: null,
    quality_window: null,
    quality_coverage: null,
    alerts: metrics.needsAttention ? [{ severity: "high" }] : [],
    alerts_at: null,
  };
}

function lsaRow(customerId: string, clientName: string, practiceAreas: string[]) {
  const metrics = ownershipMetrics(clientName);
  return {
    customer_id: customerId,
    descriptive_name: `${clientName} LSA`,
    client_name: clientName,
    lsa_city: "Denver",
    practice_areas: practiceAreas,
    currency_code: "USD",
    doer: metrics.doer,
    checker: metrics.checker,
    cost_30d: metrics.spend,
    charged_leads_30d: metrics.leads,
    cpl_30d: metrics.spend / metrics.leads,
    cost_prev: metrics.spendPrev,
    charged_leads_prev: metrics.leadsPrev,
    cpl_prev: metrics.spendPrev / metrics.leadsPrev,
    answer_rate_30d: null,
    answer_calls_30d: 0,
    answer_connected_30d: 0,
    ads_running: true,
    pacing_pct: null,
    monthly_budget: null,
    mtd_spend: null,
    recommended_weekly_budget: null,
    health_score: null,
    health_band: null,
    health_at: null,
    alerts: metrics.needsAttention ? [{ severity: "high" }] : [],
    alerts_at: null,
  };
}

const responseBase = {
  generated_at: "2026-08-24T12:00:00.000Z",
  from_cache: false,
  window: 30,
  compare: "previous",
  clickup_live: true,
  clickup_stale_since: null,
  clickup_bundle_age_ms: 0,
  store_ok: true,
  store_reason: null,
};

let activeKind: DashboardKind = "main";
const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: /\/api\/ads-os\/(?:combined\/dashboard|lsa\/dashboard|dashboard)\?/,
      json: ({ url }: { url: string }) => {
        if (url.includes("/combined/dashboard")) return { ...responseBase, rows: combinedRows };
        if (url.includes("/lsa/dashboard")) return { ...responseBase, rows: lsaRows };
        return { ...responseBase, rows: gadsRows };
      },
    },
    {
      path: "/api/auth/user",
      json: {
        id: "practice-area-operator",
        email: "operator@example.com",
        firstName: "Avery",
        lastName: "Operator",
        role: "account_manager",
      },
    },
    { path: "/api/ads-os/clickup/enabled", json: { enabled: false } },
    { path: "/api/ads-os/status", json: {} },
    { path: "/api/ads-os/clients", json: { clients: [] } },
    { path: "/api/ads-os/monitored-accounts", json: { accounts: [] } },
    { path: "/api/ads-os/lsa/monitored-accounts", json: { accounts: [] } },
  ],
  defaultJson: ({ url }: { url: string }) => {
    throw new Error(`Unexpected fetch in ${activeKind} Practice Area suite: ${url}`);
  },
});
(globalThis as any).fetch = fetchStub;

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const MainDashboardPage = (
  await import("../../client/src/pages/adsOs/MainDashboard")
).default;
const GadsDashboardPage = (
  await import("../../client/src/pages/adsOs/GadsDashboard")
).default;
const LsaDashboardPage = (
  await import("../../client/src/pages/adsOs/LsaDashboard")
).default;

let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${error?.stack ?? error}`);
  }
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  assert.ok(setter, "jsdom input value setter exists");
  await act(async () => {
    setter!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush(2);
}

async function setSelect(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  assert.ok(setter, "jsdom select value setter exists");
  await act(async () => {
    setter!.call(select, value);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush(2);
}

function practiceHeader(): { button: HTMLButtonElement; th: HTMLTableCellElement } {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("thead .dash-sort"),
  ).find((candidate) => candidate.textContent?.includes("Practice Area"));
  assert.ok(button, "Practice Area sortable header renders");
  const th = button.closest("th");
  assert.ok(th, "Practice Area button belongs to a table header");
  return { button, th };
}

function rowTestIds(prefix: string): string[] {
  return Array.from(
    document.querySelectorAll<HTMLTableRowElement>(`tbody tr[data-testid^="${prefix}"]`),
  ).map((row) => row.dataset.testid ?? "");
}

function practiceCell(rowTestId: string): string {
  const row = document.querySelector<HTMLTableRowElement>(
    `[data-testid="${rowTestId}"]`,
  );
  assert.ok(row, `${rowTestId} renders`);
  const cell = row.querySelector<HTMLElement>(".dash-practice-area");
  assert.ok(cell, `${rowTestId} has a Practice Area cell`);
  return cell.textContent?.trim() ?? "";
}

type SummaryLabels = {
  primary: string;
  volume: string;
  ratio: string;
  count: string;
  attention: string;
};

type SummaryValues = {
  primary: string;
  volume: string;
  ratio: string;
  count: string;
  attention: string;
};

function summaryValue(label: string): string {
  const tile = Array.from(
    document.querySelectorAll<HTMLElement>(".dash-summary .dash-stat"),
  ).find(
    (candidate) =>
      candidate.querySelector<HTMLElement>(".dash-stat-label")?.textContent?.trim() ===
      label,
  );
  assert.ok(tile, `summary tile "${label}" renders`);
  const value = tile.querySelector<HTMLElement>(".dash-stat-val");
  assert.ok(value, `summary tile "${label}" has a value`);
  return value.textContent?.trim() ?? "";
}

function assertSummary(labels: SummaryLabels, expected: SummaryValues): void {
  assert.equal(summaryValue(labels.primary), expected.primary, labels.primary);
  assert.equal(summaryValue(labels.volume), expected.volume, labels.volume);
  assert.equal(summaryValue(labels.ratio), expected.ratio, labels.ratio);
  assert.equal(summaryValue(labels.count), expected.count, labels.count);
  assert.equal(summaryValue(labels.attention), expected.attention, labels.attention);
}

async function withMounted(
  kind: DashboardKind,
  path: string,
  Page: AnyPage,
  run: () => void | Promise<void>,
): Promise<void> {
  activeKind = kind;
  dom.window.history.replaceState({}, "", path);
  const container = document.getElementById("root")!;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider as any,
          { client: queryClient },
          React.createElement(Page as any),
        ),
      );
    });
    await flush();
    await run();
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.innerHTML = "";
  }
}

async function exerciseDashboard({
  kind,
  path,
  Page,
  inputTestId,
  rowPrefix,
  defaultOrder,
  ascendingOrder,
  descendingOrder,
  populatedRow,
  blankRow,
  fullColSpan,
  expandableRow,
  doerSelectTestId,
  checkerSelectTestId,
  summaryLabels,
}: {
  kind: DashboardKind;
  path: string;
  Page: AnyPage;
  inputTestId: string;
  rowPrefix: string;
  defaultOrder: string[];
  ascendingOrder: string[];
  descendingOrder: string[];
  populatedRow: string;
  blankRow: string;
  fullColSpan: number;
  expandableRow?: string;
  doerSelectTestId: string;
  checkerSelectTestId: string;
  summaryLabels: SummaryLabels;
}): Promise<void> {
  console.log(`\nAds OS Practice Area columns — ${kind}`);
  await withMounted(kind, path, Page, async () => {
    await check("renders canonical multi-label text and the em-dash fallback", () => {
      assert.equal(practiceCell(populatedRow), "Family, Criminal Defense");
      assert.equal(practiceCell(blankRow), "—");
    });

    await check("keeps the existing name-ascending default sort", () => {
      assert.deepEqual(rowTestIds(rowPrefix), defaultOrder);
      assert.equal(practiceHeader().th.getAttribute("aria-sort"), "none");
    });

    await check("reconciles every summary tile to Doer/Checker ownership filters", async () => {
      const doer = document.querySelector<HTMLSelectElement>(
        `[data-testid="${doerSelectTestId}"]`,
      );
      const checker = document.querySelector<HTMLSelectElement>(
        `[data-testid="${checkerSelectTestId}"]`,
      );
      assert.ok(doer, "Doer filter renders");
      assert.ok(checker, "Checker filter renders");

      assertSummary(summaryLabels, {
        primary: "$600.00▲ 54%",
        volume: "20▲ 122%",
        ratio: "$30.00▼ 31%",
        count: "3",
        attention: "2",
      });

      await setSelect(doer, "Avery Doe");
      assert.deepEqual(rowTestIds(rowPrefix), defaultOrder.slice(0, 2));
      assertSummary(summaryLabels, {
        primary: "$300.00▲ 58%",
        volume: "14▲ 100%",
        ratio: "$21.43▼ 21%",
        count: "2",
        attention: "1",
      });

      await setSelect(doer, "");
      await setSelect(checker, "Casey Checker");
      assert.deepEqual(rowTestIds(rowPrefix), [defaultOrder[0], defaultOrder[2]]);
      assertSummary(summaryLabels, {
        primary: "$400.00▲ 38%",
        volume: "10▲ 100%",
        ratio: "$40.00▼ 31%",
        count: "2",
        attention: "2",
      });

      await setSelect(doer, "Avery Doe");
      assert.deepEqual(rowTestIds(rowPrefix), [defaultOrder[0]]);
      assertSummary(summaryLabels, {
        primary: "$100.00▲ 11%",
        volume: "4▲ 33%",
        ratio: "$25.00▼ 17%",
        count: "1",
        attention: "1",
      });

      await setSelect(doer, "Jordan Doer");
      await setSelect(checker, "Blake Checker");
      assert.deepEqual(rowTestIds(rowPrefix), []);
      assertSummary(summaryLabels, {
        primary: "$0.00",
        volume: "0",
        ratio: "—",
        count: "0",
        attention: "0",
      });

      await setSelect(doer, "");
      await setSelect(checker, "");
      assert.deepEqual(rowTestIds(rowPrefix), defaultOrder);
      assertSummary(summaryLabels, {
        primary: "$600.00▲ 54%",
        volume: "20▲ 122%",
        ratio: "$30.00▼ 31%",
        count: "3",
        attention: "2",
      });
    });

    await check("sorts Practice Area descending then ascending with blanks last", async () => {
      const header = practiceHeader();
      await act(async () => header.button.click());
      assert.equal(header.th.getAttribute("aria-sort"), "descending");
      assert.deepEqual(rowTestIds(rowPrefix), descendingOrder);

      await act(async () => header.button.click());
      assert.equal(header.th.getAttribute("aria-sort"), "ascending");
      assert.deepEqual(rowTestIds(rowPrefix), ascendingOrder);
    });

    await check("matches Practice Area labels in dashboard text search", async () => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-testid="${inputTestId}"]`,
      );
      assert.ok(input, "dashboard text filter renders");
      await setInput(input, "criminal");
      assert.deepEqual(rowTestIds(rowPrefix), [populatedRow]);
      await setInput(input, "");
    });

    if (expandableRow) {
      await check("expanded detail row spans the complete ten-column table", async () => {
        const row = document.querySelector<HTMLTableRowElement>(
          `[data-testid="${expandableRow}"]`,
        );
        assert.ok(row, "expandable account row renders");
        await act(async () => row.click());
        const detail = document.querySelector<HTMLTableCellElement>(
          ".cmb-detail-row td",
        );
        assert.equal(detail?.colSpan, fullColSpan);
        await act(async () => row.click());
      });
    }

    await check("filtered empty state spans the complete table width", async () => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-testid="${inputTestId}"]`,
      );
      assert.ok(input, "dashboard text filter renders");
      await setInput(input, "no-such-practice-area");
      const emptyCell = document.querySelector<HTMLTableCellElement>(
        "tbody tr td.pad",
      );
      assert.equal(emptyCell?.colSpan, fullColSpan);
    });
  });
}

await exerciseDashboard({
  kind: "main",
  path: "/ads-os",
  Page: MainDashboardPage,
  inputTestId: "input-combined-filter",
  rowPrefix: "row-combined-",
  defaultOrder: [
    "row-combined-Alpha Law",
    "row-combined-Bravo Law",
    "row-combined-Zulu Law",
  ],
  descendingOrder: [
    "row-combined-Zulu Law",
    "row-combined-Alpha Law",
    "row-combined-Bravo Law",
  ],
  ascendingOrder: [
    "row-combined-Alpha Law",
    "row-combined-Zulu Law",
    "row-combined-Bravo Law",
  ],
  populatedRow: "row-combined-Alpha Law",
  blankRow: "row-combined-Bravo Law",
  fullColSpan: 8,
  doerSelectTestId: "select-combined-doer",
  checkerSelectTestId: "select-combined-checker",
  summaryLabels: {
    primary: "Spend · 30d",
    volume: "Leads · 30d",
    ratio: "Blended CPL · 30d",
    count: "Clients",
    attention: "Needs attention",
  },
});

await exerciseDashboard({
  kind: "gads",
  path: "/ads-os/gads",
  Page: GadsDashboardPage,
  inputTestId: "input-gads-filter",
  rowPrefix: "row-gads-",
  defaultOrder: [
    "row-gads-1000000001",
    "row-gads-1000000002",
    "row-gads-1000000003",
  ],
  descendingOrder: [
    "row-gads-1000000003",
    "row-gads-1000000001",
    "row-gads-1000000002",
  ],
  ascendingOrder: [
    "row-gads-1000000001",
    "row-gads-1000000003",
    "row-gads-1000000002",
  ],
  populatedRow: "row-gads-1000000001",
  blankRow: "row-gads-1000000002",
  fullColSpan: 10,
  expandableRow: "row-gads-1000000001",
  doerSelectTestId: "select-gads-doer",
  checkerSelectTestId: "select-gads-checker",
  summaryLabels: {
    primary: "Spend · 30d",
    volume: "Conversions · 30d",
    ratio: "Blended CPA · 30d",
    count: "Accounts",
    attention: "Need attention",
  },
});

await exerciseDashboard({
  kind: "lsa",
  path: "/ads-os/lsa",
  Page: LsaDashboardPage,
  inputTestId: "input-lsa-filter",
  rowPrefix: "row-lsa-",
  defaultOrder: [
    "row-lsa-2000000001",
    "row-lsa-2000000002",
    "row-lsa-2000000003",
  ],
  descendingOrder: [
    "row-lsa-2000000003",
    "row-lsa-2000000001",
    "row-lsa-2000000002",
  ],
  ascendingOrder: [
    "row-lsa-2000000001",
    "row-lsa-2000000003",
    "row-lsa-2000000002",
  ],
  populatedRow: "row-lsa-2000000001",
  blankRow: "row-lsa-2000000002",
  fullColSpan: 10,
  expandableRow: "row-lsa-2000000001",
  doerSelectTestId: "select-lsa-doer",
  checkerSelectTestId: "select-lsa-checker",
  summaryLabels: {
    primary: "Cost · 30d",
    volume: "Charged leads · 30d",
    ratio: "Blended CPL · 30d",
    count: "Accounts",
    attention: "Need attention",
  },
});

if (failed > 0) {
  throw new Error(`${failed} Ads OS Practice Area column check(s) failed`);
}

console.log(
  "\nads-os-practice-area-columns: all three real dashboards preserve canonical labels, blank-last accessible sorting, search, and complete table spans.",
);