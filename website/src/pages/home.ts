// Redesigned homepage — graduated 2026-08 from the approved canvas mockup
// (artifacts/mockup-sandbox/src/components/mockups/nobull-homepage/Homepage.tsx).
// Self-chromed page (chrome: false): it ships its own NoBull header/footer and
// loads assets/css/home.css + assets/js/home.js instead of site.css/site.js.
//
// Section order (Task #3895 storytelling arc — Hook → Problem → Belief shift
// → Mechanism → Proof → Plan → Who → Ask; Task #4261 leads with outcomes;
// Task #4837 owner decision REPLACED the pinned Revenue Engine cinematic
// with the normal-scrolling engine story — "I would remove the cinematic
// entirely and rebuild this as a normal-scrolling presentation of the three
// core components" (attached_assets/
// Pasted-I-would-remove-the-cinematic-entirely-and-rebuild-this-_1786976924006.txt).
// #4837 deliberately supersedes the #4816 cinematic placement, the #4295
// six-scene capability-first brief, the #4301 pinned/sequence presentation
// axes, the #3998→#4816 OPEN THE HOOD cue + light→dark seam, and the
// #4259→#4816 tuned proof ribbon — the ribbon's three receipts moved INSIDE
// the engine story's component sections, and the retired
// nobull-revenue-engine-cinematic skill is tombstoned):
// hero → credibility rail (press logos + the four outcome aggregates in ONE
// compact band, Task #4816 — merged from the #4261 press strip + metrics
// pair) → gap (closes on the handoff-diagnosis line since Task #4923 —
// owner brief 2026-08-18 §3, attached_assets/Pasted-The-page-is-directionally
// -much-better-than-the-cinemati_1787000455136.txt, moved the diagnosis INTO
// the gap band's closer and DELETED the #4837 standalone handoff transition
// band) → product section
// (#system, Task #4992 owner funnel brief — ONE continuous top-down
// funnel object: OUR PRODUCT LINES eyebrow + "One Revenue
// Engine. Three Core Components." over three stacked, touching,
// angle-edged stages (CaseGen/MARKETING → CaseIntake/INTAKE →
// CaseConvert/SALES) narrowing into the gold-edged SIGNED CASES plaque,
// then the section's single session CTA. Replaces the #4837/#4923/#4924
// engine story wholesale: the charcoal overview, the three component
// sections with diagrams + receipts, the CSS-sticky 01/02/03 index, and
// the dark customization band are ALL retired. Scroll focuses the stage
// nearest the reader's viewport zone — nothing pins, no loops or particles,
// motion gated on prefers-reduced-motion, in home-client/engineStory.ts;
// #casegen / #caseintake / #caseconvert component fragments align their named
// stage to that zone for motion-enabled visitors while the served, fully
// readable markup remains the reduced-motion/no-JS fallback) →
// proof (#proof — ONE result-first Presti flagship + two compact supporting
// receipts; Task #5134 distilled the complete inline stories from #5068
// without changing their verified proof register, and Task #4925 replaced
// the #3915/#4261 four-slide slider; post-proof session CTA +
// How Results Are Measured disclosure, two-sentence form; the REE score
// strip that followed it — #4120 → #4166 → #4816 → #4925 — was REMOVED
// wholesale by Task #4987, owner decision: ZERO REE mentions on the
// homepage; the score is introduced sitewide only on /calculator/ now) →
// testimonials (Tom Boris's two static statements precede the #3997 endless
// marquee since Task #5068; the marquee was retired by #4925 brief §9's
// static curated set and restored by Task #4980 owner reversal — 5 named
// videos + 11 review quotes in three time-based loops for motion-allowed
// visitors; the served static material stays the complete
// no-JS/reduced-motion presentation) → team (FULL
// 18-person roster, Task #4979 owner directive — led by Ronnie → Oliver
// → Brett → Jeff → Janno → Cam with the rest in prior relative order,
// presented as a calm static grid that opens collapsed to its first
// two rows behind a Meet the Full Team toggle (teamReveal.ts, Task
// #5011 — the #4979/#4903 endless wall is RETIRED, owner verdict: it
// didn't look good; the served 18-card grid stays the complete no-JS
// presentation), still under ONE TEAM RESPONSIBLE FROM
// FIRST CLICK TO SIGNED CASE and still NO in-band CTA; supersedes the
// #4926 §10 five-person compression + its About roster link; the #4926
// brief-§11 session-offer band that followed team — the free-session
// lede + the you-leave-knowing card, NO booking CTA — was REMOVED by
// Task #5016, owner request: the hero session-explainer note and the
// homepage booking section carries the session facts) → fit (nb-fit, Task #4926,
// brief §12 — the gold-vs-crimson
// verdict pair re-homed OUT of the closing band, both lists rewritten to
// the brief, resolving the old lead-generation contradiction; stacking
// at ≤1000px) → faq (nb-faq-sec, Task #4926, brief §13 — cut to the six
// buying questions; its old #4261 contact band stays retired) → book
// (#book — existing lower-commitment handoff, now placed directly after
// FAQ so it prepares the final decision without interrupting it) → conversion
// close (#booking + #contact — the “Ready to Build Your Revenue Engine?”
// title treatment and supporting close copy lead directly into the canonical
// Calendly scheduler and shared protected inquiry form; the redundant chooser
// and standalone closing booking CTA are retired) → footer.
// docs/website-final-copy.md mirrors this order — keep the two in lockstep.
//
// Task #3908 (repetition & hand-off): every recurring claim has ONE owning
// section — hero: agency contrast + the Marketing/Intake/Sales one-system
// claim; gap: the same-leads model + the handoff diagnosis (Task #4259 owner
// direction replaced the #3949 leads-are-fuel kicker; the #4837 handoff
// transition band extended it until Task #4923 retired that band and made
// the diagnosis line the gap band's own closer); REE: owned by NO
// homepage section — Task #4987 removed the score strip (the definition +
// formula + four-lever band; #4120/#4259/#4295/#4837/#4924/#4925 history
// in the copy changelog) and relabeled the footer calculator link, so the
// homepage never names the score; /calculator/ is REE's only sitewide
// introduction and working surface (ledger #38/#39); ROI FAQ: click-to-close
// tracking; book band: "wrote the book". The three per-stage live-result
// receipts left the homepage with the engine story (Task #4992 — the
// funnel brief's remove list bars receipts, body paragraphs, and
// per-product proof from the product section): the 2× lead-growth /
// consult-rate / case-rate figures now remain only in /data-notes/ as
// provenance records after the standalone services page retirement
// (claim ledger rows 9/11/12 record the current surfaces). See
// docs/website-copy-changelog.md (2026-08-06, Task #3908; 2026-08-17,
// Task #4837; 2026-08-18, Tasks #4925 + #4992).
//
// Task #4166 (homepage distill): the REE strip compressed into the page's
// scoreboard moment — a history that ran #4166 → #4259 → #4816 → #4925
// (scoreboard plate, connective tissue, four terminal beats; details in
// the copy changelog) and ENDED with Task #4987: the strip band is
// REMOVED wholesale — owner decision, zero REE mentions on the homepage;
// the explainer lede and the ROAS paragraph are GONE (owner, 2026-08-09:
// "lawyers don't think in ROAS" — ROAS is banned sitewide, guarded by
// tests/lint-website-banned-phrases.test.ts), and ledger #38 stays
// WITHHELD (the score's only remaining illustration is the visitor's own
// numbers on /calculator/). The gap band's WHERE IT
// LEAKS / HOW IT'S TUNED strip folded into the duel chart's shortfall
// captions (+ the .nb-vh summary's closing sentence), and the
// proof/book/closing/contact ledes were cut where they restated their own
// headings. Copy record: docs/website-final-copy.md +
// docs/website-copy-changelog.md (2026-08-09, Task #4166; 2026-08-18,
// Task #4987).
//
// Task #3997 (endless testimonials — retired by the #4925 restructure's
// static curated set, restored in full by Task #4980 owner reversal): the
// testimonials band serves ALL five client videos + eleven review quotes
// as static grids, and home-client/testimonialsMarquee.ts turns the three
// [data-marquee] rows into seamless time-based loops for motion-allowed
// visitors (quote row B counter-scrolls). Quote data lives in
// QUOTE_ROW_A/B triples; sources + anonymization policy in
// docs/CONTENT_TRUTH_SOURCE.md §4.
//
// Mobile hardening (Task #3795): the header carries a small-screen disclosure
// menu (.nb-nav-toggle, wired in home.js, styled ≤850px only), hero preloads
// are viewport-conditional so phones fetch the compressed WebP derivatives
// (scripts/generate-marketing-hero-variants.ts) instead of the ~3.5MB PNGs,
// and every lazy image carries intrinsic width/height (CLS).

