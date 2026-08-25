/* test-registration
{
  "name": "Front all-windows re-arm background drain (Task #2151)",
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
 * Task #2151 — All-windows re-arm background-drain wiring
 * (`startParkedWindowReArmDrain`).
 *
 * Task #2085 shipped the one-press "re-arm every parked Front recovery
 * window" drain shared by the CEO prod-action and the Team-Lead recovery
 * panel. Task #2119 pinned the SINGLE-window sibling
 * (`startOneParkedWindowReArmDrain`) and `tests/front-rearm-converge.ts`
 * covers the pure eligibility math (`isReArmEligible`); the ALL-windows
 * drain wiring itself had no direct test. That path is where multi-window
 * behavior actually matters — `countPending` counts over
 * `listReArmableParkedWindows(sinceIso)` and `runChunk` re-reads that
 * list each pass, processing one window per chunk until the eligible set
 * drains. This file pins:
 *
 *   1. Switch-off short-circuit — with the search-strategy switch OFF the
 *      call returns `switch_off` and never touches state / the drain,
 *      even when genuinely-parked, eligible windows exist.
 *   2. `nothing-to-do` — with zero eligible parked windows the shared
 *      drain reports nothing to do and registers no drain / audit row.
 *   3. N (>=2) eligible parked windows under a single `sinceIso` epoch —
 *      the drain processes exactly N windows across N chunks, stamps a
 *      terminal `still_empty` outcome on each (so the next pass is
 *      ineligible and the drain terminates without a perpetual re-pick),
 *      and an already-`still_empty` window is skipped (neither counted
 *      nor re-armed).
 *
 * The Front walk (`runTargetedWindowBackfill`) and the drain's
 * finalize-audit (`recordProdActionRun`) are redirected to in-memory
 * stubs via a Node ESM resolve hook (registered through
 * `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs` in run-all.ts —
 * shared with the Task #2119 sibling), so this suite makes no real Front
 * API calls and never writes the `prod_action_runs` table.
 *
 * State note: like the sibling re-arm suites, this reads/writes the
 * shared persisted auto-closure state in `system_settings`, which the
 * live dev server's `runFrontAutoClosureTick` also mutates. The
 * all-windows drain enumerates the WHOLE parked set (not just one month),
 * so to keep the counts deterministic this suite snapshots the existing
 * `parkedWindows` map, replaces it with only its own far-future
 * (2997-*) test windows for the duration of a case, and restores the
 * snapshot afterwards. Real parked windows are empty in the dev workspace
 * today; the snapshot/restore keeps the suite correct even if that
 * changes.
 *
 * Usage: tsx --import ./tests/helpers/oneWindowReArmDrainSetup.mjs \
 *            tests/front-all-windows-rearm-drain.test.ts
 */
import assert from "node:assert/strict";
import {
  startParkedWindowReArmDrain,
  createInMemoryStateStore,
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

let stateStore = createInMemoryStateStore();

const FUTURE_YEAR = 2997;
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const ALL_ACTION_ID = "rearm_parked_front_recovery_windows";
// Sentinel timestamp on the already-terminal window; if the drain ever
// (incorrectly) re-armed it, `reArmOneParkedWindow` would overwrite this
// with a fresh ISO string.
const SKIPPED_AT = "2000-01-01T00:00:00.000Z";

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

function mkParkedEntry(): any {
  return {
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
  };
}

/** A window already proven `still_empty` — permanently ineligible. */
function mkStillEmptyEntry(): any {
  return {
    ...mkParkedEntry(),
    searchEscalated: true,
    searchEscalatedAt: SKIPPED_AT,
    reArmOutcome: {
      kind: "still_empty",
      ingested: 0,
      at: SKIPPED_AT,
      source: "operator_rearm",
    },
  };
}

/**
 * Replace the entire `parkedWindows` map with exactly `entries`. The
 * all-windows drain enumerates every parked window, so the suite owns the
 * whole map while a case runs and restores the original afterwards.
 */
async function setParked(entries: Record<string, any>): Promise<void> {
  const state = await stateStore.load();
  state.parkedWindows = entries;
  await stateStore.save(state);
}

// ── 1. Switch OFF → `switch_off`, no state / drain interaction. ─────────
async function testSwitchOffShortCircuits(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, false, "system");

  // Genuinely-parked, eligible windows must still be skipped when the
  // switch is off — re-running would only rebuild the legacy enumeration.
  await setParked({
    [`${FUTURE_YEAR}-01`]: mkParkedEntry(),
    [`${FUTURE_YEAR}-02`]: mkParkedEntry(),
  });

  const res = await startParkedWindowReArmDrain("actor-1", stateStore);
  assert.equal(res.state, "switch_off", "switch off returns switch_off");
  assert.equal(res.totalParked, 0);
  assert.match(res.detail, /switch .* is OFF|OFF/);
  // No Front walk, no drain registered, no audit row.
  assert.equal(__getCallCount(), 0, "no Front walk when switch is off");
  assert.equal(
    getDrainState(ALL_ACTION_ID),
    undefined,
    "no drain registered when switch is off",
  );
  assert.equal(__getRecordedRuns().length, 0, "no audit row when switch is off");
}

