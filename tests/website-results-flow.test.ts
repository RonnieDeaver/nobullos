/* test-registration
{
  "name": "Homepage Results flow lands on the complete proof section (Task #5070)",
  "regression": true,
  "sweepOnlyReason": "Task #5070: browser coverage for the user-visible Results journey across homepage, shared subpage, nested page, and marketing 404 chrome; static semantic and marquee suites do not exercise clicking those links or verifying the settled #proof landing.",
  "timeoutMs": 240000,
  "scanPaths": [
    "website/public"
  ],
  "tier": "large",
  "tierReason": "Chromium/browser harness; it consumes a heavyweight external-process resource lane even when the path is deterministic and short."
}
test-registration */
/**
 * Task #5070 — durable browser verification for the consolidated Results flow.
 *
 * The semantic-content suite proves that Results links are emitted and that
 * the proof content is complete. The marquee suite proves motion behavior.
 * This suite covers the missing user journey: clicking Results from each
 * generated chrome context lands on the homepage's #proof section, and the
 * complete proof/testimonial fallback remains visible with reduced motion and
 * JavaScript disabled.
 */

import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import {
  MARKETING_PREVIEW_PATH,
  registerMarketingSite,
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

async function newPage(
  browser: import("puppeteer-core").Browser,
  reducedMotion: boolean,
): Promise<import("puppeteer-core").Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument("window.__name = (f) => f;");
  if (reducedMotion) {
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
  }
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
  return page;
}

async function assertProofLanding(
  page: import("puppeteer-core").Page,
  label: string,
): Promise<void> {
  await page.waitForFunction(() => location.hash === "#proof", {
    timeout: 15_000,
  });
  await sleep(1_000);
  const state = await page.evaluate(() => {
    const proof = document.querySelector("#proof");
    if (!proof) return { top: Number.NaN, viewport: innerHeight };
    return { top: proof.getBoundingClientRect().top, viewport: innerHeight };
  });
  assert(
    Number.isFinite(state.top) &&
      state.top >= -2 &&
      state.top <= Math.max(24, state.viewport * 0.22),
    `${label} settles the proof section near the viewport top (top=${state.top.toFixed(1)}px)`,
  );
}

async function clickResults(
  page: import("puppeteer-core").Page,
  base: string,
  path: string,
  selector: string,
  label: string,
  scrollFooter: boolean,
): Promise<void> {
  await page.goto(`${base}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (scrollFooter) {
    await page.evaluate(() =>
      document.querySelector(".nb-footer")?.scrollIntoView({
        block: "center",
        behavior: "instant",
      }),
    );
    await sleep(100);
  }
  await page.click(selector);
  await assertProofLanding(page, label);
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log("website-results-flow: SKIPPED (no chromium binary available)");
    process.exit(0);
  }

  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}`;

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

    const page = await newPage(b, true);
    await page.setViewport({ width: 1440, height: 900 });
    const clicks = [
      ["/", '.nb-links a[href="#proof"]', "homepage header Results", false],
      ["/", '.nb-footer a[href="#proof"]', "homepage footer Results", true],
      ["/about/", '.nb-links a[href="../#proof"]', "subpage header Results", false],
      ["/about/", '.nb-footer a[href="../#proof"]', "subpage footer Results", true],
      [
        "/resource/closing-30-percent-attorney-leads/",
        '.nb-links a[href="../../#proof"]',
        "nested-page header Results",
        false,
      ],
      [
        "/missing-results-qa/",
        '.nb-links a[href$="#proof"]',
        "404 header Results",
        false,
      ],
    ] as const;
    for (const [path, selector, label, scrollFooter] of clicks) {
      await clickResults(page, base, path, selector, label, scrollFooter);
    }
    await page.close();

    const reducedPage = await newPage(b, true);
    await reducedPage.setViewport({ width: 390, height: 844 });
    await reducedPage.goto(`${base}/#proof`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await reducedPage.waitForSelector(
      '.nb-testimonials[data-testi-mode="static"]',
      { timeout: 15_000 },
    );
    const reduced = await reducedPage.evaluate(() => ({
      videos: document.querySelectorAll(".nb-video-card").length,
      reviews: document.querySelectorAll(".nb-review").length,
      proofText: document.querySelector("#proof")?.textContent ?? "",
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    }));
    assert(
      reduced.videos === 5 && reduced.reviews === 11,
      `reduced-motion view keeps all testimonial cards (videos=${reduced.videos}, reviews=${reduced.reviews})`,
    );
    assert(
      reduced.proofText.includes("3,600+") &&
        reduced.proofText.includes("292") &&
        reduced.proofText.includes("The Presti Law Firm, PLLC"),
      "reduced-motion view keeps the complete flagship proof facts",
    );
    assert(
      reduced.scrollWidth <= reduced.innerWidth,
      `reduced-motion phone view has no horizontal overflow (${reduced.scrollWidth}/${reduced.innerWidth})`,
    );
    await reducedPage.close();

    const noJsPage = await newPage(b, false);
    await noJsPage.setJavaScriptEnabled(false);
    await noJsPage.setViewport({ width: 1440, height: 900 });
    await noJsPage.goto(`${base}/#proof`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const noJs = await noJsPage.evaluate(() => {
      const visible = (selector: string): boolean => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      return {
        videos: document.querySelectorAll(".nb-video-card").length,
        reviews: document.querySelectorAll(".nb-review").length,
        proofVisible: visible(".nb-flag"),
        testimonialVisible: visible(".nb-client-testimonial"),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });
    assert(
      noJs.videos === 5 &&
        noJs.reviews === 11 &&
        noJs.proofVisible &&
        noJs.testimonialVisible,
      `JavaScript-disabled view keeps complete proof/testimonial content (videos=${noJs.videos}, reviews=${noJs.reviews})`,
    );
    assert(
      noJs.scrollWidth <= noJs.innerWidth,
      `JavaScript-disabled view has no horizontal overflow (${noJs.scrollWidth}/${noJs.innerWidth})`,
    );
    await noJsPage.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("website-results-flow: unexpected error:", err);
  process.exit(1);
});