import {
  CALENDLY_URL,
  PageDef,
  assetV,
  dimsAttr,
  esc,
  skipLink,
} from "../html";
import {
  BORIS,
  BURNS_SMITH,
  CLIENTS,
  EXPANSION,
  GAP_MODEL,
  LEADS_GENERATED,
  PRESTI,
  REVENUE_GENERATED,
} from "../proof";
import { BOOK_STORES, BOOK_STORE_STATUS } from "../bookLinks";
import { TEAM_ROSTER, type TeamMember } from "../team";

const ARROW = `<span aria-hidden="true">→</span>`;

const prestiQuoteExcerpt = (): string => {
  const excerpt = PRESTI.quote.text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ");
  if (!excerpt.endsWith(".")) {
    throw new Error("Presti quote no longer has a two-sentence excerpt");
  }
  return excerpt;
};
const PRESS_LOGOS: ReadonlyArray<readonly [string, string]> = [
  ["aba.png", "American Bar Association"],
  ["nadp.png", "National Association of Divorce Professionals"],
  ["profit-with-law.png", "Profit with Law"],
  ["law-firm-growth-summit.png", "Law Firm Growth Summit"],
  ["wealthy-woman-lawyer.png", "Wealthy Woman Lawyer"],
];

const pressLogoTag = (r: string, [img, name]: readonly [string, string]): string =>
  `<img class="nb-press-logo" src="${nbAsset(r, `press/${img}`)}" alt="${esc(name)}" loading="lazy"${nbDims(`press/${img}`)}>`;

// Credibility metrics (Task #4261, owner doc §2 — outcome-first): the band
// sits right after the press strip now, before The Gap, and leads with the
// money result. Wording rules: "$150M+" pairs with "In New Client Revenue"
// (ledger #17 — client firms' revenue, never NoBull's own); the firm count
// reads cumulatively as "Law Firms Worked With" (ledger #13 — never
// "Grown", never an active-client framing); leads are always "Generated",
// never "Reviewed" (ledger #16). REVIEWS_GENERATED (30,000+, ledger #35)
// is the sanctioned alternate for slot 4 if the owner prefers reviews.
const METRICS: ReadonlyArray<readonly [string, string]> = [
  [REVENUE_GENERATED.stat, "In New Client Revenue"],
  [CLIENTS.stat, "Law Firms Worked With"],
  ["10+", "Years of Results"],
  [LEADS_GENERATED.stat, "Leads Generated"],
];

// Count-up markup for one stat: static currency-prefix / unit-suffix spans
// around the [data-count-to] digits — statsBand.ts rewrites ONLY the digit
// span, so "$150M+" animates 0→150 with the $, M and gold + pinned — plus
// the full stat repeated visually-hidden for screen readers / no-JS.
function metricStat(stat: string): string {
  const m = /^(\$?)([\d,]+)([A-Za-z]*)(\+?)$/.exec(stat);
  if (!m) return esc(stat);
  const prefix = m[1] ? `<span aria-hidden="true">${m[1]}</span>` : "";
  const suffix = m[3] ? `<span aria-hidden="true">${esc(m[3])}</span>` : "";
  const plus = m[4]
    ? `<span class="nb-metric-plus" aria-hidden="true">+</span>`
    : "";
  return (
    prefix +
    `<span class="nb-count" data-count-to="${m[2].replace(/,/g, "")}" aria-hidden="true">${esc(m[2])}</span>` +
    suffix +
    plus +
    `<span class="nb-vh">${esc(stat)}</span>`
  );
}
// All five named client-voice videos (truth source §5). Presti Law + Burns
// Smith joined 2026-08-07 (Task #3997): both already embedded on
// /testimonials/, identified via their Vimeo oEmbed titles; the committed
// posters are the videos' own public Vimeo poster frames, finished with the
// same paused-player treatment (dark-leaning still + white play chip) as the
// original trio. Task #4925 had trimmed the band to a trio distinct from
// the proof band's case-study firms; the owner's #4980 full-restore
// decision knowingly repeats Presti + Burns here beside their case-study
// appearances — reversal recorded in docs/website-copy-changelog.md
// (2026-08-18). Cards stay plain outbound anchors — no embeds here (the
// original trio's embeds are domain-locked and render "Sorry" iframes
// off-domain).
const VIDEO_TESTIMONIALS: ReadonlyArray<readonly [string, string, string]> = [
  ["shields-boris.png", "Shields & Boris", "https://vimeo.com/898391761"],
  ["covington.png", "Covington & Associates", "https://vimeo.com/701775821"],
  ["integrity.png", "Integrity Law", "https://vimeo.com/898392089"],
  ["presti-law.png", "Presti Law", "https://vimeo.com/1106263914"],
  ["burns-smith.png", "Burns Smith Law", "https://vimeo.com/1106262623"],
];

type ReviewQuote = readonly [text: string, name: string, attribution: string];

type FeaturedClientQuote = Readonly<{
  paragraphs: readonly string[];
  name: string;
  attribution: string;
}>;
const FAQ: ReadonlyArray<readonly [string, string]> = [
  [
    "Do we need all three components at once?",
    "No. We install the engine in a fixed order: Marketing, then Intake, then Sales. A stage that is already well established can move through its work faster, but it does not change the sequence. Engagements are incremental: we normally cover one stage at a time, with no more than two active at once. All three feed the same click-to-close measurement, so each stage you add joins numbers that are already running.",
  ],
  [
    "Will we need to replace our current team or software?",
    "Not by default. The engine installs around the people and tools you already have: CaseIntake™ builds answering, follow-up, and booking systems around your intake team, and CaseConvert™ scripts, records, and coaches the consultation your attorneys already run. We generally build around your existing software rather than prescribing change. If a tool is materially inadequate or obstructs the system, we will recommend replacing it.",
  ],
  [
    "What does NoBull handle, and what does our firm handle?",
    "Your firm needs three owners: a decision-maker empowered to make and enforce the changes the engine needs, an Intake owner, and a Sales owner. NoBull does the hands-on implementation: we get campaigns live, configure and improve your CRM software, coordinate supporting vendors such as call-answering services, and measure results from first click to signed case. You keep practicing law; running the engine is our job. But the work cannot succeed if necessary decisions cannot be made and enforced.",
  ],
  [
    "How long does implementation take?",
    "CaseGen™ is typically fully launched within 21 days and profitable within 60 days. CaseIntake™ is typically launched within 90 days and in fine-tuning within 180 days. CaseConvert™ is typically launched within 30 days and seeing profitable ROI within 90 days. These are typical expectations, not guarantees. Client implementation pace is the number-one timing factor, and NoBull will go as fast as your firm allows.",
  ],
  [
    "How do you track leads, consultations, signed cases, and revenue?",
    "We use WhatConverts for complete lead tracking and lead scoring. Visibility into Intake and Sales outcomes depends on your firm's software and how consistently it is used. We go as deep as the available data allows to report outcomes and improve your marketing campaigns. Where your data can't support a precise revenue number, we say so and give you the best honest estimate instead of a guess.",
  ],
  [
    "What does working with NoBull cost?",
    "It depends on which components your firm needs — the engine is scoped component by component, not sold as a one-size package, and we don't publish a flat rate. The free High Impact Revenue Session is where the number gets real: it puts an estimated value on the constraint we'd be fixing, so you can weigh the investment with your own numbers in front of you.",
  ],
];

/** Asset under the redesign asset root, relative to the page. */
const nbAsset = (r: string, rest: string): string =>
  `${r}nobull-redesign/${rest}`;

/** Intrinsic width/height attributes for a redesign asset (CLS). */
const nbDims = (rest: string): string => dimsAttr(`nobull-redesign/${rest}`);

/** One team-roster card — the single 18-card grid renders these (Task
    #4979 roster; presentation Task #5011): the grid is the ONLY
    presentation now — home-client/teamReveal.ts never moves or clones
    these nodes, it only collapses the grid's tail rows via the
    data-team-collapsed CSS state. */
const teamCard = (r: string) => ({ img, name, role }: TeamMember): string => `      <div class="nb-team-card">
        <img src="${nbAsset(r, `team/${img}`)}" alt="${esc(name)}" loading="lazy"${nbDims(`team/${img}`)}>
        <h3>${esc(name)}</h3>
        <span class="nb-team-role">${esc(role)}</span>
      </div>`;

/** Book cover art: ≤850px gets the resized mobile WebP, wider viewports the
    full-resolution WebP re-encode. Both are derived from the untouched
    standalone front-cover.jpg export, which remains the <img> fallback and
    canonical source (never a crop from a print-wrap proof). */
const bookCoverPicture = (
  r: string,
  imgAttrs: string,
): string => `<picture class="nb-picture">
        <source media="(max-width: 850px)" type="image/webp" srcset="${nbAsset(r, "brand/law-firm-revenue-engine-cover-mobile.webp")}">
        <source type="image/webp" srcset="${nbAsset(r, "brand/law-firm-revenue-engine-cover.webp")}">
        <img ${imgAttrs}${nbDims("brand/front-cover.jpg")}>
      </picture>`;

