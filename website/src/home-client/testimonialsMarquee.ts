// Part 8 — endless testimonials marquee (Task #3997; retired by the
// #4925 restructure's static curated set, restored verbatim by Task
// #4980 owner reversal).
//
// The served "Hear It From The Firms We Grow." band carries the complete Tom
// Boris featured proof plus the static grid of five video cards + eleven review
// quotes. That markup IS the no-JS / prefers-reduced-motion presentation (site
// animation contract: served markup is the fallback). For motion-allowed
// visitors this module rotates the featured proof, flips the band to
// data-testi-mode="marquee" (home.css keys ALL marquee styling off that
// attribute, never off viewport width), clones each
// [data-marquee-track]'s cards until the track covers the row plus one full
// loop, and drives a time-based, linear, repeat:-1 tween.
//
// Deliberately NO ScrollTriggers here: the Revenue Engine cinematic owns a
// pinned scene higher on the page, and triggers created before an async pin
// go stale on refresh (see .agents/memory scrolltrigger-refresh-order).
// Off-screen rows are paused via IntersectionObserver instead.
//
// Seamlessness: the loop period is the exact rect distance between an
// original card and its first clone twin (one set width + one flex gap), so
// the wrap frame is pixel-identical to frame zero — no rounding seam.
//
// Accessibility:
//   - clones are aria-hidden and every focusable inside them (and any clone
//     that is itself a link) gets tabindex="-1" — keyboard/AT users meet
//     exactly ONE set of cards;
//   - hovering a row or moving focus into it eases the tween to a stop
//     (timeScale → 0) and eases it back on leave;
//   - focusing a card that is currently outside the masked viewport jumps
//     the (pausing) loop so the card is centered — focus is never invisible
//     (WCAG 2.4.7); the browser's native focus-scroll on the overflow:hidden
//     row is reset to keep the transform the only offset;
//   - flipping prefers-reduced-motion mid-visit tears everything down via
//     gsap.matchMedia cleanup and restores the served static grid.

import { gsap } from "gsap";

interface MotionHandle {
  teardown(): void;
  refresh?(): void;
}

/** Seconds to ease the loop to a stop / back to full speed. */
const PAUSE_EASE_SECONDS = 0.5;
/** Safety cap on clone sets (2 is typical: one for coverage, one for wrap). */
const MAX_SETS = 6;
/** A full reading beat before the next featured proof is introduced. */
const FEATURED_ROTATION_MS = 9_000;

interface FeaturedQuote {
  paragraphs: string[];
  name: string;
  attribution: string;
}

