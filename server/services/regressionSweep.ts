/**
 * Task #2611 — Shared, dependency-free contract for the nightly regression
 * sweep.
 *
 * Two callers share this module so they can never drift:
 *
 *   - `tests/run-all.ts` BUILDS a `SweepReport` (it owns the test list and
 *     the spawn loop) and writes it as JSON via `--json-report=<path>`.
 *   - `server/services/regressionSweepScheduler.ts` READS that JSON back,
 *     decides whether to raise an alert (`reportIndicatesFailure`), and turns
 *     the report into human-readable Slack / inbox text
 *     (`summarizeSweepResult`).
 *
 * Quarantine policy: some DB tests are environmentally flaky under dev-server
 * contention on the shared workspace Postgres (the always-on dev app drives
 * high pool-acquire latency). A persistent failure in one of those files
 * should NOT turn the whole nightly sweep red — otherwise the sweep is
 * useless because it is always failing. Those files are listed in
 * `QUARANTINED_TEST_FILES`: in sweep mode their failures are reported as a
 * warning, never as a hard failure. A test that merely flakes once and then
 * passes on retry is recorded as `flaky` (also a warning), independent of
 * quarantine.
 *
 * This module is intentionally dependency-free (no DB, no server imports; the
 * report contract itself uses nothing beyond JSON) so it bundles cleanly into
 * the server build AND imports cleanly into the test runner. Exception, Task
 * #5030: the duration-budget breach ledger at the bottom uses node:fs — it is
 * the shared contract between tests/run-all.ts + scripts/gate.ts (writers)
 * and the sweep scheduler (reader), and both sides already run under Node.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

/**
 * Test files known to be environmentally flaky under shared dev-DB
 * contention. Their failures degrade to a warning in sweep mode rather than
 * turning the sweep red. Keep this list short and justified — the goal is to
 * stop perpetual-red, not to hide real regressions. Add an entry only for a
 * test whose failures are demonstrably caused by the workspace environment
 * (pool contention, timing) and not by the code under test.
 */
export interface QuarantineEntry {
  file: string;
  /** Why this suite is quarantined (environmental cause, follow-up plan). */
  reason: string;
  /** ISO date the entry was added. */
  addedOn: string;
  /**
   * ISO date the quarantine EXPIRES. After this date the suite's failures
   * count as hard failures again — quarantine is a documented grace period,
   * never a permanent mute (Task #3797 step 11).
   */
  expiresOn: string;
}

// Task #3840: the ledger is currently EMPTY. Its one historical entry
// (tests/zoom-none-rate-alert.test.ts, quarantined 2026-06-01 for shared
// dev-DB pool-acquire flakiness, expiry 2026-09-30) was delisted because the
// feature it tested — the AI comparative evaluator's rolling none-rate alert —
// was deleted wholesale in Task #2637 (deterministic-only comms matching),
// and the test file was deleted with it. There is no current behavior for
// that suite to be rewritten against. Keep the mechanism: new entries must
// follow the QuarantineEntry contract above.
export const QUARANTINE_LEDGER: readonly QuarantineEntry[] = [];

/** Derived view kept for callers that only need membership. */
export const QUARANTINED_TEST_FILES: ReadonlySet<string> = new Set<string>(
  QUARANTINE_LEDGER.map((q) => q.file),
);

export function isQuarantinedTestFile(
  file: string,
  onDate: Date = new Date(),
  ledger: readonly QuarantineEntry[] = QUARANTINE_LEDGER,
): boolean {
  const entry = ledger.find((q) => q.file === file);
  if (!entry) return false;
  // Expired quarantine = loud again. Compare on the date portion so the
  // expiry day itself still quarantines (inclusive).
  return onDate.toISOString().slice(0, 10) <= entry.expiresOn;
}

export type SweepTestOutcome = "passed" | "failed" | "incomplete";

