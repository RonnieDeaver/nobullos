/* test-registration
{
  "name": "Completion-rebase conflict triage classifier/planner (Task #4553)",
  "regression": true,
  "smoke": true,
  "scanPaths": ["scripts/rebase-conflict-triage.ts", "COMPLETION_REBASE_TRIAGE.md", "RUNBOOKS.md", ".gitattributes"],
  "smokeReason": "Task #4553: the triage helper encodes the take-a-side-then-regenerate convention for every committed generated artifact during completion-rebase rounds. Spec drift vs the canonical generator specs (ARTIFACTS / INVENTORY_PATHS / BASELINE_RELPATH) or a lost fall-open rule would silently mis-resolve conflicts at the worst possible moment (mid-completion). Pure fixture-driven unit tests + lockstep imports + source-scan wiring checks: no DB, no network, no live git.",
  "tier": "small"
}
test-registration */
/**
 * Guard test for the Task #4553 completion-rebase conflict triage tooling.
 *
 * Proves:
 *   1. `git ls-files -u -z` parsing (stage → base/ours/theirs flags).
 *   2. Classification: every generated-artifact family path maps to its
 *      family; memory index, lockfile, memory topic files, L3 control-plane
 *      surfaces and unknown paths classify correctly; one-side-deleted
 *      conflicts are never auto-resolvable.
 *   3. Planning: per-family regen dedupe, dependency ordering (route
 *      inventory before the endpoint contract table), the cascade rule
 *      (inventory conflict forces a contract-table regen), and the blanket
 *      deferral rule when residual source conflicts remain.
 *   4. Fall-open: unknown conflicts are never auto-resolved (autoResolvable
 *      false ⇒ residual), and the executor records them in the round report.
 *   5. Lockstep with the canonical generator specs: the family table
 *      mirrors ARTIFACTS (post-merge-generated-artifact-refresh),
 *      INVENTORY_PATHS (post-merge-route-inventory-refresh) and
 *      BASELINE_RELPATH (designContractRatchet) byte-for-byte.
 *   6. Wiring: executor imports the pure lib, writes reports under
 *      .local/runs/rebase-triage, invokes verify-merge-integrity (which owns
 *      the typecheck — no second `npm run check`), never `git commit`s;
 *      runbook exists, is indexed in RUNBOOKS.md, and the memory-index class
 *      still has its `.gitattributes merge=union` backing.
 *   7. --verify fails CLOSED: a stale clean integrity report can never be
 *      attributed to the current invocation (prior report deleted pre-spawn,
 *      mtime freshness gate, child exit status retained) — a verifier that
 *      dies before writing yields exit 1 / verify-failed, never verify-clean.
 *
 * No live git: all fixtures are synthetic path sets; --verify cases inject
 * every dependency (unmerged listing, repo-operation probe, verifier spawn,
 * report sink) and touch only an os.tmpdir() scratch directory.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_FAMILIES,
  L3_CONTROL_PLANE_PATHS,
  LOCKFILE_PATH,
  MEMORY_INDEX_PATH,
  classifyPath,
  detectMode,
  parseLsFilesUnmergedZ,
  planTriage,
  upstreamSideFor,
  type UnmergedPath,
} from "../scripts/rebaseConflictTriageLib";
import { parseArgs, ROUND_REPORT_DIR, runVerify } from "../scripts/rebase-conflict-triage";
import { ARTIFACTS } from "../scripts/post-merge-generated-artifact-refresh";
import { INVENTORY_PATHS } from "../scripts/post-merge-route-inventory-refresh";
import { BASELINE_RELPATH } from "../scripts/designContractRatchet";

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

function both(path: string): UnmergedPath {
  return { path, hasBase: true, hasOurs: true, hasTheirs: true };
}

function main(): void {
  // 1. ls-files -u -z parsing -------------------------------------------
  {
    const sha = "a".repeat(40);
    const raw =
      `100644 ${sha} 1\ttests/route-inventory.json\0` +
      `100644 ${sha} 2\ttests/route-inventory.json\0` +
      `100644 ${sha} 3\ttests/route-inventory.json\0` +
      `100644 ${sha} 2\tboth-added.txt\0` +
      `100644 ${sha} 3\tboth-added.txt\0` +
      `100644 ${sha} 1\tdeleted-by-them.txt\0` +
      `100644 ${sha} 2\tdeleted-by-them.txt\0`;
    const parsed = parseLsFilesUnmergedZ(raw);
    assert(parsed.length === 3, "parses three distinct unmerged paths");
    const inv = parsed.find((p) => p.path === "tests/route-inventory.json");
    assert(
      inv !== undefined && inv.hasBase && inv.hasOurs && inv.hasTheirs,
      "both-modified path has all three stages",
    );
    const added = parsed.find((p) => p.path === "both-added.txt");
    assert(
      added !== undefined && !added.hasBase && added.hasOurs && added.hasTheirs,
      "both-added path lacks the base stage",
    );
    const del = parsed.find((p) => p.path === "deleted-by-them.txt");
    assert(
      del !== undefined && del.hasBase && del.hasOurs && !del.hasTheirs,
      "deleted-by-them path lacks stage 3",
    );
    assert(parseLsFilesUnmergedZ("").length === 0, "empty output parses to zero paths");
  }

  // 2. Classification -----------------------------------------------------
  {
    for (const family of ARTIFACT_FAMILIES) {
      const probe = family.exactPaths?.[0] ?? `${family.pathPrefix}deep/file.js`;
      const c = classifyPath(both(probe));
      assert(
        c.classId === "generated-artifact" && c.familyId === family.id && c.autoResolvable,
        `${probe} → generated-artifact:${family.id} (auto-resolvable)`,
      );
    }
    const website = classifyPath(both("website/public/js/home.js")); // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
    assert(
      website.classId === "generated-artifact" && website.familyId === "website-bundle",
      "nested website/public path matches the website-bundle prefix",
    );
    const mem = classifyPath(both(MEMORY_INDEX_PATH));
    assert(
      mem.classId === "memory-index" && mem.autoResolvable,
      "MEMORY.md → memory-index (union-mergeable)",
    );
    const topic = classifyPath(both(".agents/memory/some-topic.md"));
    assert(
      topic.classId === "source" && !topic.autoResolvable && /topic/i.test(topic.reason),
      "memory TOPIC file → source/manual (union covers only the index)",
    );
    const lock = classifyPath(both(LOCKFILE_PATH));
    assert(lock.classId === "lockfile" && lock.autoResolvable, "package-lock.json → lockfile");
    for (const l3 of [
      "tests/green-baseline.json",
      "tests/red-manifest.json",
      "scripts/gate.ts", // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
      "tests/run-all.ts",
    ]) {
      const c = classifyPath(both(l3));
      assert(
        c.classId === "source" && !c.autoResolvable && /L3/.test(c.reason),
        `${l3} → source/manual with explicit L3 never-auto reason`,
      );
      assert(
        L3_CONTROL_PLANE_PATHS.includes(l3),
        `${l3} is in the L3 control-plane list`,
      );
    }
    const unknown = classifyPath(both("server/services/foo.ts")); // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
    assert(
      unknown.classId === "source" && !unknown.autoResolvable,
      "unknown path → source/manual (fall-open, never auto-resolved)",
    );
    const halfDeleted = classifyPath({
      path: "tests/route-inventory.json",
      hasBase: true,
      hasOurs: true,
      hasTheirs: false,
    });
    assert(
      halfDeleted.classId === "generated-artifact" && !halfDeleted.autoResolvable,
      "one-side-deleted artifact is NOT auto-resolvable (regen could resurrect a retirement)",
    );
  }

  // 3. Planning: dedupe, ordering, cascade, deferral -----------------------
  {
    // Scenario A: purely mechanical round.
    const planA = planTriage([
      both("tests/route-inventory.json"),
      both("tests/route-inventory-report.md"),
      both("audits/governance/async-topology.json"),
    ]);
    assert(planA.residual.length === 0 && !planA.deferRegens, "mechanical-only round is not deferred");
    assert(
      planA.regens.filter((r) => r.familyId === "route-inventory").length === 1,
      "two conflicted inventory paths dedupe to ONE route-inventory regen",
    );
    const cascade = planA.regens.find((r) => r.familyId === "endpoint-contract-table");
    assert(
      cascade !== undefined &&
        cascade.trigger === "cascade" &&
        cascade.triggeredBy.includes("route-inventory"),
      "route-inventory regen cascades an endpoint-contract-table regen",
    );
    const invIdx = planA.regens.findIndex((r) => r.familyId === "route-inventory");
    const tblIdx = planA.regens.findIndex((r) => r.familyId === "endpoint-contract-table");
    assert(
      invIdx !== -1 && tblIdx !== -1 && invIdx < tblIdx,
      "route inventory regen is ordered BEFORE the contract table (table is generated FROM it)",
    );
    const orders = planA.regens.map((r) => r.order);
    assert(
      orders.every((o, i) => i === 0 || orders[i - 1] <= o),
      "regens are sorted ascending by dependency order",
    );

    // Scenario B: contract table alone does NOT drag the inventory in.
    const planB = planTriage([both("audits/D-endpoint-contract-table.md")]);
    assert(
      planB.regens.length === 1 &&
        planB.regens[0].familyId === "endpoint-contract-table" &&
        planB.regens[0].trigger === "conflicted",
      "contract-table-only conflict plans exactly one conflicted-trigger regen",
    );

    // Scenario C: mixed round defers all regens.
    const planC = planTriage([
      both("server/services/foo.ts"), // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
      both("website/public/a.js"), // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
      both("website/public/assets/b.css"), // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
      both(LOCKFILE_PATH),
      both(MEMORY_INDEX_PATH),
    ]);
    assert(planC.deferRegens, "residual source conflict defers ALL regens (marker-laden tree)");
    assert(
      planC.residual.length === 1 && planC.residual[0].path === "server/services/foo.ts", // fs-scan-inputs-ignore -- synthetic classifier fixture path, never fs-read
      "residual list contains exactly the genuine source conflict",
    );
    assert(
      planC.regens.filter((r) => r.familyId === "website-bundle").length === 1,
      "multiple website/public paths dedupe to ONE website regen",
    );
    assert(
      planC.memoryUnionPaths.length === 1 && planC.lockfilePaths.length === 1,
      "memory-index union and lockfile reinstall are planned",
    );

    // Scenario D: every family fires at once, still one regen per family.
    const allPaths: UnmergedPath[] = [
      ...ARTIFACT_FAMILIES.flatMap((f) =>
        f.exactPaths ? f.exactPaths.map(both) : [both(`${f.pathPrefix}bundle.js`)],
      ),
    ];
    const planD = planTriage(allPaths);
    assert(
      planD.regens.length === ARTIFACT_FAMILIES.length,
      "all-families round plans exactly one regen per family",
    );
    assert(
      planD.regens.every((r) => r.trigger === "conflicted"),
      "no cascade entries when every family conflicted directly",
    );
  }

  // 4. Lockstep with the canonical generator specs --------------------------
  {
    for (const spec of ARTIFACTS) {
      const family = ARTIFACT_FAMILIES.find((f) => f.id === spec.name);
      assert(family !== undefined, `family exists for canonical artifact spec "${spec.name}"`);
      if (!family) continue;
      assert(
        family.regenCommand === spec.regenCommand &&
          family.regenArgv.join(" ") === spec.regenArgv.join(" "),
        `${spec.name}: regen command/argv match the canonical spec (${spec.regenCommand})`,
      );
      if (spec.name === "website-bundle") {
        assert(
          family.pathPrefix === "website/public/" && // fs-scan-inputs-ignore -- prefix constant compared against the canonical spec, never fs-read
            family.stagePaths.join(",") === spec.paths.join(","),
          "website-bundle family covers the website/public prefix and stages the spec paths",
        );
      } else {
        assert(
          [...(family.exactPaths ?? [])].sort().join(",") === [...spec.paths].sort().join(","),
          `${spec.name}: family paths equal the canonical spec paths`,
        );
      }
    }
    const invFamily = ARTIFACT_FAMILIES.find((f) => f.id === "route-inventory");
    assert(
      invFamily !== undefined &&
        [...(invFamily.exactPaths ?? [])].sort().join(",") ===
          [...INVENTORY_PATHS].sort().join(","),
      "route-inventory family paths equal INVENTORY_PATHS from the post-merge refresh hook",
    );
    assert(
      invFamily !== undefined &&
        invFamily.regenArgv.join(" ") === "npx tsx scripts/regen-route-inventory.mjs",
      "route-inventory regen argv is the sanctioned regen-route-inventory.mjs invocation",
    );
    const designFamily = ARTIFACT_FAMILIES.find((f) => f.id === "design-contract-baseline");
    assert(
      designFamily !== undefined &&
        (designFamily.exactPaths ?? []).includes(BASELINE_RELPATH),
      "design-contract-baseline family covers BASELINE_RELPATH (sole-writer regen script)",
    );
    const tbl = ARTIFACT_FAMILIES.find((f) => f.id === "endpoint-contract-table");
    const inv = ARTIFACT_FAMILIES.find((f) => f.id === "route-inventory");
    assert(
      tbl !== undefined &&
        inv !== undefined &&
        (tbl.regenAlsoWhen ?? []).includes("route-inventory") &&
        inv.order < tbl.order,
      "contract table declares its dependency on route-inventory and orders after it",
    );
  }

  // 5. Mode/side helpers ----------------------------------------------------
  {
    assert(
      detectMode({ rebaseMergeDir: true, rebaseApplyDir: false, mergeHead: false }) === "rebase" &&
        detectMode({ rebaseMergeDir: false, rebaseApplyDir: true, mergeHead: false }) === "rebase" &&
        detectMode({ rebaseMergeDir: false, rebaseApplyDir: false, mergeHead: true }) === "merge" &&
        detectMode({ rebaseMergeDir: false, rebaseApplyDir: false, mergeHead: false }) === "none",
      "detectMode maps git-dir markers to rebase/merge/none",
    );
    assert(
      upstreamSideFor("rebase") === "ours" && upstreamSideFor("merge") === "theirs",
      "upstream side is --ours mid-rebase and --theirs mid-merge",
    );
  }

  // 6. Executor arg parsing ---------------------------------------------------
  {
    assert(parseArgs(["--dry-run"]).dryRun && parseArgs(["--verify"]).verify, "flags parse");
    assert(parseArgs(["--side", "ours"]).side === "ours", "--side ours parses");
    assert(parseArgs(["--side", "upstream"]).error !== null, "--side rejects non-ours/theirs values");
    assert(parseArgs(["--frobnicate"]).error !== null, "unknown arguments are rejected");
  }

  // 7. Wiring: executor source, runbook, index row, gitattributes ------------
  {
    const cli = readFileSync("scripts/rebase-conflict-triage.ts", "utf-8");
    assert(
      cli.includes('from "./rebaseConflictTriageLib"'),
      "executor imports the pure decision lib",
    );
    assert(
      ROUND_REPORT_DIR === ".local/runs/rebase-triage" && cli.includes(ROUND_REPORT_DIR),
      "round reports land under .local/runs/rebase-triage",
    );
    assert(
      cli.includes("scripts/verify-merge-integrity.ts"), // fs-scan-inputs-ignore -- substring assert against already-declared executor source, never fs-read
      "--verify invokes the existing merge-integrity verifier",
    );
    assert(
      !cli.includes('"run", "check"') && !cli.includes("'run', 'check'"),
      "no second bare typecheck spawn (verify-merge-integrity owns `npm run check`)",
    );
    assert(
      cli.includes('git(["commit"') === false && cli.includes('["git", "commit"') === false,
      "executor never commits — mid-rebase resolution is stage-only",
    );
    assert(
      cli.includes("residualManual"),
      "round report records residual/fell-open-to-manual conflicts",
    );
    assert(
      cli.includes('"npm", "install"') || cli.includes('["npm", "install"'),
      "lockfile class reinstalls via npm install (never merges the lockfile)",
    );

    const runbook = readFileSync("COMPLETION_REBASE_TRIAGE.md", "utf-8");
    assert(
      runbook.includes("scripts/rebase-conflict-triage.ts") &&
        runbook.includes("--verify") &&
        runbook.includes("`Validate` workflow"),
      "runbook covers the triage command, the integrity pass and Validate workflow revalidation",
    );
    assert(
      /quiesce/i.test(runbook) && /green-skip/i.test(runbook),
      "runbook covers quiesce and the unchanged incremental green-skip revalidation",
    );

    const runbooksIndex = readFileSync("RUNBOOKS.md", "utf-8");
    assert(
      /\|\s*\[COMPLETION_REBASE_TRIAGE\.md\]\(\.\/COMPLETION_REBASE_TRIAGE\.md\)\s*\|/.test(
        runbooksIndex,
      ),
      "RUNBOOKS.md Runbook Index has the COMPLETION_REBASE_TRIAGE.md row (coverage lint contract)",
    );

    const gitattributes = readFileSync(".gitattributes", "utf-8");
    assert(
      /\.agents\/memory\/MEMORY\.md\s+merge=union/.test(gitattributes),
      ".gitattributes still union-merges the memory index (memory-index class backing)",
    );
  }

  // 8. --verify fail-closed freshness gate ------------------------------------
  // A stale clean merge-integrity report must never produce verify-clean when
  // the verifier fails or never writes a fresh report for THIS invocation.
  {
    const tmpBase = mkdtempSync(join(tmpdir(), "triage-verify-"));
    const reports: Array<Record<string, unknown>> = [];
    const lastReport = (): Record<string, unknown> => reports[reports.length - 1]!;
    const cleanReportJson = JSON.stringify({
      kind: "not-a-merge",
      smearedFiles: [],
      typecheck: { ran: true, exitCode: 0, errorFilesNotTaskTouched: [] },
      warnings: [],
    });
    const baseDeps = {
      listUnmergedFn: () => [],
      detectRepoOperationFn: () => "none" as const,
      writeRoundReportFn: (r: unknown): string => {
        reports.push(r as Record<string, unknown>);
        return "(test-sink)";
      },
    };
    try {
      // (a) stale clean report + verifier failure without replacement.
      const p1 = join(tmpBase, "a-merge-integrity.json");
      writeFileSync(p1, cleanReportJson);
      const code1 = runVerify({
        ...baseDeps,
        integrityReportPath: p1,
        spawnVerifier: () => ({ status: 1 }),
      });
      assert(
        code1 === 1 && lastReport().outcome === "verify-failed",
        "stale clean report + failing verifier without replacement ⇒ exit 1 / verify-failed",
      );
      assert(!existsSync(p1), "prior integrity report is deleted before the verifier spawns");
      const integ1 = lastReport().integrity as { verifierRan: boolean; warnings: string[] };
      assert(
        integ1.verifierRan === false &&
          integ1.warnings.some((w) => w.includes("failing closed")),
        "fail-closed reason is recorded in the round report",
      );

      // (b) verifier exits 0 but never writes a report ⇒ still fail closed.
      const p2 = join(tmpBase, "b-merge-integrity.json");
      writeFileSync(p2, cleanReportJson);
      const code2 = runVerify({
        ...baseDeps,
        integrityReportPath: p2,
        spawnVerifier: () => ({ status: 0 }),
      });
      assert(
        code2 === 1 && lastReport().outcome === "verify-failed",
        "verifier exit 0 with no freshly written report ⇒ exit 1 / verify-failed",
      );

      // (c) report present after spawn but with a pre-spawn mtime ⇒ stale.
      const p3 = join(tmpBase, "c-merge-integrity.json");
      const staleEpochSec = (Date.now() - 3_600_000) / 1000;
      const code3 = runVerify({
        ...baseDeps,
        integrityReportPath: p3,
        spawnVerifier: () => {
          writeFileSync(p3, cleanReportJson);
          utimesSync(p3, staleEpochSec, staleEpochSec);
          return { status: 0 };
        },
      });
      assert(
        code3 === 1 && lastReport().outcome === "verify-failed",
        "clean-parsing report with a pre-spawn mtime ⇒ exit 1 / verify-failed (mtime gate)",
      );

      // (d) fresh clean report but non-zero child ⇒ child signal retained.
      const p4 = join(tmpBase, "d-merge-integrity.json");
      const code4 = runVerify({
        ...baseDeps,
        integrityReportPath: p4,
        spawnVerifier: () => {
          writeFileSync(p4, cleanReportJson);
          return { status: 1 };
        },
      });
      assert(
        code4 === 1 && lastReport().outcome === "verify-failed",
        "fresh clean report but verifier child exited non-zero ⇒ exit 1 (child signal retained)",
      );

      // (e) happy control: fresh clean report + exit 0 ⇒ verify-clean.
      const p5 = join(tmpBase, "e-merge-integrity.json");
      const code5 = runVerify({
        ...baseDeps,
        integrityReportPath: p5,
        spawnVerifier: () => {
          writeFileSync(p5, cleanReportJson);
          return { status: 0 };
        },
      });
      assert(
        code5 === 0 && lastReport().outcome === "verify-clean",
        "freshly written clean report + verifier exit 0 ⇒ exit 0 / verify-clean (control)",
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  console.log(`\nrebase-conflict-triage guard: passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main();
