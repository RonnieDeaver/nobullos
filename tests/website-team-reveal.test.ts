/* test-registration
{
  "name": "Homepage team reveal toggle behavior (Task #5048)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green <0.1s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 300000,
  "scanPaths": [
    "website/public",
    "website/src/home-client/teamReveal.ts"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #5048 — Automated regression guard for the homepage team reveal toggle.
 *
 * Context: Task #5011 added home-client/teamReveal.ts, which stamps
 * data-team-collapsed="1" on .nb-team on page load and appends a
 * "Meet the Full Team" <button> below the grid.  Home.css keys all card-hiding
 * rules off that attribute so the grid shows only the first two rows per
 * breakpoint.  Clicking the button toggles between collapsed and expanded.
 *
 * What this suite asserts at each responsive grid breakpoint:
 *
 *   Initial collapsed state (JS has run):
 *     1. .nb-team section carries data-team-collapsed="1".
 *     2. The "Meet the Full Team" button is present in the DOM.
 *     3. The button's aria-expanded attribute is "false".
 *     4. The button's aria-controls names the grid's id.
 *     5. The expected first two rows of cards are visible (display ≠ none).
 *     6. Remaining cards are display:none (hidden by the nth-child CSS rule).
 *
 *   After clicking the button — expanded state:
 *     7. .nb-team section carries data-team-expanded="1" (collapsed attr removed).
 *     8. The button's aria-expanded attribute is "true".
 *     9. All 18 team cards are visible (display ≠ none).
 *
 *   After clicking the button again — re-collapsed state:
 *    10. .nb-team section carries data-team-collapsed="1" (expanded attr removed).
 *    11. The button's aria-expanded attribute is "false".
 *    12. The expected remaining cards are hidden again (display:none).
 *
 *   With JavaScript disabled — served-markup fallback:
 *    13. All 18 cards are visible (display !== none).
 *    14. No reveal button is present.
 *    15. Neither team-reveal state attribute is present on the section.
 *
 * Harness notes:
 *   - Spins up the in-process marketing-site express server (committed bundle).
 *   - External hosts (Typekit, Vimeo, CDNs) are aborted for determinism.
 *   - Runs at 1280, 900, 768, and 480 px widths to cover the 6-, 3-, 2-,
 *     and 1-column collapse selectors. Each retains two visible rows.
 *   - The test scrolls the team section into view before clicking so that
 *     no sticky nav occludes the button.
 */

import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";

// ---------------------------------------------------------------------------
// Constants (must stay in sync with home.ts TEAM array and home.css rules)
// ---------------------------------------------------------------------------

/** Total team cards in the grid (TEAM array length in home.ts). */
const TOTAL_TEAM_CARDS = 18;

/**
 * The responsive grid keeps its first two rows visible while collapsed. These
 * cases mirror home.css's 6-, 3-, 2-, and 1-column nth-child selectors.
 */
const VIEWPORT_CASES = [
  { width: 1280, columns: 6, visibleWhenCollapsed: 12 },
  { width: 900, columns: 3, visibleWhenCollapsed: 6 },
  { width: 768, columns: 2, visibleWhenCollapsed: 4 },
  { width: 480, columns: 1, visibleWhenCollapsed: 2 },
] as const;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Team reveal assertions
// ---------------------------------------------------------------------------