/** One funnel stage, top-down order. Copy is the 2026-08-18 owner
    brief's, verbatim — Title Case outcome headlines, capability lines
    exactly as given (CaseGen's carries the three ™ system names). The
    brief rules out body paragraphs, so there is deliberately no
    lede/description field here. */
type FunnelStageSpec = {
  key: string; // data-fn-stage token (casegen / caseintake / caseconvert)
  num: string; // 01 / 02 / 03 — the translucent background numeral
  dept: string; // small component label: MARKETING / INTAKE / SALES
  name: string; // CASEGEN™ / CASEINTAKE™ / CASECONVERT™
  headline: string; // outcome-oriented headline (Title Case, serif)
  caps: string; // one compact capability line (· separated)
  art: () => string; // engraved stage emblem — text-free inline SVG
};
export const homePage: PageDef = {
  path: "",
  title: "NoBull Marketing — Law Firm Revenue, Engineered",
  desc:
    "More leads aren't enough. NoBull Marketing installs The Law Firm Revenue Engine™ — more revenue from the same leads, measured from first click to signed case.",
  priority: "1.0",
  chrome: false,
  bodyClass: "nb-page",
  // Hero preloads are viewport-conditional and all-WebP (Task #4127):
  // desktop preloads the full-resolution WebP re-encodes of the approved art,
  // ≤850px the compressed mobile derivatives it actually renders — no
  // viewport downloads the multi-MB source artwork.
  headExtra: (r) => `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/home.css${assetV()}">
<link rel="preload" as="image" href="${r}nobull-redesign/brand/machinery-hero.webp" type="image/webp" media="(min-width: 851px)">
<link rel="preload" as="image" href="${r}nobull-redesign/brand/law-firm-revenue-engine-cover.webp" type="image/webp" media="(min-width: 851px)">
<link rel="preload" as="image" href="${r}nobull-redesign/brand/machinery-hero-mobile.webp" type="image/webp" media="(max-width: 850px)">
<link rel="preload" as="image" href="${r}nobull-redesign/brand/law-firm-revenue-engine-cover-mobile.webp" type="image/webp" media="(max-width: 850px)">`,
  bodyEnd: (r) => `
<script src="${r}assets/js/home.js${assetV()}" defer></script>`,
  render: (r) => `
${skipLink()}
<header class="nb-header">
  <div class="nb-wrap nb-nav">
    <a href="${r || "./"}" aria-label="NoBull Marketing home">
      <img class="nb-logo" src="${nbAsset(r, "brand/nobull-logo-full-color.svg")}" alt="NoBull Marketing — The Law Firm Experts" width="156" height="37">
    </a>
    <nav id="nb-menu" class="nb-links" aria-label="Main navigation">
      <a href="${r}about/#practice-areas-served">Practice Areas Served</a>
      <a href="#proof">Results</a>
      <a href="${r}about/">About</a>
      <a href="${r}resources/">Resources</a>
      <a class="nb-btn nb-menu-cta" href="#booking">Book a High Impact Revenue Session ${ARROW}</a>
      <a class="nb-btn-outline nb-menu-book" href="${r}free-chapters/">Read the Book ${ARROW}</a>
    </nav>
    <!-- Book secondary (Task #5017, owner request): outlined "Read the
         Book" beside the session ask on the persistent chrome. Desktop
         shows nb-nav-book only where it fits (width-gated in home.css);
         at hamburger widths the menu twin (nb-menu-book, above) carries
         it. Not a booking ask — the session budget counts the stable
         homepage #booking destination only. -->
    <a class="nb-btn-outline nb-nav-book" href="${r}free-chapters/">Read the Book ${ARROW}</a>
    <a class="nb-btn nb-nav-cta" href="#booking">Book a High Impact Revenue Session ${ARROW}</a>
    <button class="nb-nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nb-menu">
      <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
    </button>
  </div>
</header>

<main id="main" tabindex="-1">

<div class="nb-hero-outer">
  <section class="nb-wrap nb-hero">

    <div class="nb-hero-copy">
      <div class="nb-eyebrow">
        <i class="nb-rule"></i>
        LAW FIRM REVENUE, ENGINEERED.
      </div>

      <h1 class="nb-h1">
        <span class="nb-h1-l1">More Leads Aren't Enough.</span>
        <span class="nb-h1-l2">We Turn Them Into</span>
        <span class="nb-h1-l3">Signed Cases.</span>
      </h1>

      <p class="nb-lede">
        Most agencies stop at the lead. NoBull builds and manages the
        Marketing, Intake, and Sales systems that move qualified prospects
        from first click to signed case — and measures the revenue
        produced at every stage.
      </p>

      <!-- Secondary CTA is an OUTLINED button since Task #4816 (owner
           feedback: the quiet text link read as decoration). Task #5017
           (owner request, 2026-08-18) points it at the BOOK: Read the
           Book → /free-chapters/, wiring the book funnel (cover → free
           chapters → session, owner doc §3) into the hero pair — the
           same destination as the book-cover link across the split.
           Label history: SEE THE SYSTEM (#4816) → SEE THE THREE CORE
           COMPONENTS (#4923, named the then-#system destination) →
           Read the Book (#5017; source is title case, the .nb-btn*
           chrome uppercases). The hero no longer links #system — the
            header Practice Areas Served link + footer OUR SERVICES column keep it
           reachable (anchors suite). Book CTAs are NOT booking asks:
           the five direct booking placements remain header, hero,
           product funnel, after proof, and footer (six anchors because
           the header has desktop/mobile twins). The session CTA
           keeps the only filled treatment, and the brief's
           session-explainer note sits under the pair (.nb-hero-note —
           "free" + the revenue-goals plan promise ride ledger #36).
           The #4165
           trust line ("✓ $150M+ … across 350+ law firms we've worked
           with") is GONE from the hero — the credibility rail directly
           below carries both figures once (ledger #17/#13). -->
      <div class="nb-actions">
        <a class="nb-btn" href="#booking">Book a High Impact Revenue Session ${ARROW}</a>
        <a class="nb-btn-outline" href="${r}free-chapters/">Read the Book ${ARROW}</a>
      </div>
      <p class="nb-hero-note">A free working session to build the plan for making your revenue goals a reality.</p>
    </div>

    <!-- Hero art (Task #4262, owner doc §3 — book funnel entry): the dark
         art side stays decorative (aria-hidden per layer), but the book
         cover itself is now a subtle link into /free-chapters/ — the
         funnel's first step (cover → free chapters → session). The hero's
         PRIMARY action remains the session CTA on the copy side; the caption
         under the cover is the doc's approved connection line. -->
    <div class="nb-hero-right">
      <div class="nb-machinery" aria-hidden="true">
        <div class="nb-machinery-img"></div>
        <div class="nb-machinery-ambient"></div>
        <div class="nb-floor"></div>
        <div class="nb-sch-line nb-sch-a"></div>
        <div class="nb-sch-line nb-sch-b"></div>
      </div>

      <a class="nb-book-stage" href="${r}free-chapters/" aria-label="Read the first two chapters of The Law Firm Revenue Engine — free">
        ${bookCoverPicture(r, `class="nb-book" src="${nbAsset(r, "brand/front-cover.jpg")}" alt=""`)}
      </a>
      <p class="nb-book-caption">The book explains the system. NoBull installs it.</p>
      <div class="nb-book-shadow" aria-hidden="true"></div>
      <div class="nb-book-reflect" aria-hidden="true"></div>
    </div>

  </section>
</div>

<!-- Credibility rail (Task #4816, owner feedback): the #4261 press strip +
     metrics pair merged into ONE compact hairline-framed band — AS SEEN ON
     logos over the four outcome aggregates — so the authority moment costs
     one glance instead of two screens and the engine section starts ~two
     screens sooner (the cinematic then; the #4992 funnel now). #4261's outcome-first order and wording rules are
     unchanged (ledger #17/#13/#16 — see the METRICS comment above), and
     home-client/statsBand.ts still drives the count-up wherever the
     [data-stats-band] hook sits. Band rhythm: hero (egg) → rail (warm,
     hairline-framed like the old press strip) → gap (warm; the rail's
     bottom hairline draws the divider). -->
<section class="nb-cred" data-stats-band aria-label="As seen on, and aggregate results">
  <div class="nb-wrap nb-cred-press">
    <span class="nb-press-strip-label">AS SEEN ON</span>
${PRESS_LOGOS.slice(0, 3).map((l) => `    ${pressLogoTag(r, l)}`).join("\n")}
    <span class="nb-press-pair">
${PRESS_LOGOS.slice(3).map((l) => `      ${pressLogoTag(r, l)}`).join("\n")}
    </span>
  </div>
  <div class="nb-wrap nb-metric-grid">
${METRICS.map(([stat, label]) => `    <div class="nb-metric"><strong>${metricStat(stat)}</strong><span class="nb-metric-label">${esc(label)}</span></div>`).join("\n")}
  </div>
</section>

<section class="nb-gap">
  <div class="nb-wrap">
    <div class="nb-eyebrow nb-eyebrow-center">
      <i class="nb-rule"></i>
      <span class="nb-label">THE MILLION DOLLAR GAP</span>
    </div>
    <h2 class="nb-serif">Same ${GAP_MODEL.leads} Leads. ${GAP_MODEL.gap} Apart.</h2>
    <p class="nb-gap-lede">
      Picture two firms with the same ${GAP_MODEL.leads} qualified leads.
      One signs ${GAP_MODEL.leaky.cases} cases. The other signs
      ${GAP_MODEL.tuned.cases}. At a ${GAP_MODEL.caseValue} average case
      value, that is a ${GAP_MODEL.gap} difference without generating one
      additional lead.
    </p>
    <!-- Task #4923 (owner brief 2026-08-18 §3, tighter setup) on the
         #4259 frame: the H2 still PRICES the gap (500 leads / $1,000,000
         — the #4259 supersession of the #3949 "numbers land once" rule
         for the HEADLINE figures stands) and the lede now prices it too
         (leads in, cases out, case value, difference), while the
         consults pair + revenue duel still land only in the
         chart/receipt. The lede KEEPS the "Picture two firms"
         hypothetical cue (the illustrative-model label — claim ledger
         row 19; the brief's setup dropped it, deliberately restored —
         deviation logged in docs/website-copy-changelog.md 2026-08-18).
         Every figure stays GAP_MODEL-templated, like every number in
         the band, so the generate-time drift check still guards the
         arithmetic. This visually-hidden summary is the aria-hidden
         chart/receipt pair's accessible home; since Task #4923 it names
         the STAGES only (Marketing / Intake / Sales — brief §3: no
         product names inside the problem illustration, so the #4259
         stage→system attributions left with the visible row tags; the
         solution reveal below owns the ™ names). Task #3991 reframed
         the payoff tail: the $1M reads as the tuned firm's upside ("an
         extra $1,000,000 from the same lead flow") — keep this
         summary's tail in lockstep with the receipt caps. Task #4166
         folded the WHERE IT LEAKS strip into the chart's shortfall
         captions; this summary's closing sentence is the four leak
         names' accessible home. -->
    <p class="nb-vh">
      Marketing generates the same ${GAP_MODEL.leads} qualified
      leads for both firms. Intake books the consultations:
      ${GAP_MODEL.leaky.consults} at the leaky firm, ${GAP_MODEL.tuned.consults} at the tuned firm. Sales
      signs the cases: ${GAP_MODEL.leaky.cases} against ${GAP_MODEL.tuned.cases} —
      ${GAP_MODEL.multiple} the clients from identical lead flow. At a ${GAP_MODEL.caseValue} average
      case value, that's ${GAP_MODEL.leaky.revenue} against ${GAP_MODEL.tuned.revenue} — an extra
      ${GAP_MODEL.gap} from the same lead flow. The leaks: missed calls and
      slow follow-up before the consult, a weak consult offer and too much
      friction after it.
    </p>
    <!-- Two-column compress (Task #3991): duel chart (left, the evidence)
         and payoff receipt (right, the money story) sit side by side on
         desktop so the band reads in one sweep; ≤850px stacks chart →
         receipt. aria-hidden lives on this wrapper (the .nb-vh summary
         above speaks for both); markup ships the final state, gapDuel.ts
         animates it only when motion is allowed. -->
    <div class="nb-gap-cols" aria-hidden="true">
    <div class="nb-gap-duel" data-gap-duel>
      <div class="nb-gap-duel-head">
        <span class="nb-gap-side nb-gap-side-leaky">THE LEAKY FIRM</span>
        <span class="nb-gap-duel-tag">SAME ${GAP_MODEL.leads} LEADS IN</span>
        <span class="nb-gap-side nb-gap-side-tuned">THE TUNED FIRM</span>
      </div>
      <div class="nb-gap-row">
        <div class="nb-gap-cell nb-gap-cell-leaky">
          <div class="nb-gap-bar" style="--w:100%">
            <i class="nb-gap-fill nb-gap-fill-leaky" data-gap-fill></i>
            <span class="nb-gap-num nb-gap-num-in" data-gap-count="${GAP_MODEL.leads}">${GAP_MODEL.leads}</span>
          </div>
        </div>
        <span class="nb-gap-stage"><b class="nb-gap-sys">MARKETING</b>Qualified leads</span>
        <div class="nb-gap-cell nb-gap-cell-tuned">
          <div class="nb-gap-bar" style="--w:100%">
            <i class="nb-gap-fill nb-gap-fill-tuned" data-gap-fill></i>
            <span class="nb-gap-num nb-gap-num-in" data-gap-count="${GAP_MODEL.leads}">${GAP_MODEL.leads}</span>
          </div>
        </div>
      </div>
      <div class="nb-gap-row">
        <div class="nb-gap-cell nb-gap-cell-leaky">
          <div class="nb-gap-bar" style="--w:${gapPct(GAP_N.leakyConsults)};--g:${gapPct(GAP_N.tunedConsults - GAP_N.leakyConsults)}">
            <i class="nb-gap-ghost" data-gap-ghost></i>
            <i class="nb-gap-fill nb-gap-fill-leaky" data-gap-fill></i>
            <span class="nb-gap-num" data-gap-count="${GAP_MODEL.leaky.consults}">${GAP_MODEL.leaky.consults}</span>
          </div>
          <span class="nb-gap-leak" data-gap-leak>${GAP_N.tunedConsults - GAP_N.leakyConsults} fewer consults booked — missed calls, slow follow-up</span>
        </div>
        <span class="nb-gap-stage"><b class="nb-gap-sys">INTAKE</b>Consults booked</span>
        <div class="nb-gap-cell nb-gap-cell-tuned">
          <div class="nb-gap-bar" style="--w:${gapPct(GAP_N.tunedConsults)}">
            <i class="nb-gap-fill nb-gap-fill-tuned" data-gap-fill></i>
            <span class="nb-gap-num" data-gap-count="${GAP_MODEL.tuned.consults}">${GAP_MODEL.tuned.consults}</span>
          </div>
        </div>
      </div>
      <div class="nb-gap-row">
        <div class="nb-gap-cell nb-gap-cell-leaky">
          <div class="nb-gap-bar" style="--w:${gapPct(GAP_N.leakyCases)};--g:${gapPct(GAP_N.tunedCases - GAP_N.leakyCases)}">
            <i class="nb-gap-ghost" data-gap-ghost></i>
            <i class="nb-gap-fill nb-gap-fill-leaky" data-gap-fill></i>
            <span class="nb-gap-num" data-gap-count="${GAP_MODEL.leaky.cases}">${GAP_MODEL.leaky.cases}</span>
          </div>
          <span class="nb-gap-leak" data-gap-leak>${GAP_N.tunedCases - GAP_N.leakyCases} fewer cases signed — weak consult offer, too much friction</span>
        </div>
        <span class="nb-gap-stage"><b class="nb-gap-sys">SALES</b>Cases signed</span>
        <div class="nb-gap-cell nb-gap-cell-tuned">
          <div class="nb-gap-bar" style="--w:${gapPct(GAP_N.tunedCases)}">
            <i class="nb-gap-fill nb-gap-fill-tuned" data-gap-fill></i>
            <span class="nb-gap-num" data-gap-count="${GAP_MODEL.tuned.cases}">${GAP_MODEL.tuned.cases}</span>
          </div>
        </div>
      </div>
    </div>
    <!-- Payoff receipt (right column): totals the duel — 6×, the revenue
         duel, then the reframed big-money moment reading top-to-bottom as
         "AN EXTRA / $1,000,000 / FROM THE SAME LEAD FLOW" (Task #3991 —
         gain-framed, so the figure lands gold-ink like the tuned firm,
         not crimson). Caps never restate the head tag or eyebrow. -->
      <div class="nb-gap-payoff" data-gap-payoff>
        <div class="nb-gap-payoff-row"><i class="nb-rule"></i><span class="nb-gap-multiple">${GAP_MODEL.multiple}</span><i class="nb-rule"></i></div>
        <p class="nb-gap-payoff-cap">THE CLIENTS</p>
        <p class="nb-gap-payoff-money"><span class="nb-gap-money-leaky">${GAP_MODEL.leaky.revenue}</span><span class="nb-gap-money-vs">vs</span><span class="nb-gap-money-tuned">${GAP_MODEL.tuned.revenue}</span></p>
        <p class="nb-gap-payoff-cap">AT A ${GAP_MODEL.caseValue} AVERAGE CASE VALUE</p>
        <p class="nb-gap-payoff-cap nb-gap-payoff-lead">AN EXTRA</p>
        <p class="nb-gap-payoff-gap" data-gap-money="${GAP_N.gapDollars}">${GAP_MODEL.gap}</p>
        <p class="nb-gap-payoff-cap">FROM THE SAME LEAD FLOW</p>
      </div>
    </div>
    <!-- WHERE IT LEAKS / HOW IT'S TUNED strip — FOLDED (Task #4166): the
         four leak names now ride the duel chart's own shortfall captions
         (two per caption, matched to the stage where each leak bites) and
         the .nb-vh summary's closing sentence; the four fix answers were
         retired as visible copy — the engine story's component sections
         walked every fix until Task #4992 retired them with the story.
         The standalone services page is also retired; do not rebuild the strip
         (the #4031 ledger form is recorded in docs/website-final-copy.md
         §2). -->

    <!-- Closer / diagnosis (Task #4923, owner brief 2026-08-18 §3): the
         band now ENDS on the one diagnosis line — the sentence that
         opened the deleted standalone handoff band — and hands straight
         into the #system overview below. The #4816 kicker ("The
         Million-Dollar Gap lives in the handoffs.") retired with that
         band, as did the #4259 bridge body before it (2026-08-14 owner
         feedback — still retired; nothing may pre-narrate the section
         that follows). Treatment keeps #3991's device — centered, full
         band width, the band's last copy, the gold rule bookending the
         eyebrow that opened the band — now with HANDOFFS in oxblood
         (the failure mark, exactly as the old band's head styled it).
         gapDuel.ts staggers this container's children after the receipt
         lands (motion mode only; markup ships final state). -->
    <div class="nb-gap-close" data-gap-close>
      <i class="nb-rule" aria-hidden="true"></i>
      <p class="nb-gap-kicker nb-serif">THE MILLION-DOLLAR OPPORTUNITY DIES IN THE <span class="nb-gap-kick-hand">HANDOFFS</span> BETWEEN MARKETING, INTAKE, AND SALES.</p>
    </div>
  </div>
</section>

${funnelSection(r)}

<section id="proof" class="nb-proof">
  <div class="nb-wrap">
    <div class="nb-proof-head">
      <div>
        <div class="nb-eyebrow">
          <i class="nb-rule"></i>
          <span class="nb-label">PROOF, NOT PROMISES</span>
        </div>
        <h2 class="nb-serif">What the Complete Engine Did for These Firms</h2>
      </div>
    </div>
    <!-- Result-first flagship: identity and verified headline lead into an
         editorial result composition. Supporting lead/review evidence stays
         left on wide screens; the 292-case result owns the right and carries
          its own six-month label. On narrow screens that focal result is first
         in DOM and visual order. Canonical proof.ts data stays complete. -->
    <article class="nb-flag" aria-labelledby="nb-flag-head">
      <div class="nb-slide-sys">THE COMPLETE ENGINE · FLAGSHIP CASE STUDY</div>
      <div class="nb-flag-identity">
        <p class="nb-flag-firm">${PRESTI.firm}</p>
        <div class="nb-label">${PRESTI.label}</div>
      </div>
      <h3 id="nb-flag-head" class="nb-serif nb-flag-headline">${PRESTI.headline}</h3>
      <div class="nb-flag-results" aria-label="Presti Law Firm results">
        <div class="nb-flag-primary">
          <b>${PRESTI.homepageFlagship.primaryStat[1]}</b>
          <span>${PRESTI.homepageFlagship.primaryStat[0]}</span>
          <p>${PRESTI.homepageFlagship.primaryTimeframe}</p>
        </div>
        <div class="nb-flag-supporting">
${PRESTI.homepageFlagship.supportingStats
  .map(
    ([label, value]) =>
      `          <div class="nb-flag-evidence"><b>${value}</b><span>${label}</span></div>`,
  )
  .join("\n")}
        </div>
      </div>
      <blockquote class="nb-flag-quote">
        <p>"${prestiQuoteExcerpt()}"</p>
        <footer>— ${PRESTI.quote.name}, ${PRESTI.quote.firm}</footer>
      </blockquote>
    </article>
    <!-- Two compact supports: each keeps its own system/firm context,
         one verified result headline, and exactly two proof figures. -->
    <div class="nb-supports">
      <article class="nb-sup nb-slide-light" aria-label="${esc(BURNS_SMITH.firm)} — supporting case study">
        <div class="nb-slide-sys">CASEGEN™ RESULT · MARKETING</div>
        <div class="nb-label">${BURNS_SMITH.label}</div>
        <h3 class="nb-serif">${BURNS_SMITH.headline}</h3>
        <div class="nb-sup-cells">
          <div><b>${BURNS_SMITH.totalLeads}</b><span>LEADS — FIRST FIVE MONTHS</span></div>
          <div><b>${BURNS_SMITH.totalReviews}</b><span>FIVE-STAR REVIEWS</span></div>
        </div>
      </article>
      <article class="nb-sup nb-slide-light" aria-label="Expansion Play — supporting case study">
        <div class="nb-slide-sys">THE COMPLETE ENGINE · ALL THREE SYSTEMS</div>
        <div class="nb-label">${EXPANSION.label}</div>
        <h3 class="nb-serif">${EXPANSION.headline}</h3>
        <div class="nb-sup-cells">
          <div><b>${xStat("FIRST 100-CASE MONTH")}</b><span>FIRST 100-CASE MONTH · COLLECTED REVENUE</span><em>${EXPANSION.firstBigMonth}</em></div>
          <div><b>${xStat("LOCATIONS ADDED")}</b><span>LOCATIONS ADDED</span></div>
        </div>
      </article>
    </div>
  </div>
  <div class="nb-wrap nb-proof-foot">
    <!-- Post-proof primary ask (Task #4261, owner doc §4): the unified
         session CTA lands immediately after the receipts do. -->
    <a class="nb-btn nb-proof-cta" href="#booking">Book a High Impact Revenue Session ${ARROW}</a>
    <!-- How Results Are Measured — the brief's two-sentence form (Task
         #4925, owner brief §7; replaced the #4261 five-point paragraph).
         Restates NO figures, introduces no new claims; the revenue-basis
         labeling lives on the cards themselves (COLLECTED REVENUE, ledger
         #7) and the full register lives on /data-notes/. -->
    <aside class="nb-measure" aria-labelledby="nb-measure-head">
      <h3 id="nb-measure-head">HOW RESULTS ARE MEASURED</h3>
      <p>Every result shown is one firm's tracked outcome over the stated
      period, not an average or a guarantee. See <a href="${r}data-notes/">Data
      Notes &amp; Definitions</a> for the measurement basis.</p>
    </aside>
  </div>
</section>

<section class="nb-testimonials">
  <div class="nb-wrap">
    <!-- Eyebrow removed (Task #4166): "WHAT CLIENTS ARE SAYING" restated
         the H2 below it — the #3995 IS THIS YOUR FIRM? precedent. The H2
         opens the band alone. -->
    <h2 class="nb-serif">Hear It From The Firms We Grow.</h2>
    <blockquote class="nb-client-testimonial" data-featured-testimonial data-featured-index="0" data-featured-quotes="${esc(JSON.stringify(FEATURED_CLIENT_QUOTES))}" aria-label="Featured client testimonial">
      <div data-featured-content>
        <div data-featured-copy>
          <p>"${BORIS.quotes[0]}"</p>
          <p>"${BORIS.quotes[1]}"</p>
        </div>
        <footer data-featured-attribution>— ${BORIS.name}, ${BORIS.firm}</footer>
      </div>
      <button class="nb-featured-testimonial-toggle" type="button" data-featured-toggle aria-pressed="false" aria-label="Pause featured client quote rotation" hidden>Pause rotation</button>
    </blockquote>
    <!-- Endless rows (Task #3997; retired by the #4925 static curated
         set, restored by Task #4980 owner reversal — record:
         docs/website-copy-changelog.md 2026-08-18): the SERVED markup
         below is the complete static grid — that grid IS the no-JS /
         prefers-reduced-motion presentation. home-client/testimonialsMarquee.ts
         flips the band to data-testi-mode="marquee" (motion-allowed
         visitors only), clones each [data-marquee-track]'s cards for the
         seamless loop, and drives time-based tweens; home.css keys ALL
         marquee styling off that mode attribute, never off viewport
         width. -->
    <div class="nb-marquee nb-marquee-videos" data-marquee data-marquee-speed="44">
      <div class="nb-video-grid" data-marquee-track>
${VIDEO_TESTIMONIALS.map(
  ([img, name, url]) => `      <a class="nb-video-card" href="${url}" target="_blank" rel="noopener" aria-label="Watch the ${esc(name)} testimonial on Vimeo">
        <img src="${nbAsset(r, `testimonials/${img}`)}" alt="${esc(name)}" loading="lazy"${nbDims(`testimonials/${img}`)}>
        <span class="nb-video-play" aria-hidden="true">▶</span>
        <span class="nb-video-name">${esc(name)}</span>
      </a>`,
).join("\n")}
      </div>
    </div>
${[QUOTE_ROW_A, QUOTE_ROW_B]
  .map(
    (rowQuotes, rowIndex) => `    <div class="nb-marquee nb-marquee-quotes" data-marquee data-marquee-speed="27"${rowIndex === 1 ? " data-marquee-reverse" : ""}>
      <div class="nb-quote-grid" data-marquee-track>
${rowQuotes
  .map(
    ([quote, name, attribution]) => `      <blockquote class="nb-review">
        <span class="nb-stars" aria-label="5 out of 5 stars">★★★★★</span>
        <p>"${esc(quote)}"</p>
        <footer>— ${esc(name)}, ${esc(attribution)}</footer>
      </blockquote>`,
  )
  .join("\n")}
      </div>
    </div>`,
  )
  .join("\n")}
  </div>
</section>

<section class="nb-team">
  <div class="nb-wrap">
    <div class="nb-eyebrow nb-eyebrow-center">
      <i class="nb-rule"></i>
      <span class="nb-label">NOBLE. NO B.S.</span>
    </div>
    <h2 class="nb-serif">One Team Responsible From First Click to Signed&nbsp;Case.</h2>
    <!-- Full-roster band (Task #4979 owner directive, superseding the
         #4926 §10 five-person compression): all 18 people, led by
         Ronnie, Oliver, Brett, Jeff, Janno and Cam, then the rest of
         the roster in its prior relative order. This served grid is
         the complete presentation for EVERY visitor — Task #5011
         retired the #4979/#4903 endless wall (owner verdict: it didn't
         look good; the band never scrolls or drifts now). For
         JS-enabled visitors home-client/teamReveal.ts collapses the
         grid to its first two rows per breakpoint behind the
         accessible Meet the Full Team toggle; no-JS visitors always
         see all 18 cards. TEAM_ROSTER is also the About page's roster
         contract, so photo/name/role/order cannot drift between the
         two surfaces. The About text link below the grid stays
         dropped — the complete roster already renders in-band — and there is
         still NO in-band CTA (all booking asks remain outside the team
         presentation and resolve to the conversion hub). -->
    <div class="nb-team-grid">
${TEAM_ROSTER.map(teamCard(r)).join("\n")}
    </div>
  </div>
</section>

<section class="nb-fit">
  <div class="nb-wrap">
    <h2 class="nb-serif">Is Your Firm a Fit?</h2>
    <!-- Fit criteria (Task #4926, owner brief §12) — the verdict cards
         re-homed from the closing band with both lists rewritten to the
         brief. This resolves the old contradiction (the fit list said
         "already generate leads"; the retired FAQ said you don't need
         to): lead flow is no longer a fit condition — willingness to
         improve Intake and Sales alongside is. No minimum-investment or
         firm-size threshold is published: none is on file (changelog
         records the withholding). -->
    <div class="nb-qual-grid">
      <div class="nb-qual-card">
        <span class="nb-label" id="nb-fit-label">A FIT IF</span>
        <ul aria-labelledby="nb-fit-label">
          <li><span class="nb-check" aria-hidden="true">✓</span> You want more signed cases, not merely more marketing activity</li>
          <li><span class="nb-check" aria-hidden="true">✓</span> You'll let NoBull measure Marketing, Intake, Sales, and revenue</li>
          <li><span class="nb-check" aria-hidden="true">✓</span> Someone at the firm can approve and support implementation changes</li>
          <li><span class="nb-check" aria-hidden="true">✓</span> You want the entire system working toward the same outcome</li>
        </ul>
      </div>
      <div class="nb-qual-card nb-qual-not">
        <span class="nb-label" id="nb-notfit-label">NOT A FIT IF</span>
        <ul aria-labelledby="nb-notfit-label">
          <li><span class="nb-cross" aria-hidden="true">✕</span> You only need a logo, a website refresh, or a one-off campaign</li>
          <li><span class="nb-cross" aria-hidden="true">✕</span> You can't provide the access needed to measure results</li>
          <li><span class="nb-cross" aria-hidden="true">✕</span> You want more leads but won't improve Intake or Sales</li>
          <li><span class="nb-cross" aria-hidden="true">✕</span> Nobody at the firm can own implementation decisions</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="nb-faq-sec">
  <div class="nb-wrap">
    <div class="nb-eyebrow nb-eyebrow-center">
      <i class="nb-rule"></i>
      <span class="nb-label">BEFORE YOU BOOK</span>
    </div>
    <h2 class="nb-serif">Six Questions, Answered Straight.</h2>
    <!-- FAQ (Task #4926, owner brief §13) — cut from ten questions to the
         six a buyer actually asks before booking. The old contact band that
         wrapped this list remains retired; the FAQ stands alone, followed by
         the book handoff and final conversion close. -->
    <div class="nb-faq">
${FAQ.map(
  ([q, a]) => `      <details class="nb-faq-item">
        <summary>${esc(q)}</summary>
        <p>${esc(a)}</p>
      </details>`,
).join("\n")}
    </div>
  </div>
</section>

<!-- Book band (#book) — the existing lower-commitment handoff now comes
     directly after FAQ and before the final conversion close. The free-
     chapters action remains live; Amazon and Audible are explicit,
     non-interactive coming-soon notices until canonical destinations exist. -->
<section id="book" class="nb-book-sec">
  <div class="nb-wrap nb-book-grid">
    <div class="nb-book-visual">
      ${bookCoverPicture(r, `src="${nbAsset(r, "brand/front-cover.jpg")}" alt="The Law Firm Revenue Engine — by Ronnie Deaver" loading="lazy"`)}
    </div>
    <div class="nb-book-copy">
      <div class="nb-eyebrow">
        <i class="nb-rule"></i>
        <span class="nb-label">NOT READY FOR A REVENUE SESSION? START WITH THE BOOK.</span>
      </div>
      <h2 class="nb-serif">The Law Firm <em>Revenue Engine</em></h2>
      <p>
        Why more leads aren't enough — and the complete methodology for
        turning them into revenue. By NoBull founder Ronnie Deaver.
      </p>
      <a class="nb-btn nb-book-cta" href="${r}free-chapters/">GET THE FIRST 2 CHAPTERS FREE ${ARROW}</a>
      <div class="nb-book-actions" aria-label="Book store availability">
${BOOK_STORES.map(
  ({ name, badge }) => `        <div class="nb-store-btn" role="group" aria-label="${name} — ${BOOK_STORE_STATUS}">
          <img src="${nbAsset(r, `book/${badge}`)}" alt="" aria-hidden="true" loading="lazy"${nbDims(`book/${badge}`)}>
          <span class="nb-store-status">${BOOK_STORE_STATUS}</span>
        </div>`,
).join("\n")}
      </div>
    </div>
  </div>
</section>

<!-- Final conversion close: the existing close title/copy now opens the same
     section as the two real actions. Booking remains first in DOM, visual, and
     keyboard order; the contact form keeps its shared data-nb-inquiry contract
     so reCAPTCHA and first-touch attribution remain identical to site.js. -->
<section class="nb-conversion" aria-labelledby="nb-conversion-head">
  <div class="nb-wrap">
    <div class="nb-conversion-close">
      <img class="nb-bull" src="${nbAsset(r, "brand/nobull-icon-crimson.svg")}" alt="" width="48" height="48">
      <h2 id="nb-conversion-head" class="nb-serif">Ready to Build Your Revenue Engine?</h2>
      <p class="nb-close-lede">You're already paying to create opportunity. The question is
      how much of it becomes revenue.</p>
      <i class="nb-rule" aria-hidden="true"></i>
      <p class="nb-close-subline">Sound like a fit? The session is free — you leave knowing how to
      start with Marketing, then build through Intake to Sales.</p>
    </div>

    <div class="nb-conversion-grid">
      <section id="booking" class="nb-conversion-booking" aria-labelledby="nb-booking-head">
        <div class="nb-conversion-heading">
          <h3 id="nb-booking-head" class="nb-serif">Book a High Impact Revenue Session</h3>
          <p>Choose a time that works for your firm, then continue to our scheduler to confirm it.</p>
        </div>
        <div class="nb-booking-handoff">
          <p class="nb-booking-promise nb-serif">A focused, free session to find the next practical step in your Revenue Engine.</p>
          <ul class="nb-booking-facts">
            <li><strong>Start with the real constraint.</strong><span>Marketing, Intake, or Sales — wherever opportunity is getting stuck.</span></li>
            <li><strong>Leave with a clear next step.</strong><span>Use the session to decide where your firm should begin.</span></li>
          </ul>
          <a class="nb-btn nb-booking-cta" href="${CALENDLY_URL}" target="_blank" rel="noopener" aria-describedby="nb-booking-external">View Available Times ${ARROW}</a>
          <p id="nb-booking-external" class="nb-booking-external">Opens the NoBull scheduler on Calendly in a new tab.</p>
        </div>
        <noscript><p class="nb-conversion-noscript">JavaScript is off — that’s okay. The scheduling button above still works.</p></noscript>
      </section>

      <section id="contact" class="nb-conversion-contact" aria-labelledby="nb-contact-head">
        <div class="nb-conversion-heading">
          <h3 id="nb-contact-head" class="nb-serif">Prefer to Send a Message?</h3>
          <p>Tell us a little about your firm and what you would like to discuss. We will get back to you as soon as we can.</p>
        </div>
        <form class="nb-contact-form" data-nb-inquiry="contact" data-success="Thank you! Your message has been sent — we’ll get back to you as soon as we can." novalidate>
          <div class="hp-field" aria-hidden="true">
            <label>Leave this field empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
          </div>
          <div class="nb-contact-grid">
            <div>
              <label for="nb-contact-name">Name <span aria-hidden="true">*</span></label>
              <input id="nb-contact-name" type="text" name="fullName" required autocomplete="name" maxlength="200">
            </div>
            <div>
              <label for="nb-contact-email">Email <span aria-hidden="true">*</span></label>
              <input id="nb-contact-email" type="email" name="email" required autocomplete="email" maxlength="320">
            </div>
            <div>
              <label for="nb-contact-phone">Phone <span aria-hidden="true">*</span></label>
              <input id="nb-contact-phone" type="tel" name="phone" required autocomplete="tel" maxlength="40">
            </div>
            <div class="nb-contact-message">
              <label for="nb-contact-message">Message <span aria-hidden="true">*</span></label>
              <textarea id="nb-contact-message" name="message" required maxlength="5000"></textarea>
            </div>
          </div>
          <p class="nb-contact-required"><span aria-hidden="true">*</span> Required fields</p>
          <div class="nb-contact-captcha" data-nb-captcha aria-label="Security verification"></div>
          <div class="nb-contact-actions">
            <button class="nb-btn" type="submit">Send Message ${ARROW}</button>
          </div>
          <div class="nb-contact-status" data-nb-form-msg role="status" aria-live="polite"></div>
        </form>
      </section>
    </div>
  </div>
</section>

</main>

<footer id="footer" class="nb-footer">
  <div class="nb-wrap">
    <div class="nb-footer-grid">
      <div>
        <img class="nb-logo" src="${nbAsset(r, "brand/nobull-logo-reverse.svg")}" alt="NoBull Marketing" width="156" height="37">
        <!-- Footer conversion pair: the filled session action is the footer's
             primary next step; the outlined book action is its secondary.
             The RESOURCES "The Book" → #book text link stays distinct. -->
        <div class="nb-footer-actions">
          <a class="nb-btn nb-footer-session" href="#booking">Book a High Impact Revenue Session ${ARROW}</a>
          <a class="nb-btn-outline nb-footer-book" href="${r}free-chapters/">Read the Book ${ARROW}</a>
        </div>
      </div>
      <div>
        <h4>OUR SERVICES</h4>
        <a href="#system">The Revenue Engine™</a>
        <a href="#casegen">CaseGen™</a>
        <a href="#caseintake">CaseIntake™</a>
        <a href="#caseconvert">CaseConvert™</a>
      </div>
      <div>
        <h4>COMPANY</h4>
        <a href="${r}about/">About NoBull</a>
        <a href="#proof">Results</a>
        <a href="#contact">Contact</a>
      </div>
      <div>
        <h4>RESOURCES</h4>
        <a href="#book">The Book</a>
        <a href="${r}calculator/">Revenue Calculator</a>
        <a href="${r}resources/">Articles</a>
        <a href="${r}resources/">Webinars</a>
      </div>
    </div>
    <div class="nb-footer-bottom">© 2026 NoBull Marketing. All rights reserved. · <a href="${r}privacy/">Privacy</a> · <a href="${r}terms/">Terms</a> · <a href="${r}shipping-returns/">Shipping &amp; Returns</a></div>
  </div>
</footer>`,
};

