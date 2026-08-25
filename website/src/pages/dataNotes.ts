// /data-notes/ — versioned definitions, formulas, and provenance.
//
// The book's final editorial review directs: "publish your samples and
// definitions when you make claims." This page is that appendix target —
// versioned so the printed book's QR readers and calculator users can hold
// the site to its own definitions, and so future benchmark publications
// have a place to version their samples BEFORE any benchmark claim ships.
// As of v1.1 no benchmarks exist and none are published (review defers
// them until real data exists) — the page says so explicitly.
//
// Content rules:
//   • Definitions/formulas mirror website/src/calc-client/math.ts exactly.
//   • The published-figures table is seeded ONLY from claims the site
//     already publishes, via website/src/proof.ts (the ledger's LIVE rows) —
//     no new claims. Basis wording follows the ledger: single-firm tracked
//     results are never averages; models are labeled ILLUSTRATIVE MODEL.
//   • Linked from the calculator footer; deliberately not in the main nav
//     (an appendix, not a destination).

import { PageDef, titleBand } from "../html";
import {
  ACCELERATOR_8X,
  BURNS_SMITH,
  CLIENTS,
  CONSULT_TO_CASE,
  EXPANSION,
  FOUNDATION_2X,
  GAP_MODEL,
  LEADS_GENERATED,
  LEADS_REVIEWED,
  LEAD_TO_CONSULT,
  PRESTI,
  REVIEWS_GENERATED,
} from "../proof";

const VERSION = "1.1";
const PUBLISHED = "August 19, 2026";

interface Definition {
  term: string;
  formula: string | null;
  note: string;
}

const DEFINITIONS: Definition[] = [
  {
    term: "Revenue Engine Efficiency (REE)",
    formula: "Revenue for the selected period \u00f7 Total investment for the selected period",
    note: "The score: how many dollars of top-line revenue the engine produces for every $1 invested during the same reporting period. The 3-, 6-, or 12-month choice labels the totals you enter; it does not annualize or extrapolate them.",
  },
  {
    term: "Total investment",
    formula: null,
    note: "The acquisition and conversion costs counted for the selected period, including ad spend, agency fees, and intake or sales staff costs. Count the same categories every period so comparisons stay meaningful.",
  },
  {
    term: "Actual revenue basis",
    formula: "Revenue generated entered for the selected period",
    note: "Choose this basis when you can enter the top-line revenue attributable to the same reporting period. The calculator labels the result Actual revenue.",
  },
  {
    term: "Estimated revenue basis",
    formula: "Cases \u00d7 Estimated case value",
    note: "Choose this basis when you do not have an attributable revenue total. The calculator multiplies the cases entered by your estimated case value and labels the result Estimated revenue.",
  },
  {
    term: "Cost per Lead (CPL)",
    formula: "Total investment \u00f7 leads",
    note: "What one lead costs during the selected period.",
  },
  {
    term: "Lead-to-Consult rate",
    formula: "Consults \u00f7 leads",
    note: "The share of leads that become consults during the selected period.",
  },
  {
    term: "Consult-to-Case rate",
    formula: "Cases \u00f7 consults",
    note: "The share of consults that become cases during the selected period.",
  },
  {
    term: "Lead-to-Case rate",
    formula: "Cases \u00f7 leads",
    note: "The whole funnel in one number: the share of leads that become cases.",
  },
  {
    term: "Cost per Case",
    formula: "Total investment \u00f7 cases",
    note: "What one case costs, all-in, during the selected period. It is unavailable when no cases are entered.",
  },
  {
    term: "Revenue per Case",
    formula: "Actual revenue \u00f7 cases, or the entered Estimated case value",
    note: "The actual basis derives this figure when at least one case is entered. The estimated basis uses the value you enter directly.",
  },
];

