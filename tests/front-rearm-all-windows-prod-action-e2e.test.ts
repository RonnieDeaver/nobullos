/* test-registration
{
  "name": "Front all-windows re-arm prod-action e2e (Task #2156)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/oneWindowReArmDrainSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2156 — End-to-end coverage for the operator-driven re-arm of
 * ALL parked Front recovery windows.
 *
 * Task #2120 covered the *auto-park* branch (escalate → wait → park →
 * release) inside `runFrontAutoClosureTick`. The complementary
 * operator-driven path — the one-press `rearm_parked_front_recovery_windows`
 * prod-action that re-runs every window parked under the search-escalation
 * strategy — is only covered at the unit level
 * (tests/front-auto-closure-search-escalation-rearm.test.ts) and the
 * per-window drain (tests/front-one-window-rearm-drain.test.ts). The
 * all-windows prod-action handler itself had no e2e test; a regression
 * there would silently leave parked windows un-recoverable by the CEO.
 *
 * This file drives the action through its REAL registry handler — it looks
 * the action up in `PROD_ACTIONS` by id and calls `apply()` / `status()`,
 * exactly as the CEO prod-actions surface does — so the whole chain runs
 * for real: registry `apply` → `startParkedWindowReArmDrain` →
 * `startBackgroundDrain` → `reArmOneParkedWindow` (eligibility + unpark /
 * stamp). Only the leaves are stubbed: the Front walk
 * (`runTargetedWindowBackfill`) and the finalize-audit
 * (`recordProdActionRun`) are redirected to in-memory stubs via the
 * shared Node ESM resolve hook (registered through
 * `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs` in run-all.ts),
 * so the suite makes no real Front API calls and never writes the
 * `prod_action_runs` table.
 *
 * It pins the behaviors the unit / per-window suites cannot:
 *
 *   A. Re-drive-and-unpark — several windows parked with
 *      `searchEscalated:true` are each re-driven EXACTLY ONCE by a single
 *      press; an `ingested` outcome clears the parked marker (and the
 *      in-flight escalation marker), the audit row reflects the count, the
 *      action's `status()` flips to `not-needed`, and a SECOND press is a
 *      no-op (`not-needed`, no double-enqueue).
 *   B. Stays-parked convergence — windows whose re-run still dead-runs
 *      (`still_empty`) stay parked but are stamped terminal, so the drain
 *      terminates after exactly one pass per window (no within-drain
 *      re-enqueue) and a second operator press is `not-needed`
 *      (permanently ineligible → no double-enqueue).
 *
 * State note: like the sibling re-arm suites this reads/writes the shared
 * persisted auto-closure state in `system_settings`, which the live dev
 * server's `runFrontAutoClosureTick` also mutates. All persisted rows use
 * a unique far-future month prefix (2994-*) that never appears in the
 * coverage table, so the dev server's read-modify-write preserves them and
 * this suite cleans them up before and after.
 *
 * Usage: tsx --import ./tests/helpers/oneWindowReArmDrainSetup.mjs \
 *            tests/front-rearm-all-windows-prod-action-e2e.test.ts
 */
import assert from "node:assert/strict";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  __frontAutoClosureTestHelpers,
  listReArmableParkedWindows,
  createInMemoryStateStore,
  __setFrontAutoClosureStateStoreForTest,
} from "../server/services/frontAutoClosure";
import {
  getDrainState,
  isDrainRunning,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
} from "../server/services/poolEpicKillSwitches";
import {
  __getRecordedRuns,
  __resetRecordedRuns,
} from "./helpers/prodActionRunsStub.mjs";
import {
  __setNextCheckpoint,
  __getCallCount,
  __resetStub,
} from "./helpers/frontHistoricalRecoveryReArmStub.mjs";

const { isReArmEligible } = __frontAutoClosureTestHelpers;

const FUTURE_YEAR = 2994;

// Task #2239 — drive an injected in-memory store instead of read-modify-
// writing the global `front_auto_closure_state` setting on the shared dev
// DB. This suite exercises the REAL registry handler, which loads/saves
// state through the module's own accessors (no stateStore param), so the
// store is installed via the module-level test override
// (`__setFrontAutoClosureStateStoreForTest`) in main() and cleared in the
// finally. Re-creating it resets state between runs.
let stateStore = createInMemoryStateStore();
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const ACTION_ID = "rearm_parked_front_recovery_windows";

