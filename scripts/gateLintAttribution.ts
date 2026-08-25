/**
 * Task #4491 — Self-healing gate for upstream lint drift.
 *
 * Two failure classes repeatedly cost task agents hours of manual innocence
 * proofs (worktree A/B runs, `git log -1` archaeology):
 *   (a) gate lint reds INHERITED from the task's base tree — upstream landed a
 *       violation (possibly after the last nightly red-manifest publish, so the
 *       suite-side manifest rails can never cover it), and
 *   (b) freshness lints on committed generated artifacts (route inventory,
 *       endpoint contract table, website bundle) that go stale after every
 *       completion rebase, where the remedy is always the same mechanical
 *       "run the registered generator on the rebased tree".
 *
 * This module mechanizes both, called from scripts/gate.ts when gate lints
 * fail:
 *   1. SELF-HEAL (freshness lints): for a failing gate lint that corresponds
 *      to an artifact in the post-merge regen registry, run its registered
 *      generator, re-verify the lint, and commit the artifact-only diff —
 *      exactly like scripts/post-merge-*-refresh.ts do at merge time. Unlike
 *      the post-merge flow (which commits even a still-stale regen, because
 *      the next actor is a human at merge time), the gate flow commits ONLY
 *      when the lint re-verifies green: a task-env commit that doesn't fix
 *      the gate would be a surprising side effect, and the regen is reverted
 *      so the tree is left exactly as found. Non-converging regens and regens
 *      that write outside the registered artifact paths fail red as before.
 *   2. BASE-TREE A/B ATTRIBUTION (all other lint reds): re-run just the
 *      failing lints against the task's upstream base tree in a disposable
 *      `git worktree` (shared node_modules, time-budgeted) and classify each
 *      red inherited-vs-yours by comparing normalized offense signatures.
 *      This is a LIVE check — no staleness window at all, unlike the
 *      nightly-published suite manifest.
 *   3. AUDITED EXCUSAL: a fully-inherited lint red (identical offense set at
 *      base AND task diff touching neither the offending files nor the lint's
 *      script/harness) is excused smoke-gate-only, stays visibly listed, and
 *      is loudly flagged as needing ONE fix on main. Everything else — A/B
 *      errors, budget overruns, base-green lints, signature drift,
 *      diff-intersecting reds — falls open to "yours". Publish/nightly runs
 *      never consult this module (run-all's nightly lint phase is report-only
 *      and structurally separate), and predeploy runs lints bare via
 *      scripts/predeploy.sh, so deploys are untouched by design.
 *
 * Base-tree resolution mirrors scripts/verify-merge-integrity.ts:
 *   - HEAD is a merge  → base = HEAD^2 (the upstream side of the completion/
 *     sync merge); task diff = `git diff --name-only HEAD^2 HEAD` ∪ worktree.
 *   - HEAD not a merge → base = HEAD; task diff = worktree changes only
 *     (staged + unstaged + untracked). Task environments keep task work
 *     uncommitted until the platform's completion commit, so in a linear
 *     history HEAD IS the inherited upstream state. Known accepted
 *     limitation: a hypothetical mid-session self-commit would be treated as
 *     base — mitigated by convention (the only sanctioned mid-session commits
 *     are this module's own converged-green artifact regens) and by evidence
 *     lines always naming the base commit + subject so a human can spot the
 *     pathology in the gate summary.
 *
 * Kill switches / budgets (all read at call time, rows in audits/G-docs):
 *   - GATE_LINT_ATTRIBUTION_EXCUSE=0 — disable excusal (verdicts still print).
 *   - GATE_LINT_SELFHEAL=0          — disable freshness self-heal.
 *   - GATE_LINT_AB_BUDGET_MS        — overall A/B budget (default 300s).
 *
 * Everything decision-shaped is pure and injectable for the guard tests in
 * tests/gate-lint-attribution.test.ts; the real runners are thin wrappers.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Env knobs
// ---------------------------------------------------------------------------

/** Set to "0" to disable excusal of fully-inherited lint reds (kill switch). */
export const GATE_LINT_EXCUSE_KILL_SWITCH_ENV = "GATE_LINT_ATTRIBUTION_EXCUSE";
/** Set to "0" to disable gate-time freshness-lint self-heal (kill switch). */
export const GATE_LINT_SELFHEAL_KILL_SWITCH_ENV = "GATE_LINT_SELFHEAL";
/** Overall A/B wall budget in ms (worktree add + all base lint re-runs). */
export const GATE_LINT_AB_BUDGET_ENV = "GATE_LINT_AB_BUDGET_MS";

export const DEFAULT_AB_OVERALL_BUDGET_MS = 300_000;
/** Per-lint cap inside the overall budget (lint-async-correctness ~2.5min). */
export const DEFAULT_AB_PER_LINT_TIMEOUT_MS = 150_000;