const SENSITIVITY_SCENARIOS: { lever: string; formula: string }[] = [
  { lever: "More leads (+10%)", formula: "additional leads \u00d7 Lead-to-Case rate \u00d7 Revenue per Case" },
  { lever: "Lead-to-Consult rate (+10% relative)", formula: "additional consults \u00d7 Consult-to-Case rate \u00d7 Revenue per Case" },
  { lever: "Consult-to-Case rate (+10% relative)", formula: "additional cases \u00d7 Revenue per Case" },
  { lever: "Revenue per Case (+10%)", formula: "cases \u00d7 the increase in Revenue per Case" },
];

interface FigureRow {
  figure: string;
  what: string;
  basis: string;
}

function publishedFigures(): FigureRow[] {
  return [
    {
      figure: `${CLIENTS.stat} ${CLIENTS.label}`,
      what: "Client firms the system has been built and proven across",
      basis: "Client-approved aggregate (sales materials, July 2026)",
    },
    {
      figure: `${LEADS_GENERATED.stat} ${LEADS_GENERATED.label}`,
      what: "All-time leads generated across client firms",
      basis: "Owner-confirmed aggregate, August 2026",
    },
    {
      figure: `${REVIEWS_GENERATED.stat} ${REVIEWS_GENERATED.label}`,
      what: "All-time five-star reviews generated for client firms",
      basis: "Owner-confirmed aggregate, August 2026",
    },
    {
      figure: `${LEADS_REVIEWED.stat} ${LEADS_REVIEWED.label}`,
      what: "Yearly lead-review volume \u2014 an operations-scale figure, not a client result",
      basis: "Client-approved operations figure (sales materials, July 2026)",
    },
    {
      figure: `${FOUNDATION_2X.stat} lead growth in ${FOUNDATION_2X.window}`,
      what: "One client's tracked result after Local Authority Optimization",
      basis: "Single-client tracked result \u2014 never an average or a promise",
    },
    {
      figure: `${ACCELERATOR_8X.stat} lead growth in ${ACCELERATOR_8X.window}`,
      what: "One client's tracked paid-search result (a lead multiple \u2014 not the same quantity as an 8\u00d7 REE)",
      basis: "Single-client tracked result \u2014 never an average or a promise",
    },
    {
      figure: `Lead-to-Consult ${LEAD_TO_CONSULT.before} \u2192 ${LEAD_TO_CONSULT.after}`,
      what: "One client's tracked intake result \u2014 same lead flow, nearly twice the consultations",
      basis: "Single-client tracked result \u2014 never an average or a promise",
    },
    {
      figure: `Consult-to-Case ${CONSULT_TO_CASE.before} \u2192 ${CONSULT_TO_CASE.after}`,
      what: "One client's tracked sales result",
      basis: "Single-client tracked result \u2014 never an average or a promise",
    },
    {
      figure: PRESTI.headline,
      what: `${PRESTI.firm} \u2014 one firm's tracked results`,
      basis: "Single-firm tracked result, client-approved",
    },
    {
      figure: BURNS_SMITH.headline,
      what: `${BURNS_SMITH.firm} \u2014 one firm's tracked five-month lead growth`,
      basis: "Single-firm tracked result, client-approved",
    },
    {
      figure: EXPANSION.headline,
      what: "One multi-location client engagement (firm unnamed in our materials)",
      basis: "Single-client tracked result, client-approved",
    },
    {
      figure: `The ${GAP_MODEL.gap} gap (${GAP_MODEL.leads} leads, ${GAP_MODEL.leaky.revenue} vs ${GAP_MODEL.tuned.revenue})`,
      what: "The homepage's two-firm funnel walk-through",
      basis: "ILLUSTRATIVE MODEL \u2014 hypothetical arithmetic, not a client result",
    },
    // ($1 in → $8 out (an 8× REE) example row removed by Task #4925: the
    // homepage REE strip retired its example line, so the figure renders
    // nowhere on the site — ledger #38 WITHHELD. Re-add the row only if a
    // labeled surface returns.)
  ];
}