export interface SweepTestResult {
  /** Human-readable test name from the runner's TestDef. */
  name: string;
  /** Test file path relative to the repo root. */
  file: string;
  outcome: SweepTestOutcome;
  /** True when this file is in the quarantine list (failure → warning). */
  quarantined: boolean;
  /** How many times the file was executed (1 = passed first try). */
  attempts: number;
  /** Wall-clock ms across all attempts. */
  elapsedMs: number;
  /** Populated when outcome is not passed: e.g. "exit 1" / "hang 184s". */
  failureReason?: string;
}

/**
 * Aggregate runner facts forwarded only through the gate's invocation-private
 * report. It deliberately excludes suite identity, output, paths, and env.
 */
export interface TaskGateRunnerPerformance {
  shardCount: number;
  activeLaneCount: number;
  estimateKnownCount: number;
  estimateUnknownCount: number;
  plannedLaneTotalMs: number;
  plannedLaneMinMs: number;
  plannedLaneMaxMs: number;
  actualLaneTotalMs: number;
  actualLaneMinMs: number;
  actualLaneMaxMs: number;
  batchCompatibleFirstAttempts: number;
  batchIncompatibleFirstAttempts: number;
  batchedFirstAttempts: number;
  soloFirstAttempts: number;
  soloFirstAttemptElapsedMs: number;
  batchedFailureSoloRechecks: number;
  batchWorkerStarts: number;
  batchWorkerReuses: number;
  batchWorkerSuiteRuns: number;
  batchWorkerPeakRssKb: number;
  batchWorkerRecyclesHardCap: number;
  batchWorkerRecyclesResourcePressure: number;
  batchWorkerRecyclesFailure: number;
  batchWorkerRecyclesStraggler: number;
}

