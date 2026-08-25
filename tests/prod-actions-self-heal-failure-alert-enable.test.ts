/* test-registration
{
  "name": "Prod-actions self-heal failure-alert enable (Task #2238)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2238 — registry-level test for the one-press CEO prod-action that
 * turns ON the persistent-failure alert for the maintenance prod-action
 * self-healer (`enable_prod_action_self_heal_failure_alert`, Task #2154).
 *
 * Mirrors the sibling reconnect-required enable action
 * (`enable_prod_action_self_heal_reconnect_alert`, Task #2201). The action
 * is a plain `systemSettingAction` that flips
 * `prod_action_self_heal_failure_alert_enabled` to "true",
 * write-through and idempotent.
 *
 * Scenarios:
 *   (A) setting unset            → pending; apply flips it to "true"
 *   (B) setting already "true"   → not-needed (idempotent, no re-write)
 *   (C) setting "false"          → pending; apply flips it to "true"
 *
 * Shared-DB note: `system_settings` reads go through a cache-aside Redis
 * layer (`server/storage/settingsStorage.ts`). Under the full suite the
 * live app's self-heal scheduler reads this exact key on every tick, so a
 * concurrent stale read can re-poison the shared cache *after* our write's
 * `cacheDel` (classic cache-aside invalidation race). We defend against
 * that by busting the cache immediately before every status/apply read and
 * retrying the convergence assertions until they reflect the value we just
 * committed. All scenarios restore the original setting value afterward.
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import {
  PROD_ACTIONS,
  type ProdAction,
} from "../server/services/prodActionsRegistry";
import { cacheDel } from "../server/services/cache/redisCache";

const ACTION_ID = "enable_prod_action_self_heal_failure_alert";
const SETTING_KEY = "prod_action_self_heal_failure_alert_enabled";
// Mirror of the private namespace in settingsStorage.ts so we can bust the
// same cache entry its read-through layer uses.
const SYSTEM_SETTINGS_NS = "system_settings";

function getAction(id: string): ProdAction {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`registry missing action ${id}`);
  return a;
}

async function bustCache(): Promise<void> {
  await cacheDel(SYSTEM_SETTINGS_NS, SETTING_KEY).catch(() => {});
}

async function setSetting(value: string): Promise<void> {
  await storage.setSystemSetting(SETTING_KEY, value, undefined);
}

async function deleteSetting(): Promise<void> {
  await storage.deleteSystemSetting(SETTING_KEY);
}

async function readSettingValue(): Promise<string | null> {
  await bustCache();
  const row = await storage.getSystemSetting(SETTING_KEY);
  return row?.value ?? null;
}

async function main(): Promise<void> {
  const action = getAction(ACTION_ID);
  assert(action, "failure-alert enable action present in registry");

  // Read the action status, tolerant of a concurrent app process
  // re-poisoning the shared system_settings cache between our write and
  // our read. Bust the cache, read, and retry until the status converges
  // on the expected state (or we exhaust attempts → return the last seen
  // state so the caller's assert prints a useful diff).
  async function statusStateWithRetry(expected: string): Promise<string> {
    let last = "";
    for (let i = 0; i < 15; i++) {
      await bustCache();
      last = (await action.status()).state;
      if (last === expected) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  }

  const original = await readSettingValue();

  try {
    // (A) unset → pending; apply flips to "true"
    {
      await deleteSetting();
      assert.equal(
        await statusStateWithRetry("pending"),
        "pending",
        "(A) unset ⇒ pending",
      );

      await bustCache();
      const outcome = await action.apply(null);
      assert.equal(outcome.state, "applied", "(A) apply ⇒ applied");
      assert.equal(await readSettingValue(), "true", "(A) setting is now 'true'");

      assert.equal(
        await statusStateWithRetry("not-needed"),
        "not-needed",
        "(A) re-status after apply ⇒ not-needed",
      );
      console.log("  ok  (A) unset → pending → apply → not-needed");
    }

    // (B) already "true" → not-needed (idempotent)
    {
      await setSetting("true");
      assert.equal(
        await statusStateWithRetry("not-needed"),
        "not-needed",
        "(B) already true ⇒ not-needed",
      );

      await bustCache();
      const outcome = await action.apply(null);
      assert.equal(
        outcome.state,
        "not-needed",
        "(B) apply when already true ⇒ not-needed",
      );
      assert.equal(await readSettingValue(), "true", "(B) setting unchanged");
      console.log("  ok  (B) already true → not-needed (idempotent)");
    }

    // (C) "false" → pending; apply flips to "true"
    {
      await setSetting("false");
      assert.equal(
        await statusStateWithRetry("pending"),
        "pending",
        "(C) false ⇒ pending",
      );

      await bustCache();
      const outcome = await action.apply(null);
      assert.equal(outcome.state, "applied", "(C) apply ⇒ applied");
      assert.equal(await readSettingValue(), "true", "(C) setting is now 'true'");
      console.log("  ok  (C) false → pending → apply → not-needed");
    }
  } finally {
    if (original == null) {
      await deleteSetting();
    } else {
      await setSetting(original);
    }
  }
}

main().then(
  () => {
    console.log("prod-actions-self-heal-failure-alert-enable: all scenarios passed");
    process.exit(0);
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-failure-alert-enable: FAILED —",
      err?.stack ?? err,
    );
    process.exit(1);
  },
);
