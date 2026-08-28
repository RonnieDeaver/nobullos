/* test-registration
{
  "name": "Durable long-run validation: allowlisted profiles, evidence, and lifecycle safety",
  "smoke": true,
  "smokeReason": "Fast, DB-free fixture coverage prevents the approved long-control workflow from accepting arbitrary execution, losing evidence, or reporting interrupted controls as green.",
  "regression": true,
  "tier": "medium",
  "tierReason": "Exercises long-control profile validation, evidence, and lifecycle fixture scenarios.",
  "scanPaths": [".replit", "scripts/long-run-validation.ts", "scripts/lint-gate-workflow-drift.ts"]
}
test-registration */
// fs-scan-fixture-only -- this suite reads only its own mkdtemp evidence tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LONG_RUNS_DIR,
  MAIN_WORKSPACE_ONLY_PROFILES,
  assertProfileAllowedInEnvironment,
  buildDeclaredChildEnv,
  classifyChildClose,
  cleanupLongRunValidationArtifacts,
  createLineRedactor,
  redactText,
  runLongValidation,
  startLongRunValidation,
  validateLongRunRequest,
  type ChildOutcome,
} from "../scripts/long-run-validation.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "long-run-validation-"));
}

function initGitFixture(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".local/\nnode_modules/\n");
  writeFileSync(join(dir, "tracked.txt"), "before\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
}

function request(profile: "focused-test" | "routine-gate" = "focused-test") {
  return profile === "focused-test"
    ? { schemaVersion: 1, profile, files: ["tests/example.test.ts"] }
    : { schemaVersion: 1, profile };
}

function executor(
  outcome: ChildOutcome,
  options: {
    output?: string;
    waitForAbort?: boolean;
    duplicateResults?: boolean;
  } = {},
) {
  return async (
    stage: { reports: string[] },
    context: { rootDir: string; logPath: string; signal: AbortSignal },
  ): Promise<ChildOutcome> => {
    if (options.waitForAbort) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "cancelled", exitCode: null, signal: "SIGTERM" };
    }
    for (const report of stage.reports) {
      const path = join(context.rootDir, report);
      mkdirSync(join(context.rootDir, ".local", "runs"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          verificationComplete: true,
          verificationProblems: [],
          total: options.duplicateResults ? 2 : 1,
          skippedGreen: 0,
          skippedGreenFiles: [],
          results: options.duplicateResults
            ? [
                { file: "tests/example.test.ts" },
                { file: "tests/example.test.ts" },
              ]
            : [{ file: "tests/example.test.ts" }],
          report,
        }),
      );
    }
    writeFileSync(context.logPath, options.output ?? "fixture output\n");
    return outcome;
  };
}

console.log("1) strict request contract");
assert.equal(validateLongRunRequest({ schemaVersion: 1, profile: "routine-gate", command: "rm -rf /" }).ok, false);
assert.equal(validateLongRunRequest({ schemaVersion: 1, profile: "focused-test", files: ["../unsafe.test.ts"] }).ok, false);
assert.equal(validateLongRunRequest({ schemaVersion: 1, profile: "full-control", control: "unsafe" }).ok, false);
assert.equal(validateLongRunRequest(request()).ok, true);
{
  const previousPublish = process.env.TEST_GREEN_BASELINE_PUBLISH;
  const previousPath = process.env.TEST_GREEN_BASELINE_PATH;
  try {
    process.env.TEST_GREEN_BASELINE_PUBLISH = "1";
    process.env.TEST_GREEN_BASELINE_PATH = "tests/attacker-baseline.json";
    const childEnv = buildDeclaredChildEnv({});
    assert.equal(childEnv.TEST_GREEN_BASELINE_PUBLISH, undefined);
    assert.equal(childEnv.TEST_GREEN_BASELINE_PATH, undefined);
  } finally {
    if (previousPublish === undefined) delete process.env.TEST_GREEN_BASELINE_PUBLISH;
    else process.env.TEST_GREEN_BASELINE_PUBLISH = previousPublish;
    if (previousPath === undefined) delete process.env.TEST_GREEN_BASELINE_PATH;
    else process.env.TEST_GREEN_BASELINE_PATH = previousPath;
  }
}
console.log("✓ unknown commands, unsafe paths, unsupported controls, and malformed specs are refused");

