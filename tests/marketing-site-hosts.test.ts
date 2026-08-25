/* test-registration
{
  "name": "Marketing website host routing (Task #3740)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3740: marketing-website host routing — apex/www must get the static marketing bundle (with www→apex redirect + marketing 404), while the OS host keeps the SPA shell and /website-preview stays reviewable pre-DNS. DB-free express-on-ephemeral-port suite; a drift here either breaks the public website or, worse, leaks the OS shell onto the marketing domain.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3740: host-routing coverage for the nobullmarketing.com marketing
// website. One deployment serves two audiences: marketing hosts (apex + www)
// get the static marketing bundle, every other host (reports., *.replit.dev)
// keeps getting the OS SPA shell, and /website-preview serves the same bundle
// on the OS hosts so the design can be reviewed before DNS is connected.
//
// The suite mounts registerMarketingSite() on a bare express app whose final
// catch-all responds with a recognizable SPA sentinel, then drives raw
// http.request calls with spoofed Host / X-Forwarded-Host headers.
//
// Usage: tsx tests/marketing-site-hosts.test.ts

import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";

const SPA_SENTINEL = "OS_SPA_SHELL_SENTINEL";
const APEX = "nobullmarketing.com";
const WWW = "www.nobullmarketing.com";
const OS_HOST = "reports.nobullmarketing.com";
const LEGACY_EPISODE_13_PATH = "/resource/episode-13/";
const CANONICAL_EPISODE_13_PATH =
  "/resource/episode-13-interview-with-brita-long-founder-of-the-happier-attorney-llc/";
const EPISODE_15_SLUG =
  "episode-15-lila-m-seif-ceo-founder-of-new-family-fertility-law";
const PODCAST_SLUGS = [
  "episode-21-evolving-family-law-to-meet-unique-lgbtq-non-traditional-family-needs",
  "episode-20-positive-divorce-through-mediation-interview-with-top-1-5-divorce-beyond-podcast-host-susan-guthrie",
  "episode-19-interview-with-hayley-lisa-certified-divorce-coach-for-men",
  "episode-18-interview-with-rebecca-stahl-somatic-experiencing-professional-attorney-trauma-researcher",
  "episode-17-interview-with-nick-himonidis-high-tech-private-investigator-ceo-of-the-ngh-group",
  "episode-16-gullu-singh-meditation-teacher-real-estate-lawyer",
  EPISODE_15_SLUG,
  "episode-14-sara-scott-ceo-of-center-for-legal-inclusiveness",
  "episode-13-interview-with-brita-long-founder-of-the-happier-attorney-llc",
  "episode-12-interview-with-ed-kless-soul-of-enterprise-radio-talk-show-sage-thought-leadership-podcast-host",
] as const;

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let port = 0;

function request(
  path: string,
  opts: { host?: string; xfHost?: string; method?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host) headers["Host"] = opts.host;
    if (opts.xfHost) headers["X-Forwarded-Host"] = opts.xfHost;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method || "GET",
        headers,
        agent: false, // no keep-alive sockets to leak past the summary
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function testMarketingApexServesBundle(): Promise<void> {
  console.log("\nMarketing apex serves the marketing bundle, never the SPA");
  const res = await request("/", { host: APEX });
  check("HTTP 200", res.status === 200, `got ${res.status}`);
  check("marketing HTML", /NoBull/i.test(res.body) && /<html/i.test(res.body));
  check("not the SPA shell", !res.body.includes(SPA_SENTINEL));
  check(
    "marketing CSP header set",
    String(res.headers["content-security-policy"] || "").includes("default-src"),
  );
  const csp = String(res.headers["content-security-policy"] || "");
  check(
    "marketing CSP has no Calendly embed allowances",
    !/assets\.calendly\.com|https:\/\/\*?\.?calendly\.com/.test(csp),
    csp,
  );
  check(
    "marketing CSP narrowly allows the Google reCAPTCHA script",
    /script-src[^;]*https:\/\/www\.google\.com\/recaptcha\//.test(csp) &&
      /script-src[^;]*https:\/\/www\.gstatic\.com\/recaptcha\//.test(csp),
    csp,
  );
  check(
    "marketing CSP narrowly allows the Google reCAPTCHA frame",
    /frame-src[^;]*https:\/\/www\.google\.com\/recaptcha\//.test(csp) &&
      /frame-src[^;]*https:\/\/www\.gstatic\.com\/recaptcha\//.test(csp),
    csp,
  );
  check(
    "marketing CSP narrowly allows Google reCAPTCHA traffic",
    /connect-src[^;]*https:\/\/www\.google\.com\/recaptcha\//.test(csp) &&
      !csp.includes("challenges.cloudflare.com"),
    csp,
  );
  check(
    "html is no-cache",
    String(res.headers["cache-control"] || "").includes("no-cache"),
  );

  const css = await request("/assets/css/site.css", { host: APEX });
  check("asset 200", css.status === 200, `got ${css.status}`);
  check(
    "asset gets long cache",
    String(css.headers["cache-control"] || "").includes("max-age=86400"),
    `got ${css.headers["cache-control"]}`,
  );
}

async function testWwwRedirectsToApex(): Promise<void> {
  console.log("\nwww host 301-redirects to the apex, preserving path + query");
  const res = await request("/about/?utm=x", { host: WWW });
  check("301", res.status === 301, `got ${res.status}`);
  check(
    "Location -> apex with path+query",
    res.headers.location === `https://${APEX}/about/?utm=x`,
    `got ${res.headers.location}`,
  );
}

async function testDirectorySlashRedirect(): Promise<void> {
  console.log("\n/about -> /about/ so relative asset links resolve");
  const res = await request("/about", { host: APEX });
  check("301", res.status === 301, `got ${res.status}`);
  check(
    "Location ends with /about/",
    String(res.headers.location || "").endsWith("/about/"),
    `got ${res.headers.location}`,
  );
}

async function testBookFunnelRoutes(): Promise<void> {
  console.log("\n/book/ serves the focused paid-book funnel on both marketing surfaces");
  const apex = await request("/book/?utm_source=host-test", { host: APEX });
  check("book funnel HTTP 200", apex.status === 200, `got ${apex.status}`);
  check(
    "book funnel marker and offer",
    apex.body.includes("data-book-funnel") &&
      apex.body.includes("Choose the Digital Edition — $4.99") &&
      apex.body.includes("$4.99"),
  );
  check(
    "book funnel includes the complete lower-page decision path",
    apex.body.includes('class="bf-author-proof"') &&
      apex.body.includes('class="bf-formats"') &&
      apex.body.includes('class="bf-delivery"') &&
      apex.body.includes('class="bf-faq"') &&
      apex.body.includes('class="bf-close"'),
  );
  check(
    "disabled Complete Collection is absent from generated HTML",
    !apex.body.includes("Complete Collection") && !apex.body.includes("$19.99"),
  );
  check(
    "book funnel uses limited chrome",
    !apex.body.includes('aria-label="Main navigation"') &&
      !apex.body.includes("nb-nav-toggle"),
  );
  check(
    "paid funnel stays separate from free chapters",
    !apex.body.includes("free-chapters/"),
  );
  check("book funnel never falls through to SPA", !apex.body.includes(SPA_SENTINEL));

  const purchaseHref =
    /<a\b[^>]*href="([^"]+)"[^>]*data-book-purchase/.exec(apex.body)?.[1] ?? "";
  const purchaseUrl = purchaseHref
    ? new URL(purchaseHref, `https://${APEX}/book/`)
    : null;
  check(
    "book purchase utility points to the focused local handoff",
    purchaseUrl?.pathname === "/book/checkout/" &&
      purchaseUrl.searchParams.get("package") === "digital",
    `got ${purchaseHref || "<missing>"}`,
  );
  const purchase = await request(
    `${purchaseUrl?.pathname ?? "/book/checkout/"}${purchaseUrl?.search ?? ""}`,
    { host: APEX },
  );
  check("book purchase handoff HTTP 200", purchase.status === 200, `got ${purchase.status}`);
  check(
    "book purchase handoff is the focused direct checkout",
    purchase.body.includes("data-book-checkout") &&
      purchase.body.includes("Where should we send your book?") &&
      purchase.body.includes("data-payment-element") &&
      purchase.body.includes("One-time purchase") &&
      !purchase.body.includes("Main navigation"),
  );
  check(
    "checkout SMS choice is separate, optional, and unchecked",
    purchase.body.includes('id="book-phone"') &&
      !purchase.body.includes('id="book-phone" name="phone" type="tel" required') &&
      purchase.body.includes('id="book-sms-consent" name="smsMarketingConsent" type="checkbox"') &&
      !purchase.body.includes('id="book-sms-consent" name="smsMarketingConsent" type="checkbox" checked'),
  );
  check(
    "checkout loads Stripe-hosted payment fields without raw card inputs",
    purchase.body.includes("https://js.stripe.com/v3/") &&
      !/name="(?:card|cardNumber|cvc|expiry)"/i.test(purchase.body),
  );
  check(
    "book purchase handoff never falls through to SPA",
    !purchase.body.includes(SPA_SENTINEL),
  );

  const access = await request("/book/access/", { host: APEX });
  check("book access center HTTP 200", access.status === 200, `got ${access.status}`);
  check(
    "book access center is private-session UI, not a file directory",
    access.body.includes("data-book-access") &&
      access.body.includes('name="robots" content="noindex,nofollow"') &&
      access.body.includes("Send a new access link") &&
      !/PRIVATE_OBJECT_DIR|object_key|https?:\/\/[^"]+\.(?:pdf|epub|m4b)/i.test(access.body),
  );

  const orderStatus = await request("/book/order-status/", { host: APEX });
  check(
    "book order-status utility HTTP 200",
    orderStatus.status === 200,
    `got ${orderStatus.status}`,
  );
  check(
    "order-status shell is noindex and contains no personal or physical fulfillment detail",
    orderStatus.body.includes("data-book-order-status") &&
      orderStatus.body.includes('name="robots" content="noindex,nofollow"') &&
      orderStatus.body.includes("Checking your secure order session") &&
      !/shipping address|tracking number|card number/i.test(orderStatus.body),
  );

  const slash = await request("/book", { host: APEX });
  check("/book redirects to /book/", slash.status === 301, `got ${slash.status}`);
  check(
    "/book redirect location keeps directory slash",
    String(slash.headers.location || "").endsWith("/book/"),
    `got ${slash.headers.location}`,
  );

  const preview = await request(`${MARKETING_PREVIEW_PATH}/book/`, {
    host: OS_HOST,
  });
  check("preview book funnel HTTP 200", preview.status === 200, `got ${preview.status}`);
  check(
    "preview book funnel stays noindexed",
    String(preview.headers["x-robots-tag"] || "").includes("noindex"),
  );
  check(
    "preview serves the same focused funnel",
    preview.body.includes("data-book-funnel") && !preview.body.includes(SPA_SENTINEL),
  );
}

async function testLegacyEpisode13Redirect(): Promise<void> {
  console.log(
    "\nLegacy Episode 13 short link redirects once to the canonical Brita Long article",
  );
  for (const testCase of [
    {
      name: "marketing apex",
      path: LEGACY_EPISODE_13_PATH,
      host: APEX,
      location: CANONICAL_EPISODE_13_PATH,
    },
    {
      name: "preview path",
      path: `${MARKETING_PREVIEW_PATH}${LEGACY_EPISODE_13_PATH}`,
      host: OS_HOST,
      location: `${MARKETING_PREVIEW_PATH}${CANONICAL_EPISODE_13_PATH}`,
    },
  ]) {
    const redirect = await request(testCase.path, { host: testCase.host });
    check(
      `${testCase.name} alias -> 301`,
      redirect.status === 301,
      `got ${redirect.status}`,
    );
    check(
      `${testCase.name} alias targets canonical route`,
      redirect.headers.location === testCase.location,
      `got ${redirect.headers.location}`,
    );
    const target = await request(testCase.location, { host: testCase.host });
    check(
      `${testCase.name} canonical target -> 200`,
      target.status === 200,
      `got ${target.status}`,
    );
  }
}

async function testMarketing404NeverSpa(): Promise<void> {
  console.log("\nUnknown marketing URL gets the marketing 404, never the OS shell");
  const res = await request("/definitely-not-a-page/", { host: APEX });
  check("404", res.status === 404, `got ${res.status}`);
  check("marketing 404 page", res.body.includes("Page Not Found"));
  check("not the SPA shell", !res.body.includes(SPA_SENTINEL));

  const post = await request("/", { host: APEX, method: "POST" });
  check("non-GET on marketing host -> 404", post.status === 404, `got ${post.status}`);
  check("non-GET body is marketing 404", post.body.includes("Page Not Found"));

  const services = await request("/services/", { host: APEX });
  check("retired /services/ -> 404", services.status === 404, `got ${services.status}`);
  check(
    "retired /services/ gets branded marketing 404",
    services.body.includes("Page Not Found") &&
      services.body.includes("NoBull") &&
      !services.body.includes(SPA_SENTINEL),
  );
}

async function testVersionedLegalRoutes(): Promise<void> {
  console.log("\nVersioned funnel policy routes remain fail-closed and compatible");
  for (const path of ["/privacy-policy/", "/privacy/", "/terms/", "/shipping-returns/"]) {
    const apex = await request(path, { host: APEX });
    check(`${path} serves on marketing host`, apex.status === 200, `got ${apex.status}`);
    check(`${path} exposes durable policy metadata`, apex.body.includes("data-policy-version="));

    const preview = await request(`${MARKETING_PREVIEW_PATH}${path}`, { host: OS_HOST });
    check(`${path} serves on preview path`, preview.status === 200, `got ${preview.status}`);
  }
  const terms = await request("/terms/", { host: APEX });
  check(
    "unapproved terms explicitly block paid checkout",
    terms.body.includes("paid book checkout is unavailable"),
  );
  check(
    "pending policies use durable display versions without implying approval",
    terms.body.includes('data-policy-version="terms-pending-2026-08-21"') &&
      !terms.body.includes('data-policy-version="not assigned"'),
  );
}

async function testInternalBundleFilesBlocked(): Promise<void> {
  console.log("\nInternal bundle files are not directly reachable");
  const nf = await request("/404.html", { host: APEX });
  check("/404.html -> 404", nf.status === 404, `got ${nf.status}`);
  const sm = await request("/sitemap-pages.json", { host: APEX });
  check("/sitemap-pages.json -> 404", sm.status === 404, `got ${sm.status}`);
}

async function testApiPassthrough(): Promise<void> {
  console.log("\n/api/* passes through on marketing hosts (demo form posts here)");
  const res = await request("/api/ping", { host: APEX });
  check("API handler reached", res.status === 200, `got ${res.status}`);
  check("API json body", res.body.includes('"api":true'), res.body.slice(0, 80));
}

async function testEngineStoryAssetsServed(): Promise<void> {
  console.log(
    "\nProduct section (Task #4992): homepage assets served, cinematic frame world gone",
  );
  const hero = await request("/nobull-redesign/brand/machinery-hero.webp", {
    host: APEX,
  });
  check("brand hero 200", hero.status === 200, `got ${hero.status}`);
  check(
    "brand hero is webp",
    String(hero.headers["content-type"] || "").includes("webp"),
    `got ${hero.headers["content-type"]}`,
  );
  const previewHero = await request(
    `${MARKETING_PREVIEW_PATH}/nobull-redesign/brand/machinery-hero.webp`,
    { host: OS_HOST },
  );
  check(
    "preview path serves homepage imagery",
    previewHero.status === 200,
    `got ${previewHero.status}`,
  );

  // Task #4837 removed the pinned cinematic and its 144-frame WebP
  // sequence: the frame directories are deleted, so the old frame URLs
  // must 404 on the marketing host and neither the bundle nor the served
  // homepage may reference them again.
  const frame = await request(
    "/nobull-redesign/revenue-engine/frames/desktop/rev-engine_0001.webp",
    { host: APEX },
  );
  check(
    "cinematic frames gone (404)",
    frame.status === 404,
    `got ${frame.status}`,
  );

  const js = await request("/assets/js/home.js", { host: APEX });
  check("home.js 200", js.status === 200, `got ${js.status}`);
  check(
    "no frame fetch base in home.js",
    !js.body.includes("revenue-engine/frames"),
  );
  check(
    "reduced-motion gate present in home.js",
    js.body.includes("prefers-reduced-motion"),
  );

  const css = await request("/assets/css/home.css", { host: APEX });
  check("home.css 200", css.status === 200, `got ${css.status}`);
  check(
    "product funnel styles served",
    css.body.includes(".nb-funnel") && css.body.includes(".nb-fn-stage"),
  );

  const home = await request("/", { host: APEX });
  check(
    "homepage carries the #system product funnel, not frame bases",
    home.body.includes('id="system"') && !home.body.includes("data-frame-base"),
  );
}

async function testRetiredConversionRouteRedirects(): Promise<void> {
  console.log(
    "\nRetired /book-free-demo/ and /contact/ permanently redirect to homepage anchors",
  );
  for (const { path: retiredPath, anchor } of [
    { path: "/book-free-demo/", anchor: "#booking" },
    { path: "/contact/", anchor: "#contact" },
  ]) {
    // Plain redirect on apex
    const apex = await request(retiredPath, { host: APEX });
    check(
      `apex ${retiredPath} -> 301`,
      apex.status === 301,
      `got ${apex.status}`,
    );
    check(
      `apex ${retiredPath} location -> /${anchor}`,
      apex.headers.location === `/${anchor}`,
      `got ${apex.headers.location}`,
    );
    const apexHead = await request(retiredPath, {
      host: APEX,
      method: "HEAD",
    });
    check(
      `apex HEAD ${retiredPath} -> 301`,
      apexHead.status === 301 && apexHead.headers.location === `/${anchor}`,
      `got ${apexHead.status} ${apexHead.headers.location}`,
    );
    const apexPost = await request(retiredPath, {
      host: APEX,
      method: "POST",
    });
    check(
      `apex POST ${retiredPath} keeps branded-404 behavior`,
      apexPost.status === 404 && !apexPost.headers.location,
      `got ${apexPost.status} ${apexPost.headers.location}`,
    );

    // Query string preserved and placed BEFORE the fragment
    const withQuery = await request(`${retiredPath}?utm_source=test`, {
      host: APEX,
    });
    check(
      `apex ${retiredPath}?utm_source=test -> 301`,
      withQuery.status === 301,
      `got ${withQuery.status}`,
    );
    check(
      `apex ${retiredPath} query precedes fragment in redirect`,
      withQuery.headers.location === `/?utm_source=test${anchor}`,
      `got ${withQuery.headers.location}`,
    );

    // Alias canonicalization remains the first hop; apex then applies the
    // retired-route redirect above without losing attribution.
    const alias = await request(`${retiredPath}?utm_source=test`, {
      host: WWW,
    });
    check(
      `www ${retiredPath} canonicalizes before the route redirect`,
      alias.status === 301 &&
        alias.headers.location ===
          `https://${APEX}${retiredPath}?utm_source=test`,
      `got ${alias.status} ${alias.headers.location}`,
    );
    const aliasPost = await request(retiredPath, {
      host: WWW,
      method: "POST",
    });
    check(
      `www POST ${retiredPath} canonicalizes before the method gate`,
      aliasPost.status === 301 &&
        aliasPost.headers.location === `https://${APEX}${retiredPath}`,
      `got ${aliasPost.status} ${aliasPost.headers.location}`,
    );

    // Same redirects on the preview path
    const previewRetired = await request(
      `${MARKETING_PREVIEW_PATH}${retiredPath}`,
      { host: OS_HOST },
    );
    check(
      `preview ${retiredPath} -> 301`,
      previewRetired.status === 301,
      `got ${previewRetired.status}`,
    );
    check(
      `preview ${retiredPath} location -> ${MARKETING_PREVIEW_PATH}/${anchor}`,
      previewRetired.headers.location ===
        `${MARKETING_PREVIEW_PATH}/${anchor}`,
      `got ${previewRetired.headers.location}`,
    );
    const previewHead = await request(
      `${MARKETING_PREVIEW_PATH}${retiredPath}`,
      { host: OS_HOST, method: "HEAD" },
    );
    check(
      `preview HEAD ${retiredPath} -> 301`,
      previewHead.status === 301 &&
        previewHead.headers.location ===
          `${MARKETING_PREVIEW_PATH}/${anchor}`,
      `got ${previewHead.status} ${previewHead.headers.location}`,
    );
    const previewPost = await request(
      `${MARKETING_PREVIEW_PATH}${retiredPath}`,
      { host: OS_HOST, method: "POST" },
    );
    check(
      `preview POST ${retiredPath} keeps branded-404 behavior`,
      previewPost.status === 404 && !previewPost.headers.location,
      `got ${previewPost.status} ${previewPost.headers.location}`,
    );

    const previewWithQuery = await request(
      `${MARKETING_PREVIEW_PATH}${retiredPath}?utm_source=test`,
      { host: OS_HOST },
    );
    check(
      `preview ${retiredPath}?utm_source=test -> 301`,
      previewWithQuery.status === 301,
      `got ${previewWithQuery.status}`,
    );
    check(
      `preview ${retiredPath} query precedes fragment in redirect`,
      previewWithQuery.headers.location ===
        `${MARKETING_PREVIEW_PATH}/?utm_source=test${anchor}`,
      `got ${previewWithQuery.headers.location}`,
    );
  }
}

async function testSitemapAndRobots(): Promise<void> {
  console.log("\nMarketing-host-only sitemap.xml + robots.txt");
  const sm = await request("/sitemap.xml", { host: APEX });
  check("sitemap 200", sm.status === 200, `got ${sm.status}`);
  check(
    "sitemap is xml",
    String(sm.headers["content-type"] || "").includes("xml"),
    `got ${sm.headers["content-type"]}`,
  );
  check("sitemap urlset", sm.body.includes("<urlset"));
  check("sitemap uses apex origin", sm.body.includes(`https://${APEX}/`));
  check(
    "sitemap omits retired /services/",
    !sm.body.includes(`https://${APEX}/services/`),
  );
  check(
    "sitemap excludes retired /book-free-demo/",
    !sm.body.includes(`https://${APEX}/book-free-demo/`),
  );
  check(
    "sitemap excludes retired /contact/",
    !sm.body.includes(`https://${APEX}/contact/`),
  );
  const resourceUrls =
    sm.body.match(
      new RegExp(`<loc>https://${APEX}/resource/[^<]+</loc>`, "g"),
    ) ?? [];
  check(
    "sitemap keeps exactly 15 canonical resources",
    resourceUrls.length === 15,
    `got ${resourceUrls.length}`,
  );
  check(
    "sitemap includes canonical Brita Long article",
    sm.body.includes(
      `<loc>https://${APEX}${CANONICAL_EPISODE_13_PATH}</loc>`,
    ),
  );
  check(
    "sitemap excludes legacy Episode 13 alias",
    !sm.body.includes(`<loc>https://${APEX}${LEGACY_EPISODE_13_PATH}</loc>`),
  );

  const rb = await request("/robots.txt", { host: APEX });
  check("robots 200", rb.status === 200, `got ${rb.status}`);
  check(
    "robots points at sitemap",
    rb.body.includes(`Sitemap: https://${APEX}/sitemap.xml`),
  );

  const osSm = await request("/sitemap.xml", { host: OS_HOST });
  check(
    "OS host /sitemap.xml falls through to SPA",
    osSm.body.includes(SPA_SENTINEL),
    osSm.body.slice(0, 80),
  );
}

function articleBody(html: string): string {
  return html.match(/<article class="prose">([\s\S]*?)<\/article>/i)?.[1] ?? "";
}

async function testPodcastStaticPathIntegrity(): Promise<void> {
  console.log(
    "\nPodcast bodies use portable article paths, omit dead category links, and keep monotonic headings",
  );
  for (const slug of PODCAST_SLUGS) {
    const route = `/resource/${slug}/`;
    const apex = await request(route, { host: APEX });
    check(`${slug}: apex article -> 200`, apex.status === 200, `got ${apex.status}`);

    const body = articleBody(apex.body);
    const relativeArticleLinks =
      body.match(/href="\.\.\/\.\.\/resource\/episode-[^"]+\/"/g) ?? [];
    check(
      `${slug}: three related article links are pure-relative`,
      relativeArticleLinks.length === 3,
      `got ${relativeArticleLinks.length}`,
    );
    check(
      `${slug}: no root-absolute resource links`,
      !body.includes('href="/resource/'),
    );
    check(
      `${slug}: no ungenerated podcast-category link`,
      !body.includes("/resource/category/podcasts/"),
    );

    const bodyHeadingLevels = [...body.matchAll(/<h([1-6])\b/gi)].map(
      (match) => Number(match[1]),
    );
    check(
      `${slug}: body headings are H2 then three H3s`,
      JSON.stringify(bodyHeadingLevels) === JSON.stringify([2, 3, 3, 3]),
      `got ${bodyHeadingLevels.join(" -> ") || "none"}`,
    );

    const preview = await request(`${MARKETING_PREVIEW_PATH}${route}`, {
      host: OS_HOST,
    });
    check(
      `${slug}: preview article -> 200`,
      preview.status === 200,
      `got ${preview.status}`,
    );
    check(
      `${slug}: preview serves the same portable body links`,
      articleBody(preview.body).includes(
        'href="../../resource/episode-',
      ),
    );
  }

  const episode15 = await request(`/resource/${EPISODE_15_SLUG}/`, {
    host: APEX,
  });
  check(
    "Episode 15 owner-gated MP3 reference remains unchanged",
    articleBody(episode15.body).includes(
      'href="/wp-content/uploads/2024/01/lilas-fav-podcasts-mp3.mp3"',
    ),
  );
}

async function testOsHostUntouched(): Promise<void> {
  console.log("\nOS host and unknown hosts keep getting the SPA shell");
  for (const host of [OS_HOST, "myapp.replit.dev", "127.0.0.1"]) {
    const res = await request("/", { host });
    check(`${host} -> SPA shell`, res.body.includes(SPA_SENTINEL), res.body.slice(0, 80));
  }
}

async function testXForwardedHostWins(): Promise<void> {
  console.log("\nX-Forwarded-Host (Replit proxy) identifies the marketing host");
  const res = await request("/", { host: "127.0.0.1", xfHost: `${APEX}:443` });
  check("proxied apex serves marketing HTML", /NoBull/i.test(res.body));
  check("proxied apex is not SPA", !res.body.includes(SPA_SENTINEL));
}

async function testPreviewPath(): Promise<void> {
  console.log("\n/website-preview serves the bundle on OS hosts, noindexed");
  const res = await request(`${MARKETING_PREVIEW_PATH}/`, { host: OS_HOST });
  check("200", res.status === 200, `got ${res.status}`);
  check("marketing HTML", /NoBull/i.test(res.body) && !res.body.includes(SPA_SENTINEL));
  check(
    "noindex header",
    String(res.headers["x-robots-tag"] || "").includes("noindex"),
    `got ${res.headers["x-robots-tag"]}`,
  );
  check(
    "preview CSP allows replit workspace frame",
    String(res.headers["content-security-policy"] || "").includes("replit.dev"),
  );

  const nf = await request(`${MARKETING_PREVIEW_PATH}/nope/`, { host: OS_HOST });
  check("preview 404 status", nf.status === 404, `got ${nf.status}`);
  check("preview 404 page", nf.body.includes("Page Not Found"));
  check(
    "preview 404 links back under the preview prefix",
    nf.body.includes(`${MARKETING_PREVIEW_PATH}/`),
  );

  const services = await request(`${MARKETING_PREVIEW_PATH}/services/`, {
    host: OS_HOST,
  });
  check(
    "preview retired /services/ -> 404",
    services.status === 404,
    `got ${services.status}`,
  );
  check(
    "preview retired /services/ gets branded marketing 404",
    services.body.includes("Page Not Found") &&
      services.body.includes("NoBull") &&
      !services.body.includes(SPA_SENTINEL),
  );

  const blocked = await request(`${MARKETING_PREVIEW_PATH}/404.html`, {
    host: OS_HOST,
  });
  check("preview /404.html blocked", blocked.status === 404, `got ${blocked.status}`);
}

async function testMarketingHostsEnvOverride(): Promise<void> {
  console.log("\nMARKETING_SITE_HOSTS env override retargets the predicate live");
  const prev = process.env.MARKETING_SITE_HOSTS;
  try {
    process.env.MARKETING_SITE_HOSTS = "brand-x.example.com,www.brand-x.example.com";
    const brand = await request("/", { host: "brand-x.example.com" });
    check("overridden host serves marketing HTML", /NoBull/i.test(brand.body));
    const oldApex = await request("/", { host: APEX });
    check(
      "default apex no longer marketing under override",
      oldApex.body.includes(SPA_SENTINEL),
      oldApex.body.slice(0, 80),
    );
    const alias = await request("/x/?q=1", { host: "www.brand-x.example.com" });
    check(
      "override alias redirects to override apex",
      alias.status === 301 &&
        alias.headers.location === "https://brand-x.example.com/x/?q=1",
      `got ${alias.status} ${alias.headers.location}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MARKETING_SITE_HOSTS;
    else process.env.MARKETING_SITE_HOSTS = prev;
  }
}

async function main(): Promise<void> {
  console.log("Marketing website host-routing tests (Task #3740)");

  const app = express();
  registerMarketingSite(app);
  // Stand-ins for the real app layers behind the marketing middleware:
  app.get("/api/ping", (_req, res) => res.json({ ok: true, api: true }));
  app.use((_req, res) => res.status(200).type("html").send(`<html>${SPA_SENTINEL}</html>`));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;

  try {
    await testMarketingApexServesBundle();
    await testWwwRedirectsToApex();
    await testDirectorySlashRedirect();
    await testBookFunnelRoutes();
    await testLegacyEpisode13Redirect();
    await testRetiredConversionRouteRedirects();
    await testMarketing404NeverSpa();
    await testVersionedLegalRoutes();
    await testInternalBundleFilesBlocked();
    await testApiPassthrough();
    await testEngineStoryAssetsServed();
    await testSitemapAndRobots();
    await testPodcastStaticPathIntegrity();
    await testOsHostUntouched();
    await testXForwardedHostWins();
    await testPreviewPath();
    await testMarketingHostsEnvOverride();
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
