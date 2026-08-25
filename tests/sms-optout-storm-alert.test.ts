/* test-registration
{
  "name": "SMS opt-out storm alert semantics (Task #4336)",
  "regression": true,
  "sweepOnlyReason": "Task #4336 — alert-cadence semantics: pins/restores shared storm settings and walks threshold/cooldown/growth windows against the shared dev DB events table; settings-mutating and timing-shaped, not a smoke-gate candidate (send-gate + webhook smoke suites cover the runtime paths).",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
// Task #4336 — the opt-out storm watcher: durable windowed count (survives
// restarts via sms_consent_events), threshold trigger, cooldown with
// growth override, disabled short-circuit, and house dispatch semantics
// (only delivered/skipped_deduped counts as "alerted" — dispatch RESOLVES
// on failure, it never throws).
//
// Dispatcher is stubbed via the module's injection seam; DB writes run in
// runInTxSandbox; module in-memory state is reset in finally.
//
// Usage: tsx tests/sms-optout-storm-alert.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { runInTxSandbox } from "./db-sandbox";
import {
  recordSmsOptOutAndEvaluate,
  getSmsOptOutStormAlertConfig,
  SETTING_ENABLED,
  SETTING_WINDOW,
  SETTING_THRESHOLD,
  SETTING_COOLDOWN,
  __testHelpers,
} from "../server/services/smsOptOutStormAlerts";
import { insertConsentEvent } from "../server/storage/smsConsentStorage";
import { setSystemSetting } from "../server/storage/settingsStorage";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

function freshPhone(): string {
  const suffix = String(Math.floor(1000000 + Math.random() * 8999999));
  return `+1215${suffix}`;
}

/** Insert the durable opt_out event row the live consent service would write. */
async function durableOptOut(phoneE164: string): Promise<void> {
  await insertConsentEvent({
    phoneNormalized: phoneE164,
    eventType: "opt_out",
    keyword: "STOP",
    source: "keyword_inbound",
    detail: `storm test ${RUN}`,
  });
}

type CapturedDispatch = { id: string; payload: any; opts: any };

async function main(): Promise<void> {
  console.log("SMS opt-out storm alert semantics (Task #4336)");

  const captured: CapturedDispatch[] = [];
  let dispatchResult: any = { attempted: true, delivered: true, skipped: false, status: "sent" };

  __testHelpers.resetForTests();
  __testHelpers.setDispatcherForTests((async (id: string, payload: any, opts: any) => {
    captured.push({ id, payload, opts });
    return dispatchResult;
  }) as any);

  try {
    await runInTxSandbox(async () => {
      // Pin the config: threshold 2 in a 60-min window, 240-min cooldown.
      await setSystemSetting(SETTING_ENABLED, "true");
      await setSystemSetting(SETTING_WINDOW, "60");
      await setSystemSetting(SETTING_THRESHOLD, "2");
      await setSystemSetting(SETTING_COOLDOWN, "240");
      const cfg = await getSmsOptOutStormAlertConfig();
      check(
        "config reads the pinned values",
        cfg.enabled && cfg.windowMinutes === 60 && cfg.threshold === 2 && cfg.cooldownMinutes === 240,
      );

      console.log("\n— 1. Below threshold stays silent —");
      const p1 = freshPhone();
      await durableOptOut(p1);
      const one = await recordSmsOptOutAndEvaluate(p1);
      check(
        "1 opt-out < threshold 2 → skipped_below_threshold",
        one.decision === "skipped_below_threshold" && one.windowedCount === 1,
        `${one.decision} count=${one.windowedCount}`,
      );
      check("no dispatch yet", captured.length === 0);

      console.log("\n— 2. Threshold crossing alerts —");
      const p2 = freshPhone();
      await durableOptOut(p2);
      const two = await recordSmsOptOutAndEvaluate(p2);
      check("2nd opt-out in window → alerted", two.decision === "alerted" && two.windowedCount === 2, two.decision);
      check("dispatcher called exactly once", captured.length === 1);
      check(
        "alert text names the count/window and points at the admin ledger",
        Boolean(
          captured[0]?.payload?.text?.includes("2 STOP-family") &&
            captured[0]?.payload?.text?.includes("/admin/sms-consent"),
        ),
      );
      check(
        "alert never leaks a full phone number",
        !captured[0]?.payload?.text?.includes(p1) && !captured[0]?.payload?.text?.includes(p2),
      );

      console.log("\n— 3. Cooldown + growth override —");
      const p3 = freshPhone();
      await durableOptOut(p3);
      const three = await recordSmsOptOutAndEvaluate(p3);
      check(
        "inside cooldown without threshold-sized growth → skipped_cooldown",
        three.decision === "skipped_cooldown" && three.windowedCount === 3,
        three.decision,
      );
      const p4 = freshPhone();
      const p5 = freshPhone();
      await durableOptOut(p4);
      await durableOptOut(p5);
      const five = await recordSmsOptOutAndEvaluate(p5);
      check(
        "growth ≥ threshold inside cooldown re-alerts (storm keeps growing)",
        five.decision === "alerted" && five.windowedCount === 5,
        `${five.decision} count=${five.windowedCount}`,
      );
      check("second dispatch recorded", captured.length === 2);

      console.log("\n— 4. Disabled + dispatch-failure semantics —");
      await setSystemSetting(SETTING_ENABLED, "false");
      const disabled = await recordSmsOptOutAndEvaluate(freshPhone());
      check("disabled → skipped_disabled (no dispatch)", disabled.decision === "skipped_disabled");
      check("disabled did not dispatch", captured.length === 2);

      await setSystemSetting(SETTING_ENABLED, "true");
      __testHelpers.resetForTests(); // clear lastAlert so the next eval re-fires
      dispatchResult = { attempted: true, delivered: false, skipped: true, status: "failed" };
      const p6 = freshPhone();
      await durableOptOut(p6);
      const failed1 = await recordSmsOptOutAndEvaluate(p6);
      check(
        "resolved-but-undelivered dispatch → skipped_dispatcher_skipped (NOT alerted)",
        failed1.decision === "skipped_dispatcher_skipped",
        failed1.decision,
      );
      // Because the failure did NOT set lastAlert, recovery re-fires without
      // waiting out a cooldown.
      dispatchResult = { attempted: true, delivered: true, skipped: false, status: "sent" };
      const p7 = freshPhone();
      await durableOptOut(p7);
      const recovered = await recordSmsOptOutAndEvaluate(p7);
      check("next evaluation after dispatcher recovery alerts", recovered.decision === "alerted");
    });
  } finally {
    __testHelpers.setDispatcherForTests(null);
    __testHelpers.resetForTests();
    // The sandbox rolled the settings rows back, but setSystemSetting also
    // populates the shared settings cache — restore the shipped defaults so
    // no later reader sees the test's tightened threshold.
    const d = __testHelpers.DEFAULTS as {
      enabled: boolean;
      windowMinutes: number;
      threshold: number;
      cooldownMinutes: number;
    };
    await setSystemSetting(SETTING_ENABLED, String(d.enabled));
    await setSystemSetting(SETTING_WINDOW, String(d.windowMinutes));
    await setSystemSetting(SETTING_THRESHOLD, String(d.threshold));
    await setSystemSetting(SETTING_COOLDOWN, String(d.cooldownMinutes));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
