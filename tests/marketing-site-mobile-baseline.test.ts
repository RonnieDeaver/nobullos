/* test-registration
{
  "name": "Marketing website mobile-layout baseline (Task #3801)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3801: cheap static assertions over committed generator output catch mobile regressions in navigation, hero preloads, text-size adjustment, 16px form controls, compact external booking handoff, lazy-image dimensions, and proof-zone collapse. The homepage conversion hub extends this baseline: its labeled contact controls remain at least 16px, its form stacks at <=850px, and its booking action remains fluid without an embedded scheduler.",
  "scanPaths": [
    "website/public"
  ],
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3801: static assertions over the committed marketing bundle
// (website/public/*) guarding the mobile-layout baseline shipped in Task
// #3795. Sibling of tests/marketing-site-hosts.test.ts, but file-read only —
// no server needed: the bundle IS the deployable artifact, so scanning the
// committed files is equivalent to scanning what the marketing hosts serve.
//
// Usage: tsx tests/marketing-site-mobile-baseline.test.ts

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "website",
  "public",
);

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

function read(rel: string): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), "utf8");
}

/** Every committed page of the bundle (index.html files at any depth). */
function allPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "index.html") out.push(path.relative(PUBLIC_DIR, full));
    }
  };
  walk(PUBLIC_DIR);
  return out.sort();
}

function testHamburgerNav(): void {
  console.log("\nHomepage keeps the mobile hamburger nav (nb-nav-toggle + #nb-menu)");
  const html = read("index.html");
  check(
    "nb-nav-toggle button present",
    /<button[^>]*class="[^"]*\bnb-nav-toggle\b[^"]*"/.test(html),
  );
  check('toggle targets #nb-menu (aria-controls)', html.includes('aria-controls="nb-menu"'));
  check('#nb-menu nav present', /<nav[^>]*id="nb-menu"/.test(html));
  check(
    "toggle starts collapsed (aria-expanded=false)",
    /nb-nav-toggle[^>]*aria-expanded="false"|aria-expanded="false"[^>]*nb-nav-toggle/.test(
      html.match(/<button[^>]*nb-nav-toggle[^>]*>/)?.[0] ?? "",
    ),
  );
}

function testHeroPreloadMediaGates(): void {
  // Task #4127 moved hero preloads to all-WebP viewport-conditional pairs:
  // desktop (min-width: 851px) gets the full-resolution WebP re-encodes,
  // mobile (max-width: 850px) the compressed -mobile derivatives. The mobile
  // invariant guarded here: EVERY image preload is media-gated to exactly one
  // viewport (no viewport double-downloads hero art), no multi-MB source PNG
  // is ever preloaded, and each side of the 850px split has its own preload.
  console.log("\nHero preloads stay media-gated (all-WebP, split at 850px)");
  const html = read("index.html");
  const preloads = html.match(/<link[^>]*rel="preload"[^>]*as="image"[^>]*>/g) ?? [];
  check("has image preloads", preloads.length > 0, "no <link rel=preload as=image> found");
  for (const tag of preloads) {
    const href = tag.match(/href="([^"]+)"/)?.[1];
    check(`preload is webp (no heavyweight png preloads): ${href}`, /\.webp/.test(tag), tag);
    const mobile = tag.includes('media="(max-width: 850px)"');
    const desktop = tag.includes('media="(min-width: 851px)"');
    check(
      `preload gated to exactly one viewport: ${href}`,
      (mobile || desktop) && !(mobile && desktop),
      tag,
    );
  }
  check(
    "at least one mobile-gated webp preload",
    preloads.some((t) => /\.webp/.test(t) && t.includes('media="(max-width: 850px)"')),
  );
  check(
    "at least one desktop-gated webp preload",
    preloads.some((t) => /\.webp/.test(t) && t.includes('media="(min-width: 851px)"')),
  );
}

function testCanonicalBookCoverArtwork(): void {
  console.log("\nHomepage book placements share the canonical standalone front cover");
  const html = read("index.html");
  const fallbackTags =
    html.match(/<img[^>]*src="nobull-redesign\/brand\/front-cover\.jpg"[^>]*>/g) ?? [];

  check(
    "canonical front-cover.jpg is retained",
    fs.existsSync(path.join(PUBLIC_DIR, "nobull-redesign", "brand", "front-cover.jpg")),
  );
  check(
    "hero and book band both use the standalone front-cover fallback",
    fallbackTags.length === 2,
    `found ${fallbackTags.length} front-cover fallback tags`,
  );
  for (const tag of fallbackTags) {
    check(
      "front-cover fallback keeps exact 1800x2700 intrinsic proportions",
      /\bwidth="1800"/.test(tag) && /\bheight="2700"/.test(tag),
      tag,
    );
  }
  check(
    "homepage never references a print-wrap proof",
    !/full-wra|barcode/i.test(html),
  );
}

