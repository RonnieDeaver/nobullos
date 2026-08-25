/* test-registration
{
  "name": "Engine funnel single source — Engine Health + Revenue Leak reconcile by construction, monotonicity guard annotates (Task #4278)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4278 (§8.5): Engine Health and Revenue Leak render the SAME leads→consults→cases pipeline; before the shared source they recomputed it independently and drifted (hard-coded $5K revenue vs entered avg case value, silent consults>leads). This pins the whole contract: (1) both slides render view.engineFunnel verbatim — stage values, No-data presence, and est. top-line revenue can never diverge; (2) a non-monotonic funnel NEVER renders without its carry-over annotation, in both slides and in FunnelChart's auto-injection (caller annotation wins); (3) ONE currency format deck-wide (uppercase K — a lowercase '$…k' anywhere is the drift tell); (4) the Revenue Leak reconciliation line names the Engine Health slide. DB-free, network-free SSR render of the real slide components.",
  "timeoutMs": 240000,
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4278 — ONE computed funnel/health source (shared/reportFunnel.ts,
 * stamped as view.engineFunnel by derivePublicReportView) feeds BOTH the
 * Engine Health slide and the Revenue Leak slide.
 *
 * Layers:
 *   1. Pure unit contract — findNonMonotonicBreaks (nulls skipped, never
 *      treated as 0), computeEngineFunnel presence gating (#3688: absent
 *      metric → null stage, revenue only when cases AND avg value entered),
 *      formatReportCurrency (compact "$212K"/"$1.3M" + precise mode for the
 *      user-entered avg case value — Task #2776), funnelCarryoverNote copy.
 *   2. Cross-slide reconciliation — SSR-render the REAL EngineHealthSlide and
 *      RevenueLeakSlide from one derived view and assert stage-by-stage text
 *      equality (values AND No-data states), identical carry-over annotation
 *      in both when consults > leads, hero revenue = shared estTopLineRevenue,
 *      the §8.7-8 reconciliation line, and zero lowercase "$…k" currency.
 *   3. FunnelChart guard — a non-monotonic group auto-injects the carry-over
 *      annotation; a caller-provided annotation at that boundary wins; a
 *      monotonic funnel renders no annotation rows.
 *
 * Memory: ssr-markup-escape-asserts — all copy asserts go through
 * jsdom textContent (entity-decoded), never raw-markup includes().
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";

// ── jsdom bootstrap (must precede the dynamic react/component imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;

const SLIDE_NUMBERS = {
  title: 1, roadmap: 2, ceoPulse: 3, marketContext: 4,
  engineHealth: 5, marketing: 6, intake: 7, sales: 8,
  lossAudit: 9, lifetimeValue: 10, next30: 11, bookPromo: 12,
};

/**
 * Minimal PublicReportRootState: leads arrive via the marketing "Other"
 * bucket (no products active), consults/cases/avg value via the intake and
 * sales sections. omitSales exercises the #3688 No-data lane.
 */
function buildRootState(opts: {
  leads: number;
  consults: number;
  cases: number;
  avgCaseValue: number;
  omitSales?: boolean;
}) {
  const sections: any[] = [
    {
      sectionKey: "intake",
      data: { totalConsults: opts.consults, leadToConsultRate: 55, noDataFlags: {} },
    },
    {
      sectionKey: "marketing",
      data: { posture: "scaling", otherLeads: { count: opts.leads, description: "Referrals" } },
    },
  ];
  if (!opts.omitSales) {
    sections.push({
      sectionKey: "sales",
      data: {
        totalCases: opts.cases,
        consultToCaseRate: 30,
        averageCaseValue: opts.avgCaseValue,
        noDataFlags: {},
      },
    });
  }
  return {
    isDemo: false,
    isPrintMode: false,
    isPreview: false,
    isEditing: false,
    prefersReducedMotion: true,
    printModeActive: false,
    hasCeoPulse: false,
    slideNumbers: SLIDE_NUMBERS,
    data: {
      report: { id: "r-4278", reportMonth: "2026-06" },
      client: { id: "c-4278", name: "Reconciliation Test Firm", products: [], terminology: null, consultType: "free" },
      sections,
      ceoPulse: null,
      trendData: null,
      productUpdates: [],
      slideVerdicts: null,
    },
  } as any;
}

function parse(html: string): Document {
  return new JSDOM(html).window.document;
}

function textOf(doc: Document, testId: string): string {
  const el = doc.querySelector(`[data-testid="${testId}"]`);
  assert.ok(el, `expected element [data-testid="${testId}"]`);
  return (el!.textContent ?? "").trim();
}

