/* test-registration
{
  "name": "Front re-arm unpark-race counts skipped (Task #2228)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/reArmRaceDrainSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2228 — A parked window unparked mid-drain is counted, not
 * double-processed (the `null`-outcome / `"skipped"` race).
 *
 * The re-arm drains classify each processed window into a perKey bucket:
 *   `const key = outcome?.kind ?? "skipped"`
 * Tasks #2151 / #2174 / #2192 pin every REAL classification
 * (still_empty, ingested, resolved_covered, error). The remaining,
 * untested branch is the `null` outcome — the race where a parked window
 * is unparked by ANOTHER path (e.g. the auto-closure fresh-checkpoint
 * trigger's `decideAutoUnpark`) AFTER it passed the eligibility read
 * (`countPending` + the chunk's `listReArmableParkedWindows`) but BEFORE
 * `reArmOneParkedWindow` re-reads state. `reArmOneParkedWindow` then sees
 * no entry and returns `{ outcome: null }`, which `runChunk` must still
 * count as `processed: 1` under the `"skipped"` bucket so the drain
 * advances and converges in one pass — without re-running the Front walk
 * (no classification mis-attributed) and without double-counting.
 *
 * Why this needs a custom hook: the race lives in the gap between two
 * back-to-back `getSystemSetting(SETTING_STATE)` reads (the eligibility
 * read vs. `reArmOneParkedWindow`'s `pre` read) — no test-thread `await`
 * can land there. So the settingsStorage wrapper
 * (`settingsStorageReArmRaceStub.mjs`) counts SETTING_STATE reads and,
 * once armed, strips the target month from the RETURNED value after the
 * eligibility reads, exactly as a concurrent unpark would. The Front walk
 * (`runTargetedWindowBackfill`) and the finalize-audit
 * (`recordProdActionRun`) are redirected to in-memory stubs, so this
 * suite makes no real Front API calls and never writes
 * `prod_action_runs`.
 *
 * Read ordering (both drains): countPending issues SETTING_STATE read #1,
 * the chunk's eligibility read is #2, and `reArmOneParkedWindow`'s `pre`
 * read is #3 — so `dropAfterReads: 2` keeps the window visible for the
 * count + chunk eligibility check and removes it exactly for the `pre`
 * read, deterministically driving the `null` → `skipped` branch.
 *
 * State note: like the sibling re-arm suites this reads/writes the shared
 * persisted auto-closure state in `system_settings`, which the live dev
 * server's `runFrontAutoClosureTick` also mutates. The all-windows drain
 * enumerates the WHOLE parked set, so this suite snapshots the existing
 * `parkedWindows` map, replaces it with only its own far-future (2996-*)
 * test window for the duration of a case, and restores the snapshot
 * afterwards. The wrapper only masks the window in the READ value (it
 * never persists the removal), so the snapshot/restore is unaffected.
 *
 * Usage: tsx --import ./tests/helpers/reArmRaceDrainSetup.mjs \
 *            tests/front-rearm-unpark-race.test.ts
 */
import assert from "node:assert/strict";
import {
  startParkedWindowReArmDrain,
  startOneParkedWindowReArmDrain,
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
  __getCallCount,
  __resetStub,
} from "./helpers/frontHistoricalRecoveryReArmStub.mjs";
import {
  __armUnparkRace,
  __disarmUnparkRace,
} from "./helpers/settingsStorageReArmRaceStub.mjs";

const { loadState, saveState } = __frontAutoClosureTestHelpers;

const FUTURE_YEAR = 2996;
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const ALL_ACTION_ID = "rearm_parked_front_recovery_windows";
// The window passes the count (read #1) and the chunk eligibility read
// (#2); `reArmOneParkedWindow`'s `pre` read (#3) is the first to see it
// gone — the moment the concurrent unpark lands.
const DROP_AFTER_READS = 2;

// The four real classifications; none may be set on the null/skipped
// path (a `null` outcome means the Front walk never ran).
const REAL_KINDS = ["still_empty", "ingested", "resolved_covered", "error"];

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

/** Replace the entire `parkedWindows` map with exactly `entries`. */
async function setParked(entries: Record<string, any>): Promise<void> {
  const state = await loadState();
  state.parkedWindows = entries;
  await saveState(state);
}

