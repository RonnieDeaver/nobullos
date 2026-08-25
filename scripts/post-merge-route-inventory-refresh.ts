/**
 * Task #4111 — Post-merge route-inventory auto-refresh.
 *
 * Ran by scripts/post-merge.sh right after every merge. Two independently
 * green tasks can merge into main with line-number-only drift in
 * tests/route-inventory.json (each passed alone; the combined merge shifted
 * route line numbers with nobody regenerating). Until someone manually ran
 * `npx tsx scripts/regen-route-inventory.mjs`, EVERY nightly run stayed red
 * (3 consecutive reds on 2026-08-08) — training the team to ignore red runs.
 *
 * What it does:
 *   1. Runs the same freshness check as scripts/lint-route-inventory-freshness.ts
 *      (imported runLint(), not a re-implementation — no drift between them).
 *   2. If fresh: prints OK, exits 0.
 *   3. If stale: runs the regen script, re-runs the lint, and commits the
 *      refreshed tests/route-inventory.json + tests/route-inventory-report.md
 *      (ONLY those two paths are staged; nothing else is swept into the
 *      commit) so the next nightly sweep sees a fresh inventory.
 *   4. If the lint STILL fails after regen (e.g. duplicate live route
 *      registrations — a source problem regen cannot fix), the refreshed
 *      inventory is still committed (it is accurate) but the script exits 1
 *      so post-merge.sh surfaces a loud warning at merge time instead of the
 *      failure first appearing in the next nightly sweep.
 *
 * No behavior change to the lint itself: line/detail drift stays a lint
 * failure everywhere else (gate + SMOKE_FILES); this hook just repairs the
 * committed artifacts at the moment the staleness is created.
 *
 * Exit codes: 0 = fresh or auto-refreshed clean; 1 = needs human attention
 * (regen crashed, commit failed, or lint still red after regen).
 */

import { spawnSync } from "node:child_process";
import { runLint, type RouteInventoryLintResult } from "./lint-route-inventory-freshness";

export const INVENTORY_PATHS = [
  "tests/route-inventory.json",
  "tests/route-inventory-report.md",
] as const;

export const AUTO_COMMIT_MESSAGE =
  "post-merge: auto-regenerate route inventory (merge-shifted drift, Task #4111)";

export interface RefreshDeps {
  /** Freshness check; defaults to the real lint's runLint(). */
  lint: () => RouteInventoryLintResult;
  /** Regenerate the inventory artifacts; return true on success. */
  regen: () => boolean;
  /** Stage exactly the inventory paths and commit; returns outcome. */
  commit: () => "committed" | "nothing-to-commit" | "failed";
  log: (line: string) => void;
}

export interface RefreshResult {
  /** What happened, for tests and the console summary. */
  outcome:
    | "fresh"
    | "refreshed-committed"
    | "refreshed-nothing-to-commit"
    | "regen-failed"
    | "commit-failed"
    | "still-stale-after-regen";
  exitCode: 0 | 1;
  problemsBefore: string[];
  problemsAfter: string[];
}

/**
 * Decision core, unit-testable with injected deps: lint → (stale?) regen →
 * re-lint → commit. Never throws.
 */
