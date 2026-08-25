/* test-registration
{
  "name": "Front single-window re-arm background drain (Task #2119)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/oneWindowReArmDrainSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2119 — Single-window re-arm background-drain wiring
 * (`startOneParkedWindowReArmDrain`).
 *
 * Task #2098 added the per-window analogue of the all-windows re-arm
 * drain: an operator can re-drive ONE suspect parked month under the
 * search strategy via `POST /api/admin/front/auto-closure/rearm-one`.
 * `tests/front-rearm-converge.test.ts` covers the pure eligibility
 * convergence math (`isReArmEligible`); the drain wiring itself had no
 * direct test. This file pins:
 *
 *   1. Switch-off short-circuit — with the search-strategy switch OFF the
 *      call returns `switch_off` and never touches state / the drain.
 *   2. `nothing-to-do` — an eligible-but-not-parked month counts 0 pending
 *      so the shared drain reports nothing to do.
 *   3. Eligible parked month — the drain starts, runs the per-window Front
 *      walk exactly once, stamps a terminal `reArmOutcome` (so the next
 *      pass is ineligible), and terminates after a single pass.
 *   4. Per-month `actionId` isolation — the drain registers under
 *      `rearm_parked_front_recovery_window_<month>`, NOT the all-windows
 *      `rearm_parked_front_recovery_windows` id.
 *
 * The Front walk (`runTargetedWindowBackfill`) and the drain's
 * finalize-audit (`recordProdActionRun`) are redirected to in-memory
 * stubs via a Node ESM resolve hook (registered through
 * `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs` in run-all.ts),
 * so this suite makes no real Front API calls and never writes the
 * `prod_action_runs` table.
 *
 * State note: like the sibling re-arm suite, this reads/writes the shared
 * persisted auto-closure state in `system_settings`, which the live dev
 * server's `runFrontAutoClosureTick` also mutates. All persisted rows use
 * a unique far-future month prefix (2998-*) that never appears in the
 * coverage table, so the dev server's read-modify-write preserves them
 * and this suite cleans them up before and after.
 *
 * Usage: tsx --import ./tests/helpers/oneWindowReArmDrainSetup.mjs \
 *            tests/front-one-window-rearm-drain.test.ts
 */
import assert from "node:assert/strict";
import {
  startOneParkedWindowReArmDrain,
  listReArmableParkedWindows,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
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
  __installGate,
  __resetStub,
} from "./helpers/frontHistoricalRecoveryReArmStub.mjs";

const { isReArmEligible } = __frontAutoClosureTestHelpers;

const FUTURE_YEAR = 2998;
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";

// Task #2239 — drive an injected in-memory store instead of read-modify-
// writing the global `front_auto_closure_state` setting on the shared dev
// DB. `startOneParkedWindowReArmDrain` / `listReArmableParkedWindows` take
// the store explicitly; each case re-creates it to reset.
let stateStore = createInMemoryStateStore();

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

async function waitForDrainFinished(
  actionId: string,
  timeoutMs = 5000,
): Promise<void> {
  await waitFor(
    () => !isDrainRunning(actionId),
    timeoutMs,
    "drain finished",
  );
}
function mkParkedEntry(): any {
  return {
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
  };
}

async function seedParkedWindow(month: string): Promise<void> {
  const state = await stateStore.load();
  state.parkedWindows = state.parkedWindows ?? {};
  state.parkedWindows[month] = mkParkedEntry();
  await stateStore.save(state);
}

