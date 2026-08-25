/* test-registration
{
  "name": "Front webhook receiver-staleness watcher (Task #1606)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1606 regression coverage for the Front webhook receiver-staleness
 * watcher added in Task #1602
 * (`server/services/frontWebhookReceiverStalenessAlerts.ts`).
 *
 * Locks the following behavior in place against future refactors:
 *
 * 5. Fresh `source_event_log` activity → watcher skips (no alert).
 * 6. Stale `source_event_log` activity → watcher alerts exactly once and
 *    records `lastAlert`.
 * 7. Cooldown blocks duplicate alerts inside the cooldown window; after the
 *    cooldown expires the watcher fires again.
 * 8. No Front rows at all → watcher does not spam (decision is
 *    `skipped_below_threshold`).
 * 9. Dispatcher-skip (e.g. Slack auth breaker open) does NOT arm `lastAlert`,
 *    so the next tick after Slack recovers still delivers the alert.
 *
 * Task #3993 rework — staleness now keys on WEBHOOK-ORIGIN rows only
 * (`dedupe_key LIKE 'front:webhook:%'`):
 *
 * 10. A fresh reconcile/polling row does NOT mask a stale webhook row —
 *     the exact failure mode that hid a receiver which never worked.
 * 11. Never-validated era: Front polling activity exists but zero webhook
 *     rows have ever landed → distinct `alerted_never_validated` alert on
 *     its own (longer) cooldown; no Front rows at all → quiet
 *     (`skipped_no_front_activity`).
 *
 * Uses the existing `__testHelpers.{resetLastAlertCache,setDispatcherForTests}`
 * seams from the watcher module — no new production hooks are added.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkFrontWebhookReceiverStaleness,
  SETTING_COOLDOWN_MINUTES,
  SETTING_ENABLED,
  SETTING_NEVER_VALIDATED_COOLDOWN_MINUTES,
  SETTING_THRESHOLD_MINUTES,
} from "../server/services/frontWebhookReceiverStalenessAlerts";

const MARKER = `t1606_front_${process.pid}_${Date.now()}`;
/**
 * Tag used by Group 8 to temporarily rename all existing
 * `source_system='front'` rows so the watcher's `MAX(received_at) IS NULL`
 * branch becomes reachable. A startup safety pass restores any rows still
 * tagged from a previously-crashed test run before this run starts, and a
 * `try/finally` restores them after the test. Worst case (process killed
 * mid-rename) the safety pass on the next run repairs the table.
 */
const GROUP_8_STASH_SOURCE = "__t1606_front_stash__";
const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_THRESHOLD_MINUTES,
  SETTING_COOLDOWN_MINUTES,
  SETTING_NEVER_VALIDATED_COOLDOWN_MINUTES,
] as const;

const THRESHOLD_MIN = 60;
const COOLDOWN_MIN = 360;

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function makeDispatcher(
  outcome: { delivered: boolean; status?: string; skipReason?: string } = {
    delivered: true,
    status: "success",
  },
): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "success" : "skipped_slack_disconnected"),
      skipReason: outcome.skipReason,
    };
  };
  return { fn, calls };
}

/** Wipe every Front-tagged row this test ever inserted (idempotent). */
async function deleteOurFrontRows(): Promise<void> {
  await workerDb.execute(sql`
    DELETE FROM source_event_log
    WHERE source_system = 'front'
      AND (dedupe_key LIKE ${`${MARKER}%`}
        OR dedupe_key LIKE ${`front:webhook:${MARKER}%`})
  `);
}

/**
 * The watcher's staleness grain (Task #3993) is
 * `MAX(received_at) WHERE source_system='front' AND dedupe_key LIKE
 * 'front:webhook:%'`. The dev workspace may already contain webhook rows,
 * so tests that control the latest-webhook-row age insert exactly one
 * webhook-keyed row guaranteed to be the newest one on that grain.
 */
async function insertWebhookRowAt(receivedAt: Date): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const dedupe = `front:webhook:${tag}`;
  await workerDb.execute(sql`
    INSERT INTO source_event_log
      (source_system, source_event_type, source_object_id, dedupe_key,
       payload_json, status, received_at, created_at, updated_at)
    VALUES
      ('front', 'test', ${tag}, ${dedupe},
       '{}'::jsonb, 'received', ${receivedAt.toISOString()},
       ${receivedAt.toISOString()}, ${receivedAt.toISOString()})
  `);
}

