/* test-registration
{
  "name": "Front pipeline stuck-row alerts (Task #1642)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1642 regression coverage for the Front pipeline stuck-row
 * watcher (`server/services/frontPipelineStuckAlerts.ts`).
 *
 * Locks the following behavior in place:
 *
 * 1. No stuck rows → watcher skips below threshold (no dispatch).
 * 2. Stuck row in a non-terminal `pipeline_state` older than the
 *    threshold → watcher alerts exactly once and arms cooldown.
 * 3. Cooldown blocks duplicate alerts; after the cooldown expires
 *    the watcher fires again.
 * 4. Kill switch off → watcher returns `skipped_disabled` without
 *    querying or dispatching.
 * 5. Dispatcher-skip does NOT arm cooldown, so the next tick after
 *    Slack recovers still delivers.
 * 6. Rows in `applied` are ignored regardless of age.
 *
 * Task #1929 — runs inside `runInIsolatedSchema` so seeded
 * `front_sync_emails` rows live in a per-test schema invisible to the
 * live `Start application` workers. The watcher reads via `getDb()`
 * (Task #1929 service migration) so the override applies.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkFrontPipelineStuck,
  SETTING_AGE_MINUTES,
  SETTING_COOLDOWN_MINUTES,
  SETTING_ENABLED,
  SETTING_MIN_COUNT,
} from "../server/services/frontPipelineStuckAlerts";
import { runInIsolatedSchema } from "./db-sandbox";

const MARKER = `t1642_fps_${process.pid}_${Date.now()}`;

const AGE_MIN = 60;
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
      status: outcome.status ?? (outcome.delivered ? "success" : "skipped"),
      skipReason: outcome.skipReason,
    };
  };
  return { fn, calls };
}

async function insertStuckRow(
  isoDb: { execute: (q: any) => Promise<any> },
  opts: { pipelineState: string; ageMinutes: number },
): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.ageMinutes * 60_000).toISOString();
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (conversation_id, pipeline_state, match_status, state_changed_at, created_at)
    VALUES
      (${tag}, ${opts.pipelineState}, 'unmatched', ${ts}, ${ts})
  `);
}

async function configure(opts: {
  enabled?: boolean;
  ageMinutes?: number;
  minCount?: number;
  cooldownMinutes?: number;
}): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_ENABLED,
      opts.enabled ? "true" : "false",
      "system",
    );
  }
  if (opts.ageMinutes !== undefined) {
    await storage.setSystemSetting(SETTING_AGE_MINUTES, String(opts.ageMinutes), "system");
  }
  if (opts.minCount !== undefined) {
    await storage.setSystemSetting(SETTING_MIN_COUNT, String(opts.minCount), "system");
  }
  if (opts.cooldownMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_COOLDOWN_MINUTES,
      String(opts.cooldownMinutes),
      "system",
    );
  }
}

async function resetStuckRows(isoDb: { execute: (q: any) => Promise<any> }): Promise<void> {
  await isoDb.execute(sql`DELETE FROM front_sync_emails`);
}

async function resetInMemory(): Promise<void> {
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
}

let failures = 0;
async function step(
  isoDb: { execute: (q: any) => Promise<any> },
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  await resetInMemory();
  await resetStuckRows(isoDb);
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetInMemory();
    await resetStuckRows(isoDb);
  }
}

async function main(): Promise<void> {
  console.log("Front pipeline stuck-row watcher regression (Task #1642)");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await step(isoDb, "Group 1 — no stuck rows → skipped_below_threshold", async () => {
        await configure({
          enabled: true,
          ageMinutes: AGE_MIN,
          minCount: 1,
          cooldownMinutes: COOLDOWN_MIN,
        });
        // Insert a row that is fresher than the age threshold.
        await insertStuckRow(isoDb, { pipelineState: "discovered", ageMinutes: AGE_MIN - 5 });
        const { fn, calls } = makeDispatcher();
        __testHelpers.setDispatcherForTests(fn);

        const r = await checkFrontPipelineStuck(Date.now());
        assert.equal(r.decision, "skipped_below_threshold", `decision=${r.decision}`);
        assert.equal(r.totalStuck, 0);
        assert.equal(calls.length, 0);
      });

      await step(isoDb, "Group 2 — stuck row above threshold alerts exactly once", async () => {
        await configure({
          enabled: true,
          ageMinutes: AGE_MIN,
          minCount: 1,
          cooldownMinutes: COOLDOWN_MIN,
        });
        await insertStuckRow(isoDb, { pipelineState: "discovered", ageMinutes: AGE_MIN + 30 });
        const { fn, calls } = makeDispatcher();
        __testHelpers.setDispatcherForTests(fn);

        const r = await checkFrontPipelineStuck();
        assert.equal(r.decision, "alerted", `decision=${r.decision} skipReason=${r.skipReason}`);
        assert.ok(r.totalStuck >= 1, `totalStuck=${r.totalStuck}`);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].id, __testHelpers.NOTIFICATION_ID);
        assert.match(calls[0].text, /Front pipeline rows are stuck/);
        assert.match(calls[0].text, /discovered/);

        // Second immediate tick → cooldown.
        const r2 = await checkFrontPipelineStuck();
        assert.equal(r2.decision, "skipped_cooldown");
        assert.equal(calls.length, 1);
      });

      await step(isoDb, "Group 3 — after cooldown expires the watcher fires again", async () => {
        await configure({
          enabled: true,
          ageMinutes: AGE_MIN,
          minCount: 1,
          cooldownMinutes: COOLDOWN_MIN,
        });
        await insertStuckRow(isoDb, { pipelineState: "hydrate_pending", ageMinutes: AGE_MIN + 5 });
        const { fn, calls } = makeDispatcher();
        __testHelpers.setDispatcherForTests(fn);

        const now = Date.now();
        const first = await checkFrontPipelineStuck(now);
        assert.equal(first.decision, "alerted");
        assert.equal(calls.length, 1);

        const past = now + (COOLDOWN_MIN + 1) * 60_000;
        const third = await checkFrontPipelineStuck(past);
        assert.equal(third.decision, "alerted", `decision=${third.decision}`);
        assert.equal(calls.length, 2);
      });

      await step(isoDb, "Group 4 — kill switch off → skipped_disabled, no dispatch", async () => {
        await configure({
          enabled: false,
          ageMinutes: AGE_MIN,
          minCount: 1,
          cooldownMinutes: COOLDOWN_MIN,
        });
        await insertStuckRow(isoDb, { pipelineState: "discovered", ageMinutes: AGE_MIN + 60 });
        const { fn, calls } = makeDispatcher();
        __testHelpers.setDispatcherForTests(fn);

        const r = await checkFrontPipelineStuck();
        assert.equal(r.decision, "skipped_disabled");
        assert.equal(r.totalStuck, 0);
        assert.equal(calls.length, 0);
      });

      await step(
        isoDb,
        "Group 5 — dispatcher-skip does NOT arm cooldown; next call with healthy Slack delivers",
        async () => {
          await configure({
            enabled: true,
            ageMinutes: AGE_MIN,
            minCount: 1,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertStuckRow(isoDb, { pipelineState: "discovered", ageMinutes: AGE_MIN + 10 });

          const skipped = makeDispatcher({
            delivered: false,
            status: "skipped_slack_disconnected",
            skipReason: "slack_breaker_open",
          });
          __testHelpers.setDispatcherForTests(skipped.fn);
          const r1 = await checkFrontPipelineStuck();
          assert.equal(r1.decision, "skipped_dispatcher_skipped", `decision=${r1.decision}`);
          assert.equal(skipped.calls.length, 1);

          const healthy = makeDispatcher({ delivered: true, status: "success" });
          __testHelpers.setDispatcherForTests(healthy.fn);
          const r2 = await checkFrontPipelineStuck();
          assert.equal(r2.decision, "alerted", `decision=${r2.decision} skipReason=${r2.skipReason}`);
          assert.equal(healthy.calls.length, 1);
        },
      );

      await step(isoDb, "Group 6 — rows in 'applied' are ignored regardless of age", async () => {
        await configure({
          enabled: true,
          ageMinutes: AGE_MIN,
          minCount: 1,
          cooldownMinutes: COOLDOWN_MIN,
        });
        // Insert several very old `applied` rows. The watcher must not fire.
        await insertStuckRow(isoDb, { pipelineState: "applied", ageMinutes: AGE_MIN + 24 * 60 });
        await insertStuckRow(isoDb, { pipelineState: "applied", ageMinutes: AGE_MIN + 48 * 60 });
        const { fn, calls } = makeDispatcher();
        __testHelpers.setDispatcherForTests(fn);

        const r = await checkFrontPipelineStuck();
        // Isolated schema starts empty, so `applied` rows must produce 0 alerts.
        for (const s of r.byState) {
          assert.notEqual(s.pipelineState, "applied", "applied rows must be ignored");
        }
        assert.equal(calls.length, 0);
        assert.equal(r.totalStuck, 0);
      });

      if (failures > 0) {
        throw new Error(`${failures} test(s) failed`);
      }
      console.log("\nAll Front pipeline stuck-row regression tests passed");
    },
    { tables: ["front_sync_emails", "system_settings", "admin_setting_audit"] },
  );
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
