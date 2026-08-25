/* test-registration
{
  "name": "Notification config-change alerts (Task #1228)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1228 — regression coverage for the notification config-change alert
 * dispatch wired by Task #745.
 *
 * Every audit row written by `setAlertNotifyConfig` triggers a fire-and-forget
 * Slack + email send via `dispatchNotifyConfigChangeAlert`, and the delivery
 * outcome is then written back through `updateAdminSettingAuditDelivery`.
 * Without coverage, a future refactor of the audit-insert loop or the
 * dispatch helper could silently break the sent/failed badges in the admin
 * history panel.
 *
 * This test stubs `global.fetch` (which both `slackIntegration.postMessage`
 * and `mailer.sendEmail` go through) and toggles the slack token + SendGrid
 * env vars to drive the four delivery outcomes called for in the task brief:
 *   1. success
 *   2. Slack disconnected
 *   3. SendGrid http_error
 *   4. no destination configured
 *
 * For each scenario we flip all four notify-config fields in a single
 * `setAlertNotifyConfig` call (which writes four audit rows, sharing the same
 * `before` dispatch snapshot) and assert:
 *   - Slack/email transport functions are invoked exactly once per audit row
 *     (or zero times when the destination is unconfigured)
 *   - Each audit row ends up with the expected `slackStatus`/`emailStatus`
 *     plus a matching failure reason where one is expected.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  loadAlertNotifyConfig,
  setAlertNotifyConfig,
} from "../server/services/rateLimitAlertNotifier";
import { ensureAdminSettingAuditTable } from "../server/storage/settingsStorage";

const TAG = `nca-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;

const SETTING_KEYS = [
  "rate_limit_alert_slack_channel_id",
  "rate_limit_alert_email",
  "rate_limit_alert_disabled_categories",
  "rate_limit_alert_cadence",
] as const;

const originalFetch = global.fetch;
const originalEnv = {
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,
  ALERT_FROM_EMAIL: process.env.ALERT_FROM_EMAIL,
};

let slackCalls = 0;
let sendgridCalls = 0;
let sendgridStatus: "ok" | "http_error" = "ok";

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  // Task #1819 / #1820: stub Upstash Redis REST endpoint so the
  // system_settings read-through cache always behaves as "cold cache".
  // GET returns null (forces DB read), SET/DEL return ok. Without
  // this, an intermittent cacheDel failure can leak the prior
  // scenario's `slack_bot_token` (e.g. "xoxb-test") into the
  // slack-disconnected scenario, causing isConnected() to return true
  // and the dispatcher to hit Slack 4×. Task #1820 migrated this to
  // the shared URL-aware helper so single-command vs pipeline
  // envelopes match the call and the @upstash/redis client doesn't
  // crash on under-sized arrays.
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string"
      ? input
      : input?.url
        ? input.url
        : String(input);
  if (url.includes("slack.com/api")) {
    slackCalls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("api.sendgrid.com")) {
    sendgridCalls++;
    if (sendgridStatus === "http_error") {
      return new Response("Bad request from SendGrid", { status: 500 });
    }
    return new Response("", { status: 202 });
  }
  return originalFetch(input as any, init);
}) as any;

async function ensureActor(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Notify', 'Tester')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_setting_audit WHERE changed_by = ${ACTOR_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

interface AuditRow {
  id: string;
  settingKey: string;
  slackStatus: string | null;
  emailStatus: string | null;
  slackFailureReason: string | null;
  emailFailureReason: string | null;
}

async function listActorRows(): Promise<AuditRow[]> {
  const r: any = await db.execute(sql`
    SELECT id,
           setting_key AS "settingKey",
           slack_status AS "slackStatus",
           email_status AS "emailStatus",
           slack_failure_reason AS "slackFailureReason",
           email_failure_reason AS "emailFailureReason",
           changed_at AS "changedAt"
    FROM admin_setting_audit
    WHERE changed_by = ${ACTOR_ID}
    ORDER BY changed_at ASC
  `);
  return (r.rows ?? r) as AuditRow[];
}

async function waitForDelivery(
  beforeIds: Set<string>,
  expected: number,
): Promise<AuditRow[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await listActorRows();
    const newRows = rows.filter((r) => !beforeIds.has(r.id));
    if (
      newRows.length === expected &&
      newRows.every((r) => r.slackStatus !== null && r.emailStatus !== null)
    ) {
      return newRows;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  const rows = await listActorRows();
  throw new Error(
    `delivery rows did not populate in time; rows=${JSON.stringify(rows)}`,
  );
}

async function setBeforeState(state: {
  slackChannelId: string | null;
  email: string | null;
  disabledCategories: string[];
  cadence: "realtime" | "hourly" | "daily";
}): Promise<void> {
  // Bypass setAlertNotifyConfig so we don't generate audit rows or
  // dispatch alerts while priming the per-scenario "before" state.
  await storage.setSystemSetting(
    "rate_limit_alert_slack_channel_id",
    state.slackChannelId ?? "",
    "system",
  );
  await storage.setSystemSetting(
    "rate_limit_alert_email",
    state.email ?? "",
    "system",
  );
  await storage.setSystemSetting(
    "rate_limit_alert_disabled_categories",
    JSON.stringify(state.disabledCategories),
    "system",
  );
  await storage.setSystemSetting(
    "rate_limit_alert_cadence",
    state.cadence,
    "system",
  );
  await loadAlertNotifyConfig(true);
}

interface ScenarioSetup {
  slackToken: string | null;
  sendgridConfigured: boolean;
  sendgridStatus?: "ok" | "http_error";
  before: { slackChannelId: string | null; email: string | null };
}

interface ScenarioExpect {
  slackCalls: number;
  sendgridCalls: number;
  slackStatus: "sent" | "failed" | "skipped";
  emailStatus: "sent" | "failed" | "skipped";
  slackReason: string | null;
  emailReason: string | null;
}

async function runScenario(
  label: string,
  setup: ScenarioSetup,
  expected: ScenarioExpect,
): Promise<void> {
  await storage.setSystemSetting(
    "slack_bot_token",
    setup.slackToken ?? "",
    "system",
  );
  if (setup.sendgridConfigured) {
    process.env.SENDGRID_API_KEY = "test-key";
    process.env.SENDGRID_FROM_EMAIL = "noreply@example.com";
  } else {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM_EMAIL;
  }
  sendgridStatus = setup.sendgridStatus ?? "ok";

  await setBeforeState({
    slackChannelId: setup.before.slackChannelId,
    email: setup.before.email,
    disabledCategories: [`prev-${label}`],
    cadence: "realtime",
  });

  const beforeRows = await listActorRows();
  const beforeIds = new Set(beforeRows.map((r) => r.id));

  slackCalls = 0;
  sendgridCalls = 0;

  // Flip all four fields to new, distinct values so each generates an audit
  // row. `dispatchNotifyConfigChangeAlert` snapshots `before` once, so all
  // four rows share the destinations configured in `setBeforeState` above.
  await setAlertNotifyConfig(
    {
      slackChannelId: `chan-${label}-new`,
      email: `${label}-new@example.com`,
      disabledCategories: [`new-${label}`],
      cadence: "hourly",
    },
    ACTOR_ID,
  );

  const newRows = await waitForDelivery(beforeIds, 4);

  const seenKeys = new Set(newRows.map((r) => r.settingKey));
  assert.equal(
    seenKeys.size,
    4,
    `${label}: expected 4 unique setting keys, got ${[...seenKeys].join(",")}`,
  );
  for (const k of SETTING_KEYS) {
    assert.ok(seenKeys.has(k), `${label}: missing audit row for ${k}`);
  }

  assert.equal(
    slackCalls,
    expected.slackCalls,
    `${label}: slack fetch calls — got ${slackCalls}, want ${expected.slackCalls}`,
  );
  assert.equal(
    sendgridCalls,
    expected.sendgridCalls,
    `${label}: sendgrid fetch calls — got ${sendgridCalls}, want ${expected.sendgridCalls}`,
  );

  for (const row of newRows) {
    assert.equal(
      row.slackStatus,
      expected.slackStatus,
      `${label}: row ${row.settingKey} slackStatus`,
    );
    assert.equal(
      row.emailStatus,
      expected.emailStatus,
      `${label}: row ${row.settingKey} emailStatus`,
    );
    if (expected.slackReason === null) {
      assert.equal(
        row.slackFailureReason,
        null,
        `${label}: row ${row.settingKey} slackFailureReason should be null`,
      );
    } else {
      assert.ok(
        (row.slackFailureReason ?? "").includes(expected.slackReason),
        `${label}: row ${row.settingKey} slackFailureReason expected to include "${expected.slackReason}", got "${row.slackFailureReason}"`,
      );
    }
    if (expected.emailReason === null) {
      assert.equal(
        row.emailFailureReason,
        null,
        `${label}: row ${row.settingKey} emailFailureReason should be null`,
      );
    } else {
      assert.ok(
        (row.emailFailureReason ?? "").includes(expected.emailReason),
        `${label}: row ${row.settingKey} emailFailureReason expected to include "${expected.emailReason}", got "${row.emailFailureReason}"`,
      );
    }
  }

  // Drop actor rows so the next scenario starts from an empty baseline.
  await db.execute(sql`DELETE FROM admin_setting_audit WHERE changed_by = ${ACTOR_ID}`);
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureActor();

  const priorCached = await loadAlertNotifyConfig();
  const priorSlackToken = await storage.getSystemSetting("slack_bot_token");

  try {
    await runScenario(
      "success",
      {
        slackToken: "xoxb-test",
        sendgridConfigured: true,
        sendgridStatus: "ok",
        before: { slackChannelId: "C-before", email: "before@example.com" },
      },
      {
        slackCalls: 4,
        sendgridCalls: 4,
        slackStatus: "sent",
        emailStatus: "sent",
        slackReason: null,
        emailReason: null,
      },
    );

    await runScenario(
      "slack-disconnected",
      {
        slackToken: null,
        sendgridConfigured: true,
        sendgridStatus: "ok",
        before: { slackChannelId: "C-before", email: "before@example.com" },
      },
      {
        slackCalls: 0,
        sendgridCalls: 4,
        slackStatus: "skipped",
        emailStatus: "sent",
        slackReason: "Slack not connected",
        emailReason: null,
      },
    );

    await runScenario(
      "sendgrid-http-error",
      {
        slackToken: "xoxb-test",
        sendgridConfigured: true,
        sendgridStatus: "http_error",
        before: { slackChannelId: "C-before", email: "before@example.com" },
      },
      {
        slackCalls: 4,
        sendgridCalls: 4,
        slackStatus: "sent",
        emailStatus: "failed",
        slackReason: null,
        emailReason: "SendGrid 500",
      },
    );

    await runScenario(
      "no-destination",
      {
        slackToken: "xoxb-test",
        sendgridConfigured: true,
        sendgridStatus: "ok",
        before: { slackChannelId: null, email: null },
      },
      {
        slackCalls: 0,
        sendgridCalls: 0,
        slackStatus: "skipped",
        emailStatus: "skipped",
        slackReason: "No Slack channel configured",
        emailReason: "No email recipient configured",
      },
    );

    console.log("notification-config-change-alerts: PASSED");
  } finally {
    if (originalEnv.SENDGRID_API_KEY === undefined) {
      delete process.env.SENDGRID_API_KEY;
    } else {
      process.env.SENDGRID_API_KEY = originalEnv.SENDGRID_API_KEY;
    }
    if (originalEnv.SENDGRID_FROM_EMAIL === undefined) {
      delete process.env.SENDGRID_FROM_EMAIL;
    } else {
      process.env.SENDGRID_FROM_EMAIL = originalEnv.SENDGRID_FROM_EMAIL;
    }
    if (originalEnv.ALERT_FROM_EMAIL === undefined) {
      delete process.env.ALERT_FROM_EMAIL;
    } else {
      process.env.ALERT_FROM_EMAIL = originalEnv.ALERT_FROM_EMAIL;
    }
    global.fetch = originalFetch;

    await storage
      .setSystemSetting(
        "slack_bot_token",
        priorSlackToken?.value ?? "",
        "system",
      )
      .catch(() => undefined);
    await storage
      .setSystemSetting(
        "rate_limit_alert_slack_channel_id",
        priorCached.slackChannelId ?? "",
        "system",
      )
      .catch(() => undefined);
    await storage
      .setSystemSetting(
        "rate_limit_alert_email",
        priorCached.email ?? "",
        "system",
      )
      .catch(() => undefined);
    await storage
      .setSystemSetting(
        "rate_limit_alert_disabled_categories",
        JSON.stringify(priorCached.disabledCategories),
        "system",
      )
      .catch(() => undefined);
    await storage
      .setSystemSetting(
        "rate_limit_alert_cadence",
        priorCached.cadence,
        "system",
      )
      .catch(() => undefined);
    await loadAlertNotifyConfig(true).catch(() => undefined);
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch(async (err) => {
    console.error("notification-config-change-alerts: FAILED", err);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  });
