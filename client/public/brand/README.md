# NoBull OS brand assets (canonical in-app set)

The one static namespace the internal OS serves brand artwork from
(Task #4618). Rendered in the app **only** through the kit component
`client/src/components/kit/BrandMark.tsx` — never via ad-hoc `<img>` tags.

## Rules

- **Exact approved artwork only.** Never redraw, recolor, restyle, or crop
  these files (brand guidelines: `docs/brand/no-bull-brand-guidelines-v2.pdf`).
  Resizing exports and padding onto square canvases is allowed; distortion and
  cropping are not.
- **Variant choice, not recoloring**: crimson = identity chrome (nav band,
  favicon, notifications); black/white = neutral placements on light/dark
  surfaces; earth = soft content-area moments (empty states). Per the Task
  #4600 accent rule, crimson never sits where it could read as an error state.
- Do not hand-edit generated rasters — regenerate:
  `npx tsx scripts/generate-brand-assets.ts` (byte-stable re-run).

## Provenance

SVGs are byte-exact copies from the tracked brand package
`.source/nobull-brand/Brand Files/NoBull Logo Package/` (sha256 of each copy
== its source):

| File | Package source | sha256 |
| --- | --- | --- |
| `nobull-logo-full-color.svg` | `Primary Logo/RGB (Web)/NoBull.Primary.Logo.RGB.svg` | `67797b4a571b206ede5c764d04b05b3e114fc46708d2eb8786ef061fb665545d` |
| `nobull-logo-black.svg` | `Primary Logo/Black/NoBull.Primary.Logo.Black.svg` | `f93ffac6a4d4b2c57e84b279128cb18a94429fcf7d7273bd7d576e0ebbe1229f` |
| `nobull-logo-white.svg` | `Primary Logo/White/NoBull.Primary.Logo.White.svg` | `c148e461be49447907440ed2248319aa8de2ab1a1c9bf02c1bda24c9433ad109` |
| `nobull-icon-crimson.svg` | `Icon/Crimson/RGB (Web)/NoBull.Crimson.Icon.RGB.svg` | `5e2356a09260c9e505ab2c7800bad53ebef38e0e15652ce014d4484af340e5cf` |
| `nobull-icon-black.svg` | `Icon/Black/NoBull.Crimson.Icon.Black.svg` | `5bec1f33d0a3a1762fa2c43828e791dafde7fa71c8008d6db899cfeb61a070f2` |
| `nobull-icon-white.svg` | `Icon/White/NoBull.Crimson.Icon.White.svg` | `382b6c3ba676826141915ccea51cb5dc6428f3c3c75a4d395d8cf005f1250753` |
| `nobull-icon-earth.svg` | `Icon/Earth/RGB (Web)/NoBull.Icon.Earth.RGB.svg` | `a85d6aa91e01ca5ce4de1f20c736e13196c442677961689cc26347fd4d0eba6d` |

Generated rasters (same artwork, square-padded, never cropped):

| File | Contents |
| --- | --- |
| `../favicon.ico` | 16+32+48 crimson bull, transparent square frames |
| `../apple-touch-icon.png` | 180×180 crimson bull on opaque eggshell `#EEE8DC` tile |
| `nobull-icon-crimson-192.png` | 192×192 transparent — desktop notification icon |
| `og-nobull-os.png` | 1200×630 OpenGraph card — full-color logo on eggshell |

Geometry note: the bull icon viewBox is `800×646.32` (wider than tall); the
primary logo is `800×224.65`. Square raster frames pad with empty canvas —
aspect ratio is always preserved.

The marketing/design-pack namespace `client/public/nobull-redesign/` is a
separate design-source import and is not the app's brand namespace; new
in-app usages point here.
