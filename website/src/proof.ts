/*
 * Deck-sourced proof figures — the single source of truth.
 *
 * Every number and quote below is a client-approved figure from the
 * Revenue Engine sales deck (July 13, 2026), attributed to its slide
 * (`attached_assets/Revenue_Engine_Sales_Deck___July_13,_2026_(2)_1785952349453.pptx`).
 * These figures are woven across the site — homepage proof panel and client
 * voice, homepage proof and testimonial sections, booking proof band, and
 * data-notes provenance table — and every consuming page imports from this
 * module so shared numbers cannot drift.
 * Mirrored in docs/CONTENT_TRUTH_SOURCE.md § 16.
 * Exception: the all-time aggregate totals near the bottom
 * (LEADS_GENERATED, REVIEWS_GENERATED, REVENUE_GENERATED) are not deck
 * figures — they were confirmed directly by the owner in session
 * (2026-08-06 and 2026-08-09) and are registered in
 * docs/website-claim-ledger.md (#16, #35, #17).
 * Do not edit without matching client sign-off.
 */

export type ProofStat = readonly [label: string, value: string];

/**
 * The Presti Law Firm, PLLC (immigration, Dallas TX).
 * Stats: slide 34 "The Multiplier in Action" (200 five-star reviews
 * generated, 3,600+ leads generated, 292 cases signed; GBP thumbnail:
 * 4.8 ★ / 470 Google reviews; owner-confirmed six-month timeframe applies to
 * the 292 signed cases). Headline figures + 400-plus new-five-star-reviews
 * quote: slide 8 (Michael Presti testimonial; its review figure carries no
 * six-month timeframe). First lead record: slide 57.
 */
export const PRESTI = {
  firm: "The Presti Law Firm, PLLC",
  label: "IMMIGRATION LAW FIRM \u2014 DALLAS, TX",
  headline: "500+ Leads a Month. 60+ Cases Signed in a Single Month.",
  homepageFlagship: {
    supportingStats: [
      ["LEADS", "3,600+"],
      ["FIVE-STAR REVIEWS GENERATED", "400+"],
    ] as ReadonlyArray<ProofStat>,
    primaryStat: ["CASES SIGNED", "292"] as ProofStat,
    primaryTimeframe: "IN 6 MONTHS",
  },
  stats: [
    ["LEADS", "3,600+"],
    ["CASES SIGNED", "292"],
    ["5-STAR REVIEWS", "200"],
    ["GOOGLE RATING", "4.8 \u2605"],
  ] as ReadonlyArray<ProofStat>,
  quote: {
    name: "Michael Presti",
    firm: "The Presti Law Firm, PLLC",
    text:
      "[NoBull] has totally automated the intake & sales process for the attorneys. It\u2019s very click-and-easy now. We\u2019re seeing 500 plus leads per month, 60 plus cases in a single month, and 400 plus new five-star reviews. I\u2019ve never seen this kind of lead flow before.",
  },
} as const;

/**
 * Burns Smith Law P.C. (family law).
 * Slide 56 "Live Client Example: 3.5x Increase in 5 Months" (5-month
 * totals 1,779 leads / 50 five-star reviews; monthly leads
 * 150/250/350/450/513; Day 0 onboarding call, Day 17 launch day,
 * Day 19 first consult booked). Quote: slide 9 (Zachary H. Smith). The
 * The homepage intentionally selects only the headline, total leads, and
 * five-star reviews; the monthly ramp, timeline, and quote remain canonical
 * here for other verified proof surfaces.
 */
export const BURNS_SMITH = {
  firm: "Burns Smith Law P.C.",
  label: "FAMILY LAW \u2014 BURNS SMITH LAW P.C.",
  headline: "3.5\u00d7 Lead Increase in 5 Months.",
  totalLeads: "1,779",
  totalReviews: "50",
  monthlyLeads: [150, 250, 350, 450, 513],
  timeline: [
    { day: "DAY 0", event: "Onboarding Call" },
    { day: "DAY 17", event: "Launch Day" },
    { day: "DAY 19", event: "First Consult Booked" },
  ],
  quote: {
    name: "Zachary H. Smith",
    firm: "Burns Smith Law P.C.",
    text:
      "We\u2019ve added a new receptionist because the calls have uptick tremendously\u2026 The leads are coming in. We are able to gain more access to a wider net of clientele\u2026 and we are grateful for what they have done and continue to do.",
  },
} as const;