/** Task-diff intersection with these always forces "yours" (harness files). */
export const GATE_HARNESS_PATHS: readonly string[] = [
  "scripts/gate.ts",
  "scripts/gateLintAttribution.ts",
  "scripts/gate-lint-worker.mjs",
  "scripts/gate-lint-ab-capture.mjs",
];

// ---------------------------------------------------------------------------
// Base-tree resolution
// ---------------------------------------------------------------------------

export interface BaseTreeInfo {
  baseCommit: string;
  baseSubject: string;
  resolution: "merge-second-parent" | "head";
  /** Repo-relative paths the task tree changed vs the base tree. */
  taskDiffFiles: string[];
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: res.status === 0 && res.error == null, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  }
}

/** Parse `git status --porcelain` into repo-relative paths (rename → both sides). */
export function parsePorcelainPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      out.push(rest.slice(0, arrow).trim(), rest.slice(arrow + 4).trim());
    } else {
      out.push(rest.trim());
    }
  }
  return out.filter(Boolean).map((p) => p.replace(/^"|"$/g, ""));
}

export function resolveBaseTree(repoRoot: string = ROOT): BaseTreeInfo | { error: string } {
  const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", "HEAD"]);
  if (!parents.ok) return { error: `git rev-list failed: ${parents.stderr.trim().slice(0, 300)}` };
  const shas = parents.stdout.trim().split(/\s+/).filter(Boolean);
  if (shas.length === 0) return { error: "could not parse HEAD parents" };
  const head = shas[0];
  const isMerge = shas.length >= 3;
  const baseCommit = isMerge ? shas[2] : head;

  const status = git(repoRoot, ["status", "--porcelain"]);
  if (!status.ok) return { error: `git status failed: ${status.stderr.trim().slice(0, 300)}` };
  const diffFiles = new Set<string>(parsePorcelainPaths(status.stdout));

  if (isMerge) {
    const diff = git(repoRoot, ["diff", "--name-only", baseCommit, head]);
    if (!diff.ok) return { error: `git diff --name-only failed: ${diff.stderr.trim().slice(0, 300)}` };
    for (const f of diff.stdout.split("\n")) {
      const t = f.trim();
      if (t) diffFiles.add(t);
    }
  }

  const subject = git(repoRoot, ["log", "-1", "--format=%s", baseCommit]);
  return {
    baseCommit,
    baseSubject: subject.ok ? subject.stdout.trim().slice(0, 120) : "?",
    resolution: isMerge ? "merge-second-parent" : "head",
    taskDiffFiles: Array.from(diffFiles).sort(),
  };
}

// ---------------------------------------------------------------------------
// Offense normalization + signatures
// ---------------------------------------------------------------------------

/**
 * Normalize lint output for byte-conservative comparison between the task-tree
 * run and the base-tree run: strip absolute path prefixes (main repo root and
 * the disposable worktree render the same repo-relative offense differently),
 * neutralize durations and timestamps, normalize line endings. Deliberately
 * UNDER-normalizes — a false mismatch falls open to "yours" (safe), a false
 * match could excuse a real offense (unsafe).
 */
export function normalizeOffenseOutput(text: string, stripPrefixes: readonly string[]): string {
  let out = String(text ?? "").replace(/\r\n?/g, "\n");
  for (const prefix of stripPrefixes) {
    if (!prefix) continue;
    out = out.split(prefix.endsWith("/") ? prefix : prefix + "/").join("");
    out = out.split(prefix).join("");
  }
  out = out
    .replace(/\b\d+(\.\d+)?\s*(ms|s)\b/g, "<t>")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "<ts>");
  return (
    out
      .split("\n")
      .map((l) => l.replace(/\s+$/g, ""))
      .join("\n")
      .replace(/\n+$/g, "") + "\n"
  );
}

export function offenseSignature(exitCode: number, normalizedOutput: string): string {
  const digest = createHash("sha256").update(normalizedOutput, "utf8").digest("hex").slice(0, 16);
  return `exit=${exitCode}:sha256=${digest}`;
}

// ---------------------------------------------------------------------------
// Base-tree A/B runner (disposable worktree)
// ---------------------------------------------------------------------------

export interface BaseLintRun {
  name: string;
  status: "ran" | "spawn-error" | "timeout" | "budget-exhausted";
  exitCode: number | null;
  output: string;
  detail?: string;
  durationMs: number;
}

export interface BaseTreeRunResult {
  runs: BaseLintRun[];
  /** Non-null when the worktree could not even be prepared — all yours. */
  worktreeError: string | null;
  worktreeDir: string | null;
  wallMs: number;
}