/* Million Dollar Gap duel geometry (Task #3904; model reworked Task #3936)
   — bar widths as percentages of the shared lead axis, derived from
   GAP_MODEL so the chart can never drift from the published numbers. A
   leaky-side "ghost" spans from the leaky bar's tip out to the TUNED firm's
   same-stage tip — the shortfall its caption states, with the stage's two
   leak names in tow since the Task #4166 trade-strip fold ("200 fewer
   consults booked — missed calls, slow follow-up" / "100 fewer cases
   signed — weak consult offer, too much friction"). The two firms are
   compared with each other at every stage, never against 100% conversion. */
const gapUsd = (s: string): number => Number(s.replace(/[^0-9]/g, ""));
const GAP_N = {
  leads: Number(GAP_MODEL.leads),
  leakyConsults: Number(GAP_MODEL.leaky.consults),
  leakyCases: Number(GAP_MODEL.leaky.cases),
  tunedConsults: Number(GAP_MODEL.tuned.consults),
  tunedCases: Number(GAP_MODEL.tuned.cases),
  gapDollars: gapUsd(GAP_MODEL.gap),
} as const;

const gapPct = (n: number): string => `${(n / GAP_N.leads) * 100}%`;

// Generate-time drift check: the published revenue/gap/multiple strings must
// equal the funnel arithmetic (cases × case value) or the generator refuses
// to emit — the "$1,000,000 gap" claim is exact math, not copywriting.
{
  const caseValue = gapUsd(GAP_MODEL.caseValue);
  if (
    gapUsd(GAP_MODEL.leaky.revenue) !== GAP_N.leakyCases * caseValue ||
    gapUsd(GAP_MODEL.tuned.revenue) !== GAP_N.tunedCases * caseValue ||
    GAP_N.gapDollars !== (GAP_N.tunedCases - GAP_N.leakyCases) * caseValue ||
    Number(GAP_MODEL.multiple.replace("\u00d7", "")) * GAP_N.leakyCases !==
      GAP_N.tunedCases
  ) {
    throw new Error("GAP_MODEL revenue figures drifted from the funnel math");
  }
}

