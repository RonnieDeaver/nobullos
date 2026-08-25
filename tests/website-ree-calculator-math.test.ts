/* test-registration
{
  "name": "REE calculator math + CTA-ladder wiring — the pure period model behind /calculator/ validates one 3-, 6-, or 12-month funnel, computes direct REE/economics/rates, prices four unranked 10%-relative improvements, and keeps the concise booking handoff plus committed CTA ladder aligned",
  "regression": true,
  "smoke": true,
  "smokeReason": "Published revenue math: /calculator/ shows real law firms a dollars-per-dollar score and the dollar value of four direct 10% improvements with NoBull's name on it, and /data-notes/ publishes the legacy methodology appendix (claim ledger #39/#40) — a silent formula regression would misstate money to prospects sitewide. This suite is also the only automated gate on the review-verbatim headline/handoff templates and on the CTA-ladder wiring in the committed bundle. Pure math + committed-file string asserts; no DB, no network.",
  "timeoutMs": 120000,
  "scanPaths": ["website/public", "website/src/client-shared/reeHandoff.ts"],
  "tier": "small"
}
test-registration */
/**
 * Unit + wiring coverage for the REE calculator:
 *
 *   math      website/src/calc-client/math.ts — parseNumericInput,
 *             validateCalcInputs (period, money, and monotonic funnel),
 *             computeCalc (direct metrics and four unranked scenarios), and
 *             the shared number formatters.
 *
 *   handoff   website/src/client-shared/reeHandoff.ts — the period, REE, and
 *             actual/estimated revenue-basis query round-trip plus the
 *             booking-form message composer.
 *
 *   wiring    committed website/public output — the calculator page ships
 *             the simplified form + result copy, /data-notes/ publishes the
 *             matching live methodology, and every contextual soft-CTA
 *             surface links /calculator/.
 *
 * Period selection is a label/scope only. The arithmetic never annualizes or
 * extrapolates, and scenarios remain in stable funnel order rather than
 * naming a winner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CalcInputDraft,
  CalcInputs,
  SCENARIO_IDS,
  computeCalc,
  fmtPct,
  fmtUSD0,
  fmtUSD2,
  fmtX,
  headlineSentence,
  parseNumericInput,
  validateCalcInputs,
} from "../website/src/calc-client/math";
import {
  buildReeHandoffQuery,
  composeReeInquiryMessage,
  parseReeHandoffParams,
} from "../website/src/client-shared/reeHandoff";

const close = (actual: number, expected: number, tol = 1e-9): void => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} ≈ ${expected} (±${tol})`,
  );
};

/** Baseline complete funnel for the simplified model. */
const simpleInputs = (over: Partial<CalcInputs> = {}): CalcInputs =>
  ({
    periodMonths: 3,
    totalInvestment: 20000,
    leads: 100,
    consults: 40,
    cases: 10,
    revenueBasis: "estimated",
    revenueGenerated: null,
    estimatedCaseValue: 11600,
    ...over,
  }) as CalcInputs;

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

test("parseNumericInput: money/count strings parse loosely, junk is NaN, empty is null", () => {
  assert.equal(parseNumericInput("$25,000"), 25000);
  assert.equal(parseNumericInput("$11,600.50"), 11600.5);
  assert.equal(parseNumericInput(" 1 200 "), 1200);
  assert.equal(parseNumericInput("0.5"), 0.5);
  assert.equal(parseNumericInput(""), null);
  assert.equal(parseNumericInput("   "), null);
  assert.ok(Number.isNaN(parseNumericInput("abc")!));
  assert.ok(Number.isNaN(parseNumericInput("1.2.3")!));
  assert.ok(Number.isNaN(parseNumericInput("-5")!));
});

const validDraft: CalcInputDraft = {
  periodMonths: 3,
  totalInvestment: 20000,
  leads: 100,
  consults: 40,
  cases: 10,
  revenueBasis: "estimated",
  revenueGenerated: null,
  estimatedCaseValue: 11600,
};

