/* test-registration
{
  "name": "gate duration budget — artifact integrity + evaluator semantics (Task #4531)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4531 (L3-approved gate policy): the merge gate's duration-budget ratchet. Validates the committed tests/gate-duration-budget.json (schema, self-hash tamper seal, formula binding budget = min(ceil(1.30×source wall), pin) with clamp consistency, zero-skip full-smoke source-run invariants, pinned maxima: full-smoke wall ≤ 40min, per-suite default ceiling ≤ 90s, gate lint phase ≤ 240s) and pins the evaluator + selection-mode semantics run-all.ts enforces: per-suite ceilings judge per-attempt time of PASSING suites only, FAIL full-smoke runs and WARN related/sweep runs; registered timeoutMs overrides are the sanctioned slow lane and become the suite's ceiling; the whole-run wall budget is ALERT-ONLY (Task #5030 revision: a wall breach NEVER fails a run — green stays green; breach events feed the scheduler's auto-filed re-baseline/triage item) and is measured only on full-smoke zero-deferral runs; enforcement keys on the ACTUAL selected universe so related-selection fallback-to-full runs are budget-ENFORCED and --full-smoke refuses inherited TEST_SMOKE_RELATED (wiring source-pinned). DB-free, network-free, <5s; fs reads confined to the committed artifact + run-all + gate wiring pins (scanPaths); 4d exercises the REAL exported gate spawn seam (buildSmokeGateCheck/composeSpawnEnv): --full-smoke passes through npm argv to the runner and STRIPS inherited TEST_SMOKE_RELATED from the composed child env.",
  "scanPaths": ["tests/gate-duration-budget.json", "tests/run-all.ts", "scripts/gate.ts"],
  "tier": "small"
}
test-registration */
/**
 * Task #4531 — Guard for the merge-gate duration budget.
 *
 * The committed artifact (tests/gate-duration-budget.json) is a frozen-
 * snapshot ratchet: derived from ONE measured zero-skip full-smoke run by
 * the sole writer (scripts/regen-gate-duration-budget.ts), sealed with a
 * self-hash, bounded by owner-approved pins. This suite proves:
 *
 *   1. The committed artifact validates (schema + self-hash + pins + source-
 *      run invariants) — a merge that tampers with or corrupts it goes red.
 *   2. The pins match the owner-approved policy values.
 *   3. Tampering (value edit without re-hash) is refused.
 *   4. A budget above a pin is refused even with a correct self-hash;
 *      4b. the formula binding refuses RE-HASHED budget edits;
 *      4c. enforcement keys on the ACTUAL selected universe (fallback-to-
 *      full related runs are enforced; --full-smoke refuses inherited
 *      TEST_SMOKE_RELATED), with the run-all wiring source-pinned.
 *   5-11. Evaluator semantics (per-suite ceilings, timeoutMs slow lane,
 *      per-attempt division, failed-suite exclusion, alert-only wall —
 *      Task #5030: a wall breach never fails a run, and deferral-narrowed
 *      runs skip the wall comparison entirely — mode/related gating) — the
 *      exact rules run-all.ts enforces.
 *      4d. the gate spawn seam: --full-smoke strips inherited
 *          TEST_SMOKE_RELATED from the child env + npm argv pass-through.
 */

import { readFileSync } from "node:fs";
import { buildSmokeGateCheck, composeSpawnEnv } from "../scripts/gate";

import {
  BUDGET_ARTIFACT_PATH,
  PINNED_MAXIMA,
  computeArtifactSelfHash,
  evaluateDurationBudget,
  loadDurationBudgetArtifact,
  resolveSmokeSelection,
  validateDurationBudgetArtifact,
  type DurationBudgetArtifact,
} from "./durationBudget";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** A structurally valid artifact for evaluator fixtures — self-hashed. */
function syntheticArtifact(overrides: Partial<DurationBudgetArtifact> = {}): DurationBudgetArtifact {
  const base: DurationBudgetArtifact = {
    schemaVersion: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    sourceRun: {
      generatedAt: "2026-08-11T00:00:00.000Z",
      mode: "smoke",
      relatedSelection: false,
      skippedGreen: 0,
      suiteCount: 700,
      failedSuites: 0,
      wallMs: 1_800_000, // 30 min
    },
    fullSmokeWallBudgetMs: 2_340_000, // 39 min = 1.3 × 30 min
    perSuiteDefaultCeilingMs: PINNED_MAXIMA.perSuiteDefaultCeilingMs,
    gateLintWallBudgetMs: PINNED_MAXIMA.gateLintWallBudgetMs,
    formula: "fixture",
    updatePath: "fixture",
    selfHash: "",
    ...overrides,
  };
  base.selfHash = computeArtifactSelfHash(base as unknown as Record<string, unknown>);
  return base;
}

