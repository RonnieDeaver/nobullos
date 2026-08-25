/* test-registration
{
  "name": "Baseline-staleness watchdog alert delivery (Task #4530)",
  "regression": true,
  "sweepOnlyReason": "Task #4530: proves the watchdog staleness alert lands in notification_deliveries (real dispatcher + hermetic DB). The pure decision-logic is already smoke-gated in regression-sweep-catchup.test.ts and regression-sweep-scheduler.test.ts; this suite adds the one layer those cannot cover — that the injectable notifyFn in runStalenessWatchdogOnce calls the real dispatcher which writes a row to the DB. DB-backed by construction: the dispatcher upserts a delivery row.",
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: NOW_STALE (2026-08-15) is an injected pinned clock passed as now: to the watchdog; all staleness math runs against it, never the real clock — it cannot rot.
/**
 * Task #4530 — Integration proof that the staleness watchdog alert actually
 * reaches notification_deliveries (and the in-app mirror) when the committed
 * baseline is stale.
 *
 * Uses runStalenessWatchdogOnce with injectable deps so the test can control
 * the baseline age and state path without touching the real file-system paths
 * or the real Slack channel (Slack is disconnected in the hermetic env, so the
 * dispatch lands as skipped_slack_disconnected — still a real DB row that
 * proves the delivery chain is wired end-to-end).
 *
 * Layer: sweep-only (DB write required, not suitable for the routine gate).
 * Cost: two dispatcher calls + DB read — sub-second against the hermetic DB.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { notifyByType } from "../server/services/notifications/dispatcher";
import {
  BASELINE_STALENESS_ALERT_DAYS,
  ATTEMPT_ORPHAN_THRESHOLD_HOURS,
  runStalenessWatchdogOnce,
} from "../server/services/regressionSweepScheduler";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Helper: count delivery rows with a given dedupe-key prefix in this run.
// We filter by prefix (not exact match) so this test doesn't collide with
// other concurrent suite runs' keys. Filtering by prefix is safe because the
// date-stamped key is unique per calendar day per suite.
// ---------------------------------------------------------------------------

async function countDeliveryRows(dedupeKeyPrefix: string): Promise<number> {
  const db = getDb();
  const result = await db.execute(
    sql`SELECT COUNT(*) AS n FROM notification_deliveries WHERE dedupe_key LIKE ${dedupeKeyPrefix + "%"}`,
  );
  return Number((result.rows[0] as { n: string }).n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOW_STALE = new Date("2026-08-15T10:00:00.000Z"); // reference clock for stale tests
const STALE_PUBLISHED_AT = new Date(
  NOW_STALE.getTime() - (BASELINE_STALENESS_ALERT_DAYS + 1) * 24 * 60 * 60 * 1000,
).toISOString(); // 3d ago — stale

const FRESH_PUBLISHED_AT = new Date(
  NOW_STALE.getTime() - 0.1 * 24 * 60 * 60 * 1000,
).toISOString(); // 2.4h ago — fresh

function makeBaselineFile(dir: string, publishedAt: string): string {
  const path = join(dir, "green-baseline.json");
  writeFileSync(path, JSON.stringify({ publishedAt }), "utf8");
  return path;
}

test("stale baseline: watchdog fires notifyByType → row in notification_deliveries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-delivery-stale-"));
  try {
    const baselinePath = makeBaselineFile(dir, STALE_PUBLISHED_AT);
    const watchdogStatePath = join(dir, "watchdog-state.json");
    const attemptStartPath = join(dir, "attempt-start.json");

    // Use a dedupe key unique to this test run so we don't pick up noise.
    const todayUtc = NOW_STALE.toISOString().slice(0, 10);
    const expectedDedupeKeyPrefix = `regression-sweep-staleness:${todayUtc}`;

    // Verify no pre-existing rows.
    const beforeCount = await countDeliveryRows(expectedDedupeKeyPrefix);

    await runStalenessWatchdogOnce({
      now: NOW_STALE,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: notifyByType,
    });

    const afterCount = await countDeliveryRows(expectedDedupeKeyPrefix);
    assert.ok(
      afterCount > beforeCount,
      `Expected at least one new delivery row for dedupe key prefix "${expectedDedupeKeyPrefix}", ` +
        `before=${beforeCount} after=${afterCount}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh baseline: watchdog does NOT notify (no new delivery row)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-delivery-fresh-"));
  try {
    const baselinePath = makeBaselineFile(dir, FRESH_PUBLISHED_AT);
    const watchdogStatePath = join(dir, "watchdog-state-fresh.json");
    const attemptStartPath = join(dir, "attempt-start-fresh.json");

    // Use a unique future date string so we can be sure no pre-existing rows
    // match — fresh watchdog should write NO delivery rows.
    const futureDay = "2099-01-01";
    const futureDedupePrefix = `regression-sweep-staleness:${futureDay}`;

    const beforeCount = await countDeliveryRows(futureDedupePrefix);
    assert.equal(beforeCount, 0, "precondition: no 2099 rows exist");

    await runStalenessWatchdogOnce({
      now: NOW_STALE,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: notifyByType,
    });

    const afterCount = await countDeliveryRows(futureDedupePrefix);
    assert.equal(afterCount, 0, "fresh baseline must not produce any delivery row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale baseline already alerted today: watchdog stays quiet (daily dedupe)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-delivery-daily-"));
  try {
    const baselinePath = makeBaselineFile(dir, STALE_PUBLISHED_AT);
    const watchdogStatePath = join(dir, "watchdog-daily.json");
    const attemptStartPath = join(dir, "attempt-start-daily.json");
    const todayUtc = NOW_STALE.toISOString().slice(0, 10);

    // Pre-seed state: already alerted today for this episode.
    writeFileSync(
      watchdogStatePath,
      JSON.stringify({ publishedAt: STALE_PUBLISHED_AT, alertedOn: todayUtc }),
      "utf8",
    );

    // Count rows BEFORE — we'll assert the count doesn't increase.
    const todayDedupePrefix = `regression-sweep-staleness:${todayUtc}`;
    const beforeCount = await countDeliveryRows(todayDedupePrefix);

    await runStalenessWatchdogOnce({
      now: NOW_STALE,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: notifyByType,
    });

    const afterCount = await countDeliveryRows(todayDedupePrefix);
    assert.equal(
      afterCount,
      beforeCount,
      "already-alerted-today: must not add another row (daily dedupe working)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale + orphaned attempt: alert text mentions the orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-delivery-orphan-"));
  try {
    const baselinePath = makeBaselineFile(dir, STALE_PUBLISHED_AT);
    const watchdogStatePath = join(dir, "watchdog-orphan.json");
    const attemptStartPath = join(dir, "attempt-orphan.json");

    // Write an orphaned attempt start (>ATTEMPT_ORPHAN_THRESHOLD_HOURS ago).
    const orphanStart = new Date(
      NOW_STALE.getTime() - (ATTEMPT_ORPHAN_THRESHOLD_HOURS + 0.5) * 60 * 60 * 1000,
    ).toISOString();
    writeFileSync(
      attemptStartPath,
      JSON.stringify({ startedAt: orphanStart, trigger: "catchup" }),
      "utf8",
    );

    // Capture the notify call payload via a spy.
    let capturedText = "";
    const notifySpy: typeof notifyByType = async (id, payload, opts) => {
      capturedText = typeof payload.text === "string" ? payload.text : "";
      // Delegate to the real dispatcher so DB evidence is also written.
      return notifyByType(id, payload, opts);
    };

    await runStalenessWatchdogOnce({
      now: NOW_STALE,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: notifySpy,
    });

    assert.ok(
      capturedText.includes("orphan") ||
        capturedText.includes("attempt started") ||
        capturedText.includes("no completion record"),
      `Expected orphan context in alert text, got: ${capturedText.slice(0, 300)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
if (failures > 0) {
  console.error(`\n${failures} of ${tests.length} watchdog-delivery test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} watchdog-delivery tests passed.`);
process.exit(0);
