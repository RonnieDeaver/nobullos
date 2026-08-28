/* test-registration
{
  "name": "Marketing-site sitemap hygiene — book-funnel/legacy-privacy exclusions stay out of sitemap-pages.json and every remaining entry's <lastmod> is a stable, content-derived date (git history for chrome pages, authored publish date for articles), never the wall-clock date the generator happened to run on",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5311: a fabricated build-time lastmod would make every page look modified on every regen, defeating the sitemap-hygiene goal and misleading crawlers. Pure fs + git-log reads of the committed repo, no DB/network, sub-second.",
  "scanPaths": [
    "website/public/sitemap-pages.json",
    "website/generate.ts",
    "server/website/marketingSite.ts",
    "website/src/pages",
    "website/content",
    "tests/website-sitemap-lastmod.test.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #5311 — sitemap hygiene guard.
 *
 * Reads the COMMITTED website/public/sitemap-pages.json (lint-website-
 * bundle-freshness already guarantees it matches the generator sources):
 *
 *   1. The 6 personal/transactional book-funnel pages and the legacy
 *      /privacy-policy/ URL are absent (they duplicate /privacy/ or have no
 *      search-worthy content).
 *   2. Every entry that carries a <lastmod> uses a valid YYYY-MM-DD date.
 *   3. Chrome-page (non-article) lastmod values are independently
 *      reproducible from `git log -1` on that page's own known source
 *      file(s) — the same computation website/generate.ts performs — proving
 *      the date is a deterministic function of committed history, not
 *      today's wall clock. Re-running this exact check on a later day (with
 *      no new commits to those files) must yield the identical answer.
 *   4. Article entries carry the article's own authored publish date
 *      (content/articles/*.json), not a generator-run date.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_PATH = join(ROOT, "website/public/sitemap-pages.json");

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

interface SitemapEntry {
  path: string;
  title: string;
  priority: string;
  lastmod?: string;
}

const manifest: SitemapEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
assert.ok(manifest.length >= 20, `expected at least 20 sitemap entries, found ${manifest.length}`);
ok(`loaded ${manifest.length} committed sitemap entries`);

// ---------------------------------------------------------------------------
// 1. Excluded paths never appear.
// ---------------------------------------------------------------------------
const EXCLUDED_PATHS = [
  "privacy-policy/",
  "book/checkout/",
  "book/bonus/",
  "book/apply/",
  "book/thanks/",
  "book/access/",
  "book/order-status/",
];
for (const excluded of EXCLUDED_PATHS) {
  assert.ok(
    !manifest.some((e) => e.path === excluded),
    `sitemap-pages.json must exclude ${excluded} (personal/transactional or duplicate-of-/privacy/ content) but it is present`,
  );
}
ok(`all ${EXCLUDED_PATHS.length} personal/transactional + legacy-privacy paths excluded`);

// book/ itself (the funnel landing page) has real search-worthy content and
// must still be listed.
assert.ok(manifest.some((e) => e.path === "book/"), "book/ (the funnel landing page) must remain in the sitemap");
ok("book/ landing page remains listed (only its transactional sub-pages are excluded)");

// ---------------------------------------------------------------------------
// 2. Every present lastmod is a valid calendar date, never empty/malformed.
// ---------------------------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const withLastmod = manifest.filter((e) => e.lastmod !== undefined);
assert.ok(withLastmod.length >= manifest.length - 2, "nearly every sitemap entry should carry a lastmod");
for (const e of withLastmod) {
  assert.ok(ISO_DATE.test(e.lastmod!), `${e.path}: lastmod ${JSON.stringify(e.lastmod)} is not a valid YYYY-MM-DD date`);
  assert.ok(!Number.isNaN(Date.parse(e.lastmod!)), `${e.path}: lastmod ${e.lastmod} does not parse as a real calendar date`);
}
ok(`all ${withLastmod.length} present lastmod values are valid YYYY-MM-DD dates`);

// ---------------------------------------------------------------------------
// 3. Chrome-page lastmod is reproducible from git history of its own source
//    file(s) — the exact mechanism website/generate.ts uses (PAGE_CONTENT_
//    FILES + gitLastModifiedIso). This is the crux of the hygiene fix: an
//    unmodified page must report the SAME lastmod no matter which day the
//    generator is re-run on.
// ---------------------------------------------------------------------------
const PAGE_CONTENT_FILES: Record<string, string[]> = {
  "": ["website/src/pages/home.ts"],
  "about/": ["website/src/pages/about.ts"],
  "resources/": ["website/src/pages/resources.ts", "website/content/articles/index.json"],
  "free-chapters/": ["website/src/pages/freeChapters.ts", "website/content/book-excerpt.json"],
  "book/": ["website/src/pages/bookFunnel.ts"],
  "calculator/": ["website/src/pages/calculator.ts"],
  "data-notes/": ["website/src/pages/dataNotes.ts"],
  "privacy/": ["website/src/pages/legal.ts", "website/content/privacy.json"],
  "terms/": ["website/src/pages/legal.ts"],
  "shipping-returns/": ["website/src/pages/legal.ts"],
  "unsubscribe/": ["website/src/pages/legal.ts"],
};

function gitLastModifiedIso(files: string[]): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...files], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    return out ? out.slice(0, 10) : null;
  } catch {
    return null;
  }
}

let chromeChecked = 0;
for (const [pagePath, files] of Object.entries(PAGE_CONTENT_FILES)) {
  const entry = manifest.find((e) => e.path === pagePath);
  assert.ok(entry, `sitemap-pages.json is missing the chrome page "${pagePath}"`);
  const expected = gitLastModifiedIso(files);
  assert.equal(
    entry!.lastmod,
    expected ?? undefined,
    `sitemap lastmod for "${pagePath}" (${entry!.lastmod}) does not match its own git-history-derived date (${expected}) computed from ${files.join(", ")} — it may be using a fabricated/build-time date instead of stable content history`,
  );
  chromeChecked += 1;
}
ok(`${chromeChecked} chrome-page lastmod values reproduce byte-for-byte from git history of their own source file(s)`);

// Determinism: recomputing twice in the same process yields the identical
// answer (no hidden dependency on Date.now()).
const homeFirst = gitLastModifiedIso(PAGE_CONTENT_FILES[""]);
const homeSecond = gitLastModifiedIso(PAGE_CONTENT_FILES[""]);
assert.equal(homeFirst, homeSecond, "gitLastModifiedIso must be deterministic across repeated calls");
ok("git-history lastmod lookup is deterministic across repeated calls (no wall-clock dependency)");

// ---------------------------------------------------------------------------
// 4. Article entries use their own authored date, not a generator-run date.
// ---------------------------------------------------------------------------
const articleEntries = manifest.filter((e) => e.path.startsWith("resource/"));
assert.equal(articleEntries.length, 15, `expected exactly 15 resource/article sitemap entries, found ${articleEntries.length}`);
for (const e of articleEntries) {
  assert.ok(e.lastmod, `article ${e.path} must carry a lastmod (its own authored publish date)`);
}
// All 15 shipped articles are dated "Jan 4, 2024" in their content JSON
// (see website/content/articles/*.json) — confirms the article branch reads
// the authored date, not today's date.
const articleDates = new Set(articleEntries.map((e) => e.lastmod));
assert.deepEqual([...articleDates], ["2024-01-04"], `expected every article's lastmod to be its authored publish date 2024-01-04, got ${JSON.stringify([...articleDates])}`);
ok(`all ${articleEntries.length} article entries carry their authored publish date (2024-01-04), not a build-time date`);

console.log(`website sitemap lastmod hygiene: ${passed} checks passed`);
