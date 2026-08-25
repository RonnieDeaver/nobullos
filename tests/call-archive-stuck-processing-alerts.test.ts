/* test-registration
{
  "name": "Call-archive stuck-processing alerts (Task #1098)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1098 regression tests for `callArchiveStuckProcessingAlerts`.
 *
 * Mirrors the structure of `tests/call-archive-backlog-alerts.test.ts` and
 * exercises the watcher's threshold, cooldown, growth-since-last-alert,
 * disabled, dispatcher-skipped, and predicate-parity paths.
 *
 * The dispatcher is stubbed via `__testHelpers.setDispatcherForTests` so
 * no Slack/email goes out. `resetLastAlertCache` is invoked between cases
 * to clear the watcher's cooldown bookkeeping.
 *
 * The watcher counts the ENTIRE `twilio_calls` table, not just the rows
 * this test inserts. To stay robust against pre-existing dev data we
 * snapshot the baseline count up front and configure the watcher's
 * threshold as `baseline + 5`. All assertions are written in terms of
 * deltas so the test is reliable on any DB state.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkCallArchiveStuckProcessing,
  SETTING_ENABLED,
  SETTING_AGE_MINUTES,
  SETTING_COUNT,
  SETTING_COOLDOWN,
  stuckProcessingWhere,
} from "../server/services/callArchiveStuckProcessingAlerts";

const MARKER = `t1098_${process.pid}_${Date.now()}`;
const FROM = `+1556${String(process.pid).slice(-4).padStart(4, "0")}`;

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_AGE_MINUTES,
  SETTING_COUNT,
  SETTING_COOLDOWN,
] as const;

const AGE_MINUTES = 5;
const GROWTH = 5;

interface CountRow { n: number }
interface IdRow { id: string }

function firstRow<T>(result: { rows?: unknown[] }): T | undefined {
  return result.rows?.[0] as T | undefined;
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM twilio_calls WHERE from_number = ${FROM}`);
  for (const k of SETTING_KEYS) {
    try { await storage.deleteSystemSetting(k); } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
}

async function countBaseline(): Promise<number> {
  const r = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM twilio_calls WHERE ${stuckProcessingWhere(AGE_MINUTES)}
  `);
  return Number(firstRow<CountRow>(r)?.n ?? 0);
}

interface StuckRowOpts {
  /** Minutes ago that the lease was released (archive_locked_until = NOW() - this). */
  leaseReleasedMinutesAgo: number;
}
async function insertStuck(opts: StuckRowOpts): Promise<string> {
  const tag = `${MARKER}_s_${Math.random().toString(36).slice(2)}`;
  const r = await workerDb.execute(sql`
    INSERT INTO twilio_calls
      (direction, from_number, to_number, status, archive_status, archive_attempts,
       twilio_sid, archive_locked_until, created_at, updated_at)
    VALUES
      ('inbound', ${FROM}, '+15550000000', 'completed', 'processing', 1, ${tag},
       NOW() - (${opts.leaseReleasedMinutesAgo} || ' minutes')::interval,
       NOW() - interval '1 hour',
       NOW() - (${opts.leaseReleasedMinutesAgo} || ' minutes')::interval)
    RETURNING id
  `);
  return String(firstRow<IdRow>(r)?.id ?? "");
}