/**
 * Expansion play case study (multi-location growth).
 * Slide 36 "Expansion Play Case Study: 8 Figure Results in 6 Months"
 * (2,400+ leads generated, 228 five-star reviews generated, 3 locations
 * added, first 100-case month worth $1.5M in collected revenue in April 2026);
 * framing from slide 35 ("Turn One Winning Location Into the Launchpad for
 * the Next"). The homepage intentionally selects only the headline, first
 * 100-case month, and locations added; the complete figures remain canonical
 * here for other verified proof surfaces.
 */
export const EXPANSION = {
  label: "EXPANSION PLAY \u2014 MULTI-LOCATION GROWTH",
  headline: "8-Figure Results in 6 Months.",
  stats: [
    ["LEADS GENERATED", "2,400+"],
    ["5-STAR REVIEWS", "228"],
    ["LOCATIONS ADDED", "3"],
    ["FIRST 100-CASE MONTH", "$1.5M"],
  ] as ReadonlyArray<ProofStat>,
  firstBigMonth: "April 2026",
} as const;

/**
 * Tom Boris, The Elder Law Offices of Shields and Boris — slide 10
 * (two testimonial quotes: turnkey/automated + Google reviews close deals).
 * Both statements render in the static homepage client-voice block as well
 * as on the Results route.
 */
export const BORIS = {
  name: "Tom Boris",
  firm: "The Elder Law Offices of Shields and Boris",
  quotes: [
    "I\u2019m skeptical about everything\u2026 I would not be on here unless you guys did what you promised. You\u2019re helping us grow, you\u2019re helping us expand\u2026 I\u2019m not tech savvy\u2026 you take my dumb questions\u2026 once you get everything set up, it\u2019s turnkey, it\u2019s automated.",
    "99% of the people I talk to compliment us on our Google reviews\u2026 that helps me close the deal\u2026 that is the highlight\u2026 I couldn\u2019t live without them.",
  ],
} as const;

/**
 * First Lead Records — slide 57 (days from launch to first lead,
 * across four firms / practice areas).
 */
export const FIRST_LEAD_RECORDS = [
  { firm: "Presti Law", practice: "Immigration", days: "+1 day" },
  { firm: "Burns Smith Law", practice: "Family Law", days: "+2 days" },
  { firm: "White & Jocham", practice: "Estate Planning", days: "+3 days" },
  { firm: "Hair Shunnarah", practice: "Insurance Defense", days: "+1 day" },
] as const;

/**
 * Google Business Profile / Local Authority result — slide 19
 * "The Foundation in Action: More Than 2× Lead Growth in 90 Days"
 * (live client data after ongoing Local Authority Optimization).
 * Renders in /data-notes/ sourcing only — the homepage receipt retired with
 * the engine story, and the standalone services page is also retired
 * (ledger row 9).
 */
export const FOUNDATION_2X = {
  stat: "2\u00d7",
  window: "90 days",
} as const;

/**
 * Paid search control result — slide 26 "The Accelerator in Action:
 * 8× Lead Growth in Five Months" (3,464 total leads; a real client
 * example of controlled Paid Search) + slide 27 "Live Case Study:
 * 8x Leads in 5 Mo".
 */
export const ACCELERATOR_8X = {
  stat: "8\u00d7",
  window: "five months",
} as const;

/**
 * Intake result — slide 44 "CaseIntake in Action": lead-to-consult
 * rate 38.3% → 75% (+96%), same lead flow, nearly twice the consultations.
 * Renders in /data-notes/ sourcing only — the homepage receipt retired with
 * the engine story, and the standalone services page is also retired
 * (ledger row 11).
 */
export const LEAD_TO_CONSULT = {
  metric: "LEAD-TO-CONSULT RATE",
  before: "38.3%",
  after: "75%",
  lift: "+96%",
} as const;

/**
 * Sales result — slide 51 "CaseConvert in Action": consult-to-case
 * rate 15% → 40% (2.67× the close rate), consultations down from
 * 90+ minutes to 30 or less.
 * Renders in /data-notes/ sourcing only — the homepage receipt retired with
 * the engine story, and the standalone services page is also retired
 * (ledger row 12).
 */
export const CONSULT_TO_CASE = {
  metric: "CONSULT-TO-CASE RATE",
  before: "15%",
  after: "40%",
  lift: "2.67\u00d7 the close rate",
} as const;

