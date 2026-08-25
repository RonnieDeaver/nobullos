/* test-registration
{
  "name": "Report form autosave aggregate under concurrent section saves (Task #4351)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure in-memory state machine, no DB/network/DOM, sub-second: guards the edit form's save indicator against lying under concurrency — the exact regression class (first settlement claiming 'All changes saved' while sibling section saves are in flight or failed) that a shared scalar feedback state reintroduces.",
  "tier": "small"
}
test-registration */
/**
 * Task #4351 — ReportForm runs four debounced section autosaves whose
 * network writes overlap freely. The header indicator derives from
 * client/src/lib/reportAutosaveAggregate.ts; these cases pin the truth
 * conditions:
 *
 *   - "saved" only when NO section is dirty, in flight, or failed;
 *   - a section's failure stays visible until THAT section retries —
 *     unrelated sections succeeding must not mask it;
 *   - out-of-order settlements (success after failure and vice versa)
 *     resolve by last-settlement-wins WITHIN a section;
 *   - dirty (debounce pending) outranks everything.
 */

import assert from "node:assert/strict";
import {
  createAutosaveAggregator,
  deriveAutosaveIndicator,
  type AutosaveIndicatorStatus,
} from "../client/src/lib/reportAutosaveAggregate";

function status(
  agg: ReturnType<typeof createAutosaveAggregator>,
  anyDirty = false,
): AutosaveIndicatorStatus {
  return deriveAutosaveIndicator(agg.snapshot(), anyDirty);
}

async function main(): Promise<void> {
  // ── 1. The review's core case: first success must NOT claim "saved"
  // while a sibling section save is still in flight. ──
  {
    const agg = createAutosaveAggregator();
    agg.record("sales", "start");
    agg.record("marketing", "start");
    assert.equal(status(agg), "saving", "two saves in flight → saving");

    agg.record("sales", "success");
    assert.equal(
      status(agg),
      "saving",
      "sales settled first but marketing is still in flight — 'saved' here is the lie this module exists to prevent",
    );

    agg.record("marketing", "success");
    assert.equal(status(agg), "saved", "all sections settled clean → saved");
  }

  // ── 2. Out-of-order overlap ending in failure: late failure wins the
  // aggregate even though an unrelated success arrived in between. ──
  {
    const agg = createAutosaveAggregator();
    agg.record("intake", "start");
    agg.record("nextActions", "start");
    agg.record("intake", "success");
    assert.equal(status(agg), "saving", "nextActions still in flight");
    agg.record("nextActions", "failure");
    assert.equal(
      status(agg),
      "error",
      "quiesced with one failed section → error, not saved",
    );
  }

  // ── 3. Failure is sticky per section: other sections saving cleanly
  // must not mask it (the failed section's edits remain unsaved). ──
  {
    const agg = createAutosaveAggregator();
    agg.record("sales", "start");
    agg.record("sales", "failure");
    assert.equal(status(agg), "error");

    agg.record("marketing", "start");
    assert.equal(status(agg), "saving", "a new save is on the network");
    agg.record("marketing", "success");
    assert.equal(
      status(agg),
      "error",
      "marketing succeeded but sales' failed edits are still unsaved",
    );
  }

  // ── 4. Same-section retry clears its own failure. ──
  {
    const agg = createAutosaveAggregator();
    agg.record("sales", "start");
    agg.record("sales", "failure");
    agg.record("sales", "start");
    assert.equal(status(agg), "saving", "retry supersedes the failure flag");
    agg.record("sales", "success");
    assert.equal(status(agg), "saved");
  }

  // ── 5. Within-section out-of-order: two overlapping saves of the SAME
  // section; whichever settles last determines that section's face. ──
  {
    const agg = createAutosaveAggregator();
    agg.record("intake", "start");
    agg.record("intake", "start");
    agg.record("intake", "failure");
    assert.equal(
      status(agg),
      "saving",
      "one of two overlapping intake saves failed, one still in flight",
    );
    agg.record("intake", "success");
    assert.equal(status(agg), "saved", "last settlement was a success");
  }
  {
    const agg = createAutosaveAggregator();
    agg.record("intake", "start");
    agg.record("intake", "start");
    agg.record("intake", "success");
    agg.record("intake", "failure");
    assert.equal(status(agg), "error", "last settlement was a failure");
  }

  // ── 6. Dirty outranks everything; idle before any activity. ──
  {
    const agg = createAutosaveAggregator();
    assert.equal(status(agg), "idle", "no activity, nothing dirty → idle");
    assert.equal(status(agg, true), "dirty", "debounce pending → dirty");
    agg.record("sales", "start");
    assert.equal(status(agg, true), "dirty", "dirty outranks saving");
    agg.record("sales", "failure");
    assert.equal(status(agg, true), "dirty", "dirty outranks error");
    assert.equal(status(agg), "error");
  }

  // ── 7. onChange fires per event and reset() forgets everything. ──
  {
    let changes = 0;
    const agg = createAutosaveAggregator(() => {
      changes += 1;
    });
    agg.record("sales", "start");
    agg.record("sales", "success");
    assert.equal(changes, 2, "one onChange per recorded event");
    assert.equal(status(agg), "saved");
    agg.reset();
    assert.equal(changes, 3, "reset also notifies");
    assert.equal(status(agg), "idle", "reset returns to pre-activity idle");
  }

  // ── Task #4551: useSyncExternalStore contract — subscribe fires on
  // every mutation, snapshot() is a CACHED object (referentially stable
  // between changes, replaced on change) so React's external-store hook
  // neither loops nor misses updates. ──
  {
    const agg = createAutosaveAggregator();
    let fires = 0;
    const unsubscribe = agg.subscribe(() => fires++);
    const before = agg.snapshot();
    assert.equal(
      agg.snapshot(),
      before,
      "snapshot is referentially stable while nothing changed",
    );
    agg.record("intake", "start");
    assert.equal(fires, 1, "subscribe listener fired on record()");
    const after = agg.snapshot();
    assert.notEqual(before, after, "snapshot object replaced on change");
    assert.equal(
      agg.snapshot(),
      after,
      "new snapshot is stable until the next change",
    );
    agg.record("intake", "success");
    assert.equal(fires, 2, "listener fired again on settlement");
    unsubscribe();
    agg.reset();
    assert.equal(fires, 2, "unsubscribed listener no longer fires");
  }

  console.log("report-autosave-aggregate: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
