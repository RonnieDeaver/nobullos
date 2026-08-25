# NoBull Redesign — Design Pack Import Report

**Date:** 2026-08-03
**Scope:** Import/staging only. No redesign work was started; no existing application file was modified.

---

## 1. Source ZIP

| Item | Value |
|---|---|
| Uploaded as | `nobull-replit-design-pack.zip` |
| Found at | `attached_assets/nobull-replit-design-pack_1785784500085.zip` (6,198,780 bytes) |
| Instruction sheet (external copy) | `attached_assets/Pasted-I-uploaded-a-ZIP-named-nobull-replit-design-pack-zip-co_1785784514665.txt` |
| Instruction sheet (in-pack copy) | `01_REPLIT_IMPORT_PROMPT.txt` (identical instructions) |

## 2. Extraction / staging

| Item | Value |
|---|---|
| Staging directory | `design-source/nobull-revenue-engine-2026/` |
| Wrapper handling | The ZIP wraps all content in an inner `nobull-replit-design-pack/` folder; that wrapper was flattened during extraction so pack files sit directly at the staging root (e.g. `design-source/nobull-revenue-engine-2026/00_READ_ME_FIRST.md`). |
| Immutability | Everything under the staging directory is treated as immutable source originals — nothing renamed, edited, re-exported, optimized, or deleted. |
| Overwrites | None. `design-source/`, `docs/nobull-redesign/`, and `client/public/nobull-redesign/` did not exist before this import, and no pre-existing project file was overwritten, renamed, moved, or deleted. |
| `.gitignore` | Does not exclude `design-source/`, `docs/`, or `client/public/` — all imported files are trackable. |

### Staged contents (13 files + `SHA256SUMS.txt`)

```
00_READ_ME_FIRST.md
01_REPLIT_IMPORT_PROMPT.txt
02_DESIGN_DIRECTION.md
03_ASSET_MANIFEST.md
04_BRAND_TOKENS.json
SHA256SUMS.txt
assets/book/law-firm-revenue-engine-cover-exact.png
assets/brand/nobull-icon-crimson.svg
assets/brand/nobull-icon-reverse.svg
assets/brand/nobull-logo-full-color.svg
assets/brand/nobull-logo-reverse.svg
assets/guidelines/no-bull-brand-guidelines.pdf
assets/references/homepage-direction-reference.png
prompts/replit-nobull-redesign-prompt-pack.md
```

## 3. Integrity verification (staged files)

`sha256sum -c SHA256SUMS.txt` was run from inside the staging directory (manifest paths are relative to the pack root): **all 13 files OK, zero mismatches.**

SHA-256 of the six approved runtime assets (staged originals):

| Staged file | SHA-256 |
|---|---|
| `assets/brand/nobull-logo-full-color.svg` | `67797b4a571b206ede5c764d04b05b3e114fc46708d2eb8786ef061fb665545d` |
| `assets/brand/nobull-logo-reverse.svg` | `c148e461be49447907440ed2248319aa8de2ab1a1c9bf02c1bda24c9433ad109` |
| `assets/brand/nobull-icon-crimson.svg` | `5e2356a09260c9e505ab2c7800bad53ebef38e0e15652ce014d4484af340e5cf` |
| `assets/brand/nobull-icon-reverse.svg` | `382b6c3ba676826141915ccea51cb5dc6428f3c3c75a4d395d8cf005f1250753` |
| `assets/book/law-firm-revenue-engine-cover-exact.png` | `fc0dd6ccf74c665c4b1289b276bf1fbbe3c0b2cff3b1144f5342eced83b1380e` |
| `assets/references/homepage-direction-reference.png` | `9c581212c3935ae71ceeb0687e027380df73916a0e04b54dc81f30a48029bd3c` |

## 4. Application inspection

| Aspect | Finding |
|---|---|
| Framework | Vite 7 + React 19 + TypeScript 5.6 single-page app (`client/`), Express 4 backend (`server/`). Routing via **wouter** 3. Styling via **Tailwind CSS v4** (`@tailwindcss/vite` plugin) with shadcn/ui ("new-york" style, `components.json`). |
| Static asset root | **`client/public/`** — Vite `root` is `client/` (`vite.config.ts`), so `client/public/` is served at `/` in dev and copied into `dist/public/` at build. Confirmed in use (`favicon-nobull.png`, `book-cover.webp`, `assets/`, etc.). |
| Source asset root | **None** — `client/src/assets/` does not exist. Per instruction #14 the `src/assets/nobull-redesign/` fallback is only for projects with no static/public root; this project has one, so **no new source-asset namespace was created** and the static root is used. |
| Typography | Merriweather loaded via Google Fonts `<link>` in `client/index.html` and applied via `font-family` rules in `client/src/index.css`; Tailwind v4 `@theme` declares `--font-sans: 'Montserrat', sans-serif` and `--font-heading: 'Playfair Display', serif` (`client/src/index.css:46-47`). Neither Crimson Pro nor Sweet Sans Pro is present anywhere. |
| Header / footer | Internal OS application shell — sidebar navigation plus a shared `PageHeader` component (`client/src/components/PageHeader.tsx`). **No marketing-site header/footer components exist** (the only `<footer>` is inside the internal Roadmap page). |
| Routes | wouter `<Route>` definitions in `client/src/App.tsx` — internal app routes only (`/`, `/admin/*`, `/clients/*`, `/reports/*`, `/ceo/*`, `/analytics/*`, …). No public marketing routes. |
| Design tokens | Tailwind v4 `@theme` block + CSS custom properties in `client/src/index.css` (beige/burgundy theme); shadcn/ui configuration in `components.json`. No other token files. |

