/* test-registration
{
  "name": "Book funnel + direct-checkout + buyer journey + access center browser contract (Tasks #5100/#5101/#5102/#5103/#5104/#5106)",
  "regression": true,
  "sweepOnlyReason": "Tasks #5100/#5101/#5102/#5103: Chromium coverage uniquely verifies the dedicated /book/ surface, fully stubbed direct checkout, and post-purchase buyer journey at phone and desktop widths, including no-overflow stacking, reduced motion, keyboard focus, resilient resume, Stripe Element failures/retries, verified fulfillment, calendar gating/lazy load, privacy-safe thanks state, fail-closed catalog handling, limited chrome, and the sticky mobile purchase utility.",
  "scanPaths": [
    "website/public/book",
    "website/public/assets/css/book.css",
    "website/public/assets/js/book.js",
    "website/public/assets/js/book-checkout.js",
    "website/public/assets/js/home.js",
    "website/public/assets/js/site.js",
    "website/public/assets/js/calc.js",
    "website/src/pages/bookFunnel.ts",
    "website/src/pages/bookPurchaseBridge.ts",
    "website/src/pages/bookBonus.ts",
    "website/src/pages/bookApply.ts",
    "website/src/pages/bookThanks.ts",
    "website/src/pages/bookAccess.ts",
    "website/src/pages/bookOrderStatus.ts",
    "website/src/book-client",
    "website/src/book-checkout-client",
    "website/src/home-client/main.ts",
    "website/src/site-client/main.ts",
    "website/src/calc-client/main.ts"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even though this is a single static route."
}
test-registration */
// SPDX-License-Identifier: MIT

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

