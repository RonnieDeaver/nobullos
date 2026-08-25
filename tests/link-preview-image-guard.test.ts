/* test-registration
{
  "name": "Link-preview image guard — client/index.html og:image and twitter:image must point at the canonical NoBull card (https://reports.nobullmarketing.com/brand/og-nobull-os.png) and no meta tag may reference a *.replit.dev / *.replit.app / replit.com image host (Task #4664)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4664: sub-second hermetic check (single file read, no DB/network). Task #4641 removed the vite-plugin-meta-images machinery that silently rewrote link-preview tags to Replit-domain URLs; nothing else verifies the NoBull-branded tags stay verbatim. A template edit or re-introduced rewrite plugin would otherwise ship a wrong client-facing link preview and only surface in a client's Slack unfurl. scanPaths keeps it gate-selected only when the shell or this guard changes.",
  "scanPaths": [
    "client/index.html",
    "tests/link-preview-image-guard.test.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4664 — catch a wrong link-preview image before it ships.
 *
 * Task #4641 deleted the vite-plugin-meta-images rewrite machinery that used
 * to silently repoint og:image/twitter:image at a Replit-domain opengraph.*
 * file, so client/index.html's NoBull-branded tags now serve verbatim. This
 * guard pins that outcome:
 *
 *   1. Exactly one og:image and one twitter:image tag exist, each pointing
 *      at the canonical NoBull card (absolute prod URL — scrapers require
 *      absolute; host per server/services/publicUrl.ts).
 *   2. No <meta> content attribute anywhere in the shell references a
 *      Replit-domain host (*.replit.dev, *.replit.app, replit.com) — the
 *      exact regression class the removed plugin used to introduce.
 *
 * The Replit-host scan deliberately looks only at meta tag content
 * attributes (not the whole file) so the historical HTML comment explaining
 * the Task #4641 removal doesn't false-positive.
 *
 * Hermetic L1: one filesystem read, no DB, no network, no DOM libs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const html = readFileSync(join(ROOT, "client/index.html"), "utf8");

const CANONICAL_OG_IMAGE =
  "https://reports.nobullmarketing.com/brand/og-nobull-os.png";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// Parse every <meta ...> tag and pull out its property/name + content.
// Attribute order varies, so match attributes individually per tag.
// ---------------------------------------------------------------------------
interface MetaTag {
  raw: string;
  key: string | null; // property=... or name=... (case-insensitive, any valid HTML quoting)
  content: string | null;
}

// HTML allows attribute names in any case and values double-quoted,
// single-quoted, or unquoted — a rewrite plugin emitting
// content='https://x.replit.dev/…' or CONTENT=… is just as valid to a
// scraper, so the extractor must see all forms (review-hardened).
function metaAttr(tag: string, names: string[]): string | null {
  const attr = tag.match(
    new RegExp(
      `\\b(?:${names.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
      "i",
    ),
  );
  if (!attr) return null;
  return attr[1] ?? attr[2] ?? attr[3] ?? null;
}

function parseMetaTags(source: string): MetaTag[] {
  return [...source.matchAll(/<meta\b[^>]*>/gi)].map((m) => {
    const raw = m[0];
    return {
      raw,
      key: metaAttr(raw, ["property", "name"])?.toLowerCase() ?? null,
      content: metaAttr(raw, ["content"]),
    };
  });
}

const metaTags: MetaTag[] = parseMetaTags(html);

assert.ok(
  metaTags.length > 0,
  "client/index.html yielded zero <meta> tags — the shell head was gutted or the parser regex broke",
);

// ---------------------------------------------------------------------------
// 1. Exactly one og:image and one twitter:image, each the canonical NoBull
//    card. Duplicates matter: scrapers pick the FIRST tag, so a rewrite
//    plugin that prepends its own og:image would win even with ours intact.
// ---------------------------------------------------------------------------
for (const key of ["og:image", "twitter:image"]) {
  const tags = metaTags.filter((t) => t.key === key);
  assert.equal(
    tags.length,
    1,
    `expected exactly one ${key} meta tag in client/index.html, found ${tags.length} — duplicates let a rewrite win (scrapers take the first tag) and zero ships no preview image at all`,
  );
  assert.equal(
    tags[0].content,
    CANONICAL_OG_IMAGE,
    `${key} must point at the canonical NoBull card ${CANONICAL_OG_IMAGE} — got ${JSON.stringify(tags[0].content)}. A wrong URL here ships a broken/off-brand link preview to every client Slack/iMessage unfurl.`,
  );
  ok(`${key} is exactly the canonical NoBull card URL (single tag)`);
}

// ---------------------------------------------------------------------------
// 2. No meta tag content may reference a Replit-domain host — the exact
//    regression the removed vite-plugin-meta-images used to introduce
//    (it repointed image tags at <repl>.replit.dev/.replit.app opengraph
//    files). Checked across ALL meta tags, not just the image ones, so a
//    re-introduced plugin emitting og:image:secure_url or similar variants
//    is caught too.
// ---------------------------------------------------------------------------
const REPLIT_HOST = /(?:^|[\/."'@])(?:[a-z0-9-]+\.)*replit\.(?:dev|app|com)\b/i;
const offenders = metaTags.filter(
  (t) => t.content !== null && REPLIT_HOST.test(t.content),
);
assert.deepEqual(
  offenders.map((t) => t.raw),
  [],
  "client/index.html meta tags must never reference a Replit-domain host — this is the Task #4641 regression class (silent rewrite of link-preview images to Replit URLs)",
);
ok("no meta tag content references a *.replit.dev / *.replit.app / replit.com host");

// ---------------------------------------------------------------------------
// 3. Self-test: the extractor + Replit-host ban must catch valid-HTML
//    quoting/casing variants a rewrite plugin could emit (single-quoted,
//    unquoted, uppercase attributes). If parsing quietly narrows to
//    double-quoted lowercase, this negative fixture fails loudly instead of
//    the ban silently going blind.
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
  assert.ok(
    parsed[0].content !== null && REPLIT_HOST.test(parsed[0].content),
    `self-test: the Replit-host ban failed to catch the ${label} variant ${JSON.stringify(fixture)} — the extractor has gone blind to valid HTML quoting/casing`,
  );
}
ok(`self-test: Replit-host ban catches quoting/casing evasion variants (${evasionFixtures.length} fixtures)`);

console.log(`link-preview image guard: ${passed} checks passed`);