export function runBaseTreeLints(opts: {
  baseCommit: string;
  lints: ReadonlyArray<{ name: string; script: string }>;
  repoRoot?: string;
  perLintTimeoutMs?: number;
  overallBudgetMs?: number;
  log?: (line: string) => void;
}): BaseTreeRunResult {
  const repoRoot = opts.repoRoot ?? ROOT;
  const log = opts.log ?? (() => {});
  const perLintTimeout = opts.perLintTimeoutMs ?? DEFAULT_AB_PER_LINT_TIMEOUT_MS;
  const envBudget = Number(process.env[GATE_LINT_AB_BUDGET_ENV]);
  const overallBudget =
    opts.overallBudgetMs ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_AB_OVERALL_BUDGET_MS);
  const start = Date.now();
  const deadline = start + overallBudget;
  const dir = join(tmpdir(), `gate-lint-ab-${process.pid}-${Date.now()}`);
  const runs: BaseLintRun[] = [];

  const add = git(repoRoot, ["worktree", "add", "--detach", dir, opts.baseCommit]);
  if (!add.ok) {
    return {
      runs: [],
      worktreeError: `git worktree add failed: ${add.stderr.trim().slice(0, 400)}`,
      worktreeDir: null,
      wallMs: Date.now() - start,
    };
  }

  try {
    try {
      symlinkSync(resolve(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    } catch (err) {
      return {
        runs: [],
        worktreeError: `node_modules symlink failed: ${(err as Error).message}`,
        worktreeDir: dir,
        wallMs: Date.now() - start,
      };
    }

    for (const lint of opts.lints) {
      const remaining = deadline - Date.now();
      if (remaining <= 1_000) {
        runs.push({
          name: lint.name,
          status: "budget-exhausted",
          exitCode: null,
          output: "",
          detail: `overall A/B budget (${overallBudget}ms) exhausted before this lint ran`,
          durationMs: 0,
        });
        continue;
      }
      const lintStart = Date.now();
      log(`[lint-attribution] A/B re-running ${lint.name} at base tree …`);
      try {
        // Task #4604: capture the base run through the SAME channel contract
        // as the head-side gate worker (console patch → ordered lines), so
        // signatures are comparable. A raw subprocess's stdout/stderr
        // re-groups streams and picks up node/npm/tsx boot noise, which made
        // byte-identical inherited offenses hash differently ("offense
        // signature differs at base"). The capture CLI is loaded from the
        // MAIN checkout (ROOT, harness consistency — the base tree may
        // predate it); the lint script itself comes from the worktree, so
        // its import.meta-derived root scans the base tree.
        // Result file lives OUTSIDE the worktree: an untracked file inside it
        // could perturb repo-scanning lints (e.g. worktree hygiene) at base.
        const resultPath = join(tmpdir(), `gate-lint-ab-result-${process.pid}-${Date.now()}-${runs.length}.json`);
        const res = spawnSync(
          process.execPath,
          [resolve(ROOT, "scripts/gate-lint-ab-capture.mjs"), resolve(dir, lint.script), resultPath],
          {
            cwd: dir,
            encoding: "utf8",
            timeout: Math.min(perLintTimeout, remaining),
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GATE_LINT_AB: "1" },
          },
        );
        const timedOut = res.error != null && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
        if (timedOut) {
          runs.push({
            name: lint.name,
            status: "timeout",
            exitCode: null,
            output: "",
            detail: `base run exceeded ${Math.min(perLintTimeout, remaining)}ms`,
            durationMs: Date.now() - lintStart,
          });
        } else if (res.error != null || res.status !== 0) {
          runs.push({
            name: lint.name,
            status: "spawn-error",
            exitCode: null,
            output: "",
            detail: res.error
              ? String(res.error)
              : `capture CLI exited ${res.status ?? "null"} before posting a result (import-time process.exit or crash): ${(res.stderr ?? "").trim().slice(0, 400)}`,
            durationMs: Date.now() - lintStart,
          });
        } else {
          let parsed: { code: number; lines: Array<{ stream: string; text: string }> } | null = null;
          try {
            const raw = JSON.parse(readFileSync(resultPath, "utf8"));
            if (
              raw &&
              typeof raw.code === "number" &&
              Array.isArray(raw.lines) &&
              raw.lines.every((l: unknown) => l != null && typeof (l as { text?: unknown }).text === "string")
            ) {
              parsed = raw;
            }
          } catch {
            /* missing/corrupt result file → spawn-error below */
          }
          try {
            rmSync(resultPath, { force: true });
          } catch {
            /* best-effort cleanup */
          }
          if (!parsed) {
            runs.push({
              name: lint.name,
              status: "spawn-error",
              exitCode: null,
              output: "",
              detail: "capture CLI exited 0 but its result file is missing or malformed",
              durationMs: Date.now() - lintStart,
            });
          } else {
            runs.push({
              name: lint.name,
              status: "ran",
              exitCode: parsed.code,
              // Composed EXACTLY like the head side in scripts/gate.ts:
              // r.output.map((o) => o.text).join("\n").
              output: parsed.lines.map((l) => l.text).join("\n"),
              durationMs: Date.now() - lintStart,
            });
          }
        }
      } catch (err) {
        runs.push({
          name: lint.name,
          status: "spawn-error",
          exitCode: null,
          output: "",
          detail: (err as Error).message,
          durationMs: Date.now() - lintStart,
        });
      }
    }
  } finally {
    const rm = git(repoRoot, ["worktree", "remove", "--force", dir]);
    if (!rm.ok) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      git(repoRoot, ["worktree", "prune"]);
    }
  }

  return { runs, worktreeError: null, worktreeDir: dir, wallMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

export interface LintFailureForAttribution {
  name: string;
  script: string;
  exitCode: number;
  outputText: string;
}

export interface LintAttributionVerdict {
  name: string;
  script: string;
  verdict: "inherited" | "yours";
  /** Set by decideLintExcusals — only inherited verdicts are excusable. */
  excused: boolean;
  headSignature: string;
  baseSignature: string | null;
  evidence: string[];
}

export function classifyLintFailure(input: {
  failure: LintFailureForAttribution;
  baseRun: BaseLintRun | undefined;
  taskDiffFiles: readonly string[];
  harnessPaths?: readonly string[];
  normalize: (raw: string) => string;
}): LintAttributionVerdict {
  const { failure, baseRun, taskDiffFiles } = input;
  const harness = input.harnessPaths ?? GATE_HARNESS_PATHS;
  const headSignature = offenseSignature(failure.exitCode, input.normalize(failure.outputText));
  const yours = (evidence: string[]): LintAttributionVerdict => ({
    name: failure.name,
    script: failure.script,
    verdict: "yours",
    excused: false,
    headSignature,
    baseSignature: baseRun && baseRun.status === "ran" ? offenseSignature(baseRun.exitCode ?? -1, input.normalize(baseRun.output)) : null,
    evidence,
  });

  try {
    if (!baseRun) {
      return yours(["no A/B base run recorded (budget) — conservative fall-open to yours"]);
    }
    if (baseRun.status !== "ran") {
      return yours([
        `A/B base run ${baseRun.status}${baseRun.detail ? ` (${baseRun.detail})` : ""} — conservative fall-open to yours`,
      ]);
    }
    if (baseRun.exitCode === 0) {
      return yours(["lint is GREEN at the base tree — the offense is introduced by this task's tree"]);
    }
    const baseSignature = offenseSignature(baseRun.exitCode ?? -1, input.normalize(baseRun.output));
    if (baseSignature !== headSignature) {
      return yours([
        `offense signature differs at base (head ${headSignature} vs base ${baseSignature}) — the task tree changes the offense set`,
      ]);
    }
    // Identical offense set at base. Still conservative: any task-touched
    // file that is the lint's own script, gate harness, or named in the
    // offense output forces "yours".
    const diffSet = new Set(taskDiffFiles);
    const touchedGuarded = [failure.script, ...harness].filter((p) => diffSet.has(p));
    if (touchedGuarded.length > 0) {
      return yours([
        `identical offense at base BUT task diff touches ${touchedGuarded.join(", ")} — lint script/harness edits are never excused`,
      ]);
    }
    const mentioned = taskDiffFiles.filter((f) => f.length > 0 && failure.outputText.includes(f));
    if (mentioned.length > 0) {
      return yours([
        `identical offense at base BUT task-touched file(s) appear in the offense output: ${mentioned.slice(0, 3).join(", ")}${mentioned.length > 3 ? ` (+${mentioned.length - 3} more)` : ""}`,
      ]);
    }
    return {
      name: failure.name,
      script: failure.script,
      verdict: "inherited",
      excused: false,
      headSignature,
      baseSignature,
      evidence: [
        `identical offense signature at base tree (${headSignature})`,
        `task diff (${taskDiffFiles.length} file(s)) touches neither the offending files, the lint script, nor the gate harness`,
      ],
    };
  } catch (err) {
    return yours([`classification error (${(err as Error).message}) — conservative fall-open to yours`]);
  }
}

/** Marks inherited verdicts excused when armed. Returns counts. */
export function decideLintExcusals(
  verdicts: LintAttributionVerdict[],
  opts: { armed: boolean },
): { excusedCount: number; blockingCount: number } {
  let excused = 0;
  for (const v of verdicts) {
    if (v.verdict === "inherited" && opts.armed) {
      v.excused = true;
      excused += 1;
    }
  }
  return { excusedCount: excused, blockingCount: verdicts.length - excused };
}

// ---------------------------------------------------------------------------
// Freshness-lint self-heal (gate-time regen of registered artifacts)
// ---------------------------------------------------------------------------

/**
 * Gate lints whose red maps to a registered generated artifact. Kept in
 * lockstep with the post-merge regen registry (scripts/post-merge-route-
 * inventory-refresh.ts INVENTORY_PATHS and scripts/post-merge-generated-
 * artifact-refresh.ts ARTIFACTS) — pinned by tests/gate-lint-attribution.test.ts
 * rather than imported, so gate.ts's module graph stays lean. Array order is
 * execution order: the contract table is generated FROM the route inventory,
 * so the inventory must heal first.
 */
export interface GateSelfHealSpec {
  lintName: string;
  /** Exact repo-relative files or directory prefixes regen may touch. */
  artifactPaths: readonly string[];
  regenArgv: readonly [string, ...string[]];
  commitMessage: string;
}

export const GATE_SELF_HEAL_SPECS: readonly GateSelfHealSpec[] = [
  {
    lintName: "lint-route-inventory-freshness",
    artifactPaths: ["tests/route-inventory.json", "tests/route-inventory-report.md"],
    regenArgv: ["npx", "tsx", "scripts/regen-route-inventory.mjs"],
    commitMessage: "gate: auto-regenerate route inventory (completion-rebase drift, Task #4491)",
  },
  {
    lintName: "lint-contract-table-freshness",
    artifactPaths: ["audits/D-endpoint-contract-table.md", "audits/D-endpoint-contract-table.json"],
    regenArgv: ["node", "scripts/generate-endpoint-contract-table.mjs"],
    commitMessage: "gate: auto-regenerate endpoint contract table (completion-rebase drift, Task #4491)",
  },
  {
    lintName: "lint-website-bundle-freshness",
    artifactPaths: ["website/public"],
    regenArgv: ["npx", "tsx", "website/generate.ts"],
    commitMessage: "gate: auto-regenerate marketing website bundle (completion-rebase drift, Task #4491)",
  },
];

export function pathInSpec(path: string, spec: GateSelfHealSpec): boolean {
  return spec.artifactPaths.some((a) => path === a || path.startsWith(a.endsWith("/") ? a : a + "/"));
}

export type SelfHealOutcome =
  | "healed-committed"
  | "healed-nothing-to-commit"
  | "skipped-pre-dirty"
  | "regen-failed"
  | "out-of-spec-writes"
  | "not-converged"
  | "commit-failed";

export interface SelfHealStatusEntry {
  path: string;
  untracked: boolean;
}

export interface SelfHealDeps {
  /** Current dirty worktree entries (git status --porcelain parsed). */
  status(): SelfHealStatusEntry[];
  /** Run the registered generator; true = exit 0. */
  regen(): boolean;
  /** Re-run the failing lint through the gate worker; true = green. */
  relint(): boolean;
  /** Undo regen writes: checkout tracked paths, delete untracked ones. */
  revert(entries: SelfHealStatusEntry[]): void;
  /** Stage exactly the artifact paths and commit (--only --no-verify). */
  commit(): "committed" | "nothing-to-commit" | "failed";
  log(line: string): void;
}

/**
 * Decision core, unit-testable with injected deps. Never throws. Contract:
 *   - artifact paths dirty BEFORE regen → skip (might be task work in flight;
 *     the lint red then continues into normal A/B attribution);
 *   - regen writes outside the registered artifact paths → revert its writes,
 *     fail red (a generator that surprises us never auto-commits);
 *   - lint still red after regen → revert, fail red (non-converging);
 *   - converged green → commit the artifact-only diff.
 */
export function selfHealFreshnessLint(
  spec: GateSelfHealSpec,
  deps: SelfHealDeps,
): { outcome: SelfHealOutcome; detail: string } {
  try {
    const before = deps.status();
    const preDirty = before.filter((e) => pathInSpec(e.path, spec));
    if (preDirty.length > 0) {
      const detail = `artifact path(s) already dirty before regen (${preDirty
        .map((e) => e.path)
        .slice(0, 3)
        .join(", ")}${preDirty.length > 3 ? ` +${preDirty.length - 3}` : ""}) — possibly task work in flight; not self-healing`;
      deps.log(`[gate-self-heal] ${spec.lintName}: SKIP — ${detail}`);
      return { outcome: "skipped-pre-dirty", detail };
    }
    const beforePaths = new Set(before.map((e) => e.path));

    deps.log(
      `[gate-self-heal] ${spec.lintName}: stale generated artifact — running registered generator \`${spec.regenArgv.join(" ")}\` …`,
    );
    if (!deps.regen()) {
      const detail = "registered generator FAILED — fix the generator input and re-run it by hand";
      deps.log(`[gate-self-heal] ${spec.lintName}: ${detail}`);
      return { outcome: "regen-failed", detail };
    }

    const after = deps.status();
    const newly = after.filter((e) => !beforePaths.has(e.path));
    const outside = newly.filter((e) => !pathInSpec(e.path, spec));
    if (outside.length > 0) {
      deps.revert(newly);
      const detail = `regen wrote OUTSIDE the registered artifact paths (${outside
        .map((e) => e.path)
        .slice(0, 3)
        .join(", ")}${outside.length > 3 ? ` +${outside.length - 3}` : ""}) — reverted; not auto-committing`;
      deps.log(`[gate-self-heal] ${spec.lintName}: ${detail}`);
      return { outcome: "out-of-spec-writes", detail };
    }

    if (!deps.relint()) {
      deps.revert(newly);
      const detail = "lint STILL RED after regen (source problem regen cannot fix) — reverted regen writes";
      deps.log(`[gate-self-heal] ${spec.lintName}: ${detail}`);
      return { outcome: "not-converged", detail };
    }

    const commit = deps.commit();
    if (commit === "failed") {
      const detail =
        "regen converged green but the artifact-only commit FAILED — commit the artifact paths by hand";
      deps.log(`[gate-self-heal] ${spec.lintName}: ${detail}`);
      return { outcome: "commit-failed", detail };
    }
    if (commit === "nothing-to-commit") {
      const detail = "lint re-verified green; artifacts already matched HEAD (nothing to commit)";
      deps.log(`[gate-self-heal] ${spec.lintName}: healed — ${detail}`);
      return { outcome: "healed-nothing-to-commit", detail };
    }
    const detail = `regenerated + re-verified green + committed artifact-only (${spec.artifactPaths.join(", ")})`;
    deps.log(`[gate-self-heal] ${spec.lintName}: healed — ${detail}`);
    return { outcome: "healed-committed", detail };
  } catch (err) {
    const detail = `self-heal error (${(err as Error).message}) — leaving the lint red`;
    deps.log(`[gate-self-heal] ${spec.lintName}: ${detail}`);
    return { outcome: "regen-failed", detail };
  }
}

function realStatus(repoRoot: string): SelfHealStatusEntry[] {
  const res = git(repoRoot, ["status", "--porcelain"]);
  if (!res.ok) return [];
  const entries: SelfHealStatusEntry[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.length < 4) continue;
    const untracked = line.startsWith("??");
    for (const p of parsePorcelainPaths(line)) entries.push({ path: p, untracked });
  }
  return entries;
}

