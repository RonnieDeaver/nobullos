// Closing-band ask reveal (Task #4033) — the booking-ask cluster
// is the page's final beat, so it arrives the way the gap band's closer
// does: one once-only rise (rule → sub-line → CTA since Task #5014
// trimmed the duplicate ask heading and the calculator soft line) when
// the cluster scrolls into view. The band's amplification is the STATIC
// design (display-scale H2 + enlarged button); this motion only
// underlines it.
//
// Same motion contract as gapDuel.ts: the generator ships the cluster in
// its COMPLETE final state — with JS disabled nothing here runs, and under
// prefers-reduced-motion the matchMedia block never activates, so both get
// the finished static cluster. No pinning, no scrub; the trigger fires
// once and self-destructs. refreshPriority -1 keeps it refreshing AFTER
// the cinematic's pinned trigger (created later and higher in the page),
// and data-close-anim ("pending" → "done", absent in static mode) mirrors
// data-gap-anim so headless QA can assert the active mode.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export function initClosingAsk(): void {
  const ask = document.querySelector<HTMLElement>("[data-close-ask]");
  if (!ask) return;

  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", () => {
    const parts = Array.from(ask.children) as HTMLElement[];
    if (!parts.length) return;

    ask.dataset.closeAnim = "pending";
    // Hide the shipped final state; matchMedia revert restores it if the
    // preference flips mid-visit.
    gsap.set(parts, { autoAlpha: 0, y: 14 });

    gsap
      .timeline({
        defaults: { ease: "power3.out" },
        scrollTrigger: {
          trigger: ask,
          start: "top 88%",
          once: true,
          refreshPriority: -1,
        },
        onComplete: () => {
          ask.dataset.closeAnim = "done";
        },
      })
      .to(parts, { autoAlpha: 1, y: 0, duration: 0.65, stagger: 0.16 });

    return () => {
      delete ask.dataset.closeAnim;
    };
  });
}
