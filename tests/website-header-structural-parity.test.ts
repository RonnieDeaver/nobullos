/* test-registration
{
  "name": "Marketing site nb-header structural parity across all committed subpages (Task #4920)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4920: a generator change that accidentally drops the hamburger toggle, changes nav link labels, or widens the CTA button text on a subpage is invisible until the page hits production. This cheap file-read-only check catches the divergence the moment the bundle is regenerated and committed — before headless-browser tests even run.",
  "scanPaths": [
    "website/public"
  ],
  "tier": "medium",
  "tierReason": "Scans every committed marketing HTML subpage for the structural header contract."
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #4920: static structural-parity lint for marketing-site headers across
// every committed HTML page in website/public. File-read only — no browser,
// no server. The committed HTML IS the deployable artifact so scanning it is
// equivalent to scanning what nobullmarketing.com serves.
//
// Discovery is UNCONDITIONAL: every *.html file under website/public is
// included regardless of content.  This means a generator regression that
// drops the nb-header class on a shared-chrome page is caught as a
// missing-header failure. Focused funnel pages must instead opt into and
// satisfy the strict data-site-header-contract="focused-funnel" contract.
//
// The reference page is website/public/index.html (the homepage), pinned
// explicitly — not auto-selected from discovered content.
//
// What is checked per page:
//   1. The first focusable control is the shared skip link targeting #main.
//   2. #main is programmatically focusable for native fragment navigation.
//   3. Either <header class="nb-header"> is present, or the page declares the
//      strict focused-funnel header contract (logo present; main nav absent).
//   4. <button class="nb-nav-toggle"> is present inside the header.
//   5. The ordered list of non-CTA nav link texts matches the reference page.
//   6. The desktop CTA text (.nb-nav-cta) matches the reference page.
//   7. The mobile-menu CTA text (.nb-menu-cta inside <nav>) matches the
//      reference page.
//   8. The desktop book-secondary text (.nb-nav-book, Task #5017) matches
//      the reference page.
//   9. The in-menu book-secondary text (.nb-menu-book inside <nav>,
//      Task #5017) matches the reference page.
//
// Failing assertions name the divergent file and the differing element so
// the author can find the regression without manual bisection.
//
// Usage: tsx tests/website-header-structural-parity.test.ts

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "website",
  "public",
);

// The mandatory reference — must always be the homepage.
const REFERENCE_FILE = path.join(PUBLIC_DIR, "index.html");
const EXPECTED_NON_CTA_NAV_LINKS = [
  "Practice Areas Served",
  "Results",
  "About",
  "Resources",
];
const FOCUSED_FUNNEL_FILES = new Set([
  "book/index.html",
  "book/access/index.html",
  "book/apply/index.html",
  "book/bonus/index.html",
  "book/checkout/index.html",
  "book/order-status/index.html",
  "book/thanks/index.html",
]);

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

/** Strip HTML tags and collapse whitespace (including &nbsp; → space). */
function innerText(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the outer HTML of the first element of `tag` that carries class
 * `cls`.  Handles multi-line HTML by tracking nesting depth.
 */
function extractByClass(html: string, tag: string, cls: string): string | null {
  const openPattern = new RegExp(`<${tag}\\b[^>]*\\b${cls}\\b[^>]*>`, "s");
  const m = openPattern.exec(html);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  const closeTag = `</${tag}>`;
  let depth = 1;
  let idx = startIdx;
  const openRe = new RegExp(`<${tag}\\b`, "g");
  const closeRe = new RegExp(`</${tag}>`, "g");
  while (depth > 0 && idx < html.length) {
    openRe.lastIndex = idx;
    closeRe.lastIndex = idx;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      idx = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(m.index, nextClose.index + closeTag.length);
      }
      idx = nextClose.index + closeTag.length;
    }
  }
  return null;
}

