/* test-registration
{
  "name": "Post-merge canary rails (Task #4501)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4501: the post-merge canary and partial-manifest upsert are safety-rail code — a bug could clear reds that weren't re-verified (silent false-excusal) or advance publishedAt (breaking staleness verdicts for all downstream task gates). Fast fixture tests (tmpdir + JSON, no DB, no spawned children, no network). Also tests the blast-radius gate-expansion call site guard.",
  "scanPaths": [
    "scripts/post-merge-canary.ts",
    "scripts/gate.ts",
    "scripts/post-merge.sh",
    "server/services/regressionSweepScheduler.ts",
    "server/services/healthOverview.ts"
  ],
  "tier": "small",
  "tierReason": "Deliberately small, overriding the unmeasured default of medium: these fixture tests use temporary JSON and source reads only, with no database, browser, child process, or network."
}
test-registration */
/**
 * Task #4501 — Guard tests for post-merge canary rails:
 *
 *   1. upsertRedManifestEntries never clears entries the canary did NOT re-verify.
 *   2. upsertRedManifestEntries does NOT advance publishedAt (staleness verdicts).
 *   3. New red entries get a culprit stamp; pre-existing same-breakage entries carry theirs.
 *   4. Re-verified greens are removed from the manifest; unverified reds stay.
 *   5. Wiring pin: upsertRedManifestEntries has exactly one call site
 *      (scripts/post-merge-canary.ts) and the canary exits 0 and never calls
 *      publishRedManifest or references TEST_GREEN_BASELINE_PUBLISH.
 *   6. blast-radius expansion: TEST_GATE_EXPANSION="1" is in the smoke-gate env.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RED_MANIFEST_SCHEMA_VERSION,
  loadRedManifest,
  publishRedManifest,
  upsertRedManifestEntries,
  type RedManifest,
} from "./redManifest";
import { FINGERPRINT_ALGO_VERSION } from "./suiteFingerprint";
import { selectBlastRadiusExpansion } from "./relatedSmokeSelection";

// ---------------------------------------------------------------------------
// Mini test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

const NOW = new Date("2026-08-11T12:00:00Z");
const PUBLISHED_AT = "2026-08-10T03:30:00Z"; // a prior nightly publish timestamp

/** Build a minimal committed manifest (as if the nightly already ran). */
function makeCommittedManifest(
  root: string,
  overrides: Partial<RedManifest> = {},
): string {
  const manifestPath = join(root, "tests", "red-manifest.json");
  mkdirSync(join(root, "tests"), { recursive: true });
  const manifest: RedManifest = {
    schemaVersion: RED_MANIFEST_SCHEMA_VERSION,
    fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
    publishedAt: PUBLISHED_AT,
    commit: "abc1234567",
    entries: {
      "tests/suite-a.test.ts": {
        failureSignature: "exit 1",
        fingerprint: "fp-a",
        firstRedAt: PUBLISHED_AT,
        lastRedAt: PUBLISHED_AT,
      },
      "tests/suite-b.test.ts": {
        failureSignature: "exit 2",
        fingerprint: "fp-b",
        firstRedAt: PUBLISHED_AT,
        lastRedAt: PUBLISHED_AT,
      },
      "tests/suite-unverified.test.ts": {
        failureSignature: "exit 1",
        fingerprint: "fp-u",
        firstRedAt: PUBLISHED_AT,
        lastRedAt: PUBLISHED_AT,
      },
    },
    lints: {},
    ...overrides,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

// ---------------------------------------------------------------------------
// 1. Partial upsert never clears un-verified reds
// ---------------------------------------------------------------------------

test("upsertRedManifestEntries: un-verified red entries are preserved untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-test-"));
  try {
    const manifestPath = makeCommittedManifest(root);
    // Canary ran suite-a and suite-b only; suite-unverified was NOT in the run.
    upsertRedManifestEntries({
      manifestPath,
      newReds: [],                          // nothing newly failed this run
      clearedFiles: ["tests/suite-a.test.ts", "tests/suite-b.test.ts"], // canary verified these passed
      culprit: { commit: "dead1234", task: "9999", mergedAt: NOW.toISOString() },
      now: NOW,
    });

    const result = loadRedManifest(manifestPath);
    assert.equal(result.note, null, `manifest must load cleanly after upsert (note: ${result.note})`);
    assert.ok(result.manifest, "manifest exists after upsert");

    // suite-a and suite-b were re-verified green — they should be cleared.
    assert.ok(
      !result.manifest!.entries["tests/suite-a.test.ts"],
      "suite-a was re-verified passing — it must be cleared from the manifest",
    );
    assert.ok(
      !result.manifest!.entries["tests/suite-b.test.ts"],
      "suite-b was re-verified passing — it must be cleared from the manifest",
    );

    // suite-unverified was NOT in the canary run — it must remain untouched.
    assert.ok(
      result.manifest!.entries["tests/suite-unverified.test.ts"],
      "suite-unverified was NOT re-verified — it must survive the upsert unchanged",
    );
    assert.equal(
      result.manifest!.entries["tests/suite-unverified.test.ts"].failureSignature,
      "exit 1",
      "un-verified entry's failureSignature must be intact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. publishedAt is NOT advanced by a partial upsert
// ---------------------------------------------------------------------------

test("upsertRedManifestEntries: publishedAt is not advanced (staleness verdicts preserved)", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-test-"));
  try {
    const manifestPath = makeCommittedManifest(root);

    upsertRedManifestEntries({
      manifestPath,
      newReds: [
        { file: "tests/suite-new-red.test.ts", failureReason: "exit 1", fingerprint: "fp-new" },
      ],
      clearedFiles: ["tests/suite-a.test.ts"],
      culprit: { commit: "cafebabe", task: "4501", mergedAt: NOW.toISOString() },
      now: NOW,
    });

    const result = loadRedManifest(manifestPath);
    assert.ok(result.manifest, "manifest loads after upsert");

    // publishedAt must stay at the prior nightly stamp.
    assert.equal(
      result.manifest!.publishedAt,
      PUBLISHED_AT,
      "publishedAt must remain at the prior nightly stamp — not the canary run time",
    );

    // lastPartialUpdateAt must be set to the canary run time.
    assert.equal(
      result.manifest!.lastPartialUpdateAt,
      NOW.toISOString(),
      "lastPartialUpdateAt must be set to the canary run time",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. New red entries get a culprit stamp; existing same-breakage entries carry theirs
// ---------------------------------------------------------------------------

test("upsertRedManifestEntries: culprit stamp is attached to new reds but not overwritten on same-breakage incumbents", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-test-"));
  try {
    const priorCulprit = { commit: "prev1234", task: "1000", mergedAt: PUBLISHED_AT };
    const manifestPath = makeCommittedManifest(root, {
      entries: {
        "tests/suite-incumbent.test.ts": {
          failureSignature: "exit 1",
          fingerprint: "fp-i",
          firstRedAt: PUBLISHED_AT,
          lastRedAt: PUBLISHED_AT,
          culprit: priorCulprit,
        },
      },
    });

    const newCulprit = { commit: "cafebabe", task: "4501", mergedAt: NOW.toISOString() };
    upsertRedManifestEntries({
      manifestPath,
      newReds: [
        // A genuinely new red (not in the manifest yet).
        { file: "tests/suite-brand-new.test.ts", failureReason: "exit 1", fingerprint: "fp-new" },
        // The incumbent is re-failing with the SAME signature class — culprit should be carried.
        { file: "tests/suite-incumbent.test.ts", failureReason: "exit 1", fingerprint: "fp-i" },
      ],
      clearedFiles: [],
      culprit: newCulprit,
      now: NOW,
    });

    const result = loadRedManifest(manifestPath);
    assert.ok(result.manifest, "manifest loads");

    // Brand-new red gets the new culprit.
    assert.deepEqual(
      result.manifest!.entries["tests/suite-brand-new.test.ts"]?.culprit,
      newCulprit,
      "brand-new red entry must receive the canary culprit stamp",
    );

    // Incumbent with same breakage carries its PRIOR culprit.
    assert.deepEqual(
      result.manifest!.entries["tests/suite-incumbent.test.ts"]?.culprit,
      priorCulprit,
      "incumbent entry with same signature must carry its prior culprit stamp (not overwritten)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Re-verified greens removed; unverified reds stay
// ---------------------------------------------------------------------------

test("upsertRedManifestEntries: mixed batch — new red added, passing cleared, unverified stays", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-test-"));
  try {
    const manifestPath = makeCommittedManifest(root);

    const result = upsertRedManifestEntries({
      manifestPath,
      newReds: [
        { file: "tests/suite-new.test.ts", failureReason: "exit 2", fingerprint: null },
      ],
      clearedFiles: ["tests/suite-a.test.ts"],
      culprit: { commit: "abc", task: "4501", mergedAt: NOW.toISOString() },
      now: NOW,
    });

    assert.equal(result.upserted, true, "upsert succeeded");
    assert.equal(result.addedReds, 1, "one new red added");
    assert.equal(result.clearedReds, 1, "one green cleared");
    assert.equal(result.note, null, "no error note");

    const loaded = loadRedManifest(manifestPath);
    assert.ok(loaded.manifest, "manifest loads");
    const entries = loaded.manifest!.entries;

    // New red was added.
    assert.ok(entries["tests/suite-new.test.ts"], "new red was added");
    // Cleared green was removed.
    assert.ok(!entries["tests/suite-a.test.ts"], "cleared green was removed");
    // suite-b was neither re-run as failing nor cleared — it must remain.
    assert.ok(entries["tests/suite-b.test.ts"], "suite-b (unverified) stays in manifest");
    // suite-unverified likewise.
    assert.ok(entries["tests/suite-unverified.test.ts"], "suite-unverified stays in manifest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Wiring pins (fs — this test is in the always-run core for this reason)
// ---------------------------------------------------------------------------

test("canary wiring: upsertRedManifestEntries is called only from scripts/post-merge-canary.ts; canary always exits 0; no publishRedManifest or TEST_GREEN_BASELINE_PUBLISH", () => {
  const canarySource = readFileSync("scripts/post-merge-canary.ts", "utf8");
  const runAllSource = readFileSync("tests/run-all.ts", "utf8");

  // Canary must call upsertRedManifestEntries.
  assert.ok(
    canarySource.includes("upsertRedManifestEntries("),
    "scripts/post-merge-canary.ts must call upsertRedManifestEntries",
  );

  // run-all must NOT call upsertRedManifestEntries (it uses publishRedManifest).
  assert.ok(
    !runAllSource.includes("upsertRedManifestEntries("),
    "tests/run-all.ts must NOT call upsertRedManifestEntries (single-writer: publishRedManifest only)",
  );

  // Canary must NOT call publishRedManifest (that would advance publishedAt).
  assert.ok(
    !canarySource.includes("publishRedManifest("),
    "scripts/post-merge-canary.ts must NOT call publishRedManifest (partial upsert only; publishedAt must not advance)",
  );

  // Canary must not reference the nightly publish flag (separate code path).
  assert.ok(
    !canarySource.includes("TEST_GREEN_BASELINE_PUBLISH"),
    "scripts/post-merge-canary.ts must not reference TEST_GREEN_BASELINE_PUBLISH",
  );

  // Canary always exits 0 — must never block post-merge.
  assert.ok(
    canarySource.includes("process.exit(0)"),
    "scripts/post-merge-canary.ts must call process.exit(0) (always exits 0)",
  );

  // redManifest.ts must still be outside the publish-flag chain.
  const redManifestSource = readFileSync("tests/redManifest.ts", "utf8");
  assert.ok(
    !redManifestSource.includes("TEST_GREEN_BASELINE_PUBLISH"),
    "tests/redManifest.ts must not reference TEST_GREEN_BASELINE_PUBLISH",
  );
});

// ---------------------------------------------------------------------------
// 6. Blast-radius gate expansion is wired into the smoke gate env
// ---------------------------------------------------------------------------

test("gate.ts: TEST_GATE_EXPANSION=1 is present in the smoke-gate env block", () => {
  const gateSource = readFileSync("scripts/gate.ts", "utf8");
  assert.ok(
    gateSource.includes('TEST_GATE_EXPANSION: "1"'),
    'scripts/gate.ts must set TEST_GATE_EXPANSION: "1" in the SMOKE_GATE env (Task #4501 blast-radius expansion)',
  );
  // Kill-switch documentation: the kill switch env var must be mentioned.
  assert.ok(
    gateSource.includes("TEST_GATE_EXPANSION"),
    "scripts/gate.ts must reference TEST_GATE_EXPANSION",
  );
});

test("run-all.ts: blast-radius expansion block respects the TEST_GATE_EXPANSION kill switch", () => {
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(
    runAll.includes('TEST_GATE_EXPANSION !== "0"'),
    'tests/run-all.ts must guard the expansion block with TEST_GATE_EXPANSION !== "0" (kill switch)',
  );
  assert.ok(
    runAll.includes("selectBlastRadiusExpansion"),
    "tests/run-all.ts must call selectBlastRadiusExpansion from relatedSmokeSelection",
  );
  // Expansion errors must never suppress the smoke run.
  assert.ok(
    runAll.includes("smoke run continues"),
    "tests/run-all.ts expansion catch block must log that the smoke run continues",
  );
});

// ---------------------------------------------------------------------------
// 8. SHA-capture wiring: post-merge.sh captures merge SHA before refresh steps
// ---------------------------------------------------------------------------

tests.push({
  name: "post-merge.sh captures CANARY_MERGE_BASE before artifact-refresh commits, and canary reads it via env var",
  fn: () => {
    const postMergeSh = readFileSync("scripts/post-merge.sh", "utf8");
    const canaryTs = readFileSync("scripts/post-merge-canary.ts", "utf8");

    // The env-var capture must appear in post-merge.sh.
    assert.ok(
      postMergeSh.includes("CANARY_MERGE_BASE="),
      "scripts/post-merge.sh must export CANARY_MERGE_BASE before artifact-refresh commits",
    );
    // The capture must come BEFORE the generated-artifact refresh (which may commit).
    const captureIdx = postMergeSh.indexOf("CANARY_MERGE_BASE=");
    const refreshIdx = postMergeSh.indexOf("post-merge-generated-artifact-refresh");
    assert.ok(
      captureIdx !== -1 && refreshIdx !== -1 && captureIdx < refreshIdx,
      "CANARY_MERGE_BASE must be captured before the generated-artifact refresh step",
    );
    // Canary must read CANARY_MERGE_BASE and CANARY_MERGE_SHA env vars.
    assert.ok(
      canaryTs.includes("CANARY_MERGE_BASE"),
      "scripts/post-merge-canary.ts must read CANARY_MERGE_BASE set by post-merge.sh",
    );
    assert.ok(
      canaryTs.includes("CANARY_MERGE_SHA"),
      "scripts/post-merge-canary.ts must read CANARY_MERGE_SHA set by post-merge.sh",
    );
    // Canary must not fall back to HEAD~1 as the PRIMARY range (env var must be first).
    const envBaseIdx = canaryTs.indexOf("CANARY_MERGE_BASE");
    const headParentIdx = canaryTs.indexOf("HEAD~1");
    assert.ok(
      envBaseIdx < headParentIdx,
      "canary must prefer CANARY_MERGE_BASE env var over HEAD~1 git resolution",
    );
  },
});

// ---------------------------------------------------------------------------
// 9. Timestamp-max wiring: scheduler and health overview use max not ?? so
//    a newer partial canary update actually extends freshness
// ---------------------------------------------------------------------------

tests.push({
  name: "readCommittedRedManifestStatus and health overview use max(publishedAt, lastPartialUpdateAt) so canary updates extend freshness",
  fn: () => {
    const schedulerSrc = readFileSync(
      "server/services/regressionSweepScheduler.ts",
      "utf8",
    );
    const overviewSrc = readFileSync("server/services/healthOverview.ts", "utf8");

    // Locate the readCommittedRedManifestStatus function body.
    const funcStart = schedulerSrc.indexOf(
      "export function readCommittedRedManifestStatus(",
    );
    assert.ok(funcStart !== -1, "readCommittedRedManifestStatus must be exported");
    const funcEnd = schedulerSrc.indexOf("\n}", funcStart) + 2;
    const funcSrc = schedulerSrc.slice(funcStart, funcEnd);

    // Must NOT use ?? to prefer publishedAt over lastPartialUpdateAt (that would
    // mask a newer canary update and produce false stale-manifest alerts).
    assert.ok(
      !funcSrc.includes("?? (\n") && !funcSrc.match(/\?\?\s*\(\s*parsed/),
      "readCommittedRedManifestStatus must not use ?? to prefer publishedAt — use max comparison instead",
    );
    // Must use a reduce/max comparison to pick the newer stamp.
    assert.ok(
      funcSrc.includes("reduce"),
      "readCommittedRedManifestStatus must use reduce() to pick the newest of publishedAt and lastPartialUpdateAt",
    );

    // Same check for healthOverview.ts — the red-manifest stamp block.
    const overviewBlock = overviewSrc.slice(
      overviewSrc.indexOf("Red manifest"),
      overviewSrc.indexOf("manifest absent → nulls"),
    );
    assert.ok(
      !overviewBlock.match(/\?\?\s*\(/),
      "healthOverview red-manifest stamp block must not use ?? (masks canary update) — use max comparison",
    );
    assert.ok(
      overviewBlock.includes("reduce"),
      "healthOverview red-manifest stamp block must use reduce() to pick the newest stamp",
    );
  },
});

// ---------------------------------------------------------------------------
// 10. Task #4545 — canary breakage check files exactly ONE deduped item
// ---------------------------------------------------------------------------

test("runCanaryBreakageCheck: drains the event ledger, files exactly one 'fix main' item per culprit, deduped across ticks", async () => {
  const {
    runCanaryBreakageCheck,
    buildCanaryBreakageReport,
    readCanaryBreakageEvents,
    CANARY_FEEDBACK_USER_ID,
  } = await import("../server/services/regressionSweepScheduler");

  const root = mkdtempSync(join(tmpdir(), "canary-fb-test-"));
  try {
    const eventsPath = join(root, "post-merge-canary-events.jsonl");
    const resultPath = join(root, "post-merge-canary.json");
    const statePath = join(root, "canary-feedback-state.json");
    const paths = { canaryEventsPath: eventsPath, canaryResultPath: resultPath, statePath };
    const calls: Array<{ report: any; opts: any }> = [];
    const fileFn = (async (report: any, opts: any) => {
      calls.push({ report, opts });
      return { filed: report.results.length, resolved: 0 };
    }) as any;

    // No ledger, no result file → no call.
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 0, "no canary events → nothing filed");

    // Result file with empty newReds → no call.
    writeFileSync(
      resultPath,
      JSON.stringify({ culpritCommit: "clean000000", culpritTask: null, newReds: [] }),
      "utf8",
    );
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 0, "empty newReds → nothing filed");

    writeFileSync(
      resultPath,
      JSON.stringify({
        culpritCommit: "deferred000",
        culpritTask: null,
        newReds: ["tests/unproven.test.ts"],
        skipped: true,
        validationComplete: false,
        selectionMode: "central-integrity-deferred",
      }),
      "utf8",
    );
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(
      calls.length,
      0,
      "deferred/full selection is explicit incomplete evidence and never files unproven reds",
    );

    // Unknown culprit → no call (no stable dedupe key).
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ culpritCommit: "unknown", newReds: ["tests/x.test.ts"] })}\n`,
      "utf8",
    );
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 0, "unknown culprit → nothing filed");

    // REVIEW SCENARIO 1 — breaking merge then a CLEAN merge before the tick:
    // the breaking event lives in the append-only ledger; the clean merge
    // only overwrote the result file. The tick must still file the incident.
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        culpritCommit: "cafebabe12",
        culpritTask: "4501",
        newReds: ["tests/x.test.ts", "tests/y.test.ts"],
        finishedAt: "2026-08-11T00:04:00Z",
      })}\n`,
      "utf8",
    );
    // resultPath still holds the clean run (newReds: []) from above.
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 1, "breaking-then-clean before one tick → the incident still files");
    const { report, opts } = calls[0];
    assert.equal(opts.submitterId, CANARY_FEEDBACK_USER_ID, "dedicated canary submitter id");
    assert.equal(
      opts.autoResolve,
      false,
      "canary filing must NOT auto-resolve older incidents (partial per-drain reports)",
    );
    assert.equal(report.results.length, 1, "ONE synthetic failure per culprit, not per suite");
    assert.equal(
      report.results[0].file,
      "post-merge-canary:cafebabe12",
      "dedupe key is keyed on the culprit commit",
    );
    assert.ok(
      report.results[0].name.includes("cafebabe12") &&
        report.results[0].name.includes("Task #4501"),
      "item text names the culprit commit and task",
    );
    assert.ok(
      report.results[0].name.includes("tests/x.test.ts") &&
        report.results[0].name.includes("tests/y.test.ts"),
      "item text lists the broken suites",
    );

    // Second tick, same events → deduped by the durable filed-culprits state.
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 1, "same culprit on a later tick → nothing new filed");

    // REVIEW SCENARIO 2 — TWO distinct breaking merges land before one tick:
    // both events must file (one result per culprit, in a single call).
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ culpritCommit: "cafebabe12", culpritTask: "4501", newReds: ["tests/x.test.ts"] }),
        JSON.stringify({ culpritCommit: "deadbeef99", newReds: ["tests/z.test.ts"] }),
        JSON.stringify({ culpritCommit: "0badc0de77", newReds: ["tests/q.test.ts"] }),
      ].join("\n") + "\n",
      "utf8",
    );
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 2, "new culprits → one more fileFn call");
    const files2 = calls[1].report.results.map((r: any) => r.file).sort();
    assert.deepEqual(
      files2,
      ["post-merge-canary:0badc0de77", "post-merge-canary:deadbeef99"],
      "BOTH new culprits file; the already-filed one is excluded",
    );

    // fileFn throw → state not stamped → next tick retries.
    const throwingFileFn = (async () => {
      throw new Error("db down");
    }) as any;
    writeFileSync(
      resultPath,
      JSON.stringify({ culpritCommit: "feedface55", newReds: ["tests/w.test.ts"] }),
      "utf8",
    );
    await runCanaryBreakageCheck({ ...paths, fileFn: throwingFileFn });
    await runCanaryBreakageCheck({ ...paths, fileFn });
    assert.equal(calls.length, 3, "a failed filing is retried on the next tick");
    assert.equal(calls[2].report.results[0].file, "post-merge-canary:feedface55");

    // Sanity: reader folds ledger + result file, deduped by culprit.
    const events = readCanaryBreakageEvents(eventsPath, resultPath);
    assert.equal(events.length, 4, "3 ledger culprits + 1 result-file culprit");
    const built = buildCanaryBreakageReport(events);
    assert.equal(built.hardFailed, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10b. Task #4609 — recovery arm posts a "recovered" Slack relay message,
//      budget-raced so a hung Slack never stalls the watchdog tick.
// ---------------------------------------------------------------------------

test("runCanaryRecoveryCheck: resolving an open item relays a recovery message; hung/throwing relay never blocks (Task #4609)", async () => {
  const { runCanaryBreakageCheck } = await import(
    "../server/services/regressionSweepScheduler"
  );

  const root = mkdtempSync(join(tmpdir(), "canary-recovery-relay-"));
  try {
    const eventsPath = join(root, "post-merge-canary-events.jsonl");
    const statePath = join(root, "canary-feedback-state.json");
    // Task #4630 — hermetic pending-relay ledger: the hung/failed relay cases
    // below must never write to the real .local/state default path.
    const recoveryPendingStatePath = join(root, "canary-recovery-pending.json");
    // Manifest WITHOUT the culprit's suites → fully recovered.
    const manifestPath = makeCommittedManifest(root);
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        culpritCommit: "cafebabe12",
        culpritTask: "4501",
        newReds: ["tests/x.test.ts", "tests/y.test.ts"],
      })}\n`,
      "utf8",
    );
    // Pre-stamp the culprit as already filed so the filing arm is inert and
    // only the recovery arm acts.
    writeFileSync(
      statePath,
      JSON.stringify({ filedCulprits: ["cafebabe12"] }),
      "utf8",
    );

    const relayCalls: any[] = [];
    const base = {
      canaryEventsPath: eventsPath,
      canaryResultPath: join(root, "post-merge-canary.json"),
      statePath,
      redManifestPath: manifestPath,
      recoveryPendingStatePath,
      listOpenFn: (async () => ["post-merge-canary:cafebabe12"]) as any,
    };

    // 1) Happy path: item resolves → exactly one recovery relay message.
    await runCanaryBreakageCheck({
      ...base,
      resolveFn: (async () => 1) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "delivered" };
      }) as any,
    });
    assert.equal(relayCalls.length, 1, "one recovery relay per resolved item");
    assert.equal(relayCalls[0].page, "post-merge-canary:cafebabe12");
    assert.ok(
      relayCalls[0].feedbackText.includes("cafebabe12") &&
        relayCalls[0].feedbackText.includes("tests/x.test.ts") &&
        relayCalls[0].feedbackText.includes("tests/y.test.ts"),
      "recovery message names the culprit commit and the recovered suites",
    );
    assert.ok(
      /[Rr]ecovered/.test(relayCalls[0].feedbackText),
      "recovery message says main recovered",
    );

    // 2) Nothing actually resolved (another workspace won the race) → no relay.
    relayCalls.length = 0;
    await runCanaryBreakageCheck({
      ...base,
      resolveFn: (async () => 0) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "delivered" };
      }) as any,
    });
    assert.equal(relayCalls.length, 0, "no relay when no row was resolved");

    // 3) Throwing relay stub → swallowed (belt-catch), check still completes.
    await runCanaryBreakageCheck({
      ...base,
      resolveFn: (async () => 1) as any,
      relayFn: (async () => {
        throw new Error("slack exploded");
      }) as any,
    });

    // 4) Hung relay (never settles) → the budget race lets the tick continue.
    const start = Date.now();
    await runCanaryBreakageCheck({
      ...base,
      resolveFn: (async () => 1) as any,
      relayFn: (() => new Promise(() => {})) as any,
    });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 10_000,
      `hung Slack relay must not stall the tick beyond the budget (took ${elapsed}ms)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10c. Task #4630 — a failed/timed-out recovery relay persists a durable
//      pending marker and is retried on later watchdog ticks until delivered
//      (or the attempt cap), with no duplicate when a send actually delivered.
// ---------------------------------------------------------------------------

test("canary recovery relay: failed relay persists a pending marker, later tick retries until delivered, no duplicates (Task #4630)", async () => {
  const {
    runCanaryBreakageCheck,
    readPendingCanaryRecoveryRelays,
    writePendingCanaryRecoveryRelays,
    CANARY_RECOVERY_RELAY_MAX_ATTEMPTS,
  } = await import("../server/services/regressionSweepScheduler");

  const root = mkdtempSync(join(tmpdir(), "canary-recovery-pending-"));
  try {
    const eventsPath = join(root, "post-merge-canary-events.jsonl");
    const statePath = join(root, "canary-feedback-state.json");
    const pendingPath = join(root, "canary-recovery-pending.json");
    const manifestPath = makeCommittedManifest(root); // culprit's suites cleared
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        culpritCommit: "cafebabe12",
        culpritTask: "4501",
        newReds: ["tests/x.test.ts"],
      })}\n`,
      "utf8",
    );
    writeFileSync(statePath, JSON.stringify({ filedCulprits: ["cafebabe12"] }), "utf8");

    const relayCalls: any[] = [];
    const base = {
      canaryEventsPath: eventsPath,
      canaryResultPath: join(root, "post-merge-canary.json"),
      statePath,
      redManifestPath: manifestPath,
      recoveryPendingStatePath: pendingPath,
    };

    // 1) Item resolves but Slack is down → relay fails → durable marker.
    await runCanaryBreakageCheck({
      ...base,
      listOpenFn: (async () => ["post-merge-canary:cafebabe12"]) as any,
      resolveFn: (async () => 1) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "failed", reason: "socket hang up" };
      }) as any,
    });
    assert.equal(relayCalls.length, 1, "one initial relay attempt");
    let pending = readPendingCanaryRecoveryRelays(pendingPath);
    assert.equal(pending.length, 1, "failed relay persists a pending marker");
    assert.equal(pending[0].culprit, "cafebabe12");
    assert.equal(pending[0].attempts, 1);
    assert.ok(
      pending[0].feedbackText.includes("cafebabe12") &&
        /[Rr]ecovered/.test(pending[0].feedbackText),
      "marker freezes the full recovery message",
    );

    // 2) Next tick (item no longer open — it resolved) with Slack still down:
    //    retried, still pending, attempts incremented.
    await runCanaryBreakageCheck({
      ...base,
      listOpenFn: (async () => []) as any,
      resolveFn: (async () => 0) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "not_connected", reason: "down" };
      }) as any,
    });
    assert.equal(relayCalls.length, 2, "pending marker retried on the next tick");
    assert.equal(relayCalls[1].page, "post-merge-canary:cafebabe12");
    pending = readPendingCanaryRecoveryRelays(pendingPath);
    assert.equal(pending.length, 1, "still-failing relay keeps the marker");
    assert.equal(pending[0].attempts, 2, "attempt counter increments");

    // 3) Slack recovers → retry delivers → marker cleared.
    await runCanaryBreakageCheck({
      ...base,
      listOpenFn: (async () => []) as any,
      resolveFn: (async () => 0) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "delivered" };
      }) as any,
    });
    assert.equal(relayCalls.length, 3, "delivered retry sends exactly once");
    assert.equal(
      readPendingCanaryRecoveryRelays(pendingPath).length,
      0,
      "delivered retry clears the marker",
    );

    // 4) No duplicate after delivery: a further tick relays nothing.
    await runCanaryBreakageCheck({
      ...base,
      listOpenFn: (async () => []) as any,
      resolveFn: (async () => 0) as any,
      relayFn: (async (args: any) => {
        relayCalls.push(args);
        return { status: "delivered" };
      }) as any,
    });
    assert.equal(relayCalls.length, 3, "no duplicate recovery message after delivery");

    // 5) Give-up cap: a marker one attempt short of the cap that fails again
    //    is dropped (undeliverable) — never retried forever.
    writePendingCanaryRecoveryRelays(
      [
        {
          culprit: "deadbeef99",
          page: "post-merge-canary:deadbeef99",
          feedbackText: "Recovered: main is fixed for culprit commit deadbeef99.",
          attempts: CANARY_RECOVERY_RELAY_MAX_ATTEMPTS - 1,
          firstFailedAt: new Date().toISOString(),
        },
      ],
      pendingPath,
    );
    await runCanaryBreakageCheck({
      ...base,
      listOpenFn: (async () => []) as any,
      resolveFn: (async () => 0) as any,
      relayFn: (async () => ({ status: "failed", reason: "still down" })) as any,
    });
    assert.equal(
      readPendingCanaryRecoveryRelays(pendingPath).length,
      0,
      "marker past the attempt cap is dropped as undeliverable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canary recovery relay: in-flight-at-budget send that later delivers clears its own marker — no duplicate on the next tick (Task #4630)", async () => {
  const { runCanaryBreakageCheck, readPendingCanaryRecoveryRelays } = await import(
    "../server/services/regressionSweepScheduler"
  );

  const root = mkdtempSync(join(tmpdir(), "canary-recovery-late-"));
  try {
    const eventsPath = join(root, "post-merge-canary-events.jsonl");
    const statePath = join(root, "canary-feedback-state.json");
    const pendingPath = join(root, "canary-recovery-pending.json");
    const manifestPath = makeCommittedManifest(root);
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ culpritCommit: "cafebabe12", newReds: ["tests/x.test.ts"] })}\n`,
      "utf8",
    );
    writeFileSync(statePath, JSON.stringify({ filedCulprits: ["cafebabe12"] }), "utf8");

    // A relay that hangs past the budget, then delivers when we release it.
    let release!: (v: any) => void;
    const slow = new Promise<any>((resolve) => {
      release = resolve;
    });
    const relayCalls: any[] = [];
    await runCanaryBreakageCheck({
      canaryEventsPath: eventsPath,
      canaryResultPath: join(root, "post-merge-canary.json"),
      statePath,
      redManifestPath: manifestPath,
      recoveryPendingStatePath: pendingPath,
      listOpenFn: (async () => ["post-merge-canary:cafebabe12"]) as any,
      resolveFn: (async () => 1) as any,
      relayFn: ((args: any) => {
        relayCalls.push(args);
        return slow;
      }) as any,
    });
    // Budget expired first → durable marker written (message not lost if we
    // crash here and the send never actually completed).
    assert.equal(relayCalls.length, 1);
    assert.equal(
      readPendingCanaryRecoveryRelays(pendingPath).length,
      1,
      "in-flight-at-budget relay persists a pending marker",
    );

    // The in-flight send now ACTUALLY delivers → continuation clears the
    // marker so the next tick does not double-post.
    release({ status: "delivered" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      readPendingCanaryRecoveryRelays(pendingPath).length,
      0,
      "late delivery clears its own marker (no duplicate on the next tick)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Task #4545 — wiring pins: single call site, watchdog wiring
// ---------------------------------------------------------------------------

test("canary breakage feedback wiring: single canary call site into fileAndResolveSweepFeedback, wired into the 6h watchdog", () => {
  const schedulerSrc = readFileSync(
    "server/services/regressionSweepScheduler.ts",
    "utf8",
  );

  // The scheduler reads the canary result file AND the append-only ledger.
  assert.ok(
    schedulerSrc.includes(".local/runs/post-merge-canary.json"),
    "scheduler must read .local/runs/post-merge-canary.json",
  );
  assert.ok(
    schedulerSrc.includes(".local/runs/post-merge-canary-events.jsonl"),
    "scheduler must drain the append-only event ledger (a clean merge overwrites the result file)",
  );

  // The canary appends breakage events to the ledger (never truncate-writes it).
  const canarySrcForLedger = readFileSync("scripts/post-merge-canary.ts", "utf8");
  assert.ok(
    canarySrcForLedger.includes("post-merge-canary-events.jsonl") &&
      canarySrcForLedger.includes("appendFileSync"),
    "scripts/post-merge-canary.ts must APPEND breakage events to the jsonl ledger",
  );

  // Exactly ONE call site passes the canary submitter id into
  // fileAndResolveSweepFeedback (via the injectable fileFn seam).
  const canarySubmitterCallSites =
    schedulerSrc.split("submitterId: CANARY_FEEDBACK_USER_ID").length - 1;
  assert.equal(
    canarySubmitterCallSites,
    1,
    "exactly one canary-feedback call site (submitterId: CANARY_FEEDBACK_USER_ID)",
  );

  // The check is wired into the 6h staleness watchdog (boot + periodic).
  const watchdogStart = schedulerSrc.indexOf("async function runStalenessWatchdog(");
  assert.ok(watchdogStart !== -1, "runStalenessWatchdog must exist");
  const watchdogBody = schedulerSrc.slice(watchdogStart, schedulerSrc.indexOf("\n}", watchdogStart));
  assert.ok(
    watchdogBody.includes("runCanaryBreakageCheck()"),
    "runStalenessWatchdog must call runCanaryBreakageCheck (6h tick + boot)",
  );

  // The canary script itself must NOT file feedback (DB access is not
  // guaranteed in the post-merge pipeline; the scheduler is the single filer).
  const canarySrc = readFileSync("scripts/post-merge-canary.ts", "utf8");
  assert.ok(
    !canarySrc.includes("fileAndResolveSweepFeedback"),
    "scripts/post-merge-canary.ts must not call fileAndResolveSweepFeedback",
  );
});
// ---------------------------------------------------------------------------
// 10. Task #4547 — expansion timeout guard: a stalled tracer must resolve to
//     an honest fallbackReason instead of hanging the smoke run.
// ---------------------------------------------------------------------------

test("selectBlastRadiusExpansion: a stalled tracer times out with an honest fallbackReason (Task #4547)", async () => {
  // Tracer that never resolves — simulates an esbuild BFS stall.
  const neverResolves = () => new Promise<never>(() => {});
  const result = await selectBlastRadiusExpansion(
    [{ file: "tests/post-merge-canary.test.ts" }],
    ["server/some-changed-file.ts"], // fs-scan-inputs-ignore -- fixture changed-file name passed to selectBlastRadiusExpansion, never an fs-read target
    { timeoutMs: 50, traceFn: neverResolves as any },
  );
  assert.equal(result.selected.length, 0, "timed-out expansion selects nothing");
  assert.equal(result.truncated, false, "timed-out expansion is not truncated");
  assert.equal(
    result.fallbackReason,
    "expansion timed out after 0s",
    "timeout must surface as a fallbackReason (smoke run continues unexpanded)",
  );
});

test("selectBlastRadiusExpansion: a fast tracer is unaffected by the timeout guard (Task #4547)", async () => {
  // Tracer resolves immediately with an empty closure map — no hits, no
  // fallback: the guard must not misfire on a healthy trace.
  const fastTrace = async () => ({ ok: true, closures: new Map(), unresolved: new Map() });
  const result = await selectBlastRadiusExpansion(
    [{ file: "tests/post-merge-canary.test.ts" }],
    ["server/some-changed-file.ts"], // fs-scan-inputs-ignore -- fixture changed-file name passed to selectBlastRadiusExpansion, never an fs-read target
    { timeoutMs: 30_000, traceFn: fastTrace as any },
  );
  assert.equal(result.fallbackReason, null, "healthy trace must not produce a fallbackReason");
  assert.equal(result.selected.length, 0, "empty closures → no selections");
});

test("run-all.ts: expansion passes a timeoutMs budget (GATE_EXPANSION_TIMEOUT_MS, Task #4547)", () => {
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(
    runAll.includes("GATE_EXPANSION_TIMEOUT_MS"),
    "tests/run-all.ts must read GATE_EXPANSION_TIMEOUT_MS for the expansion timeout",
  );
  assert.ok(
    /timeoutMs:\s*expansionTimeoutMs/.test(runAll),
    "tests/run-all.ts must pass timeoutMs to selectBlastRadiusExpansion",
  );
});

// ---------------------------------------------------------------------------
// 11. Task #4617 — the canary pre-computes its slice in-process and spawns
//     exactly that slice via --file; fall-opens skip honestly up front.
// ---------------------------------------------------------------------------

test("canary pre-computes its slice with the runner's own selection code and spawns --file (Task #4617)", () => {
  const src = readFileSync("scripts/post-merge-canary.ts", "utf8");

  // Selection single-source-of-truth: the canary imports the runner's own
  // exported machinery — never a reimplementation.
  assert.ok(src.includes("selectRelatedSmokeTests("), "uses the runner's related-selection");
  assert.ok(src.includes("selectBlastRadiusExpansion("), "keeps blast-radius expansion");
  assert.ok(src.includes("planIncrementalRun("), "green-skip pre-check uses the runner's planner");
  assert.ok(src.includes("buildTestRegistry("), "slice validated against the real registry");

  // The disclosed slice IS the executed slice: spawn is an explicit --file list.
  assert.ok(src.includes("`--file=${executedFiles.join(\",\")}`"), "spawns an explicit --file list");

  // The old blind smoke spawn is gone: no smoke-mode env on the child, and
  // inherited selection flags are stripped so the child cannot re-select.
  assert.ok(!src.includes('TEST_SMOKE: "1"'), "child no longer runs in smoke selection mode");
  for (const key of ['k !== "TEST_SMOKE"', 'k !== "TEST_SMOKE_RELATED"', 'k !== "SMOKE_RELATED_BASE"']) {
    assert.ok(src.includes(key), `spawn env strips ${key}`);
  }
  // The merge base feeds the in-process SELECTOR env instead.
  assert.ok(src.includes("SMOKE_RELATED_BASE: mergeBase"), "merge base passed to the selector explicitly");

  // Result discloses the plan (additive fields; scheduler contract untouched).
  for (const field of ["validationComplete", "selectionMode", "plannedFiles", "executedFiles", "excludedOverBudget"]) {
    assert.ok(src.includes(field), `result carries ${field}`);
  }
  assert.ok(
    src.includes("validationComplete: !result.skipped"),
    "every skipped canary result is persisted as incomplete validation evidence",
  );
});

test("canary skips honestly on fall-open/full selection instead of attempting the universe (Task #4617)", () => {
  const src = readFileSync("scripts/post-merge-canary.ts", "utf8");

  // Full-universe fallback = skip with disclosed reason (full coverage is the
  // gate/nightly's job; a 240s budget cannot run ~746 suites).
  assert.ok(src.includes('manifest.mode !== "related"'), "detects fall-open selection");
  assert.ok(src.includes('"central-integrity-deferred"'), "full fall-open skip mode disclosed");
  assert.ok(
    src.includes("belong to the post-merge/nightly/weekly integrity lane"),
    "skip reason names the responsible layer",
  );

  // Empty slice and all-green slice skip WITHOUT booting the runner.
  assert.ok(src.includes("runner never booted"), "empty/green slices never boot the runner");
  assert.ok(src.includes("plan.executeFiles.size === 0"), "green-skip pre-check present");

  // A broken registry or broken selection = honest skip, never a guess.
  assert.ok(src.includes('"registry-invalid"'), "partial registry skips honestly");
  assert.ok(src.includes('"selection-error"'), "selection crash skips honestly");

  // Over-budget suites are excluded and disclosed, not started-and-killed.
  assert.ok(src.includes("excludedOverBudget.push"), "over-budget suites excluded");
  assert.ok(src.includes("timeoutMs ?? SUITE_TIMEOUT_MS"), "exclusion respects registered suite timeouts");
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} post-merge-canary tests passed`);
process.exit(failures > 0 ? 1 : 0);