export interface SweepReport {
  startedAt: string;
  finishedAt: string;
  /** Which selection mode produced this report. */
  mode: "regression" | "smoke" | "all";
  /**
   * Whether a smoke run actually narrowed to the related subset. False means
   * full smoke (including a related-selection fallback); null means the field
   * is not applicable to regression/all modes. Optional for older reports.
   */
  relatedSelection?: boolean | null;
  total: number;
  passed: number;
  /** Failures NOT covered by quarantine — these make the sweep red. */
  hardFailed: number;
  /** Failures in quarantined files — warnings only. */
  quarantinedFailed: number;
  /** Files that failed at least once but passed on a retry. */
  flaky: number;
  /**
   * Selected suites that did not produce a trustworthy terminal execution
   * result. An incomplete report is diagnostic-only: it cannot publish
   * baseline, manifest, or duration evidence.
   */
  incomplete?: number;
  /**
   * False when lane accounting saw a missing, duplicate, or foreign result.
   * Optional for reports written before explicit shard accounting existed.
   */
  verificationComplete?: boolean;
  /** Human-readable accounting diagnostics for an incomplete run. */
  verificationProblems?: string[];
  results: SweepTestResult[];
  hardFailedNames: string[];
  quarantinedFailedNames: string[];
  flakyNames: string[];
  incompleteNames?: string[];
  /**
   * Task #3791 — suites the runner did NOT execute because their input
   * fingerprint matched their last green run in this environment (see
   * tests/suiteFingerprint.ts). Optional so pre-#3791 report JSON still
   * parses; new reports always set them. Skipped suites are not in
   * `results`/`total` — they were proven green on identical inputs, not run.
   */
  skippedGreen?: number;
  skippedGreenFiles?: string[];
  /**
   * Task #4077 — skip-health visibility: freshness of the committed green
   * baseline (tests/green-baseline.json) as observed by the runner's plan.
   * Null when the baseline is absent/unreadable or carries no parseable
   * publish stamp. Optional so older report JSON still parses.
   */
  baselinePublishedAt?: string | null;
  baselineAgeDays?: number | null;
  /**
   * Task #4104 — repeat-poison warnings (Task #4101): files that have carried
   * a `<build error: …>` in POISON_REPEAT_THRESHOLD+ consecutive skip audits
   * (history: .local/state/skip-poison-history.json). Riding along in the
   * report makes the alert PUSH (Slack / nightly notification) instead of
   * pull (reading the sweep log). Structural copy of RepeatPoisonWarning from
   * tests/suiteFingerprint.ts — this module must stay dependency-free.
   * Optional so older report JSON still parses.
   */
  repeatPoisonWarnings?: RepeatPoisonWarningLike[];
  /**
   * Task #4491 — gate lint reds observed by the nightly report-only lint
   * phase (tests/run-all.ts sets this AFTER buildSweepReport, publish-armed
   * runs only). Array = the lint phase ran (names of red lints; empty =
   * lint-green); null/undefined = not measured (task-side runs, budget
   * overruns, pre-#4491 reports). Report-only: never affects
   * reportIndicatesFailure — visibility rides the notification instead.
   */
  lintReds?: string[] | null;
  /**
   * Task #4595 — realized savings of the #4503 per-table migration scoping,
   * riding along so the sweep summary / run notification trends it. Counts
   * of the selected suites by classification (table-scoped vs full-scope
   * DB-sensitive) plus the REALIZED skips among them this run — a drift back
   * toward full-scope classification, or table-scoped suites that stop
   * skipping (unattributable migrations), shows up here without digging into
   * .local/runs/incremental-skip.json. Null = not measured (incremental
   * planning unavailable); optional so older report JSON still parses.
   */
  migrationTableScopedCount?: number | null;
  migrationFullScopeCount?: number | null;
  migrationTableScopedSkipped?: number | null;
  migrationFullScopeSkipped?: number | null;
  /**
   * Task #5028 — auto-quarantine ledger transitions recorded by the nightly
   * publisher (tests/run-all.ts inside TEST_GREEN_BASELINE_PUBLISH=1 block).
   * Riding along in the report so the scheduler can drive feedback filing and
   * cap-breach alerts without re-running the transition logic. Optional so
   * older/task-side report JSON still parses.
   *
   * quarantineEntered:     file paths newly auto-quarantined this run.
   * quarantineReinstated:  file paths auto-reinstated (proven stable).
   * quarantineCapDenied:   flaky candidates denied entry — cap full (still blocking).
   * quarantineSkippedFromGate: how many quarantined suites were excluded from
   *                        the smoke gate this run (non-diff-related, non-blocking).
   */
  quarantineEntered?: string[];
  quarantineReinstated?: string[];
  quarantineCapDenied?: string[];
  quarantineSkippedFromGate?: number;
  /**
   * Task #5030 — rotation-day full-universe deferral. When green evidence
   * rotated (merge-heavy day) the blocking gate keeps only related + core +
   * diff-reached suites and DEFERS the remaining execution debt to the
   * post-merge/nightly lane. These fields are the honest "deferred, not
   * verified" record riding in the report (full detail:
   * .local/runs/full-lane-deferred.json). Deferred suites are NOT in
   * `results`/`total` and are never recorded green — they were not run.
   * Optional so older report JSON still parses.
   */
  deferredNotVerified?: number;
  deferredFiles?: string[];
  /**
   * Task #5030 — culprit merge-window attribution for NEW nightly reds.
   * When the nightly sweep (publish-armed) records a red suite that was NOT
   * in the previous red manifest, the window of commits between the previous
   * manifest's commit stamp and this run's HEAD is resolved so breakage
   * triage names the culprit merge window automatically instead of falling
   * on the next unlucky task. Null/absent = no new reds or window
   * unresolvable. Optional so older report JSON still parses.
   */
  newRedMergeWindow?: {
    fromCommit: string;
    toCommit: string;
    newReds: string[];
    commits: Array<{ commit: string; task: string | null; subject: string }>;
    truncated: boolean;
  } | null;
  /**
   * Aggregate scheduler/batching facts for task-gate performance evidence.
   * Local report only; older reports legitimately omit it.
   */
  taskGatePerformance?: TaskGateRunnerPerformance;
}

