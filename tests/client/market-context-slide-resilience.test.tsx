/* test-registration
{
  "name": "Market Context slide resilience — no state exists where the slide's only content is an error card (query errors degrade to the labeled static industry-pattern chart), the slide + its agenda row drop when the report has no practice areas AND no embedded trends (deck numbering shifts up), the slide opens with a VerdictLine (stored copy wins, deterministic per-phase derivation otherwise, exact audit Soft sentence), estimated data carries an 'Industry Estimate' chip + caption instead of a false 'Google Trends' claim, and the slide vertically centers per §8.4 (Task #4277, §8.7-4, backlog #13/#25)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4277: fast (~2s), pure SSR + pure-function units — no DB, no jsdom, no network (fetch stubbed to throw; queries disabled on the public path). Pins the client-facing resilience contract no other suite renders: a regression here ships an error-card-only Market Context slide to paying clients, a dead agenda jump-link to a dropped slide, mislabeled 'Google Trends' provenance on estimated numbers, or a silently vanished §8.1 verdict line.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": ["client/src/pages/publicReport/MarketContextSlide.tsx", "client/src/pages/PublicReport.tsx"],
  "tier": "small"
}
test-registration */
/**
 * Task #4277 — Market Context slide resilience (audit §8.7-4 + backlog
 * #13/#25 + §8.4 dead space).
 *
 * Layer choice (test-economics L1): the contract is markup shape + pure
 * decision rules, so this suite runs at the cheapest sufficient layer —
 * react-dom/server static markup plus direct unit calls. No jsdom, no DB,
 * no network. Existing coverage this does NOT duplicate:
 *   - webinar-footnote-print-mode.test.tsx pins the print footnote system;
 *   - ceo-pulse-slide-polish.test.tsx pins the NoBull Brief slide;
 *   - slide-verdict suites pin the shared verdict store/schema, not this
 *     slide's adoption of it.
 *
 * What this suite uniquely pins:
 *   (1) resolveMarketContextRenderState — the render-state machine has NO
 *       error state by construction: real data, a transient loading card
 *       (screen only, never print), or the labeled "estimated" fallback.
 *   (2) hasMarketContextData + computeSlideNumbers — the drop-the-slide
 *       predicate and the deck renumbering that absorbs the gap.
 *   (3) deriveMarketContextVerdict — deterministic phase → sentence map,
 *       including the audit's exact Soft sentence.
 *   (4) Rendered slide: populated (Google Trends provenance, portfolio tab),
 *       estimated (Industry Estimate chip + caption, full content — chart,
 *       analysis rail, Strategic Response Plan — never a bare notice),
 *       stored-verdict-beats-derived, loading (internal view) suppresses the
 *       derived verdict, print mode never shows the loading card, and the
 *       retired error-card copy is gone from the module source.
 *   (5) AgendaSlide: the market-context row exists exactly when the slide
 *       does (no dead jump links).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  MarketContextSlide,
  deriveMarketContextVerdict,
  hasMarketContextData,
  resolveMarketContextRenderState,
  type MarketContextRenderState,
} from "../../client/src/pages/publicReport/MarketContextSlide";
import { AgendaSlide } from "../../client/src/pages/publicReport/AgendaSlide";
import { computeSlideNumbers } from "../../client/src/pages/publicReport/sections";
import type {
  PracticeAreaTrend,
  TrendsResponse,
} from "../../client/src/pages/publicReport/types";

// Harness-agnostic JSX-runtime shim: under a bare `npx tsx <file>` invocation
// the root tsconfig compiles JSX with the CLASSIC runtime (React.createElement)
// while the component modules carry no React import of their own. Bind React
// globally BEFORE the first render so this suite behaves identically under
// the registered runner (tsconfig.tests.json → automatic runtime), the
// batched worker, and bare tsx.
(globalThis as { React?: typeof React }).React = React;

// Hermeticity: nothing in this suite may touch the network. SSR never runs
// query effects, so this stub existing is belt-and-braces — if a code change
// ever makes a render fetch, the suite fails loudly instead of hitting a
// live endpoint.
(globalThis as { fetch?: typeof fetch }).fetch = (async () => {
  throw new Error("network disabled in market-context-slide-resilience test");
}) as unknown as typeof fetch;

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

const RETIRED_ERROR_COPY = "Unable to load live trend data";

// ---------------------------------------------------------------------------
// (1) Render-state machine: no error state can exist
// ---------------------------------------------------------------------------

{
  const states = new Set<MarketContextRenderState>();
  for (const hasTrendData of [true, false]) {
    for (const isLoading of [true, false]) {
      for (const isPrinting of [true, false]) {
        states.add(resolveMarketContextRenderState({ hasTrendData, isLoading, isPrinting }));
      }
    }
  }
  assert.deepEqual(
    [...states].sort(),
    ["data", "estimated", "loading"],
    "the full input space maps to exactly {data, estimated, loading} — no error state exists",
  );
  ok("render-state machine has no error state across the full input space");

  // Real data always wins, even mid-refetch or in print.
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: true, isLoading: true, isPrinting: false }),
    "data",
  );
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: true, isLoading: false, isPrinting: true }),
    "data",
  );
  ok("hasTrendData → data regardless of loading/printing");

  // Loading card is screen-only and transient.
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: false, isLoading: true, isPrinting: false }),
    "loading",
  );
  // Print never waits and never blanks: straight to the static fallback.
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: false, isLoading: true, isPrinting: true }),
    "estimated",
  );
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: false, isLoading: false, isPrinting: false }),
    "estimated",
  );
  assert.equal(
    resolveMarketContextRenderState({ hasTrendData: false, isLoading: false, isPrinting: true }),
    "estimated",
  );
  ok("no data → loading only while a screen fetch is in flight, estimated otherwise (print always estimated)");
}

// ---------------------------------------------------------------------------
// (2) Drop predicate + deck renumbering
// ---------------------------------------------------------------------------

{
  assert.equal(hasMarketContextData([], null), false);
  assert.equal(hasMarketContextData(undefined, undefined), false);
  assert.equal(hasMarketContextData(null, { practiceAreas: [] }), false);
  assert.equal(hasMarketContextData([], { practiceAreas: null }), false);
  assert.equal(hasMarketContextData(["Personal Injury"], null), true);
  assert.equal(hasMarketContextData(["Personal Injury"], undefined), true);
  // Embedded trends alone keep the slide even when the client record has no
  // practice areas (the embed is a snapshot of a market that existed).
  assert.equal(hasMarketContextData([], { practiceAreas: [{}] }), true);
  ok("hasMarketContextData: true iff practice areas OR embedded trend series exist");
}

{
  const full = computeSlideNumbers({ hasCeoPulse: true, hasMarketContext: true });
  assert.equal(full.ceoPulse, 3);
  assert.equal(full.marketContext, 4);
  assert.equal(full.engineHealth, 5);
  assert.equal(full.next30, 11);
  assert.equal(full.bookPromo, 12, "book promo closes the deck as the colophon (Task #4284)");
  ok("both conditional slides present → contiguous 1..12 numbering, colophon last");

  const dropped = computeSlideNumbers({ hasCeoPulse: true, hasMarketContext: false });
  assert.equal(dropped.marketContext, 0, "dropped slide gets 0, not a stale number");
  assert.equal(dropped.engineHealth, 4, "later slides shift up — no numbering gap");
  assert.equal(dropped.next30, 10);
  assert.equal(dropped.bookPromo, 11);
  ok("market context dropped → 0 for the slide, every later slide shifts up");

  const neither = computeSlideNumbers({ hasCeoPulse: false, hasMarketContext: false });
  assert.equal(neither.ceoPulse, 0);
  assert.equal(neither.marketContext, 0);
  assert.equal(neither.engineHealth, 3);
  assert.equal(neither.next30, 9);
  assert.equal(neither.bookPromo, 10);
  assert.equal(neither.title, 1);
  assert.equal(neither.roadmap, 2);
  ok("both conditional slides dropped → deck compacts to 1..10");
}

// ---------------------------------------------------------------------------
// (3) Verdict derivation
// ---------------------------------------------------------------------------

{
  // The audit's exact example sentence (§8.7-4) — pinned verbatim.
  assert.equal(
    deriveMarketContextVerdict("Soft"),
    "Demand is in a seasonal Soft phase — the move is intake, not spend.",
  );
  ok("Soft phase derives the exact audit verdict sentence");

  const phases = ["Peak", "Hold", "Taper", "Soft", "Rebuild"];
  const sentences = phases.map(deriveMarketContextVerdict);
  assert.equal(new Set(sentences).size, phases.length, "each phase gets a distinct sentence");
  for (const s of sentences) {
    assert.ok(s.startsWith("Demand is"), `verdicts share the 'Demand is …' pattern: ${s}`);
    assert.ok(s.includes("the move is"), `verdicts name the move: ${s}`);
  }
  const fallbackSentence = deriveMarketContextVerdict("SomethingUnknown");
  assert.ok(fallbackSentence.length > 20, "unknown phases still produce a real sentence");
  ok("every phase (and the unknown fallback) derives a distinct 'Demand is … — the move is …' sentence");
}

// ---------------------------------------------------------------------------
// SSR fixtures + render helper
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOW_MONTH = new Date().getMonth();

/** All-"Soft" trend: makes the derived verdict clock-proof for the populated
 *  fixture (whatever month the suite runs in, the current phase is Soft). */
