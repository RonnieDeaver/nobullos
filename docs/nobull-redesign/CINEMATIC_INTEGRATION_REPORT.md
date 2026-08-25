# Revenue Engine Cinematic — Integration Report

Written before implementation, per the pack's implementation contract.
Date: 2026-08-04

## Target surface
- **Target = mockup sandbox homepage**, not the main app. The canvas-selected iframe
  (`shape:nobull-homepage-frame`) renders
  `artifacts/mockup-sandbox/src/components/mockups/nobull-homepage/Homepage.tsx`.
  Graduation to the main app is a later, separate step.

## Environment audit
- Framework: React 18 + Vite (mockup sandbox artifact). Package manager: npm.
- Source root: `artifacts/mockup-sandbox/src`
- Static asset root: `artifacts/mockup-sandbox/public` (served at `/`).
- CSS Modules: supported natively by Vite (`*.module.css`). ✓
- GSAP: not currently installed in the sandbox — will add `gsap` + `@gsap/react`.

## Current Revenue Engine section (to be replaced)
- `Homepage.tsx` lines ~290–389: `<section id="system" className="nb-system">` —
  scroll-listener-driven hood reveal + SVG `EngineDiagram` + stage nav/scroller + finale block.
- Supporting code to remove with it: `engineStages` data, `EngineDiagram` component,
  `activeStage`/`revealProgress`/`scrollProgress` state, the scroll `useEffect`, `jumpToStage`,
  `stageRefs`, and the `nb-system`/`nb-engine-*`/`nb-stage-*` CSS in `_group.css` (left in place
  initially; pruned only if unreferenced — CSS is inert without the markup).
- The finale block ("BUILD THE ENGINE...") is part of the replaced section; the cinematic's own
  ending CTA (strategy call + first chapters) supersedes it.

## Untouched (locked, approved direction)
- Header and hero (50/50 split, Sweet Sans bold two-color headline, black-gold book machinery).
- Metrics/proof section and everything below remains; the cinematic is inserted between hero
  (`</div>` closing `.nb-hero-outer`) and the metrics section.

## Transformed-ancestor check
- The insertion point's ancestors are `<main className="nb-page">` only — no `transform`,
  `filter`, `perspective`, or `will-change` on `.nb-page` (checked `_group.css`). Pin-safe. ✓
- Transforms present in `_group.css` apply to hero-internal elements (book, machinery) and
  the old system section being removed — none are ancestors of the new section.

## Font tokens
- Sans: `"sweet-sans-pro", Arial, sans-serif` (weights 600–800 in use).
- Serif: `"Crimson Pro", Baskerville, serif` (`.nb-serif`).
- Palette tokens on `.nb-page`: `--crimson:#8A292F --earth:#524B3A --gold:#D5AC5C
  --blue:#485696 --egg:#EEE8DC --warm:#FAF8F4 --ink:#100D0B`.

## Files to change / add
1. `artifacts/mockup-sandbox/package.json` — add `gsap`, `@gsap/react`.
2. Copy pack implementation (imports adapted only, no architecture changes) to
   `artifacts/mockup-sandbox/src/components/nobull-redesign/revenue-engine/`:
   `RevenueEngineCinematic.tsx`, `RevenueEngineCinematic.module.css`, `frameLoader.ts`,
   `stageData.ts`, `index.ts`.
3. `artifacts/mockup-sandbox/public/nobull-redesign/revenue-engine/frames/desktop/` — created
   empty. **The 144 WebP frames do not exist yet** (art not produced). The component's built-in
   load-failure state will show; this is the honest, contract-mandated behavior. Frames are NOT
   fabricated.
4. `Homepage.tsx` — replace the `#system` section with:
   `<RevenueEngineCinematic strategyCallHref="/talk" firstChaptersHref="/read/revenue-engine"
   frameBasePath="/nobull-redesign/revenue-engine/frames/desktop" />`

## Routing note
- The sandbox has no router; `/read/revenue-engine` and `/talk` hrefs are preserved verbatim as
  the contract requires. The real routes are wired at graduation into the main app.

## Contract invariants honored
- One pin, 5.6vh scroll length, scrub 0.65, stages at 0/21.5/40/58/78%, no snap.
- Cinematic only on ≥1024px + hover + fine pointer; touch/reduced-motion get the static
  final-frame + stacked stage summaries fallback (handled inside the component via
  `gsap.matchMedia`).
- The pinned element itself is never animated; children only.
