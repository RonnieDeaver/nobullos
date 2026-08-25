/**
 * regen-gate-duration-budget.ts — Task #4531: the SOLE writer of the
 * committed duration-budget artifact (tests/gate-duration-budget.json).
 *
 * Reads the runner's per-suite duration report (.local/runs/suite-durations.json)
 * and derives the whole-gate wall budget with the owner-approved formula:
 *
 *     fullSmokeWallBudgetMs = ceil(1.30 × measured zero-skip wall),
 *     clamped to PINNED_MAXIMA.fullSmokeWallBudgetMs (40 min hard pin).
 *
 * The source run MUST be a full-smoke zero-skip measurement (mode=smoke,
 * relatedSelection=false, skippedGreen=0) — budgets derived from narrowed or
 * green-skipped runs would be fictions. Produce one with a cleared local
 * green store (or TEST_FORCE_ALL=1) via `npm run gate --full-smoke`, then
 * run this script and commit the artifact. Validation (tests/durationBudget.ts,
 * enforced by tests/gate-duration-budget.test.ts and tests/run-all.ts)
 * refuses hand-edits via the self-hash and refuses budgets above the pins.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUDGET_ARTIFACT_PATH,
  PINNED_MAXIMA,
  REGEN_COMMAND,
  computeArtifactSelfHash,
  validateDurationBudgetArtifact,
  type DurationBudgetArtifact,
} from "../tests/durationBudget";

const DURATIONS_PATH = ".local/runs/suite-durations.json";

interface DurationsReport {
  generatedAt: string;
  mode: string;
  relatedSelection: boolean;
  skippedGreen: number;
  /**
   * Task #5030 — suites deferred to the post-merge/nightly lane (rotation-day
   * full-lane deferral). Absent on reports written before the field existed.
   */
  deferredNotVerified?: number;
  suiteCount: number;
  wallMs: number;
  suites: Array<{ file: string; elapsedMs: number; outcome: string; attempts: number }>;
}

export function buildArtifactFromDurations(
  rawDurations: string,
  nowIso: string,
): { artifact: DurationBudgetArtifact; notes: string[] } {
  const report = JSON.parse(rawDurations) as DurationsReport;
  const notes: string[] = [];

  if (report.mode !== "smoke") {
    throw new Error(
      `source run mode is "${report.mode}" — the budget must come from a SMOKE run (the gate's own mode), not a sweep`,
    );
  }
  if (report.relatedSelection !== false) {
    throw new Error(
      "source run used related-selection narrowing — a narrowed wall is not a full-smoke measurement",
    );
  }
  if (report.skippedGreen !== 0) {
    throw new Error(
      `source run green-skipped ${report.skippedGreen} suite(s) — the budget must bound the WORST honest case (zero skips). ` +
        `Clear .local/state/test-green-store.json (or run with TEST_FORCE_ALL=1) and re-measure.`,
    );
  }
  if ((report.deferredNotVerified ?? 0) > 0) {
    throw new Error(
      `REFUSED — source run deferred ${report.deferredNotVerified} suite(s) to the post-merge/nightly lane (Task #5030): ` +
        `a deferral-narrowed run is not a zero-skip measurement. Re-measure with --full-smoke (or TEST_FULL_DEFERRAL=0) ` +
        `so every suite executes.`,
    );
  }
  if (!Number.isInteger(report.wallMs) || report.wallMs <= 0) {
    throw new Error(`source run wallMs ${String(report.wallMs)} is not a positive integer`);
  }

  const failedSuites = report.suites.filter((s) => s.outcome !== "passed").length;
  if (failedSuites > 0) {
    notes.push(
      `source run had ${failedSuites} failed suite(s) (recorded in sourceRun.failedSuites for honesty — ` +
        `their runtime is still in the wall; re-regen from a green run when available)`,
    );
  }

  const rawBudget = Math.ceil(report.wallMs * 1.3);
  const clamped = Math.min(rawBudget, PINNED_MAXIMA.fullSmokeWallBudgetMs);
  if (clamped < rawBudget) {
    notes.push(
      `formula budget ${(rawBudget / 60_000).toFixed(1)}min exceeds the 40min owner pin — CLAMPED to the pin ` +
        `(recorded as clampedFromMs). The gate must shrink to fit the pin, not the other way around.`,
    );
  }

  const artifact: DurationBudgetArtifact = {
    schemaVersion: 1,
    generatedAt: nowIso,
    sourceRun: {
      generatedAt: report.generatedAt,
      mode: report.mode,
      relatedSelection: report.relatedSelection,
      skippedGreen: report.skippedGreen,
      suiteCount: report.suiteCount,
      failedSuites,
      wallMs: report.wallMs,
    },
    fullSmokeWallBudgetMs: clamped,
    ...(clamped < rawBudget ? { clampedFromMs: rawBudget } : {}),
    perSuiteDefaultCeilingMs: PINNED_MAXIMA.perSuiteDefaultCeilingMs,
    gateLintWallBudgetMs: PINNED_MAXIMA.gateLintWallBudgetMs,
    formula:
      "fullSmokeWallBudgetMs = min(ceil(1.30 × sourceRun.wallMs), 40min pin); per-suite/lint-phase budgets are the PINNED_MAXIMA policy values (tests/durationBudget.ts)",
    updatePath:
      `Owner-approved regen only (Task #4531 L3): produce a fresh zero-skip full-smoke measurement ` +
      `(clear .local/state/test-green-store.json or TEST_FORCE_ALL=1, npm run gate --full-smoke), then \`${REGEN_COMMAND}\` and commit. ` +
      `Hand-edits fail the self-hash; budgets above PINNED_MAXIMA are refused.`,
    selfHash: "",
  };
  artifact.selfHash = computeArtifactSelfHash(artifact as unknown as Record<string, unknown>);
  return { artifact, notes };
}

