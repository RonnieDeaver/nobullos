/* test-registration
{
  "name": "Blocked-IP trim alerts (Task #780)",
  "tier": "small"
}
test-registration */
/**
 * Task #780 — verify the blocked-IP trim alert service:
 *   - Disabled = no dispatch, queue cleared
 *   - Enabled  = batches multiple events into one alert
 *   - Per-IP cooldown suppresses re-alerts on subsequent flushes
 *   - minTrims threshold keeps small batches in the carry-over queue
 *   - Email is skipped cleanly when no recipients are configured
 */

import { setSystemSetting, deleteSystemSetting } from "../server/storage/settingsStorage";
import {
  recordTrimEventsForAlerting,
  flushNow,
  __testHelpers,
  SETTING_ENABLED,
  SETTING_EMAIL,
  SETTING_MIN_TRIMS,
  SETTING_BATCH_WINDOW,
  SETTING_COOLDOWN,
  SETTING_OVERRIDES,
  sendBlockedIpTrimAlertTest,
  matchScopePattern,
  parseOverrides,
  validateScopePattern,
} from "../server/services/blockedIpTrimAlerts";

let dispatchedCalls: Array<{ id: string; text: string; meta: any }> = [];
let mailerCalls: Array<{ to: string[]; subject: string }> = [];

async function fakeDispatcher(id: string, payload: any, opts: any) {
  dispatchedCalls.push({ id, text: payload.text, meta: opts?.metadata });
  return {
    attempted: true,
    delivered: true,
    skipped: false,
    status: "delivered" as any,
    channelId: "C-TEST",
    deliveryId: "d-1",
    slackTs: "1.0",
  };
}

async function fakeMailer(opts: any) {
  mailerCalls.push({ to: opts.to, subject: opts.subject });
  return { ok: true as const };
}

async function setup({
  enabled,
  email = "",
  minTrims = 1,
  cooldownMin = 60,
  windowSec = 60,
  overrides = [] as Array<{ scopePattern: string; minTrims?: number; perIpCooldownMinutes?: number }>,
}: {
  enabled: boolean;
  email?: string;
  minTrims?: number;
  cooldownMin?: number;
  windowSec?: number;
  overrides?: Array<{ scopePattern: string; minTrims?: number; perIpCooldownMinutes?: number }>;
}) {
  await setSystemSetting(SETTING_ENABLED, enabled ? "true" : "false");
  await setSystemSetting(SETTING_EMAIL, email);
  await setSystemSetting(SETTING_MIN_TRIMS, String(minTrims));
  await setSystemSetting(SETTING_BATCH_WINDOW, String(windowSec));
  await setSystemSetting(SETTING_COOLDOWN, String(cooldownMin));
  await setSystemSetting(SETTING_OVERRIDES, JSON.stringify(overrides));
  __testHelpers.reset();
  __testHelpers.setDispatcher(fakeDispatcher as any);
  __testHelpers.setMailer(fakeMailer as any);
  dispatchedCalls = [];
  mailerCalls = [];
}

