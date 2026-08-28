/**
 * durationBudget.ts — Task #4531 (L3-approved gate policy): the merge gate's
 * duration budget.
 *
 * Why: the smoke universe grew ~301 → ~790 suites (Aug 8 promotion + steady
 * task velocity) and a full-smoke validation reached ~37 min wall with
 * nothing enforcing an upper bound. This module is the frozen-snapshot-style
 * ratchet (repo convention, see ratchet-frozen-snapshot pattern): budgets are
 * DERIVED from one measured zero-skip run by the sole writer
 * (scripts/regen-gate-duration-budget.ts), committed as a self-hashed
 * artifact (tests/gate-duration-budget.json), and enforced loudly by
 * tests/run-all.ts (suite ceilings) and scripts/gate.ts (lint-phase wall
 * alert). Hand-edits fail the self-hash.
 *
 * Owner-approved semantics (Task #4531 Architecture Impact Review, revised
 * by the Task #5030 L3 review):
 *   - Whole-gate full-smoke wall budget = ceil(1.30 × measured zero-skip
 *     wall), hard-pinned at 40 min (PINNED_MAXIMA — regen clamps, the guard
 *     test refuses artifacts above the pin).
 *   - Per-suite default ceiling 90s (per attempt, passing suites only). A
 *     registered `timeoutMs` override in the suite's registration block IS
 *     the sanctioned slow lane — the override becomes that suite's ceiling,
 *     and the registration text is the recorded justification.
 *   - Enforcement (Task #5030 revision): per-suite ceiling violations FAIL
 *     full-smoke runs (mode smoke, no related narrowing) and WARN-only on
 *     related gate runs and regression/all sweeps. The WALL budget never
 *     fails a run: an all-green run must never be verdicted FAIL on
 *     aggregate wall time (2026-08-18 incident: 765/765 green FAILed on a
 *     stale budget). A wall breach is a loud non-blocking ALERT — callers
 *     append a breach event (appendDurationBudgetBreachEvent in
 *     server/services/regressionSweep.ts) and the sweep scheduler auto-files
 *     one re-baseline/triage item per stale-budget episode.
 *   - The wall is judged only on full-smoke runs that executed the measured
 *     quantity: a run narrowed by rotation-day deferral (deferredCount > 0,
 *     Task #5030) skips the wall comparison entirely.
 *   - Kill switch: TEST_DURATION_BUDGET=0 (checked by the callers, not here
 *     — this module is pure so the guard test can drive fixtures). Using it
 *     to bury a per-suite violation remains banned.
 *   - Update path: optimize the suite, or register a justified timeoutMs
 *     override, or — for the wall — owner-approved regen:
 *     `npx tsx scripts/regen-gate-duration-budget.ts` after a fresh
 *     zero-skip full-smoke measurement.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Authoring-time hard pins (owner-approved). The regen script clamps the
 * derived wall budget to these; validation refuses any artifact above them,
 * so the budget can never ratchet UP past policy without a reviewed edit to
 * this file. */
export const PINNED_MAXIMA = {
  /** 40 min — owner-approved hard cap for the full-smoke wall budget. */
  fullSmokeWallBudgetMs: 40 * 60_000,
  /** 90s per suite (per attempt); registered timeoutMs overrides win. */
  perSuiteDefaultCeilingMs: 90_000,
  /** 4 min for the gate's whole lint phase (holds cold: worst single lint
   * ~170s + pool parallelism; warm verdict-cache runs are far under). */
  gateLintWallBudgetMs: 240_000,
} as const;

export const BUDGET_ARTIFACT_PATH = "tests/gate-duration-budget.json";
export const REGEN_COMMAND = "npx tsx scripts/regen-gate-duration-budget.ts";

export interface DurationBudgetSourceRun {
  generatedAt: string;
  mode: string;
  relatedSelection: boolean;
  skippedGreen: number;
  suiteCount: number;
  /** Suites red in the source run (recorded for honesty — during the
   * 2026-08 Clerk red storm a fully green zero-skip run is impossible; the
   * wall still includes those suites' runtime). */
  failedSuites: number;
  wallMs: number;
}

