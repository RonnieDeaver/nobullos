/* test-registration
{
  "name": "Website product funnel semantic content — brief copy renders in funnel order, retired engine-story/cinematic elements stay out (Task #4992)",
  "smoke": true,
  "smokeReason": "Guards the owner's #4992 product-section brief verbatim: the #system region opens on the THE LAW FIRM REVENUE ENGINE eyebrow directly followed by the One Revenue Engine. Three Core Components. headline (no intro paragraph), the funnel reads top-down as 01/MARKETING/CASEGEN™ → 02/INTAKE/CASEINTAKE™ → 03/SALES/CASECONVERT™ — each stage exactly dept label, product name, Title Case outcome headline, one ·-separated capability line (CaseGen's carries the three ™ system names) — terminating in the SIGNED CASES plaque, then the Build a Revenue Engine ask with the section's single Book Your High Impact Revenue Session CTA targeting #booking. The funnel object itself is arrow-, money-, and percent-free (receipts retired to /services/), and the removal list keeps out every retired engine-story family (overview/components/customization copy + class stems, diagram hooks) alongside the older cinematic/ribbon/#4925/#4926 material. A stale regen, copy edit, or merge that drops the brief copy or resurrects retired material fails here in under a second with no DB.",
  "regression": true,
  "scanPaths": ["website/public/index.html", "website/public/about/index.html", "website/src/proof.ts"],
  "tier": "small"
}
test-registration */
// Semantic-content guard for the #system product section (Task #4992 —
// the owner's single-funnel brief replaced the #4837/#4923/#4924 engine
// story: the charcoal overview, the three four-question component
// sections with their diagrams and ONE FIRM'S RESULT receipts, and the
// customization band all retired; the copy source of truth is the
// uploaded funnel brief, mirrored verbatim in website/src/pages/home.ts
// and documented in docs/website-final-copy.md §4). The section is ONE
// continuous funnel: eyebrow + headline, three stacked stages (dept →
// product name → outcome headline → one capability line, nothing else),
// the SIGNED CASES plaque as the terminal result, and a single session
// CTA below. This suite asserts the COMMITTED generator output carries
// that copy in that order, so a stale regen or a hand edit to the
// generated HTML can never ship a divergent section, and enforces the
// brief's remove list plus the older removal history: no body
// paragraphs or between-stage text in the funnel, no arrows/receipts
// inside the object, no retired engine-story vocabulary or class
// families, no scroll-jacking chrome, no frame-sequence attributes.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { footer, header, INDUSTRIES } from "../website/src/html";
import {
  BORIS,
  BURNS_SMITH,
  EXPANSION,
  PRESTI,
} from "../website/src/proof";
import { TEAM_ROSTER } from "../website/src/team";
const HTML_PATH = "website/public/index.html";
const ABOUT_HTML_PATH = "website/public/about/index.html";
/** website/src/html.ts esc() escapes & < > " — undo those four so copy
    containing them still compares verbatim (apostrophes ship raw), and
    fold &nbsp; (used to glue the CTA ask's final words) to a space. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function visibleText(markup: string): string {
  return decodeEntities(
    markup.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

/** The product-section region: the #system funnel section, whole (one
    section since Task #4992 — the funnel object + its CTA block). */
function sliceFunnel(html: string): string {
  const start = html.indexOf('<section id="system" class="nb-funnel"');
  assert.ok(start >= 0, "generated homepage contains the #system funnel");
  const end = html.indexOf("</section>", start);
  assert.ok(end > start, "funnel section closes");
  return html.slice(start, end);
}

/** The #4925 zone: proof band (flagship + supports + disclosure) through
    the static testimonials, ending at the team band (the REE strip that
    sat between them was removed by Task #4987). */
function sliceProofZone(html: string): string {
  const start = html.indexOf('<section id="proof" class="nb-proof">');
  assert.ok(start >= 0, "generated homepage contains the #proof band");
  // The proof zone ends at the team band that directly follows testimonials;
  // the book remains later in the final FAQ → book → conversion sequence.
  const end = html.indexOf('<section class="nb-team">', start);
  assert.ok(end > start, "team band follows the testimonials band");
  return html.slice(start, end);
}

