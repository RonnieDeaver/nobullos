# Experiments

> improve-website journey artifact — created 2026-08-09 from the skill skeleton
> (`.agents/skills/improve-website/references/artifact-templates.md`) during the Phase 1 (CRO)
> diagnosis, Task #4123. Tracker: [IMPROVE-WEBSITE-PLAN.md](IMPROVE-WEBSITE-PLAN.md) · Findings
> (F-nn): [WEBSITE.md](WEBSITE.md) · Baselines: [METRICS.md](METRICS.md).

## Experiment Cards

None yet — cards require a pre-committed primary metric, and nothing is measurable until
analytics exist (F-01) and the apex serves the redesign (F-02). Promotion rule (skill "Completing
the Journey"): once measurement is live, re-run the CRO method on the high-ICE backlog rows —
size the sample up front, run one full business cycle, require 95% confidence, never peek early —
then promote rows from the backlog into cards here.

Until then, backlog rows ship (if at all) as reversible changes with a qualitative before/after
record, explicitly labeled unmeasured.

## Experiment Backlog

ICE = impact / confidence / ease, each 1–10; score = mean, ranked. Status: proposed ·
owner-gated (D# → tracker Open Decisions) · in-flight (#4121 — REE calculator page, data-notes
page, sitewide soft-CTA ladder; `docs/website-copy-changelog.md` #4120 entry names them a
separate follow-on task; **not re-proposed here**) · deferred.

| ID | Idea | ICE (I/C/E) | Score | Status |
|---|---|---|---|---|
| E-01 | Wire privacy-friendly analytics + Calendly booking events (funnel visibility; F-01) | 9/9/8 | 8.7 | owner-gated (D5 tool choice); top priority |
| E-02 | Convert desktop hero + book-cover PNGs (3.5 MB preloaded) to WebP/AVIF (F-06) | 7/9/8 | 8.0 | shipped 2026-08-09 (Task #4127 — 3.5 MB → 405 KB WebP, visually lossless) |
| E-18 | Drop the duplicate Crimson Pro foundry: audit cuts used per surface, confirm Typekit kit coverage, remove the Google css2 line (−97 KB fonts, −1 render-blocking origin) (F-14, F-18) | 5/9/9 | 7.7 | proposed — cheapest real perf win |
| E-03 | Defer cinematic frame fetch until `#system` approach — cuts mobile @load ~7 MB → ~0.8 MB (F-03; loading strategy only, cinematic locked) | 7/8/6 | 7.0 | shipped 2026-08-09 (Task #4126) — lab @load 6.96 MB/168 req → 0.72 MB/25 req, load 34.9 s → 4.3 s (METRICS.md) |
| E-04 | Raise body text to ≥16 px (18 px reader), cap measures at 45–75 ch, trim font payload <200 KB (F-10; fix spec in DESIGN.md §Typography) | 6/8/7 | 7.0 | proposed — Phase 4 owns |
| E-05 | Reconcile decided-copy drift: trust-line tail, home meta trim, final-copy Presti lag (F-12) | 3/9/9 | 7.0 | owner-gated (D10 direction) |
| E-06 | Field CWV + windowed CLS via PSI/CrUX after apex cutover; verify deployment cache headers (F-07, F-16, F-19) | 5/8/8 | 7.0 | deferred until F-02 closes |
| E-19 | Fix `/services/` active-nav state + expose `aria-current="page"` sitewide (U-01) | 3/9/9 | 7.0 | proposed |
| E-07 | Bump sub-10 px text (8.64 px gauge stamps, 9 px chart labels) to ≥11–12 px (F-11) | 4/8/8 | 6.7 | proposed |
| E-08 | REE calculator page (interactive leak/score diagnosis; strengthens Price counter F-05) | 8/7/5 | 6.7 | **in-flight (#4121)** |
| E-09 | Sitewide soft-CTA ladder (intermediate commitment between "read" and "book"; F-04) | 7/7/6 | 6.7 | **in-flight (#4121)** |
| E-20 | Visible form labels (placeholder → example text only) + client email-shape check in the shared handler (U-02, U-03) | 4/8/8 | 6.7 | proposed |
| E-10 | Accuracy-safe wording for the "AS SEEN ON" strip label (F-13) | 4/6/9 | 6.3 | owner-gated (D9) |
| E-11 | Publish phone/direct contact channel (F-09) | 5/6/8 | 6.3 | owner-gated (D7) |
| E-12 | Optional post-read email capture on /free-chapters/ + minimal nurture, preserving the "no email required" promise verbatim (F-04) | 7/6/5 | 6.0 | owner-gated (D8) |
| E-13 | Booking-page reassurance within allowed facts + visible Calendly fallback path (F-15; claim ledger §5 constrains — withheld facts stay withheld) | 5/6/7 | 6.0 | proposed |
| E-21 | About-page founder/team block: photo + name + 1-line credentials beside the trust quote (P-02, U-07) | 6/6/6 | 6.0 | proposed — owner supplies photo/bio |
| E-14 | Price-objection asset: honest investment framing (FAQ answer or block; no guarantees — ledger bans them) (F-05) | 8/5/4 | 5.7 | owner-gated (D6) |
| E-15 | FAQ depth: 2–3 ledger-safe additions (timeline-to-first-lead via First Lead Records facts; who does the work) | 5/6/6 | 5.7 | proposed |
| E-22 | Restore real publish dates on the resource library (every item stamped "Jan 4, 2024" today) or drop the date element (U-05) | 3/6/8 | 5.7 | proposed |
| E-16 | Per-case-study pages fulfilling the "VIEW CASE STUDY →" promise (F-08) | 5/6/5 | 5.3 | proposed |
| E-23 | Distinctive-imagery pass on subpage/article stock (gavel/scales clichés vs home's art direction) (U-07) | 4/5/6 | 5.0 | proposed — needs owner assets |
| E-17 | A/B testing capability | 6/4/3 | 4.3 | deferred — needs E-01 + traffic ≥ significance threshold (intake Q4 unknown); infra explicitly out of Task #4123 scope |

Ranking notes: E-05's high score is ease-driven (impact 3) — treat as a quick win, not a
priority peer of E-01–E-03. E-08/E-09 rank on their own merits but are owned by #4121; this
journey only consumes their results. Phases 2–8 (2026-08-09) added E-18–E-23 and the table was
re-sorted by score; recommended opening batch = E-01 + E-18 + E-02 (measurement first, then the
two cheapest real perf wins).
