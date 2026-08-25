// Client bundle for the redesigned nobullmarketing.com homepage.
//
// Bundled by website/generate.ts (esbuild, iife) into
// website/public/assets/js/home.js — loaded ONLY by the homepage.
//
// Part 1 is the product-section funnel scroll focus (engineStory.ts,
// Task #4992 — the owner funnel brief that REPLACED the #4837/#4923/
// #4924 engine story: the per-component entrance rises, diagram line
// draw, sticky-index color tracking, and customization-band gold sweep
// left with their markup; before that, #4837 had already removed the
// pinned Revenue Engine cinematic). What remains for #system is a
// reversible ScrollTrigger focus treatment: the stage nearest the reading
// zone warms while its peers gently recede, then resets outside the funnel
// range. Direct #casegen / #caseintake / #caseconvert arrivals settle their
// named stage into that same zone. No traveling leads, loops, particles,
// pinning, snapping, or scrubbed timelines. The served markup is the complete
// FULLY-LIT final state: JS-off and reduced-motion visitors never see a
// dimmed stage.
//
// Part 2 wires the shared mobile-nav + inquiry-form modules from
// website/src/client-shared/ — the SAME source the subpage bundle
// (assets/js/site.js, built from website/src/site-client/main.ts)
// compiles in, so homepage and subpage behavior cannot drift (PR5).
//
// Part 3 is the Million Dollar Gap duel reveal (gapDuel.ts, Task #3904):
// small once-only ScrollTriggers, gated on prefers-reduced-motion, never
// pinned.
//
// Part 4 (statsBand.ts, Task #3907) is the credibility band's once-only
// scroll count-up — fully independent ScrollTriggers; nothing on the page
// pins since Task #4837.
//
// The proof band's #3915 case-study slider retired with Task #4925 (owner
// brief §7): that band serves static markup with NO client module — the
// flagship case study + supports are complete as rendered for every
// visitor. (The same restructure had retired the testimonials band's
// #3997 endless marquee; Task #4980 restored it as Part 8 below.)
//
// The final conversion close is intentionally static: it now contains the
// real booking and contact actions rather than a separate booking-ask
// cluster, so it does not add another motion moment.
//
// The REE scoreboard strip's once-on-entry rise (formerly Part 5,
// reeReveal.ts, Task #4166) retired with Task #4987: the owner removed
// the strip band wholesale — the homepage carries zero REE mentions
// now — so the module is deleted, like the team band's endless wall
// below.
//
// Part 6 (teamReveal.ts, Task #5011) is the team band's collapsed-grid
// disclosure. The #4979 endless vertical wall (teamWall.ts — the
// resurrected #4903 module) is RETIRED on the owner's verdict that it
// didn't look good, so the band never scrolls or drifts for anyone now:
// the served 18-card grid is the complete presentation for every
// visitor, and the module just collapses it to its first two rows per
// breakpoint behind an accessible Meet the Full Team toggle (native
// button, aria-expanded announced; no GSAP, no ScrollTrigger — the
// expand rise is reduced-motion-gated CSS in home.css).
//
// Part 7 (testimonialsMarquee.ts, Task #3997) is the testimonials band's
// endless video/quote marquee — retired by Task #4925's static curated
// set, restored by Task #4980 (owner reversal: five video cards + eleven
// review quotes drift on forever again). Time-based repeat:-1 tweens with
// IntersectionObserver visibility pausing, zero ScrollTriggers; no-JS and
// reduced-motion visitors keep the served static grids.

import { captureAttribution } from "../client-shared/attribution";
import { initInquiryForms } from "../client-shared/inquiry";
import { initMobileNav } from "../client-shared/nav";
import { initReeHandoffPrefill } from "../client-shared/reeHandoff";
import { initEngineStory } from "./engineStory";
import { initGapDuel } from "./gapDuel";
import { initStatsBand } from "./statsBand";
import { initTeamReveal } from "./teamReveal";
import { initTestimonialsMarquee } from "./testimonialsMarquee";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// Touch tuning (kept from Task #3788 for the active ScrollTriggers):
// mobile browsers fire resize while the URL bar collapses/expands
// mid-scroll; letting those force a ScrollTrigger.refresh would shift the
// once-only start lines under the reader. Real dimension changes
// (orientation) still refresh.
ScrollTrigger.config({ ignoreMobileResize: true });

function init(): void {
  initEngineStory();
  initGapDuel();
  initStatsBand();
  initTestimonialsMarquee();
  initTeamReveal();
  // Task #4337 — persist first-touch utm/referrer before anything else so
  // a later form submission on any page can attach it.
  captureAttribution();
  initMobileNav();
  initInquiryForms();
  initReeHandoffPrefill();

  // Webfont swap (Typekit Sweet Sans + Crimson Pro) can grow text sections by
  // hundreds of px AFTER ScrollTrigger caches its trigger positions at load,
  // leaving every start line (stats-band count-up and funnel focus) stale-early —
  // measured ~800px drift on a cold cache. One safe recalibration once fonts
  // settle; ignoreMobileResize above still guards the mid-scroll URL-bar case.
  if ("fonts" in document) {
    void document.fonts.ready.then(() => ScrollTrigger.refresh());
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
