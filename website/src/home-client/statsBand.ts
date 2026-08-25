// Scroll-triggered count-up for the homepage credibility band (Task #3907).
//
// The served HTML always carries the FINAL figures — "1,000,000", "30,000",
// … — plus a visually-hidden copy of each complete stat (".nb-vh"), so
// no-JS and prefers-reduced-motion visitors get the finished band exactly
// as committed (the site's static-fallback convention). This module only
// ever rewrites the aria-hidden digit spans, and only when motion is
// allowed.
//
// Behavior:
//   - ARM shortly before the band scrolls in (start "top 140%"): pin each
//     figure's final width as a ch min-width derived from its formatted
//     digit count (the digits are right-aligned tabular inline-blocks per
//     home.css, hugging the static gold "+"), then blank to 0 — geometry
//     is frozen so nothing shifts while digit counts change. ch beats a
//     measured px width because the band sits above the fold since Task
//     #4261: arm() can run at DOMContentLoaded, before webfonts land, and
//     a px width frozen from fallback-font metrics left a visible gap
//     between the band's static "$" prefix and the digits once Crimson
//     Pro swapped in. Tabular digits are exactly 1ch; commas are narrower,
//     so comma'd figures only ever reserve harmless extra space on the
//     right-aligned column's invisible left edge.
//   - PLAY once on first entry (start "top 88%", once: true): staggered
//     per-stat count-ups sweep 0 → final with en-US comma grouping; each
//     gold "+" stamps in as its figure settles; labels rise in behind.
//   - A mid-visit prefers-reduced-motion flip jumps straight to the
//     finished band.
//   - Standalone ScrollTriggers only — the Revenue Engine cinematic's
//     pinned scene (Part 1 of main.ts) is never touched. Both triggers
//     carry refreshPriority: -1: ScrollTrigger refreshes triggers in
//     CREATION order unless at least one trigger declares a
//     refreshPriority (only that flag switches refreshes to sorted page
//     order — see _sort in ScrollTrigger's _refreshAll). When this band
//     sat BELOW the cinematic, that was load-bearing — these triggers
//     exist from DOMContentLoaded, but the pin's ~5040px spacer registers
//     later (first-frame decode), so refreshes measured the band ~5000px
//     stale without it. Task #4261 moved the band ABOVE the pin (after
//     the press strip), where its start no longer depends on the spacer;
//     the priority stays as belt-and-braces for any future reshuffle.
//     Task #4816 merged the press strip + metrics into the single
//     credibility rail (.nb-cred) directly under the hero — still above
//     the pin; the [data-stats-band] hook and .nb-metric cells moved onto
//     that band unchanged, so this module needed no code change.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

interface MetricCell {
  digits: HTMLElement | null;
  target: number;
  plus: HTMLElement | null;
  label: HTMLElement | null;
}

const COUNT_SECONDS = 1.9;
const STAGGER_SECONDS = 0.16;

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function initStatsBand(): void {
  const band = document.querySelector<HTMLElement>("[data-stats-band]");
  if (!band) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduceMotion.matches) return; // served static band stays as-is

  gsap.registerPlugin(ScrollTrigger); // no-op if Part 1 already did

  const cells: MetricCell[] = gsap.utils
    .toArray<HTMLElement>(".nb-metric", band)
    .map((cell) => {
      const digits = cell.querySelector<HTMLElement>("[data-count-to]");
      const target = Number(digits?.dataset.countTo);
      return {
        digits,
        target: Number.isFinite(target) && target > 0 ? target : 0,
        plus: cell.querySelector<HTMLElement>(".nb-metric-plus"),
        label: cell.querySelector<HTMLElement>(".nb-metric-label"),
      };
    });
  if (!cells.length) return;

  let armed = false;
  let timeline: gsap.core.Timeline | null = null;

  const arm = (): void => {
    if (armed) return;
    armed = true;
    for (const cell of cells) {
      if (cell.digits && cell.target > 0) {
        // Freeze the final width so the column never moves as "0" grows
        // back into "1,000,000" (digits right-align against the "+").
        // Width comes from the formatted digit count in ch — never a px
        // measurement, which goes stale when arm() beats the webfonts
        // (see header): "150" comes out exact, so the "$" hugs the "1".
        cell.digits.style.minWidth = `${formatCount(cell.target).length}ch`;
        gsap.set(cell.digits, { autoAlpha: 0 });
        cell.digits.textContent = "0";
      }
      if (cell.plus) gsap.set(cell.plus, { autoAlpha: 0, y: 6 });
      if (cell.label) gsap.set(cell.label, { autoAlpha: 0, y: 10 });
    }
  };

  const play = (): void => {
    arm(); // both triggers can fire in the same refresh — arm() is idempotent
    timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
    cells.forEach((cell, index) => {
      const at = index * STAGGER_SECONDS;
      if (cell.digits && cell.target > 0) {
        const digits = cell.digits;
        const state = { value: 0 };
        timeline!.to(digits, { autoAlpha: 1, duration: 0.3, ease: "none" }, at);
        timeline!.to(
          state,
          {
            value: cell.target,
            duration: COUNT_SECONDS,
            onUpdate: () => {
              digits.textContent = formatCount(state.value);
            },
          },
          at,
        );
      }
      if (cell.plus) {
        // The "+" stamps in as its figure settles (space was reserved at
        // arm time via autoAlpha, so nothing shifts).
        timeline!.to(
          cell.plus,
          { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out" },
          at + (cell.target > 0 ? COUNT_SECONDS - 0.55 : 0.1),
        );
      }
      if (cell.label) {
        timeline!.to(
          cell.label,
          { autoAlpha: 1, y: 0, duration: 0.7, ease: "expo.out" },
          at + 0.35,
        );
      }
    });
  };

  const approachTrigger = ScrollTrigger.create({
    trigger: band,
    start: "top 140%",
    once: true,
    refreshPriority: -1, // refresh AFTER the later-registered pin above (see header)
    onEnter: arm,
  });
  const playTrigger = ScrollTrigger.create({
    trigger: band,
    start: "top 88%",
    once: true,
    refreshPriority: -1,
    onEnter: play,
  });

  const finishStatic = (): void => {
    approachTrigger.kill();
    playTrigger.kill();
    if (timeline) {
      timeline.progress(1).kill();
      timeline = null;
      return;
    }
    for (const cell of cells) {
      if (cell.digits && cell.target > 0) {
        cell.digits.textContent = formatCount(cell.target);
        cell.digits.style.minWidth = "";
      }
      const parts = [cell.digits, cell.plus, cell.label].filter(
        (el): el is HTMLElement => el !== null,
      );
      if (parts.length) {
        gsap.set(parts, { clearProps: "opacity,visibility,transform" });
      }
    }
  };

  // Mid-visit reduced-motion flip: jump straight to the finished band.
  if (typeof reduceMotion.addEventListener === "function") {
    reduceMotion.addEventListener("change", (event) => {
      if (event.matches) finishStatic();
    });
  }
}
