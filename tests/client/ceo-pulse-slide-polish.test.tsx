/* test-registration
{
  "name": "CEO Pulse report-slide polish — By The Numbers card caps at TWO charts + ONE insight paragraph, per-chart 'Source: …' attribution lines survive as the legible source copy, the Product Updates block still renders on the slide and hides when empty, centralized NoBull Brief strings render, no sub-11px (text-[10px]) type remains anywhere in the slide markup (Task #4276, §8.7-3), the report chart palette (Task #4414) keeps stock SaaS hexes/classes out of the slide (AI-emitted colors remapped onto --report-* tokens, AA under white segment labels) while the paletteless OS rendering keeps its stock colors, and text-only company-update briefs render the compact announcement layout (initiative tiles + commitment rows, break-inside-avoid print safety, report tokens only) while market-shift/legacy text-only briefs keep the stacked bullet columns (Task #4813); Tasks #4834 + #4984: roadmap-shaped company updates render the simplified roadmap deck twin (kicker/supporting line, snapshot cards with category icons or numbered fallback, Why This Matters as lead + whyBullets with the capped 3-paragraph legacy fallback, serif pull quote) under the same no-stock-hex/no-stock-class/print-safe/≥11px contract, with per-section omission — Task #4984 deletes the Before & After and What's Coming Next bands, which stay absent even when an already-published brief's stored analysis still carries beforeAfter/timeline (those legacy fields keep the roadmap template active, never render) — while roadmap-free rows keep the announcement layout and market-shift/charts-mode never adopt the twin",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4276: fast (~2s), pure SSR + pure-function units, DB/DOM/fetch-free; pins the §8.7-3 slide contract on the client-report surface clients actually receive — a regression here silently ships a chart-wall slide (no cap), duplicated or vanished insight prose, an AWOL Product Updates block (#4216), or illegible sub-11px source lines, none of which any other suite renders (existing suites cover CeoPulseVisual strings and getUsableSeries only).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4276 — §8.7-3 residuals of the client-report design audit.
 *
 * Layer choice (test-economics L1): the contract is markup shape + a pure
 * derivation, so this suite runs at the cheapest sufficient layer —
 * react-dom/server static markup plus direct unit calls. No jsdom, no DB,
 * no network. Existing coverage this does NOT duplicate:
 *   - nobull-brief-edition-rendering.test.tsx pins CeoPulseVisual (the
 *     /pulse share page), not the report slide;
 *   - ceo-pulse-series-validation.test.tsx pins getUsableSeries (#4226);
 *   - report-product-updates.test.ts pins the SERVER payload selection.
 *
 * What this suite uniquely pins:
 *   (1) splitChartSourceInsight / deriveCeoPulseSlideContent semantics —
 *       two-chart cap, source-line extraction (incl. dotted source names),
 *       first-prose promotion without double-rendering, unparseable
 *       fallbacks that never lose text.
 *   (2) The rendered slide: exactly CEO_PULSE_SLIDE_MAX_CHARTS chart
 *       wrappers from a 3-chart analysis, exactly one insight paragraph
 *       (prose only — no "Source:" leakage), attribution lines rendered.
 *   (3) Product Updates block (#4216): present with a payload, absent when
 *       the payload is null AND when both item lists are empty.
 *   (4) Centralized NOBULL_BRIEF_STRINGS render on the slide; no
 *       user-visible "CEO Pulse" text.
 *   (5) §8.3 legibility floor: no text-[10px] class anywhere in the slide
 *       markup (renderer, product updates, progress bars all ≥11px).
 *   (7) Task #4813 — text-only company_update briefs render the compact
 *       ANNOUNCEMENT layout on the deck slide (name-first initiative tiles +
 *       short commitment rows; print-safe break-inside-avoid; report token
 *       classes only), legacy overlong details render clamped, the additive
 *       optional status chip renders only when present, and market-shift /
 *       legacy-untagged text-only briefs keep the stacked bullet columns.
 *   (8) Tasks #4834 + #4984 — roadmap-shaped company updates (aiAnalysis
 *       carries supportingLine/whyBullets/pullQuote/categories, or legacy
 *       beforeAfter/timeline from a pre-#4984 published brief) render the
 *       simplified ROADMAP deck twin: banner kicker + supporting line,
 *       snapshot cards (category icon or padded-number fallback, optional
 *       status chip), a Why This Matters card (lead paragraph + short
 *       bullets when whyBullets exist; capped 3-paragraph legacy fallback
 *       otherwise), and a serif pull quote on the crimson card. Task #4984
 *       deleted the Before & After and What's Coming Next bands: they must
 *       never render — even when the stored analysis still carries the
 *       legacy fields, which continue to count toward roadmap-layout
 *       detection so old published briefs keep the template. The twin
 *       holds the same report contract as (6)-(7): no stock hexes/classes,
 *       no sub-11px type, break-inside-avoid on every card. Sections with
 *       absent data are omitted; roadmap-free rows keep the (7) announcement
 *       layout; market-shift and charts-mode ignore roadmap fields.
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CeoPulseSlide } from "../../client/src/pages/publicReport/CeoPulseSlide";
import {
  CEO_PULSE_SLIDE_MAX_CHARTS,
  deriveCeoPulseSlideContent,
  splitChartSourceInsight,
} from "../../client/src/components/ceoPulseSlideContent";
import { NOBULL_BRIEF_STRINGS } from "../../client/src/components/ceoPulseCopy";
import type { CeoPulseChart } from "../../client/src/components/CeoPulseChartRenderer";

// Harness-agnostic JSX-runtime shim: under a bare `npx tsx <file>` invocation
// the root tsconfig compiles JSX with the CLASSIC runtime (React.createElement)
// while the component modules carry no React import of their own (the app
// builds with the automatic runtime). Bind React globally BEFORE the first
// render so this contract executes identically under the registered runner
// (tsconfig.tests.json → automatic runtime), the batched worker, and bare tsx.
(globalThis as { React?: typeof React }).React = React;

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// react-dom/server escapes text content (' → &#x27; etc.) — compare rendered
// markup against the escaped form of a constant, not the raw string.
const ssrEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// (1) Pure derivation semantics
// ---------------------------------------------------------------------------

{
  assert.equal(CEO_PULSE_SLIDE_MAX_CHARTS, 2);
  ok("slide chart cap is 2 (§8.7-3)");

  // Canonical AI prompt shape: "Source: <name>. <prose>"
  const s1 = splitChartSourceInsight(
    "Source: First Page Sage. Google dominates transactional searches with 90% share.",
  );
  assert.equal(s1.source, "Source: First Page Sage");
  assert.equal(s1.insight, "Google dominates transactional searches with 90% share.");
  ok("splits 'Source: X. prose' into attribution + insight");

  // Dotted source names (domains) must not truncate at the first period.
  const s2 = splitChartSourceInsight("Source: firstpagesage.com. AI referrals doubled.");
  assert.equal(s2.source, "Source: firstpagesage.com");
  assert.equal(s2.insight, "AI referrals doubled.");
  ok("dotted source names survive (sentence-boundary split)");

  // "Sources:" plural also parses.
  const s3 = splitChartSourceInsight("Sources: SEMrush, GBP. Rankings held steady.");
  assert.equal(s3.source, "Sources: SEMrush, GBP");
  assert.equal(s3.insight, "Rankings held steady.");
  ok("plural 'Sources:' prefix parses");

  // Attribution-only description → source without trailing period, no insight.
  const s4 = splitChartSourceInsight("Source: Internal CRM data.");
  assert.equal(s4.source, "Source: Internal CRM data");
  assert.equal(s4.insight, null);
  ok("attribution-only description → source only");

  // No prefix → everything is insight; nothing invented.
  const s5 = splitChartSourceInsight("Referrals grew 2x quarter over quarter.");
  assert.equal(s5.source, null);
  assert.equal(s5.insight, "Referrals grew 2x quarter over quarter.");
  ok("prefix-less description → insight only");

  assert.deepEqual(splitChartSourceInsight(undefined), { source: null, insight: null });
  assert.deepEqual(splitChartSourceInsight("   "), { source: null, insight: null });
  ok("empty/undefined descriptions → nulls");
}

const chart = (over: Partial<CeoPulseChart>): CeoPulseChart =>
  ({
    type: "comparison",
    title: "Chart",
    data: [
      { label: "Google", value: 90 },
      { label: "AI platforms", value: 10 },
    ],
    valueSuffix: "%",
    ...over,
  }) as CeoPulseChart;

{
  const three = [
    chart({
      title: "Search share",
      description: "Source: First Page Sage. Google dominates transactional searches with 90% share.",
    }),
    chart({
      title: "Referral growth",
      description: "Source: Internal CRM data. Referrals grew 2x quarter over quarter.",
    }),
    chart({ title: "Third chart", description: "Source: SEMrush. Should be capped away." }),
  ];
  const derived = deriveCeoPulseSlideContent(three);
  assert.equal(derived.charts.length, 2);
  assert.equal(derived.charts[0].title, "Search share");
  assert.equal(derived.charts[1].title, "Referral growth");
  ok("3 charts cap to the first 2");

  assert.equal(derived.charts[0].description, "Source: First Page Sage");
  assert.equal(derived.charts[1].description, "Source: Internal CRM data");
  ok("capped charts keep only their attribution lines");

  assert.equal(derived.insight, "Google dominates transactional searches with 90% share.");
  ok("insight = first chart's prose");

  // Unparseable first description gets promoted wholesale and must NOT also
  // stay on the chart (no double render).
  const promoted = deriveCeoPulseSlideContent([
    chart({ title: "A", description: "Referrals grew 2x quarter over quarter." }),
    chart({ title: "B", description: "Source: GBP. Calls held steady." }),
  ]);
  assert.equal(promoted.insight, "Referrals grew 2x quarter over quarter.");
  assert.equal(promoted.charts[0].description, undefined);
  assert.equal(promoted.charts[1].description, "Source: GBP");
  ok("promoted prefix-less description is dropped from its chart (no duplication)");

  // Attribution-only first chart → insight comes from the second.
  const secondProse = deriveCeoPulseSlideContent([
    chart({ title: "A", description: "Source: Internal CRM data." }),
    chart({ title: "B", description: "Source: GBP. Calls held steady." }),
  ]);
  assert.equal(secondProse.insight, "Calls held steady.");
  assert.equal(secondProse.charts[0].description, "Source: Internal CRM data");
  ok("attribution-only first chart → insight promoted from second");

  assert.deepEqual(deriveCeoPulseSlideContent([]), { charts: [], insight: null });
  assert.deepEqual(deriveCeoPulseSlideContent(undefined), { charts: [], insight: null });
  ok("empty/undefined chart lists → empty content");
}

// ---------------------------------------------------------------------------
// (2)–(5) Rendered slide (react-dom/server, no jsdom)
// ---------------------------------------------------------------------------

const productUpdates = {
  quarterLabel: "Q3 2026",
  upcoming: [
    {
      id: "itm-up-1",
      title: "Faster intake routing",
      typeName: "Feature",
      description: null,
      status: "in_progress",
      releaseQuarter: "2026-Q3",
      completedAt: null,
    },
  ],
  completed: [
    {
      id: "itm-done-1",
      title: "Call transcripts in reports",
      typeName: "Improvement",
      description: null,
      status: "shipped",
      releaseQuarter: "2026-Q2",
      completedAt: "2026-07-15T12:00:00.000Z",
    },
  ],
};

function makeView(over: Record<string, unknown> = {}): any {
  return {
    ceoPulse: {
      edition: "company_update",
      includeGraphs: true,
      fullLetterHtml: "<p>letter</p>",
      shareToken: "tok-test-4276",
      aiAnalysis: {
        headline: "Search is consolidating fast",
        keyTakeaways: ["AI referrals grew 2x this quarter"],
        strategicImplications: ["Double down on retrieval-friendly content"],
        charts: [
          chart({
            title: "Search share",
            description:
              "Source: First Page Sage. Google dominates transactional searches with 90% share.",
          }),
          chart({
            title: "Referral growth",
            description: "Source: Internal CRM data. Referrals grew 2x quarter over quarter.",
          }),
          chart({ title: "Third chart", description: "Source: SEMrush. Should be capped away." }),
        ],
      },
    },
    data: {},
    report: {},
    monthLabel: "July 2026",
    productUpdates,
    slideNumbers: { ceoPulse: 9 },
    ...over,
  };
}

function renderSlide(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(<CeoPulseSlide view={makeView(over)} />);
}

{
  const html = renderSlide();

  const chartWrappers = html.match(/data-testid="chart-/g) ?? [];
  assert.equal(
    chartWrappers.length,
    CEO_PULSE_SLIDE_MAX_CHARTS,
    `expected exactly ${CEO_PULSE_SLIDE_MAX_CHARTS} chart wrappers, got ${chartWrappers.length}`,
  );
  assert.ok(!html.includes("Third chart"), "third chart must be capped away");
  ok("slide renders exactly two chart wrappers from a 3-chart analysis");

  const insightMatches = html.match(/data-testid="text-ceo-pulse-insight"/g) ?? [];
  assert.equal(insightMatches.length, 1);
  assert.ok(html.includes("Google dominates transactional searches with 90% share."));
  ok("exactly one insight paragraph, carrying the first chart's prose");

  // The insight paragraph is prose-only; attribution stays with the charts.
  const insightText = html.match(
    /data-testid="text-ceo-pulse-insight"[^>]*>([^<]*)</,
  )?.[1] ?? html.match(/<p[^>]*data-testid="text-ceo-pulse-insight"[^>]*>([^<]*)</)?.[1] ?? "";
  assert.ok(insightText.length > 0, "insight paragraph text should be extractable");
  assert.ok(!insightText.includes("Source:"), "insight paragraph must not contain 'Source:'");
  assert.ok(html.includes("Source: First Page Sage"));
  assert.ok(html.includes("Source: Internal CRM data"));
  ok("source attribution lines render with their charts, not inside the insight");

  // (3) Product Updates block intact and correctly placed on the slide.
  assert.ok(html.includes('data-testid="ceo-pulse-product-updates"'));
  assert.ok(html.includes("Faster intake routing"));
  assert.ok(html.includes("Call transcripts in reports"));
  assert.ok(
    html.indexOf('data-testid="text-ceo-pulse-insight"') <
      html.indexOf('data-testid="ceo-pulse-product-updates"'),
    "product updates render after the By The Numbers card",
  );
  assert.ok(
    html.indexOf('data-testid="ceo-pulse-product-updates"') <
      html.indexOf('data-testid="link-full-letter-report"'),
    "product updates render before the full-letter CTA",
  );
  ok("Product Updates block renders in place (after charts, before letter CTA)");

  // (4) Centralized strings (SSR-escaped comparison — several contain
  // apostrophes).
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.title)));
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.letterCtaEyebrow)));
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.letterCtaLabel)));
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.tagline)));
  assert.ok(!html.includes("CEO Pulse"), "no user-visible 'CEO Pulse' text may remain");
  ok("centralized NoBull Brief strings render; no 'CEO Pulse' text");

  // (5) §8.3 legibility floor across the WHOLE slide markup.
  assert.ok(!html.includes("text-[10px]"), "no text-[10px] anywhere in the slide");
  assert.ok(!html.includes("text-[8px]"), "no text-[8px] anywhere in the slide");
  assert.ok(!html.includes("text-[9px]"), "no text-[9px] anywhere in the slide");
  ok("no sub-11px Tailwind text classes in slide markup");
}

{
  // Product Updates hides when the payload is null…
  const withoutUpdates = renderSlide({ productUpdates: null });
  assert.ok(!withoutUpdates.includes("ceo-pulse-product-updates"));
  // …and when the payload exists but both lists are empty (component
  // self-hide guard).
  const emptyUpdates = renderSlide({
    productUpdates: { quarterLabel: "Q3 2026", upcoming: [], completed: [] },
  });
  assert.ok(!emptyUpdates.includes("ceo-pulse-product-updates"));
  ok("Product Updates block hides on null AND on empty payloads");
}

{
  // includeGraphs=false → no charts, no insight paragraph, rest of slide
  // intact. The fixture's edition is company_update, so text-only now takes
  // the Task #4813 announcement layout: initiative tiles + commitment rows
  // instead of the stacked bullet columns.
  const view = makeView();
  view.ceoPulse.includeGraphs = false;
  const html = renderToStaticMarkup(<CeoPulseSlide view={view} />);
  assert.ok(!html.includes('data-testid="chart-'));
  assert.ok(!html.includes("text-ceo-pulse-insight"));
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.title)));
  assert.ok(html.includes('data-testid="ceo-pulse-product-updates"'));
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.updateInitiativesLabel)), "announcement initiatives label renders");
  assert.ok(html.includes(NOBULL_BRIEF_STRINGS.updateCommitmentsLabel), "announcement commitments label renders");
  assert.ok(html.includes('data-testid="initiative-card-0"'), "initiative tile renders");
  assert.ok(html.includes('data-testid="commitment-0"'), "commitment row renders");
  // String-form fixture items render whole as the leads.
  assert.ok(html.includes("AI referrals grew 2x this quarter"), "string takeaway renders as the tile lead");
  assert.ok(html.includes("Double down on retrieval-friendly content"), "string implication renders as the statement");
  assert.ok(!html.includes('data-testid="text-takeaway-0"'), "old stacked bullets replaced for company updates");
  assert.ok(!html.includes("Key Takeaways"), "old takeaway label replaced for company updates");
  // Frame preserved around the new layout.
  assert.ok(
    html.indexOf('data-testid="ceo-pulse-product-updates"') <
      html.indexOf('data-testid="link-full-letter-report"'),
    "product updates still render before the full-letter CTA",
  );
  ok("includeGraphs=false renders no charts/insight; company update takes the announcement layout");
}

// ---------------------------------------------------------------------------
// (6) Task #4414 — report chart palette: the slide's charts ride the
// --report-* brand palette; stock SaaS hexes/classes never reach the report
// markup; the paletteless (internal OS) rendering is byte-identically stock.
// ---------------------------------------------------------------------------

import CeoPulseChartRenderer from "../../client/src/components/CeoPulseChartRenderer";
import {
  REPORT_CEO_PULSE_CHART_PALETTE,
  REPORT_COLORS,
  REPORT_STATUS_COLORS,
} from "../../client/src/pages/publicReport/reportTokens";

// Stock renderer colors that must never appear in report markup: the
// renderer's DEFAULT_COLORS, FunnelChart's LIGHT_COLORS/DARK_COLORS stage
// schemes, and the stock amber annotation callout. #9CA3AF is deliberately
// absent from this list: it doubles as the sanctioned report `slate` token
// (the palette's previous-period neutral).
const STOCK_HEXES = [
  "#8B2E31", "#2D6A4F", "#1E3A5F", "#D97706", "#7C3AED", "#0891B2", "#C4A35A",
  "#D4A5A7", "#C48B8E", "#B47275", "#A4585C", "#944043",
  "#7A2729", "#6B2023", "#5C191C", "#4D1316",
  "#FEF3C7", "#F59E0B", "#92400E",
];
const STOCK_CLASSES = [
  // RoadmapProgressBar's OS styling (report variant must replace these)
  "text-emerald-700", "text-slate-500", "bg-slate-200/70", "bg-emerald-500", "bg-amber-400", "bg-primary","text-[#333333]", "bg-gray-50", "bg-gray-100", "border-gray-200", "border-gray-100", "text-green-600", "text-red-600", "bg-red-500", "border-[#8B2E31]"];

// Non-recharts chart types (plain DOM — fills render in SSR, unlike
// ResponsiveContainer charts which need a measured box), with AI-emitted
// stock colors and a legend reusing one of them.
const paletteCharts: CeoPulseChart[] = [
  {
    type: "metric_cards",
    title: "KPIs",
    data: [
      { label: "Leads", value: 42, previousValue: 30, color: "#1E3A5F" },
      { label: "Calls", value: 18, previousValue: 25, color: "#2D6A4F" },
    ],
    legend: [
      { label: "Leads", color: "#1E3A5F" },
      { label: "Calls", color: "#2D6A4F" },
    ],
  },
  {
    // Funnel: one AI-supplied stock stage color, one default (scheme ramp),
    // plus an annotation → covers stage-fill remapping AND the callout.
    type: "funnel",
    title: "Lead funnel",
    groups: [
      {
        label: "This month",
        colorScheme: "dark",
        stages: [
          { label: "Visits", value: 900, color: "#1E3A5F" },
          { label: "Leads", value: 300 },
          { label: "Booked", value: 90 },
        ],
      },
    ],
    annotations: [{ afterStage: 0, text: "33% convert" }],
  } as unknown as CeoPulseChart,
];

const progressChart: CeoPulseChart = {
  type: "progress",
  title: "Goal progress",
  data: [{ label: "Reviews", value: 64 }],
  target: 80,
  valueSuffix: "%",
} as CeoPulseChart;

{
  // Every palette value must reuse an existing sanctioned report token — no
  // new hexes may enter through this side door.
  const sanctioned = new Set<string>([
    ...Object.values(REPORT_COLORS),
    ...Object.values(REPORT_STATUS_COLORS),
  ]);
  const paletteValues = [
    ...REPORT_CEO_PULSE_CHART_PALETTE.series,
    ...REPORT_CEO_PULSE_CHART_PALETTE.funnelStages,
    REPORT_CEO_PULSE_CHART_PALETTE.primary,
    REPORT_CEO_PULSE_CHART_PALETTE.neutral,
    REPORT_CEO_PULSE_CHART_PALETTE.target,
    REPORT_CEO_PULSE_CHART_PALETTE.grid,
    REPORT_CEO_PULSE_CHART_PALETTE.ink,
    REPORT_CEO_PULSE_CHART_PALETTE.inkFaint,
    REPORT_CEO_PULSE_CHART_PALETTE.valueOnDark,
    REPORT_CEO_PULSE_CHART_PALETTE.positiveText,
    REPORT_CEO_PULSE_CHART_PALETTE.negativeText,
  ];
  for (const v of paletteValues) {
    assert.ok(sanctioned.has(v), `palette value ${v} is not a sanctioned report token`);
  }
  ok("report chart palette reuses only sanctioned report tokens (no new hexes)");

  // AA floor: the renderer paints WHITE value labels on stacked-bar segment
  // fills, so every series entry must hold ≥4.5:1 under white.
  const srgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
  };
  const luminance = (hex: string) => {
    const [r, g, b] = srgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastVsWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
  for (const s of [
    ...REPORT_CEO_PULSE_CHART_PALETTE.series,
    ...REPORT_CEO_PULSE_CHART_PALETTE.funnelStages,
  ]) {
    assert.ok(
      contrastVsWhite(s) >= 4.5,
      `series/funnel fill ${s} fails AA (${contrastVsWhite(s).toFixed(2)}:1) under white labels`,
    );
  }
  ok("every report series + funnel-stage fill holds WCAG AA (≥4.5:1) under white labels");
}

{
  // Rendered slide: replace the fixture charts with the DOM-rendering types
  // so fills/classes are visible in static markup.
  const view = makeView();
  view.ceoPulse.aiAnalysis.charts = paletteCharts;
  const html = renderToStaticMarkup(<CeoPulseSlide view={view} />);

  for (const hex of STOCK_HEXES) {
    assert.ok(
      !html.toLowerCase().includes(hex.toLowerCase()),
      `stock hex ${hex} leaked into report slide markup`,
    );
  }
  for (const cls of STOCK_CLASSES) {
    assert.ok(!html.includes(cls), `stock class ${cls} leaked into report slide markup`);
  }
  ok("no stock renderer hexes or utility classes reach the report slide markup");

  // AI-emitted explicit colors are REMAPPED (first-seen order) onto the
  // report series, and legend swatches agree with the data fills.
  const first = REPORT_CEO_PULSE_CHART_PALETTE.series[0];
  const second = REPORT_CEO_PULSE_CHART_PALETTE.series[1];
  assert.equal((html.match(new RegExp(first, "gi")) ?? []).length >= 2, true,
    "first AI color (#1E3A5F card + legend swatch) should remap to series[0] in both places");
  assert.ok(html.toLowerCase().includes(second.toLowerCase()),
    "second AI color should remap to series[1]");
  ok("AI-emitted stock colors remap deterministically; legend matches data fills");

  // Funnel stages ride the report ramp: AI stock stage colors AND scheme
  // defaults are both replaced (stage i clamps to the last ramp entry).
  for (const rampHex of REPORT_CEO_PULSE_CHART_PALETTE.funnelStages) {
    assert.ok(html.toLowerCase().includes(rampHex.toLowerCase()),
      `funnel ramp color ${rampHex} missing from report slide markup`);
  }
  ok("funnel stage fills ride the report crimson ramp (AI + default stages)");

  // Product Updates progress bars (RoadmapProgressBar variant="report"):
  // report track + fill + label classes replace the stock emerald/slate set.
  for (const cls of ["bg-report-cream-deep", "bg-report-healthy", "text-report-healthy", "text-report-ink-muted"]) {
    assert.ok(html.includes(cls), `report progress-bar class ${cls} missing from slide markup`);
  }
  ok("Product Updates progress bars ride report token classes");

  // Report-token classes are actually in play on the chart card DOM.
  assert.ok(html.includes("text-report-ink"), "report ink class missing from chart markup");
  assert.ok(html.includes("bg-report-paper-bright"), "report card field class missing");
  ok("chart DOM rides report token classes inside the slide");
}

{
  // Progress charts (dropped by the 2-chart slide cap above) — render the
  // renderer directly in report mode and hold the same no-stock contract.
  const html = renderToStaticMarkup(
    <CeoPulseChartRenderer charts={[progressChart]} palette={REPORT_CEO_PULSE_CHART_PALETTE} />,
  );
  for (const hex of STOCK_HEXES) {
    assert.ok(!html.toLowerCase().includes(hex.toLowerCase()), `stock hex ${hex} leaked into report progress markup`);
  }
  for (const cls of STOCK_CLASSES) {
    assert.ok(!html.includes(cls), `stock class ${cls} leaked into report progress markup`);
  }
  assert.ok(html.includes("bg-report-cream-deep"), "report progress track class missing");
  ok("report-mode progress chart holds the no-stock contract too");
}

{
  // Paletteless rendering (the internal OS surface) keeps the stock colors —
  // report branding must NOT leak into the OS. Funnel keeps the AI stage
  // color verbatim and its stock dark scheme for unstyled stages.
  const html = renderToStaticMarkup(<CeoPulseChartRenderer charts={paletteCharts} compact />);
  assert.ok(html.includes("#1E3A5F"), "OS rendering must keep AI-emitted colors untouched");
  assert.ok(html.includes("#7A2729"), "OS funnel must keep its stock dark scheme for default stages");
  assert.ok(html.includes("text-[#333333]"), "OS rendering must keep stock ink classes");
  assert.ok(!html.includes("text-report-ink"), "report classes must not leak into the OS rendering");
  ok("paletteless OS rendering keeps stock colors (no report leakage)");
}

{
  // (7) Task #4813 — compact announcement layout for company-update
  // text-only briefs, on the object-form {highlight, detail, status?} shape.
  // Details are deliberately overlong (~250 chars, the shape of the real
  // August 2026 prod draft, read from the prod replica 2026-08-14) — the
  // slide must contain them via clamps, not render bullet walls.
  const longDetail =
    "We are rebuilding the first impression a prospective client gets when they search the firm so the reviews they see — count, recency, and the story they tell — finally match the quality of the work delivered, because that first scan decides who gets the call.";
  const view = makeView();
  view.ceoPulse.includeGraphs = false;
  view.ceoPulse.aiAnalysis.keyTakeaways = [
    { highlight: "Review Velocity System", detail: longDetail, status: "In beta" },
    { highlight: "Company Roadmap visibility", detail: longDetail },
  ] as any;
  view.ceoPulse.aiAnalysis.strategicImplications = [
    { highlight: "You get more reviews", detail: "with less chasing, month over month." },
  ] as any;
  const html = renderToStaticMarkup(<CeoPulseSlide view={view} />);

  assert.ok(html.includes('data-testid="initiative-card-0"'), "initiative tile 0 renders");
  assert.ok(html.includes('data-testid="initiative-card-1"'), "initiative tile 1 renders");
  assert.ok(html.includes("Review Velocity System"), "initiative NAME leads the tile");
  assert.ok(html.includes('data-testid="initiative-status-0"'), "status chip renders when present");
  assert.ok(html.includes("In beta"), "status chip carries the stage text");
  assert.ok(!html.includes('data-testid="initiative-status-1"'), "no chip without the additive field");
  assert.ok(html.includes("line-clamp-3"), "overlong legacy details clamped on the slide");
  assert.ok(html.includes('data-testid="commitment-0"'), "commitment row renders");
  assert.ok(html.includes("break-inside-avoid"), "tiles are print-safe (no mid-card page breaks)");
  assert.ok(!html.includes('data-testid="text-takeaway-0"'), "stacked bullets gone for company updates");

  // Report chrome contract holds on the NEW markup too: token classes only,
  // no stock hexes/classes, and the §8.3 legibility floor.
  for (const hex of STOCK_HEXES) {
    assert.ok(!html.toLowerCase().includes(hex.toLowerCase()), `stock hex ${hex} leaked into the announcement slide markup`);
  }
  for (const cls of STOCK_CLASSES) {
    assert.ok(!html.includes(cls), `stock class ${cls} leaked into the announcement slide markup`);
  }
  for (const cls of ["text-[10px]", "text-[9px]", "text-[8px]"]) {
    assert.ok(!html.includes(cls), `sub-11px type (${cls}) in the announcement slide markup`);
  }
  assert.ok(html.includes("border-report-gold"), "initiative tiles ride the report gold token");
  assert.ok(html.includes("text-report-crimson"), "status chip rides the report crimson token");
  ok("company-update announcement slide: tiles + chips + clamps, report tokens only, print-safe");

  // Market-shift and legacy-untagged text-only briefs keep the stacked
  // columns byte-for-byte (the announcement branch must not widen).
  for (const [label, edition] of [
    ["market_shift", "market_shift"],
    ["legacy untagged", null],
  ] as Array<[string, string | null]>) {
    const old = makeView();
    old.ceoPulse.includeGraphs = false;
    (old.ceoPulse as any).edition = edition;
    const oldHtml = renderToStaticMarkup(<CeoPulseSlide view={old} />);
    assert.ok(oldHtml.includes("Key Takeaways"), `${label}: old takeaway label kept`);
    assert.ok(oldHtml.includes('data-testid="text-takeaway-0"'), `${label}: old stacked bullets kept`);
    assert.ok(!oldHtml.includes('data-testid="initiative-card-0"'), `${label}: no initiative tiles`);
    assert.ok(!oldHtml.includes(ssrEscape(NOBULL_BRIEF_STRINGS.updateInitiativesLabel)), `${label}: no announcement label`);
  }
  ok("market-shift / legacy text-only slides keep the stacked bullet columns");
}

{
  // (8) Task #4834 roadmap deck twin, simplified by Task #4984. Fixture:
  // whyBullets present (→ lead + bullets; the 4 stored paragraphs are
  // superseded), unknown + missing categories (→ padded-number fallback),
  // PLUS legacy beforeAfter/timeline still stored on an already-published
  // brief — they keep the roadmap template active but must never render.
  const roadmapAnalysis = {
    headline: "Reviews now drive the build queue",
    keyTakeaways: [
      { highlight: "Review Velocity System", detail: "Automates the ask cadence.", status: "In beta", category: "System" },
      { highlight: "Partner Education Series", detail: "Short trainings on the new workflow.", category: "Education" },
      { highlight: "Mystery Area Initiative", detail: "Unknown category falls back to a number.", category: "Logistics" },
      { highlight: "No Category Initiative", detail: "No category numbers too." },
    ],
    strategicImplications: [{ highlight: "You get more reviews", detail: "with less chasing." }],
    contextNarrative: [
      "Why paragraph one.",
      "Why paragraph two.",
      "Why paragraph three.",
      "Why paragraph four must not render.",
    ],
    byTheNumbers: [],
    charts: [],
    supportingLine: "Because reviews decide who gets the first call.",
    whyBullets: [
      "The old chase is gone; the cadence runs itself.",
      "Every closed matter gets an ask with a clear owner.",
      "Team asks launch next, then the public roadmap page.",
    ],
    // Legacy fields from a pre-#4984 published brief — count toward
    // roadmap-layout detection, never render.
    beforeAfter: {
      before: ["Manual chasing", "Ad-hoc asks", "No owner", "Slow follow-up", "Fifth bullet must not render"],
      after: ["Automated cadence", "Every matter asked", "Clear ownership"],
    },
    timeline: [
      { phase: "soon", title: "Roadmap page live", description: "Clients follow along weekly." },
      { phase: "now", title: "Velocity system beta", description: "Rolling out to pilot firms." },
      { phase: "next", title: "Team asks launch" },
    ],
    pullQuote: "Reviews are the new first impression.",
  };
  const view = makeView();
  view.ceoPulse.includeGraphs = false;
  view.ceoPulse.aiAnalysis = roadmapAnalysis as any;
  const html = renderToStaticMarkup(<CeoPulseSlide view={view} />);

  // Simplified template sections in order (kicker + supporting line live in
  // the headline banner; the letter CTA closes the slide). Task #4984: the
  // before/after and timeline bands are GONE from the chain.
  const chain = [
    'data-testid="text-roadmap-kicker"',
    'data-testid="text-supporting-line"',
    'data-testid="roadmap-snapshot"',
    'data-testid="roadmap-why"',
    'data-testid="roadmap-pull-quote"',
    'data-testid="link-full-letter-report"',
  ];
  let prev = -1;
  for (const needle of chain) {
    const idx = html.indexOf(needle);
    assert.ok(idx >= 0, `${needle} present on the deck twin`);
    assert.ok(idx > prev, `${needle} in template order`);
    prev = idx;
  }
  assert.ok(html.includes(ssrEscape(NOBULL_BRIEF_STRINGS.roadmapKicker)), "kicker copy from the strings module");
  assert.ok(html.includes("Because reviews decide who gets the first call."), "supporting line text");

  // Task #4984 — the removed bands stay removed even though the stored
  // analysis STILL carries beforeAfter/timeline (already-published briefs).
  assert.ok(!html.includes('data-testid="roadmap-before-after"'), "Before & After band deleted");
  assert.ok(!html.includes('data-testid="roadmap-timeline"'), "What's Coming Next band deleted");
  assert.ok(!html.includes("timeline-step-"), "no timeline steps in any variant");
  assert.ok(!html.includes("before-bullet-") && !html.includes("after-bullet-"), "no before/after bullet markup");
  assert.ok(!html.includes("Slow follow-up") && !html.includes("Every matter asked"), "legacy before/after content never rendered");
  assert.ok(!html.includes("Velocity system beta") && !html.includes(">Now<") && !html.includes(">Soon<"), "legacy timeline content never rendered");

  // Announcement layout replaced (and old stacked bullets absent).
  assert.ok(!html.includes('data-testid="initiative-card-0"'), "no announcement tiles on the roadmap twin");
  assert.ok(!html.includes('data-testid="commitment-0"'), "no commitment rows on the roadmap twin");
  assert.ok(!html.includes('data-testid="text-takeaway-0"'), "no stacked bullets on the roadmap twin");

  // Snapshot cards: icon map + padded-number fallback + status chip.
  assert.ok(html.includes('data-testid="snapshot-card-3"'), "all four snapshot cards render");
  assert.ok(html.includes('data-testid="snapshot-icon-0"'), "System category icon");
  assert.ok(html.includes('data-testid="snapshot-icon-1"'), "Education category icon");
  assert.ok(html.includes('data-testid="snapshot-number-2"'), "unknown category → number fallback");
  assert.ok(html.includes('data-testid="snapshot-category-2"'), "unknown category keeps its label");
  assert.ok(html.includes(">03<"), "padded number (03)");
  assert.ok(html.includes('data-testid="snapshot-number-3"'), "missing category → number fallback");
  assert.ok(html.includes('data-testid="snapshot-status-0"'), "status chip renders");
  assert.ok(!html.includes('data-testid="snapshot-status-1"'), "no chip without a status");

  // Why This Matters (Task #4984): lead + bullets when whyBullets exist —
  // the stored paragraphs are superseded, never rendered alongside.
  assert.ok(html.includes('data-testid="why-lead"'), "why lead renders");
  assert.ok(html.includes("Why paragraph one."), "lead = first stored paragraph");
  assert.ok(!html.includes("Why paragraph two."), "remaining paragraphs superseded by bullets");
  assert.ok(!html.includes('data-testid="why-paragraph-0"'), "no paragraph list when bullets exist");
  assert.ok(html.includes('data-testid="why-bullet-2"'), "all three bullets render");
  assert.ok(!html.includes('data-testid="why-bullet-3"'), "exactly the stored bullets, no padding");
  assert.ok(html.includes("Every closed matter gets an ask with a clear owner."), "bullet text renders");

  // Pull quote: serif on the crimson card.
  assert.ok(html.includes("font-report-serif"), "pull quote set in the serif face");
  assert.ok(html.includes("bg-report-crimson"), "pull quote rides the report crimson token");
  assert.ok(html.includes("Reviews are the new first impression."), "pull quote text");

  // Same report contract as (6)-(7): no stock hexes/classes, ≥11px type,
  // print-safe cards, report tokens in play.
  for (const hex of STOCK_HEXES) {
    assert.ok(!html.toLowerCase().includes(hex.toLowerCase()), `stock hex ${hex} leaked into the roadmap twin markup`);
  }
  for (const cls of STOCK_CLASSES) {
    assert.ok(!html.includes(cls), `stock class ${cls} leaked into the roadmap twin markup`);
  }
  for (const cls of ["text-[10px]", "text-[9px]", "text-[8px]"]) {
    assert.ok(!html.includes(cls), `sub-11px type (${cls}) in the roadmap twin markup`);
  }
  assert.ok(html.includes("break-inside-avoid"), "twin cards are print-safe");
  assert.ok(html.includes("text-report-ink"), "twin rides report ink tokens");
  assert.ok(html.includes("border-report-gold"), "snapshot status chip rides the report gold token");
  assert.ok(html.includes('data-testid="ceo-pulse-product-updates"'), "product updates block survives the twin");
  ok("roadmap deck twin: simplified section order, why lead+bullets, legacy bands absent, report contract holds");

  // Why card legacy fallback: same fixture minus whyBullets → bullet-less
  // (older) briefs keep the capped 3-paragraph rendering unchanged.
  const paragraphView = makeView();
  paragraphView.ceoPulse.includeGraphs = false;
  paragraphView.ceoPulse.aiAnalysis = { ...roadmapAnalysis, whyBullets: undefined } as any;
  const paragraphHtml = renderToStaticMarkup(<CeoPulseSlide view={paragraphView} />);
  assert.ok(paragraphHtml.includes('data-testid="why-paragraph-2"'), "three why paragraphs render on bullet-less rows");
  assert.ok(!paragraphHtml.includes('data-testid="why-paragraph-3"'), "why card still capped at 3 paragraphs");
  assert.ok(!paragraphHtml.includes("Why paragraph four must not render"), "over-cap paragraph text absent");
  assert.ok(
    !paragraphHtml.includes('data-testid="why-lead"') && !paragraphHtml.includes('data-testid="why-bullet-0"'),
    "no lead/bullet markup without whyBullets",
  );
  assert.ok(
    !paragraphHtml.includes('data-testid="roadmap-before-after"') && !paragraphHtml.includes('data-testid="roadmap-timeline"'),
    "legacy bands absent on the paragraph fallback too",
  );
  ok("why card legacy fallback: bullet-less rows keep the capped paragraph rendering");

  // Per-section omission: only a pull quote → template active, other
  // roadmap sections absent (never blank shells).
  const partialView = makeView();
  partialView.ceoPulse.includeGraphs = false;
  partialView.ceoPulse.aiAnalysis = {
    headline: "Only a pull quote this time",
    keyTakeaways: [{ highlight: "Single Initiative", detail: "One line." }],
    strategicImplications: [{ highlight: "One commitment", detail: "short." }],
    contextNarrative: ["Why paragraph."],
    byTheNumbers: [],
    charts: [],
    pullQuote: "One sentence still flips the twin.",
  } as any;
  const partial = renderToStaticMarkup(<CeoPulseSlide view={partialView} />);
  assert.ok(partial.includes('data-testid="roadmap-pull-quote"'), "pull quote renders");
  assert.ok(partial.includes('data-testid="roadmap-snapshot"'), "snapshot renders from keyTakeaways");
  assert.ok(!partial.includes('data-testid="text-supporting-line"'), "no supporting line without data");
  assert.ok(!partial.includes('data-testid="initiative-card-0"'), "announcement layout replaced");

  // Roadmap-free company update keeps the (7) announcement layout — the
  // legacy fallback is pinned against the SAME fixture minus roadmap fields
  // (whyBullets alone would keep the template active, so it goes too).
  const legacyView = makeView();
  legacyView.ceoPulse.includeGraphs = false;
  legacyView.ceoPulse.aiAnalysis = {
    ...roadmapAnalysis,
    supportingLine: undefined,
    whyBullets: undefined,
    beforeAfter: undefined,
    timeline: undefined,
    pullQuote: undefined,
    keyTakeaways: roadmapAnalysis.keyTakeaways.map(({ category: _c, ...rest }) => rest),
  } as any;
  const legacy = renderToStaticMarkup(<CeoPulseSlide view={legacyView} />);
  assert.ok(legacy.includes('data-testid="initiative-card-0"'), "roadmap-free rows keep the announcement tiles");
  assert.ok(!legacy.includes('data-testid="roadmap-snapshot"'), "no roadmap twin without roadmap fields");
  assert.ok(!legacy.includes('data-testid="text-roadmap-kicker"'), "no kicker without roadmap fields");

  // Market-shift ignores roadmap fields; charts-mode company updates too.
  const marketView = makeView();
  marketView.ceoPulse.includeGraphs = false;
  (marketView.ceoPulse as any).edition = "market_shift";
  marketView.ceoPulse.aiAnalysis = roadmapAnalysis as any;
  const market = renderToStaticMarkup(<CeoPulseSlide view={marketView} />);
  assert.ok(market.includes("Key Takeaways"), "market-shift keeps the stacked columns");
  assert.ok(!market.includes('data-testid="roadmap-snapshot"'), "market-shift: no roadmap twin");
  assert.ok(!market.includes('data-testid="text-roadmap-kicker"'), "market-shift: no kicker");
  assert.ok(!market.includes('data-testid="why-lead"'), "market-shift: no why lead/bullets");

  const chartsView = makeView();
  chartsView.ceoPulse.aiAnalysis = {
    ...roadmapAnalysis,
    charts: [chart({ title: "Search share", description: "Source: FPS. Prose." })],
  } as any;
  const chartsHtml = renderToStaticMarkup(<CeoPulseSlide view={chartsView} />);
  assert.ok(chartsHtml.includes('data-testid="chart-'), "charts-mode renders its charts");
  assert.ok(!chartsHtml.includes('data-testid="roadmap-snapshot"'), "charts-mode: no roadmap twin");
  assert.ok(!chartsHtml.includes('data-testid="text-roadmap-kicker"'), "charts-mode: no kicker");
  ok("roadmap twin omission + legacy fallback + market/charts controls hold");
}

console.log(`\nceo-pulse-slide-polish: ${passed} checks passed`);