/** Structural data extracted from one page's nb-header. */
interface HeaderData {
  hasToggle: boolean;
  /** Text labels of the non-CTA nav links (in source order). */
  navLinks: string[];
  /** Text of the desktop CTA anchor (.nb-nav-cta). */
  navCtaText: string | null;
  /** Text of the in-menu CTA anchor (.nb-menu-cta). */
  menuCtaText: string | null;
  /** Text of the desktop book-secondary anchor (.nb-nav-book, Task #5017). */
  navBookText: string | null;
  /** Text of the in-menu book-secondary anchor (.nb-menu-book, Task #5017). */
  menuBookText: string | null;
}

/**
 * Parse the nb-header structure from `html`.
 * Returns null (and records a FAIL) if the nb-header element is absent.
 */
function parseHeader(html: string, fileLabel: string): HeaderData | null {
  const headerMatch = /<header\b[^>]*\bnb-header\b[^>]*>([\s\S]*?)<\/header>/.exec(html);
  if (!headerMatch) {
    // Explicit failure: the nb-header is MISSING from this committed file.
    check(
      `${fileLabel}: nb-header element present`,
      false,
      "no <header class=\"nb-header\"> found — was the generator template changed?",
    );
    return null;
  }
  // Record the presence assertion as passed.
  check(`${fileLabel}: nb-header element present`, true);

  const headerHtml = headerMatch[0];

  // 1. Toggle presence.
  const hasToggle = /class="[^"]*\bnb-nav-toggle\b[^"]*"/.test(headerHtml);

  // 2. Nav block: <nav id="nb-menu" …> … </nav>
  const navBlock = extractByClass(headerHtml, "nav", "nb-links") ?? "";

  // Extract all <a> tags from the nav block.
  const allAnchors = navBlock.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];

  // Non-CTA links: anchors without the nb-btn class.
  const navLinks = allAnchors
    .filter((a) => !/class="[^"]*\bnb-btn\b/.test(a))
    .map((a) => innerText(a));

  // In-menu CTA: the anchor with nb-menu-cta class.
  const menuCtaRaw = allAnchors.find((a) => /class="[^"]*\bnb-menu-cta\b/.test(a)) ?? null;
  const menuCtaText = menuCtaRaw ? innerText(menuCtaRaw) : null;

  // In-menu book secondary (Task #5017): the outlined anchor with the
  // nb-menu-book class. (Book anchors carry nb-btn-outline, which the
  // \bnb-btn\b filter above already matches — the hyphen is a word
  // boundary — so they never leak into navLinks.)
  const menuBookRaw = allAnchors.find((a) => /class="[^"]*\bnb-menu-book\b/.test(a)) ?? null;
  const menuBookText = menuBookRaw ? innerText(menuBookRaw) : null;

  // 3. Desktop CTA: .nb-nav-cta lives outside the <nav>, directly in the header.
  // Strip the nav block from the header to avoid picking up the menu CTA.
  const headerWithoutNav = headerHtml.replace(navBlock, "");
  const navCtaRaw =
    /<a\b[^>]*\bnb-nav-cta\b[^>]*>[\s\S]*?<\/a>/.exec(headerWithoutNav)?.[0] ?? null;
  const navCtaText = navCtaRaw ? innerText(navCtaRaw) : null;

  // Desktop book secondary (Task #5017): lives beside .nb-nav-cta outside
  // the <nav>, width-gated by CSS (hidden below its fit width) but always
  // present in the committed markup.
  const navBookRaw =
    /<a\b[^>]*\bnb-nav-book\b[^>]*>[\s\S]*?<\/a>/.exec(headerWithoutNav)?.[0] ?? null;
  const navBookText = navBookRaw ? innerText(navBookRaw) : null;

  return { hasToggle, navLinks, navCtaText, menuCtaText, navBookText, menuBookText };
}

/**
 * Walk `dir` recursively and return every *.html file path found,
 * regardless of content.  The universe is ALL committed HTML files.
 */
function allHtmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function fileLabel(fullPath: string): string {
  return path.relative(PUBLIC_DIR, fullPath);
}

