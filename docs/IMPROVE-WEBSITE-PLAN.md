# Improve Website Plan

> Journey tracker for the `improve-website` skill (installed 2026-08-09 at
> `.agents/skills/improve-website/` from `wondelai/skills@HEAD`, SKILL.md +
> `references/artifact-templates.md`, frontmatter intact). Artifacts:
> [WEBSITE.md](WEBSITE.md) (findings F-nn) · [METRICS.md](METRICS.md) (funnel + lab baselines) ·
> [EXPERIMENTS.md](EXPERIMENTS.md) (backlog E-nn) · [DESIGN.md](DESIGN.md) (U-nn, Phases 2/3/4/8)
> · [POSITIONING.md](POSITIONING.md) (P-nn, Phases 5/7) — all five artifacts live as of
> 2026-08-09 (owning phases created the last two per rule 7).
>
> **Resume protocol (operating rule 1):** read this file + the three artifacts, summarize the
> journey state in 3–5 lines, and ask which phase to enter. This journey is resumed, never
> restarted. **Mode note (rule 4):** none of the eight constituent skills are installed — phases
> run from their built-in Briefs (fallback mode) unless D4 changes that.
> **2026-08-09 update:** the owner directed a full 8-phase run + PDF report in-session; Phases
> 2–8 were executed from the Briefs the same day (gate approvals + corrections in Key
> Decisions; report at `audits/website-audit-report-2026-08-09.pdf`). The journey remains
> resumable for implementation passes and post-cutover re-runs.

## Context

- **Site:** the NoBull Marketing static marketing site (`website/` generator → committed
  `website/public/` bundle, served by the app; production at the deployment host — the apex
  domain still serves the old WordPress site, finding F-02, re-verified 2026-08-09).
- **Started:** 2026-08-09 (Task #4123: skill install + intake + Phase 1 diagnosis). The skill's
  in-phase questions are recorded as **Open Decisions** below rather than answered — a task
  session must not decide them silently (a silently made decision is a defect, rule 5).
- **Prior evidence folded in:** Task #4119 content & copy report
  (`audits/website-content-copy-report-2026-08-08.md`) including its §1 reviewer briefing and §11
  drift appendix (both items re-verified live and carried as F-12); Task #4120 aligned all copy to
  the book's final editorial review (post-#4120 copy is what was audited); Task #4121 (REE
  calculator page, data-notes page, sitewide soft-CTA ladder) is **in-flight** — overlapping ideas
  are marked in-flight in EXPERIMENTS.md (E-08/E-09), not re-proposed.