/** Structural twin of tests/suiteFingerprint.ts's RepeatPoisonWarning (this
 * module is intentionally import-free — see the header). */
export interface RepeatPoisonWarningLike {
  file: string;
  streak: number;
  firstSeenAt: string;
  error: string;
}

/**
 * Build a `SweepReport` from the per-file results the runner collected. Pure:
 * classification is derived entirely from each result's outcome + quarantine
 * flag. Incomplete records are always hard verification failures and are never
 * quarantined or treated as test-code reds.
 */
export function buildSweepReport(
  results: SweepTestResult[],
  meta: {
    startedAt: string;
    finishedAt: string;
    mode: SweepReport["mode"];
    /** Actual smoke selection outcome; null outside smoke mode. */
    relatedSelection?: boolean | null;
    /** Task #3791: suites skipped as green-on-identical-inputs (not executed). */
    skippedGreen?: number;
    skippedGreenFiles?: string[];
    /** Task #4077: committed-baseline freshness (see SweepReport). */
    baselinePublishedAt?: string | null;
    baselineAgeDays?: number | null;
    /** Task #4104: repeat-poisoned files (see SweepReport). */
    repeatPoisonWarnings?: RepeatPoisonWarningLike[];
    /** Task #4595: migration-scoping classification + realized skips. */
    migrationTableScopedCount?: number | null;
    migrationFullScopeCount?: number | null;
    migrationTableScopedSkipped?: number | null;
    migrationFullScopeSkipped?: number | null;
    /** False blocks evidence consumers even when no individual suite is missing
     * (for example, duplicate or foreign lane output). */
    verificationComplete?: boolean;
    verificationProblems?: string[];
  },
): SweepReport {
  const hardFailedNames: string[] = [];
  const quarantinedFailedNames: string[] = [];
  const flakyNames: string[] = [];
  const incompleteNames: string[] = [];
  let passed = 0;

  for (const r of results) {
    if (r.outcome === "passed") {
      passed++;
      if (r.attempts > 1) flakyNames.push(r.name);
      continue;
    }
    const label = r.failureReason ? `${r.name} (${r.failureReason})` : r.name;
    if (r.outcome === "incomplete") {
      incompleteNames.push(label);
      continue;
    }
    if (r.quarantined) quarantinedFailedNames.push(label);
    else hardFailedNames.push(label);
  }

  return {
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    mode: meta.mode,
    relatedSelection: meta.relatedSelection ?? null,
    total: results.length,
    passed,
    hardFailed: hardFailedNames.length,
    quarantinedFailed: quarantinedFailedNames.length,
    flaky: flakyNames.length,
    incomplete: incompleteNames.length,
    verificationComplete: meta.verificationComplete ?? incompleteNames.length === 0,
    verificationProblems: meta.verificationProblems ?? [],
    results,
    hardFailedNames,
    quarantinedFailedNames,
    flakyNames,
    incompleteNames,
    skippedGreen: meta.skippedGreen ?? 0,
    skippedGreenFiles: meta.skippedGreenFiles ?? [],
    baselinePublishedAt: meta.baselinePublishedAt ?? null,
    baselineAgeDays: meta.baselineAgeDays ?? null,
    repeatPoisonWarnings: meta.repeatPoisonWarnings ?? [],
    migrationTableScopedCount: meta.migrationTableScopedCount ?? null,
    migrationFullScopeCount: meta.migrationFullScopeCount ?? null,
    migrationTableScopedSkipped: meta.migrationTableScopedSkipped ?? null,
    migrationFullScopeSkipped: meta.migrationFullScopeSkipped ?? null,
  };
}

/**
 * The sweep is failed when verification was incomplete or at least one
 * non-quarantined test failed. Quarantined failures and flaky passes remain
 * warnings, but cannot excuse missing shard results.
 */