export function dataNotesPage(): PageDef {
  return {
    path: "data-notes/",
    title: "Data Notes & Definitions (v" + VERSION + ") | NoBull Marketing",
    desc:
      "The definitions, formulas, and provenance behind the numbers NoBull Marketing publishes \u2014 including the REE calculator's math \u2014 versioned so you can hold us to them. No practice-area benchmarks are published as of v" +
      VERSION +
      ".",
    priority: "0.3",
    render: (r) => `
${titleBand(
  "Data Notes &amp; Definitions",
  "The definitions, formulas, and provenance behind every number this site publishes \u2014 versioned, so you can hold us to them.",
  { eyebrow: "APPENDIX" },
)}

<section class="dn-sec">
  <div class="container dn-wrap">

    <p class="dn-meta">Version ${VERSION} \u00b7 Published ${PUBLISHED} \u00b7 Companion to the <a href="${r}calculator/">REE calculator</a></p>

    <div class="dn-block">
      <h2>What this page is</h2>
      <p>When we publish a number \u2014 on this site, in the book, or in the <a href="${r}calculator/">REE calculator</a> \u2014 this page records what that number means, how it's computed, and what kind of evidence sits behind it. Each revision is versioned below, so a figure you read today can be checked against the definitions that were in force when it was published.</p>
      <p><strong>As of v${VERSION}, NoBull publishes no practice-area benchmarks, medians, or top-quartile comparisons.</strong> The calculator prices your levers against your own numbers only. If benchmarks are ever published, their samples and definitions will be versioned on this page first.</p>
    </div>

    <div class="dn-block">
      <h2>Definitions &amp; formulas</h2>
      <dl class="dn-defs">
${DEFINITIONS.map(
  (d) => `        <div class="dn-def">
          <dt>${d.term}</dt>
          <dd>${d.formula ? `<span class="dn-formula">${d.formula}</span>` : ""}${d.note}</dd>
        </div>`,
).join("\n")}
      </dl>
    </div>

    <div class="dn-block">
      <h2>How the 10% improvement values work</h2>
      <p>The calculator improves one available direct lever at a time by 10%, holds every other input unchanged, and prices the additional top-line revenue for the selected period. Rate improvements are relative: a 40% rate becomes 44%, not 50%.</p>
      <ul class="dn-list">
${SENSITIVITY_SCENARIOS.map((s) => `        <li><strong>${s.lever}:</strong> ${s.formula}</li>`).join("\n")}
      </ul>
      <p>Rates stop at 100%, so a rate near that ceiling may receive less than the full lift. A scenario is unavailable when the entered totals cannot support its math, such as actual revenue with no cases to derive Revenue per Case. Values stay in direct funnel order. The output is your arithmetic, never a grade: the calculator makes no judgment about whether a metric is good or bad, and it compares you to no one.</p>
    </div>

    <div class="dn-block">
      <h2>Results disclaimer</h2>
      <p>No result shown on this site is guaranteed for any individual firm. Outcomes vary based on the firm, its market, practice area, and other relevant circumstances.</p>
    </div>

    <div class="dn-block">
      <h2>The numbers this site publishes</h2>
      <p>Every figure below already appears on this site; this table records what kind of number each one is. Single-firm results are that firm's tracked outcome \u2014 never an average, never a promise of yours. Aggregates are owner-confirmed all-time totals. Models are hypothetical arithmetic, labeled as such wherever they render.</p>
      <div class="dn-table-wrap dn-table-wide">
        <table class="dn-table">
          <thead><tr><th scope="col">Figure</th><th scope="col">What it is</th><th scope="col">Basis</th></tr></thead>
          <tbody>
${publishedFigures()
  .map((f) => `            <tr><td>${f.figure}</td><td>${f.what}</td><td>${f.basis}</td></tr>`)
  .join("\n")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="dn-block">
      <h2>Version history</h2>
      <ul class="dn-list">
        <li><strong>v${VERSION} \u2014 ${PUBLISHED}.</strong> Reconciled to the live period-based calculator: actual or estimated revenue, direct funnel metrics, four available 10% improvement values, and the existing provenance table. No benchmarks published.</li>
        <li><strong>v1.0 \u2014 August 9, 2026.</strong> First publication of the definitions and provenance appendix. Its calculator methodology was superseded by v${VERSION}.</li>
      </ul>
    </div>

  </div>
</section>`,
  };
}