// Expansion support card: registered-stat lookup by label — throws at
// generate time if a proof.ts label ever drifts (the labels are
// load-bearing copy).
const xStat = (label: string): string => {
  const hit = EXPANSION.stats.find(([l]) => l === label);
  if (!hit) throw new Error(`EXPANSION stat label missing: ${label}`);
  return hit[1];
};

// The First Lead Records day-race slide left the homepage slider in Task
// #4261, and its complete strip left About in Task #5172. The canonical source
// records remain in proof.ts; the compact homepage proof band does not repeat
// a first-lead beat.

// Written reviews for the two endless quote rows — [text, name, attribution]
// (type ReviewQuote, declared near VIDEO_TESTIMONIALS above). All eleven
// restored verbatim from the pre-#4925 source by Task #4980 (owner
// reversal of the static three-quote curated set).
// Quotes render with bracketed editorial substitutions ("[NoBull]",
// "[the team]"…) in place of the founder's name — reviews are not tied to an
// individual (operator request, 2026-08-06) — and long originals are
// excerpted at sentence boundaries (documented per quote). Verbatim
// originals, screenshot sources (Review-1…11.png), excerpt notes, and the
// policy: docs/CONTENT_TRUTH_SOURCE.md §4. Attribution is "Google Review"
// ONLY for actual Google reviews; the three /testimonials/-page quotes carry
// their on-file roles instead. The A/B split feeds the counter-scrolling
// marquee rows (Task #3997); the served fallback stacks both as one grid.
const GOOGLE = "Google Review";

