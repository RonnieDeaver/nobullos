# Website Copy Changelog — Sitewide Revenue Engine Overhaul (Aug 2026)

Companion docs: `website-messaging-architecture.md` (locked naming + narrative),
`website-claim-ledger.md` (every number, source slide, status),
`website-copy-audit.md` (pre-change route audit), `website-final-copy.md`
(the decided copy this changelog implements).


## 2026-08-27 — Homepage credibility rail now leads with proof numbers

- Reordered the existing credibility rail so the four approved outcome
  metrics lead visually and semantically, with the five existing opaque press
  logos following as quieter validation.
- Preserved every metric value, label, logo asset, accessibility treatment,
  count-up behavior, and responsive wrapping rule.

## 2026-08-27 — Homepage FAQ story reordered

- Reordered the existing seven homepage FAQ disclosures into the approved
  buying sequence: engagement scope, operating ownership, compatibility,
  measurement, timing, investment, then final fit.
- Questions, answers, fit criteria, accessibility markup, styling, and the
  existing FAQ → book → booking sequence are unchanged.

## 2026-08-25 — Homepage booking panel simplified

- Reduced the final homepage booking panel to its heading and the existing
  `View Available Times →` action.
- Retired the booking explainer paragraphs, benefit facts, scheduler note, and
  no-JavaScript note. The action still opens the canonical High Impact Revenue
  Session Calendly destination in a new tab; no embedded scheduler was added.

## 2026-08-24 — Amazon and Audible marked Coming Soon

- Replaced the current-edition Amazon and Audible search-link affordances with
  non-interactive `Coming Soon!` availability notices on the homepage book
  band, the `/free-chapters/` endcap, and its roomier-screen floating bar.
- Retained the matched store wordmarks in the two full-size dark treatments,
  with the availability message rendered as visible text. The floating bar
  uses compact text notices; phone widths continue to reserve the bar for the
  full-width High Impact Revenue Session action.
- The free-chapters CTA, endcap calculator link, and High Impact Revenue
  Session CTAs are unchanged. The separate `/book/` checkout funnel and
  unrelated legacy-edition destinations are unchanged.
- Canonical store URLs remain a client blocker. `website/src/bookLinks.ts` now
  single-sources store names and the availability message instead of broad
  search URLs, so no current-edition marketing surface implies the book can
  already be purchased on Amazon or Audible.

## Per-route changes

