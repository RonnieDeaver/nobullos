// Deterministic input fingerprint for the committed marketing bundle (PR4).
//
// website/public is a COMMITTED build artifact: website/generate.ts renders
// the HTML pages and bundles the client entries (website/src/home-client,
// website/src/site-client) into public/assets/js/home.js + site.js, and
// script/build.ts only COPIES website/public into dist/website. Nothing
// regenerates the bundle automatically, so editing any generator input
// without re-running the generator silently ships stale JS/HTML on the
// production lead-gen homepage.
//
// This module is the single source of truth for "what counts as a generator
// input" and how those inputs are fingerprinted. It is shared by:
//   - website/generate.ts        (stamps the fingerprint into
//                                 website/public/build-manifest.json)
//   - scripts/lint-website-bundle-freshness.ts
//                                 (recomputes and compares; fails the gate
//                                 with the regeneration command on drift)
// Keeping both sides on ONE implementation means the stamp and the check can
// never drift apart.
//
// The fingerprint is computed over input CONTENT + PATHS (sha256 per file,
// aggregated over the sorted path list), so adding, removing, renaming, or
// editing any input changes it. It deliberately does NOT hash the generated
// outputs (pages, home.js, site.js, sitemap-pages.json): output bytes can
// legitimately differ across esbuild versions, and the guard's contract is
// "the committed stamp matches the committed inputs", which is stable and
// deterministic.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The exact command that regenerates the bundle (quoted in lint failures). */
export const WEBSITE_REGEN_COMMAND = "npx tsx website/generate.ts";

/** Repo-relative path of the committed stamp file (part of the bundle). */
export const WEBSITE_BUILD_MANIFEST_PATH = "website/public/build-manifest.json";

/**
 * Directories whose entire (committed) content is generator input:
 *   - website/src:     page templates, shared layout, and the client TS
 *                      bundled into public/assets/js/home.js + site.js
 *                      (home-client, site-client, client-shared)
 *   - website/content: article/legal JSON rendered into the pages
 * Every file under these roots is included, recursively (dotfiles like
 * .DS_Store are skipped — they are environment litter, never inputs).
 */
export const WEBSITE_INPUT_DIRS = ["website/src", "website/content"] as const;

/**
 * Individual input files outside those roots:
 *   - the generator itself + this module (logic changes re-render output);
 *   - the two hand-authored public CSS assets whose content generate.ts
 *     hashes into the `?v=` cache-buster stamped on every page. Editing one
 *     without regenerating leaves a stale `?v=` in the committed HTML, so
 *     returning visitors keep day-old cached CSS. public/assets/js/home.js
 *     and public/assets/js/site.js are deliberately EXCLUDED — both are
 *     generator OUTPUTS bundled from website/src (site.js since PR5), and
 *     website/src is already fingerprinted above.
 * Missing entries are skipped (fixture trees in tests are partial; in the
 * real repo a deleted asset still changes the enumeration and therefore the
 * fingerprint).
 */
export const WEBSITE_INPUT_FILES = [
  "website/generate.ts",
  "website/fingerprint.ts",
  "website/public/assets/css/site.css",
  "website/public/assets/css/home.css",
  "website/public/assets/css/book.css",
] as const;

export interface WebsiteInputManifest {
  /** Aggregate sha256 over the sorted `path\n<sha256>\n` entry lines. */
  inputFingerprint: string;
  /** Repo-relative posix path -> sha256 of file content. */
  inputs: Record<string, string>;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Recursively collect files under `absDir` as repo-relative posix paths. */
function walkDir(absDir: string, relDir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // missing input dir (fixture tree) — contributes nothing
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .DS_Store & co — never inputs
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walkDir(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Computes the current input manifest from the tree at `root` (defaults to
 * the repo root containing this file). Deterministic: paths are sorted and
 * content is hashed byte-for-byte, so two runs over the same tree always
 * agree, regardless of platform or esbuild version.
 */
export function computeWebsiteInputManifest(root?: string): WebsiteInputManifest {
  const repoRoot = root ?? path.resolve(__dirnameCompat(), "..");

  const files: string[] = [];
  for (const dir of WEBSITE_INPUT_DIRS) {
    walkDir(path.join(repoRoot, dir), dir, files);
  }
  for (const file of WEBSITE_INPUT_FILES) {
    if (fs.existsSync(path.join(repoRoot, file))) files.push(file);
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const inputs: Record<string, string> = {};
  const aggregate = crypto.createHash("sha256");
  for (const rel of files) {
    const digest = sha256(fs.readFileSync(path.join(repoRoot, rel)));
    inputs[rel] = digest;
    aggregate.update(`${rel}\n${digest}\n`);
  }

  return { inputFingerprint: aggregate.digest("hex"), inputs };
}

/** Serialized manifest file content (deterministic key order, LF, EOF \n). */
export function renderWebsiteBuildManifest(manifest: WebsiteInputManifest): string {
  return (
    JSON.stringify(
      {
        "//": `Generated by \`${WEBSITE_REGEN_COMMAND}\` — do not edit by hand. scripts/lint-website-bundle-freshness.ts fails the gate when this stamp no longer matches the website/src + website/content inputs.`,
        regenerate: WEBSITE_REGEN_COMMAND,
        inputFingerprint: manifest.inputFingerprint,
        inputs: manifest.inputs,
      },
      null,
      2,
    ) + "\n"
  );
}

// server/website/marketingSite.ts pattern: dev runs this file under tsx
// (ESM, import.meta.url), the file is never part of the CJS prod bundle,
// but keep the guard anyway so an accidental bundling cannot crash.
function __dirnameCompat(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return path.dirname(new URL(import.meta.url).pathname);
}
