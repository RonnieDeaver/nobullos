/* test-registration
{
  "name": "Auto-baseline skip alerts (Task #984)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/services/postDeployVerification.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #984 — verify the post-deploy auto-baseline skip alert:
 *   - Fires through `notifyByType` when overall != "pass" and saved=false
 *   - Names the failing groups in the alert payload + metadata
 *   - Persists last-alerted timestamp and dedupes repeat skips within cooldown
 *   - Does NOT fire when overall == "pass" (saved=true) or when alerts disabled
 */

import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  recordAutoBaselineSkip,
  __testHelpers as alertHelpers,
  NOTIFICATION_ID,
  SETTING_LAST_ALERTED_AT,
  SETTING_COOLDOWN_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
} from "../server/services/autoBaselineSkipAlerts";
import type {
  NotifyPayload,
  NotifyOptions,
  NotifyResult,
} from "../server/services/notifications/dispatcher";

interface DispatchedCall {
  id: string;
  text: string;
  meta: Record<string, unknown> | undefined;
}
let dispatched: DispatchedCall[] = [];

const fakeDispatcher = async (
  id: string,
  payload: NotifyPayload,
  opts: NotifyOptions = {},
): Promise<NotifyResult> => {
  dispatched.push({ id, text: payload.text, meta: opts.metadata });
  return {
    attempted: true,
    delivered: true,
    skipped: false,
    status: "delivered",
    channelId: "C-TEST",
    deliveryId: "d-1",
    slackTs: "1.0",
  };
};

const fakeDispatcherSkipped = async (
  id: string,
  payload: NotifyPayload,
  opts: NotifyOptions = {},
): Promise<NotifyResult> => {
  dispatched.push({ id, text: payload.text, meta: opts.metadata });
  return {
    attempted: false,
    delivered: false,
    skipped: true,
    status: "skipped_disabled",
    skipReason: "Notification disabled",
  };
};

