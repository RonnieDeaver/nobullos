/* test-registration
{
  "name": "Front outbound gap-close corrupt-last-run admin alert (Task #2197)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/services/workQueueHandlers.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2197 — verify the corrupt-last-run admin alert for the Front
 * outbound gap-close driver:
 *   - Fires an in-app notification to every responsible admin when the
 *     persisted last-run summary is `unreadable` (a real persistence bug)
 *   - Names the parse error, deep-links to the Front integration panel,
 *     and tags a stable category + dedupeKey
 *   - Does NOT fire when the last-run reads `ok` or `never_run`
 *   - Honors a persisted cooldown so a corruption re-detected every tick
 *     can't flood the bell
 *   - Skips cleanly when no recipients resolve (no cooldown consumed)
 *   - Source-level guard: the outbound gap-close worker tick calls the
 *     alert before running the tick
 */

import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  alertIfLastRunUnreadable,
  __testHelpers as alertHelpers,
  UNREADABLE_ALERT_DEDUPE_KEY,
  SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  SETTING_UNREADABLE_ALERT_MUTED,
  SETTING_LAST_RUN,
  readUnreadableAlertConfig,
  setUnreadableAlertConfig,
  DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES,
} from "../server/services/frontOutboundGapCloser";

const SETTING_LAST_ALERTED =
  "front_outbound_gap_close:unreadable_alert_last_at";

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

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

let savedLastRun: string | null = null;

async function snapshot() {
  savedLastRun = (await getSystemSetting(SETTING_LAST_RUN))?.value ?? null;
}

async function reset(recipients: string[]) {
  calls = [];
  alertHelpers.setResolveAlertRecipients(async () => recipients);
  alertHelpers.setNotifyUser(fakeNotifyUser);
  for (const k of [
    SETTING_LAST_ALERTED,
    SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    SETTING_UNREADABLE_ALERT_MUTED,
  ]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

async function setLastRunCorrupt() {
  await setSystemSetting(SETTING_LAST_RUN, "{not-valid-json", "test");
}

async function cleanup() {
  alertHelpers.setResolveAlertRecipients(null);
  alertHelpers.setNotifyUser(null);
  for (const k of [
    SETTING_LAST_ALERTED,
    SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    SETTING_UNREADABLE_ALERT_MUTED,
  ]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
  if (savedLastRun === null) await deleteSystemSetting(SETTING_LAST_RUN);
  else await setSystemSetting(SETTING_LAST_RUN, savedLastRun, "test");
}

async function testFiresWhenUnreadable() {
  await reset(["admin-1", "admin-2"]);
  await setLastRunCorrupt();
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.recipientCount === 2, `recipientCount=${r.recipientCount}`);
  assert(calls.length === 2, `2 notifyUser calls, got ${calls.length}`);
  const ids = calls.map((c) => c.userId).sort();
  assert(ids[0] === "admin-1" && ids[1] === "admin-2", "notifies both admins");
  for (const c of calls) {
    assert(c.category === "system", `category=${c.category}`);
    assert(
      c.title.toLowerCase().includes("corrupt") ||
        c.title.toLowerCase().includes("status"),
      "title flags corrupt status",
    );
    assert((c.body ?? "").length > 0, "body present");
    assert(c.deepLink === "/admin/front", `deepLink=${c.deepLink}`);
    assert(
      c.dedupeKey === UNREADABLE_ALERT_DEDUPE_KEY,
      `dedupeKey=${c.dedupeKey}`,
    );
    assert(
      "error" in (c.metadata ?? {}),
      "metadata carries the parse error key",
    );
  }
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(stamp?.value && Number(stamp.value) > 0, "cooldown timestamp persisted");
  console.log("✓ fires to all admins with deep link + dedupe key when unreadable");
}

async function testSkipsWhenNeverRun() {
  await reset(["admin-1"]);
  await deleteSystemSetting(SETTING_LAST_RUN);
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "skipped_not_unreadable", `decision=${r.decision}`);
  assert(calls.length === 0, "no alert on never_run");
  console.log("✓ never_run (fresh deploy) raises no alert");
}

async function testSkipsWhenOk() {
  await reset(["admin-1"]);
  await setSystemSetting(
    SETTING_LAST_RUN,
    JSON.stringify({ ranAt: new Date().toISOString(), enabled: false }),
    "test",
  );
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "skipped_not_unreadable", `decision=${r.decision}`);
  assert(calls.length === 0, "no alert on a well-formed summary");
  console.log("✓ well-formed last-run raises no alert");
}

async function testCooldownDedupes() {
  await reset(["admin-1"]);
  await setLastRunCorrupt();
  const first = await alertIfLastRunUnreadable();
  assert(first.decision === "alerted", `first=${first.decision}`);
  assert(calls.length === 1, "1 call");

  const second = await alertIfLastRunUnreadable();
  assert(second.decision === "skipped_cooldown", `second=${second.decision}`);
  assert(calls.length === 1, "no extra call within cooldown");
  console.log("✓ persisted cooldown dedupes a re-detected corruption");
}

