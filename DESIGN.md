# Design System — NoBull Marketing Website

<!-- impeccable:design-schema 1 -->

<!-- STATUS: Pre-build contract. Rules are binding requirements, not post-hoc documentation.
     When the first build ships, this file is superseded in the tokens section by the built world.
     All composition, content-integrity, and preservation rules remain binding permanently. -->

---

## Identity

**Surface:** nobullmarketing.com marketing website  
**Mode:** Persuade  
**Brand hierarchy:** 70–75% NoBull / 25–30% Revenue Engine

---

## Palette

### Testable rules

| Rule | Test |
|---|---|
| All primary backgrounds are Eggshell (#EEE8DC) or warm white; no pure #FFFFFF | Inspect `background-color` on `<body>`, `<main>`, and all section elements |
| Crimson (#8A292F) is used exclusively for CTAs, the title band, and the one dark system band | No other element carries Crimson as a background except these three roles |
| Goldenrod (#D5AC5C) appears only as accent: labels, rules, icons, small emphasis; never as a section background | No `background-color: #D5AC5C` or equivalent on any block-level container |
| Liberty Blue (#485696) is used only for supporting panels, subheadings, and supplementary UI — never as the hero or dominant section color | No full-width Liberty Blue section background appears above the fold |
| Earth (#524B3A) is the body copy color | `color` on `<p>` and body text elements resolves to #524B3A or functionally equivalent |
| Black (#000 or near-black) does not appear as a global or dominant page color | Page-level `color` and `background` are not black except inside the one dark Revenue Engine band |
| Metallic gold is used only inside the Revenue Engine dark band; not globally | No gold gradient, metallic texture, or gold fill appears outside the dark system band |
| The dark system band uses charcoal or near-black sampled from the book cover, with white type | Computed `background-color` on the system band resolves to a dark value (L < 20 in HSL); `color` on its text resolves to white or near-white |

---

## Typography

### Testable rules

| Rule | Test |
|---|---|
| Editorial headlines use Crimson Pro (or Baskerville as fallback); no other serif is used for display headings | `font-family` on `<h1>`, `<h2>`, and section headings resolves to Crimson Pro or Baskerville |
| Body copy and UI elements use Sweet Sans Pro (Typekit kit `hve0rhv`) with Arial as system fallback | `font-family` on `<p>`, nav, buttons, and form elements resolves to `"sweet-sans-pro", Arial, sans-serif` |
| Sweet Sans Pro is loaded via `<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">` in `<head>` | Tag exists in generated `<head>` on every page |
| No other sans-serif is substituted and labelled Sweet Sans Pro | No `font-family` declaration contains "sweet-sans-pro" pointing to a local file or CDN other than use.typekit.net |
| Weight 600 renders as Regular (non-standard mapping); no weight lower than 600 is used for body copy | Body `font-weight` is 600 or higher |
| Pill-shaped design language is absent | No `border-radius` ≥ 50% on any interactive element; no fully rounded large buttons |
| Corner radius is minimal | `border-radius` on cards and buttons does not exceed 4px |

---

## Logo and Asset Rules

### Testable rules

| Rule | Test |
|---|---|
| Header logo on light/eggshell backgrounds uses `public/assets/brand/nobull-logo-full-color.svg` only | `<img src>` or `<use href>` in `<header>` on light-background pages resolves to `nobull-logo-full-color.svg` |
| Header logo on Crimson or dark backgrounds uses `public/assets/brand/nobull-logo-reverse.svg` only | Same check on dark-background header variants |
| Standalone bull icon uses only `nobull-icon-crimson.svg` (light bg) or `nobull-icon-reverse.svg` (dark bg) | No other bull icon file or inline SVG appears |
| Book cover image is `public/assets/book/law-firm-revenue-engine-cover.png` — the exact supplied file, SHA256 `fc0dd6ccf74c665c4b1289b276bf1fbbe3c0b2cff3b1144f5342eced83b1380e` | `<img src>` in the book section resolves to this file; SHA256 of the deployed file matches |
| The book cover is never recolored, cropped, distorted, or rearranged | No `filter:`, `clip-path:`, `transform: skew/scale`, or `object-fit: cover` with offset applied to the book cover image |
| A 3-D book presentation wraps the cover as the front face; perspective, pages, spine, and shadow are constructed around it | The book cover `<img>` is present inside the 3-D presentation; no replacement or composite is used |
| The homepage-direction reference (`public/assets/references/homepage-direction.png`) is never rendered on a user-facing page | No `<img src>` containing `homepage-direction` appears in any published HTML |

---

## Composition and Layout

### Testable rules

| Rule | Test |
|---|---|
| The page opens with a light hero; the hero background is Eggshell or warm white | First full-width section's `background` is a light value |
| Machinery / Revenue Engine visual element appears only on the right side of the hero and fades into the light background | No full-bleed dark machinery texture is present in the hero |
| There is exactly one dark system band (the Revenue Engine centerpiece) | Exactly one `section` or `div` with a dark background (L < 20 HSL) exists in the page body |
| The page returns to Eggshell immediately after the dark band | The section following the dark band has a light background |
| Header and footer are NoBull-palette (Eggshell/white background, Crimson accents) on every page including the book landing page | `background-color` on `<header>` and `<footer>` is not dark or metallic-gold |
| Cards are not nested inside cards | No `.card`, `[class*="card"]`, or `border + background` container is a direct child of another such container |
| No purple gradients, glassmorphism, floating glow blobs, or generic icon tile rows appear anywhere | Grep for `radial-gradient.*purple`, `backdrop-filter`, `box-shadow.*glow`, `rgba.*blur`; visual inspection for icon-tile rows |
| Spacing above a heading is greater than spacing below it | `margin-top` on `<h2>` and `<h3>` exceeds `margin-bottom` |

---

## Brand Hierarchy Enforcement

### Testable rules

| Rule | Test |
|---|---|
| NoBull visual language (Eggshell, Crimson Pro, Crimson CTAs, Liberty Blue panels, Goldenrod accents) occupies ≥ 70% of vertical page height | Measure cumulative section heights: NoBull-palette sections ≥ 70% of total |
| Revenue Engine visual language (dark band + hero machinery) is confined to ≤ 30% of vertical page height | Dark-band + machinery region heights ≤ 30% of total |
| The Revenue Engine dark band is a single coherent section, not a motif scattered throughout the page | Only one dark section background exists (see composition rule above) |
| No currency-tear motif appears outside the actual book cover | Grep for currency, money, bill, tear imagery; visual inspection |
| No machinery background appears behind multiple sections | The machinery/engineering visual element is present only in the hero right column and the dark system band |
| No generic gold bull illustration appears | No bull SVG or image other than the approved brand icon SVGs is present |

---

## Content Integrity

### Testable rules

| Rule | Test |
|---|---|
| All metric claims (lead counts, revenue figures, client counts, experience years, pricing) appear verbatim from `docs/CONTENT_TRUTH_SOURCE.md` marked VERIFIED | Diff every numeric claim in rendered HTML against the truth source; any number not in the VERIFIED section is a violation |
| Items marked NEEDS CLIENT CONFIRMATION appear only as neutral layout placeholders, never as factual claims | Grep for `[`, `placeholder`, or known unconfirmed values (650,000; $150 million; 300 law firms; $6,000) — if present, they must be inside a `<!-- placeholder -->` comment or visually marked as pending |
| Items marked UNVERIFIED (e.g., "As Seen On" logo identities) are rendered with placeholder alt text, not invented names | `alt` attributes on "As Seen On" logos do not contain invented organization names |
| The three testimonial quotes (Tessa Thrift, Lani Akiona, Stacy Grow) are not rendered until the operator confirms which version is approved | No blockquote or testimonial copy for these three persons appears in published HTML without explicit operator sign-off |
| No trademark symbols (™, ®) appear without operator confirmation | Grep for `™`, `®`, `&trade;`, `&reg;` — none are permitted until confirmed |
| Copyright year in the footer is current (2026) or a range (2024–2026) | Footer `<p>` contains `2026` not just `2024` |
| No phone numbers appear as links or text unless added by the operator | Grep for `tel:` and numeric patterns matching phone format — none are permitted from the current source |

---

## Integrations and Functional Preservation

### Testable rules

| Rule | Test |
|---|---|
| The single Calendly widget loads at homepage `#booking`; subpages link back to it | Exactly one generated `data-url` matches the confirmed URL; subpage booking CTAs are depth-correct homepage anchors |
| Calendly URL is exactly `https://calendly.com/jmangle-nobullmarketing/high-impact-revenue-session-other` | `data-url` attribute value matches exactly |
| Contact form has exactly four visible required fields: Full Name, Email, Phone, Message — plus one honeypot | Four `required` inputs + one `tabindex="-1"` honeypot with `name="website"` |
| All 16 article slugs remain valid | `GET /resource/<slug>/` returns 200 for all slugs in `website/content/articles/index.json` |
| `www.nobullmarketing.com` redirects 301 to `nobullmarketing.com` | HTTP response code from `www.` host |
| `/website-preview/` carries `noindex` header | Response headers for preview path contain `X-Robots-Tag: noindex` or equivalent |
| Every page emits a canonical tag pointing to `https://nobullmarketing.com/<path>` | `<link rel="canonical">` in `<head>` resolves to the apex domain |

---

## Prohibited Patterns

The following patterns are banned. Their presence in a build is a blocking defect:

- Purple gradients of any kind
- Glassmorphism (`backdrop-filter`, frosted panels)
- Floating glow blobs or ambient light halos
- Generic SaaS icon tile rows (rows of interchangeable emoji-backed feature cards)
- Cards nested inside cards
- Pill-shaped buttons (border-radius ≥ 50%)
- Full-page black-and-gold palette (outside the one dark band)
- Any font labelled Sweet Sans Pro that is not loaded from `use.typekit.net/hve0rhv.css`
- The homepage-direction reference image rendered on any user-facing page
- Any logo, testimonial, metric, or case study not present in `docs/CONTENT_TRUTH_SOURCE.md` as VERIFIED or explicitly confirmed by the operator

---

## Finish Gate

A build is not finished until:

1. Desktop and mobile screenshots have been reviewed against this contract
2. Every testable rule above has been checked (pass or documented exception)
3. DESIGN.md has been updated from the built world (tokens section) by the shipped documenter
4. The finish reviewer has returned a verdict

---

## OS App Responsive Baseline

Scope: the internal OS app (`client/`), not the marketing site above. Established by the mobile compatibility pass; new OS pages must hold these invariants at 375 / 768 / 1024 px:

- **Zoom policy**: the viewport meta must never set `maximum-scale`/`user-scalable=no`. iOS input auto-zoom is prevented instead by the global ≥16px form-control font floor below 768px (`client/src/index.css`); `text-size-adjust: 100%` is set globally. These two ship together — removing the font floor re-introduces focus zoom.
- **Overflow containment**: pages must have no horizontal scroll; `body` uses `overflow-x: clip` as a backstop, never as an excuse. Wide tables go inside `.os-table-wrap` (bordered horizontal scroll container) with `.os-sticky-col` keeping the identity column visible; override its background via `--os-sticky-col-bg` for striped/highlighted rows.
- **Grids**: the global mobile override collapses multi-column `.grid`s and gives children `min-width: 0` (stops min-content blowout from `truncate`/`whitespace-nowrap` descendants). Grids that must keep their tracks at phone width (e.g. calendars) opt out with `mobile-grid-keep` and get their own scroll wrapper.
- **Toolbars / button rows**: action rows use `flex-wrap` (+ `min-w-0`), fixed-width filter controls become `w-full sm:w-[NNNpx]`. Long unbreakable identifiers (`font-mono`/`code` tokens) in tight cells need `break-all`.
- **Safe areas**: viewport uses `viewport-fit=cover`; body sides, sidebar, and the toast viewport pad with `env(safe-area-inset-*)`. Any new fixed/floating UI must do the same.
- **Touch targets**: under `pointer: coarse`, buttons get a 24px minimum (WCAG 2.5.8); frequent primary controls (sidebar trigger) get 44px.
- **Header**: `GlobalAppNav` needs ~1250px; it collapses to the hamburger below `xl`.
- **Verification**: `tests/os-mobile-layout-sweep.test.ts` (registered regression-sweep suite) mints an authed session, loads the 11 audited pages in real Chromium at 375/768/1024px, and fails when `max(html,body).scrollWidth` exceeds the viewport. Run it directly (`npx tsx tests/os-mobile-layout-sweep.test.ts`, dev server must be up) whenever touching these surfaces; the nightly regression sweep runs it routinely. Bisect offenders per `.agents/memory/mobile-overflow-debugging.md`.

## OS App Dark Mode

Task #4377 (design-epic capstone). App-wide dark theme for the internal OS — the v2 "machinery" mood (warm near-black canvas, charcoal panels, fill-grade primary — crimson at the time; Liberty Blue since the 2026-08 re-primary, Task #4558), never inverted beige. The 2026-08 brand rebalance (Task #4600, below) left the dark anchors untouched: dark chrome is the card charcoal with a crimson `--chrome-edge` hairline and light heading ink.

- **Tokens**: the `.dark` block in `client/src/index.css` defines dark values for every house token (canvas, cards, popovers, primary, status tones, borders, `--os-table-surface`, `--shadow-ink`, warm surfaces). Status fills invert the light-theme "white text on fills" guarantee — dark-safe idiom is tint chips (`bg-status-x/10` + `text-status-x`).
- **Toggle**: global light/dark/system control in the top-nav user menu (`QuicklinksBar`) and Profile → Appearance. Default **system** (follows `prefers-color-scheme` live); choice persists per user in `users.theme_preference` via `PUT /api/users/me/theme` and syncs across devices.
- **No-flash boot**: an inline pre-paint script in `client/index.html` applies `.dark` from the `nobull-theme` localStorage key before first paint; `client/src/lib/theme.tsx` (`ThemeProvider`/`useTheme`) reconciles with the server preference after auth.
- **Light-locked surfaces**: the public report layer (`.report-surface`, `--report-*`) is a branded artifact and never flips with app dark mode.
- **Compat remap**: a documented block in `index.css` re-maps light-era literal utilities (`bg-white`, gray/slate ramps, high-alpha whites) onto tokens under `.dark` (report surface exempted). New code uses semantic tokens; the remap exists to keep legacy literals legible until the per-site burn-down (follow-up task) retires it.
- **Ads OS**: the module's dark palette was absorbed — `adsOs.css` keys off global `.dark` (module keeps only scoped deltas like its text-grade Liberty `--primary`); the module-local toggle is gone.
- **Verification**: `tests/client/theme-provider-switch-persist.test.ts` (registered) covers boot-from-cache, switching, persistence PUT + cache invalidation, system live-follow, and signed-out behavior.

## OS App Brand Color Hierarchy (2026-08 rebalance)

Task #4600 (owner decision, follows the internal-OS color study in `audits/internal-os-design-audit-2026-08.md`). After the Liberty re-primary the OS read as a generic blue-on-beige tool; the rebalance restores the v2 brand hierarchy — "eggshell backgrounds, crimson and earth typography" (brand guidelines v2 pp. 3, 15–16) — at the chrome/canvas/typography layer **without reverting the re-primary**. Full token story + contrast math live in the `client/src/index.css` constitution (CANVAS / CHROME / HEADINGS sections).

- **Canvas**: the light neutral ramp is the true v2 eggshell family — `--background` = Eggshell `#EEE8DC`, `--card`/`--popover`/`--surface-warm-2` = Warm Paper `#FAF8F4` (lifted warm cards), `--secondary` = Cream Deep `#E7DFCE`; muted/border are warm steps on the same 40° axis. All text/status/Liberty contrast bars re-verified AA on the new surfaces.
- **Chrome**: the global nav band and the Brief Studio band are brand chrome on the dedicated `--chrome` token family — v2 crimson with the reverse bull mark (exact approved artwork) in light; charcoal with a crimson `--chrome-edge` hairline in dark. `--chrome` never colors buttons, links, focus rings, data, or status.
- **Interactive stays Liberty**: `--primary`/`--ring`, buttons, links, focus rings, and selected/active states are unchanged; destructive/critical stay the only reds in the working UI.
- **Headings**: display/section headings default to `--heading-ink` = v2 Earth `#524B3A` on light (base-layer h1–h3 rule; explicit text utilities win; report deck excluded); dark keeps a light heading tone.
- **Crimson identity moments** (accent usage rule): the chrome bands, the PageHeader title (`text-accent`, light only), and the sign-in brand lockup — a deliberately small set, never on data rows or anything confusable with an error state.
- **Card outlines are warm, not Liberty** (Task #4785 decision): non-interactive card borders, section dividers, and info-chip outlines use the neutral `border-border` token, matching shadcn Card and the loading skeletons. The legacy `border-primary/10` tint on client-detail panels was a pre-rebalance leftover, not an idiom — Liberty borders remain reserved for interactive states (focus rings, selected/active).