### Home (`/`, `website/src/pages/home.ts`)
- Hero: H1 + eyebrow unchanged (locked). New support lede ("Most agencies stop
  at the lead…measured from first click to signed case"), trust line now
  `350+ law firms grown — and counting` (proof.ts CLIENTS), secondary CTA
  **See the System** → `#system` (cinematic), primary **Book a Strategy Call**.
- Metrics band moved above the cinematic; figures replaced: 350+ firms /
  100,000s leads reviewed yearly / 1–3 days to first lead / 10+ years
  (legacy 650K leads + $150M removed — unverified, see ledger).
- NEW §3 "The Million Dollar Gap" (`.nb-gap`): leaky-firm vs tuned-firm model
  from deck S12–13 (GAP_MODEL), labeled as illustrative.
- Cinematic growth-stage secondary CTA relabeled "Get the Book on Amazon"
  (was "Read the First 2 Chapters" — label promised content the search-URL
  destination doesn't provide; destinations owned by Task #3855).
- Cinematic section: kicker → THE LAW FIRM REVENUE ENGINE™; stage narration
  tuned within the cinematic skill contract (no structural/timing changes).
- NEW §5 "Three Systems. One Measured Path to Signed Cases." (`.nb-sys`):
  CaseGen™ / CaseIntake™ / CaseConvert™ cards with adjacent proof figures.
- Proof section: "PROOF, NOT PROMISES / One Firm. The Whole Engine." —
  Presti panel (500+ leads/mo, 60+ cases/mo, 292 signed) + mechanism line.
- NEW §8 "Installed in Stages." (`.nb-install`): implementation-method lede
  + the Burns Smith install timeline only (Day 0 onboarding call → Day 17
  launch → Day 19 first consult), narrowly attributed and interpolated from
  proof.ts. The deck's generic onboarding path (S55) is not published.
- NEW §10 growth-control/differentiator 2-col (`.nb-throttle`): "Growth You
  Can Throttle." + "We Optimize for Cases, Not Clicks."
- Book band: rewritten around locked title/subtitle; tertiary CTA
  **Get the Book on Amazon** (label doesn't promise content while the
  destination is an Amazon search URL; destination unchanged — see blockers).
- NEW §11 qualification (`.nb-qual`): "Built for Firms Ready to Fix the Whole
  Funnel." fit / not-fit columns.
- Closing: "Ready to Build Your Revenue Engine?" + honest-recommendation line;
  contact form intro "Not Ready To Book? Just Ask."; FAQ guarantee claim
  removed; footer SOLUTIONS → The Revenue Engine™/CaseGen™/CaseIntake™/
  CaseConvert™, RESOURCES → The Book/Articles/Webinars, COMPANY gains
  Book a Strategy Call.
- New meta description (≤160 chars, engine-led).

### About (`/about/`)
- Title/meta/eyebrow band → "Noble. No B.S." company-story framing.
- Ronnie bio rewritten (author + speaker; unverified 650K/$150M totals
  withheld); Jake → Sr. Marketing Engineer; Oliver → Head of Operations +
  bio rewrite. FAQs 1/3 rewritten (no guarantee wording, strategy-call next
  step, "click to signed case" language).

### Services (`/services/`)
- Band → "The Law Firm Revenue Engine™ / Three systems, one measured path…".
- Intro → "One Engine, Three Systems" with CaseGen/CaseIntake/CaseConvert
  roles + 350+ firms.
- Rows renamed to locked subsystem names: The Foundation — Local Authority
  Optimization™ / The Accelerator — Paid Search Control System™ / The
  Multiplier — Review Velocity System™ (2× and 8× proof chips kept adjacent).
- Systems cards → CaseIntake™/CaseConvert™ ("Then We Book Them. Then We
  Close Them."); both CTAs → Book a Strategy Call.

### Testimonials (`/testimonials/`)
- Title → "Client Results & Case Studies | NoBull Marketing"; meta built from
  proof.ts figures (292 cases, 1,779 leads, 8-figure expansion).
- Band → "Real Firms. Real Numbers." / "Proof, Not Promises" eyebrow.
- Case-studies H2 → "From First Lead to Eight-Figure Expansion."; each case
  body now states constraint → what was installed → outcome, figures
  interpolated from proof.ts (never hand-typed).

### Book a call (`/book-free-demo/`, URL unchanged)
- Reframed from "Book a Free Demo" to **Book a Strategy Call** everywhere
  (title, H1, meta, header/nav, Calendly band).
- New "What Happens On The Call" 3-step section; proof band kept (8×, +1 day,
  19 days); Calendly sub sets onboarding expectation. Calendly destination
  untouched.

### Resources (`/resources/`)
- Title → "Law Firm Growth Library | NoBull Marketing"; band → "Resources" /
  "The Library" eyebrow; meta ties library to the Revenue Engine thinking.

### Articles (15 × `website/content/articles/*.json` + `index.json`)
- All 15 junk meta descriptions ("Jan 4, 2024 | Articles") replaced with real
  ≤160-char summaries; index + per-file excerpts now match (card blurbs).
- `.co` domain links fixed → `.com` (webinar article ×3; dead `/talk` path →
  `/book-free-demo/`).
- "Book Free Demo" phrase in cracking-the-code body → "Book a Strategy Call".
- Unverified aggregate claim ("500,000 leads and $100 million") softened to
  the campaign count only, in both articles that carried it.
- Educational content otherwise preserved; article sidebar CTA → Book a
  Strategy Call.

### Legal / utility
- `privacy.json`: domain → nobullmarketing.com; scraped WordPress footer-nav
  debris (incl. "Book a Free Demo", stale © 2024) removed from body end.
  No substantive legal wording changed.
- Unsubscribe button → "Unsubscribe Me" (was "Submit"). 404 verified clean.

### Shared chrome (`website/src/html.ts`)
- Header CTA → Book a Strategy Call sitewide; footer solutions/product naming
  → locked architecture; calendlyBand default heading no longer "Book a Free
  Demo".

## Legacy terminology removed (verified 0 hits in rendered bundle)
"Revenue Engineering System", "Book a Free Demo"/"Free Demo", "Perfect
Intake", "Case Generation", "Sales Conversion", "300 law firms"/"5 years",
"$6,000/month", 650,000 leads, $150M, 500,000 leads/$100M (articles),
"Learn More"/"Submit" labels, junk "Jan 4, 2024 | …" meta descriptions,
`.co` domains, guarantee wording in FAQs.

## Claims used (all slide-traceable — see claim ledger for slide numbers)
350+ firms · 100,000s leads reviewed/yr · 1–3 days to first lead · 10+ years ·
Presti 500+/mo, 60+/mo, 292 signed, +1 day · Burns Smith 1,779 leads,
200 reviews, 8× growth, 19 days to first consult · Expansion client 3
locations/6 months, $1.5M-100-case month · 2× (Foundation) · 8× (Accelerator)
· leak-model 100→25 vs 200→60 cases from 500 leads (illustrative, labeled;
S6 ratios ×5 per Task #3904) · day-17/day-19 launches.

## Claims withheld (and why)
- 650K leads / $150M / 500K-lead variants — no deck source; pending client
  verification.
- S53 guarantee ("150 signed cases + 7 locations in 90 days") — forbidden
  without explicit approval + eligibility terms.
- S54 pricing — deck-only, not for the public site.
- Book pseudonym case stories — book uses pseudonyms; never published as real
  clients.
- "Work for free" / "Guaranteed Profitable" — legacy risk language, dropped.
- Strategy-call qualifiers and process promises — no "free"/"no-pressure"/
  "not a pitch", no call-behavior assurances ("No B.S. either way"), no
  promised call deliverables (funnel map, leak list, plan, approach/pricing
  recommendations), no onboarding generalizations ("single session", "live
  in about two weeks", "Live in Weeks", generalized day schedules, or the
  deck's generic Day-0/Days-3–5/~2-weeks onboarding path itself), no
  operational-cadence commitments ("one weekly meeting", "weekly 30-minute
  meeting", "ongoing tune-ups") — pending client confirmation; booking page
  and FAQs state call topics only, and the homepage install section shows
  only the narrowly attributed Burns Smith case timeline.
- Book-content CTA labels ("Read the First 2 Chapters", "Read a Sample") —
  not used while destinations are Amazon search URLs; labels read "Get the
  Book on Amazon" until Task #3855 supplies canonical product pages.

## Remaining factual blockers
1. **Book purchase URLs** (Amazon/Audible point at the old
   "Revenue-Engineering-Law-Firms-Skyrocket" listing; "first two chapters"
   link is an Amazon search URL) — owned by Task #3855; surrounding copy
   already uses the locked current title.
2. **Expansion case client is unnamed** — naming requires client permission.
3. **Article publish dates** all read "Jan 4, 2024" (WordPress migration
   artifact) — real dates need the old CMS export.

## QA performed
- `npx tsx website/generate.ts` rerun; committed bundle fresh (23 pages +
  404 + sitemap + build-manifest, fingerprint 0c27ae63e131…); `tsc` clean.
- All 24 rendered pages: unique title + unique ≤160-char meta + exactly one
  H1 (scripted check).
- Puppeteer sweep, 24 routes × desktop (1440) + mobile (390): no horizontal
  overflow (one found on the new call-steps grid and fixed), no junk
  text, no real console errors, "Book a Strategy Call" present on every
  page. Vimeo 403/"Sorry" on preview hosts is the known non-bug.
- Banned-term grep of `website/public` — zero hits (list above).
- Brief's 11-question acceptance test walked against the rendered pages —
  passes; heading-only read of the homepage tells the full argument
  (gap → engine → systems → proof → install → control → book → fit → call).

---


## 2026-08-06 — Credibility band: owner-confirmed aggregates + count-up (Task #3907)

- Owner confirmed directly in session (2026-08-06): **1,000,000+ leads
  generated** all-time and **30,000+ five-star reviews generated**. Ledger
  #16 promoted from WITHHELD 650K to LIVE 1,000,000+; new aggregate row
  #35; #18's 500K variant stays withheld (superseded). $150M+ (#17) still
  withheld.
- Home metrics band lineup is now: 1,000,000+ Leads Generated · 30,000+
  Five-Star Reviews Generated · 350+ Law Firms Grown · 10+ Years of
  Results (proof.ts LEADS_GENERATED / REVIEWS_GENERATED / CLIENTS).
- Rotated out of the band (deliberately, still available elsewhere):
  "100,000s of Leads Reviewed Every Year" (#14, now WITHHELD — a
  "reviewed" ops figure must not sit beside the 1M+ "generated" total)
  and "1–3 Days From Launch to First Lead" (lives on via
  FIRST_LEAD_RECORDS on /about/ and the demo page).
- The band now counts up once on scroll entry (GSAP ScrollTrigger,
  website/src/home-client/statsBand.ts) with comma grouping and static
  final values for no-JS / reduced-motion visitors. Where the overhaul
  sections above list the band as "100,000s leads reviewed/yr · 1–3 days
  to first lead", read this section as superseding them.
## Post-overhaul updates

### 2026-08-20 — Footer conversion hierarchy

- The homepage and shared subpage footers now lead with the filled **Book a
  High Impact Revenue Session →** action pointing to `/book-free-demo/`, paired
  directly with the outlined **Read the Book →** action pointing to
  `/free-chapters/`.
- The former plain session link is removed from the `COMPANY` column. The
  paired controls wrap only when necessary and become full-width touch targets
  on phone layouts; the footer navigation columns remain unchanged.

## Post-overhaul changes


### 2026-08-20 — About/navigation/services-retirement integration verification

- Reconciled current sitemap, navigation, content-truth, copy-audit,
  messaging, claim-ledger, and do-not-break guidance around one live model:
  About owns the exact 18-person roster and exact 14-item `Practice Areas
  Served` section; every header links directly to
  `/about/#practice-areas-served`.
- Confirmed the standalone `/services/` route remains fully retired: no
  generator page, sitemap row, canonical, internal link, or redirect. Both the
  marketing-host and `/website-preview/` paths serve the branded 404.
- Preserved the independent footer product contract: the Revenue Engine and
  three component links still resolve to homepage `#system`, `#casegen`,
  `#caseintake`, and `#caseconvert`. No top-navigation change repointed them.
- Reconciled route preservation to the generated inventory: 25 sitemap routes
  comprise 10 non-resource pages and 15 canonical resources. The legacy
  `/resource/episode-13/` URL remains a one-hop cutover 301 to the canonical
  Brita Long article and is not a generated page or sitemap entry.
- Historical route and label mentions remain only in explicitly dated or
  retired context; current generated visible copy uses `Practice Areas
  Served` and `Marketing, Intake, and Sales services`.


### 2026-08-19 — Homepage proof consolidation

- The homepage `PROOF, NOT PROMISES` band now carries the complete verified
  content previously unique to the standalone Results route. Its plural
  `What the Complete Engine Did for These Firms` heading remains unchanged;
  `SEE MORE CASE STUDIES →` and every `VIEW CASE STUDY →` control are removed
  because the route is not a case-study library.
- The Presti flagship gains its verified manual-intake-and-sales context,
  `+1 day after launch` first-lead fact, and static
  Marketing → Intake → Sales → 292 cases-signed path without repeating its
  existing Michael Presti quote. Burns Smith now includes the five-value
  150/250/350/450/513 lead ramp, the attributed Day 0/17/19 milestones, and
  Zachary H. Smith's verbatim quote. The unnamed Expansion story regains its
  launchpad framing and the 228 six-month review result beside its existing
  leads, locations, and April 2026 collected-revenue milestone.
- Tom Boris's two S10 client-testimonial statements now serve statically above
  the testimonial grids. The five Vimeo video cards, eleven review cards, and
  their no-JS/reduced-motion static contract are unchanged; marquee motion is
  still an optional enhancement only.
- Proof facts and quotes remain sourced from `website/src/proof.ts`; the
  claim ledger and final-copy liveness records now name the homepage surfaces.
  The committed static bundle was regenerated and the existing semantic
  homepage suite was retargeted rather than adding a duplicate test.


### 2026-08-19 — Free Chapters floating CTA hierarchy

- The `/free-chapters/` floating reader bar now uses the site-standard primary
  **Book a High Impact Revenue Session →** label and keeps its established
  `/book-free-demo/` destination. Its former "Apply This to Your Firm" label,
  duplicate calculator link, and calculator-focused assistive wording are
  removed.
- The calculator remains in the end-of-excerpt action row, where it is a
  contextually appropriate soft next step. Amazon and Audible remain quiet
  full-book links in the floating bar on roomier screens, but hide at phone
  widths so the 48px session action takes the full usable width without
  wrapping or horizontal overflow. The fixed bar and reading body padding
  retain safe-area protection.
- The existing committed-bundle CTA-ladder assertion now independently checks
  that the calculator remains in the endcap and cannot return to the floating
  bar; no new suite or browser test was added.

## Review anonymization (2026-08-06, operator request)

Reviews must not be tied to an individual. All five written client review
quotes that named the founder now use bracketed editorial substitutions
("[NoBull]", "[The team is]", "[they were]" …) in place of "Ronnie" and the
he/his pronouns that referred to him — no claims added or removed, reviewer
attribution names unchanged, star rows / "Google Review" labels unchanged.

- Home "What Clients Are Saying" (`website/src/pages/home.ts` `QUOTES`):
  Alistair Schneider — "[NoBull] is one of the best…" / "…this is the
  [company] you want to contact." Atara Twersky — "…but [NoBull] does.
  [They are] a rare find, running [their] business with skill and integrity."
- Testimonials quote wall (`website/src/pages/testimonials.ts` `QUOTES`):
  Tessa Thrift, Lani Akiona, Stacy Grow — same treatment; the three
  deck-sourced client testimonials (Presti / Smith / Boris) never named an
  individual and are untouched.
- Intentionally unchanged (first-party content, not reviews): About bio,
  homepage team grid, book-cover alt + "written by NoBull founder Ronnie
  Deaver" book-band line, resource articles by/about Ronnie Deaver, and the
  video testimonials (no review text names him).
- Verbatim pre-anonymization quote texts preserved in
  `docs/CONTENT_TRUTH_SOURCE.md` §4 (homepage pair now on file there too),
  with a note that bracket-only differences between truth source and
  rendered site are policy, not drift.
- Bundle regenerated (`npx tsx website/generate.ts`); rendered
  review/testimonial quote blocks grep clean of "Ronnie".


## Book band fix + free-chapters excerpt reader (2026-08-06, Task #3920)

Owner-reported: the Audible badge rendered lower/larger than the Amazon badge
and clipped off-screen at some widths; the gold "GET THE BOOK ON AMAZON →"
link duplicated the Amazon badge above it; and the owner chose to promote
"Get the first 2 chapters free" via an on-site, no-email-gate reader instead.

- Store badges rebuilt as a matched pair from the same supplied art (never
  redrawn): both PNGs re-composed on equal-height canvases with the two
  wordmarks at identical x-height and a shared text baseline (amazon.png now
  460×148, audible.png 620×148; both were 609×104 with mismatched internal
  geometry — amazon label top-of-canvas with ~105px trailing transparency,
  audible label bottom, full-width). Badge row now wraps at every width
  (`flex-wrap` existed only ≤520px, so the ~520–575px and ~850–1010px bands
  overflowed into `.nb-book-sec{overflow:hidden}` and clipped Audible).
- Tertiary `GET THE BOOK ON AMAZON →` link REMOVED; replaced by the gold
  primary `GET THE FIRST 2 CHAPTERS FREE →` → `/free-chapters/`.
- NEW `/free-chapters/`: on-site excerpt reader — Introduction + Chapters 1–2
  imported VERBATIM from the owner-supplied manuscript DOCX by
  `scripts/extract-book-excerpt.ts` into `website/content/book-excerpt.json`
  (inline bold/italic preserved; the six in-text diagrams ship as ~47–78KB
  WebP derivatives instead of the 1.2–1.4MB originals). No email gate (owner
  declined lead capture). Only text exclusion: the manuscript's final
  back-matter CTA line (printed `/talk` URL that doesn't exist on this
  site) — ledger §5 row records it.
- Reader conversion layer: dark endcap after Chapter 2 (real Chapters 3–5
  titles from the manuscript ToC, store badges, `Book a Strategy Call`) plus
  a floating bottom bar — primary `BOOK A STRATEGY CALL →` (`/book-free-demo/`),
  secondary `GET THE FULL BOOK` Amazon/Audible. `body.fc-body` reserves
  bottom padding so the bar never covers the last lines; safe-area inset
  respected; bar suppressed in print.
- Amazon/Audible search URLs single-sourced into `website/src/bookLinks.ts`
  (homepage band, cinematic stage CTA, reader endcap + bar all import it) so
  Task #3855's product-page swap propagates everywhere at once.
- Claim ledger: "Read the first 2 chapters" CTA row resolved; book-content
  CTA rule updated (content promises allowed only when pointing at the
  on-site excerpt); §4 rows 26–27 annotated — inside `/free-chapters/` the
  pseudonyms and book stats are clearly-attributed book narrative (with the
  names-changed note inline in the first Introduction paragraph), not site
  claims.
### 2026-08-06 — "Growth You Can Throttle." section removed (home)
- Deleted the homepage "GROWTH CONTROL / Growth You Can Throttle." band
  (`.nb-throttle`) entirely — eyebrow, H2, lede, and the crimson kicker
  quote "Build the system once. Use it to enter market after market."
  (deck S35) — operator judged it added no value. Homepage now flows
  "Installed in Stages." straight into "The People Behind The Engine."
- The "growth you control" bullet in the qualification section is
  unchanged. Section-order line + §11 in `website-final-copy.md` updated
  in lockstep; bundle regenerated.


### 2026-08-06 — "Installed in Stages." section removed (home)
- Deleted the homepage IMPLEMENTATION band (`.nb-install`) entirely — the
  `IMPLEMENTATION` eyebrow, "Installed in Stages." H2, the no-rip-and-replace
  install lede, the three numbered Burns Smith timeline cards (DAY 0
  Onboarding Call / DAY 17 Launch Day / DAY 19 First Consult Booked), and
  the "One firm's real install timeline…" microcopy — operator judged it
  added no value. The homepage now flows the book band straight into "The
  People Behind The Engine." (team).
- `BURNS_SMITH.timeline` (proof.ts, deck S56) is untouched and still renders
  where it's genuinely used: the testimonials case study and the book-a-call
  proof band. The deck's generic onboarding path (S55) remains unpublished —
  claim ledger row 23 — now with no homepage install section at all.
- Lockstep updates: §10 + section-order line in `website-final-copy.md`
  marked removed (§11's flow note updated too), claim-ledger row 23 revised
  and row 24 re-scoped (the component-at-a-time / decision-bunching /
  keep-current-software wording left the site with this section; the
  click-to-close tracking description stays live in the differentiator +
  FAQs), orphaned `.nb-install*` CSS dropped (base rules, responsive
  overrides, and the stale INSTALL/THROTTLE band comments), home.ts /
  proof.ts section-order + S56 comments refreshed; bundle regenerated.
### 2026-08-06 — Task #3904: Million Dollar Gap redesign
- GAP_MODEL rescaled 5× at the owner's request (same S6 ratios): 100→20→5
  vs 100→40→12 becomes 500→100→25 vs 500→200→60; the 2.4× multiple is
  unchanged. Lede, claim-ledger row 19 and final-copy §2 updated in
  lockstep. Still an ILLUSTRATIVE MODEL — never a client result, and kept
  distinct from the Presti figures (500+ leads/mo, 60+ cases/mo) that the
  rescaled numbers coincidentally echo.
- Tuned-firm list rewritten as one-for-one antitheses of the leaky list:
  Missed calls → Every call answered · Slow follow-up → Follow-up in
  minutes · Weak consult offer → Consults built to close · Too much
  friction → Signing made effortless.
- Section rebuilt as a shared-axis duel chart (crimson leaky bars leftward
  vs gold tuned bars rightward, leak ghosts + captions, 2.4× payoff, trade
  rows) with a one-time GSAP scroll reveal; complete static state under
  reduced motion / JS off. The chart is aria-hidden — every number it shows
  is restated in the lede text.
- Site-wide accessibility fix: gold TEXT/glyphs on light surfaces moved to
  --gold-ink #7D5C1B (≥4.5:1 on white/--warm/--egg, computed); bright
  #D5AC5C stays for text on dark bands and decorative rules/borders.


### 2026-08-06 — Task #3916: qualification band merged into the closing CTA
- The standalone `.nb-qual` band (warm bg) and the `.nb-closing` band (egg
  bg) became ONE eggshell closing band: eyebrow `IS THIS YOUR FIRM?` →
  fit / not-a-fit cards → bull icon → `Ready to Build Your Revenue
  Engine?` → `Book a Strategy Call.` → sub-line → CTA button. The page no
  longer ends on two consecutive low-density centered bands split by a
  background seam; self-qualification sits directly against the ask.
- Copy: the qualification H2 `Built for Firms Ready to Fix the Whole
  Funnel.` was DELETED (operator-approved — the eyebrow alone frames the
  cards). Every other line of card + closing copy is byte-identical; no
  claim-ledger rows point at either band, so the ledger is untouched.
- Styling: cards moved onto the closing's egg background under one
  vertical rhythm (the 90px+120px double-padding seam and the closing's
  gold hairline `::before` are gone — the eyebrow's gold rule opens the
  band); tablet/phone spacing tightened so the stacked cards don't push
  the CTA a full viewport away.
- Lockstep: final-copy §13 + §14 merged into one §13 entry (Contact/FAQ
  renumbered §15 → §14), section-order lines updated in `home.ts` +
  final-copy, bundle regenerated.
### 2026-08-06 — Task #3936: Million Dollar Gap model rework ($1,000,000 math)
- GAP_MODEL revised to owner-provided figures (supersedes the deck-S6 ×5
  scaling of Task #3904): both firms GENERATE (not "buy") the same 500
  qualified leads; leaky 100 consults → 20 cases vs tuned 300 (60%) → 120
  (40% of consults) = 6× the clients. New constants state the $10,000
  average case value and the derived $200,000 vs $1,200,000 revenues —
  exactly the $1,000,000 gap the section is named for. The generator now
  asserts the revenue/gap/multiple strings match the funnel arithmetic at
  build time (home.ts), so copy and chart cannot drift.
- Lede rewritten ("Picture two firms generating…" — the visible
  hypothetical cue now carries the model label in rendered copy; 100/20 vs
  300/120, 6×, the stated $10,000 case value, $200,000 against $1,200,000,
  the $1,000,000 gap). The chart stays aria-hidden, so the lede alone
  carries the full story.
- Duel chart re-derived from the new numbers; the leaky-only "− 400 never
  book" / "− 75 never sign" captions (which implied 100% conversion was
  the bar) replaced with leaky-vs-tuned stage comparisons — "200 fewer
  consults booked" / "100 fewer cases signed" — and the dashed ghosts now
  span from the leaky tip to the tuned firm's same-stage tip.
- Payoff evolved into a receipt: `6×` (THE CLIENTS — FROM THE SAME 500
  LEADS) → `$200,000 vs $1,200,000` (AT A $10,000 AVERAGE CASE VALUE) →
  `$1,000,000` (THE MILLION DOLLAR GAP), the gap figure counting up when
  motion is allowed; complete static final state still ships for
  reduced-motion / no-JS visitors.
- Deleted the "Illustrative model — the same math we diagnose on a
  strategy call." caption; replaced the kicker "Guessing creates activity.
  Diagnosis creates growth." with "Your next $1,000,000 isn't in more
  leads — it's in the leads you already have." — the closing line now
  finishes the million-dollar story.
- Claim-ledger row 19 + final-copy §2 updated in lockstep (the hypothetical
  two-firm framing remains the model label; never a client result, never
  conflated with Presti). Bundle regenerated.
### 2026-08-06 — Task #3908: Homepage repetition de-dup + cinematic hand-off
- Post-#3904/#3907 repetition audit → one owning section per recurring
  claim: locked hero keeps the agency contrast ("Most agencies stop at the
  lead") and the Marketing/Intake/Sales one-system claim; the gap kicker
  keeps diagnosis; the why band keeps optimize-for-signed-cases; the ROI
  FAQ owns click-to-close tracking; the book band keeps "wrote the book".
  The "Marketing, Intake, and Sales" formula now appears only in the locked
  hero lede and the contract-bound cinematic stage copy (plus the book's
  actual subtitle, off-page).
- Why band rebuilt as the belief-shift bridge: left-aligned single point
  ("A law firm's funnel is full of numbers, and most of them can look good
  while the firm stands still. We tune the whole engine on the one that
  can't — the signed case.") beside an aria-hidden metric-ladder crescendo
  (CLICKS → CALLS → LEADS → CONSULTS BOOKED → serif "Signed cases" / THE
  NUMBER WE TUNE ON), then the hand-off — "The engine that does the tuning
  is just below." + OPEN THE HOOD ↓ (#system), a deliberate
  call-and-response with the cinematic's opening stage eyebrow — and a
  pure-CSS eggshell→black seam whose gold shaft drops into the engine bay,
  so the dark band arrives announced. The seam sits wholly outside the
  cinematic's pinned scene/contract and reads identically in cinematic,
  reduced-motion static, and no-JS presentations. Dropped from the band:
  the "Most agencies report clicks…" lede and all three ticks (each claim
  rehomed per the audit above).
- Systems band reframed as receipts, not a re-introduction: eyebrow
  YOU'VE SEEN THE ENGINE RUN, H2 "Now Read the Gauges." — the deck-S39
  eyebrow ("EVERY LEAK HAS A SYSTEM. EVERY SYSTEM HAS A METRIC.") and the
  "Three Systems. One Measured Path to Signed Cases." H2 rotate out with
  the re-teach framing (S39 remains available in the deck). The three
  proof-fed cards and their figures are unchanged.
- FAQ de-dup: FAQ 1 → done-for-you accountability ("NoBull engineers
  revenue end to end: one team builds and runs the entire engine for your
  firm, and answers for the outcome — not just the ad spend."); FAQ 2 →
  sole homepage owner of tracking ("Click-to-close tracking on every
  matter, with dashboard reporting…at all times."); FAQ 3 → topics only
  ("Book a strategy call. It covers your goals and where your funnel
  stands today." — the fit-clause stays with the closing band). Book-band
  support now opens "The book behind the headline:" (lampshading the
  deliberate hero-H1 echo) and drops its trio restatement.
- Lockstep: final-copy §3/§5/§9/§15 updated, claim-ledger row 24 liveness
  note re-scoped (home ROI FAQ + about FAQs), home.ts header comment + CSS
  band comments refreshed, bundle regenerated.
- Proof band rebuilt as a case-study slider (Task #3915): “PROOF, NOT
  PROMISES / Different Firms. Same Engine.” with four deck-proof slides —
  Presti (Liberty Blue; stats unchanged, the engine-in-action line moved in
  from the band's old support copy, and the Michael Presti quote now renders
  verbatim from proof.ts, retiring the old hand-abridged excerpt), Burns
  Smith (white panel; 1,779-lead / 50-review totals, monthly lead ramp,
  Day 0/17/19 install chips), the unnamed Expansion Play (near-black panel;
  2×2 stats grid, April 2026 tag), and First Lead Records (crimson panel;
  the four first-lead records plus the approved /about/ measurement line).
  Every figure/quote renders from proof.ts, no numbers merged across firms,
  no new claims. Slider = arrows + dash-dots + 1/4 counter + ArrowLeft/Right
  + touch swipe (home-client/proofSlider.ts, data-mode convention); no-JS
  and prefers-reduced-motion keep the served stacked layout. Readability:
  new --gold-pale #EFD9AC replaces raw gold for small gold text on the
  blue/crimson case panels (5.0:1 / 6.2:1, vs 3.2:1 / 4.1:1 before — the
  old panel label was the last sub-AA gold text on a non-dark surface);
  light-surface labels keep --gold-ink (Task #3904); dark-band gold
  untouched (~9:1). Lockstep: final-copy arc note + §7 rewritten, §10
  liveness note, claim-ledger rows 1–4/7/8 + row 23 where-used updates.

### 2026-08-06 — Task #3910: Revenue Engine stage panels punched up
- Owner-reported: sparse stages (the opener and the growth closer) left a
  dead black void under a few lines of text in the fixed ~760×460 copy
  card, and the stage copy read bland ("Build lead flow." / "Remove intake
  friction."). All five stage narrations rewritten in the deck/book voice
  around the owner's engine metaphor (book editorial note): Marketing =
  the fuel, Intake = the fuel injector, Sales = the spark — with lines
  mined from deck S2 ("Fix the blind spot. Control the spend. Break the
  ceiling."), S30-33 (intent-high contact, drop-off recovery, "More lead
  flow creates the next constraint"), S39-44 ("isolate the final
  variable", "Record. Score. Coach. Repeat."), S59 ("FULL ENGINE
  INSTALLED", CaseGen creates / CaseIntake captures / CaseConvert closes)
  and the book's Growth Control chapter (throttle, dials, consolidate).
  Full decided copy: final-copy §4.
- No numbers or client facts placed in any panel (proof stays in the
  systems/credibility bands), so the claim ledger gains no "Where used"
  rows; banned items (guarantee, pricing, day-path promises, pseudonyms,
  promise-y CTA labels) verified absent from the new copy.
- De-dup honored: caseintake chips no longer restate the gap section's
  leak list (now deck-S33 plugs `Capture Faster / Guide Consistently /
  Follow Through`); the growth headline no longer pre-echoes the closing
  "Ready to Build Your Revenue Engine?"; the opener answers the why-band's
  `OPEN THE HOOD ↓` hand-off (deliberate call-and-response, per #3908).
- Panel composition reworked so every stage fills the card: bottom-anchored
  machine-plate output readouts (STAGE OUTPUT → Qualified Leads / Booked
  Consultations / Signed Cases; ENGINE OUTPUT chains all three on growth)
  and a three-row build manifest on the opener (01 CaseGen — The Fuel …).
  Progress rail now renders stage-owned numbers 00–04 that match the
  numbered eyebrows (the old index-based rail showed 02 beside `01 ·
  CASEGEN`). Growth stage rail label `Dominate` → `Control` (book's Growth
  Control System). Body text weight corrected to the Sweet Sans 600 floor.
  Card size/position, crossfade architecture, and every cinematic timeline
  number untouched (skill contract); mobile stacked stages + static/no-JS
  fallback carry the same copy + plates from the shared stageData source.
- Bundle regenerated (`npx tsx website/generate.ts`).
- Merge amendment (same day, after #3913/#3949 landed): growth body's first
  beat rewritten from `CaseGen creates the opportunity. CaseIntake captures
  it. CaseConvert closes it.` to `Fuel, injector, spark — the whole chain
  synced and firing.` — the trio construction structurally paralleled the
  proof band's Presti receipt line ("created the demand… captured it…
  closed it — 292 signed cases"), which owns it; the chain recap instead
  closes the opener manifest's fuel→injector→spark arc. The systems band's
  role tags (The Fuel / The Fuel Injector / The Spark Plug, #3913) echoing
  the opener manifest roles is deliberate index→detail continuation, kept.
### 2026-08-06 — Task #3913: Systems band rebuilt as the engine flow
- Presentation only at heart — the three flat white cards ("zero design",
  owner) became ONE connected engine in the book cover's black-gold
  machinery language: a gold fuel rail runs fuel tank (CaseGen™, crimson
  halo) → fuel injector (CaseIntake™) → spark plug (CaseConvert™, the only
  spark accent) → flywheel (REVENUE GROWTH, the outcome terminus), with
  role tags THE FUEL / THE FUEL INJECTOR / THE SPARK PLUG / THE FLYWHEEL
  per the messaging-architecture metaphor (no gears). The band goes
  engine-bay dark so the cinematic above hands off seamlessly; the light
  credibility band below reads as surfacing back out of the hood.
  Component art is new-generated in the frame-render language (the comp
  frames are stock-watermarked, never cropped) →
  `website/public/nobull-redesign/systems/`.
- Copy compression (stat-first): ladder one-liners verbatim; figures still
  interpolate from proof.ts, now as big before→after / multiplier readouts
  with small-caps labels — CASEGEN™ `2× / LEAD GROWTH IN 90 DAYS / LOCAL
  AUTHORITY OPTIMIZATION™` + `8× / LEAD GROWTH IN FIVE MONTHS / PAID SEARCH
  CONTROL`; CASEINTAKE™ `38.3% → 75% / LEAD-TO-CONSULT RATE · +96% / SAME
  LEAD FLOW — NEARLY TWICE THE CONSULTATIONS`; CASECONVERT™ `15% → 40% /
  CONSULT-TO-CASE RATE · 2.67× THE CLOSE RATE / CONSULTS DOWN FROM 90+
  MINUTES TO 30 OR LESS`. Each stat carries a LIVE CLIENT RESULT tag (dot
  + caps); the band microcopy sentence is unchanged. Retired: "…without
  another dollar of ad spend" (the same-lead-flow line carries it).
- NEW terminus copy (claim-free, firms stay unnamed; the named full-funnel
  story remains the Presti panel): label `REVENUE GROWTH`, line `Where fuel
  becomes signed cases.`, tag `THREE SYSTEMS · ONE OUTPUT`.
- Motion: staged fuel→inject→ignite→output reveal (home-client/
  engineFlow.ts), once-only ScrollTrigger, no pin/scrub, reduced-motion
  gated; served markup is the finished band (no-JS complete).
- Lockstep: final-copy §5 rewritten, home.ts header comment + CSS band
  comments refreshed, bundle regenerated.
### 2026-08-06 — Task #3949: Gap section de-dupe + redesign
- Single-statement discipline: the ~60-word lede that narrated every model
  number shrank to the one-sentence setup "Picture two firms generating
  the same 500 qualified leads — one leaky, one tuned." (the visible
  hypothetical cue still carries the model label — ledger row 19). The
  funnel numbers and dollar figures now land exactly once in visible copy,
  inside the duel chart + payoff receipt.
- Payoff receipt de-dupe: `THE CLIENTS — FROM THE SAME 500 LEADS` →
  `THE CLIENTS` (the chart's `SAME 500 LEADS IN` head tag owns that fact);
  the final `THE MILLION DOLLAR GAP` cap (which restated the eyebrow) →
  `OPENED ENTIRELY AFTER THE LEAD` (the phrase the old lede used to hold,
  now bridging into the WHERE IT LEAKS trade rows).
- Kicker replaced: "Your next $1,000,000 isn't in more leads — it's in the
  leads you already have." read as "you don't need more leads" and
  undermined the lead-gen offer. Now "Both firms had the fuel. Only one
  had the engine." — the hero's leads-alone-aren't-enough belief shift in
  the band's own fuel/engine language, no repeated figure, handing off to
  the Cases-not-Clicks band below.
- Accessibility: the chart stays aria-hidden, so a visually-hidden `.nb-vh`
  summary (fully GAP_MODEL-templated, like all band copy) now speaks the
  complete model — 100→20 vs 300→120, 6× the clients, $200,000 vs
  $1,200,000, the $1,000,000 gap — to screen readers.
- Design rebalance (impeccable pass): lede restyled as a one-line serif
  italic whisper bookending the serif italic kicker; H2+lede grouped tight
  with generous air below so the duel chart is the centerpiece;
  payoff/trades/kicker separations retuned; text-wrap:balance on lede +
  kicker. Animation contract untouched (`data-gap-anim` pending→done
  verified; reduced-motion ships the static final state).
- Lockstep: final-copy §2 + §3 diagnosis cross-ref, claim-ledger row 19
  liveness note, home.ts header + CSS band comments, proof.ts GAP_MODEL
  comment, approved-direction memory. Bundle regenerated.


### 2026-08-07 — Task #3995: closing band reordered — the ask now leads
- The closing band's running order flipped from eyebrow → fit/not-a-fit
  cards → bull → serif ask → CTA to: crimson bull mark + `Ready to Build
  Your Revenue Engine?` opening the band, the qualification cards between
  the heading and the ask cluster, then `Book a Strategy Call.` + sub-line
  + `BOOK A STRATEGY CALL →` closing the page.
- The `IS THIS YOUR FIRM?` eyebrow was REMOVED entirely (operator request —
  the serif heading now frames the cards, making the eyebrow redundant).
  Every other line of card + closing copy is verbatim; no claim-ledger rows
  point at this band (the eyebrow was navigational copy, not a claim), so
  the ledger is untouched.
- Spacing rebalanced for the new order at every width: the bull now opens
  the band (its old follows-the-cards top margins — 64/48/40px by width —
  are gone), heading→cards→CTA beats retuned so the band still reads as one
  unit, and stacked-card widths keep the CTA close beneath the cards.
- Lockstep: final-copy §13 + both section-order lines (home.ts header
  comment + final-copy), CSS band comment rewritten; bundle regenerated.


### 2026-08-07 — Task #3995 follow-through: closing CTA reassurance + polish

- Design-critique follow-through, operator-approved (exact sentence shown in
  preview and confirmed). The closing CTA sub-line is REPLACED:
  - old: `One conversation about your whole funnel — and whether the engine
    fits your firm.`
  - new: `Sound like a fit? The call is free, with our Head of Sales — a deep
    dive into your leads, consults, and signed cases, and a plan shaped to
    your growth goals.`
- Why: the critique flagged the moment of commitment as under-reassured
  (who/cost unanswered) and unbridged from the cards' fit verdict. The
  opening question ties the CTA to the qualification cards; every fact is
  owner-confirmed 2026-08-07 — free, Head of Sales, numbers deep-dive,
  growth plan (CONTENT_TRUTH_SOURCE §17, ledger #36). NO duration or
  call-behavior assurances — still withheld per ledger §5.
- Wording notes: draft's `Book the call.` was dropped (the H3 above and the
  button below already carry "book"); `growth&nbsp;goals` glue prevents a
  lone-word last line at desktop.
- Non-copy polish in the same pass: `.nb-btn` gains a gold-ink
  `:focus-visible` ring (home.css + site.css); the sub-line is capped at
  620px; each qualification list is now labelled for screen readers by its
  visible card label (`aria-labelledby` → A FIT IF / NOT A FIT IF).
- H2, both card lists, H3, and the button copy are UNCHANGED.
### 2026-08-07 — Task #3997: Endless testimonials band (5 videos, 11 quotes, marquee rows)

- The "What Clients Are Saying" band grew from 3 videos + 2 quotes to ALL
  five named client videos and eleven written reviews, presented as
  continuously scrolling seamless loops (video row + two counter-directional
  quote rows) for motion-allowed visitors. The served markup remains the
  complete static grid — that grid IS the no-JS / prefers-reduced-motion
  presentation (site animation contract).
- Videos: Presti Law (vimeo.com/1106263914) and Burns Smith Law
  (vimeo.com/1106262623) — both already embedded on /testimonials/, firms
  named via their public Vimeo titles, resolving the truth-source §5
  "(unnamed)" rows — joined the original trio as plain outbound anchors
  with committed posters matching the paused-player treatment.
- Quotes: the three /testimonials/ written reviews (Tessa Thrift, Lani
  Akiona, Stacy Grow — footed by role, never "Google Review") plus six
  newly transcribed Google reviews (Alec Chapa, Attorney Angelik Edmonds,
  Jake Cutler, Jayanta Acharyya, Susannah Bruck, Sam Varnerin) join the
  existing Alistair Schneider + Atara Twersky cards. All eleven render
  under the 2026-08-06 bracketed-anonymization policy; long originals
  excerpt at sentence boundaries; Sam Varnerin's excerpt deliberately
  omits the review's specific-result sentences (no new metric claims).
  The stars' aria-label is now "5 out of 5 stars" (was "5 star Google
  review" — wrong for the three role-footed quotes).
- Truth source: §4 gained a Google-review register with full verbatim
  transcriptions of ALL 11 committed screenshots, each citing its
  Review-N.png source — including the three deliberately NOT rendered
  (Ron Baranski — prospect who went another direction; Oluchi Igbokwe —
  collaborator voice; Quanta Study — free-consult/business account). The
  full Review-1/2 transcriptions surfaced small pre-existing smoothings in
  the inherited Alistair/Atara excerpts ("leader"→"leaders", an em-dash
  sentence join, dropped mid-sentence phrases, softened punctuation);
  renders are unchanged and the deviations are now documented per-review
  in §4 instead of living silently in the render.
- Accessibility/motion: loop clones are aria-hidden and tabindex-excluded
  (keyboard/AT users meet exactly ONE set of cards), hover or focus-within
  eases a row to a stop, focusing an off-screen card snaps it into view,
  rows pause while off-screen (IntersectionObserver), and the module uses
  zero ScrollTriggers — the Revenue Engine cinematic's pinned scene is
  untouched.
- Lockstep: final-copy §8 rewritten (band contract + full card inventory),
  truth-source §5 rows named + §6 pointed at the new register,
  claim-ledger testimonial-thumbnails liveness note, home.ts header +
  home.css band comments, main.ts Part 7. Bundle regenerated.
## Case-study punch-up — all seven renderings (2026-08-07, Task #3996)

Every number, quote, timeframe, and attribution still renders byte-identical
from `website/src/proof.ts`; this pass touched framing copy and presentation
only. Ledger rows #2/#4/#7/#8 render notes updated in lockstep.

- Homepage slider dead space fixed structurally: slides are flex columns and
  the trailing link pins to the panel foot, so the equal-height stretch
  (track sizes to the tallest slide) reads as breathing room, not the old
  dead block under Burns Smith/Expansion/records content (~40/90/150px on
  desktop, up to ~400px on phones).
- Presti slide: the verbatim S8 quote is the slide's payoff — pull-quote
  scale (20px serif italic) behind a 1px pale-gold rule. Copy unchanged.
- Burns Smith slide gains its missing narrative arc: lede "The turnaround,
  month by month: 150 new leads in month one, 513 in month five — no
  plateaus, no down months." (both figures interpolated from monthlyLeads).
- Expansion slide re-composed (was a bare 2×2 stat grid + the template
  line): lede "One winning location became the launchpad: the same engine,
  aimed at the next market, then the next."; launchpad ladder (1 solid + 3
  outline gold blocks on a rail, aria-hidden, captioned ONE WINNING
  LOCATION / +3 IN SIX MONTHS); $1.5M milestone hero with FIRST 100-CASE
  MONTH / April 2026 and 2,400+/228 support cells.
- First Lead Records slide re-composed (was a flat 2×2 grid, the only slide
  with no link): lede "Four firms, four practice areas, one pattern: not
  one of them waited more than three days for its first new lead." ("three"
  derived from the records at generate time — generator throws if they
  drift); launch→first-lead day race (LAUNCH/DAY 1–3 scale, one pale-gold
  bar per firm sized to its record, the +N day figure as text); gains
  SEE THE CASE STUDIES → /testimonials/#case-studies. The "Days from
  launch…" microcopy line stays on /about/ + demo only.
- Testimonials cards: the shared "Constraint: … Installed: …" opener is
  retired — each card now opens differently ("Demand was never the
  problem…", "The brief was blunt…", "One winning location became the
  launchpad.") and carries its own device: Presti = engine rail
  (created/captured/closed, claim #3 framing) into the 292 CASES SIGNED
  output + 3-up stat row; Burns Smith = existing ramp + timeline; Expansion
  = milestone panel (APRIL 2026 / $1.5M / FIRST 100-CASE MONTH + compact
  2,400+/228/3 row).
- Slider mechanics untouched: same four PROOF_SLIDE_NAMES, dot/arrow aria
  labels, no-JS stacked fallback and reduced-motion static presentation.
### 2026-08-07 — Task #3998: "Why NoBull" band removed (home)
- Deleted the `.nb-why` band ("WHY NOBULL / We Optimize for Cases, Not
  Clicks.") that sat between the Million Dollar Gap and the cinematic:
  eyebrow, H2, the single tuned-on-the-signed-case point, the aria-hidden
  CLICKS→CALLS→LEADS→CONSULTS BOOKED→"Signed cases" metric ladder, and
  the invite line "The engine that does the tuning is just below."
  (owner screenshot, 2026-08-07). The ladder pre-stated the exact stage
  flow the cinematic walks moments later, and the gap kicker ("Both
  firms had the fuel. Only one had the engine.") already lands the
  belief-shift beat. The band was last reworked by Task #3908; the owner
  saw that version and wanted the beat gone — removed, not re-slimmed.
  The page now flows gap → cinematic directly.
- Preserved the designed light→dark arrival: the "OPEN THE HOOD ↓"
  (#system) cue and the pure-CSS seam with the descending gold shaft
  moved onto the gap band's tail (.nb-gap-handoff / .nb-gap-seam /
  .nb-gap-shaft); the seam ramp now starts from the gap band's warm tone
  (was eggshell) and still lands on #090908, the cinematic's own top
  tone. Wholly outside the cinematic's pinned scene/contract — timeline
  numbers, stage starts/copy/boundaries, and frames untouched — and it
  reads identically in cinematic, reduced-motion static, and no-JS
  presentations. The cinematic opener's OPEN THE HOOD eyebrow keeps its
  call-and-response partner; the invite line was NOT carried over.
- Lockstep: final-copy section-order line + §2 tail hand-off entry + §3
  tombstone + §4 opener cross-ref; claim-ledger row 24 note (it said the
  differentiator band "now carries the optimize-for-signed-cases
  principle"); home.ts header comment; home.css (WHY block deleted, gap
  tail block added, .nb-sys-tap "answers" note renamed to .nb-gap-shaft,
  ≤850px/≤520px overrides); bundle regenerated
  (`npx tsx website/generate.ts`).


### 2026-08-07 — Task #3991: Million Dollar Gap compressed into two columns + gain-framed payoff (home)
- Band restructure (owner: chart and analysis paired, band shorter): the
  duel chart and the payoff receipt now sit side by side in a two-column
  `.nb-gap-cols` grid on desktop (chart left as the evidence, receipt
  right as the money story; stacks chart → receipt ≤850px). The chart's
  170px center stage-label spine is gone — stage labels ride centered
  above each bar pair so the mirrored bars keep their full length at
  half width. `aria-hidden` moved from the chart to the wrapper (it now
  covers the receipt too, as before the receipt lived inside the chart);
  the `.nb-vh` summary remains the accessible home for every figure.
- Payoff reframe (owner: "opened entirely after the lead" didn't land):
  the receipt's money moment now reads top-to-bottom as `AN EXTRA` /
  `$1,000,000` / `FROM THE SAME LEAD FLOW`, and the figure switched
  crimson → gold-ink — it's the tuned firm's upside, gain-framed, not a
  loss figure. `OPENED ENTIRELY AFTER THE LEAD` is retired. The `.nb-vh`
  summary tail changed in lockstep ("— an extra $1,000,000 from the same
  lead flow."). All figures stay GAP_MODEL-templated (model arithmetic
  untouched — claim ledger row 19 note updated); the services page's
  "same lead flow, better math" line is a different claim (CaseIntake
  row 11) and was not touched.
- Trade rows slimmed to a 2×2 full-width strip under the columns with a
  single centered `WHERE IT LEAKS → HOW IT'S TUNED` head line; the four
  leak → fix pairs are verbatim.
- Closer elevated (owner: make it land): `Both firms had the fuel. Only
  one had the engine.` is centered, spans the band, sits last under a
  lone gold rule (bookending the opening eyebrow), scaled up in earth
  ink with `fuel` in crimson and `engine` in gold-ink — the duel's side
  colors. Wording unchanged (Task #3949); still no dollar figure.
- Choreography: bars → receipt → trades → closer, all once-only
  ScrollTriggers at refreshPriority -1; the receipt is now queried from
  the section (sibling of the chart), and the closer got its own
  on-screen trigger. Count-up final-string restore, `data-gap-anim` QA
  stamp, and the complete static state for reduced-motion/no-JS all
  preserved.
- Lockstep: final-copy §2 (heading, support bracket, duel-chart line,
  trade-rows line, kicker line); claim-ledger row 19 note; home.ts band
  comments; home.css gap band header comment + both media blocks;
  gapDuel.ts header; bundle regenerated
### 2026-08-07 — Task #3999: gauges band merged into the cinematic stages
- Homepage "Systems in numbers" band deleted (operator direction — its
  middle re-walked the fuel → injector → spark → flywheel story the
  cinematic had just told, while holding the component art and live
  figures). Retired outright: eyebrow `YOU'VE SEEN THE ENGINE RUN`, H2
  `Now Read the Gauges.`, the standalone microcopy line `Live client
  results — each metric is one real firm, never an average.`, and the
  engine-flow reveal module (home-client/engineFlow.ts). Role tags
  unified to the opener manifest's names: `THE FUEL INJECTOR` → `THE
  INJECTOR`, `THE SPARK PLUG` → `THE SPARK` (`THE FUEL` and `THE
  FLYWHEEL` unchanged).
- Cinematic stages 01–04 became instrument panels carrying the band's
  material (final-copy §4; §5 now a merge tombstone): component art as a
  haloed porthole over role + one-line system function; the old stage
  plate fused with the readouts into an illuminated gauge strip — figures
  still interpolate from proof.ts (`2×`/`8×`, `38.3% → 75%`,
  `15% → 40%`), tagged `LIVE CLIENT RESULT` with the microcopy condensed
  to the stamp tail `— one real firm, never an average`; stage 04 carries
  the flywheel terminus (`THE FLYWHEEL` / `REVENUE GROWTH` / `Where fuel
  becomes signed cases.` / `THREE SYSTEMS · ONE OUTPUT`). Stage copy
  (eyebrows, H2s, bodies, chips, CTAs) unchanged; cinematic mechanics
  unchanged.
- Ledger rows 9–12 "Where used" now name the cinematic stage gauges (row
  10 previously omitted the home placement). Files: home.ts (band markup
  deleted, stage panels + gauge markup), stageData.ts (instrument
  fields), main.ts (engineFlow init removed), home.css (band CSS deleted,
  instrument/gauge CSS added), engineFlow.ts deleted; bundle regenerated
  (`npx tsx website/generate.ts`).

### 2026-08-07 — Task #4032: stage copy rewritten in the owner's book voice
- The cinematic's five stage panels drop the design-pack storyboard's
  invented ad-agency register — "machinery", "qualified demand",
  "No magic", "watch it assemble" appear nowhere in the manuscript —
  for lines mined from the book. Everything locked stays identical:
  eyebrows (incl. `OPEN THE HOOD` + gap-tail call-and-response), rail
  numbers/labels, progress boundaries, chips, manifest roles, plates,
  outputs, CTAs, machine art, proof figures, section order (cinematic
  skill contract; no timeline/art/interaction change).
- Per-line book sources:
  - open H2 `Your turn to see how the engine turns.` ← Ch1 "Now You Can
    See the Engine's Internals": "Now it's your turn to see how the
    engine turns." Body ← Ch1: "Marketing brings in leads, Intake
    converts leads into booked consultations, and then Sales converts
    consultations into paying clients." (compressed with the locked
    ladder nouns) + "Altogether, that's a Revenue Engine." + "I'll show
    you what has to be built…" (as "we'll show you each one");
    "under the hood" carried from the Introduction's closer "Let's open
    the hood."
  - casegen H2 `Marketing is the fuel.` ← Ch2: "I adore how it can feel
    like injecting fuel into an engine." Body ← Ch1: "These leads were
    qualified. They were people relevant to the attorneys' practice
    areas, local to their area, looking for help." + Ch2: "It'll get
    your phone ringing off the hook…" ("three fuel lines" = the three ™
    chips, kept). Instrument fn `Fills the engine with qualified
    leads.` — the messaging-architecture §2 ladder + CaseGen role row
    updated in lockstep ("demand" is not a book noun).
  - caseintake H2 `Someone still has to pick up.` ← Ch2: "…but you'll
    still need to be able to pick up." Body ← Ch1: "that just increases
    how many times a phone rings out to a full voicemail machine.
    That's not money." + Ch2: "Once they're ready to move, your
    potential client will hire an attorney fast" and "following up with
    your leads at every possible drop-out point". (The book's
    five-minute/21× speed figures deliberately NOT imported — no new
    ledger claims.) Locked fn unchanged.
  - caseconvert H2 `No one buys your law degree.` ← Ch2 verbatim:
    "No one buys a lawyer. No one buys your law degree. They buy help."
    (the payoff `They buy help.` opens the body — on 1024–1280 desktop
    cards this stage's long chip labels wrap to two rows, so the H2
    must hold two lines). Body ← Ch2: "They buy help.", "your Intake
    call is your first Sales call", "law
    schools may do an excellent job of teaching their students about
    the law, they do not even attempt to teach them about Sales",
    scripts + "record and transcribe all of our clients' consultations,
    give them all a score… to a personal Coach"; Ch1: consultations
    that "stalled out". Locked fn unchanged.
  - growth H2 `Your hand on the throttle.` kept — already the book's
    Ch4 register. Body ← Ch2: "Reviews fuel rankings. Rankings fuel
    leads. Leads fuel cases. Cases fuel more reviews. That is the
    flywheel." (loops stage 03's signed cases back to stage 01's
    reviews chip) + Ch4: dial-down steps, "Whatever your path, you have
    control." (a crank-it-up/ease-it-back clause was cut for card fit
    at 360px — every panel was fit-probed at 1440/1280/1024 desktop and
    390/360 mobile after the rewrite). Instrument
    fn `Success feeds greater success.` ← Ch1: "A strong Revenue Engine
    spirals a business upward very quickly as success feeds greater
    success." (replaces invented `Where fuel becomes signed cases.`).
- Same-sweep (exact-phrase only, no other band reworked): cinematic
  SR/noscript sequence description now reads "fills its CaseGen fuel
  system with qualified leads" (home.ts); /services/ meta → "CaseGen™
  fills the engine with qualified leads. CaseIntake™ books
  consultations…" (trimmed to hold ≤160 chars). Loader text `Opening
  the hood` kept — book-authentic.
- Lockstep docs: messaging-architecture §2 (ladder + role row) + new §3
  "Book voice" block (traits, authentic phrase bank, purge list, no-
  numbers rule); final-copy §4 stage/instrument/SR rows + /services/
  meta row; stageData.ts header comment. Claim ledger untouched — no
  numbers or new claims enter stage copy.
- Files: website/src/home-client/stageData.ts, website/src/pages/home.ts
  (SR line), website/src/pages/services.ts (meta); bundle regenerated
  (`npx tsx website/generate.ts`).

### 2026-08-07 — Task #4039: cinematic gauges simplified to one proof line; backdrop re-lit

- Owner-flagged: the merged gauge strips were overloaded (CaseGen carried
  two readouts, every readout carried an attribution sub-line, and the
  strip painted over the third detail chip on short desktop viewports),
  and the backdrop's flat 30% vignette dim crushed the machine's
  gold/metal range everywhere just to keep the flash frames soft.
- Each instrument stage now shows ONE proof readout (figure or
  before→after sweep + short metric caption), still interpolated from
  proof.ts at generate time, never hand-typed:
  - casegen: `2×` / `LEAD GROWTH IN 90 DAYS` (FOUNDATION_2X). The 8×
    Accelerator readout left the home gauge — /services/ (Accelerator
    row) and the demo-page proof band still render it (ACCELERATOR_8X).
  - caseintake: `38.3% → 75%` / `LEAD-TO-CONSULT RATE` (LEAD_TO_CONSULT;
    `+96%` lift + same-lead-flow context line now /services/-only).
  - caseconvert: `15% → 40%` / `CONSULT-TO-CASE RATE` (CONSULT_TO_CASE;
    `2.67×` lift + 90-minutes-to-30 clause now /services/-only).
  - growth: unchanged — flow + claim-free `THREE SYSTEMS · ONE OUTPUT`.
- All per-readout system-attribution sub-lines (`LOCAL AUTHORITY
  OPTIMIZATION™`, `PAID SEARCH CONTROL`, `SAME LEAD FLOW — NEARLY TWICE
  THE CONSULTATIONS`, `CONSULTS DOWN FROM 90+ MINUTES TO 30 OR LESS`)
  dropped from the home gauges. Honesty qualifier kept but tightened:
  stamp reads `LIVE CLIENT RESULT — one real firm` (tail shortened from
  Task #3999's `— one real firm, never an average`); no figure reads as
  a promised outcome.
- Presentation-only (no copy meaning changed): the uniform vignette dim
  was replaced by a gentle elliptical edge vignette + kicker corner
  scrim, and flash softening moved into the canvas frame draw (soft
  highlight knee + per-frame adaptive wash mute keyed to measured frame
  brightness) — machinery frames read rich again, flash moments stay
  muted, committed frames untouched. Fit: headings/chips/CTA rows
  compress on short landscape viewports (≤1023×≤520) which now shed
  detail chips like portrait phones; static/no-JS stages keep them.
- Lockstep docs: claim-ledger rows 9–12 "Where used" render notes;
  final-copy §4 live-readouts bullet, panel-composition paragraph, and
  per-stage gauge listings.
- Files: website/src/pages/home.ts (STAGE_READOUTS + gaugeMarkup),
  website/public/assets/css/home.css (vignette stack, gauge strip,
  responsive blocks), website/src/home-client/main.ts (drawFrameCover
  lighting); bundle regenerated (`npx tsx website/generate.ts`).

### 2026-08-08 — Task #4035: scale-up-only growth messaging (owner directive)

Owner directive (2026-08-07, operator-provided; now recorded in
CONTENT_TRUTH_SOURCE §18): the website must NEVER make the point that
growth can be throttled up **or down** ("rev it up, or ease it back",
"slow it down", growth as a two-way dial) — the growth-control concept
is reserved for the book. The website makes the opposite point: the
installed engine removes the ceiling — you can scale up as much as you
want. Directive-enforcement sweep over the post-#4032/#4033/#4039 site:

- Stage 04 (website/src/home-client/stageData.ts): rail label `Control`
  → `Scale` (rail aria becomes `Jump to stage 04: Scale`); H2 `Your
  hand on the throttle.` → `The ceiling comes off.` (source: the
  directive's own framing — "the installed engine removes the
  ceiling"; the deck was checked and holds no ceiling line to mine);
  body tail `That's the flywheel. Now growth is a dial. You have
  control.` → `That's the flywheel. It spirals your firm upward —
  scale as far as you want.` — the Ch2 flywheel chain stays verbatim;
  the new tail mines Ch1's "A strong Revenue Engine spirals a business
  upward very quickly as success feeds greater success." (the same
  sentence the nameplate fn quotes — the panel now reunites its two
  halves) and closes on the directive's scale-as-much-as-you-want
  point. Eyebrow, plate, instrument nameplate, gauge strip, outputs,
  stage boundaries, timeline all untouched (cinematic skill contract).
- Closing-band fit list (website/src/pages/home.ts): `You want growth
  you control — including when to slow it down` → `You want to scale
  up — and you don't want a ceiling` (#4033's restyled band untouched).
- /free-chapters/ endcap support line (freeChapters.ts): `how you keep
  control of growth once it's running` → `how you scale it once it's
  running` (site-voice line only; the verbatim excerpt text and the
  Ch4 ToC title `The Growth Control System` stay — the book keeps the
  concept; that is the directive's point).
- Sweep result: no other published surface carried the framing (page
  metas, SR + noscript text, loader, every other page and article
  clean; the homepage Growth Control band was already removed
  2026-08-06 — final-copy §11).
- Durability: tests/lint-website-banned-phrases.test.ts gained a second
  banned list (throttle, rev it up, ease it back, growth is a dial,
  dial you own, you have control, slow it down, growth you control,
  control of growth, consolidate) over the same scanned surfaces;
  messaging-architecture §3 diagnostic-frame vocabulary + Ch4 phrase
  bank flipped book-only and §6 #8 rewritten to uncapped scale-up;
  claim ledger #25 LIVE → WITHHELD (book-only); final-copy §4 voice
  bullet + growth row, §11 note, §13 fit list, and the /free-chapters/
  endcap row updated; the directive itself recorded in
  CONTENT_TRUTH_SOURCE §18 (Owner Messaging Directives).
- Files: website/src/home-client/stageData.ts,
  website/src/pages/home.ts, website/src/pages/freeChapters.ts,
  tests/lint-website-banned-phrases.test.ts, the four governance docs;
  bundle regenerated (`npx tsx website/generate.ts`).

### 2026-08-08 — Task #4120: align site copy with the book's final editorial direction

Source: the final editorial review of *The Law Firm Revenue Engine*
(`attached_assets/Law_Firm_Revenue_Engine_Final_Book_Review_1786232660649.pdf`).
Direction locked there: the promise is more top-line revenue (not
"growth"); REE (Revenue Engine Efficiency = attributable top-line
revenue ÷ Growth Investment) is the book's single public score under a
strict "Revenue is the goal, REE is the score" hierarchy (Money →
Revenue Engine → REE → Tuning); proof carries timeframe/basis labels;
"only company in the world" claims become defensible category
positioning; the sales page states the session's five-point promise.
The site is the book's companion sales surface — this pass aligns its
copy. (The REE calculator page, data-notes page, and sitewide soft-CTA
ladder are a separate follow-on task; `website/content/book-excerpt.json`
stays untouched until the revised manuscript DOCX exists.)

Revenue-first language sweep (goal-phrasing only — factual scale claims
stay unhedged: `350+ law firms grown`, `Hear It From The Firms We
Grow.`, the testimonials `too thin to grow on` brief, expansion/location
facts):
- Home meta title `NoBull Marketing — Law Firm Growth, Engineered` →
  `NoBull Marketing — Law Firm Revenue, Engineered`; meta description
  now sells "more revenue from the same leads, measured from first
  click to signed case". The LOCKED on-page hero eyebrow keeps
  `LAW FIRM GROWTH, ENGINEERED.` — owner flag 1 below.
- Book band support: `…the complete methodology for turning them into
  signed cases` → `…turning them into revenue` (follows the review's
  subtitle direction without touching the locked title).
- /resources/ title: `Law Firm Growth Library` → `Law Firm Revenue
  Library`. Shared recentNews sub (html.ts, all pages): `Growth
  playbooks, intake tactics…` → `Revenue playbooks, intake tactics…`.
- /about/: meta `growth partner` → `revenue partner`; Ronnie bio
  `engineering growth` → `engineering revenue`; pride copy now says
  we'll `grow your law firm's revenue`.
- /services/ intro: `Growth stalls when one is weak` → `Revenue stalls
  when one is weak`.
- Kept deliberately: /free-chapters/ meta `…turns leads into signed
  cases` (paraphrases the book's actual locked subtitle — swapping it
  to "revenue" would front-run the owner's subtitle decision, flag 3);
  the cinematic loader, stage 04 scale-up tail, and every factual
  "grown/grow" above.

REE strip (homepage `#ree` — the single sitewide REE introduction,
between the gap band and the cinematic; final-copy §2b, ledger #38):
- Eyebrow `REVENUE ENGINE EFFICIENCY` · H2 `Revenue Is the Goal. REE
  Is the Score.` · lede `One number tells you how expensive your
  revenue is to produce:`.
- Formula plate (aria-hidden): `REE = ATTRIBUTABLE TOP-LINE REVENUE ÷
  GROWTH INVESTMENT` over a gold hairline fraction bar, with a `.nb-vh`
  screen-reader sentence carrying the same content (gap-band SR-parity
  pattern).
- The example under a visible `ILLUSTRATIVE MODEL` chip: `Put $1 of
  growth investment in and get $8 of attributable revenue out — that
  engine runs at an 8× REE.` — never conflated with ledger #10's REAL
  8× lead-growth figure.
- ROAS distinction: `ROAS hands you a ratio. REE shows you where the
  ratio comes from — cost per lead, lead-to-case conversion, and case
  value — so you know which part of the engine to fix.`
- The `OPEN THE HOOD ↓` hand-off + light→dark seam moved intact from
  the gap band's tail onto this strip's tail (classes/markup unchanged;
  the gap band now ends on its kicker line). New `.nb-ree*` CSS: warm
  band continuation, serif score line, hairline-fraction plate, ≤850px
  and ≤520px compressions (formula wraps, terms shrink). REE appears
  once more on the page by NAME only — the flywheel terminus closer.

Per-system economic levers (the review's Ch2 summary logic; lever
lines are figure-free — stageData ships in the client bundle):
- Stage bodies gain lever tails: CaseGen `The lever: Cost per Lead,
  and the quality every dollar buys.` · CaseIntake `The lever:
  Lead-to-Consult rate — and how many actually show.` · CaseConvert
  `The lever: Consult-to-Case rate.`
- Flywheel terminus body: `…Cases fuel more reviews. That's the
  flywheel — spiraling your firm upward, as far as you want to scale.
  Lead cost, consult rate, close rate, case value: together they set
  your REE.` (Ch2 chain verbatim; #4035's uncapped scale-up point
  kept; the four levers echo the stages just walked; names the score
  without re-defining it.)
- /services/: intro gains `CaseGen™ builds the demand below — it sets
  your Cost per Lead and the quality behind it.`; the two systems
  cards open on their jobs — `The job: raise how many leads reach a
  consultation — and show up for it.` / `The job: turn booked
  consultations into paying clients.` (locked three-line ladder
  wording elsewhere untouched).

Booking page session promise (ledger #37 — replaces the three vague
WHAT WE'LL COVER steps): `1. Map your funnel — Marketing, Intake, and
Sales, from growth investment to paying client.` `2. Calculate your
Revenue Engine Efficiency (REE) — or the best honest estimate your
tracking supports.` `3. Identify the largest apparent revenue leak in
the engine.` `4. Put a number on the upside — the additional top-line
revenue if that leak were fixed.` `5. Decide whether The Law Firm
Revenue Engine™ fits your firm.` — estimate-honest wording is
load-bearing ("best honest estimate", "largest apparent", "put a
number on"); still no deliverable-artifact, duration, or call-behavior
assurances (ledger §5). CTA labels stay `Book a Strategy Call` — flag 2.

Proof-format labels (deck-backed only; zero new numbers):
- Presti engine line (home slider) + testimonials card body: `292
  signed cases and counting` → `292 signed cases in twelve months`
  (ledger #2's own ~12-month window; open-ended tail retired).
- Expansion slide + card support cells: `LEADS GENERATED` → `LEADS —
  SIX-MONTH TOTAL` and `5-STAR REVIEWS` → `5-STAR REVIEWS — SIX-MONTH
  TOTAL` (render-site label transform; proof.ts keys stay canonical).
  The $1.5M milestone stays single-month framed (`FIRST 100-CASE
  MONTH` + `April 2026`) and carries NO revenue-basis qualifier — flag
  4. The one-firm `never an average` qualifiers all stay.

Positioning + closing:
- Home FAQ rewritten (each still one claim): FAQ1 = category
  positioning `Most legal marketing agencies stop taking
  responsibility when the lead arrives. We don't. One team builds and
  runs the whole engine — Marketing, Intake, and Sales — and follows
  every opportunity from acquisition through signed-and-paid client,
  answering for the revenue, not just the ad spend.`; FAQ2 =
  revenue-measured ROI + estimate honesty (`We measure return the way
  you do: revenue. … we say so and give you the best honest estimate
  instead.`); FAQ3 = getting-started in session-promise language.
  /about/ FAQ1–2 aligned to the same positioning + revenue-measured
  frame (FAQ3 already topics-only).
- Closing band now opens on the review's close, directly under the
  `Ready to Build Your Revenue Engine?` H2: `You're already paying for
  a Revenue Engine. The question is how much money it's leaking.`
  (`.nb-close-lede`, serif italic; the locked owner-approved #36
  sub-line below is untouched — flag 5).

Docs in lockstep: messaging-architecture (§1 promise + hierarchy, §2
REE naming row + subtitle note + per-system levers, §4 session
promise + naming note, §6 narrative 3b + rewritten #9/#12, §7 label
rules); claim ledger (#2/#7 render notes, #36 tail note, NEW #37
session promise, NEW #38 REE model, §5 rows: $1.5M basis · call
naming · book subtitle · hero eyebrow); final-copy (title/meta,
section order, §2 tail moved, NEW §2b, §4 stage bodies, §7 slides 1+3,
§9 book support, §13 lede, §14 FAQs, /about/, /services/,
/book-free-demo/, /resources/ — plus deleted the two stale duplicate
§6 blocks at the file tail; the canonical §6 stands). Bundle
regenerated (`npx tsx website/generate.ts`).

OWNER FLAGS (decisions recorded, not guessed — locked copy untouched):
1. Hero eyebrow (LOCKED): `LAW FIRM GROWTH, ENGINEERED.` is now the
   main growth-as-goal surface. Proposed rewording, awaiting approval:
   `LAW FIRM REVENUE, ENGINEERED.` — one word, matches the new meta
   title and the book's promise.
2. Call naming: the book (and deck S55) call the sales call a **High
   Impact Revenue Session**; the site says **Book a Strategy Call**
   everywhere. Drafts for both — keep: current labels unchanged;
   adopt: page H1 `Book a High Impact Revenue Session`, buttons `BOOK
   YOUR SESSION →`, closing H3 `Book a High Impact Revenue Session.`
   Adopting touches every CTA instance + ledger #36/#37 +
   messaging-architecture §4 — only on owner sign-off.
3. Book subtitle: the review recommends ending `…Turn Them into
   Revenue` if the subtitle is not already finalized. Site copy keeps
   the locked current title; cover/subtitle assets out of scope.
4. $1.5M revenue basis (ledger #7/§5): gross fees vs collected revenue
   is deck-unstated — no basis qualifier shipped; needs owner
   confirmation before wording like "in collected revenue".
5. Closing sub-line (LOCKED, ledger #36): its tail `…a plan shaped to
   your growth goals` is the last goal-as-growth phrase on the
   homepage. Proposed rewording, awaiting approval: `…a plan shaped to
   your revenue goals` (single word; stays inside the owner-confirmed
   fact set — "growth goals" was the owner's phrasing, so this needs
   explicit sign-off, not a silent edit).

RESOLVED — Task #4124, 2026-08-09: owner decided all five flags.
1. Hero eyebrow → ADOPTED: `LAW FIRM REVENUE, ENGINEERED.` (live).
2. Call naming → ADOPTED: "High Impact Revenue Session" sitewide —
   H1 `Book a High Impact Revenue Session`, buttons `BOOK YOUR SESSION
   →`, closing H3 `Book a High Impact Revenue Session.`, all running
   text and footer links updated; ledger #36/#37 updated.
3. Book subtitle → NOT FINAL: subtitle still unconfirmed — site keeps
   the locked current title; revisit when print is final.
4. $1.5M basis → COLLECTED REVENUE: `FIRST 100-CASE MONTH —
   COLLECTED REVENUE` label now live on home proof slider and
   testimonials card; ledger #7 updated.
5. Closing sub-line → ADOPTED: `…a plan shaped to your revenue goals`
   (live in home closing band); ledger #36 updated.
- Files: website/src/pages/home.ts, website/src/home-client/stageData.ts,
  website/src/pages/services.ts, website/src/pages/demo.ts,
  website/src/pages/about.ts, website/src/pages/resources.ts,
  website/src/pages/testimonials.ts, website/src/html.ts,
  website/public/assets/css/home.css, the four governance docs;
  bundle regenerated (`npx tsx website/generate.ts`).

### 2026-08-09 — Task #4121: REE calculator + data notes + the CTA ladder wired sitewide

The book revision's sales architecture is an intentional CTA ladder —
soft (calculate your REE) → diagnostic (identify your highest-dollar
lever) → hard (book the call). This task builds its centerpiece and
wires the rungs. Two NEW pages; five surfaces gain calculator entry
points; the hard ask stays exactly one per page.

**NEW `/calculator/` (ledger #39; messaging-architecture §4 ladder + §5 row):**
- H1 `Score Your Revenue Engine.` / eyebrow `REVENUE ENGINE EFFICIENCY` /
  sub promises the score + lever pricing, `Free, no email required.`
- Form (all math in-browser; privacy line `Runs entirely in your browser —
  nothing you enter is stored or sent.`): cohort period + maturity window,
  Growth Investment, leads, consults booked/held (optional), signed
  clients, revenue basis (average per signed client OR attributable
  revenue), optional practice area / market / the firm's OWN targets.
- Results (review's recommended language): confidence chip (`Actual
  data`/`Estimated`) + `Your REE`/`Estimated REE` heading, the verbatim
  headline sentence ("…produces an estimated $X.XX in top-line revenue
  for every $1 invested in client acquisition." — "estimated" drops only
  on actual-confidence data), eight metric tiles, five +10%-relative
  lever scenarios ranked by dollar upside, `Your highest-dollar lever
  appears to be: ___` callout. Tie honesty: a complete funnel makes all
  five upsides EQUAL (product-of-levers arithmetic) — the callout says
  "any of them" and prices the shared upside instead of faking a winner.
  No judgments, no benchmarks, no email gate; "fuller report" = print.
- Handoff (review verbatim): `Want us to validate the data and identify
  the fastest way to capture this revenue?` → `Book a Strategy Call` →
  `/book-free-demo/` carrying the headline result as query params; the
  booking form pre-fills an editable message (site-client prefill,
  `client-shared/reeHandoff.ts` contract). Guidance aside: `Measure a
  cohort, not a month.` + Estimated-REE rules + `No benchmarks, on
  purpose.`
- Footer strip links `/data-notes/` (v1.0) with the illustrative-model
  disclaimer.

**NEW `/data-notes/` (ledger #40):** versioned appendix (v1.0 —
Aug 9, 2026) — REE + funnel definitions/formulas, the sensitivity method
(equal-dollars property + 100% caps), the $5.80 worked example RENDERED
from the live calculator math at generate time (drift kills the build),
and a provenance table typing every published figure (owner-confirmed
aggregates / single-firm tracked results / illustrative models). States
explicitly: no practice-area benchmarks published as of v1.0.

**Soft-CTA wiring (one per surface, always visually secondary):**
- Home REE strip tail: `CALCULATE YOUR REE →` text CTA (strip stays the
  score's single INTRODUCTION; calculator = its sanctioned WORKING
  surface, ledger #38 note).
- Home closing band: quiet secondary line under the CTA — `Want a number
  first? Calculate your Revenue Engine — free, no email required.`
  (phrased to avoid colliding with the contact band's `Not Ready To
  Book? Just Ask.` directly below).
- `/free-chapters/` endcap actions row: `Calculate your Revenue Engine →`
  gold text link beside the hard ask (the book revision's end-of-Ch2
  calculator CTA rung); floating bar gains `CALCULATE YOUR REE` link
  (hidden ≤700px) + aria-label update.
- Article sidebar: `.side-calc` card (`Score Your Revenue Engine` / one
  cohort in, REE + lever out / `Calculate your REE →`) above the
  unchanged `Book a Strategy Call` button.
- `/resources/`: `.res-calc` band before the Calendly band — eyebrow
  `Start With Your Score`, H2 `How Hard Does Your $1 Work?`, text-link
  CTA.
- Shared + homepage footers: `REE Calculator` added to the RESOURCES
  column.

**Owner flags (Task #4121):**
1. Book QR / printed-URL target: the calculator lives at
   `/calculator/`; the manuscript's back-matter still prints
   `nobullmarketing.com/talk` (ledger §5 row updated). **RESOLVED
   2026-08-09**: owner confirmed the printed URL/QR will be updated to
   `nobullmarketing.com/calculator/` before the book ships. No `/talk`
   redirect is needed; the ledger §5 row is marked done.
2. Benchmarks stay unpublished (review defers them): when real cohort
   data exists someday, publish samples/definitions on `/data-notes/`
   (new version) BEFORE any benchmark claim ships.
- Files: website/src/pages/calculator.ts + dataNotes.ts (new),
  website/src/calc-client/ (new: math.ts + main.ts),
  website/src/client-shared/reeHandoff.ts (new),
  website/src/site-client/main.ts, website/src/pages/home.ts,
  freeChapters.ts, article.ts, resources.ts, website/src/html.ts,
  website/generate.ts, assets/css/site.css + home.css, the four
  governance docs; bundle regenerated (`npx tsx website/generate.ts`).

### 2026-08-09 — Task #4166: Homepage distill + REE scoreboard (owner decisions, 2026-08-09 consult)
- Page-wide distill at standard depth: the homepage's rendered word count
  drops ~10% overall (locked pools — verbatim testimonial quotes, hero,
  team, FAQ answers, chart/stat figures — cap the reachable cut; every
  unlocked redundant lede was cut or halved). Headings still tell the
  complete argument (messaging-architecture §6 rule) — every cut removed
  copy that RESTATED its own heading or a neighboring visual object.
- REE strip rebuilt as the page's SCOREBOARD moment (final-copy §2b):
  eyebrow → H2 → formula plate as the crafted visual centerpiece (engraved
  brass-plaque object: double gold-ink hairline, warm-metal gradient, THE
  SCORE tab, schematic corner ticks — gold-ink chrome only, bright gold
  stays dark-band exclusive) → the $1→$8=8× example FUSED to one line
  under the now-inline ILLUSTRATIVE MODEL chip (ledger #38) → CALCULATE
  YOUR REE → CTA. Band lede (`One number tells you how expensive your
  revenue is to produce:`) removed — the plate speaks for itself. Visible
  band copy ~41 words (was ~87). Once-on-entry reveal via
  home-client/reeReveal.ts under the gap band's motion contract; the
  `.nb-vh` SR sentence, OPEN THE HOOD hand-off and light→dark seam are
  untouched.
- ROAS deleted SITEWIDE — owner: "lawyers don't think in ROAS." The
  strip's `ROAS hands you a ratio. REE shows you where the ratio comes
  from — cost per lead, lead-to-case conversion, and case value — so you
  know which part of the engine to fix.` paragraph no longer renders, and
  the ROAS distinction is purged from final-copy §2b and
  messaging-architecture §1/#5 + §6/3b. lint-website-banned-phrases now
  bans `ROAS` (fully bounded match) in rendered copy AND the decided-copy
  docs; this changelog keeps history verbatim and is deliberately not a
  scanned surface. The cost-per-lead / conversion / case-value triad left
  the band with it — the cinematic's stage bodies own the levers.
- WHERE IT LEAKS / HOW IT'S TUNED trade strip FOLDED (final-copy §2): the
  four leak names now ride the duel chart's shortfall captions (`200
  fewer consults booked — missed calls, slow follow-up` / `100 fewer
  cases signed — weak consult offer, too much friction`) and the gap
  `.nb-vh` summary's new closing sentence; the fix answers left visible
  copy — the cinematic's stage bodies walk every fix two bands later.
- Redundant-lede cuts: proof-band support cut to the never-an-average
  sentence; Burns Smith / Expansion / First-Lead-Records slide ledes
  tightened (figures and interpolations unchanged); testimonials eyebrow
  `WHAT CLIENTS ARE SAYING` removed; book support loses `The book behind
  the headline:`; closing lede tightened to `You're already paying for
  one…` (the locked #36 sub-line untouched); contact form lede removed.
- Cinematic stage-panel bodies tightened ~16% (stageData.ts; final-copy
  §4 mirrors): contract-locked lines — lever tails, the verbatim flywheel
  chain, `as far as you want to scale`, all stage names/mechanics/gauge
  figures — kept byte-identical, which caps the trim below the page-wide
  target. Panels and mobile stacks still render from the ONE shared
  stage-copy module.
- Files: website/src/pages/home.ts, website/src/home-client/stageData.ts
  + gapDuel.ts + main.ts + reeReveal.ts (new),
  website/public/assets/css/home.css, tests/lint-website-banned-phrases
  .test.ts, the four governance docs; site regenerated
  (`npx tsx website/generate.ts`).


### 2026-08-09 — Task #4186: Closing band §13 copy record reconciled to rendered wording

The decided-copy record in `docs/website-final-copy.md` §13 drifted from the
live site after Task #4168 (closing-band recomposition, zero-copy by mandate)
left the §13 H3, CTA, and sub-line quotes pointing at the old "Book a Strategy
Call" naming. The rendered site has carried "Book a High Impact Revenue Session"
wording since an earlier styling pass; the copy doc was never updated in
lockstep. No rendered strings changed — doc only.

- **H3:** `Book a Strategy Call.` → `Book a High Impact Revenue Session.`
  (rendered wording confirmed canonical by owner, 2026-08-09)
- **CTA:** `BOOK A STRATEGY CALL →` → `BOOK YOUR SESSION →`
- **Sub-line "…goals" tail:** `growth goals` → `revenue goals`
  (the live page already renders `revenue&nbsp;goals`)
- §13 record now carries an explicit note: do not revert to "Strategy Call"
  in the closing H3 or CTA; that phrase survives only in the footer COMPANY
  link, FAQ 3 answer, and the §14 contact band.
- Files: `docs/website-final-copy.md` §13 (doc-only); no rendered output
  changed.

### 2026-08-09 — Task #4165: Hero trust line — $150M+ revenue aggregate goes LIVE

- Owner confirmed the **$150M+ in new client revenue** all-time aggregate
  directly in session (2026-08-09) by explicitly selecting it when offered —
  ledger #17 flipped WITHHELD → LIVE (it had been withheld as a legacy-site
  metric with no deck source since the original overhaul). New proof.ts
  export REVENUE_GENERATED; the figure never renders inline.
- Hero trust line replaced (the operator called the old line the hero's
  weakest element): `✓ 350+ law firms grown` →
  `✓ $150M+ in new client revenue — across 350+ law firms we've worked
  with`. Same check-mark small-text treatment and locked hero layout;
  `.nb-trust` moved to baseline alignment + a wrap-friendly line-height
  for the longer line on narrow viewports.
- Cumulative clarification recorded in the same owner answer: the 350+
  figure is firms worked with over time, NOT an active-client count —
  ledger #13 annotated; the trust line's "we've worked with" tail carries
  that framing. Wording audit of the other 350+ placements (home metrics
  band `Law Firms Grown`, services intro `Proven across 350+ law firms`,
  data-notes provenance row `built and proven across`) — all already
  past-tense/cumulative, left untouched.
- Out of scope honored: metrics band keeps its three stats (1,000,000+ /
  30,000+ / 350+); no other hero change.
- Lockstep: ledger #17/#13 + §5 blocker row resolved, final-copy §1 trust
  line updated; bundle regenerated (`npx tsx website/generate.ts`).
- Files: website/src/proof.ts, website/src/pages/home.ts,
  website/public/assets/css/home.css, docs/website-claim-ledger.md,
  docs/website-final-copy.md; site regenerated.
### 2026-08-09 — Task #4168: Closing band recomposed to one display peak (ZERO copy change)
- Layout/typography only — every rendered string in the band is
  byte-identical (locked #36 sub-line, fit bullets, alt-line included);
  this entry records presentation, not copy.
- The band's two competing serif display headings resolve to ONE peak:
  the opening H2 keeps display scale (phone floor 3rem→2.2rem so it no
  longer out-scales the hero H1 at 390px), while the ask line steps down
  decisively (contact-H2 step → clamp(1.5rem,2.2vw,2rem)) with the gold
  closer rule tied tight above it (28→18px; the 76px cards→ask void is
  now one deliberate 64px transition) — the cluster still closes the
  page as its final beat over the enlarged button.
- Qualification duel stacks at ≤1000px at the lede's 640px column
  (the 851–1000px two-up squeezed cards to ~385–425px with every fit
  bullet double-wrapped); two-up widths balance the not-fit card's
  shorter verdicts with airier rows (fill tuning only, same glyph rail).
- Files: website/src/pages/home.ts (comment layers only),
  website/public/assets/css/home.css, docs/website-final-copy.md §13
  Treatment line; bundle regenerated (`npx tsx website/generate.ts`).

### 2026-08-10 — Task #4195: Copy-record sweep — every stale "final copy" quote reconciled to the rendered site (ZERO rendered-copy change)
- Follow-through on Task #4186 (§13 closing band): a systematic comparison of
  every verbatim quote in `website-final-copy.md` against the rendered
  bundle (`website/public`) + page sources found the same false-canonical
  pattern in many more sections. Root cause in every case: Task #4124's
  owner flag resolution (2026-08-09) renamed the call "High Impact Revenue
  Session" SITEWIDE and adopted the `LAW FIRM REVENUE, ENGINEERED.` hero
  eyebrow, but the final-copy record was only partially updated (§13 by
  #4186). One further stale tail predated that: the doc's /testimonials/
  Presti body still quoted `292 signed cases and counting.` although the
  rendered page carries the Task #4120 `in twelve months` window (the home
  slide's record had been fixed; the testimonials record had not).
- Reconciled in `website-final-copy.md` (doc-only; the rendered site is
  untouched and the committed bundle already carries all of this):
  - Homepage header note + §1: hero eyebrow record `LAW FIRM GROWTH,
    ENGINEERED.` → `LAW FIRM REVENUE, ENGINEERED.` (adopted, no longer
    "not applied"); hero primary CTA `BOOK A STRATEGY CALL →` →
    `BOOK YOUR SESSION →`.
  - §13 H3 note: "Strategy Call survives in footer/FAQ 3/§14" was already
    stale when written-adjacent surfaces renamed — corrected to "zero
    Strategy Call strings render anywhere sitewide".
  - §14 FAQ 3 + footer COMPANY link + /about/ FAQ 3: session naming.
  - /services/ row + systems-card CTAs → `Book a High Impact Revenue
    Session`.
  - /testimonials/ Presti body tail → `…292 signed cases in twelve months.`
  - /book-free-demo/: title, meta, H1 → session forms; the "naming stays
    Strategy Call pending owner decision" note marked RESOLVED (#4124).
  - /free-chapters/: endcap action + floating-bar primary + bar aria-label
    → session naming.
  - /calculator/: tie-callout tail, no-priceable-levers copy, handoff lede
    + CTA, and the no-JS fallback link → session naming (client-rendered
    strings verified in `calc-client/main.ts`).
  - /resource/<slug>/ sidebar hard-ask CTA and the shared calendlyBand
    default heading → `Book a High Impact Revenue Session`.
- Verified NOT drifted (mechanical backtick-quote sweep + manual review of
  ~120 flagged candidates): all page titles/metas, hero lede + trust line,
  gap band, REE strip, cinematic stage copy, metrics, proof slides 2–4,
  testimonials rows, book band, closing band (per #4186), contact/FAQ 1–2,
  about/services/free-chapters/calculator/data-notes/resources bodies —
  remaining flags were retired-copy history entries (correctly absent),
  markup-split spans, or CSS-uppercased eyebrows.
- No claim-ledger changes: no figure, claim, or wording changed on the
  site; this entry corrects the record only. Bundle untouched (doc-only).
- Files: docs/website-final-copy.md, docs/website-copy-changelog.md.


### 2026-08-10 — Task #4259: Homepage narrative bridge — Gap → Engine → REE → proof (owner feedback)
- Source: owner-uploaded narrative critique
  (`attached_assets/Pasted-Yes-your-instinct-is-right-On-the-live-preview-https-a5_1786371471841.txt`,
  2026-08-10). Diagnosis adopted: the homepage showed the scoreboard
  before explaining what was being scored — the gap band priced a leak,
  the REE strip posted a score, and only the cinematic (much later)
  explained that three systems form one engine. The rework states the
  causal chain at the moment each beat needs it: Gap (priced) → the gap
  lives in the HANDOFFS of Marketing/Intake/Sales → those three systems
  ARE the Law Firm Revenue Engine™ → REE scores that whole system →
  quick per-stage proof → cinematic as the detailed walkthrough.
- Gap band (§2):
  - H2 `Same Leads. Very Different Firm.` → `Same 500 Leads. $1,000,000
    Apart.` (figures GAP_MODEL-templated; the generate-time arithmetic
    check still guards them).
  - Lede `Picture two firms generating the same 500 qualified leads —
    one leaky, one tuned.` → `Picture two firms: one turns 500
    qualified leads into 20 signed cases; the other turns the same 500
    into 120. The difference isn't lead volume. It's what happens
    between the lead and the signed case.` (keeps the ledger-#19
    hypothetical cue; deliberately supersedes the #3949
    numbers-land-once rule for the HEADLINE figures — the receipt still
    proves the $1,000,000 the H2 poses).
  - Each duel row gains its responsible system tag — `CASEGEN™ ·
    MARKETING` / `CASEINTAKE™ · INTAKE` / `CASECONVERT™ · SALES` — and
    the `.nb-vh` summary opens each stage on the same attribution.
  - Closer: the kicker `Both firms had the fuel. Only one had the
    engine.` (locked since #3949) is RETIRED for the handoffs bridge:
    `The Million-Dollar Gap lives in the handoffs.` + `Marketing
    creates qualified opportunity. Intake turns that opportunity into
    booked consultations. Sales turns consultations into signed
    clients. Together, those three systems form the Law Firm Revenue
    Engine™.` — the band now names WHERE the gap lives and WHAT the
    three systems form before the strip scores it.
- REE strip (§2b) — scoreboard untouched (plate, `.nb-vh` formula
  sentence, $1→$8 example, CTA all byte-stable); three additions:
  - Connection line under the H2: `The Million-Dollar Gap shows what is
    being lost. Revenue Engine Efficiency shows how efficiently the
    entire system turns growth investment into attributable top-line
    revenue.`
  - `WHAT MOVES THE SCORE` lever list: `Cost and quality of qualified
    leads` / `Lead-to-consultation rate` / `Consultation-to-case rate`
    / `Average revenue per signed case` (the four-lever summary moves
    here from the flywheel terminus).
  - Diagnostic-role clarifier: `REE is not the goal and it is not a
    fourth system. It is the diagnostic score that shows where the
    engine is limiting revenue. We do not optimize the ratio at the
    expense of producing more total revenue.`
  - The #4166 deletions stay deleted: no explainer lede, no metric
    comparisons of any kind.
- NEW tuned proof ribbon (§2c) between the REE strip and the cinematic:
  `What happens when each stage is tuned` over three readouts
  interpolated from the existing proof exports ONLY (FOUNDATION_2X /
  LEAD_TO_CONSULT / CONSULT_TO_CASE — ledger #9/#11/#12; the same
  figures the cinematic gauges re-read in-context, a deliberate double)
  plus `Each number represents one real firm's result, never an
  average.` The `OPEN THE HOOD ↓` hand-off + light→dark seam moved
  intact from the REE strip's tail to the ribbon's tail (third home:
  gap → REE #4120 → ribbon #4259).
- Cinematic bookends (copy ONLY — frames, timings, stage boundaries,
  manifest, plates, gauges, CTAs untouched):
  - Opener H2 `Your turn to see how the engine turns.` → `Three
    Systems. One Revenue Outcome.`; body `Marketing brings in leads.
    Intake books consultations. Sales signs cases. Altogether, that's a
    Revenue Engine — scroll, and we'll show you each one.` → `Each
    stage has one job, one primary conversion point, and one output.
    Now let's open the hood and show you how NoBull improves each one.`
    (the gap bridge owns the three-function chain now — the opener
    stops restating it).
  - Terminus H2 `The ceiling comes off.` → `Every Improvement
    Compounds.`; body → `When Marketing, Intake, and Sales operate as
    one system, every improvement makes the other stages more valuable:
    more qualified leads reach consultations, more consultations become
    signed cases, and more attributable revenue becomes available to
    reinvest.` RETIRED with it, superseding the #4120/#4166 stage-copy
    contract lines: the Ch2 flywheel chain `Reviews fuel rankings.
    Rankings fuel leads. Leads fuel cases. Cases fuel more reviews.`,
    the spiral clause with its formerly locked `as far as you want to
    scale` tail, and the four-lever closer `Lead cost, consult rate,
    close rate, case value: together they set your REE.` — the lever
    summary lives on the REE strip now, and no homepage surface outside
    the strip names the score anymore.
- Rationale, in the owner's framing: name the machine at the moment the
  reader feels the pain (the bridge), define the score's ROLE where the
  score lives (the strip), give one quick per-stage receipt before
  asking for scroll depth (the ribbon), and let the cinematic be the
  detailed explanation instead of the first explanation.
- Records updated in lockstep: website-final-copy.md (section order,
  §2, §2b, new §2c, §3 flow note, §4 opener/growth),
  website-messaging-architecture.md (§1 #5, §2 lever note, §3
  phrase-bank annotation, §6 items 3/3b/new 3c/#8),
  website-claim-ledger.md rows 9/11/12 (ribbon in Where-used), 19 (lede
  form + headline-figure supersession), 25 (stage-04 note), 38 (strip
  location/composition; terminus reference retired). Guards:
  copy-playbook drift + banned-phrases lints, freshness stamp,
  gap-arithmetic check.
- Files: website/src/pages/home.ts,
  website/src/home-client/stageData.ts,
  website/src/home-client/reeReveal.ts, website/src/proof.ts (comment),
  website/public/assets/css/home.css, website/public/* (regenerated),
  docs/website-final-copy.md, docs/website-messaging-architecture.md,
  docs/website-claim-ledger.md, docs/website-copy-changelog.md.
### 2026-08-10 — Task #4253: Proof-band H2 retuned to the revenue outcome
- Homepage proof band H2: `Different Firms. Engines Tuned for Revenue.`
  (was `Different Firms. Same Engine.`) — owner-approved verbatim. The
  book's final editorial direction (marine-diesel vs jet) reads "same
  engine" as wrong: different firms run differently tuned engines — a few
  high-value cases or high throughput of lower-value ones; volume is one
  lever, not the objective. The new H2 keeps the different-firms trust
  signal and ties the tuning to the outcome ("No reader cares that an
  engine is tuned unless the tuning produces more revenue").
- Everything else in the band untouched: `PROOF, NOT PROMISES` eyebrow,
  the never-an-average support line, all four slides, slider controls.
  Deliberately NOT changed (accurate under the tuned-engines framing —
  each describes one firm's own engine replicated across its markets):
  the Expansion slide lede `The same engine, aimed at the next market,
  then the next.` and the /testimonials/ Expansion body. The diesel/jet
  metaphor itself stays book-only.
- Lockstep: final-copy §7 H2 line carries the rename history; bundle
  regenerated (`npx tsx website/generate.ts`).

### 2026-08-10 — Task #4259 follow-up (same session): tuned ribbon REPLACES the in-cinematic proof
- Owner direction (chat, 2026-08-10, verbatim): "note the new proof
  ribbon should replace the proof in the actual cinematic, pull that out
  all together, its distracting".
- Change: the cinematic's middle stages dropped their gauge readouts —
  the `2×` figure, the `38.3% → 75%` and `15% → 40%` sweeps, the metric
  captions — and the `LIVE CLIENT RESULT — one real firm` stamp (gold
  pilot dot). Every stage plate now renders the flat output-flow bezel
  the flywheel terminus already used (STAGE OUTPUT / ENGINE OUTPUT +
  storyboard flow); the terminus keeps its `THREE SYSTEMS · ONE OUTPUT`
  tag. One renderer feeds the desktop panels, the mobile stage stack,
  and the static/no-JS presentation, so all three change together.
- The tuned proof ribbon (built earlier in this task) is now the
  homepage's ONLY statement of the three per-stage figures; the
  "deliberate double" recorded this morning lasted one session. Figure
  history: Task #3999 fused the readouts into the stages, Task #4039
  distilled them to one per stage, this follow-up removed them.
  /services/ and demo-page receipts untouched.
- Mechanics untouched (cinematic skill contract): frames, stage
  boundaries, pin/scrub, progress rail, nameplates, detail chips.
- Lockstep: final-copy §4 Live-readouts bullet rewritten as RETIRED
  (+ §2c/§5/section-order notes); messaging-architecture arc item
  updated; claim-ledger rows 9/11/12 "Where used" drop the gauge
  entries; STAGE_READOUTS deleted from the generator and the orphaned
  gauge CSS (stamp/figure/sweep/caption rules) removed with it; site
  regenerated.

### 2026-08-10 — Task #4261: Homepage proof rebalance & CTA unification
- Implements the owner recommendations doc (§1/§2/§4/§7/§8/§9/§10 of
  `attached_assets/Pasted--Updated-Recommendations-After-the-Gap-REE-Work-
  This-re_1786372529054.txt`); builds on #4259 (gap/REE/ribbon) and #4253
  (proof H2) — both bands untouched here.
- Credibility metrics (owner doc §2): band moved from after the cinematic
  to directly after the press strip (band rhythm hero egg → press warm →
  metrics egg → gap warm) and recomposed outcome-first — `$150M+ / In New
  Client Revenue` (NEW band surface, ledger #17) · `350+ / Law Firms
  Worked With` (renamed from `Law Firms Grown` — #13's mandated cumulative
  framing; the ledger documents no defensible "grown" standard) · `10+ /
  Years of Results` · `1,000,000+ / Leads Generated`. `30,000+ / Five-Star
  Reviews Generated` rotated out (#35 → WITHHELD; the owner doc's
  sanctioned alternate for slot 4). metricStat() now renders `$`/`M` as
  static aria-hidden spans so the statsBand count-up stays digits-only.
- Proof slider rebalanced one-card-per-system (owner doc §1): slide 1
  Burns Smith opens on `CASEGEN™ RESULT · MARKETING` (content otherwise
  unchanged); slide 2 NEW CaseIntake rate card (`ONE FIRM'S INTAKE,
  REBUILT` / `Same Lead Flow. Nearly Twice the Consultations.` /
  38.3%→75%, ledger #11); slide 3 NEW CaseConvert rate card (`ONE FIRM'S
  CLOSE RATE, REBUILT` / `From Booked Consultations to Signed Cases.` /
  15%→40%, #12); slide 4 Expansion recomposed as the complete-engine card
  (`THE COMPLETE ENGINE · ALL THREE SYSTEMS`; how-line `CaseGen™,
  CaseIntake™, and CaseConvert™ installed together — the same engine,
  aimed at the next market, then the next.` now owns the trio
  construction; payoff = leads → arrow → $1.5M collected-revenue
  progression, #7). The Presti slide moved to /testimonials/ WHOLESALE
  (#1/#2 slider surfaces removed, #3 dormant; testimonial copy untouched).
  First Lead Records slide relocated to a compact `.svc-flr` strip on
  /services/ after the CaseGen rows (#8), leading with the registered
  `Days from launch to the first new lead — four firms, four practice
  areas.` microcopy; the services systems section gained `id="systems"`
  for the new slider links.
- CTA unification (owner doc §4): one primary phrase everywhere — header
  + mobile menu (html.ts + home.ts), hero, NEW post-proof `.nb-proof-cta`,
  NEW team ask, and closing all carry `Book a High Impact Revenue Session
  →` (title-case source; `.nb-btn`/`.btn` chrome uppercases — "High
  Impact" never hyphenated). Hero keeps the `SEE THE SYSTEM →` secondary.
  The cinematic walkthrough's `Get the Book on Amazon →` secondary CTA is
  REMOVED — Amazon remains only in the book band's store badges
  (tertiary); its orphaned `.rec-secondary-cta` CSS deleted.
- NEW `HOW RESULTS ARE MEASURED` disclosure (`.nb-measure`, owner doc
  §10) under the post-proof CTA: verification basis, measurement window,
  individual-firms-not-averages, results-not-guarantees, and
  component-vs-complete-engine in one paragraph, closing on a
  /data-notes/ link. Zero figures restated, zero new claims.
- Team condensed (owner doc §7): 7 leadership/senior-delivery members
  default-visible, the session ask between grid and roster, then `MEET
  THE COMPLETE NOBULL TEAM` as a native `<details>` disclosure holding
  the remaining 11 — works without JS; same 18 people, zero member copy
  changes.
- Closing lede swapped verbatim (owner doc §8): `You're already paying to
  create opportunity. The question is how much of it becomes revenue.`
  (was `You're already paying for one. The question is how much money
  it's leaking.` — #4120 review close, #4166 tighten). Fit/not-fit cards
  + booking button beneath them unchanged.
- FAQ +7 objection items (owner doc §9), claim-safe: agency replacement ·
  CRM/intake/sales-team replacement (re-surfaces #24's
  keep-current-software rule) · existing systems/vendors · what NoBull
  needs · tracking (#37 estimate-honest wording) · first 30–90 days
  (states the no-universal-schedule refusal out loud — #23 stays
  withheld; component-by-component per #24) · need-leads-already. No new
  figures, no cadence promises, no "only company" framing (#32).
- Records updated in lockstep: website-final-copy.md (section order, §1
  hero CTA, §4 trio/CTA notes, §6 rewrite, §7 slide-by-slide rewrite with
  rename history, §9 Amazon CTA removal, §12 roster split, §13 lede/CTA,
  §14 FAQs 4–10, /services/ strip + systems anchor), website-claim-ledger
  rows 1/2/3/4/7/8/11/12/13/17/24/35.
- Files: website/src/pages/home.ts, website/src/pages/services.ts,
  website/src/html.ts, website/src/demo.ts (naming-note comment),
  website/src/home-client/statsBand.ts (comment),
  website/public/assets/css/home.css, website/public/assets/css/site.css,
  website/public/* (regenerated), docs/website-final-copy.md,
  docs/website-claim-ledger.md, docs/website-copy-changelog.md.


### 2026-08-10 — Task #4295: Cinematic copy & content model — the owner brief's six-scene capability-first rewrite

Owner source: `design-source/nobull-revenue-engine-cinematic-v2/BRIEF.md`
(§7 scene copy, verbatim; §3 removals; 2026-08-10 owner correction — the
epic ENHANCES the existing 144-frame cinematic, it does not replace it).
Subtask 2 of the rebuild epic: content model + renderers + docs only; the
frames, loader, canvas, GSAP timeline, scroll boundaries, and the
cinematic/static-mode contract are untouched, and the overlay visual
system is subtask 3.

- Content model: `stageData.ts` now exports six scenes (opening, casegen,
  caseintake, caseconvert, full-engine, cta) riding the existing five
  timeline stages — scenes 1–5 map 1:1, the Scene 6 CTA block rides the
  growth panel until subtask 3. Hierarchy per the brief: capability
  headline → proprietary/system name beneath → one short caption; one
  when-installed statement; one stage output; one transition line. The
  long stage bodies and every #4120 lever tail are gone — at any scroll
  position: at most one headline, one short sentence, three concise
  labels, one when-installed statement, one stage output.
- Opener (Scene 1): body now `Most firms manage Marketing, Intake, and
  Sales separately. The Revenue Engine connects them into one measurable
  path from qualified demand to signed case.` (was `Each stage has one
  job, one primary conversion point, and one output. Now let's open the
  hood and show you how NoBull improves each one.` — #4259). H2
  `THREE SYSTEMS. ONE REVENUE OUTCOME.` kept (all-caps display). NEW cue
  `Scroll to follow one opportunity through the engine.`; the manifest
  rows (`01 CaseGen — The Fuel` etc.) became the capability index
  (`CREATE DEMAND` / `CAPTURE OPPORTUNITY` / `CONVERT TO REVENUE` over
  the three ™ names).
- Working stages — headline swaps (brief §7): casegen `CREATE MORE OF
  THE RIGHT OPPORTUNITIES.` (was `Marketing is the fuel.`, #4032);
  caseintake `STOP QUALIFIED PROSPECTS FROM DISAPPEARING.` (was `Someone
  still has to pick up.`, #4032); caseconvert `TURN THE CONSULTATION
  INTO A CLEAR DECISION TO HIRE.` (was `No one buys your law degree.`,
  #4032). The #4032/#4166 bodies retired with them (verbatim history in
  final-copy §4's inline records): `Qualified leads fed in until your
  phone's ringing off the hook — real people, looking for help. The
  lever: Cost per Lead, and the quality it buys.` · `A call that rings
  out to voicemail isn't money. We answer while the lead is ready to
  move, and follow up at every drop-out point. The lever: Lead-to-Consult
  rate — and how many actually show.` · `They buy help — a Sales call law
  school never taught. We script, record, and coach it until consults
  stop stalling out. The lever: Consult-to-Case rate.` New bodies are the
  brief's one-liners; new engine-role tags (`ENGINE ROLE — THE FUEL` /
  `— THE INJECTOR` / `— THE SPARK`) replace the engraved nameplates and
  their serif function lines (`Fills the engine with qualified leads.` /
  `Turns qualified leads into booked consultations.` / `Turns booked
  consultations into signed cases.` — the three-line ladder stays
  standardized elsewhere; messaging-architecture §2 untouched on that).
- Capability stacks (NEW, brief §7): casegen `BE FOUND`/`CONTROL
  DEMAND`/`BUILD PROOF` over `Local Authority Optimization™` /
  `Paid Search Control System™` / `Review Velocity System™` with one
  caption each; caseintake keeps the #4166 chips as system names under
  `RESPOND`/`QUALIFY`/`RECOVER`; caseconvert `STRUCTURE THE
  CONVERSATION`/`CLARIFY THE OFFER`/`REVIEW AND COACH` — chip renamed:
  `Proven Consultation Framework` (was `Proven Consultation Script`).
  NEW when-installed statements + outputs: `Qualified Leads` ·
  `Consultations That Happen` (was `Booked Consultations`) ·
  `Signed Cases`; NEW transition lines close each stage.
- Full engine (Scene 5): eyebrow `FULL ENGINE CONNECTED` (was `FULL
  ENGINE INSTALLED`, deck S59); H2 `EVERY IMPROVEMENT COMPOUNDS.` kept;
  body now the brief's `CaseGen creates opportunity. CaseIntake protects
  it. CaseConvert turns it into signed cases. Connecting all three makes
  every stage more valuable and exposes the next constraint.` (was the
  #4259 compounding paragraph `When Marketing, Intake, and Sales operate
  as one system, …becomes available to reinvest.`). NEW flow line
  `QUALIFIED LEADS → CONSULTATIONS THAT HAPPEN → SIGNED CASES →
  ATTRIBUTABLE REVENUE`, know-line `KNOW WHERE OPPORTUNITY COMES FROM.
  KNOW WHERE IT LEAKS. KNOW WHAT TO IMPROVE NEXT.`, name-only score-line
  `Revenue is the outcome. REE is the scorecard.` (§2b stays the sole
  definition surface, ledger #38), engine tag `THREE SYSTEMS · ONE
  CONNECTED REVENUE ENGINE` (was `THREE SYSTEMS · ONE OUTPUT`). The
  flywheel nameplate (`THE FLYWHEEL`/`REVENUE GROWTH`, `Success feeds
  greater success.`) and `ENGINE OUTPUT` plate head retired.
- Scene 6 CTA block (NEW, rides the growth panel): kicker `THE BOOK
  EXPLAINS THE SYSTEM. NOBULL INSTALLS IT.`, H3 `FIND THE CONSTRAINT
  LIMITING YOUR REVENUE ENGINE.`, body `A High Impact Revenue Session
  identifies where qualified opportunity is being lost and which system
  should be improved first.`, single CTA `BOOK A HIGH IMPACT REVENUE
  SESSION` → /book-free-demo/ (no arrow glyph, never hyphenated, no
  secondary — #4261's Amazon removal stands).
- Removals (brief §3 / owner correction item 7): the #3999/#4039 gauge
  strips and every result card/label are gone from the cinematic (the
  #4259 follow-up had already emptied them of readouts — ledger rows
  9/11/12 note the strips themselves are now retired; results NOT
  re-homed). Rail label `Full Engine` (was `Scale`, #4035; `Control`/
  `Dominate` earlier). Mobile/static stack now renders all six scenes
  (opener included). SR description rewritten to the one-signal
  narrative, ending `Revenue is the outcome. REE is the scorecard.`
- Vocabulary ruling: `qualified demand` RE-ADOPTED by the owner brief
  (scenes 1–2) — removed from lint-website-banned-phrases' storyboard
  purge list and from messaging-architecture §3's purge roster (comment
  + doc note cite the brief); "machinery" / "No magic" / "watch it
  assemble" stay purged. ROAS stays banned; the brief's copy uses none
  of the other banned families.
- Records updated in lockstep: website-final-copy.md (§4 full six-scene
  rewrite with per-quote retirement records, section-order note, §2
  trade-rows fix-lane sentence, §2b lever + name-only-score bullets),
  website-claim-ledger rows 9/11/12 (gauge strips retired), 38
  (name-only score-line), 90 (no book CTA inside the cinematic),
  website-messaging-architecture §1.5, §2 lever preamble, §3 purge
  list, §6 items 3b/4/5/8.
- Files: website/src/home-client/stageData.ts, website/src/pages/home.ts,
  website/public/assets/css/home.css, website/public/* (regenerated),
  tests/lint-website-banned-phrases.test.ts, docs/website-final-copy.md,
  docs/website-claim-ledger.md, docs/website-messaging-architecture.md,
  docs/website-copy-changelog.md.
### 2026-08-10 — Task #4262: Book funnel — cover-to-session path
- Implements §3 of the owner recommendations doc
  (`attached_assets/Pasted--Updated-Recommendations-After-the-Gap-REE-Work-
  This-re_1786372529054.txt`): keep the book dominant, clarify its role,
  and make the free-chapters reader a deliberate funnel — cover → free
  chapters → session. Builds on #4261 (CTA unification) without touching
  its surfaces.
- Hero cover now a subtle link → `/free-chapters/` (aria-label "Read the
  first two chapters of The Law Firm Revenue Engine — free"; machinery
  art stays decorative aria-hidden per layer; hover/focus rim light + gold
  keyboard-focus outline; the hero's primary action remains the session
  CTA). NEW connection caption under the cover — the doc's first approved
  line: `The book explains the system. NoBull installs it.` (quiet serif
  italic on the book floor, `.nb-book-caption` — not a competing headline).
- /free-chapters/ endcap reframed to the doc's leak-diagnosis ask: H2 now
  `You've seen how the Revenue Engine works. Now see where yours is
  leaking.` (was `You've seen inside the engine. The full book installs
  it.`); the session button + calculator link lead (`.fc-endcap-ask`), and
  the full-book push (three-more-chapters support line, Ch3–5 ToC list,
  Amazon/Audible badges) is demoted to a labeled `GET THE FULL BOOK`
  secondary block under a gold hairline (`.fc-endcap-book`).
- Floating reader bar is now the doc's persistent "Apply This to Your
  Firm" prompt: primary CTA relabeled `Apply This to Your Firm →`
  (was `Book a High Impact Revenue Session →`; still → `/book-free-demo/`,
  link aria-label carries the full session phrase for assistive tech).
  Note, GET THE FULL BOOK Amazon/Audible links, and CALCULATE YOUR REE
  link unchanged.
- Book band (§9): hierarchy confirmed per doc §3/§9 — free chapters
  primary, store badges tertiary and confined to the band; zero copy
  change. Chapter body text untouched (manuscript-imported, never edited).
- Files: website/src/pages/home.ts, website/src/pages/freeChapters.ts,
  website/public/assets/css/home.css, website/public/assets/css/site.css,
  website/public/* (regenerated), docs/website-final-copy.md,
  docs/website-copy-changelog.md.

### 2026-08-11 — Task #4300: Cinematic Scenes 5–6 — full-engine pull-back, REE gauge, and the CTA beat takes its own scene (ZERO copy change)

Motion/structure only; every rendered string is the contract copy Task #4295
landed. The Scene 6 block (kicker `THE BOOK EXPLAINS THE SYSTEM. NOBULL
INSTALLS IT.`, headline `Find the constraint limiting your revenue engine.`,
body, and the single `BOOK A HIGH IMPACT REVENUE SESSION` button) moved out
of the full-engine copy panel — where subtask 2 parked it as a floor row —
into its own closing panel at the end of the scroll timeline, after the
full-engine panel exits. The rail still shows five items; FULL ENGINE covers
both closing beats.

- **Deliberate kicker echo, not drift:** the cinematic's closing kicker
  repeats the book-band caption line (`The book explains the system. NoBull
  installs it.`, Task #4262) and its hero/book-funnel variants on purpose —
  the same sentence closes the scroll story that the book band opens. A
  recorded repetition decision; do not "deduplicate" it in future copy
  sweeps.
- Scene 5 overlay (above the preserved frame canvas, per the 2026-08-10
  owner correction): housing pull-back settle, three restrained adjustment
  beats with dial + widened intake fans, twin flow streams, expanding
  attributable-revenue rings/arcs, the single analog REE gauge (`REVENUE =
  THE OUTCOME / REE = THE SCORECARD` etches — referenced, never re-defined),
  and the quiet `CLIENTS → REVIEWS → AUTHORITY` return line.
- The flow line `QUALIFIED LEADS → CONSULTATIONS THAT HAPPEN → SIGNED CASES
  → ATTRIBUTABLE REVENUE` reads along the machine; its fourth position is
  the arrow leading into the terminal's own lit `ATTRIBUTABLE REVENUE`
  caption (avoids stacking the same words three deep at the terminal).
- Scene 6: diagnostic-scan sweep with per-station blips; the CaseIntake
  station glows amber as a *possible* constraint, always paired with the
  `POSSIBLE CONSTRAINT / REVIEW REQUIRED` marker (scan-caused, never
  color-alone, never claims which stage is failing).
- Reduced-motion static presentation gains two stills: the assembled engine
  with gauge and flow labels, and the frozen scan with the constraint
  marker; the static CTA card keeps the full Scene 6 copy at every width.
- Files: website/src/pages/home.ts, website/src/home-client/main.ts,
  website/src/home-client/recOverlay.ts, website/src/home-client/stageData.ts
  (comments only), website/public/assets/css/home.css, website/public/*
  (regenerated), docs/website-copy-changelog.md.

### 2026-08-14 — Task #4816: Homepage reorg — cinematic two screens earlier (owner-endorsed feedback)

Structural reorder per the owner-endorsed feedback in
`attached_assets/Pasted-You-re-feeling-the-right-problem-The-homepage-preview-h_1786744816190.txt`:
the engine reveal IS the differentiator, so the cinematic now starts
~1,600–1,800px in (was ~3,620px) and the page no longer teaches the REE
scorecard or shows tuned results before the visitor reaches it. New order:
hero → credibility rail (press logos + four count-up metrics merged into
ONE compact band) → Million-Dollar Gap (closes on the handoffs kicker +
`OPEN THE HOOD ↓` + compressed light→dark seam) → cinematic → tuned proof
ribbon → case-study proof slider → compact REE strip → testimonials → book
→ team → closing → contact. ~90–95% of copy preserved; this entry records
every deletion/move verbatim. **Deliberate supersessions of Task #4259's
narrative-bridge arrangement** (owner-endorsed 2026-08-14): REE strip no
longer precedes the cinematic, the gap band's bridge paragraph is retired,
and the tuned ribbon moved off the cinematic's doorstep to its exit.

- **Hero trust line REMOVED** (the credibility rail directly below now
  carries the figures ONCE — ledger #17/#13): retired rendered copy
  `✓ $150M+ in new client revenue — across 350+ law firms we've worked
  with` (Task #4165 form). The hero's `SEE THE SYSTEM →` secondary link
  restyled as a clearly clickable OUTLINED button (wording unchanged;
  the filled session CTA stays dominant).
- **Press strip + metrics band MERGED** into one credibility rail — zero
  copy change: same `AS SEEN ON` label, same three logos, same four
  aggregates with count-up.
- **Gap bridge paragraph RETIRED** (rendered #4259–#4816): `Marketing
  creates qualified opportunity. Intake turns that opportunity into
  booked consultations. Sales turns consultations into signed clients.
  Together, those three systems form the Law Firm Revenue Engine™.` —
  the cinematic one seam below now demonstrates the three-system chain
  itself; the kicker `The Million-Dollar Gap lives in the handoffs.` is
  the band's last copy, with the `OPEN THE HOOD ↓` cue + seam back on
  the gap tail (their #3998–#4120 home) and the seam compressed to
  ~100–160px.
- **Tuned proof ribbon MOVED** to directly after the cinematic (compact
  ~220–300px rail; same three readouts + never-an-average line; the
  hood cue/seam left its tail with the move). No copy change.
- **REE strip MOVED below the proof slider + compressed** (~400–500px):
  the connection line drops its gap-deixis sentence — retired: `The
  Million-Dollar Gap shows what is being lost.` (the gap band now sits
  five sections up; the surviving sentence names what the score is FOR
  unchanged) — the four levers hold one horizontal row, the CTA follows
  them, and the `$1 → $8` example line closes the band as a muted tail
  qualifier. The diagnostic-role clarifier RE-HOMED verbatim to
  `/calculator/`'s measurement guide under a new `What REE is not.`
  head: `REE is not the goal and it is not a fourth system. It is the
  diagnostic score that shows where the engine is limiting revenue. We
  do not optimize the ratio at the expense of producing more total
  revenue.`
- **Cinematic Scene 6 body REPLACED** (the reorg's one cinematic edit —
  stage copy only, contract untouched; an owner-directed supersession
  of the 2026-08-10 brief's verbatim line): now `A High Impact Revenue
  Session identifies where qualified opportunity is being lost, what
  the complete build must address, and what to prioritize as we
  install the engine in order: Marketing, Intake, then Sales.` —
  retired: `A High Impact Revenue Session identifies where qualified
  opportunity is being lost and which system should be improved
  first.` (the session frames the COMPLETE build and the install
  order, not a pick-one fix).
- Files: website/src/pages/home.ts, website/src/pages/calculator.ts,
  website/src/home-client/stageData.ts, website/src/home-client/
  reeReveal.ts, website/src/home-client/statsBand.ts (comment only),
  website/public/assets/css/home.css, website/public/* (regenerated),
  docs/website-final-copy.md, docs/website-claim-ledger.md,
  docs/website-copy-changelog.md.

### 2026-08-17 — Task #4837: Cinematic removed — #system rebuilt as the normal-scrolling engine story (owner decision)

Owner feedback (verbatim brief + complete replacement copy:
`attached_assets/Pasted-I-would-remove-the-cinematic-entirely-and-rebuild-this-_1786976924006.txt`):
"I would remove the cinematic entirely and rebuild this section as a
premium scrolling presentation." The pinned scene, canvas frame
sequence, progress rail, HUD pipeline, and scroll-jacking are gone;
nothing on the homepage pins. The §2c tuned proof ribbon retired with
it — its three readouts moved into the new component sections.

- New structure (final-copy §4 records every rendered line): gap-tail
  handoff transition (`THE MILLION-DOLLAR OPPORTUNITY DIES IN THE
  HANDOFFS…` + `SEE THE THREE CORE COMPONENTS ↓` cue) → charcoal
  `#system` overview (`THE THREE CORE COMPONENTS`, three columns +
  handoff connectors) → one focused section per component (outcome
  headline, lede, static SVG diagram, three capabilities,
  when-installed line, stage output, `ONE FIRM'S RESULT` proof,
  hand-off line) → dark recap (`EVERY IMPROVEMENT COMPOUNDS.`, flow
  line, know-line, score line, single session CTA — the #4816 Scene 6
  ask body carried over verbatim).
- Copy retired with the cinematic (for the record): `OPEN THE HOOD`
  opener eyebrow + gap-tail cue, `THREE SYSTEMS. ONE REVENUE
  OUTCOME.` H2, `Most firms manage Marketing, Intake, and Sales
  separately. The Revenue Engine connects them into one measurable
  path from qualified demand to signed case.` body, `Scroll to follow
  one opportunity through the engine.` cue, the `ENGINE ROLE — THE
  FUEL / THE INJECTOR / THE SPARK` tags, the full-engine scene's flow
  chrome, the SR sequence description, the `Opening the hood` loader
  text, and the rail labels `START / CASEGEN / CASEINTAKE /
  CASECONVERT / FULL ENGINE`. The ribbon's H2 `What happens when each
  stage is tuned` retired with its band.
- Copy carried forward verbatim (new home in parentheses): the three
  capability stacks (component sections), `WHEN … IS INSTALLED` lines
  (component sections), stage outputs + transition lines (stage-output
  blocks), the three-system index roles (overview columns), `Revenue
  is the outcome. REE is the scorecard.` (recap score line, name-only
  rule intact), the Scene 6 ask block + CTA (recap), and the ribbon's
  three readouts + never-an-average attribution (component sections +
  band-level note).
- New copy (owner feedback, rendered verbatim from its "Complete
  replacement copy"): the handoff-transition lines, the overview
  ledes, the three component ledes/headlines where they differ, the
  recap compound lines, know-line, and flow line's
  `ATTRIBUTABLE REVENUE` terminus.
- The `.agents/skills/nobull-revenue-engine-cinematic` skill is a
  tombstone; the 144-frame watermarked sequences, frame loader,
  overlay/sequence modules, stage data, and the mobile-frame script
  are deleted.
- Files: website/src/pages/home.ts, website/src/home-client/main.ts,
  website/src/home-client/engineStory.ts (new),
  website/src/home-client/{stageData,recOverlay,recSequence,
  frameLoader}.ts (deleted), scripts/generate-revenue-engine-mobile-
  frames.ts (deleted), website/public/assets/css/home.css,
  website/public/* (regenerated; revenue-engine frame directories
  deleted), docs/website-final-copy.md, docs/website-claim-ledger.md,
  docs/website-messaging-architecture.md, RUNBOOKS.md,
  docs/website-copy-changelog.md.

### 2026-08-17 — Task #4903: Endless vertical team wall (presentation only — ZERO copy change)
- No copy was added, removed, or reworded anywhere: every team-band
  heading, eyebrow, member name, role, the session-ask CTA, and the
  `MEET THE COMPLETE NOBULL TEAM` summary are byte-identical, and the
  served static markup (leadership grid → ask → full-roster disclosure)
  is unchanged as the no-JS / prefers-reduced-motion experience.
- What changed: for motion-allowed visitors, the new
  `home-client/teamWall.ts` (Part 9) flips the band to
  `data-team-mode="wall"` and moves all 18 roster cards —
  leadership-first order preserved — into a masked fixed-height window
  of counter-drifting vertical columns (3 desktop / 2 narrow; adjacent
  columns opposite directions at slightly different speeds; seamless
  aria-hidden clone loop; pauses on hover and off-screen; egg-tone edge
  fades). The whole team cycles into view, so the disclosure hides as
  redundant in wall mode while the session ask keeps its slot below the
  window (owner doc §7 — the ask outranks the org chart).
- Files: website/src/home-client/teamWall.ts (new),
  website/src/home-client/main.ts, website/src/pages/home.ts (comments
  only), website/public/assets/css/home.css, website/public/*
  (regenerated), docs/website-final-copy.md (§0 order line + §12
  presentation bullet), docs/website-copy-changelog.md.

### 2026-08-18 — Task #4923: Homepage restructure 1 — hero to overview (owner brief §§1–4)
Owner brief `attached_assets/Pasted-The-page-is-directionally-much-better-than-the-cinemati_1787000455136.txt`
(canonical for the page top). Stage 1 of the premium sales-page
restructure (supersedes the crashed Task #4904 for §§1–4); product deep
dives, customization, proof/REE/testimonials, team, session offer, FAQ,
and the global four-CTA budget are later stages — this stage adds no
new booking CTAs.
- Hero (§1): supporting lede replaced — now `Most agencies stop at the
  lead. NoBull builds and manages the Marketing, Intake, and Sales
  systems that move qualified prospects from first click to signed
  case — and measures the revenue produced at every stage.` (was the
  #4120 `NoBull installs The Law Firm Revenue Engine™…` form; the ™
  naming stays with the §4 eyebrow/recap + meta description).
  Deviation: house-style spaced em dash replaces the brief's closed
  `case—and`. Hero visual, eyebrow, H1, primary CTA unchanged (locked).
- Hero secondary CTA relabeled `SEE THE THREE CORE COMPONENTS →` (was
  `SEE THE SYSTEM →`; same `#system` target, same outlined treatment).
- Hero session-explainer note added under the CTA pair
  (`.nb-hero-note`): `A free working session to identify what is
  limiting signed cases and what should be fixed first.` — "free"
  rides ledger #36 (where-used expanded); the identify-what-limits
  clause is a ledger #37 session activity; no duration, deliverable,
  or no-pressure promises.
- Credibility rail (§2): untouched — the brief asks only that nothing
  more be added to it.
- Gap (§3): lede tightened to price the gap in one breath: `Picture
  two firms with the same 500 qualified leads. One signs 20 cases. The
  other signs 120. At a $10,000 average case value, that is a
  $1,000,000 difference without generating one additional lead.`
  Deviations: kept the `Picture two firms` hypothetical cue the
  brief's setup dropped (ledger row 19 mandates an explicit cue) and
  rendered the brief's `$1 million` as `$1,000,000` (house style,
  matches H2/receipt). All figures stay GAP_MODEL-templated.
- Gap rows de-branded to stage-only tags `MARKETING` / `INTAKE` /
  `SALES` (were `CASEGEN™ · MARKETING` etc.) and the `.nb-vh` summary
  opens stages without product attributions — brief §3 keeps product
  names out of the problem illustration; the §4 overview owns the
  reveal.
- Gap closer: the #4816 kicker `The Million-Dollar Gap lives in the
  handoffs.` is retired; the band now ends on the diagnosis line `THE
  MILLION-DOLLAR OPPORTUNITY DIES IN THE HANDOFFS BETWEEN MARKETING,
  INTAKE, AND SALES.` (upright serif caps, `HANDOFFS` in oxblood — the
  deleted band's head verbatim).
- Standalone handoff transition band (#4837 §4(a), `.nb-handoff`)
  DELETED with its CSS. Retired with it: body `The first handoff
  determines whether a qualified lead becomes a consultation. The
  second determines whether that consultation becomes a signed case.`,
  connect `The Law Firm Revenue Engine™ connects all three.`, the
  `MARKETING — HANDOFF — INTAKE — HANDOFF — SALES` row, and the
  `SEE THE THREE CORE COMPONENTS ↓` cue (label re-homed to the hero
  secondary CTA).
- Overview (§4) simplified to the brief's five-second model: single
  lede `Built in order. Connected from qualified lead to signed
  case.` (both #4837 ledes retired); columns reduced to num/name/dept;
  role lines (`CREATE DEMAND` / `CAPTURE OPPORTUNITY` / `CONVERT TO
  REVENUE`), one-liners, and in-column `OUTPUT:` rows retired; the
  stage outputs `QUALIFIED LEADS` / `CONSULTATIONS THAT HAPPEN` /
  `SIGNED CASES` became the visible connectors (real copy — the
  terminal `SIGNED CASES` lands cream after column 3; the old
  aria-hidden `MARKETING → INTAKE` / `INTAKE → SALES` connectors
  retired). Component sections + recap untouched.
- Files: website/src/pages/home.ts, website/public/assets/css/home.css,
  website/public/* (regenerated), docs/website-final-copy.md,
  docs/website-claim-ledger.md, docs/WEBSITE.md,
  docs/website-messaging-architecture.md, docs/website-copy-changelog.md,
  tests/website-engine-story-{anchors,semantic-content,static-integrity}.test.ts.

### 2026-08-18 — Task #4924: Homepage restructure 2 — product deep dives + customization (owner brief §§5–6)
Same owner brief (canonical for the restructure). Stage 2 of the
premium sales-page restructure: the three component sections rebuilt
to the brief's §5 four-question layout, and the #4837 complete-engine
recap replaced by the brief's §6 customization band. Proof slider, REE
strip, testimonials, team, session offer, FAQ, contact, book band, and
the global CTA budget are later stages; this stage adds no new booking
CTAs (the customization band carries the recap's single dominant
session CTA forward).
- Component sections (§5, all three): each now answers exactly — id
  line → outcome H2 → one paragraph → large diagram → WHAT NOBULL
  BUILDS AND MANAGES list → WHAT CHANGES line → ONE FIRM'S RESULT
  row. Retired from every section: the capability triad (role /
  system name / one-liner), the WHEN … IS INSTALLED block, the STAGE
  OUTPUT row + output tag, and the next-component hand-off. Diagrams,
  section ids/anchors, data-es-* motion hooks, the proof figures
  (ledger #9/#11/#12), and the never-an-average note are unchanged;
  sections compress to roughly a screen each.
- CaseGen (§5): lede replaced — now "CaseGen combines local search,
  paid search, and reviews to create qualified demand your firm can
  measure and control." (was "CaseGen coordinates local authority,
  paid search, and reviews to create qualified demand the firm can
  measure and control."). Builds list = the three ™ systems (Local
  Authority Optimization™ / Paid Search Control System™ / Review
  Velocity System™ — names carried from the retired capability
  triad). WHAT CHANGES = "Know which markets, searches, and channels
  produce qualified leads, what those leads cost, and where to invest
  next." (replaces the when-installed line "Know where qualified
  demand comes from, what it costs, and where to invest next.").
  Retired with the triad: BE FOUND / "Win the local searches that
  matter.", CONTROL DEMAND / "Put budget behind the searches most
  likely to become qualified opportunities.", BUILD PROOF / "Turn
  satisfied clients into compounding trust."; output tag "Qualified
  opportunity created. The clock starts now."; hand-off "NEXT:
  CASEINTAKE™ — Every qualified lead receives an owner, a status, and
  a next action."
- CaseIntake (§5): lede replaced — now "CaseIntake installs the
  response, qualification, scheduling, and follow-up systems your
  team needs to move viable leads to consultations." (was "Every lead
  receives a fast response, a clear owner, a next action, and
  structured follow-up through consultation."). Builds list: "Lead
  routing, ownership, and response workflows" / "Qualification and
  booking processes" / "Missed-call, no-response, cancellation, and
  no-show recovery" / "Tracking, scripts, and intake coaching". WHAT
  CHANGES keeps the #4837 when-installed line verbatim ("Every lead
  has an owner, a status, a next action, and a measurable path to
  consultation."). Retired: RESPOND / Capture Faster / "Respond while
  intent is highest.", QUALIFY / Guide Consistently / "Qualify and
  book the same way every time.", RECOVER / Follow Through / "Recover
  missed calls, silence, cancellations, and no-shows."; output tag
  "Consultation secured. The decision is next."; hand-off "NEXT:
  CASECONVERT™ — The attorney receives a qualified prospect at the
  consultation and a repeatable process for turning that conversation
  into a decision to hire."
- CaseConvert (§5): H2 replaced — now "TURN MORE CONSULTATIONS INTO
  SIGNED CASES." (was "TURN THE CONSULTATION INTO A CLEAR DECISION TO
  HIRE."). Lede replaced — now "CaseConvert gives attorneys a
  repeatable consultation framework, a stronger legal-services offer,
  and ongoing coaching to improve the percentage of qualified
  prospects who hire." (was "CaseConvert gives attorneys a repeatable
  process for diagnosing the need, presenting the path, communicating
  value, and asking for the engagement."). Builds list: "Consultation
  framework and scripts" / "Offer and engagement presentation" /
  "Follow-up after the consultation" / "Call recording, scorecards,
  and coaching". WHAT CHANGES = "Know why prospects hire, where
  consultations stall, and what should be coached next." (replaces
  the when-installed "Consult-to-case performance becomes visible,
  coachable, and repeatable."). Retired: STRUCTURE THE CONVERSATION /
  Proven Consultation Framework / "Lead the conversation from
  diagnosis to decision.", CLARIFY THE OFFER / Strong Legal Services
  Offer / "Make the scope, value, and next step easy to understand.",
  REVIEW AND COACH / Coaching Loop / "Turn real consultations into
  measurable improvement."; output tag "Case signed. Revenue
  created."
- Recap band REPLACED (§6) by the customization band (.nb-custom,
  same near-black ground): kicker CUSTOMIZATION (eyebrow added for
  band-grammar consistency — the brief names none; deviation) · H2
  "BUILT AROUND THE FIRM YOU WANT TO GROW" · paragraphs "The three
  core components stay the same. What goes inside them is built
  around your practice areas, markets, team, capacity, case
  economics, and growth goals." + "A high-volume consumer practice
  needs a different revenue engine than a lower-volume, high-value
  firm. We build the engine your firm needs — not the one we prefer
  to sell." · three adjustable areas MARKETING "Market, practice
  mix, lead volume, acquisition cost and budget." / INTAKE
  "Qualification standards, staffing, response, scheduling and
  follow-up." / SALES "Consultation structure, offer, pricing,
  payment options and follow-up." · implementation-order flow line
  MEASURE THE CURRENT ENGINE → BUILD MARKETING → BUILD INTAKE →
  BUILD SALES → IMPROVE THE NEXT CONSTRAINT (the gold sweep motion
  moved here from the retired recap flow line; order-of-build only,
  no cadence commitments — ledger #24) · single CTA "Book a High
  Impact Revenue Session →" → /book-free-demo/ (re-homed from the
  recap; the global CTA budget lands in stage 4). Deviations from
  the brief: spaced em dash in "needs — not" (house style, matches
  the #4923 hero deviation); the CUSTOMIZATION eyebrow is invented.
- Retired with the recap (all #4837/#4816 copy): kicker "THE COMPLETE
  LAW FIRM REVENUE ENGINE™" (the ™ name still renders in the §4
  overview kicker + meta description) · H2 "EVERY IMPROVEMENT
  COMPOUNDS." · lines "CaseGen creates opportunity. CaseIntake
  protects it. CaseConvert turns it into signed cases." + "Connecting
  all three makes every stage more valuable and exposes the next
  constraint." · flow line "QUALIFIED LEADS → CONSULTATIONS THAT
  HAPPEN → SIGNED CASES → ATTRIBUTABLE REVENUE" (the three stage
  outputs still render as the §4 overview's connectors; ATTRIBUTABLE
  REVENUE now renders nowhere on the page) · know-line "Know where
  opportunity comes from. Know where it leaks. Know what to improve
  next." · score line "Revenue is the outcome. REE is the scorecard."
  (the homepage's last name-only REE mention outside the strip — the
  §2b strip is now the score's ONLY homepage surface; ledger #38
  updated) · ask block H3 "FIND THE CONSTRAINT LIMITING YOUR REVENUE
  ENGINE." + body "A High Impact Revenue Session identifies where
  qualified opportunity is being lost, what the complete build must
  address, and what to prioritize as we install the engine in order:
  Marketing, Intake, then Sales." (the #4816 owner body — its
  install-in-order clause survives as the flow line's BUILD order).
- Files: website/src/pages/home.ts,
  website/src/home-client/engineStory.ts,
  website/public/assets/css/home.css, website/public/* (regenerated),
  docs/website-final-copy.md, docs/website-messaging-architecture.md,
  docs/website-claim-ledger.md, docs/website-copy-changelog.md,
  tests/website-engine-story-semantic-content.test.ts,
  tests/website-engine-story-static-integrity.test.ts.

### 2026-08-18 — Task #4925: Homepage restructure 3 — flagship proof, compressed REE, static testimonials (owner brief §§7–9)

Stage 3 of the 2026-08-18 owner-brief restructure (brief:
`attached_assets/Pasted-The-page-is-directionally-much-better-than-the-cinemati_1787000455136.txt`,
§§7–9 — the zone from the proof band through the testimonials band;
everything above is stages 1–2, everything below is stages 4–5).

**§7 — proof band: four-slide slider → ONE flagship case study + two
supports (`#proof`).**
- The #3915/#4261 carousel (4 slides, prev/next arrows, dash-dots,
  `1 / 4` counter, `home-client/proofSlider.ts`) is DELETED — the band
  is fully static; the served markup is the only presentation for
  every visitor (no JS fork, no reduced-motion fork).
- H2 `Different Firms. Engines Tuned for Revenue.` (#4253) → `What the
  Complete Engine Did for One Firm.` — the brief's one-deep-story
  direction; wording ours (the brief supplied structure, not an H2
  draft). Eyebrow + `SEE MORE CASE STUDIES →` link kept.
- Support line `Every number is one real firm's result, never an
  average.` (#4166) CUT — the band-foot disclosure carries the
  not-an-average fact once (single-surface rule).
- FLAGSHIP: the Presti story in the brief's six-part structure (`THE
  FIRM` / `WHAT NOBULL INSTALLED` / `WHAT CHANGED` / `TIME ELAPSED` /
  `THE BUSINESS OUTCOME — TWELVE MONTHS IN` / the client's own words).
  **Claim discipline — the brief's draft flagship figures were NOT
  published:** its ≈200→500 leads/mo, ≈200→600+ reviews, ~3×-cases-
  from-the-same-spend, and ~nine-months figures are not in the
  verified corpus (ledger #1/#2 carry no "before" baselines and a
  twelve-month window). Rendered instead, all from proof.ts:
  PRESTI.headline `500+ Leads a Month. 60+ Cases Signed in a Single
  Month.` (ledger #1), `Twelve months.` (ledger #2's own timeframe),
  the four ledger-#2 stats (3,600+ leads / 292 cases signed / 200
  five-star reviews / 4.8★), and the verbatim S8 quote footed
  Michael Presti. The brief's "sales process unchanged" beat is
  OMITTED — it conflicts with the S8 quote's "totally automated the
  intake & sales process". Part 1 renders firm identity (name +
  practice/location label) instead of the brief's where-they-started
  baseline — no verified baseline exists.
- `WHAT NOBULL INSTALLED` line: `CaseGen™, CaseIntake™, and
  CaseConvert™ — the complete engine, installed and managed as one
  system.` — the ledger-#3 trio-construction PATTERN re-homed from the
  retired Expansion slide install line (still no #3 figures; #3 stays
  dormant).
- SUPPORTS: Burns Smith Law P.C. (`CASEGEN™ RESULT · MARKETING` —
  label, headline, month-one→month-five lede, 1,779/50 totals; the
  monthly bar ramp + install-timeline chips left the homepage) and the
  unnamed Expansion Play (`THE COMPLETE ENGINE · ALL THREE SYSTEMS` —
  `$1.5M / FIRST 100-CASE MONTH — COLLECTED REVENUE / April 2026`
  milestone + `2,400+ / LEADS — SIX-MONTH TOTAL` and `3 / LOCATIONS
  ADDED` cells; the launchpad ladder, trio install how-line, and
  228-reviews cell left the homepage). Both keep `VIEW CASE STUDY →`
  → /testimonials/#case-studies; /testimonials/ still renders every
  retired figure.
- Retired with the slider: the #4261 CaseIntake and CaseConvert rate
  cards (`ONE FIRM'S INTAKE, REBUILT` / `Same Lead Flow. Nearly Twice
  the Consultations.`; `ONE FIRM'S CLOSE RATE, REBUILT` / `From Booked
  Consultations to Signed Cases.`; both before→after sweeps) and their
  `HOW CASEINTAKE™ WORKS →` / `HOW CASECONVERT™ WORKS →` links — the
  rate pairs' ONLY homepage surfaces are the §4 engine-story component
  sections now (ledger #11/#12).
- Measurement disclosure: the #4261 five-point paragraph → the brief's
  two sentences VERBATIM: `Every result shown is one firm's tracked
  outcome over the stated period, not an average or a guarantee. See
  Data Notes & Definitions for the measurement basis.` (link →
  /data-notes/). Restates zero figures; revenue-basis labeling lives
  on the cards (`COLLECTED REVENUE`, ledger #7).

**§8 — REE strip cut to its terminal four beats (`#ree`).**
- Now title → formula plate → `WHAT MOVES THE SCORE` levers →
  `CALCULATE YOUR REE →`. Retired: the #4259/#4816 connection sentence
  (`Revenue Engine Efficiency shows how efficiently the entire system
  turns growth investment into attributable top-line revenue.`) and
  the fused `ILLUSTRATIVE MODEL` example line (`$1 of growth
  investment in, $8 of attributable revenue out — an 8× REE.`). The
  strip was the example's ONLY rendered surface, so ledger #38 →
  WITHHELD (registered for labeled reuse; still never conflated with
  #10's REAL 8× lead-growth figure) and its /data-notes/ provenance
  row ("The homepage's REE definition example") was removed in
  lockstep — no version bump to the data-notes register (bookkeeping,
  not a definition change). Plate, `.nb-vh` screen-reader sentence,
  levers, and CTA are byte-identical to #4816.

**§9 — testimonials: endless marquees → static curated set.**
- `home-client/testimonialsMarquee.ts` DELETED (time-based marquee
  loops, `data-testi-mode="marquee"` stamp, aria-hidden loop clones,
  hover/focus pauses, edge fades). H2 `Hear It From The Firms We
  Grow.` unchanged; the served static grids are the only presentation.
- Videos 5 → 3: Shields & Boris · Covington & Associates · Integrity
  Law. Selection rationale: keep the three video firms DISTINCT from
  the proof band's case studies — the Presti Law + Burns Smith Law
  cards (#3997) would repeat the two firms featured directly above;
  both videos stay embedded on /testimonials/ and both committed
  posters stay on file. Cards stay firm-named only (no speaker names
  are on file, truth-source §5).
- Quotes 11 → 3 (one static row, no loops): the three truth-source §4
  written reviews — Lani Akiona (`Family Law Attorney`) · Tessa Thrift
  (`Attorney`) · Stacy Grow (`Law Firm Marketing Director`) — the
  register's outcome-focused texts (quality leads grown month after
  month / from nothing to fully booked / return far exceeded
  expectations), Replit variants, anonymized per policy, footed by
  role. The eight #3997 Google-review excerpts render NOWHERE now
  (transcriptions stay on file, swap-ready; the `— Name, Google
  Review` foot convention is documented in home.ts for any future
  Google-review card).

**Lockstep:** home.ts header-order comment + band comments;
home-client/main.ts part renumbering (5/6/7) + retirement note;
reeReveal.ts four-beat selector list; home.css band comments + rule
families (`.nb-flag`/`.nb-supports`/`.nb-sup` new; slider/marquee/
rate-card/bs-/x-/example/connection rules deleted at both
breakpoints); docs/website-final-copy.md overview + §7/§8 rewrites +
§2b/§2c/§10/services notes; docs/website-claim-ledger.md rows
#1/#2/#3/#4/#7/#11/#12/#23/#38 + the video-thumbnails row;
docs/CONTENT_TRUTH_SOURCE.md §4 anonymization note + register header
+ three Replit-version notes + §5 video table/paragraph + §6;
docs/website-messaging-architecture.md §6 items 3b/6 + §7 proof
bullets (also corrected the stale "$1.5M basis is an open owner flag"
note — resolved 2026-08-09, ledger §5); website/src/pages/dataNotes.ts
provenance row removed; committed site regenerated.
- Files: website/src/pages/home.ts, website/src/pages/dataNotes.ts,
  website/src/home-client/main.ts, website/src/home-client/reeReveal.ts,
  website/src/home-client/proofSlider.ts (deleted),
  website/src/home-client/testimonialsMarquee.ts (deleted),
  website/public/assets/css/home.css, website/public/* (regenerated),
  docs/website-final-copy.md, docs/website-claim-ledger.md,
  docs/CONTENT_TRUTH_SOURCE.md, docs/website-messaging-architecture.md,
  docs/website-copy-changelog.md,
  tests/website-engine-story-anchors.test.ts,
  tests/website-engine-story-semantic-content.test.ts,
  tests/website-engine-story-static-integrity.test.ts,
  tests/marketing-site-mobile-baseline.test.ts,
  tests/lint-website-copy-playbook-drift.test.ts (excused-quote ceiling
  90 → 97 — the slider retirement's per-quote markers grew the recorded
  set to 94; documented in the ceiling's own comment).

## Homepage restructure 4 — team compressed, session offer, fit rewrite, six-question FAQ, close-then-book, contact form removed (2026-08-18, Task #4926)

Stage 4 of the 2026-08-18 owner brief (`attached_assets/Pasted-The-page-is-directionally-much-better-than-the-cinemati_1787000455136.txt`, §§10–14), following #4923/#4924/#4925. The zone below the testimonials is rebuilt and the homepage's booking CTAs are reduced to exactly FOUR slots — header (nav button + its mobile-menu twin), hero, after proof, final close.

**§10 — Team.** H2 rename: `The People Behind The Engine.` → `One Team Responsible From First Click to Signed Case.` (brief-verbatim; eyebrow `NOBLE. NO B.S.` kept). Grid compressed from 7-visible + 11-behind-disclosure to the five delivery-responsible people (Ronnie Deaver · Janno Perez · Cam Duhart · Jeff Mangle · Oliver Goessler — one per brief delivery area; member copy verbatim from /about/). The `<details>` full-roster disclosure is DELETED — its summary label `MEET THE COMPLETE NOBULL TEAM` lives on as a quiet `→` text link to `/about/`. REMOVED: the in-band `.nb-team-ask` booking button (four-slot budget). RETIRED: the #4903 endless team wall — `home-client/teamWall.ts` deleted with its `data-team-mode` CSS family, and `tests/website-team-wall-contract.test.ts` deleted with it (the wall contract lost its subject; this supersedes the #4903/#4905 wall treatment, and the proposed wall-QA follow-ups #4947/#4948 are moot).

**§11 — Session offer (nb-offer, NEW band).** Eyebrow `HOW WORKING TOGETHER STARTS`, H2 `Find the Constraint Costing Your Firm Signed Cases.`, lede carrying ONLY ledger #36's owner-confirmed facts: `During a free High Impact Revenue Session, our Head of Sales reviews your firm's real numbers — leads, consultations, signed cases, and the rates between them — and builds a plan shaped to your revenue goals.` `YOU LEAVE KNOWING` card, brief-verbatim bullets: `Which part of the engine is limiting revenue` · `The estimated value of that constraint` · `What should be addressed first` · `Whether NoBull is the right partner to build it` (ledger #37 session activities in the estimate-honest register). WITHHELD from the brief's §11 draft — no ledger rows on file; the operator must confirm each before it can publish: the session-length claim, who should attend, what to bring, what happens after the session, and the review list's "average case value" item. No booking CTA in the band.

**§12 — Fit (nb-fit, NEW band; verdict cards re-homed from the closing).** H2 `Is Your Firm a Fit?` — a new heading, NOT a revival of the operator-removed `IS THIS YOUR FIRM?` closing eyebrow (that stays gone). Both lists rewritten to the brief, resolving the flagged contradiction (the old fit list required existing lead flow while the FAQ said none was needed — lead generation is no longer a fit condition). RETIRED fit bullets: `You already generate leads but sign fewer cases than the flow deserves` · `You'll let us measure intake and sales, not just marketing` · `You want to scale up — and you don't want a ceiling` (the #4035 scale-up bullet). RETIRED not-fit bullets: `You want a logo refresh or a one-off campaign` · `You'd rather buy more leads than fix the leaks` · `Nobody at the firm can own the decisions the engine needs`. Live lists recorded in final-copy §12c; brief items adapted to house contractions ("You'll", "can't", "won't"). Brief §12's minimum-investment criterion is WITHHELD (no approved threshold on file).

**§13 — FAQ cut to the six buying questions (nb-faq-sec, NEW band).** Eyebrow `BEFORE YOU BOOK`, H2 `Six Questions, Answered Straight.` Kept from the ten-question set (answers verbatim, questions retitled): FAQ 5 → new FAQ 2 (`Do we need to replace our CRM, intake staff, or sales team?` → `Will we need to replace our current team or software?`), FAQ 9 → new FAQ 4 (`What happens in the first 30 to 90 days?` → `What happens during the first 30 to 90 days?`), FAQ 8 → new FAQ 5 (`How do you track consultations, cases, and revenue?` → `How do you track leads, consultations, signed cases, and revenue?`), and FAQ 7 reworked into new FAQ 3 (`What does NoBull need from our firm?` → `What does NoBull handle, and what does our firm handle?` — the three asks now sit inside a we-build-and-run frame). NEW: `Do we need all three components at once?` (ledger #24's component-at-a-time rule) and `What does working with NoBull cost?` (ZERO figures — ledger #29 pricing stays banned; the free session is the route to a real number). RETIRED Q&As, quoted for the record:
- RETIRED: `How is NoBull different from other agencies?` → `Most legal marketing agencies stop taking responsibility when the lead arrives. We don't. One team builds and runs the whole engine — Marketing, Intake, and Sales — and follows every opportunity from acquisition through signed-and-paid client, answering for the revenue, not just the ad spend.` (the defensible-positioning claim survives in the /about/ FAQ)
- RETIRED: `How do you ensure a good return on investment?` → `We measure return the way you do: revenue. Click-to-close tracking connects each dollar you invest to the leads, consultations, and signed cases it produced — and where your data can't support a precise number yet, we say so and give you the best honest estimate instead.` (click-to-close + estimate-honest wording lives on in the tracking FAQ)
- RETIRED: `What does getting started look like?` → `Book a high impact revenue session. We'll map your funnel — marketing, intake, and sales — put a number on the biggest leak, and tell you straight whether the engine fits your firm.` (the nb-offer band now owns getting-started)
- RETIRED: `Will NoBull replace our current marketing agency?` → `For the Marketing system, usually yes — CaseGen™ is done-for-you, and split accountability between two marketing vendors blurs the click-to-close measurement the engine depends on. But that's a session conclusion, not a sales-page rule: we'll map what you're running now and tell you straight what should stay.`
- RETIRED: `Can you work with the systems and vendors we already use?` → `Yes, where they can feed the engine. Click-to-close measurement needs your phones, calendar, and case data connected, so we build around your existing practice management setup rather than forcing a migration. If another vendor already owns a piece of the engine, the session maps the overlap and we tell you straight.`
- RETIRED: `Do we need to be generating leads already?` → `No. Building lead flow is CaseGen™'s whole job, and the engine can start there. The gap tends to be widest, though, at firms already paying for opportunity — if you generate leads but sign fewer cases than the flow deserves, that leak is where the engine goes to work first.` (its no-leads-needed point now lives structurally in the rewritten fit list)
- RETIRED with the FAQ 7 rework, the standalone three-asks opener: `Three things. Someone at the firm who can own the decisions the engine needs. Access to the numbers that measure it — leads, consultations, signed cases. And the willingness to let us measure intake and sales, not just marketing.` (continues inside the new FAQ 3 answer as "Your firm brings three things: …")

**§14 — Final close, then the book.** Closing slimmed to one beat — the qual cards left for the fit band (see §12) and the sub-line was first replaced: RETIRED `Sound like a fit? The call is free, with our Head of Sales — a deep dive into your leads, consults, and signed cases, and a plan shaped to your revenue goals.` → `Sound like a fit? The session is free — you leave knowing what is limiting revenue and what should be fixed first.`; that wording is now RETIRED in favor of `Sound like a fit? The session is free — you leave knowing how to start with Marketing, then build through Intake to Sales.` (the fact set lives in the offer band; "free" — ledger #36; the close follows the fixed implementation sequence). Book band MOVED below the final close as the lower-commitment coda; eyebrow rename: `WE WROTE THE BOOK ON IT` → `NOT READY FOR A REVENUE SESSION? START WITH THE BOOK.` (brief-verbatim; every other line in the band unchanged).

**Contact form removed + CTA budget.** The homepage contact band is DELETED — RETIRED: the `HAVE A QUESTION?` eyebrow, the `Not Ready To Book? Just Ask.` H2, and the homepage `data-nb-inquiry="contact"` form with its `SEND MESSAGE →` button. The shared inquiry contract is untouched: `/book-free-demo/` and `/unsubscribe/` forms run exactly as before, and the footer's existing `Contact` link (→ `/book-free-demo/#Contact`) is the homepage's message route. Also REMOVED under the four-slot budget: the customization band's `.nb-custom-cta` session button and the homepage footer's `Book a High Impact Revenue Session` COMPANY link (subpage footers keep theirs). Result: exactly four booking slots page-wide — header (+ its mobile-menu twin markup), hero, after proof, final close.

**Lockstep:** home.ts header-order comment + per-band comments (team / offer / fit / faq / closing / book; contact comment deleted); home-client/main.ts part list + wall-retirement note (teamWall import and init call removed); home.css band comments + rule families (`.nb-offer*` / `.nb-fit` / `.nb-faq-sec` new; the wall `data-team-mode` family, `.nb-team-ask` / `.nb-team-more*` / `.nb-team-grid-rest`, the whole contact family, and `.nb-custom-cta` deleted at every breakpoint; `.nb-team-grid` → five columns; `.nb-close-ask` gap 64px → 44px; ≤380 qual rules retargeted `.nb-closing` → `.nb-fit`); docs/website-final-copy.md order block + §9/§12/§12b/§12c/§13/§14/footer records; docs/website-claim-ledger.md rows #24/#29/#36/#37 where-used notes; committed site regenerated via `npx tsx website/generate.ts`.
- Files: website/src/pages/home.ts, website/src/home-client/main.ts,
  website/src/home-client/teamWall.ts (deleted),
  website/public/assets/css/home.css, website/public/* (regenerated),
  docs/website-final-copy.md, docs/website-claim-ledger.md,
  docs/website-copy-changelog.md,
  tests/website-team-wall-contract.test.ts (deleted),
  tests/website-engine-story-semantic-content.test.ts,
  tests/website-inquiry-forms.test.ts,
  tests/marketing-site-mobile-baseline.test.ts.

## Homepage restructure 5 — full-page verification (2026-08-18, Task #4927)

Stage 5 of the 2026-08-18 owner brief (`attached_assets/Pasted-The-page-is-directionally-much-better-than-the-cinemati_1787000455136.txt`, "Visual direction" + "The target"), closing the #4923→#4926 sequence. ZERO copy change — this pass verifies the assembled page and applies presentation-only residuals (type-size floor, spacing trims, straggler test cleanup).

**Verified against the brief (desktop 1440, mobile 390 + 767 probe, reduced-motion; headless Chromium):**
- Row order end-to-end matches the target: hero → credibility rail → gap → components overview (#system) → CaseGen/CaseIntake/CaseConvert → customization → flagship proof + supports (#proof) → REE → static testimonials → team → session offer → fit → FAQ → final close → book band (#book) → footer (Contact → `/book-free-demo/#Contact`). Strictly increasing offsets, no stray bands.
- Booking CTAs: exactly the four slots (header + its hidden mobile-menu twin, hero, after proof, final close); the footer Contact link is excluded from the budget by its `#Contact` fragment. Mobile shows 4 visible.
- Anchors (`#system`, `#proof`, `#comp-*`, `#book`) land at 0–1px under the non-sticky header; hamburger nav present at 390.
- Motion: zero infinite animations page-wide (no marquee/carousel/wall behavior); all reveal elements visible after scroll; reduced-motion shows everything without scrolling; no horizontal overflow at 390 or 767.

**Type-size floor (≥16px for meaningful text).** Bumped to 16px: `.nb-lede` (15.5) · `.nb-flag-part p` (15) · `.nb-slide-how` (15) · `.nb-review p` (15) · `.nb-faq-item p` (15) · `.nb-comp-build` (15) · `.nb-qual-card li` (14.5) · `.nb-ree-lever-list li` (14.5) · `.nb-custom-area-line` (14.5). Kept BY DESIGN below 16px: uppercase micro-labels/eyebrows/stat captions, button and text-link chrome, SVG diagram labels (`.nb-dg-*`), quote attributions, and the fine-print register (`.nb-hero-note` 13 · `.nb-comps-note` 13 · `.nb-measure p` 13.5 · `.nb-book-caption` 13.5 · `.nb-close-alt` 13.5 · `.nb-gap-leak` 12.5).

**Spacing trims (height budget).** Band paddings trimmed ~20%: `.nb-system` 96/100→80/84 · `.nb-custom` 104/112→84/88 · `.nb-proof` 115→88 · `.nb-testimonials` 92→76 · `.nb-team` 100/90→80/72 · `.nb-offer` 100→80 · `.nb-fit` 96/100→76/80 · `.nb-faq-sec` 100→80 · `.nb-closing` 96/140→76/108 · `.nb-book-sec` 110→88 · `.nb-comps-note` bottom 96→72; customization inter-block margins 60→44. Desktop height 14,118px → **13,764px** (the type floor added back ~250px). The brief's ~10–11k target is NOT reached: the remaining ~2.8k px is intrinsic band content (three ~1k component sections, a 1.7k proof zone), and compressing it exceeds this stage's small-trims scope — flagged for an owner-decision follow-up.

**Residue.** DELETED the stranded team-wall suite trio — `tests/website-team-wall-font-swap-mobile.test.ts` + `website-team-wall-gsap-hooks.mjs` + `website-team-wall-gsap-setup.mjs` (Task #4918): the module they mount (`home-client/teamWall.ts`) was deleted by #4926, leaving that smoke suite red on ERR_MODULE_NOT_FOUND; the governance test-portfolio baseline was regenerated. Corpus grep for every band retired in #4923–#4926 (proof slider, testimonial marquees, team wall, handoff band, complete-engine recap, homepage contact form, the $1→$8 REE example): zero live references remain — the only surviving tokens are the guard tests' own ban lists, comment-layer ledger notes, and docs history, all intentional.

**Lockstep:** docs order line (`website-final-copy.md` + the home.ts header comment) verified current — no sections moved; committed site regenerated via `npx tsx website/generate.ts`.
- Files: website/public/assets/css/home.css, website/public/* (regenerated),
  tests/website-team-wall-font-swap-mobile.test.ts (deleted),
  tests/website-team-wall-gsap-hooks.mjs (deleted),
  tests/website-team-wall-gsap-setup.mjs (deleted),
  audits/governance/test-portfolio-baseline.json (regenerated),
  docs/website-copy-changelog.md.


## Homepage REE removal — score strip deleted, footer link relabeled (2026-08-18, Task #4987)

Owner decision: the homepage carries ZERO REE mentions. The score's
introduction, definition, and working surface now live solely on
`/calculator/` (ledger #38/#39); subpages are untouched (the resources
band, article sidebar cards, and free-chapters endcap/bar keep their
`CALCULATE YOUR REE →` CTAs, and subpage footers keep `REE Calculator`).

**REMOVED — the REE score strip (`#ree`), whole band.** Last rendered in
its #4925 four-beat form (recorded here for history; none of it renders
anywhere now):
- Eyebrow `REVENUE ENGINE EFFICIENCY`
- H2 `Revenue Is the Goal. REE Is the Score.`
- Screen-reader definition sentence `Revenue Engine Efficiency, or REE,
  is your attributable top-line revenue divided by your growth
  investment.` (the plate's `.nb-vh` SR-parity twin)
- The brass-plaque formula plate — `THE SCORE` tab, schematic corner
  ticks, `REE = ATTRIBUTABLE TOP-LINE REVENUE ÷ GROWTH INVESTMENT`
- `WHAT MOVES THE SCORE` + the four levers: `Cost and quality of
  qualified leads` · `Lead-to-consultation rate` ·
  `Consultation-to-case rate` · `Average revenue per signed case`
- Tail CTA `CALCULATE YOUR REE →` → `/calculator/` (the label lives on
  at the subpage surfaces above)

Band history closed out: #4120 (introduced) → #4166 (scoreboard) →
#4259 (connective tissue) → #4816 (compressed, moved below proof) →
#4925 (terminal four beats) → #4987 (removed).

**RENAMED — homepage footer RESOURCES link:** `REE Calculator` →
`Revenue Calculator` (same `/calculator/` destination; homepage footer
only — subpage footers in `html.ts` keep the old label).

**Seam.** The strip sat on `--warm` between the egg proof band and the
warm testimonials band, drawing the second seam with its own bottom
hairline. With the band gone the egg proof band hands off directly to
the warm testimonials band — a natural tone step needing no replacement
hairline or gradient.

**Client + CSS.** `home-client/reeReveal.ts` (the strip's once-on-entry
rise, formerly Part 6) deleted; `main.ts` prunes its import/init and
renumbers its part-map comments. The strip's whole dotted CSS rule
family left `home.css` with the band — the base rules, the ≤850 and
≤520 media overrides, and the #4121 strip-tail CTA margin rule (the
`.nb-close-alt` closing-secondary rules stay).

**Docs + guards lockstep.** final-copy: the arc line loses its
**Score** beat, the section-order chain re-seams proof → testimonials,
§2b is marked REMOVED with the last-rendered record kept below it, and
the footer RESOURCES line records the rename. messaging-architecture:
argument item 5, the glossary Public-score row, the four-lever
ownership note, the soft-CTA table row, and §6 3b restated around the
removal. claim-ledger row #38's liveness notes updated (strip removal,
footer relabel, `/calculator/` sole introduction). Guard suites
re-anchored content-only: anchors (`id="ree"` asserted absent),
semantic-content (REE beats dropped, removal ban-list group added),
static-integrity (the `nb-ree`/`data-ree-` markup + CSS families join
the retired ban lists), calculator-math homepage block (negative
asserts + `Revenue Calculator`), copy-playbook drift ceilings
re-measured. Committed site regenerated via `npx tsx
website/generate.ts`.
- Files: website/src/pages/home.ts, website/src/home-client/main.ts,
  website/src/home-client/reeReveal.ts (deleted),
  website/public/assets/css/home.css, website/public/* (regenerated),
  tests/website-engine-story-anchors.test.ts,
  tests/website-engine-story-semantic-content.test.ts,
  tests/website-engine-story-static-integrity.test.ts,
  tests/website-ree-calculator-math.test.ts,
  tests/lint-website-copy-playbook-drift.test.ts,
  docs/website-final-copy.md, docs/website-messaging-architecture.md,
  docs/website-claim-ledger.md, docs/website-copy-changelog.md,
  audits/governance/test-portfolio-baseline.json (regenerated).
## Homepage team reorder + endless roster (2026-08-18, Task #4979)

Owner directive: lead the team band with **Ronnie Deaver → Oliver Goessler → Brett Barney → Jeff Mangle → Janno Perez → Cam Duhart**, then everyone else, and make the team feel like it goes on forever. This SUPERSEDES the #4926 §10 five-person compression (§10 of that brief is no longer binding for this band) — the homepage returns to the full 18-person roster. ZERO copy edits to any member's name or role; the band's eyebrow + H2 are untouched.

**Roster restored + reordered.** All 18 people return to the `home.ts` TEAM array (names/roles/photos verbatim from the pre-#4926 source): the six named leads in the directive's exact order, then the prior relative order — Jake Davis · Cat McManus · Jason Robbins · Priyanka Lakha · Juan Antoniazzi · Santiago Sanchez · Kaylie Dietrichsen · Devin Petersen · Jordan Scrimgeour · Liri Abdullahu · Cleo Ortega · Lotis Florida. Brett Barney (Head of Accounts) returns to the homepage — he was in the pre-#4926 roster and `brett2.jpg` never left the repo.

**Endless wall RESURRECTED.** `home-client/teamWall.ts` returns, adapted from the #4903 module #4926 deleted: motion-allowed visitors see the 18 cards drift through a masked fixed-height window of counter-scrolling columns (time-based repeat:-1 tweens at unequal speeds, IntersectionObserver off-screen pausing, hover/focus pause, aria-hidden clone loops, width + font-settle rebuilds, gsap.matchMedia reduced-motion teardown — no ScrollTrigger, nothing pins). Adaptations vs #4903: ONE 18-card grid is the source and the complete no-JS / reduced-motion fallback (the 7+11 disclosure split and the in-band session ask stay retired), and the wall's narrow breakpoint follows the grid's current 850px split (was 1000px). The `data-team-mode` CSS family returns to home.css; the static grid widens to six columns (the named six form the first row) and keeps its 2-col/1-col collapses.

**REMOVED — the About roster link** (label was `MEET THE COMPLETE NOBULL TEAM →`): the complete roster now renders in-band, and /about/ shows only three bios, so the label over-promised. Header nav + footer keep the About routes. NO in-band booking CTA (unchanged): the page stays at four booking slots / five `book-free-demo/` anchors.

**Guards.** `tests/website-team-wall-contract.test.ts` resurrected in adapted single-grid form (from the #4905 contract suite #4926 deleted): served-fallback / CSS-mode-gate / module-accessibility-and-teardown / main.ts-wiring asserts — static file scans only; the #4918 jsdom font-swap trio stays retired (its bespoke gsap harness cost outweighs the seam; the fonts.ready rebuild contract is asserted statically). `website-engine-story-semantic-content` un-bans ONLY `data-team-mode` (runtime-stamped by the resurrected wall), keeps `nb-team-ask` / `nb-team-more` / `nb-team-grid-rest` / the old headline banned, bans the dropped About-link label, and pins the 18-name roster order. Copy-playbook drift ceiling raised 100 → 103 (excused set 101: the retired About-link label joins with a REMOVED marker in §12).

**Lockstep:** home.ts header-order comment + TEAM comment + band comment; main.ts part list (Part 7 restored); home.css band comment + wall family at every breakpoint; docs/website-final-copy.md order block + §12; committed site regenerated via `npx tsx website/generate.ts`; governance test-portfolio baseline regenerated.
- Files: website/src/pages/home.ts, website/src/home-client/teamWall.ts (restored), website/src/home-client/main.ts, website/public/assets/css/home.css, website/public/* (regenerated), tests/website-team-wall-contract.test.ts (restored), tests/website-engine-story-semantic-content.test.ts, tests/lint-website-copy-playbook-drift.test.ts (excused ceiling), docs/website-final-copy.md, docs/website-copy-changelog.md, audits/governance/test-portfolio-baseline.json.


## Homepage product section — single-funnel redesign (2026-08-18, Task #4992)

**One continuous funnel replaces the engine story.** Owner brief
`attached_assets/Pasted-Here-is-the-complete-version-I-would-hand-to-the-design_1787066887433.txt`
(canonical, followed verbatim): the #system region is now ONE
continuous top-down funnel object — three stacked, touching,
angle-edged stages (CaseGen/MARKETING full width → CaseIntake/INTAKE
~84% → CaseConvert/SALES ~68%) narrowing into a smaller gold
`SIGNED CASES` plaque (~44%) under one continuous gold rim — so the
page communicates "CaseGen creates the right opportunities →
CaseIntake keeps them from disappearing → CaseConvert turns
consultations into signed cases → SIGNED CASES" in a single glance,
as one Revenue Engine rather than three product cards. Mobile keeps
the funnel with gentler narrowing (100/94/88/70) and shallower
angles. The four bands it replaces — charcoal overview, the three
component sections, and the dark customization band — are retired
wholesale (every retired rendered line below). The gap band above and
the proof band below are byte-identical; the section keeps
`id="system"` so the header "Solutions" links, footer link, hero
secondary button, and every generated subpage link still land.

**New rendered copy (brief-verbatim).** Eyebrow `THE LAW FIRM REVENUE
ENGINE` (unmarked — the ™ engine naming stays with the meta
description) · H2 `One Revenue Engine. Three Core Components.` · no
intro paragraph. Stages (dept → product → outcome headline → one
capability line; no body paragraphs, no per-product CTAs, no
input/output labels, no between-stage copy, no arrows):
- 01 `MARKETING` / `CASEGEN™` / `Create More of the Right
  Opportunities.` / `Local Authority Optimization™ · Paid Search
  Control System™ · Review Velocity System™`
- 02 `INTAKE` / `CASEINTAKE™` / `Stop Qualified Leads From
  Disappearing.` / `Answer faster · Guide consistently · Follow up ·
  Remove friction`
- 03 `SALES` / `CASECONVERT™` / `Turn More Booked Consultations Into
  Signed Cases.` / `Script the conversation · Strengthen the offer ·
  Coach the execution`
Plaque `SIGNED CASES`. Section ask (~64–72px below the plaque, the
section's only CTA): H3 `Build a Revenue Engine That Produces More
Signed Cases.` (non-breaking "Signed Cases" glue) + button `Book Your
High Impact Revenue Session →` → `/book-free-demo/` — the brief's
BOOK YOUR HIGH IMPACT REVENUE SESSION, a deliberate YOUR-variant of
the sitewide session label on this button only. Stage emblems are
engraved line art (search pin / conversation-calendar / agreement
seal), aria-hidden, with translucent stage numerals behind the copy;
faint engineering-grid section background. Motion: the served markup
ships fully lit; motion-allowed visitors get a once-only top-down
illumination (stage-by-stage brighten, restrained plaque glow — no
traveling leads, loops, or particles); reduced-motion/JS-off see the
identical final state (`data-fn-anim` pending→done stamp, mirroring
the gap band's contract).


### 2026-08-27 — Product Funnel Capability Beats

**Owner-approved capability wording.** CaseIntake now reads `speed to
human, consult capture, revenue follow through`, and CaseConvert now reads
`Consult to Client Script, Obvious Choice Offer, Close Rate Lab`. CaseGen's
three system names remain unchanged.

**Layout.** The three capability phrases in every stage now render as
separate semantic beats with centered vertical spacing, so the short copy
occupies the existing angled surfaces intentionally without adding body
copy, cards, or changing the funnel's geometry, order, or conversion path.

### 2026-08-19 — Product Funnel Scroll Focus (Task #5065)

**Section identity.** The `#system` eyebrow now reads `OUR PRODUCT LINES`.
The existing `One Revenue Engine. Three Core Components.` headline, all
Marketing / Intake / Sales product copy, signed-cases terminus, CTA, anchor,
and funnel geometry remain unchanged.

**Motion.** The former once-only illumination has been replaced with reversible
viewport-reading-zone focus. In the motion-allowed experience, exactly one
stage is warm and prominent at a time, proceeding Marketing → Intake → Sales
on downward scrolling and reversing in the same order upward. The non-focused
stages receive a restrained readable veil. Leaving the funnel's active range
resets every stage to the fully readable served state. There is no pinning,
scroll-jacking, snapping, or scrubbed timeline. Reduced-motion and JavaScript-
disabled visitors retain the complete fully lit funnel; `data-fn-focus` is
present only while a motion-enabled stage is focused.

**Retired — (b) charcoal overview (#4923 five-second model, rendered
2026-08-18 only).** Kicker `THE LAW FIRM REVENUE ENGINE™` · H2 `THE
THREE CORE COMPONENTS` · lede `Built in order. Connected from
qualified lead to signed case.` · three num/name/dept columns (01
CASEGEN™ · MARKETING; 02 CASEINTAKE™ · INTAKE; 03 CASECONVERT™ ·
SALES) with the stage outputs as visible connectors: `QUALIFIED
LEADS` → `CONSULTATIONS THAT HAPPEN` → terminal `SIGNED CASES`
(cream). The funnel keeps the trio and the SIGNED CASES terminus;
the output-connector copy (`QUALIFIED LEADS`, `CONSULTATIONS THAT
HAPPEN`) does not carry over — the narrowing geometry now says it.

**Retired — (c1)(c2)(c3) component sections (#4837, four-question
layout #4924).** Shared skeleton per section: id line (`01 ·
CASEGEN™ · MARKETING` form) → outcome H2 → one paragraph → large SVG
diagram → `WHAT NOBULL BUILDS AND MANAGES` list → `WHAT CHANGES` line
→ `ONE FIRM’S RESULT` row; desktop sticky 01/02/03 index rail beside
them.
- CaseGen: H2 `CREATE MORE OF THE RIGHT OPPORTUNITIES.` · lede
  `CaseGen combines local search, paid search, and reviews to create
  qualified demand your firm can measure and control.` · diagram
  `LOCAL AUTHORITY` / `PAID SEARCH` / `REVIEWS` converging into
  `QUALIFIED LEADS` · builds `Local Authority Optimization™` / `Paid
  Search Control System™` / `Review Velocity System™` · changes
  `Know which markets, searches, and channels produce qualified
  leads, what those leads cost, and where to invest next.` · result
  `2×` `Lead growth in 90 days` [proof.ts:FOUNDATION_2X, ledger #9].
  (The three ™ system names live on — the funnel's CaseGen
  capability line carries them verbatim; /services/ keeps its own.)
- CaseIntake: H2 `STOP QUALIFIED PROSPECTS FROM DISAPPEARING.` (the
  funnel headline says "Qualified Leads" instead — brief-verbatim) ·
  lede `CaseIntake installs the response, qualification, scheduling,
  and follow-up systems your team needs to move viable leads to
  consultations.` · diagram `NEW LEAD` → `RESPONSE` →
  `QUALIFICATION` → `BOOKING` → `CONFIRMATION` → `CONSULTATION` with
  the `RECOVERY ROUTE` (`MISSED CALL`, `NO RESPONSE`,
  `CANCELLATION`, `NO-SHOW`) rejoining · builds `Lead routing,
  ownership, and response workflows` / `Qualification and booking
  processes` / `Missed-call, no-response, cancellation, and no-show
  recovery` / `Tracking, scripts, and intake coaching` · changes
  `Every lead has an owner, a status, a next action, and a
  measurable path to consultation.` · result `38.3%` → `75%`
  `LEAD-TO-CONSULT RATE` [proof.ts:LEAD_TO_CONSULT, ledger #11].
- CaseConvert: H2 `TURN MORE CONSULTATIONS INTO SIGNED CASES.` (the
  funnel headline adds "Booked" — brief-verbatim) · lede
  `CaseConvert gives attorneys a repeatable consultation framework,
  a stronger legal-services offer, and ongoing coaching to improve
  the percentage of qualified prospects who hire.` · diagram
  `DIAGNOSE` → `RECOMMEND` → `EXPLAIN VALUE` → `RESOLVE HESITATION`
  → `ENGAGE` with the `COACHING LOOP` (`CALL REVIEW` → `SCORECARD` →
  `COACHING` → `NEXT CONSULTATION`) · builds `Consultation framework
  and scripts` / `Offer and engagement presentation` / `Follow-up
  after the consultation` / `Call recording, scorecards, and
  coaching` · changes `Know why prospects hire, where consultations
  stall, and what should be coached next.` · result `15%` → `40%`
  `CONSULT-TO-CASE RATE` [proof.ts:CONSULT_TO_CASE, ledger #12].
Band-level attribution `Each number represents one real firm’s
result, never an average.` retired with the receipts — the three
figures and their captions render on /services/ only now (ledger
rows 9/11/12 updated; proof.ts exports unchanged — /services/ and
/data-notes/ still consume them). The funnel carries NO receipts,
per the brief's remove list ("Individual proof points per product").

**Retired — (d) customization band (#4924, rendered 2026-08-18
only).** Kicker `CUSTOMIZATION` · H2 `BUILT AROUND THE FIRM YOU WANT
TO GROW` · paragraphs `The three core components stay the same. What
goes inside them is built around your practice areas, markets, team,
capacity, case economics, and growth goals.` + `A high-volume
consumer practice needs a different revenue engine than a
lower-volume, high-value firm. We build the engine your firm needs —
not the one we prefer to sell.` · adjustable areas `MARKETING` /
`Market, practice mix, lead volume, acquisition cost and budget.`,
`INTAKE` / `Qualification standards, staffing, response, scheduling
and follow-up.`, `SALES` / `Consultation structure, offer, pricing,
payment options and follow-up.` · implementation-order flow line
`MEASURE THE CURRENT ENGINE` → `BUILD MARKETING` → `BUILD INTAKE` →
`BUILD SALES` → `IMPROVE THE NEXT CONSTRAINT` (ledger #24's
component-order surface — gone from the homepage with the band) ·
CTA `Book a High Impact Revenue Session →`. The page-wide booking
budget moves from four slots to FIVE (header, hero, product section,
after proof, final close) — the funnel's YOUR-variant button replaces
the customization band's standard-label CTA as §4's single ask.

**Structure/motion retirements.** The engine-story class families
(`nb-system*`, `nb-comp*`, `nb-custom*`, `nb-dg*`) and `data-es-*`
motion hooks left the template and stylesheet; the six diagram SVGs
and the sticky index rail with them. `home-client/engineStory.ts`
was rewritten in place (same module path, same `initEngineStory`
export): the old once-only fade/rise + line-draw + index/gold-sweep
choreography is replaced by the funnel illumination sequence
(ScrollTrigger on `[data-fn-object]`, per-stage veil-lift + lume
pulse, plaque glow; `prefers-reduced-motion: no-preference` gated,
once only). Tests: the three engine-story suites + the hosts-CSS
assert were rewritten as content-only edits (registration names now
carry the funnel wording — test-portfolio baseline regenerated);
banned lists extended with the retired class stems and retired copy.
Docs: final-copy §4 + section-order block rewritten (five-slot CTA
budget), claim-ledger rows 9/11/12/24 + book-CTA row updated,
proof.ts/bookLinks.ts comments refreshed. Site output regenerated
(`npx tsx website/generate.ts`).

- Files: `website/src/pages/home.ts`,
  `website/public/assets/css/home.css`,
  `website/src/home-client/engineStory.ts`,
  `website/src/home-client/main.ts`, `website/src/bookLinks.ts`,
  `website/src/proof.ts`,
  `tests/website-engine-story-static-integrity.test.ts`,
  `tests/website-engine-story-semantic-content.test.ts`,
  `tests/website-engine-story-anchors.test.ts`,
  `tests/marketing-site-hosts.test.ts`, `docs/website-final-copy.md`,
  `docs/website-claim-ledger.md`, `docs/website-copy-changelog.md`,
  regenerated `website/public/` output.
## Endless testimonials marquee restored (2026-08-18, Task #4980)

Owner decision: bring back the "reviews go on forever" treatment on the
testimonials band — a FULL restore of the #3997 endless marquee that
restructure 3 (Task #4925, owner brief §9) had replaced with the static
3-video + 3-quote curated set. ZERO new copy: every restored card and
quote is the previously published #3997 material, verbatim from the
pre-#4925 source; the band keeps its H2 (`Hear It From The Firms We
Grow.`), its eyebrow-removed state, its position, and the restructure's
trimmed band padding + 16px review-text floor. The page's booking-CTA
budget is untouched, and the proof band's #3915/#4261 slider stays
retired — this reversal is the testimonials band's alone.

**REVERSAL RECORDED — video distinctness.** #4925's selection rationale
kept the three video firms DISTINCT from the proof band's case studies
directly above; the owner reversed that call: the Presti Law + Burns
Smith Law cards return (5 video cards total), knowingly repeating the
flagship's and support's firms one band below. Both cards restore
as-published (public Vimeo titles per truth-source §5, committed posters
never left the repo).

**Restored surfaces.**
- Video row: Shields & Boris · Covington & Associates · Integrity Law ·
  Presti Law · Burns Smith Law — plain outbound Vimeo anchors with the
  paused-player poster treatment, drifting in one auto-scrolling row.
- Quote rows: all ELEVEN five-star quotes return in their #3997 A/B
  split (row A: Alistair Schneider, Alec Chapa, Lani Akiona, Susannah
  Bruck, Jake Cutler, Stacy Grow; row B: Tessa Thrift, Jayanta
  Acharyya, Atara Twersky, Sam Varnerin, Attorney Angelik Edmonds), two
  counter-scrolling rows below the videos. The eight Google-review
  excerpts render again footed `— Name, Google Review`; Tessa/Lani/
  Stacy keep their role feet (truth-source §4 register unchanged).
- `home-client/testimonialsMarquee.ts` restored verbatim from the
  pre-#4925 source (Part 8): `data-testi-mode="marquee"` stamp for
  motion-allowed visitors, seamless time-based clone loops (videos
  drift faster, quote row B reversed), hover/focus-within pause,
  focus-jump with scroll reset, IntersectionObserver off-screen pause,
  reduced-motion teardown via gsap.matchMedia, zero ScrollTriggers. The
  served static grids (5 + 11) remain the complete no-JS /
  prefers-reduced-motion presentation.
- home.css: the `[data-testi-mode="marquee"]` rule family returns
  (masked rows with soft edge fades, flex tracks, fixed card widths,
  row spacing at every breakpoint), grafted onto the current band base —
  the served quote grid returns to its pre-#4925 two-column desktop/
  tablet form, collapsing at ≤520px.

**Guards.** `website-engine-story-static-integrity` un-bans the marquee
stems (`.nb-marquee` CSS family + the mode stamp — the band's lockstep
comments name them again); `website-engine-story-semantic-content`
asserts the served 5-video/11-quote grids, all five firm names, the
role-footed trio, and exactly eight `Google Review` feet (replacing the
static-set zero-Google-feet assert), while KEEPING `data-testi-mode`
banned from served markup — the stamp stays runtime-only. Mobile
baseline re-words its collapse check for the restored two-column quote
grid. Copy-playbook drift: the rewritten §8 quotes verify against the
regrown corpus (370 verified; excused steady at 101, ceiling 103
unchanged).

**Lockstep:** home.ts header-order comment + band comment + restored
video/quote arrays; main.ts part list (Part 8 restored, retirement note
now proof-slider-only); home.css band comment + marquee family at every
breakpoint; docs/website-final-copy.md order block + §8; claim-ledger
and truth-source §4/§5 liveness notes flipped back to live;
messaging-architecture proof bullets; committed site regenerated via
`npx tsx website/generate.ts`; governance test-portfolio baseline
regenerated.
- Files: website/src/pages/home.ts, website/src/home-client/
  testimonialsMarquee.ts (restored), website/src/home-client/main.ts,
  website/public/assets/css/home.css, website/public/* (regenerated),
  tests/website-engine-story-static-integrity.test.ts,
  tests/website-engine-story-semantic-content.test.ts,
  tests/marketing-site-mobile-baseline.test.ts,
  tests/lint-website-copy-playbook-drift.test.ts,
  docs/website-final-copy.md, docs/website-copy-changelog.md,
  docs/website-claim-ledger.md, docs/CONTENT_TRUTH_SOURCE.md,
  docs/website-messaging-architecture.md,
  audits/governance/test-portfolio-baseline.json.


## Closing band simplified — calculator soft line + duplicate H3 removed (2026-08-18, Task #5014)

Owner screenshot note: the final close should drop its calculator/REE
mention and read tighter. Since #4926 the band stacked five copy beats
and ended on the #4121 soft rung; it now runs four — H2 → lede →
sub-line → button — with exactly one hard ask and zero calculator copy.

**Removed (both recorded in final-copy §13):**
- REMOVED: the closing secondary line `Want a number first? Calculate your Revenue Engine — free, no email required.` (Task #4121's CTA-ladder soft rung, a quiet `.nb-close-alt` text link to `/calculator/` under the button). It was the homepage's last calculator rung above the footer — the footer RESOURCES `Revenue Calculator` link (relabeled by #4987) is now the homepage's ONLY calculator entry. Every other calculator surface is untouched: free-chapters endcap + floating bar, article sidebar cards, resources band, subpage footers, /calculator/ itself.
- REMOVED: the ask cluster's serif H3 `Book a High Impact Revenue Session.` — a verbatim duplicate of the CTA button directly under it; the gold closer rule now sits over the slimmed sub-line. No replacement copy: the surviving H2, lede, sub-line, and button are byte-identical (no new claims — the ledger is untouched except row 38's homepage-rung liveness note).

**Structure after:** bull mark → `Ready to Build Your Revenue Engine?` →
`You're already paying to create opportunity. The question is how much of it becomes revenue.` →
gold rule → `Sound like a fit? The session is free — you leave knowing how to start with Marketing, then build through Intake to Sales.` →
`Book a High Impact Revenue Session →`. Still exactly ONE hard ask; the
page-wide booking budget (five slots, six anchors with the header) and
the band's presentation (bull, rule, button styling) are unchanged.

**Guards:** the CTA-ladder wiring test flips its homepage assertions —
the secondary line and its class hook must be ABSENT and the footer link
must be the homepage's only calculator href (subpage, article, and
free-chapters soft-rung assertions unchanged); the semantic-content
page-wide booking count passes untouched.

**Lockstep:** home.ts band template + header-order comment;
home-client/closingAsk.ts beat comment; home.css (closing-secondary
quiet-link rule family and the dead ask-heading rule dropped, band
header + ask-cluster comments updated); docs/website-final-copy.md
(order block + §13 heading/body + H3/Secondary retirement records +
treatment note); docs/website-messaging-architecture.md soft-CTA
surfaces row; docs/website-claim-ledger.md row 38 liveness tail;
committed site regenerated via `npx tsx website/generate.ts`;
governance test-portfolio baseline regenerated.
## Dedicated /contact/ page — sitewide footer Contact repoint (2026-08-18, Task #5015)

**Change:** Since Task #4926 deleted the homepage contact band, the site's
only message route was the footer Contact link deep-linking to the booking
page's form section (`/book-free-demo/#Contact`) — visitors explicitly NOT
ready to book a High Impact Revenue Session got dropped onto the booking
page anyway. New standalone `/contact/` page in the shared chrome
(website/src/pages/contact.ts, registered in generate.ts, sitemap priority
0.5), and BOTH footers (shared subpage footer in html.ts + the homepage's
self-rendered footer in home.ts) now point their Contact link at
`/contact/`. The booking page's own `#Contact` section is untouched (still
useful for mid-booking questions), and the server inquiry pipeline is
unchanged — the new page runs the exact shared form contract
(`data-nb-inquiry="contact"`, honeypot, per-form `data-success`, status
element), so submissions land as `website_inquiries` rows attributed to
`/contact/` as their source page.

**New page copy (all NEW strings):**
- Title `Contact Us | NoBull Marketing`; meta welcomes the not-ready-to-book
  visitor and names the session correctly.
- H1 band: eyebrow `Talk To Us` / H1 `Have a Question? Ask Away.` / sub
  "Not every conversation starts with a booking. Send us a message about
  your firm, your marketing, or anything you've read here — we'll get back
  to you as soon as we can." (no response-time promise — claim-safe).
- Form intro: "Tell us who you are and what's on your mind."; fields,
  honeypot, `Send Message` button, and success line are the booking form's
  exact contract.
- Soft booking pointer below the form: eyebrow `When You're Ready` / H2
  `Rather Talk It Through?` / sub reuses the established
  first-click-to-signed-case framing / `Book a High Impact Revenue Session`
  button → `/book-free-demo/`.

**Lockstep:** home.ts header-order comment + FAQ band comment (both note the
footer Contact link now points at /contact/); docs/website-final-copy.md
(section-order block, §14 contact-band deletion note, footer section, new
`## /contact/` section); docs/DO_NOT_BREAK.md (§1 URL table row + §6 contact
forms heading/contract note); tests/website-inquiry-forms.test.ts (footer
route assertion + new /contact/ e2e scenario, suite now makes exactly 5
POSTs of the 6/min budget); committed site regenerated via
`npx tsx website/generate.ts` (new contact/index.html joins the bundle,
sitemap manifest, and freshness stamp).
- Files: website/src/pages/contact.ts (NEW), website/generate.ts,
  website/src/html.ts, website/src/pages/home.ts, website/public/*
  (regenerated), tests/website-inquiry-forms.test.ts,
  docs/website-final-copy.md, docs/website-copy-changelog.md,
  docs/DO_NOT_BREAK.md.
## Team band: endless wall replaced by collapsed grid (2026-08-18, Task #5011)

Owner verdict on the #4979 endless vertical team wall: it doesn't look
good. Task #5011 RETIRES the wall — `home-client/teamWall.ts` is deleted
with its `data-team-mode` CSS family (re-retiring the #4903 treatment
for good; the band never scrolls or drifts for any visitor now) — and
the band becomes a calm static grid that opens collapsed.

**ZERO roster copy changes.** All 18 people, the #4979 directive order
(Ronnie → Oliver → Brett → Jeff → Janno → Cam, then the prior relative
order), every name/role/photo, and the band's eyebrow + H2 are
untouched. The served markup remains the complete 18-card grid, so
no-JS visitors still see everyone.

**ONE new string** — the only copy this task adds — the disclosure
button label: `Meet the Full Team` (Title Case in source; home.css
uppercases it like every site label). The button is a JS-built toggle
(`home-client/teamReveal.ts`, the new Part 7) appended below the grid:
on load the section is stamped `data-team-collapsed="1"` and shows its
first two rows per breakpoint (12 / 4 / 2 cards at the grid's 6 / 2 /
1-column splits); pressing it reveals all 18 and can fold them back.
Native `<button>` with `aria-expanded` + `aria-controls`, an
aria-hidden chevron, `display:none` hiding (collapsed cards leave the
tab order and the accessibility tree), and the expand rise + chevron
flip animate only under `prefers-reduced-motion: no-preference`. The
label deliberately avoids the retired About-link phrasing `MEET THE
COMPLETE NOBULL TEAM` (that link stays gone — the roster renders
in-band; still NO in-band booking CTA).

**Guards:** `tests/website-team-wall-contract.test.ts` retired with the
module, replaced 1:1 by `tests/website-team-reveal-contract.test.ts` —
served HTML stays the complete zero-chrome grid (button + state
attributes are runtime-only), every card-hiding CSS rule keys on the
JS-set `data-team-collapsed` state (never viewport width alone) with
the per-breakpoint boundaries in lockstep beside the grid's column
rules, the reveal motion stays reduced-motion-gated, teamReveal.ts
keeps its disclosure a11y seams with zero GSAP/ScrollTrigger, main.ts
wires `initTeamReveal`, and the wall stems stay dead everywhere.

**Lockstep:** home.ts header-order + TEAM/teamCard/template comments;
main.ts part list (Part 7 is the disclosure now); home.css band comment
+ collapse family at every breakpoint (wall family deleted);
docs/website-final-copy.md §12 heading + presentation notes;
semantic-suite team comments; committed site regenerated via `npx tsx
website/generate.ts`; governance test-portfolio baseline regenerated.
- Files: website/src/home-client/teamReveal.ts (new),
  website/src/home-client/teamWall.ts (deleted),
  website/src/home-client/main.ts, website/src/pages/home.ts,
  website/public/assets/css/home.css, website/public/* (regenerated),
  tests/website-team-reveal-contract.test.ts (new),
  tests/website-team-wall-contract.test.ts (deleted),
  tests/website-engine-story-semantic-content.test.ts (comments),
  docs/website-final-copy.md, docs/website-copy-changelog.md,
  audits/governance/test-portfolio-baseline.json.


## Session-offer band removed (2026-08-18, Task #5016)

Owner request (screenshot): the homepage's `HOW WORKING TOGETHER
STARTS` section — the Task #4926 (brief §11) session-offer band that
sat between the team roster and the fit band — is deleted whole.
Retired with it: the H2 `Find the Constraint Costing Your Firm
Signed Cases.` (its `Signed&nbsp;Cases` glue pair with it), the
ledger-#36 four-fact lede `During a free High Impact Revenue Session,
our Head of Sales reviews your firm's real numbers — leads,
consultations, signed cases, and the rates between them — and builds a
plan shaped to your revenue goals.` (its `revenue&nbsp;goals` glue pair
with it), and the `YOU LEAVE KNOWING` card with its four brief-verbatim
bullets (`Which part of the engine is limiting revenue` · `The
estimated value of that constraint` · `What should be addressed first`
· `Whether NoBull is the right partner to build it`). The team band now
flows straight into `Is Your Firm a Fit?` — two egg-background bands
adjacent, the accepted band-removal seam.

**Nothing replaces the band, and no claim dies with it.** Ledger
#36/#37 stay LIVE: the hero session-explainer note, the closing
sub-line's free + you-leave-knowing pair (kept by the #5014
simplification), and the `/book-free-demo/` page carry the session
facts — only the rows' where-used notes changed. The band had NO
booking CTA, so the page's five-slot booking budget is untouched
(header, hero, product section, after proof, final close). The Task
#4926 WITHHELD-facts record (session length, who should attend, what
to bring, what happens afterward, the review list's "average case
value" item) is history and stands: those facts stay off the site.

**Guards:** `tests/website-engine-story-static-integrity.test.ts` bans
the band's class stem in the served homepage HTML (comments included)
and its dotted rule family in home.css, per the band-retirement
convention. No other suite anchored on the band.

**Lockstep:** home.ts header section-order comment + closing
ask-cluster comment (both now point the session facts at the hero note
and the booking page); home.css band rules deleted at every breakpoint
(base family + the ≤520px card-padding override) with the ask-cluster
comment reworded; docs/website-final-copy.md section-order block, §12b
REMOVED record, and §13 sub-line note; docs/website-claim-ledger.md
rows #36/#37 where-used notes; committed site regenerated via `npx tsx
website/generate.ts`; governance test-portfolio baseline regenerated.
- Files: website/src/pages/home.ts,
  website/public/assets/css/home.css, website/public/* (regenerated),
  tests/website-engine-story-static-integrity.test.ts,
  docs/website-final-copy.md, docs/website-claim-ledger.md,
  docs/website-copy-changelog.md,
  audits/governance/test-portfolio-baseline.json.
## Book secondary CTA: hero, nav, footer (2026-08-18, Task #5017)

Owner request (homepage-hero screenshot): the book joins the site's
three persistent CTA surfaces as the SECONDARY ask beside the primary
session CTA, wiring the book funnel (cover → free chapters → session,
owner doc §3) into the chrome. All three book CTAs open
`/free-chapters/`; source/DOM is title case `Read the Book` + arrow
and the `.nb-btn*` chrome renders it uppercase. Book CTAs are NOT
booking asks — the five-slot / six-anchor session budget is untouched.

- Hero: the outlined secondary `SEE THE THREE CORE COMPONENTS →`
  (→ `#system`, Task #4923) is RETIRED — the button now reads
  `Read the Book →` and opens the free chapters, matching the
  book-cover link across the hero split. `#system` stays reachable via
  the header Solutions link + footer SOLUTIONS column (anchors suite).
  The `.nb-hero-note` session explainer is unchanged.
- Header (home.ts + html.ts): new outlined `.nb-nav-book` beside the
  session button — desktop renders it ≥1200px only (headless-measured:
  the homepage nav row runs 983px intrinsic and the book button + gap
  add 204px → 1187px, so 1200 is the first clean round gate;
  901–1199px keeps the session ask only), and the hamburger menu
  carries the `.nb-menu-book` twin at ≤900px.
- Footer (both): the logo column gains the dark-scheme outlined
  `Read the Book →` button (warm-white hairline, gold-pale arrow). The
  homepage footer stays session-free (booking budget); the subpage
  footer pairs it with the COMPANY session text link. Column links
  unchanged, including RESOURCES `The Book` → #book.

**Guards:** anchors suite repointed (hero secondary → free-chapters/;
the hero outlined button must NOT re-grow a `#system` target;
Solutions/footer #system reachability unchanged); the retired ALL-CAPS
hero label joined the semantic suite's page ban list (the funnel H2
keeps Title Case "Three Core Components", so the exact-case ban is
safe); header structural parity now extracts + compares the desktop
and menu book secondaries across every committed page; header/footer
overflow suites pass unedited (the width gate keeps the guarded
851–900px and ≤520px ranges book-CTA-free in the desktop chrome).

**Lockstep:** home.ts hero comment layer + header/footer slots; html.ts
shared chrome; home.css + site.css (.nb-btn-outline family ported to
site.css, width-gated nav slot, menu variant in both hamburger blocks,
dark footer variant + touch-size bumps); docs/website-final-copy.md
(§0 map, §1 hero, §2 tail note, §4 anchor note, Footer section);
docs/WEBSITE.md nav + CTA-hierarchy lines;
docs/website-messaging-architecture.md §4 CTA table + book taxonomy
rows; committed site regenerated via `npx tsx website/generate.ts`;
governance test-portfolio baseline regenerated.
- Files: website/src/pages/home.ts, website/src/html.ts,
  website/public/assets/css/home.css,
  website/public/assets/css/site.css, website/public/* (regenerated),
  tests/website-engine-story-anchors.test.ts,
  tests/website-engine-story-semantic-content.test.ts,
  tests/website-header-structural-parity.test.ts,
  docs/website-final-copy.md, docs/WEBSITE.md,
  docs/website-messaging-architecture.md,
  docs/website-copy-changelog.md,
  audits/governance/test-portfolio-baseline.json.

## Revenue-session hero note reframed (2026-08-19, Task #5063)

The homepage `.nb-hero-note` now reads `A free working session to build
the plan for making your revenue goals a reality.` It is the concise live
use of the owner-verified revenue-goals plan fact (claim-ledger row #36
and CONTENT_TRUTH_SOURCE §17), without adding a duration, guaranteed
outcome, pricing recommendation, or handed-over artifact.

RETIRED: `A free working session to identify what is limiting signed
cases and what should be fixed first.` The previous hero note put the
session in a constraint-first/product-diagnosis frame; the page's
Marketing → Intake → Sales managed-system framing, CTAs, book funnel,
layout, and styling are unchanged.

**Lockstep:** `website/src/pages/home.ts`, the existing zero-DB
homepage semantic assertion, `docs/website-final-copy.md`, claim ledger,
truth source, and the generated `website/public/` bundle.

## Lead-tracking FAQ clarified (2026-08-19, Task #5078)

Homepage FAQ 5 now names WhatConverts as the platform NoBull uses for complete
lead tracking and lead scoring. It draws the operating boundary explicitly:
visibility into Intake and Sales outcomes depends on each firm's software and
how consistently it is used.

The answer promises to go as deep as the available data permits to report
outcomes and improve marketing campaigns, not universal downstream
attribution. Its existing revenue safeguard remains explicit: when the data
cannot support precision, NoBull identifies that limit and presents the best
honest estimate instead of guessing.

**Lockstep:** the homepage source, decided-copy record, claim ledger #42,
content truth source §20, and generated homepage bundle carry the same
approved wording. No reporting integration or FAQ layout changed.


## Homepage implementation timelines corrected (2026-08-20, Task #5079)

Homepage FAQ 4 now asks the full-window question, `How long does
implementation take?`, instead of implying that every component fits inside a
30-to-90-day window. Its answer publishes the owner-confirmed typical
milestones in product order: CaseGen™ fully launched within 21 days and
profitable within 60; CaseIntake™ launched within 90 days and in fine-tuning
within 180; CaseConvert™ launched within 30 days and seeing profitable ROI
within 90.

The answer explicitly says these are typical expectations, not guarantees.
Client implementation pace is identified as the number-one timing factor, and
NoBull commits to going as fast as the firm allows. The new authorization does
not publish the separate generic Day 0 / Days 3–5 / Day 14 onboarding path or
change the narrowly attributed Burns Smith client timeline.

RETIRED: `What happens during the first 30 to 90 days?` and `We don't publish a
universal week-by-week schedule, because firms start from different places —
your install is scoped in the session, component by component. The shape is
consistent, though: tracking goes in early, the systems are built around your
firm, and you watch the same numbers we do — leads, consultations, signed
cases — the whole way.`

**Lockstep:** the homepage source, decided-copy record, claim ledger #43,
content truth source §21, changelog, and generated homepage bundle carry the
same approved milestones and caveat. FAQ layout and all five adjacent answers
are unchanged.


## Footer service deep links (2026-08-19, Task #5084)

The sitewide footer column heading is now `OUR SERVICES`. Its overall
`The Revenue Engine™` link still opens the homepage product section at
`#system`; the three component links now open their own stages:
`CaseGen™ → #casegen` (Marketing), `CaseIntake™ → #caseintake`
(Intake), and `CaseConvert™ → #caseconvert` (Sales). The homepage
footer uses same-page fragments, while shared subpage footers retain
their generated relative prefix so nested routes resolve through the
homepage.

The three funnel stages now own those stable ids. Motion-enabled
fragment arrivals settle the requested stage into the existing funnel
reading zone and activate its existing focused treatment. Reduced
motion and JavaScript-disabled arrivals keep native fragment behavior
and the complete, fully lit served state.

**Unchanged:** header `Solutions → #system`; footer grid and styling;
product names and copy; all non-service footer destinations; session
CTA hierarchy.


## About page consolidated — complete team and practice areas (2026-08-19, Task #5085)

The About page is now the complete people-and-practice destination. Its team
section renders all 18 people in the owner-approved homepage order, with the
same photo, name, and role data sourced from one shared `TEAM_ROSTER`. The
existing Ronnie, Oliver, and Jake biographies remain available through native
keyboard-operable disclosures; no biography or personal claim was added for
the other 15 members. The homepage presentation and reveal behavior are
unchanged.

The former `Industries Served` band now owns the stable
`#practice-areas-served` destination and the exact heading
`Practice Areas Served`. Its introduction uses the decided
`Marketing, Intake, and Sales services` framing and visibly lists all 14
practice areas from the canonical `INDUSTRIES` source. The retired
`View All Industries Served` button and the About-page dependency on
`/services/` are gone; the First Lead Records evidence remains beneath the
complete list.

**Lockstep:** shared roster and practice sources, About/home templates,
responsive subpage CSS, truth/final-copy records, the existing DB-free
semantic suite, and the committed generated website bundle.


## Standalone services page retired (2026-08-19, Task #5087)

Owner decision: `/services/` no longer exists and does not redirect. The page
definition, generator registration, committed route output, sitemap row,
canonical/OG URL, and page-only CSS are removed. The marketing host and the
`/website-preview/` mount now both reach the existing branded static 404 for
that path, never the OS shell.

The former Revenue Engine hero, CaseGen subsystem rows, First Lead Records
strip, CaseIntake/CaseConvert cards, and their CTAs retired together. None of
that page-exclusive copy or presentation moved to About or the homepage.
Practice-area scope remains solely in About's complete
`#practice-areas-served` section; the homepage funnel and footer stage deep
links remain unchanged.

Proof exports were preserved where they still support live surfaces. About
keeps the complete First Lead Records strip; the homepage and booking page keep
their selected records; booking keeps the 8× result; and `/data-notes/` keeps
the sourced provenance rows for the 2×, 8×, lead-to-consult, and
consult-to-case figures. Claim-ledger rows #8–#12 now name those actual
surfaces.

**Guards:** the existing DB-free marketing-host routing suite pins the branded
404 at both URL mounts and the generated sitemap omission. The existing
generated-link/anchor suite rejects any internal services-route href without a
new suite or test-control-plane change.

## Homepage conversion hub reconciled (2026-08-20)

The later conversion-flow stages supersede the historical standalone
`/book-free-demo/` and `/contact/` page records above. The homepage now owns
the only Calendly widget at `#booking` and the only contact-kind inquiry form
at `#contact`. Both old paths remain compatibility-only permanent redirects
to those anchors; neither is generated, canonical, linked, or listed in the
sitemap. Historical entries remain unchanged as dated implementation history.

## 2026-08-25 — Owner-confirmed 20-person roster replacement

Owner confirmation expands the shared homepage/About roster from 18 to 20
people. Inno Mdletshe joins as `Paid Search` immediately before Devin
Petersen; Devin's role is now `Senior Paid Search`; and Kreston Nathras joins
as `Senior Paid Search` immediately after Devin. Every other member keeps
their prior relative order.

Six owner-supplied portrait assets were prepared for Priyanka Lakha, Cam
Duhart, Inno Mdletshe, Devin Petersen, Kreston Nathras, and Liri Abdullahu.
Five are wired into the merged roster (Priyanka, Cam, Inno, Devin, and
Kreston); Liri's prepared portrait remains unwired pending a separate
follow-up. Inno and Kreston receive no invented biography; the only approved
About biographies remain Ronnie, Oliver, and Jake. The homepage's first-two-row reveal remains
12 / 6 / 4 / 2 cards across its 6 / 3 / 2 / 1-column breakpoints; expanding
and the JavaScript-disabled fallback show all 20 people.

This owner-confirmed replacement chain supersedes Task #5239's unmergeable
all-in-one attempt. That blocked attempt is not retried or applied: the
replacement stages prepare the portrait assets, cut over the shared roster and
generated site, then reconcile the active documentation and integrated checks.
Earlier dated 18-person entries below remain unchanged as historical records.

**Lockstep:** `TEAM_ROSTER`, the homepage and About templates, square team
assets, active truth/final-copy/do-not-break documentation, the existing
focused static/browser suites, and the committed generated website bundle.

## 2026-08-27 — Homepage copy, FAQ, and roster refresh

The homepage removes the redundant session-explainer sentence, the
book/system caption, and the visible Million Dollar Gap setup paragraph. The
chart and payoff remain unchanged; their visually hidden summary now begins
`Hypothetical model:` so the comparison stays explicit for screen readers.

The standalone fit band is retired. Its complete fit and not-fit criteria now
form the seventh native FAQ disclosure, `Is Your Firm a Fit?`, after the six
existing questions. The heading now reads `Seven Questions, Answered
Straight.`

The shared homepage/About roster now places Cat immediately after Priyanka.
Its paid-search run is Juan, Santiago, Devin, Kreston, Kaylie, then Inno.
Juan, Santiago, Devin, and Kreston are `Senior Paid Search Expert`; Kaylie and
Inno are `Paid Search Expert`. Liri is `Intake Engineer`, and both pages use
her owner-supplied square portrait derivative,
`liri-abdullahu-2026.jpg`. This supersedes the 2026-08-25 note that Liri's
prepared portrait was not yet wired.