async function cleanup() {
  __testHelpers.reset();
  __testHelpers.setDispatcher(null);
  __testHelpers.setMailer(null);
  for (const k of [
    SETTING_ENABLED,
    SETTING_EMAIL,
    SETTING_MIN_TRIMS,
    SETTING_BATCH_WINDOW,
    SETTING_COOLDOWN,
    SETTING_OVERRIDES,
  ]) {
    try {
      await deleteSystemSetting(k);
    } catch {}
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

async function testDisabled() {
  await setup({ enabled: false });
  const r = await recordTrimEventsForAlerting(
    [
      { scope: "ip:1.2.3.4", count: 3 },
      { scope: "ip:5.6.7.8", count: 2 },
    ],
    100,
  );
  assert(!r.enqueued, "disabled => not enqueued");
  assert(r.reason === "alerts_disabled", "disabled => reason");
  // A scheduled flush should not produce an alert.
  const f = await flushNow("scheduled");
  assert(f.alertedScopes === 0, "disabled flush has 0 alerts");
  assert(dispatchedCalls.length === 0, "disabled => no dispatch");
  console.log("✓ disabled path");
}

async function testBatching() {
  await setup({ enabled: true, email: "", minTrims: 1 });
  await recordTrimEventsForAlerting(
    [
      { scope: "ip:1.2.3.4", count: 5 },
      { scope: "ip:5.6.7.8", count: 7 },
    ],
    100,
  );
  // Same scope, more trims → folded into the same pending bucket.
  await recordTrimEventsForAlerting([{ scope: "ip:1.2.3.4", count: 4 }], 100);
  const f = await flushNow("manual");
  assert(f.alertedScopes === 2, `expected 2 scopes alerted, got ${f.alertedScopes}`);
  assert(f.totalTrimmed === 16, `expected 16 trimmed, got ${f.totalTrimmed}`);
  assert(dispatchedCalls.length === 1, "should batch into 1 Slack call");
  assert(
    dispatchedCalls[0].text.includes("ip:1.2.3.4") &&
      dispatchedCalls[0].text.includes("ip:5.6.7.8"),
    "Slack text mentions both IPs",
  );
  assert(mailerCalls.length === 0, "no email when no recipients");
  console.log("✓ batching across calls + scopes");
}

async function testCooldown() {
  await setup({ enabled: true, cooldownMin: 60 });
  await recordTrimEventsForAlerting([{ scope: "ip:9.9.9.9", count: 5 }], 100);
  let f = await flushNow("manual");
  assert(f.alertedScopes === 1, "first manual flush alerts");
  assert(dispatchedCalls.length === 1, "first dispatch");

  // Same IP trims again — scheduled flush should be suppressed by cooldown.
  await recordTrimEventsForAlerting([{ scope: "ip:9.9.9.9", count: 3 }], 100);
  f = await flushNow("scheduled");
  assert(f.alertedScopes === 0, "scheduled flush suppressed by cooldown");
  const cooldownRow = f.perScope.find((p) => p.scope === "ip:9.9.9.9");
  assert(cooldownRow?.decision === "skipped_cooldown", "decision = cooldown");
  assert(dispatchedCalls.length === 1, "no extra dispatch during cooldown");
  console.log("✓ per-IP cooldown");
}

async function testMinThreshold() {
  await setup({ enabled: true, minTrims: 5 });
  await recordTrimEventsForAlerting([{ scope: "ip:7.7.7.7", count: 2 }], 100);
  let f = await flushNow("manual");
  assert(f.alertedScopes === 0, "below min => no alert");
  assert(__testHelpers.pendingCount() === 1, "below-min stays in carry-over");

  // More trims arrive — now over threshold.
  await recordTrimEventsForAlerting([{ scope: "ip:7.7.7.7", count: 4 }], 100);
  f = await flushNow("manual");
  assert(f.alertedScopes === 1, "now over min => alerted");
  assert(f.totalTrimmed === 6, `total trimmed = 6, got ${f.totalTrimmed}`);
  console.log("✓ minTrims threshold + carry-over");
}

async function testEmailRecipients() {
  await setup({ enabled: true, email: "alerts@example.com, ops@example.com" });
  await recordTrimEventsForAlerting([{ scope: "ip:2.2.2.2", count: 9 }], 100);
  const f = await flushNow("manual");
  assert(f.alertedScopes === 1, "alerted");
  assert(mailerCalls.length === 1, "one email batch");
  assert(
    mailerCalls[0].to.length === 2 &&
      mailerCalls[0].to.includes("alerts@example.com"),
    "two recipients parsed",
  );
  assert(
    mailerCalls[0].subject.includes("Blocked-IP history trimmed"),
    "subject set",
  );
  console.log("✓ email recipients parsed + sent");
}

async function testTestSendBypassesEnabled() {
  // Disabled, but the explicit "Send test" button still exercises both
  // channels so admins can validate config before turning alerts on.
  await setup({ enabled: false, email: "alerts@example.com" });
  const r = await sendBlockedIpTrimAlertTest();
  assert(r.alertedScopes >= 1, "test send produces an alert row");
  assert(dispatchedCalls.length === 1, "test send dispatches Slack");
  assert(mailerCalls.length === 1, "test send dispatches email");
  console.log("✓ test send works while alerts disabled");
}

async function testMatchScopePattern() {
  // Exact
  assert(matchScopePattern("ip:1.2.3.4", "ip:1.2.3.4"), "exact match");
  assert(!matchScopePattern("ip:1.2.3.4", "ip:1.2.3.5"), "exact mismatch");
  // Glob
  assert(matchScopePattern("ip:1.2.3.4", "ip:1.2.3.*"), "glob /24");
  assert(matchScopePattern("ip:10.0.0.1", "ip:10.*"), "glob /8");
  assert(!matchScopePattern("ip:1.2.4.5", "ip:1.2.3.*"), "glob mismatch");
  // CIDR
  assert(matchScopePattern("ip:203.0.113.7", "203.0.113.0/24"), "cidr /24 hit");
  assert(!matchScopePattern("ip:203.0.114.7", "203.0.113.0/24"), "cidr /24 miss");
  assert(matchScopePattern("ip:10.5.6.7", "10.0.0.0/8"), "cidr /8 hit");
  assert(!matchScopePattern("ip:11.5.6.7", "10.0.0.0/8"), "cidr /8 miss");
  assert(matchScopePattern("ip:1.2.3.4", "0.0.0.0/0"), "cidr /0 matches all");
  assert(matchScopePattern("ip:1.2.3.4", "1.2.3.4/32"), "cidr /32 exact");
  assert(!matchScopePattern(null, "1.2.3.0/24"), "null scope never matches");
  console.log("✓ matchScopePattern (exact/glob/cidr)");
}

async function testValidateScopePattern() {
  assert(validateScopePattern("ip:1.2.3.4") === null, "exact ok");
  assert(validateScopePattern("ip:1.2.3.*") === null, "glob ok");
  assert(validateScopePattern("203.0.113.0/24") === null, "cidr ok");
  assert(validateScopePattern("0.0.0.0/0") === null, "cidr /0 ok");
  assert(validateScopePattern("1.2.3.4/32") === null, "cidr /32 ok");
  assert(validateScopePattern("") !== null, "empty rejected");
  assert(validateScopePattern("   ") !== null, "blank rejected");
  assert(validateScopePattern("1.2.3.0/99") !== null, "bad bits rejected");
  assert(validateScopePattern("999.1.2.3/24") !== null, "bad octet rejected");
  assert(validateScopePattern("foo/bar") !== null, "non-cidr slash rejected");
  console.log("✓ validateScopePattern");
}

async function testParseOverrides() {
  assert(parseOverrides(null).length === 0, "null => empty");
  assert(parseOverrides("not json").length === 0, "bad json => empty");
  assert(parseOverrides("{}").length === 0, "non-array => empty");
  const ok = parseOverrides(
    JSON.stringify([
      { scopePattern: "ip:1.2.3.*", minTrims: 10 },
      { scopePattern: "", minTrims: 5 }, // dropped: blank pattern
      { scopePattern: "ip:9.*", perIpCooldownMinutes: 0 },
      { scopePattern: "ip:5.*" }, // dropped: no-op
      { scopePattern: "ip:7.*", minTrims: -1 }, // dropped: bad value, no-op left
    ]),
  );
  assert(ok.length === 2, `expected 2 valid overrides, got ${ok.length}`);
  assert(ok[0].minTrims === 10, "first parsed");
  assert(ok[1].perIpCooldownMinutes === 0, "zero cooldown is allowed");
  console.log("✓ parseOverrides");
}

async function testOverrideMinTrims() {
  // Global minTrims = 10, but override raises it to 100 for the noisy /24.
  await setup({
    enabled: true,
    minTrims: 10,
    overrides: [{ scopePattern: "ip:203.0.113.*", minTrims: 100 }],
  });
  await recordTrimEventsForAlerting(
    [
      { scope: "ip:203.0.113.7", count: 50 }, // below override's 100
      { scope: "ip:198.51.100.1", count: 50 }, // above global 10
    ],
    100,
  );
  const f = await flushNow("manual");
  const noisy = f.perScope.find((p) => p.scope === "ip:203.0.113.7");
  const other = f.perScope.find((p) => p.scope === "ip:198.51.100.1");
  assert(
    noisy?.decision === "skipped_below_min" && noisy.skipReason?.includes("override"),
    `noisy IP should be below override min, got ${JSON.stringify(noisy)}`,
  );
  assert(
    other?.decision === "alerted",
    `non-matching IP should follow global min, got ${JSON.stringify(other)}`,
  );
  assert(f.alertedScopes === 1, `only the non-overridden IP alerts (got ${f.alertedScopes})`);
  console.log("✓ per-prefix minTrims override");
}

async function testOverrideCooldown() {
  // Global cooldown = 60min; abuse range gets cooldown = 0 (always alert).
  await setup({
    enabled: true,
    cooldownMin: 60,
    overrides: [{ scopePattern: "198.51.100.0/24", perIpCooldownMinutes: 0 }],
  });
  await recordTrimEventsForAlerting([{ scope: "ip:198.51.100.5", count: 5 }], 100);
  let f = await flushNow("manual");
  assert(f.alertedScopes === 1, "first alert fires");

  // Same scope again — scheduled flush should NOT be suppressed by cooldown
  // because the override sets it to 0.
  await recordTrimEventsForAlerting([{ scope: "ip:198.51.100.5", count: 5 }], 100);
  f = await flushNow("scheduled");
  assert(
    f.alertedScopes === 1,
    `override should bypass cooldown, got alerted=${f.alertedScopes}`,
  );

  // A different IP (global cooldown) should still be suppressed after alerting.
  await recordTrimEventsForAlerting([{ scope: "ip:9.9.9.9", count: 5 }], 100);
  f = await flushNow("manual"); // manual ignores cooldown — establish prior
  assert(f.alertedScopes === 1, "global IP first alert");
  await recordTrimEventsForAlerting([{ scope: "ip:9.9.9.9", count: 5 }], 100);
  f = await flushNow("scheduled");
  const row = f.perScope.find((p) => p.scope === "ip:9.9.9.9");
  assert(
    row?.decision === "skipped_cooldown",
    `global IP should still respect 60m cooldown, got ${JSON.stringify(row)}`,
  );
  console.log("✓ per-prefix cooldown override");
}

async function main() {
  try {
    await testDisabled();
    await testBatching();
    await testCooldown();
    await testMinThreshold();
    await testEmailRecipients();
    await testTestSendBypassesEnabled();
    await testMatchScopePattern();
    await testValidateScopePattern();
    await testParseOverrides();
    await testOverrideMinTrims();
    await testOverrideCooldown();
    console.log("\nALL BLOCKED-IP TRIM ALERT TESTS PASSED");
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
