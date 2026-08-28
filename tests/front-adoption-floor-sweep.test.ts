/* test-registration
{
  "name": "Front adoption floor sweep (baseline triage, Task #3424)",
  "tier": "medium",
  "tierReason": "Sweeps adoption-floor records through the production-facing evaluation path."
}
test-registration */
/**
 * Task #2369 — Converge Front collection to 100% from July 2025.
 *
 * Two regression intents pinned here:
 *
 *   1. Sweep candidate selection (`shouldSweepFrontCoverageMonth`) — the
 *      pure per-month decision the `reach_front_coverage_full_message_grain`
 *      drain uses. It must:
 *        - exclude the live current month and any in-progress row;
 *        - exclude pre-adoption months (below the YYYY-MM floor);
 *        - exclude a covered month that is ALREADY message grain;
 *        - INCLUDE a covered month whose denominator is NOT message grain
 *          (the ≥100%-on-conversation-grain case) so it is re-measured;
 *        - Task #2387: EXCLUDE that covered-but-wrong-grain month when the
 *          #2365 message-grain upgrade driver is enabled (delegated to it),
 *          while a genuinely sub-floor month stays a candidate either way;
 *        - INCLUDE gap / not-measured in-scope months (prior behavior);
 *        - apply no floor when the adoption month is null.
 *
 *   2. Fixed floor (`ensureFrontAdoptionDate` / `getAdoptionFloorMonth`,
 *      Task #2481) — the floor is the hard-coded `FRONT_ADOPTION_DATE`
 *      constant (`2025-07-01`). It is returned regardless of the
 *      `system_settings.front_adoption_date` row: present, absent, or set
 *      to a different value. No code path (worker auto-derivation, operator
 *      route, or UI) can change it, so the regression where a missing row
 *      let the worker re-derive the floor down to 2026-04-16 is eliminated.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2290 / #1920 (message-grain denominator everywhere + search-sourced
 *   message grain), #2281 (sweep convergence + self-heal), #2087
 *   (completeness classifier), #1656 (operator adoption-date override —
 *   removed by #2481), #2369 (established 2025-07-01 as the floor),
 *   #1643 (original adoption-date derivation — replaced by the fixed floor).
 */
import assert from "node:assert/strict";

import { shouldSweepFrontCoverageMonth } from "../server/services/prodActionsRegistry";
import {
  ensureFrontAdoptionDate,
  getAdoptionFloorMonth,
  nextCoverageConvergenceAttempts,
  FRONT_COVERAGE_CONVERGENCE_CAP,
  FRONT_ADOPTION_DATE,
  SETTING_ADOPTION_DATE,
} from "../server/services/frontAnalyticsCoverage";
import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";

const CURRENT = "2026-06";
const FLOOR = "2025-07";

function decide(
  overrides: Partial<Parameters<typeof shouldSweepFrontCoverageMonth>[0]> = {},
): boolean {
  return shouldSweepFrontCoverageMonth({
    month: "2025-09",
    currentMonth: CURRENT,
    adoptionMonth: FLOOR,
    completenessStatus: "apply-gap",
    isMessageGrainDenominator: false,
    ...overrides,
  });
}

// ── 1. current month and in-progress rows are never candidates. ──────
assert.equal(
  decide({ month: CURRENT }),
  false,
  "the live current month is excluded (still accumulating)",
);
assert.equal(
  decide({ completenessStatus: "in-progress" }),
  false,
  "an in-progress month is excluded (still settling)",
);

// ── 2. adoption floor. ───────────────────────────────────────────────
assert.equal(
  decide({ month: "2025-06" }),
  false,
  "a month before the July-2025 floor is excluded",
);
assert.equal(
  decide({ month: FLOOR }),
  true,
  "the floor month itself is in scope",
);
assert.equal(
  decide({ month: "2025-03", adoptionMonth: null }),
  true,
  "no floor filtering when the adoption month is null",
);

// ── 3. the new ≥100%-wrong-grain inclusion. ──────────────────────────
// A covered month already on message grain has nothing left to do.
assert.equal(
  decide({ completenessStatus: "covered", isMessageGrainDenominator: true }),
  false,
  "a covered, message-grain month is fully done and excluded",
);
// A covered month on the WRONG grain (e.g. conversations_all → reads
// ≥100%) must be re-measured to message grain even though it is covered.
assert.equal(
  decide({ completenessStatus: "covered", isMessageGrainDenominator: false }),
  true,
  "a covered-but-conversation-grain month is kept for a message-grain re-measure",
);