async function runTeamRevealTests(
  page: import("puppeteer-core").Page,
  url: string,
  viewport: (typeof VIEWPORT_CASES)[number],
): Promise<void> {
  const { width, columns, visibleWhenCollapsed } = viewport;
  const hiddenWhenCollapsed = TOTAL_TEAM_CARDS - visibleWhenCollapsed;
  console.log(`\n— Team reveal toggle run (${width}px, ${columns}-column grid) —`);

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });

  // Allow the team reveal module a tick to initialise (it runs synchronously
  // on DOMContentLoaded, but "load" fires after — give the module a rAF).
  await sleep(300);

  // -------------------------------------------------------------------------
  // 1. Initial collapsed state
  // -------------------------------------------------------------------------

  // 1. data-team-collapsed="1" present on .nb-team
  const collapsedAttr = await page.evaluate(
    () =>
      document.querySelector(".nb-team")?.getAttribute("data-team-collapsed") ??
      null,
  );
  assert(
    collapsedAttr === "1",
    `initial state: .nb-team has data-team-collapsed="1" (got: ${JSON.stringify(collapsedAttr)})`,
  );

  // 2. The toggle button is present
  const buttonPresent = await page.evaluate(
    () => document.querySelector(".nb-team-reveal") !== null,
  );
  assert(buttonPresent, `initial state: .nb-team-reveal button is in the DOM`);

  // 3. aria-expanded is "false"
  const ariaExpandedInitial = await page.evaluate(
    () =>
      document.querySelector(".nb-team-reveal")?.getAttribute("aria-expanded") ??
      null,
  );
  assert(
    ariaExpandedInitial === "false",
    `initial state: aria-expanded="false" on reveal button (got: ${JSON.stringify(ariaExpandedInitial)})`,
  );

  // 4. aria-controls names the grid's id
  const ariaControlsOk = await page.evaluate(() => {
    const btn = document.querySelector(".nb-team-reveal");
    if (!btn) return false;
    const gridId = btn.getAttribute("aria-controls");
    if (!gridId) return false;
    const grid = document.getElementById(gridId);
    return grid !== null && grid.classList.contains("nb-team-grid");
  });
  assert(
    ariaControlsOk,
    `initial state: aria-controls names an element with class nb-team-grid`,
  );

  // 5 & 6. Visible and hidden card counts at this responsive breakpoint.
  const cardVisibility = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".nb-team-grid .nb-team-card"),
    );
    const visibleCount = cards.filter(
      (c) => window.getComputedStyle(c).display !== "none",
    ).length;
    const hiddenCount = cards.filter(
      (c) => window.getComputedStyle(c).display === "none",
    ).length;
    return { total: cards.length, visibleCount, hiddenCount };
  });

  assert(
    cardVisibility.total === TOTAL_TEAM_CARDS,
    `total team cards in DOM = ${TOTAL_TEAM_CARDS} (got ${cardVisibility.total})`,
  );
  assert(
    cardVisibility.visibleCount === visibleWhenCollapsed,
    `collapsed: ${visibleWhenCollapsed} cards visible at ${width} px (got ${cardVisibility.visibleCount})`,
  );
  assert(
    cardVisibility.hiddenCount === hiddenWhenCollapsed,
    `collapsed: ${hiddenWhenCollapsed} cards hidden (display:none) at ${width} px (got ${cardVisibility.hiddenCount})`,
  );

  // -------------------------------------------------------------------------
  // 2. Expanded state — click the button
  // -------------------------------------------------------------------------

  // Scroll the button into view before clicking (avoids sticky-nav occlusion).
  await page.evaluate(() => {
    const btn = document.querySelector(".nb-team-reveal");
    if (btn) btn.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await sleep(200);

  await page.click(".nb-team-reveal");
  await sleep(300); // allow transition / attribute swap

  // 7. data-team-expanded="1" present; data-team-collapsed removed
  const expandedAttr = await page.evaluate(
    () =>
      document.querySelector(".nb-team")?.getAttribute("data-team-expanded") ??
      null,
  );
  const collapsedAttrAfterExpand = await page.evaluate(
    () =>
      document.querySelector(".nb-team")?.getAttribute("data-team-collapsed") ??
      null,
  );
  assert(
    expandedAttr === "1",
    `expanded: .nb-team has data-team-expanded="1" (got: ${JSON.stringify(expandedAttr)})`,
  );
  assert(
    collapsedAttrAfterExpand === null,
    `expanded: data-team-collapsed removed (got: ${JSON.stringify(collapsedAttrAfterExpand)})`,
  );

  // 8. aria-expanded is "true"
  const ariaExpandedAfterOpen = await page.evaluate(
    () =>
      document.querySelector(".nb-team-reveal")?.getAttribute("aria-expanded") ??
      null,
  );
  assert(
    ariaExpandedAfterOpen === "true",
    `expanded: aria-expanded="true" on reveal button (got: ${JSON.stringify(ariaExpandedAfterOpen)})`,
  );

  // 9. All 18 cards visible and none hidden.
  const expandedVisibility = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".nb-team-grid .nb-team-card"),
    );
    const visibleCount = cards.filter(
      (c) => window.getComputedStyle(c).display !== "none",
    ).length;
    const hiddenCount = cards.filter(
      (c) => window.getComputedStyle(c).display === "none",
    ).length;
    return { visibleCount, hiddenCount };
  });
  assert(
    expandedVisibility.visibleCount === TOTAL_TEAM_CARDS,
    `expanded: all ${TOTAL_TEAM_CARDS} cards visible at ${width} px (got ${expandedVisibility.visibleCount})`,
  );
  assert(
    expandedVisibility.hiddenCount === 0,
    `expanded: 0 cards hidden at ${width} px (got ${expandedVisibility.hiddenCount})`,
  );

  // -------------------------------------------------------------------------
  // 3. Re-collapsed state — click the button again
  // -------------------------------------------------------------------------

  await page.click(".nb-team-reveal");
  await sleep(300);

  // 10. data-team-collapsed="1" restored; data-team-expanded removed
  const recollapsedAttr = await page.evaluate(
    () =>
      document.querySelector(".nb-team")?.getAttribute("data-team-collapsed") ??
      null,
  );
  const expandedAttrAfterRecollapse = await page.evaluate(
    () =>
      document.querySelector(".nb-team")?.getAttribute("data-team-expanded") ??
      null,
  );
  assert(
    recollapsedAttr === "1",
    `re-collapsed: .nb-team has data-team-collapsed="1" (got: ${JSON.stringify(recollapsedAttr)})`,
  );
  assert(
    expandedAttrAfterRecollapse === null,
    `re-collapsed: data-team-expanded removed (got: ${JSON.stringify(expandedAttrAfterRecollapse)})`,
  );

  // 11. aria-expanded is "false" again
  const ariaExpandedAfterReclose = await page.evaluate(
    () =>
      document.querySelector(".nb-team-reveal")?.getAttribute("aria-expanded") ??
      null,
  );
  assert(
    ariaExpandedAfterReclose === "false",
    `re-collapsed: aria-expanded="false" on reveal button (got: ${JSON.stringify(ariaExpandedAfterReclose)})`,
  );

  // 12. The expected remaining cards are hidden again.
  const recollapsedHidden = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".nb-team-grid .nb-team-card"),
    );
    return cards.filter(
      (c) => window.getComputedStyle(c).display === "none",
    ).length;
  });
  assert(
    recollapsedHidden === hiddenWhenCollapsed,
    `re-collapsed: ${hiddenWhenCollapsed} cards hidden again at ${width} px (got ${recollapsedHidden})`,
  );
}