const QUOTE_ROW_B: ReadonlyArray<ReviewQuote> = [
  [
    // /testimonials/ quote wall (truth source §4, Replit variant)
    "[NoBull Marketing] is amazing! [The team is] very knowledgeable and has literally brought my firm up from nothing to fully booked! I know nothing about marketing or computers and [they were] able to work with me at my level. Highly recommend!",
    "Tessa Thrift",
    "Attorney",
  ],
  [
    // Review-8.png (excerpt)
    "I was struggling to survive in my business. Just then I fortunately came in touch with [NoBull]. And [they] revived my position in a few months! Everything started looking so easy! [The team] has the uncanny ability to spot the problems and come up with permanent solutions.",
    "Jayanta Acharyya",
    GOOGLE,
  ],
  [
    // Review-2.png (excerpt)
    "I have interviewed many marketing companies and few of them really understand how to grow your business — but [NoBull] does. [They are] a rare find, running [their] business with skill and integrity. Highly recommend!",
    "Atara Twersky",
    GOOGLE,
  ],
  [
    // Review-11.png (excerpt)
    "I asked [NoBull] for advice years ago for my personal practice and was floored with the value [they] produced for me. Now I'm considered an authority in my work and it's mostly because [the team] helped make me findable with the message I had to share. Thank you, NoBull Marketing and the work you do!",
    "Sam Varnerin",
    GOOGLE,
  ],
  [
    // Review-5.png (excerpt)
    "I highly recommend NoBull Marketing for all law firm owners seeking to get honest marketing insight to increase their firm revenues. I was most impressed with [the team's] candor and integrity. If you are considering whether or not you should make the call, do it. You will not regret it!",
    "Attorney Angelik Edmonds",
    GOOGLE,
  ],
];

