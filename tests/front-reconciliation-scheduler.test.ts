/* test-registration
{
  "name": "Front reconciliation scheduler (Task #1825)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/boot",
    "server/index.ts",
    "server/services/workerConfig.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1825 — regression tests for the Front reconciliation
 * enqueue scheduler + the `trigger_front_reconciliation_sweep` CEO
 * action.
 *
 * Covers:
 *   (A) Gate is open in the healthy default state → scheduler tick
 *       enqueues one row with the expected workload_class / priority
 *       / dedupe key shape.
 *   (B) After (A) the row is in `pending` → both scheduler tick AND
 *       CEO `apply()` are gated by the in-flight pre-check and return
 *       `inflight_job_present` (no duplicate row is created).
 *   (C) `system_settings.front_reconciliation_scheduler_enabled = false`
 *       gates both surfaces with reason `scheduler_setting_disabled`.
 *   (D) Missing Front access token gates with reason
 *       `front_not_connected`.
 *   (E) `KILL_SWITCH_NON_CRITICAL_SWEEPS = true` gates with reason
 *       `non_critical_sweeps_killed`.
 *   (F) `system_settings.front_reconciliation_interval_minutes`
 *       resolves the scheduler tick interval; invalid values fall
 *       back to the PERF default.
 *   (G) Boot wiring: `startFrontReconciliationScheduler()` is wired
 *       into `server/index.ts` under the documented stagger offset
 *       and registers the right kill-switch-aware producer.
 *
 * Task #1878 — every scenario that touches the database runs inside
 * `runInIsolatedSchema(...)` so the test's `work_queue` /
 * `system_settings` rows live in a per-test schema that the live
 * `Start application` workers (whose default `search_path` is
 * `public`) cannot see, claim, or race-write. That removes the
 * Task #1833 queue-pause + retry-loop scaffolding the previous
 * iteration of this test needed against the shared `public` schema.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

import { storage } from "../server/storage";
import {
  PROD_ACTIONS,
  PROD_ACTION_STATUS_STATES,
  type ProdAction,
} from "../server/services/prodActionsRegistry";
import { setKillSwitch, ensureKillSwitchesLoaded } from "../server/services/killSwitches";
import {
  FRONT_RECONCILIATION_QUEUE,
  SCHEDULER_ENABLED_SETTING,
  SCHEDULER_INTERVAL_SETTING,
  enqueueScheduledFrontReconciliation,
  enqueueManualFrontReconciliation,
  evaluateFrontReconciliationGates,
  __frontReconciliationSchedulerTestHelpers,
} from "../server/services/frontReconciliationScheduler";
import { runInIsolatedSchema } from "./db-sandbox";

const TOKEN_KEY = "front_access_token";
const KILL_SWITCH_PERSISTED_KEY = "kill_switch_non_critical_sweeps";
const ACTION_ID = "trigger_front_reconciliation_sweep";

function getAction(id: string): ProdAction {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`registry missing action ${id}`);
  return a;
}

async function main(): Promise<void> {
  // Kill-switch in-memory map is global to the process. Load it once
  // up-front; we restore non_critical_sweeps to false on exit so we
  // don't poison sibling tests in the run-all harness.
  await ensureKillSwitchesLoaded();

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      try {
        // Seed healthy defaults inside the isolated schema. Settings
        // writes go through storage → getDb() → isolated schema, so
        // the live workspace's `public.system_settings` row is
        // untouched.
        await storage.setSystemSetting(TOKEN_KEY, "test-token-task-1825", undefined);
        await setKillSwitch("non_critical_sweeps", false, undefined);

        const action = getAction(ACTION_ID);

        // (A) Healthy gate → CEO action lifecycle: status=pending →
        //     apply enqueues exactly one row with workload_class=ingestion
        //     + priority=250 + manual-bucket dedupe key → second
        //     status/apply are gated by the in-flight pre-check.
        {
          const statusBefore = await action.status();
          assert.equal(
            statusBefore.state,
            "pending",
            `(A) initial status=pending; got ${JSON.stringify(statusBefore)}`,
          );

          const apply1 = await action.apply(null);
          assert.equal(
            apply1.state,
            "applied",
            `(A) first apply=applied; got ${JSON.stringify(apply1)}`,
          );

          const row: any = await isoDb.execute(sql`
            SELECT queue_name, workload_class, priority, dedupe_key, status
            FROM work_queue
            WHERE queue_name = ${FRONT_RECONCILIATION_QUEUE}
              AND dedupe_key LIKE 'front_reconciliation:manual:%'
              AND status = 'pending'
            ORDER BY id DESC LIMIT 1
          `);
          const r = (Array.isArray(row) ? row : row?.rows ?? [])[0];
          assert.ok(r, "(A) manual enqueue row exists");
          // Task #1829 — `enqueueJob` remaps the three Front pipeline
          // queues to `workload_class='front_ingestion'` only when the
          // `front_warp_speed_enabled` pool-epic switch is ON. Accept
          // either to stay green regardless of switch state.
          assert.ok(
            r.workload_class === "front_ingestion" || r.workload_class === "ingestion",
            `(A) workload_class is one of {front_ingestion, ingestion}; got ${r.workload_class}`,
          );
          assert.equal(Number(r.priority), 250, "(A) priority");
          assert.match(
            String(r.dedupe_key),
            /^front_reconciliation:manual:\d+$/,
            "(A) manual dedupe key",
          );

          // Scheduler path's in-flight gate fires directly — the live
          // worker cannot lease our row because its `search_path` is
          // `public` and our row is in the isolated schema.
          const schedOut = await enqueueScheduledFrontReconciliation();
          assert.equal(schedOut.enqueued, false, "(A) scheduler also gated by in-flight");
          assert.equal((schedOut as any).reason, "inflight_job_present");

          const inFlight =
            await __frontReconciliationSchedulerTestHelpers.isFrontReconciliationInFlight();
          assert.equal(inFlight, true, "(A) row is in-flight");

          const statusAfter = await action.status();
          assert.equal(
            statusAfter.state,
            "not-needed",
            "(A) post-apply status=not-needed (in-flight gate)",
          );
          const apply2 = await action.apply(null);
          assert.equal(
            apply2.state,
            "not-needed",
            "(A) second apply=not-needed (in-flight gate)",
          );
          console.log(
            "  ok  (A) CEO lifecycle pending→applied→not-needed (in-flight gate)",
          );
        }

        // (B) Direct gate evaluation reports `inflight_job_present` while
        //     the scenario-A row is still pending.
        {
          const gate = await evaluateFrontReconciliationGates();
          assert.equal((gate as any).reason, "inflight_job_present", "(B) gate reason");
          const manualOut = await enqueueManualFrontReconciliation();
          assert.equal(manualOut.enqueued, false, "(B) manual no-op");
          assert.equal((manualOut as any).reason, "inflight_job_present", "(B) manual reason");
          console.log(
            "  ok  (B) evaluateFrontReconciliationGates surfaces inflight_job_present",
          );
        }

        // Clear the row before (C) — drop both manual and scheduled
        // pending rows so the next scenarios start from a clean slate.
        await isoDb.execute(sql`DELETE FROM work_queue`);

        // (C) Scheduler setting OFF gates the scheduled tick only;
        //     manual CEO override is intentionally decoupled.
        {
          await storage.setSystemSetting(SCHEDULER_ENABLED_SETTING, "false", undefined);
          try {
            const schedGate = await evaluateFrontReconciliationGates();
            assert.equal(
              (schedGate as any).reason,
              "scheduler_setting_disabled",
              "(C) scheduled gate reason",
            );
            const schedOut = await enqueueScheduledFrontReconciliation();
            assert.equal(schedOut.enqueued, false, "(C) scheduler no-op");
            assert.equal((schedOut as any).reason, "scheduler_setting_disabled");

            const manualGate = await evaluateFrontReconciliationGates("manual");
            assert.equal(manualGate.open, true, "(C) manual gate is open");
            const status = await action.status();
            assert.equal(status.state, "pending", "(C) CEO status pending (manual override)");
            const manualOut = await enqueueManualFrontReconciliation();
            assert.equal(manualOut.enqueued, true, "(C) manual enqueue succeeds");
            await isoDb.execute(sql`DELETE FROM work_queue`);
            console.log(
              "  ok  (C) scheduler setting=false blocks tick but not manual CEO override",
            );
          } finally {
            await storage.deleteSystemSetting(SCHEDULER_ENABLED_SETTING);
          }
        }

        // (D) Missing Front token gates both surfaces. No retry loop
        //     needed: live workers cannot write to our isolated
        //     `system_settings` between our delete and the gate read.
        {
          await storage.deleteSystemSetting(TOKEN_KEY);
          try {
            const gate = await evaluateFrontReconciliationGates();
            assert.equal((gate as any).reason, "front_not_connected", "(D) gate reason");
            const status = await action.status();
            // Task #2155 integration-auth → blocked wiring reclassifies a
            // missing/disconnected Front credential as `blocked` (amber
            // "needs reconnect") rather than `error` (red). The action maps
            // the `front_not_connected` gate reason straight to that state.
            // Validate against the shared canonical state list first so a
            // future rename of the state literal is caught here instead of
            // silently drifting (see prodActionsRegistry state constants).
            assert(
              (PROD_ACTION_STATUS_STATES as readonly string[]).includes(
                status.state,
              ),
              "(D) status state is a recognized prod-action state",
            );
            assert.equal(status.state, "blocked", "(D) CEO blocked state");
            assert.equal(
              (status as any).integration,
              "Front",
              "(D) names the Front integration",
            );
            assert.match(status.detail, /Front login is not connected/i, "(D) detail");
          } finally {
            await storage.setSystemSetting(TOKEN_KEY, "test-token-task-1825", undefined);
          }
          console.log("  ok  (D) missing Front token gates both surfaces");
        }

        // (E) Canonical non-critical sweeps kill switch.
        {
          await setKillSwitch("non_critical_sweeps", true, undefined);
          try {
            const gate = await evaluateFrontReconciliationGates();
            assert.equal(
              (gate as any).reason,
              "non_critical_sweeps_killed",
              "(E) gate reason",
            );
            const status = await action.status();
            assert.equal(status.state, "not-needed", "(E) CEO not-needed");
            assert.match(status.detail, /KILL_SWITCH_NON_CRITICAL_SWEEPS/i, "(E) detail");
            const persisted = await storage.getSystemSetting(KILL_SWITCH_PERSISTED_KEY);
            assert.equal(persisted?.value, "true", "(E) persisted under canonical key");
          } finally {
            await setKillSwitch("non_critical_sweeps", false, undefined);
          }
          console.log(
            "  ok  (E) canonical non-critical-sweeps kill switch gates both surfaces",
          );
        }

        // (F) Interval setting resolution: valid → applied; invalid → fallback.
        {
          const { refreshIntervalMs, resolveIntervalMsSync } =
            __frontReconciliationSchedulerTestHelpers;
          await storage.setSystemSetting(SCHEDULER_INTERVAL_SETTING, "7", undefined);
          try {
            const ms = await refreshIntervalMs();
            assert.equal(ms, 7 * 60_000, "(F) 7m setting applied");
            assert.equal(resolveIntervalMsSync(), 7 * 60_000, "(F) cached interval matches");
            await storage.setSystemSetting(SCHEDULER_INTERVAL_SETTING, "not-a-number", undefined);
            const ms2 = await refreshIntervalMs();
            assert.ok(ms2 > 0, "(F) invalid value falls back to a positive default");
            assert.notEqual(ms2, 7 * 60_000, "(F) invalid value no longer applies the 7m override");
          } finally {
            await storage.deleteSystemSetting(SCHEDULER_INTERVAL_SETTING);
            await refreshIntervalMs();
          }
          console.log("  ok  (F) interval setting resolves; invalid falls back");
        }
      } finally {
        // Best-effort: restore the in-memory kill-switch override so
        // sibling tests in the run-all harness don't inherit a
        // poisoned `non_critical_sweeps=true`. The persisted row
        // lives in the isolated schema and is dropped on exit.
        try {
          await setKillSwitch("non_critical_sweeps", false, undefined);
        } catch {
          /* ignore */
        }
      }
    },
    {
      tables: [
        "work_queue",
        "system_settings",
        "admin_setting_audit",
      ],
    },
  );

  // (G) Boot wiring sanity: file I/O only, no DB. Runs outside the
  //     isolated schema closure.
  {
    // Task #3787: scheduler wiring moved into server/boot/ (thin-orchestrator
    // split); scan index + boot modules.
    const bootDir = path.join(process.cwd(), "server", "boot");
    const idxSrc = [
      path.join(process.cwd(), "server", "index.ts"),
      ...fs.readdirSync(bootDir).filter((f) => f.endsWith(".ts")).sort()
        .map((f) => path.join(bootDir, f)),
    ].map((p) => fs.readFileSync(p, "utf8")).join("\n");
    assert.match(
      idxSrc,
      /startFrontReconciliationScheduler/,
      "(G) server/index.ts wires startFrontReconciliationScheduler",
    );
    assert.match(
      idxSrc,
      /WORKER_STAGGER_OFFSETS\.front_reconciliation_enqueue/,
      "(G) boot uses front_reconciliation_enqueue stagger offset",
    );
    const cfgPath = path.join(process.cwd(), "server", "services", "workerConfig.ts");
    const cfgSrc = fs.readFileSync(cfgPath, "utf8");
    assert.match(
      cfgSrc,
      /front_reconciliation_enqueue:\s*\d+/,
      "(G) workerConfig declares front_reconciliation_enqueue stagger offset",
    );
    console.log("  ok  (G) boot wiring sanity (server/index.ts + workerConfig)");
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("front-reconciliation-scheduler: all scenarios passed");
  },
  (err) => {
    console.error("front-reconciliation-scheduler: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