export interface DurationBudgetArtifact {
  schemaVersion: 1;
  generatedAt: string;
  sourceRun: DurationBudgetSourceRun;
  /** ceil(1.30 × sourceRun.wallMs), clamped to PINNED_MAXIMA. */
  fullSmokeWallBudgetMs: number;
  /** Present when the formula exceeded the pin and was clamped down. */
  clampedFromMs?: number;
  perSuiteDefaultCeilingMs: number;
  gateLintWallBudgetMs: number;
  formula: string;
  updatePath: string;
  /** sha256 over the canonical JSON with selfHash="" — tamper seal. */
  selfHash: string;
}

/** Canonical JSON: recursively sorted object keys, no whitespace — the hash
 * input must not depend on serialization order or formatting. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function computeArtifactSelfHash(artifact: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson({ ...artifact, selfHash: "" }))
    .digest("hex");
}

export type ArtifactLoadResult =
  | { ok: true; artifact: DurationBudgetArtifact }
  | { ok: false; missing: boolean; error: string };

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function validateDurationBudgetArtifact(raw: string): ArtifactLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, error: `unparseable JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, missing: false, error: "artifact is not a JSON object" };
  }
  const a = parsed as Record<string, unknown>;
  if (a.schemaVersion !== 1) {
    return { ok: false, missing: false, error: `unknown schemaVersion ${String(a.schemaVersion)}` };
  }
  const sr = a.sourceRun as Record<string, unknown> | undefined;
  if (typeof sr !== "object" || sr === null) {
    return { ok: false, missing: false, error: "missing sourceRun" };
  }
  if (sr.mode !== "smoke" || sr.relatedSelection !== false || sr.skippedGreen !== 0) {
    return {
      ok: false,
      missing: false,
      error:
        "sourceRun must be a full-smoke zero-skip measurement (mode=smoke, relatedSelection=false, skippedGreen=0) — budgets derived from narrowed or green-skipped runs would be fictions",
    };
  }
  if (!isPositiveInt(sr.wallMs) || !isPositiveInt(sr.suiteCount)) {
    return { ok: false, missing: false, error: "sourceRun.wallMs / suiteCount must be positive integers" };
  }
  if (typeof sr.failedSuites !== "number" || sr.failedSuites < 0) {
    return { ok: false, missing: false, error: "sourceRun.failedSuites must be a non-negative number" };
  }
  for (const field of ["fullSmokeWallBudgetMs", "perSuiteDefaultCeilingMs", "gateLintWallBudgetMs"] as const) {
    if (!isPositiveInt(a[field])) {
      return { ok: false, missing: false, error: `${field} must be a positive integer` };
    }
  }
  if (typeof a.selfHash !== "string" || a.selfHash.length !== 64) {
    return { ok: false, missing: false, error: "missing/malformed selfHash" };
  }
  const expected = computeArtifactSelfHash(a);
  if (a.selfHash !== expected) {
    return {
      ok: false,
      missing: false,
      error: `self-hash mismatch (found ${String(a.selfHash).slice(0, 12)}…, expected ${expected.slice(0, 12)}…) — the artifact is a frozen policy snapshot; hand-edits are refused. Regenerate: ${REGEN_COMMAND}`,
    };
  }
  // Pinned maxima — the ratchet's upper bound. An artifact above these is
  // refused even with a valid self-hash (the sole writer clamps, so this
  // only fires on a bypassed/forked writer).
  if ((a.fullSmokeWallBudgetMs as number) > PINNED_MAXIMA.fullSmokeWallBudgetMs) {
    return {
      ok: false,
      missing: false,
      error: `fullSmokeWallBudgetMs ${String(a.fullSmokeWallBudgetMs)} exceeds the pinned maximum ${PINNED_MAXIMA.fullSmokeWallBudgetMs} (40 min, owner-approved) — raising the pin requires editing PINNED_MAXIMA in tests/durationBudget.ts under review`,
    };
  }
  if ((a.perSuiteDefaultCeilingMs as number) > PINNED_MAXIMA.perSuiteDefaultCeilingMs) {
    return {
      ok: false,
      missing: false,
      error: `perSuiteDefaultCeilingMs exceeds the pinned maximum ${PINNED_MAXIMA.perSuiteDefaultCeilingMs}`,
    };
  }
  if ((a.gateLintWallBudgetMs as number) > PINNED_MAXIMA.gateLintWallBudgetMs) {
    return {
      ok: false,
      missing: false,
      error: `gateLintWallBudgetMs exceeds the pinned maximum ${PINNED_MAXIMA.gateLintWallBudgetMs}`,
    };
  }
  // Derivation formula — the wall budget must EQUAL what the sole writer
  // computes from sourceRun: min(ceil(1.30 × wallMs), pin). Without this
  // check, editing the budget and recomputing the public self-hash would
  // yield an accepted artifact; with it, rehashing is not a bypass — the
  // only free input is the measured source run itself, and THAT is what
  // artifact diffs get reviewed on.
  const rawFromSource = Math.ceil((sr.wallMs as number) * 1.3);
  const expectedBudget = Math.min(rawFromSource, PINNED_MAXIMA.fullSmokeWallBudgetMs);
  if ((a.fullSmokeWallBudgetMs as number) !== expectedBudget) {
    return {
      ok: false,
      missing: false,
      error: `fullSmokeWallBudgetMs ${String(a.fullSmokeWallBudgetMs)} does not equal min(ceil(1.30 × sourceRun.wallMs), pin) = ${expectedBudget} — the budget is derived from the measurement, never chosen; regenerate: ${REGEN_COMMAND}`,
    };
  }
  if (rawFromSource > PINNED_MAXIMA.fullSmokeWallBudgetMs) {
    if (a.clampedFromMs !== rawFromSource) {
      return {
        ok: false,
        missing: false,
        error: `clampedFromMs must record the pre-clamp ceil(1.30 × sourceRun.wallMs) = ${rawFromSource} when the pin clamps (found ${String(a.clampedFromMs)})`,
      };
    }
  } else if (a.clampedFromMs !== undefined) {
    return {
      ok: false,
      missing: false,
      error: `clampedFromMs is present (${String(a.clampedFromMs)}) but the derived budget ${rawFromSource} does not exceed the pin — clamp bookkeeping must match the formula`,
    };
  }
  return { ok: true, artifact: a as unknown as DurationBudgetArtifact };
}

export function loadDurationBudgetArtifact(path: string): ArtifactLoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      missing: true,
      error: `budget artifact not found at ${path}: ${(err as Error).message}`,
    };
  }
  return validateDurationBudgetArtifact(raw);
}

export interface SuiteTimingForBudget {
  file: string;
  outcome: "passed" | "failed";
  quarantined?: boolean;
  elapsedMs: number;
  attempts: number;
  /** Registered timeoutMs override from the suite's registration block, if
   * any — the sanctioned slow lane, doubling as that suite's ceiling. */
  timeoutMsOverride?: number | null;
}