export function reportIndicatesFailure(report: SweepReport): boolean {
  return report.verificationComplete === false || (report.incomplete ?? 0) > 0 || report.hardFailed > 0;
}

/**
 * Render a one-message human summary for Slack / the in-app inbox. The first
 * line states the verdict; follow-up lines name the offenders so a rotted
 * regression test is identifiable straight from the alert.
 */
export function summarizeSweepResult(
  report: SweepReport,
  label = "Test run",
): string {
  const lines: string[] = [];
  const verdict =
    report.verificationComplete === false || (report.incomplete ?? 0) > 0
      ? `${label} INCOMPLETE: ${report.incomplete ?? 0} of ${report.total} ${report.mode} test(s) were not verified.`
      : reportIndicatesFailure(report)
    ? `${label} FAILED: ${report.hardFailed} of ${report.total} ${report.mode} test(s) broke.`
    : `${label} passed: ${report.passed} of ${report.total} ${report.mode} test(s) green.`;
  lines.push(verdict);

  if (report.hardFailedNames.length > 0) {
    lines.push("Failed tests:");
    for (const n of report.hardFailedNames) lines.push(`  - ${n}`);
  }
  if ((report.incompleteNames?.length ?? 0) > 0) {
    lines.push("Incomplete verification (runner/lane failure, not a test failure):");
    for (const n of report.incompleteNames ?? []) lines.push(`  - ${n}`);
  }
  if ((report.verificationProblems?.length ?? 0) > 0) {
    lines.push("Verification accounting:");
    for (const problem of report.verificationProblems ?? []) lines.push(`  - ${problem}`);
  }
  if (report.quarantinedFailedNames.length > 0) {
    lines.push("Quarantined (flaky, not counted as failures):");
    for (const n of report.quarantinedFailedNames) lines.push(`  - ${n}`);
  }
  if (report.flakyNames.length > 0) {
    lines.push("Passed only on retry (watch these):");
    for (const n of report.flakyNames) lines.push(`  - ${n}`);
  }
  // Task #3791: make incremental runs auditable straight from the alert. The
  // verdict line above stays untouched — operators and tooling key off it.
  if ((report.skippedGreen ?? 0) > 0) {
    lines.push(
      `Skipped ${report.skippedGreen} suite(s) green on identical inputs (not re-executed; audit: .local/runs/incremental-skip.json).`,
    );
  }
  // Task #4077 — skip-health: surface committed-baseline freshness in every
  // sweep summary so a frozen baseline is visible from the nightly alert
  // itself, not discovered days later via slow task validations.
  if (typeof report.baselineAgeDays === "number") {
    lines.push(
      `Committed green baseline age: ${report.baselineAgeDays.toFixed(1)}d (published ${report.baselinePublishedAt ?? "unknown"}).`,
    );
  }
  // Task #4595 — realized per-table migration-scoping savings: how many
  // DB-sensitive suites skipped this run, by scope, plus the classification
  // split. Trending the table-scoped skipped count across sweep summaries
  // makes a silent regression back toward full-tree re-runs visible from the
  // notification itself instead of via slow task validations.
  if (typeof report.migrationTableScopedSkipped === "number" && typeof report.migrationFullScopeSkipped === "number") {
    lines.push(
      `Migration scoping: ${report.migrationTableScopedSkipped} table-scoped DB-sensitive suite(s) skipped this run (${report.migrationFullScopeSkipped} full-scope skipped; classification: ${report.migrationTableScopedCount ?? "?"} table-scoped / ${report.migrationFullScopeCount ?? "?"} full-scope).`,
    );
  }
  // Task #5028 — auto-quarantine transition summary: entered/reinstated/denied
  // events ride in the notification so operators see the quarantine list evolve.
  if (report.quarantineEntered && report.quarantineEntered.length > 0) {
    lines.push(`Auto-quarantine: ${report.quarantineEntered.length} suite(s) newly quarantined (flaky, non-blocking):`);
    for (const f of report.quarantineEntered) lines.push(`  + ${f}`);
  }
  if (report.quarantineReinstated && report.quarantineReinstated.length > 0) {
    lines.push(`Auto-quarantine: ${report.quarantineReinstated.length} suite(s) reinstated (proven stable):`);
    for (const f of report.quarantineReinstated) lines.push(`  ✓ ${f}`);
  }
  if (report.quarantineCapDenied && report.quarantineCapDenied.length > 0) {
    lines.push(
      `⚠ Auto-quarantine cap exceeded: ${report.quarantineCapDenied.length} flaky suite(s) denied entry — still blocking until cap clears:`,
    );
    for (const f of report.quarantineCapDenied) lines.push(`  ! ${f}`);
  }
  if (typeof report.quarantineSkippedFromGate === "number" && report.quarantineSkippedFromGate > 0) {
    lines.push(
      `Auto-quarantine: ${report.quarantineSkippedFromGate} quarantined suite(s) excluded from gate (not diff-related, non-blocking).`,
    );
  }
  // Task #4104 — repeat-poison warnings ride in the notification too, naming
  // the file and its build-error text, so a persistently broken test file is
  // pushed to the team instead of buried in the sweep log.
  const poisoned = report.repeatPoisonWarnings ?? [];
  if (poisoned.length > 0) {
    lines.push(
      `⚠ REPEAT-POISONED test file(s): ${poisoned.length} file(s) have carried a <build error> across consecutive nightly skip audits — they (and every dependent suite) stay unskippable until fixed:`,
    );
    for (const w of poisoned) {
      lines.push(`  - ${w.file} — poisoned ${w.streak} consecutive audit(s) since ${w.firstSeenAt}`);
      lines.push(`      ${w.error}`);
    }
  }
  return lines.join("\n");
}

