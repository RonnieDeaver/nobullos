/* test-registration
{
  "name": "Homepage testimonials marquee motion behavior (Task #4999)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 18.1s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 300000,
  "scanPaths": [
    "website/public",
    "website/src/home-client/testimonialsMarquee.ts"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #4999 — Automated regression guard for the homepage testimonials marquee.
 *
 * Context: Task #4980 restored the endless-marquee band (5 video cards +
 * 11 review quotes in three [data-marquee] rows).  Manual headless QA verified
 * the motion behavior at the time, but no automated test was committed.  A
 * future rename of the data-testi-mode attribute, a CSS class change, or a
 * drift in the clone logic would regress silently.
 *
 * What this suite asserts:
 *
 *   Motion-allowed visitors (prefers-reduced-motion: no-preference):
 *     1. Band carries data-testi-mode="marquee" after the module initialises.
 *     2. Each row's track transform advances over time (tween is running).
 *     3. Quote row B counter-scrolls: its x-delta is opposite in sign to row A.
 *     4. Clone-twin geometry: dist(original[i] → clone[i]) is uniform across
 *        all originals in the video row (<0.6 px spread), proving the seamless
 *        wrap frame is pixel-identical to frame zero.
 *     5. Hovering a row eases the tween to a stop (|Δx| < 1.5 px over 500 ms
 *        after a 1.2 s hover dwell — 2.4× the PAUSE_EASE_SECONDS constant).
 *     6. Focusing a video card:
 *          • row.scrollLeft resets to 0 (the module's focus-scroll undo)
 *          • the focused card's rect is within the row's visible rect
 *          • the tween is eased to a stop (same tolerance as hover)
 *     7. The featured quote begins on Tom Boris, advances as an atomic
 *        quote/attribution pair, pauses for hover and explicit control, and
 *        resumes on request without changing the card's height.
 *     8. Tabbable count inside the band = 6 (the pause control + five original
 *        video anchors); clones carry aria-hidden + tabindex="-1" so
 *        keyboard/AT users see exactly one card set.
 *
 *   Reduced-motion visitors (prefers-reduced-motion: reduce):
 *     9. Band carries data-testi-mode="static" — marquee never activates.
 *    10. Exactly 5 .nb-video-card elements are present (no clones).
 *    11. Exactly 11 .nb-review elements are present (no clones).
 *    12. Zero [data-marquee-clone] elements exist.
 *    13. Zero [data-marquee-ready] attributes exist.
 *    14. Reduced-motion and no-JavaScript pages retain Tom Boris as their
 *        readable static featured proof, without an active control.
 *
 * Harness notes:
 *   - Spins up the in-process marketing-site express server (committed bundle).
 *   - External hosts (Typekit, Vimeo, etc.) are aborted for determinism.
 *   - The IO-pause gotcha (memory: testimonials-marquee-qa.md): the module's
 *     IntersectionObserver (rootMargin 160px) pauses off-screen rows.  This
 *     suite scrolls each row into view and waits for IO to fire before
 *     taking any drift readings.
 *   - Seam proof uses geometry, not live wrap observation: wrap periods run
 *     ~45 s+, so we compare clone distances instead of waiting for a wrap.
 */

import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";