/** The real registered prod-action — invoked exactly as the CEO surface does. */
const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
assert.ok(action, `prod-action ${ACTION_ID} is registered`);

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Remove every 2994-* entry this suite may have written. */
async function cleanupFutureState(): Promise<void> {
  const state = await stateStore.load();
  for (const bag of [
    state.parkedWindows,
    state.deadRunStreak,
    state.searchEscalations,
  ]) {
    if (!bag) continue;
    for (const key of Object.keys(bag)) {
      if (key.startsWith(`${FUTURE_YEAR}-`)) delete (bag as any)[key];
    }
  }
  await stateStore.save(state);
}

/** A parked, search-escalated, never-re-armed (eligible) window. */
function mkParkedEntry(): any {
  return {
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs_post_search_escalation",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
    searchEscalated: true,
    searchEscalatedAt: "2030-03-20T00:00:00Z",
  };
}

/** Seed N consecutive parked windows + their in-flight escalation markers. */
async function seedParkedWindows(months: string[]): Promise<void> {
  const state = await stateStore.load();
  state.parkedWindows = state.parkedWindows ?? {};
  state.searchEscalations = state.searchEscalations ?? {};
  for (const month of months) {
    state.parkedWindows[month] = mkParkedEntry();
    state.searchEscalations[month] = {
      escalatedAt: "2030-03-20T00:00:00Z",
      triggeredByCheckpointAt: "2030-03-19T00:00:00Z",
      deadRunsAtEscalation: 3,
    };
  }
  await stateStore.save(state);
}

/** Parked 2994-* months currently present in shared state, sorted. */
async function parkedFutureMonths(): Promise<string[]> {
  const state = await stateStore.load();
  return Object.keys(state.parkedWindows ?? {})
    .filter((m) => m.startsWith(`${FUTURE_YEAR}-`))
    .sort();
}

// ── A. Re-drive each window once, unpark on ingested, converge, no-op
//        second press. ─────────────────────────────────────────────────
async function testReDriveUnparkAndSecondPressNoOp(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  // The re-run lands new conversations → `ingested` → the window unparks.
  __setNextCheckpoint({ status: "partial", statusReason: null, ingested: 9 });

  const months = [`${FUTURE_YEAR}-01`, `${FUTURE_YEAR}-02`, `${FUTURE_YEAR}-03`];
  await seedParkedWindows(months);

  // status() before the press: all three are pending re-arm.
  const before = await action!.status();
  assert.equal(before.state, "pending", "parked windows make the action pending");
  for (const m of months) {
    assert.match(
      before.detail ?? "",
      new RegExp(m),
      `status lists the parked window ${m}`,
    );
  }

  // ── First press: through the REAL registry handler. ──────────────────
  const out1 = await action!.apply("ceo-actor-1");
  assert.equal(out1.state, "applied", "a press with parked windows applies");

  // The all-windows drain records exactly one finalize audit row.
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ACTION_ID) === false, 5000, "drain finished");

  // Each parked window was re-driven EXACTLY ONCE (one Front walk each),
  // and the drain terminated after a final empty pass.
  assert.equal(
    __getCallCount(),
    months.length,
    "each parked window is re-driven exactly once",
  );
  const drain = getDrainState(ACTION_ID);
  assert.ok(drain, "drain registered under the all-windows actionId");
  assert.equal(drain!.processed, months.length, "every window processed once");
  assert.equal(drain!.chunks, months.length, "one productive chunk per window");
  assert.equal(
    drain!.perKey.ingested,
    months.length,
    "every window classified as ingested",
  );

  // The parked markers (and the in-flight escalation markers) are cleared.
  assert.deepEqual(
    await parkedFutureMonths(),
    [],
    "every re-armed window's parked marker is cleared on ingested",
  );
  {
    const state = await stateStore.load();
    for (const m of months) {
      assert.equal(
        state.searchEscalations?.[m],
        undefined,
        `un-park also clears the in-flight escalation marker for ${m}`,
      );
    }
  }

  // The audit row reflects the applied drain.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, months.length);
  assert.equal(row.actorUserId, "ceo-actor-1");

  // status() converges to not-needed (nothing left parked).
  const after = await action!.status();
  assert.equal(after.state, "not-needed", "status flips to not-needed once drained");

  // ── Second press: a no-op — no parked windows, no double-enqueue. ────
  const out2 = await action!.apply("ceo-actor-1");
  assert.equal(out2.state, "not-needed", "a second press finds nothing to do");
  assert.equal(
    __getCallCount(),
    months.length,
    "the second press does NOT re-drive anything (no double-enqueue)",
  );
  assert.equal(
    __getRecordedRuns().length,
    1,
    "a nothing-to-do second press records no new audit row",
  );
}

