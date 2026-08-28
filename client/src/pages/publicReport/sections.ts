/**
 * Report section index — single source for the deck's anchor targets
 * (Task #4275, audit §8.7-2).
 *
 * SLIDE_LABELS maps every slide id rendered in PublicReport.tsx to the short
 * label the mobile progress strip shows; AGENDA_ROWS drives the roadmap's
 * anchor-link rows (headline + one-line "what you'll learn"). Ids must match
 * the `id=` attributes the slide components render — the agenda jump links
 * and the ≤768px strip both resolve through here.
 */

import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";

export const SLIDE_LABELS: Record<string, string> = {
  cover: "Cover",
  agenda: "Roadmap",
  "ceo-pulse": "The NoBull Brief",
  "market-context": "Market Context",
  "engine-health": "Engine Health",
  intake: "Intake Deep Dive",
  sales: "Sales Deep Dive",
  marketing: "Marketing Deep Dive",
  closing: "Revenue Leak Analysis",
  "lifetime-value": "Lifetime Value",
  "next-30-days": "Next 30 Days",
  "book-promo": "The Book",
};

/**
 * Slide numbering for the deck (Task #4277 — extracted from PublicReport so
 * the drop-a-slide renumbering is a pure, testable rule). A slide absent
 * from the deck gets 0 and every later slide shifts up — the rendered deck
 * never shows a numbering gap.
 *
 * Order mirrors the rendered deck: the deep dives run Marketing → Intake →
 * Sales (funnel order — marketing generates leads, intake converts them,
 * sales closes; Task #4522) and the book promo sits AFTER Next 30 Days
 * as the closing colophon (Task #4284, audit backlog #8).
 */
export function computeSlideNumbers(flags: { hasCeoPulse: boolean; hasMarketContext: boolean }) {
  let n = 2;
  return {
    title: 1,
    roadmap: 2,
    ceoPulse: flags.hasCeoPulse ? ++n : 0,
    marketContext: flags.hasMarketContext ? ++n : 0,
    engineHealth: ++n,
    marketing: ++n,
    intake: ++n,
    sales: ++n,
    lossAudit: ++n,
    lifetimeValue: ++n,
    next30: ++n,
    bookPromo: ++n,
  };
}

export interface AgendaRow {
  /** Slide id this row jumps to — must exist in the rendered deck. */
  target: string;
  headline: string;
  /** One-line "what you'll learn" (§8.7-2). */
  learn: string;
}

export const AGENDA_ROWS: AgendaRow[] = [
  {
    target: "ceo-pulse",
    headline: "The NoBull Brief",
    learn: "The month in plain English — what mattered most and why.",
  },
  {
    target: "market-context",
    headline: "Market Context",
    learn: "Where seasonal demand stands and how it shapes this month's plan.",
  },
  {
    target: "engine-health",
    headline: "Engine Health",
    learn: "How Marketing, Intake & Sales are performing as one system.",
  },
  {
    target: "marketing",
    headline: "Revenue Engine Deep Dives",
    learn: "The numbers behind each stage: Marketing, Intake, then Sales.",
  },
  {
    target: "closing",
    headline: "Revenue Leak Analysis",
    learn: "Where revenue is slipping away and what recovering it is worth.",
  },
  {
    target: "lifetime-value",
    headline: "Relationship Lifetime Value",
    learn: "What each client relationship is worth to your firm over time.",
  },
  {
    target: "next-30-days",
    headline: "Next 30 Days",
    learn: "The actions we're taking — and the ones we need from you.",
  },
];

/**
 * Scroll a slide into view, applying its CSS scroll-margin-top manually.
 *
 * Chromium ignores a scroll target's own scroll-margin when the target
 * establishes a scroll container — and every .slide section is
 * overflow-hidden (that clipping does real containment work; see audit #21)
 * — so default anchor navigation lands slides flush under the sticky bar.
 * The href is kept for semantics (middle-click, copy link, no-JS); this
 * handler takes over the in-page jump. Enter on a focused link fires click,
 * so keyboard operability rides the same path.
 */
export function jumpToSlide(e: { preventDefault: () => void }, target: string): void {
  const el = document.getElementById(target);
  if (!el) return; // let native anchor behavior have a go
  e.preventDefault();
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const top = el.getBoundingClientRect().top + window.scrollY - margin;
  window.scrollTo({ top, behavior: motionSafeScrollBehavior() });
  // Skip redundant history entries when re-clicking the slide we're already
  // on, and never let the address-bar hash update crash the deck: Safari and
  // Chromium throw a SecurityError once pushState is called >100 times in
  // 10s (e.g. rapid repeated taps or an automated browser mashing agenda
  // links), which was propagating uncaught into GlobalErrorBoundary and
  // taking down the whole report with "Something went wrong."
  if (window.location.hash !== `#${target}`) {
    try {
      history.pushState(null, "", `#${target}`);
    } catch {
      // Cosmetic URL update only — the scroll above already happened.
    }
  }
}
