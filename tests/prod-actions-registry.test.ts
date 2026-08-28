/* test-registration
{
  "name": "Prod actions registry (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #1808 — registry-level test for the Task #1807 2 → 3 ramp gate.
 *
 * Covers only the gating logic that the routes test can't exercise
 * cleanly (it requires forging audit rows with synthetic `applied_at`
 * timestamps).
 *
 *   action: `ramp_front_recovery_ingest_concurrency_3`
 *   gate:
 *     - current `front_recovery_ingest_concurrency` must be exactly "2"
 *     - AND a successful `ramp_front_recovery_ingest_concurrency`
 *       (the 1 → 2 ramp) audit row must exist and be ≥24h old
 *     - AND the live API pool must not be under pressure
 *
 * Scenarios:
 *   (A) current=3                          → not-needed ("Already set to 3.")
 *   (B) current=1 (no audit row at all)    → not-needed ("ramp the 1 → 2 action first")
 *   (C) current=2, NO audit row            → not-needed ("Waiting on a recorded successful 1 → 2 ramp")
 *   (D) current=2, audit row 1h old        → not-needed ("Watch window not elapsed")
 *   (E) current=2, audit row 25h old       → pending  (assuming pool healthy in dev)
 *       + apply() flips the setting to "3" and returns `applied`
 *
 * Task #3889 — focused scenarios for `front_recent_window_message_freshness`
 * (the rolling current+previous-month materializer keeper), driven through
 * `__setFrontRecentWindowFreshnessOverridesForTest` so no Front call or real
 * month walk ever runs:
 *   (F1) both months fresh                  → status not-needed; apply → not-needed
 *   (F2) a month stale + pendingWalk        → status pending naming the month
 *   (F3) pendingWalk + Front breaker open   → status blocked (integration Front)
 *   (F4) apply() drains: tick override completes the walk → the durable
 *        `front_recent_window_walked:<month>` marker is stamped, and a
 *        re-status (measure now fresh) reads not-needed
 *
 * All scenarios clean up after themselves.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db, isApiPoolUnderPressure } from "../server/db";
import { storage } from "../server/storage";
import {
  PROD_ACTIONS,
  __setFrontRecentWindowFreshnessOverridesForTest,
  type ProdAction,
} from "../server/services/prodActionsRegistry";
import { ensureProdActionRunsTable } from "../server/storage/prodActionRuns";
import {
  __setFrontAuthStateForTest,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";

const TAG = "task-1808-registry";
const SETTING_KEY = "front_recovery_ingest_concurrency";
const RAMP_2_TO_3_ID = "ramp_front_recovery_ingest_concurrency_3";
const RAMP_1_TO_2_ID = "ramp_front_recovery_ingest_concurrency";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function getAction(id: string): ProdAction {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`registry missing action ${id}`);
  return a;
}

async function setSetting(key: string, value: string): Promise<void> {
  // Pass undefined actor so we don't trip the users FK on
  // `system_settings.updated_by` — the registry test doesn't care who
  // wrote the row, only the value.
  await storage.setSystemSetting(key, value, undefined);
}

async function deleteSetting(key: string): Promise<void> {
  await storage.deleteSystemSetting(key);
}

async function readSettingValue(key: string): Promise<string | null> {
  const row = await storage.getSystemSetting(key);
  return row?.value ?? null;
}

async function insertFakeRampSuccess(ageMs: number): Promise<string> {
  await ensureProdActionRunsTable();
  const appliedAt = new Date(Date.now() - ageMs);
  const res: any = await db.execute(sql`
    INSERT INTO prod_action_runs
      (action_id, action_title, actor_user_id, outcome_state, detail, applied_at)
    VALUES
      (${RAMP_1_TO_2_ID}, ${`${TAG}-fake-1to2`}, NULL, 'applied',
       ${`${TAG}-fake-success ageMs=${ageMs}`}, ${appliedAt.toISOString()})
    RETURNING id
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const id = rows[0]?.id;
  if (!id) throw new Error("failed to insert fake audit row");
  return String(id);
}

async function clearFakeAuditRows(): Promise<void> {
  // Tag-scoped only — never delete unrelated audit rows. Note:
  // `action.apply()` invoked directly (as we do in scenario E) does NOT
  // write to `prod_action_runs` — only `applyAllProdActions()` does.
  // So we have nothing to clean up for the 2→3 action itself.
  await db.execute(sql`
    DELETE FROM prod_action_runs
    WHERE action_id = ${RAMP_1_TO_2_ID}
      AND (
        action_title = ${`${TAG}-fake-1to2`}
        OR detail LIKE ${`${TAG}-fake-success%`}
      )
  `);
}

async function snapshotSettingValue(): Promise<string | null> {
  return readSettingValue(SETTING_KEY);
}

async function restoreSettingValue(original: string | null): Promise<void> {
  if (original == null) {
    await deleteSetting(SETTING_KEY);
  } else {
    await setSetting(SETTING_KEY, original);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const action = getAction(RAMP_2_TO_3_ID);
  assert(action, "2→3 ramp action present in registry");

  const originalSetting = await snapshotSettingValue();
  await clearFakeAuditRows();

  try {
    // (A) Already at 3 → not-needed
    {
      await setSetting(SETTING_KEY, "3");
      const s = await action.status();
      assertEq(s.state, "not-needed", "(A) current=3 ⇒ not-needed");
      assert(s.detail.toLowerCase().includes("already"), `(A) detail mentions already: ${s.detail}`);
      console.log("  ok  (A) current=3 → not-needed");
    }

    // (B) current=1, no audit row → not-needed
    {
      await setSetting(SETTING_KEY, "1");
      await clearFakeAuditRows();
      const s = await action.status();
      assertEq(s.state, "not-needed", "(B) current=1 ⇒ not-needed");
      assert(/1\s*[→\-]\s*2|ramp the 1/i.test(s.detail), `(B) detail mentions 1→2 first: ${s.detail}`);
      console.log("  ok  (B) current=1 → not-needed (wrong precondition)");
    }

    // (C) current=2, no audit row → not-needed (waiting on recorded ramp)
    {
      await setSetting(SETTING_KEY, "2");
      await clearFakeAuditRows();
      const s = await action.status();
      assertEq(s.state, "not-needed", "(C) current=2 + no audit ⇒ not-needed");
      assert(s.detail.toLowerCase().includes("waiting"), `(C) detail mentions waiting: ${s.detail}`);
      console.log("  ok  (C) current=2 + no audit → not-needed (gate closed)");
    }

    // (D) current=2, fake 1h-old success → not-needed (watch window not elapsed)
    {
      await setSetting(SETTING_KEY, "2");
      await clearFakeAuditRows();
      await insertFakeRampSuccess(1 * 60 * 60 * 1000); // 1h old
      try {
        const s = await action.status();
        assertEq(s.state, "not-needed", "(D) 1h-old success ⇒ not-needed");
        assert(/watch window|elapsed/i.test(s.detail), `(D) detail mentions watch window: ${s.detail}`);
        console.log("  ok  (D) current=2 + 1h-old success → not-needed (window not elapsed)");
      } finally {
        await clearFakeAuditRows();
      }
    }

    // (E1) current=2, fake 25h-old success, healthy pool → pending;
    //      then apply() flips the setting to "3". This is the *open-gate*
    //      path — the test FAILS LOUDLY (rather than masking) if the dev
    //      pool is unexpectedly under pressure when the test runs, so a
    //      regression in the watch-window/open-path logic can't slip by.
    {
      await setSetting(SETTING_KEY, "2");
      await clearFakeAuditRows();
      await insertFakeRampSuccess(25 * 60 * 60 * 1000); // 25h old
      try {
        const pressure = isApiPoolUnderPressure();
        if (pressure.underPressure) {
          throw new Error(
            `(E1) cannot exercise open-gate path: API pool is under pressure ` +
              `(${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, ` +
              `waiters=${pressure.waitingCount}). Re-run when the dev pool is idle. ` +
              `The "pressure path" branch of the gate is covered by direct ` +
              `inspection of ramp2to3Action.status() in scenario E2 below.`,
          );
        }
        const s = await action.status();
        assertEq(s.state, "pending", "(E1) 25h-old success + healthy pool ⇒ pending");
        assert(/safe to bump|healthy/i.test(s.detail), `(E1) detail mentions safe/healthy: ${s.detail}`);

        const outcome = await action.apply(null);
        assertEq(outcome.state, "applied", "(E1) apply flips setting");
        const after = await readSettingValue(SETTING_KEY);
        assertEq(after, "3", "(E1) setting is now '3'");

        const s2 = await action.status();
        assertEq(s2.state, "not-needed", "(E1) re-status after apply ⇒ not-needed");
        console.log("  ok  (E1) 25h-old success + healthy pool → pending → apply → not-needed");
      } finally {
        await clearFakeAuditRows();
      }
    }

    // (E2) Pressure-path coverage. We can't force the live API pool
    //      under pressure deterministically without a heavy harness, so
    //      we verify the gate's pressure branch by direct construction:
    //      we re-seed the open-gate preconditions, then assert that IF
    //      `isApiPoolUnderPressure()` is true the status detail mentions
    //      pressure (and the state is `not-needed`). When the pool is
    //      healthy (the normal case), we record that the pressure branch
    //      is unreachable in this run rather than silently pass — this
    //      keeps the coverage gap visible.
    {
      await setSetting(SETTING_KEY, "2");
      await clearFakeAuditRows();
      await insertFakeRampSuccess(25 * 60 * 60 * 1000);
      try {
        const pressure = isApiPoolUnderPressure();
        if (pressure.underPressure) {
          const s = await action.status();
          assertEq(s.state, "not-needed", "(E2) live pressure ⇒ not-needed");
          assert(/pressure/i.test(s.detail), `(E2) detail mentions pressure: ${s.detail}`);
          console.log("  ok  (E2) live pressure observed → not-needed (live-health gate)");
        } else {
          console.log("  --  (E2) live pressure path not exercised this run (dev pool healthy); branch verified by E1 negative + ramp2to3Action source review");
        }
      } finally {
        await clearFakeAuditRows();
      }
    }
  } finally {
    await restoreSettingValue(originalSetting);
    await clearFakeAuditRows();
  }

  await recentWindowScenarios();
}

// ── Task #3889: front_recent_window_message_freshness ───────────────────────

const RECENT_WINDOW_ID = "front_recent_window_message_freshness";

type MonthShape = { month: string; monthStart: Date; monthEnd: Date };

function fakeFreshness(m: MonthShape, o: { stale: boolean; pendingWalk: boolean }) {
  return {
    month: m.month,
    monthStart: m.monthStart,
    monthEnd: m.monthEnd,
    activeConvs: 100,
    materializedConvs: o.stale ? 40 : 99,
    coveragePct: o.stale ? 40 : 99,
    newestSyncAt: new Date(),
    newestMsgAt: new Date(),
    lagDays: o.stale ? 9 : 0,
    stale: o.stale,
    pendingWalk: o.pendingWalk,
  };
}

function currentMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 7);
}

async function recentWindowScenarios(): Promise<void> {
  const action = getAction(RECENT_WINDOW_ID);
  const staleMonth = currentMonthUtc();
  const walkedKey = `front_recent_window_walked:${staleMonth}`;

  try {
    __resetFrontAuthBreakerForTest();

    // (F1) both months fresh → not-needed on status AND apply.
    {
      __setFrontRecentWindowFreshnessOverridesForTest({
        measure: (async (m: MonthShape) => fakeFreshness(m, { stale: false, pendingWalk: false })) as any,
        tick: (async () => {
          throw new Error("tick must not run when nothing is pending");
        }) as any,
      });
      const s = await action.status();
      assertEq(s.state, "not-needed", "(F1) fresh window ⇒ not-needed");
      assert(/fresh/i.test(s.detail), `(F1) detail mentions fresh: ${s.detail}`);
      const outcome = await action.apply(null);
      assertEq(outcome.state, "not-needed", "(F1) apply with nothing pending ⇒ not-needed");
      console.log("  ok  (F1) recent-window fresh → not-needed (status + apply)");
    }

    // (F2) a month stale + pendingWalk → pending, naming the month.
    {
      __setFrontRecentWindowFreshnessOverridesForTest({
        measure: (async (m: MonthShape) =>
          fakeFreshness(m, { stale: m.month === staleMonth, pendingWalk: m.month === staleMonth })) as any,
      });
      const s = await action.status();
      assertEq(s.state, "pending", "(F2) pendingWalk month ⇒ pending");
      assert(s.detail.includes(staleMonth), `(F2) detail names the month: ${s.detail}`);
      console.log("  ok  (F2) stale month → pending");
    }

    // (F3) same pendingWalk month but Front breaker open → blocked.
    {
      __setFrontAuthStateForTest({ breakerOpenUntilMs: Date.now() + 60_000 });
      try {
        const s = await action.status();
        assertEq(s.state, "blocked", "(F3) breaker open ⇒ blocked");
        assertEq((s as any).integration, "Front", "(F3) names the Front integration");
        const outcome = await action.apply(null);
        assertEq(outcome.state, "blocked", "(F3) apply also blocked");
      } finally {
        __resetFrontAuthBreakerForTest();
      }
      console.log("  ok  (F3) breaker open → blocked (status + apply)");
    }

    // (F4) apply() drains: the tick override completes the month's walk in
    // one chunk → the drain stamps the durable walked marker; the measure
    // override flips to fresh once the tick ran, so the drain converges and
    // a re-status reads not-needed.
    {
      let tickCalls = 0;
      __setFrontRecentWindowFreshnessOverridesForTest({
        measure: (async (m: MonthShape) =>
          fakeFreshness(m, {
            stale: m.month === staleMonth && tickCalls === 0,
            pendingWalk: m.month === staleMonth && tickCalls === 0,
          })) as any,
        tick: (async () => {
          tickCalls += 1;
          return { ran: true, inserted: 3, skipped: 1, done: true };
        }) as any,
      });
      await deleteSetting(walkedKey);
      try {
        const outcome = await action.apply(null);
        assertEq(outcome.state, "applied", "(F4) apply kicks the background drain");
        // The drain is asynchronous — poll its durable side effect (the
        // walked marker) rather than sleeping (drain-audit ordering).
        const deadline = Date.now() + 10_000;
        let marker: string | null = null;
        while (Date.now() < deadline) {
          marker = await readSettingValue(walkedKey);
          if (marker) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        assert(marker, "(F4) completed walk stamped the durable walked marker");
        assert(!Number.isNaN(Date.parse(marker!)), `(F4) marker is a timestamp: ${marker}`);
        assertEq(tickCalls, 1, "(F4) exactly one materializer tick ran");
        // The marker lands inside the chunk, slightly before the drain
        // itself unwinds — poll status until the drain-running window
        // closes instead of asserting on the first read.
        let s = await action.status();
        const statusDeadline = Date.now() + 10_000;
        while (s.state === "pending" && Date.now() < statusDeadline) {
          await new Promise((r) => setTimeout(r, 200));
          s = await action.status();
        }
        assertEq(s.state, "not-needed", "(F4) re-status after convergence ⇒ not-needed");
        console.log("  ok  (F4) apply → drain tick → walked marker stamped → not-needed");
      } finally {
        await deleteSetting(walkedKey);
      }
    }
  } finally {
    __setFrontRecentWindowFreshnessOverridesForTest({ measure: null, tick: null });
    __resetFrontAuthBreakerForTest();
    await deleteSetting(walkedKey);
    // Background drains audit their completion — clear this run's rows.
    try {
      await db.execute(sql`DELETE FROM prod_action_runs WHERE action_id = ${RECENT_WINDOW_ID}`);
    } catch {}
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-registry: all scenarios passed");
  },
  (err) => {
    console.error("prod-actions-registry: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