/** Non-webhook (reconcile/polling-shaped) Front row — must NOT count as freshness. */
async function insertPollingRowAt(receivedAt: Date): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  await workerDb.execute(sql`
    INSERT INTO source_event_log
      (source_system, source_event_type, source_object_id, dedupe_key,
       payload_json, status, received_at, created_at, updated_at)
    VALUES
      ('front', 'reconciliation_scan', ${tag}, ${tag},
       '{}'::jsonb, 'received', ${receivedAt.toISOString()},
       ${receivedAt.toISOString()}, ${receivedAt.toISOString()})
  `);
}

async function snapshotExistingMaxReceivedAt(): Promise<Date | null> {
  const r = await workerDb.execute(sql`
    SELECT MAX(received_at) AS latest FROM source_event_log
    WHERE source_system='front' AND dedupe_key LIKE 'front:webhook:%'
  `);
  const raw = ((r.rows?.[0] ?? null) as any)?.latest ?? null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Returns a `now` instant that is at least `ageMinutes` newer than every
 * existing Front row in the table. We then insert a single row at
 * `now - ageMinutes`, and the watcher's MAX(received_at) is guaranteed to
 * be that row.
 */
async function pickNowAndInsert(ageMinutes: number): Promise<{ now: number; latest: Date }> {
  const existingMax = await snapshotExistingMaxReceivedAt();
  // We want: latest > existingMax  AND  now - latest = ageMinutes.
  // So: now = max(Date.now(), existingMax + ageMinutes + 1min)
  const minNow = existingMax
    ? existingMax.getTime() + (ageMinutes + 1) * 60_000
    : Date.now();
  const now = Math.max(Date.now(), minNow);
  const latest = new Date(now - ageMinutes * 60_000);
  await insertWebhookRowAt(latest);
  return { now, latest };
}

async function configure(opts: {
  enabled?: boolean;
  thresholdMinutes?: number;
  cooldownMinutes?: number;
}): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(SETTING_ENABLED, opts.enabled ? "true" : "false", "system");
  }
  if (opts.thresholdMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_THRESHOLD_MINUTES,
      String(opts.thresholdMinutes),
      "system",
    );
  }
  if (opts.cooldownMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_COOLDOWN_MINUTES,
      String(opts.cooldownMinutes),
      "system",
    );
  }
}

