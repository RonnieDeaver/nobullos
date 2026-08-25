/**
 * Task #4670 — verify the BUILT site (dist/public/index.html) still ships the
 * NoBull link-preview image.
 *
 * Task #4664's tests/link-preview-image-guard.test.ts pins the og:image /
 * twitter:image tags in client/index.html (the SOURCE template). But a
 * build-time HTML transform — e.g. a re-introduced Vite plugin like the
 * removed vite-plugin-meta-images (Task #4641) — could rewrite those tags in
 * the built output while the source stays clean: the source guard would stay
 * green while production ships a Replit-domain preview image.
 *
 * This check closes that gap at the only seam where the build artifact is
 * guaranteed to exist: script/build.ts calls assertBuiltLinkPreview() right
 * after `viteBuild()` writes dist/public/index.html, so every deploy build
 * (`./scripts/predeploy.sh && npm run build`, per .replit [deployment].build)
 * fails loudly if the built HTML drifts. Deliberately NOT part of the L1
 * smoke gate — a Vite build is far too slow for L1 (task contract).
 *
 * Contract (mirrors the source-side guard):
 *   1. Exactly one og:image and one twitter:image tag, each pointing at the
 *      canonical NoBull card (absolute prod URL).
 *   2. No <meta> content attribute anywhere in the built shell references a
 *      Replit-domain host (*.replit.dev, *.replit.app, replit.com) — the
 *      exact regression class the removed plugin used to introduce.
 *
 * The meta-tag extractor matches the review-hardened one in
 * tests/link-preview-image-guard.test.ts: attribute names in any case,
 * values double-quoted, single-quoted, or unquoted — a rewrite plugin
 * emitting content='…' or CONTENT=… is just as valid to a scraper.
 *
 * Also runnable standalone against an existing build:
 *   npx tsx scripts/verify-built-link-preview.ts [path/to/index.html]
 * (a missing file is a FAILURE — the CLI is only meaningful post-build).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CANONICAL_OG_IMAGE =
  "https://reports.nobullmarketing.com/brand/og-nobull-os.png";

export const DEFAULT_BUILT_HTML_PATH = "dist/public/index.html";

const REPLIT_HOST = /(?:^|[\/."'@])(?:[a-z0-9-]+\.)*replit\.(?:dev|app|com)\b/i;

interface MetaTag {
  raw: string;
  key: string | null;
  content: string | null;
}

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

export function parseMetaTags(source: string): MetaTag[] {
  return [...source.matchAll(/<meta\b[^>]*>/gi)].map((m) => {
    const raw = m[0];
    return {
      raw,
      key: metaAttr(raw, ["property", "name"])?.toLowerCase() ?? null,
      content: metaAttr(raw, ["content"]),
    };
  });
}

/**
 * Pure check: returns a list of human-readable problems (empty = pass).
 * Exported separately from the assert wrapper so the guard test can exercise
 * failure fixtures without touching the filesystem.
 */
export function checkBuiltHtml(html: string): string[] {
  const problems: string[] = [];
  const metaTags = parseMetaTags(html);

  if (metaTags.length === 0) {
    problems.push(
      "built index.html yielded zero <meta> tags — the head was gutted by a build transform or the parser regex broke",
    );
    return problems;
  }

  for (const key of ["og:image", "twitter:image"]) {
    const tags = metaTags.filter((t) => t.key === key);
    if (tags.length !== 1) {
      problems.push(
        `expected exactly one ${key} meta tag in the built HTML, found ${tags.length} — duplicates let a build-time rewrite win (scrapers take the first tag) and zero ships no preview image at all`,
      );
      continue;
    }
    if (tags[0].content !== CANONICAL_OG_IMAGE) {
      problems.push(
        `${key} in the built HTML must be the canonical NoBull card ${CANONICAL_OG_IMAGE} — got ${JSON.stringify(tags[0].content)}. The source template may be clean (Task #4664 guard green) while a build transform rewrote the shipped tag.`,
      );
    }
  }

  const offenders = metaTags.filter(
    (t) => t.content !== null && REPLIT_HOST.test(t.content),
  );
  for (const t of offenders) {
    problems.push(
      `built HTML meta tag references a Replit-domain host (the Task #4641 vite-plugin-meta-images regression class): ${t.raw}`,
    );
  }

  return problems;
}

/**
 * Build-seam entry point: read the built shell and THROW (failing the deploy
 * build) if the shipped link-preview tags drifted from the NoBull card.
 */
export function assertBuiltLinkPreview(
  htmlPath: string = DEFAULT_BUILT_HTML_PATH,
): void {
  if (!existsSync(htmlPath)) {
    throw new Error(
      `[verify-built-link-preview] ${htmlPath} does not exist — this check must run AFTER the Vite client build has written the built shell (never a silent skip: a missing artifact here means the build seam moved).`,
    );
  }
  const problems = checkBuiltHtml(readFileSync(htmlPath, "utf8"));
  if (problems.length > 0) {
    throw new Error(
      `[verify-built-link-preview] the BUILT site would ship a wrong link-preview image (source guard tests/link-preview-image-guard.test.ts cannot see build-time rewrites):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  console.log(
    `[verify-built-link-preview] OK — ${htmlPath} ships og:image/twitter:image = ${CANONICAL_OG_IMAGE} and no Replit-domain meta hosts`,
  );
}

const isMain = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    assertBuiltLinkPreview(process.argv[2] ?? DEFAULT_BUILT_HTML_PATH);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