/**
 * Aggregate client count — slide 15 "The CaseGen System™"
 * ("Built specifically for law firms. Proven across 350+ clients.").
 */
export const CLIENTS = {
  stat: "350+",
  label: "law firms",
} as const;

/**
 * Lead-review operations scale — slide 24 (LSA training:
 * "Hundreds of thousands of leads reviewed per year").
 */
export const LEADS_REVIEWED = {
  stat: "100,000s",
  label: "of leads reviewed every year",
} as const;

/**
 * All-time leads generated across all client firms — confirmed directly
 * by the owner on 2026-08-06 (docs/website-claim-ledger.md #16; supersedes
 * the withheld legacy "650,000+" figure). WORDING RULE: always publish as
 * "generated", never "reviewed" — LEADS_REVIEWED above is the separate,
 * deliberately distinct yearly ops-scale claim (ledger #14).
 */
export const LEADS_GENERATED = {
  stat: "1,000,000+",
  label: "leads generated",
} as const;
/**
 * The Million Dollar Gap model — owner-directed revision, 2026-08-06
 * (Task #3936; supersedes the deck-S6 ×5 scaling from Task #3904). Both
 * firms GENERATE (never "buy") the same 500 qualified leads; the leaky firm
 * books 100 consults and signs 20 cases, the tuned firm books 300 (60%)
 * and signs 120 (40% of consults) — 6× the clients. At the stated $10,000
 * average case value that is $200,000 vs $1,200,000: exactly the
 * $1,000,000 gap the section is named for. The revenue/gap strings are
 * derived constants (cases × caseValue) kept HERE so copy and chart can
 * never drift from the funnel numbers — home.ts re-checks the arithmetic
 * at generate time. Task #4259 (owner narrative bridge) deliberately
 * superseded the #3949 "each fact lands once" rule for the HEADLINE
 * figures: the H2 prices the gap (leads / $1,000,000) and the lede walks
 * leads-in → cases-out for both firms — the H2 poses the figure, the
 * receipt still proves it, and the consults pair + revenue duel remain
 * visible only in the chart/receipt. Everything stays GAP_MODEL-templated
 * (lede keeps the "Picture two firms" cue), and a visually-hidden
 * summary (also GAP_MODEL-templated) speaks the full model to screen
 * readers while the chart stays aria-hidden.
 * ILLUSTRATIVE MODEL — always label as a model (the hypothetical two-firm
 * framing carries the label), never as a client result, and never conflate
 * with the Presti client result (500+ leads/mo, 60+ cases/mo) even though
 * the 500-lead figure coincidentally echoes it.
 */
export const GAP_MODEL = {
  leads: "500",
  caseValue: "$10,000",
  leaky: { consults: "100", cases: "20", revenue: "$200,000" },
  tuned: { consults: "300", cases: "120", revenue: "$1,200,000" },
  multiple: "6\u00d7",
  gap: "$1,000,000",
} as const;

/**
 * All-time five-star reviews generated for client firms — confirmed
 * directly by the owner on 2026-08-06 (docs/website-claim-ledger.md #35).
 */
export const REVIEWS_GENERATED = {
  stat: "30,000+",
  label: "five-star reviews generated",
} as const;

/**
 * All-time new client revenue generated for client firms — confirmed
 * directly by the owner on 2026-08-09 (docs/website-claim-ledger.md #17;
 * previously the withheld legacy-site metric). WORDING RULES: always
 * "new client revenue" (revenue generated FOR client firms, never NoBull's
 * own revenue), and when paired with the CLIENTS count the firm figure must
 * read cumulatively (firms worked with over time) — the owner clarified
 * 2026-08-09 that 350+ is NOT an active-client count.
 */
export const REVENUE_GENERATED = {
  stat: "$150M+",
  label: "in new client revenue",
} as const;
// NOTE: the deck's generic onboarding path (S55: Day 0 → Days 3–5 → live by
// Day 14) is deliberately NOT exported. Publishing it reads as a universal
// process/schedule promise, which is withheld pending client confirmation —
// see docs/website-claim-ledger.md (row 23 + strategy-call qualifiers).
// BURNS_SMITH.timeline (S56) — a narrowly attributed real-client instance —
// renders on the testimonials case study and the book-a-call proof band
// (the homepage "Installed in Stages." section was removed 2026-08-06).