function assertNoRealClassification(perKey: Record<string, number>): void {
  for (const kind of REAL_KINDS) {
    assert.equal(
      perKey[kind],
      undefined,
      `no Front-walk classification mis-attributed (${kind} unset)`,
    );
  }
}

// ── 1. All-windows drain: window unparked mid-drain → counted skipped. ──
async function testAllWindowsRaceCountsSkipped(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  __disarmUnparkRace();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  const month = `${FUTURE_YEAR}-01`;
  await setParked({ [month]: mkParkedEntry() });

  // Arm AFTER seeding so the seed writes/reads don't consume the read
  // budget — the counter only spans the drain's SETTING_STATE reads.
  __armUnparkRace({ dropAfterReads: DROP_AFTER_READS, months: [month] });

  const res = await startParkedWindowReArmDrain("actor-race-1");
  assert.equal(res.state, "started", "eligible window starts a drain");
  assert.equal(
    res.totalParked,
    1,
    "countPending saw the window BEFORE the unpark (totalParked=1)",
  );

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE finishedAt
  // flips), so poll the flag instead of asserting it immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");
  __disarmUnparkRace();

  // The Front walk never ran — a null outcome short-circuits before
  // `runTargetedWindowBackfill`, so nothing was re-classified.
  assert.equal(
    __getCallCount(),
    0,
    "no Front walk on the null/skipped path (no double-processing)",
  );

  const state = getDrainState(ALL_ACTION_ID);
  assert.ok(state, "drain state registered under the all-windows actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "the raced window still counts processed:1");
  assert.equal(
    state!.perKey.skipped,
    1,
    "the null outcome maps to the skipped bucket (drain advances)",
  );
  assertNoRealClassification(state!.perKey);

  // Converges in one pass: the audit row is `applied` for the single
  // processed window — not double-counted, not dropped.
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, ALL_ACTION_ID);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1, "exactly one window counted (no double)");
  assert.equal(row.actorUserId, "actor-race-1");
}

// ── 2. One-window drain: same race → counted skipped, converges. ───────
async function testOneWindowRaceCountsSkipped(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  __disarmUnparkRace();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

  const month = `${FUTURE_YEAR}-02`;
  await setParked({ [month]: mkParkedEntry() });

  __armUnparkRace({ dropAfterReads: DROP_AFTER_READS, months: [month] });

  const actionId = `rearm_parked_front_recovery_window_${month}`;
  const res = await startOneParkedWindowReArmDrain(month, "actor-race-2");
  assert.equal(res.state, "started", "an eligible parked month starts a drain");
  assert.equal(
    res.totalParked,
    1,
    "countPending saw the window BEFORE the unpark (totalParked=1)",
  );

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Same Task #2234 finalize-ordering race as above: poll, don't assert.
  await waitFor(() => isDrainRunning(actionId) === false, 5000, "drain finished");
  __disarmUnparkRace();

  assert.equal(
    __getCallCount(),
    0,
    "no Front walk on the null/skipped path (no double-processing)",
  );

  const state = getDrainState(actionId);
  assert.ok(state, "drain state registered under the per-month actionId");
  assert.equal(state!.chunks, 1, "exactly one productive chunk");
  assert.equal(state!.processed, 1, "the raced window still counts processed:1");
  assert.equal(
    state!.perKey.skipped,
    1,
    "the null outcome maps to the skipped bucket (drain advances)",
  );
  assertNoRealClassification(state!.perKey);

  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 1, "exactly one window counted (no double)");
  assert.equal(row.actorUserId, "actor-race-2");
}

async function main(): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  const origParked = { ...((await loadState()).parkedWindows ?? {}) };
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      [
        "all-windows drain counts a mid-drain unpark as skipped and converges",
        testAllWindowsRaceCountsSkipped,
      ],
      [
        "one-window drain counts a mid-drain unpark as skipped and converges",
        testOneWindowRaceCountsSkipped,
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
      throw new Error("front-rearm-unpark-race test cases failed");
    }
    console.log("front-rearm-unpark-race: OK");
  } finally {
    __disarmUnparkRace();
    await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
    // Restore the original parked set (drops this suite's 2996-* window).
    await setParked(origParked);
  }
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("front-rearm-unpark-race: FAILED —", err?.stack ?? err);
  process.exitCode = 1;
});
