/**
 * lint-worktree-hygiene.ts — Task #3794: deny-by-default worktree hygiene
 * gate. Absorbs and extends Task #3790's lint-root-junk (same debris
 * classes, now tree-wide, plus a full root-entry allow-list).
 *
 * Why: every task environment is provisioned from a full copy of the repo,
 * and the publish image carries the workspace's on-disk files — so junk
 * anywhere in the worktree (merge-conflict dumps, scratch scripts, log
 * captures) gets copied into every task environment and every deploy until
 * someone notices. Task #3790 removed ~66 such files once; this lint plus
 * the scratch GC (scripts/clean-scratch.ts) is the ONGOING mechanism that
 * stops re-accumulation. Policy + zone map: WORKTREE_HYGIENE.md.
 *
 * What it enforces:
 *   1. Junk name patterns (scripts/worktreePolicy.ts JUNK_ANYWHERE) are
 *      offenders anywhere in the git-visible tree (tracked + untracked-not-
 *      ignored); *.log / *.html additionally at the repo root only.
 *      Grandfathered tracked leftovers may be listed in
 *      scripts/lint-worktree-hygiene.baseline.txt (currently empty).
 *   2. Junk-pattern files that are on disk but GIT-IGNORED are offenders
 *      too — ignore rules hide them from git, but they still bloat every
 *      task environment and the publish image. Remediation: `npm run
 *      clean:scratch` deletes them (they are untracked by definition).
 *   3. The repo root is deny-by-default for BOTH files and directories:
 *      every non-dot, non-*.md root entry must be registered in
 *      worktreePolicy.ts (ROOT_ALLOWLIST_FILES / ROOT_ALLOWLIST_DIRS) —
 *      a deliberate one-line registration in the same change, mirroring
 *      the RUNBOOKS-index obligation. Root *.md files stay owned by
 *      scripts/verify-runbook-coverage.ts.
 *   4. The repo's OWN .gitignore must carry the scratch-zone ignores
 *      (`.local/`, `tmp/`) so the policy does not depend on the
 *      environment-level /etc/.gitignore, which does not travel with
 *      the repo.
 *
 * Wiring: `npm run gate` (after the clean-scratch self-clean step) and
 * scripts/predeploy.sh. The `.replit` `Validate` workflow runs that gate; the
 * SMOKE_FILES entry for tests/lint-worktree-hygiene.test.ts is part of the
 * enforcement.
 *
 * Escape hatch (emergency, audited): LINT_WORKTREE_HYGIENE_SKIP=1.
 *
 * Exit codes: 0 — worktree is clean; 1 — at least one offender.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchJunk,
  ROOT_ALLOWLIST_DIRS,
  ROOT_ALLOWLIST_FILES,
  REQUIRED_GITIGNORE_LINES,
  TSCONFIG_VARIANT,
  walkAllFiles,
  walkJunkFiles,
} from "./worktreePolicy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = resolve(__dirname, "lint-worktree-hygiene.baseline.txt");

export interface Offender {
  file: string;
  reason: string;
}

export interface LintResult {
  ok: boolean;
  offenders: Offender[];
  scanned: number;
}

export interface LintOptions {
  /**
   * Fixture injection: tracked file paths. At the real repo root this comes
   * from `git ls-files`. Pass `null` to simulate git being unavailable
   * (git-visible checks then see only `untrackedFiles`).
   */
  trackedFiles?: string[] | null;
  /**
   * Fixture injection: untracked-but-NOT-ignored paths. At the real repo
   * root this comes from `git ls-files --others --exclude-standard`. In
   * fixture mode, when omitted, every walked file that is not tracked is
   * treated as untracked-not-ignored (the natural state of a fresh fixture).
   */
  untrackedFiles?: string[];
  /** Fixture injection: baseline entries (grandfathered tracked junk). */
  baselineLines?: string[];
  /** Fixture injection: .gitignore content override (null = missing file). */
  gitignoreContent?: string | null;
}

