/* test-registration
{
  "name": "Twilio webhook collision alerts (Task #1284)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1284 regression tests: Twilio inbound-webhook 23505 collision spike
 * watcher.
 *
 * Covers:
 *   (a) below-threshold collisions do NOT alert,
 *   (b) crossing the threshold inside the rolling window fires once,
 *   (c) cooldown suppression (no growth since last alert),
 *   (d) re-alert when count grows by another full threshold inside cooldown,
 *   (e) window pruning — collisions older than the rolling window do not
 *       count toward the threshold,
 *   (f) `enabled=false` short-circuits even when the threshold is met.
 *
 * Stubs the dispatcher so no Slack call is made; talks to the real
 * `system_settings` store via `storage.setSystemSetting` for config knobs.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";

const SETTING_KEYS = [
  "twilio_webhook_collision_alert_enabled",
  "twilio_webhook_collision_alert_window_minutes",
  "twilio_webhook_collision_alert_threshold",
  "twilio_webhook_collision_alert_cooldown_minutes",
] as const;

async function cleanup(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

async function installDispatcherStub(
  calls: DispatchCall[],
  outcome: { delivered: boolean; status?: string; skipReason?: string } = { delivered: true },
) {
  const mod = await import("../server/services/twilioWebhookCollisionAlerts");
  mod.__testHelpers.setDispatcherForTests(async (id, payload, options) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "failed"),
      skipReason: outcome.skipReason,
    };
  });
  return () => mod.__testHelpers.setDispatcherForTests(null);
}

async function configure(opts: { enabled: boolean; windowMinutes: number; threshold: number; cooldownMinutes: number }): Promise<void> {
  await storage.setSystemSetting("twilio_webhook_collision_alert_enabled", String(opts.enabled), "system");
  await storage.setSystemSetting("twilio_webhook_collision_alert_window_minutes", String(opts.windowMinutes), "system");
  await storage.setSystemSetting("twilio_webhook_collision_alert_threshold", String(opts.threshold), "system");
  await storage.setSystemSetting("twilio_webhook_collision_alert_cooldown_minutes", String(opts.cooldownMinutes), "system");
}

async function run(): Promise<void> {
  await cleanup();

  const mod = await import("../server/services/twilioWebhookCollisionAlerts");
  const { recordTwilioSidCollision, checkTwilioWebhookCollisions, __testHelpers } = mod;

  // ── (a) below-threshold does not alert ─────────────────────────────
  __testHelpers.resetForTests();
  await configure({ enabled: true, windowMinutes: 10, threshold: 5, cooldownMinutes: 60 });
  const callsA: DispatchCall[] = [];
  let restore = await installDispatcherStub(callsA);
  for (let i = 0; i < 4; i++) recordTwilioSidCollision(`SM_a_${i}`);
  let r = await checkTwilioWebhookCollisions();
  assert.equal(r.alertsSent, 0, "(a) below-threshold must not alert");
  assert.equal(r.decision, "skipped_below_threshold");
  assert.equal(callsA.length, 0);
  restore();

  // ── (b) crossing the threshold fires exactly one alert ─────────────
  __testHelpers.resetForTests();
  const callsB: DispatchCall[] = [];
  restore = await installDispatcherStub(callsB);
  // Mix of accepted (correct constraint) and rejected (wrong constraint
  // / wrong code) attempts — only the matching ones should be counted.
  const matchingErr = { code: "23505", constraint: "twilio_msg_twilio_sid_uniq" };
  const wrongConstraintErr = { code: "23505", constraint: "twilio_msg_pkey" };
  const wrongCodeErr = { code: "23503", constraint: "twilio_msg_twilio_sid_uniq" };
  for (let i = 0; i < 5; i++) {
    const accepted = recordTwilioSidCollision(`SM_b_${i}`, matchingErr);
    assert.equal(accepted, true, `(b) matching constraint must be recorded for SM_b_${i}`);
  }
  // These must be ignored.
  assert.equal(
    recordTwilioSidCollision("SM_b_pk", wrongConstraintErr),
    false,
    "(b) wrong constraint must not be recorded",
  );
  assert.equal(
    recordTwilioSidCollision("SM_b_fk", wrongCodeErr),
    false,
    "(b) wrong error code must not be recorded",
  );
  // Detail-fallback path: some drivers populate `detail` instead of
  // `constraint` — that should still match by index name.
  assert.equal(
    recordTwilioSidCollision("SM_b_detail", {
      code: "23505",
      detail: 'duplicate key value violates unique constraint "twilio_msg_twilio_sid_uniq"',
    }),
    true,
    "(b) detail-fallback constraint match must be recorded",
  );
  r = await checkTwilioWebhookCollisions();
  assert.equal(r.alertsSent, 1, "(b) hitting threshold must alert once");
  assert.equal(r.decision, "alerted");
  assert.equal(callsB.length, 1);
  assert.equal(callsB[0]!.id, "infra.twilio_webhook.sid_collision_spike");
  assert.equal(
    r.windowedCount,
    6,
    "(b) only matching-constraint collisions should be counted (5 + 1 detail fallback, not the rejected 2)",
  );
  assert.ok(/\*6\* collisions/.test(callsB[0]!.text), `alert text should mention count, got: ${callsB[0]!.text}`);
  assert.ok(callsB[0]!.text.includes("SM_b_0"), "alert text should list sample SIDs");
  // Link presence — each sample SID gets an admin + Twilio Console link
  // in both the rendered text and the structured metadata payload.
  assert.ok(
    /<https?:\/\/console\.twilio\.com[^|]*\|Twilio Console>/.test(callsB[0]!.text),
    `alert text should include Twilio Console links, got: ${callsB[0]!.text}`,
  );
  assert.ok(
    /\|admin>/.test(callsB[0]!.text),
    `alert text should include admin links, got: ${callsB[0]!.text}`,
  );
  const sidLinks = callsB[0]!.metadata?.sampleSidLinks as Array<{ sid: string; adminUrl: string; twilioConsoleUrl: string }>;
  assert.ok(Array.isArray(sidLinks) && sidLinks.length === 6, "metadata.sampleSidLinks should mirror sample SIDs");
  for (const link of sidLinks) {
    assert.ok(link.sid.length > 0);
    assert.ok(link.adminUrl.includes(encodeURIComponent(link.sid)), `admin link should embed SID: ${link.adminUrl}`);
    assert.ok(
      link.twilioConsoleUrl.startsWith("https://console.twilio.com/") &&
        link.twilioConsoleUrl.includes(encodeURIComponent(link.sid)),
      `twilioConsoleUrl should be a console.twilio.com link with the SID: ${link.twilioConsoleUrl}`,
    );
  }
  restore();

  // ── (c) cooldown: no growth since last alert → no re-alert ─────────
  const callsC: DispatchCall[] = [];
  restore = await installDispatcherStub(callsC);
  r = await checkTwilioWebhookCollisions();
  assert.equal(r.alertsSent, 0, "(c) no growth since last alert must not re-alert");
  assert.equal(r.decision, "skipped_no_growth_since_last_alert");
  restore();

  // ── (d) re-alert when growth since last alert ≥ threshold ──────────
  const callsD: DispatchCall[] = [];
  restore = await installDispatcherStub(callsD);
  for (let i = 0; i < 5; i++) recordTwilioSidCollision(`SM_d_${i}`); // total = 10, +5 since last
  r = await checkTwilioWebhookCollisions();
  assert.equal(
    r.alertsSent,
    1,
    "(d) growth-since-last ≥ threshold must re-alert even inside cooldown",
  );
  restore();

  // ── (e) window pruning — old events outside the window don't count ─
  __testHelpers.resetForTests();
  await configure({ enabled: true, windowMinutes: 10, threshold: 5, cooldownMinutes: 60 });
  const callsE: DispatchCall[] = [];
  restore = await installDispatcherStub(callsE);
  // Manually craft "old" events by recording then evaluating with a
  // future `now` that's past the window.
  for (let i = 0; i < 10; i++) recordTwilioSidCollision(`SM_e_${i}`);
  const recordedAt = Date.now();
  // Evaluate 11m in the future — every event is older than the 10m window.
  r = await checkTwilioWebhookCollisions(recordedAt + 11 * 60_000);
  assert.equal(r.alertsSent, 0, "(e) events older than window must not count");
  assert.equal(r.decision, "skipped_below_threshold");
  assert.equal(r.windowedCount, 0);
  // Ring buffer should have been pruned.
  assert.equal(__testHelpers.ringBufferSize(), 0, "(e) ring buffer should be pruned");
  restore();

  // ── (f) enabled=false short-circuits ───────────────────────────────
  __testHelpers.resetForTests();
  await configure({ enabled: false, windowMinutes: 10, threshold: 5, cooldownMinutes: 60 });
  const callsF: DispatchCall[] = [];
  restore = await installDispatcherStub(callsF);
  for (let i = 0; i < 20; i++) recordTwilioSidCollision(`SM_f_${i}`);
  r = await checkTwilioWebhookCollisions();
  assert.equal(r.alertsSent, 0, "(f) disabled watcher must not alert");
  assert.equal(r.decision, "skipped_disabled");
  assert.equal(callsF.length, 0);
  restore();

  __testHelpers.resetForTests();
  await cleanup();
  console.log("twilio-webhook-collision-alerts.test.ts: OK");
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
