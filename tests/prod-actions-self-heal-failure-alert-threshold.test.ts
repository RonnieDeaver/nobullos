/* test-registration
{
  "name": "Prod actions self heal failure alert threshold (baseline triage, Task #3424)",
  "timeoutMs": 300000,
  "tier": "medium"
}
test-registration */
/**
 * Task #2173 — let the CEO tune the self-heal persistent-failure alert
 * sensitivity (the consecutive-error trip point) from the panel, bounded
 * 1..50, write-through (reflected on the next self-heal tick).
 *
 * Covers the service-level setter/accessors that back the new
 * `POST /api/admin/prod-actions/failure-alert-threshold` route and the
 * `selfHealFailureAlertThreshold` field on `getProdActionStatuses()`:
 *   (A) in-range write          → stored verbatim, surfaced by status
 *   (B) above cap (>50)         → clamped to 50
 *   (C) below min (<1)          → floored to 1
 *   (D) fractional input        → floored to integer
 *   (E) non-finite input        → throws (route answers 400)
 *
 * Shared-DB note: `system_settings` reads go through a cache-aside Redis
 * layer (`server/storage/settingsStorage.ts`). Under the full suite the
 * live app's self-heal scheduler reads this exact key on every tick, so a
 * concurrent stale read can re-poison the shared cache *after* our write's
 * `cacheDel`. We bust the cache before every read and retry the
 * convergence assertions. The original setting value is restored after.
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import {
  getFailureAlertThreshold,
  setFailureAlertThreshold,
  FAILURE_ALERT_THRESHOLD_MIN,
  FAILURE_ALERT_THRESHOLD_CAP,
} from "../server/services/prodActionSelfHeal";
import { getProdActionStatuses } from "../server/services/prodActionsRegistry";
import { cacheDel } from "../server/services/cache/redisCache";

const SETTING_KEY = "prod_action_self_heal_failure_alert_threshold";
const SYSTEM_SETTINGS_NS = "system_settings";

async function bustCache(): Promise<void> {
  await cacheDel(SYSTEM_SETTINGS_NS, SETTING_KEY).catch(() => {});
}

async function readThresholdWithRetry(expected: number): Promise<number> {
  let last = NaN;
  for (let i = 0; i < 15; i++) {
    await bustCache();
    last = await getFailureAlertThreshold();
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function statusThresholdWithRetry(expected: number): Promise<number> {
  let last = NaN;
  for (let i = 0; i < 15; i++) {
    await bustCache();
    last = (await getProdActionStatuses()).selfHealFailureAlertThreshold;
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function main(): Promise<void> {
  assert.equal(FAILURE_ALERT_THRESHOLD_MIN, 1, "min is 1");
  assert.equal(FAILURE_ALERT_THRESHOLD_CAP, 50, "cap is 50");

  const original = await (async () => {
    await bustCache();
    return (await storage.getSystemSetting(SETTING_KEY))?.value ?? null;
  })();

  try {
    // (A) in-range write stored verbatim and surfaced by status
    {
      const effective = await setFailureAlertThreshold(7);
      assert.equal(effective, 7, "(A) setter returns the stored value");
      assert.equal(
        await readThresholdWithRetry(7),
        7,
        "(A) accessor reflects the write",
      );
      assert.equal(
        await statusThresholdWithRetry(7),
        7,
        "(A) status surfaces the write",
      );
      console.log("  ok  (A) in-range 7 stored + surfaced");
    }

    // (B) above cap clamps to 50
    {
      const effective = await setFailureAlertThreshold(999);
      assert.equal(effective, 50, "(B) >cap clamps to 50");
      assert.equal(
        await readThresholdWithRetry(50),
        50,
        "(B) accessor shows clamped 50",
      );
      console.log("  ok  (B) above cap clamps to 50");
    }

    // (C) below min floors to 1
    {
      const effective = await setFailureAlertThreshold(0);
      assert.equal(effective, 1, "(C) <min floors to 1");
      assert.equal(
        await readThresholdWithRetry(1),
        1,
        "(C) accessor shows floored 1",
      );
      console.log("  ok  (C) below min floors to 1");
    }

    // (D) fractional input floors to integer
    {
      const effective = await setFailureAlertThreshold(4.9);
      assert.equal(effective, 4, "(D) 4.9 floors to 4");
      console.log("  ok  (D) fractional input floors to integer");
    }

    // (E) non-finite input throws (route answers 400)
    {
      await assert.rejects(
        () => setFailureAlertThreshold(Number.NaN),
        /finite/,
        "(E) NaN rejects",
      );
      await assert.rejects(
        () => setFailureAlertThreshold(Infinity),
        /finite/,
        "(E) Infinity rejects",
      );
      console.log("  ok  (E) non-finite input throws");
    }
  } finally {
    if (original == null) {
      await storage.deleteSystemSetting(SETTING_KEY);
    } else {
      await storage.setSystemSetting(SETTING_KEY, original, undefined);
    }
    await bustCache();
  }
}

main().then(
  () => {
    console.log(
      "prod-actions-self-heal-failure-alert-threshold: all scenarios passed",
    );
    process.exit(0);
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-failure-alert-threshold: FAILED —",
      err?.stack ?? err,
    );
    process.exit(1);
  },
);
