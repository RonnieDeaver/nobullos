/* test-registration
{
  "name": "Call-analysis failure spike alerts (Task #1076)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1076 regression tests: single-reason call-analysis failure
 * spike alert.
 *
 * Covers:
 *   (a) absolute threshold fires inside a non-60m window (correct
 *       ratio normalization),
 *   (b) ratio threshold fires when window count is N× the per-window
 *       baseline (NOT N× the per-hour baseline),
 *   (c) muted reason is reported but never alerts,
 *   (d) per-reason cooldown suppresses re-alert without growth.
 *
 * Stubs the dispatcher so no Slack call is made; uses the real worker
 * DB for `call_analysis_jobs` (matching the `queue-drain-backlog-
 * alerts.test.ts` pattern).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";

const MARKER = `t1076_${process.pid}_${Date.now()}`;

// Task #1821: prior runs of this test (or production traffic mirrored
// into the shared dev DB) can leave `call_analysis_jobs` rows with
// generic `failure_reason` values like "whisper_timeout" or
// "ffmpeg_timeout" lying around. The watcher groups by
// `failure_reason`, so any pre-existing rows would pollute the
// baseline-per-window math and flip the ratio assertion at L227 from
// "alerted" to "below threshold". Use MARKER-suffixed reasons so the
// watcher's GROUP BY isolates exactly the rows this test seeded, and
// `cleanup()` (which deletes by MARKER external_id) keeps the table
// clean for the next run.
const REASON_FFMPEG = `ffmpeg_timeout_${MARKER}`;
const REASON_CPU = `cpu_starved_${MARKER}`;
const REASON_DOWNLOAD = `download_failed_${MARKER}`;
const REASON_WHISPER = `whisper_timeout_${MARKER}`;

const SETTING_KEYS = [
  "call_analysis_failure_spike_alert_enabled",
  "call_analysis_failure_spike_window_minutes",
  "call_analysis_failure_spike_baseline_days",
  "call_analysis_failure_spike_absolute_threshold",
  "call_analysis_failure_spike_ratio_threshold",
  "call_analysis_failure_spike_min_count_for_ratio",
  "call_analysis_failure_spike_cooldown_minutes",
  "call_analysis_failure_spike_muted_reasons",
] as const;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`
    DELETE FROM call_analysis_jobs WHERE external_id LIKE ${MARKER + "_%"}
  `);
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

interface SeedRow {
  reason: string;
  /** Minutes ago `completed_at` should be set to. */
  completedMinutesAgo: number;
}

/**
 * Task #1821: seed `completed_at` from an explicit JS-side `nowMs`
 * snapshot. The watcher's window and baseline SQL helpers were
 * updated in the same task to use `to_timestamp(${nowMs/1000})`
 * instead of SQL `NOW()`, so when the test passes the SAME `nowMs`
 * to `checkCallAnalysisFailureSpikes(nowMs, ...)` the seed offsets
 * and the watcher's window floor/ceiling share an identical origin
 * to the millisecond. This eliminates the wall-clock minute-boundary
 * race entirely.
 */
async function seedFailures(rows: SeedRow[], nowMs: number): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const externalId = `${MARKER}_${i}_${Math.random()}`;
    const completedAt = new Date(nowMs - r.completedMinutesAgo * 60_000).toISOString();
    await workerDb.execute(sql`
      INSERT INTO call_analysis_jobs
        (external_id, idempotency_key, status, failure_reason, lane, completed_at)
      VALUES (
        ${externalId},
        ${externalId},
        'failed',
        ${r.reason},
        'normal',
        ${completedAt}::timestamptz
      )
    `);
  }
}

interface AlertMetadata {
  reason?: unknown;
  windowCount?: unknown;
  baselinePerWindow?: unknown;
  ratio?: unknown;
  triggered?: unknown;
  windowMinutes?: unknown;
  baselineDays?: unknown;
  absoluteThreshold?: unknown;
  ratioThreshold?: unknown;
  minCountForRatio?: unknown;
}

interface DispatchCall {
  id: string;
  text: string;
  metadata: AlertMetadata;
}