/**
 * Task #3791 — nightly sweep cadence: incremental on weeknights, one FULL
 * integrity execution per week. Fingerprints cannot see environment/DB
 * drift, so once a week the sweep executes every regression suite regardless
 * of the green store; any drift is therefore caught within a week. The cron
 * fires daily at 03:30 America/New_York; this decides which kind of night it
 * is. Sunday 03:30 ET = Saturday night — the quietest slot for the heavy run.
 */
export const FULL_INTEGRITY_SWEEP_WEEKDAY = "Sun";

export function isFullIntegritySweepDate(now: Date, timeZone = "America/New_York"): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return weekday === FULL_INTEGRITY_SWEEP_WEEKDAY;
}

/**
 * The exact runner argv for a sweep tick (shared so the scheduler and tests
 * cannot drift): incremental by default, `--force-all` on the weekly
 * integrity night.
 */
export function buildSweepRunArgs(reportPath: string, fullIntegrity: boolean): string[] {
  return [
    "tests/run-all.ts",
    "--regression",
    "--sweep",
    `--json-report=${reportPath}`,
    ...(fullIntegrity ? ["--force-all"] : []),
  ];
}

/**
 * Safely parse a JSON sweep report written by the runner. Returns null when
 * the payload is missing or malformed (e.g. the runner crashed before writing
 * it) so the scheduler can treat an unreadable report as its own failure mode.
 */
