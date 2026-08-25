/* test-registration
{
  "name": "Prod-actions self-heal reconnect-alert enable (Task #2201)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2201 — registry-level test for the one-press CEO prod-action that
 * turns ON the reconnect-required (auth-dead) self-heal alert
 * (`enable_prod_action_self_heal_reconnect_alert`).
 *
 * Mirrors the sibling persistent-failure enable action
 * (`enable_prod_action_self_heal_failure_alert`, Task #2154). The action
 * is a plain `systemSettingAction` that flips
 * `prod_action_self_heal_reconnect_alert_enabled` to "true",
 * write-through and idempotent.
 *
 * Scenarios:
 *   (A) setting unset            → pending; apply flips it to "true"
 *   (B) setting already "true"   → not-needed (idempotent, no re-write)
 *   (C) setting "false"          → pending; apply flips it to "true"
 *   (D) Task #4840 — with the lever ON, a self-heal tick pages ONLY for
 *       blocked outcomes that NAME an integration (auth-dead); a blocked
 *       outcome without one (precondition wait-state, e.g. the Zoom
 *       legacy-retirement soak) is tracked but never pages and never
 *       latches `reconnectAlertSent`.
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
import {
  runProdActionSelfHealTick,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  type SelfHealReconnectAlert,
} from "../server/services/prodActionSelfHeal";

const ACTION_ID = "enable_prod_action_self_heal_reconnect_alert";
const SETTING_KEY = "prod_action_self_heal_reconnect_alert_enabled";
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
  assert(action, "reconnect-alert enable action present in registry");

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

    // (D) Task #4840 — with the alert lever ON (scenario C just flipped it
    // to "true"), drive an injected tick carrying BOTH blocked flavors:
    // only the integration-named (auth-dead) outcome may page. Uses the
    // in-memory tick seams (persist:false, priorSchedule:{}), so nothing
    // durable is written; the master-switch + budget settings the tick
    // reads are pinned and restored below.
    {
      const originalEnabled =
        (await storage.getSystemSetting(SETTING_ENABLED))?.value ?? null;
      const originalMax =
        (await storage.getSystemSetting(SETTING_MAX_PER_TICK))?.value ?? null;
      try {
        await storage.setSystemSetting(SETTING_ENABLED, "true", undefined);
        await storage.setSystemSetting(SETTING_MAX_PER_TICK, "10", undefined);
        for (const key of [SETTING_ENABLED, SETTING_MAX_PER_TICK, SETTING_KEY]) {
          await cacheDel(SYSTEM_SETTINGS_NS, key).catch(() => {});
        }

        const alerts: Array<{ actionId: string; integration: string | null }> = [];
        const alertReconnect: SelfHealReconnectAlert = async (e) => {
          alerts.push({ actionId: e.actionId, integration: e.integration });
        };
        const mkBlocked = (id: string, integration?: string): any => ({
          id,
          title: `fake ${id}`,
          description: "test",
          kind: "custom",
          apply: async () =>
            integration
              ? {
                  state: "blocked",
                  detail: "SEMrush login expired — reconnect.",
                  integration,
                }
              : {
                  state: "blocked",
                  detail: "Waiting for soak evidence — preconditions not yet met.",
                },
          selfHeal: { cadenceMs: 1_000, backoffMs: 600_000 },
        });

        const r = await runProdActionSelfHealTick({
          actions: [mkBlocked("wait_no_integration"), mkBlocked("auth_dead", "SEMrush")],
          recordRun: async () => {},
          alertReconnect,
          now: new Date("2026-06-01T00:00:00.000Z"),
          priorSchedule: {},
          persist: false,
        });

        assert.deepEqual(
          r.reconnectAlertsSent,
          ["auth_dead"],
          "(D) only the integration-named blocked outcome pages",
        );
        assert.equal(alerts.length, 1, "(D) exactly one page");
        assert.equal(alerts[0].actionId, "auth_dead");
        assert.equal(alerts[0].integration, "SEMrush");
        assert.equal(r.blocked, 2, "(D) both flavors still count as blocked");
        assert.equal(
          r.schedule["wait_no_integration"].reconnectAlertSent,
          false,
          "(D) waiting-blocked never latches the reconnect-page flag",
        );
        assert.equal(
          r.schedule["auth_dead"].reconnectAlertSent,
          true,
          "(D) auth-dead latches the de-dupe flag as before",
        );
        console.log(
          "  ok  (D) tick pages only for integration-named blocked outcomes",
        );
      } finally {
        if (originalEnabled == null) {
          await storage.deleteSystemSetting(SETTING_ENABLED);
        } else {
          await storage.setSystemSetting(SETTING_ENABLED, originalEnabled, undefined);
        }
        if (originalMax == null) {
          await storage.deleteSystemSetting(SETTING_MAX_PER_TICK);
        } else {
          await storage.setSystemSetting(SETTING_MAX_PER_TICK, originalMax, undefined);
        }
      }
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
    console.log("prod-actions-self-heal-reconnect-alert-enable: all scenarios passed");
    process.exit(0);
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-reconnect-alert-enable: FAILED —",
      err?.stack ?? err,
    );
    process.exit(1);
  },
);
