/* test-registration
{
  "name": "Front auto-closure search escalation + operator re-arm (Task #2097)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2097 — Front recovery auto-park search escalation + operator re-arm.
 *
 * Task #2085 added two non-trivial behaviors to the auto-closure loop
 * that the older park/unpark suite
 * (tests/front-auto-closure-park-window.test.ts) does not cover. This
 * file exercises the dedicated test-helper surface added for them
 * (`__frontAutoClosureTestHelpers` + the exported re-arm functions):
 *
 *   A. Pre-park search escalation — a *legacy*-strategy page-cap dead
 *      run is the only shape that gets migrated to the search strategy,
 *      the escalation is gated on the
 *      `front_recovery_sparse_month_search_strategy_enabled` switch, the
 *      in-flight marker is durable (so it fires at most once), it is
 *      cleared on un-park, and the post-escalation park decision fires
 *      only when the escalated re-run lands a *new* dead-run checkpoint.
 *   B. `classifyReArmCheckpoint` outcome mapping (ingested /
 *      resolved_covered / still_empty / error).
 *   C. The re-arm drain's `sinceIso` epoch excludes already-stamped (and
 *      permanently still_empty) windows so a single operator press
 *      terminates after one pass.
 *
 * State note: this suite reads/writes the shared persisted auto-closure
 * state in `system_settings`, which the live dev server's
 * `runFrontAutoClosureTick` also mutates. All persisted rows use a
 * unique far-future month prefix (2997-*) that never appears in the
 * coverage table, so the dev server's read-modify-write preserves them.
 * See .agents/memory/test-db-pool-exit-and-contention.md § 2b.
 */
import assert from "node:assert/strict";
import {
  unparkRecoveryWindow,
  listReArmableParkedWindows,
  reArmOneParkedWindow,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
  type SearchReArmOutcome,
} from "../server/services/frontAutoClosure";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
} from "../server/services/poolEpicKillSwitches";

const FUTURE_YEAR = 2997;
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";

const {
  isDeadRunCheckpoint,
  isLegacyStrategyDeadRun,
  isSearchEscalationEnabled,
  classifyReArmCheckpoint,
  isReArmEligible,
} = __frontAutoClosureTestHelpers;

// Task #2239 — drive an injected in-memory store instead of read-modify-
// writing the global `front_auto_closure_state` setting on the shared dev
// DB. The exported re-arm functions accept the store explicitly; a fresh
// store at the top of the run is the reset.
const stateStore = createInMemoryStateStore();

/** Canonical legacy page-cap dead-run checkpoint reason. */
const DEAD_REASON =
  "safety_max_pages_reached_resume_available scanned=25000 ingested=0";

