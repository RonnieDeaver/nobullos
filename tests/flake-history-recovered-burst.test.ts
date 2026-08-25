/* test-registration
{
  "name": "Flake-history recovered-burst classification (Task #4187)",
  "regression": true,
  "smoke": true,
  "smokeReason": "DB-free pure-function suite over synthetic history records; guards the repeat-offender report's flaky-vs-recovered classification so already-fixed deterministic bursts stop training people to ignore the report.",
  "tier": "small"
}
test-registration */
/**
 * Task #4187 — the end-of-run repeat-offender report used to flag a suite
 * whose recent failures were one contiguous deterministic burst (fixed by a
 * single commit, green ever since) as a chronic flake for many subsequent
 * runs (motivating case: audits/marketing-mobile-baseline-flake-disposition-
 * 2026-08-09.md). findRepeatOffenders now classifies each offender:
 *   - "recovered": one contiguous failure block + ≥RECOVERY_GREENS trailing
 *     passes → reported quietly under a separate informational header.
 *   - "flaky": anything else (alternation, still-red tails) → loud, unchanged.
 */
import {
  classifyRecentFailureHistory,
  findRepeatOffenders,
  formatRepeatOffenders,
  RECOVERY_GREENS,
  type SuiteHistoryFile,
  type SuiteRunRecord,
} from "./flakeHistory";
import { classifyFailure } from "./redManifest";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function rec(outcome: "passed" | "failed", i: number): SuiteRunRecord {
  return {
    at: `2026-08-0${1 + Math.floor(i / 10)}T0${i % 10}:00:00.000Z`,
    outcome,
    ms: 20,
    mode: "smoke",
    ...(outcome === "failed" ? { reason: "exit code 1" } : {}),
  };
}

/** Build a history with one suite whose outcomes follow `pattern` (P/F). */
function historyOf(pattern: string, file = "tests/synthetic.test.ts"): SuiteHistoryFile {
  const records = [...pattern].map((c, i) => rec(c === "F" ? "failed" : "passed", i));
  return { schemaVersion: 1, updatedAt: records[records.length - 1].at, suites: { [file]: records } };
}

function classify(pattern: string): string {
  const offenders = findRepeatOffenders(historyOf(pattern));
  return offenders.length === 0 ? "none" : offenders[0].kind;
}

console.log("Task #4187 — recovered-burst classification over synthetic histories");

// The motivating shape: contiguous 7-failure burst, then 3 greens (last-10
// window: F F F F F F F P P P) — recovered, not flaky.
check("contiguous burst + 3 trailing greens → recovered", classify("FFFFFFFPPP") === "recovered");

// Burst head aged out of the window: window starts mid-burst. Still one
// contiguous block within the window → recovered.
check("burst starting at window head → recovered", classify("FFPPPPPPPP") === "recovered");

// Genuine alternation stays loud.
check("alternating pass/fail → flaky", classify("PFPFPFPFPP") === "flaky");
check("two separated failures → flaky", classify("PFPPPPFPPP") === "flaky");

// Contiguous burst but not enough trailing greens yet (only 2 < RECOVERY_GREENS).
check(
  `contiguous burst with only ${RECOVERY_GREENS - 1} trailing greens → still flaky`,
  classify("PPPPPFFFPP") === "flaky",
);

// Still red at the tail — the burst has not ended.
check("burst ending the window (still red) → flaky", classify("PPPPPPPFFF") === "flaky");

// Exactly RECOVERY_GREENS trailing greens is the boundary — recovered.
check(
  `contiguous burst with exactly ${RECOVERY_GREENS} trailing greens → recovered`,
  classify("PPPPFFFPPP") === "recovered",
);

// Below the offender threshold: a single failure never surfaces at all.
check("single failure → not an offender", classify("PPPPFPPPPP") === "none");
check("all green → not an offender", classify("PPPPPPPPPP") === "none");

// Formatting: recovered suites go under the informational header, never the
// loud one; flaky suites keep the original loud header.
{
  const history: SuiteHistoryFile = {
    schemaVersion: 1,
    updatedAt: "2026-08-09T00:00:00.000Z",
    suites: {
      "tests/recovered-burst.test.ts": [...`FFFFFFFPPP`].map((c, i) => rec(c === "F" ? "failed" : "passed", i)),
      "tests/genuine-flake.test.ts": [...`PFPFPFPFPP`].map((c, i) => rec(c === "F" ? "failed" : "passed", i)),
    },
  };
  const lines = formatRepeatOffenders(findRepeatOffenders(history));
  const text = lines.join("\n");
  const loudHeaderIdx = lines.findIndex((l) => l.startsWith("Repeat offenders"));
  const recoveredHeaderIdx = lines.findIndex((l) => l.startsWith("Recovered (deterministic burst"));
  check("loud header present for the genuine flake", loudHeaderIdx >= 0);
  check("recovered header present", recoveredHeaderIdx >= 0);
  check(
    "genuine flake listed under the loud header",
    loudHeaderIdx >= 0 &&
      recoveredHeaderIdx > loudHeaderIdx &&
      lines.slice(loudHeaderIdx, recoveredHeaderIdx).some((l) => l.includes("tests/genuine-flake.test.ts")),
  );
  check(
    "recovered suite listed ONLY under the recovered header",
    recoveredHeaderIdx >= 0 &&
      lines.slice(recoveredHeaderIdx).some((l) => l.includes("tests/recovered-burst.test.ts")) &&
      !lines.slice(0, recoveredHeaderIdx).some((l) => l.includes("tests/recovered-burst.test.ts")),
  );
  check("recovered line is labeled contiguous", text.includes("all contiguous; green since"));
}