async function testCooldownExpires() {
  await reset(["admin-1"]);
  await setLastRunCorrupt();
  await setSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES, "1", "test");
  const twoMinAgo = Date.now() - 2 * 60_000;
  await setSystemSetting(SETTING_LAST_ALERTED, String(twoMinAgo), "test");

  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "alerted", `decision=${r.decision}`);
  assert(r.cooldownMinutes === 1, `cooldown=${r.cooldownMinutes}`);
  assert(calls.length === 1, "alert fires once cooldown elapsed");
  console.log("✓ alert resumes once cooldown window elapses");
}

async function testSkippedNoRecipients() {
  await reset([]);
  await setLastRunCorrupt();
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "skipped_no_recipients", `decision=${r.decision}`);
  assert(calls.length === 0, "no calls without recipients");
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(!stamp?.value, "no cooldown consumed when nothing was sent");
  console.log("✓ skips cleanly with no recipients (no cooldown consumed)");
}

async function testCooldownNotConsumedWhenAllNotifyFail() {
  await reset(["admin-1"]);
  await setLastRunCorrupt();
  alertHelpers.setNotifyUser((async () => {
    throw new Error("notify pipeline down");
  }) as any);
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "skipped_error", `decision=${r.decision}`);
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(!stamp?.value, "no cooldown consumed when every notify failed");
  console.log("✓ cooldown not consumed when all notifications fail (retries next tick)");
}

async function testMutedSkipsAlert() {
  await reset(["admin-1", "admin-2"]);
  await setLastRunCorrupt();
  await setSystemSetting(SETTING_UNREADABLE_ALERT_MUTED, "true", "test");
  const r = await alertIfLastRunUnreadable();
  assert(r.decision === "skipped_muted", `decision=${r.decision}`);
  assert(calls.length === 0, "muted alert fires nothing");
  const stamp = await getSystemSetting(SETTING_LAST_ALERTED);
  assert(!stamp?.value, "muted skip consumes no cooldown");
  console.log("✓ muted corrupt-status alert raises no notification");
}

async function testReadAndSetConfigRoundTrip() {
  await reset(["admin-1"]);
  // Defaults when nothing is persisted.
  const def = await readUnreadableAlertConfig();
  assert(
    def.cooldownMinutes === DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    `default cooldown=${def.cooldownMinutes}`,
  );
  assert(def.muted === false, "default not muted");
  assert(
    def.minCooldownMinutes === MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES &&
      def.maxCooldownMinutes === MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    "config carries bounds",
  );

  // Tune cooldown + mute via the writer, then read it back.
  const updated = await setUnreadableAlertConfig(
    { cooldownMinutes: 15, muted: true },
    "test",
  );
  assert(updated.cooldownMinutes === 15, `set cooldown=${updated.cooldownMinutes}`);
  assert(updated.muted === true, "set muted=true");
  const readBack = await readUnreadableAlertConfig();
  assert(readBack.cooldownMinutes === 15, "cooldown persisted");
  assert(readBack.muted === true, "muted persisted");

  // Un-mute alone leaves the cooldown untouched.
  const unmuted = await setUnreadableAlertConfig({ muted: false }, "test");
  assert(unmuted.muted === false, "un-muted");
  assert(unmuted.cooldownMinutes === 15, "cooldown unchanged by mute toggle");
  console.log("✓ readUnreadableAlertConfig / setUnreadableAlertConfig round-trip");
}

async function testSetConfigRejectsOutOfBounds() {
  await reset(["admin-1"]);
  for (const bad of [
    0,
    MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES - 1,
    MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES + 1,
    1.5,
  ]) {
    let threw = false;
    try {
      await setUnreadableAlertConfig({ cooldownMinutes: bad }, "test");
    } catch (err) {
      threw = err instanceof RangeError;
    }
    assert(threw, `cooldownMinutes=${bad} must throw RangeError`);
  }
  // A rejected write must not have persisted anything.
  const after = await readUnreadableAlertConfig();
  assert(
    after.cooldownMinutes === DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    "out-of-bounds write left default cooldown intact",
  );
  console.log("✓ setUnreadableAlertConfig rejects out-of-bounds / non-integer cooldown");
}

async function testWorkerTickWiringGuard() {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile("server/services/workQueueHandlers.ts", "utf8");
  assert(
    /alertIfLastRunUnreadable\s*\(/m.test(src),
    "worker tick calls alertIfLastRunUnreadable",
  );
  console.log("✓ worker tick wiring preserved (source-level guard)");
}

async function main() {
  await snapshot();
  try {
    await testFiresWhenUnreadable();
    await testSkipsWhenNeverRun();
    await testSkipsWhenOk();
    await testCooldownDedupes();
    await testCooldownExpires();
    await testSkippedNoRecipients();
    await testCooldownNotConsumedWhenAllNotifyFail();
    await testMutedSkipsAlert();
    await testReadAndSetConfigRoundTrip();
    await testSetConfigRejectsOutOfBounds();
    await testWorkerTickWiringGuard();
    console.log("\nALL OUTBOUND GAP-CLOSE UNREADABLE-ALERT TESTS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