async function resetAll(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
  await deleteOurFrontRows();
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

async function main(): Promise<void> {
  console.log("Front webhook receiver-staleness watcher regression (Task #1606)");

  // Startup safety pass: if a previous (crashed) run of this test left
  // Front rows renamed to the stash tag, repair them before doing anything
  // else. This makes the Group 8 rename/restore dance crash-safe.
  await workerDb.execute(sql`
    UPDATE source_event_log
    SET source_system = 'front'
    WHERE source_system = ${GROUP_8_STASH_SOURCE}
  `);

  // ── Group 5 ── fresh activity → no alert ─────────────────────────────
  await step("Group 5 — fresh receiver activity skips below threshold", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    // Insert a row that is 1 minute fresher than threshold.
    const { now } = await pickNowAndInsert(THRESHOLD_MIN - 1);
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(r.decision, "skipped_below_threshold", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(r.alertsSent, 0);
    assert.equal(calls.length, 0, "dispatcher must not be called when fresh");
  });

  // ── Group 6 ── stale activity → exactly one alert, lastAlert recorded ─
  await step("Group 6 — stale receiver activity alerts exactly once", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    const { now } = await pickNowAndInsert(THRESHOLD_MIN + 5);
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(r.decision, "alerted", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(r.alertsSent, 1);
    assert.equal(calls.length, 1, "dispatcher must be called exactly once");
    assert.equal(calls[0].id, __testHelpers.NOTIFICATION_ID);
    // Arming `lastAlert` is observable via Group 7 below — re-evaluating
    // immediately must now return skipped_cooldown.
    const r2 = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(r2.decision, "skipped_cooldown");
    assert.equal(calls.length, 1, "second tick inside cooldown must not dispatch");
  });

  // ── Group 7A ── cooldown blocks a duplicate inside the window ────────
  await step("Group 7A — second tick inside cooldown is skipped", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    const { now } = await pickNowAndInsert(THRESHOLD_MIN + 5);
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    const first = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(first.decision, "alerted");
    assert.equal(calls.length, 1);

    const insideCooldown = now + (COOLDOWN_MIN - 1) * 60_000;
    const second = await checkFrontWebhookReceiverStaleness(insideCooldown);
    assert.equal(second.decision, "skipped_cooldown", `decision=${second.decision}`);
    assert.match(second.skipReason ?? "", /cooldown/);
    assert.equal(calls.length, 1, "dispatcher must not be called twice within cooldown");
  });

  // ── Group 7B ── after cooldown expires the watcher fires again ───────
  await step("Group 7B — past the cooldown window the watcher fires again", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    const { now } = await pickNowAndInsert(THRESHOLD_MIN + 5);
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    const first = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(first.decision, "alerted");
    assert.equal(calls.length, 1);

    const past = now + (COOLDOWN_MIN + 1) * 60_000;
    const third = await checkFrontWebhookReceiverStaleness(past);
    assert.equal(third.decision, "alerted", `decision=${third.decision}`);
    assert.equal(calls.length, 2, "dispatcher must fire again once cooldown expires");
  });

  // ── Group 8 ── no Front rows at all → no spam ────────────────────────
  await step("Group 8 — no Front rows in the table → skipped_no_front_activity (null branch)", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    // Temporarily rename every existing source_system='front' row so the
    // watcher's MAX(received_at) returns NULL on BOTH grains. try/finally
    // guarantees the restore even on assertion failure; the startup safety
    // pass repairs any rows left tagged by a previously-crashed run.
    try {
      await workerDb.execute(sql`
        UPDATE source_event_log
        SET source_system = ${GROUP_8_STASH_SOURCE}
        WHERE source_system = 'front'
      `);

      const r = await checkFrontWebhookReceiverStaleness(Date.now());
      assert.equal(r.decision, "skipped_no_front_activity");
      assert.equal(r.mode, "none");
      assert.equal(r.ageMinutes, null, "ageMinutes must be null when no Front rows exist");
      assert.equal(r.latestReceivedAt, null);
      assert.equal(r.latestAnyReceivedAt, null);
      assert.match(r.skipReason ?? "", /no source_event_log rows/);
      assert.equal(calls.length, 0, "dispatcher must not be called when there is no history");
    } finally {
      await workerDb.execute(sql`
        UPDATE source_event_log
        SET source_system = 'front'
        WHERE source_system = ${GROUP_8_STASH_SOURCE}
      `);
    }
  });

  // ── Group 10 ── fresh polling row must NOT mask a stale webhook row ──
  await step("Group 10 — fresh reconcile/polling row does not mask webhook staleness", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    const { now } = await pickNowAndInsert(THRESHOLD_MIN + 5);
    // Fresh non-webhook Front row 1 minute before `now` — under the old
    // ALL-rows grain this would have suppressed the alert forever.
    await insertPollingRowAt(new Date(now - 60_000));
    const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkFrontWebhookReceiverStaleness(now);
    assert.equal(r.decision, "alerted", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(r.mode, "stale");
    assert.equal(r.alertsSent, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /webhook-origin/i);
    assert.match(calls[0].text, /polling is carrying sync/i);
  });

  // ── Group 11 ── never-validated era: polling alive, zero webhook rows ─
  await step(
    "Group 11 — polling activity with ZERO webhook rows ever → alerted_never_validated on its own cooldown",
    async () => {
      const NV_COOLDOWN = 24 * 60;
      await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
      await storage.setSystemSetting(
        SETTING_NEVER_VALIDATED_COOLDOWN_MINUTES,
        String(NV_COOLDOWN),
        "system",
      );
      const { fn, calls } = makeDispatcher({ delivered: true, status: "success" });
      __testHelpers.setDispatcherForTests(fn);

      // Stash any pre-existing webhook-origin rows so the webhook grain is
      // guaranteed empty (dev/shared DBs may contain real webhook rows once
      // the receiver fix ships). Reuses the same stash tag so the startup
      // and final safety passes repair a crashed run.
      try {
        await workerDb.execute(sql`
          UPDATE source_event_log
          SET source_system = ${GROUP_8_STASH_SOURCE}
          WHERE source_system = 'front' AND dedupe_key LIKE 'front:webhook:%'
        `);
        const now = Date.now();
        await insertPollingRowAt(new Date(now - 5 * 60_000));

        const r1 = await checkFrontWebhookReceiverStaleness(now);
        assert.equal(r1.decision, "alerted_never_validated", `decision=${r1.decision} skipReason=${r1.skipReason}`);
        assert.equal(r1.mode, "never_validated");
        assert.equal(r1.alertsSent, 1);
        assert.equal(r1.latestReceivedAt, null);
        assert.ok(r1.latestAnyReceivedAt, "polling activity must be surfaced");
        assert.equal(calls.length, 1);
        assert.match(calls[0].text, /NEVER been validated/i);
        assert.match(calls[0].text, /polling is carrying sync/i);

        // Inside the never-validated cooldown → skipped.
        const r2 = await checkFrontWebhookReceiverStaleness(now + (NV_COOLDOWN - 1) * 60_000);
        assert.equal(r2.decision, "skipped_cooldown", `decision=${r2.decision}`);
        assert.match(r2.skipReason ?? "", /never-validated cooldown/);
        assert.equal(calls.length, 1);

        // Past the cooldown → fires again (chronic state repeats daily).
        const r3 = await checkFrontWebhookReceiverStaleness(now + (NV_COOLDOWN + 1) * 60_000);
        assert.equal(r3.decision, "alerted_never_validated", `decision=${r3.decision}`);
        assert.equal(calls.length, 2);

        // First webhook row landing ends the era: fresh webhook row → clean skip.
        await insertWebhookRowAt(new Date(now - 60_000));
        __testHelpers.resetLastAlertCache();
        const r4 = await checkFrontWebhookReceiverStaleness(now);
        assert.equal(r4.decision, "skipped_below_threshold", `decision=${r4.decision}`);
        assert.equal(r4.mode, "stale");
        assert.equal(calls.length, 2);
      } finally {
        await workerDb.execute(sql`
          UPDATE source_event_log
          SET source_system = 'front'
          WHERE source_system = ${GROUP_8_STASH_SOURCE}
        `);
      }
    },
  );

  // ── Group 9 ── dispatcher-skip does NOT arm lastAlert ────────────────
  await step(
    "Group 9 — dispatcher-skip (Slack unavailable) does NOT set lastAlert; next call with healthy Slack delivers",
    async () => {
      await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
      const { now } = await pickNowAndInsert(THRESHOLD_MIN + 5);

      // First tick: dispatcher reports skipped (Slack auth breaker open).
      const skipped = makeDispatcher({
        delivered: false,
        status: "skipped_slack_disconnected",
        skipReason: "slack_breaker_open",
      });
      __testHelpers.setDispatcherForTests(skipped.fn);
      const r1 = await checkFrontWebhookReceiverStaleness(now);
      assert.equal(r1.decision, "skipped_dispatcher_skipped", `decision=${r1.decision}`);
      assert.equal(r1.alertsSent, 0);
      assert.equal(skipped.calls.length, 1, "dispatcher SHOULD have been called");
      assert.match(r1.skipReason ?? "", /slack|disconn/i);

      // Swap the dispatcher to a healthy one. Because the previous tick did
      // NOT arm `lastAlert`, the cooldown is not in play and this tick must
      // dispatch normally.
      const healthy = makeDispatcher({ delivered: true, status: "success" });
      __testHelpers.setDispatcherForTests(healthy.fn);
      // Use the SAME `now` so any cooldown effect would be visible.
      const r2 = await checkFrontWebhookReceiverStaleness(now);
      assert.equal(r2.decision, "alerted", `decision=${r2.decision} skipReason=${r2.skipReason}`);
      assert.equal(r2.alertsSent, 1);
      assert.equal(healthy.calls.length, 1, "healthy dispatcher must deliver after the skip");
    },
  );

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll Front webhook receiver-staleness regression tests passed");
}

main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Final safety pass: ensure no rows are left tagged with the Group 8
    // stash source_system, even if an assertion failure short-circuited
    // the per-test finally block before its UPDATE ran.
    try {
      await workerDb.execute(sql`
        UPDATE source_event_log
        SET source_system = 'front'
        WHERE source_system = ${GROUP_8_STASH_SOURCE}
      `);
    } catch {}
    // The shared test teardown in server/db.ts disables the pg-pool idle reaper
    // and unref's idle sockets in test mode, so the loop drains and the child
    // exits on its own once the finally settles — no manual process.exit() (Task #2084).
  });