function main(): void {
  const html = readFileSync(HTML_PATH, "utf8");
  const region = sliceFunnel(html);
  const vis = visibleText(region);
  const pageVis = visibleText(html);
  let checks = 0;
  const expectVisible = (copy: string, what: string): void => {
    assert.ok(vis.includes(copy), `${what} renders: ${JSON.stringify(copy)}`);
    checks += 1;
  };

  // Results is an in-page destination, never a standalone route. The
  // self-chromed homepage uses #proof directly; shared chrome prefixes that
  // same anchor with the relative path back to the homepage. Exercising the
  // helper at subpage, article, and 404 depths covers every generated chrome
  // contract without adding another suite or changing registration metadata.
  assert.equal(
    (html.match(/href="#proof"[^>]*>Results<\/a>/g) ?? []).length,
    2,
    "homepage header and footer Results links both target #proof",
  );
  assert.ok(
    !/href="[^"]*testimonials\//.test(html),
    "homepage contains no stale standalone Results-page link",
  );
  checks += 2;
  for (const [r, label] of [
    ["../", "generated subpage"],
    ["../../", "generated article"],
    ["{{BASE}}", "404 page"],
  ] as const) {
    const chrome = `${header(r)}${footer(r)}`;
    const expected = `href="${r}#proof">Results</a>`;
    assert.equal(
      chrome.split(expected).length - 1,
      2,
      `${label} header and footer Results links target the homepage proof anchor`,
    );
    assert.ok(
      !/testimonials\/|Results<\/a>[^]*is-active/.test(chrome),
      `${label} chrome has no retired Results route or active-page state`,
    );
    checks += 2;
  }

  // ── Page top (#4923 restructure, untouched by #4992): the hero copy
  //    renders, the gap lede prices the model in one breath, and the gap
  //    band closes on the handoff-diagnosis line. ──
  const pageCopy: Array<[string, string]> = [
    [
      "Most agencies stop at the lead. NoBull builds and manages the Marketing, Intake, and Sales systems that move qualified prospects from first click to signed case — and measures the revenue produced at every stage.",
      "hero lede (#4923 build-and-manage framing)",
    ],
    [
      "A free working session to build the plan for making your revenue goals a reality.",
      "hero session-explainer note (ledger #36 free + verified revenue-goals plan)",
    ],
    [
      "Picture two firms with the same 500 qualified leads. One signs 20 cases. The other signs 120. At a $10,000 average case value, that is a $1,000,000 difference without generating one additional lead.",
      "gap lede (priced in one breath, hypothetical cue kept — ledger row 19)",
    ],
    [
      "THE MILLION-DOLLAR OPPORTUNITY DIES IN THE HANDOFFS BETWEEN MARKETING, INTAKE, AND SALES.",
      "gap closer — the handoff-diagnosis line",
    ],
  ];
  for (const [copy, what] of pageCopy) {
    assert.ok(
      pageVis.includes(copy),
      `${what} renders: ${JSON.stringify(copy)}`,
    );
    checks += 1;
  }
  // The diagnosis line lives in the GAP band, before the product section:
  assert.ok(
    !vis.includes("THE MILLION-DOLLAR OPPORTUNITY DIES"),
    "the diagnosis line belongs to the gap closer, not the product section",
  );
  checks += 1;
  // Stage-only row tags (brief §3 — no product names inside the problem
  // illustration): the gap band carries MARKETING/INTAKE/SALES tags
  // without the CASEGEN™/CASEINTAKE™/CASECONVERT™ attributions.
  const gapStart = html.indexOf('<section class="nb-gap"');
  const sysStart = html.indexOf('<section id="system"');
  assert.ok(
    gapStart >= 0 && sysStart > gapStart,
    "gap band renders before the #system funnel",
  );
  const gapVis = visibleText(html.slice(gapStart, sysStart));
  assert.ok(
    !/CASEGEN™|CASEINTAKE™|CASECONVERT™/.test(gapVis),
    "no product names inside the gap problem illustration (brief §3)",
  );
  checks += 2;

  // ── Section open: explicit Product Lines eyebrow → headline, DIRECTLY — the
  //    brief bars any intro paragraph or transition copy, so the two
  //    must be adjacent in the visible text. ──
  assert.ok(
    vis.includes(
      "OUR PRODUCT LINES One Revenue Engine. Three Core Components.",
    ),
    "the section identifies OUR PRODUCT LINES directly before the existing headline — no intro paragraph between them",
  );
  checks += 1;
  assert.equal(
    vis.split("OUR PRODUCT LINES").length - 1,
    1,
    "OUR PRODUCT LINES renders exactly once as the section identity",
  );
  checks += 1;

  // ── The funnel, top to bottom, in one visible-text chain: numeral +
  //    dept + name + Title Case outcome headline + the one capability
  //    line per stage, three stages in engine order, terminating in the
  //    SIGNED CASES plaque — with NOTHING between the stages (no
  //    between-stage text, labels, or arrows: the chain match itself
  //    proves adjacency). ──
  const FUNNEL_CHAIN = [
    "01 MARKETING CASEGEN™ Create More of the Right Opportunities.",
    "Local Authority Optimization™ · Paid Search Control System™ · Review Velocity System™",
    "02 INTAKE CASEINTAKE™ Stop Qualified Leads From Disappearing.",
    "Answer faster · Guide consistently · Follow up · Remove friction",
    "03 SALES CASECONVERT™ Turn More Booked Consultations Into Signed Cases.",
    "Script the conversation · Strengthen the offer · Coach the execution",
    "SIGNED CASES",
    "Build a Revenue Engine That Produces More Signed Cases.",
    "Book Your High Impact Revenue Session",
  ].join(" ");
  assert.ok(
    vis.includes(FUNNEL_CHAIN),
    `the complete funnel chain renders in order with nothing interleaved: ${JSON.stringify(FUNNEL_CHAIN.slice(0, 120))}…`,
  );
  checks += 1;

  // Belt-and-suspenders on top of the chain — each stage's copy also
  // asserted individually so a failure names the missing piece:
  const stages = [
    {
      dept: "MARKETING",
      name: "CASEGEN™",
      headline: "Create More of the Right Opportunities.",
      caps: "Local Authority Optimization™ · Paid Search Control System™ · Review Velocity System™",
    },
    {
      dept: "INTAKE",
      name: "CASEINTAKE™",
      headline: "Stop Qualified Leads From Disappearing.",
      caps: "Answer faster · Guide consistently · Follow up · Remove friction",
    },
    {
      dept: "SALES",
      name: "CASECONVERT™",
      headline: "Turn More Booked Consultations Into Signed Cases.",
      caps: "Script the conversation · Strengthen the offer · Coach the execution",
    },
  ] as const;
  for (const s of stages) {
    expectVisible(s.headline, `${s.name} outcome headline`);
    expectVisible(s.caps, `${s.name} capability line`);
    assert.ok(
      vis.includes(`${s.dept} ${s.name}`),
      `${s.name} dept label sits directly above the product name`,
    );
    checks += 1;
  }
  assert.equal(
    vis.split("SIGNED CASES").length - 1,
    1,
    "SIGNED CASES renders exactly once — the plaque is the single terminal result",
  );
  checks += 1;

  // ── The funnel OBJECT is receipt- and flow-chrome-free: no arrows, no
  //    money, no percentages anywhere inside it (the remove list bars
  //    input/output labels, receipts, and traveling-flow decoration; the
  //    section's only → glyph belongs to the CTA button below). ──
  const objStart = region.indexOf("data-fn-object");
  const ctaStart = region.indexOf('class="nb-fn-cta"');
  assert.ok(objStart >= 0 && ctaStart > objStart, "funnel object precedes the CTA block");
  const objVis = visibleText(region.slice(objStart, ctaStart));
  assert.ok(
    !/[→$%]/.test(objVis),
    "no arrows, dollar figures, or percentages inside the funnel object",
  );
  checks += 2;
  assert.deepEqual(
    vis.match(/[0-9][0-9.,]*%/g) ?? [],
    [],
    "the product section is percent-free — the component receipts retired to /services/ (ledger rows 9/11/12)",
  );
  checks += 1;

  // ── Single CTA (brief: one primary CTA beneath the funnel), now using
  //    the homepage conversion hub's stable booking fragment. ──
  const ctaAnchors = region.match(/<a\b[^>]*href="#booking"/g) ?? [];
  assert.equal(
    ctaAnchors.length,
    1,
    "exactly one session-CTA anchor in the product section (its single CTA)",
  );
  checks += 1;
  assert.ok(
    !html.includes("High-Impact"),
    "the session name is never hyphenated anywhere on the page",
  );
  checks += 1;

  // ── Proof zone: ONE result-first Presti flagship + two compact supports
  //    + the two-sentence measurement disclosure (no slider); the REE strip
  //    that sat between the proof
  //    and testimonials bands was REMOVED by Task #4987 (zero REE
  //    mentions on the homepage — its copy joins the page ban list
  //    below); the testimonials band serves the complete 5-video +
  //    11-quote static grids (the #3997 endless marquee, restored by
  //    Task #4980 owner reversal — the served grids stay the no-JS /
  //    reduced-motion presentation). Figures are ledger-verified only —
  //    the brief's draft flagship numbers were never published
  //    (docs/website-copy-changelog.md 2026-08-18). ──
  const zone = sliceProofZone(html);
  const zvis = visibleText(zone);
  const testimonialsStart = zone.indexOf('<section class="nb-testimonials">');
  assert.ok(testimonialsStart > 0, "testimonials follow the proof band");
  const proof = zone.slice(0, testimonialsStart);
  const pvis = visibleText(proof);
  const expectZone = (copy: string, what: string): void => {
    assert.ok(zvis.includes(copy), `${what} renders: ${JSON.stringify(copy)}`);
    checks += 1;
  };
  const expectProof = (copy: string, what: string): void => {
    assert.ok(pvis.includes(copy), `${what} renders: ${JSON.stringify(copy)}`);
    checks += 1;
  };
  const zoneOnce = (copy: string, what: string): void => {
    assert.equal(
      zvis.split(copy).length - 1,
      1,
      `${what} renders exactly once: ${JSON.stringify(copy)}`,
    );
    checks += 1;
  };
  const proofOnce = (copy: string, what: string): void => {
    assert.equal(
      pvis.split(copy).length - 1,
      1,
      `${what} renders exactly once: ${JSON.stringify(copy)}`,
    );
    checks += 1;
  };

  proofOnce("PROOF, NOT PROMISES", "proof eyebrow");
  proofOnce(
    "What the Complete Engine Did for These Firms",
    "proof H2 (multi-firm proof framing)",
  );
  assert.ok(
    !/SEE MORE CASE STUDIES|VIEW CASE STUDY/.test(pvis),
    "proof band has no case-study-library controls",
  );
  checks += 1;
  proofOnce("THE COMPLETE ENGINE · FLAGSHIP CASE STUDY", "flagship sys tag");
  proofOnce(
    "— Michael Presti, The Presti Law Firm, PLLC",
    "flagship quote attribution",
  );
  const flagshipStart = proof.indexOf('<article class="nb-flag"');
  const flagshipEnd = proof.indexOf("</article>", flagshipStart);
  assert.ok(flagshipStart >= 0 && flagshipEnd > flagshipStart, "flagship article is complete");
  const flagship = proof.slice(flagshipStart, flagshipEnd);
  const fvis = visibleText(flagship);
  expectProof("The Presti Law Firm, PLLC", "flagship firm name");
  expectProof("IMMIGRATION LAW FIRM — DALLAS, TX", "flagship firm label");
  expectProof(PRESTI.headline, "flagship result headline (ledger #1)");
  assert.deepEqual(
    PRESTI.homepageFlagship.supportingStats,
    [
      ["LEADS", "3,600+"],
      ["FIVE-STAR REVIEWS GENERATED", "400+"],
    ],
    "proof source records the two supporting homepage markers",
  );
  assert.deepEqual(
    {
      stat: PRESTI.homepageFlagship.primaryStat,
      timeframe: PRESTI.homepageFlagship.primaryTimeframe,
    },
    { stat: ["CASES SIGNED", "292"], timeframe: "IN 6 MONTHS" },
    "proof source attaches the six-month timeframe only to the signed-case outcome",
  );
  assert.ok(
    fvis.includes(
      "292 CASES SIGNED IN 6 MONTHS 3,600+ LEADS 400+ FIVE-STAR REVIEWS GENERATED",
    ),
    "mobile/semantic order leads with signed cases, then supporting evidence",
  );
  assert.match(
    flagship,
    /<div class="nb-flag-primary">\s*<b>292<\/b>\s*<span>CASES SIGNED<\/span>\s*<p>IN 6 MONTHS<\/p>/,
    "the six-month label is structurally attached to the 292 signed-case outcome",
  );
  assert.ok(
    !fvis.includes("IN 12 MONTHS"),
    "the flagship rejects the superseded 12-month wording",
  );
  assert.ok(
    !fvis.includes("4.8 ★") && !fvis.includes("GOOGLE RATING"),
    "the canonical Google rating is not a homepage flagship marker",
  );
  expectProof(
    "\"[NoBull] has totally automated the intake & sales process for the attorneys. It’s very click-and-easy now.\"",
    "flagship sentence-boundary S8 quote excerpt",
  );
  assert.equal(
    (flagship.match(/class="nb-flag-evidence"/g) ?? []).length,
    2,
    "flagship renders exactly two supporting proof markers",
  );
  assert.equal(
    (flagship.match(/class="nb-flag-primary"/g) ?? []).length,
    1,
    "flagship renders exactly one dominant signed-case outcome",
  );
  checks += 9;

  // The two inline supports keep attribution context, one headline, and
  // exactly two figures each; no card merges figures across firms.
  proofOnce("CASEGEN™ RESULT · MARKETING", "Burns Smith support tag");
  expectProof(BURNS_SMITH.headline, "Burns Smith support headline");
  expectProof(
    "1,779 LEADS — FIRST FIVE MONTHS 50 FIVE-STAR REVIEWS",
    "Burns Smith support cells",
  );
  proofOnce("THE COMPLETE ENGINE · ALL THREE SYSTEMS", "Expansion support tag");
  expectProof(EXPANSION.headline, "Expansion support headline");
  expectProof(
    "$1.5M FIRST 100-CASE MONTH · COLLECTED REVENUE April 2026",
    "Expansion revenue milestone with its timeframe (ledger #7)",
  );
  expectProof(
    "3 LOCATIONS ADDED",
    "Expansion locations-added support figure",
  );
  const supportCells = [
    ...proof.matchAll(
      /<div class="nb-sup-cells">([\s\S]*?)<\/div>\s*<\/article>/g,
    ),
  ];
  assert.equal(supportCells.length, 2, "proof band renders two support tiles");
  for (const [index, match] of supportCells.entries()) {
    assert.equal(
      (match[1].match(/<div><b>/g) ?? []).length,
      2,
      `support tile ${index + 1} renders exactly two proof figures`,
    );
  }
  checks += 3;

  for (const removed of [
    "Demand was never the problem at The Presti Law Firm, PLLC",
    "CaseGen™, CaseIntake™, and CaseConvert™ — the complete engine",
    "Twelve months.",
    "FIRST LEAD",
    "MARKETING Created demand INTAKE Captured it SALES Closed it",
    "200 5-STAR REVIEWS",
    "513 — no plateaus, no down months.",
    "NEW LEADS PER MONTH",
    "DAY 0 Onboarding Call",
    BURNS_SMITH.quote.text,
    `— ${BURNS_SMITH.quote.name}, ${BURNS_SMITH.quote.firm}`,
    "One winning location became the launchpad.",
    "2,400+ LEADS — SIX-MONTH TOTAL",
    "228 5-STAR REVIEWS — SIX-MONTH TOTAL",
  ]) {
    assert.ok(!pvis.includes(removed), `removed proof detail stays out: ${removed}`);
  }
  checks += 14;
  assert.equal(
    (proof.match(/href="testimonials\/#case-studies"/g) ?? []).length,
    0,
    "no proof card links to a case-study library that does not exist",
  );
  checks += 1;
  // Band foot: one session CTA + the brief's two-sentence disclosure:
  assert.equal(
    (proof.match(/<a\b[^>]*href="#booking"/g) ?? []).length,
    1,
    "exactly one session-CTA anchor in the proof band (the proof foot's)",
  );
  checks += 1;
  proofOnce("HOW RESULTS ARE MEASURED", "measurement disclosure heading");
  expectProof(
    "Every result shown is one firm's tracked outcome over the stated period, not an average or a guarantee. See Data Notes & Definitions for the measurement basis.",
    "the two-sentence measurement disclosure, verbatim from the brief",
  );

  // (The REE strip's four beats — H2, SR definition sentence, levers,
  //  calculator CTA — were asserted here until Task #4987 removed the
  //  band; its copy is now banned page-wide in the removal group below.)

  // Testimonials — the #3997 endless-marquee band, restored by Task #4980
  // (owner reversal of #4925's static 3+3 curated set). The SERVED markup
  // is the complete static grid — five video cards + eleven review
  // quotes — and that grid IS the no-JS / reduced-motion presentation
  // (the marquee mode stamp stays runtime-only; removal list below).
  zoneOnce("Hear It From The Firms We Grow.", "testimonials H2");
  assert.equal(
    (zone.match(/class="nb-video-card"/g) ?? []).length,
    5,
    "all five video cards serve statically (Presti/Burns restored by #4980 — the owner accepted repeating the proof band's firms)",
  );
  assert.equal(
    (zone.match(/<blockquote class="nb-review">/g) ?? []).length,
    11,
    "all eleven written-quote cards serve statically",
  );
  checks += 2;
  for (const firm of [
    "Shields & Boris",
    "Covington & Associates",
    "Integrity Law",
    "Presti Law",
    "Burns Smith Law",
  ]) {
    expectZone(firm, "video card firm name");
  }
  expectZone(BORIS.quotes[0], "Tom Boris turnkey client testimonial");
  expectZone(BORIS.quotes[1], "Tom Boris Google-reviews client testimonial");
  expectZone(
    `— ${BORIS.name}, ${BORIS.firm}`,
    "Tom Boris testimonial attribution",
  );
  assert.match(
    zone,
    /data-featured-testimonial[^>]*data-featured-index="0"/,
    "featured testimonial begins on deterministic Tom Boris fallback",
  );
  assert.match(
    zone,
    /data-featured-toggle[^>]*hidden[^>]*>Pause rotation<\/button>/,
    "featured testimonial serves an initially hidden, progressively enhanced pause control",
  );
  checks += 2;
  zoneOnce("— Lani Akiona, Family Law Attorney", "role-footed quote attribution (Lani)");
  zoneOnce("— Tessa Thrift, Attorney", "role-footed quote attribution (Tessa)");
  zoneOnce(
    "— Stacy Grow, Law Firm Marketing Director",
    "role-footed quote attribution (Stacy)",
  );
  assert.equal(
    (zvis.match(/, Google Review/g) ?? []).length,
    8,
    'exactly the eight actual Google reviews are footed "Google Review" (truth-source §4 — the three role-footed quotes keep their on-file roles)',
  );
  checks += 1;
  expectZone(
    "the number of quality leads coming into my firm has grown month after month",
    "Lani quote outcome stem",
  );
  expectZone("from nothing to fully booked", "Tessa quote outcome stem");
  expectZone(
    "the return has far exceeded our expectations",
    "Stacy quote outcome stem",
  );

  // ── Removal list: retired material stays out of the whole page (HTML
  //    comments stripped first so history notes in markup comments could
  //    never mask a real regression). ──
  const pageNoComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const banned of [
    // #4992 funnel redesign — the engine story's class families, runtime
    // hooks, and anchors left with their markup (the funnel is the only
    // #system structure now):
    "nb-system",
    "nb-comp",
    "nb-custom",
    "nb-dg",
    "data-es-",
    "comp-casegen",
    // #4992 — the retired overview vocabulary (the new eyebrow drops the
    // ™; the funnel H2 still renders "Three Core Components" in Title
    // Case, so the ALL-CAPS bans here stay exact-case-safe):
    "THE LAW FIRM REVENUE ENGINE™",
    "Built in order. Connected from qualified lead to signed case.",
    "CONSULTATIONS THAT HAPPEN",
    // #5017 — the hero secondary's #4923 label retired when the hero
    // button became Read the Book → /free-chapters/ (the book-funnel
    // entry); #system stays reachable via the header Solutions link +
    // footer OUR SERVICES Revenue Engine link (anchors suite):
    "SEE THE THREE CORE COMPONENTS",
    // #4992 — the four-question component sections' copy retired with
    // their markup (headlines were ALL-CAPS; the funnel's are Title
    // Case, so exact-case bans are safe):
    "CREATE MORE OF THE RIGHT OPPORTUNITIES.",
    "STOP QUALIFIED PROSPECTS FROM DISAPPEARING.",
    "TURN MORE CONSULTATIONS INTO SIGNED CASES.",
    "CaseGen combines local search, paid search, and reviews",
    "CaseIntake installs the response, qualification, scheduling",
    "CaseConvert gives attorneys a repeatable consultation framework",
    "WHAT NOBULL BUILDS AND MANAGES",
    "WHAT CHANGES",
    "Lead routing, ownership, and response workflows",
    "Qualification and booking processes",
    "Missed-call, no-response, cancellation, and no-show recovery",
    "Tracking, scripts, and intake coaching",
    "Consultation framework and scripts",
    "Offer and engagement presentation",
    "Follow-up after the consultation",
    "Call recording, scorecards, and coaching",
    "Know which markets, searches, and channels",
    "Every lead has an owner, a status, a next action",
    "Know why prospects hire, where consultations stall",
    // #4992 — the receipts left the homepage (figures are /services/-only
    // marketing surfaces now; the lowercase composed caption cannot
    // collide with the Title Case support headlines):
    "ONE FIRM’S RESULT",
    "Lead growth in",
    "never an average",
    "Each number represents one real firm’s result",
    // #4992 — the customization band's copy retired with its markup:
    "BUILT AROUND THE FIRM YOU WANT TO GROW",
    "What goes inside them is built around your practice areas",
    "We build the engine your firm needs",
    "MEASURE THE CURRENT ENGINE",
    "IMPROVE THE NEXT CONSTRAINT",
    // #4923 restructure — the deleted handoff band and the simplified
    // overview's retired vocabulary stay out:
    "nb-handoff",
    "SEE THE SYSTEM",
    "The first handoff determines",
    "The Law Firm Revenue Engine™ connects all three.",
    "MARKETING → INTAKE",
    "INTAKE → SALES",
    "CREATE DEMAND",
    "CAPTURE OPPORTUNITY",
    "CONVERT TO REVENUE",
    "OUTPUT:",
    "They are built in that order",
    "CaseGen creates qualified demand.",
    // #4924 restructure — the retired capability triads, when-installed
    // blocks, stage-output rows/tags, next-component hand-offs, and the
    // replaced complete-engine recap (nb-recap) stay out:
    "nb-recap",
    "WHEN CASEGEN IS INSTALLED",
    "WHEN CASEINTAKE IS INSTALLED",
    "WHEN CASECONVERT IS INSTALLED",
    "STAGE OUTPUT",
    "Qualified opportunity created.",
    "Consultation secured.",
    "Case signed. Revenue created.",
    "NEXT: CASEINTAKE™",
    "NEXT: CASECONVERT™",
    "BE FOUND",
    "CONTROL DEMAND",
    "BUILD PROOF",
    "Capture Faster",
    "Guide Consistently",
    "Follow Through",
    "STRUCTURE THE CONVERSATION",
    "CLARIFY THE OFFER",
    "REVIEW AND COACH",
    "Proven Consultation Framework",
    "Strong Legal Services Offer",
    "Win the local searches that matter.",
    "Turn satisfied clients into compounding trust.",
    "CaseGen coordinates local authority",
    "Every lead receives a fast response",
    "repeatable process for diagnosing the need",
    "TURN THE CONSULTATION INTO A CLEAR DECISION",
    "EVERY IMPROVEMENT COMPOUNDS.",
    "CaseGen creates opportunity.",
    "Connecting all three makes every stage",
    "ATTRIBUTABLE REVENUE",
    "Know where opportunity comes from.",
    "Revenue is the outcome.",
    "FIND THE CONSTRAINT LIMITING",
    "what the complete build must address",
    // #4925 restructure (owner brief §§7–9) — the four-slide proof
    // slider, its rate cards + product cross-links, the retired proof
    // support line, and the REE example/connection tissue stay out:
    "nb-proof-track",
    "nb-proof-nav",
    "nb-proof-slide",
    "data-proof-",
    "Different Firms. Engines Tuned for Revenue.",
    "Every number is one real firm",
    "INTAKE, REBUILT",
    "CLOSE RATE, REBUILT",
    "Same Lead Flow. Nearly Twice the Consultations.",
    "From Booked Consultations to Signed Cases.",
    "HOW CASEINTAKE™ WORKS",
    "HOW CASECONVERT™ WORKS",
    "ILLUSTRATIVE MODEL",
    "$1 of growth investment in",
    "Revenue Engine Efficiency shows how efficiently",
    // (the #4925-era nb-ree-example / nb-ree-connect entries are subsumed
    //  by the whole-family "nb-ree" ban in the #4987 group below)
    // #4980 marquee restore: the band's [data-marquee] wrappers are back
    // in the served markup, but the mode stamp stays runtime-only — the
    // served static grids ARE the no-JS / reduced-motion presentation:
    "data-testi-mode",
    // #4837 removal list — retired cinematic/ribbon material:
    "OPEN THE HOOD",
    "ENGINE ROLE",
    "LIVE CLIENT RESULT",
    "Opening the hood",
    "Scroll to follow one opportunity",
    "THREE SYSTEMS. ONE REVENUE OUTCOME.",
    "What happens when each stage is tuned",
    "data-frame-base",
    "data-rec-",
    "data-stage-button",
    "data-mode=",
    "data-presentation=",
    "rec-section",
    "rec-pin",
    "rec-stage",
    "rec-hud",
    "nb-tuned",
    "revenue-engine/frames",
    // #4926 removal list — retired team-disclosure and the old contact-band
    // presentation. The conversion hub intentionally restores a new
    // data-nb-inquiry form with nb-contact-* classes, so only the superseded
    // row layout, old CTA copy, and old headline stay banned. Task #4979
    // resurrected the #4903 endless wall for the
    // full-roster band; Task #5011 then retired the wall for good —
    // wall-stem absence everywhere is the collapsed-grid contract
    // suite's job (see website-team-reveal-contract.test.ts). The
    // in-band session ask, the disclosure chrome, and the old headline
    // stay retired:
    "nb-team-ask",
    "nb-team-more",
    "nb-team-grid-rest",
    "nb-form-row",
    "SEND MESSAGE",
    "Not Ready To Book? Just Ask.",
    "HAVE A QUESTION?",
    "The People Behind The Engine.",
    // #4979 removal — the About roster text link is dropped (the
    // complete 18-person roster renders in-band; /about/ carries only
    // three bios, so the label over-promised):
    "MEET THE COMPLETE NOBULL TEAM",
    // #4987 removal list — the REE score strip left the homepage whole
    // (owner decision: zero REE mentions; the score is introduced
    // sitewide only on /calculator/) and the footer link was relabeled
    // Revenue Calculator. The strip's copy, markup family, and the old
    // footer label all stay out:
    "REVENUE ENGINE EFFICIENCY",
    "Revenue Engine Efficiency",
    "Revenue Is the Goal.",
    "REE Is the Score.",
    "WHAT MOVES THE SCORE",
    "CALCULATE YOUR REE",
    "REE Calculator",
    "nb-ree",
    "data-ree-",
  ]) {
    assert.ok(
      !pageNoComments.includes(banned),
      `retired engine-story/cinematic/ribbon/REE material stays out: ${banned}`,
    );
    checks += 1;
  }

  // ── Team band (Task #4979 owner directive — supersedes the #4926 §10
  //    five-person compression): the FULL 18-person roster renders
  //    in-band, led by Ronnie → Oliver → Brett → Jeff → Janno → Cam and
  //    then the prior relative order. The served grid is the complete
  //    presentation for every visitor (Task #5011 retired the
  //    #4903/#4979 endless wall; the collapsed-grid default + Meet the
  //    Full Team toggle are runtime-only — see
  //    website-team-reveal-contract.test.ts); the band carries NO
  //    booking CTA and no longer links to the 3-bio About page. ──
  const teamStart = pageNoComments.indexOf('<section class="nb-team">');
  assert.ok(teamStart >= 0, "team band present");
  const teamEnd = pageNoComments.indexOf("</section>", teamStart);
  assert.ok(teamEnd > teamStart, "team band closes");
  const teamBand = pageNoComments.slice(teamStart, teamEnd);
  checks += 1;

  assert.equal(
    (teamBand.match(/class="nb-team-card"/g) ?? []).length,
    18,
    "team band renders the complete 18-person roster",
  );
  checks += 1;

  let rosterCursor = -1;
  for (const { name, role } of TEAM_ROSTER) {
    const namePos = teamBand.indexOf(`<h3>${name}</h3>`);
    assert.ok(
      namePos > rosterCursor,
      `roster order (directive-first, then prior relative order): ${name}`,
    );
    const rolePos = teamBand.indexOf(role, namePos);
    assert.ok(
      rolePos > namePos && rolePos < namePos + 200,
      `role renders with ${name}: ${role}`,
    );
    rosterCursor = namePos;
    checks += 1;
  }

  assert.ok(
    !/<a\b[^>]*href="[^"]*book-free-demo\/"/.test(teamBand),
    "team band carries NO in-band booking CTA",
  );
  checks += 1;
  assert.ok(
    !/<a\b[^>]*href="[^"]*about\/"/.test(teamBand),
    "team band carries no About roster link (the complete roster is in-band)",
  );
  checks += 1;

  // ── About page consolidation: the committed generated page renders its
  //    company story and FAQ, then the complete 14-item practice-area
  //    destination, then the same canonical roster as the homepage and the
  //    booking band. It exposes only the three existing biographies and no
  //    First Lead Records or Recent News/resource-card blocks. This stays in
  //    the existing DB-free semantic suite rather than adding a second
  //    overlapping page-copy suite. ──
  const aboutHtml = readFileSync(ABOUT_HTML_PATH, "utf8");
  const aboutNoComments = aboutHtml.replace(/<!--[\s\S]*?-->/g, "");
  const aboutVis = visibleText(aboutNoComments);
  const storyStart = aboutNoComments.indexOf('<section class="pride">');
  const storyEnd = aboutNoComments.indexOf("</section>", storyStart);
  const practiceStart = aboutNoComments.indexOf(
    '<section class="industries" id="practice-areas-served"',
  );
  const aboutTeamStart = aboutNoComments.indexOf('<section class="team">');
  const aboutTeamEnd = aboutNoComments.indexOf("</section>", aboutTeamStart);
  const bookingStart = aboutNoComments.indexOf('<section class="demo-band">');
  assert.ok(
    storyStart >= 0 &&
      storyEnd > storyStart &&
      storyEnd < practiceStart &&
      practiceStart < aboutTeamStart &&
      aboutTeamEnd < bookingStart,
    "About flows from its company story and FAQ to Practice Areas Served to the complete team section to the booking band",
  );
  assert.equal(
    (
      aboutNoComments
        .slice(storyStart, storyEnd)
        .match(/<details class="nb-faq-item">/g) ?? []
    ).length,
    3,
    "About keeps all three existing FAQ disclosures with the company story",
  );
  assert.ok(
    !aboutVis.includes("First Lead Records") &&
      !aboutNoComments.includes('class="flr"') &&
      !aboutVis.includes("Recent News") &&
      !aboutNoComments.includes('class="news-section"') &&
      !aboutNoComments.includes('class="news-card"'),
    "About contains neither the First Lead Records proof strip nor Recent News resource cards",
  );
  checks += 3;
  assert.ok(
    aboutTeamStart >= 0 && aboutTeamEnd > aboutTeamStart,
    "generated About page contains the complete team section",
  );
  const aboutTeam = aboutNoComments.slice(aboutTeamStart, aboutTeamEnd);
  assert.equal(
    (aboutTeam.match(/class="team-card"/g) ?? []).length,
    TEAM_ROSTER.length,
    "About renders one card for every canonical team member",
  );
  checks += 2;

  let aboutRosterCursor = -1;
  for (const member of TEAM_ROSTER) {
    const namePos = aboutTeam.indexOf(`<h3>${member.name}</h3>`);
    assert.ok(
      namePos > aboutRosterCursor,
      `About roster follows canonical homepage order: ${member.name}`,
    );
    assert.ok(
      aboutTeam.includes(
        `src="../nobull-redesign/team/${member.img}" alt="${member.name}"`,
      ),
      `About uses the canonical homepage photo for ${member.name}`,
    );
    const rolePos = aboutTeam.indexOf(member.role, namePos);
    assert.ok(
      rolePos > namePos && rolePos < namePos + 240,
      `About renders the canonical role with ${member.name}: ${member.role}`,
    );
    if (member.bio) {
      assert.ok(
        visibleText(aboutTeam).includes(member.bio),
        `About keeps the existing biography available for ${member.name}`,
      );
    }
    aboutRosterCursor = namePos;
    checks += member.bio ? 4 : 3;
  }
  assert.equal(
    (aboutTeam.match(/<details class="team-bio">/g) ?? []).length,
    TEAM_ROSTER.filter((member) => member.bio).length,
    "only the three existing biographies are offered; no new biographies are invented",
  );
  checks += 1;

  assert.equal(
    (aboutNoComments.match(/id="practice-areas-served"/g) ?? []).length,
    1,
    "About exposes one stable #practice-areas-served destination",
  );
  const practiceEnd = aboutNoComments.indexOf("</section>", practiceStart);
  assert.ok(
    practiceStart >= 0 && practiceEnd > practiceStart,
    "practice-area destination is a complete semantic section",
  );
  const practiceSection = aboutNoComments.slice(practiceStart, practiceEnd);
  const practiceVis = visibleText(practiceSection);
  assert.ok(
    practiceSection.includes(
      '<h2 id="practice-areas-served-heading">Practice Areas Served</h2>',
    ),
    'section heading is exactly "Practice Areas Served"',
  );
  assert.ok(
    practiceVis.includes("Our Marketing, Intake, and Sales services"),
    "practice-area introduction uses the decided Marketing, Intake, and Sales services framing",
  );
  assert.equal(
    (practiceSection.match(/<li>/g) ?? []).length,
    INDUSTRIES.length,
    "practice-area list has exactly the canonical 14 entries",
  );
  let practiceCursor = -1;
  for (const practice of INDUSTRIES) {
    const practicePos = practiceSection.indexOf(`<li>${practice}</li>`);
    assert.ok(
      practicePos > practiceCursor,
      `About practice list follows the canonical order: ${practice}`,
    );
    practiceCursor = practicePos;
    checks += 1;
  }
  assert.ok(
    !practiceSection.includes("View All Industries Served") &&
      !/href="[^"]*services\//.test(practiceSection),
    "practice list is complete in context with no services-page dependency",
  );
  assert.ok(
    !aboutVis.includes("Industries Served") &&
      !aboutVis.includes("digital marketing services"),
    "retired About naming and service framing stay out",
  );
  checks += 8;

  // ── Footer conversion hierarchy: each implementation places the filled
  //    session action before the outlined book action, while COMPANY keeps
  //    only informational navigation links. ──
  const assertFooterActions = (
    footerMarkup: string,
    sessionHref: string,
    bookHref: string,
    label: string,
  ): void => {
    const actionStart = footerMarkup.indexOf('<div class="nb-footer-actions">');
    const actionEnd = footerMarkup.indexOf("</div>", actionStart);
    assert.ok(
      actionStart >= 0 && actionEnd > actionStart,
      `${label} footer contains the dedicated action group`,
    );
    const actions = footerMarkup.slice(actionStart, actionEnd);
    const session = `<a class="nb-btn nb-footer-session" href="${sessionHref}">Book a High Impact Revenue Session`;
    const book = `<a class="nb-btn-outline nb-footer-book" href="${bookHref}">Read the Book`;
    assert.ok(
      actions.includes(session) && actions.includes(book) && actions.indexOf(session) < actions.indexOf(book),
      `${label} footer presents the filled session primary before the outlined book secondary`,
    );
    assert.equal(
      (footerMarkup.match(new RegExp(`href="${sessionHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")) ?? []).length,
      1,
      `${label} footer has one session destination, in the action group only`,
    );
    const companyStart = footerMarkup.indexOf("<h4>COMPANY</h4>");
    const companyEnd = footerMarkup.indexOf("</div>", companyStart);
    assert.ok(
      companyStart >= 0 &&
        companyEnd > companyStart &&
        !footerMarkup.slice(companyStart, companyEnd).includes("Book a High Impact Revenue Session"),
      `${label} COMPANY column has no low-emphasis session link`,
    );
    checks += 4;
  };
  const homeFooterStart = pageNoComments.indexOf('<footer id="footer" class="nb-footer">');
  const homeFooterEnd = pageNoComments.indexOf("</footer>", homeFooterStart);
  assert.ok(homeFooterStart >= 0 && homeFooterEnd > homeFooterStart, "homepage footer renders");
  assertFooterActions(
    pageNoComments.slice(homeFooterStart, homeFooterEnd),
    "#booking",
    "free-chapters/",
    "homepage",
  );
  // Task #5092: /book-free-demo/ is retired; shared subpage footer session
  // action now uses the depth-correct homepage #booking anchor.
  assertFooterActions(
    footer("../"),
    "../#booking",
    "../free-chapters/",
    "shared subpage",
  );
  checks += 1;

  // ── Page-wide booking budget: the standalone close CTA and conversion
  //    chooser retired together. The remaining six destinations are the
  //    established direct booking paths, including the header's twin. ──
  assert.equal(
    (pageNoComments.match(/<a\b[^>]*href="#booking"/g) ?? []).length,
    6,
    "page-wide booking destinations hold: only the six established direct paths target #booking",
  );
  checks += 1;

  // ── The FAQ → book → conversion close is the final narrative. The close
  //    itself owns title/copy and leads straight into the booking-first grid;
  //    there is no redundant button chooser or standalone closing structure. ──
  const faqAt = pageNoComments.indexOf('<section class="nb-faq-sec">');
  const bookAt = pageNoComments.indexOf('<section id="book" class="nb-book-sec">');
  const conversionAt = pageNoComments.indexOf('<section class="nb-conversion"');
  assert.ok(faqAt >= 0 && faqAt < bookAt && bookAt < conversionAt, "FAQ → book → final conversion close order holds");
  const conversionEnd = pageNoComments.indexOf(
    "</main>",
    conversionAt,
  );
  assert.ok(conversionEnd > conversionAt, "the complete final conversion section closes before main");
  const conversion = pageNoComments.slice(conversionAt, conversionEnd);
  assert.ok(
    conversion.includes('<div class="nb-conversion-close">') &&
      conversion.includes('id="nb-conversion-head" class="nb-serif">Ready to Build Your Revenue Engine?</h2>') &&
      conversion.includes("You're already paying to create opportunity.") &&
      conversion.includes("Sound like a fit? The session is free"),
    "final conversion close keeps the established title and supporting copy",
  );
  assert.ok(
    conversion.indexOf('<section id="booking"') < conversion.indexOf('<section id="contact"') &&
      conversion.includes('<div class="nb-conversion-grid">'),
    "final conversion grid keeps booking first, then contact",
  );
  assert.ok(
    conversion.includes('class="nb-booking-handoff"') &&
      conversion.includes('target="_blank" rel="noopener" aria-describedby="nb-booking-external">View Available Times') &&
      !conversion.includes("calendly-inline-widget") &&
      !conversion.includes("assets.calendly.com") &&
      conversion.includes('<noscript><p class="nb-conversion-noscript">'),
    "booking surface keeps the compact external handoff and no-JavaScript recovery without an embed dependency",
  );
  assert.ok(
    conversion.includes('<form class="nb-contact-form" data-nb-inquiry="contact" data-success=') &&
      conversion.includes('name="website" tabindex="-1" autocomplete="off"') &&
      ["nb-contact-name", "nb-contact-email", "nb-contact-phone", "nb-contact-message"].every(
        (id) => conversion.includes(`for="${id}"`) && conversion.includes(`id="${id}"`),
      ) &&
      conversion.includes('class="nb-contact-captcha" data-nb-captcha') &&
      conversion.includes('<button class="nb-btn" type="submit">Send Message') &&
      conversion.includes('class="nb-contact-status" data-nb-form-msg role="status" aria-live="polite"'),
    "contact surface keeps labels, honeypot, reCAPTCHA, submit, success/error status, and inquiry hooks",
  );
  for (const retired of ["nb-closing", "nb-close-ask", "nb-close-cta", "nb-conversion-choice", "Choose the Conversation That Fits."]) {
    assert.ok(!pageNoComments.includes(retired), `${retired} stays retired from the final conversion flow`);
  }
  checks += 5;

  console.log(
    `OK website-engine-story-semantic-content: ${checks} copy assertions + CTA/percent/removal guards over ${HTML_PATH}`,
  );
}

main();