test("validateCalcInputs: accepts exactly one revenue basis and returns short field errors", () => {
  assert.deepEqual(validateCalcInputs(validDraft), []);
  assert.deepEqual(
    validateCalcInputs({
      ...validDraft,
      revenueBasis: "generated",
      revenueGenerated: 116000,
      estimatedCaseValue: null,
    }),
    [],
  );

  const fields = (over: Partial<CalcInputDraft>): string[] =>
    validateCalcInputs({ ...validDraft, ...over }).map((issue) => issue.field);

  assert.deepEqual(fields({ periodMonths: 9 }), ["periodMonths"]);
  assert.deepEqual(fields({ totalInvestment: 0 }), ["totalInvestment"]);
  assert.deepEqual(fields({ totalInvestment: -1 }), ["totalInvestment"]);
  assert.deepEqual(fields({ totalInvestment: Number.POSITIVE_INFINITY }), ["totalInvestment"]);
  assert.deepEqual(fields({ leads: 1.5 }), ["leads"]);
  assert.deepEqual(fields({ consults: -1 }), ["consults"]);
  assert.deepEqual(fields({ cases: 2.5 }), ["cases"]);
  assert.deepEqual(fields({ estimatedCaseValue: -1 }), ["estimatedCaseValue"]);
  assert.deepEqual(fields({ estimatedCaseValue: null }), ["estimatedCaseValue"]);
  assert.deepEqual(fields({ revenueGenerated: 1 }), ["revenueGenerated"]);
  assert.deepEqual(
    fields({
      revenueBasis: "generated",
      revenueGenerated: null,
      estimatedCaseValue: null,
    }),
    ["revenueGenerated"],
  );
});

test("validateCalcInputs: enforces leads ≥ consults ≥ cases without cascading noise", () => {
  const messages = (over: Partial<CalcInputDraft>): string =>
    validateCalcInputs({ ...validDraft, ...over })
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join(" | ");

  assert.match(messages({ consults: 101 }), /^consults: Consults can't exceed leads\.$/);
  assert.match(messages({ cases: 41 }), /^cases: Cases can't exceed consults\.$/);
  assert.deepEqual(
    validateCalcInputs({ ...validDraft, consults: -1, cases: 10 }).map(
      (issue) => issue.field,
    ),
    ["consults"],
  );
});

// ---------------------------------------------------------------------------
// Period model and scenarios
// ---------------------------------------------------------------------------

test("computeCalc: estimated case value produces the direct period economics", () => {
  const result = computeCalc(simpleInputs());

  assert.equal(result.periodMonths, 3);
  assert.equal(result.periodLabel, "3-month totals");
  assert.equal(result.revenueBasis, "estimated");
  assert.equal(result.confidence, "estimated");
  assert.equal(result.metrics.revenue, 116000);
  close(result.ree, 5.8);
  close(result.metrics.costPerLead, 200);
  close(result.metrics.costPerCase!, 2000);
  close(result.metrics.leadToConsult, 0.4);
  close(result.metrics.consultToCase!, 0.25);
  close(result.metrics.leadToCase, 0.1);
  close(result.metrics.revenuePerCase!, 11600);
});

test("computeCalc: generated revenue uses the entered total and derives revenue per case", () => {
  const result = computeCalc(
    simpleInputs({
      revenueBasis: "generated",
      revenueGenerated: 100000,
      estimatedCaseValue: null,
    }),
  );

  assert.equal(result.metrics.revenue, 100000);
  close(result.ree, 5);
  close(result.metrics.revenuePerCase!, 10000);
  assert.equal(result.revenueBasis, "generated");
  assert.equal(result.confidence, "actual");
});

test("3-, 6-, and 12-month selections label the same entered totals without extrapolation", () => {
  const results = ([3, 6, 12] as const).map((periodMonths) =>
    computeCalc(simpleInputs({ periodMonths })),
  );

  assert.deepEqual(
    results.map((result) => result.periodLabel),
    ["3-month totals", "6-month totals", "12-month totals"],
  );
  assert.deepEqual(
    results.map((result) => result.metrics.revenue),
    [116000, 116000, 116000],
  );
  assert.deepEqual(
    results.map((result) => result.ree),
    [5.8, 5.8, 5.8],
  );
});

test("simple scenarios price four 10%-relative levers in stable order without ranking", () => {
  const result = computeCalc(simpleInputs());

  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.id),
    [...SCENARIO_IDS],
  );
  assert.ok(result.scenarios.every((scenario) => scenario.available && !scenario.cappedAt100));
  for (const scenario of result.scenarios) {
    close(scenario.additionalRevenue, 11600, 0.01);
  }
  assert.equal("topLevers" in result, false);
  assert.equal("bestLever" in result, false);
  assert.ok(result.scenarios.every((scenario) => !("rank" in scenario)));
});