async function reset() {
  dispatched = [];
  alertHelpers.setDispatcher(fakeDispatcher);
  for (const k of [SETTING_LAST_ALERTED_AT, SETTING_COOLDOWN_MINUTES]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

async function cleanup() {
  alertHelpers.setDispatcher(null);
  for (const k of [SETTING_LAST_ALERTED_AT, SETTING_COOLDOWN_MINUTES]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

async function testFiresAndNamesGroups() {
  await reset();
  const r = await recordAutoBaselineSkip({
    overall: "warn",
    failingGroups: [
      { id: "913F.1", title: "Sampler verification (913F.1)", status: "warn" },
      { id: "913F.3", title: "Attribution verification (913F.3)", status: "fail" },
    ],
    reason: "overall status was warn, baseline not saved",
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.delivered, "delivered");
  assert(dispatched.length === 1, `1 dispatch, got ${dispatched.length}`);
  assert(dispatched[0].id === NOTIFICATION_ID, "uses notification id");
  assert(
    dispatched[0].text.includes("Sampler verification (913F.1)") &&
      dispatched[0].text.includes("Attribution verification (913F.3)"),
    "names failing groups in payload",
  );
  assert(dispatched[0].meta.overall === "warn", "metadata.overall");
  assert(
    Array.isArray(dispatched[0].meta.failingGroups) &&
      dispatched[0].meta.failingGroups.length === 2,
    "metadata.failingGroups list",
  );
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED_AT);
  assert(stamp?.value && Number(stamp.value) > 0, "last-alerted timestamp persisted");
  console.log("✓ fires + names failing groups + persists timestamp");
}

async function testCooldownDedupes() {
  await reset();
  // Default cooldown is 6h — first call alerts, second call within window dedupes.
  const first = await recordAutoBaselineSkip({
    overall: "fail",
    failingGroups: [
      { id: "913F.2", title: "Incident verification (913F.2)", status: "fail" },
    ],
    reason: "overall status was fail, baseline not saved",
  });
  assert(first.decision === "alerted", "first alert");
  assert(first.cooldownMinutes === DEFAULT_COOLDOWN_MINUTES, "default cooldown");
  assert(dispatched.length === 1, "1 dispatch");

  const second = await recordAutoBaselineSkip({
    overall: "fail",
    failingGroups: [
      { id: "913F.2", title: "Incident verification (913F.2)", status: "fail" },
    ],
    reason: "still failing",
  });
  assert(second.decision === "skipped_cooldown", `decision=${second.decision}`);
  assert(!second.delivered, "not delivered");
  assert(dispatched.length === 1, "no extra dispatch within cooldown");
  console.log("✓ persisted cooldown dedupes repeat skips");
}

async function testCooldownExpires() {
  await reset();
  // Custom 1-minute cooldown so we can exercise the expiry path.
  await setSystemSetting(SETTING_COOLDOWN_MINUTES, "1");
  // Backdate the last-alerted stamp to 2 minutes ago.
  const twoMinAgo = Date.now() - 2 * 60_000;
  await setSystemSetting(SETTING_LAST_ALERTED_AT, String(twoMinAgo));

  const r = await recordAutoBaselineSkip({
    overall: "warn",
    failingGroups: [
      { id: "913F.4", title: "Health-metric correctness (913F.4)", status: "warn" },
    ],
    reason: "overall status was warn, baseline not saved",
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.cooldownMinutes === 1, `cooldown=${r.cooldownMinutes}`);
  assert(dispatched.length === 1, "alert fires once cooldown elapsed");
  console.log("✓ alert resumes once cooldown window elapses");
}

async function testDispatcherSkipped() {
  await reset();
  alertHelpers.setDispatcher(fakeDispatcherSkipped);
  const r = await recordAutoBaselineSkip({
    overall: "fail",
    failingGroups: [
      { id: "913F.1", title: "Sampler verification (913F.1)", status: "fail" },
    ],
    reason: "overall status was fail, baseline not saved",
  });
  assert(
    r.decision === "skipped_dispatcher_skipped",
    `decision=${r.decision}`,
  );
  assert(!r.delivered, "not delivered");
  // Dispatcher-side skip must NOT consume the cooldown — we want the next
  // attempt to retry instead of being silenced for hours.
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED_AT);
  assert(!stamp?.value, "no timestamp persisted on dispatcher skip");
  console.log("✓ dispatcher-side skip does not consume cooldown");
}

async function testTryAutoSnapshotInvokesAlert() {
  // Static guard: assert the wiring in tryAutoSnapshotBaseline still imports
  // and calls recordAutoBaselineSkip on the non-pass branch. ESM exports are
  // read-only so we can't easily monkey-patch runPostDeployVerification at
  // runtime — a source-level guard catches accidental removal of the wiring.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    "server/services/postDeployVerification.ts",
    "utf8",
  );
  assert(
    src.includes('"./autoBaselineSkipAlerts"'),
    "tryAutoSnapshotBaseline imports autoBaselineSkipAlerts",
  );
  assert(
    /report\.overall\s*!==\s*"pass"[\s\S]+recordAutoBaselineSkip\s*\(/m.test(src),
    "non-pass branch calls recordAutoBaselineSkip",
  );
  assert(
    /failingGroups[\s\S]+report\.groups[\s\S]+filter\s*\(\s*\(?g\)?\s*=>\s*g\.status\s*!==\s*"pass"\s*\)/m.test(
      src,
    ),
    "non-pass branch passes failing groups (filtered to status != pass)",
  );
  console.log("✓ tryAutoSnapshotBaseline wiring preserved (source-level guard)");
}

async function testResolverInheritsLegacyChannel() {
  // Integration check against the real resolver — the registry entry must
  // fall back to the legacy `rate_limit_alert_slack_channel_id` setting so
  // default deployments route the alert without admin reconfiguration.
  const { resolveNotification } = await import(
    "../server/services/notifications/resolver"
  );
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");
  const LEGACY_KEY = "rate_limit_alert_slack_channel_id";

  // Clean any prior saved row that might mask the legacy fallback path.
  try {
    await db.execute(
      sql`DELETE FROM notification_settings WHERE notification_id = ${NOTIFICATION_ID}`,
    );
  } catch {}

  const prior = (await getSystemSetting(LEGACY_KEY))?.value ?? null;
  await setSystemSetting(LEGACY_KEY, "C-LEGACY-HEALTH");
  try {
    const resolved = await resolveNotification(NOTIFICATION_ID);
    assert(resolved !== null, "registry knows the id");
    assert(
      resolved!.channelId === "C-LEGACY-HEALTH",
      `channel resolves via legacy key, got ${resolved!.channelId}`,
    );
    assert(
      resolved!.source === "legacy_migrated",
      `source=${resolved!.source}`,
    );
    assert(resolved!.enabled === true, "defaultEnabled=true honored");
  } finally {
    if (prior == null) {
      try {
        await deleteSystemSetting(LEGACY_KEY);
      } catch {}
    } else {
      await setSystemSetting(LEGACY_KEY, prior);
    }
  }
  console.log("✓ resolver falls back to legacy health channel");
}

async function main() {
  try {
    await testFiresAndNamesGroups();
    await testCooldownDedupes();
    await testCooldownExpires();
    await testDispatcherSkipped();
    await testTryAutoSnapshotInvokesAlert();
    await testResolverInheritsLegacyChannel();
    console.log("\nALL AUTO-BASELINE SKIP ALERT TESTS PASSED");
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
