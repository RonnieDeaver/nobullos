/* test-registration
{
  "name": "Client-text Slack channel alert (Task #2779)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2779 — client-text Slack channel alert (`workflow.client_sms.received`).
 *
 * When a client texts a NoBull number, `sendClientTextSlackAlert` (called
 * best-effort from `twilioService.handleInboundSms`) posts to the configured
 * Slack channel (default `#client-texts`, seeded idempotently into the legacy
 * setting key `client_text_slack_channel_id`) and @-mentions the conversation
 * owners via their linked `user_slack_identities` row (`<@SLACK_ID>`), falling
 * back to a plain name for owners with no linked identity.
 *
 * Coverage:
 *   1. Seed: missing setting → seeded to "#client-texts"; existing value never
 *      overwritten (admin edits win).
 *   2. Mention resolution: linked identity → `<@id>`; disconnected identity or
 *      none → name/email fallback; duplicate uids collapsed.
 *   3. End-to-end send: Slack chat.postMessage receives the resolved channel,
 *      the mention, and the message preview; the delivery is recorded.
 *   4. No health-transition dedupe: a second text posts again (dedupeKey would
 *      suppress every text after the first).
 *   5. Never throws: Slack transport failure is swallowed (webhook must 200).
 *
 * Slack API cited: chat.postMessage (channel accepts a #name or ID) and
 * mention syntax `<@USER_ID>` — docs.slack.dev/messaging/formatting-message-text.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __resetSlackTokenCacheForTest,
  SLACK_BOT_TOKEN_SETTING_KEY,
} from "../server/services/slackIntegration";
import {
  upsertUserSlackIdentity,
  disconnectUserSlackIdentity,
} from "../server/storage/userSlackPreferencesStorage";
import {
  CLIENT_TEXT_CHANNEL_SETTING,
  CLIENT_TEXT_DEFAULT_CHANNEL,
  CLIENT_TEXT_NOTIFICATION_ID,
  __resetClientTextSeedForTests,
  buildClientTextAlertText,
  ensureClientTextChannelSeeded,
  resolveMentions,
  sendClientTextSlackAlert,
} from "../server/services/notifications/clientTextSlackAlert";

const TAG = `ctsa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const USER_LINKED = `user-linked-${TAG}`;
const USER_PLAIN = `user-plain-${TAG}`;
const SLACK_ID = `U${TAG.replace(/[^0-9]/g, "").slice(0, 8)}LNK`;

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}

// ── Slack transport stub ────────────────────────────────────────────────
const originalFetch = global.fetch;
const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

interface SlackCall {
  url: string;
  body: any;
}
const slackCalls: SlackCall[] = [];
let slackFailNext = false;

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) {
    return __makeUpstashPassthroughResponse(input, init);
  }
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api")) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    slackCalls.push({ url, body });
    if (slackFailNext && url.includes("chat.postMessage")) {
      slackFailNext = false;
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, ts: "1.1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

function postMessageCalls(): SlackCall[] {
  return slackCalls.filter((c) => c.url.includes("chat.postMessage"));
}

// ── setup / teardown ───────────────────────────────────────────────────
const priorChannelRow = await storage.getSystemSetting(
  CLIENT_TEXT_CHANNEL_SETTING,
);
// Pin the watcher kill switch so a leaked 'false' from a SIGKILL'd sibling
// can't silently skip every send in this suite.
const priorWatcherSwitch = await storage.getSystemSetting(
  "notifications_slack_watchers_enabled",
);
const priorToken = await storage.getSystemSetting(SLACK_BOT_TOKEN_SETTING_KEY);

async function restoreSetting(
  key: string,
  prior: { value: string } | undefined,
): Promise<void> {
  if (prior?.value != null) {
    await storage.setSystemSetting(key, prior.value);
  } else {
    await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`);
  }
}

async function cleanup(): Promise<void> {
  await restoreSetting(CLIENT_TEXT_CHANNEL_SETTING, priorChannelRow);
  await restoreSetting(
    "notifications_slack_watchers_enabled",
    priorWatcherSwitch,
  );
  await restoreSetting(SLACK_BOT_TOKEN_SETTING_KEY, priorToken);
  __resetSlackTokenCacheForTest();
  await db.execute(
    sql`DELETE FROM user_slack_identities WHERE user_id IN (${USER_LINKED}, ${USER_PLAIN})`,
  );
  await db.execute(
    sql`DELETE FROM notification_deliveries WHERE notification_id = ${CLIENT_TEXT_NOTIFICATION_ID} AND metadata_json::text LIKE ${"%" + TAG + "%"}`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE id IN (${USER_LINKED}, ${USER_PLAIN})`,
  );
  global.fetch = originalFetch;
}

try {
  // seed users + identity
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES
      (${USER_LINKED}, ${`${USER_LINKED}@example.com`}, 'Linked', 'Owner'),
      (${USER_PLAIN}, ${`${USER_PLAIN}@example.com`}, 'Plain', 'Owner')
    ON CONFLICT (id) DO NOTHING
  `);
  await upsertUserSlackIdentity({ userId: USER_LINKED, slackUserId: SLACK_ID });
  await storage.setSystemSetting(
    "notifications_slack_watchers_enabled",
    "true",
  );
  await storage.setSystemSetting(
    SLACK_BOT_TOKEN_SETTING_KEY,
    "xoxb-test-client-text",
  );
  __resetSlackTokenCacheForTest();

  // ── 1. seeding ────────────────────────────────────────────────────────
  await db.execute(
    sql`DELETE FROM system_settings WHERE key = ${CLIENT_TEXT_CHANNEL_SETTING}`,
  );
  __resetClientTextSeedForTests();
  await ensureClientTextChannelSeeded();
  const seeded = await storage.getSystemSettingFresh(CLIENT_TEXT_CHANNEL_SETTING);
  check("missing setting is seeded to #client-texts", () =>
    assert.equal(seeded?.value, CLIENT_TEXT_DEFAULT_CHANNEL),
  );

  await storage.setSystemSetting(
    CLIENT_TEXT_CHANNEL_SETTING,
    "#admin-picked",
  );
  __resetClientTextSeedForTests();
  await ensureClientTextChannelSeeded();
  const kept = await storage.getSystemSettingFresh(CLIENT_TEXT_CHANNEL_SETTING);
  check("existing admin value is never overwritten by the seed", () =>
    assert.equal(kept?.value, "#admin-picked"),
  );

  // ── 2. mention resolution ────────────────────────────────────────────
  const mentions = await resolveMentions([USER_LINKED, USER_PLAIN, USER_LINKED]);
  check("duplicate owner uids collapse to one mention each", () =>
    assert.equal(mentions.length, 2),
  );
  check("linked identity resolves to <@SLACK_ID>", () =>
    assert.equal(
      mentions.find((m) => m.userId === USER_LINKED)?.display,
      `<@${SLACK_ID}>`,
    ),
  );
  check("owner without identity falls back to plain name", () =>
    assert.equal(
      mentions.find((m) => m.userId === USER_PLAIN)?.display,
      "Plain Owner",
    ),
  );

  await disconnectUserSlackIdentity(USER_LINKED);
  const afterDisconnect = await resolveMentions([USER_LINKED]);
  check("disconnected identity falls back to plain name (no dead @)", () =>
    assert.equal(afterDisconnect[0]?.display, "Linked Owner"),
  );
  await upsertUserSlackIdentity({ userId: USER_LINKED, slackUserId: SLACK_ID });

  const text = buildClientTextAlertText(
    { fromLabel: "Jane (+15551234567)", preview: "Need help asap" },
    mentions,
  );
  check("alert text contains sender, preview, and owner mentions", () => {
    assert.ok(text.includes("Jane (+15551234567)"));
    assert.ok(text.includes("Need help asap"));
    assert.ok(text.includes(`<@${SLACK_ID}>`));
    assert.ok(text.includes("Plain Owner"));
  });
  check("no owners renders an explicit no-owner marker", () =>
    assert.ok(
      buildClientTextAlertText(
        { fromLabel: "x", preview: "y" },
        [],
      ).includes("no assigned owner"),
    ),
  );

  // ── 3. end-to-end send ───────────────────────────────────────────────
  const before = postMessageCalls().length;
  await sendClientTextSlackAlert({
    recipientUserIds: [USER_LINKED, USER_PLAIN],
    fromLabel: `Client (${TAG})`,
    preview: "First text",
    clientId: null,
    messageSid: `SM-${TAG}-1`,
    threadKey: `thread-${TAG}`,
  });
  const first = postMessageCalls().slice(before);
  check("exactly one chat.postMessage for the first text", () =>
    assert.equal(first.length, 1),
  );
  check("posted to the admin-configured channel (setting wins)", () =>
    assert.equal(first[0]?.body?.channel, "#admin-picked"),
  );
  check("posted text @-mentions the linked owner", () =>
    assert.ok(String(first[0]?.body?.text).includes(`<@${SLACK_ID}>`)),
  );
  check("posted text includes the message preview", () =>
    assert.ok(String(first[0]?.body?.text).includes("First text")),
  );

  const delivery: any = await db.execute(sql`
    SELECT status FROM notification_deliveries
    WHERE notification_id = ${CLIENT_TEXT_NOTIFICATION_ID}
      AND metadata_json::text LIKE ${"%SM-" + TAG + "-1%"}
    ORDER BY created_at DESC LIMIT 1
  `);
  const deliveryRows = delivery.rows ?? delivery;
  check("a notification_deliveries row records the send", () =>
    assert.equal(deliveryRows[0]?.status, "success"),
  );

  // ── 4. second text posts again (no health-transition dedupe) ────────
  await sendClientTextSlackAlert({
    recipientUserIds: [USER_LINKED],
    fromLabel: `Client (${TAG})`,
    preview: "Second text",
    clientId: null,
    messageSid: `SM-${TAG}-2`,
    threadKey: `thread-${TAG}`,
  });
  check("a subsequent text posts again — per-message, not deduped", () =>
    assert.equal(postMessageCalls().slice(before).length, 2),
  );

  // ── 5. transport failure never throws ────────────────────────────────
  slackFailNext = true;
  let threw = false;
  try {
    await sendClientTextSlackAlert({
      recipientUserIds: [USER_LINKED],
      fromLabel: `Client (${TAG})`,
      preview: "Third text",
      clientId: null,
      messageSid: `SM-${TAG}-3`,
      threadKey: `thread-${TAG}`,
    });
  } catch {
    threw = true;
  }
  check("Slack failure is swallowed — inbound webhook path never throws", () =>
    assert.equal(threw, false),
  );
} finally {
  await cleanup();
}

console.log(`client-text-slack-alert: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