async function runNoJavaScriptTeamRevealTests(
  page: import("puppeteer-core").Page,
  url: string,
): Promise<void> {
  console.log("\n— Team reveal no-JS fallback run —");

  await page.setJavaScriptEnabled(false);
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });

  const fallback = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".nb-team-grid .nb-team-card"),
    );
    const section = document.querySelector(".nb-team");
    return {
      total: cards.length,
      visibleCount: cards.filter(
        (card) => window.getComputedStyle(card).display !== "none",
      ).length,
      revealButtonPresent:
        document.querySelector(".nb-team-reveal") !== null,
      collapsedAttr: section?.getAttribute("data-team-collapsed") ?? null,
      expandedAttr: section?.getAttribute("data-team-expanded") ?? null,
    };
  });

  assert(
    fallback.total === TOTAL_TEAM_CARDS &&
      fallback.visibleCount === TOTAL_TEAM_CARDS,
    `no-JS fallback: all ${TOTAL_TEAM_CARDS} cards are visible (total ${fallback.total}, visible ${fallback.visibleCount})`,
  );
  assert(
    !fallback.revealButtonPresent,
    `no-JS fallback: .nb-team-reveal button is absent from the DOM`,
  );
  assert(
    fallback.collapsedAttr === null && fallback.expandedAttr === null,
    `no-JS fallback: .nb-team has no reveal state attributes (collapsed ${JSON.stringify(fallback.collapsedAttr)}, expanded ${JSON.stringify(fallback.expandedAttr)})`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log(
      "website-team-reveal: SKIPPED (no chromium binary available)",
    );
    process.exit(0);
  }

  // Start the in-process marketing site server (committed bundle).
  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
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

    for (const viewport of VIEWPORT_CASES) {
      const page = await b.newPage();
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.setViewport({ width: viewport.width, height: 900 });
      // Abort external hosts (Typekit, Vimeo, CDNs) for determinism.
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        try {
          host = new URL(req.url()).hostname;
        } catch {
          /* data: URI */
        }
        if (host && host !== "127.0.0.1") {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await runTeamRevealTests(page, homepageUrl, viewport);
      if (viewport.width === 1280) {
        await runNoJavaScriptTeamRevealTests(page, homepageUrl);
      }
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
  console.error("website-team-reveal: unexpected error:", err);
  process.exit(1);
});