function parseFeaturedQuotes(serialized: string | null): FeaturedQuote[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const quote = candidate as Partial<FeaturedQuote>;
      if (
        !Array.isArray(quote.paragraphs) ||
        !quote.paragraphs.every((paragraph) => typeof paragraph === "string") ||
        typeof quote.name !== "string" ||
        typeof quote.attribution !== "string"
      ) {
        return [];
      }
      return [{
        paragraphs: quote.paragraphs,
        name: quote.name,
        attribution: quote.attribution,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * The feature card serves complete Tom Boris proof before this module runs.
 * Motion-enabled visitors receive a gently rotated set; reduced-motion and
 * no-JavaScript visitors keep that deterministic, readable initial state.
 */
function setupFeaturedQuote(featured: HTMLElement): MotionHandle | null {
  const quotes = parseFeaturedQuotes(featured.getAttribute("data-featured-quotes"));
  const content = featured.querySelector<HTMLElement>("[data-featured-content]");
  const copy = featured.querySelector<HTMLElement>("[data-featured-copy]");
  const attribution = featured.querySelector<HTMLElement>("[data-featured-attribution]");
  const toggle = featured.querySelector<HTMLButtonElement>("[data-featured-toggle]");
  if (quotes.length < 2 || !content || !copy || !attribution || !toggle) return null;

  let index = 0;
  let userPaused = false;
  let hovered = false;
  let contentFocused = false;
  let inView = true;
  let pageVisible = !document.hidden;
  let timer: number | undefined;
  let transition: gsap.core.Timeline | null = null;

  const render = (quote: FeaturedQuote) => {
    copy.replaceChildren(
      ...quote.paragraphs.map((paragraph) => {
        const element = document.createElement("p");
        element.textContent = `"${paragraph}"`;
        return element;
      }),
    );
    attribution.textContent = `— ${quote.name}, ${quote.attribution}`;
    featured.setAttribute("data-featured-index", String(index));
  };

  // Reserve the tallest approved entry before rotation starts, so swapping
  // client proof never moves the marquee rows below it.
  const measureHeight = () => {
    featured.style.removeProperty("--featured-quote-min-height");
    const originalVisibility = content.style.visibility;
    content.style.visibility = "hidden";
    let maxHeight = 0;
    for (const quote of quotes) {
      render(quote);
      maxHeight = Math.max(maxHeight, content.getBoundingClientRect().height);
    }
    render(quotes[index]!);
    content.style.visibility = originalVisibility;
    if (maxHeight > 0) {
      featured.style.setProperty("--featured-quote-min-height", `${Math.ceil(maxHeight)}px`);
    }
  };

  const pauseReason = () => {
    if (userPaused) return "user";
    if (!pageVisible) return "page-hidden";
    if (!inView) return "offscreen";
    if (hovered) return "hover";
    if (contentFocused) return "focus";
    return null;
  };

  const clearTimer = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };

  const updateControl = () => {
    toggle.setAttribute("aria-pressed", String(userPaused));
    toggle.textContent = userPaused ? "Resume rotation" : "Pause rotation";
    toggle.setAttribute(
      "aria-label",
      userPaused
        ? "Resume featured client quote rotation"
        : "Pause featured client quote rotation",
    );
  };

  const stopTransition = () => {
    if (!transition) return;
    transition.kill();
    transition = null;
    gsap.set(content, { clearProps: "opacity,visibility,transform" });
  };

  const advance = () => {
    timer = undefined;
    if (pauseReason()) return;
    transition = gsap
      .timeline({
        onComplete: () => {
          transition = null;
          gsap.set(content, { clearProps: "opacity,visibility,transform" });
          syncPlayState();
        },
      })
      .to(content, {
        autoAlpha: 0,
        y: -4,
        duration: 0.18,
        ease: "power1.in",
      })
      .add(() => {
        index = (index + 1) % quotes.length;
        render(quotes[index]!);
      })
      .fromTo(
        content,
        { autoAlpha: 0, y: 4 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.28,
          ease: "power2.out",
        },
      );
  };

  const syncPlayState = () => {
    clearTimer();
    const reason = pauseReason();
    if (reason) {
      featured.setAttribute("data-featured-paused", reason);
      stopTransition();
      return;
    }
    featured.removeAttribute("data-featured-paused");
    if (!transition) timer = window.setTimeout(advance, FEATURED_ROTATION_MS);
  };

  const onMouseEnter = () => {
    hovered = true;
    syncPlayState();
  };
  const onMouseLeave = () => {
    hovered = false;
    syncPlayState();
  };
  const onFocusIn = () => {
    contentFocused = true;
    syncPlayState();
  };
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && featured.contains(event.relatedTarget)) return;
    contentFocused = false;
    syncPlayState();
  };
  const onToggle = () => {
    userPaused = !userPaused;
    // Explicit Resume is stronger than the passive focus pause. Keyboard
    // focus stays on the control, but this activation restarts the cadence;
    // tabbing away and back establishes a fresh focus pause.
    if (!userPaused) contentFocused = false;
    updateControl();
    syncPlayState();
  };
  const onVisibilityChange = () => {
    pageVisible = !document.hidden;
    syncPlayState();
  };

  featured.addEventListener("mouseenter", onMouseEnter);
  featured.addEventListener("mouseleave", onMouseLeave);
  featured.addEventListener("focusin", onFocusIn);
  featured.addEventListener("focusout", onFocusOut);
  toggle.addEventListener("click", onToggle);
  document.addEventListener("visibilitychange", onVisibilityChange);

  const observer = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      syncPlayState();
    },
    { threshold: 0.05 },
  );
  observer.observe(featured);

  measureHeight();
  toggle.hidden = false;
  featured.setAttribute("data-featured-ready", "1");
  updateControl();
  syncPlayState();

  return {
    refresh: measureHeight,
    teardown() {
      clearTimer();
      stopTransition();
      observer.disconnect();
      featured.removeEventListener("mouseenter", onMouseEnter);
      featured.removeEventListener("mouseleave", onMouseLeave);
      featured.removeEventListener("focusin", onFocusIn);
      featured.removeEventListener("focusout", onFocusOut);
      toggle.removeEventListener("click", onToggle);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      index = 0;
      render(quotes[index]!);
      toggle.hidden = true;
      featured.style.removeProperty("--featured-quote-min-height");
      featured.removeAttribute("data-featured-ready");
      featured.removeAttribute("data-featured-paused");
    },
  };
}