export function realSelfHealDeps(
  spec: GateSelfHealSpec,
  opts: { repoRoot?: string; relint: () => boolean; log?: (line: string) => void },
): SelfHealDeps {
  const repoRoot = opts.repoRoot ?? ROOT;
  const log = opts.log ?? ((line: string) => console.log(line));
  return {
    status: () => realStatus(repoRoot),
    regen: () => {
      try {
        const [cmd, ...args] = spec.regenArgv;
        const res = spawnSync(cmd, args, {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 300_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        if (res.status !== 0 || res.error != null) {
          log(
            `[gate-self-heal] ${spec.lintName} regen stderr: ${(res.stderr ?? String(res.error ?? "")).trim().slice(0, 1500)}`,
          );
          return false;
        }
        return true;
      } catch (err) {
        log(`[gate-self-heal] ${spec.lintName} regen threw: ${(err as Error).message}`);
        return false;
      }
    },
    relint: opts.relint,
    revert: (entries) => {
      const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
      const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
      if (tracked.length > 0) git(repoRoot, ["checkout", "--", ...tracked]);
      for (const p of untracked) {
        try {
          rmSync(resolve(repoRoot, p), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    commit: () => {
      const add = git(repoRoot, ["add", "--", ...spec.artifactPaths]);
      if (!add.ok) {
        log(`[gate-self-heal] ${spec.lintName} git add failed: ${add.stderr.trim().slice(0, 400)}`);
        return "failed";
      }
      const staged = git(repoRoot, ["diff", "--cached", "--quiet", "--", ...spec.artifactPaths]);
      if (staged.ok) return "nothing-to-commit";
      const commit = git(repoRoot, [
        "-c",
        "user.name=gate freshness self-heal",
        "-c",
        "user.email=gate@local",
        "commit",
        "--no-verify",
        "-m",
        spec.commitMessage,
        "--only",
        "--",
        ...spec.artifactPaths,
      ]);
      if (!commit.ok) {
        log(`[gate-self-heal] ${spec.lintName} git commit failed: ${commit.stderr.trim().slice(0, 400)}`);
        return "failed";
      }
      return "committed";
    },
    log,
  };
}

// ---------------------------------------------------------------------------
// Attribution report (lints section of .local/runs/attribution-report.json)
// ---------------------------------------------------------------------------

/** Report carrying window: run-all's suite writer carries a `lints` section
 * forward only when younger than this (stale sections mislead humans). */
export const ATTRIBUTION_REPORT_LINTS_FRESH_MS = 6 * 60 * 60 * 1000;

export interface LintAttributionReportSection {
  sectionVersion: 1;
  generatedAt: string;
  base: { commit: string; subject: string; resolution: string } | null;
  excusalArmed: boolean;
  selfHeal: Array<{ lint: string; outcome: SelfHealOutcome; detail: string }>;
  verdicts: Array<{
    name: string;
    script: string;
    verdict: "inherited" | "yours";
    excused: boolean;
    headSignature: string;
    baseSignature: string | null;
    evidence: string[];
  }>;
  excusedCount: number;
  blockingCount: number;
}

/**
 * Merge the lint section into the shared attribution report. The suite side
 * (tests/redManifest.ts attributeRunFailures) writes the rest of the file and
 * carries a fresh `lints` section forward; both writers stamp schemaVersion 4.
 * Best-effort: never throws (the gate verdict must not depend on report IO).
 */
export function writeLintSectionIntoAttributionReport(
  section: LintAttributionReportSection,
  reportPath: string = resolve(ROOT, ".local/runs/attribution-report.json"),
): boolean {
  try {
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      /* absent/corrupt → fresh object */
    }
    existing.schemaVersion = 4;
    existing.lints = section;
    mkdirSync(dirname(reportPath), { recursive: true });
    const tmp = `${reportPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
    renameSync(tmp, reportPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gate orchestrator
// ---------------------------------------------------------------------------

export interface GateLintRailsResult {
  /** Lints regenerated + re-verified green (their gate results flip to pass). */
  healedLints: string[];
  selfHeal: Array<{ lint: string; outcome: SelfHealOutcome; detail: string }>;
  verdicts: LintAttributionVerdict[];
  excusedLints: Set<string>;
  summaryLines: string[];
  wallMs: number;
}

/**
 * The full gate-side rail: self-heal freshness lints, then base-tree A/B
 * attribution + audited excusal for whatever still fails. Called by
 * scripts/gate.ts ONLY (the nightly publish run executes the lint phase
 * report-only inside tests/run-all.ts and never consults this function, so
 * publish runs structurally cannot excuse; scripts/predeploy.sh runs lints
 * bare and is equally untouched). Never throws.
 */
export async function runGateLintFailureRails(opts: {
  failures: LintFailureForAttribution[];
  /** Re-run one lint through the gate's worker pool; true = green. */
  relint: (check: { name: string; script: string }) => Promise<boolean>;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Promise<GateLintRailsResult> {
  const started = Date.now();
  const repoRoot = opts.repoRoot ?? ROOT;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const summaryLines: string[] = [];
  const healedLints: string[] = [];
  const selfHealOutcomes: Array<{ lint: string; outcome: SelfHealOutcome; detail: string }> = [];
  let remaining = [...opts.failures];

  try {
    // ---- 1. Freshness self-heal --------------------------------------------
    const selfHealArmed = env[GATE_LINT_SELFHEAL_KILL_SWITCH_ENV] !== "0";
    for (const spec of GATE_SELF_HEAL_SPECS) {
      const failure = remaining.find((f) => f.name === spec.lintName);
      if (!failure) continue;
      if (!selfHealArmed) {
        summaryLines.push(
          `[gate-self-heal] ${spec.lintName}: self-heal DISABLED (${GATE_LINT_SELFHEAL_KILL_SWITCH_ENV}=0) — red continues into attribution`,
        );
        continue;
      }
      const res = selfHealFreshnessLint(
        spec,
        realSelfHealDeps(spec, {
          repoRoot,
          relint: () => {
            // spawn the lint standalone (same contract predeploy uses); the
            // gate re-verifies through its own worker pool afterwards too.
            try {
              const r = spawnSync("npx", ["--yes", "tsx", failure.script], {
                cwd: repoRoot,
                encoding: "utf8",
                timeout: 180_000,
                maxBuffer: 16 * 1024 * 1024,
              });
              return r.status === 0 && r.error == null;
            } catch {
              return false;
            }
          },
          log,
        }),
      );
      selfHealOutcomes.push({ lint: spec.lintName, outcome: res.outcome, detail: res.detail });
      if (res.outcome === "healed-committed" || res.outcome === "healed-nothing-to-commit") {
        // Confirm through the gate's own worker contract before flipping.
        const green = await opts.relint({ name: failure.name, script: failure.script });
        if (green) {
          healedLints.push(spec.lintName);
          remaining = remaining.filter((f) => f.name !== spec.lintName);
          summaryLines.push(
            `[gate-self-heal] ${spec.lintName}: SELF-HEALED — ${res.detail}. Registered generator: \`${spec.regenArgv.join(" ")}\`.`,
          );
        } else {
          summaryLines.push(
            `[gate-self-heal] ${spec.lintName}: standalone re-verify green but gate worker re-run still red — leaving red (investigate).`,
          );
        }
      } else if (res.outcome !== "skipped-pre-dirty") {
        summaryLines.push(`[gate-self-heal] ${spec.lintName}: ${res.outcome} — ${res.detail}`);
      }
    }

    // ---- 2. Base-tree A/B attribution for whatever still fails -------------
    const verdicts: LintAttributionVerdict[] = [];
    if (remaining.length > 0) {
      const base = resolveBaseTree(repoRoot);
      if ("error" in base) {
        for (const f of remaining) {
          verdicts.push({
            name: f.name,
            script: f.script,
            verdict: "yours",
            excused: false,
            headSignature: offenseSignature(f.exitCode, normalizeOffenseOutput(f.outputText, [repoRoot])),
            baseSignature: null,
            evidence: [`base tree unresolvable (${base.error}) — conservative fall-open to yours`],
          });
        }
        summaryLines.push(`[lint-attribution] base tree unresolvable: ${base.error} — all lint reds remain yours`);
      } else {
        summaryLines.push(
          `[lint-attribution] base tree ${base.baseCommit.slice(0, 9)} ("${base.baseSubject}") — resolution: ${base.resolution}; task diff: ${base.taskDiffFiles.length} file(s)`,
        );
        const ab = runBaseTreeLints({
          baseCommit: base.baseCommit,
          lints: remaining.map((f) => ({ name: f.name, script: f.script })),
          repoRoot,
          log,
        });
        const stripPrefixes = [ab.worktreeDir ?? "", repoRoot].filter(Boolean);
        const normalize = (raw: string) => normalizeOffenseOutput(raw, stripPrefixes);
        const runByName = new Map(ab.runs.map((r) => [r.name, r]));
        for (const f of remaining) {
          if (ab.worktreeError) {
            verdicts.push({
              name: f.name,
              script: f.script,
              verdict: "yours",
              excused: false,
              headSignature: offenseSignature(f.exitCode, normalize(f.outputText)),
              baseSignature: null,
              evidence: [`A/B worktree unavailable (${ab.worktreeError}) — conservative fall-open to yours`],
            });
          } else {
            verdicts.push(
              classifyLintFailure({
                failure: f,
                baseRun: runByName.get(f.name),
                taskDiffFiles: base.taskDiffFiles,
                normalize,
              }),
            );
          }
        }
      }

      const excusalArmed = env[GATE_LINT_EXCUSE_KILL_SWITCH_ENV] !== "0";
      const counts = decideLintExcusals(verdicts, { armed: excusalArmed });
      for (const v of verdicts) {
        if (v.verdict === "inherited" && v.excused) {
          summaryLines.push(
            `[lint-attribution] ${v.name}: INHERITED — EXCUSED (smoke gate only; audited): ${v.evidence[0]}. ⚠ needs ONE fix on main, not N task-side fixes.`,
          );
        } else if (v.verdict === "inherited") {
          summaryLines.push(
            `[lint-attribution] ${v.name}: INHERITED but excusal disarmed (${GATE_LINT_EXCUSE_KILL_SWITCH_ENV}=0) — still blocking. ${v.evidence[0]}`,
          );
        } else {
          summaryLines.push(`[lint-attribution] ${v.name}: YOURS — ${v.evidence[0]}`);
        }
      }
      if (counts.excusedCount > 0) {
        summaryLines.push(
          `[lint-attribution] ${counts.excusedCount} fully-inherited lint red(s) excused with evidence — see .local/runs/attribution-report.json §lints. Publish/predeploy runs never excuse.`,
        );
      }

      writeLintSectionIntoAttributionReport({
        sectionVersion: 1,
        generatedAt: new Date().toISOString(),
        base:
          "error" in base
            ? null
            : { commit: base.baseCommit, subject: base.baseSubject, resolution: base.resolution },
        excusalArmed,
        selfHeal: selfHealOutcomes,
        verdicts: verdicts.map((v) => ({ ...v })),
        excusedCount: counts.excusedCount,
        blockingCount: counts.blockingCount,
      });

      return {
        healedLints,
        selfHeal: selfHealOutcomes,
        verdicts,
        excusedLints: new Set(verdicts.filter((v) => v.excused).map((v) => v.name)),
        summaryLines,
        wallMs: Date.now() - started,
      };
    }

    // Everything healed — still record the section for the machine trail.
    writeLintSectionIntoAttributionReport({
      sectionVersion: 1,
      generatedAt: new Date().toISOString(),
      base: null,
      excusalArmed: env[GATE_LINT_EXCUSE_KILL_SWITCH_ENV] !== "0",
      selfHeal: selfHealOutcomes,
      verdicts: [],
      excusedCount: 0,
      blockingCount: 0,
    });
    return {
      healedLints,
      selfHeal: selfHealOutcomes,
      verdicts: [],
      excusedLints: new Set(),
      summaryLines,
      wallMs: Date.now() - started,
    };
  } catch (err) {
    summaryLines.push(
      `[lint-attribution] rails crashed (${(err as Error).message}) — all remaining lint reds stay yours`,
    );
    return {
      healedLints,
      selfHeal: selfHealOutcomes,
      verdicts: remaining.map((f) => ({
        name: f.name,
        script: f.script,
        verdict: "yours" as const,
        excused: false,
        headSignature: "",
        baseSignature: null,
        evidence: ["attribution rails crashed — conservative fall-open to yours"],
      })),
      excusedLints: new Set(),
      summaryLines,
      wallMs: Date.now() - started,
    };
  }
}
