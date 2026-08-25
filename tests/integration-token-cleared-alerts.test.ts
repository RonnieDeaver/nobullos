/* test-registration
{
  "name": "Integration token auto-cleared admin alert (Task #1978)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/services/slackIntegration.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1978 — verify the integration-token-auto-cleared admin alert:
 *   - Fires an in-app notification to every responsible admin when an
 *     integration token is auto-cleared by a terminal auth error
 *   - Names the provider, the error code, and deep-links to the
 *     Integrations Hub card
 *   - Honors a persisted per-provider cooldown so repeats don't flood
 *   - Skips cleanly when no recipients resolve
 *   - Source-level guard: slackIntegration.disconnect() fires the alert
 *     only on the connect_terminal_auth_error trigger
 */

import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  notifyIntegrationTokenCleared,
  __testHelpers as alertHelpers,
  SETTING_COOLDOWN_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
} from "../server/services/integrationTokenClearedAlerts";

interface NotifyCall {
  userId: string;
  category: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  dedupeKey: string | null;
  metadata: Record<string, unknown> | null;
}
let calls: NotifyCall[] = [];

const fakeNotifyUser = (async (userId: string, opts: any) => {
  calls.push({
    userId,
    category: opts.category,
    title: opts.title,
    body: opts.body ?? null,
    deepLink: opts.deepLink ?? null,
    dedupeKey: opts.dedupeKey ?? null,
    metadata: opts.metadata ?? null,
  });
  return null;
}) as any;

const SETTING_LAST_ALERTED = "integration_token_cleared:slack:last_alerted_at";

async function reset(recipients: string[]) {
  calls = [];
  alertHelpers.setResolveRecipients(async () => recipients);
  alertHelpers.setNotifyUser(fakeNotifyUser);
  for (const k of [SETTING_LAST_ALERTED, SETTING_COOLDOWN_MINUTES]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

async function cleanup() {
  alertHelpers.setResolveRecipients(null);
  alertHelpers.setNotifyUser(null);
  for (const k of [SETTING_LAST_ALERTED, SETTING_COOLDOWN_MINUTES]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

async function testFiresToAllAdminsWithDetails() {
  await reset(["admin-1", "admin-2"]);
  const r = await notifyIntegrationTokenCleared({
    provider: "slack",
    providerLabel: "Slack",
    errorCode: "token_revoked",
    trigger: "connect_terminal_auth_error",
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.recipientCount === 2, `recipientCount=${r.recipientCount}`);
  assert(calls.length === 2, `2 notifyUser calls, got ${calls.length}`);
  const ids = calls.map((c) => c.userId).sort();
  assert(ids[0] === "admin-1" && ids[1] === "admin-2", "notifies both admins");
  for (const c of calls) {
    assert(c.category === "system", `category=${c.category}`);
    assert(c.title.includes("Slack"), "title names provider");
    assert((c.body ?? "").includes("token_revoked"), "body names error code");
    assert(c.deepLink === "/admin/integrations", `deepLink=${c.deepLink}`);
    assert(
      c.dedupeKey === "integration-token-cleared:slack",
      `dedupeKey=${c.dedupeKey}`,
    );
    assert(
      (c.metadata as any)?.errorCode === "token_revoked",
      "metadata names error code",
    );
    assert((c.metadata as any)?.provider === "slack", "metadata names provider");
  }
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(stamp?.value && Number(stamp.value) > 0, "cooldown timestamp persisted");
  console.log("✓ fires to all admins + names provider/error + deep link");
}

async function testCooldownDedupes() {
  await reset(["admin-1"]);
  const first = await notifyIntegrationTokenCleared({
    provider: "slack",
    errorCode: "invalid_auth",
    trigger: "connect_terminal_auth_error",
  });
  assert(first.decision === "alerted", "first alert");
  assert(first.cooldownMinutes === DEFAULT_COOLDOWN_MINUTES, "default cooldown");
  assert(calls.length === 1, "1 call");

  const second = await notifyIntegrationTokenCleared({
    provider: "slack",
    errorCode: "invalid_auth",
    trigger: "connect_terminal_auth_error",
  });
  assert(second.decision === "skipped_cooldown", `decision=${second.decision}`);
  assert(calls.length === 1, "no extra call within cooldown");
  console.log("✓ persisted cooldown dedupes repeat auto-clears");
}

async function testCooldownExpires() {
  await reset(["admin-1"]);
  await setSystemSetting(SETTING_COOLDOWN_MINUTES, "1");
  const twoMinAgo = Date.now() - 2 * 60_000;
  await setSystemSetting(SETTING_LAST_ALERTED, String(twoMinAgo));

  const r = await notifyIntegrationTokenCleared({
    provider: "slack",
    errorCode: "invalid_auth",
    trigger: "connect_terminal_auth_error",
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.cooldownMinutes === 1, `cooldown=${r.cooldownMinutes}`);
  assert(calls.length === 1, "alert fires once cooldown elapsed");
  console.log("✓ alert resumes once cooldown window elapses");
}

async function testSkippedNoRecipients() {
  await reset([]);
  const r = await notifyIntegrationTokenCleared({
    provider: "slack",
    errorCode: "invalid_auth",
    trigger: "connect_terminal_auth_error",
  });
  assert(r.decision === "skipped_no_recipients", `decision=${r.decision}`);
  assert(calls.length === 0, "no calls without recipients");
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(!stamp?.value, "no cooldown consumed when nothing was sent");
  console.log("✓ skips cleanly with no recipients (no cooldown consumed)");
}

async function testDisconnectWiringGuard() {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile("server/services/slackIntegration.ts", "utf8");
  assert(
    src.includes('"./integrationTokenClearedAlerts"'),
    "disconnect imports integrationTokenClearedAlerts",
  );
  assert(
    /trigger\s*===\s*"connect_terminal_auth_error"[\s\S]+notifyIntegrationTokenCleared\s*\(/m.test(
      src,
    ),
    "alert fires only on connect_terminal_auth_error trigger",
  );
  console.log("✓ disconnect wiring preserved (source-level guard)");
}

async function main() {
  try {
    await testFiresToAllAdminsWithDetails();
    await testCooldownDedupes();
    await testCooldownExpires();
    await testSkippedNoRecipients();
    await testDisconnectWiringGuard();
    console.log("\nALL INTEGRATION-TOKEN-CLEARED ALERT TESTS PASSED");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
