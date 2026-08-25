/* test-registration
{
  "name": "REE calculator browser e2e — drives the committed calculator and homepage bundles, including responsive results plus the period/REE/basis-only handoff to homepage #booking without overwriting visitor text",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 1.9s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared committed-bundle inputs change.",
  "timeoutMs": 240000,
  "scanPaths": [
    "website/public",
    "website/src/calc-client",
    "website/src/client-shared/nav.ts",
    "website/src/client-shared/reeHandoff.ts",
    "website/src/home-client/main.ts",
    "website/src/site-client/main.ts"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Browser coverage for the generated calculator, mobile navigation, and
 * homepage contact handoff.
 *
 * The pure math suite owns arithmetic edge cases. This suite uniquely proves
 * that the committed HTML and client bundles initialize mobile navigation
 * exactly once, expose only the simplified controls, toggle the applicable
 * revenue input, render direct results and improvement values, remain live
 * after submit, and prefill the homepage contact form without overwriting text
 * the visitor already typed.
 *
 * No DB: only the marketing-site middleware is mounted. External hosts are
 * aborted so the run is deterministic offline.
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

function assert(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  for (const binary of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const found = execSync(`which ${binary}`, { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log("website-ree-calculator-e2e: SKIPPED (no chromium binary available)");
    process.exit(0);
  }

  const app = express();
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const previewBase = `http://127.0.0.1:${port}${MARKETING_PREVIEW_PATH}`;

  let browser: { close(): Promise<void> } | null = null;
  try {
    const response = await fetch(`${previewBase}/calculator/`);
    assert(response.status === 200, `preview /calculator/ serves the committed bundle (${response.status})`);

    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const activeBrowser = browser as Awaited<ReturnType<typeof puppeteer.launch>>;
    const page = await activeBrowser.newPage();
    await page.evaluateOnNewDocument("window.__name = (f) => f;");
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      let host = "";
      try {
        host = new URL(request.url()).hostname;
      } catch {
        /* data: etc. */
      }
      if (host && host !== "127.0.0.1") {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    console.log("\n— /calculator/ (simplified calc.js wiring) —");
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: false,
    });
    await page.goto(`${previewBase}/calculator/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("#calc-form button[type=submit]", { timeout: 15000 });

    const mobileNavState = () =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".nb-header");
        const toggle = document.querySelector<HTMLButtonElement>(".nb-nav-toggle");
        return {
          open: header?.classList.contains("nb-menu-open") ?? false,
          expanded: toggle?.getAttribute("aria-expanded") ?? null,
          label: toggle?.getAttribute("aria-label") ?? null,
          toggleFocused: document.activeElement === toggle,
        };
      });
    assert(
      JSON.stringify(await mobileNavState()) ===
        JSON.stringify({
          open: false,
          expanded: "false",
          label: "Open menu",
          toggleFocused: false,
        }),
      "calculator mobile menu starts collapsed",
    );

    await page.tap(".nb-nav-toggle");
    const tappedOpen = await mobileNavState();
    assert(
      tappedOpen.open && tappedOpen.expanded === "true" && tappedOpen.label === "Close menu",
      `one tap opens the calculator menu exactly once (${JSON.stringify(tappedOpen)})`,
    );
    await page.keyboard.press("Escape");
    const tapEscape = await mobileNavState();
    assert(
      !tapEscape.open &&
        tapEscape.expanded === "false" &&
        tapEscape.label === "Open menu" &&
        tapEscape.toggleFocused,
      `Escape closes the tapped menu and restores toggle focus (${JSON.stringify(tapEscape)})`,
    );

    await page.keyboard.press("Enter");
    const enteredOpen = await mobileNavState();
    assert(
      enteredOpen.open &&
        enteredOpen.expanded === "true" &&
        enteredOpen.label === "Close menu",
      `one Enter keypress opens the calculator menu exactly once (${JSON.stringify(enteredOpen)})`,
    );
    await page.keyboard.press("Escape");
    const enterEscape = await mobileNavState();
    assert(
      !enterEscape.open &&
        enterEscape.expanded === "false" &&
        enterEscape.label === "Open menu" &&
        enterEscape.toggleFocused,
      `Escape closes the keyboard-opened menu and restores toggle focus (${JSON.stringify(enterEscape)})`,
    );

    const fieldShape = await page.evaluate(() => {
      const names = Array.from(
        document.querySelectorAll<HTMLInputElement>("#calc-form input[name]"),
        (input) => input.name,
      );
      return {
        names: [...new Set(names)],
        periodValues: Array.from(
          document.querySelectorAll<HTMLInputElement>('input[name="periodMonths"]'),
          (input) => input.value,
        ),
        hasDate: !!document.querySelector('input[type="date"]'),
      };
    });
    const expectedFields = [
      "periodMonths",
      "totalInvestment",
      "leads",
      "consults",
      "cases",
      "revenueBasis",
      "estimatedCaseValue",
      "revenueGenerated",
    ];
    assert(
      JSON.stringify(fieldShape.names.sort()) === JSON.stringify(expectedFields.sort()),
      `form exposes only the simplified controls (${JSON.stringify(fieldShape.names)})`,
    );
    assert(
      fieldShape.periodValues.join(",") === "3,6,12",
      `period control offers exactly 3, 6, and 12 months (${fieldShape.periodValues.join(",")})`,
    );
    assert(!fieldShape.hasDate, "the calculator has no date fields");
    const pageText = await page.$eval("main", (element) => (element as HTMLElement).innerText.toLowerCase());
    for (const removed of [
      "maturity",
      "consults booked",
      "consults held",
      "practice area",
      "market",
      "targets",
      "print or save",
      "measure a cohort",
    ]) {
      assert(!pageText.includes(removed), `removed experience omits "${removed}"`);
    }

    const basisState = () =>
      page.evaluate(() => {
        const generated = document.querySelector<HTMLInputElement>('input[name="revenueGenerated"]')!;
        const estimated = document.querySelector<HTMLInputElement>('input[name="estimatedCaseValue"]')!;
        return {
          generatedDisabled: generated.disabled,
          estimatedDisabled: estimated.disabled,
          generatedOn: !!generated.closest(".calc-basis-opt")?.classList.contains("on"),
          estimatedOn: !!estimated.closest(".calc-basis-opt")?.classList.contains("on"),
        };
      });
    const initialBasis = await basisState();
    assert(
      initialBasis.generatedDisabled &&
        !initialBasis.estimatedDisabled &&
        !initialBasis.generatedOn &&
        initialBasis.estimatedOn,
      `estimated basis enables only estimatedCaseValue (${JSON.stringify(initialBasis)})`,
    );
    await page.click('input[name="revenueBasis"][value="generated"] + span');
    const generatedBasis = await basisState();
    assert(
      !generatedBasis.generatedDisabled &&
        generatedBasis.estimatedDisabled &&
        generatedBasis.generatedOn &&
        !generatedBasis.estimatedOn,
      `generated basis enables only revenueGenerated (${JSON.stringify(generatedBasis)})`,
    );
    await page.click('input[name="revenueBasis"][value="estimated"] + span');

    // Empty submit: visible validation, aria-invalid, and focus on the first
    // invalid control make keyboard recovery explicit.
    await page.click("#calc-form button[type=submit]");
    const validation = await page.evaluate(() => {
      const error = document.querySelector<HTMLElement>("#calc-errors")!;
      return {
        hidden: error.hidden,
        text: error.innerText.toLowerCase(),
        focusedName: (document.activeElement as HTMLInputElement | null)?.name ?? "",
        invalidInvestment:
          document.querySelector('input[name="totalInvestment"]')?.getAttribute("aria-invalid") === "true",
      };
    });
    assert(
      !validation.hidden &&
        validation.text.includes("total investment must be above $0") &&
        validation.invalidInvestment,
      "empty submit shows concise field validation and marks the first money input invalid",
    );
    assert(
      validation.focusedName === "totalInvestment",
      `validation focuses the first invalid control (${validation.focusedName})`,
    );

    const setInput = async (name: string, value: string): Promise<void> => {
      await page.$eval(
        `input[name="${name}"]`,
        (element, next) => {
          const input = element as HTMLInputElement;
          input.value = next as string;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
        value,
      );
    };
    await page.click('input[name="periodMonths"][value="6"] + span');
    await setInput("totalInvestment", "20,000");
    await setInput("leads", "100");
    await setInput("consults", "40");
    await setInput("cases", "10");
    await setInput("estimatedCaseValue", "11,600");
    await page.click("#calc-form button[type=submit]");
    await page.waitForFunction(
      () => {
        const result = document.querySelector<HTMLElement>("#calc-results");
        return !!result && !result.hidden && result.innerHTML.trim() !== "";
      },
      { timeout: 15000 },
    );

    const estimatedText = await page.$eval(
      "#calc-results",
      (element) => (element as HTMLElement).innerText.toLowerCase(),
    );
    assert(estimatedText.includes("your ree"), "result leads with Your REE");
    assert(estimatedText.includes("estimated revenue"), "estimated result clearly labels its revenue basis");
    assert(estimatedText.includes("6-month totals"), "result echoes the selected 6-month period");
    assert(estimatedText.includes("$5.80 per $1"), "estimated result shows $5.80 per $1");
    assert(
      estimatedText.includes("an estimated $5.80 in top-line revenue"),
      "estimated result uses the estimated REE headline",
    );

    const tiles = await page.$$eval("#calc-results .calc-metric", (elements) =>
      elements.map((element) =>
        (element as HTMLElement).innerText.toLowerCase().replace(/\s+/g, " ").trim(),
      ),
    );
    const tileHas = (label: string, value: string): boolean =>
      tiles.some((tile) => tile.includes(label.toLowerCase()) && tile.includes(value.toLowerCase()));
    assert(tiles.length === 8, `all 8 supported direct metrics render (${tiles.length})`);
    assert(tileHas("Estimated revenue", "$116,000"), "estimated revenue is $116,000");
    assert(tileHas("Total investment", "$20,000"), "total investment is $20,000");
    assert(tileHas("Cost per Lead", "$200"), "cost per lead is $200");
    assert(tileHas("Cost per Case", "$2,000"), "cost per case is $2,000");
    assert(tileHas("Lead-to-Consult", "40%"), "lead-to-consult is 40%");
    assert(tileHas("Consult-to-Case", "25%"), "consult-to-case is 25%");
    assert(tileHas("Lead-to-Case", "10%"), "lead-to-case is 10%");
    assert(tileHas("Revenue per Case", "$11,600"), "revenue per case is $11,600");

    const improvements = await page.$$eval("#calc-results .calc-improvement", (elements) =>
      elements.map((element) =>
        (element as HTMLElement).innerText.toLowerCase().replace(/\s+/g, " ").trim(),
      ),
    );
    assert(improvements.length === 4, `exactly 4 direct improvements render (${improvements.length})`);
    for (const label of [
      "more leads",
      "lead-to-consult rate",
      "consult-to-case rate",
      "revenue per case",
    ]) {
      assert(
        improvements.some((row) => row.includes(label) && row.includes("+$11,600")),
        `${label} is worth +$11,600`,
      );
    }
    assert(
      !estimatedText.includes("highest-dollar") && !estimatedText.includes("appears to be"),
      "improvements have no ranking or winner callout",
    );

    const estimatedHref = await page.$eval(
      "#calc-results .calc-handoff a.btn",
      (element) => (element as HTMLAnchorElement).href,
    );
    const estimatedUrl = new URL(estimatedHref);
    assert(
      estimatedUrl.pathname === `${MARKETING_PREVIEW_PATH}/` &&
        estimatedUrl.hash === "#booking",
      `handoff points to homepage #booking (${estimatedUrl.pathname}${estimatedUrl.hash})`,
    );
    assert(
      estimatedHref.indexOf("?") < estimatedHref.indexOf("#booking"),
      `handoff keeps the query before the booking fragment (${estimatedHref})`,
    );
    assert(
      estimatedUrl.searchParams.toString() ===
        "ree_period=6&ree_usd=5.80&ree_basis=estimated",
      `handoff carries only period, REE, and basis (${estimatedUrl.search})`,
    );

    // Invalid post-submit edits dim the existing result; fixing the field
    // immediately recomputes without another submit.
    await setInput("leads", "");
    const stale = await page.$eval("#calc-results", (element) => ({
      stale: element.classList.contains("calc-stale"),
      hidden: (element as HTMLElement).hidden,
    }));
    assert(stale.stale && !stale.hidden, `invalid live edit dims the result (${JSON.stringify(stale)})`);
    await setInput("leads", "100");
    await page.waitForFunction(
      () => !document.querySelector("#calc-results")!.classList.contains("calc-stale"),
      { timeout: 15000 },
    );
    assert(true, "fixing an edit recomputes live without resubmitting");

    // Switch to generated revenue and a 12-month period. Both changes are
    // valid live edits and produce the actual-basis result.
    await page.click('input[name="revenueBasis"][value="generated"] + span');
    await setInput("revenueGenerated", "100,000");
    await page.click('input[name="periodMonths"][value="12"] + span');
    await page.waitForFunction(
      () => document.querySelector("#calc-results")?.textContent?.includes("$5.00 per $1"),
      { timeout: 15000 },
    );
    const actualText = await page.$eval(
      "#calc-results",
      (element) => (element as HTMLElement).innerText.toLowerCase(),
    );
    assert(actualText.includes("actual revenue"), "generated-revenue result clearly labels actual revenue");
    assert(actualText.includes("12-month totals"), "live period change updates the result to 12 months");
    assert(actualText.includes("$5.00 per $1"), "generated revenue recalculates REE to $5.00 per $1");
    assert(
      actualText.includes("currently produces $5.00") &&
        !actualText.includes("an estimated $5.00"),
      "actual result drops the estimated qualifier",
    );
    const actualHref = await page.$eval(
      "#calc-results .calc-handoff a.btn",
      (element) => (element as HTMLAnchorElement).href,
    );
    const actualUrl = new URL(actualHref);
    assert(
      actualUrl.searchParams.toString() === "ree_period=12&ree_usd=5.00&ree_basis=actual",
      `actual handoff stays concise (${actualUrl.search})`,
    );
    assert(actualUrl.hash === "#booking", "actual handoff retains the #booking fragment");

    const mobile = await page.evaluate(() => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      submitWidth: document.querySelector("button[type=submit]")?.getBoundingClientRect().width ?? 0,
    }));
    assert(
      mobile.pageWidth <= mobile.viewport && mobile.submitWidth >= 300,
      `mobile calculator has no horizontal overflow and keeps a wide submit target (${JSON.stringify(mobile)})`,
    );

    await page.focus(".nb-nav-toggle");
    await page.keyboard.press("Enter");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click("#nb-menu .nb-menu-book"),
    ]);
    assert(
      new URL(page.url()).pathname.endsWith("/free-chapters/"),
      `calculator mobile menu navigates to Free Chapters (${new URL(page.url()).pathname})`,
    );
    await page.waitForSelector(".nb-nav-toggle", { timeout: 15000 });
    await page.tap(".nb-nav-toggle");
    assert(
      (await mobileNavState()).expanded === "true",
      "Free Chapters shared mobile navigation still opens",
    );

    await page.goto(`${previewBase}/data-notes/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector(".nb-nav-toggle", { timeout: 15000 });
    await page.tap(".nb-nav-toggle");
    const dataNotesNav = await mobileNavState();
    assert(
      dataNotesNav.open && dataNotesNav.expanded === "true",
      `Data Notes shared mobile navigation still opens (${JSON.stringify(dataNotesNav)})`,
    );

    console.log("\n— homepage #booking (concise home.js contact-message prefill) —");
    await page.goto(actualHref, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector('form[data-nb-inquiry="contact"] textarea[name="message"]', {
      timeout: 15000,
    });
    const prefill = await page.$eval(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      (element) => (element as HTMLTextAreaElement).value,
    );
    assert(prefill.includes("12-month reporting period"), "prefill carries the selected period");
    assert(prefill.includes("$5.00 in revenue per $1"), "prefill carries the REE score");
    assert(prefill.includes("actual revenue basis"), "prefill carries the actual revenue basis");
    assert(
      !/cohort|confidence|lever|upside|10%/i.test(prefill),
      "prefill contains no legacy calculator context",
    );
    await page.type(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      " My own note.",
    );
    const edited = await page.$eval(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      (element) => (element as HTMLTextAreaElement).value,
    );
    assert(edited.endsWith(" My own note."), "prefilled message remains editable");

    // Hold home.js, plant visitor text, then release it. The handoff must not
    // replace an existing message.
    const guardPage = await activeBrowser.newPage();
    await guardPage.evaluateOnNewDocument("window.__name = (f) => f;");
    await guardPage.setRequestInterception(true);
    let releaseHomeJs: (() => void) | null = null;
    const homeJsHeld = new Promise<() => void>((resolve) => {
      guardPage.on("request", (request) => {
        let host = "";
        let pathname = "";
        try {
          const url = new URL(request.url());
          host = url.hostname;
          pathname = url.pathname;
        } catch {
          /* data: etc. */
        }
        if (host && host !== "127.0.0.1") {
          request.abort().catch(() => {});
          return;
        }
        if (pathname.endsWith("/assets/js/home.js") && releaseHomeJs === null) {
          releaseHomeJs = () => request.continue().catch(() => {});
          resolve(releaseHomeJs);
          return;
        }
        request.continue().catch(() => {});
      });
    });
    const guardNavigation = guardPage.goto(actualHref, {
      waitUntil: "load",
      timeout: 30000,
    });
    await homeJsHeld;
    await guardPage.waitForSelector(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      { timeout: 15000 },
    );
    await guardPage.$eval(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      (element) => {
        (element as HTMLTextAreaElement).value = "My own words come first.";
      },
    );
    releaseHomeJs!();
    await guardNavigation;
    const guarded = await guardPage.$eval(
      'form[data-nb-inquiry="contact"] textarea[name="message"]',
      (element) => (element as HTMLTextAreaElement).value,
    );
    assert(guarded === "My own words come first.", "prefill never overwrites visitor-entered text");
    await guardPage.close();

    assert(pageErrors.length === 0, `calculator and homepage raise no browser errors (${pageErrors.join(" | ")})`);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nwebsite-ree-calculator-e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});