// ── 2. Switch ON + zero eligible windows → `nothing-to-do`. ─────────────
async function testNoEligibleNothingToDo(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  // An empty parked set, plus an already-terminal `still_empty` window
  // that is permanently ineligible — neither contributes to countPending.
  await setParked({
    [`${FUTURE_YEAR}-03`]: mkStillEmptyEntry(),
  });

  const res = await startParkedWindowReArmDrain("actor-1", stateStore);
  assert.equal(res.state, "nothing-to-do", "no eligible window is nothing-to-do");
  assert.equal(res.totalParked, 0, "countPending=0 when nothing is eligible");
  // No drain loop runs, so the Front walk is never reached and no audit
  // row is recorded for the nothing-to-do branch.
  assert.equal(__getCallCount(), 0, "no Front walk for nothing-to-do");
  assert.equal(__getRecordedRuns().length, 0, "no audit row for nothing-to-do");
  assert.equal(
    getDrainState(ALL_ACTION_ID),
    undefined,
    "no drain registered when nothing is eligible",
  );
}

// ── 3. Switch ON + N eligible parked windows → N chunks, converges. ─────
async function testNEligibleDrainAcrossNChunks(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // The stub default already classifies as `still_empty` (page-cap dead
  // run, 0 ingested) — every re-armed window stays parked and gets a
  // terminal outcome so it drops out of the eligible set next pass.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const months = [
    `${FUTURE_YEAR}-04`,
    `${FUTURE_YEAR}-05`,
    `${FUTURE_YEAR}-06`,
  ];
  const N = months.length;
  const skippedMonth = `${FUTURE_YEAR}-07`; // already still_empty → skipped

  const entries: Record<string, any> = {};
  for (const m of months) entries[m] = mkParkedEntry();
  entries[skippedMonth] = mkStillEmptyEntry();
  await setParked(entries);

  const res = await startParkedWindowReArmDrain("actor-9", stateStore);
  assert.equal(res.state, "started", "eligible windows start a drain");
  assert.equal(
    res.totalParked,
    N,
    "countPending counts only eligible windows (still_empty excluded)",
  );

  // Wait for the background drain to finalize (single audit row).
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");

  // Exactly one Front walk per eligible window, one window per chunk, and
  // the (N+1)th pass re-read the list, found it drained, and stopped — so
  // there is no perpetual re-pick.
  assert.equal(__getCallCount(), N, "Front walk ran exactly N times");
  const state = getDrainState(ALL_ACTION_ID);
  assert.ok(state, "drain state registered under the all-windows actionId");
  assert.equal(state!.chunks, N, "exactly N productive chunks");
  assert.equal(state!.processed, N, "N windows processed");
  assert.equal(
    state!.perKey.still_empty,
    N,
    "every processed window classified still_empty",
  );

  // The audit row reflects all N applied windows.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ALL_ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, N);
  assert.equal(row.actorUserId, "actor-9");

  // Every eligible window stays parked with a terminal still_empty
  // outcome stamped; the already-terminal window is untouched (its
  // sentinel `at` proves the drain never re-armed it).
  const after = await stateStore.load();
  for (const m of months) {
    const entry = after.parkedWindows?.[m];
    assert.ok(entry, `window ${m} stays parked`);
    assert.equal(
      (entry as any).reArmOutcome?.kind,
      "still_empty",
      `window ${m} stamped terminal still_empty`,
    );
  }
  const skipped = after.parkedWindows?.[skippedMonth];
  assert.ok(skipped, "already-terminal window stays parked");
  assert.equal((skipped as any).reArmOutcome?.kind, "still_empty");
  assert.equal(
    (skipped as any).reArmOutcome?.at,
    SKIPPED_AT,
    "the already-still_empty window was never re-armed",
  );
}

// ── 4. Forward progress (`ingested > 0`) → window UNPARKED, converges. ──
// Task #2174 — the branch that actually frees a month. The Task #2151
// suite only pinned the `still_empty` outcome (window stays parked); this
// case drives the stub to report new conversations so `reArmOneParkedWindow`
// classifies `ingested` and calls `unparkRecoveryWindow`. A regression
// here would silently keep good months parked.
async function testForwardProgressIngestedUnparks(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // ingested > 0 wins over status in classifyReArmCheckpoint, so the
  // re-run is treated as forward progress regardless of the page-cap reason.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=12",
    ingested: 12,
  });

  const month = `${FUTURE_YEAR}-08`;
  await setParked({ [month]: mkParkedEntry() });

  const res = await startParkedWindowReArmDrain("actor-11", stateStore);
  assert.equal(res.state, "started", "eligible window starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");

  // One pass: the (N+1)th chunk re-read the now-empty parked set and
  // stopped — the unparked window is gone, so no perpetual re-pick.
  assert.equal(__getCallCount(), 1, "Front walk ran exactly once");
  const state = getDrainState(ALL_ACTION_ID);
  assert.ok(state, "drain state registered under the all-windows actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.ingested,
    1,
    "the processed window classified as ingested (forward progress)",
  );

  // The audit row reflects the single unparked window.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ALL_ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-11");

  // The window is RELEASED — removed from parkedWindows entirely.
  const after = await stateStore.load();
  assert.equal(
    after.parkedWindows?.[month],
    undefined,
    "the window is unparked (removed) once new data arrives",
  );
}

