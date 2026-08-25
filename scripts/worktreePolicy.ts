/**
 * worktreePolicy.ts — Task #3794: single source of truth for worktree
 * hygiene — junk-file patterns, sanctioned scratch zones, the `.local`
 * classification map, root-entry allow-lists, and the shared worktree walk.
 *
 * Consumed by:
 *   - scripts/lint-worktree-hygiene.ts  (deny-by-default validation gate)
 *   - scripts/clean-scratch.ts          (scratch GC — the gate's self-clean)
 *   - tests/lint-worktree-hygiene.test.ts, tests/clean-scratch.test.ts
 *
 * Policy summary (operator runbook: WORKTREE_HYGIENE.md):
 *   - Transient files belong in exactly TWO places: `.local/scratch/` or
 *     `tmp/` (both git-ignored). Scratch never lands next to product files.
 *   - `.local/` also holds platform-managed content (`state/`, `skills/`,
 *     `secondary_skills/`, `custom_skills/`) that must NEVER be touched, and
 *     agent tooling (`runs/`, `tasks/`) that is never auto-pruned by the
 *     generic scratch cleaner. Long-control evidence owns its separately
 *     scoped lifecycle below `.local/runs/long-validation/`. Only the declared
 *     scratch zones are prunable here; unknown `.local` entries are REPORTED,
 *     never deleted.
 *   - The repo root is deny-by-default: a new root-level file or directory
 *     requires a deliberate one-line registration in the allow-lists below,
 *     in the same change that introduces it.
 */

/** A junk-name rule: pattern + human remediation. */
export interface JunkRule {
  rx: RegExp;
  reason: string;
}

/**
 * Name patterns that are debris ANYWHERE in the tree (matched against the
 * basename). Keep in lockstep with the debris block in .gitignore
 * (Task #3790 / #3794).
 */
export const JUNK_ANYWHERE: JunkRule[] = [
  {
    rx: /\.bak$/i,
    reason:
      "merge/backup dump (*.bak) — resolve conflicts in place; never keep .bak snapshots",
  },
  {
    rx: /\.(orig|rej)$/i,
    reason: "patch/merge residue (*.orig / *.rej)",
  },
  {
    rx: /~$/,
    reason: "editor backup file (trailing ~)",
  },
  {
    rx: /^nohup\.out$/,
    reason:
      "nohup output capture — run long jobs via workflows; transient logs go in .local/scratch/",
  },
  {
    rx: /^tmp[_-]/i,
    reason:
      "scratch file (tmp_* / tmp-*) — scratch belongs in .local/scratch/ or tmp/ (both git-ignored)",
  },
  {
    rx: /_block\.txt$/i,
    reason: "merge-scratch block dump (*_block.txt)",
  },
  {
    rx: /^\.DS_Store$/,
    reason: "macOS Finder metadata (.DS_Store)",
  },
];

/**
 * Patterns that are debris only at the REPOSITORY ROOT (depth 0). The tree
 * legitimately contains .html (website/, client/) and generated logs deeper
 * down; at the root they are one-off dumps.
 */
export const JUNK_ROOT_ONLY: JunkRule[] = [
  {
    rx: /\.log$/i,
    reason: "log dump at repo root — transient logs belong in .local/scratch/",
  },
  {
    rx: /\.html$/i,
    reason:
      "one-off HTML dump at repo root — app HTML lives in client/ or website/; scratch dumps in .local/scratch/",
  },
];

/** Match a path's basename against the junk rules. `isRootLevel` = depth 0. */
export function matchJunk(baseName: string, isRootLevel: boolean): JunkRule | null {
  for (const rule of JUNK_ANYWHERE) {
    if (rule.rx.test(baseName)) return rule;
  }
  if (isRootLevel) {
    for (const rule of JUNK_ROOT_ONLY) {
      if (rule.rx.test(baseName)) return rule;
    }
  }
  return null;
}

/**
 * The ONLY prunable scratch zones (relative to the repo root). Everything
 * the GC deletes by zone lives under one of these. Both are git-ignored via
 * the repo's own .gitignore (see REQUIRED_GITIGNORE_LINES).
 */
export const SCRATCH_ZONES: string[] = [".local/scratch", "tmp"];

/**
 * `.local` classification map. Platform entries are NEVER touched (walked,
 * pruned, or deleted); tooling entries are agent/task infrastructure that is
 * never auto-pruned; prunable entries are the scratch zones. Anything else
 * found directly under `.local/` is reported as unclassified and left alone.
 */
export const LOCAL_PLATFORM_ENTRIES = new Set<string>([
  "state",
  "skills",
  "secondary_skills",
  "custom_skills",
]);

export const LOCAL_TOOLING_ENTRIES = new Set<string>([
  "runs", // per-invocation gate/test evidence and selection manifests
  "tasks", // provisioned task plans (.local/tasks/task-*.md)
  "hermetic-pg", // hermetic test-DB template cache (tests/hermetic/provision.ts)
  "exports", // deliberately exported deliverables (audit reports, zips) presented to the user
]);

export const LOCAL_PRUNABLE_ENTRIES = new Set<string>(["scratch"]);

export type LocalClass = "platform" | "tooling" | "prunable" | "unknown";

export function classifyLocalEntry(name: string): LocalClass {
  if (LOCAL_PLATFORM_ENTRIES.has(name)) return "platform";
  if (LOCAL_TOOLING_ENTRIES.has(name)) return "tooling";
  if (LOCAL_PRUNABLE_ENTRIES.has(name)) return "prunable";
  return "unknown";
}