function softTrend(practiceArea: string, searchTerm: string): PracticeAreaTrend {
  return {
    practiceArea,
    searchTerm,
    data: MONTHS.map((month, i) => ({
      month,
      value: 40 + i,
      isCurrent: i === NOW_MONTH,
      phase: "Soft",
    })),
  };
}

function makeTrends(over: Partial<TrendsResponse> = {}): TrendsResponse {
  const pi = softTrend("Personal Injury", "personal injury lawyer near me");
  const fam = softTrend("Family Law", "family lawyer near me");
  return {
    practiceAreas: [pi, fam],
    combined: softTrend("Portfolio", "combined demand"),
    currentMonth: MONTHS[NOW_MONTH],
    currentMonthIndex: NOW_MONTH,
    aiAnalysis: {
      "Personal Injury": {
        currentPosition: ["Search volume held its seasonal floor."],
        demandShapeAhead: ["Expect a slow climb into spring."],
      },
    },
    source: "google-trends",
    ...over,
  };
}

function renderSlide(props: Partial<Parameters<typeof MarketContextSlide>[0]> = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MarketContextSlide
        slideNumber={4}
        practiceAreas={["Personal Injury"]}
        isPublicView={true}
        {...props}
      />
    </QueryClientProvider>,
  );
}

const verdictTextOf = (html: string): string | null =>
  html.match(/data-testid="text-verdict-marketContext"[^>]*>([^<]*)</)?.[1] ?? null;

