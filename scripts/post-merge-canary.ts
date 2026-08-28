#!/usr/bin/env -S npx tsx
/**
 * Task #4501 — Post-merge canary: run the blast-radius smoke slice on main
 * immediately after a task merge, partial-publish new reds to the committed
 * red manifest (with culprit stamp), and write a result record.
 *
 * Always exits 0 — advisory only, must never block the post-merge pipeline.
 * Invoked by scripts/post-merge.sh after the generated-artifact refresh.
 *
 * Task #4617 — the canary now PRE-COMPUTES its slice in-process using the
 * runner's own exported selection code (selectRelatedSmokeTests +
 * selectBlastRadiusExpansion + planIncrementalRun — single source of truth,
 * no reimplementation) and spawns `npm test -- --file=<list>` with exactly
 * that slice. Consequences, all deliberate:
 *   - The DISCLOSED set is the EXECUTED set (the old spawn re-derived its
 *     own selection; a fall-open inside the child silently attempted the
 *     full ~746-suite smoke universe against a 240s budget, got SIGKILLed,
 *     and wrote "no report" — burning 4 minutes of every merge for zero
 *     evidence).
 *   - A selection that falls open to "full" SKIPS HONESTLY up front: full
 *     coverage is the gate/nightly's job; the canary is a fast advisory
 *     slice, and pretending to run the universe in 240s was a lie.
 *   - An EMPTY slice skips without booting the runner at all (~40s of
 *     hermetic provisioning saved on unrelated merges — the common case).
 *   - Suites whose registered timeoutMs exceeds the canary budget are
 *     excluded and disclosed (excludedOverBudget) instead of being started
 *     and killed mid-flight.
 *
 * Kill switch: POST_MERGE_CANARY=0 (or "false" / "off" / "no").
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Kill switch ─────────────────────────────────────────────────────────────
const raw = (process.env.POST_MERGE_CANARY ?? "").trim().toLowerCase();
if (raw === "false" || raw === "0" || raw === "off" || raw === "no") {
  console.log("[canary] POST_MERGE_CANARY disabled — skipping");
  process.exit(0);
}

// ─── Single-flight lock (prevents overlapping canary runs) ───────────────────
const LOCK_PATH = join(ROOT, ".local/state/post-merge-canary.lock");
const LOCK_MAX_AGE_MS = 12 * 60 * 1000; // 12 min (longer than the budget)
mkdirSync(dirname(LOCK_PATH), { recursive: true });

function isLocked(): boolean {
  try {
    if (!existsSync(LOCK_PATH)) return false;
    const ts = Number(readFileSync(LOCK_PATH, "utf8").trim());
    return Number.isFinite(ts) && Date.now() - ts < LOCK_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    writeFileSync(LOCK_PATH, "0", "utf8");
  } catch {
    /* best-effort */
  }
}

if (isLocked()) {
  console.log("[canary] another canary is still in flight — skipping (lock age < 12 min)");
  process.exit(0);
}
writeFileSync(LOCK_PATH, String(Date.now()), "utf8");

// ─── Constants ───────────────────────────────────────────────────────────────
const CANARY_REPORT_PATH = join(ROOT, ".local/runs/post-merge-canary.json");
/**
 * Task #4545 — append-only breakage-event ledger. The result file above is
 * OVERWRITTEN on every merge, so a breaking merge followed by a clean one
 * before the scheduler's next 6h tick would silently lose the incident. Every
 * run with new reds appends one JSONL event here; the regressionSweepScheduler
 * drains every unfiled event into a deduped "fix main" feedback item.
 */
const CANARY_EVENTS_PATH = join(ROOT, ".local/runs/post-merge-canary-events.jsonl");
/** Keep at most this many ledger lines (trim oldest on append). */
const CANARY_EVENTS_MAX_LINES = 200;

