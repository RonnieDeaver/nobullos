/* test-registration
{
  "name": "Max-attempts warning auto-retry (Task #1252)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1252 — Regression coverage for the auto-retry exhausted warning
 * (Task #793).
 *
 * `runAutoRetryPass` sweeps failed alert-notification chains and, when a
 * chain's latest attempt has reached `maxAttempts`, it forwards a
 * "max-attempts exhausted" warning to Slack/email via
 * `processMaxAttemptsCapWarnings` → `sendMaxAttemptsWarning`. The warning
 * is gated by a per-chain cooldown stored in
 * `system_settings.rate_limit_alert_max_attempts_warning_state`, and the
 * whole feature is gated by `setMaxAttemptsWarningConfig({ enabled })`.
 *
 * Without coverage, a regression that disables either gate would silently
 * stop the operator-visible warning until someone noticed a real broken
 * destination rotting in history. This test pins:
 *
 *   1. A capped chain produces exactly one warning Slack send per auto-
 *      retry pass.
 *   2. A second pass within the cooldown produces no further sends.
 *   3. After the cooldown elapses, a re-pass at the *same* attempt
 *      number still does NOT re-warn (Task #1249: strict one-shot per
 *      (rootId, destination) once a successful warning has landed).
 *   4. A genuinely new cap event (attempt count strictly greater than
 *      the last alerted attempt) re-alerts even with prior success.
 *   5. With `enabled=false`, no warning is sent even outside the cooldown.
 *
 * Slack/email transports are stubbed at `global.fetch` (slack.com/api)
 * and via the SendGrid env vars (left unset so email skips). No external
 * network calls are made.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  ensureRateLimitAlertNotificationsTable,
  insertRateLimitAlertNotification,
} from "../server/storage/rateLimitAlertNotificationsStorage";
import {
  loadAlertNotifyConfig,
  loadAutoRetryConfig,
  loadMaxAttemptsWarningConfig,
  runAutoRetryPass,
  setAutoRetryConfig,
  setMaxAttemptsWarningConfig,
  type TriggerSource,
} from "../server/services/rateLimitAlertNotifier";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `mawa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DEST = `cap+${TAG}@example.invalid`;
const SLACK_CHANNEL = `C-${TAG}`;
const MAX_ATTEMPTS = 3;

const SETTING_WARNING_STATE = "rate_limit_alert_max_attempts_warning_state";
const SETTING_WARNING_CONFIG = "rate_limit_alert_max_attempts_warning";
const SETTING_SLACK_CHANNEL = "rate_limit_alert_slack_channel_id";
const SETTING_EMAIL = "rate_limit_alert_email";
const SETTING_DISABLED_CATEGORIES = "rate_limit_alert_disabled_categories";
const SETTING_CADENCE = "rate_limit_alert_cadence";
const SETTING_AUTO_RETRY = "rate_limit_alert_auto_retry";
const SETTING_SLACK_BOT_TOKEN = "slack_bot_token";

// Make sure the email branch is a no-op: with SendGrid unconfigured,
// `isMailerConfigured()` returns false and `sendMaxAttemptsWarning`
// skips that channel.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_FROM_EMAIL;
delete process.env.ALERT_FROM_EMAIL;

// ── fetch stub ────────────────────────────────────────────────────────
const originalFetch = global.fetch;
let slackChatPostCalls = 0;
const slackChatPostBodies: string[] = [];

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  // Task #1820: short-circuit Upstash REST calls so the
  // system_settings cache (this suite writes ~8 alert-related
  // settings per scenario) does not depend on a live Upstash
  // round-trip and stays deterministic.
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string"
      ? input
      : input?.url
        ? input.url
        : String(input);
  if (url.includes("slack.com/api/chat.postMessage")) {
    // Race guard: the live `Start application` workflow runs its own
    // `runAutoRetryPass` against the same DB and may have legitimate
    // failed alert chains of its own. When THIS test process's
    // `runAutoRetryPass` scans the shared `rate_limit_alert_notifications`
    // table it processes those rows too, generating "extra" Slack calls
    // that fail the strict `=== 1` assertions. Filter the counter to
    // only count posts that target OUR test channel/destination — every
    // assertion in this file is about the SEEDED chain's warning, not
    // about other chains that happen to be in the shared DB.
    const body = init?.body ? String(init.body) : "";
    // Filter on DEST only: SLACK_CHANNEL appears in every postMessage
    // body (it's the channel param) — too broad. TAG is in our
    // destination, so DEST inclusion is the canonical "this is our
    // chain" signal. Other concurrent test runs / live alert chains
    // in the shared DB have different destinations and are ignored.
    const isOurs = body.includes(DEST);
    if (isOurs) {
      slackChatPostCalls++;
      slackChatPostBodies.push(body);
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("slack.com/api")) {
    // Any other slack endpoint (none expected) — answer ok.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

async function seedRow(opts: {
  status: "failed" | "sent";
  attemptNumber?: number;
  parentNotificationId?: string | null;
  attemptedAt?: number;
  triggerSource?: TriggerSource;
}): Promise<string> {
  const attemptedAt = opts.attemptedAt ?? Date.now();
  const row = await insertRateLimitAlertNotification({
    channel: "email",
    destination: DEST,
    status: opts.status,
    errorMessage: opts.status === "failed" ? "seeded failure" : null,
    userId: `${TAG}-user`,
    userLabel: `${TAG} user`,
    category: TAG,
    count: 100,
    maxRequests: 100,
    warningPercent: 80,
    windowMs: 60_000,
    windowStart: attemptedAt - 60_000,
    triggeredAt: attemptedAt,
    attemptedAt,
    alert: {
      userId: `${TAG}-user`,
      category: TAG,
      count: 100,
      max: 100,
      warningPercent: 80,
      windowStart: attemptedAt - 60_000,
      windowMs: 60_000,
      triggeredAt: attemptedAt,
    },
    triggerSource: opts.triggerSource ?? "scheduled",
    triggerActorId: null,
    attemptNumber: opts.attemptNumber ?? 1,
    parentNotificationId: opts.parentNotificationId ?? null,
  });
  return row.id;
}

async function clearTagged(): Promise<void> {
  await db.execute(
    sql`DELETE FROM rate_limit_alert_notifications WHERE category = ${TAG}`,
  );
}

async function readWarningState(): Promise<{
  chains: Record<string, { lastWarningAt: number; lastWarningStatus: string }>;
}> {
  const row = await storage.getSystemSetting(SETTING_WARNING_STATE);
  if (!row?.value) return { chains: {} };
  try {
    const parsed = JSON.parse(row.value);
    return { chains: parsed?.chains ?? {} };
  } catch {
    return { chains: {} };
  }
}

async function ageWarningStateBack(deltaMs: number): Promise<void> {
  const state = await readWarningState();
  for (const k of Object.keys(state.chains)) {
    state.chains[k].lastWarningAt -= deltaMs;
  }
  await storage.setSystemSetting(
    SETTING_WARNING_STATE,
    JSON.stringify(state),
    "system",
  );
}

async function seedCappedChain(): Promise<string> {
  // Root: failed, far enough in the past to clear `minIntervalMinutes`.
  // listFailedRetryCandidates filters by attempted_at <= now - minAge AND
  // attempted_at >= now - lookback, so place the root inside that window.
  const rootId = await seedRow({
    status: "failed",
    attemptNumber: 1,
    parentNotificationId: null,
    attemptedAt: Date.now() - 60 * 60_000,
  });
  // Latest child at attempt == cap. Auto-retry sees this and pushes the
  // chain into `cappedChains` instead of inserting a new retry row.
  await seedRow({
    status: "failed",
    attemptNumber: MAX_ATTEMPTS,
    parentNotificationId: rootId,
    attemptedAt: Date.now() - 30 * 60_000,
  });
  return rootId;
}

async function snapshotSetting(key: string): Promise<string | null> {
  const row = await storage.getSystemSetting(key);
  return row?.value ?? null;
}

async function restoreSetting(key: string, value: string | null): Promise<void> {
  await storage
    .setSystemSetting(key, value ?? "", "test")
    .catch(() => undefined);
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();

  // Snapshot every setting we will perturb so the test is hermetic.
  const prior = {
    autoRetry: await snapshotSetting(SETTING_AUTO_RETRY),
    warningConfig: await snapshotSetting(SETTING_WARNING_CONFIG),
    warningState: await snapshotSetting(SETTING_WARNING_STATE),
    slackChannel: await snapshotSetting(SETTING_SLACK_CHANNEL),
    email: await snapshotSetting(SETTING_EMAIL),
    disabledCategories: await snapshotSetting(SETTING_DISABLED_CATEGORIES),
    cadence: await snapshotSetting(SETTING_CADENCE),
    slackBotToken: await snapshotSetting(SETTING_SLACK_BOT_TOKEN),
  };

  await clearTagged();

  try {
    // Configure notify destinations: Slack only (email skips because
    // SendGrid is unconfigured above).
    await storage.setSystemSetting(SETTING_SLACK_CHANNEL, SLACK_CHANNEL, "system");
    await storage.setSystemSetting(SETTING_EMAIL, "", "system");
    await storage.setSystemSetting(SETTING_DISABLED_CATEGORIES, "[]", "system");
    await storage.setSystemSetting(SETTING_CADENCE, "realtime", "system");
    await storage.setSystemSetting(SETTING_SLACK_BOT_TOKEN, "xoxb-test", "system");
    await loadAlertNotifyConfig(true);

    // Auto-retry: enabled, cap=3, minInterval=5min, 24h lookback.
    await setAutoRetryConfig(
      {
        enabled: true,
        maxAttempts: MAX_ATTEMPTS,
        minIntervalMinutes: 5,
        lookbackHours: 24,
      },
      "system",
    );
    const autoCfg = await loadAutoRetryConfig(true);
    assert(autoCfg.maxAttempts === MAX_ATTEMPTS, "auto-retry cap override failed");

    // Max-attempts warning: enabled, 60-min cooldown.
    await setMaxAttemptsWarningConfig(
      { enabled: true, cooldownMinutes: 60 },
      "system",
    );
    const warnCfg = await loadMaxAttemptsWarningConfig(true);
    assert(warnCfg.enabled, "warning enabled override failed");
    assert(warnCfg.cooldownMinutes === 60, "warning cooldown override failed");

    // Clear any pre-existing warning state so our chain key starts fresh.
    await storage.setSystemSetting(
      SETTING_WARNING_STATE,
      JSON.stringify({ chains: {} }),
      "system",
    );

    const rootId = await seedCappedChain();
    const chainKey = `${rootId}::${DEST}`;

    // ── (1) First pass: exactly one warning Slack send ────────────────
    slackChatPostCalls = 0;
    slackChatPostBodies.length = 0;
    const pass1 = await runAutoRetryPass(null);
    assert(
      slackChatPostCalls === 1,
      `first pass should send 1 warning, got ${slackChatPostCalls}`,
    );
    const body1 = slackChatPostBodies[0] ?? "";
    assert(
      body1.includes(SLACK_CHANNEL) && body1.includes("Auto-retry exhausted"),
      `slack body should target ${SLACK_CHANNEL} and mention 'Auto-retry exhausted', got ${body1}`,
    );
    // The capped chain must be reported as skipped by the pass (not
    // retried — it's at the cap), and our chain key must now have state.
    assert(
      pass1.skipped >= 1,
      `first pass should report >=1 skip for the capped chain, got ${pass1.skipped}`,
    );
    const state1 = await readWarningState();
    assert(
      state1.chains[chainKey]?.lastWarningStatus === "sent",
      `state should record sent warning for ${chainKey}, got ${JSON.stringify(state1.chains[chainKey])}`,
    );
    const firstWarningAt = state1.chains[chainKey].lastWarningAt;
    assert(Number.isFinite(firstWarningAt), "lastWarningAt should be a number");

    // ── (2) Second pass within cooldown: no new warning ───────────────
    slackChatPostCalls = 0;
    slackChatPostBodies.length = 0;
    await runAutoRetryPass(null);
    assert(
      slackChatPostCalls === 0,
      `second pass within cooldown should send 0 warnings, got ${slackChatPostCalls}`,
    );
    const state2 = await readWarningState();
    assert(
      state2.chains[chainKey]?.lastWarningAt === firstWarningAt,
      "lastWarningAt should not advance while still in cooldown",
    );

    // ── (3) After cooldown elapses, the same chain still does NOT
    //        re-warn (Task #1249 strict one-shot). The cooldown only
    //        applies to the *retry cadence* for previously-failed
    //        warnings; once a warning at attemptNumber=N has been
    //        successfully delivered, every later pass at attempt ≤ N
    //        stays silent regardless of elapsed time.
    await ageWarningStateBack(61 * 60_000);
    slackChatPostCalls = 0;
    slackChatPostBodies.length = 0;
    const pass3 = await runAutoRetryPass(null);
    assert(
      slackChatPostCalls === 0,
      `post-cooldown re-pass at same attemptNumber should send 0 warnings (strict one-shot), got ${slackChatPostCalls}`,
    );
    assert(
      pass3.skipped >= 1,
      `post-cooldown pass should still skip the capped chain, got ${pass3.skipped}`,
    );

    // ── (4) A genuinely *new* cap event (attemptNumber strictly
    //        greater than the last alerted attempt) re-alerts even if
    //        the prior warning was successfully delivered.
    await setAutoRetryConfig(
      {
        enabled: true,
        maxAttempts: MAX_ATTEMPTS + 1,
        minIntervalMinutes: 5,
        lookbackHours: 24,
      },
      "system",
    );
    await loadAutoRetryConfig(true);
    // Seed a new failed attempt at the bumped cap (attempt = MAX+1 = 4)
    // against the same root/destination.
    await seedRow({
      status: "failed",
      attemptNumber: MAX_ATTEMPTS + 1,
      parentNotificationId: rootId,
      attemptedAt: Date.now() - 15 * 60_000,
    });
    slackChatPostCalls = 0;
    slackChatPostBodies.length = 0;
    // Task #1789 — Race guard: the live `Start application` workflow runs
    // its own `rateLimitAlertNotifier` and shares the same DB + Redis
    // settings cache. If its periodic auto-retry tick reloads
    // `rate_limit_alert_auto_retry` (cap=4) AFTER our `setAutoRetryConfig`
    // call above AND BEFORE our `runAutoRetryPass` below, the live worker
    // can scan the same lookback window, find our seeded attempt=4 row,
    // and fire the warning itself — advancing the shared
    // `rate_limit_alert_max_attempts_warning_state.chains[chainKey]`
    // to attemptNumber=4. When our pass then runs, the strict-one-shot
    // gate sees "already alerted at 4" and stays silent. End state
    // (state.chains[chainKey].attemptNumber === 4) is identical in both
    // outcomes; only the *who-sent-the-slack-call* observable differs.
    // Snapshot pre-pass state so we can tell the two paths apart.
    const stateBefore = await readWarningState();
    const preempted =
      (stateBefore.chains[chainKey]?.attemptNumber ?? 0) >= MAX_ATTEMPTS + 1;
    await runAutoRetryPass(null);
    if (!preempted) {
      assert(
        slackChatPostCalls === 1,
        `new cap event at higher attemptNumber should re-warn once, got ${slackChatPostCalls}`,
      );
    }
    const state4 = await readWarningState();
    assert(
      state4.chains[chainKey]?.attemptNumber === MAX_ATTEMPTS + 1,
      `state should record bumped attemptNumber, got ${JSON.stringify(state4.chains[chainKey])}`,
    );

    // ── (5) Disabling the warning suppresses sends ────────────────────
    await setMaxAttemptsWarningConfig({ enabled: false }, "system");
    const disabledCfg = await loadMaxAttemptsWarningConfig(true);
    assert(!disabledCfg.enabled, "warning should be disabled");
    // Bypass any cooldown that would also block the send so we're
    // isolating the `enabled` gate.
    await ageWarningStateBack(61 * 60_000);
    slackChatPostCalls = 0;
    slackChatPostBodies.length = 0;
    await runAutoRetryPass(null);
    assert(
      slackChatPostCalls === 0,
      `disabled warning should send 0, got ${slackChatPostCalls}`,
    );

    console.log("max-attempts-warning-auto-retry: PASSED");
  } finally {
    // Restore fetch first so any restoration step that talks to Slack
    // doesn't hit our stub.
    global.fetch = originalFetch;

    await clearTagged().catch(() => undefined);

    await restoreSetting(SETTING_AUTO_RETRY, prior.autoRetry);
    await restoreSetting(SETTING_WARNING_CONFIG, prior.warningConfig);
    await restoreSetting(SETTING_WARNING_STATE, prior.warningState);
    await restoreSetting(SETTING_SLACK_CHANNEL, prior.slackChannel);
    await restoreSetting(SETTING_EMAIL, prior.email);
    await restoreSetting(SETTING_DISABLED_CATEGORIES, prior.disabledCategories);
    await restoreSetting(SETTING_CADENCE, prior.cadence);
    await restoreSetting(SETTING_SLACK_BOT_TOKEN, prior.slackBotToken);

    // Force every in-process cache to reload from the restored rows.
    await loadAutoRetryConfig(true).catch(() => undefined);
    await loadMaxAttemptsWarningConfig(true).catch(() => undefined);
    await loadAlertNotifyConfig(true).catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch(async (err) => {
    console.error("max-attempts-warning-auto-retry: FAILED", err);
    await clearTagged().catch(() => undefined);
    global.fetch = originalFetch;
    process.exitCode = 1;
  });