function gitLines(args: string[], cwd: string): string[] {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadBaseline(): string[] {
  if (!existsSync(BASELINE_PATH)) return [];
  return readFileSync(BASELINE_PATH, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

export function runLint(rootDir: string = REPO_ROOT, opts: LintOptions = {}): LintResult {
  const isRealRoot = resolve(rootDir) === REPO_ROOT && opts.trackedFiles === undefined;

  let tracked: string[];
  let untracked: string[];
  if (isRealRoot) {
    tracked = gitLines(["ls-files"], rootDir);
    untracked = gitLines(["ls-files", "--others", "--exclude-standard"], rootDir);
  } else {
    tracked = opts.trackedFiles ?? [];
    untracked =
      opts.untrackedFiles ??
      walkAllFiles(rootDir).filter((f) => !tracked.includes(f));
  }

  const trackedSet = new Set(tracked);
  const gitVisible = [...new Set([...tracked, ...untracked])].sort();
  const gitVisibleSet = new Set(gitVisible);
  const baseline = new Set(opts.baselineLines ?? loadBaseline());

  const offenders: Offender[] = [];

  // --- 1. Junk patterns across the git-visible tree -----------------------
  for (const path of gitVisible) {
    const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const rule = matchJunk(base, !path.includes("/"));
    if (!rule) continue;
    if (baseline.has(path)) continue; // grandfathered (baseline convention)
    const via = trackedSet.has(path)
      ? "tracked — `git rm` it and move any keeper content where it belongs"
      : "untracked — `npm run clean:scratch` removes it, or move it to .local/scratch/ or tmp/";
    offenders.push({ file: path, reason: `${rule.reason} (${via})` });
  }

  // --- 2. On-disk junk that git ignores (still ships in copies) -----------
  for (const hit of walkJunkFiles(rootDir)) {
    if (gitVisibleSet.has(hit.path)) continue; // already reported above
    offenders.push({
      file: hit.path,
      reason:
        `${hit.reason} (git-ignored but ON DISK — still copied into every task ` +
        `environment and the publish image; run \`npm run clean:scratch\`)`,
    });
  }

  // --- 3. Root-entry allow-list (deny-by-default, files AND dirs) ---------
  const rootFiles = new Set<string>();
  const rootDirs = new Set<string>();
  for (const path of gitVisible) {
    const slash = path.indexOf("/");
    if (slash === -1) rootFiles.add(path);
    else rootDirs.add(path.slice(0, slash));
  }

  for (const file of [...rootFiles].sort()) {
    const base = file;
    if (matchJunk(base, true)) continue; // junk already reported in pass 1
    if (file.startsWith(".")) continue; // dotfiles (config-class) exempt
    if (/\.md$/i.test(file)) continue; // owned by verify-runbook-coverage
    if (ROOT_ALLOWLIST_FILES.has(file) || TSCONFIG_VARIANT.test(file)) continue;
    offenders.push({
      file,
      reason:
        "unregistered root-level file — module code belongs in server/, client/, scripts/, …; " +
        "scratch belongs in .local/scratch/ or tmp/. If this file genuinely must live at the " +
        "root, register it in ROOT_ALLOWLIST_FILES (scripts/worktreePolicy.ts) in the same change.",
    });
  }

  for (const dir of [...rootDirs].sort()) {
    if (dir.startsWith(".")) continue; // dot-directories (.agents, .source) exempt
    if (ROOT_ALLOWLIST_DIRS.has(dir)) continue;
    offenders.push({
      file: `${dir}/`,
      reason:
        "unregistered top-level directory — new product code belongs inside an existing module " +
        "directory; scratch belongs in .local/scratch/ or tmp/. If a new top-level directory is " +
        "genuinely needed, register it in ROOT_ALLOWLIST_DIRS (scripts/worktreePolicy.ts) in the " +
        "same change.",
    });
  }

  // --- 4. Repo-portable scratch-zone ignores -------------------------------
  let gitignore: string | null;
  if (opts.gitignoreContent !== undefined) {
    gitignore = opts.gitignoreContent;
  } else {
    const p = resolve(rootDir, ".gitignore");
    gitignore = existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  const ignoreLines = new Set(
    (gitignore ?? "").split("\n").map((s) => s.trim()),
  );
  for (const required of REQUIRED_GITIGNORE_LINES) {
    if (!ignoreLines.has(required)) {
      offenders.push({
        file: ".gitignore",
        reason:
          `missing required ignore line \`${required}\` — scratch-zone ignores must live in the ` +
          `repo's own .gitignore (portable), not only the environment-level /etc/.gitignore.`,
      });
    }
  }

  return { ok: offenders.length === 0, offenders, scanned: gitVisible.length };
}

/**
 * Gate worker entry point (Task #3789 contract): import-side-effect-free,
 * prints exactly what the standalone CLI prints, returns the exit code.
 */
export function cliMain(): number {
  if (process.env.LINT_WORKTREE_HYGIENE_SKIP === "1") {
    console.log(
      "[lint-worktree-hygiene] SKIPPED (LINT_WORKTREE_HYGIENE_SKIP=1 — emergency override; " +
        "the worktree was NOT validated).",
    );
    return 0;
  }
  const result = runLint();
  if (result.ok) {
    console.log(
      `[lint-worktree-hygiene] OK — scanned ${result.scanned} git-visible files ` +
        `(+ on-disk ignored junk sweep, root allow-list, .gitignore portability); worktree is clean.`,
    );
    return 0;
  }
  console.error(
    `[lint-worktree-hygiene] FAILED — ${result.offenders.length} offender(s):`,
  );
  for (const o of result.offenders) {
    console.error(`  ${o.file}`);
    console.error(`    ${o.reason}`);
  }
  console.error(
    "\nWhere things belong: transient/scratch files go ONLY in .local/scratch/ or tmp/ " +
      "(both git-ignored, TTL-pruned by scripts/clean-scratch.ts). `npm run clean:scratch` " +
      "removes untracked junk for you; tracked junk needs `git rm`. New root-level entries " +
      "require a one-line allow-list registration in scripts/worktreePolicy.ts in the same " +
      "change. Full policy: WORKTREE_HYGIENE.md.",
  );
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-worktree-hygiene.ts") ?? false);

if (isMain) {
  process.exit(cliMain());
}