// ── 5. Proven covered (`status: complete`) → window UNPARKED, converges. ─
// The other forward-progress branch: the search re-run walked the whole
// month and ingested nothing, but the window is now genuinely covered
// (`complete` / `empty_source`) → `resolved_covered` → unpark.
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

  const month = `${FUTURE_YEAR}-09`;
  await setParked({ [month]: mkParkedEntry() });

  const res = await startParkedWindowReArmDrain("actor-12", stateStore);
  assert.equal(res.state, "started", "eligible window starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");

  assert.equal(__getCallCount(), 1, "Front walk ran exactly once");
  const state = getDrainState(ALL_ACTION_ID);
  assert.ok(state, "drain state registered under the all-windows actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.resolved_covered,
    1,
    "the processed window classified as resolved_covered",
  );

  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ALL_ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-12");

  const after = await stateStore.load();
  assert.equal(
    after.parkedWindows?.[month],
    undefined,
    "the window is unparked (removed) once proven covered",
  );
}

// ── 6. Error (blocked/failed re-run) → window STAYS parked, converges. ─
// Task #2192 — the remaining classification. The search re-run could not
// complete (a `failed` / `blocked` checkpoint: not complete/empty_source
// and not the page-cap partial, with 0 ingested), so
// classifyReArmCheckpoint returns `{ kind: "error" }` and
// reArmOneParkedWindow keeps the window parked, stamping the error
// `reArmOutcome` (with `searchEscalated`) at `at >= sinceIso` so it is
// not re-picked this epoch. A regression here would either silently drop
// a still-broken month from the parked set or re-pick it forever.
async function testErrorKeepsWindowParked(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // A failed re-run: not complete/empty_source and not the page-cap
  // partial, with 0 ingested → classifyReArmCheckpoint → error.
  __setNextCheckpoint({
    status: "failed",
    statusReason: "front_api_5xx_after_retries",
    ingested: 0,
  });

  const month = `${FUTURE_YEAR}-10`;
  await setParked({ [month]: mkParkedEntry() });

  // Captured before the drain creates its `sinceIso` epoch, so the
  // stamped outcome's `at` is provably >= the epoch start.
  const before = new Date().toISOString();
  const res = await startParkedWindowReArmDrain("actor-13", stateStore);
  assert.equal(res.state, "started", "eligible window starts a drain");
  assert.equal(res.totalParked, 1, "exactly one window pending");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");

  // One pass: the (N+1)th chunk re-read the parked set, found the
  // now-error window ineligible (its outcome `at >= sinceIso`), and
  // stopped — so a still-broken month neither drops out nor re-picks
  // forever.
  assert.equal(__getCallCount(), 1, "Front walk ran exactly once");
  const state = getDrainState(ALL_ACTION_ID);
  assert.ok(state, "drain state registered under the all-windows actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "one window processed");
  assert.equal(
    state!.perKey.error,
    1,
    "the processed window classified as error",
  );

  // The audit row reflects the single applied window.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ALL_ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1);
  assert.equal(row.actorUserId, "actor-13");

  // The window STAYS parked (not silently dropped) with a terminal error
  // outcome stamped this epoch (at >= the timestamp captured before the
  // drain started, so isReArmEligible returns false on the next poll).
  const after = await stateStore.load();
  const entry = after.parkedWindows?.[month];
  assert.ok(entry, "still-broken window stays parked (not dropped)");
  assert.equal(
    (entry as any).reArmOutcome?.kind,
    "error",
    "window stamped terminal error outcome",
  );
  assert.ok(
    (entry as any).reArmOutcome?.at >= before,
    "error outcome stamped at >= epoch start (not re-picked this epoch)",
  );
  assert.equal(
    (entry as any).searchEscalated,
    true,
    "searchEscalated stamped on the error outcome",
  );
}

async function main(): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ["switch off short-circuits to switch_off", testSwitchOffShortCircuits],
      ["zero eligible windows is nothing-to-do", testNoEligibleNothingToDo],
      [
        "N eligible windows drain across N chunks and converge",
        testNEligibleDrainAcrossNChunks,
      ],
      [
        "forward progress (ingested) unparks the window and converges",
        testForwardProgressIngestedUnparks,
      ],
      [
        "proven covered (resolved_covered) unparks the window and converges",
        testForwardProgressResolvedCoveredUnparks,
      ],
      [
        "error (failed re-run) keeps the window parked and converges",
        testErrorKeepsWindowParked,
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
      throw new Error("front-all-windows-rearm-drain test cases failed");
    }
    console.log("front-all-windows-rearm-drain: OK");
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
  console.error("front-all-windows-rearm-drain: FAILED —", err?.stack ?? err);
  process.exitCode = 1;
});