export function refreshRouteInventoryIfStale(deps: RefreshDeps): RefreshResult {
  const before = deps.lint();
  if (before.ok) {
    deps.log(
      `[route-inventory-refresh] OK — committed inventory matches a fresh scan (${before.freshCount} routes); nothing to do.`,
    );
    return { outcome: "fresh", exitCode: 0, problemsBefore: [], problemsAfter: [] };
  }

  deps.log(
    `[route-inventory-refresh] STALE after merge — ${before.problems.length} problem(s):`,
  );
  for (const p of before.problems) deps.log(`  - ${p}`);
  deps.log(
    "[route-inventory-refresh] auto-running scripts/regen-route-inventory.mjs (merge-shifted drift would otherwise turn every nightly run red until someone regenerates by hand) …",
  );

  if (!deps.regen()) {
    deps.log(
      "[route-inventory-refresh] !!! regen FAILED — inventory is still stale; the nightly lint WILL be red. Run `npx tsx scripts/regen-route-inventory.mjs` by hand and commit the results.",
    );
    return { outcome: "regen-failed", exitCode: 1, problemsBefore: before.problems, problemsAfter: before.problems };
  }

  const after = deps.lint();
  // Commit the refreshed artifacts regardless of remaining problems: a
  // regenerated inventory is accurate even when e.g. duplicate live route
  // registrations keep the lint red (that is a source bug regen cannot fix).
  const commitOutcome = deps.commit();
  if (commitOutcome === "failed") {
    deps.log(
      "[route-inventory-refresh] !!! COMMIT FAILED — the regenerated inventory is only in the worktree. Commit tests/route-inventory.json + tests/route-inventory-report.md by hand or the refresh is lost on the next clean checkout.",
    );
    return { outcome: "commit-failed", exitCode: 1, problemsBefore: before.problems, problemsAfter: after.problems };
  }

  if (!after.ok) {
    deps.log(
      `[route-inventory-refresh] !!! STILL FAILING after regen — ${after.problems.length} problem(s) regen cannot fix (fix the SOURCE, e.g. delete shadowed duplicate registrations):`,
    );
    for (const p of after.problems) deps.log(`  - ${p}`);
    return {
      outcome: "still-stale-after-regen",
      exitCode: 1,
      problemsBefore: before.problems,
      problemsAfter: after.problems,
    };
  }

  if (commitOutcome === "nothing-to-commit") {
    // Possible when a prior partial run already regenerated but the lint saw
    // a stale on-disk read, or the drift lived only in the report timestamp.
    deps.log(
      `[route-inventory-refresh] refreshed — inventory now fresh (${after.freshCount} routes); artifacts already matched HEAD, nothing to commit.`,
    );
    return { outcome: "refreshed-nothing-to-commit", exitCode: 0, problemsBefore: before.problems, problemsAfter: [] };
  }

  deps.log(
    `[route-inventory-refresh] refreshed + committed — inventory fresh again (${after.freshCount} routes). Nightly lint-route-inventory-freshness stays green.`,
  );
  return { outcome: "refreshed-committed", exitCode: 0, problemsBefore: before.problems, problemsAfter: [] };
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  }
}

function realRegen(): boolean {
  const res = run("npx", ["tsx", "scripts/regen-route-inventory.mjs"]);
  if (!res.ok) {
    console.error(`[route-inventory-refresh] regen stderr: ${res.stderr.trim().slice(0, 2000)}`);
  }
  return res.ok;
}

function realCommit(): "committed" | "nothing-to-commit" | "failed" {
  // Stage ONLY the inventory artifacts — post-merge worktrees can carry other
  // modifications that must never be swept into this auto-commit.
  const add = run("git", ["add", "--", ...INVENTORY_PATHS]);
  if (!add.ok) {
    console.error(`[route-inventory-refresh] git add failed: ${add.stderr.trim()}`);
    return "failed";
  }
  const staged = run("git", ["diff", "--cached", "--quiet", "--", ...INVENTORY_PATHS]);
  if (staged.ok) return "nothing-to-commit"; // exit 0 = no staged changes
  const commit = run("git", [
    "-c",
    "user.name=post-merge route-inventory refresh",
    "-c",
    "user.email=post-merge@local",
    "commit",
    "--no-verify",
    "-m",
    AUTO_COMMIT_MESSAGE,
    "--only",
    "--",
    ...INVENTORY_PATHS,
  ]);
  if (!commit.ok) {
    console.error(`[route-inventory-refresh] git commit failed: ${commit.stderr.trim()}`);
    return "failed";
  }
  return "committed";
}

export function cliMain(): number {
  const result = refreshRouteInventoryIfStale({
    lint: () => runLint(),
    regen: realRegen,
    commit: realCommit,
    log: (line) => console.log(line),
  });
  return result.exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("post-merge-route-inventory-refresh.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