/**
 * Directories the worktree walk never enters.
 *
 * Top-level (relative to root): environment/platform/scratch/asset dirs with
 * their own owners or GC. `.local` is excluded wholesale — only
 * clean-scratch's zone pruner (which enters ONLY .local/scratch) and its
 * unknown-entry reporter look inside it.
 */
export const WALK_EXCLUDE_TOP = new Set<string>([
  ".git",
  ".local",
  ".agents",
  ".cache",
  ".config",
  ".upm",
  ".source",
  "node_modules",
  "dist",
  "tmp", // sanctioned scratch zone — contents exempt by definition
  "attached_assets", // platform-managed uploads (out of scope, Task #3794)
]);

/** Directory NAMES skipped at any depth. */
export const WALK_EXCLUDE_ANYWHERE = new Set<string>([
  ".git",
  "node_modules",
  "dist",
]);

/** Specific relative PATHS skipped (build output regenerated on every build). */
export const WALK_EXCLUDE_PATHS = new Set<string>(["server/public"]);

/**
 * Root-level FILES that are deliberately part of the project. Anything at
 * the root that is not a dotfile, not *.md (owned by
 * scripts/verify-runbook-coverage.ts), not a tsconfig variant, and not in
 * this set is junk-by-default. Register a new entry here ONLY for a file
 * that genuinely must live at the root (build/tool configs, manifests) — in
 * the same change that introduces the file.
 */
export const ROOT_ALLOWLIST_FILES = new Set<string>([
  "components.json",
  "drizzle.config.ts",
  "generated-icon.png",
  // F12 (Task #4162): committed repository-aware Knip config for the
  // warning-only periodic audit (`npm run audit:knip`). Policy: KNIP_AUDIT.md.
  "knip.jsonc",
  "package.json",
  "package-lock.json",
  // pnpm-lock.yaml and postcss.config.js were deliberately REMOVED (code-health
  // prune, audits/H-code-health-findings.md): the repo is npm-only, and the
  // Vite build neutralizes PostCSS inline (vite.config.ts css.postcss). Do not
  // re-register them here — a returning pnpm lockfile or postcss config at the
  // root is drift, and this deny-by-default list is what catches it.
  "replit.nix",
  "skills-lock.json",
  "vite.config.ts",
  // vite-plugin-meta-images.ts was deliberately REMOVED (Task #4641): it
  // silently rewrote og:image/twitter:image to Replit-domain URLs whenever a
  // client/public/opengraph.* file existed. Do not re-register it here.
]);

export const TSCONFIG_VARIANT = /^tsconfig[\w.-]*\.json$/;

/**
 * Root-level DIRECTORIES that are deliberately part of the project. A new
 * top-level directory requires a one-line registration here in the same
 * change (deny-by-default, mirroring the RUNBOOKS-index obligation for root
 * runbooks). Dot-directories (.agents, .source, …) are exempt like dotfiles.
 */
export const ROOT_ALLOWLIST_DIRS = new Set<string>([
  "artifacts",
  "attached_assets",
  "audits",
  "client",
  "design-source",
  "docs",
  "migrations",
  "public",
  "script",
  "scripts",
  "server",
  "shared",
  "tests",
  "website",
]);

/**
 * Ignore lines the repo's OWN .gitignore must contain, so the scratch-zone
 * ignores do not depend on the environment-level /etc/.gitignore (which does
 * not travel with the repo).
 */
export const REQUIRED_GITIGNORE_LINES: string[] = [".local/", "tmp/"];

// ---------------------------------------------------------------------------
// Shared worktree walk
// ---------------------------------------------------------------------------

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WalkedJunk {
  /** Path relative to the walk root, using "/" separators. */
  path: string;
  reason: string;
}

/**
 * Walk the worktree under `rootDir` (honoring the exclusion sets) and return
 * every FILE whose basename matches a junk rule. Symlinks are never followed
 * (and never reported — the GC also skips them). Root-only rules apply at
 * depth 0 only.
 */
export function walkJunkFiles(rootDir: string): WalkedJunk[] {
  const found: WalkedJunk[] = [];
  walk(rootDir, "", found, true);
  return found;
}

/** Walk returning EVERY file (same exclusions), for fixture-based tests. */
export function walkAllFiles(rootDir: string): string[] {
  const all: string[] = [];
  collect(rootDir, "", all);
  return all;
}

function shouldSkipDir(relPath: string, name: string, isTop: boolean): boolean {
  if (WALK_EXCLUDE_ANYWHERE.has(name)) return true;
  if (isTop && WALK_EXCLUDE_TOP.has(name)) return true;
  if (WALK_EXCLUDE_PATHS.has(relPath)) return true;
  return false;
}

function walk(absDir: string, relDir: string, out: WalkedJunk[], isTop: boolean): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — nothing to report
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldSkipDir(rel, entry.name, isTop)) continue;
      walk(join(absDir, entry.name), rel, out, false);
    } else if (entry.isFile()) {
      const rule = matchJunk(entry.name, isTop);
      if (rule) out.push({ path: rel, reason: rule.reason });
    }
  }
}

function collect(absDir: string, relDir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  const isTop = relDir === "";
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldSkipDir(rel, entry.name, isTop)) continue;
      collect(join(absDir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

// lstatSync re-exported use: callers (GC) need symlink-safe stats.
export function lstatSafe(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