function testStylesheetTextSizeAdjust(): void {
  console.log("\nBoth stylesheets keep -webkit-text-size-adjust:100%");
  for (const rel of ["assets/css/home.css", "assets/css/site.css"]) {
    const css = read(rel);
    check(
      `${rel} has -webkit-text-size-adjust:100%`,
      /-webkit-text-size-adjust:\s*100%/.test(css),
    );
    check(`${rel} has text-size-adjust:100%`, /(^|[^-])text-size-adjust:\s*100%/m.test(css));
  }
}

function testKeyboardFocusBaseline(): void {
  console.log("\nBoth stylesheets reveal the skip link and keep token-based focus visible");
  for (const rel of ["assets/css/home.css", "assets/css/site.css"]) {
    const css = read(rel);
    check(`${rel} defines --focus-ring`, /--focus-ring\s*:/.test(css));
    check(
      `${rel} gives interactive controls a :focus-visible outline`,
      /:where\([^}]*\):focus-visible\s*\{[^}]*outline\s*:\s*2px solid var\(--focus-ring\)/s.test(
        css,
      ),
    );
    check(
      `${rel} adds a contrast layer behind the focus outline`,
      /:where\([^}]*\):focus-visible\s*\{[^}]*box-shadow\s*:\s*0 0 0 2px var\(--focus-ring-contrast\)/s.test(
        css,
      ),
    );
    check(
      `${rel} reveals .nb-skip-link on keyboard focus`,
      /\.nb-skip-link:focus-visible\s*\{[^}]*transform\s*:\s*translateY\(0\)/s.test(css),
    );
  }
}

function testFormControlFontSizes(): void {
  console.log("\nForm controls stay >=16px (below that iOS Safari auto-zooms on focus)");

  // site.css: longhand font-size on legacy contact/unsubscribe controls.
  const site = read("assets/css/site.css");
  for (const selector of [".contact-form input", '.unsub-form input[type="email"]'] as const) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = site.match(new RegExp(`${esc}[^{]*\\{[^}]*\\}`))?.[0] ?? "";
    check(`${selector} rule exists (site.css)`, rule.length > 0);
    const m = rule.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    const px = m ? parseFloat(m[1]) : 0;
    check(`site.css ${selector} >=16px (got ${px}px)`, px >= 16);
  }

  // home.css: the homepage conversion form owns the same iOS floor and
  // becomes a single column at the established <=850px breakpoint.
  const home = read("assets/css/home.css");
  for (const selector of [".nb-contact-grid input", ".nb-contact-grid textarea"] as const) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = home.match(new RegExp(`${esc}[^{]*\\{[^}]*\\}`))?.[0] ?? "";
    check(`${selector} rule exists (home.css)`, rule.length > 0);
    const m = rule.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    const px = m ? parseFloat(m[1]) : 0;
    check(`home.css ${selector} >=16px (got ${px}px)`, px >= 16);
  }
  const mobileStart = home.indexOf("@media(max-width:850px)");
  check(
    "homepage contact grid stacks at <=850px",
    mobileStart >= 0 &&
      /\.nb-contact-grid\{[^}]*grid-template-columns:1fr[;}]/.test(
        home.slice(mobileStart),
      ),
  );
}

function testProofZoneMobileCollapse(): void {
  console.log(
    "\nResult-first proof stays linear while supports + testimonial grids collapse on phones (supports/videos at <=850px; the #4980 marquee restore returns the served quote grid to its pre-#4925 two-column tablet form, collapsing at <=520px)",
  );
  const home = read("assets/css/home.css");
  const idx850 = home.indexOf("@media(max-width:850px)");
  check("@media(max-width:850px) block exists", idx850 >= 0);
  const mobile = home.slice(Math.max(idx850, 0));
  check(
    "retired .nb-flag-grid wrapper stays out of the result-first flagship",
    !home.includes(".nb-flag-grid"),
  );
  check(
    "result-first flagship gets narrow-screen inset padding",
    /\.nb-flag\{[^}]*padding:44px 32px[;}]/.test(mobile),
  );
  for (const cls of [
    ".nb-supports",
    ".nb-video-grid",
    ".nb-quote-grid",
  ] as const) {
    const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    check(
      `${cls} collapses to one column on mobile`,
      new RegExp(`${esc}\\{[^}]*grid-template-columns:1fr[;}]`).test(mobile),
    );
  }
}