const QUOTE_ROW_A: ReadonlyArray<ReviewQuote> = [
  [
    // Review-1.png (excerpt)
    "[NoBull] is one of the best marketing specialists and leaders I have encountered. If you want a company looking to deliver results with you — this is the [company] you want to contact.",
    "Alistair Schneider",
    GOOGLE,
  ],
  [
    // Review-4.png (excerpt)
    "[NoBull] is the real deal!! [The team is] highly competent, clearly experienced, down to earth (so easy to work with), and not afraid to offer [their] friendly candor. That combination is hard to come by, and it's something much needed with any partner, especially something as crucial as marketing. Highly recommend!",
    "Alec Chapa",
    GOOGLE,
  ],
  [
    // /testimonials/ quote wall (truth source §4, Replit variant)
    "[The NoBull team] is a pleasure to work with. [They\u2019re] incredibly responsive, and [their] approach to marketing is straightforward and effective. Since working with NoBull Marketing, the number of quality leads coming into my firm has grown month after month.",
    "Lani Akiona",
    "Family Law Attorney",
  ],
  [
    // Review-10.png (excerpt)
    "[NoBull] is extremely knowledgeable and gives great advice. I really appreciate [their] honesty and willingness to go over topics in-depth. It makes a huge difference!",
    "Susannah Bruck",
    GOOGLE,
  ],
  [
    // Review-7.png (excerpt)
    "[The NoBull team] was kind enough to offer to provide feedback and advice for my webpage. [They are] very knowledgeable. The insights [they] provided made sense and were actionable. I plan to work with [them] again when we can get more changes in place, to better polish our page to drive better engagement. Would highly recommend.",
    "Jake Cutler",
    GOOGLE,
  ],
  [
    // /testimonials/ quote wall (truth source §4, Replit variant)
    "NoBull Marketing gets results. [The team is] transparent, data-driven, and genuinely invested in our success. Every dollar we spend is accounted for, and the return has far exceeded our expectations.",
    "Stacy Grow",
    "Law Firm Marketing Director",
  ],
];

