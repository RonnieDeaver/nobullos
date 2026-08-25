/* test-registration
{
  "name": "Prod-actions re-run Front 2025-11 historical recovery — status/apply + breaker/cap guards (Task #2717)",
  "regression": true,
  "sweepOnlyReason": "Task #2717 — DB-heavy: isolated-schema clones of system_settings; not a fast smoke-gate candidate",
  "tier": "small"
}
test-registration */
/**
 * Task #2717 — end-to-end verification for the `rerun_front_recovery_2025_11`
 * prod-action.
 *
 * The 2025-11 historical-recovery checkpoint stuck `status='partial'`
 * scanned=0/pages=0 after a page-1 OAuth-rotation 401, and matched NEITHER
 * existing recovery action. This suite covers the server-side status/apply
 * drive of the dedicated action:
 *
 *   1. STATUS — pending when the checkpoint is poisoned/never-scanned;
 *      not-needed once complete with scanned>0; pending while a run is in
 *      flight (`running`); blocked (names Front) while the auth breaker is open.
 *
 *   2. APPLY — happy path delegates to the recovery launcher with the EXACT
 *      hard-coded 2025-11 window and reports applied with the job id; it
 *      short-circuits (launcher never runs) when already complete, while a run
 *      is in flight, and while the breaker is open; a RecoveryConcurrencyCapError
 *      degrades to not-needed (transient), and a generic launcher throw → error.
 *
 * Isolation (Task #1929 pattern): everything runs inside `runInIsolatedSchema`
 * so the live `Start application` workers (default search_path = public) can
 * neither see nor race-write the seeded `system_settings` checkpoint row, and
 * the real `runHistoricalRecovery` engine is never invoked (the launcher seam is
 * stubbed) so no Front I/O happens.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  getRerunFront202511RecoveryStatus,
  applyRerunFront202511Recovery,
  __setFront202511RecoveryLauncherOverrideForTest,
} from "../server/services/prodActionsRegistry";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import { RecoveryConcurrencyCapError } from "../server/services/frontHistoricalRecovery";
import { runInIsolatedSchema } from "./db-sandbox";

const CHECKPOINT_KEY = "front_recovery_checkpoint_2025_11";
const EXPECTED_AFTER = 1761955200;
const EXPECTED_BEFORE = 1764547200;

const TABLES = ["system_settings"] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function seedCheckpoint(
  isoDb: IsoDb,
  cp: Record<string, unknown>,
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (${CHECKPOINT_KEY}, ${JSON.stringify(cp)}, 'system', NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

// ── 1. STATUS ───────────────────────────────────────────────────────────
async function testStatus(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // (a) no checkpoint at all → pending (a press will start the re-run).
      __resetFrontAuthBreakerForTest();
      let s = await getRerunFront202511RecoveryStatus();
      assert.equal(s.state, "pending", `no checkpoint → pending (got ${s.state})`);

      // (b) poisoned partial scanned=0 → pending.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "partial",
        scanned: 0,
        pages: 0,
        statusReason:
          "auto_unblocked_after_probe_ok_was:front_auth_unauthorized_after_refresh",
      });
      s = await getRerunFront202511RecoveryStatus();
      assert.equal(s.state, "pending", `poisoned partial → pending (got ${s.state})`);

      // (c) complete with scanned>0 → not-needed.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "complete",
        scanned: 9761,
      });
      s = await getRerunFront202511RecoveryStatus();
      assert.equal(s.state, "not-needed", `complete+scanned → not-needed (got ${s.state})`);

      // (c2) complete but scanned=0 (genuinely empty / never really scanned)
      // → still pending, NOT a false "done".
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "complete",
        scanned: 0,
      });
      s = await getRerunFront202511RecoveryStatus();
      assert.equal(s.state, "pending", `complete+scanned=0 → pending (got ${s.state})`);

      // (d) running → pending (in progress).
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "running",
        scanned: 100,
        startedAt: new Date().toISOString(),
      });
      s = await getRerunFront202511RecoveryStatus();
      assert.equal(s.state, "pending", `running → pending (got ${s.state})`);

      // (e) breaker open + poisoned partial → blocked, names Front.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "partial",
        scanned: 0,
      });
      tripFrontAuthBreaker("front_not_connected");
      try {
        s = await getRerunFront202511RecoveryStatus();
        assert.equal(s.state, "blocked", `breaker open → blocked (got ${s.state})`);
        assert.notEqual(s.state, "error", "blocked must never surface as error");
        assert.equal(
          (s as { integration?: string }).integration,
          "Front",
          "blocked status names Front",
        );
      } finally {
        __resetFrontAuthBreakerForTest();
      }

      // (e2) breaker open but already complete → not-needed wins over blocked.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "complete",
        scanned: 9761,
      });
      tripFrontAuthBreaker("front_not_connected");
      try {
        s = await getRerunFront202511RecoveryStatus();
        assert.equal(s.state, "not-needed", `complete wins over breaker (got ${s.state})`);
      } finally {
        __resetFrontAuthBreakerForTest();
      }

      ok("status: pending / not-needed / running / blocked(Front) computed correctly");
    },
    { tables: TABLES },
  );
}

// ── 2. APPLY ────────────────────────────────────────────────────────────
async function testApply(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetFrontAuthBreakerForTest();

      // (a) happy path: launcher invoked with the EXACT hard-coded window.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "partial",
        scanned: 0,
      });
      let launchArgs: { label: string; afterTimestamp: number; beforeTimestamp: number } | null =
        null;
      __setFront202511RecoveryLauncherOverrideForTest(async (w) => {
        launchArgs = w;
        return { jobId: "recovery-test-123" };
      });
      try {
        const out = await applyRerunFront202511Recovery("user-ceo");
        assert.equal(out.state, "applied", `happy path → applied (got ${out.state})`);
        assert.ok(
          out.detail.includes("recovery-test-123"),
          `detail surfaces the job id (got: ${out.detail})`,
        );
        assert.deepEqual(
          launchArgs,
          { label: "2025-11", afterTimestamp: EXPECTED_AFTER, beforeTimestamp: EXPECTED_BEFORE },
          `launcher gets the exact 2025-11 window (got ${JSON.stringify(launchArgs)})`,
        );
        ok("apply: happy path delegates to the recovery launcher with the exact window");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
      }

      // (b) already complete with scanned>0 → not-needed, launcher NOT called.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "complete",
        scanned: 9761,
      });
      let calledWhenComplete = false;
      __setFront202511RecoveryLauncherOverrideForTest(async (w) => {
        calledWhenComplete = true;
        return { jobId: "should-not-run" };
      });
      try {
        const out = await applyRerunFront202511Recovery(null);
        assert.equal(out.state, "not-needed", `complete → not-needed (got ${out.state})`);
        assert.equal(calledWhenComplete, false, "complete → launcher never runs");
        ok("apply: already-complete short-circuits without launching");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
      }

      // (c) running → not-needed (no double-start), launcher NOT called.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "running",
        scanned: 100,
        startedAt: new Date().toISOString(),
      });
      let calledWhenRunning = false;
      __setFront202511RecoveryLauncherOverrideForTest(async () => {
        calledWhenRunning = true;
        return { jobId: "should-not-run" };
      });
      try {
        const out = await applyRerunFront202511Recovery(null);
        assert.equal(out.state, "not-needed", `running → not-needed (got ${out.state})`);
        assert.equal(calledWhenRunning, false, "running → launcher never runs (no double-start)");
        ok("apply: a run already in flight is not restarted");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
      }

      // (d) breaker open → blocked (names Front), launcher NOT called.
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "partial",
        scanned: 0,
      });
      let calledWhenBlocked = false;
      __setFront202511RecoveryLauncherOverrideForTest(async () => {
        calledWhenBlocked = true;
        return { jobId: "should-not-run" };
      });
      tripFrontAuthBreaker("front_not_connected");
      try {
        const out = await applyRerunFront202511Recovery(null);
        assert.equal(out.state, "blocked", `breaker → blocked (got ${out.state})`);
        assert.notEqual(out.state, "error", "blocked apply must never surface as error");
        assert.equal(
          (out as { integration?: string }).integration,
          "Front",
          "blocked outcome names Front",
        );
        assert.equal(calledWhenBlocked, false, "breaker → no Front drive starts");
        ok("apply: breaker open → blocked(Front), no launch");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
        __resetFrontAuthBreakerForTest();
      }

      // (e) concurrency cap reached → not-needed (transient, not error).
      await seedCheckpoint(isoDb, {
        windowLabel: "2025-11",
        status: "partial",
        scanned: 0,
      });
      __setFront202511RecoveryLauncherOverrideForTest(async () => {
        throw new RecoveryConcurrencyCapError(3, 3);
      });
      try {
        const out = await applyRerunFront202511Recovery(null);
        assert.equal(out.state, "not-needed", `cap reached → not-needed (got ${out.state})`);
        ok("apply: recovery worker at capacity degrades to not-needed (transient)");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
      }

      // (f) generic launcher throw → error.
      __setFront202511RecoveryLauncherOverrideForTest(async () => {
        throw new Error("boom from engine");
      });
      try {
        const out = await applyRerunFront202511Recovery(null);
        assert.equal(out.state, "error", `generic throw → error (got ${out.state})`);
        assert.ok(
          out.detail.includes("boom from engine"),
          `error detail surfaces the cause (got: ${out.detail})`,
        );
        ok("apply: a genuine launcher failure surfaces as error");
      } finally {
        __setFront202511RecoveryLauncherOverrideForTest(null);
      }
    },
    { tables: TABLES },
  );
}

async function main(): Promise<void> {
  await testStatus();
  await testApply();
  console.log(`\n${passed} assertion group(s) passed`);
  console.log("prod-actions-rerun-front-recovery-2025-11.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