function setupRow(row: HTMLElement): MotionHandle | null {
  const track = row.querySelector<HTMLElement>("[data-marquee-track]");
  if (!track) return null;
  const originals = Array.from(track.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  if (originals.length === 0) return null;

  const reverse = row.hasAttribute("data-marquee-reverse");
  // Pixels per second; data-marquee-speed lets the videos row drift faster
  // than the denser quote rows.
  const speed = Math.max(8, Number(row.getAttribute("data-marquee-speed")) || 30);

  const cloneSet = (): HTMLElement[] =>
    originals.map((source) => {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.setAttribute("aria-hidden", "true");
      clone.setAttribute("data-marquee-clone", "");
      if (clone.matches("a[href],button,[tabindex]")) clone.setAttribute("tabindex", "-1");
      clone
        .querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[tabindex]")
        .forEach((focusable) => focusable.setAttribute("tabindex", "-1"));
      return clone;
    });

  // First clone set doubles as the period ruler: rect distance from an
  // original to its clone twin = one set width + one flex gap, exact even
  // with fractional card widths.
  const clones = cloneSet();
  clones.forEach((clone) => track.appendChild(clone));
  const period = clones[0].getBoundingClientRect().left - originals[0].getBoundingClientRect().left;
  if (period <= 0) {
    clones.forEach((clone) => clone.remove());
    return null;
  }

  // Cover the row viewport plus one period so every x in [-period, 0] shows
  // a full window of cards.
  let sets = 2;
  while (track.scrollWidth < row.clientWidth + period && sets < MAX_SETS) {
    const more = cloneSet();
    more.forEach((clone) => track.appendChild(clone));
    clones.push(...more);
    sets += 1;
  }

  const tween = reverse
    ? gsap.fromTo(
        track,
        { x: -period },
        { x: 0, duration: period / speed, ease: "none", repeat: -1 },
      )
    : gsap.fromTo(
        track,
        { x: 0 },
        { x: -period, duration: period / speed, ease: "none", repeat: -1 },
      );

  let hovered = false;
  let focused = false;
  let inView = true;

  const syncPlayState = () => {
    if (!inView) {
      tween.pause();
      return;
    }
    if (tween.paused()) tween.play();
    gsap.to(tween, {
      timeScale: hovered || focused ? 0 : 1,
      duration: PAUSE_EASE_SECONDS,
      ease: "power1.out",
      overwrite: true,
    });
  };

  const ensureFocusVisible = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    const card = originals.find((item) => item === target || item.contains(target));
    if (!card) return;
    // Focus makes browsers scroll the nearest scroll container even when it
    // is overflow:hidden — undo that so the tween's transform stays the only
    // horizontal offset.
    row.scrollLeft = 0;
    const rowRect = row.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (cardRect.left >= rowRect.left - 1 && cardRect.right <= rowRect.right + 1) return;
    const currentX = Number(gsap.getProperty(track, "x")) || 0;
    const layoutLeft = cardRect.left - trackRect.left; // transform-independent
    const trackLayoutLeft = trackRect.left - currentX;
    let desiredX = rowRect.left + (rowRect.width - cardRect.width) / 2 - trackLayoutLeft - layoutLeft;
    desiredX = -(((-desiredX % period) + period) % period); // wrap into (-period, 0]
    const progress = reverse ? 1 + desiredX / period : -desiredX / period;
    tween.progress(((progress % 1) + 1) % 1);
  };

  const onMouseEnter = () => {
    hovered = true;
    syncPlayState();
  };
  const onMouseLeave = () => {
    hovered = false;
    syncPlayState();
  };
  const onFocusIn = (event: FocusEvent) => {
    focused = true;
    syncPlayState();
    ensureFocusVisible(event.target);
  };
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
    focused = false;
    syncPlayState();
  };
  row.addEventListener("mouseenter", onMouseEnter);
  row.addEventListener("mouseleave", onMouseLeave);
  row.addEventListener("focusin", onFocusIn);
  row.addEventListener("focusout", onFocusOut);

  // Don't burn main-thread time animating rows nobody can see.
  const observer = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      syncPlayState();
    },
    { rootMargin: "160px 0px" },
  );
  observer.observe(row);

  row.setAttribute("data-marquee-ready", "1");

  return {
    teardown() {
      observer.disconnect();
      row.removeEventListener("mouseenter", onMouseEnter);
      row.removeEventListener("mouseleave", onMouseLeave);
      row.removeEventListener("focusin", onFocusIn);
      row.removeEventListener("focusout", onFocusOut);
      gsap.killTweensOf(tween); // any in-flight timeScale ease
      tween.kill();
      clones.forEach((clone) => clone.remove());
      gsap.set(track, { clearProps: "transform" });
      row.scrollLeft = 0;
      row.removeAttribute("data-marquee-ready");
    },
  };
}