export interface PerSuiteBudgetHit {
  file: string;
  perAttemptMs: number;
  ceilingMs: number;
  ceilingSource: "default" | "registration-timeoutMs";
}

export interface DurationBudgetEvaluation {
  /** True when PER-SUITE violations fail the run (full-smoke); false =
   * warn-only. The wall budget never fails a run (Task #5030). */
  enforced: boolean;
  perSuiteHits: PerSuiteBudgetHit[];
  /** Non-null when a judged full-smoke wall exceeded the budget. Task #5030:
   * this is an ALERT signal, never a failure — callers append a breach event
   * to the ledger (server/services/regressionSweep.ts) so the scheduler
   * auto-files a re-baseline/triage item. */
  wallHit: { wallMs: number; budgetMs: number } | null;
  /** True ⟺ enforced && perSuiteHits.length > 0. Wall breaches never set
   * this (Task #5030: green stays green on aggregate wall time). */
  failRun: boolean;
  lines: string[];
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtMin(ms: number): string {
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** How a smoke run's selection request resolved — the ACTUAL universe. */
export interface SmokeSelectionResolution {
  /** Narrow the selected set to the manifest's related subset. */
  narrowToRelated: boolean;
  /** What the duration report + budget evaluator must receive: true ONLY
   * when the run genuinely executes a narrowed subset. */
  relatedSelectionForBudget: boolean;
  /** Operator-facing log line (override / fallback-enforcement notices). */
  note: string | null;
}

/**
 * Resolve budget-enforcement mode from the selector's ACTUAL outcome, never
 * the requested flag: a related-selection run that falls back to the full
 * smoke universe IS a full-smoke run. Deferred selector outcomes remain
 * bounded task proof and transfer the omitted broad work to central integrity.
 * `--full-smoke` refuses an inherited
 * TEST_SMOKE_RELATED so parent environment state cannot silently narrow an
 * intended-full run.
 */
export function resolveSmokeSelection(input: {
  requestedRelated: boolean;
  fullSmokeForced: boolean;
  /** null = selector did not run (no related request, or full-smoke forced). */
  manifestMode: "related" | "deferred" | null;
}): SmokeSelectionResolution {
  if (input.fullSmokeForced) {
    return {
      narrowToRelated: false,
      relatedSelectionForBudget: false,
      note: input.requestedRelated
        ? "[selection] --full-smoke overrides inherited TEST_SMOKE_RELATED — running (and budget-enforcing) the complete smoke universe."
        : null,
    };
  }
  if (!input.requestedRelated) {
    return { narrowToRelated: false, relatedSelectionForBudget: false, note: null };
  }
  if (input.manifestMode === "related") {
    return { narrowToRelated: true, relatedSelectionForBudget: true, note: null };
  }
  return {
    narrowToRelated: input.manifestMode === "deferred",
    relatedSelectionForBudget: input.manifestMode === "deferred",
    note:
      input.manifestMode === "deferred"
        ? "[selection] broad coverage deferred to the post-merge/nightly/weekly integrity lane; this bounded task run is NOT full-smoke verification."
        : null,
  };
}

export function evaluateDurationBudget(input: {
  artifact: DurationBudgetArtifact;
  suites: SuiteTimingForBudget[];
  wallMs: number;
  mode: string;
  relatedSelection: boolean;
  /** Task #5030 — suites deferred to the post-merge/nightly lane this run
   * (rotation-day deferral, tests/run-all.ts). A deferral-narrowed run did
   * not execute the measured full-smoke universe, so its wall is not the
   * budgeted quantity: when > 0 the wall comparison is skipped entirely.
   * Per-suite ceilings still apply. Default 0. */
  deferredCount?: number;
}): DurationBudgetEvaluation {
  const { artifact } = input;
  const fullSmoke = input.mode === "smoke" && !input.relatedSelection;
  const enforced = fullSmoke;
  const deferredCount = input.deferredCount ?? 0;

  const perSuiteHits: PerSuiteBudgetHit[] = [];
  for (const s of input.suites) {
    // Failed suites already fail (or are excused by) the run — ceiling noise
    // on top would double-report; quarantined suites are sweep-only concerns.
    if (s.outcome !== "passed" || s.quarantined) continue;
    // Per-attempt: a retried-then-passed suite's elapsedMs sums attempts;
    // the ceiling judges the suite's cost, not the runner's retry policy.
    const perAttemptMs = Math.round(s.elapsedMs / Math.max(1, s.attempts));
    const override = s.timeoutMsOverride ?? null;
    const ceilingMs = override ?? artifact.perSuiteDefaultCeilingMs;
    if (perAttemptMs > ceilingMs) {
      perSuiteHits.push({
        file: s.file,
        perAttemptMs,
        ceilingMs,
        ceilingSource: override !== null ? "registration-timeoutMs" : "default",
      });
    }
  }
  perSuiteHits.sort((a, b) => b.perAttemptMs - a.perAttemptMs);

  // Task #5030: the wall is judged only when the run actually executed the
  // measured full-smoke quantity — a deferral-narrowed run's wall is a
  // subset measurement (same reason related runs are exempt).
  const wallJudged = fullSmoke && deferredCount === 0;
  const wallHit =
    wallJudged && input.wallMs > artifact.fullSmokeWallBudgetMs
      ? { wallMs: input.wallMs, budgetMs: artifact.fullSmokeWallBudgetMs }
      : null;

  // Task #5030 (L3-approved policy revision): per-suite ceilings are the
  // ONLY hard failures. An all-green run can never be verdicted FAIL on
  // aggregate wall time — a wall breach is a loud non-blocking ALERT plus an
  // auto-filed re-baseline/triage item (breach ledger:
  // server/services/regressionSweep.ts; drain: regressionSweepScheduler.ts).
  const failRun = enforced && perSuiteHits.length > 0;

  const lines: string[] = [];
  lines.push("");
  lines.push(`── duration budget (Task #4531; ${BUDGET_ARTIFACT_PATH}) ──`);
  if (perSuiteHits.length === 0 && wallHit === null) {
    if (fullSmoke) {
      lines.push(
        wallJudged
          ? `  within budget: wall ${fmtMin(input.wallMs)} ≤ ${fmtMin(artifact.fullSmokeWallBudgetMs)}; ` +
              `no passing suite over its ceiling (default ${fmtSec(artifact.perSuiteDefaultCeilingMs)}/attempt, registered timeoutMs overrides win).`
          : `  within budget: no passing suite over its ceiling (default ${fmtSec(artifact.perSuiteDefaultCeilingMs)}/attempt, registered timeoutMs overrides win); ` +
              `wall not judged — ${deferredCount} suite(s) deferred to the post-merge/nightly lane (a deferral-narrowed wall is not the measured quantity).`,
      );
    } else {
      lines.push(
        `  within budget (informational — ${input.mode}${input.relatedSelection ? "/related" : ""} runs never block on the budget; the wall budget applies to full-smoke runs only).`,
      );
    }
  } else {
    const label = enforced ? "VIOLATION" : "warning";
    for (const h of perSuiteHits) {
      lines.push(
        `  ${label}: ${h.file} ${fmtSec(h.perAttemptMs)}/attempt > ceiling ${fmtSec(h.ceilingMs)} (${h.ceilingSource})`,
      );
    }
    if (wallHit) {
      // Task #5030: wall breaches are ALERTS, never failures — green stays
      // green; the breach ledger + scheduler auto-file the re-baseline task.
      lines.push(
        `  ALERT (non-blocking): full-smoke wall ${fmtMin(wallHit.wallMs)} > budget ${fmtMin(wallHit.budgetMs)} ` +
          `(= 1.30 × the ${fmtMin(artifact.sourceRun.wallMs)} measured ${artifact.sourceRun.generatedAt.slice(0, 10)} zero-skip run, pinned ≤ 40min). ` +
          `Green stays green (Task #5030): this never flips the verdict — a breach event is recorded and a re-baseline/triage item is auto-filed.`,
      );
    }
    lines.push(
      `  remedy — a gate slot must be earned: optimize the suite; or record the decision by registering a ` +
        `justified timeoutMs override in its registration block (that override becomes the suite's ceiling); ` +
        `or, for the wall, re-triage the smoke set / owner-approved regen from a fresh zero-skip measurement: ${REGEN_COMMAND}`,
    );
    if (!enforced && perSuiteHits.length > 0) {
      lines.push(
        `  (warn-only on ${input.mode}${input.relatedSelection ? "/related" : ""} runs — full-smoke runs fail on per-suite ceilings.)`,
      );
    }
    lines.push(`  kill switch: TEST_DURATION_BUDGET=0`);
  }
  return { enforced, perSuiteHits, wallHit, failRun, lines };
}
