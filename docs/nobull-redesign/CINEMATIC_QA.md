# Revenue Engine Cinematic — QA Report

Date: 2026-08-04 · Surface: mockup sandbox homepage
(`artifacts/mockup-sandbox/src/components/mockups/nobull-homepage/Homepage.tsx`)

## Status: LIVE with AI-generated interim frames (2026-08-04 update)

144 WebP frames now exist at the configured path, sliced from an AI-generated 8s 1080p
master clip (`attached_assets/generated_videos/rev-engine-master.mp4`) following the
MOTION_RENDER_BRIEF arc (closed hood → hood open/internals → gold fuel → white-gold
spark → flywheel output). 23.5 MB total, max frame 258 KB — within the brief's 18–28 MB /
300 KB targets. These are an approved interim stand-in, NOT the purpose-built final render;
they do not hit every choreography beat frame-exactly (per-stage ASSET_QA.md checks still
pending final art). Swap-in of final frames requires no code changes.

Fix shipped alongside: `frameBasePath` on Homepage.tsx now prefixes `import.meta.env.BASE_URL`
(sandbox serves under `/__mockup/`; a root-absolute path 404'd every frame).

### Cinematic-mode verification (headless Chromium, matchMedia hover/fine-pointer stubbed)
- Pin active (pin-spacer present) across the whole 5.6vh range; document height grows accordingly.
- Frames scrub with scroll: hood closed at 5%, ignition sparks mid-range, full gold output late.
- Stage narration advances correctly: open → casegen → caseintake → caseconvert → growth
  at 5/25/45/65/90% progress; exactly one panel visible at a time.
- Zero console errors; zero frame 404s.
- Note: real headless Chrome reports `hover: none`, so unstubbed headless (and touch devices)
  correctly get the static final-frame + stacked-summaries fallback — verified rendering well.

## Verified (headless Chromium against the live sandbox preview)

| Viewport | Section renders | Canvas mounts | Notes |
|---|---|---|---|
| 1920×1080 | ✓ | ✓ | Unavailable notice + stacked stage summaries |
| 1440×900 | ✓ | ✓ | Screenshot reviewed — dark stage, gold typography, stage 01 copy correct |
| 1366×768 | ✓ | ✓ | |
| 1024×768 | ✓ | ✓ | Cinematic breakpoint boundary renders without layout break |
| 768×1024 | ✓ | ✓ | Falls into static/stacked fallback branch |
| 390×844 | ✓ | ✓ | Screenshot reviewed — mobile stacked summaries legible |

Also verified:
- Hero and header untouched (full-page screenshot at 1280×720 matches approved direction).
- Typecheck clean (`tsc --noEmit` in the sandbox).
- No transformed ancestor around the pinned section (`.nb-page` has no transform/filter/perspective).
- Console shows only the expected frame-404 errors; no React/GSAP runtime errors.
- Old scroll-listener Revenue Engine section, `EngineDiagram`, and its state/effects fully removed.

## Not verifiable until frames exist
- Pin/scrub behavior (5.6vh scroll, scrub 0.65, stage boundaries 0/21.5/40/58/78%).
- Frame-canvas rendering quality, priority-frame progressive load, per-stage imagery.
- Reduced-motion final-frame poster (needs frame 144).

Re-run this QA once the 144 frames are exported into
`artifacts/mockup-sandbox/public/nobull-redesign/revenue-engine/frames/desktop/`
(`rev-engine_0001.webp` … `rev-engine_0144.webp`).