- **Locked elements** (#4119 §1; findings may flag genuine problems, rewrites are never proposed):
  hero eyebrow `LAW FIRM GROWTH, ENGINEERED.` + H1 · all ™ names + three-line product ladder
  (CaseConvert™ line always "turns booked consultations into signed cases") · CTA
  hierarchy/labels · homepage narrative order · book title.
- **Constraint docs:** `docs/website-claim-ledger.md` (banned claims — e.g. guarantees, growth
  throttling; §5 withheld facts), `docs/website-final-copy.md` (decided copy),
  `docs/website-messaging-architecture.md` (positioning/voice).

### Intake (answered from repo evidence, first run 2026-08-09)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Page/flow + the ONE action | Whole marketing funnel, homepage first; ONE action everywhere = **Book a Strategy Call** (macro-conversion: completed Calendly booking on `/book-free-demo/`) | Funnel map in METRICS.md; #4119 §1 ("every page funnels to the booking page") |
| 2 | Conversion problem + evidence | Pre-launch hardening, not a measured leak: the redesign has **no analytics** (F-01) and isn't live at the apex yet (F-02) — there is no conversion data to have a problem in. Working mode: find and fix the leaks before/at cutover. | Bundle + layout greps; live apex check 2026-08-09 |
| 3 | Real visitor input | Yes, verbatim: 6 on-site reviews + 6 marquee quotes (#4119 §6.4, §3.7 — Boris "skeptical about everything", Thrift "at my level", Presti "click-and-easy", Grow "every dollar accounted for"…), book excerpt (§9). No surveys/recordings/tickets in repo. | O/CO table in WEBSITE.md cites each quote |
| 4 | Traffic/week | Unknown — no analytics; apex still WordPress. Assume low until measured → qualitative + heuristic evidence mode (D3). | F-01/F-02 |
| 5 | Most-heard complaint | Unknown — no support-channel corpus in repo. Ask the owner (Next Actions). | — |
| 6 | Existing positioning docs | No POSITIONING.md, but strong equivalents exist and Phase 5/7 must build on them: messaging architecture, claim ledger, final-copy spec (all in `docs/`). | files present |
| 7 | Real assets | Full: generator source, committed rendered bundle, #4119 transcript, decided-copy spec, 2026-08-09 lab renders/measurements (METRICS.md §Methodology). | — |

**Skip heuristics applied (skill Intake):** Phase 4 — body 14–15 px < 16 px and measures 88–149 ch
> 75 ch on key surfaces → **cannot skip, must run** (METRICS.md §Typography). Phase 6 — CWV not
"already green": no field data exists, and lab shows F-03/F-06/F-07 → **run** (subpages are
already lean — scope it to home + cutover follow-ups). Phase 5 — messaging freshly re-validated
(2026-08-08 #4120 alignment to the book's final editorial review + claim ledger + #4119) →
**candidate skip**, user confirms at entry (D-P5). Phase 7 — REE is a brand-new central
abstraction, stickiness untested → **run light**. Phases 2/3/8 — no prior heuristic/visual/error
audit corpus → run. Phase 1 is the GATE and is never skipped.

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 | cro-methodology | done — gate passed by owner directive 2026-08-09 (run-all instruction = sign-off; D1/D3 recommendations adopted as working assumptions, rows kept for override) | METRICS.md, WEBSITE.md, EXPERIMENTS.md | 2026-08-09 |
| 2 | ux-heuristics | done — executed from Brief (fallback): U-01…U-09 + Trunk Test in DESIGN.md | DESIGN.md, EXPERIMENTS.md (E-19/E-20/E-22) | 2026-08-09 |
| 3 | refactoring-ui | done — executed from Brief: grayscale hierarchy **passes**, tokens/components inventoried, imagery split U-07, no spacing tokens U-08 | DESIGN.md, EXPERIMENTS.md (E-21/E-23) | 2026-08-09 |
| 4 | web-typography | done — executed from Brief; fix spec in DESIGN.md §Typography. **Corrections: F-14 = double-sourced Crimson (not dead preconnects); kit maps 600→Regular (semibold-body verdict withdrawn)** | DESIGN.md, METRICS.md, EXPERIMENTS.md (E-04/E-18) | 2026-08-09 |
| 5 | storybrand-messaging | done — ran as a conformance audit (owner said run all; D-P5's skip rationale held): HIGH SB7 conformance, zero rewrites proposed; P-01/P-02/P-03 | POSITIONING.md, EXPERIMENTS.md (E-21) | 2026-08-09 |
| 6 | high-perf-browser | done — executed from Brief: F-18/F-19 added, F-14 corrected, METRICS extended; field pass still gated on cutover (E-06) | METRICS.md, WEBSITE.md, EXPERIMENTS.md | 2026-08-09 |
| 7 | made-to-stick | done — run light as planned: SUCCESs scorecard (6 flagship messages) in POSITIONING.md; REE concreteness rides #4121 | POSITIONING.md | 2026-08-09 |
| 8 | design-everyday-things | done — executed from Brief: forms state machine documented, 404 = pass (corrected), gaps U-02/U-03 + Calendly fallback signifier (E-13) | DESIGN.md, EXPERIMENTS.md (E-13/E-20) | 2026-08-09 |
Statuses: pending · in-progress · awaiting-evidence · done · deferred: <reason> · skipped: <reason>

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-09 | install | Vendored the skill from `wondelai/skills@HEAD` into `.agents/skills/improve-website/` (SKILL.md + references/artifact-templates.md — the repo's complete skill dir); frontmatter verified | Loads in future agent sessions alongside existing workspace skills |
| 2026-08-09 | all | Fallback-Brief mode: constituent skills not installed (rule 4); install offer recorded as D4 | Task scope excluded installing the eight skills |
| 2026-08-09 | 1 | Evidence mode: qualitative + heuristic (no analytics, no field data) — pending user confirmation D3 | F-01/F-02; intake Q2/Q4 |
| 2026-08-09 | 1 | Lab methodology + caveats recorded in METRICS.md §Methodology (localhost = optimistic floor; scroll-sum CLS ≠ windowed CWV) | Measurement honesty — findings must not overclaim |
| 2026-08-09 | 1 | Created METRICS/WEBSITE/EXPERIMENTS from the skill skeletons; DESIGN/POSITIONING left to their owning phases | Rule 7 (create only when the phase names it) |
| 2026-08-09 | 1 | #4121 overlaps (REE calculator, soft-CTA ladder) marked in-flight in the backlog, not re-proposed; locked elements flag-only | Task boundaries; #4119 §1 locked list |
| 2026-08-09 | 1 | Pre-existing owner flags inherited as gates, not re-decided (D11) | They were opened by the copy tasks and belong to the owner |
| 2026-08-09 | all | Owner directed the full 8-phase run + a comprehensive PDF report (in-session instruction); Phases 2–8 executed from fallback Briefs; owner-only questions stayed as Open Decisions | The run-all instruction supplies the gate approvals rule 6 requires; nothing silently decided beyond adopting the D1/D3 recommendations as working assumptions |
| 2026-08-09 | 4/6/8 | **Corrections over Phase 1 output:** F-14 rewritten (runtime font-host capture shows Google css2 AND Typekit both serving — the "dead preconnects" claim was wrong) · "semibold body" withdrawn (kit weight map: 600 = Regular) · "404 routes home" corrected (dedicated page, correct status, rated pass) | Every claim re-verified against runtime evidence before the report shipped |
| 2026-08-09 | report | Comprehensive report committed at `audits/website-audit-report-2026-08-09.pdf` (+ `.html` source beside it) | Committed because untracked reports die with the task environment (project policy) |

## Open Decisions (require the user — none decided silently)

| ID | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Confirm the ONE action per page as mapped (METRICS.md §Funnel) and the competing-CTA verdicts: keep locked hierarchy everywhere incl. free-chapters' tertiary Amazon/Audible exits? | (a) confirm as mapped · (b) adjust specific pages | (a) — **adopted as working assumption 2026-08-09 (run-all directive); override anytime** |
| D2 | First attack after sign-off: blocked artery or missing link? | (a) measurement missing link (E-01) · (b) mobile weight (E-03) · (c) price asset (E-14) | (a) — every later decision is blind until the site can be measured; (b) ships alongside cheaply |
| D3 | Accept qualitative + heuristic evidence until analytics + apex cutover provide field data? | yes / no (wait for data first) | yes — **adopted as working assumption 2026-08-09 (run-all directive); override anytime** |
| D4 | Install the eight constituent skills (`npx skills add wondelai/skills/<slug> --global`) or continue fallback Briefs? | install all · install some (5/7 deepest) · fallback | fallback for 2/3/4/6/8; revisit for 5/7 if those phases run |
| D5 | Analytics tool + consent posture (E-01/F-01) | Plausible/Fathom-class cookieless (no banner) · GA4 (consent banner) · server-side | cookieless privacy-first — zero UX/CLS cost, adequate for CTA/booking funnel |
| D6 | Price-objection asset (E-14/F-05): publish investment framing? | FAQ answer w/ honest range · investment page · leave to the call (status quo) | at minimum an FAQ investment answer in non-guarantee language; owner supplies numbers |
| D7 | Publish a phone/direct contact channel (E-11/F-09)? | yes (footer + booking page) · no (form-only stays) | owner call — it's an intake-capacity question, not copy |
| D8 | Optional post-read email capture on /free-chapters/ (E-12/F-04)? | keep pure no-email stance · optional capture after the reader (promise kept verbatim) | optional post-read capture — preserves the promise, creates the only retention hook |
| D9 | "AS SEEN ON" label wording (E-10/F-13) | keep · "SPEAKING & PRESS" · "FEATURED AT & ON" · split associations/podcasts rows | change to an accuracy-safe label; owner picks wording |
| D10 | Drift reconciliation direction (E-05/F-12) | (a) regenerate to spec: drop trust-line "— and counting"; fix final-copy meta text to the rendered ≤160-char trim + update its Presti body · (b) update spec to match rendered everywhere | (a) — the spec tail-drop was the decided review outcome; the meta trim is correct as rendered, the doc should record it |
| D11 | Inherited owner flags (gates on E-13/E-14; **pre-existing**, from the copy tasks/ledger §5 — listed so the journey sees them, not re-opened): hero-eyebrow revenue rewording · "High Impact Revenue Session" vs "Book a Strategy Call" naming · book subtitle · $1.5M revenue-basis label · $150M+ aggregate confirmation · withheld call duration/deliverables | resolve any / leave withheld | leave withheld until the owner rules; experiments touching them stay gated |
| D-P5 | At Phase 5 entry: skip (messaging just re-validated) or run? | skip: reason recorded · run | **resolved 2026-08-09: ran as a conformance audit (owner run-all); HIGH conformance, zero rewrites (POSITIONING.md)** |

## Next Actions

- [ ] Owner: read the report (`audits/website-audit-report-2026-08-09.pdf`); rule on D2 — the report recommends the opening batch E-01 + E-18 + E-02 (measurement first, then the two cheapest perf wins)
- [ ] Owner: rule on D5 (analytics tool) so E-01 can be scheduled; answer intake Q5 (most-heard complaint)
- [ ] Owner: rule on D6–D11 when ready (price asset · phone · email capture · AS-SEEN-ON label · drift direction · inherited flags)
- [ ] Owner: license the Adobe Stock source clip and regenerate both 144-frame sets (F-17) — watermarked previews must not ship at cutover
- [ ] Track #4121 (REE calculator / data-notes / soft-CTA ladder) → when merged, re-check E-08/E-09/F-04/F-05 and P-01 (any session)
- [ ] After apex cutover (F-02): E-06 field CWV + windowed CLS, verify Calendly initializes live (F-15), verify cache headers (F-19) (any session)
- [ ] Implementation sessions: work the re-sorted backlog top-down (EXPERIMENTS.md), one reversible change per experiment, qualitative before/after until E-01 makes real experiment cards possible