// ── B. Stays-parked still_empty: re-driven once each, terminates after a
//        single pass, second press permanently ineligible (no double-
//        enqueue). ─────────────────────────────────────────────────────
async function testStillEmptyStaysParkedAndConverges(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  // The re-run still saturates the page cap with 0 ingested →
  // `still_empty` → the window stays parked with a TERMINAL outcome.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const months = [`${FUTURE_YEAR}-06`, `${FUTURE_YEAR}-07`];
  await seedParkedWindows(months);

  // ── First press. ─────────────────────────────────────────────────────
  const out1 = await action!.apply("ceo-actor-2");
  assert.equal(out1.state, "applied", "a press with parked windows applies");
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ACTION_ID) === false, 5000, "drain finished");

  // Each window re-driven EXACTLY ONCE — the still_empty stamp makes it
  // ineligible for the rest of the epoch, so the drain does not loop on a
  // window that stays parked.
  assert.equal(
    __getCallCount(),
    months.length,
    "each window re-driven exactly once even though it stays parked",
  );
  const drain = getDrainState(ACTION_ID);
  assert.equal(drain!.processed, months.length, "every window processed once");
  assert.equal(
    drain!.perKey.still_empty,
    months.length,
    "every window classified still_empty",
  );

  // Windows stay parked, each stamped with the terminal still_empty outcome.
  assert.deepEqual(
    await parkedFutureMonths(),
    months,
    "still_empty windows stay parked",
  );
  {
    const state = await stateStore.load();
    for (const m of months) {
      assert.equal(
        (state.parkedWindows?.[m] as any)?.reArmOutcome?.kind,
        "still_empty",
        `terminal still_empty outcome stamped on ${m}`,
      );
    }
  }

  // ── Second press: still_empty is PERMANENTLY ineligible → not-needed,
  //    and no window is re-driven (no double-enqueue). ──────────────────
  const callsBeforeSecond = __getCallCount();
  const out2 = await action!.apply("ceo-actor-2");
  assert.equal(
    out2.state,
    "not-needed",
    "still_empty windows make a second press not-needed",
  );
  assert.equal(
    __getCallCount(),
    callsBeforeSecond,
    "a second press never re-runs a still_empty window (no double-enqueue)",
  );

  // The action's status() also reports not-needed (terminally ineligible).
  const status = await action!.status();
  assert.equal(
    status.state,
    "not-needed",
    "status reports not-needed once every parked window is terminally still_empty",
  );
}

