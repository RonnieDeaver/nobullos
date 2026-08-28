// Static-site generator for the NoBull Marketing website bundle.
//
//   npx tsx website/generate.ts
//
// Reads page templates from website/src/pages/* and article/legal content
// from website/content/, then writes the finished HTML bundle into
// website/public/ (committed). The server serves website/public in dev and
// dist/website in production (script/build.ts copies it).
//
// Every internal link is RELATIVE so the bundle works both at the domain
// root (nobullmarketing.com) and under /website-preview/ on the OS hosts.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  computeWebsiteInputManifest,
  renderWebsiteBuildManifest,
} from "./fingerprint";
import { PageDef, layout, setAssetVersion } from "./src/html";
import { homePage } from "./src/pages/home";
import { aboutPage } from "./src/pages/about";
import { resourcesPage } from "./src/pages/resources";
import { articlePage, ArticleFull } from "./src/pages/article";
import { freeChaptersPage, BookExcerpt } from "./src/pages/freeChapters";
import { calculatorPage } from "./src/pages/calculator";
import { dataNotesPage } from "./src/pages/dataNotes";
import { bookFunnelPage } from "./src/pages/bookFunnel";
import { bookCheckoutPage } from "./src/pages/bookPurchaseBridge";
import { bookBonusPage } from "./src/pages/bookBonus";
import { bookAccessPage } from "./src/pages/bookAccess";
import { bookApplyPage } from "./src/pages/bookApply";
import { bookThanksPage } from "./src/pages/bookThanks";
import {
  privacyPage,
  privacyCanonicalPage,
  termsPage,
  shippingReturnsPage,
  unsubscribePage,
  notFoundPage,
} from "./src/pages/legal";
import { bookOrderStatusPage } from "./src/pages/bookOrderStatus";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "public");
const CONTENT = path.join(ROOT, "content");

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

const articleIndex = readJson<
  { slug: string; title: string; date: string; cat: string; thumb: string; excerpt: string }[]
>(path.join(CONTENT, "articles", "index.json"));

const articles: ArticleFull[] = articleIndex.map((meta) => ({
  ...meta,
  ...readJson<{ bodyHtml: string; metaDesc: string; ogImage: string }>(
    path.join(CONTENT, "articles", `${meta.slug}.json`),
  ),
  ...meta, // index metadata (title/date/cat/thumb/excerpt) wins
}));

const privacy = readJson<{ bodyHtml: string }>(path.join(CONTENT, "privacy.json"));

const bookExcerpt = readJson<BookExcerpt>(path.join(CONTENT, "book-excerpt.json"));

// Bundle the client scripts from website/src (PR5 — site.js is generated
// output here, no longer a hand-maintained duplicate):
//   home-client/main.ts → assets/js/home.js  (homepage only: engine-story
//     allowed-list motion — gsap compiled in, no runtime CDN dependency —
//     + shared nav/inquiry)
//   site-client/main.ts → assets/js/site.js  (shared-chrome subpages: shared
//     nav/inquiry + Vimeo lightbox + resources tabs + REE handoff prefill)
//   calc-client/main.ts → assets/js/calc.js  (calculator page only: the REE
//     form/results UI over the pure math module; site.js owns shared chrome)
//   book-client/main.ts → assets/js/book.js  (/book/ only)
//   book-checkout-client/main.ts → assets/js/book-checkout.js
//     (/book/checkout, /book/bonus, /book/apply, /book/thanks, /book/access,
//     and /book/order-status)
// Homepage and subpages import the SAME website/src/client-shared/ nav +
// inquiry modules, so the page classes cannot drift.
for (const [entryDir, outfile] of [
  ["home-client", "home.js"],
  ["site-client", "site.js"],
  ["calc-client", "calc.js"],
  ["book-client", "book.js"],
  ["book-checkout-client", "book-checkout.js"],
] as const) {
  buildSync({
    entryPoints: [path.join(ROOT, "src", entryDir, "main.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2019"],
    outfile: path.join(OUT, "assets", "js", outfile),
    logLevel: "error",
  });
}

// Cache-buster for css/js: hash of the asset files, appended as ?v=…
// (non-HTML assets are cached for a day by the server).
const assetHash = crypto
  .createHash("md5")
  .update(fs.readFileSync(path.join(OUT, "assets", "css", "site.css")))
  .update(fs.readFileSync(path.join(OUT, "assets", "js", "site.js")))
  .update(fs.readFileSync(path.join(OUT, "assets", "css", "home.css")))
  .update(fs.readFileSync(path.join(OUT, "assets", "js", "home.js")))
  .update(fs.readFileSync(path.join(OUT, "assets", "js", "calc.js")))
  .update(fs.readFileSync(path.join(OUT, "assets", "css", "book.css")))
  .update(fs.readFileSync(path.join(OUT, "assets", "js", "book.js")))
  .update(fs.readFileSync(path.join(OUT, "assets", "js", "book-checkout.js")))
  .digest("hex")
  .slice(0, 10);
setAssetVersion(assetHash);

const pages: PageDef[] = [
  homePage,
  aboutPage(),
  resourcesPage(articleIndex),
  freeChaptersPage(bookExcerpt),
  bookFunnelPage,
  bookCheckoutPage,
  bookBonusPage,
  bookApplyPage,
  bookThanksPage,
  bookAccessPage,
  bookOrderStatusPage,
  calculatorPage,
  dataNotesPage(),
  privacyPage(privacy.bodyHtml),
  privacyCanonicalPage(privacy.bodyHtml),
  termsPage,
  shippingReturnsPage,
  unsubscribePage,
  ...articles.map((a) => articlePage(a, articleIndex)),
];

// These routes are now server-owned permanent redirects to the homepage
// conversion hub. Remove any stale generated directories before emitting so a
// previously committed page cannot shadow the redirect contract.
for (const retiredDir of ["book-free-demo", "contact"]) {
  fs.rmSync(path.join(OUT, retiredDir), { recursive: true, force: true });
}

// ---- emit pages ----
let count = 0;
for (const p of pages) {
  const dir = path.join(OUT, p.path);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), layout(p));
  count++;
}