// ── 1. Switch OFF → `switch_off`, no state / drain interaction. ─────────
async function testSwitchOffShortCircuits(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, false, "system");

  const month = `${FUTURE_YEAR}-01`;
  // Even a genuinely-parked, eligible window must be skipped when the
  // switch is off — re-running would only rebuild the legacy enumeration.
  await seedParkedWindow(month);

  const res = await startOneParkedWindowReArmDrain(month, "actor-1", stateStore);
  assert.equal(res.state, "switch_off", "switch off returns switch_off");
  assert.equal(res.totalParked, 0);
  assert.match(res.detail, /switch .* is OFF|OFF/);
  // No Front walk, no drain registered, no audit row.
  assert.equal(__getCallCount(), 0, "no Front walk when switch is off");
  assert.equal(
    getDrainState(`rearm_parked_front_recovery_window_${month}`),
    undefined,
    "no drain registered when switch is off",
  );
  assert.equal(__getRecordedRuns().length, 0, "no audit row when switch is off");
}

// ── 2. Switch ON + month NOT parked → `nothing-to-do`. ──────────────────
async function testNotParkedNothingToDo(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  const month = `${FUTURE_YEAR}-02`; // never seeded → not parked
  const res = await startOneParkedWindowReArmDrain(month, "actor-1", stateStore);
  assert.equal(res.state, "nothing-to-do", "non-parked month is nothing-to-do");
  assert.equal(res.totalParked, 0, "countPending=0 for a non-parked month");
  // No drain loop runs, so the Front walk is never reached and no audit
  // row is recorded for the nothing-to-do branch.
  assert.equal(__getCallCount(), 0, "no Front walk for nothing-to-do");
  assert.equal(__getRecordedRuns().length, 0, "no audit row for nothing-to-do");
  assert.equal(
    getDrainState(`rearm_parked_front_recovery_window_${month}`),
    undefined,
    "no drain registered for a non-parked month",
  );
}