## 5. Sweet Sans Pro licensed font files

**Repo files: not found.** A search of `client/` (and the repo generally) found **zero** `.woff`, `.woff2`, `.ttf`, or `.otf` files. Per the pack rules (`03_ASSET_MANIFEST.md`, `04_BRAND_TOKENS.json`):

- Sweet Sans Pro **must not be used** until a license is supplied.
- No unofficial copy may be downloaded; no lookalike may be labeled Sweet Sans Pro.
- The pack's declared no-license fallback was Arial (secondary stack: `Sweet Sans Pro, Arial, sans-serif`).

**UPDATE (2026-08-03, post-import):** The user supplied the license as an **Adobe Fonts (Typekit) hosted kit** — `https://use.typekit.net/hve0rhv.css`, CSS family `"sweet-sans-pro"`, weights 200–900 in normal + italic. Self-hosted WOFF/WOFF2 files are therefore not required; the hosted kit **is** the licensed delivery, superseding the Arial fallback for the redesign. Full weight table and usage notes: `docs/nobull-redesign/reference/sweet-sans-pro-adobe-fonts-license.md`. ⚠ The kit's weight mapping is non-standard — **600 = Regular, 700 = Medium, 800 = Bold** (400 is *Extra Light*). Nothing has been wired into the app; adding the `<link>` and typography tokens is redesign work (Task #3751).

## 6. Potential conflicts with existing files

**No naming collisions.** None of the target paths existed before import. Related — but non-conflicting — existing assets that a future redesign should be aware of (all left untouched):

| Existing file | Note |
|---|---|
| `client/public/assets/NoBull.Primary.Logo.RGB_1768082941101.png` | Older PNG raster of the primary logo (pack supplies exact SVG) |
| `client/public/assets/NoBull.Primary.Logo.White_1768864291629.png` | Older PNG raster of the white/reverse logo (pack supplies exact SVG) |
| `client/public/book-cover.webp` | Existing book-cover image (pack supplies the exact approved PNG) |
| `client/public/favicon-nobull.png` | Current favicon (icon SVGs in the pack are separate assets) |

The new `client/public/nobull-redesign/` namespace keeps all pack assets fully separated from these.

## 7. Canonical runtime paths (approved assets)

Copies (never moves) from staging into the detected static asset root, under the new `nobull-redesign/` namespace. Staged originals remain in place, byte-for-byte identical.

| Approved asset (staged origin) | Canonical runtime path | Served URL |
|---|---|---|
| `assets/brand/nobull-logo-full-color.svg` | `client/public/nobull-redesign/brand/nobull-logo-full-color.svg` | `/nobull-redesign/brand/nobull-logo-full-color.svg` |
| `assets/brand/nobull-logo-reverse.svg` | `client/public/nobull-redesign/brand/nobull-logo-reverse.svg` | `/nobull-redesign/brand/nobull-logo-reverse.svg` |
| `assets/brand/nobull-icon-crimson.svg` | `client/public/nobull-redesign/brand/nobull-icon-crimson.svg` | `/nobull-redesign/brand/nobull-icon-crimson.svg` |
| `assets/brand/nobull-icon-reverse.svg` | `client/public/nobull-redesign/brand/nobull-icon-reverse.svg` | `/nobull-redesign/brand/nobull-icon-reverse.svg` |
| `assets/book/law-firm-revenue-engine-cover-exact.png` | `client/public/nobull-redesign/book/law-firm-revenue-engine-cover-exact.png` | `/nobull-redesign/book/law-firm-revenue-engine-cover-exact.png` |
| `assets/references/homepage-direction-reference.png` | `client/public/nobull-redesign/references/homepage-direction-reference.png` | `/nobull-redesign/references/homepage-direction-reference.png` |

Non-runtime reference documents (working copies; staged originals stay immutable):