console.log("\n2) success evidence is immutable and collision-safe");
{
  const dir = root();
  try {
    const deps = { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 0, signal: null }) };
    const first = await runLongValidation(request(), undefined, deps);
    const second = await runLongValidation(request(), undefined, deps);
    assert.equal(first.manifest.status, "passed");
    assert.equal(second.manifest.status, "passed");
    assert.notEqual(first.runDir, second.runDir, "each request gets a unique evidence directory");
    assert.ok(existsSync(join(first.runDir, "request.json")));
    assert.ok(existsSync(join(first.runDir, "source.json")));
    const events = readFileSync(join(first.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.state),
      ["queued", "running", "running", "succeeded"],
      "structured lifecycle records preserve queued/running/succeeded transitions",
    );
    const index = JSON.parse(readFileSync(join(dir, LONG_RUNS_DIR, "index.json"), "utf8"));
    assert.equal(index.records[0].lifecycleState, "succeeded", "summary index records successful terminal state");
    assert.equal(index.records[0].cleanup.disposition, "retained", "summary index records current cleanup disposition");
    assert.ok(existsSync(join(first.runDir, "stages", "01-focused-test", "raw.log")));
    assert.equal(first.manifest.stages[0].reports.length, 1, "fresh report copied immediately");
    console.log("✓ request, source, log, report snapshot, and atomic manifest are retained per unique run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n3) failures, missing results, cancellation, and stale locks stay honest");
{
  const dir = root();
  try {
    const failed = await runLongValidation(
      request(),
      undefined,
      { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 7, signal: null }) },
    );
    assert.equal(failed.manifest.status, "failed");
    assert.equal(failed.manifest.stages[0].outcome?.exitCode, 7);

    const missing = await runLongValidation(
      request(),
      undefined,
      {
        rootDir: dir,
        executeStage: async () => ({ kind: "exited", exitCode: 0, signal: null }),
      },
    );
    assert.equal(missing.manifest.interruptionReason, "missing-report");

    const duplicate = await runLongValidation(
      request(),
      undefined,
      {
        rootDir: dir,
        executeStage: executor(
          { kind: "exited", exitCode: 0, signal: null },
          { duplicateResults: true },
        ),
      },
    );
    assert.equal(
      duplicate.manifest.interruptionReason,
      "missing-report",
      "duplicate test results are not accepted as complete evidence",
    );

    const timedOut = await runLongValidation(
      request(),
      undefined,
      {
        rootDir: dir,
        executeStage: executor({ kind: "timed-out", exitCode: null, signal: "SIGKILL" }),
      },
    );
    assert.equal(timedOut.manifest.status, "failed");
    assert.equal(timedOut.manifest.interruptionReason, "timed-out");

    const staleRunId = "2000-01-01T00-00-00-000Z-999999-aaaaaaaaaaaa";
    const staleRunDir = join(dir, LONG_RUNS_DIR, staleRunId);
    mkdirSync(staleRunDir, { recursive: true });
    writeFileSync(
      join(staleRunDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: staleRunId,
        profile: "focused-test",
        status: "running",
        startedAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
        source: { commit: null, tree: null, workingTreeHash: "old" },
        profileDefinitionHash: "old",
        stages: [{ name: "focused-test", status: "running", reports: [] }],
      }),
    );
    const staleLock = join(dir, LONG_RUNS_DIR, ".active-lock.json");
    mkdirSync(staleLock);
    writeFileSync(
      join(staleLock, "owner.json"),
      JSON.stringify({ schemaVersion: 1, pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z", runId: staleRunId }),
    );
    const recovered = await runLongValidation(
      request(),
      undefined,
      { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 0, signal: null }) },
    );
    assert.equal(recovered.manifest.status, "passed", "stale dead-owner lock is recovered");
    const abandoned = JSON.parse(readFileSync(join(staleRunDir, "manifest.json"), "utf8"));
    assert.equal(abandoned.status, "failed", "recovered stale owner no longer remains running");
    assert.equal(abandoned.interruptionReason, "stale-lock-recovered");
    const staleEvents = readFileSync(join(staleRunDir, "events.jsonl"), "utf8");
    assert.ok(staleEvents.includes('"state":"interrupted"'), "stale recovery records an interrupted lifecycle event");

    const racingLock = join(dir, LONG_RUNS_DIR, ".active-lock.json");
    mkdirSync(racingLock);
    writeFileSync(
      join(racingLock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 999_998,
        createdAt: "2000-01-01T00:00:00.000Z",
        runId: "2000-01-01T00-00-00-000Z-999998-bbbbbbbbbbbb",
      }),
    );
    const slowExecutor = async (
      stage: { reports: string[] },
      context: { rootDir: string; logPath: string; signal: AbortSignal },
    ): Promise<ChildOutcome> => {
      const outcome = await executor({ kind: "exited", exitCode: 0, signal: null })(stage, context);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return outcome;
    };
    const racers = await Promise.allSettled([
      runLongValidation(request(), undefined, { rootDir: dir, executeStage: slowExecutor }),
      runLongValidation(request(), undefined, { rootDir: dir, executeStage: slowExecutor }),
    ]);
    assert.equal(
      racers.filter((result) => result.status === "fulfilled").length,
      1,
      "exactly one stale-lock recovery contender executes",
    );
    assert.equal(
      racers.filter((result) => result.status === "rejected").length,
      1,
      "the other stale-lock recovery contender is refused",
    );

    const handle = startLongRunValidation(
      request(),
      { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 0, signal: null }, { waitForAbort: true }) },
    );
    await assert.rejects(
      () => runLongValidation(request(), undefined, { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 0, signal: null }) }),
      /active/,
      "an active lock refuses an overlapping run",
    );
    setTimeout(() => handle.cancel(), 10);
    const cancelled = await handle.done;
    assert.equal(cancelled.manifest.status, "cancelled");
    assert.equal(cancelled.manifest.interruptionReason, "cancelled");
    assert.deepEqual(
      classifyChildClose(null, null, "SIGTERM"),
      { kind: "killed", exitCode: null, signal: "SIGTERM" },
      "an external child signal is recorded as killed, not a normal exit",
    );
    console.log("✓ nonzero, missing-result, timeout, stale-lock, overlap, and cancellation paths persist a failing lifecycle outcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n4) output is not copied into aggregate lifecycle metadata");
{
  const dir = root();
  try {
    const secret = "Bearer private-token-value";
    const run = await runLongValidation(
      request(),
      undefined,
      { rootDir: dir, executeStage: executor({ kind: "exited", exitCode: 0, signal: null }, { output: secret }) },
    );
    const manifest = readFileSync(join(run.runDir, "manifest.json"), "utf8");
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    const index = readFileSync(join(dir, LONG_RUNS_DIR, "index.json"), "utf8");
    assert.ok(!manifest.includes(secret), "manifest has no child output");
    assert.ok(!manifest.includes("tests/example.test.ts"), "aggregate manifest has no focused test path");
    assert.ok(!events.includes(secret) && !index.includes(secret), "lifecycle events and index exclude child output");
    assert.ok(!events.includes("tests/example.test.ts") && !index.includes("tests/example.test.ts"), "lifecycle events and index exclude focused test paths");
    assert.equal(redactText(secret), "Bearer [REDACTED]", "credential-shaped output is redacted at the log boundary");
    let streamed = "";
    const redactor = createLineRedactor((safe) => {
      streamed += safe;
    });
    redactor.push('{"authorization":"Bea');
    redactor.push('rer private-token-value"}\n');
    redactor.end();
    assert.ok(!streamed.includes("private-token-value"), "chunk-split credentials are redacted");
    assert.equal(
      redactText("GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY=supersecretvalue"),
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY="[REDACTED]"',
      "generic workspace secret keys are redacted",
    );
    assert.equal(
      redactText("private_key=-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----"),
      'private_key="[REDACTED]"',
      "structured private-key assignments are redacted before persistence",
    );
    console.log("✓ aggregate manifest excludes child output, commands, and request-specific test paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n5) a source change between captured revision and result fails closed");
{
  const dir = root();
  try {
    initGitFixture(dir);
    const changingExecutor = async (
      stage: { reports: string[] },
      context: { rootDir: string; logPath: string; signal: AbortSignal },
    ): Promise<ChildOutcome> => {
      const outcome = await executor({ kind: "exited", exitCode: 0, signal: null })(stage, context);
      writeFileSync(join(dir, "tracked.txt"), "after\n");
      return outcome;
    };
    const changed = await runLongValidation(
      request(),
      undefined,
      { rootDir: dir, executeStage: changingExecutor },
    );
    assert.equal(changed.manifest.status, "failed");
    assert.equal(changed.manifest.interruptionReason, "source-changed");
    console.log("✓ matched inputs cannot silently change after provenance capture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n6) retention is bounded, dry-runnable, and namespace-scoped");
{
  const dir = root();
  const runsDir = join(dir, LONG_RUNS_DIR);
  const outside = join(dir, ".local", "runs", "gate-timings.json");
  try {
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(join(dir, ".local", "runs"), { recursive: true });
    writeFileSync(outside, "must survive\n");
    const oldId = "2000-01-01T00-00-00-000Z-100-aaaaaaaaaaaa";
    const freshId = "2099-01-01T00-00-00-000Z-101-bbbbbbbbbbbb";
    for (const runId of [oldId, freshId]) {
      const runDir = join(runsDir, runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          profile: "focused-test",
          status: "passed",
          startedAt: runId === oldId ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
          finishedAt: runId === oldId ? "2000-01-02T00:00:00.000Z" : "2099-01-02T00:00:00.000Z",
          updatedAt: "2099-01-02T00:00:00.000Z",
          source: { commit: null, tree: null, workingTreeHash: "fixture" },
          profileDefinitionHash: "fixture",
          stages: [],
        }),
      );
    }
    mkdirSync(join(runsDir, "not-a-run"), { recursive: true });
    const dryRun = cleanupLongRunValidationArtifacts({
      rootDir: dir,
      now: () => new Date("2099-01-03T00:00:00.000Z"),
      dryRun: true,
    });
    assert.ok(dryRun.eligibleRunIds.includes(oldId), "dry-run identifies expired long-control evidence");
    assert.equal(dryRun.deletedRunIds.length, 0, "dry-run does not report evidence as deleted");
    assert.ok(existsSync(join(runsDir, oldId)), "dry-run does not delete eligible evidence");
    const cleaned = cleanupLongRunValidationArtifacts({
      rootDir: dir,
      now: () => new Date("2099-01-03T00:00:00.000Z"),
    });
    assert.ok(cleaned.deletedRunIds.includes(oldId), "expired long-control evidence is pruned");
    assert.ok(!existsSync(join(runsDir, oldId)), "only the expired namespace child is deleted");
    assert.ok(existsSync(join(runsDir, freshId)), "evidence inside the retention window survives");
    assert.ok(existsSync(outside), "unrelated gate evidence is never touched");
    assert.ok(cleaned.unsafeEntries.includes("not-a-run"), "ambiguous namespace entries are refused and reported");
    const secret = "Bearer should-never-reach-index";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ runId: oldId, interruptionReason: secret }],
      }),
    );
    const unsafeTerminalId = "2000-01-01T00-00-00-000Z-102-cccccccccccc";
    mkdirSync(join(runsDir, unsafeTerminalId), { recursive: true });
    writeFileSync(
      join(runsDir, unsafeTerminalId, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: unsafeTerminalId,
        profile: "focused-test",
        status: "failed",
        startedAt: "2000-01-01T00:00:00.000Z",
        finishedAt: "2000-01-02T00:00:00.000Z",
        interruptionReason: secret,
        stages: [],
      }),
    );
    const forgedId = "2000-01-01T00-00-00-000Z-103-dddddddddddd";
    mkdirSync(join(runsDir, forgedId), { recursive: true });
    writeFileSync(
      join(runsDir, forgedId, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: forgedId,
        profile: "focused-test",
        status: "running",
        startedAt: "2000-01-01T00:00:00.000Z",
        finishedAt: "2000-01-02T00:00:00.000Z",
        stages: [],
      }),
    );
    const cleanupTriggerId = "2000-01-01T00-00-00-000Z-104-eeeeeeeeeeee";
    mkdirSync(join(runsDir, cleanupTriggerId), { recursive: true });
    writeFileSync(
      join(runsDir, cleanupTriggerId, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: cleanupTriggerId,
        profile: "focused-test",
        status: "passed",
        startedAt: "2000-01-01T00:00:00.000Z",
        finishedAt: "2000-01-02T00:00:00.000Z",
        stages: [],
      }),
    );
    const forgedReport = cleanupLongRunValidationArtifacts({
      rootDir: dir,
      now: () => new Date("2099-01-03T00:00:00.000Z"),
    });
    assert.ok(forgedReport.notEligibleRunIds.includes(forgedId), "non-terminal manifests are never retention candidates");
    assert.ok(existsSync(join(runsDir, forgedId)), "forged running evidence remains untouched");
    assert.ok(forgedReport.notEligibleRunIds.includes(unsafeTerminalId), "untrusted terminal metadata is never retention eligible");
    assert.ok(existsSync(join(runsDir, unsafeTerminalId)), "unsafe terminal evidence remains untouched");
    assert.ok(forgedReport.deletedRunIds.includes(cleanupTriggerId), "safe expired evidence still triggers index rewrite");
    assert.ok(!readFileSync(join(runsDir, "index.json"), "utf8").includes(secret), "untrusted index and manifest text never survives index normalization");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n7) routine gate reports come from a private source mirror");
{
  const dir = root();
  try {
    initGitFixture(dir);
    const isolated = await runLongValidation(
      request("routine-gate"),
      undefined,
      {
        rootDir: dir,
        executeStage: executor({ kind: "exited", exitCode: 0, signal: null }),
      },
    );
    assert.equal(isolated.manifest.status, "passed");
    assert.equal(isolated.manifest.stages[0].reports.length, 2);
    assert.ok(
      !existsSync(join(isolated.runDir, "stages", "01-routine-gate", "workspace")),
      "temporary source mirror is removed after reports are captured",
    );
    console.log("✓ fixed-path gate reports cannot collide with writers in the original workspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n8) full-control and matched-comparison are refused before any evidence, lock, or child work in a detected sub-environment (Task #5292)");
{
  assert.ok(MAIN_WORKSPACE_ONLY_PROFILES.has("full-control"), "full-control is a main-workspace-only profile");
  assert.ok(MAIN_WORKSPACE_ONLY_PROFILES.has("matched-comparison"), "matched-comparison is a main-workspace-only profile");
  assert.ok(!MAIN_WORKSPACE_ONLY_PROFILES.has("routine-gate"), "routine-gate remains available everywhere");
  assert.ok(!MAIN_WORKSPACE_ONLY_PROFILES.has("focused-test"), "focused-test remains available everywhere");
  assert.throws(
    () => assertProfileAllowedInEnvironment("full-control", true),
    /main-workspace central-integrity control/,
    "the pure gate refuses full-control in a sub-environment",
  );
  assert.throws(
    () => assertProfileAllowedInEnvironment("matched-comparison", true),
    /main-workspace central-integrity control/,
    "the pure gate refuses matched-comparison in a sub-environment",
  );
  assert.doesNotThrow(() => assertProfileAllowedInEnvironment("full-control", false), "the main workspace keeps its reviewed operator path");
  assert.doesNotThrow(() => assertProfileAllowedInEnvironment("matched-comparison", false), "the main workspace keeps its matched-comparison path");
  assert.doesNotThrow(() => assertProfileAllowedInEnvironment("routine-gate", true), "routine-gate is never gated by environment");
  assert.doesNotThrow(() => assertProfileAllowedInEnvironment("focused-test", true), "focused-test is never gated by environment");

  const dir = root();
  try {
    let childInvoked = false;
    const guardExecutor = async (): Promise<ChildOutcome> => {
      childInvoked = true;
      return { kind: "exited", exitCode: 0, signal: null };
    };
    await assert.rejects(
      () =>
        runLongValidation(
          { schemaVersion: 1, profile: "full-control", control: "static-4" },
          undefined,
          { rootDir: dir, isSubEnvironment: true, executeStage: guardExecutor },
        ),
      /main-workspace central-integrity control/,
      "full-control is refused end-to-end in a detected task/sub-environment",
    );
    await assert.rejects(
      () =>
        runLongValidation(
          { schemaVersion: 1, profile: "matched-comparison" },
          undefined,
          { rootDir: dir, isSubEnvironment: true, executeStage: guardExecutor },
        ),
      /main-workspace central-integrity control/,
      "matched-comparison is refused end-to-end in a detected task/sub-environment",
    );
    assert.equal(childInvoked, false, "a refused profile never spawns a child");
    assert.ok(
      !existsSync(join(dir, LONG_RUNS_DIR)),
      "a refused profile never allocates a run directory, manifest, or lock",
    );

    initGitFixture(dir);
    for (const profile of ["focused-test", "routine-gate"] as const) {
      const admitted = await runLongValidation(
        request(profile),
        undefined,
        {
          rootDir: dir,
          isSubEnvironment: true,
          executeStage: executor({ kind: "exited", exitCode: 0, signal: null }),
        },
      );
      assert.equal(admitted.manifest.status, "passed", `${profile} is unaffected by sub-environment detection`);
    }
    console.log("✓ full-control/matched-comparison fail closed pre-evidence in a task environment; routine-gate/focused-test are unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n9) the main workspace retains the reviewed full-control and matched-comparison paths (Task #5292)");
{
  const dir = root();
  try {
    initGitFixture(dir);
    const fullControl = await runLongValidation(
      { schemaVersion: 1, profile: "full-control", control: "static-4" },
      undefined,
      {
        rootDir: dir,
        isSubEnvironment: false,
        executeStage: executor({ kind: "exited", exitCode: 0, signal: null }),
      },
    );
    assert.equal(fullControl.manifest.status, "passed", "full-control still runs to completion on the main workspace");
    const matchedComparison = await runLongValidation(
      { schemaVersion: 1, profile: "matched-comparison" },
      undefined,
      {
        rootDir: dir,
        isSubEnvironment: false,
        executeStage: executor({ kind: "exited", exitCode: 0, signal: null }),
      },
    );
    assert.equal(matchedComparison.manifest.status, "passed", "matched-comparison still runs to completion on the main workspace");
    assert.equal(matchedComparison.manifest.stages.length, 2, "a matched comparison still runs both control lanes");
    console.log("✓ the explicit reviewed operator path for central controls is preserved on the main workspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nlong-run-validation: all assertions passed");