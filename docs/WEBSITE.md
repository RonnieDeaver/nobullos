# Website

> improve-website journey artifact — created 2026-08-09 from the skill skeleton
> (`.agents/skills/improve-website/references/artifact-templates.md`) during the Phase 1 (CRO)
> diagnosis, Task #4123. Tracker: [IMPROVE-WEBSITE-PLAN.md](IMPROVE-WEBSITE-PLAN.md) ·
> Metrics/baselines: [METRICS.md](METRICS.md) · Backlog: [EXPERIMENTS.md](EXPERIMENTS.md).
> Primary evidence: the Task #4119 content & copy report
> (`audits/website-content-copy-report-2026-08-08.md`, cited below as "#4119 §n"), the rendered
> bundle `website/public/`, and the 2026-08-09 lab measurements (methodology in METRICS.md).
> **Locked elements** (#4119 §1 reviewer briefing): hero eyebrow `LAW FIRM GROWTH, ENGINEERED.` +
> H1; all ™ names + the three-line product ladder (CaseConvert™ line always "turns booked
> consultations into signed cases"); CTA hierarchy/labels; homepage narrative order; the book
> title. Findings may flag genuine problems with locked elements; no rewrites are proposed for them.

## Sitemap

- `/` — homepage (hook → problem → Revenue Engine funnel → proof → team → fit/FAQ → book → closing ask)
- `/#proof` — Results destination: complete inline case studies + testimonial videos/reviews (not a standalone route)
- `/about/` — company story, FAQ, complete 20-person team, and the complete 14-item `#practice-areas-served` section
- `/resources/` — Library index; `/resource/<slug>/` × 15 canonical articles/videos/webinars/podcasts
- `/free-chapters/` — book excerpt reader (Introduction + Chapters 1–2, no email required)
- `/#booking` — canonical High Impact Revenue Session scheduler
- `/#contact` — canonical message/contact form
- `/calculator/` — Revenue Engine Efficiency calculator
- `/data-notes/` — versioned definitions and provenance notes
- `/privacy-policy/` · `/unsubscribe/` · 404 (dedicated page, correct 404 status — corrected 2026-08-09, see Page Briefs)

`/services/` is retired: it is not generated, listed in sitemap data, redirected, or linked. It returns the
branded 404 on both the marketing host and `/website-preview/services/`. Product explanation remains on
the homepage funnel and its `#system`, `#casegen`, `#caseintake`, and `#caseconvert` destinations.

`/book-free-demo/` and `/contact/` are compatibility-only URLs: each permanently redirects to the
matching homepage destination (`/#booking` or `/#contact`), preserving safe query parameters before
the fragment. Neither path is generated, canonical, or listed in the sitemap.

Cutover compatibility is separate from the canonical sitemap: `/resource/episode-13/` is a legacy
WordPress alias that must return one 301 to the existing Brita Long Episode 13 canonical route. It is
not a 16th resource and must not be generated or added to sitemap data.

Nav: PRACTICE AREAS SERVED → `/about/#practice-areas-served` from every page depth · RESULTS →
homepage `#proof` · ABOUT · RESOURCES · filled button `Book a High Impact Revenue Session` (#4124)
· outlined secondary `Read the Book` → `/free-chapters/` (Task #5017; desktop shows it ≥1200px, the
hamburger menu carries it below that).

## Page Briefs

### / (home)
- Purpose & primary conversion action: sell the Revenue Engine story end-to-end; **Book a High Impact Revenue Session** (hero + closing ask → `#booking`).
- Message (decided copy: `docs/website-final-copy.md`): more leads aren't enough — the engine turns the same leads into more revenue. REE remains on `/calculator/`, not the homepage.
- CTA (direct + transitional): `Book a High Impact Revenue Session →` (direct; the #4124/#4261 sitewide session ask — was `BOOK A STRATEGY CALL →`); secondary `Read the Book →` → `/free-chapters/` on hero + header + footer (book-funnel entry since Task #5017 — was `SEE THE THREE CORE COMPONENTS →` → `#system`, itself relabeled Task #4923 from `SEE THE SYSTEM →`; `#system` stays reachable from homepage sections and the footer OUR SERVICES Revenue Engine link) and the book band → `/free-chapters/` (transitional). Hierarchy locked.
- Copy blocks: see `docs/website-final-copy.md` §§1–14 (canonical spec) and #4119 §3 (rendered transcript).

### /about/
- Purpose: persuasion depth about who NoBull is; the page owns the complete team and the sitewide
  practice-area destination. It does not depend on a standalone services page.
- Team/practice contract: all 20 canonical team members and all 14 canonical practice areas render in
  full from the shared homepage/About sources. Team order, photos, names, and roles come only from
  `TEAM_ROSTER`; only Ronnie, Oliver, and Jake have approved biographies. The homepage preserves its
  first-two-row reveal (12 / 6 / 4 / 2 cards at the 6 / 3 / 2 / 1-column breakpoints), while About
  renders all 20. The practice-area heading is `Practice Areas Served`, its stable id is
  `#practice-areas-served`, and its introduction begins `Our Marketing, Intake, and Sales services…`.
- CTA: the shared "The Next Step" booking band links back to homepage `#booking`; subpages never embed the scheduler.

### /services/ — retired
- No current page brief. The route has no generated page, sitemap entry, internal link, canonical, or
  redirect and intentionally resolves to the branded 404.
- The homepage Revenue Engine funnel and footer deep links own the product explanation; About owns
  practice-area scope.

### /resources/ + /resource/<slug>/
- Purpose: awareness/authority ("the thinking behind the Revenue Engine"); ONE action: enter an article → sidebar **Book a High Impact Revenue Session** to homepage `#booking` (soft; low intent surface).

### /free-chapters/
- Purpose: transitional asset — read the method, then book; ONE action: **Book a High Impact Revenue Session** to homepage `#booking` (endcap + floating bar). Amazon and Audible remain non-interactive `Coming Soon!` notices until client-confirmed current-edition destinations exist.
- Promise: "no email required" is stated copy — any capture experiment must preserve it (see D8 in the tracker).

### Homepage conversion hub (`/#booking` + `/#contact`)
- Purpose: **the macro-conversion**: open the canonical Calendly booking action from the one homepage handoff, or send a protected inquiry through the one canonical contact form. The homepage does not embed a third-party scheduler.

### /privacy-policy/ · /unsubscribe/ · 404
- Utility; no conversion action. 404 is a dedicated page served with a real 404 status, clear
  no-blame copy, a single "BACK TO HOMEPAGE" CTA, and full nav/footer (verified 2026-08-09,
  screenshot + probe — supersedes the earlier "routes home" note; Phase 8 rates it a pass,
  DESIGN.md §Interaction).

## Conversion Elements

Objection/counter table for the Big 5, in real customer language. Sources: on-site reviews
(#4119 §6.4, §3.7), FAQ answers (§3.11/§4.2), book excerpt framing (§9), decided copy
(`docs/website-final-copy.md`).

| Objection (Big 5) | Customer language (evidence) | Counter | Placement | Status |
|---|---|---|---|---|
| Trust — "agencies overpromise" | "I'm skeptical about everything… I would not be on here unless you guys did what you promised." — Tom Boris (#4119 §6.4); "candor" (Chapa), "skill and integrity" (Twersky) (#4119 §3.7) | Inline case studies; video testimonials + reviews; the published book + free excerpt; First Lead Records; press strip | Sitewide; densest on homepage `#proof` + testimonials band | Strong. Label nuance on press strip → F-13 |
| Price — "what does it cost / is it worth it" | "Every dollar we spend is accounted for, and the return has far exceeded our expectations." — Stacy Grow (#4119 §6.4) | ROI reframe only: REE strip ("Revenue is the goal, REE is the score"), gap-band leak math, FAQ 2 revenue-measured answer, closing lede "You're already paying for a Revenue Engine. The question is how much money it's leaking." | Home §REE/§gap/§closing; FAQ | **Gap: no cost anchor anywhere on site** → F-05, E-14 (owner-gated D6); REE calculator in-flight (#4121, E-08) |
| Fit — "will this work for my firm/me" | "I know nothing about marketing or computers and [they were] able to work with me at my level." — Tessa Thrift (#4119 §6.4) | "Built For B2C Law Firms" + complete practice-area list; fit / not-a-fit verdict cards; First Lead Records across four practice areas | Home fit band; /about/#practice-areas-served; homepage `#booking` | Strong; ask-first closing frames it honestly |
| Timing — "later, not now" | "If you are considering… do it." — Edmonds (#4119 §3.7); "We've added a new receptionist because the calls have uptick tremendously…" — Zachary H. Smith (#4119 §6.4) | Cost-of-waiting leak math (gap band); Day-17 launch / Day-19 first consult timeline; First Lead Records +1/+2/+3 days | Home gap band + Burns Smith proof; homepage `#booking` | Good. No fake urgency by design (voice rules) — keep |
| Effort — "I don't have time to run this" | "It's very click-and-easy now… I've never seen this kind of lead flow before." — Michael Presti; "once you get everything set up, it's turnkey, it's automated" — Tom Boris (#4119 §6.4) | Homepage responsibility FAQ; proof remains narrowly attributed to its owning client/result surfaces | Homepage FAQ; homepage `#booking`; homepage proof | Good. Onboarding-effort expectations deliberately withheld (claim ledger row 23) — owner-gated, not re-proposed |

### Missing persuasion assets (Phase 1 gap list)

- Price/investment anchor — nothing on site answers "what does it cost" (F-05; owner-gated D6; guarantees are BANNED by claim ledger #28–30 and are **not** proposed).
- Mid-funnel capture/nurture — no email capture exists anywhere; `/unsubscribe/` with no subscribe (F-04; D8; soft-CTA ladder in-flight #4121).
- Per-case-study pages remain intentionally absent; every verified proof detail renders inline and the misleading `VIEW CASE STUDY →` controls are retired (F-08 resolved).
- Phone / direct contact channel — form-only contact (F-09; owner-gated D7).
- Deeper FAQ — 3 questions on home/about; ledger-safe additions possible (timeline-to-first-lead via First Lead Records facts; who-does-the-work) (E-15).
- "What happens after you book" — most session facts beyond the five-point promise are withheld per claim ledger §5 (duration, call behavior, deliverables) — inherited owner flags (D11), not re-proposed.

## Audit Findings

Severity 0–4 (4 = conversion catastrophe). Lab numbers: [METRICS.md](METRICS.md) (2026-08-09,
localhost — treat as optimistic floor). Status values: open · owner-gated (D#) · in-flight (#4121)
· lab-note.

| # | Issue | Severity (0-4) | Fix | Status |
|---|---|---|---|---|
| F-01 | **No analytics/measurement of any kind** — zero trackers in the layout (`website/src/html.ts`) and rendered bundle (grep: only prose matches); runtime request log shows no beacon hosts (Typekit + Calendly only). Funnel, drop-off, and every CWV field metric are invisible; A/B testing impossible. | 4 | Wire privacy-friendly analytics + Calendly booking events (E-01, decision D5) | open |
| F-02 | **Apex domain still serves the old WordPress site** — live check 2026-08-09: `nobullmarketing.com` → 144.202.65.61, nginx, `wp-content` × 173, title "Homepage - NoBull Marketing". The audited redesign is not what visitors see; every fix below is moot at the apex until cutover. | 4 | DNS cutover to the deployed redesign (deployment-owned, outside this repo's code) | owner-gated |
| F-03 | Mobile home shipped ~7.0 MB / 168 requests **before the load event** (throttled lab: load 34.9 s) — the 144 cinematic frames (6.2 MB mobile set) loaded eagerly even if the visitor never reached `#system`. LCP itself was green (1.96 s). | 3 | Defer frame fetch until `#system` approach (loading strategy only — the cinematic is a locked flagship experience) (E-03) | **fixed 2026-08-09 (Task #4126)** — IntersectionObserver arming; re-measured 0.72 MB / 25 req @load, load 4.3 s (METRICS.md). **Superseded 2026-08-11 (Task #4301, BRIEF v2 defects D1/D2):** arming is now a fixed 1,600 px window, pinned presentation ONLY — ≤767 px sequence visitors fetch six lazy posters instead of a frame set, and static/reduced-motion visitors make zero frame requests (verification: audits/revenue-engine-rebuild-verification-2026-08.md) |
| F-04 | No mid-funnel capture: visitors not ready to book leave with nothing — no email list, no lead magnet delivery, no retargeting pixel (F-01). Free excerpt is deliberately un-gated ("no email required" is stated copy). | 3 | Optional post-read capture preserving the no-email promise (E-12, D8); sitewide soft-CTA ladder | partially in-flight (#4121 CTA ladder) |
| F-05 | Price objection has no on-site counter — no cost anchor, range, or investment framing; FAQ silent on price (see Conversion Elements). | 3 | Price-objection asset (E-14, owner-gated D6); REE calculator strengthens the reframe | owner-gated (D6) / related in-flight (#4121) |
| F-17 | Cinematic frame sequences are **watermarked Adobe Stock previews** — all 288 committed frames (144 desktop, 18 MB + 144 mobile, 6.2 MB) carry the baked watermark on the flagship engine section (asset inspection; known from the cinematic build). Visible watermarks on the proof-heavy homepage damage trust and expose unlicensed-asset risk; code cropping is not a fix. | 3 | Owner licenses the source clip; regenerate both frame sets from the licensed render | owner-gated |
| F-06 | Desktop hero preloads 3.5 MB of PNG: `machinery-hero.png` 1.9 MB (the LCP element, `.nb-machinery-img`) + book cover 1.6 MB. Mobile already ships WebP (144 KB) — desktop formats are the gap. | 2 | Convert to WebP/AVIF ≈ 80% smaller (E-02) | **fixed 2026-08-09 (Task #4127)** — desktop now preloads visually lossless WebP re-encodes (hero 279 KB + cover 126 KB, ~88% smaller; PSNR ≈ 40–42 dB); PNGs remain only as derivation sources + the cover's non-WebP fallback. METRICS.md §Static weight facts updated |
| F-07 | Home main-thread cost: lab TBT 3.7 s desktop / 2.1 s mobile (4× CPU), 22 long tasks — frame decode + scroll choreography. Field INP unknown (F-01/F-02). | 2 | Phase 6 scope; re-measure in field after cutover (E-06) | open |
| F-08 | Historical: "VIEW CASE STUDY →" cards promised depth but landed on a shared standalone page. | 2 | Retired the controls, moved every verified proof detail inline, and made Results target homepage `#proof`. | fixed |
| F-09 | No phone number or direct contact channel site-wide — footer and contact are form-only (#4119 §2, §8.5). Law-firm buyers are phone-native (the site itself sells call-answering discipline). | 2 | Publish phone/direct contact if the owner wants inbound calls (E-11, D7) | owner-gated (D7) |
| F-10 | Reading surfaces below readability floor: body paragraphs 14–15 px and the free-chapters reader ~15 px at ~92 ch/line (skill floor: ≥16 px, 45–75 ch). The former services-page intro measured ~149 ch/line, but that clause is historical and superseded by the route's retirement. Measured values in METRICS.md §Typography. (Weight is NOT part of this finding — the kit maps 600→Regular; the earlier "semibold body" reading is withdrawn, see METRICS key.) | 2 | Phase 4 fix spec in DESIGN.md §Typography (E-04) | open on remaining live reading surfaces; services clause superseded |
| F-11 | Historical sub-10 px text: the home gauge stamps and standalone Results chart labels were both removed with their retired presentations. | 1 | No remaining surface. | fixed |
| F-12 | Decided-copy drift (successor to #4119 §11, re-verified 2026-08-09): (a) rendered hero trust line keeps "— and counting" tail the spec dropped (`<small>350+ law firms grown — and counting</small>` vs final-copy §1); (b) rendered home meta is a ≤160-char trim of the 219-char spec sentence (final-copy L12); (c) `docs/website-final-copy.md` Presti body still reads "and counting" while the rendered pages say "in twelve months" (doc lags #4120). #4119 §11's two items remain live in these forms. | 1 | Reconcile per D10 (E-05) | open (direction = D10) |
| F-13 | "AS SEEN ON" strip labels associations/podcasts (ABA — a speaking venue per the bio; Profit with Law, Law Firm Growth, Wealthy Woman Lawyer — podcasts/communities) as if media coverage. Proof-discipline nuance on a trust element; contents are real, the label overclaims slightly. | 1 | Accuracy-safe label wording (E-10, owner-gated D9) | owner-gated (D9) |
| F-14 | **Crimson Pro is double-sourced** (corrected 2026-08-09 — the Phase-1 "dead preconnects" claim was wrong): the head loads BOTH the Google css2 stylesheet AND the Typekit kit, and runtime font-host capture shows both foundries serving — Typekit 5 files (~234 KB, Sweet Sans + Crimson cuts) + fonts.gstatic 2 files (~97 KB duplicate Crimson). Total 332 KB / 7 files (> 200 KB budget) behind two render-blocking cross-origin stylesheets. | 1 | One foundry owns Crimson: audit cuts used, confirm kit coverage, drop the css2 line (E-18); then Phase 4 subsetting (E-04) | open |
| F-15 | **Resolved:** the former embedded Calendly widget was a preview-host single point of failure. The homepage now uses one explicit `View Available Times →` external action to the canonical scheduler, with the protected contact form beside it for non-booking inquiries. | — | Preserve the external handoff; do not restore the embed, its script, or recovery copy without a new owner decision. | resolved |
| F-16 | CLS at load is green everywhere (0.000–0.06; home 0.009 — stamped image dims work). The 1.63 "shift sum" on home is a full-scroll lab sum across the pinned cinematic, **not** windowed CWV CLS; field/windowed measurement pending. | 0 | Field CWV once live (E-06) | open |

**Phase 6 additions (2026-08-09):**

| # | Issue | Severity (0-4) | Fix | Status |
|---|---|---|---|---|
| F-18 | Render-blocking head chain on every standard page: page CSS (home.css 86.5 KB on `/`, site.css 39 KB on subpages) + TWO cross-origin font stylesheets (Google css2 + Typekit kit, F-14) + the p.typekit.net beacon; no preload/critical-CSS strategy. Localhost hides the cost (lab FCP 98–597 ms); real-RTT impact lands post-cutover. | 1 | After E-18 consolidation, preload the single remaining font CSS; inline-critical only if field FCP misses | open |
| F-19 | Caching posture is deployment-owned and unverifiable from this repo: CSS/JS ship content-hash busters (`?v=654f6b90…`) so long-cache headers are safe — whether the deployed host actually sets them is unknown (dev server ≠ prod). | 1 | Verify response headers on the deployed host at cutover (fold into E-06 field pass) | deferred until cutover |

UX findings from Phases 2/3/8 are numbered **U-nn** in [DESIGN.md](DESIGN.md); messaging
findings **P-nn** in [POSITIONING.md](POSITIONING.md).

### What already works (keep; do not "fix")

Proof discipline (per-firm stamps, timeframe/basis labels, estimate-honest REE language) ·
no-JS/reduced-motion static parity · CLS-safe image dims · homepage booking hub lean + fast (227 KB, lab
LCP 98 ms, five-point promise live) · semantic heading structure + meta/OG hygiene · ask-first
closing with honest not-a-fit cards · no fake scarcity anywhere · dedicated 404 with correct
status + recovery CTA · hardened shared form handler (honeypot, in-flight disabled state,
verbatim server errors, `role="status"` live region) · zero `_blank`-without-`noopener` links ·
in-CSS documented WCAG-safe gold token (`--gold-ink`).

### #4119 items already fixed by #4120 (folded, not re-raised)

- Booking page's three vague topic steps → the book's five-point session promise (ledger #37) — live in bundle.
- Presti "292 signed cases and counting" → "in twelve months" in the homepage proof (timeframe-labeled) — live in bundle; final-copy doc lag captured in F-12(c).

## Lead Capture

Current state: **none** — no email capture surface exists (only `/unsubscribe/`); the contact and
unsubscribe forms are the site's only inputs. Free excerpt is deliberately un-gated. Candidates
(all gated): optional post-read capture on `/free-chapters/` (D8, E-12); nurture sequence after
capture exists; scorecard/quiz funnel — **deferred** until the REE calculator (#4121) lands, since
it occupies the same "diagnose yourself" slot.