| Staged origin | Reference copy |
|---|---|
| `assets/guidelines/no-bull-brand-guidelines.pdf` | `docs/nobull-redesign/reference/no-bull-brand-guidelines.pdf` |
| `00_READ_ME_FIRST.md` | `docs/nobull-redesign/reference/00_READ_ME_FIRST.md` |
| `01_REPLIT_IMPORT_PROMPT.txt` | `docs/nobull-redesign/reference/01_REPLIT_IMPORT_PROMPT.txt` |
| `02_DESIGN_DIRECTION.md` | `docs/nobull-redesign/reference/02_DESIGN_DIRECTION.md` |
| `03_ASSET_MANIFEST.md` | `docs/nobull-redesign/reference/03_ASSET_MANIFEST.md` |
| `04_BRAND_TOKENS.json` | `docs/nobull-redesign/reference/04_BRAND_TOKENS.json` |
| `prompts/replit-nobull-redesign-prompt-pack.md` | `docs/nobull-redesign/reference/replit-nobull-redesign-prompt-pack.md` |

## 8. Asset handling rules honored

- Nothing redrawn, recolored, traced, cropped, distorted, rearranged, re-exported, optimized, or replaced — all copies are byte-for-byte (verified by SHA-256, see §9).
- The homepage mockup is a visual-direction reference only; its statistics, ratings, testimonials, client logos, case-study results, and trademark symbols are **not** verified content.
- The brand-guidelines PDF is reference material, never publishable site content.
- The website redesign itself was **not** started (explicitly out of scope for this import).

## 9. Post-copy verification

*(completed after the runtime copies were made — see the final section appended below)*
**Result: PASS.** All 13 copies are byte-for-byte identical to their staged originals (SHA-256 verified below), and the staged pack still verifies 13/13 against `SHA256SUMS.txt` after copying.

Working-tree check: the **import operations themselves produced additions only** — new files under `design-source/`, `docs/nobull-redesign/`, and `client/public/nobull-redesign/`; the import performed no writes outside those three new directories, and no pre-existing project file was overwritten, renamed, moved, or deleted **by the import**. The task branch's final diff additionally carries changes that are not part of the import: (a) a `.replit` platform metadata update (removal of a stale `[[ports]]` block) applied automatically by Replit during the session, and (b) upstream `main` content auto-merged into the branch mid-session as sibling tasks landed — including repairs this task then made to breakage introduced by that merge resolution itself: six corrupted startup call sites in `server/index.ts` restored to their canonical implementations, three colliding `0146_*` migration files renamed to unique prefixes (`0142_add_client_save_plays.sql` restored to its pre-merge name; roadmap → `0147_`; intel notes → `0148_`; the earliest claimant kept `0146_`), and the dev migration-ledger rows reconciled to match. None of these repairs touch the imported assets, which remain byte-for-byte verified below.

| Copy | SHA-256 (== staged original) |
|---|---|
| `client/public/nobull-redesign/brand/nobull-logo-full-color.svg` | `67797b4a571b206ede5c764d04b05b3e114fc46708d2eb8786ef061fb665545d` |
| `client/public/nobull-redesign/brand/nobull-logo-reverse.svg` | `c148e461be49447907440ed2248319aa8de2ab1a1c9bf02c1bda24c9433ad109` |
| `client/public/nobull-redesign/brand/nobull-icon-crimson.svg` | `5e2356a09260c9e505ab2c7800bad53ebef38e0e15652ce014d4484af340e5cf` |
| `client/public/nobull-redesign/brand/nobull-icon-reverse.svg` | `382b6c3ba676826141915ccea51cb5dc6428f3c3c75a4d395d8cf005f1250753` |
| `client/public/nobull-redesign/book/law-firm-revenue-engine-cover-exact.png` | `fc0dd6ccf74c665c4b1289b276bf1fbbe3c0b2cff3b1144f5342eced83b1380e` |
| `client/public/nobull-redesign/references/homepage-direction-reference.png` | `9c581212c3935ae71ceeb0687e027380df73916a0e04b54dc81f30a48029bd3c` |
| `docs/nobull-redesign/reference/no-bull-brand-guidelines.pdf` | `4b754c4270dae9455c9c3270af552c568c6c5245b11a6c2d0d725ec6b55f14ac` |
| `docs/nobull-redesign/reference/00_READ_ME_FIRST.md` | `2ec133eb9442769f3133da4df63fc8a0d348d8e2985674e7b234a5cf3483c639` |
| `docs/nobull-redesign/reference/01_REPLIT_IMPORT_PROMPT.txt` | `b3b3e6e82492e378a85bddc0d5f634efc0da7bcf62202ff80e638005a46189f9` |
| `docs/nobull-redesign/reference/02_DESIGN_DIRECTION.md` | `62d83be1002010230edfa4d931736ee6fd87122952a5133df9fe1c3c2eb94bac` |
| `docs/nobull-redesign/reference/03_ASSET_MANIFEST.md` | `16e2bb1ba0058002738e29912fcd9b874ce9a387f52f5b11d9943cbe542e6f81` |
| `docs/nobull-redesign/reference/04_BRAND_TOKENS.json` | `502e55d269b84518157422241d22b81bc1b7688d68000321b5d6a0ffe6944494` |
| `docs/nobull-redesign/reference/replit-nobull-redesign-prompt-pack.md` | `d8532bb6d52fc627c29a654dfa3e34d8af4b13d0798e1d8c67a32df970ddca9e` |