// ---------------------------------------------------------------------------
// Counts for served-markup assertions (must stay in sync with home.ts arrays)
// ---------------------------------------------------------------------------
const EXPECTED_VIDEO_CARDS = 5; // VIDEO_TESTIMONIALS.length
const EXPECTED_QUOTE_CARDS = 11; // QUOTE_ROW_A (6) + QUOTE_ROW_B (5)
const EXPECTED_TABBABLE_ORIGINALS = EXPECTED_VIDEO_CARDS + 1; // pause control + anchors
const FEATURED_WAIT_MS = 10_000; // 9 s cadence + transition/test scheduling margin

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  const nixPath =
    "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
  if (fs.existsSync(nixPath)) return nixPath;
  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const p = execSync(`which ${bin}`, { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

/**
 * Parse the CSS transform matrix on an element and return its translateX value
 * in pixels.  GSAP 3 writes translate3d() inline; getComputedStyle normalises
 * it to matrix() or matrix3d().
 */
const GET_TRANSLATE_X_FN = `
function getTranslateX(el) {
  const t = window.getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m3 = t.match(/matrix3d\\(([^)]+)\\)/);
  if (m3) { const v = m3[1].split(',').map(Number); return v[12]; }
  const m2 = t.match(/matrix\\(([^)]+)\\)/);
  if (m2) { const v = m2[1].split(',').map(Number); return v[4]; }
  return 0;
}
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Motion-allowed assertions
// ---------------------------------------------------------------------------

async function runMotionAllowedTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— Motion-allowed run —");

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });

  // Wait for all three marquee rows to initialise (data-marquee-ready).
  await page
    .waitForFunction(
      () => document.querySelectorAll("[data-marquee-ready]").length >= 3,
      { timeout: 15_000 },
    )
    .catch(() => {
      /* If it times out we'll still attempt the assertions below — they'll
         produce clearer failure messages than a thrown timeout. */
    });

  // 1. Band mode attribute
  const mode = await page.evaluate(
    () =>
      document
        .querySelector(".nb-testimonials")
        ?.getAttribute("data-testi-mode") ?? null,
  );
  assert(
    mode === "marquee",
    `data-testi-mode="marquee" on .nb-testimonials (got: ${JSON.stringify(mode)})`,
  );
  const featuredToggleHeight = await page.$eval(
    ".nb-featured-testimonial-toggle",
    (element) => (element as HTMLElement).getBoundingClientRect().height,
  );
  assert(
    featuredToggleHeight >= 44,
    `featured testimonial motion control has a 44px touch target (${featuredToggleHeight.toFixed(1)}px)`,
  );

  // Scroll the testimonials section into view so IntersectionObserver marks
  // all three rows as inView=true before we take any drift readings.
  await page.evaluate(() => {
    const el = document.querySelector(".nb-testimonials");
    if (el) el.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await sleep(400); // give IO (rootMargin 160px) time to fire

  // Helper: read translateX of a track element (identified by its row class).
  const getX = (rowSelector: string): Promise<number> =>
    page.evaluate(
      ([sel, fn]: [string, string]) => {
        /* eslint-disable no-new-func */
        const getTranslateX = new Function(
          `${fn}; return getTranslateX(arguments[0]);`,
        ) as (el: Element) => number;
        const row = document.querySelector(sel);
        const track = row?.querySelector("[data-marquee-track]");
        return track ? getTranslateX(track) : 0;
      },
      [rowSelector, GET_TRANSLATE_X_FN] as [string, string],
    );

  // 2 & 3. Drift and direction for all three rows.
  const SAMPLE_WAIT_MS = 700; // at 27 px/s → ~19 px; at 44 px/s → ~31 px

  // Video row (forward direction: x goes 0 → -period)
  await page.evaluate(() => {
    const row = document.querySelector(".nb-marquee-videos");
    if (row) row.scrollIntoView({ block: "center", behavior: "instant" });
  });
  // Keep the baseline genuinely neutral: scrolling can move the row beneath
  // Chromium's implicit pointer position and synthesize mouseenter.
  await page.mouse.move(10, 10);
  await sleep(300);
  const vx1 = await getX(".nb-marquee-videos");
  await sleep(SAMPLE_WAIT_MS);
  const vx2 = await getX(".nb-marquee-videos");
  const vDelta = vx2 - vx1;
  assert(Math.abs(vDelta) > 5, `video row track drifts over ${SAMPLE_WAIT_MS} ms (Δx=${vDelta.toFixed(1)} px)`);
  assert(
    vDelta < 0,
    `video row moves in forward direction (x decreases; Δx=${vDelta.toFixed(1)} px)`,
  );

  // Quote row A (forward direction)
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".nb-marquee-quotes");
    if (rows[0]) (rows[0] as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(300);
  const ax1 = await getX(".nb-marquee-quotes:not([data-marquee-reverse])");
  await sleep(SAMPLE_WAIT_MS);
  const ax2 = await getX(".nb-marquee-quotes:not([data-marquee-reverse])");
  const aDelta = ax2 - ax1;
  assert(Math.abs(aDelta) > 5, `quote row A track drifts over ${SAMPLE_WAIT_MS} ms (Δx=${aDelta.toFixed(1)} px)`);
  assert(aDelta < 0, `quote row A moves in forward direction (Δx=${aDelta.toFixed(1)} px)`);

  // Quote row B (reverse: x goes -period → 0, so x increases)
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".nb-marquee-quotes");
    if (rows[1]) (rows[1] as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(300);
  const bx1 = await getX("[data-marquee-reverse]");
  await sleep(SAMPLE_WAIT_MS);
  const bx2 = await getX("[data-marquee-reverse]");
  const bDelta = bx2 - bx1;
  assert(Math.abs(bDelta) > 5, `quote row B track drifts over ${SAMPLE_WAIT_MS} ms (Δx=${bDelta.toFixed(1)} px)`);
  assert(bDelta > 0, `quote row B moves opposite row A — reverse direction (Δx=${bDelta.toFixed(1)} px)`);
  // Confirm A and B are opposite in sign
  assert(
    aDelta < 0 && bDelta > 0,
    `row A and row B drift in opposite directions (A Δx=${aDelta.toFixed(1)}, B Δx=${bDelta.toFixed(1)})`,
  );

  // 4. Clone-twin geometry on the video row (seam proof).
  // Distance from original[i] to clone[i] must be uniform (<0.6 px spread).
  const cloneGeom = await page.evaluate(() => {
    const track = document.querySelector(
      ".nb-marquee-videos [data-marquee-track]",
    );
    if (!track) return { ok: false, spread: 0, msg: "track not found" };
    const children = Array.from(track.children) as HTMLElement[];
    const originals = children.filter(
      (c) => !c.hasAttribute("data-marquee-clone"),
    );
    const clones = children.filter(
      (c) => c.hasAttribute("data-marquee-clone"),
    );
    if (originals.length === 0 || clones.length < originals.length) {
      return {
        ok: false,
        spread: 0,
        msg: `originals=${originals.length} clones=${clones.length}`,
      };
    }
    // First clone set: the first `originals.length` clone elements.
    const firstCloneSet = clones.slice(0, originals.length);
    const distances = originals.map((orig, i) => {
      const oLeft = orig.getBoundingClientRect().left;
      const cLeft = firstCloneSet[i].getBoundingClientRect().left;
      return cLeft - oLeft;
    });
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    return { ok: max - min < 0.6, spread: max - min, distances };
  });
  assert(
    cloneGeom.ok,
    `clone-twin geometry is uniform (max spread ${typeof cloneGeom.spread === "number" ? cloneGeom.spread.toFixed(2) : "?"} px < 0.6 px — seam proof)`,
  );

  // 5. Hover pause.
  // Scroll video row back into center view, then hover it and verify the tween
  // eases to a stop within 1.2 s (2.4× PAUSE_EASE_SECONDS=0.5).
  await page.evaluate(() => {
    const row = document.querySelector(".nb-marquee-videos");
    if (row) row.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(300);

  // Ensure tween is running before hover (take a baseline movement check).
  const preHoverX1 = await getX(".nb-marquee-videos");
  await sleep(300);
  const preHoverX2 = await getX(".nb-marquee-videos");
  // (Tween should be running — we already asserted this above; no extra assert here)

  // Hover the row.
  await page.hover(".nb-marquee-videos");
  await sleep(1200); // wait for timeScale→0 ease to complete

  // Now assert stable: |Δx| over 500ms should be < 1.5 px when paused.
  const hx1 = await getX(".nb-marquee-videos");
  await sleep(500);
  const hx2 = await getX(".nb-marquee-videos");
  const hoverDelta = Math.abs(hx2 - hx1);
  assert(
    hoverDelta < 1.5,
    `hover pauses the tween (|Δx|=${hoverDelta.toFixed(2)} px over 500 ms while hovered)`,
  );

  // Move mouse away from the row so the tween resumes before the focus test.
  await page.mouse.move(10, 10);
  await sleep(800); // allow timeScale→1 ease to complete

  // 6. Focus pause and visibility.
  //
  // Selector note: clones carry data-marquee-clone on the card element itself
  // (e.g. <a class="nb-video-card" data-marquee-clone ...>).  The correct
  // selector is :not([data-marquee-clone]) — an attribute check ON the element.
  // :not([data-marquee-clone] *) only tests ancestry and would still match
  // the clone card elements, causing ensureFocusVisible to return early (clone
  // not in originals[]) with the original left off-screen.
  //
  // Card-visibility approach: ensureFocusVisible has two paths —
  //   (a) card already fully in row viewport → returns immediately; card stays in view.
  //   (b) card off-screen → wraps tween progress to bring the visual back in view.
  // Path (b) for card 0 (layout offset 0) repositions via clone (the modulo wrap
  // puts the clone twin at the centred position, not the original element).
  // To avoid a false-fail we find an original card that IS currently in view
  // (path a), focus it, and assert it remains visible.  This still validates:
  //   • module resets row.scrollLeft on focusin (primary scroll-doubling guard)
  //   • focused card stays within the row viewport (no accidental shift)
  //   • tween eases to a stop on focus

  // Scroll video row into view so the tween is running (IO observer active).
  await page.evaluate(() => {
    const row = document.querySelector(".nb-marquee-videos");
    if (row) row.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(400);

  // Step 1 — focus an original card that is currently fully in view.
  // We inspect live rects inside evaluate() so we always pick a visible card
  // regardless of the tween's current position.
  const focusStep1 = await page.evaluate(() => {
    const band = document.querySelector(".nb-testimonials");
    const row = band?.querySelector<HTMLElement>(".nb-marquee-videos");
    if (!row) return { ok: false as const, msg: "row not found" };
    const rowRect = row.getBoundingClientRect();
    // :not([data-marquee-clone]) selects only originals; clones carry the
    // attribute on themselves, so this correctly excludes them.
    const originals = Array.from(
      row.querySelectorAll<HTMLElement>(".nb-video-card:not([data-marquee-clone])"),
    );
    const inViewCard = originals.find((c) => {
      const r = c.getBoundingClientRect();
      return r.left >= rowRect.left - 1 && r.right <= rowRect.right + 1;
    });
    if (!inViewCard) {
      const positions = originals.map((c) =>
        c.getBoundingClientRect().left.toFixed(0),
      );
      return {
        ok: false as const,
        msg: `no original in view (row ${rowRect.left.toFixed(0)}–${rowRect.right.toFixed(0)}, cards at ${positions.join(",")})`,
      };
    }
    inViewCard.focus();
    // Capture scrollLeft immediately — module's onFocusIn handler has already run.
    return { ok: true as const, scrollLeft: row.scrollLeft };
  });

  assert(focusStep1.ok, `focus test: found an original card in view (${(focusStep1 as { msg?: string }).msg ?? "ok"})`);
  if (focusStep1.ok) {
    assert(
      focusStep1.scrollLeft === 0,
      `focus resets row.scrollLeft to 0 (got ${focusStep1.scrollLeft})`,
    );
  }

  // Step 2 — allow one rAF tick to settle, then re-read via document.activeElement.
  await sleep(200);

  const focusRects = await page.evaluate(() => {
    const band = document.querySelector(".nb-testimonials");
    const row = band?.querySelector<HTMLElement>(".nb-marquee-videos");
    if (!row) return { ok: false as const };
    const scrollLeft = row.scrollLeft;
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || !row.contains(focused)) return { ok: false as const };
    const rowRect = row.getBoundingClientRect();
    const cardRect = focused.getBoundingClientRect();
    return {
      ok: true as const,
      scrollLeft,
      cardVisible: cardRect.left >= rowRect.left - 2 && cardRect.right <= rowRect.right + 2,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
    };
  });

  if (focusRects.ok) {
    assert(
      focusRects.scrollLeft === 0,
      `row.scrollLeft remains 0 after rAF settle (got ${focusRects.scrollLeft})`,
    );
    assert(
      focusRects.cardVisible,
      `focused card stays within row viewport (card ${focusRects.cardLeft?.toFixed(0)}–${focusRects.cardRight?.toFixed(0)} px, row ${focusRects.rowLeft?.toFixed(0)}–${focusRects.rowRight?.toFixed(0)} px)`,
    );
  }

  // Wait for the tween to ease to a stop after focusin (PAUSE_EASE_SECONDS=0.5).
  await sleep(1200);
  const fx1 = await getX(".nb-marquee-videos");
  await sleep(500);
  const fx2 = await getX(".nb-marquee-videos");
  const focusDelta = Math.abs(fx2 - fx1);
  assert(
    focusDelta < 1.5,
    `focus eases tween to a stop (|Δx|=${focusDelta.toFixed(2)} px over 500 ms while focused)`,
  );

  // 8. Tabbable count inside the band.
  // The featured pause control and the 5 original video anchors should be
  // reachable by keyboard. Clones carry aria-hidden="true" and tabindex="-1".
  const tabbableCount = await page.evaluate(() => {
    const band = document.querySelector(".nb-testimonials");
    if (!band) return -1;
    const candidates = band.querySelectorAll(
      "a[href], button, [tabindex]",
    ) as NodeListOf<HTMLElement>;
    let count = 0;
    for (const el of candidates) {
      if (el.getAttribute("tabindex") === "-1") continue;
      // Verify no aria-hidden ancestor within the band.
      let node: Element | null = el.parentElement;
      let hidden = false;
      while (node && node !== band) {
        if (node.getAttribute("aria-hidden") === "true") {
          hidden = true;
          break;
        }
        node = node.parentElement;
      }
      if (!hidden) count++;
    }
    return count;
  });
  assert(
    tabbableCount === EXPECTED_TABBABLE_ORIGINALS,
    `band has exactly ${EXPECTED_TABBABLE_ORIGINALS} tabbable elements (one original card set; got ${tabbableCount})`,
  );
}

async function runFeaturedRotationTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— Featured quote rotation run —");
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page
    .waitForFunction(
      () =>
        document
          .querySelector("[data-featured-testimonial]")
          ?.getAttribute("data-featured-ready") === "1",
      { timeout: 15_000 },
    )
    .catch(() => {
      /* assertions below provide the actionable failure */
    });
  await page.evaluate(() => {
    document
      .querySelector("[data-featured-testimonial]")
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await page.mouse.move(10, 10);
  await sleep(400);

  const readFeatured = () =>
    page.evaluate(() => {
      const featured = document.querySelector<HTMLElement>(
        "[data-featured-testimonial]",
      );
      const toggle = featured?.querySelector<HTMLButtonElement>(
        "[data-featured-toggle]",
      );
      return {
        index: featured?.getAttribute("data-featured-index") ?? null,
        paused: featured?.getAttribute("data-featured-paused") ?? null,
        text:
          featured
            ?.querySelector<HTMLElement>("[data-featured-copy]")
            ?.innerText.replace(/\s+/g, " ")
            .trim() ?? "",
        attribution:
          featured
            ?.querySelector<HTMLElement>("[data-featured-attribution]")
            ?.textContent?.trim() ?? "",
        height: featured?.getBoundingClientRect().height ?? 0,
        ready: featured?.getAttribute("data-featured-ready") ?? null,
        toggleHidden: toggle?.hidden ?? true,
        togglePressed: toggle?.getAttribute("aria-pressed") ?? null,
        toggleText: toggle?.textContent?.trim() ?? "",
      };
    });

  const featuredInitial = await readFeatured();
  assert(
    featuredInitial.ready === "1" &&
      featuredInitial.index === "0" &&
      featuredInitial.text.includes("I’m skeptical about everything") &&
      featuredInitial.text.includes("99% of the people I talk to") &&
      featuredInitial.attribution ===
        "— Tom Boris, The Elder Law Offices of Shields and Boris" &&
      !featuredInitial.toggleHidden,
    "featured proof starts on the complete Tom Boris fallback with its pause control enabled",
  );

  await page
    .waitForFunction(
      () =>
        document
          .querySelector("[data-featured-testimonial]")
          ?.getAttribute("data-featured-index") === "1",
      { timeout: FEATURED_WAIT_MS + 2_000 },
    )
    .catch(() => {
      /* assertion below provides the paired-content failure */
    });
  const featuredAdvanced = await readFeatured();
  assert(
    featuredAdvanced.index === "1" &&
      featuredAdvanced.text.includes(
        "the number of quality leads coming into my firm has grown month after month",
      ) &&
      featuredAdvanced.attribution === "— Lani Akiona, Family Law Attorney",
    "featured proof advances quote text and attribution together to the next curated source",
  );
  assert(
    Math.abs(featuredAdvanced.height - featuredInitial.height) < 1,
    `featured proof card height stays fixed across rotation (initial=${featuredInitial.height.toFixed(1)} px advanced=${featuredAdvanced.height.toFixed(1)} px)`,
  );

  await page.hover("[data-featured-testimonial]");
  await sleep(150);
  const hoverHeld = await readFeatured();
  assert(
    hoverHeld.paused === "hover",
    "hover pauses featured proof while it is being read",
  );

  await page.mouse.move(10, 10);
  await sleep(150);
  await page.focus("[data-featured-toggle]");
  await sleep(150);
  const focusHeld = await readFeatured();
  await sleep(FEATURED_WAIT_MS);
  const focusAfterCadence = await readFeatured();
  assert(
    focusHeld.paused === "focus" &&
      focusAfterCadence.index === focusHeld.index,
    `keyboard focus pauses featured proof for a full cadence (index stayed ${focusHeld.index})`,
  );

  await page.keyboard.press("Space");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await sleep(150);
  const userHeld = await readFeatured();
  await sleep(FEATURED_WAIT_MS);
  const userAfterCadence = await readFeatured();
  assert(
    userHeld.paused === "user" &&
      userHeld.togglePressed === "true" &&
      userHeld.toggleText === "Resume rotation" &&
      userAfterCadence.index === userHeld.index,
    `explicit pause holds featured proof for a full cadence (index stayed ${userHeld.index})`,
  );

  await page.click("[data-featured-toggle]");
  await page.mouse.move(10, 10);
  await page
    .waitForFunction(
      (heldIndex) => {
        const featured = document.querySelector(
          "[data-featured-testimonial]",
        );
        return (
          featured?.getAttribute("data-featured-index") !== heldIndex &&
          !featured?.hasAttribute("data-featured-paused")
        );
      },
      { timeout: FEATURED_WAIT_MS + 2_000 },
      userHeld.index,
    )
    .catch(() => {
      /* assertion below provides the resume failure */
    });
  const userResumed = await readFeatured();
  assert(
    userResumed.index !== userHeld.index &&
      userResumed.paused === null &&
      userResumed.togglePressed === "false" &&
      userResumed.toggleText === "Pause rotation",
    `explicit resume restarts featured proof rotation (index ${userHeld.index} → ${userResumed.index})`,
  );

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await sleep(300);
  const offscreenHeld = await readFeatured();
  assert(
    offscreenHeld.paused === "offscreen",
    "featured proof pauses while its card is offscreen",
  );
  await page.evaluate(() => {
    document
      .querySelector("[data-featured-testimonial]")
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await page
    .waitForFunction(
      () =>
        !document
          .querySelector("[data-featured-testimonial]")
          ?.hasAttribute("data-featured-paused"),
      { timeout: 2_000 },
    )
    .catch(() => {
      /* assertion below provides the resume failure */
    });
  const backInView = await readFeatured();
  assert(
    backInView.paused === null,
    "featured proof resumes its cadence when the card returns onscreen",
  );

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const pageHidden = await readFeatured();
  assert(
    pageHidden.paused === "page-hidden",
    "featured proof pauses when the page becomes hidden",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(150);

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    document
      .querySelector("[data-featured-testimonial]")
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await page.mouse.move(10, 10);
  await sleep(500);
  const mobileBefore = await readFeatured();
  await page
    .waitForFunction(
      (heldIndex) =>
        document
          .querySelector("[data-featured-testimonial]")
          ?.getAttribute("data-featured-index") !== heldIndex,
      { timeout: FEATURED_WAIT_MS + 2_000 },
      mobileBefore.index,
    )
    .catch(() => {
      /* assertion below provides the mobile rotation failure */
    });
  const mobileAfter = await readFeatured();
  assert(
    mobileAfter.index !== mobileBefore.index &&
      Math.abs(mobileAfter.height - mobileBefore.height) < 1,
    `mobile featured proof rotates without a height jump (index ${mobileBefore.index} → ${mobileAfter.index}; ${mobileBefore.height.toFixed(1)} px → ${mobileAfter.height.toFixed(1)} px)`,
  );

  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await sleep(300);
  const reducedMidVisit = await readFeatured();
  const reducedMode = await page.evaluate(
    () =>
      document
        .querySelector(".nb-testimonials")
        ?.getAttribute("data-testi-mode") ?? null,
  );
  assert(
    reducedMode === "static" &&
      reducedMidVisit.ready === null &&
      reducedMidVisit.index === "0" &&
      reducedMidVisit.text.includes("I’m skeptical about everything") &&
      reducedMidVisit.toggleHidden,
    "enabling reduced motion mid-visit tears down rotation and restores the Tom Boris fallback",
  );
}

// ---------------------------------------------------------------------------
// Resize-rebuild assertions (Task #5049)
// ---------------------------------------------------------------------------

/**
 * Verify that the debounced resize → dismantle → rebuild path leaves the
 * marquee in a healthy state.  Covers the onResize handler (lines 229-237 of
 * testimonialsMarquee.ts) which is not exercised by the fixed-viewport tests
 * above.
 *
 * Assertions:
 *   13. All three rows still carry data-marquee-ready after the rebuild.
 *   14. No duplicate [data-marquee-clone] elements exist (dismantle removed
 *       the old clones; build added exactly one fresh set).
 *   15. Clone-twin geometry is still uniform (<0.6 px spread) — period
 *       recalculation at the new width produced a valid seam.
 *   16. The tween still advances after the rebuild (motion is live).
 *   17. A rebuild that starts while the row is hovered resumes after mouseleave.
 *   18. A rebuild that starts while a card is focused resumes after focusout.
 */
async function runResizeRebuildTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— Resize-rebuild run —");

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });

  // Wait for the initial 1280 px build to complete (3 rows ready).
  await page
    .waitForFunction(
      () => document.querySelectorAll("[data-marquee-ready]").length >= 3,
      { timeout: 15_000 },
    )
    .catch(() => {
      /* assertions below will surface a clearer message */
    });

  // Scroll the section into view so the IO observer activates all rows before
  // the resize, matching the invariant that the tween is running.
  await page.evaluate(() => {
    const el = document.querySelector(".nb-testimonials");
    if (el) el.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await sleep(400);

  // ------------------------------------------------------------------
  // Stamp every pre-resize clone with a sentinel attribute so we can
  // confirm they are removed from the DOM during dismantle.  This is
  // the key proof that a rebuild actually occurred — assertions on
  // clone counts alone are satisfied even if onResize is a no-op.
  // ------------------------------------------------------------------
  const preResizeCloneCount = await page.evaluate(() => {
    const clones = Array.from(
      document.querySelectorAll("[data-marquee-clone]"),
    );
    for (const c of clones) {
      c.setAttribute("data-pre-resize-sentinel", "1");
    }
    return clones.length;
  });

  // ------------------------------------------------------------------
  // Trigger a viewport width change: 1280 → 1024 px.
  // Puppeteer's setViewport dispatches a real "resize" event in the page
  // so the onResize handler fires.
  // ------------------------------------------------------------------
  await page.setViewport({ width: 1024, height: 900 });

  // Wait for the debounced teardown to complete: all sentinel-stamped clones
  // must leave the DOM.  This proves dismantle() ran and removed the old set.
  // Timeout is generous (3 s = 250 ms debounce + rebuild time + buffer).
  let teardownProven = false;
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("[data-pre-resize-sentinel]").length === 0,
      { timeout: 3_000 },
    )
    .then(() => {
      teardownProven = true;
    })
    .catch(() => {
      /* assertion below will surface a clearer failure */
    });

  // Give the fresh build a moment to settle after the sentinels disappear.
  await sleep(200);

  // 13. The sentinel-stamped clones must be gone — proving dismantle() ran.
  const sentinelCount = await page.evaluate(
    () => document.querySelectorAll("[data-pre-resize-sentinel]").length,
  );
  assert(
    sentinelCount === 0,
    `pre-resize clone sentinels removed from DOM (got ${sentinelCount} remaining) — proves teardown executed`,
  );

  // 14. All three rows must still carry data-marquee-ready (fresh build ran).
  const readyCount = await page.evaluate(
    () => document.querySelectorAll("[data-marquee-ready]").length,
  );
  assert(
    readyCount >= 3,
    `all 3 marquee rows carry data-marquee-ready after resize rebuild (got ${readyCount})`,
  );

  // 15. Clone count after rebuild must be non-zero and equal the pre-resize
  //     count — the fresh build produced exactly one set (not doubled).
  const postResizeCloneCount = await page.evaluate(
    () => document.querySelectorAll("[data-marquee-clone]").length,
  );
  assert(
    postResizeCloneCount > 0 && postResizeCloneCount === preResizeCloneCount,
    `fresh clone set has the same size as the original (pre=${preResizeCloneCount} post=${postResizeCloneCount}) — no duplicates`,
  );

  // 16. Clone-twin geometry is still uniform on the video row after the
  //     period recalculation at 1024 px width.
  const cloneGeomAfterResize = await page.evaluate(() => {
    const track = document.querySelector(
      ".nb-marquee-videos [data-marquee-track]",
    );
    if (!track) return { ok: false, spread: 0, msg: "track not found" };
    const children = Array.from(track.children) as HTMLElement[];
    const originals = children.filter(
      (c) => !c.hasAttribute("data-marquee-clone"),
    );
    const clones = children.filter((c) => c.hasAttribute("data-marquee-clone"));
    if (originals.length === 0 || clones.length < originals.length) {
      return {
        ok: false,
        spread: 0,
        msg: `originals=${originals.length} clones=${clones.length}`,
      };
    }
    const firstCloneSet = clones.slice(0, originals.length);
    const distances = originals.map((orig, i) => {
      const oLeft = orig.getBoundingClientRect().left;
      const cLeft = firstCloneSet[i].getBoundingClientRect().left;
      return cLeft - oLeft;
    });
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    return { ok: max - min < 0.6, spread: max - min, distances };
  });
  assert(
    cloneGeomAfterResize.ok,
    `clone-twin geometry uniform after resize (max spread ${typeof cloneGeomAfterResize.spread === "number" ? cloneGeomAfterResize.spread.toFixed(2) : "?"} px < 0.6 px)`,
  );

  // 17. Drift check — the tween must be advancing at the new viewport width.
  // Scroll the video row into view so the IO observer keeps the tween active.
  await page.evaluate(() => {
    const row = document.querySelector(".nb-marquee-videos");
    if (row) row.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(300);

  const SAMPLE_WAIT_MS = 700;
  const getX = (rowSelector: string): Promise<number> =>
    page.evaluate(
      ([sel, fn]: [string, string]) => {
        /* eslint-disable no-new-func */
        const getTranslateX = new Function(
          `${fn}; return getTranslateX(arguments[0]);`,
        ) as (el: Element) => number;
        const row = document.querySelector(sel);
        const track = row?.querySelector("[data-marquee-track]");
        return track ? getTranslateX(track) : 0;
      },
      [rowSelector, GET_TRANSLATE_X_FN] as [string, string],
    );

  const rx1 = await getX(".nb-marquee-videos");
  await sleep(SAMPLE_WAIT_MS);
  const rx2 = await getX(".nb-marquee-videos");
  const rDelta = rx2 - rx1;
  assert(
    Math.abs(rDelta) > 5,
    `video row tween still advances after resize rebuild (Δx=${rDelta.toFixed(1)} px over ${SAMPLE_WAIT_MS} ms)`,
  );

  // 17. Hover-state rebuild. Pause the row, resize while the pause ease is
  // active, then leave the row. The fresh handle must not inherit a stuck
  // hovered=true state from the torn-down handle.
  await page.hover(".nb-marquee-videos");
  await sleep(1_200);
  const hoverPauseX1 = await getX(".nb-marquee-videos");
  await sleep(500);
  const hoverPauseX2 = await getX(".nb-marquee-videos");
  assert(
    Math.abs(hoverPauseX2 - hoverPauseX1) < 1.5,
    `video row is paused before hovered resize (|Δx|=${Math.abs(hoverPauseX2 - hoverPauseX1).toFixed(2)} px)`,
  );

  await page.evaluate(() => {
    document.querySelectorAll("[data-marquee-clone]").forEach((clone) => {
      clone.setAttribute("data-hover-resize-sentinel", "1");
    });
  });
  await page.setViewport({ width: 800, height: 900 });
  await page
    .waitForFunction(
      () => document.querySelectorAll("[data-hover-resize-sentinel]").length === 0,
      { timeout: 3_000 },
    )
    .catch(() => {
      /* assertion below provides the actionable failure */
    });
  const hoverSentinels = await page.evaluate(
    () => document.querySelectorAll("[data-hover-resize-sentinel]").length,
  );
  assert(
    hoverSentinels === 0,
    `hovered resize dismantles the paused row before rebuilding (got ${hoverSentinels} old clones)`,
  );

  await page.mouse.move(10, 10);
  await page.evaluate(() => {
    document
      .querySelector(".nb-marquee-videos")
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(800);
  const hoverResumeX1 = await getX(".nb-marquee-videos");
  await sleep(SAMPLE_WAIT_MS);
  const hoverResumeX2 = await getX(".nb-marquee-videos");
  const hoverResumeDelta = hoverResumeX2 - hoverResumeX1;
  assert(
    Math.abs(hoverResumeDelta) > 5,
    `video row resumes after mouseleave following hovered resize (Δx=${hoverResumeDelta.toFixed(1)} px over ${SAMPLE_WAIT_MS} ms)`,
  );

  // 18. Focus-state rebuild. Focus an original card, resize while focused,
  // then blur it. This catches the equivalent stale focused=true state.
  const focusStarted = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".nb-marquee-videos");
    const card = row?.querySelector<HTMLElement>(
      ".nb-video-card:not([data-marquee-clone])",
    );
    if (!row || !card) return false;
    card.focus();
    return document.activeElement === card;
  });
  assert(focusStarted, "an original video card receives focus before focused resize");
  await sleep(1_200);
  const focusPauseX1 = await getX(".nb-marquee-videos");
  await sleep(500);
  const focusPauseX2 = await getX(".nb-marquee-videos");
  assert(
    Math.abs(focusPauseX2 - focusPauseX1) < 1.5,
    `video row is paused before focused resize (|Δx|=${Math.abs(focusPauseX2 - focusPauseX1).toFixed(2)} px)`,
  );

  await page.evaluate(() => {
    document.querySelectorAll("[data-marquee-clone]").forEach((clone) => {
      clone.setAttribute("data-focus-resize-sentinel", "1");
    });
  });
  await page.setViewport({ width: 1024, height: 900 });
  await page
    .waitForFunction(
      () => document.querySelectorAll("[data-focus-resize-sentinel]").length === 0,
      { timeout: 3_000 },
    )
    .catch(() => {
      /* assertion below provides the actionable failure */
    });
  const focusSentinels = await page.evaluate(
    () => document.querySelectorAll("[data-focus-resize-sentinel]").length,
  );
  assert(
    focusSentinels === 0,
    `focused resize dismantles the paused row before rebuilding (got ${focusSentinels} old clones)`,
  );

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document
      .querySelector(".nb-marquee-videos")
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(800);
  const focusResumeX1 = await getX(".nb-marquee-videos");
  await sleep(SAMPLE_WAIT_MS);
  const focusResumeX2 = await getX(".nb-marquee-videos");
  const focusResumeDelta = focusResumeX2 - focusResumeX1;
  assert(
    Math.abs(focusResumeDelta) > 5,
    `video row resumes after blur following focused resize (Δx=${focusResumeDelta.toFixed(1)} px over ${SAMPLE_WAIT_MS} ms)`,
  );

  void teardownProven; // referenced for type-checker only
}

// ---------------------------------------------------------------------------
// Reduced-motion assertions
// ---------------------------------------------------------------------------

async function runReducedMotionTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— Reduced-motion run —");

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  // Allow the GSAP matchMedia callback a tick to fire (synchronous on
  // registration, so "load" + a brief paint settle is sufficient).
  await sleep(300);

  // 8. Band mode should be "static", not "marquee".
  const mode = await page.evaluate(
    () =>
      document
        .querySelector(".nb-testimonials")
        ?.getAttribute("data-testi-mode") ?? null,
  );
  assert(
    mode === "static",
    `data-testi-mode="static" in reduced-motion (got: ${JSON.stringify(mode)})`,
  );

  // 9. Exactly EXPECTED_VIDEO_CARDS video cards (no clones).
  const videoCount = await page.evaluate(
    () => document.querySelectorAll(".nb-video-card").length,
  );
  assert(
    videoCount === EXPECTED_VIDEO_CARDS,
    `exactly ${EXPECTED_VIDEO_CARDS} .nb-video-card elements in static mode (got ${videoCount})`,
  );

  // 10. Exactly EXPECTED_QUOTE_CARDS review quotes (no clones).
  const quoteCount = await page.evaluate(
    () => document.querySelectorAll(".nb-review").length,
  );
  assert(
    quoteCount === EXPECTED_QUOTE_CARDS,
    `exactly ${EXPECTED_QUOTE_CARDS} .nb-review elements in static mode (got ${quoteCount})`,
  );

  // 11. No clone elements exist.
  const cloneCount = await page.evaluate(
    () => document.querySelectorAll("[data-marquee-clone]").length,
  );
  assert(
    cloneCount === 0,
    `zero [data-marquee-clone] elements in static mode (got ${cloneCount})`,
  );

  // 12. No marquee-ready attributes exist (marquee never initialised).
  const readyCount = await page.evaluate(
    () => document.querySelectorAll("[data-marquee-ready]").length,
  );
  assert(
    readyCount === 0,
    `zero [data-marquee-ready] attributes in static mode (got ${readyCount})`,
  );

  const featured = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(
      "[data-featured-testimonial]",
    );
    const toggle = card?.querySelector<HTMLButtonElement>(
      "[data-featured-toggle]",
    );
    return {
      index: card?.getAttribute("data-featured-index") ?? null,
      ready: card?.hasAttribute("data-featured-ready") ?? false,
      text:
        card
          ?.querySelector<HTMLElement>("[data-featured-copy]")
          ?.innerText.replace(/\s+/g, " ")
          .trim() ?? "",
      attribution:
        card
          ?.querySelector<HTMLElement>("[data-featured-attribution]")
          ?.textContent?.trim() ?? "",
      toggleHidden: toggle?.hidden ?? false,
    };
  });
  assert(
    featured.index === "0" &&
      !featured.ready &&
      featured.text.includes("I’m skeptical about everything") &&
      featured.text.includes("99% of the people I talk to") &&
      featured.attribution ===
        "— Tom Boris, The Elder Law Offices of Shields and Boris" &&
      featured.toggleHidden,
    "reduced-motion keeps the complete Tom Boris proof static with its rotation control hidden",
  );
}

async function runNoJavaScriptTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— No-JavaScript fallback run —");
  await page.setJavaScriptEnabled(false);
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });

  const featured = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(
      "[data-featured-testimonial]",
    );
    const toggle = card?.querySelector<HTMLButtonElement>(
      "[data-featured-toggle]",
    );
    return {
      index: card?.getAttribute("data-featured-index") ?? null,
      mode:
        document
          .querySelector(".nb-testimonials")
          ?.getAttribute("data-testi-mode") ?? null,
      ready: card?.hasAttribute("data-featured-ready") ?? false,
      text:
        card
          ?.querySelector<HTMLElement>("[data-featured-copy]")
          ?.innerText.replace(/\s+/g, " ")
          .trim() ?? "",
      attribution:
        card
          ?.querySelector<HTMLElement>("[data-featured-attribution]")
          ?.textContent?.trim() ?? "",
      toggleHidden: toggle?.hidden ?? false,
    };
  });
  assert(
    featured.index === "0" &&
      featured.mode === null &&
      !featured.ready &&
      featured.text.includes("I’m skeptical about everything") &&
      featured.text.includes("99% of the people I talk to") &&
      featured.attribution ===
        "— Tom Boris, The Elder Law Offices of Shields and Boris" &&
      featured.toggleHidden,
    "no-JavaScript keeps the complete Tom Boris proof readable with no inert rotation control",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log(
      "website-testimonials-marquee: SKIPPED (no chromium binary available)",
    );
    process.exit(0);
  }

  // Start the in-process marketing site server (committed bundle).
  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}`;
  const homepageUrl = `${base}/`;

  // Quick sanity check before launching the browser.
  const probe = await fetch(homepageUrl);
  assert(probe.status === 200, `homepage serves 200 from the committed bundle`);

  let browser: { close(): Promise<void> } | null = null;
  try {
    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    const b = browser as Awaited<ReturnType<typeof puppeteer.launch>>;

    // ---- Motion-allowed page ----
    {
      const page = await b.newPage();
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      await page.setViewport({ width: 1280, height: 900 });
      // Abort external hosts (Typekit, Vimeo, CDNs) for determinism.
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try { host = new URL(req.url()).hostname; } catch { /* data: URI */ }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runMotionAllowedTests(page, homepageUrl);
      await page.close();
    }

    // ---- Featured quote page (motion-allowed, real cadence + controls) ----
    {
      const page = await b.newPage();
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try { host = new URL(req.url()).hostname; } catch { /* data: URI */ }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runFeaturedRotationTests(page, homepageUrl);
      await page.close();
    }

    // ---- Resize-rebuild page (motion-allowed, viewport changes mid-session) ----
    {
      const page = await b.newPage();
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try { host = new URL(req.url()).hostname; } catch { /* data: URI */ }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runResizeRebuildTests(page, homepageUrl);
      await page.close();
    }

    // ---- Reduced-motion page ----
    {
      const page = await b.newPage();
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try { host = new URL(req.url()).hostname; } catch { /* data: URI */ }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runReducedMotionTests(page, homepageUrl);
      await page.close();
    }

    // ---- No-JavaScript fallback page ----
    {
      const page = await b.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try { host = new URL(req.url()).hostname; } catch { /* data: URI */ }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runNoJavaScriptTests(page, homepageUrl);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("website-testimonials-marquee: unexpected error:", err);
  process.exit(1);
});