// ── 3b. Task #2387 — delegate the grain re-measure to the #2365 driver. ──
// When the message-grain upgrade driver is ON it owns the covered-but-
// wrong-grain re-measure, so this drain must NOT also offer that month.
assert.equal(
  decide({
    completenessStatus: "covered",
    isMessageGrainDenominator: false,
    messageGrainUpgradeDriverEnabled: true,
  }),
  false,
  "a covered-but-wrong-grain month is delegated to the #2365 driver when it is enabled",
);
// A genuinely sub-floor month is the prod-action's recovery-numerator job;
// the measurement-only driver cannot fill it, so it stays a candidate even
// when the driver is enabled.
assert.equal(
  decide({
    completenessStatus: "apply-gap",
    isMessageGrainDenominator: false,
    messageGrainUpgradeDriverEnabled: true,
  }),
  true,
  "a sub-floor month is still a candidate even with the driver enabled (driver is measurement-only)",
);
// A covered, already-message-grain month is fully done regardless of the
// driver flag.
assert.equal(
  decide({
    completenessStatus: "covered",
    isMessageGrainDenominator: true,
    messageGrainUpgradeDriverEnabled: true,
  }),
  false,
  "a covered, message-grain month stays excluded with the driver enabled",
);

// ── 4. existing gap / not-measured behavior is preserved. ────────────
for (const status of ["apply-gap", "ingest-gap", "not-measured"]) {
  assert.equal(
    decide({ completenessStatus: status, isMessageGrainDenominator: true }),
    true,
    `an in-scope ${status} month is still a candidate even on message grain`,
  );
}

// ── 4b. Task #2434 / #2482 / #2745: convergence exhaustion at message grain.
//      The convergence budget is a NUMERATOR concern (a month whose missing
//      rows are proven unfillable); the denominator GRAIN is a separate axis, so
//      a wrong-grain month still needs its forced per-message re-measure even
//      with the budget exhausted.
//      Task #2745 refined the message-grain terminal case: a spent budget alone
//      is NOT proof the deep per-message search walk actually ran (grain-only
//      re-measures / recovery passes can spend it), so a message-grain,
//      NON-plan-limited, budget-exhausted month is KEPT a candidate — letting
//      reach re-run the deep walk — UNTIL `deepSearchExhausted` proves the walk
//      ran to exhaustion, at which point it is retired so the action converges.
assert.equal(
  decide({
    convergenceExhausted: true,
    isMessageGrainDenominator: true,
    deepSearchExhausted: true,
  }),
  false,
  "a convergence-exhausted, message-grain month with the deep-search walk PROVEN exhausted is terminally excluded",
);
assert.equal(
  decide({
    convergenceExhausted: true,
    isMessageGrainDenominator: true,
    deepSearchExhausted: false,
  }),
  true,
  "a convergence-exhausted, message-grain month whose deep-search walk has NOT run to exhaustion stays a candidate (reach re-runs it)",
);
assert.equal(
  decide({ convergenceExhausted: true, isMessageGrainDenominator: true }),
  true,
  "a convergence-exhausted, message-grain month defaults to a candidate when the deep-search marker is absent (budget-spent alone is not proof)",
);
assert.equal(
  decide({ convergenceExhausted: true, isMessageGrainDenominator: false }),
  true,
  "a convergence-exhausted month NOT yet at message grain stays a candidate for the grain re-measure",
);
assert.equal(
  decide({ convergenceExhausted: false }),
  true,
  "a not-yet-exhausted in-scope gap month is still a candidate",
);
// Task #2745 — the deep-search marker only matters once the budget is spent AND
// the month is message grain: a not-yet-exhausted month is a candidate whether
// or not the marker happens to be set (a live month can still make progress).
assert.equal(
  decide({
    convergenceExhausted: false,
    isMessageGrainDenominator: true,
    deepSearchExhausted: true,
  }),
  true,
  "a NOT-exhausted message-grain month stays a candidate even if the deep-search marker is set (budget not yet spent)",
);
// The same axis-independence holds for a covered-but-wrong-grain month: a
// spent budget must not block its grain re-measure either.
assert.equal(
  decide({
    completenessStatus: "covered",
    isMessageGrainDenominator: false,
    convergenceExhausted: true,
  }),
  true,
  "a covered-but-wrong-grain month is kept for the grain re-measure even with the budget exhausted",
);