// ── 3. Switch ON + eligible parked month → drain runs once, converges. ──
async function testEligibleParkedDrainsOnce(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // The stub default already classifies as `still_empty` (page-cap dead
  // run, 0 ingested) — the window stays parked and gets a terminal
  // outcome so the very next pass is ineligible.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-03`;
  await seedParkedWindow(month);

  const actionId = `rearm_parked_front_recovery_window_${month}`;
  const res = await startOneParkedWindowReArmDrain(month, "actor-7", stateStore);
  assert.equal(res.state, "started", "an eligible parked month starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  // Wait for the background drain to finalize (single audit row).
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(actionId);

  // Terminates after exactly one pass: the Front walk ran once, the
  // second chunk re-read state, found the (now still_empty) window
  // ineligible, and returned processed:0.
  assert.equal(__getCallCount(), 1, "Front walk ran exactly once (one pass)");
  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");

  // The audit row reflects the single applied window.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-7");

  // The window stays parked with a terminal still_empty outcome stamped.
  const after = await stateStore.load();
  const entry = after.parkedWindows?.[month];
  assert.ok(entry, "window stays parked after a still_empty re-arm");
  assert.equal(
    (entry as any).reArmOutcome?.kind,
    "still_empty",
    "terminal reArmOutcome stamped so a re-press converges",
  );
}

// ── 4. Per-month actionId isolation. ────────────────────────────────────
async function testPerMonthActionIdIsolation(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-04`;
  await seedParkedWindow(month);
  await startOneParkedWindowReArmDrain(month, "actor-1", stateStore);
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");

  // The per-month drain is keyed by month and is NOT the all-windows id,
  // so per-window presses never collide with the all-windows drain.
  assert.ok(
    getDrainState(`rearm_parked_front_recovery_window_${month}`),
    "registered under the per-month actionId",
  );
  assert.equal(
    getDrainState("rearm_parked_front_recovery_windows"),
    undefined,
    "the all-windows drain id is untouched by a single-window press",
  );
}

// ── 5. Forward progress (`ingested > 0`) → window UNPARKED, converges. ──
// Task #2174 — the branch that actually frees a month for the per-window
// drain. Case 3 only pins `still_empty` (stays parked); this drives the
// stub to report new conversations so `reArmOneParkedWindow` classifies
// `ingested` and calls `unparkRecoveryWindow`.
async function testForwardProgressIngestedUnparks(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // ingested > 0 wins over status in classifyReArmCheckpoint.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=7",
    ingested: 7,
  });

  const month = `${FUTURE_YEAR}-05`;
  await seedParkedWindow(month);

  const actionId = `rearm_parked_front_recovery_window_${month}`;
  const res = await startOneParkedWindowReArmDrain(month, "actor-8", stateStore);
  assert.equal(res.state, "started", "an eligible parked month starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(actionId);

  // One pass: the second chunk re-read state, found the month no longer
  // parked (unparked), and returned processed:0.
  assert.equal(__getCallCount(), 1, "Front walk ran exactly once (one pass)");
  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.ingested,
    1,
    "the processed window classified as ingested (forward progress)",
  );

  // The audit row reflects the single unparked window.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-8");

  // The window is RELEASED — removed from parkedWindows entirely.
  const after = await stateStore.load();
  assert.equal(
    after.parkedWindows?.[month],
    undefined,
    "the window is unparked (removed) once new data arrives",
  );
}

// ── 6. Proven covered (`status: complete`) → window UNPARKED, converges. ─
async function testForwardProgressResolvedCoveredUnparks(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // ingested = 0 but the window walked to completion — resolved_covered.
  __setNextCheckpoint({
    status: "complete",
    statusReason: null,
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-06`;
  await seedParkedWindow(month);

  const actionId = `rearm_parked_front_recovery_window_${month}`;
  const res = await startOneParkedWindowReArmDrain(month, "actor-9", stateStore);
  assert.equal(res.state, "started", "an eligible parked month starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(actionId);

  assert.equal(__getCallCount(), 1, "Front walk ran exactly once (one pass)");
  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.resolved_covered,
    1,
    "the processed window classified as resolved_covered",
  );

  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-9");

  const after = await stateStore.load();
  assert.equal(
    after.parkedWindows?.[month],
    undefined,
    "the window is unparked (removed) once proven covered",
  );
}

// ── 7. Error (blocked/failed re-run) → window STAYS parked THIS epoch but
//        is recoverable on a later per-window press. ───────────────────
// Task #2229 — the per-window analogue of
// tests/front-rearm-all-windows-prod-action-e2e.test.ts case C. The same
// epoch-vs-terminal eligibility rule (`isReArmEligible`) that governs the
// all-windows drain also governs `startOneParkedWindowReArmDrain`, but the
// single-window path had no `error`-outcome e2e. The search re-run could
// not complete (a `failed` / `blocked` checkpoint: not complete/empty_source
// and not the page-cap partial, with 0 ingested), so classifyReArmCheckpoint
// returns `{ kind: "error" }` and reArmOneParkedWindow keeps the window
// parked, stamping the error `reArmOutcome` at `at >= sinceIso`. Unlike
// `still_empty` (permanently ineligible), an `error` outcome is excluded
// only within its stamping epoch and becomes eligible again under a newer
// `sinceIso`. A regression here would either re-offer the error window
// forever (the drain never converges) or never retry a transient failure
// (the window stays stuck parked with no second chance to recover).
async function testErrorStaysParkedThisEpochRecoverableLater(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // A blocked re-run (auth): not complete/empty_source and not the
  // page-cap partial, with 0 ingested → classifyReArmCheckpoint → error.
  __setNextCheckpoint({
    status: "blocked",
    statusReason: "auth",
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-07`;
  await seedParkedWindow(month);

  const actionId = `rearm_parked_front_recovery_window_${month}`;
  // ── First press: through the per-window drain. ───────────────────────
  const res = await startOneParkedWindowReArmDrain(month, "actor-10", stateStore);
  assert.equal(res.state, "started", "an eligible parked month starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(actionId);

  // Re-driven EXACTLY ONCE: the second chunk re-read state, found the
  // now-error window ineligible (its outcome `at >= sinceIso`), and
  // returned processed:0 — so the drain converges after one pass instead
  // of re-offering the error window forever.
  assert.equal(__getCallCount(), 1, "Front walk ran exactly once (one pass)");
  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.error,
    1,
    "the processed window classified as error",
  );

  // The audit row reflects the single applied window.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-10");

  // The window STAYS parked (not silently dropped) with an `error` outcome
  // attributed to the operator re-arm (NOT the permanently-ineligible
  // `still_empty`).
  const after1 = await stateStore.load();
  const entry1 = after1.parkedWindows?.[month] as any;
  assert.ok(entry1, "still-broken window stays parked (not dropped)");
  assert.equal(
    entry1.reArmOutcome?.kind,
    "error",
    "window stamped terminal error outcome",
  );
  assert.equal(
    entry1.reArmOutcome?.source,
    "operator_rearm",
    "the stamp is attributed to the operator re-arm",
  );
  assert.equal(
    entry1.searchEscalated,
    true,
    "searchEscalated stamped on the error outcome",
  );
  // Task #2230 — a window that errors from a clean slate has a
  // consecutive-error count of exactly 1, so an operator can tell a
  // first-time failure apart from a repeatedly auth-blocked one.
  assert.equal(
    entry1.reArmConsecutiveErrors,
    1,
    "first error re-arm sets reArmConsecutiveErrors to 1",
  );
  const stampedAt: string = entry1.reArmOutcome.at;

  // ── Same epoch: a no-op. Re-checking eligibility with the epoch that
  //    stamped the outcome (sinceIso === the stamp's `at`) returns false —
  //    exactly what made the drain above converge after one pass instead
  //    of re-offering the error window forever. ──────────────────────────
  assert.equal(
    isReArmEligible(entry1, stampedAt),
    false,
    "within the same epoch the error window is ineligible (no-op)",
  );
  // Read-only: the same-epoch re-armable list excludes this error window.
  // (Filter to this suite's 2998-* months so concurrent dev-server /
  // sibling-suite state never makes the assertion flaky.)
  assert.ok(
    !(await listReArmableParkedWindows(stampedAt, stateStore))
      .filter((m) => m.startsWith(`${FUTURE_YEAR}-`))
      .includes(month),
    "the same-epoch re-armable list excludes the error window",
  );

  // ── Fresh epoch: eligible again. A later press carries a newer sinceIso
  //    (> the stamp's `at`), so the transient error window becomes
  //    recoverable — the key contrast with `still_empty`. ────────────────
  const laterIso = new Date(Date.parse(stampedAt) + 1000).toISOString();
  assert.equal(
    isReArmEligible(entry1, laterIso),
    true,
    "in a later epoch the error window is eligible again",
  );
  assert.ok(
    (await listReArmableParkedWindows(laterIso, stateStore)).includes(month),
    "the later-epoch re-armable list re-offers the window",
  );

  // ── Second per-window press (fresh epoch) re-drives the error window. ──
  // The stub still returns the blocked checkpoint, so it re-stamps error
  // (still recoverable later). This is the "second chance to recover" the
  // task pins: without it a transient failure would stay stuck forever.
  const res2 = await startOneParkedWindowReArmDrain(month, "actor-10", stateStore);
  assert.equal(res2.state, "started", "a later press re-drives the error window");
  assert.equal(res2.totalParked, 1, "the error window is pending again");

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

  const after2 = await stateStore.load();
  const entry2 = after2.parkedWindows?.[month] as any;
  assert.ok(entry2, "the window remains parked after the second error re-run");
  assert.equal(
    entry2.reArmOutcome?.kind,
    "error",
    "the second re-run re-stamps an error outcome (still recoverable later)",
  );
}

// ── 8. Two concurrent presses of the SAME window join one single-flight.
// Task #2235 — the per-window analogue of the all-windows concurrent
// double-press coverage. `startOneParkedWindowReArmDrain` reserves its
// single-flight slot synchronously inside `startBackgroundDrain` (keyed by
// the per-month `rearm_parked_front_recovery_window_<month>` actionId), so
// a second press landing while the first drain is still running must JOIN
// it (`already-running`) instead of starting a duplicate drain. A
// regression here would let the second press start a second drain and
// double-enqueue the Front recovery walk for that month — the exact
// double-processing the synchronous reservation exists to prevent. This
// holds the first drain's Front walk open via the gate, presses the same
// window again, and asserts the second press reports already-running with
// no extra Front walk and no second drain, then that the single drain
// converges after release (re-driven exactly once, one finalize audit row).
async function testConcurrentSecondPressJoinsSingleFlight(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // Default still_empty classification: the window stays parked with a
  // terminal stamp so the drain converges after a single pass.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-08`;
  await seedParkedWindow(month);
  const actionId = `rearm_parked_front_recovery_window_${month}`;

  // Gate the first Front walk so the first drain is observably running
  // mid-flight when the second press arrives.
  const releaseGate = __installGate();

  // ── First press: starts the per-window drain. ────────────────────────
  const first = await startOneParkedWindowReArmDrain(month, "actor-11", stateStore);
  assert.equal(first.state, "started", "the first press starts a drain");
  assert.equal(first.totalParked, 1, "exactly one window pending");

  // Wait until the gated Front walk is in flight: the call is recorded and
  // the drain is running but cannot finish (blocked on the gate).
  await waitFor(
    () => __getCallCount() === 1,
    5000,
    "first Front walk in flight",
  );
  assert.equal(
    isDrainRunning(actionId),
    true,
    "the first drain is running while the Front walk is gated",
  );

  // ── Second press of the SAME window while the first is still running. ─
  // It joins the single-flight: `already-running`, no second drain, no
  // second Front walk.
  const second = await startOneParkedWindowReArmDrain(month, "actor-11", stateStore);
  assert.equal(
    second.state,
    "already-running",
    "the second concurrent press joins the in-flight single-flight drain",
  );
  assert.match(
    second.detail,
    /already running/i,
    "the second press reports the in-progress drain",
  );
  assert.equal(
    __getCallCount(),
    1,
    "the second press starts NO second Front walk (no double-enqueue)",
  );
  assert.equal(
    __getRecordedRuns().length,
    0,
    "no finalize audit row is written while the first drain is still gated",
  );

  // ── Release the gate: the single drain converges. ────────────────────
  releaseGate();
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(actionId);

  // The window was re-driven EXACTLY ONCE across both presses, and the
  // drain terminated after a single pass.
  assert.equal(
    __getCallCount(),
    1,
    "the window is re-driven exactly once across both presses",
  );
  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");

  // Exactly one finalize audit row — the joining press did not write a
  // second one.
  assert.equal(
    __getRecordedRuns().length,
    1,
    "exactly one finalize audit row across both presses",
  );
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-11");
}

// ── 9. Task #2230 — consecutive-error count climbs on repeated errors
//        and resets the moment a re-arm produces a non-error outcome. The
//        recovery panel surfaces this so an auth-blocked window (count
//        climbing) is distinguishable from a still-empty one at a glance.
async function testConsecutiveErrorCountIncrementsThenResets(): Promise<void> {
  // 9a. A window already carrying a 2-error streak (from prior epochs)
  //     that errors again advances the count to 3.
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  __setNextCheckpoint({
    status: "blocked",
    statusReason: "auth",
    ingested: 0,
  });

  const incMonth = `${FUTURE_YEAR}-10`;
  // Seed a parked window with a prior-epoch error outcome (so it is
  // eligible again this epoch) and an existing 2-error streak.
  {
    const state = await stateStore.load();
    state.parkedWindows = state.parkedWindows ?? {};
    state.parkedWindows[incMonth] = {
      ...mkParkedEntry(),
      reArmConsecutiveErrors: 2,
      reArmOutcome: {
        kind: "error",
        ingested: 0,
        at: "2020-01-01T00:00:00Z",
        source: "operator_rearm",
        detail: "blocked:auth",
      },
    } as any;
    await stateStore.save(state);
  }

  const incActionId = `rearm_parked_front_recovery_window_${incMonth}`;
  const incRes = await startOneParkedWindowReArmDrain(incMonth, "actor-11", stateStore);
  assert.equal(incRes.state, "started", "eligible prior-epoch error re-arms");
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(incActionId);

  const afterInc = await stateStore.load();
  const incEntry = afterInc.parkedWindows?.[incMonth];
  assert.ok(incEntry, "window stays parked after another error");
  assert.equal(
    (incEntry as any).reArmOutcome?.kind,
    "error",
    "still an error outcome",
  );
  assert.equal(
    (incEntry as any).reArmOutcome?.detail,
    "blocked:auth",
    "error detail (status:statusReason) is stamped for the panel",
  );
  assert.equal(
    (incEntry as any).reArmConsecutiveErrors,
    3,
    "a repeated error advances the consecutive-error count (2 → 3)",
  );

  // 9b. The same kind of window, when its re-arm comes back non-error
  //     (here still_empty), resets the streak to 0.
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const resetMonth = `${FUTURE_YEAR}-11`;
  {
    const state = await stateStore.load();
    state.parkedWindows = state.parkedWindows ?? {};
    state.parkedWindows[resetMonth] = {
      ...mkParkedEntry(),
      reArmConsecutiveErrors: 2,
      reArmOutcome: {
        kind: "error",
        ingested: 0,
        at: "2020-01-01T00:00:00Z",
        source: "operator_rearm",
        detail: "blocked:auth",
      },
    } as any;
    await stateStore.save(state);
  }

  const resetActionId = `rearm_parked_front_recovery_window_${resetMonth}`;
  await startOneParkedWindowReArmDrain(resetMonth, "actor-12", stateStore);
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  await waitForDrainFinished(resetActionId);

  const afterReset = await stateStore.load();
  const resetEntry = afterReset.parkedWindows?.[resetMonth];
  assert.ok(resetEntry, "window stays parked after still_empty");
  assert.equal(
    (resetEntry as any).reArmOutcome?.kind,
    "still_empty",
    "outcome is still_empty",
  );
  assert.equal(
    (resetEntry as any).reArmConsecutiveErrors,
    0,
    "a non-error outcome resets the consecutive-error count to 0",
  );
}

async function main(): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ["switch off short-circuits to switch_off", testSwitchOffShortCircuits],
      ["non-parked month is nothing-to-do", testNotParkedNothingToDo],
      ["eligible parked month drains once and converges", testEligibleParkedDrainsOnce],
      ["per-month actionId isolation", testPerMonthActionIdIsolation],
      [
        "forward progress (ingested) unparks the window and converges",
        testForwardProgressIngestedUnparks,
      ],
      [
        "proven covered (resolved_covered) unparks the window and converges",
        testForwardProgressResolvedCoveredUnparks,
      ],
      [
        "error window stays parked this epoch but a later press re-drives it",
        testErrorStaysParkedThisEpochRecoverableLater,
      ],
      [
        "two concurrent presses of one window join a single single-flight drain",
        testConcurrentSecondPressJoinsSingleFlight,
      ],
      [
        "consecutive-error count increments on repeated errors and resets on a non-error outcome",
        testConsecutiveErrorCountIncrementsThenResets,
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
      throw new Error("front-one-window-rearm-drain test cases failed");
    }
    console.log("front-one-window-rearm-drain: OK");
  } finally {
    await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
    // No parked-state restore needed: each case drives a fresh in-memory
    // store (Task #2239), so nothing was written to the shared dev DB.
  }
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("front-one-window-rearm-drain: FAILED —", err?.stack ?? err);
  process.exitCode = 1;
});