// ---------------------------------------------------------------------------
// (4a) Populated: embedded multi-area trends on the public view
// ---------------------------------------------------------------------------

{
  const html = renderSlide({
    practiceAreas: ["Personal Injury", "Family Law"],
    embeddedTrends: makeTrends(),
  });

  assert.ok(html.includes("Google Trends"), "real data carries Google Trends provenance");
  assert.ok(!html.includes("Industry Estimate"), "no estimate chip on real data");
  assert.ok(
    !html.includes("text-market-context-estimated-note"),
    "no estimate caption on real data",
  );
  ok("populated slide keeps Google Trends provenance, no estimate labeling");

  assert.ok(
    html.includes("Portfolio Demand Position"),
    "multi-area default tab is the portfolio view",
  );
  assert.ok(html.includes("Strategic Response Plan"), "response-plan band renders");
  ok("populated slide renders full content (portfolio tab + response plan)");

  assert.equal(
    verdictTextOf(html),
    ssrEscape("Demand is in a seasonal Soft phase — the move is intake, not spend."),
    "all-Soft fixture derives the audit verdict via the shared VerdictLine primitive",
  );
  assert.ok(html.includes("report-verdict"), "verdict renders via the shared primitive's class");
  ok("verdict line renders (derived from the portfolio trend's current phase)");

  assert.ok(html.includes("slide-vcenter"), "§8.4 — slide vertically centers its content");
  ok("slide adopts vCenter (§8.4 dead-space fix)");

  assert.ok(!html.includes(RETIRED_ERROR_COPY));
  assert.ok(!html.includes("Loading trend data"));
  ok("populated slide shows neither error nor loading chrome");
}

