/* test-registration
{
  "name": "Marketing site header no-overflow at ≤520px mobile widths (Task #4910)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 2.0s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 240000,
  "scanPaths": [
    "website/public"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #4910 — Headless regression guard for mobile header overflow.
 *
 * Context: at ≤520px viewports site.css hides .nb-nav-cta and the nav
 * becomes hamburger-only. The ≤850px media block already hides .nb-links
 * and shows .nb-nav-toggle. The header therefore contains only the logo
 * and the toggle button. Any flex child growing unexpectedly (wider logo,
 * padding change, margin leak) could introduce a horizontal scrollbar on
 * the most common phone widths without any existing automated assertion.
 *
 * What this suite does:
 *   - Spins up the same in-process marketing-site express server the other
 *     browser e2e tests use (serving the COMMITTED bundle from website/public).
 *   - Launches headless Chromium via puppeteer-core.
 *   - At each of the three critical mobile widths (375 px, 414 px, 480 px):
 *       • Loads the homepage (/) — home.css path.
 *       • Loads /about/ — representative shared-chrome site.css path.
 *       • Asserts document.documentElement.scrollWidth <= window.innerWidth.
 *       • On failure: bisects by hiding each direct child of .nb-header in
 *         turn, reports which element(s) caused the overflow so the culprit
 *         is immediately obvious without manual bisection.
 *
 * No DB, no POSTs. External hosts (Typekit, Calendly, Vimeo) are aborted via
 * request interception so the run is deterministic offline.
 * prefers-reduced-motion is emulated for the same determinism posture as the
 * sibling e2e suites.
 */

import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";

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
  // Pinned Nix-store path known from the task environment.
  const nixPath =
    "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
  if (fs.existsSync(nixPath)) return nixPath;
  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const p = execSync(`which ${bin}`, { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {
      /* not on PATH — try the next candidate */
    }
  }
  return null;
}

/**
 * Returns scrollWidth > innerWidth, plus (on overflow) the names of any
 * direct children of .nb-header whose removal collapses the overflow.
 * This bisect diagnostic makes the culprit immediately obvious without
 * manual browser investigation.
 */
async function checkOverflow(
  page: import("puppeteer-core").Page,
  url: string,
  width: number,
): Promise<{ overflow: boolean; culprits: string[] }> {
  await page.setViewport({ width, height: 812 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (!overflow) return { overflow: false, culprits: [] };

  // Bisect: hide each direct child of .nb-header and re-measure.
  const culprits = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".nb-header");
    if (!header) return ["<.nb-header not found>"];
    const children = Array.from(header.children) as HTMLElement[];
    const bad: string[] = [];
    for (const child of children) {
      const prev = child.style.display;
      child.style.display = "none";
      const still = document.documentElement.scrollWidth > window.innerWidth;
      child.style.display = prev;
      if (!still) {
        // Hiding this child removed the overflow — it is a contributor.
        bad.push(
          child.tagName.toLowerCase() +
            (child.id ? `#${child.id}` : "") +
            (child.className
              ? "." +
                String(child.className)
                  .trim()
                  .split(/\s+/)
                  .join(".")
              : ""),
        );
      }
    }
    return bad.length ? bad : ["<culprit not isolated to a single child>"];
  });
  return { overflow: true, culprits };
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log(
      "website-header-overflow-mobile: SKIPPED (no chromium binary available)",
    );
    process.exit(0);
  }

  // ---- in-process app: ONLY the marketing middleware (committed bundle) ----
  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}`;

  // Verify the pages exist before launching the browser.
  for (const path of ["/", "/about/"]) {
    const res = await fetch(`${base}${path}`);
    assert(
      res.status === 200,
      `preview ${path} serves the committed bundle (status ${res.status})`,
    );
  }

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
    const page = await b.newPage();

    // Same shims used by the sibling e2e suites.
    await page.evaluateOnNewDocument("window.__name = (f) => f;");
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);

    // Abort external hosts so the run is deterministic offline.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      let host = "";
      try {
        host = new URL(req.url()).hostname;
      } catch {
        /* data: URI or similar — let through */
      }
      if (host && host !== "127.0.0.1") {
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });

    // Three common phone widths that fall inside the ≤520px mobile block
    // where site.css hides .nb-nav-cta and leaves only logo + toggle.
    const WIDTHS = [375, 414, 480] as const;
    const PAGES: Array<{ label: string; path: string }> = [
      { label: "homepage (/)", path: "/" },
      { label: "about (/about/)", path: "/about/" },
    ];

    for (const { label, path } of PAGES) {
      console.log(`\n— ${label} mobile header overflow check —`);
      for (const width of WIDTHS) {
        const url = `${base}${path}`;
        const { overflow, culprits } = await checkOverflow(page, url, width);
        const detail = overflow
          ? ` — overflowing element(s): ${culprits.join(", ")}`
          : "";
        assert(
          !overflow,
          `${label} no horizontal overflow at ${width}px viewport${detail}`,
        );
      }
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("website-header-overflow-mobile: unexpected error:", err);
  process.exit(1);
});