export function cliMain(argv: string[] = []): number {
  void argv;
  let rawDurations: string;
  try {
    rawDurations = readFileSync(resolve(process.cwd(), DURATIONS_PATH), "utf8");
  } catch (err) {
    console.error(
      `regen-gate-duration-budget: cannot read ${DURATIONS_PATH} (${(err as Error).message}) — ` +
        `run npm run gate --full-smoke first to produce a measurement.`,
    );
    return 1;
  }
  let built: { artifact: DurationBudgetArtifact; notes: string[] };
  try {
    built = buildArtifactFromDurations(rawDurations, new Date().toISOString());
  } catch (err) {
    console.error(`regen-gate-duration-budget: REFUSED — ${(err as Error).message}`);
    return 1;
  }
  const serialized = `${JSON.stringify(built.artifact, null, 2)}\n`;
  // Belt-and-braces: never write an artifact our own validator would refuse.
  const check = validateDurationBudgetArtifact(serialized);
  if (!check.ok) {
    console.error(`regen-gate-duration-budget: internal error — produced artifact fails validation: ${check.error}`);
    return 1;
  }
  writeFileSync(resolve(process.cwd(), BUDGET_ARTIFACT_PATH), serialized);
  for (const n of built.notes) console.warn(`  note: ${n}`);
  console.log(
    `regen-gate-duration-budget: wrote ${BUDGET_ARTIFACT_PATH}\n` +
      `  source run: ${built.artifact.sourceRun.generatedAt} — ${built.artifact.sourceRun.suiteCount} suite(s), ` +
      `wall ${(built.artifact.sourceRun.wallMs / 60_000).toFixed(1)}min, ${built.artifact.sourceRun.failedSuites} failed, 0 green-skipped\n` +
      `  full-smoke wall budget: ${(built.artifact.fullSmokeWallBudgetMs / 60_000).toFixed(1)}min` +
      (built.artifact.clampedFromMs ? ` (clamped from ${(built.artifact.clampedFromMs / 60_000).toFixed(1)}min)` : "") +
      `\n  per-suite default ceiling: ${built.artifact.perSuiteDefaultCeilingMs / 1000}s/attempt; gate lint-phase budget: ${built.artifact.gateLintWallBudgetMs / 1000}s\n` +
      `  commit the artifact — tests/gate-duration-budget.test.ts and tests/run-all.ts enforce it.`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("regen-gate-duration-budget.ts");

if (isMain) {
  try {
    process.exit(cliMain(process.argv.slice(2)));
  } catch (err) {
    console.error("regen-gate-duration-budget: crashed:", err);
    process.exit(1);
  }
}