export function initTestimonialsMarquee(): void {
  const band = document.querySelector<HTMLElement>(".nb-testimonials");
  if (!band) return;
  const rows = Array.from(band.querySelectorAll<HTMLElement>("[data-marquee]"));
  const featured = band.querySelector<HTMLElement>("[data-featured-testimonial]");

  const media = gsap.matchMedia();
  media.add(
    {
      motionOK: "(prefers-reduced-motion: no-preference)",
      reduced: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const { motionOK } = context.conditions as { motionOK: boolean };
      band.setAttribute("data-testi-mode", motionOK ? "marquee" : "static");
      if (!motionOK) return;

      const featuredHandle = featured ? setupFeaturedQuote(featured) : null;
      let handles: MotionHandle[] = [];
      const build = () => {
        handles = rows
          .map((row) => setupRow(row))
          .filter((handle): handle is MotionHandle => handle !== null);
      };
      const dismantle = () => {
        handles.forEach((handle) => handle.teardown());
        handles = [];
      };
      build();

      // Rebuild on real width changes only — mobile URL-bar collapse fires
      // height-only resizes (same reasoning as ignoreMobileResize in main.ts).
      let lastWidth = window.innerWidth;
      let resizeTimer: number | undefined;
      const onResize = () => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          dismantle();
          build();
          featuredHandle?.refresh?.();
        }, 250);
      };
      window.addEventListener("resize", onResize);

      return () => {
        window.clearTimeout(resizeTimer);
        window.removeEventListener("resize", onResize);
        dismantle();
        featuredHandle?.teardown();
        band.removeAttribute("data-testi-mode");
      };
    },
  );
}
