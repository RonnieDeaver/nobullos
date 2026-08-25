/* test-registration
{
  "name": "Front email-mirror freshness alerts (Task #2146)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2146 regression coverage for the Front email-mirror freshness
 * watcher (`server/services/frontMirrorFreshnessAlerts.ts`).
 *
 * The watcher compares the mirror's freshness (`MAX(created_at)` on
 * `front_sync_emails`) against live Front webhook intake
 * (`MAX(received_at)` on `source_event_log` for `source_system='front'`)
 * and fires only when webhooks are arriving recently but the mirror has
 * frozen — i.e. the writer is disabled or broken.
 *
 * Locks the following behavior in place:
 *
 * 1. Fresh webhooks + frozen mirror → alerts exactly once and arms
 *    cooldown; the cooldown blocks the immediate next tick.
 * 2. After the cooldown expires the watcher fires again.
 * 3. No fresh Front webhooks (none at all) → skipped_no_webhook_traffic
 *    (don't cry wolf during a quiet period), even when the mirror is
 *    old.
 * 4. Latest Front webhook is itself older than the lag threshold →
 *    skipped_no_webhook_traffic (upstream stall, not a mirror problem).
 * 5. Fresh webhooks + fresh mirror → skipped_mirror_fresh.
 * 6. Mirror has NO rows at all but webhooks fresh → alerts.
 * 7. Kill switch off → skipped_disabled without querying or dispatching.
 * 8. Dispatcher-skip does NOT arm cooldown, so the next tick after Slack
 *    recovers still delivers.
 *
 * Runs inside `runInIsolatedSchema` so seeded rows live in a per-test
 * schema invisible to the live `Start application` workers. The watcher
 * reads via `getDb()` so the override applies.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkFrontMirrorFreshness,
  SETTING_COOLDOWN_MINUTES,
  SETTING_ENABLED,
  SETTING_LAG_MINUTES,
} from "../server/services/frontMirrorFreshnessAlerts";
import { runInIsolatedSchema } from "./db-sandbox";

const MARKER = `t2146_fmf_${process.pid}_${Date.now()}`;

const LAG_MIN = 180;
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

async function insertMirrorRow(
  isoDb: { execute: (q: any) => Promise<any> },
  opts: { createdAgeMinutes: number },
): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.createdAgeMinutes * 60_000).toISOString();
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (conversation_id, pipeline_state, match_status, state_changed_at, created_at)
    VALUES
      (${tag}, 'applied', 'unmatched', ${ts}, ${ts})
  `);
}

async function insertWebhookEvent(
  isoDb: { execute: (q: any) => Promise<any> },
  opts: { receivedAgeMinutes: number },
): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.receivedAgeMinutes * 60_000).toISOString();
  await isoDb.execute(sql`
    INSERT INTO source_event_log
      (source_system, source_event_type, source_object_id, dedupe_key,
       payload_json, status, received_at, created_at, updated_at)
    VALUES
      ('front', 'message.created', ${tag}, ${tag},
       '{}'::jsonb, 'received', ${ts}, ${ts}, ${ts})
  `);
}

async function configure(opts: {
  enabled?: boolean;
  lagMinutes?: number;
  cooldownMinutes?: number;
}): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_ENABLED,
      opts.enabled ? "true" : "false",
      "system",
    );
  }
  if (opts.lagMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_LAG_MINUTES,
      String(opts.lagMinutes),
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

async function resetRows(isoDb: { execute: (q: any) => Promise<any> }): Promise<void> {
  await isoDb.execute(sql`DELETE FROM front_sync_emails`);
  await isoDb.execute(sql`DELETE FROM source_event_log`);
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
  await resetRows(isoDb);
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetInMemory();
    await resetRows(isoDb);
  }
}

async function main(): Promise<void> {
  console.log("Front email-mirror freshness watcher regression (Task #2146)");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await step(
        isoDb,
        "Group 1 — fresh webhooks + frozen mirror alerts once, then cooldown",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 120 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(
            r.decision,
            "alerted",
            `decision=${r.decision} skipReason=${r.skipReason}`,
          );
          assert.equal(calls.length, 1);
          assert.equal(calls[0].id, __testHelpers.NOTIFICATION_ID);
          assert.match(calls[0].text, /mirror has stopped receiving new rows/i);

          const r2 = await checkFrontMirrorFreshness();
          assert.equal(r2.decision, "skipped_cooldown");
          assert.equal(calls.length, 1);
        },
      );

      await step(
        isoDb,
        "Group 2 — after cooldown expires the watcher fires again",
        async () => {
          // Short cooldown so the second call can advance the clock only
          // a couple of minutes — advancing it by hours would make the
          // seeded (absolute-timestamp) webhook look stale and flip the
          // decision to skipped_no_webhook_traffic.
          const shortCooldown = 1;
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: shortCooldown,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 30 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const now = Date.now();
          const first = await checkFrontMirrorFreshness(now);
          assert.equal(first.decision, "alerted");
          assert.equal(calls.length, 1);

          const later = now + (shortCooldown + 1) * 60_000;
          const third = await checkFrontMirrorFreshness(later);
          assert.equal(third.decision, "alerted", `decision=${third.decision}`);
          assert.equal(calls.length, 2);
        },
      );

      await step(
        isoDb,
        "Group 3 — no Front webhooks at all → skipped_no_webhook_traffic",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          // Mirror is ancient, but there is zero Front traffic.
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 600 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(r.decision, "skipped_no_webhook_traffic", `decision=${r.decision}`);
          assert.equal(calls.length, 0);
        },
      );

      await step(
        isoDb,
        "Group 4 — latest webhook itself stale → skipped_no_webhook_traffic",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          // Webhook intake itself stalled (older than lag) — the receiver
          // staleness watcher owns this; the mirror watcher must stay quiet.
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: LAG_MIN + 30 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 60 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(r.decision, "skipped_no_webhook_traffic", `decision=${r.decision}`);
          assert.equal(calls.length, 0);
        },
      );

      await step(
        isoDb,
        "Group 5 — fresh webhooks + fresh mirror → skipped_mirror_fresh",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: 10 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(r.decision, "skipped_mirror_fresh", `decision=${r.decision}`);
          assert.equal(calls.length, 0);
        },
      );

      await step(
        isoDb,
        "Group 6 — mirror has no rows at all but webhooks fresh → alerts",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          // No mirror rows seeded.
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(r.decision, "alerted", `decision=${r.decision}`);
          assert.equal(r.mirrorAgeMinutes, null);
          assert.equal(calls.length, 1);
          assert.match(calls[0].text, /no rows at all/i);
        },
      );

      await step(
        isoDb,
        "Group 7 — kill switch off → skipped_disabled, no dispatch",
        async () => {
          await configure({
            enabled: false,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 600 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(r.decision, "skipped_disabled");
          assert.equal(calls.length, 0);
        },
      );

      await step(
        isoDb,
        "Group 8 — dispatcher-skip does NOT arm cooldown; next call delivers",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 30 });

          const skipped = makeDispatcher({
            delivered: false,
            status: "skipped_slack_disconnected",
            skipReason: "slack_breaker_open",
          });
          __testHelpers.setDispatcherForTests(skipped.fn);
          const r1 = await checkFrontMirrorFreshness();
          assert.equal(r1.decision, "skipped_dispatcher_skipped", `decision=${r1.decision}`);
          assert.equal(skipped.calls.length, 1);

          const healthy = makeDispatcher({ delivered: true, status: "success" });
          __testHelpers.setDispatcherForTests(healthy.fn);
          const r2 = await checkFrontMirrorFreshness();
          assert.equal(r2.decision, "alerted", `decision=${r2.decision} skipReason=${r2.skipReason}`);
          assert.equal(healthy.calls.length, 1);
        },
      );

      await step(
        isoDb,
        "Group 9 — both old but mirror only slightly behind webhook → no alert",
        async () => {
          // Regression for the lag-computation bug: webhook is 100m old
          // (still inside the lag window so it counts as live traffic),
          // mirror is 181m old. Comparing each against `now` would make
          // mirrorAge (181) >= lag (180) and FALSE-ALERT, but the mirror
          // actually trails the webhook by only ~81m, well under the
          // threshold — so it must stay silent.
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 100 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: 181 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(
            r.decision,
            "skipped_mirror_fresh",
            `decision=${r.decision} behind=${r.mirrorBehindWebhookMinutes}`,
          );
          assert.ok(
            r.mirrorBehindWebhookMinutes !== null &&
              r.mirrorBehindWebhookMinutes <= LAG_MIN,
            `behind=${r.mirrorBehindWebhookMinutes}`,
          );
          assert.equal(calls.length, 0);
        },
      );

      await step(
        isoDb,
        "Group 10 — fresh webhook + mirror far behind webhook → alerts",
        async () => {
          await configure({
            enabled: true,
            lagMinutes: LAG_MIN,
            cooldownMinutes: COOLDOWN_MIN,
          });
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: 200 });
          const { fn, calls } = makeDispatcher();
          __testHelpers.setDispatcherForTests(fn);

          const r = await checkFrontMirrorFreshness();
          assert.equal(
            r.decision,
            "alerted",
            `decision=${r.decision} behind=${r.mirrorBehindWebhookMinutes}`,
          );
          assert.ok(
            r.mirrorBehindWebhookMinutes !== null &&
              r.mirrorBehindWebhookMinutes > LAG_MIN,
            `behind=${r.mirrorBehindWebhookMinutes}`,
          );
          assert.equal(calls.length, 1);
          assert.match(calls[0].text, /behind/i);
        },
      );

      if (failures > 0) {
        throw new Error(`${failures} test(s) failed`);
      }
      console.log("\nAll Front email-mirror freshness regression tests passed");
    },
    {
      tables: [
        "front_sync_emails",
        "source_event_log",
        "system_settings",
        "admin_setting_audit",
      ],
    },
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