/** Active processing row whose lease has NOT been released yet. */
async function insertActive(): Promise<string> {
  const tag = `${MARKER}_a_${Math.random().toString(36).slice(2)}`;
  const r = await workerDb.execute(sql`
    INSERT INTO twilio_calls
      (direction, from_number, to_number, status, archive_status, archive_attempts,
       twilio_sid, archive_locked_until, created_at, updated_at)
    VALUES
      ('inbound', ${FROM}, '+15550000000', 'completed', 'processing', 1, ${tag},
       NOW() + interval '5 minutes',
       NOW() - interval '1 hour',
       NOW() - interval '1 minute')
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

async function configure(
  threshold: number,
  overrides: Partial<Record<(typeof SETTING_KEYS)[number], string>> = {},
): Promise<void> {
  const defaults: Record<(typeof SETTING_KEYS)[number], string> = {
    [SETTING_ENABLED]: "true",
    [SETTING_AGE_MINUTES]: String(AGE_MINUTES),
    [SETTING_COUNT]: String(threshold),
    [SETTING_COOLDOWN]: "60",
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    await storage.setSystemSetting(k, v);
  }
}

async function run(): Promise<void> {
  await cleanup();
  const baseline = await countBaseline();
  const T = baseline + GROWTH;

  // ── (1) threshold not met → no alert ────────────────────────────────
  __testHelpers.resetLastAlertCache();
  await configure(T);
  for (let i = 0; i < 2; i++) await insertStuck({ leaseReleasedMinutesAgo: 30 });

  let calls: DispatchCall[] = [];
  let restore = installDispatcherStub(calls);
  let r = await checkCallArchiveStuckProcessing();
  assert.equal(r.alertsSent, 0, "(1) no alert when count < threshold");
  assert.equal(calls.length, 0, "(1) dispatcher must not be called");
  assert.equal(r.decision, "skipped_below_threshold");
  restore();
  await clearOurRows();

  // ── (2) threshold met → alert fires ─────────────────────────────────
  __testHelpers.resetLastAlertCache();
  for (let i = 0; i < GROWTH; i++) await insertStuck({ leaseReleasedMinutesAgo: 30 });

  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveStuckProcessing();
  assert.equal(r.alertsSent, 1, "(2) alert must fire when count >= threshold");
  assert.equal(calls.length, 1, "(2) dispatcher called once");
  assert.equal(calls[0]!.id, "queue.call_recording_archive.stuck_processing");
  assert.equal((calls[0]!.metadata as { ageMinutes?: number } | undefined)?.ageMinutes, AGE_MINUTES);
  restore();

  // ── (3) cooldown honoured → no re-alert when count is unchanged ─────
  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveStuckProcessing();
  assert.equal(r.alertsSent, 0, "(3) no re-alert during cooldown when count unchanged");
  assert.equal(calls.length, 0);
  assert.equal(r.decision, "skipped_no_growth_since_last_alert");
  restore();

  // ── (4) growth-since-last-alert ≥ threshold → re-fires inside cooldown ─
  // Drop threshold to 1 so adding a single row past the last-alert
  // snapshot satisfies `growth >= threshold`.
  await storage.setSystemSetting(SETTING_COUNT, "1");
  await insertStuck({ leaseReleasedMinutesAgo: 30 });
  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveStuckProcessing();
  assert.equal(r.alertsSent, 1, "(4) growth-since-last ≥ threshold must re-fire");
  assert.equal(calls.length, 1);
  restore();
  await clearOurRows();

  // ── (5) disabled flag short-circuits → count surfaced, no dispatch ──
  __testHelpers.resetLastAlertCache();
  await configure(T, { [SETTING_ENABLED]: "false" });
  for (let i = 0; i < GROWTH; i++) await insertStuck({ leaseReleasedMinutesAgo: 30 });

  calls = [];
  restore = installDispatcherStub(calls);
  r = await checkCallArchiveStuckProcessing();
  assert.equal(r.enabled, false, "(5) result must reflect disabled flag");
  assert.equal(r.alertsSent, 0, "(5) no alerts when disabled");
  assert.equal(calls.length, 0, "(5) dispatcher must not be called when disabled");
  assert.equal(r.decision, "skipped_disabled");
  assert.ok(
    r.count >= T,
    `(5) count surfaced even when disabled (got ${r.count}, expected >= ${T})`,
  );
  restore();
  await clearOurRows();

  // ── (6) dispatcher reports skipped → decision is skipped_dispatcher_skipped ─
  __testHelpers.resetLastAlertCache();
  await configure(T);
  for (let i = 0; i < GROWTH; i++) await insertStuck({ leaseReleasedMinutesAgo: 30 });

  calls = [];
  restore = installDispatcherStub(calls, { delivered: false, status: "deduped", skipReason: "deduped_recent" });
  r = await checkCallArchiveStuckProcessing();
  assert.equal(r.alertsSent, 0, "(6) dispatcher-skipped must not count as alert");
  assert.equal(r.decision, "skipped_dispatcher_skipped");
  assert.equal(r.skipReason, "deduped_recent");
  assert.equal(calls.length, 1, "(6) dispatcher called once");
  restore();
  await clearOurRows();

  // ── (7) predicate parity — only counts processing rows whose lease
  //         has been released for ≥ ageMinutes ──────────────────────────
  __testHelpers.resetLastAlertCache();
  await configure(1);
  // 1 truly-stuck row (lease released 30m ago, well past the 5m threshold)
  await insertStuck({ leaseReleasedMinutesAgo: 30 });
  // Row whose lease was released only 1 minute ago — under the 5m threshold
  await insertStuck({ leaseReleasedMinutesAgo: 1 });
  // Active row whose lease is still in the future — must not be counted
  await insertActive();

  const watcherCountRes = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE from_number = ${FROM} AND ${stuckProcessingWhere(AGE_MINUTES)}
  `);
  const watcherCount = Number(firstRow<CountRow>(watcherCountRes)?.n ?? 0);
  assert.equal(
    watcherCount,
    1,
    "(7) watcher predicate must count only the row whose lease has been released ≥ ageMinutes",
  );

  await clearOurRows();
  await cleanup();
  console.log("call-archive-stuck-processing-alerts.test.ts: OK");
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