// Only-recovered offenders: the loud header must not appear at all.
{
  const lines = formatRepeatOffenders(findRepeatOffenders(historyOf("FFFFFFFPPP")));
  check(
    "recovered-only report omits the loud header",
    lines.length > 0 && !lines.some((l) => l.startsWith("Repeat offenders")),
  );
}

// Empty offender list still renders nothing.
check("no offenders → no lines", formatRepeatOffenders([]).length === 0);

// ── Task #4217 — attribution consumes the burst classification ─────────────

console.log("\nTask #4217 — classifyRecentFailureHistory + attribution evidence");

function recentOf(pattern: string): SuiteRunRecord[] {
  return [...pattern].map((c, i) => rec(c === "F" ? "failed" : "passed", i));
}

// The standalone classifier agrees with the repeat-offender kinds.
check("classifier: all green → none", classifyRecentFailureHistory(recentOf("PPPPPPPPPP")) === "none");
check("classifier: burst + 3 greens → recovered", classifyRecentFailureHistory(recentOf("FFFFFFFPPP")) === "recovered");
check("classifier: alternating → flaky", classifyRecentFailureHistory(recentOf("PFPFPFPFPP")) === "flaky");
check("classifier: still-red tail → flaky", classifyRecentFailureHistory(recentOf("PPPPPPPFFF")) === "flaky");
check(
  "classifier: only last-10 window considered (old scattered fails aged out)",
  classifyRecentFailureHistory(recentOf("FPFPF" + "PPFFFPPPPP")) === "recovered",
);
check("classifier: empty history → none", classifyRecentFailureHistory([]) === "none");

// classifyFailure evidence reflects the classification — and NEVER changes
// the verdict (history is corroborating only; no manifest ⇒ always "yours").
function attributionFor(pattern: string) {
  return classifyFailure({
    file: "tests/synthetic.test.ts",
    failureReason: "exit 1",
    currentFingerprint: null,
    manifest: null,
    priorRecords: recentOf(pattern),
  });
}
{
  const recovered = attributionFor("FFFFFFFPPP");
  const flaky = attributionFor("PFPFPFPFPP");
  check(
    "attribution evidence labels a recovered burst as such",
    recovered.evidence.some((e) => e.includes("recovered deterministic burst") && e.includes("NOT a chronic flake")),
  );
  check(
    "recovered-burst evidence stays corroborating-only",
    recovered.evidence.some((e) => e.includes("recovered deterministic burst") && e.includes("corroborating only, not proof")),
  );
  check(
    "attribution evidence labels intermittent history as such",
    flaky.evidence.some((e) => e.includes("flake-history: intermittent")),
  );
  check(
    "intermittent evidence never claims a recovered burst",
    !flaky.evidence.some((e) => e.includes("recovered deterministic burst")),
  );
  check("recovered burst does not flip the verdict", recovered.verdict === "yours" && recovered.excusable === false);
  check("intermittent history does not flip the verdict", flaky.verdict === "yours" && flaky.excusable === false);
  // Task #4238 — the classification is also exposed as a structured field so
  // consumers of the attribution report never have to string-match evidence.
  check("structured historyKind: recovered burst → \"recovered\"", recovered.historyKind === "recovered");
  check("structured historyKind: intermittent → \"flaky\"", flaky.historyKind === "flaky");
}
{
  const clean = attributionFor("PPPPPPPPPP");
  check(
    "no recorded failures → no flake-history evidence line at all",
    !clean.evidence.some((e) => e.includes("flake-history:")),
  );
  check("structured historyKind: all-green history → \"none\"", clean.historyKind === "none");
}
// Review-driven regression: old scattered failures OUTSIDE the classifier's
// last-10 window must not leak into the evidence — counts, contiguity claim,
// and classification all derive from the same recent window.
{
  const journal = attributionFor("FPFPF" + "PPFFFPPPPP"); // 15 records; last 10 = PPFFFPPPPP
  const line = journal.evidence.find((e) => e.includes("flake-history:")) ?? "";
  check("aged-out scattered fails: still classified recovered", line.includes("recovered deterministic burst"));
  check("aged-out scattered fails: counts come from the window only (3 of 10)", line.includes("3 failed run(s) in the last 10 recorded"));
  check("aged-out scattered fails: journal totals (6/15) never reported", !line.includes("6 ") && !line.includes(" 15 "));
}
{
  const aged = attributionFor("FF" + "PPPPPPPPPP"); // failures fully aged out of the window
  check(
    "failures fully outside the window → no flake-history evidence line",
    !aged.evidence.some((e) => e.includes("flake-history:")),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