function checkSkipContract(html: string, label: string): void {
  const firstFocusable =
    /<(?:a\b[^>]*\bhref|button\b|input\b(?![^>]*\btype="hidden")|select\b|textarea\b|summary\b)[^>]*>/i.exec(
      html,
    )?.[0] ?? "";
  check(
    `${label}: skip link is the first keyboard focus target`,
    /\bclass="[^"]*\bnb-skip-link\b[^"]*"/.test(firstFocusable) &&
      /\bhref="#main"/.test(firstFocusable),
    `got ${JSON.stringify(firstFocusable.slice(0, 180))}`,
  );
  check(
    `${label}: #main is a programmatically focusable landmark`,
    /<main\b[^>]*\bid="main"[^>]*\btabindex="-1"[^>]*>/.test(html),
    'expected <main id="main" tabindex="-1">',
  );
}

const FOCUSED_HEADER_CONTRACT = 'data-site-header-contract="focused-funnel"';

function hasFocusedHeaderContract(html: string): boolean {
  return html.includes(FOCUSED_HEADER_CONTRACT);
}

function checkFocusedHeaderContract(html: string, label: string): void {
  const declarations = html.match(/data-site-header-contract="focused-funnel"/g) ?? [];
  const header =
    /<header\b[^>]*\bclass="[^"]*\bbf-header\b[^"]*"[^>]*\bdata-site-header-contract="focused-funnel"[^>]*>[\s\S]*?<\/header>/.exec(
      html,
    )?.[0] ??
    /<header\b[^>]*\bdata-site-header-contract="focused-funnel"[^>]*\bclass="[^"]*\bbf-header\b[^"]*"[^>]*>[\s\S]*?<\/header>/.exec(
      html,
    )?.[0] ??
    "";

  check(
    `${label}: focused-funnel header contract declared exactly once`,
    declarations.length === 1,
    `got ${declarations.length}`,
  );
  check(
    `${label}: focused-funnel header element present`,
    Boolean(header),
    'expected <header class="bf-header" data-site-header-contract="focused-funnel">',
  );
  check(
    `${label}: focused funnel keeps shared navigation absent`,
    !/\bnb-header\b/.test(html) &&
      !/\bnb-nav-toggle\b/.test(html) &&
      !/<nav\b[^>]*\baria-label="Main navigation"/.test(html),
  );
  check(
    `${label}: focused funnel retains the approved linked logo`,
    /<a\b[^>]*\bclass="[^"]*\bbf-logo-link\b[^"]*"[^>]*>[\s\S]*?<img\b[^>]*\bnobull-logo-full-color\.svg\b[^>]*>[\s\S]*?<\/a>/.test(
      header,
    ),
  );
}