function check(condition: unknown, message: string, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}${detail ? ` — ${detail}` : ""}`);
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
      /* try the next binary */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const chromium = findChromium();
  if (!chromium) {
    console.log("book-funnel-browser: SKIPPED (no chromium binary available)");
    process.exit(0);
  }

  let catalogMode: "digital" | "complete" = "digital";
  const checkoutStartBodies: Array<Record<string, unknown>> = [];
  const checkoutContactBodies: Array<Record<string, unknown>> = [];
  let checkoutContactSaved = false;
  let checkoutComplete = false;
  let resumeExpired = false;
  let stripeReturnUrl: string | null = null;
  let paymentIntentFailuresRemaining = 1;
  let externalCalendarRequests = 0;
  let deliverySessionActive = false;
  let deliveryAssetsAvailable = true;
  const deliveryResendBodies: Array<Record<string, unknown>> = [];
  const journeyStartResumeTokens: string[] = [];
  const scheduledAppointmentAt = new Date(Date.now() + 21 * 86_400_000);
  const app = express();
  app.use(express.json());
  app.get("/api/book/checkout/catalog", (_req, res) => {
    const packages = [
      {
        code: "digital",
        name: "Digital Edition",
        amountCents: 499,
        currency: "USD",
        shippingCents: 0,
      },
    ];
    if (catalogMode === "complete") {
      packages.push({
        code: "complete",
        name: "Complete Collection",
        amountCents: 1999,
        currency: "USD",
        shippingCents: 795,
      });
    }
    res.json({ packages });
  });
  app.post("/api/book/checkout/start", (req, res) => {
    checkoutStartBodies.push(req.body as Record<string, unknown>);
    if (req.body?.packageCode !== "digital") {
      return res.status(409).json({ message: "The selected book format is not available" });
    }
    return res.json({
      checkoutSessionId: "checkout-browser-test",
      resumeToken: "a".repeat(64),
      packageCode: "digital",
      status: "pending",
    });
  });
  app.post("/api/book/checkout/contact", (req, res) => {
    checkoutContactBodies.push(req.body as Record<string, unknown>);
    checkoutContactSaved = true;
    res.json({ saved: true });
  });
  app.post("/api/book/checkout/totals", (_req, res) => {
    res.json({
      quoteVersion: 1,
      quoteExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 43,
      amountTotalCents: 542,
      currency: "USD",
    });
  });
  app.post("/api/book/checkout/payment-intent", (_req, res) => {
    if (paymentIntentFailuresRemaining > 0) {
      paymentIntentFailuresRemaining -= 1;
      return res.status(504).json({ message: "Payment provider timed out" });
    }
    return res.json({
      clientSecret: "pi_browser_secret_test",
      publishableKey: "pk_test_browser",
      quoteVersion: 1,
      quoteExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 43,
      amountTotalCents: 542,
      currency: "USD",
      paymentState: "intent_created",
    });
  });
  app.post("/api/test-book-confirm", (_req, res) => {
    stripeReturnUrl =
      typeof _req.body?.returnUrl === "string" ? _req.body.returnUrl : null;
    checkoutComplete = true;
    res.json({ ok: true });
  });
  app.post("/api/book/checkout/resume", (_req, res) => {
    if (resumeExpired) {
      return res.status(410).json({ message: "Checkout session has expired" });
    }
    res.json({
      packageCode: "digital",
      status: checkoutComplete ? "completed" : "pending",
      paymentState: checkoutComplete ? "captured" : "not_started",
      contactComplete: checkoutContactSaved,
      hasContact: true,
      hasQuote: false,
      accessReady: checkoutComplete,
      accessToken: checkoutComplete ? "access-browser-test" : null,
    });
  });
  app.post("/api/book/delivery/exchange", (req, res) => {
    if (req.body?.token !== "access-browser-test") {
      return res.status(404).json({ error: "Access is unavailable." });
    }
    deliverySessionActive = true;
    return res.status(204).end();
  });
  app.get("/api/book/delivery/assets", (_req, res) => {
    if (!deliverySessionActive) {
      return res.status(404).json({ error: "Access is unavailable." });
    }
    res.json({
      assets: deliveryAssetsAvailable
        ? [
            {
              id: "asset-browser-pdf",
              filename: "law-firm-revenue-engine.pdf",
              contentType: "application/pdf",
              entitlementCode: "digital_book",
            },
            {
              id: "asset-browser-audio",
              filename: "law-firm-revenue-engine.m4b",
              contentType: "audio/mp4",
              entitlementCode: "audiobook",
            },
          ]
        : [],
    });
  });
  app.get("/api/book/delivery/order-status", (_req, res) => {
    if (!deliverySessionActive) {
      return res.status(404).json({ error: "Access is unavailable." });
    }
    return res.json({
      order: {
        orderNumber: "NB-BOOK-1007",
        placedAt: "2026-08-20T14:00:00.000Z",
        packageCode: "complete",
        packageLabel: "Complete Collection",
        orderState: "confirmed",
        currency: "USD",
        totalAmountCents: 1999,
        refundedAmountCents: 0,
        digitalDelivery: "available",
        audioDelivery: "available",
        physicalFulfillment: "not_active",
      },
    });
  });
  app.post("/api/book/delivery/resend", (req, res) => {
    deliveryResendBodies.push(req.body as Record<string, unknown>);
    res.status(202).json({ accepted: true });
  });
  app.post("/api/book/journey/start", (req, res) => {
    const resumeToken =
      typeof req.body?.resumeToken === "string" ? req.body.resumeToken : "";
    journeyStartResumeTokens.push(resumeToken);
    res.status(201).json({
      applicationToken: `application-${resumeToken.slice(0, 1) || "browser"}`,
      outcome: "in_progress",
      calendar: { available: false },
      appointment: { status: "pending" },
    });
  });
  app.post("/api/book/journey/submit", (req, res) => {
    res.json({
      applicationToken: req.body?.applicationToken || "application-browser-test",
      outcome: "qualified",
      calendar: {
        available: true,
        url: "https://api.leadconnectorhq.com/widget/bookings/browser-test",
      },
      appointment: { status: "pending" },
    });
  });
  app.post("/api/book/journey/status", (req, res) => {
    if (req.body?.applicationToken === "application-explicit-a") {
      return res.json({
        applicationToken: "application-explicit-a",
        outcome: "manual_review",
        calendar: { available: false },
        appointment: { status: "pending" },
      });
    }
    const endAt = new Date(scheduledAppointmentAt.getTime() + 60 * 60_000);
    res.json({
      applicationToken: req.body?.applicationToken || "application-browser-test",
      outcome: "qualified",
      calendar: {
        available: true,
        url: "https://api.leadconnectorhq.com/widget/bookings/browser-test",
      },
      appointment: {
        status: "scheduled",
        scheduledAt: scheduledAppointmentAt.toISOString(),
        endAt: endAt.toISOString(),
        timezone: "America/Chicago",
        meetingTypeName: "High-Impact Revenue Session",
        hostName: "Verified Host",
        meetingLink: "https://zoom.us/j/browser-test",
      },
    });
  });
  registerMarketingSite(app);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
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
    const activeBrowser = browser as Awaited<ReturnType<typeof puppeteer.launch>>;

    const phone = await activeBrowser.newPage();
    await phone.evaluateOnNewDocument("window.__name = (f) => f;");
    await phone.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await phone.setRequestInterception(true);
    phone.on("request", (request) => {
      let host = "";
      try {
        host = new URL(request.url()).hostname;
      } catch {
        /* data URI etc. */
      }
      if (host && host !== "127.0.0.1") {
        if (host === "api.leadconnectorhq.com") externalCalendarRequests++;
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });
    const pageErrors: string[] = [];
    phone.on("pageerror", (error) => pageErrors.push(String(error)));
    await phone.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: false,
    });
    await phone.goto(`${base}/book/?utm_source=browser-test&utm_campaign=first-half`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await phone.waitForSelector("[data-book-funnel]");
    await phone.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-book-catalog]")?.dataset.ready === "true",
    );

    const mobile = await phone.evaluate(() => {
      const cover = document.querySelector<HTMLImageElement>(".bf-book-object img");
      const darkSections = [...document.querySelectorAll<HTMLElement>("main > section")]
        .filter((section) => {
          const rgb = getComputedStyle(section).backgroundColor.match(/\d+/g)?.map(Number);
          return Boolean(rgb && rgb[0] < 45 && rgb[1] < 45 && rgb[2] < 45);
        });
      const checkoutLinks = [
        ...document.querySelectorAll<HTMLAnchorElement>("[data-book-purchase]"),
      ];
      const bodyText = document.body.innerText;
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        motion: document.documentElement.dataset.bookMotion,
        mainCount: document.querySelectorAll("main").length,
        mainNavCount: document.querySelectorAll('nav[aria-label="Main navigation"]').length,
        coverWidth: cover?.getAttribute("width"),
        coverHeight: cover?.getAttribute("height"),
        darkSections: darkSections.length,
        checkoutPaths: checkoutLinks.map((link) => new URL(link.href).pathname),
        checkoutSources: checkoutLinks.map((link) =>
          new URL(link.href).searchParams.get("utm_source"),
        ),
        checkoutPackages: checkoutLinks.map((link) =>
          new URL(link.href).searchParams.get("package"),
        ),
        freeChapterLinks: document.querySelectorAll('a[href*="free-chapters"]').length,
        videoCount: document.querySelectorAll("video").length,
        lowerSections: document.querySelectorAll(
          ".bf-author-proof,.bf-fit,.bf-formats,.bf-delivery,.bf-faq,.bf-close",
        ).length,
        faqCount: document.querySelectorAll(".bf-faq details").length,
        completeCards: document.querySelectorAll('[data-package="complete"]').length,
        hiddenStickyInert: document
          .querySelector("[data-book-sticky]")
          ?.hasAttribute("inert"),
        hasGuaranteeDisclaimer: Boolean(
          document.querySelector(".bf-model-note")?.textContent?.includes(
            "not a client result or income guarantee",
          ),
        ),
        hasScarcityCopy: /countdown|spots? left|expires? (today|soon)|limited time/i.test(
          bodyText,
        ),
      };
    });
    check(
      mobile.overflow <= 0,
      "390px reduced-motion view has no horizontal overflow",
      `overflow=${mobile.overflow}`,
    );
    check(mobile.motion === "reduce", "reduced-motion preference reaches the page client");
    check(mobile.mainCount === 1, "page has one main landmark");
    check(mobile.mainNavCount === 0, "page has no main-site navigation");
    check(
      Boolean(mobile.coverWidth && mobile.coverHeight),
      "exact cover reserves intrinsic dimensions",
    );
    check(mobile.darkSections === 1, "page has exactly one full-width dark section");
    check(
      mobile.checkoutPaths.length >= 4 &&
        mobile.checkoutPaths.every((path) => path.endsWith("/book/checkout/")) &&
        mobile.checkoutSources.every((source) => source === "browser-test") &&
        mobile.checkoutPackages.every((code) => code === "digital"),
      "all purchase links preserve digital intent and inbound attribution",
      JSON.stringify({
        paths: mobile.checkoutPaths,
        sources: mobile.checkoutSources,
        packages: mobile.checkoutPackages,
      }),
    );
    check(mobile.freeChapterLinks === 0, "paid funnel does not route into free chapters");
    check(mobile.videoCount === 0, "absent optional video emits no placeholder player");
    check(mobile.lowerSections === 6, "all lower-page decision sections render");
    check(mobile.faqCount >= 8, "FAQ answers the full purchase decision set");
    check(
      mobile.completeCards === 0,
      "disabled catalog cannot render or select the Complete Collection",
    );
    check(
      mobile.hiddenStickyInert === true,
      "hidden mobile purchase utility is removed from keyboard focus order",
    );
    check(
      mobile.hasGuaranteeDisclaimer,
      "illustrative outcomes retain the no-guarantee disclosure",
    );
    check(!mobile.hasScarcityCopy, "page contains no countdown or scarcity claim");

    await phone.focus(".bf-hero-cta");
    const focus = await phone.$eval(".bf-hero-cta", (element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    check(
      focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) >= 2,
      "primary checkout action has a visible keyboard focus indicator",
      JSON.stringify(focus),
    );

    await phone.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sticky = await phone.$eval("[data-book-sticky]", (element) => ({
      state: (element as HTMLElement).dataset.state,
      hidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
      transition: getComputedStyle(element).transitionDuration,
    }));
    check(
      sticky.state === "visible" && sticky.hidden === "false" && !sticky.inert,
      "mobile purchase utility becomes visible and keyboard-reachable after the hero leaves the viewport",
      JSON.stringify(sticky),
    );
    check(
      sticky.transition === "0.00001ms" ||
        sticky.transition === "0s" ||
        parseFloat(sticky.transition) <= .01,
      "reduced-motion mode removes sticky-bar animation",
      sticky.transition,
    );
    check(pageErrors.length === 0, "phone view has no page errors", pageErrors.join("; "));
    await phone.close();

    catalogMode = "complete";
    const desktop = await activeBrowser.newPage();
    await desktop.evaluateOnNewDocument("window.__name = (f) => f;");
    await desktop.setViewport({ width: 1440, height: 900 });
    await desktop.goto(`${base}/book/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await desktop.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-book-catalog]")?.dataset.ready === "true",
    );
    const desktopState = await desktop.evaluate(() => {
      const engine = document.querySelector<HTMLElement>(".bf-engine");
      const purchasePackages = [
        ...document.querySelectorAll<HTMLAnchorElement>("[data-book-purchase]"),
      ].map((link) => new URL(link.href).searchParams.get("package"));
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        darkRatio: engine ? engine.offsetHeight / document.documentElement.scrollHeight : 1,
        heroColumns: getComputedStyle(
          document.querySelector<HTMLElement>(".bf-hero-grid")!,
        ).gridTemplateColumns.split(" ").length,
        insideColumns: getComputedStyle(
          document.querySelector<HTMLElement>(".bf-inside-grid")!,
        ).gridTemplateColumns.split(" ").length,
        stickyDisplay: getComputedStyle(
          document.querySelector<HTMLElement>("[data-book-sticky]")!,
        ).display,
        completeCards: document.querySelectorAll('[data-package="complete"]').length,
        purchasePackages,
      };
    });
    check(
      desktopState.overflow <= 0,
      "1440px view has no horizontal overflow",
      `overflow=${desktopState.overflow}`,
    );
    check(desktopState.heroColumns === 2, "desktop hero keeps the approved split composition");
    check(desktopState.insideColumns === 2, "desktop inside-the-book section uses two columns");
    check(
      desktopState.darkRatio <= .3,
      "dark system band remains a concentrated minority of page height",
      `ratio=${desktopState.darkRatio.toFixed(3)}`,
    );
    check(desktopState.stickyDisplay === "none", "mobile purchase utility stays off desktop");
    check(
      desktopState.completeCards === 0 &&
        desktopState.purchasePackages.every((code) => code === "digital"),
      "catalog enablement alone cannot expose a collection the buyer handoff cannot honor",
      JSON.stringify(desktopState),
    );

    // Canonical marketing-site journey: every production entrypoint updates
    // the shared first/latest records, and an untagged checkout retains them.
    await desktop.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await desktop.goto(`${base}/?utm_source=browser-first&utm_campaign=home-campaign`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await desktop.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("nb_first_touch_v1") || "{}").utmSource ===
        "browser-first",
    );
    await desktop.goto(`${base}/about/?utm_source=browser-middle`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await desktop.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("nb_latest_touch_v1") || "{}").utmSource ===
        "browser-middle",
    );
    await desktop.goto(`${base}/calculator/?utm_source=browser-latest`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await desktop.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("nb_latest_touch_v1") || "{}").utmSource ===
        "browser-latest",
    );
    const marketingTouches = await desktop.evaluate(() => ({
      first: JSON.parse(localStorage.getItem("nb_first_touch_v1") || "{}"),
      latest: JSON.parse(localStorage.getItem("nb_latest_touch_v1") || "{}"),
    }));
    check(
      marketingTouches.first.utmSource === "browser-first" &&
        marketingTouches.latest.utmSource === "browser-latest",
      "homepage, subpage, and calculator preserve first touch while advancing latest touch",
      JSON.stringify(marketingTouches),
    );
    await desktop.close();

    // Direct checkout: the Stripe facade is fully stubbed, while application
    // state still travels through the public server contracts.
    catalogMode = "digital";
    const checkoutErrors: string[] = [];
    const checkout = await activeBrowser.newPage();
    checkout.on("pageerror", (error) => checkoutErrors.push(error.message));
    await checkout.evaluateOnNewDocument(`
      window.__name = (f) => f;
      window.__stripeMode = "decline";
      window.Stripe = () => ({
        elements: () => ({
          submit: async () => ({}),
          create: (type) => ({
            mount: (target) => {
              const host = typeof target === "string" ? document.querySelector(target) : target;
              const marker = document.createElement("div");
              marker.dataset.stripeStub = type;
              marker.textContent = type === "payment" ? "Secure payment fields" : "Express checkout";
              host.append(marker);
            },
            on: (event, callback) => {
              if (type === "expressCheckout" && event === "ready") {
                queueMicrotask(() => callback({ availablePaymentMethods: { applePay: true } }));
              }
            },
            destroy: () => {},
          }),
        }),
        confirmPayment: async (options) => {
          if (window.__stripeMode === "decline") {
            return { error: { type: "card_error", message: "Your card was declined." } };
          }
          await fetch("/api/test-book-confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ returnUrl: options.confirmParams.return_url }),
          });
          return { paymentIntent: { status: "processing" } };
        },
      });
    `);
    await checkout.setRequestInterception(true);
    checkout.on("request", (request) => {
      if (request.url().startsWith("https://api.leadconnectorhq.com/")) {
        externalCalendarRequests++;
        void request.abort();
      } else if (request.url().startsWith("https://js.stripe.com/")) {
        void request.abort();
      } else {
        void request.continue();
      }
    });
    await checkout.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await checkout.setViewport({ width: 390, height: 844 });
    await checkout.goto(
      `${base}/book/checkout/?package=forged`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await checkout.waitForSelector("[data-contact-stage]:not([hidden])");
    const initialCheckout = await checkout.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      mainNavs: document.querySelectorAll('[aria-label="Main navigation"]').length,
      phoneRequired: document.querySelector<HTMLInputElement>("#book-phone")?.required,
      smsChecked: document.querySelector<HTMLInputElement>("#book-sms-consent")?.checked,
      motion: document.documentElement.dataset.bookMotion,
      message: document.querySelector("[data-checkout-live]")?.textContent,
    }));
    check(initialCheckout.overflow <= 0, "checkout has no 390px horizontal overflow");
    check(initialCheckout.mainNavs === 0, "checkout keeps distracting main navigation out");
    check(initialCheckout.phoneRequired === false, "checkout keeps phone optional");
    check(initialCheckout.smsChecked === false, "SMS marketing choice defaults unchecked");
    check(initialCheckout.motion === "reduce", "checkout honors reduced motion preference");
    check(
      initialCheckout.message?.includes("not available") === true,
      "tampered package query safely falls back to an enabled server package",
    );
    await checkout.focus("#book-first-name");
    const checkoutFocus = await checkout.$eval("#book-first-name", (element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    check(
      checkoutFocus.outlineStyle !== "none" && parseFloat(checkoutFocus.outlineWidth) >= 2,
      "checkout fields expose a visible keyboard focus indicator",
      JSON.stringify(checkoutFocus),
    );

    await checkout.type("#book-first-name", "Ada");
    await checkout.type("#book-email", "ada@example.com");
    await checkout.click("#book-sms-consent");
    await checkout.click("[data-contact-submit]");
    await checkout.waitForFunction(
      () => document.querySelector('[data-error-for="phone"]')?.textContent?.includes("mobile"),
    );
    check(
      checkoutStartBodies.length === 0,
      "checked SMS choice without an optional phone is rejected before checkout creation",
    );
    await checkout.click("#book-sms-consent");
    await checkout.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("[data-contact-submit]")!;
      button.click();
      button.click();
    });
    await checkout.waitForSelector("[data-payment-stage]:not([hidden])");
    check(checkoutStartBodies.length === 1, "duplicate contact submit creates one durable checkout");
    check(
      checkoutStartBodies[0]?.packageCode === "digital" &&
        (checkoutStartBodies[0]?.firstAttribution as Record<string, unknown>)?.utmSource ===
          "browser-first" &&
        (checkoutStartBodies[0]?.latestAttribution as Record<string, unknown>)?.utmSource ===
          "browser-latest" &&
        !("attribution" in checkoutStartBodies[0]),
      "untagged checkout submits distinct immutable first and latest marketing touches",
    );
    check(
      checkoutContactBodies.length === 1 &&
        checkoutContactBodies[0]?.smsMarketingConsent === false &&
        !("phone" in checkoutContactBodies[0]),
      "contact save preserves separate unchecked SMS evidence and optional phone omission",
    );

    await checkout.reload({ waitUntil: "domcontentloaded" });
    await checkout.waitForSelector("[data-payment-stage]:not([hidden])");
    const refreshed = await checkout.evaluate(() => ({
      stage: !document.querySelector<HTMLElement>("[data-payment-stage]")?.hidden,
      nameValue: document.querySelector<HTMLInputElement>("#book-first-name")?.value,
      otherPackageDisabled: [
        ...document.querySelectorAll<HTMLInputElement>('[name="package"]'),
      ].filter((input) => !input.checked).every((input) => input.disabled),
    }));
    check(refreshed.stage, "refresh resumes the secure payment stage");
    check(refreshed.nameValue === "", "refresh does not repopulate contact PII into browser markup");
    check(
      refreshed.otherPackageDisabled,
      "resumed checkout cannot relabel its server-bound package in the browser",
    );

    await checkout.type("#book-address-line1", "123 Main Street");
    await checkout.type("#book-city", "Denver");
    await checkout.type("#book-state", "CO");
    await checkout.type("#book-postal", "80202");
    await checkout.click("[data-quote-submit]");
    await checkout.waitForFunction(
      () => document.querySelector("[data-checkout-live]")?.textContent?.includes("too long"),
    );
    check(
      await checkout.$eval("[data-stripe-shell]", (element) => (element as HTMLElement).hidden),
      "provider timeout leaves Stripe fields unmounted and retryable",
    );
    await checkout.click("[data-quote-submit]");
    await checkout.waitForSelector('[data-stripe-stub="payment"]');
    await checkout.waitForSelector("[data-express-wrap]:not([hidden])");
    const prepared = await checkout.evaluate(() => ({
      total: document.querySelector("[data-total-final]")?.textContent,
      pay: document.querySelector("[data-pay-button]")?.textContent,
      express: !document.querySelector<HTMLElement>("[data-express-wrap]")?.hidden,
      rawCardInputs: document.querySelectorAll(
        'input[name="card"],input[name="cardNumber"],input[name="cvc"]',
      ).length,
    }));
    check(
      prepared.total === "$5.42" && prepared.pay?.includes("$5.42"),
      "server-authoritative final total is reflected in summary and payment action",
      JSON.stringify(prepared),
    );
    check(prepared.express, "eligible express payment method is rendered");
    check(prepared.rawCardInputs === 0, "checkout never owns raw card inputs");

    await checkout.type("#book-city", " Heights");
    const dirty = await checkout.evaluate(() => ({
      summaryHidden: document.querySelector<HTMLElement>("[data-order-summary]")?.hidden,
      stripeHidden: document.querySelector<HTMLElement>("[data-stripe-shell]")?.hidden,
      payDisabled: document.querySelector<HTMLButtonElement>("[data-pay-button]")?.disabled,
    }));
    check(
      dirty.summaryHidden && dirty.stripeHidden && dirty.payDisabled,
      "address changes invalidate stale totals and payment fields",
      JSON.stringify(dirty),
    );
    await checkout.click("[data-quote-submit]");
    await checkout.waitForSelector('[data-stripe-stub="payment"]');

    await checkout.click("[data-pay-button]");
    await checkout.waitForFunction(
      () => document.querySelector("[data-payment-error]")?.textContent?.includes("declined"),
    );
    check(
      await checkout.$eval("[data-pay-button]", (element) => !(element as HTMLButtonElement).disabled),
      "card decline is actionable and permits a safe retry",
    );
    await checkout.evaluate(() => {
      window.__stripeMode = "success";
    });
    await checkout.click("[data-pay-button]");
    await checkout.waitForFunction(() => location.pathname.endsWith("/book/bonus/"));
    await checkout.waitForSelector("[data-access-book]:not([hidden])");
    const verified = await checkout.evaluate(() => ({
      status: document.querySelector("[data-bonus-status]")?.textContent,
      accessHref: document.querySelector<HTMLAnchorElement>("[data-access-book]")?.href,
      applyVisible: !document.querySelector<HTMLElement>("[data-apply-book-bonus]")?.hidden,
      declineCopy: document.querySelector("[data-access-book-alt]")?.textContent,
    }));
    check(
      verified.status?.includes("Payment verified") === true &&
        verified.accessHref?.includes("/book/access/#access=") === true,
      "only server-verified completion exposes immediate book access",
      JSON.stringify(verified),
    );
    check(
      verified.applyVisible &&
        verified.declineCopy?.includes("No thanks — take me to my book") === true,
      "verified bonus keeps the optional invitation and access-first decline prominent",
      JSON.stringify(verified),
    );
    check(
      stripeReturnUrl?.endsWith("/book/bonus/") === true &&
        !stripeReturnUrl.includes("#") &&
        !stripeReturnUrl.includes("checkout="),
      "Stripe return URL never receives the resume capability",
      stripeReturnUrl ?? "missing",
    );
    check(
      (await checkout.$$eval("iframe", (frames) => frames.length)) === 0,
      "sales page and bonus never load the GHL calendar",
    );
    await checkout.click("[data-apply-book-bonus]");
    await checkout.waitForSelector("[data-application-form]:not([hidden])");
    const applyLayout = await checkout.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      fields: document.querySelectorAll("[data-application-form] .bf-field").length,
      accessCopy: document.querySelector("[data-access-book-alt]")?.textContent,
      calendarFrames: document.querySelectorAll("[data-calendar-shell] iframe").length,
    }));
    check(applyLayout.overflow <= 1, "buyer application has no 390px horizontal overflow");
    check(
      applyLayout.fields === 5,
      "buyer application is bounded to the approved five questions",
      JSON.stringify(applyLayout),
    );
    check(
      applyLayout.accessCopy?.includes("No thanks — take me to my book") === true,
      "application keeps no-booking book access visible",
    );
    check(
      applyLayout.calendarFrames === 0 && externalCalendarRequests === 0,
      "application does not load GHL before an approved route and explicit request",
    );
    for (let index = 0; index < 9; index++) {
      if ((await checkout.evaluate(() => document.activeElement?.id)) === "buyer-practice") break;
      await checkout.keyboard.press("Tab");
    }
    const applyFocus = await checkout.$eval("#buyer-practice", (element) => {
      const style = getComputedStyle(element);
      return {
        focused: document.activeElement === element,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    check(
      applyFocus.focused &&
        ((applyFocus.outlineStyle !== "none" &&
          parseFloat(applyFocus.outlineWidth) >= 2) ||
          applyFocus.boxShadow !== "none"),
      "buyer application fields expose a visible keyboard focus indicator",
      JSON.stringify(applyFocus),
    );
    await checkout.select("#buyer-role", "owner");
    await checkout.type("#buyer-practice", "Family law");
    await checkout.select("#buyer-inquiries", "25_49");
    await checkout.select("#buyer-revenue", "3m_10m");
    await checkout.select("#buyer-timing", "31_90_days");
    await checkout.click("[data-application-submit]");
    await checkout.waitForSelector("[data-outcome-qualified]:not([hidden])");
    check(
      externalCalendarRequests === 0 &&
        (await checkout.$$eval("[data-calendar-shell] iframe", (frames) => frames.length)) === 0,
      "qualified outcome still keeps the GHL embed lazy",
    );
    await checkout.click("[data-load-calendar]");
    await checkout.waitForSelector("[data-calendar-shell] iframe");
    await checkout.$eval("[data-calendar-shell] iframe", (frame) =>
      frame.scrollIntoView({ block: "center" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(
      externalCalendarRequests === 1,
      "approved qualified route loads exactly one GHL calendar request on demand",
      String(externalCalendarRequests),
    );
    await checkout.click("[data-booking-status]");
    await checkout.waitForFunction(() => location.pathname.endsWith("/book/thanks/"));
    await checkout.waitForSelector("[data-appointment-details]:not([hidden])");
    const thanksState = await checkout.evaluate((scheduledAtIso) => {
      const rescheduleLink =
        document.querySelector<HTMLAnchorElement>('a[href$="#contact"]');
      return {
        time: document.querySelector("[data-appointment-time]")?.textContent,
        expectedTime: new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
          timeStyle: "short",
          timeZone: "America/Chicago",
        }).format(new Date(scheduledAtIso)),
        timezone: document.querySelector("[data-appointment-timezone]")?.textContent,
        host: document.querySelector("[data-appointment-host]")?.textContent,
        meetingHref: document.querySelector<HTMLAnchorElement>("[data-meeting-link]")?.href,
        addCalendarHidden: document.querySelector<HTMLElement>("[data-add-calendar]")?.hidden,
        reschedulePath: rescheduleLink ? new URL(rescheduleLink.href).pathname : null,
        rescheduleHash: rescheduleLink ? new URL(rescheduleLink.href).hash : null,
        privateAnswerVisible: document.body.innerText.includes("Family law"),
        accessHref: document.querySelector<HTMLAnchorElement>("[data-access-book-alt]")?.href,
      };
    }, scheduledAppointmentAt.toISOString());
    check(
      thanksState.time === thanksState.expectedTime &&
        thanksState.timezone === "America/Chicago" &&
        thanksState.host === "Verified Host",
      "thanks page renders verified appointment time, timezone, and host",
      JSON.stringify(thanksState),
    );
    check(
      thanksState.meetingHref === "https://zoom.us/j/browser-test" &&
        !thanksState.addCalendarHidden &&
        thanksState.reschedulePath === `${MARKETING_PREVIEW_PATH}/` &&
        thanksState.rescheduleHash === "#contact",
      "thanks page provides meeting, add-to-calendar, and reschedule utilities",
      JSON.stringify(thanksState),
    );
    check(
      !thanksState.privateAnswerVisible,
      "thanks page never exposes private intake answers",
    );
    check(
      thanksState.accessHref?.includes("/book/access/#access=") === true,
      "booking remains independent from continued book access",
      thanksState.accessHref,
    );
    await checkout.click("[data-access-book-alt]");
    await checkout.waitForFunction(() => location.pathname.endsWith("/book/access/"));
    await checkout.waitForSelector(".bf-download");
    const accessCenter = await checkout.evaluate(() => ({
      downloadCount: document.querySelectorAll(".bf-download").length,
      downloadLabels: [...document.querySelectorAll(".bf-download strong")].map(
        (element) => element.textContent,
      ),
      hash: location.hash,
      urlContainsToken: location.href.includes("access-browser-test"),
      markupContainsToken: document.documentElement.outerHTML.includes("access-browser-test"),
      resourceContainsToken: performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("access-browser-test")),
      orderStatusHidden: document.querySelector<HTMLElement>("[data-order-status-link]")?.hidden,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    check(
      accessCenter.downloadCount === 2 &&
        accessCenter.downloadLabels.includes("Download digital book") &&
        accessCenter.downloadLabels.includes("Download audiobook"),
      "secure access capability exchanges into the approved book files",
      JSON.stringify(accessCenter),
    );
    check(
      accessCenter.hash === "" &&
        !accessCenter.urlContainsToken &&
        !accessCenter.markupContainsToken &&
        !accessCenter.resourceContainsToken,
      "access capability is removed before markup, resource requests, or visible history can retain it",
      JSON.stringify(accessCenter),
    );
    check(
      !accessCenter.orderStatusHidden && accessCenter.overflow <= 1,
      "access center exposes order status without mobile horizontal overflow",
      JSON.stringify(accessCenter),
    );

    await checkout.click("[data-order-status-link]");
    await checkout.waitForSelector("[data-order-summary-panel]:not([hidden])");
    const orderStatusState = await checkout.evaluate(() => ({
      number: document.querySelector("[data-order-number]")?.textContent,
      packageLabel: document.querySelector("[data-order-package]")?.textContent,
      total: document.querySelector("[data-order-total]")?.textContent,
      digital: document.querySelector("[data-order-digital]")?.textContent,
      audio: document.querySelector("[data-order-audio]")?.textContent,
      physical: document.querySelector("[data-order-physical]")?.textContent,
      body: document.body.innerText,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    check(
      orderStatusState.number === "NB-BOOK-1007" &&
        orderStatusState.packageLabel === "Complete Collection" &&
        orderStatusState.total === "$19.99" &&
        orderStatusState.digital?.includes("Ready") &&
        orderStatusState.audio?.includes("Ready"),
      "order-status utility renders only verified purchase and active delivery facts",
      JSON.stringify(orderStatusState),
    );
    check(
      orderStatusState.physical?.includes("Not active") === true &&
        orderStatusState.body.includes("never displays an email, address, card information") &&
        !orderStatusState.body.includes("Fixture Buyer") &&
        !orderStatusState.body.includes("Family law") &&
        orderStatusState.overflow <= 1,
      "order status keeps physical fulfillment inactive and private data absent at 390px",
      JSON.stringify(orderStatusState),
    );

    deliveryAssetsAvailable = false;
    await checkout.goto(`${base}/book/access/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await checkout.waitForFunction(() =>
      document.querySelector("[data-access-status]")?.textContent?.includes("no approved download"),
    );
    check(
      (await checkout.$$eval(".bf-download", (links) => links.length)) === 0 &&
        (await checkout.$eval("[data-access-status]", (element) =>
          element.textContent?.includes("We’ll email you when your entitled file is ready"),
        )),
      "active entitlement with no approved asset gets a clear unavailable-file state",
    );
    deliveryAssetsAvailable = true;

    deliverySessionActive = false;
    await checkout.goto(
      `${base}/book/access/?state=invalid#access=${"x".repeat(43)}`,
      {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
      },
    );
    await checkout.waitForFunction(() =>
      document.querySelector("[data-access-status]")?.textContent?.includes("unavailable or has expired"),
    );
    await checkout.type("#access-email", "unknown@example.com");
    await checkout.click("[data-delivery-resend-form] button");
    await checkout.waitForFunction(() =>
      document.querySelector("[data-resend-status]")?.textContent?.includes(
        "If an active purchase matches this address",
      ),
    );
    const unavailableState = await checkout.evaluate(() => ({
      hash: location.hash,
      status: document.querySelector("[data-access-status]")?.textContent,
      resend: document.querySelector("[data-resend-status]")?.textContent,
      support: document.querySelector(".bf-access-help")?.textContent,
    }));
    check(
      unavailableState.hash === "" &&
        unavailableState.status?.includes("unavailable or has expired") &&
        unavailableState.resend?.includes("If an active purchase matches") &&
        unavailableState.support?.includes("refund, revocation, or unavailable file") &&
        deliveryResendBodies.at(-1)?.email === "unknown@example.com",
      "invalid, expired, revoked, or refunded access stays generic with an enumeration-safe recovery path",
      JSON.stringify(unavailableState),
    );

    const checkoutB = "b".repeat(64);
    await checkout.evaluate((resumeToken) => {
      sessionStorage.setItem("nb_book_checkout_resume_v1", resumeToken);
      sessionStorage.removeItem(
        `nb_book_buyer_application_v1:${resumeToken.slice(0, 16)}`,
      );
    }, checkoutB);
    await checkout.goto(
      `${base}/book/apply/#application=application-explicit-a`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await checkout.waitForSelector("[data-outcome-manual]:not([hidden])");
    const explicitScopedToken = await checkout.evaluate((resumeToken) =>
      sessionStorage.getItem(
        `nb_book_buyer_application_v1:${resumeToken.slice(0, 16)}`,
      ), checkoutB);
    await checkout.goto(`${base}/book/apply/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await checkout.waitForSelector("[data-application-form]:not([hidden])");
    const checkoutBScopedToken = await checkout.evaluate((resumeToken) =>
      sessionStorage.getItem(
        `nb_book_buyer_application_v1:${resumeToken.slice(0, 16)}`,
      ), checkoutB);
    check(
      explicitScopedToken === null &&
        journeyStartResumeTokens.at(-1) === checkoutB &&
        checkoutBScopedToken === "application-b",
      "an explicit application capability cannot contaminate another checkout’s recovery slot",
      JSON.stringify({
        explicitScopedToken,
        lastStart: journeyStartResumeTokens.at(-1),
        checkoutBScopedToken,
      }),
    );
    resumeExpired = true;
    checkoutComplete = false;
    await checkout.evaluate(() => {
      sessionStorage.setItem("nb_book_checkout_resume_v1", "b".repeat(64));
    });
    await checkout.goto(`${base}/book/checkout/?package=digital`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await checkout.waitForSelector("[data-contact-stage]:not([hidden])");
    const expiredRecovery = await checkout.evaluate(() => ({
      message: document.querySelector("[data-checkout-live]")?.textContent,
      storedToken: sessionStorage.getItem("nb_book_checkout_resume_v1"),
    }));
    check(
      expiredRecovery.message?.includes("expired") === true &&
        expiredRecovery.storedToken === null,
      "expired resume state is cleared and recovers to a fresh actionable checkout",
      JSON.stringify(expiredRecovery),
    );
    check(
      checkoutErrors.length === 0,
      "checkout, bonus, and access views have no browser errors",
      checkoutErrors.join("; "),
    );
    await checkout.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("book-funnel-browser: unexpected error:", error);
  process.exit(1);
});