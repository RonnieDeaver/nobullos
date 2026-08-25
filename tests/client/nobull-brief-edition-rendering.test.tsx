/* test-registration
{
  "name": "NoBull Brief rebrand rendering — CeoPulseVisual shows 'The NoBull Brief' title, 'Prepared for our partners' masthead, and the edition tag chip (Company Update / Market Shift); legacy untagged briefs render cleanly with NO tag (Task #4268); mechanics narrative render-caps at 2 paragraphs so legacy letter-length briefs stay short (Task #4804); text-only company-update briefs render the announcement layout — initiative grid + commitments band + promoted single visual, legacy overlong details contained via clamps, optional additive status chip — while market-shift, legacy-untagged, and charts-mode briefs keep the old layouts (Task #4813); Tasks #4834 + #4984: company updates whose analysis carries roadmap fields render the simplified roadmap template in exact order (kicker/supporting-line banner → snapshot cards with category icon or numbered fallback → why-this-matters as a lead paragraph + whyBullets with the capped 3-paragraph legacy fallback → serif pull quote) with sections omitted when their data is absent — Task #4984 deletes the Before & After and What's Coming Next bands, which stay absent even when a stored analysis still carries beforeAfter/timeline (those legacy fields keep the template active, never render) — while legacy roadmap-free rows keep the announcement layout and market-shift/charts-mode never adopt the template even when roadmap fields are present",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4268: fast (~2s), pure SSR string render, DB/DOM/fetch-free; pins the client-facing rebrand contract on the shared slide component used by the admin preview, the /pulse/:token public page, and the report slide — a silent regression here ships mislabeled or old-brand briefs to clients, and the untagged branch is the only guard that legacy share links keep rendering without a bogus tag.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4268 — "CEO Pulse" was rebranded to "The NoBull Brief" with a
 * standing masthead line ("Prepared for our partners") and a per-brief
 * edition tag (company_update | market_shift). CeoPulseVisual is the single
 * shared slide component behind the Studio live preview and the public
 * /pulse/:token page, so this suite pins its rendered output at the cheapest
 * layer (react-dom/server static markup, no jsdom):
 *
 *   (1) Title says "The NoBull Brief"; no user-visible "CEO Pulse" remains
 *       (including the letter CTA and empty state).
 *   (2) The masthead "Prepared for our partners" always renders.
 *   (3) edition="company_update" / "market_shift" → the tag chip renders
 *       with the right human label.
 *   (4) Legacy untagged briefs (edition null/undefined) and unknown edition
 *       values render with NO tag chip — old share links stay clean.
 *   (5) ceoPulseEditionLabel is the single label source shared by every
 *       render surface (visual, letter, public report slide).
 *   (6) Task #4804 — the mechanics card renders at most
 *       CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS narrative paragraphs: a legacy
 *       4-paragraph (letter-length) brief renders only the first two on
 *       every CeoPulseVisual surface, with no re-analysis needed.
 *   (7)-(10) Task #4813 — text-only company_update briefs render the
 *       ANNOUNCEMENT layout: a name-first initiative grid ("What We're
 *       Building"), a commitments band ("What This Means for You"), the
 *       mechanics card with a single supporting image promoted alongside as
 *       the visual anchor, and stat callouts only when real numbers exist.
 *       Legacy overlong details (rows analyzed before the announcement spec,
 *       like the live August 2026 prod draft) render contained — lead-first
 *       with clamped support — with NO re-analysis needed. The additive
 *       optional per-item `status` chip renders only when present and
 *       non-empty. Market-shift text-only, legacy untagged, and charts-mode
 *       company updates keep the OLD layouts byte-for-byte.
 *   (11)-(13) Tasks #4834 + #4984 — text-only company_update briefs whose
 *       aiAnalysis carries roadmap-template fields (supportingLine /
 *       whyBullets / pullQuote / per-takeaway category, or legacy
 *       beforeAfter / timeline from a pre-#4984 row) render the simplified
 *       ROADMAP layout in the template's exact order, with per-section
 *       presence gating (absent data → section omitted, never blank), the
 *       category→icon map with a padded-number fallback, and the serif pull
 *       quote. Task #4984 deleted the Before & After and What's Coming Next
 *       bands: they must never render, even when the stored analysis still
 *       carries the legacy fields — which continue to count toward
 *       roadmap-layout detection so already-published briefs keep the
 *       template. Why This Matters renders as one lead paragraph plus short
 *       bullets when whyBullets exist; bullet-less legacy rows keep the
 *       capped 3-paragraph rendering. Roadmap-free legacy rows keep the
 *       Task #4813 announcement layout (section 7 above pins this), and
 *       market-shift / charts-mode briefs never adopt the template even
 *       when roadmap fields are present.
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import CeoPulseVisual from "../../client/src/components/CeoPulseVisual";
import { ceoPulseEditionLabel, CEO_PULSE_EDITIONS, CEO_PULSE_EDITION_LABELS, CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS } from "../../shared/schema";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const analysis = {
  headline: "Test headline for the brief",
  keyTakeaways: ["takeaway one"],
  strategicImplications: ["implication one"],
  contextNarrative: ["A narrative paragraph."],
  byTheNumbers: [{ label: "New cases", value: "12" }],
};

function render(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <CeoPulseVisual analysis={analysis} monthLabel="August 2026" animate={false} includeGraphs={false} {...props} />,
  );
}

// ── (1) Rebrand: title + CTA + empty state say "NoBull Brief", never "CEO Pulse" ──
{
  const html = render({ letterUrl: "/pulse/tok/letter" });
  assert.ok(html.includes("The NoBull Brief"), "title renders 'The NoBull Brief'");
  assert.ok(html.includes("Read the Full NoBull Brief"), "letter CTA renamed");
  assert.ok(!html.includes("CEO Pulse"), "no user-visible 'CEO Pulse' remains in the rendered slide");
  ok("(1) title + letter CTA carry the new brand; old name absent");

  const emptyHtml = renderToStaticMarkup(
    <CeoPulseVisual analysis={null as any} animate={false} />,
  );
  assert.ok(emptyHtml.includes("No NoBull Brief data available yet."), "empty state renamed");
  assert.ok(!emptyHtml.includes("CEO Pulse"), "empty state has no old-brand copy");
  ok("(1b) empty state renamed too");
}

// ── (2) Masthead always renders ────────────────────────────────────────────
{
  for (const edition of [undefined, null, "company_update"] as const) {
    const html = render(edition === undefined ? {} : { edition });
    assert.ok(
      html.includes("Prepared for our partners"),
      `masthead present (edition=${String(edition)})`,
    );
  }
  ok("(2) 'Prepared for our partners' masthead renders for tagged and untagged briefs");
}

// ── (3) Edition tag chip renders the right label for both values ──────────
{
  const company = render({ edition: "company_update" });
  assert.ok(company.includes('data-testid="tag-edition"'), "tag chip renders for company_update");
  assert.ok(company.includes("Company Update"), "company_update labeled 'Company Update'");

  const market = render({ edition: "market_shift" });
  assert.ok(market.includes('data-testid="tag-edition"'), "tag chip renders for market_shift");
  assert.ok(market.includes("Market Shift"), "market_shift labeled 'Market Shift'");
  ok("(3) both editions render their human label as the tag chip");
}

// ── (4) Legacy untagged (and unknown values) render with NO tag ────────────
{
  for (const [label, props] of [
    ["edition omitted", {}],
    ["edition null", { edition: null }],
    ["unknown edition value", { edition: "quarterly_recap" }],
  ] as Array<[string, Record<string, unknown>]>) {
    const html = render(props);
    assert.ok(!html.includes('data-testid="tag-edition"'), `${label}: no tag chip rendered`);
    assert.ok(html.includes("The NoBull Brief"), `${label}: slide still renders cleanly`);
    assert.ok(html.includes("Test headline for the brief"), `${label}: content intact`);
  }
  ok("(4) legacy untagged briefs render cleanly with no tag (unknown values too)");
}

// ── (5) ceoPulseEditionLabel is the shared single label source ─────────────
{
  assert.deepEqual([...CEO_PULSE_EDITIONS], ["company_update", "market_shift"], "value set pinned");
  assert.equal(ceoPulseEditionLabel("company_update"), "Company Update");
  assert.equal(ceoPulseEditionLabel("market_shift"), "Market Shift");
  assert.equal(ceoPulseEditionLabel(null), null, "null → no label");
  assert.equal(ceoPulseEditionLabel(undefined), null, "undefined → no label");
  assert.equal(ceoPulseEditionLabel("bogus"), null, "unknown value → no label (renders no tag)");
  for (const edition of CEO_PULSE_EDITIONS) {
    assert.equal(ceoPulseEditionLabel(edition), CEO_PULSE_EDITION_LABELS[edition], "label map and helper agree");
  }
  ok("(5) shared edition label helper: both values mapped, everything else null");
}

// ── (6) Mechanics narrative render cap — legacy long briefs stay short ─────
{
  assert.equal(
    CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS,
    2,
    "short-brief spec: the shared narrative cap is 2 paragraphs (Task #4804)",
  );
  const legacyLongAnalysis = {
    ...analysis,
    contextNarrative: [
      "Legacy paragraph one from a letter-length brief.",
      "Legacy paragraph two from a letter-length brief.",
      "Legacy paragraph three that must not render on the report visual.",
      "Legacy paragraph four that must not render on the report visual.",
    ],
  };
  const html = render({ analysis: legacyLongAnalysis });
  assert.ok(html.includes('data-testid="text-narrative-0"'), "first paragraph renders");
  assert.ok(html.includes('data-testid="text-narrative-1"'), "second paragraph renders");
  assert.ok(!html.includes('data-testid="text-narrative-2"'), "third paragraph capped out of the mechanics card");
  assert.ok(!html.includes('data-testid="text-narrative-3"'), "fourth paragraph capped out of the mechanics card");
  assert.ok(html.includes("Legacy paragraph two"), "kept paragraphs render their text");
  assert.ok(!html.includes("Legacy paragraph three"), "over-cap paragraph text is absent");
  ok("(6) legacy 4-paragraph narrative renders only the first 2 — the report version stays short");
}

// ───────────────────────── Task #4813 sections ─────────────────────────────
// react-dom/server escapes text (' → &#x27;) — compare labels containing
// apostrophes against their escaped form.
const ssrEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Mirrors the REAL prod August 2026 company-update draft (read from the prod
// replica 2026-08-14; the dev clone's latest brief is 2026-02, so this shape
// is pinned here instead of seeded): edition='company_update',
// include_graphs=false, 6 keyTakeaways {highlight, detail} with ~250-char
// details written BEFORE the announcement spec, 5 strategicImplications with
// long details, 4 contextNarrative paragraphs, byTheNumbers: [], charts: [],
// one supporting image in slot 1. No per-item `status` anywhere (the field
// postdates the draft).
const prodShapedTakeaways = [
  "Review-driven first impressions",
  "Team Powered Ask System",
  "Review Velocity System",
  "Book relaunch alignment",
  "Company Roadmap visibility",
  "Client feedback as an input",
].map((highlight, i) => ({
  highlight,
  detail:
    `Long pre-announcement detail ${i + 1}: ` +
    "we are rebuilding the first impression a prospective client gets when they search the firm so the reviews they see — count, recency, and the story they tell — finally match the quality of the work delivered, because that first scan decides who gets the call and who never does.",
}));
const prodShapedImplications = [
  "You get more reviews with less chasing",
  "Your first impression compounds",
  "You can see what ships next",
  "Your feedback steers the roadmap",
  "The book relaunch feeds your pipeline",
].map((highlight, i) => ({
  highlight,
  detail:
    `Long implication detail ${i + 1}: ` +
    "this lands as a standing system rather than a one-off campaign, which means the effect compounds month over month without anyone on your team having to remember to ask, follow up, or reconcile the numbers by hand at the end of the quarter.",
}));
const prodShapedAnalysis = {
  headline:
    "Building the next version of the Law Firm Revenue Engine around reviews, review velocity, and an open roadmap",
  keyTakeaways: prodShapedTakeaways,
  strategicImplications: prodShapedImplications,
  contextNarrative: [
    "Narrative paragraph one explaining the lesson behind the build.",
    "Narrative paragraph two explaining the mechanics of review velocity.",
    "Narrative paragraph three that must not render on the brief.",
    "Narrative paragraph four that must not render on the brief.",
  ],
  byTheNumbers: [],
  charts: [],
};

// ── (7) Company-update announcement layout — prod-shaped draft ─────────────
{
  assert.ok(
    prodShapedTakeaways.every((t) => t.detail.length >= 200),
    "fixture honesty: details stay overlong (~250 chars) like the stored prod draft",
  );
  const html = render({
    analysis: prodShapedAnalysis,
    edition: "company_update",
    letterUrl: "/pulse/tok/letter",
  });

  // Announcement layout in, stacked bullet columns out.
  assert.ok(html.includes('data-testid="ceo-pulse-initiatives"'), "initiative grid renders");
  assert.ok(html.includes(ssrEscape("What We're Building")), "initiatives section label");
  assert.ok(html.includes("What This Means for You"), "commitments section label");
  for (let i = 0; i < 6; i++) {
    assert.ok(html.includes(`data-testid="initiative-card-${i}"`), `initiative card ${i} renders`);
  }
  assert.ok(!html.includes('data-testid="initiative-card-6"'), "exactly 6 initiative cards");
  for (let i = 0; i < 5; i++) {
    assert.ok(html.includes(`data-testid="commitment-${i}"`), `commitment row ${i} renders`);
  }
  assert.ok(!html.includes('data-testid="commitment-5"'), "exactly 5 commitment rows");
  assert.ok(!html.includes('data-testid="text-takeaway-0"'), "old takeaway bullets gone");
  assert.ok(!html.includes('data-testid="text-implication-0"'), "old implication bullets gone");
  assert.ok(!html.includes("Key Takeaways"), "old 'Key Takeaways' label gone");

  // Names lead; legacy overlong details render CONTAINED (clamped support),
  // not as 40+ word bullet walls.
  assert.ok(html.includes("Review Velocity System"), "initiative name renders as the card lead");
  assert.ok(html.includes("line-clamp-3"), "overlong initiative details clamped");
  assert.ok(html.includes("line-clamp-2"), "overlong commitment amplifiers clamped");

  // No status chips on the prod draft (field postdates it).
  assert.ok(!html.includes('data-testid="initiative-status-'), "no status chips without the additive field");

  // Frame preserved: masthead, edition chip, headline banner, letter CTA.
  assert.ok(html.includes("Prepared for our partners"), "masthead intact");
  assert.ok(html.includes('data-testid="tag-edition"'), "edition chip intact");
  assert.ok(html.includes("Company Update"), "edition chip label intact");
  assert.ok(html.includes(ssrEscape(prodShapedAnalysis.headline)), "headline banner intact");
  assert.ok(html.includes("Read the Full NoBull Brief"), "letter CTA intact and prominent");

  // Narrative still render-capped at 2; empty byTheNumbers renders NO stats card.
  assert.ok(html.includes('data-testid="text-narrative-0"'), "narrative paragraph 1 renders");
  assert.ok(html.includes('data-testid="text-narrative-1"'), "narrative paragraph 2 renders");
  assert.ok(!html.includes('data-testid="text-narrative-2"'), "narrative capped at 2 in the announcement layout too");
  assert.ok(!html.includes('data-testid="ceo-pulse-by-the-numbers"'), "empty byTheNumbers renders no stats card");
  ok("(7) prod-shaped company update renders the announcement layout with contained legacy details");
}

// ── (8) Additive status chip + string-item tolerance ───────────────────────
{
  const html = render({
    analysis: {
      ...prodShapedAnalysis,
      keyTakeaways: [
        { highlight: "Review Velocity System", detail: "Automates the ask cadence.", status: "In beta" },
        { highlight: "Company Roadmap", detail: "Follow along weekly.", status: "   " },
        "Plain legacy string initiative",
      ],
      strategicImplications: ["Plain legacy string commitment"],
    },
    edition: "company_update",
  });
  assert.ok(html.includes('data-testid="initiative-status-0"'), "status chip renders when present");
  assert.ok(html.includes("In beta"), "status chip carries the stage text");
  assert.ok(!html.includes('data-testid="initiative-status-1"'), "whitespace-only status renders no chip");
  assert.ok(html.includes("Plain legacy string initiative"), "string-form takeaway renders whole as the lead");
  assert.ok(html.includes('data-testid="initiative-card-2"'), "string-form takeaway still gets a card");
  assert.ok(html.includes("Plain legacy string commitment"), "string-form implication renders as the statement");
  ok("(8) status chip renders only when present and non-empty; string items tolerated");
}

// ── (9) Single supporting image promoted alongside the mechanics card ──────
{
  const oneImage = [{ slot: 1, url: "https://example.com/book-cover.jpg", caption: null }];
  const html = render({
    analysis: prodShapedAnalysis,
    edition: "company_update",
    supportingImages: oneImage,
  });
  assert.ok(html.includes("md:grid-cols-5"), "mechanics + visual split renders");
  assert.ok(html.includes("md:col-span-3"), "narrative takes the wide column");
  assert.ok(html.includes("md:col-span-2"), "image takes the anchor column");
  assert.ok(html.includes('data-testid="ceo-pulse-narrative"'), "mechanics card present in the split");
  assert.ok(html.includes('data-testid="supporting-image-1"'), "single image renders in the promoted slot");

  // Two images → the shared full-width visuals grid, no promotion split.
  const twoImages = render({
    analysis: prodShapedAnalysis,
    edition: "company_update",
    supportingImages: [
      { slot: 1, url: "https://example.com/a.jpg", caption: null },
      { slot: 2, url: "https://example.com/b.jpg", caption: "Caption B" },
    ],
  });
  assert.ok(!twoImages.includes("md:grid-cols-5"), "multi-image briefs keep the full-width grid");
  assert.ok(twoImages.includes('data-testid="ceo-pulse-supporting-images"'), "shared visuals card renders");
  assert.ok(twoImages.includes('data-testid="supporting-image-1"'), "image 1 renders");
  assert.ok(twoImages.includes('data-testid="supporting-image-2"'), "image 2 renders");
  ok("(9) one image promotes beside the mechanics card; multiple images fall back to the grid");
}

// ── (10) Old layouts unchanged: market-shift, legacy untagged, charts mode ─
{
  for (const [label, props] of [
    ["market_shift text-only", { analysis: prodShapedAnalysis, edition: "market_shift" }],
    ["legacy untagged text-only", { analysis: prodShapedAnalysis }],
  ] as Array<[string, Record<string, unknown>]>) {
    const html = render(props);
    assert.ok(html.includes("Key Takeaways"), `${label}: old takeaway label kept`);
    assert.ok(html.includes('data-testid="text-takeaway-0"'), `${label}: old takeaway bullets kept`);
    assert.ok(html.includes('data-testid="text-implication-0"'), `${label}: old implication bullets kept`);
    assert.ok(!html.includes('data-testid="ceo-pulse-initiatives"'), `${label}: no initiative grid`);
    assert.ok(!html.includes('data-testid="initiative-card-0"'), `${label}: no initiative cards`);
    assert.ok(!html.includes("What This Means for You"), `${label}: no commitments label (old label is 'What This Means')`);
  }

  // Charts-mode company update keeps the charts layout (metric_cards renders
  // in SSR, unlike ResponsiveContainer charts).
  const chartsHtml = render({
    analysis: {
      ...prodShapedAnalysis,
      charts: [{ type: "metric_cards", title: "KPIs", data: [{ label: "Leads", value: 42 }] }],
    },
    edition: "company_update",
    includeGraphs: true,
  });
  assert.ok(chartsHtml.includes("Key Takeaways"), "charts-mode company update: old label kept");
  assert.ok(chartsHtml.includes('data-testid="text-takeaway-0"'), "charts-mode company update: old bullets kept");
  assert.ok(!chartsHtml.includes('data-testid="ceo-pulse-initiatives"'), "charts-mode company update: no announcement layout");
  ok("(10) market-shift / legacy untagged / charts-mode layouts untouched");
}

// ─────────────────── Task #4834 + #4984 sections ───────────────────────────
// Roadmap-shaped company update as an ALREADY-PUBLISHED row would carry it:
// fresh whyBullets (→ lead + bullets; the 4 stored paragraphs are superseded)
// PLUS legacy beforeAfter/timeline from before Task #4984 retired them —
// those fields keep the roadmap template active but must never render.
// Unrecognized category label keeps the label, falls back to the padded
// number; a category-free card numbers too.
const roadmapAnalysis = {
  headline: "Reviews now drive the build queue",
  keyTakeaways: [
    { highlight: "Review Velocity System", detail: "Automates the ask cadence for every closed matter.", status: "In beta", category: "System" },
    { highlight: "Partner Education Series", detail: "Short trainings on the new workflow.", category: "Education" },
    { highlight: "Mystery Area Initiative", detail: "Unrecognized category label falls back to a number.", category: "Logistics" },
    { highlight: "No Category Initiative", detail: "No category at all also numbers." },
  ],
  strategicImplications: [{ highlight: "You get more reviews", detail: "with less chasing." }],
  contextNarrative: [
    "Why paragraph one.",
    "Why paragraph two.",
    "Why paragraph three.",
    "Why paragraph four must not render.",
  ],
  byTheNumbers: [{ label: "Reviews collected", value: "214" }],
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

// ── (11) Roadmap template — simplified section order (Task #4984) ──────────
{
  const html = render({
    analysis: roadmapAnalysis,
    edition: "company_update",
    letterUrl: "/pulse/tok/letter",
    supportingImages: [{ slot: 1, url: "https://example.com/roadmap.jpg", caption: null }],
  });

  // Template order: kicker → headline → supporting line → snapshot →
  // why → pull quote → letter CTA. Task #4984: before/after and timeline
  // are GONE from the chain.
  const chain = [
    'data-testid="text-roadmap-kicker"',
    'data-testid="text-ceo-headline"',
    'data-testid="text-supporting-line"',
    'data-testid="roadmap-snapshot"',
    'data-testid="roadmap-why"',
    'data-testid="roadmap-pull-quote"',
    'data-testid="link-full-letter"',
  ];
  let prev = -1;
  for (const needle of chain) {
    const idx = html.indexOf(needle);
    assert.ok(idx >= 0, `${needle} present`);
    assert.ok(idx > prev, `${needle} in template order`);
    prev = idx;
  }
  assert.ok(html.includes("Because reviews decide who gets the first call."), "supporting line text renders under the headline");

  // Task #4984 — the removed bands stay removed even though the stored
  // analysis STILL carries beforeAfter/timeline (already-published briefs).
  assert.ok(!html.includes('data-testid="roadmap-before-after"'), "Before & After band deleted");
  assert.ok(!html.includes('data-testid="roadmap-timeline"'), "What's Coming Next band deleted");
  assert.ok(!html.includes(ssrEscape("Before & After")), "no Before & After label anywhere");
  assert.ok(!html.includes(ssrEscape("What's Coming Next")), "no What's Coming Next label anywhere");
  assert.ok(!html.includes("timeline-step-"), "no timeline steps in either responsive variant");
  assert.ok(!html.includes("before-bullet-") && !html.includes("after-bullet-"), "no before/after bullet markup");
  assert.ok(!html.includes("Slow follow-up") && !html.includes("Every matter asked"), "legacy before/after content never rendered");
  assert.ok(!html.includes("Velocity system beta") && !html.includes(">Now<") && !html.includes(">Soon<"), "legacy timeline content never rendered");

  // Announcement layout fully replaced (and old bullet columns absent).
  assert.ok(!html.includes('data-testid="ceo-pulse-initiatives"'), "no initiative grid");
  assert.ok(!html.includes('data-testid="initiative-card-0"'), "no initiative cards");
  assert.ok(!html.includes('data-testid="commitment-0"'), "no commitments band");
  assert.ok(!html.includes('data-testid="ceo-pulse-narrative"'), "no mechanics card (why card replaces it)");
  assert.ok(!html.includes('data-testid="text-takeaway-0"'), "no old takeaway bullets");
  assert.ok(!html.includes("What This Means for You"), "no commitments label");

  // Snapshot cards: labels, category→icon map, padded-number fallback.
  assert.ok(html.includes("Update Snapshot"), "snapshot section label");
  for (let i = 0; i < 4; i++) {
    assert.ok(html.includes(`data-testid="snapshot-card-${i}"`), `snapshot card ${i} renders`);
  }
  assert.ok(html.includes('data-testid="snapshot-category-0"'), "category label renders");
  assert.ok(html.includes('data-testid="snapshot-icon-0"'), "System category maps to an icon");
  assert.ok(html.includes('data-testid="snapshot-icon-1"'), "Education category maps to an icon");
  assert.ok(html.includes('data-testid="snapshot-number-2"'), "unrecognized category falls back to a number");
  assert.ok(html.includes('data-testid="snapshot-category-2"'), "unrecognized category still shows its label");
  assert.ok(html.includes(">03<"), "number fallback is padded (03)");
  assert.ok(html.includes('data-testid="snapshot-number-3"'), "category-free card numbers too");
  assert.ok(!html.includes('data-testid="snapshot-icon-3"'), "no icon without a category");
  assert.ok(html.includes('data-testid="snapshot-status-0"'), "status chip renders on snapshot cards");
  assert.ok(html.includes("In beta"), "status chip text");
  assert.ok(!html.includes('data-testid="snapshot-status-1"'), "no chip without a status");
  assert.ok(html.includes("line-clamp-3"), "snapshot descriptions clamped");

  // Why This Matters (Task #4984): lead + bullets when whyBullets exist —
  // the stored paragraphs are superseded, never rendered alongside.
  assert.ok(html.includes("Why This Matters"), "why section label");
  assert.ok(html.includes('data-testid="why-lead"'), "why lead renders");
  assert.ok(html.includes("Why paragraph one."), "lead = first stored paragraph");
  assert.ok(!html.includes("Why paragraph two."), "remaining paragraphs superseded by bullets");
  assert.ok(!html.includes('data-testid="why-paragraph-0"'), "no paragraph list when bullets exist");
  for (let i = 0; i < 3; i++) {
    assert.ok(html.includes(`data-testid="why-bullet-${i}"`), `why bullet ${i} renders`);
  }
  assert.ok(!html.includes('data-testid="why-bullet-3"'), "exactly the stored bullets, no padding");
  assert.ok(html.includes("Every closed matter gets an ask with a clear owner."), "bullet text renders");
  assert.ok(html.includes("text-brief-crimson"), "bullet markers ride the brief crimson token");

  // Pull quote: serif face on the crimson card.
  assert.ok(html.includes("The Bottom Line"), "pull-quote eyebrow");
  assert.ok(html.includes("font-report-serif"), "pull quote set in the serif face");
  assert.ok(html.includes("Reviews are the new first impression."), "pull quote text");
  assert.ok(html.includes("bg-brief-crimson"), "pull quote rides the crimson card");

  // Brand chrome + presence-gated extras survive the template.
  assert.ok(html.includes("The NoBull Brief"), "title intact");
  assert.ok(html.includes("Prepared for our partners"), "masthead intact");
  assert.ok(html.includes('data-testid="tag-edition"'), "edition chip intact");
  assert.ok(html.includes("Company Update"), "edition chip label intact");
  assert.ok(html.includes("August 2026"), "month label intact");
  assert.ok(html.includes("Read the Full NoBull Brief"), "letter CTA intact");
  assert.ok(html.includes('data-testid="ceo-pulse-supporting-images"'), "supporting images still render");
  assert.ok(html.includes('data-testid="supporting-image-1"'), "image renders full-width (no promotion split)");
  assert.ok(!html.includes("md:grid-cols-5"), "no mechanics/visual promotion split in the roadmap layout");
  assert.ok(html.includes('data-testid="ceo-pulse-by-the-numbers"'), "stats card renders when numbers exist");
  assert.ok(html.includes('data-testid="stat-value-0"'), "stat value renders");
  assert.ok(html.includes("214"), "stat value text");
  ok("(11) roadmap company update renders the simplified template in order — legacy bands absent, why lead+bullets, chrome intact");

  // Why card legacy fallback: same fixture minus whyBullets → bullet-less
  // (older) briefs keep the capped 3-paragraph rendering unchanged.
  const paragraphHtml = render({
    analysis: { ...roadmapAnalysis, whyBullets: undefined },
    edition: "company_update",
  });
  assert.ok(paragraphHtml.includes('data-testid="roadmap-why"'), "why card still renders without bullets");
  for (let i = 0; i < 3; i++) {
    assert.ok(paragraphHtml.includes(`data-testid="why-paragraph-${i}"`), `why paragraph ${i} renders on bullet-less rows`);
  }
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
  ok("(11b) bullet-less legacy rows keep the capped paragraph rendering");
}

// ── (12) Partial roadmap data — sections omitted, never blank ──────────────
{
  const html = render({
    analysis: {
      headline: "Only a pull quote this time",
      keyTakeaways: [{ highlight: "Single Initiative", detail: "One line." }],
      strategicImplications: [{ highlight: "One commitment", detail: "short." }],
      contextNarrative: ["Why paragraph."],
      byTheNumbers: [],
      charts: [],
      pullQuote: "One sentence still flips the template.",
    },
    edition: "company_update",
  });
  // One valid roadmap field → template layout…
  assert.ok(html.includes('data-testid="text-roadmap-kicker"'), "kicker renders (template active)");
  assert.ok(html.includes('data-testid="roadmap-snapshot"'), "snapshot renders from keyTakeaways");
  assert.ok(html.includes('data-testid="roadmap-why"'), "why card renders from contextNarrative");
  assert.ok(html.includes('data-testid="roadmap-pull-quote"'), "pull quote renders");
  assert.ok(!html.includes('data-testid="ceo-pulse-initiatives"'), "announcement layout replaced");
  // …with unsupported sections OMITTED (no empty shells).
  assert.ok(!html.includes('data-testid="text-supporting-line"'), "no supporting line without data");
  assert.ok(!html.includes('data-testid="why-lead"'), "no why lead without whyBullets");
  assert.ok(!html.includes('data-testid="ceo-pulse-by-the-numbers"'), "empty byTheNumbers renders no stats card");
  ok("(12) partial roadmap data renders only its supported sections — absent data omitted, never blank");
}

// ── (13) Roadmap fields never flip other layouts ────────────────────────────
{
  // Market-shift with roadmap-shaped analysis keeps the stacked columns.
  const market = render({ analysis: roadmapAnalysis, edition: "market_shift" });
  assert.ok(market.includes("Key Takeaways"), "market-shift keeps the old takeaway label");
  assert.ok(market.includes('data-testid="text-takeaway-0"'), "market-shift keeps bullet columns");
  assert.ok(!market.includes('data-testid="roadmap-snapshot"'), "market-shift: no snapshot cards");
  assert.ok(!market.includes('data-testid="text-roadmap-kicker"'), "market-shift: no kicker");
  assert.ok(!market.includes('data-testid="roadmap-pull-quote"'), "market-shift: no pull quote");
  assert.ok(!market.includes('data-testid="why-lead"'), "market-shift: no why lead/bullets");

  // Legacy untagged with roadmap-shaped analysis keeps the old layout too.
  const legacy = render({ analysis: roadmapAnalysis });
  assert.ok(legacy.includes("Key Takeaways"), "legacy untagged keeps the old takeaway label");
  assert.ok(!legacy.includes('data-testid="roadmap-snapshot"'), "legacy untagged: no roadmap template");

  // Charts-mode company update ignores roadmap fields as well.
  const charts = render({
    analysis: {
      ...roadmapAnalysis,
      charts: [{ type: "metric_cards", title: "KPIs", data: [{ label: "Leads", value: 42 }] }],
    },
    edition: "company_update",
    includeGraphs: true,
  });
  assert.ok(charts.includes("Key Takeaways"), "charts-mode keeps the old label");
  assert.ok(!charts.includes('data-testid="roadmap-snapshot"'), "charts-mode: no roadmap template");
  assert.ok(!charts.includes('data-testid="text-roadmap-kicker"'), "charts-mode: no kicker");
  ok("(13) roadmap fields never flip market-shift, legacy-untagged, or charts-mode layouts");
}

console.log(`nobull-brief-edition-rendering: all ${passed} sections passed`);