function testLeadRampRemovedFromCompactReceipt(): void {
  console.log("\nBurns Smith compact receipt keeps the retired lead-ramp chart out");
  const html = read("index.html");
  const css = read("assets/css/home.css");
  check(
    "Burns Smith compact receipt has no lead-ramp chart markup",
    !html.includes('class="nb-ramp"'),
  );
  check(
    "retired lead-ramp selectors stay out of the homepage stylesheet",
    !css.includes(".nb-ramp"),
  );
}

function testCompactCalendlyHandoff(): void {
  console.log("\nCalendly: compact external handoff with no embed dependency");
  const pages = allPages();
  let embeds = 0;
  let calendlyScripts = 0;
  for (const rel of pages) {
    const html = read(rel);
    embeds +=
      (html.match(/<(?:div|iframe)[^>]*calendly-inline-widget[^>]*>/g) ?? [])
        .length;
    if (html.includes("assets.calendly.com")) {
      calendlyScripts++;
    }
  }
  const home = read("index.html");
  const css = read("assets/css/home.css");
  check("bundle contains no Calendly embeds", embeds === 0, `got ${embeds}`);
  check(
    "bundle loads no Calendly scripts",
    calendlyScripts === 0,
    `got ${calendlyScripts}`,
  );
  check(
    "homepage has the canonical external scheduling action",
    /class="nb-btn nb-booking-cta" href="https:\/\/calendly\.com\/[^"]+" target="_blank" rel="noopener"/.test(
      home,
    ),
  );
  check(
    "booking CTA is fluid and avoids fixed-width mobile overflow",
    /\.nb-booking-cta\{[^}]*width:100%[^}]*white-space:normal/.test(css),
  );
}

function testConversionCloseReflow(): void {
  console.log("\nFinal conversion close preserves a booking-first two-column desktop layout that stacks safely");
  const html = read("index.html");
  const home = read("assets/css/home.css");
  const bookAt = html.indexOf('<section id="book" class="nb-book-sec">');
  const conversionAt = html.indexOf('<section class="nb-conversion"');
  check("book band appears before the final conversion close", bookAt >= 0 && bookAt < conversionAt);
  check(
    "conversion close retains the established title and both direct-action surfaces",
    html.includes('class="nb-conversion-close"') &&
      html.includes("Ready to Build Your Revenue Engine?") &&
      html.includes('class="nb-conversion-grid"') &&
      html.indexOf('id="booking"') < html.indexOf('id="contact"'),
  );
  check(
    "conversion grid is two-column on desktop",
    /\.nb-conversion-grid\{[^}]*grid-template-columns:minmax\(280px,\.84fr\) minmax\(0,1\.16fr\)/.test(home),
  );
  const mobileStart = home.indexOf("@media(max-width:850px)");
  check(
    "conversion grid stacks booking before contact at <=850px",
    mobileStart >= 0 &&
      /\.nb-conversion-grid\{[^}]*grid-template-columns:1fr[;}]/.test(home.slice(mobileStart)),
  );
  check(
    "retired chooser and standalone booking close stay absent",
    !html.includes("nb-conversion-choice") && !html.includes("nb-close-cta"),
  );
}

function testLazyImagesHaveDimensions(): void {
  console.log('\nEvery lazy <img> carries width+height (no CLS on mobile)');
  let lazyCount = 0;
  let badCount = 0;
  for (const rel of allPages()) {
    const html = read(rel);
    const imgs = html.match(/<img\b[^>]*\bloading="lazy"[^>]*>/g) ?? [];
    for (const tag of imgs) {
      lazyCount++;
      const ok = /\bwidth="\d+"/.test(tag) && /\bheight="\d+"/.test(tag);
      if (!ok) {
        badCount++;
        check(`${rel}: lazy img has width/height`, false, tag.slice(0, 160));
      }
    }
  }
  check(
    `all ${lazyCount} lazy imgs carry width+height`,
    lazyCount > 0 && badCount === 0,
    lazyCount === 0 ? "no lazy imgs found" : `${badCount} missing dimensions`,
  );
}

function main(): void {
  console.log("Marketing website mobile-layout baseline tests (Task #3801)");

  testHamburgerNav();
  testHeroPreloadMediaGates();
  testCanonicalBookCoverArtwork();
  testStylesheetTextSizeAdjust();
  testKeyboardFocusBaseline();
  testFormControlFontSizes();
  testProofZoneMobileCollapse();
  testLeadRampRemovedFromCompactReceipt();
testCompactCalendlyHandoff();
  testConversionCloseReflow();
  testLazyImagesHaveDimensions();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