// ── 4b-bis. Task #2499 — a PLAN-LIMITED month is terminally conversation
//      grain (Front's analytics plan never exposes message grain for it), so
//      no re-measure can ever lift it. Paired with a SPENT convergence budget
//      it is retired so `reach_front_coverage_full_message_grain` converges to
//      not-needed instead of re-sweeping the permanently-stuck month forever.
//      The retire is gated on BOTH plan-limited AND convergence-exhausted, so
//      the Task #2482 behavior (keep wrong-grain months for the grain
//      re-measure) is preserved for every NON-plan-limited month.
for (const status of ["apply-gap", "ingest-gap", "not-measured", "covered"]) {
  assert.equal(
    decide({
      completenessStatus: status,
      isMessageGrainDenominator: false,
      convergenceExhausted: true,
      planLimited: true,
    }),
    false,
    `a plan-limited, convergence-exhausted ${status} month is retired (terminally conversation-grain)`,
  );
  // Plan-limited but budget NOT spent → still a candidate (the budget may yet
  // reset on progress; only the spent-budget case is terminal).
  assert.equal(
    decide({
      completenessStatus: status,
      isMessageGrainDenominator: false,
      convergenceExhausted: false,
      planLimited: true,
    }),
    true,
    `a plan-limited but not-yet-exhausted ${status} month stays a candidate`,
  );
  // Convergence-exhausted but NOT plan-limited → Task #2482 keeps it for the
  // grain re-measure (it can still be lifted to message grain).
  assert.equal(
    decide({
      completenessStatus: status,
      isMessageGrainDenominator: false,
      convergenceExhausted: true,
      planLimited: false,
    }),
    true,
    `a NON-plan-limited, convergence-exhausted ${status} month is still kept for the grain re-measure (Task #2482 preserved)`,
  );
}

// ── 4c. Task #2434: the pure convergence-budget advance decision. ─────
// progress resets the budget; auth_blocked leaves it unchanged (recoverable);
// unreachable jumps straight to the cap (terminal); transient_error bumps by
// one, bounded at the cap.
assert.equal(
  nextCoverageConvergenceAttempts(0, "progress"),
  null,
  "progress from 0 leaves the budget unchanged (already reset)",
);
assert.equal(
  nextCoverageConvergenceAttempts(2, "progress"),
  0,
  "progress from a non-zero budget resets it to 0",
);
assert.equal(
  nextCoverageConvergenceAttempts(1, "auth_blocked"),
  null,
  "auth_blocked never spends the budget (auth-down is recoverable)",
);
assert.equal(
  nextCoverageConvergenceAttempts(0, "unreachable"),
  FRONT_COVERAGE_CONVERGENCE_CAP,
  "a clean no-progress drive jumps straight to the cap (terminal)",
);
assert.equal(
  nextCoverageConvergenceAttempts(1, "transient_error"),
  2,
  "a transient error bumps the budget by one",
);
assert.equal(
  nextCoverageConvergenceAttempts(FRONT_COVERAGE_CONVERGENCE_CAP, "transient_error"),
  FRONT_COVERAGE_CONVERGENCE_CAP,
  "transient errors are bounded at the cap (never exceed it)",
);

// ── 5. Task #2481 — the floor is a hard-coded constant, immune to the
//      `system_settings.front_adoption_date` row (present / absent / changed).
assert.equal(
  FRONT_ADOPTION_DATE,
  "2025-07-01",
  "the hard-coded floor constant is July 2025",
);

async function fixedFloorCheck(): Promise<void> {
  const prior = await getSystemSetting(SETTING_ADOPTION_DATE).catch(() => null);
  try {
    // (a) With NO system_settings row at all the floor is still the constant —
    // this is exactly the regression case (missing row used to let the worker
    // re-derive the floor from source_event_log down to 2026-04-16).
    await deleteSystemSetting(SETTING_ADOPTION_DATE);
    assert.equal(
      await ensureFrontAdoptionDate(),
      "2025-07-01",
      "ensureFrontAdoptionDate returns the constant when the row is missing",
    );
    assert.equal(
      await getAdoptionFloorMonth(),
      "2025-07",
      "getAdoptionFloorMonth derives the YYYY-MM floor from the constant when the row is missing",
    );

    // (b) A stale/divergent row is IGNORED — the constant still wins. The row
    // is dead/ignored per Task #2481.
    await setSystemSetting(SETTING_ADOPTION_DATE, "2026-04-16");
    assert.equal(
      await ensureFrontAdoptionDate(),
      "2025-07-01",
      "ensureFrontAdoptionDate ignores a divergent system_settings row",
    );
    assert.equal(
      await getAdoptionFloorMonth(),
      "2025-07",
      "getAdoptionFloorMonth ignores a divergent system_settings row",
    );
  } finally {
    if (prior?.value) {
      await setSystemSetting(SETTING_ADOPTION_DATE, prior.value);
    } else {
      await deleteSystemSetting(SETTING_ADOPTION_DATE);
    }
  }
}

await fixedFloorCheck();

console.log("front-adoption-floor-sweep.test.ts: OK");