// ── C. Transient error stays parked THIS epoch but is recoverable on a
//        later press. Unlike `still_empty` (permanently ineligible), an
//        `error` outcome (blocked / failed re-run) is excluded only
//        within its stamping epoch (`at >= sinceIso`) and becomes
//        eligible again under a newer `sinceIso`. A regression here would
//        either re-offer error windows forever (drain never converges) or
//        never retry a transient failure (window stuck parked). ─────────
async function testErrorStaysParkedThisEpochRecoverableLater(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  // The still_empty case (B) intentionally leaves windows parked; clear all
  // 2994-* state so this case's parked-set assertions are order-independent.
  await cleanupFutureState();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  // The re-run is blocked (auth) — NOT a page-cap dead run — so it
  // classifies as `error`, not `still_empty`.
  __setNextCheckpoint({ status: "blocked", statusReason: "auth", ingested: 0 });

  const month = `${FUTURE_YEAR}-11`;
  await seedParkedWindows([month]);

  // ── First press: through the REAL registry handler. ──────────────────
  const out1 = await action!.apply("ceo-actor-3");
  assert.equal(out1.state, "applied", "a press with a parked window applies");
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ACTION_ID) === false, 5000, "drain finished");

  // Re-driven EXACTLY ONCE: the `error` stamp (at >= this epoch's
  // sinceIso) makes it ineligible for the rest of the epoch, so the drain
  // does not loop on the parked window — it converges after one pass.
  assert.equal(
    __getCallCount(),
    1,
    "the error window is re-driven exactly once within one press",
  );
  const drain = getDrainState(ACTION_ID);
  assert.ok(drain, "drain registered under the all-windows actionId");
  assert.equal(drain!.processed, 1, "exactly one window processed");
  assert.equal(drain!.chunks, 1, "one productive chunk then converges");
  assert.equal(drain!.perKey.error, 1, "the window is classified as error");

  // The window STAYS parked, stamped with an `error` outcome attributed to
  // the operator re-arm (NOT the permanently-ineligible `still_empty`).
  assert.deepEqual(
    await parkedFutureMonths(),
    [month],
    "an error window stays parked",
  );
  const state1 = await stateStore.load();
  const entry1 = state1.parkedWindows?.[month] as any;
  assert.equal(
    entry1?.reArmOutcome?.kind,
    "error",
    "error outcome stamped on the parked window",
  );
  assert.equal(
    entry1?.reArmOutcome?.source,
    "operator_rearm",
    "the stamp is attributed to the operator re-arm",
  );
  const stampedAt: string = entry1.reArmOutcome.at;

  // ── Same epoch: a no-op. Re-checking eligibility with the epoch that
  //    stamped the outcome (sinceIso === the stamp's `at`) returns false —
  //    this is exactly what made the drain above converge after one pass
  //    instead of re-offering the error window forever. ──────────────────
  assert.equal(
    isReArmEligible(entry1, stampedAt),
    false,
    "within the same epoch the error window is ineligible (no-op)",
  );
  assert.deepEqual(
    await listReArmableParkedWindows(stampedAt),
    [],
    "the same-epoch re-armable list is empty",
  );

  // ── Fresh epoch: eligible again. A later press carries a newer sinceIso
  //    (> the stamp's `at`), so the transient error window becomes
  //    recoverable — the key contrast with `still_empty`. ───────────────
  const laterIso = new Date(Date.parse(stampedAt) + 1000).toISOString();
  assert.equal(
    isReArmEligible(entry1, laterIso),
    true,
    "in a later epoch the error window is eligible again",
  );
  assert.deepEqual(
    await listReArmableParkedWindows(laterIso),
    [month],
    "the later-epoch re-armable list re-offers the window",
  );

  // status() (which uses a fresh `now` epoch) stays `pending`, so the
  // operator can retry — unlike the still_empty case, which converges to
  // not-needed.
  const status = await action!.status();
  assert.equal(
    status.state,
    "pending",
    "after an error the action stays pending so a later press can retry",
  );
  assert.match(
    status.detail ?? "",
    new RegExp(month),
    "status still lists the parked error window",
  );

  // ── Second press (fresh epoch) re-drives the transient-error window. ──
  const out2 = await action!.apply("ceo-actor-3");
  assert.equal(out2.state, "applied", "a later press re-drives the error window");
  await waitFor(
    () => __getRecordedRuns().length === 2,
    5000,
    "second drain finalize",
  );
  assert.equal(
    __getCallCount(),
    2,
    "a fresh-epoch press re-drives the transient-error window again",
  );
  assert.deepEqual(
    await parkedFutureMonths(),
    [month],
    "the window remains parked after the second error re-run",
  );
  const state2 = await stateStore.load();
  assert.equal(
    (state2.parkedWindows?.[month] as any)?.reArmOutcome?.kind,
    "error",
    "the second re-run re-stamps an error outcome (still recoverable later)",
  );
}

async function main(): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  // Route the module's own load/save accessors (used by the registry
  // handler) through the injected in-memory store for the duration of the
  // run (Task #2239).
  __setFrontAutoClosureStateStoreForTest(stateStore);
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      [
        "re-drive each parked window once, unpark, converge, no-op second press",
        testReDriveUnparkAndSecondPressNoOp,
      ],
      [
        "still_empty windows stay parked, drain converges, second press ineligible",
        testStillEmptyStaysParkedAndConverges,
      ],
      [
        "error windows stay parked this epoch but a later press re-drives them",
        testErrorStaysParkedThisEpochRecoverableLater,
      ],
    ];
    for (const [name, fn] of cases) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
      } catch (err: any) {
        console.error(`  ✗ ${name}: ${err?.stack ?? err?.message ?? err}`);
        process.exitCode = 1;
      }
    }
    if (process.exitCode && process.exitCode !== 0) {
      throw new Error("front-rearm-all-windows-prod-action-e2e test cases failed");
    }
    console.log("front-rearm-all-windows-prod-action-e2e: OK");
  } finally {
    await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
    // Detach the test store so the module reverts to its real DB-backed
    // accessors (Task #2239). Nothing was written to the shared dev DB.
    __setFrontAutoClosureStateStoreForTest(null);
  }
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error(
    "front-rearm-all-windows-prod-action-e2e: FAILED —",
    err?.stack ?? err,
  );
  process.exitCode = 1;
});
