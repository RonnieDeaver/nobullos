/* test-registration
{
  "name": "Call-archive backlog alerts (Task #1088)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1088 regression tests for `callArchiveBacklogAlerts`.
 *
 * Mirrors the structure of `tests/queue-drain-backlog-alerts.test.ts` and
 * exercises the watcher's threshold, cooldown, growth-since-last-alert,
 * disabled, dispatcher-skipped, and admin-"Stuck"-parity paths.
 *
 * The dispatcher is stubbed via `__testHelpers.setDispatcherForTests` so
 * no Slack/email goes out. `resetLastAlertCache` is invoked between cases
 * to clear the watcher's per-bucket cooldown bookkeeping.
 *
 * The watcher counts the ENTIRE `twilio_calls` table, not just the rows
 * this test inserts. To stay robust against pre-existing dev data we
 * snapshot the baseline counts up front and configure the watcher's
 * thresholds as `baseline + 5`. All assertions are written in terms of
 * deltas so the test is reliable on any DB state.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkCallArchiveBacklog,
  SETTING_ENABLED,
  SETTING_PENDING_HOURS,
  SETTING_PENDING_COUNT,
  SETTING_FAILED_LOOKBACK_HOURS,
  SETTING_FAILED_COUNT,
  SETTING_COOLDOWN,
  pendingStuckWhere,
  recentFailuresWhere,
} from "../server/services/callArchiveBacklogAlerts";
import { MAX_ATTEMPTS } from "../server/services/callArchivePipeline";

const MARKER = `t1088_${process.pid}_${Date.now()}`;
const FROM = `+1555${String(process.pid).slice(-4).padStart(4, "0")}`;

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_PENDING_HOURS,
  SETTING_PENDING_COUNT,
  SETTING_FAILED_LOOKBACK_HOURS,
  SETTING_FAILED_COUNT,
  SETTING_COOLDOWN,
] as const;

const PENDING_HOURS = 1;
const FAILED_LOOKBACK_HOURS = 24;
const GROWTH = 5;

interface CountRow { n: number }
interface IdRow { id: string }

function firstRow<T>(result: { rows?: unknown[] }): T | undefined {
  return result.rows?.[0] as T | undefined;
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM twilio_calls WHERE from_number = ${FROM}`);
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
}

async function countBaseline(): Promise<{ pending: number; failed: number }> {
  const p = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM twilio_calls WHERE ${pendingStuckWhere(PENDING_HOURS)}
  `);
  const f = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM twilio_calls WHERE ${recentFailuresWhere(FAILED_LOOKBACK_HOURS)}
  `);
  return {
    pending: Number(firstRow<CountRow>(p)?.n ?? 0),
    failed: Number(firstRow<CountRow>(f)?.n ?? 0),
  };
}

interface PendingRowOpts {
  ageHours: number;
  recordingUrl?: string | null;
  recordingSid?: string | null;
}
async function insertPending(opts: PendingRowOpts): Promise<string> {
  const tag = `${MARKER}_p_${Math.random().toString(36).slice(2)}`;
  const r = await workerDb.execute(sql`
    INSERT INTO twilio_calls
      (direction, from_number, to_number, status, archive_status, archive_attempts,
       recording_url, recording_sid, twilio_sid, created_at, updated_at)
    VALUES
      ('inbound', ${FROM}, '+15550000000', 'completed', 'pending', 0,
       ${opts.recordingUrl ?? null}, ${opts.recordingSid ?? null}, ${tag},
       NOW() - (${opts.ageHours} || ' hours')::interval,
       NOW() - (${opts.ageHours} || ' hours')::interval)
    RETURNING id
  `);
  return String(firstRow<IdRow>(r)?.id ?? "");
}

interface FailedRowOpts {
  attempts: number;
  updatedAgoHours: number;
}
async function insertFailed(opts: FailedRowOpts): Promise<string> {
  const tag = `${MARKER}_f_${Math.random().toString(36).slice(2)}`;
  const r = await workerDb.execute(sql`
    INSERT INTO twilio_calls
      (direction, from_number, to_number, status, archive_status, archive_attempts, twilio_sid,
       created_at, updated_at)
    VALUES
      ('inbound', ${FROM}, '+15550000000', 'completed', 'failed', ${opts.attempts}, ${tag},
       NOW() - (${opts.updatedAgoHours} || ' hours')::interval - interval '1 hour',
       NOW() - (${opts.updatedAgoHours} || ' hours')::interval)
    RETURNING id
  `);
  return String(firstRow<IdRow>(r)?.id ?? "");
}

async function clearOurRows(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM twilio_calls WHERE from_number = ${FROM}`);
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}
function installDispatcherStub(
  calls: DispatchCall[],
  outcome: { delivered: boolean; status?: string; skipReason?: string } = { delivered: true },
): () => void {
  __testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    calls.push({ id, text: payload.text, metadata: opts.metadata });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "skipped"),
      skipReason: outcome.skipReason,
    };
  });
  return () => __testHelpers.setDispatcherForTests(null);
}

async function configure(thresholds: { pending: number; failed: number }, overrides: Partial<Record<(typeof SETTING_KEYS)[number], string>> = {}): Promise<void> {
  const defaults: Record<(typeof SETTING_KEYS)[number], string> = {
    [SETTING_ENABLED]: "true",
    [SETTING_PENDING_HOURS]: String(PENDING_HOURS),
    [SETTING_PENDING_COUNT]: String(thresholds.pending),
    [SETTING_FAILED_LOOKBACK_HOURS]: String(FAILED_LOOKBACK_HOURS),
    [SETTING_FAILED_COUNT]: String(thresholds.failed),
    [SETTING_COOLDOWN]: "60",
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    await storage.setSystemSetting(k, v);
  }
}

function bucketDecision(
  r: { buckets: Array<{ bucket: string; decision: string; count: number; threshold: number; skipReason?: string }> },
  bucket: string,
) {
  return r.buckets.find((b) => b.bucket === bucket);
}

async function run(): Promise<void> {
  await cleanup();
  const baseline = await countBaseline();
  // Make our thresholds well above baseline so test deltas are decisive.
  const TP = baseline.pending + GROWTH;
  const TF = baseline.failed + GROWTH;

  // ── (1) threshold not met → no alert ────────────────────────────────
  __testHelpers.resetLastAlertCache();
  await configure({ pending: TP, failed: TF });
  // Add only +2 to each bucket (baseline+2 < baseline+5).
  for (let i = 0; i < 2; i++) await insertPending({ ageHours: 3 });
  for (let i = 0; i < 2; i++) await insertFailed({ attempts: MAX_ATTEMPTS, updatedAgoHours: 1 });

  let calls: DispatchCall[] = [];
  let restore = installDispatcherStub(calls);
  let r = await checkCallArchiveBacklog();
  assert.equal(r.alertsSent, 0, "(1) no alert when both buckets are below threshold");
  assert.equal(calls.length, 0, "(1) dispatcher must not be called");
  assert.equal(bucketDecision(r, "pending_stuck")?.decision, "skipped_below_threshold");
  assert.equal(bucketDecision(r, "recent_failures")?.decision, "skipped_below_threshold");
  restore();
  await clearOurRows();

  // ── (2) threshold met → both buckets alert ─────────────────────────
  __testHelpers.resetLastAlertCache();
  for (let i = 0; i < GROWTH; i++) await insertPending({ ageHours: 3 });
  for (let i = 0; i < GROWTH; i++) await insertFailed({ attempts: MAX_ATTEMPTS, updatedAgoHours: 1 });

  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveBacklog();
  assert.equal(r.alertsSent, 2, "(2) both buckets must alert when at threshold");
  assert.equal(calls.length, 2, "(2) dispatcher called once per bucket");
  assert.deepEqual(
    new Set(calls.map((c) => (c.metadata as { bucket?: string } | undefined)?.bucket)),
    new Set(["pending_stuck", "recent_failures"]),
  );
  assert.equal(calls[0]!.id, "queue.call_recording_archive.backlog_or_failures");
  restore();

  // ── (3) cooldown honoured → no re-alert when count is unchanged ────
  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveBacklog();
  assert.equal(r.alertsSent, 0, "(3) no re-alert during cooldown when counts unchanged");
  assert.equal(calls.length, 0);
  assert.equal(bucketDecision(r, "pending_stuck")?.decision, "skipped_no_growth_since_last_alert");
  assert.equal(bucketDecision(r, "recent_failures")?.decision, "skipped_no_growth_since_last_alert");
  restore();

  // ── (4) growth-since-last-alert ≥ threshold → re-fires inside cooldown ─
  // Drop the threshold to 1 so adding a single row past the last-alert
  // snapshot satisfies `growth >= threshold` regardless of baseline.
  // The cooldown is still 60min so any re-fire here proves the
  // growth-since-last branch is what unblocked the dispatcher (not
  // cooldown expiry).
  await storage.setSystemSetting(SETTING_PENDING_COUNT, "1");
  await storage.setSystemSetting(SETTING_FAILED_COUNT, "1");
  // Live-worker race: the call-archive worker can drain real
  // pending/failed rows between scenarios (2) and (4), shifting the
  // baseline downward. Insert GROWTH rows (not 1) so the growth-since-
  // last delta exceeds the threshold even if a few live rows drained.
  for (let i = 0; i < GROWTH; i++) await insertPending({ ageHours: 3 });
  for (let i = 0; i < GROWTH; i++) await insertFailed({ attempts: MAX_ATTEMPTS, updatedAgoHours: 1 });
  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveBacklog();
  assert.equal(r.alertsSent, 2, "(4) growth-since-last ≥ threshold must re-fire both buckets");
  assert.equal(calls.length, 2);
  restore();
  await clearOurRows();

  // ── (5) disabled flag short-circuits → counts surfaced, no dispatch ─
  __testHelpers.resetLastAlertCache();
  await configure({ pending: TP, failed: TF }, { [SETTING_ENABLED]: "false" });
  // Add enough rows to push BOTH buckets over threshold so we can prove
  // the disabled flag (not the count) is what suppressed the alert.
  for (let i = 0; i < GROWTH; i++) await insertPending({ ageHours: 3 });
  for (let i = 0; i < GROWTH; i++) await insertFailed({ attempts: MAX_ATTEMPTS, updatedAgoHours: 1 });

  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveBacklog();
  assert.equal(r.enabled, false, "(5) result must reflect disabled flag");
  assert.equal(r.alertsSent, 0, "(5) no alerts when disabled");
  assert.equal(calls.length, 0, "(5) dispatcher must not be called when disabled");
  const pendingDisabled = bucketDecision(r, "pending_stuck");
  const failedDisabled = bucketDecision(r, "recent_failures");
  assert.equal(pendingDisabled?.decision, "skipped_disabled");
  assert.equal(failedDisabled?.decision, "skipped_disabled");
  // Counts should still be surfaced (>= threshold proves the buckets
  // would have alerted if enabled).
  assert.ok(
    (pendingDisabled?.count ?? 0) >= TP,
    `(5) pending count surfaced even when disabled (got ${pendingDisabled?.count}, expected >= ${TP})`,
  );
  assert.ok(
    (failedDisabled?.count ?? 0) >= TF,
    `(5) failed count surfaced even when disabled (got ${failedDisabled?.count}, expected >= ${TF})`,
  );
  restore();
  await clearOurRows();

  // ── (6) dispatcher reports skipped → decision is skipped_dispatcher_skipped ─
  __testHelpers.resetLastAlertCache();
  await configure({ pending: TP, failed: TF });
  for (let i = 0; i < GROWTH; i++) await insertPending({ ageHours: 3 });

  calls = [];
  restore = installDispatcherStub(calls, { delivered: false, status: "deduped", skipReason: "deduped_recent" });
  r = await checkCallArchiveBacklog();
  assert.equal(r.alertsSent, 0, "(6) dispatcher-skipped must not count as alert");
  // Pending bucket exceeded threshold so dispatcher was called for it;
  // failed bucket may or may not be over baseline-only threshold.
  const pendingSkipped = bucketDecision(r, "pending_stuck");
  assert.equal(pendingSkipped?.decision, "skipped_dispatcher_skipped");
  assert.equal(pendingSkipped?.skipReason, "deduped_recent");
  assert.ok(calls.length >= 1, "(6) dispatcher called at least once for the over-threshold bucket");
  restore();
  await clearOurRows();

  // ── (7) pending-bucket query parity with admin "Stuck" tile ────────
  // The watcher must ONLY count pending rows where BOTH recording_url
  // AND recording_sid are NULL — same predicate as the admin endpoint
  // GET /api/admin/twilio/call-archive's `(archive_status='pending'
  //   AND recording_url IS NULL AND recording_sid IS NULL)` filter.
  __testHelpers.resetLastAlertCache();
  await configure({ pending: TP, failed: TF + 1000 /* keep failed bucket quiet */ });
  // 1 truly-stuck row (no url, no sid, old)
  await insertPending({ ageHours: 3 });
  // Rows that should NOT be counted as "stuck" (have recording metadata):
  await insertPending({ ageHours: 3, recordingUrl: "https://example.com/r1.wav" });
  await insertPending({ ageHours: 3, recordingSid: "RE_test_sid" });
  await insertPending({ ageHours: 3, recordingUrl: "https://example.com/r2.wav", recordingSid: "RE_test_sid_2" });
  // And a fresh row younger than the age threshold
  await insertPending({ ageHours: 0 });

  // Admin "Stuck" SQL (without the watcher's age clause) should see
  // exactly the two null-url+null-sid rows from our fixture.
  const adminStuckRes = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE from_number = ${FROM}
      AND archive_status = 'pending'
      AND recording_url IS NULL
      AND recording_sid IS NULL
  `);
  const adminStuckCount = Number(firstRow<CountRow>(adminStuckRes)?.n ?? 0);
  assert.equal(adminStuckCount, 2, "(7) admin Stuck SQL must see both null-url/null-sid pending rows from the fixture");

  // Watcher's exported predicate scopes to the same null checks PLUS the
  // age clause, so it should see exactly one of our fixture rows.
  const watcherCountRes = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE from_number = ${FROM} AND ${pendingStuckWhere(PENDING_HOURS)}
  `);
  const watcherCount = Number(firstRow<CountRow>(watcherCountRes)?.n ?? 0);
  assert.equal(watcherCount, 1, "(7) watcher predicate excludes rows with recording metadata or fresh rows");

  await clearOurRows();
  await cleanup();
  console.log("call-archive-backlog-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch {}
    process.exitCode = 1;
  });
