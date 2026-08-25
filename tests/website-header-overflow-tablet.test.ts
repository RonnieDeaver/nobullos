/* test-registration
{
  "name": "Marketing site header no-overflow at 851–982px tablet/narrow-desktop widths (Task #4900)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 13.4s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 300000,
  "scanPaths": [
    "website/public"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #4900 — Headless regression guard for the site-header overflow fix
 * shipped in Task #4891. Practice Areas Served extends the responsive
 * handoffs to the longer first-label and book-button fit boundaries.
 *
 * Context: at 851–900px viewport widths the desktop nav measured ~917px
 * intrinsically against an 836px content area. Task #4891 extended the
 * ≤850px hamburger media block (in both home.css and site.css) with an
 * explicit 851–900px override that hides .nb-links and shows .nb-nav-toggle.
 * Practice Areas Served grows the first non-CTA link enough that both header
 * variants need the hamburger through 1149px. The optional desktop book button
 * now waits until 1400px, where a wider header cap lets the complete chrome fit
 * again. Without an automated test a future CSS change could re-introduce a
 * scrollbar or multi-line nav label silently.
 *
 * Task #4911 extended coverage: every committed index.html under
 * website/public that carries the nb-* header chrome is now tested, not just
 * the homepage and one representative shared-chrome page. New subpages that ship with extra nav
 * items or a wider CTA button will be caught automatically on the next smoke
 * run without needing a test update.
 *
 * What this suite does:
 *   - Spins up the same in-process marketing-site express server the other
 *     browser e2e tests use (serving the COMMITTED bundle from website/public).
 *   - Discovers every committed page under website/public whose index.html
 *     contains the ".nb-header" class (auto-discovery; no hardcoded list).
 *   - Launches headless Chromium via puppeteer-core.
 *   - At each critical width around the hamburger (851 px through 1150 px)
 *     and desktop-book (1399 px / 1400 px) handoffs:
 *       • Loads the page.
 *       • Asserts document.documentElement.scrollWidth <= window.innerWidth.
 *       • Pins hamburger/desktop visibility, the single-line first label, and
 *         the optional book-button handoff.
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "website",
  "public",
);

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
 * Walk website/public and return every URL path whose index.html contains
 * the ".nb-header" class. The root index.html maps to "/".
 */
function discoverNbHeaderPages(): Array<{ label: string; path: string }> {
  const pages: Array<{ label: string; path: string }> = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "index.html") {
        const html = fs.readFileSync(full, "utf8");
        if (html.includes("nb-header")) {
          const rel = path.relative(PUBLIC_DIR, path.dirname(full));
          // root page maps to "/"; sub-pages to "/rel/"
          const urlPath = !rel || rel === "." ? "/" : `/${rel}/`;
          // Normalise path separators on Windows (no-op on Linux).
          const normPath = urlPath.replace(/\\/g, "/");
          const label =
            normPath === "/" ? "homepage (/)" : `${normPath.replace(/^\/|\/$/g, "")} (${normPath})`;
          pages.push({ label, path: normPath });
        }
      }
    }
  };

  walk(PUBLIC_DIR);

  // Stable sort: homepage first, then lexicographic.
  pages.sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    return a.path.localeCompare(b.path);
  });

  return pages;
}

/**
 * Returns scrollWidth > innerWidth, plus (on overflow) the names of any
 * direct children of .nb-header whose removal collapses the overflow — this
 * is the "bisect" diagnostic required by Task #4900.
 */
async function checkOverflow(
  page: import("puppeteer-core").Page,
  url: string,
  width: number,
): Promise<{
  overflow: boolean;
  culprits: string[];
  desktopNavVisible: boolean;
  toggleVisible: boolean;
  practiceAreaLineCount: number;
  bookVisible: boolean;
}> {
  await page.setViewport({ width, height: 800 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const fit = await page.evaluate(() => {
    const isVisible = (element: Element | null): boolean =>
      element !== null && getComputedStyle(element).display !== "none";
    const practiceAreaLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("#nb-menu > a"),
    ).find(
      (anchor) => anchor.textContent?.trim() === "Practice Areas Served",
    );
    const range = document.createRange();
    if (practiceAreaLink) range.selectNodeContents(practiceAreaLink);
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      desktopNavVisible: isVisible(document.querySelector(".nb-links")),
      toggleVisible: isVisible(document.querySelector(".nb-nav-toggle")),
      practiceAreaLineCount: practiceAreaLink
        ? range.getClientRects().length
        : 0,
      bookVisible: isVisible(document.querySelector(".nb-nav-book")),
    };
  });
  if (!fit.overflow) return { ...fit, culprits: [] };

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
  return { ...fit, culprits };
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log(
      "website-header-overflow-tablet: SKIPPED (no chromium binary available)",
    );
    process.exit(0);
  }

  // Discover all committed pages that carry the nb-* header.
  const PAGES = discoverNbHeaderPages();
  console.log(
    `\nDiscovered ${PAGES.length} nb-header page(s) under website/public:`,
  );
  for (const p of PAGES) console.log(`  ${p.path}`);

  if (PAGES.length === 0) {
    console.error("website-header-overflow-tablet: no nb-header pages found — check PUBLIC_DIR");
    process.exit(1);
  }

  // ---- in-process app: ONLY the marketing middleware (committed bundle) ----
  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}`;

  // Verify a sample of pages serve 200 before launching the browser.
  // (Full-page checks happen in the browser loop below.)
  const samplePaths = PAGES.slice(0, 3).map((p) => p.path);
  for (const urlPath of samplePaths) {
    const res = await fetch(`${base}${urlPath}`);
    assert(
      res.status === 200,
      `preview ${urlPath} serves the committed bundle (status ${res.status})`,
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

    // 851–1149px: hamburger avoids the longer label's desktop-row wrap.
    // 1150px: the full desktop row returns. 1399px/1400px straddle the
    // optional desktop book-button + wider-header-cap gate. Keep 1100px and
    // 1319px/1320px pinned because they were the superseded handoffs.
    const WIDTHS = [
      851, 875, 900, 901, 940, 982, 1000, 1050, 1099, 1100, 1149, 1150,
      1319, 1320, 1399, 1400,
    ] as const;

    for (const { label, path: urlPath } of PAGES) {
      console.log(`\n— ${label} header overflow check —`);
      for (const width of WIDTHS) {
        const url = `${base}${urlPath}`;
        const {
          overflow,
          culprits,
          desktopNavVisible,
          toggleVisible,
          practiceAreaLineCount,
          bookVisible,
        } = await checkOverflow(page, url, width);
        const detail = overflow
          ? ` — overflowing element(s): ${culprits.join(", ")}`
          : "";
        assert(
          !overflow,
          `${label} no horizontal overflow at ${width}px viewport${detail}`,
        );
        const expectDesktop = width >= 1150;
        assert(
          desktopNavVisible === expectDesktop,
          `${label} ${expectDesktop ? "desktop nav visible" : "desktop nav hidden"} at ${width}px`,
        );
        assert(
          toggleVisible === !expectDesktop,
          `${label} ${expectDesktop ? "hamburger hidden" : "hamburger visible"} at ${width}px`,
        );
        if (expectDesktop) {
          assert(
            practiceAreaLineCount === 1,
            `${label} Practice Areas Served stays on one line at ${width}px (got ${practiceAreaLineCount})`,
          );
        }
        const expectBook = width >= 1400;
        assert(
          bookVisible === expectBook,
          `${label} desktop book CTA ${expectBook ? "visible" : "hidden"} at ${width}px`,
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
  console.error("website-header-overflow-tablet: unexpected error:", err);
  process.exit(1);
});
