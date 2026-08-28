/* test-registration
{
  "name": "Website funnel animation contract — pending→done stamp, top-down veil order, once-only, reduced-motion and JS-off lit parity (Task #5002)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 7.8s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 240000,
  "scanPaths": [
    "website/public",
    "website/src/home-client/engineStory.ts",
    "website/public/assets/css/home.css"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Headless regression guard for the #system funnel scroll focus.
 *
 * Motion-allowed visitors get one focused product stage at a time while the
 * funnel crosses the viewport reading zone. Downward scrolling advances
 * Marketing → Intake → Sales; upward scrolling reverses that order. Outside
 * the active range, all inline focus variables reset to the complete served
 * state. Reduced-motion and JavaScript-disabled visitors never receive the
 * focus stamp or inline dimming variables.
 *
 * No DB, no POSTs. External hosts are aborted via request interception.
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

async function blockExternalRequests(
  page: import("puppeteer-core").Page,
): Promise<void> {
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
}

type FocusState = {
  focus: string | null;
  stages: Array<{ key: string; veil: string; lume: string }>;
};

async function readFocusState(
  page: import("puppeteer-core").Page,
): Promise<FocusState> {
  return page.evaluate(() => {
    const object = document.querySelector<HTMLElement>("[data-fn-object]");
    return {
      focus: object?.getAttribute("data-fn-focus") ?? null,
      stages: Array.from(
        document.querySelectorAll<HTMLElement>("[data-fn-stage]"),
      ).map((stage) => ({
        key: stage.dataset.fnStage ?? "",
        veil: stage.style.getPropertyValue("--fn-veil").trim(),
        lume: stage.style.getPropertyValue("--fn-lume").trim(),
      })),
    };
  });
}

function isZeroOrAbsent(raw: string): boolean {
  if (raw === "") return true;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && Math.abs(value) < 0.01;
}

async function scrollStageToReadingZone(
  page: import("puppeteer-core").Page,
  index: number,
  expectedKey: string,
): Promise<FocusState> {
  await page.evaluate((stageIndex) => {
    const stages = Array.from(
      document.querySelectorAll<HTMLElement>("[data-fn-stage]"),
    );
    const stage = stages[stageIndex];
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const documentY = window.scrollY + rect.top + rect.height / 2;
    window.scrollTo({
      top: documentY - window.innerHeight * 0.52,
      behavior: "instant",
    });
  }, index);
  await page
    .waitForFunction(
      (key) =>
        document
          .querySelector("[data-fn-object]")
          ?.getAttribute("data-fn-focus") === key,
      { timeout: 5_000, polling: 50 },
      expectedKey,
    )
    .catch(() => null);
  await new Promise<void>((resolve) => setTimeout(resolve, 420));
  return readFocusState(page);
}

function assertExclusiveFocus(
  state: FocusState,
  expectedIndex: number,
  expectedKey: string,
  label: string,
): void {
  assert(
    state.focus === expectedKey,
    `${label}: data-fn-focus is ${expectedKey} (got ${String(state.focus)})`,
  );
  assert(
    state.stages.length === 3,
    `${label}: exactly three funnel stages found (got ${state.stages.length})`,
  );
  const focused = state.stages.filter((stage) => {
    const veil = Number.parseFloat(stage.veil);
    const lume = Number.parseFloat(stage.lume);
    return Number.isFinite(veil) && veil < 0.02 && lume >= 0.35;
  });
  assert(
    focused.length === 1 && focused[0]?.key === expectedKey,
    `${label}: exactly ${expectedKey} has the warm active treatment`,
  );
  const peersReadable = state.stages.every((stage, index) => {
    if (index === expectedIndex) return true;
    const veil = Number.parseFloat(stage.veil);
    const lume = Number.parseFloat(stage.lume);
    return veil >= 0.2 && veil <= 0.35 && Math.abs(lume) < 0.02;
  });
  assert(
    peersReadable,
    `${label}: both non-focused stages use the restrained readable veil`,
  );
}

async function waitForReset(
  page: import("puppeteer-core").Page,
): Promise<FocusState> {
  await page
    .waitForFunction(
      () =>
        !document
          .querySelector("[data-fn-object]")
          ?.hasAttribute("data-fn-focus"),
      { timeout: 5_000, polling: 50 },
    )
    .catch(() => null);
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  return readFocusState(page);
}

function assertReset(state: FocusState, label: string): void {
  assert(state.focus === null, `${label}: active focus stamp is removed`);
  assert(
    state.stages.every(
      (stage) => isZeroOrAbsent(stage.veil) && isZeroOrAbsent(stage.lume),
    ),
    `${label}: every stage returns to the complete fully-lit state`,
  );
}

const COMPONENT_LINKS = [
  { key: "casegen", label: "CaseGen™", index: 0 },
  { key: "caseintake", label: "CaseIntake™", index: 1 },
  { key: "caseconvert", label: "CaseConvert™", index: 2 },
] as const;

async function runFragmentLinkScenario(
  browser: import("puppeteer-core").Browser,
  entryUrl: string,
  homeUrl: string,
  viewport: { width: number; height: number },
  label: string,
): Promise<void> {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument("window.__name = (f) => f;");
  await blockExternalRequests(page);

  for (const component of COMPONENT_LINKS) {
    await page.goto(entryUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const rawHref = await page.evaluate((linkLabel) => {
      const footer = document.querySelector(".nb-footer");
      const anchor = Array.from(
        footer?.querySelectorAll<HTMLAnchorElement>("a") ?? [],
      ).find((candidate) => candidate.textContent?.trim() === linkLabel);
      return anchor?.getAttribute("href") ?? null;
    }, component.label);
    assert(
      rawHref !== null,
      `${label}: footer exposes the ${component.label} component link`,
    );
    if (rawHref === null) continue;

    const resolvedUrl = new URL(rawHref, entryUrl).href;
    assert(
      resolvedUrl === `${homeUrl}#${component.key}`,
      `${label}: ${component.label} resolves exactly to homepage #${component.key}`,
    );
    await page.goto(resolvedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForFunction(
        (key) =>
          document
            .querySelector("[data-fn-object]")
            ?.getAttribute("data-fn-focus") === key,
        { timeout: 5_000, polling: 50 },
        component.key,
      )
      .catch(() => null);
    await new Promise<void>((resolve) => setTimeout(resolve, 420));
    assertExclusiveFocus(
      await readFocusState(page),
      component.index,
      component.key,
      `${label} ${component.label} fragment`,
    );
    const alignment = await page.evaluate((key) => {
      const stage = document.getElementById(key);
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      return {
        distance: Math.abs(
          rect.top + rect.height / 2 - window.innerHeight * 0.52,
        ),
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
      };
    }, component.key);
    assert(
      alignment?.visible === true && alignment.distance <= 2,
      `${label}: #${component.key} settles visibly in the funnel reading zone`,
    );
  }

  await page.close();
}

async function runMotionScenario(
  browser: import("puppeteer-core").Browser,
  homeUrl: string,
  viewport: { width: number; height: number },
  label: string,
): Promise<void> {
  const page = await browser.newPage();
  const gsapTargetWarnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/GSAP target .* not found/i.test(text)) {
      gsapTargetWarnings.push(text);
    }
  });
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument("window.__name = (f) => f;");
  await blockExternalRequests(page);
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await new Promise<void>((resolve) => setTimeout(resolve, 600));

  assert(
    gsapTargetWarnings.length === 0,
    `${label}: motion-enabled homepage emits no GSAP target warning${
      gsapTargetWarnings.length ? ` (got ${gsapTargetWarnings.join(" | ")})` : ""
    }`,
  );

  const initial = await readFocusState(page);
  assertReset(initial, `${label} before the funnel range`);

  const keys = ["casegen", "caseintake", "caseconvert"] as const;
  for (let index = 0; index < keys.length; index++) {
    const state = await scrollStageToReadingZone(page, index, keys[index]);
    assertExclusiveFocus(state, index, keys[index], `${label} scroll down`);
  }

  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
  );
  assertReset(await waitForReset(page), `${label} below the funnel range`);

  for (let index = keys.length - 1; index >= 0; index--) {
    const state = await scrollStageToReadingZone(page, index, keys[index]);
    assertExclusiveFocus(state, index, keys[index], `${label} scroll up`);
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  assertReset(await waitForReset(page), `${label} above the funnel range`);

  const geometry = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>("#system");
    const object = document.querySelector<HTMLElement>("[data-fn-object]");
    return {
      pageOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sectionPosition: section ? getComputedStyle(section).position : "",
      objectPosition: object ? getComputedStyle(object).position : "",
    };
  });
  assert(
    geometry.pageOverflow <= 1,
    `${label}: homepage has no horizontal overflow (delta ${geometry.pageOverflow}px)`,
  );
  assert(
    geometry.sectionPosition !== "fixed" &&
      geometry.sectionPosition !== "sticky" &&
      geometry.objectPosition !== "fixed" &&
      geometry.objectPosition !== "sticky",
    `${label}: funnel stays in normal document flow`,
  );

  const fragmentOffsets = await page.evaluate(() => {
    const ids = [
      "system",
      "casegen",
      "caseintake",
      "caseconvert",
      "proof",
      "book",
      "booking",
      "contact",
    ];
    return ids.map((id) => ({
      id,
      offset: Number.parseFloat(
        getComputedStyle(document.getElementById(id)!).scrollMarginBlockStart,
      ),
    }));
  });
  const expectedOffset = viewport.width <= 850 ? 72 : 86;
  assert(
    fragmentOffsets.every((target) => target.offset === expectedOffset),
    `${label}: every live homepage fragment clears the ${expectedOffset}px header offset (${fragmentOffsets
      .map((target) => `#${target.id}=${target.offset}px`)
      .join(", ")})`,
  );

  const touchTargets = await page.evaluate(() => {
    const booking = Array.from(
      document.querySelectorAll<HTMLElement>(".nb-btn[href='#booking'], .nb-booking-cta"),
    )
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => ({
        label: element.textContent?.trim() ?? "",
        height: element.getBoundingClientRect().height,
      }));
    return { booking };
  });
  assert(
    touchTargets.booking.length > 0 &&
      touchTargets.booking.every((target) => target.height >= 44),
    `${label}: every visible booking action has a 44px touch target (${touchTargets.booking
      .map((target) => `${target.height.toFixed(1)}px`)
      .join(", ")})`,
  );

  await page.close();
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log(
      "website-funnel-animation-browser: SKIPPED (no chromium binary available)",
    );
    process.exit(0);
  }

  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  const homeUrl = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}/`;

  const preCheck = await fetch(homeUrl);
  assert(
    preCheck.status === 200,
    `preview / serves the committed bundle (status ${preCheck.status})`,
  );

  const puppeteer = (await import("puppeteer-core")).default;
  let browser: import("puppeteer-core").Browser | null = null;
  try {
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

    console.log("\n── Scenario 1: desktop motion-allowed ──");
    await runMotionScenario(
      browser,
      homeUrl,
      { width: 1280, height: 900 },
      "desktop",
    );

    console.log("\n── Scenario 2: mobile motion-allowed ──");
    await runMotionScenario(
      browser,
      homeUrl,
      { width: 390, height: 844 },
      "mobile",
    );

    console.log("\n── Scenario 3: short viewport initial funnel sync ──");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 260 });
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await page.evaluateOnNewDocument(() => {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const firstStage = document.querySelector<HTMLElement>(
              "[data-fn-stage]",
            );
            if (!firstStage) return;
            const rect = firstStage.getBoundingClientRect();
            window.scrollTo({
              top: Math.max(
                0,
                window.scrollY +
                  rect.top +
                  rect.height / 2 -
                  window.innerHeight * 0.52,
              ),
              behavior: "instant",
            });
          },
          { once: true },
        );
      });
      await blockExternalRequests(page);
      await page.goto(homeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      const initial = await readFocusState(page);
      assert(
        initial.focus !== null &&
          initial.stages.some((stage) => stage.key === initial.focus),
        `short viewport: funnel initializes an active stage when it starts in its trigger zone (got ${String(initial.focus)})`,
      );
      await page.close();
    }

    console.log("\n── Scenario 4: footer component fragments ──");
    const fragmentEntries = [
      { url: homeUrl, label: "homepage footer" },
      { url: `${homeUrl}about/`, label: "nested subpage footer" },
    ] as const;
    const fragmentViewports = [
      { viewport: { width: 1280, height: 900 }, label: "desktop" },
      { viewport: { width: 390, height: 844 }, label: "mobile" },
    ] as const;
    for (const entry of fragmentEntries) {
      for (const viewport of fragmentViewports) {
        await runFragmentLinkScenario(
          browser,
          entry.url,
          homeUrl,
          viewport.viewport,
          `${viewport.label} ${entry.label}`,
        );
      }
    }

    console.log("\n── Scenario 5: prefers-reduced-motion: reduce ──");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluateOnNewDocument("window.__name = (f) => f;");
      await blockExternalRequests(page);
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      await page.goto(`${homeUrl}#caseintake`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      assertReset(
        await readFocusState(page),
        "reduced-motion direct #caseintake arrival",
      );
      const visible = await page.evaluate(() => {
        const rect = document
          .getElementById("caseintake")
          ?.getBoundingClientRect();
        return Boolean(
          rect && rect.bottom > 0 && rect.top < window.innerHeight,
        );
      });
      assert(visible, "reduced-motion #caseintake target is visibly readable");
      await page.close();
    }

    console.log("\n── Scenario 6: JavaScript disabled ──");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await blockExternalRequests(page);
      await page.setJavaScriptEnabled(false);
      await page.goto(`${homeUrl}#caseconvert`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // The no-JS path intentionally keeps native anchor behavior, including
      // the site's CSS smooth scroll. Give that browser-owned scroll time to
      // finish rather than expecting the motion-enabled instant correction.
      await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
      assertReset(
        await readFocusState(page),
        "JavaScript-disabled direct #caseconvert arrival",
      );
      const visible = await page.evaluate(() => {
        const rect = document
          .getElementById("caseconvert")
          ?.getBoundingClientRect();
        return Boolean(
          rect && rect.bottom > 0 && rect.top < window.innerHeight,
        );
      });
      assert(visible, "JavaScript-disabled #caseconvert target is readable");
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
  console.error("website-funnel-animation-browser: unexpected error:", err);
  process.exit(1);
});