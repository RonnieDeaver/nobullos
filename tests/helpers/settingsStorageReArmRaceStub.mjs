// Task #2228 — Transparent wrapper around `server/storage/settingsStorage`
// used by the re-arm unpark-race drain test
// (`tests/front-rearm-unpark-race.test.ts`).
//
// The re-arm drains read the persisted auto-closure state via
// `loadState()` → `getSystemSetting(SETTING_STATE)`. The race this suite
// pins is: a parked window survives the eligibility read
// (`countPending` + the chunk's `listReArmableParkedWindows`) but is
// unparked by ANOTHER path (e.g. the auto-closure fresh-checkpoint
// trigger) just before `reArmOneParkedWindow` re-reads state — so
// `reArmOneParkedWindow` sees no entry and returns `{ outcome: null }`,
// which `runChunk` maps to the `"skipped"` perKey bucket.
//
// Reproducing that micro-race deterministically requires controlling the
// gap between two back-to-back `getSystemSetting(SETTING_STATE)` reads
// (the eligibility read vs. `reArmOneParkedWindow`'s `pre` read), which
// no test-thread `await` point can hit. So this wrapper counts
// SETTING_STATE reads and, once armed, strips the target month(s) from
// the RETURNED value (not the stored row) after a configured number of
// reads — exactly as if a concurrent unpark had removed them in that gap.
//
// Everything else delegates to the REAL settingsStorage so the rest of
// the loaded module graph (kill switches, prod-action registry, etc.)
// behaves identically to production. The companion resolve hook
// (`reArmRaceDrainMockLoader.mjs`) redirects settingsStorage imports here
// for every consumer EXCEPT this file's own import of the real module
// (guarded by a parentURL check) so there is no redirect loop.

import * as real from "../../server/storage/settingsStorage.ts";

// Re-export the full real surface; the local `getSystemSetting` below
// shadows the star-re-exported one (local explicit exports win in ESM).
export * from "../../server/storage/settingsStorage.ts";

// Must match `SETTING_STATE` in `server/services/frontAutoClosure.ts`.
const SETTING_STATE = "front_auto_closure_state";

let armed = false;
let dropAfterReads = 0;
let monthsToDrop = [];
let stateReadCount = 0;

export async function getSystemSetting(key) {
  const row = await real.getSystemSetting(key);
  if (!armed || key !== SETTING_STATE) return row;

  stateReadCount += 1;
  // Reads up to and including `dropAfterReads` see the window untouched
  // (these are the eligibility reads — `countPending` and the chunk's
  // `listReArmableParkedWindows`). Every later read has the month(s)
  // removed, simulating the concurrent unpark that lands in the gap
  // before `reArmOneParkedWindow` re-reads state.
  if (stateReadCount <= dropAfterReads || !row?.value || monthsToDrop.length === 0) {
    return row;
  }
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && parsed.parkedWindows && typeof parsed.parkedWindows === "object") {
      let changed = false;
      for (const m of monthsToDrop) {
        if (m in parsed.parkedWindows) {
          delete parsed.parkedWindows[m];
          changed = true;
        }
      }
      if (changed) return { ...row, value: JSON.stringify(parsed) };
    }
  } catch {
    /* malformed value — fall through to the raw row */
  }
  return row;
}

/**
 * Arm the unpark race. `dropAfterReads` SETTING_STATE reads return the
 * window intact; every read after that strips `months` from the returned
 * parkedWindows map. Resets the read counter.
 */
export function __armUnparkRace({ dropAfterReads: n, months }) {
  armed = true;
  dropAfterReads = n;
  monthsToDrop = months.slice();
  stateReadCount = 0;
}

export function __disarmUnparkRace() {
  armed = false;
  dropAfterReads = 0;
  monthsToDrop = [];
  stateReadCount = 0;
}

export function __stateReadCount() {
  return stateReadCount;
}