test("rate scenarios honor the 100% ceiling without reordering the results", () => {
  const result = computeCalc(
    simpleInputs({
      leads: 100,
      consults: 95,
      cases: 95,
      estimatedCaseValue: 1000,
    }),
  );
  const leadToConsult = result.scenarios.find(
    (scenario) => scenario.id === "leadToConsult",
  )!;
  const consultToCase = result.scenarios.find(
    (scenario) => scenario.id === "consultToCase",
  )!;

  assert.equal(leadToConsult.cappedAt100, true);
  close(leadToConsult.additionalRevenue, 5000, 0.01);
  assert.equal(consultToCase.cappedAt100, true);
  assert.equal(consultToCase.additionalRevenue, 0);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.id),
    [...SCENARIO_IDS],
  );

  const exactCeiling = computeCalc(
    simpleInputs({
      leads: 110,
      consults: 100,
      cases: 50,
      estimatedCaseValue: 1000,
    }),
  ).scenarios.find((scenario) => scenario.id === "leadToConsult")!;
  assert.equal(exactCeiling.cappedAt100, false);
  close(exactCeiling.additionalRevenue, 5000, 0.01);
});

test("zero-case funnels expose honest zero or unavailable scenario states by revenue basis", () => {
  const estimated = computeCalc(
    simpleInputs({ cases: 0, estimatedCaseValue: 10000 }),
  );
  assert.equal(estimated.metrics.revenue, 0);
  assert.equal(estimated.metrics.costPerCase, null);
  assert.equal(estimated.metrics.revenuePerCase, 10000);
  assert.ok(estimated.scenarios.every((scenario) => scenario.available));
  assert.ok(estimated.scenarios.every((scenario) => scenario.additionalRevenue === 0));

  const generated = computeCalc(
    simpleInputs({
      cases: 0,
      revenueBasis: "generated",
      revenueGenerated: 5000,
      estimatedCaseValue: null,
    }),
  );
  close(generated.ree, 0.25);
  assert.equal(generated.metrics.revenuePerCase, null);
  assert.ok(generated.scenarios.every((scenario) => !scenario.available));
  assert.ok(generated.scenarios.every((scenario) => scenario.additionalRevenue === 0));
});

test("formatters and actual/estimated headline wording remain stable", () => {
  assert.equal(fmtUSD0(11600.4), "$11,600");
  assert.equal(fmtUSD2(5.8), "$5.80");
  assert.equal(fmtPct(1 / 3), "33.3%");
  assert.equal(fmtPct(0.4), "40%");
  assert.equal(fmtX(5.8), "5.8\u00d7");
  assert.equal(fmtX(8), "8\u00d7");
  assert.equal(
    headlineSentence({ ree: 5.8, confidence: "estimated" }),
    "Your Revenue Engine currently produces an estimated $5.80 in top-line revenue for every $1 invested in client acquisition.",
  );
  assert.equal(
    headlineSentence({ ree: 5.8, confidence: "actual" }),
    "Your Revenue Engine currently produces $5.80 in top-line revenue for every $1 invested in client acquisition.",
  );
});

// ---------------------------------------------------------------------------
// Handoff contract — calculator → homepage booking anchor
// ---------------------------------------------------------------------------