async function main(): Promise<void> {
  {

  // ════════════════════════════════════════════════════════════════════
  // A. Pre-park search escalation
  // ════════════════════════════════════════════════════════════════════

  // ── A1. isLegacyStrategyDeadRun — only a legacy `/conversations?`
  //         page-cap dead run is escalation-eligible. ───────────────────
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 0,
      statusReason: DEAD_REASON,
      completedAt: "2030-01-01T00:00:00Z",
      lastPageUrl: "/conversations?sort_by=date&page_token=abc",
    } as any),
    true,
    "legacy enumeration page-cap dead run is escalation-eligible",
  );
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 0,
      statusReason: DEAD_REASON,
      completedAt: "2030-01-01T00:00:00Z",
      lastPageUrl: "/conversations/search/after:1/before:2?page_token=abc",
    } as any),
    false,
    "a dead run already on the search endpoint is NOT escalated (no strategy change)",
  );
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 0,
      statusReason: DEAD_REASON,
      completedAt: "2030-01-01T00:00:00Z",
      lastPageUrl: "",
    } as any),
    false,
    "missing resume cursor cannot be classified as legacy — not escalated",
  );
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 0,
      statusReason: DEAD_REASON,
      completedAt: "2030-01-01T00:00:00Z",
    } as any),
    false,
    "absent lastPageUrl is not a legacy dead run",
  );
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 7,
      statusReason: DEAD_REASON,
      completedAt: "2030-01-01T00:00:00Z",
      lastPageUrl: "/conversations?sort_by=date",
    } as any),
    false,
    "forward progress (ingested>0) is never a dead run regardless of cursor",
  );
  assert.equal(
    isLegacyStrategyDeadRun({
      ingested: 0,
      statusReason: "auth_failed",
      completedAt: "2030-01-01T00:00:00Z",
      lastPageUrl: "/conversations?sort_by=date",
    } as any),
    false,
    "a non-page-cap reason is not a dead run, so not escalated",
  );
  assert.equal(
    isLegacyStrategyDeadRun(null),
    false,
    "null checkpoint is not a legacy dead run",
  );

  // ── A2. isSearchEscalationEnabled honors the switch. ─────────────────
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  try {
    await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
    assert.equal(
      isSearchEscalationEnabled(),
      true,
      "escalation enabled when the search-strategy switch is ON",
    );
    await setPoolEpicSwitch(SEARCH_SWITCH, false, "system");
    assert.equal(
      isSearchEscalationEnabled(),
      false,
      "escalation disabled when the search-strategy switch is OFF",
    );
  } finally {
    await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
  }

  // ── A3. Post-escalation park decision — park only when the escalated
  //         re-run lands a NEW dead-run checkpoint. This mirrors the
  //         tick's rule `isDeadRunCheckpoint(cp) && escalatedRunLanded`
  //         using only the exported classifier. ──────────────────────────
  const decidePostEscalation = (
    cp: { ingested: number; statusReason: string; completedAt: string },
    triggeredByCheckpointAt: string | null,
  ): "park" | "wait" | "release" => {
    const landed =
      cp.completedAt != null && cp.completedAt !== triggeredByCheckpointAt;
    if (!landed) return "wait";
    return isDeadRunCheckpoint(cp as any) ? "park" : "release";
  };

  const triggerAt = "2030-03-01T00:00:00Z";
  assert.equal(
    decidePostEscalation(
      { ingested: 0, statusReason: DEAD_REASON, completedAt: triggerAt },
      triggerAt,
    ),
    "wait",
    "same checkpoint as the one that triggered escalation = escalated run not landed yet → wait",
  );
  assert.equal(
    decidePostEscalation(
      {
        ingested: 0,
        statusReason: DEAD_REASON,
        completedAt: "2030-03-05T00:00:00Z",
      },
      triggerAt,
    ),
    "park",
    "a fresh dead-run checkpoint after escalation → park",
  );
  assert.equal(
    decidePostEscalation(
      { ingested: 12, statusReason: "done", completedAt: "2030-03-05T00:00:00Z" },
      triggerAt,
    ),
    "release",
    "a fresh checkpoint with forward progress → release (do not park)",
  );

  // ── A4. The in-flight escalation marker is durable (fires at most
  //         once) and is cleared on un-park. ─────────────────────────────
  const escMonth = `${FUTURE_YEAR}-01`;
  const seed = await stateStore.load();
  seed.searchEscalations = seed.searchEscalations ?? {};
  seed.parkedWindows = seed.parkedWindows ?? {};
  seed.searchEscalations[escMonth] = {
    escalatedAt: "2030-03-01T00:00:00Z",
    triggeredByCheckpointAt: triggerAt,
    deadRunsAtEscalation: 3,
  };
  await stateStore.save(seed);

  const afterSeed = await stateStore.load();
  assert.deepEqual(
    afterSeed.searchEscalations?.[escMonth],
    {
      escalatedAt: "2030-03-01T00:00:00Z",
      triggeredByCheckpointAt: triggerAt,
      deadRunsAtEscalation: 3,
    },
    "escalation marker is durable across a state reload (so it fires at most once)",
  );

  // Simulate the post-escalation park, then un-park and confirm BOTH the
  // parked entry and the escalation marker are dropped.
  const seed2 = await stateStore.load();
  seed2.parkedWindows = seed2.parkedWindows ?? {};
  seed2.parkedWindows[escMonth] = {
    parkedAt: "2030-03-05T00:00:00Z",
    reason: "dead_run_streak:3_runs_post_search_escalation",
    deadRuns: 3,
    lastCheckpointAt: "2030-03-05T00:00:00Z",
    searchEscalated: true,
    searchEscalatedAt: "2030-03-01T00:00:00Z",
    reArmOutcome: {
      kind: "still_empty",
      ingested: 0,
      at: "2030-03-05T00:00:00Z",
      source: "auto_escalation",
    },
  } as any;
  await stateStore.save(seed2);

  const unpark = await unparkRecoveryWindow(escMonth, stateStore);
  assert.equal(unpark.unparked, true, "un-park reports a change");
  const afterUnpark = await stateStore.load();
  assert.equal(
    afterUnpark.parkedWindows?.[escMonth],
    undefined,
    "un-park clears the parked entry",
  );
  assert.equal(
    afterUnpark.searchEscalations?.[escMonth],
    undefined,
    "un-park also clears the in-flight escalation marker so the window may escalate again after a full reset",
  );

  // ════════════════════════════════════════════════════════════════════
  // B. classifyReArmCheckpoint outcome mapping
  // ════════════════════════════════════════════════════════════════════
  const at = "2030-04-01T00:00:00Z";
  assert.deepEqual(
    classifyReArmCheckpoint(
      { status: "partial", statusReason: null, ingested: 9 },
      "operator_rearm",
      at,
    ),
    { kind: "ingested", ingested: 9, at, source: "operator_rearm" },
    "ingested>0 → ingested (forward progress, will unpark)",
  );
  assert.deepEqual(
    classifyReArmCheckpoint(
      { status: "complete", statusReason: null, ingested: 0 },
      "operator_rearm",
      at,
    ),
    { kind: "resolved_covered", ingested: 0, at, source: "operator_rearm" },
    "complete + 0 ingested → resolved_covered (month genuinely covered, will unpark)",
  );
  assert.deepEqual(
    classifyReArmCheckpoint(
      { status: "empty_source", statusReason: null, ingested: 0 },
      "operator_rearm",
      at,
    ),
    { kind: "resolved_covered", ingested: 0, at, source: "operator_rearm" },
    "empty_source + 0 ingested → resolved_covered",
  );
  assert.deepEqual(
    classifyReArmCheckpoint(
      {
        status: "partial",
        statusReason:
          "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
        ingested: 0,
      },
      "operator_rearm",
      at,
    ),
    { kind: "still_empty", ingested: 0, at, source: "operator_rearm" },
    "partial + safety_max page cap + 0 ingested → still_empty (stays parked)",
  );
  assert.deepEqual(
    classifyReArmCheckpoint(
      { status: "blocked", statusReason: "auth", ingested: 0 },
      "operator_rearm",
      at,
    ),
    {
      kind: "error",
      ingested: 0,
      at,
      source: "operator_rearm",
      detail: "blocked:auth",
    },
    "blocked → error with status:reason detail (stays parked)",
  );
  assert.deepEqual(
    classifyReArmCheckpoint(
      { status: "failed", statusReason: null, ingested: 0 },
      "operator_rearm",
      at,
    ),
    { kind: "error", ingested: 0, at, source: "operator_rearm", detail: "failed" },
    "failed with no reason → error with bare status detail",
  );
  assert.equal(
    classifyReArmCheckpoint(
      { status: "partial", statusReason: "some_transient_thing", ingested: 0 },
      "operator_rearm",
      at,
    ).kind,
    "error",
    "partial WITHOUT the page-cap reason is not still_empty — it is an error",
  );
  assert.equal(
    classifyReArmCheckpoint(
      { status: "complete", statusReason: null, ingested: 0 },
      "auto_escalation",
      at,
    ).source,
    "auto_escalation",
    "source is propagated onto the outcome",
  );

  // ════════════════════════════════════════════════════════════════════
  // C. Re-arm eligibility + sinceIso drain epoch
  // ════════════════════════════════════════════════════════════════════
  const sinceIso = "2030-05-01T00:00:00Z";
  const olderThanEpoch = "2030-04-30T00:00:00Z";
  const withinEpoch = "2030-05-02T00:00:00Z";

  const mkEntry = (outcome?: SearchReArmOutcome): any => ({
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
    ...(outcome ? { reArmOutcome: outcome } : {}),
  });

  // ── C1. isReArmEligible truth table. ─────────────────────────────────
  assert.equal(
    isReArmEligible(mkEntry(), sinceIso),
    true,
    "never-re-armed parked window is eligible",
  );
  assert.equal(
    isReArmEligible(
      mkEntry({ kind: "still_empty", ingested: 0, at: olderThanEpoch, source: "operator_rearm" }),
      sinceIso,
    ),
    false,
    "still_empty is permanently ineligible (re-running would just dead-run again)",
  );
  assert.equal(
    isReArmEligible(
      mkEntry({ kind: "error", ingested: 0, at: withinEpoch, source: "auto_escalation" }),
      sinceIso,
    ),
    true,
    "an auto_escalation outcome does not block an operator re-arm",
  );
  assert.equal(
    isReArmEligible(
      mkEntry({ kind: "error", ingested: 0, at: withinEpoch, source: "operator_rearm" }),
      sinceIso,
    ),
    false,
    "operator_rearm stamped within this epoch (at >= sinceIso) is excluded → drain terminates",
  );
  assert.equal(
    isReArmEligible(
      mkEntry({ kind: "error", ingested: 0, at: olderThanEpoch, source: "operator_rearm" }),
      sinceIso,
    ),
    true,
    "operator_rearm stamped in a PRIOR epoch (at < sinceIso) is eligible again",
  );

  // ── C2. listReArmableParkedWindows reflects the eligibility filter. ──
  const mEligible = `${FUTURE_YEAR}-02`;
  const mStillEmpty = `${FUTURE_YEAR}-03`;
  const mThisEpoch = `${FUTURE_YEAR}-04`;
  const mOldEpoch = `${FUTURE_YEAR}-05`;
  const c2 = await stateStore.load();
  c2.parkedWindows = c2.parkedWindows ?? {};
  c2.parkedWindows[mEligible] = mkEntry();
  c2.parkedWindows[mStillEmpty] = mkEntry({
    kind: "still_empty",
    ingested: 0,
    at: olderThanEpoch,
    source: "operator_rearm",
  });
  c2.parkedWindows[mThisEpoch] = mkEntry({
    kind: "error",
    ingested: 0,
    at: withinEpoch,
    source: "operator_rearm",
  });
  c2.parkedWindows[mOldEpoch] = mkEntry({
    kind: "error",
    ingested: 0,
    at: olderThanEpoch,
    source: "operator_rearm",
  });
  await stateStore.save(c2);

  const listed = (await listReArmableParkedWindows(sinceIso, stateStore)).filter((m) =>
    m.startsWith(`${FUTURE_YEAR}-`),
  );
  assert.deepEqual(
    listed,
    [mEligible, mOldEpoch].sort(),
    "only the never-armed and prior-epoch windows are offered; still_empty and same-epoch are excluded",
  );

  // ── C3. A single press terminates after one pass: once a window is
  //         re-armed and stays parked, stamping operator_rearm at
  //         >= sinceIso removes it from the eligible set. ────────────────
  const c3 = await stateStore.load();
  const cur = c3.parkedWindows?.[mEligible];
  assert.ok(cur, "seeded eligible window still present before stamping");
  (cur as any).reArmOutcome = {
    kind: "error",
    ingested: 0,
    at: withinEpoch,
    source: "operator_rearm",
  };
  await stateStore.save(c3);
  const afterStamp = (await listReArmableParkedWindows(sinceIso, stateStore)).filter((m) =>
    m.startsWith(`${FUTURE_YEAR}-`),
  );
  assert.deepEqual(
    afterStamp,
    [mOldEpoch],
    "a window stamped this epoch is no longer offered, so the drain converges after one pass",
  );

  // ── C4. reArmOneParkedWindow early-return paths (no Front walk). ──────
  const notParked = await reArmOneParkedWindow(
    `${FUTURE_YEAR}-12`,
    "tester",
    sinceIso,
    stateStore,
  );
  assert.deepEqual(
    notParked,
    { month: `${FUTURE_YEAR}-12`, outcome: null },
    "re-arming an unparked month is a no-op with a null outcome (never reaches the Front walk)",
  );

  const ineligible = await reArmOneParkedWindow(mStillEmpty, "tester", sinceIso, stateStore);
  assert.equal(
    ineligible.outcome?.kind,
    "still_empty",
    "re-arming a still_empty window returns the existing outcome without re-running it",
  );

  console.log("✓ front-auto-closure search-escalation + re-arm tests passed");
  }
  // No teardown needed: the in-memory `stateStore` is discarded with this
  // process, so nothing was written to the shared dev DB (Task #2239).
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