async function installDispatcherStub(
  calls: DispatchCall[],
  outcome: { delivered: boolean; status?: string; skipReason?: string } = {
    delivered: true,
  },
) {
  const mod = await import("../server/services/callAnalysisFailureSpikeAlerts");
  mod.__testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    calls.push({
      id,
      text: payload.text,
      metadata: (opts.metadata ?? {}) as AlertMetadata,
    });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "failed"),
      skipReason: outcome.skipReason,
    };
  });
  return () => mod.__testHelpers.setDispatcherForTests(null);
}

async function run(): Promise<void> {
  await cleanup();

  const watcher = await import("../server/services/callAnalysisFailureSpikeAlerts");
  watcher.__testHelpers.resetLastAlertCache();

  // ── Pure unit test: evaluateThresholds normalises ratio per-window ──
  // baselinePerWindow=2 (NOT per-hour); ratio of 5/2=2.5 just below 3x
  // means NO ratio fire even though the count would look spiky if you
  // mistakenly compared to a per-hour baseline.
  {
    const cfg = {
      enabled: true,
      windowMinutes: 15,
      baselineDays: 7,
      absoluteThreshold: 100, // absolute disabled for this assertion
      ratioThreshold: 3,
      minCountForRatio: 3,
      cooldownMinutes: 360,
      mutedReasons: [] as string[],
    };
    const r = watcher.__testHelpers.evaluateThresholds(5, 2, cfg);
    assert.equal(r.triggered, null, "2.5x must not trip the 3x ratio threshold");
    assert.ok(r.ratio !== null && Math.abs(r.ratio - 2.5) < 1e-6);
  }

  // ── (a) Absolute threshold inside a 30-min window ───────────────────
  await storage.setSystemSetting("call_analysis_failure_spike_alert_enabled", "true", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_window_minutes", "30", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_baseline_days", "7", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_absolute_threshold", "5", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_ratio_threshold", "999", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_min_count_for_ratio", "3", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_cooldown_minutes", "60", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_muted_reasons", REASON_CPU, "system");

  // 6 ffmpeg_timeout failures inside the 30-min window → above absolute=5
  // 4 cpu_starved failures inside the 30-min window → muted, must NOT alert
  // 1 download_failed failure → below threshold, no alert
  //
  // Task #1821: snapshot `now` once per phase and thread it through
  // BOTH the seed AND the watcher. Offset chosen as 1 minute (well
  // inside the 30-min window with massive headroom) so a slow seed
  // loop cannot push the first inserted row past the window floor.
  const nowA = Date.now();
  await seedFailures(
    [
      ...Array.from({ length: 6 }, () => ({ reason: REASON_FFMPEG, completedMinutesAgo: 1 })),
      ...Array.from({ length: 4 }, () => ({ reason: REASON_CPU, completedMinutesAgo: 1 })),
      { reason: REASON_DOWNLOAD, completedMinutesAgo: 1 },
    ],
    nowA,
  );

  watcher.__testHelpers.resetLastAlertCache();
  const callsA: DispatchCall[] = [];
  const restoreA = await installDispatcherStub(callsA);
  const r1 = await watcher.checkCallAnalysisFailureSpikes(nowA);
  restoreA();

  assert.equal(r1.alertsSent, 1, `expected 1 alert, got ${r1.alertsSent}`);
  assert.equal(callsA.length, 1, "dispatcher must be called exactly once");
  assert.equal(callsA[0]!.id, "queue.call_analysis.failure_spike");
  assert.equal(callsA[0]!.metadata.reason, REASON_FFMPEG);
  assert.equal(callsA[0]!.metadata.windowCount, 6);
  assert.equal(callsA[0]!.metadata.windowMinutes, 30);

  const cpuRow = r1.reasons.find((r) => r.reason === REASON_CPU)!;
  assert.equal(cpuRow.decision, "skipped_muted", "cpu_starved must be muted");
  assert.equal(cpuRow.windowCount, 4, "muted reason still reports its current count");

  const dlRow = r1.reasons.find((r) => r.reason === REASON_DOWNLOAD)!;
  assert.equal(dlRow.decision, "skipped_below_threshold");

  // ── (d) cooldown suppresses re-alert with no growth ──────────────────
  const callsB: DispatchCall[] = [];
  const restoreB = await installDispatcherStub(callsB);
  const r2 = await watcher.checkCallAnalysisFailureSpikes(nowA);
  restoreB();
  assert.equal(r2.alertsSent, 0, "cooldown must suppress immediate re-alert");
  const ftRow = r2.reasons.find((r) => r.reason === REASON_FFMPEG)!;
  assert.ok(
    ftRow.decision === "skipped_no_growth_since_last_alert" ||
      ftRow.decision === "skipped_cooldown",
    `expected cooldown-related skip, got: ${ftRow.decision}`,
  );

  // ── (b) ratio fire with non-60m window normalisation ────────────────
  // Reset state and config: lower the absolute threshold high enough
  // that ONLY the ratio rule can fire, then seed a baseline that
  // averages 0.5 failures per 30m-window (i.e. 1/h) and a current-
  // window count of 2 → ratio 4× over the baseline (≥3×, ≥
  // minCountForRatio=2).
  await cleanup();
  await storage.setSystemSetting("call_analysis_failure_spike_alert_enabled", "true", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_window_minutes", "30", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_baseline_days", "1", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_absolute_threshold", "999", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_ratio_threshold", "3", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_min_count_for_ratio", "2", "system");
  await storage.setSystemSetting("call_analysis_failure_spike_cooldown_minutes", "60", "system");

  // 24 failures across the prior day (24h * 60m = 1440m, divided into
  // 30m windows = 48 windows; baseline = 24/48 = 0.5 per 30m). All
  // baseline rows must land OUTSIDE the current 30-min window.
  const baselineRows: SeedRow[] = [];
  for (let i = 0; i < 24; i++) {
    // Spread evenly between 60m ago and 24h ago.
    const minutesAgo = 60 + Math.floor((i * (24 * 60 - 60)) / 24);
    baselineRows.push({ reason: REASON_WHISPER, completedMinutesAgo: minutesAgo });
  }
  // 2 current-window failures. Use 1 + 2 min offsets — deeply
  // inside the 30-min current window regardless of wall-clock
  // position; the watcher's window floor is computed from the same
  // `nowB` snapshot so the rows are guaranteed to fall inside it.
  const currentRows: SeedRow[] = [
    { reason: REASON_WHISPER, completedMinutesAgo: 1 },
    { reason: REASON_WHISPER, completedMinutesAgo: 2 },
  ];
  const nowB = Date.now();
  await seedFailures([...baselineRows, ...currentRows], nowB);

  watcher.__testHelpers.resetLastAlertCache();
  const callsC: DispatchCall[] = [];
  const restoreC = await installDispatcherStub(callsC);
  const r3 = await watcher.checkCallAnalysisFailureSpikes(nowB);
  restoreC();

  assert.equal(r3.alertsSent, 1, `expected 1 ratio-triggered alert, got ${r3.alertsSent}`);
  const wt = r3.reasons.find((r) => r.reason === REASON_WHISPER)!;
  assert.equal(wt.decision, "alerted");
  assert.equal(wt.windowCount, 2);
  assert.ok(
    wt.baselinePerWindow > 0.3 && wt.baselinePerWindow < 0.7,
    `baselinePerWindow ≈ 0.5 expected, got ${wt.baselinePerWindow}`,
  );
  assert.ok(wt.ratio !== null && wt.ratio >= 3, `ratio must be ≥3, got ${wt.ratio}`);
  assert.ok(
    (wt.triggered ?? "") === "ratio" || (wt.triggered ?? "") === "absolute_and_ratio",
    `triggered must include ratio, got ${wt.triggered}`,
  );

  // ── (e) preview path is side-effect-free ─────────────────────────────
  // Re-use the seeded whisper_timeout spike from (b). The watcher's
  // cache is still warm from that ratio alert; calling the dry-run
  // path must NOT touch the dispatcher and must NOT change the
  // cooldown cache (so a subsequent live tick that grows further can
  // still re-alert as normal).
  const callsD: DispatchCall[] = [];
  const restoreD = await installDispatcherStub(callsD);
  const preview = await watcher.checkCallAnalysisFailureSpikes(nowB, {
    dryRun: true,
  });
  restoreD();
  assert.equal(callsD.length, 0, "dry-run preview must NOT call the dispatcher");
  const previewWt = preview.reasons.find((r) => r.reason === REASON_WHISPER)!;
  assert.equal(
    previewWt.decision,
    "alerted",
    "dry-run preview must report what WOULD alert as 'alerted'",
  );

  await cleanup();
  console.log("call-analysis-failure-spike-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {}
    process.exitCode = 1;
  });