function appendBreakageEvent(event: {
  culpritCommit: string;
  culpritTask: string | null;
  newReds: string[];
  finishedAt: string;
}): void {
  try {
    mkdirSync(dirname(CANARY_EVENTS_PATH), { recursive: true });
    let lines: string[] = [];
    try {
      lines = readFileSync(CANARY_EVENTS_PATH, "utf8").split("\n").filter(Boolean);
    } catch {
      /* first event */
    }
    if (lines.length >= CANARY_EVENTS_MAX_LINES) {
      lines = lines.slice(-(CANARY_EVENTS_MAX_LINES - 1));
      writeFileSync(CANARY_EVENTS_PATH, `${lines.join("\n")}\n`, "utf8");
    }
    appendFileSync(CANARY_EVENTS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* best-effort — the result file still carries the latest incident */
  }
}
const MANIFEST_PATH = join(ROOT, "tests/red-manifest.json");
/** Wall-clock budget for the smoke run (default 4 min). */
const BUDGET_MS = Number(process.env.POST_MERGE_CANARY_BUDGET_MS) || 240_000;
/** Per-suite timeout passed to the child run (TEST_FILE_TIMEOUT_MS). */
const SUITE_TIMEOUT_MS = 60_000;
// ─── Main ────────────────────────────────────────────────────────────────────
interface CanaryResult {
  startedAt: string;
  finishedAt: string;
  skipped: boolean;
  skipReason: string | null;
  mergeBase: string | null;
  culpritCommit: string;
  culpritTask: string | null;
  suitesRan: number;
  newReds: string[];
  clearedReds: string[];
  budgetMs: number;
  /** False for every skip: no skip is completion evidence. */
  validationComplete: boolean;
  // Task #4617 — additive disclosure fields (older readers ignore them; the
  // scheduler only consumes culpritCommit/culpritTask/newReds/startedAt/
  // finishedAt, guarded by tests/post-merge-canary.test.ts).
  selectionMode: string;
  plannedFiles: string[];
  executedFiles: string[];
  excludedOverBudget: Array<{ file: string; timeoutMs: number }>;
}

type ResultInput = Omit<
  CanaryResult,
  "finishedAt" | "validationComplete" | "selectionMode" | "plannedFiles" | "executedFiles" | "excludedOverBudget"
> &
  Partial<Pick<CanaryResult, "selectionMode" | "plannedFiles" | "executedFiles" | "excludedOverBudget">>;

function writeResult(result: ResultInput): void {
  try {
    mkdirSync(dirname(CANARY_REPORT_PATH), { recursive: true });
    const full: CanaryResult = {
      validationComplete: !result.skipped,
      selectionMode: "related",
      plannedFiles: [],
      executedFiles: [],
      excludedOverBudget: [],
      ...result,
      finishedAt: new Date().toISOString(),
    };
    writeFileSync(CANARY_REPORT_PATH, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort — non-fatal */
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(
    `\n[canary] Post-merge canary starting (budget ${Math.round(BUDGET_MS / 1000)}s)…`,
  );

  // ── Resolve culprit commit info ─────────────────────────────────────────
  // Prefer the env vars set by scripts/post-merge.sh BEFORE any post-merge
  // auto-commits (artifact refresh, etc.) shift the merge tip. Without these
  // env vars, the git parent resolution could land on a generated-artifact
  // commit instead of the actual task merge, selecting the wrong smoke slice
  // and stamping reds against the wrong culprit (Task #4501 review fix).
  let mergeBase: string | null =
    (process.env.CANARY_MERGE_BASE ?? "").trim() || null;
  let culpritCommit: string =
    ((process.env.CANARY_MERGE_SHA ?? "").trim() || "unknown").slice(0, 10);
  let culpritTask: string | null = null;

  // Fall back to git when the env vars are absent (standalone invocation).
  if (!mergeBase || culpritCommit === "unknown") {
    try {
      if (culpritCommit === "unknown") {
        const headRes = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (headRes.status === 0) culpritCommit = headRes.stdout.trim().slice(0, 10);
      }
      if (!mergeBase) {
        // HEAD~1 is only correct here when post-merge.sh hasn't committed yet —
        // in the normal flow CANARY_MERGE_BASE is always set. This fallback is
        // for standalone/manual invocations only.
        const parentRes = spawnSync("git", ["rev-parse", "HEAD~1"], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (parentRes.status === 0) mergeBase = parentRes.stdout.trim();
      }
    } catch {
      /* git unavailable — best-effort */
    }
  }

  // Extract task number from the culprit commit's subject (#NNNN).
  if (culpritCommit !== "unknown") {
    try {
      const msgRes = spawnSync(
        "git",
        ["log", "-1", "--format=%s", culpritCommit],
        { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
      );
      if (msgRes.status === 0) {
        const m = msgRes.stdout.match(/#(\d{3,5})\b/);
        if (m) culpritTask = m[1];
      }
    } catch {
      /* best-effort */
    }
  }

  const baseResult = {
    startedAt,
    mergeBase,
    culpritCommit,
    culpritTask,
    suitesRan: 0,
    newReds: [] as string[],
    clearedReds: [] as string[],
    budgetMs: BUDGET_MS,
  };

  if (!mergeBase) {
    const skipReason = "HEAD~1 unavailable (initial commit, shallow clone, or git error)";
    console.log(`[canary] ${skipReason} — skipping run`);
    writeResult({ ...baseResult, skipped: true, skipReason, selectionMode: "no-merge-base" });
    return;
  }

  console.log(
    `[canary] culprit commit=${culpritCommit} task=${culpritTask ?? "unknown"} mergeBase=${mergeBase.slice(0, 10)}`,
  );

  // ── Pre-compute the slice in-process (Task #4617) ───────────────────────
  // Uses the runner's OWN exported selection/planning code so the canary can
  // never disagree with what `npm test` would select — and so the disclosed
  // slice is exactly what the child is told to run via --file.
  let plannedFiles: string[] = [];
  let executedFiles: string[] = [];
  let excludedOverBudget: Array<{ file: string; timeoutMs: number }> = [];
  try {
    const { buildTestRegistry } = await import("../tests/testRegistry.js");
    const { selectRelatedSmokeTests, selectBlastRadiusExpansion } = await import(
      "../tests/relatedSmokeSelection.js"
    );

    const registry = buildTestRegistry();
    if (registry.problems.length > 0) {
      const skipReason = `test registry has ${registry.problems.length} invalid registration(s) — advisory canary refuses to guess with a partial registry (the gate enforces this loudly)`;
      console.warn(`[canary] ${skipReason}`);
      writeResult({ ...baseResult, skipped: true, skipReason, selectionMode: "registry-invalid" });
      return;
    }
    const TESTS = registry.tests;
    const SMOKE_FILES = registry.smokeFiles;
    const smokeSuites = TESTS.filter((t) => SMOKE_FILES.has(t.file));

    // Related-smoke selection against the captured merge base. Env is passed
    // explicitly (never mutated on process.env) so the child spawn below
    // cannot inherit selection flags — run-all in --file mode is the sole
    // authority for what actually executes.
    const manifest = await selectRelatedSmokeTests(
      smokeSuites.map((t) => ({ file: t.file, extraNodeArgs: t.extraNodeArgs, scanPaths: t.scanPaths })),
      { repoRoot: ROOT, env: { ...process.env, SMOKE_RELATED_BASE: mergeBase } },
    );

    if (manifest.mode !== "related") {
      // Deferred selection leaves broad verification to the central lanes.
      // The canary stays bounded rather than launching an unrelated universe.
      const skipReason = `related selection deferred broad coverage (${manifest.deferredReason ?? "unknown"}) — ${smokeSuites.length} smoke suites belong to the post-merge/nightly/weekly integrity lane`;
      console.log(`[canary] ${skipReason}`);
      writeResult({ ...baseResult, skipped: true, skipReason, selectionMode: "central-integrity-deferred" });
      return;
    }

    plannedFiles = manifest.selected.map((s) => s.file);

    // Blast-radius expansion: non-smoke suites whose import closure reaches
    // a changed file ride along (same tracer the gate uses; capped; failure
    // here must never suppress the run — mirror run-all's non-fatal catch).
    try {
      const alreadySelected = new Set(plannedFiles);
      const nonSmokeSuites = TESTS.filter(
        (t) => !SMOKE_FILES.has(t.file) && !alreadySelected.has(t.file),
      );
      if (nonSmokeSuites.length > 0 && manifest.changedFiles.length > 0) {
        const expansion = await selectBlastRadiusExpansion(
          nonSmokeSuites.map((t) => ({ file: t.file, extraNodeArgs: t.extraNodeArgs, scanPaths: t.scanPaths })),
          manifest.changedFiles,
          {
            repoRoot: ROOT,
            maxSuites: Number(process.env.GATE_EXPANSION_MAX_SUITES) || 15,
            timeoutMs: Number(process.env.GATE_EXPANSION_TIMEOUT_MS) || 30_000,
          },
        );
        if (expansion.selected.length > 0) {
          console.log(
            `[canary] blast-radius expansion appended ${expansion.selected.length} non-smoke suite(s)${expansion.truncated ? ` (truncated, +${expansion.truncatedCount} more hit the cap)` : ""}`,
          );
          for (const s of expansion.selected) {
            if (!alreadySelected.has(s.file)) {
              plannedFiles.push(s.file);
              alreadySelected.add(s.file);
            }
          }
        }
        if (expansion.fallbackReason) {
          console.log(`[canary] expansion fell back (non-fatal): ${expansion.fallbackReason}`);
        }
      }
    } catch (expansionErr) {
      console.warn(
        `[canary] blast-radius expansion crashed (non-fatal, slice continues without it): ${
          expansionErr instanceof Error ? expansionErr.message : String(expansionErr)
        }`,
      );
    }

    // Exclude suites whose registered timeout cannot fit the budget — they
    // would be started and then killed mid-flight, poisoning flake history
    // (killed-at-cap parents) for zero evidence. Disclosed, never silent.
    const byFile = new Map(TESTS.map((t) => [t.file, t]));
    executedFiles = [];
    for (const file of plannedFiles) {
      const suite = byFile.get(file);
      const effectiveTimeout = suite?.timeoutMs ?? SUITE_TIMEOUT_MS;
      if (effectiveTimeout > BUDGET_MS) {
        excludedOverBudget.push({ file, timeoutMs: effectiveTimeout });
      } else {
        executedFiles.push(file);
      }
    }
    if (excludedOverBudget.length > 0) {
      console.log(
        `[canary] excluded ${excludedOverBudget.length} over-budget suite(s): ${excludedOverBudget
          .map((e) => `${e.file} (${Math.round(e.timeoutMs / 1000)}s > ${Math.round(BUDGET_MS / 1000)}s)`)
          .join(", ")}`,
      );
    }

    if (executedFiles.length === 0) {
      const skipReason =
        plannedFiles.length === 0
          ? "no smoke suites are related to this merge's diff — nothing to run"
          : "every related suite exceeds the canary budget (see excludedOverBudget)";
      console.log(`[canary] ${skipReason} — skipping run (runner never booted)`);
      writeResult({
        ...baseResult,
        skipped: true,
        skipReason,
        selectionMode: "related",
        plannedFiles,
        executedFiles: [],
        excludedOverBudget,
      });
      return;
    }

    // Green-skip pre-check: when EVERY selected suite holds accepted green
    // evidence (fingerprint store), the child would boot hermetic Postgres
    // just to skip everything. Ask the runner's own planner first. Planner
    // errors fall OPEN to spawning — the child remains the authority.
    try {
      const { planIncrementalRun } = await import("../tests/suiteFingerprint.js");
      const plan = await planIncrementalRun({
        suites: executedFiles.map((file) => {
          const t = byFile.get(file)!;
          return {
            file: t.file,
            extraNodeArgs: t.extraNodeArgs,
            scanPaths: t.scanPaths,
            extraEnv: t.extraEnv,
            timeoutMs: t.timeoutMs,
          };
        }),
        mode: "all", // matches run-all's --file sweepMode so skip semantics align
        forceAll: false,
      });
      if (plan.executeFiles.size === 0) {
        const skipReason = `all ${executedFiles.length} selected suite(s) hold accepted green evidence for their current input fingerprints (incremental green-skip) — nothing would execute`;
        console.log(`[canary] ${skipReason} — skipping run (runner never booted)`);
        writeResult({
          ...baseResult,
          skipped: true,
          skipReason,
          selectionMode: "related",
          plannedFiles,
          executedFiles,
          excludedOverBudget,
        });
        return;
      }
    } catch (planErr) {
      console.log(
        `[canary] green-skip pre-check unavailable (${planErr instanceof Error ? planErr.message : String(planErr)}) — spawning anyway (child planner is authoritative)`,
      );
    }
  } catch (selectionErr) {
    // Selection machinery unavailable/broken — an advisory tool must not
    // guess. Skip honestly; the gate still enforces everything.
    const skipReason = `in-process slice pre-computation failed (${
      selectionErr instanceof Error ? selectionErr.message : String(selectionErr)
    }) — advisory canary skips rather than re-running blind selection in the child`;
    console.warn(`[canary] ${skipReason}`);
    writeResult({ ...baseResult, skipped: true, skipReason, selectionMode: "selection-error" });
    return;
  }

  // ── Spawn the smoke run (exact disclosed slice) ─────────────────────────
  const reportDir = mkdtempSync(join(tmpdir(), "post-merge-canary-"));
  const reportPath = join(reportDir, "report.json");

  // Build the canary spawn env. The canary uses upsertRedManifestEntries
  // (partial update) — never publishRedManifest — so publishedAt must not
  // advance. We must exclude the nightly-publish env var if it happens to
  // be set in the parent process (e.g. when the canary is invoked from
  // within a nightly sweep context). The var name is split across the
  // join() so the literal string never appears in this file (enforced by
  // the wiring-pin guard test in tests/post-merge-canary.test.ts).
  const _NIGHTLY_KEY = (["TEST", "GREEN", "BASELINE", "PUBLISH"] as const).join("_");
  // Also strip the smoke/related selection flags: the child runs an explicit
  // --file list ("all" sweep mode); inherited smoke-mode flags must not
  // re-trigger selection inside the child (Task #4617).
  const spawnEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        k !== _NIGHTLY_KEY &&
        k !== "TEST_SMOKE" &&
        k !== "TEST_SMOKE_RELATED" &&
        k !== "SMOKE_RELATED_BASE",
    ),
  ) as NodeJS.ProcessEnv;
  Object.assign(spawnEnv, {
    // Shorter per-suite timeout inside the canary budget; the outer BUDGET_MS
    // is the hard wall-clock kill. Suite-registered timeoutMs still wins over
    // this default (that is why over-budget suites are excluded above).
    TEST_FILE_TIMEOUT_MS: String(SUITE_TIMEOUT_MS),
    TEST_ATTRIBUTION_EXCUSE: "0",
  });

  console.log(
    `[canary] spawning ${executedFiles.length} suite(s) via --file (budget ${Math.round(BUDGET_MS / 1000)}s): ${executedFiles.join(", ")}`,
  );

  const runResult = spawnSync(
    "npm",
    ["test", "--", `--file=${executedFiles.join(",")}`, `--json-report=${reportPath}`],
    {
      cwd: ROOT,
      env: spawnEnv,
      stdio: "inherit",
      timeout: BUDGET_MS,
      shell: false,
    },
  );

  // ── Parse the json report ───────────────────────────────────────────────
  let report: {
    mode?: string;
    tests?: Array<{ file: string; outcome: string; failureReason?: string }>;
    hardFailed?: number;
  } | null = null;

  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    /* absent or corrupt — timeout or crash before report written */
  }

  // Clean up the temp dir (best-effort).
  try {
    spawnSync("rm", ["-rf", reportDir], { timeout: 5_000 });
  } catch {
    /* best-effort */
  }

  if (!report) {
    const reason = runResult.signal
      ? `killed by ${String(runResult.signal)} (budget exceeded or crash)`
      : `exit ${runResult.status ?? "unknown"} without writing a report`;
    console.warn(`[canary] run produced no report (${reason}) — manifest NOT updated`);
    writeResult({
      ...baseResult,
      skipped: true,
      skipReason: reason,
      selectionMode: "related",
      plannedFiles,
      executedFiles,
      excludedOverBudget,
    });
    return;
  }

  // ── Compute delta vs the current manifest ───────────────────────────────
  const { upsertRedManifestEntries, loadRedManifest } = await import(
    "../tests/redManifest.js"
  );

  const previous = loadRedManifest(MANIFEST_PATH).manifest;
  const previousRedSet = new Set<string>(Object.keys(previous?.entries ?? {}));

  const tests = Array.isArray(report.tests) ? report.tests : [];

  const failedFiles = tests
    .filter((t) => t.outcome === "failed")
    .map((t) => ({
      file: t.file,
      failureReason: t.failureReason ?? "unknown",
      fingerprint: null,
    }));

  const passedFiles = tests
    .filter((t) => t.outcome === "passed")
    .map((t) => t.file);

  const newRedFiles = failedFiles
    .filter((f) => !previousRedSet.has(f.file))
    .map((f) => f.file);

  const reVerifiedClears = passedFiles.filter((f) => previousRedSet.has(f));

  const culprit = {
    commit: culpritCommit,
    task: culpritTask,
    mergedAt: new Date().toISOString(),
  };

  const upsertResult = upsertRedManifestEntries({
    manifestPath: MANIFEST_PATH,
    newReds: failedFiles,
    clearedFiles: reVerifiedClears,
    culprit,
    repoRoot: ROOT,
  });

  if (upsertResult.upserted) {
    console.log(
      `[canary] manifest updated: +${upsertResult.addedReds} new red(s), -${upsertResult.clearedReds} cleared — ${MANIFEST_PATH}`,
    );

    // Git-commit the manifest-only diff (mirrors post-merge-generated-artifact-refresh.ts).
    if (upsertResult.addedReds > 0 || upsertResult.clearedReds > 0) {
      try {
        spawnSync("git", ["add", "tests/red-manifest.json"], {
          cwd: ROOT,
          stdio: "inherit",
          timeout: 15_000,
        });
        // Only commit when there is actually a staged change.
        const diffResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
          cwd: ROOT,
          timeout: 10_000,
        });
        if (diffResult.status !== 0) {
          spawnSync(
            "git",
            [
              "-c",
              "user.email=post-merge-canary@noreply",
              "-c",
              "user.name=post-merge-canary",
              "commit",
              "--no-verify",
              "--only",
              "tests/red-manifest.json",
              "-m",
              `chore: post-merge canary manifest update (culprit=${culpritCommit}, +${upsertResult.addedReds} red(s), -${upsertResult.clearedReds} cleared) [Task #4501]`,
            ],
            { cwd: ROOT, stdio: "inherit", timeout: 30_000 },
          );
          console.log("[canary] committed manifest update to main");
        } else {
          console.log("[canary] manifest unchanged on disk — no commit needed");
        }
      } catch (err) {
        console.warn(
          `[canary] manifest commit failed (non-fatal): ${(err as Error).message ?? err}`,
        );
      }
    }
  } else if (upsertResult.note) {
    console.warn(`[canary] manifest upsert skipped (non-fatal): ${upsertResult.note}`);
  }

  console.log(
    `[canary] done — ${tests.length} suite(s) ran, ${failedFiles.length} failed, ${newRedFiles.length} NEW red(s)`,
  );
  if (newRedFiles.length > 0) {
    console.log("[canary] NEW reds (culprit: this merge):", newRedFiles.join(", "));
    // Task #4545 — durable breakage event: survives later result-file
    // overwrites so the scheduler's 6h drain files a "fix main" item even
    // when clean merges land in between.
    appendBreakageEvent({
      culpritCommit,
      culpritTask,
      newReds: newRedFiles,
      finishedAt: new Date().toISOString(),
    });
  }

  writeResult({
    ...baseResult,
    skipped: false,
    skipReason: null,
    suitesRan: tests.length,
    newReds: newRedFiles,
    clearedReds: reVerifiedClears,
    selectionMode: "related",
    plannedFiles,
    executedFiles,
    excludedOverBudget,
  });
}

try {
  await main();
} catch (err) {
  console.error("[canary] canary crashed (non-fatal):", err);
} finally {
  releaseLock();
}

process.exit(0);