test("handoff params round-trip only the period, score, and actual/estimated revenue basis", () => {
  const query = buildReeHandoffQuery({
    periodMonths: 6,
    reePerDollar: 5.8,
    revenueBasis: "estimated",
  });
  assert.match(query, /ree_period=6/);
  assert.match(query, /ree_usd=5\.80/);
  assert.match(query, /ree_basis=estimated/);
  assert.doesNotMatch(query, /ree_(conf|lever|upside|cohort)=/);
  // Task #5092: the full handoff URL is ?ree_*…#booking — query string
  // precedes the fragment so the server can read params before any redirect.
  const fullHandoffUrl = `/?${query}#booking`;
  assert.ok(
    fullHandoffUrl.indexOf("?") < fullHandoffUrl.indexOf("#"),
    `query string precedes fragment in the full handoff URL: ${fullHandoffUrl}`,
  );
  assert.match(fullHandoffUrl, /#booking$/);
  const parsed = parseReeHandoffParams(`?${query}`)!;
  assert.equal(parsed.periodMonths, 6);
  assert.equal(parsed.reePerDollar, 5.8);
  assert.equal(parsed.revenueBasis, "estimated");

  const actual = parseReeHandoffParams(
    `?${buildReeHandoffQuery({
      periodMonths: 12,
      reePerDollar: 3,
      revenueBasis: "actual",
    })}`,
  )!;
  assert.equal(actual.periodMonths, 12);
  assert.equal(actual.revenueBasis, "actual");
  assert.equal(parseReeHandoffParams("?utm_source=x"), null);
  assert.equal(
    parseReeHandoffParams("?ree_period=9&ree_usd=4.00&ree_basis=actual"),
    null,
  );
  assert.equal(
    parseReeHandoffParams("?ree_period=3&ree_usd=999999&ree_basis=actual"),
    null,
  );
  assert.equal(
    parseReeHandoffParams("?ree_period=3&ree_usd=junk&ree_basis=actual"),
    null,
  );
});

test("handoff prefill targets the homepage contact form textarea (editable, visitor text wins)", () => {
  // initReeHandoffPrefill() reads window.location.search, finds the
  // form[data-nb-inquiry="contact"] textarea[name="message"] on the homepage
  // reached at /?ree_*#booking, and only sets the value when the textarea is empty —
  // visitor-entered text always wins. Verify the source wiring is correct.
  const source = readFileSync(
    "website/src/client-shared/reeHandoff.ts",
    "utf8",
  );
  assert.match(
    source,
    /form\[data-nb-inquiry="contact"\]\s*textarea\[name="message"\]/,
    "initReeHandoffPrefill targets the contact form message textarea",
  );
  assert.match(
    source,
    /textarea\.value\.trim\(\) !== ""/,
    "prefill is skipped when the visitor has already typed a message",
  );
});

test("composed inquiry message carries only the period, score, basis, and validation ask", () => {
  const estimated = composeReeInquiryMessage({
    periodMonths: 6,
    reePerDollar: 5.8,
    revenueBasis: "estimated",
  });
  assert.match(estimated, /6-month reporting period/);
  assert.match(estimated, /\$5\.80 in revenue per \$1 of total investment/);
  assert.match(estimated, /estimated revenue basis/);
  assert.match(estimated, /validate these numbers/);
  assert.doesNotMatch(estimated, /cohort|lever|upside|10%/i);

  const actual = composeReeInquiryMessage({
    periodMonths: 12,
    reePerDollar: 10,
    revenueBasis: "actual",
  });
  assert.match(actual, /12-month reporting period/);
  assert.match(actual, /actual revenue basis/);
});

// ---------------------------------------------------------------------------
// Committed bundle wiring — the CTA ladder in website/public
// ---------------------------------------------------------------------------

const PUB = path.join(process.cwd(), "website", "public");
const pub = (...parts: string[]): string =>
  readFileSync(path.join(PUB, ...parts), "utf8");

test("committed /calculator/ page ships only the simplified period form and privacy line", () => {
  const html = pub("calculator", "index.html");
  assert.match(html, /Score Your Revenue Engine\./);
  for (const field of [
    "periodMonths",
    "totalInvestment",
    "leads",
    "consults",
    "cases",
    "revenueGenerated",
    "estimatedCaseValue",
  ]) {
    assert.ok(html.includes(`name="${field}"`), `form field ${field}`);
  }
  for (const removed of [
    "cohortStart",
    "cohortEnd",
    "maturity",
    "consultsBooked",
    "consultsHeld",
    "practiceArea",
    "market",
    "targetLeadToConsult",
  ]) {
    assert.ok(!html.includes(`name="${removed}"`), `removed form field ${removed}`);
  }
  assert.match(html, /3 months/);
  assert.match(html, /6 months/);
  assert.match(html, /12 months/);
  assert.match(html, /ad spend, agency fees, and intake\/sales staff costs/);
  assert.match(html, /Calculate my REE/);
  assert.match(html, /Runs entirely in your browser/);
  // Task #5092: calc page data-booking-base points to the homepage (../),
  // not the retired /book-free-demo/ directory.
  assert.match(html, /data-booking-base="\.\.\/"/);
  assert.match(html, /assets\/js\/calc\.js/);
  assert.match(html, /<noscript>/);
  assert.doesNotMatch(html, /type="date"|matur|print or save|measure a cohort/i);
});

test("committed calculator scripts carry only the concise result and handoff contract", () => {
  const calcJs = pub("assets", "js", "calc.js");
  const siteJs = pub("assets", "js", "site.js");
  assert.ok(calcJs.includes("in top-line revenue for every $1 invested in client acquisition."));
  assert.ok(calcJs.includes("The value of a 10% improvement"));
  assert.ok(calcJs.includes("Want to pressure-test this result?"));
  assert.ok(calcJs.includes("Estimated revenue"));
  assert.ok(calcJs.includes("Book a High Impact Revenue Session"));
  assert.ok(!calcJs.includes("Your highest-dollar lever appears to be:"));
  assert.ok(!calcJs.includes("Print or save this report"));
  // Task #5092: handoff lands at #booking (not the retired #contact URL) so
  // the query string precedes the fragment: …?ree_period=…&ree_usd=…&ree_basis=…#booking.
  assert.ok(
    calcJs.includes("#booking"),
    "calc.js handoff URL targets #booking (query precedes fragment)",
  );
  assert.ok(!calcJs.includes("book-free-demo/"), "calc.js has no retired booking-page reference");
  assert.ok(!calcJs.includes("#contact"), "calc.js handoff has no stale #contact fragment");
  for (const retired of [
    "ree_conf",
    "ree_lever",
    "ree_upside",
    "ree_cohort",
    "consultsBooked",
    "consultsHeld",
    "showRate",
    "topLevers",
  ]) {
    assert.ok(!calcJs.includes(retired), `calc.js omits ${retired}`);
    assert.ok(!siteJs.includes(retired), `site.js omits ${retired}`);
  }
});

test("committed /data-notes/ publishes the simplified v1.1 methodology", () => {
  const html = pub("data-notes", "index.html");
  assert.match(html, /Data Notes/);
  assert.match(html, /Version 1\.1/i);
  assert.match(html, /Revenue for the selected period/);
  assert.match(html, /Actual revenue basis/);
  assert.match(html, /Estimated revenue basis/);
  assert.match(html, /How the 10% improvement values work/);
  assert.match(html, /More leads \(\+10%\)/);
  assert.match(html, /Revenue per Case \(\+10%\)/);
  assert.match(html, /no practice-area benchmarks/i);
  assert.match(html, /Revenue Engine Efficiency/);
  assert.doesNotMatch(
    html,
    /\$5\.80|worked example|maturity window|show rate|consultations booked|consultations held|highest-dollar/i,
  );
});

test("CTA-ladder wiring: every soft-CTA surface links /calculator/ with current copy", () => {
  const home = pub("index.html");
  assert.doesNotMatch(home, /CALCULATE YOUR REE/);
  assert.doesNotMatch(home, /REE Calculator/);
  assert.doesNotMatch(home, /Want a number first\?/);
  assert.doesNotMatch(home, /nb-close-alt/);
  assert.match(home, /Revenue Calculator/);
  assert.equal(
    (home.match(/href="[^"]*calculator\//g) ?? []).length,
    1,
    "the footer RESOURCES link is the homepage's only calculator rung",
  );

  const freeChapters = pub("free-chapters", "index.html");
  assert.match(freeChapters, /Calculate your Revenue Engine/);
  assert.match(freeChapters, /fc-endcap-actions fc-endcap-ask/);
  const floatingBar =
    freeChapters.match(/<div class="fc-bar"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  assert.match(
    floatingBar,
    /Book a High Impact Revenue Session <span aria-hidden="true">→<\/span>/,
  );
  // Task #5092: /book-free-demo/ is retired; the floating bar CTA now
  // uses the depth-correct homepage #booking anchor.
  assert.match(floatingBar, /href="\.\.\/\#booking"/);
  assert.doesNotMatch(floatingBar, /calculator\/|fc-bar-calc|calculate your REE/i);

  const resources = pub("resources", "index.html");
  assert.match(resources, /How Hard Does Your \$1 Work\?/);
  assert.match(resources, /3-, 6-, or 12-month totals/);
  assert.match(resources, /each available direct lever/);
  assert.match(resources, /CALCULATE YOUR REE/);

  const slugs = readdirSync(path.join(PUB, "resource"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(slugs.length >= 10, `expected the article set, got ${slugs.length}`);
  for (const slug of slugs) {
    const article = pub("resource", slug, "index.html");
    assert.ok(article.includes("side-calc"), `article ${slug} missing side-calc card`);
    assert.match(article, /3-, 6-, or 12-month reporting period/);
    assert.match(article, /each available direct lever/);
    assert.doesNotMatch(article, /your highest-dollar lever out/i);
    assert.match(article, /Calculate your REE/);
  }

  // Shared subpage footer (any subpage) lists the calculator. Use About as
  // the representative now that Results is a homepage anchor, not a page.
  assert.match(pub("about", "index.html"), /REE Calculator/);
});
