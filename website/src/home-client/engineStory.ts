// Product-section funnel focus — as the visitor moves through #system, the
// stage nearest the viewport's reading zone is the single warm focal surface.
// The other stages receive a restrained, readable veil. Focus follows the
// normal document scroll in either direction (CaseGen ↔ CaseIntake ↔
// CaseConvert); there is no pinning, scroll-jacking, snapping, or scrubbed
// timeline.
//
// This file REPLACED the #4837/#4923/#4924 engine-story module (entrance
// rises per component section, the sub-450ms diagram line draw, the
// sticky-index active-color tracking, and the customization band's gold
// sweep left with their markup). The exported name stays initEngineStory
// so main.ts wiring is unchanged.
//
// Static contract: the generator ships the COMPLETE, fully readable state.
// JS-off and reduced-motion visitors never receive inline focus variables.
// Only the motion-allowed ScrollTrigger range writes --fn-veil / --fn-lume,
// and leaving that range clears them back to their lit stylesheet fallbacks.
// data-fn-focus is a QA state stamp only; CSS never keys on it. A direct
// component fragment (#casegen / #caseintake / #caseconvert) is the one
// intentional exception to nearest-stage selection: motion-enabled arrivals
// settle that named stage in the reading zone before ordinary scrolling takes
// over. Native fragment arrival remains untouched for reduced-motion and
// JavaScript-disabled visitors.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export function initEngineStory(): void {
  const object = document.querySelector<HTMLElement>("[data-fn-object]");
  if (!object) return;
  const stages = gsap.utils.toArray<HTMLElement>("[data-fn-stage]", object);
  if (stages.length === 0) return;

  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", () => {
    let activeIndex: number | null = null;
    const readingZone = () => window.innerHeight * 0.52;

    const focusStage = (index: number) => {
      if (index === activeIndex) return;
      activeIndex = index;
      object.dataset.fnFocus = stages[index].dataset.fnStage ?? "";
      stages.forEach((stage, stageIndex) => {
        gsap.to(stage, {
          "--fn-veil": stageIndex === index ? 0 : 0.28,
          "--fn-lume": stageIndex === index ? 0.46 : 0,
          duration: 0.32,
          ease: "power2.out",
          overwrite: "auto",
        });
      });
    };

    const reset = () => {
      if (activeIndex === null) return;
      activeIndex = null;
      delete object.dataset.fnFocus;
      gsap.to(stages, {
        "--fn-veil": 0,
        "--fn-lume": 0,
        duration: 0.24,
        ease: "power2.out",
        overwrite: "auto",
      });
    };

    const focusNearestStage = () => {
      const zone = readingZone();
      const nearest = stages.reduce(
        (best, stage, index) => {
          const rect = stage.getBoundingClientRect();
          const distance = Math.abs(rect.top + rect.height / 2 - zone);
          return distance < best.distance ? { distance, index } : best;
        },
        { distance: Number.POSITIVE_INFINITY, index: 0 },
      ).index;
      focusStage(nearest);
    };

    const trigger = ScrollTrigger.create({
      trigger: object,
      start: "top 72%",
      end: "bottom 28%",
      // Focus transitions should re-calculate beneath earlier homepage
      // triggers after fonts and responsive geometry settle.
      refreshPriority: -1,
      onEnter: focusNearestStage,
      onEnterBack: focusNearestStage,
      onUpdate: focusNearestStage,
      onLeave: reset,
      onLeaveBack: reset,
      onRefresh: (self) => {
        if (self.isActive) focusNearestStage();
        else reset();
      },
    });

    const settleFragmentStage = () => {
      const fragment = window.location.hash.slice(1);
      const stageIndex = stages.findIndex((stage) => stage.id === fragment);
      if (stageIndex < 0) return;

      // Native hash arrival puts the target at the viewport top, where the
      // next stage can be nearer the reading zone. Align this explicit
      // navigation once; ordinary scrolling remains fully user-controlled.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const stage = stages[stageIndex];
          const rect = stage.getBoundingClientRect();
          const targetTop = Math.max(
            0,
            window.scrollY + rect.top + rect.height / 2 - readingZone(),
          );
          // The site uses smooth anchor scrolling globally. An explicit
          // component deep link must settle deterministically before the
          // nearest-stage observer runs, including same-document footer
          // clicks made while another smooth scroll is still in flight.
          const root = document.documentElement;
          const previousScrollBehavior = root.style.scrollBehavior;
          root.style.scrollBehavior = "auto";
          window.scrollTo(0, targetTop);
          root.style.scrollBehavior = previousScrollBehavior;
          focusStage(stageIndex);
          ScrollTrigger.update();
        });
      });
    };

    window.addEventListener("hashchange", settleFragmentStage);
    settleFragmentStage();
    // A direct #system arrival can create the trigger while the funnel is
    // already inside its range. ScrollTrigger's initial refresh usually
    // catches this, but a short viewport plus a late native fragment layout
    // can settle one frame later. Re-check once after layout without taking
    // ownership of scrolling.
    const syncInitialRange = () => {
      trigger.refresh();
      if (trigger.isActive) focusNearestStage();
      else reset();
    };
    // Native initial-fragment positioning is allowed to complete after the
    // deferred homepage bundle's first frame. A second frame observes that
    // browser-owned position without changing it.
    let initialSyncFrame = window.requestAnimationFrame(() => {
      initialSyncFrame = window.requestAnimationFrame(syncInitialRange);
    });
    window.addEventListener("load", syncInitialRange, { once: true });

    return () => {
      window.removeEventListener("hashchange", settleFragmentStage);
      window.removeEventListener("load", syncInitialRange);
      window.cancelAnimationFrame(initialSyncFrame);
      trigger.kill();
      gsap.killTweensOf(stages);
      gsap.set(stages, { clearProps: "--fn-veil,--fn-lume" });
      delete object.dataset.fnFocus;
    };
  });
}