export function parseSweepReport(raw: string): SweepReport | null {
  try {
    const obj = JSON.parse(raw) as Partial<SweepReport>;
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray(obj.results) &&
       typeof obj.hardFailed === "number" &&
      typeof obj.total === "number"
    ) {
      return obj as SweepReport;
    }
    return null;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Task #5030 — Duration-budget breach ledger.
//
// L3-approved policy revision: a wall-budget breach never fails a run (green
// stays green — the 2026-08-18 incident verdicted a 765/765-green run FAIL on
// a stale 20.5min budget). Instead the breach is recorded here as an
// append-only JSONL event by the writers (tests/run-all.ts for the full-smoke
// wall, scripts/gate.ts for the lint-phase wall) and drained by the sweep
// scheduler (runDurationBudgetBreachCheck in regressionSweepScheduler.ts),
// which auto-files ONE re-baseline/triage feedback item per stale-budget
// episode (dedupe key = the budget artifact's generatedAt stamp).
//
// Per-suite duration ceilings are unaffected: they remain hard failures in
// tests/durationBudget.ts. The TEST_DURATION_BUDGET=0 kill switch remains
// banned as a fix for those.
// ---------------------------------------------------------------------------

/** Append-only JSONL ledger of wall-budget breaches (relative to repo root). */
export const DURATION_BREACH_EVENTS_PATH = ".local/runs/duration-budget-breach-events.jsonl";

/** Cap kept on disk — the ledger is a triage buffer, not an archive. */
export const DURATION_BREACH_EVENTS_MAX = 100;

export interface DurationBudgetBreachEvent {
  /** ISO timestamp the breach was observed. */
  observedAt: string;
  /** Which wall breached. */
  source: "run-all-wall" | "gate-lint-wall";
  /** Observed wall time (ms). */
  wallMs: number;
  /** The budget it exceeded (ms). */
  budgetMs: number;
  /**
   * `generatedAt` of the committed budget artifact in force at breach time —
   * the scheduler's dedupe identity: one filed triage item per stale-budget
   * episode, however many runs breach before the artifact is regenerated.
   */
  budgetGeneratedAt: string;
  /** Runner mode for run-all breaches ("smoke"), "lint" for the gate wall. */
  mode: string;
  /** Executed suite count (0 for the gate lint wall). */
  suiteCount: number;
}

function isDurationBudgetBreachEvent(v: unknown): v is DurationBudgetBreachEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<DurationBudgetBreachEvent>;
  return (
    typeof o.observedAt === "string" &&
    (o.source === "run-all-wall" || o.source === "gate-lint-wall") &&
    typeof o.wallMs === "number" &&
    typeof o.budgetMs === "number" &&
    typeof o.budgetGeneratedAt === "string" &&
    typeof o.mode === "string" &&
    typeof o.suiteCount === "number"
  );
}

/**
 * Append a breach event to the JSONL ledger, trimming to the newest
 * DURATION_BREACH_EVENTS_MAX. NEVER throws — a ledger write must not be able
 * to break the run that observed the breach (that would resurrect the exact
 * green-turns-red coupling this revision removes); failures log loudly.
 */
export function appendDurationBudgetBreachEvent(
  event: DurationBudgetBreachEvent,
  ledgerPath: string = DURATION_BREACH_EVENTS_PATH,
): void {
  try {
    const abs = resolvePath(ledgerPath);
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, `${JSON.stringify(event)}\n`, "utf8");
    // Trim: keep the newest MAX lines (small file — read/rewrite is fine).
    const lines = readFileSync(abs, "utf8").split("\n").filter((l) => l.trim() !== "");
    if (lines.length > DURATION_BREACH_EVENTS_MAX) {
      const kept = lines.slice(lines.length - DURATION_BREACH_EVENTS_MAX);
      writeFileSync(abs, `${kept.join("\n")}\n`, "utf8");
    }
  } catch (err) {
    console.error(
      `[duration-budget] FAILED to append breach event to ${ledgerPath} — the breach above still needs a re-baseline: ${(err as Error).message}`,
    );
  }
}

/**
 * Read the breach ledger (newest last). Corrupt/foreign lines are skipped —
 * the reader must survive a torn append. Missing file ⇒ [].
 */
export function readDurationBudgetBreachEvents(
  ledgerPath: string = DURATION_BREACH_EVENTS_PATH,
): DurationBudgetBreachEvent[] {
  try {
    const raw = readFileSync(resolvePath(ledgerPath), "utf8");
    const events: DurationBudgetBreachEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isDurationBudgetBreachEvent(parsed)) events.push(parsed);
      } catch {
        // skip corrupt line
      }
    }
    return events;
  } catch {
    return [];
  }
}
