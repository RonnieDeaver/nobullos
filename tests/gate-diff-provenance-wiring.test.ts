/* test-registration
{
  "name": "Gate auto-wired diff-provenance step: exactly-once call, report shape, never-fails contract (Task #5317)",
  "smoke": true,
  "smokeReason": "Guards the gate's automatic diff-provenance evidence step (scripts/gate.ts recordGateDiffProvenance) — a regression here would either silently stop writing the completion-review rebuttal evidence every gate run is supposed to produce, or (far worse) let that best-effort step start affecting the gate verdict. DB-free and fast.",
  "regression": true,
  "tier": "small",
  "tierReason": "DB-free, no server/browser/timers/network; four in-process calls to the extracted wiring function against mkdtemp-scoped files complete in well under a second despite the file's line count."
}
test-registration */
// fs-scan-fixture-only -- every fs read/write in this file targets files this
// test itself creates under mkdtempSync(tmpdir()); no live repo source is
// fs-read (the compute() calls it drives are injected fakes or, in one case,
// the real buildProvenanceReport, which reads repo source via git subprocess
// calls, not fs reads, and is already covered by tests/diff-provenance.test.ts)
/**
 * Task #5317 — `scripts/gate.ts` now calls Task #5316's live diff-provenance
 * tool (`buildProvenanceReport` from `scripts/diffProvenanceLib.ts`) once at
 * the end of every gate run and writes the result to the well-known
 * `.local/runs/gate-diff-provenance.json`, purely as best-effort evidence.
 * This test exercises the extracted wiring function,
 * `recordGateDiffProvenance`, directly (same pattern as
 * tests/gate-lint-phase.test.ts driving `runLintPhase` directly) rather than
 * spawning a full `npm run gate`, and proves the three contractual
 * properties the task requires:
 *   1. the provenance-computation function is called exactly once per call
 *      to the wiring step (never zero, never retried/duplicated);
 *   2. a real report — using the actual `buildProvenanceReport` default —
 *      is written to disk with the expected shape;
 *   3. an injected THROWING compute function never escapes the wiring step
 *      (proving the "never fails the gate" contract) and never writes a
 *      corrupt/partial report file;
 *   4. critically, a failure — whether compute() throwing or the write/
 *      rename step itself failing — never leaves a STALE pre-existing report
 *      sitting at the target path where a later reviewer could mistake old
 *      evidence for fresh (the write is temp-file-then-rename, and any
 *      failure path removes whatever currently sits at the target).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordGateDiffProvenance } from "../scripts/gate.ts";
import { buildProvenanceReport, type ProvenanceReport } from "../scripts/diffProvenanceLib.ts";

let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function withCapturedConsole<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gate-diff-provenance-wiring-"));

  console.log("1) calls the injected compute function exactly once");
  {
    let calls = 0;
    const fakeReport: ProvenanceReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      repoRoot: "/fake",
      head: "deadbeef",
      error: null,
      baseResolution: "head",
      upstreamTip: "deadbeef",
      upstreamTipSubject: "fake subject",
      taskDiffFiles: ["a.ts", "b.ts"],
      flaggedFiles: [],
    };
    const reportPath = join(dir, "once.json");
    const { lines } = withCapturedConsole(() => {
      recordGateDiffProvenance((opts) => {
        calls++;
        ok(opts.repoRoot.length > 0, "compute is invoked with a non-empty repoRoot");
        ok(Array.isArray(opts.flaggedPaths) && opts.flaggedPaths.length === 0, "compute is invoked with no flagged paths (surface-only)");
        return fakeReport;
      }, reportPath);
    });
    ok(calls === 1, "the compute function is called exactly once");
    ok(existsSync(reportPath), "a report file is written");
    const written = JSON.parse(readFileSync(reportPath, "utf8")) as ProvenanceReport; // fs-scan-inputs-ignore -- reads back the file recordGateDiffProvenance just wrote under this test's own mkdtempSync(tmpdir()) dir; never repo source
    ok(written.schemaVersion === 1, "written report carries schemaVersion 1");
    ok(
      JSON.stringify(written.taskDiffFiles) === JSON.stringify(fakeReport.taskDiffFiles),
      "written report's taskDiffFiles matches exactly what compute returned",
    );
    ok(
      lines.some((l) => l.includes(".local/runs/gate-diff-provenance.json")),
      "prints a pointer line naming the well-known report path",
    );
    ok(
      lines.some((l) => l.toLowerCase().includes("unrelated changes")),
      "pointer line explains when to reach for the evidence (unrelated-changes challenge)",
    );
  }

  console.log("\n2) a throwing compute function never escapes, and leaves no STALE report behind");
  {
    const reportPath = join(dir, "throws.json");
    // Prepopulate the target with a stale report from an earlier, unrelated
    // run — the exact scenario a reviewer could be misled by if this failure
    // path didn't clean up after itself.
    writeFileSync(reportPath, JSON.stringify({ stale: "evidence from an earlier run" }), "utf8");
    let threw = false;
    let calls = 0;
    try {
      recordGateDiffProvenance(() => {
        calls++;
        throw new Error("synthetic provenance-computation failure");
      }, reportPath);
    } catch {
      threw = true;
    }
    ok(!threw, "recordGateDiffProvenance never throws, even when compute() throws");
    ok(calls === 1, "the throwing compute function was still called exactly once before being caught");
    ok(!existsSync(reportPath), "the pre-existing STALE report is removed, not left behind, when compute() throws");
  }

  console.log("\n3) a write failure (bad path) also degrades to silence, not a throw");
  {
    let threw = false;
    // A path nested under an existing FILE (not a directory) can never be
    // mkdir'd into — mkdirSync throws ENOTDIR, which recordGateDiffProvenance
    // must swallow just like a throwing compute().
    const blockerFile = join(dir, "blocker-not-a-dir");
    writeFileSync(blockerFile, "not a directory", "utf8");
    const bogusPath = join(blockerFile, "nested", "report.json");
    try {
      recordGateDiffProvenance(() => ({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        repoRoot: "/fake",
        head: "deadbeef",
        error: null,
        baseResolution: "head",
        upstreamTip: "deadbeef",
        upstreamTipSubject: "fake subject",
        taskDiffFiles: [],
        flaggedFiles: [],
      }), bogusPath);
    } catch {
      threw = true;
    }
    ok(!threw, "recordGateDiffProvenance never throws even when the write itself fails");
  }

  console.log("\n4) a write-phase failure also leaves no STALE report behind (not just compute failures)");
  {
    const reportPath = join(dir, "write-fails-stale.json");
    // Prepopulate the target with a stale report from an earlier run.
    writeFileSync(reportPath, JSON.stringify({ stale: "evidence from an earlier run" }), "utf8");
    // recordGateDiffProvenance writes to `${reportPath}.${process.pid}.tmp`
    // before renaming it into place. Pre-creating that exact temp path as a
    // DIRECTORY forces the write step itself to fail (EISDIR) — structurally,
    // not via permissions — while leaving compute() free to succeed, so this
    // exercises the write/rename failure branch specifically, distinct from
    // test 2's compute-throws branch.
    const predictedTmpPath = `${reportPath}.${process.pid}.tmp`;
    mkdirSync(predictedTmpPath);
    let threw = false;
    let calls = 0;
    try {
      recordGateDiffProvenance((opts) => {
        calls++;
        return {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          repoRoot: opts.repoRoot,
          head: "deadbeef",
          error: null,
          baseResolution: "head",
          upstreamTip: "deadbeef",
          upstreamTipSubject: "fake subject",
          taskDiffFiles: [],
          flaggedFiles: [],
        };
      }, reportPath);
    } catch {
      threw = true;
    }
    ok(!threw, "recordGateDiffProvenance never throws even when the write/rename step fails");
    ok(calls === 1, "compute() still ran exactly once before the write step failed");
    ok(!existsSync(reportPath), "the pre-existing STALE report is removed, not left behind, when the write step fails");
  }

  console.log("\n5) the real buildProvenanceReport default produces a well-shaped report");
  {
    const reportPath = join(dir, "real.json");
    recordGateDiffProvenance(buildProvenanceReport, reportPath);
    ok(existsSync(reportPath), "the real default compute function writes a report");
    const written = JSON.parse(readFileSync(reportPath, "utf8")) as ProvenanceReport; // fs-scan-inputs-ignore -- reads back the file recordGateDiffProvenance just wrote under this test's own mkdtempSync(tmpdir()) dir; never repo source
    ok(written.schemaVersion === 1, "real report carries schemaVersion 1");
    ok(typeof written.head === "string" && written.head.length > 0, "real report names HEAD");
    ok(Array.isArray(written.taskDiffFiles), "real report's taskDiffFiles is an array");
    ok(Array.isArray(written.flaggedFiles) && written.flaggedFiles.length === 0, "real report has no flagged files (wiring never passes any)");
    ok(
      written.error !== undefined,
      "real report always has an (possibly-null) error field per the ProvenanceReport shape",
    );
  }

  rmSync(dir, { recursive: true, force: true });

  if (failed === 0) {
    console.log("\ngate-diff-provenance-wiring: all assertions passed");
    process.exit(0);
  }
  console.error(`\ngate-diff-provenance-wiring: ${failed} assertion(s) FAILED`);
  process.exit(1);
}

main().catch((err) => {
  console.error("gate-diff-provenance-wiring: crashed:", err);
  process.exit(1);
});
