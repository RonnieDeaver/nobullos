/* test-registration
{
  "name": "Client-products backfill unknown-values alert (Task #1110)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/boot",
    "server/index.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1110 — verify the startup client-products backfill unknown-values
 * alert:
 *   - Fires through `notifyByType` when the backfill drops unrecognized values
 *   - Names the count, distinct unrecognized values, and sample client IDs
 *   - Persists last-alerted timestamp and dedupes repeat boots within cooldown
 *   - Skips cleanly when there are zero unknown values
 *   - Source-level guard: server/index.ts wires the alert into the backfill
 */

import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  recordClientProductsUnknownValues,
  __testHelpers as alertHelpers,
  NOTIFICATION_ID,
  SETTING_LAST_ALERTED_AT,
  SETTING_COOLDOWN_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
} from "../server/services/clientProductsBackfillAlerts";
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

async function testFiresAndIncludesDetails() {
  await reset();
  const r = await recordClientProductsUnknownValues({
    totalUnknownValues: 4,
    rowsWithUnknownValues: 2,
    samples: [
      { clientId: "client-aaa", invalid: ["foo-product", "bar"] },
      { clientId: "client-bbb", invalid: ["foo-product", "baz"] },
    ],
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.delivered, "delivered");
  assert(dispatched.length === 1, `1 dispatch, got ${dispatched.length}`);
  assert(dispatched[0].id === NOTIFICATION_ID, "uses notification id");
  assert(
    dispatched[0].text.includes("4") &&
      dispatched[0].text.includes("2"),
    "includes count + row count in payload",
  );
  assert(
    dispatched[0].text.includes("foo-product") &&
      dispatched[0].text.includes("bar") &&
      dispatched[0].text.includes("baz"),
    "names distinct unrecognized values in payload",
  );
  assert(
    dispatched[0].text.includes("client-aaa") &&
      dispatched[0].text.includes("client-bbb"),
    "names sample client IDs in payload",
  );
  const meta = dispatched[0].meta as Record<string, unknown>;
  assert(meta.totalUnknownValues === 4, "metadata.totalUnknownValues");
  assert(meta.rowsWithUnknownValues === 2, "metadata.rowsWithUnknownValues");
  assert(
    Array.isArray(meta.distinctUnknownValues) &&
      (meta.distinctUnknownValues as string[]).includes("foo-product") &&
      (meta.distinctUnknownValues as string[]).includes("bar") &&
      (meta.distinctUnknownValues as string[]).includes("baz"),
    "metadata.distinctUnknownValues deduped list",
  );
  assert(
    Array.isArray(meta.samples) && (meta.samples as unknown[]).length === 2,
    "metadata.samples list",
  );
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED_AT);
  assert(stamp?.value && Number(stamp.value) > 0, "last-alerted timestamp persisted");
  console.log("✓ fires + includes count/values/samples + persists timestamp");
}

async function testSkippedWhenNoUnknownValues() {
  await reset();
  const r = await recordClientProductsUnknownValues({
    totalUnknownValues: 0,
    rowsWithUnknownValues: 0,
    samples: [],
  });
  assert(
    r.decision === "skipped_no_unknown_values",
    `decision=${r.decision}`,
  );
  assert(!r.delivered, "not delivered");
  assert(dispatched.length === 0, "no dispatch when nothing to report");
  console.log("✓ skips cleanly when there are no unknown values");
}

async function testCooldownDedupes() {
  await reset();
  const first = await recordClientProductsUnknownValues({
    totalUnknownValues: 1,
    rowsWithUnknownValues: 1,
    samples: [{ clientId: "client-x", invalid: ["mystery"] }],
  });
  assert(first.decision === "alerted", "first alert");
  assert(first.cooldownMinutes === DEFAULT_COOLDOWN_MINUTES, "default cooldown");
  assert(dispatched.length === 1, "1 dispatch");

  const second = await recordClientProductsUnknownValues({
    totalUnknownValues: 1,
    rowsWithUnknownValues: 1,
    samples: [{ clientId: "client-x", invalid: ["mystery"] }],
  });
  assert(second.decision === "skipped_cooldown", `decision=${second.decision}`);
  assert(!second.delivered, "not delivered");
  assert(dispatched.length === 1, "no extra dispatch within cooldown");
  console.log("✓ persisted cooldown dedupes repeat boots");
}

async function testCooldownExpires() {
  await reset();
  await setSystemSetting(SETTING_COOLDOWN_MINUTES, "1");
  const twoMinAgo = Date.now() - 2 * 60_000;
  await setSystemSetting(SETTING_LAST_ALERTED_AT, String(twoMinAgo));

  const r = await recordClientProductsUnknownValues({
    totalUnknownValues: 1,
    rowsWithUnknownValues: 1,
    samples: [{ clientId: "client-y", invalid: ["other-mystery"] }],
  });
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.cooldownMinutes === 1, `cooldown=${r.cooldownMinutes}`);
  assert(dispatched.length === 1, "alert fires once cooldown elapsed");
  console.log("✓ alert resumes once cooldown window elapses");
}

async function testDispatcherSkipped() {
  await reset();
  alertHelpers.setDispatcher(fakeDispatcherSkipped);
  const r = await recordClientProductsUnknownValues({
    totalUnknownValues: 1,
    rowsWithUnknownValues: 1,
    samples: [{ clientId: "client-z", invalid: ["mystery"] }],
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

async function testStartupBackfillWiringPreserved() {
  // Source-level guard: server/index.ts must continue importing the alert
  // service and calling recordClientProductsUnknownValues from the
  // unknown-values branch of the startup backfill.
  const fs = await import("node:fs/promises");
  // Task #3787: the startup backfill moved into server/boot/ (thin-orchestrator
  // split); scan index + boot modules.
  const bootFiles = (await fs.readdir("server/boot")).filter((f) => f.endsWith(".ts")).sort();
  const src = [
    await fs.readFile("server/index.ts", "utf8"),
    ...(await Promise.all(bootFiles.map((f) => fs.readFile(`server/boot/${f}`, "utf8")))),
  ].join("\n");
  assert(
    src.includes('services/clientProductsBackfillAlerts"'),
    "startup backfill imports clientProductsBackfillAlerts",
  );
  assert(
    /totalUnknownValues\s*>\s*0[\s\S]+recordClientProductsUnknownValues\s*\(/m.test(
      src,
    ),
    "unknown-values branch calls recordClientProductsUnknownValues",
  );
  console.log("✓ startup backfill wiring preserved (source-level guard)");
}

async function testResolverInheritsLegacyChannel() {
  const { resolveNotification } = await import(
    "../server/services/notifications/resolver"
  );
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");
  const LEGACY_KEY = "rate_limit_alert_slack_channel_id";

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
    await testFiresAndIncludesDetails();
    await testSkippedWhenNoUnknownValues();
    await testCooldownDedupes();
    await testCooldownExpires();
    await testDispatcherSkipped();
    await testStartupBackfillWiringPreserved();
    await testResolverInheritsLegacyChannel();
    console.log("\nALL CLIENT-PRODUCTS BACKFILL ALERT TESTS PASSED");
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