/**
 * The initial entry deliberately retains the existing two-part Tom Boris
 * proof, which is also the complete no-JavaScript/reduced-motion fallback.
 * Subsequent entries reuse only source-backed homepage review records and
 * preserve their approved attributions exactly.
 */
function featuredReview([text, name, attribution]: ReviewQuote): FeaturedClientQuote {
  return { paragraphs: [text], name, attribution };
}
const FUNNEL_STAGES: readonly FunnelStageSpec[] = [
  {
    key: "casegen",
    num: "01",
    dept: "MARKETING",
    name: "CASEGEN™",
    headline: "Create More of the Right Opportunities.",
    caps: "Local Authority Optimization™ · Paid Search Control System™ · Review Velocity System™",
    art: pinArt,
  },
  {
    key: "caseintake",
    num: "02",
    dept: "INTAKE",
    name: "CASEINTAKE™",
    headline: "Stop Qualified Leads From Disappearing.",
    caps: "Answer faster · Guide consistently · Follow up · Remove friction",
    art: calArt,
  },
  {
    key: "caseconvert",
    num: "03",
    dept: "SALES",
    name: "CASECONVERT™",
    headline: "Turn More Booked Consultations Into Signed Cases.",
    caps: "Script the conversation · Strengthen the offer · Coach the execution",
    art: sealArt,
  },
];

/** CaseIntake — conversation meets calendar: booking as the outcome of
    the answered conversation. */
function calArt(): string {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <rect x="7" y="14" width="34" height="32" rx="2.5" stroke="currentColor" stroke-width="2"/>
    <path d="M7 24h34" stroke="currentColor" stroke-width="2"/>
    <path d="M16 9.5v8M32 9.5v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M14 32h7M14 39h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M45 27h11a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 56 39h-4.5l-5 5v-5H45a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 45 27Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

function funnelSection(r: string): string {
  const stage = (s: FunnelStageSpec, i: number): string => `
        <div id="${s.key}" class="nb-fn-stage nb-fn-s${i + 1}" data-fn-stage="${s.key}">
          <span class="nb-fn-num" aria-hidden="true">${s.num}</span>
          <span class="nb-fn-art" aria-hidden="true">${s.art()}</span>
          <div class="nb-fn-copy">
            <p class="nb-fn-dept">${s.dept}</p>
            <h3 class="nb-fn-name">${s.name}</h3>
            <p class="nb-fn-headline nb-serif">${s.headline}</p>
            <p class="nb-fn-caps">${s.caps}</p>
          </div>
        </div>`;
  return `<section id="system" class="nb-funnel" aria-labelledby="nb-funnel-head">
  <div class="nb-wrap">
    <div class="nb-eyebrow nb-eyebrow-center nb-fn-eyebrow">
      <i class="nb-rule"></i>
      <span class="nb-label">OUR PRODUCT LINES</span>
      <i class="nb-rule"></i>
    </div>
    <h2 class="nb-serif nb-fn-head" id="nb-funnel-head">One Revenue Engine. Three Core Components.</h2>
    <!-- The funnel object: three touching angle-edged stages + the
         result plaque under one continuous gold rim (an outer gold
         trapezoid with the stage stack clipped to an inset copy of the
         same shape — the visible sliver of gold IS the border). The
         numerals + engravings are decorative surface texture; the
         dept/name/headline/capability lines are the section's copy. -->
    <div class="nb-fn-object" data-fn-object>
      <div class="nb-fn-body">
        <div class="nb-fn-stack">${FUNNEL_STAGES.map(stage).join("")}
        </div>
      </div>
      <div class="nb-fn-plaque" data-fn-plaque>
        <span class="nb-fn-plaque-label">SIGNED CASES</span>
      </div>
    </div>
    <!-- Section ask (~64–72px below the plaque, brief "CTA beneath the
         funnel"): ONE primary session CTA — no per-product buttons. -->
    <div class="nb-fn-cta">
      <h3 class="nb-serif nb-fn-cta-head">Build a Revenue Engine That Produces More Signed&nbsp;Cases.</h3>
      <a class="nb-btn nb-fn-book" href="#booking">Book Your High Impact Revenue Session ${ARROW}</a>
    </div>
  </div>
</section>`;
}

/** CaseGen — a search pin: location marker with a magnifier lens. */
function pinArt(): string {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <path d="M32 5c-10.8 0-19.5 8.5-19.5 19C12.5 39.5 32 59 32 59s19.5-19.5 19.5-35C51.5 13.5 42.8 5 32 5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="30.5" cy="22.5" r="7" stroke="currentColor" stroke-width="2"/>
    <path d="m35.8 27.8 6 6.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

/** CaseConvert — the signed agreement: document, signature line, seal
    with ribbon tails. */
function sealArt(): string {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <path d="M15 5h24l9 9v38a2.5 2.5 0 0 1-2.5 2.5h-30A2.5 2.5 0 0 1 13 52V7.5A2.5 2.5 0 0 1 15.5 5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M39 5v9h9" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M20 22h20M20 29h20M20 36h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M19 45c2.6-3 4.4 1.6 7-.9 1.7-1.6 3 .9 5-.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <circle cx="43.5" cy="44" r="6.5" stroke="currentColor" stroke-width="2"/>
    <circle cx="43.5" cy="44" r="2.8" stroke="currentColor" stroke-width="1.5"/>
    <path d="m40.5 49.5-2.3 7 4.2-2.6 3 3.4 1.6-7.3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

const FEATURED_CLIENT_QUOTES: ReadonlyArray<FeaturedClientQuote> = [
  {
    paragraphs: BORIS.quotes,
    name: BORIS.name,
    attribution: BORIS.firm,
  },
  featuredReview(QUOTE_ROW_A[2]!),
  featuredReview(QUOTE_ROW_B[0]!),
  featuredReview(QUOTE_ROW_A[5]!),
];
