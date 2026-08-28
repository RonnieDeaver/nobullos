# Design

> improve-website journey artifact — created 2026-08-09 by Phases 2/3/4/8 (executed from the
> skill's built-in Briefs at owner directive, same date; see tracker Key Decisions). Tracker:
> [IMPROVE-WEBSITE-PLAN.md](IMPROVE-WEBSITE-PLAN.md) · Findings F-nn: [WEBSITE.md](WEBSITE.md) ·
> Baselines: [METRICS.md](METRICS.md) · Backlog E-nn: [EXPERIMENTS.md](EXPERIMENTS.md).
> Evidence: rendered-page screenshots + DOM probes 2026-08-09
> (`.local/scratch/t4123/evidence2.mjs`, `probes2.json`, `p2-*.png` incl. grayscale conversions —
> scratch, not committed; key facts restated inline), `website/public/assets/css/site.css`
> tokens block, `website/src/client-shared/inquiry.ts` (form behavior source).
> UX findings are numbered **U-nn** here; they cross-reference F-nn/E-nn.

## Design Tokens

Current system (from `site.css` `:root`, redesigned 2026-08 to the approved editorial system):

| Group | Tokens (actual values) | Notes |
|---|---|---|
| Surfaces | `--cream #EEE8DC` · `--cream-deep #E7DFCE` · `--paper/--warm #FAF8F4` | warm eggshell bands; dark bands use near-black ink |
| Ink/text | `--ink #100D0B` · `--text #524B3A` · `--text-soft #6C6552` | earth-toned body ink |
| Brand | `--crimson #8A292F` (+ `--crimson-dark #722228`) · `--navy #485696` · `--gold #D5AC5C` | crimson = CTA/primary |
| A11y gold | `--gold-ink #7D5C1B` | **strength**: documented in-CSS as the WCAG-AA text-safe gold (4.6–6.1:1 across light surfaces); bright `--gold` reserved for dark bands + decoration |
| Type | `--serif` Crimson Pro/Baskerville/Georgia · `--sans` 'sweet-sans-pro'/Arial | two families — see Typography |
| Radius/shape | none — square `nb-*` cards and buttons by design | consistent across pages |
| Spacing | **no spacing tokens exist** — margins/paddings are per-rule literals | U-08 below; proposal: adopt a 4-pt scale (4/8/12/16/24/32/48/64/96) as CSS vars at next style touch (no change proposed now — site is frozen for this audit) |

**Kit weight map (critical reading key):** the Typekit kit's weights are non-standard —
**600 = Regular, 700 = Medium, 800 = Bold, 400 = Extra Light; body text uses 600 deliberately**
(documented in the `site.css` header). Any audit line reading "weight 600" as semibold is wrong;
METRICS.md §Typography carries the same correction.

## Components

Inventory (rendered bundle, all pages): `nb-*` header (logo, 4 links + CTA button, mobile
drawer) · footer (4 columns + social + legal) · eyebrow + gold-rule section opener · square
`nb-btn` (crimson primary / outline secondary) · square cards (verdict, review, case-study,
resource) · homepage Revenue Engine funnel + per-firm proof receipts · category filter tabs
(resources) · accordion FAQ (about) · homepage contact form + unsubscribe utility · external
Calendly handoff · floating book bar (free-chapters).

Verdicts (Phase 3 Brief):

- **Grayscale hierarchy pass: passes.** Value contrast alone carries hierarchy on the tested
  bands (home cinematic stage, section openers, card grids — grayscale conversions of the
  2026-08-09 screenshots). No section relies on hue alone for structure.
- **Visual system consistency: strong.** The eyebrow/gold-rule/Crimson-display pattern is applied
  uniformly across all subpages; header/footer shared; square shape language consistent.
- U-07 (sev 1) — **Imagery splits into two languages**: home's distinctive machinery/cinematic
  art direction vs interchangeable stock clichés on subpages (About "We Take Pride" whiteboard
  stock; article/resource cards: gavel + scales + suits — screenshots `p2-d-about`, `p2-d-article`,
  `p2-d-resources`). The About case doubles as a messaging gap (faceless guide — POSITIONING.md
  P-02/E-21). Fix: distinctive-imagery pass (E-23), founder/team photo on About (E-21).
- U-08 (sev 1) — No spacing scale (tokens table above). Rhythm is visually consistent in
  practice; codify when styles next open.

## UX Audit Findings (Phase 2 — heuristics + Trunk Test)

Severity 0–4. Statuses: open · in-flight · owner-gated · pass.

| # | Finding (heuristic) | Sev | Evidence | Fix | Status |
|---|---|---|---|---|---|
| U-01 | Active-nav state exists visually on About/Resources but is **missing on `/services/`** (SOLUTIONS now targets the homepage section, so this needs a deliberate current-page contract) and is **never exposed as `aria-current`** anywhere (visibility of status; Trunk Test "you are here"). Results is intentionally a homepage anchor and has no standalone active state. | 2 | `probes2.json`: `ariaCurrent: []` on every subpage; current shared chrome + historical screenshots | Define the `/services/` current-page behavior; add `aria-current="page"` alongside any visual class (E-19) | open |
| U-02 | The canonical homepage contact form has persistent visible labels; the separate unsubscribe utility intentionally asks only for an email address. Retired conversion subpages no longer duplicate the older placeholder-only contact form. | — | homepage `#contact`; `unsubscribe/index.html` | Preserve the single canonical form contract | resolved |
| U-03 | Client validation checks **presence only** — malformed email costs a server round-trip (`novalidate` + no format check; server message does render verbatim, so recovery works). | 1 | `inquiry.ts` L102–115 | Add client email-shape check in the shared handler (fold into E-20) | open |
| U-04 | Footer SOLUTIONS column: four product links (`The Revenue Engine™`/`CaseGen™`/`CaseIntake™`/`CaseConvert™`) all land on the same `/#system` anchor — label promises per-product depth, one destination (same pattern as F-08). | 1 | 404/footer screenshot; rendered footer markup | Point at `/services/` per-system anchors once they exist; note only — no template change in this audit | open |
| U-05 | Resource library dates all read **"Jan 4, 2024"** (visible ×4 on one article view) — a migration stamp that reads as a dead blog on the authority surface. | 1 | `p2-d-article.png` (header + 3 sidebar items), `p2-d-resources.png` | Restore real publish dates from the source export, or drop the date element (E-22) | open |
| U-06 | The homepage conversion hub is the only Calendly surface and uses one explicit external `View Available Times →` action, avoiding an embedded-widget dependency. | — | homepage `#booking` | Preserve the compact action; do not restore the widget or recovery-link pattern without an approved decision. | resolved |
| U-09 | JS-off: forms have no `action` fallback (dead without JS) — acceptable for this audience; content itself has static parity (kept from Phase 1 strengths). | 0 | `inquiry.ts` design; #4119 §1 | none — recorded so nobody "fixes" it into a worse pattern | pass |

**Trunk Test** (Krug), all pages: site ID ✓ (logo) · page name ✓ (H1 + `<title>` correct on all
9 probed pages, incl. 404) · sections ✓ (nav) · "you are here" **partial** (U-01) · search ✗ —
acceptable at 15 library items with category filters present (probes: `hasSearch: false`
everywhere; filters on `/resources/` confirmed).

**Link hygiene:** zero `target=_blank` links missing `rel=noopener` (probe, all pages) ✓.

## Typography (Phase 4)

Baselines and the failing surfaces are in [METRICS.md §Typography](METRICS.md) (F-10, F-11);
this section owns the system verdict and the fix spec. **Correction shipped with this phase:**
earlier "semibold body" readings were wrong — the kit maps 600→Regular (see Design Tokens);
emphasis hierarchy within body text is actually sound.

- System: 2 families, disciplined roles (Crimson Pro display / sweet-sans-pro text+labels) ✓.
- **P4-A (= F-14 corrected): Crimson Pro is double-sourced.** The layout head loads BOTH the
  Google `css2` stylesheet (6 cuts incl. italics) AND the Typekit kit that already carries
  Crimson cuts. Runtime capture (2026-08-09, home): 2 files / ~97 KB from `fonts.gstatic.com` +
  5 files / ~234 KB from `use.typekit.net`, behind **two render-blocking cross-origin
  stylesheets** (+ `p.typekit.net` tracker). Fix: one foundry owns Crimson — audit which cuts
  each surface uses, confirm kit coverage, then drop the `css2` line (or vice-versa) (E-18).
- Fix spec for F-10 (E-04, when styles open): body floor 16 px (reader surfaces 18 px); cap
  measures 45–75 ch via `max-width` in `ch` on text containers (worst offenders: services intro
  149 ch, REE strip 93 ch, reader 92 ch); keep line-height 1.5–1.7 (already compliant).
- F-11 micro-text (8.64 px gauge stamps, 9 px chart labels) → ≥11–12 px (E-07).
- `font-display`: Google css2 uses `swap`; Typekit kit CSS is kit-managed (not controlled from
  this repo) — revisit only if field data shows FOIT after cutover.

## Interaction & Error Design (Phase 8)

State machine (shared handler `inquiry.ts`, both forms): idle → client-validate (presence,
human-list message "Please fill in your name, email…") → sending (button disabled +
"Sending…", subpages deliberately button-only while in flight) → ok (per-form `data-success`
copy, form reset) / err (server message rendered **verbatim**; network errors get a no-blame
retry line). Honeypot bot trap; `role="status"` message slot = implicit polite live region ✓.

- **Pass:** 404 page is exemplary — correct 404 status code, clear no-blame copy, single "BACK
  TO HOMEPAGE" recovery CTA, full nav/footer retained (screenshot + probe; supersedes the
  Phase-1 "404 routes home" note, corrected in WEBSITE.md).
- **Pass:** slips prevented at the right layer — server stays authoritative, client saves the
  round trip (except U-03's email-shape gap).
- **Pass (homepage conversion hub):** persistent labels, a direct Calendly fallback, a polite
  live status region, and the shared protected inquiry state machine now coexist at `#booking`
  and `#contact`.
- **Gaps:** U-02 remains on legacy forms; U-03 (email shape) remains; legacy Calendly surfaces
  still need the planned retirement or equivalent fallback.
- Required-`phone` on the contact form is a deliberate friction/lead-quality trade — flagged as
  an observation for the owner (they sell phone-answering discipline; likely intentional). No
  change proposed.
