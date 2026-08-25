/* test-registration
{
  "name": "Marketing-site link-preview image guard — every committed website/public HTML page (recursive: service/resource/policy pages too) must ship og:image, all og:image/twitter:image values absolute https on nobullmarketing.com, and no meta tag may reference a *.replit.dev / *.replit.app / replit.com host (Task #4678)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4678: sub-second hermetic check (a few dozen file reads, no DB/network/build). Task #4670 guards the app shell's built og:image, but the marketing bundle (website/public, copied verbatim to dist/website) ships its own og:image tags on ~27 pages and nothing pinned them — a regenerated bundle or template edit could quietly ship a wrong/Replit-domain preview for nobullmarketing.com pages, only surfacing in a prospect's Slack/iMessage unfurl. Reads the committed output (lint-website-bundle-freshness keeps it in sync with the generator sources); scanPaths keeps it gate-selected only when the bundle, generator template, or this guard changes.",
  "scanPaths": [
    "website/public",
    "website/src/html.ts",
    "website/generate.ts",
    "scripts/verify-built-link-preview.ts",
    "tests/website-link-preview-image-guard.test.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4678 — the marketing site's link-preview images can't silently drift.
 *
 * Mirrors tests/link-preview-image-guard.test.ts (Task #4664, app shell) for
 * the marketing website bundle, reusing the exported quoting/casing-robust
 * meta extractor from scripts/verify-built-link-preview.ts (Task #4670):
 *
 *   1. EVERY committed website/public/**\/*.html page (recursively — the
 *      bundle nests service/resource/policy pages under subdirectories) ships
 *      at least one og:image, and every og:image* / twitter:image* content
 *      value is an absolute https URL whose host is nobullmarketing.com
 *      (scrapers require absolute URLs; SITE_ORIGIN per website/src/html.ts).
 *      The `*` suffix match covers og:image:secure_url-style variants too.
 *   2. No <meta> content attribute in any marketing page references a
 *      Replit-domain host (*.replit.dev, *.replit.app, replit.com) — the
 *      Task #4641 regression class (silent rewrite to Replit preview URLs).
 *   3. Self-tests: (a) the recursive walker provably finds nested HTML (tmp
 *      fixture tree) so enumeration can't silently narrow back to the top
 *      level; (b) violating page fixtures (Replit host, foreign host, http,
 *      relative URL, missing og:image) provably FAIL the page check; (c) the
 *      imported extractor still catches valid-HTML quoting/casing evasion.
 *
 * Deliberately reads the COMMITTED website/public output — no Vite/website
 * build runs here; lint-website-bundle-freshness already guarantees the
 * committed bundle matches the generator sources.
 *
 * Hermetic L1: filesystem reads + one tmp fixture tree, no DB, no network.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetaTags } from "../scripts/verify-built-link-preview";

const ROOT = new URL("..", import.meta.url).pathname;
const WEBSITE_PUBLIC = join(ROOT, "website/public");

const ALLOWED_IMAGE_HOST = "nobullmarketing.com";
const REPLIT_HOST = /(?:^|[\/."'@])(?:[a-z0-9-]+\.)*replit\.(?:dev|app|com)\b/i;

// The committed bundle currently ships 27 pages (index, 404, about, service
// pages, ~19 resource articles, policies). A floor well below that still
// screams if enumeration quietly narrows (e.g. back to top-level-only, which
// would see just 2) or a regen drops most of the site.
const MIN_EXPECTED_PAGES = 20;

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// Recursive HTML enumeration. website/public nests almost every page
// (about/index.html, resource/<slug>/index.html, …) — a top-level-only scan
// would validate 2 of 27 pages and miss the exact drift this guard exists
// to catch.
// ---------------------------------------------------------------------------
function collectHtmlFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectHtmlFiles(join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(rel);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Per-page check, returned as a problem list so self-test fixtures can prove
// the check actually fails on violations (a guard that can't fail is no
// guard).
// ---------------------------------------------------------------------------
function isImageKey(key: string | null): boolean {
  return (
    key !== null &&
    (key === "og:image" ||
      key.startsWith("og:image:") ||
      key === "twitter:image" ||
      key.startsWith("twitter:image:"))
  );
}

function checkPageHtml(rel: string, html: string): string[] {
  const problems: string[] = [];
  const metaTags = parseMetaTags(html);

  if (metaTags.length === 0) {
    problems.push(`${rel} yielded zero <meta> tags — the page head was gutted or the parser regex broke`);
    return problems;
  }

  // (a) Every marketing page must actually ship a preview image — zero
  //     og:image means shares of that nobullmarketing.com URL unfurl blank.
  const ogImages = metaTags.filter((t) => t.key === "og:image");
  if (ogImages.length < 1) {
    problems.push(
      `${rel} ships no og:image meta tag — the page would unfurl with no preview image in Slack/iMessage (generator template website/src/html.ts dropped it)`,
    );
  }

  // (b) Every og:image* / twitter:image* value must be an absolute https URL
  //     on the canonical marketing host. Relative URLs are invisible to
  //     scrapers; foreign/Replit hosts ship a wrong or broken preview.
  for (const tag of metaTags.filter((t) => isImageKey(t.key))) {
    if (tag.content === null || tag.content.length === 0) {
      problems.push(`${rel}: ${tag.key} meta tag has no content attribute: ${tag.raw}`);
      continue;
    }
    let host: string | null = null;
    let protocol: string | null = null;
    try {
      const u = new URL(tag.content);
      host = u.hostname.toLowerCase();
      protocol = u.protocol;
    } catch {
      // not an absolute URL — fails below
    }
    if (protocol !== "https:") {
      problems.push(
        `${rel}: ${tag.key} must be an absolute https URL (scrapers ignore relative/insecure URLs) — got ${JSON.stringify(tag.content)}`,
      );
    } else if (host !== ALLOWED_IMAGE_HOST) {
      problems.push(
        `${rel}: ${tag.key} host must be ${ALLOWED_IMAGE_HOST} (SITE_ORIGIN in website/src/html.ts) — got ${JSON.stringify(tag.content)}; a drifted host ships a wrong/broken preview for nobullmarketing.com pages`,
      );
    }
  }

  // (c) No meta tag content may reference a Replit-domain host — checked
  //     across ALL meta tags so og:url/og:image:secure_url-style variants or
  //     re-introduced rewrite machinery is caught too.
  for (const t of metaTags) {
    if (t.content !== null && REPLIT_HOST.test(t.content)) {
      problems.push(
        `${rel}: meta tag references a Replit-domain host (Task #4641 regression class — silent rewrite of link previews to Replit URLs): ${t.raw}`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 1+2. Check every committed marketing page.
// ---------------------------------------------------------------------------
const pages = collectHtmlFiles(WEBSITE_PUBLIC);

assert.ok(
  pages.length >= MIN_EXPECTED_PAGES,
  `expected at least ${MIN_EXPECTED_PAGES} committed marketing pages under website/public, found ${pages.length} (${pages.join(", ")}) — either the bundle is missing (run \`npx tsx website/generate.ts\`) or enumeration quietly narrowed (top-level-only sees just index.html + 404.html)`,
);
assert.ok(
  pages.includes("index.html") && pages.includes("404.html"),
  `website/public must contain index.html and 404.html at the top level — found: ${pages.slice(0, 5).join(", ")}…`,
);
const nestedPages = pages.filter((p) => p.includes("/"));
assert.ok(
  nestedPages.length >= 1,
  "website/public enumeration found zero NESTED pages — the marketing bundle nests service/resource/policy pages under subdirectories, so an empty nested set means the walker regressed to top-level-only or the bundle structure changed drastically",
);
ok(`enumerated ${pages.length} committed marketing pages (${nestedPages.length} nested, e.g. ${nestedPages[0]})`);

const allProblems: string[] = [];
for (const rel of pages) {
  allProblems.push(...checkPageHtml(`website/public/${rel}`, readFileSync(join(WEBSITE_PUBLIC, rel), "utf8")));
}
assert.deepEqual(
  allProblems,
  [],
  `marketing link-preview drift detected:\n${allProblems.map((p) => `  - ${p}`).join("\n")}`,
);
ok(`all ${pages.length} pages: og:image present, preview-image hosts pinned to ${ALLOWED_IMAGE_HOST}, no Replit-domain meta hosts`);

// ---------------------------------------------------------------------------
// 3a. Walker self-test: a tmp fixture tree with nested HTML must be fully
//     enumerated — proves nested pages (the bulk of the real bundle) can't
//     silently fall out of coverage.
// ---------------------------------------------------------------------------
const fixtureRoot = mkdtempSync(join(tmpdir(), "website-og-guard-"));
try {
  mkdirSync(join(fixtureRoot, "resource/some-article"), { recursive: true });
  mkdirSync(join(fixtureRoot, "assets/css"), { recursive: true });
  writeFileSync(join(fixtureRoot, "index.html"), "<html></html>");
  writeFileSync(join(fixtureRoot, "resource/some-article/index.html"), "<html></html>");
  writeFileSync(join(fixtureRoot, "assets/css/home.css"), "body{}"); // non-HTML must be ignored
  const found = collectHtmlFiles(fixtureRoot);
  assert.deepEqual(
    found,
    ["index.html", "resource/some-article/index.html"],
    `walker self-test: recursive enumeration broke — got ${JSON.stringify(found)}`,
  );
  ok("self-test: walker finds nested HTML files (and ignores non-HTML assets)");

  // -------------------------------------------------------------------------
  // 3b. Violation fixtures: each must FAIL the page check. A nested Replit-
  //     host page is exercised end-to-end (walk + check) to prove a nested
  //     violation is examined and flagged, not just enumerable.
  // -------------------------------------------------------------------------
  writeFileSync(
    join(fixtureRoot, "resource/some-article/index.html"),
    `<html><head><meta property="og:image" content="https://my-app.replit.dev/opengraph.png"></head></html>`,
  );
  const nestedViolations = collectHtmlFiles(fixtureRoot)
    .flatMap((rel) => checkPageHtml(rel, readFileSync(join(fixtureRoot, rel), "utf8")))
    .filter((p) => p.startsWith("resource/some-article/index.html"));
  assert.ok(
    nestedViolations.length >= 2, // wrong host + Replit-host ban both fire
    `self-test: a nested page with a Replit-domain og:image must be walked AND flagged — got ${JSON.stringify(nestedViolations)}`,
  );
  ok("self-test: nested fixture page with Replit-domain og:image is examined and flagged");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const violatingFixtures: Array<[string, string]> = [
  ["Replit host", `<head><meta property="og:image" content="https://x.replit.app/og.png"></head>`],
  ["foreign host", `<head><meta property="og:image" content="https://cdn.example.com/og.png"></head>`],
  ["http (insecure)", `<head><meta property="og:image" content="http://nobullmarketing.com/og.png"></head>`],
  ["relative URL", `<head><meta property="og:image" content="/assets/og.png"></head>`],
  ["missing og:image", `<head><meta property="og:title" content="NoBull"></head>`],
  ["twitter:image foreign host", `<head><meta property="og:image" content="https://nobullmarketing.com/og.png"><meta name="twitter:image" content="https://evil.example.com/og.png"></head>`],
  ["replit og:url (non-image meta)", `<head><meta property="og:image" content="https://nobullmarketing.com/og.png"><meta property="og:url" content="https://my-app.replit.dev/"></head>`],
];
for (const [label, fixture] of violatingFixtures) {
  const problems = checkPageHtml("fixture.html", fixture);
  assert.ok(problems.length >= 1, `self-test: the ${label} fixture must fail the page check but passed — the guard has gone blind`);
}
ok(`self-test: all ${violatingFixtures.length} violation fixtures fail the page check`);

// A clean page shaped like the real generator output must pass — guards the
// guard against false positives.
const cleanFixture = `<head><meta property="og:image" content="https://nobullmarketing.com/assets/uploads/2023/12/NoBull-Marketing-The-Law-Firm-Experts-bg.png"><meta property="og:title" content="NoBull Marketing"></head>`;
assert.deepEqual(checkPageHtml("clean.html", cleanFixture), [], "self-test: a clean generator-shaped page must pass");
ok("self-test: clean generator-shaped page passes");

// ---------------------------------------------------------------------------
// 3c. Extractor self-test: the imported extractor + Replit-host ban must
//     still catch valid-HTML quoting/casing variants (single-quoted,
//     unquoted, uppercase). If the shared extractor in
//     scripts/verify-built-link-preview.ts quietly narrows to double-quoted
//     lowercase, this fails loudly instead of the ban silently going blind.
// ---------------------------------------------------------------------------
const evasionFixtures: Array<[string, string]> = [
  ["single-quoted", `<meta property='og:image' content='https://my-app.replit.dev/opengraph.png' />`],
  ["unquoted", `<meta name=twitter:image content=https://my-app.replit.app/og.png>`],
  ["uppercase attrs", `<META PROPERTY="og:image:secure_url" CONTENT="https://evil.replit.com/og.png">`],
  ["mixed quoting", `<meta NAME='twitter:image' Content="https://x.y.replit.dev/img.png"/>`],
];
for (const [label, fixture] of evasionFixtures) {
  const parsed = parseMetaTags(fixture);
  assert.equal(parsed.length, 1, `self-test: extractor failed to see the ${label} meta fixture at all`);
  assert.ok(isImageKey(parsed[0].key), `self-test: ${label} fixture key not recognized as a preview-image key`);
  assert.ok(
    parsed[0].content !== null && REPLIT_HOST.test(parsed[0].content),
    `self-test: the Replit-host ban failed to catch the ${label} variant ${JSON.stringify(fixture)} — the extractor has gone blind to valid HTML quoting/casing`,
  );
  assert.ok(
    checkPageHtml("evasion.html", fixture).length >= 1,
    `self-test: the ${label} evasion variant must fail the full page check`,
  );
}
ok(`self-test: Replit-host ban catches quoting/casing evasion variants (${evasionFixtures.length} fixtures)`);

console.log(`website link-preview image guard: ${passed} checks passed`);