// ---------------------------------------------------------------------------
// (4b) Estimated: no embedded trends on the public view → labeled fallback
// ---------------------------------------------------------------------------

{
  const html = renderSlide({ embeddedTrends: null });

  assert.ok(html.includes("Industry Estimate"), "estimate chip replaces the source claim");
  assert.ok(!html.includes("Google Trends"), "no false Google Trends claim on estimated data");
  assert.ok(
    html.includes('data-testid="text-market-context-estimated-note"'),
    "estimate caption renders",
  );
  ok("estimated slide is explicitly labeled (chip + caption), never claims Google Trends");

  assert.ok(
    html.includes(ssrEscape("Search Demand: Personal Injury")),
    "fallback chart is named after the client's practice area",
  );
  assert.ok(html.includes("Strategic Response Plan"), "full content renders — not a bare notice");
  assert.ok(!html.includes(RETIRED_ERROR_COPY), "retired error card copy is gone");
  assert.ok(!html.includes("Loading trend data"), "no loading card on the public path");
  ok("estimated slide renders the full static chart + response plan (no error card, no dead notice)");

  // Derived verdict follows the fallback curve's phase for the CURRENT month.
  // Recompute the expectation independently (same index rule the fallback
  // curve uses) — never hardcode a month-dependent phase.
  const expectedPhase =
    NOW_MONTH <= 2 ? "Hold" : NOW_MONTH <= 5 ? "Taper" : NOW_MONTH <= 7 ? "Soft" : "Rebuild";
  assert.equal(
    verdictTextOf(html),
    ssrEscape(deriveMarketContextVerdict(expectedPhase)),
    "derived verdict tracks the fallback curve's current-month phase",
  );
  ok("estimated slide derives its verdict from the fallback curve (clock-derived expectation)");
}

// ---------------------------------------------------------------------------
// (4c) Stored verdict beats derivation; whitespace-only falls back
// ---------------------------------------------------------------------------

{
  const stored = "Intake demand is softening across the portfolio — hold spend, tighten follow-up.";
  const html = renderSlide({
    practiceAreas: ["Personal Injury", "Family Law"],
    embeddedTrends: makeTrends(),
    verdict: stored,
  });
  assert.equal(verdictTextOf(html), ssrEscape(stored), "stored verdict wins over derivation");
  assert.ok(
    !html.includes(ssrEscape("the move is intake, not spend.")),
    "derived sentence does not double-render",
  );
  ok("stored verdict (data.slideVerdicts.marketContext) wins over the derived sentence");

  const blank = renderSlide({ embeddedTrends: makeTrends(), verdict: "   " });
  assert.ok(
    verdictTextOf(blank)?.startsWith("Demand is"),
    "whitespace-only stored verdict falls back to derivation",
  );
  ok("whitespace-only stored verdict falls back to the derived sentence");
}

// ---------------------------------------------------------------------------
// (4d) Internal (non-public) view: loading card while the query is in
// flight; print mode never waits; embedded analysis skips the fetch
// ---------------------------------------------------------------------------