function has(doc: Document, testId: string): boolean {
  return doc.querySelector(`[data-testid="${testId}"]`) !== null;
}

/** Lowercase-k currency ("$120k") is the retired Engine Health format. */
const LOWERCASE_K_CURRENCY = /\$\d[\d,.]*k(?![A-Za-z])/;

async function run() {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const {
    computeEngineFunnel,
    findNonMonotonicBreaks,
    formatReportCurrency,
    funnelCarryoverNote,
  } = await import("../shared/reportFunnel");
  const { getTermLabel } = await import("../shared/schema");
  const { derivePublicReportView } = await import("../client/src/pages/publicReport/derive");
  const { EngineHealthSlide } = await import("../client/src/pages/publicReport/EngineHealthSlide");
  const { RevenueLeakSlide } = await import("../client/src/pages/publicReport/RevenueLeakSlide");
  const FunnelChart = (await import("../client/src/components/FunnelChart")).default;

  // ───────────────────────── 1. Pure unit contract ─────────────────────────

  // Monotonic: no breaks.
  assert.deepEqual(findNonMonotonicBreaks([300, 90, 27]), []);
  // Each increasing adjacent step is a break.
  assert.deepEqual(findNonMonotonicBreaks([100, 120, 130]), [
    { fromIndex: 0, toIndex: 1 },
    { fromIndex: 1, toIndex: 2 },
  ]);
  // Nulls are SKIPPED (No data ≠ 0): 140 compares against 100, not null.
  assert.deepEqual(findNonMonotonicBreaks([100, null, 140]), [
    { fromIndex: 0, toIndex: 2 },
  ]);
  // Equal values are monotonic (no break).
  assert.deepEqual(findNonMonotonicBreaks([100, 100, 30]), []);
  console.log("  ✓ findNonMonotonicBreaks: adjacent-valued comparison, nulls skipped");

  const funnelFull = computeEngineFunnel({
    totalLeads: 187, totalConsults: 237, totalCases: 24,
    hasConsultsData: true, hasCasesData: true,
    avgCaseValue: 8850, hasAvgCaseValueData: true,
  });
  assert.deepEqual(
    funnelFull.stages.map((s) => s.value),
    [187, 237, 24],
  );
  assert.deepEqual(funnelFull.breaks, [{ from: "leads", to: "consults" }]);
  assert.equal(funnelFull.estTopLineRevenue, 24 * 8850);

  // Revenue gating: BOTH cases and avg case value must be entered — never a
  // fabricated average (the retired strip hard-coded $5,000).
  assert.equal(
    computeEngineFunnel({
      totalLeads: 187, totalConsults: 237, totalCases: 24,
      hasConsultsData: true, hasCasesData: true,
      avgCaseValue: 0, hasAvgCaseValueData: false,
    }).estTopLineRevenue,
    null,
  );
  const funnelNoCases = computeEngineFunnel({
    totalLeads: 187, totalConsults: 237, totalCases: 0,
    hasConsultsData: true, hasCasesData: false,
    avgCaseValue: 8850, hasAvgCaseValueData: true,
  });
  assert.equal(funnelNoCases.estTopLineRevenue, null);
  assert.equal(funnelNoCases.stages[2].value, null);
  console.log("  ✓ computeEngineFunnel: presence gating + honest revenue");

  // ONE deck-wide currency format (uppercase K / one-decimal M).
  assert.equal(formatReportCurrency(212400), "$212K");
  assert.equal(formatReportCurrency(84008), "$84K");
  assert.equal(formatReportCurrency(999), "$999");
  assert.equal(formatReportCurrency(1250000), "$1.3M");
  // Task #2776: precise mode for the user-entered avg case value.
  assert.equal(formatReportCurrency(5250.5, true), "$5,250.50");
  assert.equal(formatReportCurrency(5000, true), "$5,000");
  console.log("  ✓ formatReportCurrency: compact + precise contract");

  assert.equal(
    funnelCarryoverNote("Leads", "Consults", "month"),
    "Consults include prior-month leads",
  );
  assert.equal(
    funnelCarryoverNote("Leads", "Consults"),
    "Consults include prior-period leads",
  );
  console.log("  ✓ funnelCarryoverNote copy");

  // ────────────────── 2. Cross-slide reconciliation (SSR) ──────────────────

  const renderBoth = (rootState: any) => {
    const view = derivePublicReportView(rootState);
    const engine = parse(renderToStaticMarkup(React.createElement(EngineHealthSlide, { view })));
    const leak = parse(renderToStaticMarkup(React.createElement(RevenueLeakSlide, { view })));
    return { view, engine, leak };
  };

  // Scenario A — non-monotonic (consults 237 > leads 187), full data.
  {
    const { view, engine, leak } = renderBoth(
      buildRootState({ leads: 187, consults: 237, cases: 24, avgCaseValue: 8850 }),
    );

    // Shared source is stamped and correct.
    assert.deepEqual(view.engineFunnel.stages.map((s: any) => s.value), [187, 237, 24]);
    assert.deepEqual(view.engineFunnel.breaks, [{ from: "leads", to: "consults" }]);

    // Stage-by-stage parity: both slides render the SHARED stage values.
    assert.equal(textOf(engine, "text-engine-flow-leads"), "187");
    assert.equal(textOf(leak, "text-leak-funnel-leads"), "187");
    assert.equal(textOf(engine, "text-engine-flow-consults"), "237");
    assert.equal(textOf(leak, "text-leak-funnel-consults"), "237");
    assert.equal(textOf(engine, "text-engine-flow-cases"), "24");
    assert.equal(textOf(leak, "text-leak-funnel-cases"), "24");

    // §8.5 monotonicity guard: the SAME carry-over annotation in BOTH slides.
    const expectedNote = funnelCarryoverNote(
      getTermLabel(null, "leads"),
      getTermLabel(null, "consults"),
      "month",
    );
    assert.equal(textOf(engine, "text-engine-flow-annotation-consults"), expectedNote);
    assert.equal(textOf(leak, "text-leak-funnel-annotation-consults"), expectedNote);

    // Hero = shared est. top-line revenue (entered cases × entered avg value).
    assert.equal(view.engineFunnel.estTopLineRevenue, 212400);
    assert.equal(textOf(engine, "text-engine-hero-revenue"), formatReportCurrency(212400));
    assert.equal(textOf(engine, "text-engine-hero-revenue"), "$212K");
    // The retired hard-coded $5K basis would have shown $120K — assert the
    // hero is priced off the ENTERED avg case value instead.
    assert.notEqual(textOf(engine, "text-engine-hero-revenue"), formatReportCurrency(24 * 5000));

    // Traffic-light cards replaced by compact squared status tags.
    assert.ok(has(engine, "tag-engine-intake"), "intake status tag renders");
    assert.ok(has(engine, "tag-engine-sales"), "sales status tag renders");
    assert.ok(has(engine, "tag-engine-marketing"), "marketing posture tag renders");

    // Revenue Leak headline goes through the SAME shared formatter.
    assert.equal(
      textOf(leak, "text-total-unrealized-revenue"),
      formatReportCurrency(view.unrealizedRevenue),
    );

    // §8.7-8 reconciliation line names the Engine Health slide.
    const reconciliation = textOf(leak, "text-leak-reconciliation");
    assert.ok(
      reconciliation.includes(`Engine Health (slide ${SLIDE_NUMBERS.engineHealth})`),
      `reconciliation line names the Engine Health slide: ${reconciliation}`,
    );

    // ONE value format deck-wide: no lowercase "$…k" anywhere on either slide.
    for (const [label, doc] of [["engine", engine], ["leak", leak]] as const) {
      assert.ok(
        !LOWERCASE_K_CURRENCY.test(doc.body.textContent ?? ""),
        `${label} slide must not render lowercase-k currency`,
      );
    }
    console.log("  ✓ scenario A: non-monotonic funnel reconciles + annotates in both slides");
  }

  // Scenario B — monotonic funnel: NO annotation anywhere.
  {
    const { view, engine, leak } = renderBoth(
      buildRootState({ leads: 300, consults: 90, cases: 27, avgCaseValue: 5000 }),
    );
    assert.deepEqual(view.engineFunnel.breaks, []);
    assert.equal(engine.querySelectorAll('[data-testid^="text-engine-flow-annotation-"]').length, 0);
    assert.equal(leak.querySelectorAll('[data-testid^="text-leak-funnel-annotation-"]').length, 0);
    assert.equal(textOf(engine, "text-engine-hero-revenue"), formatReportCurrency(27 * 5000));
    // Task #4841: a month whose revenue computes keeps the revenue hero —
    // no leads hero, no compact revenue-miss line (parity with the
    // pre-#4841 deck).
    assert.ok(!has(engine, "text-engine-hero-leads"), "no leads hero when revenue computes");
    assert.ok(!has(engine, "text-engine-hero-revenue-missing-compact"), "no compact revenue-miss line when revenue computes");
    console.log("  ✓ scenario B: monotonic funnel renders no annotations");
  }

  // Scenario C — sales section absent (#3688 lane): cases stage is null in
  // BOTH slides (No data, never 0), the hero refuses to fabricate revenue,
  // and the leads→consults break still annotates in both. Task #4841
  // partial-data hero: with 187 entered leads the hero slot renders the
  // SHARED leads stage at full scale and the revenue miss shrinks to one
  // compact muted line — the hero-scale "No data" slot is reserved for
  // zero-lead months (pinned in tests/client/report-empty-states.test.tsx).
  {
    const { view, engine, leak } = renderBoth(
      buildRootState({ leads: 187, consults: 237, cases: 0, avgCaseValue: 0, omitSales: true }),
    );
    assert.equal(view.engineFunnel.stages[2].value, null);
    assert.equal(view.engineFunnel.estTopLineRevenue, null);
    assert.ok(!has(engine, "text-engine-hero-revenue"), "no fabricated hero revenue");
    assert.equal(textOf(engine, "text-engine-hero-leads"), "187", "leads count takes the hero on a partial month");
    assert.equal(
      textOf(engine, "text-engine-hero-leads"),
      textOf(engine, "text-engine-flow-leads"),
      "hero and flow strip render the same shared leads stage",
    );
    assert.equal(
      textOf(engine, "text-engine-hero-leads"),
      textOf(leak, "text-leak-funnel-leads"),
      "leads hero reconciles with Revenue Leak by construction",
    );
    assert.ok(
      (engine.body.textContent ?? "").includes(`Leads Generated — ${view.monthLabel}`),
      "terminology-aware eyebrow labels the leads hero",
    );
    assert.ok(!has(engine, "text-engine-hero-revenue-missing"), "no hero-scale No-data slot over real leads");
    const revenueNote = textOf(engine, "text-engine-hero-revenue-missing-compact");
    assert.ok(revenueNote.startsWith("Est. top-line revenue: No data"), `compact line keeps the honest No data: ${revenueNote}`);
    assert.ok(
      revenueNote.includes("once you share this month's cases and average case value"),
      `compact line keeps the month-scoped share explanation: ${revenueNote}`,
    );
    assert.ok(has(engine, "text-engine-flow-cases-missing"), "engine cases cell shows No data");
    assert.ok(has(leak, "text-funnel-cases-missing"), "leak cases cell shows No data");
    assert.ok(has(engine, "text-engine-flow-annotation-consults"), "engine still annotates");
    assert.ok(has(leak, "text-leak-funnel-annotation-consults"), "leak still annotates");
    console.log("  ✓ scenario C: No-data parity + partial-data leads hero + guard independent of revenue");
  }

  // ───────────────────── 3. FunnelChart auto-injection ─────────────────────

  const chartHtml = (props: any) =>
    parse(renderToStaticMarkup(React.createElement(FunnelChart, { animate: false, ...props })));

  {
    // Non-monotonic group, no caller annotation → default injected.
    const doc = chartHtml({
      groups: [{
        label: "Pipeline",
        stages: [
          { label: "Leads", value: 100 },
          { label: "Consults", value: 140 },
          { label: "Cases", value: 30 },
        ],
      }],
    });
    const rows = doc.querySelectorAll('[data-testid^="funnel-annotation-"]');
    assert.equal(rows.length, 1, "one injected annotation row");
    assert.equal(
      (rows[0].textContent ?? "").trim(),
      funnelCarryoverNote("Leads", "Consults"),
    );

    // Caller-provided annotation at the same boundary wins — no double note.
    const docCaller = chartHtml({
      groups: [{
        label: "Pipeline",
        stages: [
          { label: "Leads", value: 100 },
          { label: "Consults", value: 140 },
          { label: "Cases", value: 30 },
        ],
      }],
      annotations: [{ afterStage: 0, text: "Consults include prior-month leads" }],
    });
    const callerRows = docCaller.querySelectorAll('[data-testid^="funnel-annotation-"]');
    assert.equal(callerRows.length, 1, "caller annotation only — nothing injected on top");
    assert.equal((callerRows[0].textContent ?? "").trim(), "Consults include prior-month leads");

    // Monotonic funnel → zero annotation rows.
    const docMono = chartHtml({
      groups: [{
        label: "Pipeline",
        stages: [
          { label: "Leads", value: 100 },
          { label: "Consults", value: 60 },
          { label: "Cases", value: 30 },
        ],
      }],
    });
    assert.equal(docMono.querySelectorAll('[data-testid^="funnel-annotation-"]').length, 0);
    console.log("  ✓ FunnelChart: injects carry-over note, caller annotation wins, monotonic clean");
  }

  console.log("report-engine-funnel-reconciliation: PASSED");
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-engine-funnel-reconciliation: FAILED", err);
    process.exitCode = 1;
  });
