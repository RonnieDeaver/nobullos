/* test-registration
{
  "name": "Task #5028 — auto-quarantine state machine: transitions, reinstatement, cap, kill switch, seal, single-writer pin (Task #5028)",
  "regression": true,
  "smoke": true,
  "smokeReason": "DB-free pure-function suite over the auto-quarantine ledger. Guards entry/reinstatement thresholds, cap deny, kill switch, seal tamper-detection, and the single-writer contract so a policy defect cannot silently start quarantining the wrong suites or skip enforcement.",
  "tier": "small",
  "scanPaths": ["tests/run-all.ts"]
}
test-registration */
/**
 * Task #5028 — Auto-quarantine state-machine guard.
 *
 * Covers:
 *   1. loadQuarantineLedger — missing → empty (no throw), tampered seal →
 *      empty + note, corrupt JSON → empty (no throw), valid → entries
 *   2. computeQuarantineTransitions — entry on flaky, reinstatement on ≥10
 *      consecutive greens with ≥3 from sweep lanes, deny when cap is full,
 *      deterministic-red suites NOT entered, deleted suites delist
 *   3. Kill switch — FLAKE_QUARANTINE=0 forces empty ledger on load
 *   4. saveQuarantineLedger — written seal is re-verifiable on load; tamper
 *      post-write is detected
 *   5. Single-writer pin: source-scan of run-all.ts confirms saveQuarantineLedger
 *      is only inside a TEST_GREEN_BASELINE_PUBLISH === "1" block
 *   6. buildQuarantineFeedbackText — smoke: text is non-empty and contains
 *      the suite file path
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  QUARANTINE_CAP,
  QUARANTINE_KILL_SWITCH_ENV,
  QUARANTINE_REINSTATE_GREENS,
  QUARANTINE_REINSTATE_SWEEP_GREENS,
  buildQuarantineFeedbackText,
  computeQuarantineTransitions,
  isAutoQuarantined,
  loadQuarantineLedger,
  saveQuarantineLedger,
  type QuarantineEntry,
  type QuarantineLedger,
} from "./flakeQuarantine";
import { appendRunToHistory } from "./flakeHistory";
import type { SuiteHistoryFile, SuiteRunRecord } from "./flakeHistory";

// ---------------------------------------------------------------------------
// Test harness (same pattern as flake-history-recovered-burst.test.ts)
// ---------------------------------------------------------------------------

let failures = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fq-test-"));
  return join(dir, "flake-quarantine.json");
}

function makeRecord(
  outcome: "passed" | "failed",
  i: number,
  sweepLane = false,
): SuiteRunRecord {
  return {
    at: new Date(Date.now() - (100 - i) * 3_600_000).toISOString(),
    outcome,
    ms: 1_000,
    mode: sweepLane ? "regression" : "smoke",
    sweepLane,
  };
}

function makeSuiteHistory(
  ...suites: Array<{
    file: string;
    outcomes: Array<{ outcome: "passed" | "failed"; sweepLane?: boolean }>;
  }>
): SuiteHistoryFile {
  const suitesMap: SuiteHistoryFile["suites"] = {};
  for (const { file, outcomes } of suites) {
    suitesMap[file] = outcomes.map((o, i) =>
      makeRecord(o.outcome, i, o.sweepLane ?? false),
    );
  }
  return { suites: suitesMap } as SuiteHistoryFile;
}

function makeEmptyLedger(): QuarantineLedger {
  return { entries: [], publishedAt: new Date(0).toISOString() };
}

function registeredSet(...files: string[]): Set<string> {
  return new Set(files);
}

// ---------------------------------------------------------------------------
// 1. loadQuarantineLedger
// ---------------------------------------------------------------------------

console.log("\n── 1. loadQuarantineLedger ──");

{
  // Missing file → empty ledger, no throw.
  const path = join(tmpdir(), `nonexistent-${Date.now()}.json`);
  const { ledger, note } = loadQuarantineLedger(path);
  check("missing file → empty ledger", ledger.entries.length === 0);
  // No error note expected for a simply-absent file.
}

{
  // Tampered seal → empty ledger + note.
  const path = makeTmpPath();
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      entries: [],
      publishedAt: "2026-01-01T00:00:00.000Z",
      seal: "badhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    }),
    "utf8",
  );
  const { ledger, note } = loadQuarantineLedger(path);
  check("tampered seal → empty ledger", ledger.entries.length === 0);
  check("tampered seal → note includes 'seal' or 'tamper'", typeof note === "string" && (note.toLowerCase().includes("seal") || note.toLowerCase().includes("tamper")));
}

{
  // Corrupt JSON → empty ledger, no throw.
  const path = makeTmpPath();
  writeFileSync(path, "{ NOT_VALID_JSON !!!!! ", "utf8");
  const { ledger, note } = loadQuarantineLedger(path);
  check("corrupt JSON → empty ledger", ledger.entries.length === 0);
}

{
  // Valid sealed ledger with one entry round-trips.
  const path = makeTmpPath();
  const inputLedger: QuarantineLedger = {
    entries: [
      {
        file: "tests/was-flaky.test.ts",
        enteredAt: "2026-08-01T00:00:00.000Z",
        reason: "flaky",
        evidence: { failures: 3, window: 10, lastFailureAt: "2026-08-01T00:00:00.000Z" },
      },
    ],
    publishedAt: "2026-08-01T00:00:00.000Z",
  };
  saveQuarantineLedger(path, inputLedger);
  const { ledger, note } = loadQuarantineLedger(path);
  check("valid ledger round-trips entry count", ledger.entries.length === 1);
  check("valid ledger round-trips file path", ledger.entries[0]?.file === "tests/was-flaky.test.ts");
  check("valid ledger → no note", note == null);
}

// ---------------------------------------------------------------------------
// 2. computeQuarantineTransitions — entry
// ---------------------------------------------------------------------------

console.log("\n── 2a. computeQuarantineTransitions — entry ──");

{
  // ≥2 intermittent failures of last 10 runs (alternating) → entry.
  const history = makeSuiteHistory({
    file: "tests/flaky.test.ts",
    outcomes: [
      { outcome: "failed" },
      { outcome: "passed" },
      { outcome: "failed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
    ],
  });
  const result = computeQuarantineTransitions(history, makeEmptyLedger(), {
    registeredFiles: registeredSet("tests/flaky.test.ts"),
  });
  check(
    "intermittent suite enters quarantine",
    result.entered.some((e) => e.file === "tests/flaky.test.ts"),
  );
  check(
    "entered suite appears in new ledger",
    result.newLedger.entries.some((e) => e.file === "tests/flaky.test.ts"),
  );
}

{
  // Deterministically red (all failures) → NOT quarantinable.
  const history = makeSuiteHistory({
    file: "tests/always-red.test.ts",
    outcomes: Array.from({ length: 10 }, () => ({ outcome: "failed" as const })),
  });
  const result = computeQuarantineTransitions(history, makeEmptyLedger(), {
    registeredFiles: registeredSet("tests/always-red.test.ts"),
  });
  check(
    "always-red suite is NOT entered",
    !result.entered.some((e) => e.file === "tests/always-red.test.ts"),
  );
  check(
    "always-red suite is NOT in new ledger",
    !result.newLedger.entries.some((e) => e.file === "tests/always-red.test.ts"),
  );
}

{
  // Fully green → no entry.
  const history = makeSuiteHistory({
    file: "tests/stable.test.ts",
    outcomes: Array.from({ length: 10 }, () => ({ outcome: "passed" as const })),
  });
  const result = computeQuarantineTransitions(history, makeEmptyLedger(), {
    registeredFiles: registeredSet("tests/stable.test.ts"),
  });
  check("stable suite is NOT entered", !result.entered.some((e) => e.file === "tests/stable.test.ts"));
}

// ---------------------------------------------------------------------------
// 2b. computeQuarantineTransitions — reinstatement
// ---------------------------------------------------------------------------

console.log("\n── 2b. computeQuarantineTransitions — reinstatement ──");

{
  // 10 consecutive greens, 3 from sweep lanes → reinstate.
  const history = makeSuiteHistory({
    file: "tests/was-flaky.test.ts",
    outcomes: [
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
    ],
  });
  const quarantinedLedger: QuarantineLedger = {
    entries: [
      {
        file: "tests/was-flaky.test.ts",
        enteredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        reason: "flaky",
      },
    ],
    publishedAt: new Date().toISOString(),
  };
  const result = computeQuarantineTransitions(history, quarantinedLedger, {
    registeredFiles: registeredSet("tests/was-flaky.test.ts"),
  });
  check(
    `${QUARANTINE_REINSTATE_GREENS} greens / ${QUARANTINE_REINSTATE_SWEEP_GREENS} sweep-lane → reinstated`,
    result.reinstated.some((e) => e.file === "tests/was-flaky.test.ts"),
  );
  check(
    "reinstated suite removed from new ledger",
    !result.newLedger.entries.some((e) => e.file === "tests/was-flaky.test.ts"),
  );
}

{
  // Only 2 sweep-lane greens (need ≥3) → NOT reinstated.
  const history = makeSuiteHistory({
    file: "tests/still-questionable.test.ts",
    outcomes: [
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
    ],
  });
  const quarantinedLedger: QuarantineLedger = {
    entries: [
      {
        file: "tests/still-questionable.test.ts",
        enteredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        reason: "flaky",
      },
    ],
    publishedAt: new Date().toISOString(),
  };
  const result = computeQuarantineTransitions(history, quarantinedLedger, {
    registeredFiles: registeredSet("tests/still-questionable.test.ts"),
  });
  check(
    "insufficient sweep-lane greens → NOT reinstated",
    !result.reinstated.some((e) => e.file === "tests/still-questionable.test.ts"),
  );
  check(
    "still in ledger when not reinstated",
    result.newLedger.entries.some((e) => e.file === "tests/still-questionable.test.ts"),
  );
}

{
  // Only 9 consecutive greens (need ≥10) → NOT reinstated.
  const history = makeSuiteHistory({
    file: "tests/almost-stable.test.ts",
    outcomes: [
      { outcome: "failed", sweepLane: true },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: true },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
      { outcome: "passed", sweepLane: false },
    ],
  });
  const quarantinedLedger: QuarantineLedger = {
    entries: [
      {
        file: "tests/almost-stable.test.ts",
        enteredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        reason: "flaky",
      },
    ],
    publishedAt: new Date().toISOString(),
  };
  const result = computeQuarantineTransitions(history, quarantinedLedger, {
    registeredFiles: registeredSet("tests/almost-stable.test.ts"),
  });
  check(
    "9 consecutive greens (not 10) → NOT reinstated",
    !result.reinstated.some((e) => e.file === "tests/almost-stable.test.ts"),
  );
}

// ---------------------------------------------------------------------------
// 2c. computeQuarantineTransitions — cap deny
// ---------------------------------------------------------------------------

console.log("\n── 2c. computeQuarantineTransitions — cap deny ──");

{
  const existingFiles = Array.from({ length: QUARANTINE_CAP }, (_, i) => `tests/existing-${i}.test.ts`);
  const fullLedger: QuarantineLedger = {
    entries: existingFiles.map((file) => ({
      file,
      enteredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      reason: "flaky",
    })),
    publishedAt: new Date().toISOString(),
  };
  const history = makeSuiteHistory(
    {
      file: "tests/new-flaky.test.ts",
      outcomes: [
        { outcome: "failed" },
        { outcome: "passed" },
        { outcome: "failed" },
        { outcome: "passed" },
        { outcome: "passed" },
        { outcome: "passed" },
        { outcome: "passed" },
        { outcome: "passed" },
        { outcome: "passed" },
        { outcome: "passed" },
      ],
    },
    ...existingFiles.map((file) => ({
      file,
      outcomes: [{ outcome: "passed" as const }],
    })),
  );
  const registered = new Set(["tests/new-flaky.test.ts", ...existingFiles]);
  const result = computeQuarantineTransitions(history, fullLedger, {
    registeredFiles: registered,
  });
  check(
    `cap at ${QUARANTINE_CAP}: new flaky suite denied entry`,
    result.capDenied.some((d) => d.file === "tests/new-flaky.test.ts"),
  );
  check("denied suite not in entered", !result.entered.some((e) => e.file === "tests/new-flaky.test.ts"));
  check(
    "denied suite not in new ledger",
    !result.newLedger.entries.some((e) => e.file === "tests/new-flaky.test.ts"),
  );
  check(
    "cap-full ledger stays at QUARANTINE_CAP",
    result.newLedger.entries.length === QUARANTINE_CAP,
  );
}

// ---------------------------------------------------------------------------
// 2d. computeQuarantineTransitions — deleted suites delist
// ---------------------------------------------------------------------------

console.log("\n── 2d. computeQuarantineTransitions — deleted suites delist ──");

{
  const quarantinedLedger: QuarantineLedger = {
    entries: [
      {
        file: "tests/deleted-suite.test.ts",
        enteredAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
        reason: "flaky",
      },
    ],
    publishedAt: new Date().toISOString(),
  };
  // deleted-suite.test.ts is NOT in registeredFiles.
  const emptyHistory: SuiteHistoryFile = { suites: {} } as SuiteHistoryFile;
  const result = computeQuarantineTransitions(emptyHistory, quarantinedLedger, {
    registeredFiles: registeredSet("tests/other.test.ts"),
  });
  check(
    "deleted suite is delisted from ledger",
    !result.newLedger.entries.some((e) => e.file === "tests/deleted-suite.test.ts"),
  );
}

// ---------------------------------------------------------------------------
// 3. Kill switch
// ---------------------------------------------------------------------------

console.log("\n── 3. Kill switch ──");

{
  const path = makeTmpPath();
  // Write a valid ledger with one entry.
  const withEntry: QuarantineLedger = {
    entries: [{ file: "tests/quarantined.test.ts", enteredAt: new Date().toISOString(), reason: "flaky" }],
    publishedAt: new Date().toISOString(),
  };
  saveQuarantineLedger(path, withEntry);

  const prev = process.env[QUARANTINE_KILL_SWITCH_ENV];
  try {
    process.env[QUARANTINE_KILL_SWITCH_ENV] = "0";
    const fakeEnv = { [QUARANTINE_KILL_SWITCH_ENV]: "0" };
    const { ledger, note } = loadQuarantineLedger(path, fakeEnv);
    check("kill switch → empty ledger", ledger.entries.length === 0);
    check(
      "kill switch → note mentions 'kill switch' or 'disabled'",
      typeof note === "string" &&
        (note.toLowerCase().includes("kill switch") || note.toLowerCase().includes("disabled")),
    );
    // The usage pattern in run-all.ts: autoQuarantinedFiles built from loaded ledger.
    check(
      "kill switch → isAutoQuarantined returns false for loaded empty ledger",
      !isAutoQuarantined("tests/quarantined.test.ts", ledger),
    );
  } finally {
    if (prev === undefined) delete process.env[QUARANTINE_KILL_SWITCH_ENV];
    else process.env[QUARANTINE_KILL_SWITCH_ENV] = prev;
  }
}

{
  // Without kill switch: entry in ledger is detected.
  const ledger: QuarantineLedger = {
    entries: [{ file: "tests/quarantined.test.ts", enteredAt: new Date().toISOString(), reason: "flaky" }],
    publishedAt: new Date().toISOString(),
  };
  check("no kill switch → quarantined file detected", isAutoQuarantined("tests/quarantined.test.ts", ledger));
  check("no kill switch → non-quarantined file returns false", !isAutoQuarantined("tests/other.test.ts", ledger));
}

// ---------------------------------------------------------------------------
// 4. saveQuarantineLedger seal round-trip
// ---------------------------------------------------------------------------

console.log("\n── 4. saveQuarantineLedger seal round-trip ──");

{
  const path = makeTmpPath();
  const { saved, note } = saveQuarantineLedger(path, makeEmptyLedger());
  check("saveQuarantineLedger returns saved:true", saved === true);
  check("no error note on successful save", note == null);

  const raw = JSON.parse(readFileSync(path, "utf8")) as { seal?: unknown }; // fs-scan-inputs-ignore -- path comes only from makeTmpPath()'s mkdtempSync(tmpdir()) ledger artifact
  check("written file has a seal field", typeof raw.seal === "string" && (raw.seal as string).length > 30);

  const { ledger: loaded, note: loadNote } = loadQuarantineLedger(path);
  check("seal round-trips loadably", loaded.entries.length === 0 && loadNote == null);
}

{
  // Tamper post-write: adding an entry after sealing is detected on load.
  const path = makeTmpPath();
  saveQuarantineLedger(path, makeEmptyLedger());
  const tampered = JSON.parse(readFileSync(path, "utf8")) as QuarantineLedger & { seal: string }; // fs-scan-inputs-ignore -- path comes only from makeTmpPath()'s mkdtempSync(tmpdir()) ledger artifact
  (tampered.entries as QuarantineEntry[]).push({
    file: "tests/injected.test.ts",
    enteredAt: new Date().toISOString(),
    reason: "injected after sealing",
  });
  writeFileSync(path, JSON.stringify(tampered), "utf8");

  const { ledger, note } = loadQuarantineLedger(path);
  check("tamper post-write → seal mismatch detected", ledger.entries.length === 0);
  check(
    "tamper post-write → note mentions seal/tamper",
    typeof note === "string" && (note.toLowerCase().includes("seal") || note.toLowerCase().includes("tamper")),
  );
}

// ---------------------------------------------------------------------------
// 2e. Decisive current-run outcome drives transitions (ordering fix)
// ---------------------------------------------------------------------------

console.log("\n── 2e. Decisive current-run outcome drives transitions ──");

{
  // Scenario: prior disk history has exactly 1 intermittent failure in the
  // last 9 recorded runs — not enough to enter (need ≥2 of last 10). The
  // decisive second failure happens on THIS run. If computeQuarantineTransitions
  // is called with the pre-tonight history it should NOT enter; with the
  // history including tonight it SHOULD enter.
  const priorHistory = makeSuiteHistory({
    file: "tests/decisive.test.ts",
    outcomes: [
      { outcome: "failed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
      { outcome: "passed" },
    ], // 9 records: 1 fail, 8 passes — not yet at entry threshold
  });

  // Simulate tonight's second failure being appended in memory (as run-all.ts
  // now does before calling computeQuarantineTransitions).
  const tonightResult = {
    file: "tests/decisive.test.ts",
    name: "decisive suite",
    outcome: "failed" as const,
    ms: 1_000,
    failureReason: "exit 1",
    quarantined: false,
  };
  const updatedHistory = appendRunToHistory(priorHistory, [tonightResult], {
    at: new Date().toISOString(),
    mode: "smoke",
  });

  // Pre-tonight: 1 of 9 — below entry threshold (need ≥2 of last 10) → no entry.
  const prePre = computeQuarantineTransitions(priorHistory, makeEmptyLedger(), {
    registeredFiles: registeredSet("tests/decisive.test.ts"),
  });
  check(
    "pre-tonight history (1 of 9 fails) → suite NOT entered",
    !prePre.entered.some((e) => e.file === "tests/decisive.test.ts"),
  );

  // Post-tonight: 2 of 10 — meets entry threshold → entered.
  const postPost = computeQuarantineTransitions(updatedHistory, makeEmptyLedger(), {
    registeredFiles: registeredSet("tests/decisive.test.ts"),
  });
  check(
    "post-tonight history (2 of 10 fails) → suite ENTERED",
    postPost.entered.some((e) => e.file === "tests/decisive.test.ts"),
  );
}

// ---------------------------------------------------------------------------
// 5. Single-writer pin + kill-switch gates quarantine publish
// ---------------------------------------------------------------------------

console.log("\n── 5. Single-writer pin + kill-switch gates quarantine publish ──");

{
  const src = readFileSync(resolve(process.cwd(), "tests/run-all.ts"), "utf8");
  const callPattern = /saveQuarantineLedger\s*\(/g;
  let match: RegExpExecArray | null;
  const callPositions: number[] = [];
  while ((match = callPattern.exec(src)) !== null) {
    callPositions.push(match.index);
  }

  check("saveQuarantineLedger has at least one call site in run-all.ts", callPositions.length > 0);

  // Every call site must be textually inside a TEST_GREEN_BASELINE_PUBLISH === "1" guard.
  // We check this by finding the nearest preceding guard within 3000 chars (one block).
  let allGuarded = true;
  for (const pos of callPositions) {
    const preceding = src.slice(0, pos);
    const lastGuardIdx = preceding.lastIndexOf('TEST_GREEN_BASELINE_PUBLISH === "1"');
    if (lastGuardIdx < 0 || pos - lastGuardIdx > 3000) {
      allGuarded = false;
      console.error(`  ✗ call site at offset ${pos} is outside a TEST_GREEN_BASELINE_PUBLISH guard`);
    }
  }
  check("all saveQuarantineLedger call sites are inside TEST_GREEN_BASELINE_PUBLISH guard", allGuarded);

  // Kill-switch guard: the quarantine publish block must check QUARANTINE_KILL_SWITCH_ENV.
  // This prevents accumulating quarantine entries while the switch is off and then
  // activating them unexpectedly on re-enable.
  check(
    "quarantine publish block in run-all.ts checks the kill switch",
    src.includes(QUARANTINE_KILL_SWITCH_ENV),
  );

  // The kill switch check must appear BEFORE saveQuarantineLedger, not after.
  const killSwitchIdx = src.indexOf(QUARANTINE_KILL_SWITCH_ENV);
  const firstSaveIdx = callPositions[0] ?? src.length;
  check("kill-switch reference precedes saveQuarantineLedger in run-all.ts", killSwitchIdx < firstSaveIdx);
  check(
    "non-blocking quarantine verdict tells executors to address the established recurring-failure item",
    src.includes("next action: address the established recurring-failure item"),
  );
}

// ---------------------------------------------------------------------------
// 6. buildQuarantineFeedbackText
// ---------------------------------------------------------------------------

console.log("\n── 6. buildQuarantineFeedbackText ──");

{
  const entry: QuarantineEntry = {
    file: "tests/some-flaky.test.ts",
    enteredAt: "2026-08-18T00:00:00.000Z",
    reason: "≥2 intermittent failures of last 10 runs",
    evidence: { failures: 3, window: 10, lastFailureAt: "2026-08-18T00:00:00.000Z" },
  };
  const text = buildQuarantineFeedbackText(entry);
  check("buildQuarantineFeedbackText returns non-empty string", typeof text === "string" && text.length > 20);
  check("feedback text contains the suite file path", text.includes("tests/some-flaky.test.ts"));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