// ---- 404 page ----
// Every internal href/src is emitted as {{BASE}}<rest>; the server replaces
// {{BASE}} with "/" (marketing host) or "/website-preview/" (preview) so the
// page renders correctly at ANY request depth.
fs.writeFileSync(path.join(OUT, "404.html"), layout(notFoundPage));

// ---- sitemap manifest (server renders sitemap.xml with the right origin) ----
// Excludes the legacy privacy-policy URL (duplicate content of privacy/,
// see legalPolicyPage's canonicalPath override) and the personal/
// transactional book-funnel pages (checkout/bonus/apply/thanks/access/
// order-status) — none have unique search-worthy content, and access/
// order-status render per-buyer data.
const SITEMAP_EXCLUDED_PATHS = new Set([
  "privacy-policy/",
  "book/checkout/",
  "book/bonus/",
  "book/apply/",
  "book/thanks/",
  "book/access/",
  "book/order-status/",
]);

// Chrome-based pages don't carry an authored per-page date (unlike articles,
// which set PageDef.lastmod from their own JSON), so their sitemap <lastmod>
// is derived from git history of the file(s) that actually define each
// page's content — stable across every re-run of this generator (never
// changes unless one of those files is next committed with real edits),
// unlike a fabricated "now" that would churn on every regen.
const REPO_ROOT = path.resolve(ROOT, "..");
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

/** Most recent git commit date (ISO YYYY-MM-DD) across the given repo-root
    relative files, or null if git has no committed history for them yet
    (e.g. an uncommitted new file) — callers must omit lastmod rather than
    inventing one in that case. */
function gitLastModifiedIso(files: string[]): string | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", ...files],
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    return out ? out.slice(0, 10) : null;
  } catch {
    return null;
  }
}

const manifest = pages
  .filter((p) => !SITEMAP_EXCLUDED_PATHS.has(p.path))
  .map((p) => {
    const contentFiles = PAGE_CONTENT_FILES[p.path];
    const lastmod = p.lastmod ?? (contentFiles ? gitLastModifiedIso(contentFiles) : null);
    return {
      path: p.path,
      title: p.title,
      priority: p.priority ?? (p.path.startsWith("resource/") ? "0.5" : "0.7"),
      ...(lastmod ? { lastmod } : {}),
    };
  });
fs.writeFileSync(path.join(OUT, "sitemap-pages.json"), JSON.stringify(manifest, null, 2));

// ---- freshness stamp (PR4) ----
// Deterministic fingerprint of every generator input (website/src +
// website/content + the hand-authored assets hashed into ?v=), committed
// with the bundle. scripts/lint-website-bundle-freshness.ts recomputes it
// and fails the gate when an input was edited without re-running this
// generator. Served requests never see it: the server keeps it in
// INTERNAL_BUNDLE_FILES (server/website/marketingSite.ts).
const inputManifest = computeWebsiteInputManifest(path.resolve(ROOT, ".."));
fs.writeFileSync(
  path.join(OUT, "build-manifest.json"),
  renderWebsiteBuildManifest(inputManifest),
);

console.log(
  `generated ${count} pages + 404.html + sitemap-pages.json + build-manifest.json (inputs ${Object.keys(inputManifest.inputs).length}, fingerprint ${inputManifest.inputFingerprint.slice(0, 12)}…) -> website/public/`,
);
