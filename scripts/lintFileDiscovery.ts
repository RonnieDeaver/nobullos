/**
 * Shared repo-wide file discovery for lint scanners (Task #2846).
 *
 * Extracted from scripts/lint-merge-conflict-markers.ts (Task #2835), where
 * the pattern was first proven: a lint whose intent is "every relevant file
 * in the repo" must source its file list from `git ls-files` and exclude via
 * a small binary/asset DENYLIST — never from hand-maintained directory roots
 * plus an extension allow-list. Allow-lists drift: a new tree or a new
 * extension silently falls out of scope with no signal. A denylist inverts
 * the failure mode — a new file type is scanned by default, and forgetting a
 * denylist entry means over-scanning, not silence.
 * See .agents/memory/lint-scope-git-ls-files-denylist.md.
 *
 * Consumers:
 *   - `listTrackedFiles()` — the authoritative repo file list (git ls-files).
 *   - `isScannablePath(file)` — denylist predicate (path segments + binary
 *     extensions). Lints layer their own semantic filter (e.g. ".ts/.tsx
 *     only") ON TOP of this; the discovery itself stays repo-wide.
 *   - `walkDir` / `collectTopLevelFiles` — fixture-mode directory walks that
 *     apply the SAME denylist, so tests can point a lint at a temp tree.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Binary / asset extensions no text lint can meaningfully scan. This is a
// DENYLIST: any tracked file whose extension is NOT listed here is in scope,
// including unknown extensions and extension-less files.
export const BINARY_EXTENSIONS = new Set([
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".heic",
  ".avif",
  // fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // archives
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  // audio / video
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".m4a",
  // office / documents
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  // misc binary
  ".wasm",
  ".exe",
  ".bin",
  ".so",
  ".dylib",
  ".db",
  ".sqlite",
]);

// Path segments excluded from scans wherever they appear. Tracked
// attached_assets/ is a pure upload/asset tree; fixtures/ directories hold
// intentionally-broken content; the rest are untracked in practice but kept
// for the fixture-walk mode.
export const SKIP_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".git",
  "fixtures",
  "attached_assets",
]);

/**
 * Denylist predicate shared by BOTH the git-ls-files default mode and the
 * fixture directory-walk mode: skip denylisted path segments and binary
 * extensions. Lints add their own self-file skip and semantic filters on
 * top of this.
 */
export function isScannablePath(file: string): boolean {
  const segments = file.split("/");
  const base = segments[segments.length - 1];
  for (let i = 0; i < segments.length - 1; i++) {
    if (SKIP_PATH_SEGMENTS.has(segments[i])) return false;
  }
  // lastIndexOf > 0 (not >= 0) so dotfiles like `.replit` count as
  // extension-less, not as having extension ".replit".
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return true;
}

/**
 * Default mode: the authoritative file list is what git tracks. New
 * extensions, extension-less files (Dockerfile, Procfile), and new config
 * formats are automatically in scope the moment they are tracked — no
 * allow-list to forget to update.
 */
export function listTrackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((f) => f.length > 0);
}

/**
 * Fixture-walk mode: recursive directory walk applying the same denylist.
 * `accept` lets a lint layer its semantic filter (e.g. self-file skip,
 * ".ts/.tsx only") over the shared denylist.
 *
 * DELIBERATE: fixture mode inherits the FULL denylist, including the
 * `fixtures` path segment — so fixture-mode behavior matches default-mode
 * behavior exactly. Tests must build their temp trees without a directory
 * literally named `fixtures` (or any other SKIP_PATH_SEGMENTS name) on the
 * scanned path, or those files are skipped just as they would be in the
 * real repo.
 */
export function walkDir(
  dir: string,
  out: string[],
  accept: (file: string) => boolean = isScannablePath,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_PATH_SEGMENTS.has(entry)) walkDir(full, out, accept);
      continue;
    }
    if (isScannablePath(full) && accept(full)) out.push(full);
  }
}

/**
 * Fixture-walk mode: collect scannable files sitting DIRECTLY in `dir`
 * without recursing into any subdirectory.
 */
export function collectTopLevelFiles(
  dir: string,
  out: string[],
  accept: (file: string) => boolean = isScannablePath,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    if (isScannablePath(full) && accept(full)) out.push(full);
  }
}