async function main(): Promise<void> {
  // ── 1. The committed artifact validates end-to-end. ──
  const loaded = loadDurationBudgetArtifact(BUDGET_ARTIFACT_PATH);
  assert(
    loaded.ok,
    `committed ${BUDGET_ARTIFACT_PATH} validates (schema + self-hash + pins)${loaded.ok ? "" : ` — ${loaded.error}`}`,
  );
  if (loaded.ok) {
    const a = loaded.artifact;
    assert(
      a.fullSmokeWallBudgetMs <= PINNED_MAXIMA.fullSmokeWallBudgetMs,
      `committed wall budget ${(a.fullSmokeWallBudgetMs / 60_000).toFixed(1)}min respects the 40min pin`,
    );
    assert(
      a.sourceRun.skippedGreen === 0 && a.sourceRun.mode === "smoke" && a.sourceRun.relatedSelection === false,
      `committed budget derives from a zero-skip full-smoke measurement (${a.sourceRun.generatedAt}, ${a.sourceRun.suiteCount} suites, wall ${(a.sourceRun.wallMs / 60_000).toFixed(1)}min)`,
    );
  }

  // ── 2. Pins ARE the owner-approved policy values. ──
  assert(
    PINNED_MAXIMA.fullSmokeWallBudgetMs === 40 * 60_000 &&
      PINNED_MAXIMA.perSuiteDefaultCeilingMs === 90_000 &&
      PINNED_MAXIMA.gateLintWallBudgetMs === 240_000,
    "pinned maxima match the Task #4531 owner-approved policy (40min wall / 90s per-suite / 240s lint phase) — changing policy means editing PINNED_MAXIMA under review, not the artifact",
  );

  // ── 3. Tampering (value edit, stale hash) is refused. ──
  {
    const real = syntheticArtifact();
    const tampered = { ...real, fullSmokeWallBudgetMs: real.fullSmokeWallBudgetMs - 60_000 };
    const res = validateDurationBudgetArtifact(JSON.stringify(tampered));
    assert(
      !res.ok && /self-hash/i.test(res.ok ? "" : res.error),
      "editing a budget value without the sole writer fails the self-hash seal",
    );
  }

  // ── 4. A budget above the pin is refused even with a CORRECT self-hash. ──
  {
    const overPin = syntheticArtifact({
      fullSmokeWallBudgetMs: PINNED_MAXIMA.fullSmokeWallBudgetMs + 1,
    });
    const res = validateDurationBudgetArtifact(JSON.stringify(overPin));
    assert(
      !res.ok && /pinned maximum/i.test(res.ok ? "" : res.error),
      "a wall budget above the 40min pin is refused even when correctly self-hashed (forked-writer defense)",
    );
    // Control: a formula-consistent CLAMPED artifact at the pin passes —
    // proving case 4 fails on the pin, not on some schema accident, and
    // that legitimate clamp bookkeeping (clampedFromMs = pre-clamp raw)
    // validates.
    const atPin = syntheticArtifact({
      sourceRun: {
        generatedAt: "2026-08-11T00:00:00.000Z",
        mode: "smoke",
        relatedSelection: false,
        skippedGreen: 0,
        suiteCount: 700,
        failedSuites: 0,
        wallMs: 2_000_000, // ceil(1.3×) = 2,600,000 > 40min pin → clamps
      },
      fullSmokeWallBudgetMs: PINNED_MAXIMA.fullSmokeWallBudgetMs,
      clampedFromMs: 2_600_000,
    });
    assert(
      validateDurationBudgetArtifact(JSON.stringify(atPin)).ok,
      "control: a clamped artifact AT the pin with consistent clampedFromMs validates",
    );
  }

  // ── 4b. Formula binding: recomputing the self-hash is NOT a bypass. The
  // budget must equal min(ceil(1.30 × sourceRun.wallMs), pin) and the clamp
  // bookkeeping must match, so an edited budget is refused even when the
  // artifact is re-hashed through the same public hash function. ──
  {
    // syntheticArtifact() re-hashes after overrides — these all carry VALID
    // self-hashes; only the formula check can catch them.
    const raisedUnderPin = syntheticArtifact({ fullSmokeWallBudgetMs: 2_340_000 + 60_000 });
    const raisedRes = validateDurationBudgetArtifact(JSON.stringify(raisedUnderPin));
    assert(
      !raisedRes.ok && /does not equal min\(ceil/.test(raisedRes.ok ? "" : raisedRes.error),
      "raising the wall budget under the pin with a RECOMPUTED valid self-hash is refused (formula binding)",
    );
    const lowered = syntheticArtifact({ fullSmokeWallBudgetMs: 60_000 });
    const loweredRes = validateDurationBudgetArtifact(JSON.stringify(lowered));
    assert(
      !loweredRes.ok && /does not equal min\(ceil/.test(loweredRes.ok ? "" : loweredRes.error),
      "an arbitrary lowered budget (also rehashed) is refused — the budget is derived, never chosen",
    );
    const phantomClamp = syntheticArtifact({ clampedFromMs: 2_340_000 });
    const phantomRes = validateDurationBudgetArtifact(JSON.stringify(phantomClamp));
    assert(
      !phantomRes.ok && /clamp bookkeeping must match/.test(phantomRes.ok ? "" : phantomRes.error),
      "clampedFromMs present without a real clamp is refused (rehashed)",
    );
    const wrongClampValue = syntheticArtifact({
      sourceRun: {
        generatedAt: "2026-08-11T00:00:00.000Z",
        mode: "smoke",
        relatedSelection: false,
        skippedGreen: 0,
        suiteCount: 700,
        failedSuites: 0,
        wallMs: 2_000_000, // real clamp case: raw 2,600,000 > pin
      },
      fullSmokeWallBudgetMs: PINNED_MAXIMA.fullSmokeWallBudgetMs,
      clampedFromMs: 2_600_001, // off by one — bookkeeping lie
    });
    const wrongClampRes = validateDurationBudgetArtifact(JSON.stringify(wrongClampValue));
    assert(
      !wrongClampRes.ok && /clampedFromMs must record the pre-clamp/.test(wrongClampRes.ok ? "" : wrongClampRes.error),
      "a clamped artifact whose clampedFromMs is not the true pre-clamp raw value is refused (rehashed)",
    );
  }

  // ── 4c. Selection-mode resolution: enforcement keys on the ACTUAL selected
  // universe, never the requested flag. A deferred selector outcome remains
  // bounded and transfers broad work to central integrity; --full-smoke
  // refuses inherited TEST_SMOKE_RELATED. ──
  {
    const deferred = resolveSmokeSelection({ requestedRelated: true, fullSmokeForced: false, manifestMode: "deferred" });
    assert(
      deferred.narrowToRelated && deferred.relatedSelectionForBudget,
      "related request + deferred selector outcome stays bounded (relatedSelection=true)",
    );
    assert(
      deferred.note !== null && /post-merge\/nightly\/weekly/.test(deferred.note ?? ""),
      "deferred selection names central-integrity ownership",
    );
    const narrowed = resolveSmokeSelection({ requestedRelated: true, fullSmokeForced: false, manifestMode: "related" });
    assert(
      narrowed.narrowToRelated && narrowed.relatedSelectionForBudget,
      "genuinely narrowed related run stays warn-mode (owner policy: FAIL full-smoke, WARN otherwise)",
    );
    const forced = resolveSmokeSelection({ requestedRelated: true, fullSmokeForced: true, manifestMode: null });
    assert(
      !forced.narrowToRelated && !forced.relatedSelectionForBudget && forced.note !== null,
      "--full-smoke refuses inherited TEST_SMOKE_RELATED: no narrowing, enforcement on, override logged",
    );
    const plain = resolveSmokeSelection({ requestedRelated: false, fullSmokeForced: false, manifestMode: null });
    assert(
      !plain.narrowToRelated && !plain.relatedSelectionForBudget && plain.note === null,
      "plain full smoke resolves silently to enforced-full",
    );
    // Wiring pin (integration-level): run-all.ts must consume the resolver
    // for BOTH the narrowing decision and the budget/report inputs — the
    // regression this guards is requested-flag enforcement, which can turn
    // an explicit full-smoke request into an accidentally narrowed run.
    const runAllSrc = readFileSync("tests/run-all.ts", "utf8");
    assert(
      runAllSrc.includes("resolveSmokeSelection("),
      "run-all.ts resolves selection through resolveSmokeSelection",
    );
    assert(
      /relatedSelection:\s*smokeSelection\.relatedSelectionForBudget/.test(runAllSrc) &&
        !/relatedSelection:\s*relatedSmoke\b/.test(runAllSrc),
      "run-all.ts feeds the RESOLVED mode (never the requested flag) to the duration report + budget evaluator",
    );
    assert(
      runAllSrc.includes("narrowToRelated"),
      "run-all.ts narrows the selected set only when the resolver says the selection actually applied",
    );
  }

  // ── 4d. Gate-to-runner integration: the full-smoke gate spawn REFUSES
  // inherited TEST_SMOKE_RELATED (stripped from the composed child env, not
  // merely left unset) and forces the runner's full-smoke mode via npm argv
  // pass-through. Exercises the REAL exported seam from scripts/gate.ts. ──
  {
    const full = buildSmokeGateCheck(true);
    assert(
      full.args.join(" ") === "test -- --full-smoke",
      "full-smoke gate spawns `npm test -- --full-smoke` (argv pass-through to run-all)",
    );
    const fullEnv = composeSpawnEnv(full, { TEST_SMOKE_RELATED: "1", PATH: "/bin" });
    assert(
      !("TEST_SMOKE_RELATED" in fullEnv),
      "inherited TEST_SMOKE_RELATED is STRIPPED from the full-smoke child env (overlay alone cannot remove it)",
    );
    assert(
      fullEnv.TEST_SMOKE === "1" && fullEnv.PATH === "/bin",
      "smoke-mode env vars and unrelated parent env survive the strip",
    );
    const related = buildSmokeGateCheck(false);
    assert(related.args.join(" ") === "test", "related-default gate spawns plain `npm test`");
    const relatedEnv = composeSpawnEnv(related, {});
    assert(relatedEnv.TEST_SMOKE_RELATED === "1", "related default sets TEST_SMOKE_RELATED=1 for the child");
    // Wiring pins: the gate must actually USE this seam for its spawn.
    const gateSrc = readFileSync("scripts/gate.ts", "utf8");
    assert(
      /const SMOKE_GATE: SpawnCheck = buildSmokeGateCheck\(FULL_SMOKE\);/.test(gateSrc),
      "gate.ts builds SMOKE_GATE via buildSmokeGateCheck(FULL_SMOKE)",
    );
    assert(
      /const env = composeSpawnEnv\(check, process\.env\);/.test(gateSrc),
      "runSpawnCheck composes the child env via composeSpawnEnv (unsetEnv honored)",
    );
  }

  // ── 5. Source-run invariants are enforced (green-skipped source refused). ──
  {
    const skipped = syntheticArtifact({
      sourceRun: {
        generatedAt: "2026-08-11T00:00:00.000Z",
        mode: "smoke",
        relatedSelection: false,
        skippedGreen: 90,
        suiteCount: 700,
        failedSuites: 0,
        wallMs: 1_800_000,
      },
    });
    const res = validateDurationBudgetArtifact(JSON.stringify(skipped));
    assert(
      !res.ok && /zero-skip/i.test(res.ok ? "" : res.error),
      "an artifact derived from a green-skipped run is refused (budgets from partial walls would be fictions)",
    );
  }

  const artifact = syntheticArtifact();
  const baseSuite = { outcome: "passed" as const, attempts: 1, timeoutMsOverride: null };

  // ── 6. Default ceiling: FAIL on full smoke, WARN on related. ──
  {
    const suites = [{ ...baseSuite, file: "tests/slow.test.ts", elapsedMs: 100_000 }];
    const full = evaluateDurationBudget({ artifact, suites, wallMs: 600_000, mode: "smoke", relatedSelection: false });
    assert(
      full.failRun && full.perSuiteHits.length === 1 && full.perSuiteHits[0].ceilingSource === "default",
      "a passing suite at 100s/attempt (no override) violates the 90s default ceiling and FAILS a full-smoke run",
    );
    const related = evaluateDurationBudget({ artifact, suites, wallMs: 600_000, mode: "smoke", relatedSelection: true });
    assert(
      !related.failRun && related.perSuiteHits.length === 1 && !related.enforced,
      "the same suite on a related gate run is a WARNING, never a block (approved: flake-noise must not block narrowed runs)",
    );
    assert(
      related.lines.some((l) => /warn-only/.test(l)),
      "the related-run block says it is warn-only (honest reporting)",
    );
  }

  // ── 7. Registered timeoutMs override IS the ceiling (sanctioned slow lane). ──
  {
    const under = evaluateDurationBudget({
      artifact,
      suites: [{ ...baseSuite, file: "tests/lint-react-hooks.test.ts", elapsedMs: 250_000, timeoutMsOverride: 300_000 }],
      wallMs: 600_000,
      mode: "smoke",
      relatedSelection: false,
    });
    assert(
      !under.failRun && under.perSuiteHits.length === 0,
      "a suite with a registered timeoutMs override (300s) may run 250s — the registration is the recorded decision",
    );
    const over = evaluateDurationBudget({
      artifact,
      suites: [{ ...baseSuite, file: "tests/lint-react-hooks.test.ts", elapsedMs: 350_000, timeoutMsOverride: 300_000 }],
      wallMs: 600_000,
      mode: "smoke",
      relatedSelection: false,
    });
    assert(
      over.failRun &&
        over.perSuiteHits.length === 1 &&
        over.perSuiteHits[0].ceilingSource === "registration-timeoutMs",
      "exceeding even the registered override (350s > 300s) is a violation attributed to the override ceiling",
    );
  }

  // ── 8. Failed suites are never ceiling-judged. ──
  {
    const res = evaluateDurationBudget({
      artifact,
      suites: [{ file: "tests/red.test.ts", outcome: "failed", attempts: 1, elapsedMs: 400_000, timeoutMsOverride: null }],
      wallMs: 600_000,
      mode: "smoke",
      relatedSelection: false,
    });
    assert(
      res.perSuiteHits.length === 0 && !res.failRun,
      "a FAILED suite over the ceiling produces no budget hit — the failure itself already blocks (no double-reporting)",
    );
  }

  // ── 9. Per-attempt division: a retried-then-passed suite is judged per attempt. ──
  {
    const res = evaluateDurationBudget({
      artifact,
      suites: [{ ...baseSuite, file: "tests/flaky.test.ts", elapsedMs: 160_000, attempts: 2 }],
      wallMs: 600_000,
      mode: "smoke",
      relatedSelection: false,
    });
    assert(
      res.perSuiteHits.length === 0 && !res.failRun,
      "2 attempts × 80s (160s total) passes the 90s ceiling — the ceiling judges the suite's cost, not the retry policy",
    );
  }

  // ── 10. Wall budget: alert-only (Task #5030), measured full-smoke only. ──
  {
    const suites = [{ ...baseSuite, file: "tests/fine.test.ts", elapsedMs: 1_000 }];
    const over = evaluateDurationBudget({
      artifact,
      suites,
      wallMs: artifact.fullSmokeWallBudgetMs + 1,
      mode: "smoke",
      relatedSelection: false,
    });
    assert(
      over.wallHit !== null && !over.failRun,
      "a full-smoke wall past the budget raises the alert signal but NEVER fails the run (Task #5030 — green stays green)",
    );
    assert(
      over.lines.some((l) => /ALERT \(non-blocking\)/.test(l)),
      "the wall-breach line is an explicit non-blocking ALERT (loud, honest, verdict-neutral)",
    );
    const deferredRun = evaluateDurationBudget({
      artifact,
      suites,
      wallMs: artifact.fullSmokeWallBudgetMs + 1,
      mode: "smoke",
      relatedSelection: false,
      deferredCount: 3,
    });
    assert(
      deferredRun.wallHit === null && !deferredRun.failRun,
      "a deferral-narrowed run never judges the wall (it did not execute the measured full-smoke quantity)",
    );
    const related = evaluateDurationBudget({
      artifact,
      suites,
      wallMs: artifact.fullSmokeWallBudgetMs + 1,
      mode: "smoke",
      relatedSelection: true,
    });
    assert(
      related.wallHit === null && !related.failRun,
      "the wall budget never judges related runs (their wall is a narrowed subset, not the measured quantity)",
    );
  }

  // ── 11. Non-smoke modes never block on the budget. ──
  {
    const res = evaluateDurationBudget({
      artifact,
      suites: [{ ...baseSuite, file: "tests/slow.test.ts", elapsedMs: 500_000 }],
      wallMs: artifact.fullSmokeWallBudgetMs * 2,
      mode: "regression",
      relatedSelection: false,
    });
    assert(
      !res.failRun && !res.enforced && res.perSuiteHits.length === 1,
      "regression/all sweeps report budget hits as warnings only (nightly owns its own alerting)",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("gate-duration-budget test crashed:", err);
  process.exit(1);
});