{
  // isPublicView=false enables the trends query; in SSR react-query reports
  // the optimistic first-render state (pending + about-to-fetch), so the
  // slide shows its transient loading card — with the derived verdict
  // suppressed (no phase guess before data lands).
  const html = renderSlide({ isPublicView: false, embeddedTrends: null });
  assert.ok(html.includes("Loading trend data"), "internal view shows the loading card in-flight");
  assert.ok(html.includes("print:hidden"), "loading card is screen-only");
  assert.equal(verdictTextOf(html), null, "no derived verdict while loading (no phase guess)");
  assert.ok(!html.includes(RETIRED_ERROR_COPY));
  ok("internal view in-flight: loading card (screen-only), verdict suppressed, no error card");

  // Print mode: never wait, never blank — straight to the labeled estimate.
  const printHtml = renderSlide({
    isPublicView: false,
    embeddedTrends: null,
    isPrintMode: true,
  });
  assert.ok(!printHtml.includes("Loading trend data"), "print never shows the loading card");
  assert.ok(printHtml.includes("Industry Estimate"), "print falls through to the labeled estimate");
  assert.ok(printHtml.includes("Strategic Response Plan"));
  ok("print mode skips loading and renders the full labeled fallback");

  // Embedded trends WITH aiAnalysis disable the fetch entirely on internal
  // views — real content, no loading flash.
  const embedded = renderSlide({
    isPublicView: false,
    practiceAreas: ["Personal Injury", "Family Law"],
    embeddedTrends: makeTrends(),
  });
  assert.ok(!embedded.includes("Loading trend data"));
  assert.ok(embedded.includes("Google Trends"));
  ok("internal view with embedded analysis renders data immediately (query disabled)");
}

// ---------------------------------------------------------------------------
// (5) AgendaSlide: market-context row exists exactly when the slide does
// ---------------------------------------------------------------------------

function renderAgenda(hasMarketContext: boolean): string {
  const view = {
    prefersReducedMotion: true,
    hasCeoPulse: true,
    hasMarketContext,
    slideNumbers: computeSlideNumbers({ hasCeoPulse: true, hasMarketContext }),
  } as unknown as Parameters<typeof AgendaSlide>[0]["view"];
  return renderToStaticMarkup(<AgendaSlide view={view} />);
}

{
  const withRow = renderAgenda(true);
  assert.ok(
    withRow.includes('data-testid="link-agenda-market-context"'),
    "agenda offers the market-context jump when the slide exists",
  );

  const withoutRow = renderAgenda(false);
  assert.ok(
    !withoutRow.includes('data-testid="link-agenda-market-context"'),
    "agenda drops the market-context row when the slide is dropped",
  );
  assert.ok(
    withoutRow.includes('data-testid="link-agenda-engine-health"'),
    "other agenda rows survive the drop",
  );
  ok("agenda row exists exactly when the slide does (no dead jump links)");
}

// ---------------------------------------------------------------------------
// (6) Source scan: the retired error card cannot come back silently
// ---------------------------------------------------------------------------

{
  const source = readFileSync("client/src/pages/publicReport/MarketContextSlide.tsx", "utf8");
  assert.ok(
    !source.includes(RETIRED_ERROR_COPY),
    "the retired error-card copy must not reappear in MarketContextSlide",
  );
  assert.ok(
    source.includes("resolveMarketContextRenderState({ hasTrendData, isLoading, isPrinting })"),
    "the component routes rendering through the no-error-state machine",
  );
  const publicReport = readFileSync("client/src/pages/PublicReport.tsx", "utf8");
  assert.ok(
    publicReport.includes("hasMarketContext && ("),
    "PublicReport renders the slide conditionally on the drop predicate",
  );
  ok("source scan: error card retired; render routed through the state machine; deck render gated");
}

console.log(`\nmarket-context-slide-resilience: ${passed} checks passed`);