function main(): void {
  console.log("Marketing site nb-header structural parity (Task #4920)\n");

  // Verify the reference file exists before anything else.
  if (!fs.existsSync(REFERENCE_FILE)) {
    console.error(`FATAL: reference page not found: ${REFERENCE_FILE}`);
    process.exit(1);
  }

  // Unconditional universe: every *.html file committed under website/public.
  const allFiles = allHtmlFiles(PUBLIC_DIR);

  // Reference first, then lexicographic order for the rest.
  const refLabel = fileLabel(REFERENCE_FILE);
  const others = allFiles.filter((f) => f !== REFERENCE_FILE);
  const ordered = [REFERENCE_FILE, ...others];

  console.log(`Committed HTML universe: ${allFiles.length} file(s) under website/public`);
  for (const f of ordered) console.log(`  ${fileLabel(f)}`);

  // ---- Parse and validate the reference page first. ----
  const refHtml = fs.readFileSync(REFERENCE_FILE, "utf8");
  console.log(`\n— Reference page (${refLabel}) —`);
  checkSkipContract(refHtml, refLabel);
  const ref = parseHeader(refHtml, refLabel);

  if (!ref) {
    console.error(`\nCannot continue: nb-header missing from the reference page (${refLabel})`);
    process.exit(1);
  }

  check(`${refLabel}: nb-nav-toggle present`, ref.hasToggle);
  check(
    `${refLabel}: has non-CTA nav links`,
    ref.navLinks.length > 0,
    "no plain nav links found in reference",
  );
  check(
    `${refLabel}: non-CTA nav labels and order match the header contract`,
    JSON.stringify(ref.navLinks) === JSON.stringify(EXPECTED_NON_CTA_NAV_LINKS),
    `got ${JSON.stringify(ref.navLinks)}`,
  );
  check(`${refLabel}: has nb-nav-cta text`, ref.navCtaText !== null);
  check(`${refLabel}: has nb-menu-cta text`, ref.menuCtaText !== null);
  check(`${refLabel}: has nb-nav-book text (Task #5017)`, ref.navBookText !== null);
  check(`${refLabel}: has nb-menu-book text (Task #5017)`, ref.menuBookText !== null);

  console.log(`\n  Reference nav links  : ${JSON.stringify(ref.navLinks)}`);
  console.log(`  Reference nb-nav-cta : ${JSON.stringify(ref.navCtaText)}`);
  console.log(`  Reference nb-menu-cta: ${JSON.stringify(ref.menuCtaText)}`);
  console.log(`  Reference nb-nav-book : ${JSON.stringify(ref.navBookText)}`);
  console.log(`  Reference nb-menu-book: ${JSON.stringify(ref.menuBookText)}`);

  // ---- Compare every other committed HTML file against the reference. ----
  for (const filePath of others) {
    const label = fileLabel(filePath);
    console.log(`\n— ${label} —`);
    const html = fs.readFileSync(filePath, "utf8");
    checkSkipContract(html, label);
    const focusedContractAllowed = FOCUSED_FUNNEL_FILES.has(label);
    const focusedContractDeclared = hasFocusedHeaderContract(html);
    check(
      `${label}: focused-funnel header declaration matches the route contract`,
      focusedContractDeclared === focusedContractAllowed,
      focusedContractAllowed
        ? `expected ${FOCUSED_HEADER_CONTRACT}`
        : "focused-funnel headers are allowed only on the dedicated book funnel routes",
    );
    if (focusedContractAllowed && focusedContractDeclared) {
      checkFocusedHeaderContract(html, label);
      continue;
    }
    const data = parseHeader(html, label);
    // parseHeader records a FAIL for the presence check if nb-header is absent;
    // when null, skip structural comparison (the page has already failed).
    if (!data) continue;

    check(`${label}: nb-nav-toggle present`, data.hasToggle);

    // Nav link count and ordered text labels.
    check(
      `${label}: nav link count matches reference (${ref.navLinks.length})`,
      data.navLinks.length === ref.navLinks.length,
      `got ${data.navLinks.length}: ${JSON.stringify(data.navLinks)}`,
    );
    for (let i = 0; i < Math.max(ref.navLinks.length, data.navLinks.length); i++) {
      const expected = ref.navLinks[i] ?? "<missing>";
      const actual = data.navLinks[i] ?? "<missing>";
      check(
        `${label}: nav link[${i}] text matches reference ("${expected}")`,
        actual === expected,
        `got "${actual}"`,
      );
    }

    // Desktop CTA text.
    check(
      `${label}: nb-nav-cta text matches reference ("${ref.navCtaText}")`,
      data.navCtaText === ref.navCtaText,
      `got "${data.navCtaText}"`,
    );

    // Mobile-menu CTA text.
    check(
      `${label}: nb-menu-cta text matches reference ("${ref.menuCtaText}")`,
      data.menuCtaText === ref.menuCtaText,
      `got "${data.menuCtaText}"`,
    );

    // Desktop book-secondary text (Task #5017).
    check(
      `${label}: nb-nav-book text matches reference ("${ref.navBookText}")`,
      data.navBookText === ref.navBookText,
      `got "${data.navBookText}"`,
    );

    // Mobile-menu book-secondary text (Task #5017).
    check(
      `${label}: nb-menu-book text matches reference ("${ref.menuBookText}")`,
      data.menuBookText === ref.menuBookText,
      `got "${data.menuBookText}"`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
