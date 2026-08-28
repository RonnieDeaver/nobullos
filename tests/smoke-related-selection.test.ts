/* test-registration
{
  "name": "Related-only smoke gate selection engine (Task #3755)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small",
  "tierReason": "Deliberately small, overriding the unmeasured default of medium: the selection engine runs against temporary fixture repositories and bounded source graphs, with no database, browser, child process, or network."
}
test-registration */
/**
 * Task #3755 — Related-only smoke gate selection engine coverage.
 *
 * Drives tests/relatedSmokeSelection.ts against a throwaway fixture repo
 * (built under a mkdtemp root; the real repo's git state is never read) and
 * asserts every branch of the selection contract:
 *
 *   1.  Direct hit — the changed file IS a smoke test file.
 *   2.  Transitive hit — a changed file reached through an import chain.
 *   3.  Literal dynamic-import hit — `await import("./x")` edges are traced.
 *   4.  Alias hits — `@/` → client/src and `@shared/` → shared resolve.
 *   5.  Setup-file hit — a changed file reached only through a registered
 *       `--import ./tests/...-setup.mjs` hook's own import closure.
 *   6.  Global-trigger widening — e.g. migrations/ selects the FULL set.
 *   7.  Zero-match core fallback — unreached changes still run the
 *       always-run core, with a loud note.
 *   8.  Git failure → FULL (never silently zero).
 *   9.  Empty changed set → FULL (base-detection failure guard).
 *   10. Trace failure (unresolvable import) → FULL.
 *   11. Unattributable tests/ infrastructure change → FULL.
 *   12. computeChangedFiles against a REAL temp git repo: merge-base with
 *       main from a task branch + uncommitted + untracked union, and the
 *       SMOKE_RELATED_BASE override path.
 *
 * DB-free and network-free: only esbuild (in-process) and git (temp repo)
 * are exercised.
 *
 * Usage: npx tsx tests/smoke-related-selection.test.ts
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_ARTIFACT_OWNERSHIP,
  DEFAULT_CORE_RULES,
  DEFAULT_GLOBAL_TRIGGERS,
  computeChangedFiles,
  extraNodeArgsEntryFiles,
  formatSelectionSummary,
  makeGitRunner,
  matchGlobalTrigger,
  selectRelatedSmokeTests,
  verifyArtifactFreshness,
  writeSelectionManifest,
  type ArtifactFreshnessVerifier,
  type GitResult,
  type GitRunner,
  type ArtifactOwnershipContract,
  type SmokeTestEntry,
} from "./relatedSmokeSelection";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture repo (no git; git interactions are stubbed per scenario).
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "related-smoke-fixture-"));

function writeFixture(rel: string, content: string): void {
  const abs = join(ROOT, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

writeFixture("client/src/widget.tsx", `export const W = 1;\n`);
writeFixture("shared/helpers.ts", `export const H = 1;\n`);
writeFixture("server/thing.ts", `import { H } from "../shared/helpers";\nexport const T = H;\n`);
writeFixture("server/dyn-target.ts", `export const D = 1;\n`);
writeFixture(
  "server/dyn.ts",
  `export async function load(): Promise<unknown> {\n  return await import("./dyn-target");\n}\n`,
);
writeFixture("server/orphan.ts", `export const O = 1;\n`);
writeFixture("tests/direct.test.ts", `console.log("direct");\n`);
writeFixture("tests/transitive.test.ts", `import { T } from "../server/thing";\nconsole.log(T);\n`);
writeFixture("tests/dynamic.test.ts", `import { load } from "../server/dyn";\nvoid load();\n`);
writeFixture(
  "tests/alias.test.ts",
  `import { W } from "@/widget";\nimport { H } from "@shared/helpers";\nconsole.log(W, H);\n`,
);
writeFixture("tests/plain.test.ts", `console.log("plain");\n`);
writeFixture("tests/plain-setup.mjs", `import "../server/thing.ts";\n`);
writeFixture("tests/loose-stub.mjs", `export const stub = true;\n`);
writeFixture("tests/lint-guard.test.ts", `console.log("core lint guard fixture");\n`);
writeFixture(
  "tests/governor-eval-freshness.test.ts",
  `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst evidence = readFileSync(join(process.cwd(), "audits/architecture-governor-bootstrap-report.md"), "utf8");\nconsole.log(evidence);\n`,
);
writeFixture(
  "tests/comment-only-evidence.test.ts",
  `// audits/architecture-governor-bootstrap-report.md\nconsole.log("not a reader");\n`,
);
writeFixture(
  "tests/unused-evidence.test.ts",
  `const evidence = "audits/architecture-governor-bootstrap-report.md";\nconsole.log(evidence);\n`,
);
writeFixture("audits/architecture-governor-bootstrap-report.md", `# Governor bootstrap report\n`);
writeFixture("server/routes.ts", `export const routes = true;\n`);
writeFixture("server/routes/registered.ts", `export const registered = true;\n`);
writeFixture("server/services/contract-caller.ts", `export const contractServiceCaller = true;\n`);
writeFixture("tests/route-inventory.json", `[]\n`);
writeFixture("tests/route-inventory-report.md", `# route inventory\n`);
writeFixture("audits/D-endpoint-contract-table.json", `[]\n`);
writeFixture("audits/D-endpoint-contract-table.md", `# endpoint contract\n`);
writeFixture("audits/governance/test-portfolio-baseline.json", `{"facts":{}}\n`);
writeFixture(
  "tests/route-inventory.ts",
  `export const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n`,
);
writeFixture(
  "scripts/regen-route-inventory.mjs",
  `const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n`,
);
writeFixture(
  "scripts/lint-route-inventory-freshness.ts",
  `const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n`,
);
writeFixture(
  "scripts/generate-endpoint-contract-table.mjs",
  `const outputs = ["audits/D-endpoint-contract-table.md", "audits/D-endpoint-contract-table.json"];\n`,
);
writeFixture("scripts/contract-table-classifiers.mjs", `export const classify = true;\n`);
writeFixture(
  "scripts/generate-test-portfolio-baseline.ts",
  `const output = "audits/governance/test-portfolio-baseline.json";\n`,
);
writeFixture("scripts/governanceInventoryLib.ts", `export const stable = true;\n`);
writeFixture("tests/testRegistry.ts", `export const registry = true;\n`);
writeFixture(
  "scripts/lint-contract-table-freshness.ts",
  `const outputs = ["audits/D-endpoint-contract-table.md", "audits/D-endpoint-contract-table.json"];\n`,
);
writeFixture("tests/lint-route-inventory-freshness.test.ts", `console.log("route freshness");\n`);
writeFixture("tests/post-merge-route-inventory-refresh.test.ts", `console.log("route refresh");\n`);
writeFixture("tests/lint-contract-table-freshness.test.ts", `console.log("contract freshness");\n`);
writeFixture("tests/post-merge-generated-artifact-refresh.test.ts", `console.log("contract refresh");\n`);
writeFixture("tests/governance-test-portfolio-baseline.test.ts", `console.log("portfolio freshness");\n`);
writeFixture(
  "tests/artifact-import-consumer.test.ts",
  `import inventory from "./route-inventory.json";\nconsole.log(inventory);\n`,
);
writeFixture("tests/artifact-scan-consumer.test.ts", `console.log("artifact scan");\n`);

const UNIVERSE: SmokeTestEntry[] = [
  { file: "tests/direct.test.ts" },
  { file: "tests/transitive.test.ts" },
  { file: "tests/dynamic.test.ts" },
  { file: "tests/alias.test.ts" },
  { file: "tests/plain.test.ts", extraNodeArgs: ["--import", "./tests/plain-setup.mjs"] },
  { file: "tests/lint-guard.test.ts" },
];

const ARTIFACT_UNIVERSE: SmokeTestEntry[] = [
  ...UNIVERSE,
  { file: "tests/lint-route-inventory-freshness.test.ts" },
  { file: "tests/post-merge-route-inventory-refresh.test.ts" },
  { file: "tests/lint-contract-table-freshness.test.ts" },
  { file: "tests/post-merge-generated-artifact-refresh.test.ts" },
  { file: "tests/governance-test-portfolio-baseline.test.ts" },
  { file: "tests/artifact-import-consumer.test.ts" },
  { file: "tests/artifact-scan-consumer.test.ts", scanPaths: ["tests/route-inventory.json"] },
];

/** Git stub: branch=main, no origin/main, working-tree changes = `files`. */
function stubGit(files: string[]): GitRunner {
  return (args: string[]): GitResult => {
    const joined = args.join(" ");
    if (joined === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "main\n" };
    if (joined.startsWith("rev-parse --verify --quiet")) return { ok: false, stdout: "", error: "no such ref" };
    if (joined.startsWith("status --porcelain=v1")) {
      return { ok: true, stdout: files.map((f) => ` M ${f}\0`).join("") };
    }
    return { ok: false, stdout: "", error: `unexpected git call: ${joined}` };
  };
}

function selectWith(files: string[], universe: SmokeTestEntry[] = UNIVERSE) {
  return selectRelatedSmokeTests(universe, {
    repoRoot: ROOT,
    env: {},
    runGit: stubGit(files),
    // Generic import/scan-path cases intentionally exercise no generated
    // ownership records; ownership behavior has its dedicated fixture below.
    artifactOwnership: [],
  });
}

function selectWithOwnership(
  files: string[],
  ownership: ArtifactOwnershipContract[],
  universe: SmokeTestEntry[] = ARTIFACT_UNIVERSE,
  artifactFreshnessVerifier: ArtifactFreshnessVerifier = fixtureArtifactFreshnessVerifier,
) {
  return selectRelatedSmokeTests(universe, {
    repoRoot: ROOT,
    env: {},
    runGit: stubGit(files),
    artifactOwnership: ownership,
    artifactFreshnessVerifier,
  });
}

const fixtureArtifactFreshnessVerifier: ArtifactFreshnessVerifier = (owner) => {
  const expected =
    owner.id === "route-inventory"
      ? [
          ["tests/route-inventory.json", "[]\n"],
          ["tests/route-inventory-report.md", "# route inventory\n"],
        ]
      : owner.id === "endpoint-contract-table"
        ? [
            ["audits/D-endpoint-contract-table.json", "[]\n"],
            ["audits/D-endpoint-contract-table.md", "# endpoint contract\n"],
          ]
          : owner.id === "test-portfolio-baseline"
            ? [["audits/governance/test-portfolio-baseline.json", `{"facts":{}}\n`]]
            : [];
  const fresh = expected.length > 0 && expected.every(([path, value]) => readFileSync(join(ROOT, path), "utf8") === value);
  return fresh
    ? { ok: true, evidence: [`fixture freshness verified for ${owner.id}`], problems: [] }
    : { ok: false, evidence: [], problems: [`fixture artifact is stale for ${owner.id}`] };
};

function selectedFiles(manifest: Awaited<ReturnType<typeof selectRelatedSmokeTests>>): string[] {
  return manifest.selected.map((s) => s.file).sort();
}

function reasonOf(manifest: Awaited<ReturnType<typeof selectRelatedSmokeTests>>, file: string): string {
  return manifest.selected.find((s) => s.file === file)?.reason ?? "(not selected)";
}

async function main(): Promise<void> {
  // --- 1. Direct hit -------------------------------------------------------
  console.log("\n[1] direct hit: changed file is a smoke test file");
  {
    const m = await selectWith(["tests/direct.test.ts"]);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    check(
      "direct.test + core selected, nothing else",
      selectedFiles(m).join(",") === "tests/direct.test.ts,tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
    check("reason names the direct change", reasonOf(m, "tests/direct.test.ts") === "test file changed");
    check(
      "core reason labels the always-run rule",
      reasonOf(m, "tests/lint-guard.test.ts").startsWith("always-run core:"),
      reasonOf(m, "tests/lint-guard.test.ts"),
    );
    check("universe count reported", m.universeCount === UNIVERSE.length);
    check("skipped count = universe - selected", m.skippedCount === UNIVERSE.length - m.selectedCount);
    const summary = formatSelectionSummary(m);
    check(
      `summary states "selected N of M"`,
      summary[0].includes(`selected ${m.selectedCount} of ${m.universeCount} smoke test(s)`),
      summary[0],
    );
  }

  // --- 1b. scanPaths hit (Task #4103) --------------------------------------
  console.log("\n[1b] scanPaths hit: changed file matches a declared fs-scan input");
  {
    // Dedicated universe: plain.test.ts (no imports of orphan) declares
    // server/orphan.ts as a scanPath; changing orphan.ts must select it.
    const scanUniverse: SmokeTestEntry[] = [
      { file: "tests/direct.test.ts" },
      { file: "tests/plain.test.ts", scanPaths: ["server/orphan.ts"] },
      { file: "tests/lint-guard.test.ts" },
    ];
    const m = await selectWith(["server/orphan.ts"], scanUniverse);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    check(
      "scanPaths suite + core selected",
      selectedFiles(m).join(",") === "tests/lint-guard.test.ts,tests/plain.test.ts",
      selectedFiles(m).join(","),
    );
    check(
      "reason names the fs-scan hit",
      reasonOf(m, "tests/plain.test.ts").includes("fs-scans changed server/orphan.ts"),
      reasonOf(m, "tests/plain.test.ts"),
    );
    // Directory-prefix form: declaring "server" covers server/orphan.ts.
    const mDir = await selectWith(
      ["server/orphan.ts"],
      [{ file: "tests/plain.test.ts", scanPaths: ["server"] }, { file: "tests/lint-guard.test.ts" }],
    );
    check(
      "directory scanPath covers nested changed file",
      reasonOf(mDir, "tests/plain.test.ts").includes("declared scanPath server"),
      reasonOf(mDir, "tests/plain.test.ts"),
    );
  }
  {
    const auditEvidenceUniverse: SmokeTestEntry[] = [
      {
        file: "tests/governor-eval-freshness.test.ts",
        scanPaths: ["audits/architecture-governor-bootstrap-report.md"],
      },
      { file: "tests/plain.test.ts" },
      { file: "tests/lint-guard.test.ts" },
    ];
    const m = await selectWith(
      ["audits/architecture-governor-bootstrap-report.md"],
      auditEvidenceUniverse,
    );
    check("audit evidence update remains related-only", m.mode === "related", m.fullReason ?? "");
    check(
      "audit evidence update selects only Governor freshness guard plus core",
      selectedFiles(m).join(",") ===
        "tests/governor-eval-freshness.test.ts,tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
    check(
      "audit evidence selection reason names the declared scanPath",
      reasonOf(m, "tests/governor-eval-freshness.test.ts").includes(
        "declared scanPath audits/architecture-governor-bootstrap-report.md",
      ),
      reasonOf(m, "tests/governor-eval-freshness.test.ts"),
    );
    check(
      "audit evidence selection records the source-pinned reader",
      m.notes.some((note) =>
        note.includes(
          "VERIFIED authored evidence reader: audits/architecture-governor-bootstrap-report.md → tests/governor-eval-freshness.test.ts",
        ),
      ),
      JSON.stringify(m.notes),
    );
    for (const [label, file] of [
      ["comment-only", "tests/comment-only-evidence.test.ts"],
      ["unused-literal", "tests/unused-evidence.test.ts"],
    ] as const) {
      const unverified = await selectWith(
        ["audits/architecture-governor-bootstrap-report.md"],
        [{ file, scanPaths: ["audits/architecture-governor-bootstrap-report.md"] }],
      );
      check(
        `${label} audit evidence claim still defers centrally`,
        unverified.mode === "deferred" &&
          (unverified.deferredReason ?? "").includes("unknown generated artifact"),
        unverified.deferredReason ?? "",
      );
    }
  }

  // --- 2. Transitive + setup-file hits -------------------------------------
  console.log("\n[2] transitive hit through an import chain + setup-file hit");
  {
    const m = await selectWith(["shared/helpers.ts"]);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    // transitive.test.ts (via server/thing.ts), alias.test.ts (via @shared/helpers),
    // plain.test.ts (via plain-setup.mjs → server/thing.ts → helpers), + core.
    check(
      "transitive, alias, setup-carried and core tests selected",
      selectedFiles(m).join(",") ===
        "tests/alias.test.ts,tests/lint-guard.test.ts,tests/plain.test.ts,tests/transitive.test.ts",
      selectedFiles(m).join(","),
    );
    check(
      "transitive reason names the changed file",
      reasonOf(m, "tests/transitive.test.ts") === "imports changed shared/helpers.ts",
      reasonOf(m, "tests/transitive.test.ts"),
    );
    check(
      "setup-file reason names the hook and the changed file",
      reasonOf(m, "tests/plain.test.ts") === "setup tests/plain-setup.mjs imports changed shared/helpers.ts",
      reasonOf(m, "tests/plain.test.ts"),
    );
  }

  // --- 3. Literal dynamic-import hit ---------------------------------------
  console.log("\n[3] literal dynamic-import edge is traced");
  {
    const m = await selectWith(["server/dyn-target.ts"]);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    check(
      "dynamic.test selected via await import() target",
      selectedFiles(m).join(",") === "tests/dynamic.test.ts,tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
    check(
      "reason names the dynamically imported file",
      reasonOf(m, "tests/dynamic.test.ts") === "imports changed server/dyn-target.ts",
      reasonOf(m, "tests/dynamic.test.ts"),
    );
  }

  // --- 4. Alias resolution ---------------------------------------------------
  console.log("\n[4] @/ alias resolves to client/src");
  {
    const m = await selectWith(["client/src/widget.tsx"]);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    check(
      "alias.test selected via @/widget",
      selectedFiles(m).join(",") === "tests/alias.test.ts,tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
  }

  // --- 5. Global-trigger deferral -------------------------------------------
  console.log("\n[5] global-trigger paths defer broad coverage centrally");
  {
    const m = await selectWith(["migrations/0999_fixture.sql", "tests/direct.test.ts"]);
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason names the trigger",
      (m.deferredReason ?? "").includes("global trigger: migrations/0999_fixture.sql"),
      m.deferredReason ?? "",
    );
    check("central lane owns broad debt", m.deferredOwner === "post-merge/nightly/weekly", m.deferredOwner ?? "");
    check(
      "deferred result keeps directly changed test and core",
      selectedFiles(m).join(",") === "tests/direct.test.ts,tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
    const summary = formatSelectionSummary(m);
    check("summary names deferred central integrity", summary[0].includes("DEFERRED"), summary[0]);
  }

  // --- 6. Zero-match core fallback -------------------------------------------
  console.log("\n[6] zero related matches still run the always-run core, loudly");
  {
    const m = await selectWith(["server/orphan.ts"]);
    check("mode is related", m.mode === "related", m.fullReason ?? "");
    check(
      "only the core test selected",
      selectedFiles(m).join(",") === "tests/lint-guard.test.ts",
      selectedFiles(m).join(","),
    );
    check(
      "loud zero-match note present",
      m.notes.some((n) => n.startsWith("ZERO related matches")),
      JSON.stringify(m.notes),
    );
  }

  // --- 7. Git failure defers central coverage --------------------------------
  console.log("\n[7] git failure defers central coverage");
  {
    const m = await selectRelatedSmokeTests(UNIVERSE, {
      repoRoot: ROOT,
      env: {},
      runGit: () => ({ ok: false, stdout: "", error: "git unavailable (fixture)" }),
    });
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason explains the git failure",
      (m.deferredReason ?? "").includes("changed-file detection failed"),
      m.deferredReason ?? "",
    );
  }

  // --- 8. Empty changed set defers central coverage ---------------------------
  console.log("\n[8] empty changed set defers central coverage");
  {
    const m = await selectWith([]);
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason explains the empty-set refusal",
      (m.deferredReason ?? "").includes("empty changed-file set"),
      m.deferredReason ?? "",
    );
  }

  // --- 9. Trace failure defers central coverage -------------------------------
  console.log("\n[9] unresolvable import (trace failure) defers central coverage");
  {
    writeFixture("tests/broken.test.ts", `import "../server/does-not-exist";\n`);
    const m = await selectWith(["server/orphan.ts"], [...UNIVERSE, { file: "tests/broken.test.ts" }]);
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason names the esbuild trace failure",
      (m.deferredReason ?? "").includes("esbuild trace failed"),
      m.deferredReason ?? "",
    );
    rmSync(join(ROOT, "tests/broken.test.ts"), { force: true });
  }

  // --- 10. Unattributable tests/ infrastructure change → deferred -------------
  console.log("\n[10] changed tests/ infra file outside every closure defers centrally");
  {
    const m = await selectWith(["tests/loose-stub.mjs"]);
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason flags the unattributable file",
      (m.deferredReason ?? "").includes("unattributable test-infrastructure change: tests/loose-stub.mjs"),
      m.deferredReason ?? "",
    );
  }

  // --- 10b. Stalled tracer times out → FULL (Task #4560) -----------------------
  console.log("\n[10b] stalled import trace times out and defers central coverage");
  {
    // A tracer that never settles: only the Task #4560 timeout race can end
    // this call. The pending promise holds no live handle, so a hung test
    // here would mean the ref'd-timer contract broke (exit-13 note in
    // traceImportClosuresWithBudget).
    const stalledTracer = () => new Promise<never>(() => {});
    const started = Date.now();
    const m = await selectRelatedSmokeTests(UNIVERSE, {
      repoRoot: ROOT,
      env: {},
      runGit: stubGit(["shared/helpers.ts"]),
      traceTimeoutMs: 150,
      traceFn: stalledTracer as never,
    });
    check("mode is deferred", m.mode === "deferred", m.mode);
    check(
      "deferred reason names the trace timeout",
      (m.deferredReason ?? "").includes("import trace timed out"),
      m.deferredReason ?? "",
    );
    check("deferred trace result retains the core", m.selectedCount === 1, String(m.selectedCount));
    check("returned promptly after the budget, not the tracer", Date.now() - started < 5_000);
    // Env-default path: SMOKE_RELATED_TRACE_TIMEOUT_MS is honored when no
    // explicit traceTimeoutMs is injected.
    const mEnv = await selectRelatedSmokeTests(UNIVERSE, {
      repoRoot: ROOT,
      env: { SMOKE_RELATED_TRACE_TIMEOUT_MS: "150" },
      runGit: stubGit(["shared/helpers.ts"]),
      traceFn: stalledTracer as never,
    });
    check(
      "env-configured budget also defers centrally",
      mEnv.mode === "deferred" && (mEnv.deferredReason ?? "").includes("timed out"),
      mEnv.deferredReason ?? "",
    );
    // A FAST injected tracer must not be affected by the budget: the real
    // tracer through the same seam keeps the related path intact.
    const mReal = await selectWith(["shared/helpers.ts"]);
    check("fast trace under the same budget stays related", mReal.mode === "related", mReal.fullReason ?? "");

    // A REJECTING tracer must defer promptly (helper normalizes it to a
    // trace failure) and must not retain the timeout handle — the process
    // would otherwise stay alive for the full budget after a crash.
    const rejectStart = Date.now();
    const mReject = await selectRelatedSmokeTests(UNIVERSE, {
      repoRoot: ROOT,
      env: {},
      runGit: stubGit(["shared/helpers.ts"]),
      traceTimeoutMs: 60_000,
      traceFn: (() => Promise.reject(new Error("esbuild exploded"))) as never,
    });
    check("rejecting tracer → deferred", mReject.mode === "deferred", mReject.mode);
    check(
      "rejecting tracer reason names the crash",
      (mReject.deferredReason ?? "").includes("import trace crashed"),
      mReject.deferredReason ?? "",
    );
    check("rejecting tracer returns promptly (timer cleared, not awaited)", Date.now() - rejectStart < 5_000);

    // A SYNCHRONOUSLY THROWING tracer takes the same deferred path.
    const mThrow = await selectRelatedSmokeTests(UNIVERSE, {
      repoRoot: ROOT,
      env: {},
      runGit: stubGit(["shared/helpers.ts"]),
      traceTimeoutMs: 60_000,
      traceFn: (() => {
        throw new Error("sync boom");
      }) as never,
    });
    check(
      "throwing tracer → deferred",
      mThrow.mode === "deferred" && (mThrow.deferredReason ?? "").includes("crashed"),
      mThrow.deferredReason ?? "",
    );
  }

  // --- 10c. Verified generated-artifact ownership ------------------------------
  console.log("\n[10c] verified generated-artifact ownership stays precise");
  {
    const owners: ArtifactOwnershipContract[] = DEFAULT_ARTIFACT_OWNERSHIP.map((owner) => ({
      ...owner,
      artifactPaths: [...owner.artifactPaths],
      generatorPaths: [...owner.generatorPaths],
      inputPaths: owner.inputPaths.map((input) => ({ ...input })),
      freshnessGuardPaths: [...owner.freshnessGuardPaths],
      guardSuites: [...owner.guardSuites],
    }));

    const routeOutput = await selectWithOwnership(["tests/route-inventory.json"], owners);
    check("route inventory output selects related mode", routeOutput.mode === "related", routeOutput.fullReason ?? "");
    check(
      "route inventory output selects route and dependent contract guards",
      [
        "tests/lint-route-inventory-freshness.test.ts",
        "tests/post-merge-route-inventory-refresh.test.ts",
        "tests/lint-contract-table-freshness.test.ts",
        "tests/post-merge-generated-artifact-refresh.test.ts",
      ].every((file) => selectedFiles(routeOutput).includes(file)),
      selectedFiles(routeOutput).join(","),
    );
    check(
      "route inventory output records verified ownership evidence",
      routeOutput.notes.some((note) => note.includes("VERIFIED artifact ownership: route-inventory")),
      JSON.stringify(routeOutput.notes),
    );
    check(
      "artifact output retains normal closure and scanPath selections",
      ["tests/artifact-import-consumer.test.ts", "tests/artifact-scan-consumer.test.ts"].every((file) =>
        selectedFiles(routeOutput).includes(file),
      ),
      selectedFiles(routeOutput).join(","),
    );
    check(
      "closure and scanPath reasons remain specific alongside ownership",
      reasonOf(routeOutput, "tests/artifact-import-consumer.test.ts").includes("imports changed") &&
        reasonOf(routeOutput, "tests/artifact-scan-consumer.test.ts").includes("declared scanPath"),
      `${reasonOf(routeOutput, "tests/artifact-import-consumer.test.ts")} / ${reasonOf(routeOutput, "tests/artifact-scan-consumer.test.ts")}`,
    );

    const endpointOutput = await selectWithOwnership(["audits/D-endpoint-contract-table.json"], owners);
    check("endpoint contract output selects related mode", endpointOutput.mode === "related", endpointOutput.fullReason ?? "");
    check(
      "endpoint contract output selects its named freshness and refresh guards",
      ["tests/lint-contract-table-freshness.test.ts", "tests/post-merge-generated-artifact-refresh.test.ts"].every(
        (file) => selectedFiles(endpointOutput).includes(file),
      ),
      selectedFiles(endpointOutput).join(","),
    );

    const portfolioOutput = await selectWithOwnership(
      ["audits/governance/test-portfolio-baseline.json"],
      owners,
    );
    check(
      "test portfolio output selects related mode",
      portfolioOutput.mode === "related",
      portfolioOutput.fullReason ?? "",
    );
    check(
      "test portfolio output selects its named freshness guard",
      selectedFiles(portfolioOutput).includes("tests/governance-test-portfolio-baseline.test.ts"),
      selectedFiles(portfolioOutput).join(","),
    );
    check(
      "test portfolio output records verified ownership evidence",
      portfolioOutput.notes.some((note) => note.includes("VERIFIED artifact ownership: test-portfolio-baseline")),
      JSON.stringify(portfolioOutput.notes),
    );

    const routeInput = await selectWithOwnership(["server/routes/registered.ts"], owners);
    check(
      "route generator input propagates to dependent contract guards without widening",
      routeInput.mode === "related" &&
        [
          "tests/lint-route-inventory-freshness.test.ts",
          "tests/post-merge-route-inventory-refresh.test.ts",
          "tests/lint-contract-table-freshness.test.ts",
          "tests/post-merge-generated-artifact-refresh.test.ts",
        ].every((file) => selectedFiles(routeInput).includes(file)),
      routeInput.fullReason ?? selectedFiles(routeInput).join(","),
    );

    const endpointInput = await selectWithOwnership(["scripts/generate-endpoint-contract-table.mjs"], owners);
    check(
      "endpoint generator input selects endpoint guards without widening",
      endpointInput.mode === "related" &&
        ["tests/lint-contract-table-freshness.test.ts", "tests/post-merge-generated-artifact-refresh.test.ts"].every(
          (file) => selectedFiles(endpointInput).includes(file),
        ),
      endpointInput.fullReason ?? selectedFiles(endpointInput).join(","),
    );
    check(
      "normal core suites remain selected alongside ownership guards",
      selectedFiles(endpointInput).includes("tests/lint-guard.test.ts"),
      selectedFiles(endpointInput).join(","),
    );

    const missingOwner = await selectWithOwnership(["tests/route-inventory.json"], []);
    check(
      "missing ownership record defers centrally",
      missingOwner.mode === "deferred" && (missingOwner.deferredReason ?? "").includes("unknown generated artifact"),
      missingOwner.deferredReason ?? "",
    );

    const unknownOutput = await selectWithOwnership(["audits/new-generated-output.json"], owners);
    check(
      "unknown generated output defers centrally",
      unknownOutput.mode === "deferred" && (unknownOutput.deferredReason ?? "").includes("unknown generated artifact"),
      unknownOutput.deferredReason ?? "",
    );
    const unpinnedEvidenceClaim = await selectWithOwnership(
      ["audits/new-generated-output.json"],
      owners,
      [{ file: "tests/plain.test.ts", scanPaths: ["audits/new-generated-output.json"] }],
    );
    check(
      "registration-only audit evidence claim still defers centrally",
      unpinnedEvidenceClaim.mode === "deferred" &&
        (unpinnedEvidenceClaim.deferredReason ?? "").includes("unknown generated artifact"),
      unpinnedEvidenceClaim.deferredReason ?? "",
    );

    const malformedOwner = owners.map((owner) =>
      owner.id === "route-inventory"
        ? { ...owner, generatorPaths: ["scripts/missing-route-generator.mjs"] }
        : owner,
    );
    const malformed = await selectWithOwnership(["tests/route-inventory.json"], malformedOwner);
    check(
      "malformed ownership mapping defers centrally",
      malformed.mode === "deferred" && (malformed.deferredReason ?? "").includes("ownership verification failed"),
      malformed.deferredReason ?? "",
    );

    const ambiguousOwners = [
      ...owners,
      {
        ...owners[0],
        id: "route-inventory-shadow",
        guardSuites: ["tests/route-shadow-guard.test.ts"],
      },
    ];
    const ambiguous = await selectWithOwnership(["tests/route-inventory.json"], ambiguousOwners);
    check(
      "ambiguous artifact ownership defers centrally",
      ambiguous.mode === "deferred" && (ambiguous.deferredReason ?? "").includes("ownership contract is ambiguous"),
      ambiguous.deferredReason ?? "",
    );

    rmSync(join(ROOT, "tests/route-inventory-report.md"), { force: true });
    const missingArtifact = await selectWithOwnership(["tests/route-inventory.json"], owners);
    check(
      "missing generated artifact defers centrally",
      missingArtifact.mode === "deferred" && (missingArtifact.deferredReason ?? "").includes("missing or unreadable"),
      missingArtifact.deferredReason ?? "",
    );
    writeFixture("tests/route-inventory-report.md", `# route inventory\n`);

    writeFixture("scripts/regen-route-inventory.mjs", `const stale = true;\n`);
    const stale = await selectWithOwnership(["tests/route-inventory.json"], owners);
    check(
      "stale ownership evidence defers centrally",
      stale.mode === "deferred" && (stale.deferredReason ?? "").includes("ownership verification failed"),
      stale.deferredReason ?? "",
    );
    writeFixture(
      "scripts/regen-route-inventory.mjs",
      `const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n`,
    );

    writeFixture("tests/route-inventory.json", `[{"stale":true}]\n`);
    const staleArtifact = await selectWithOwnership(["tests/route-inventory.json"], owners);
    check(
      "valid but stale generated artifact defers centrally",
      staleArtifact.mode === "deferred" && (staleArtifact.deferredReason ?? "").includes("freshness verification failed"),
      staleArtifact.deferredReason ?? "",
    );

    writeFixture("tests/route-inventory.json", `{ malformed\n`);
    const malformedArtifact = await selectWithOwnership(["tests/route-inventory.json"], owners);
    check(
      "malformed generated artifact defers centrally",
      malformedArtifact.mode === "deferred" && (malformedArtifact.deferredReason ?? "").includes("malformed JSON"),
      malformedArtifact.deferredReason ?? "",
    );
    writeFixture("tests/route-inventory.json", `[]\n`);

    const productionFreshness = await Promise.all(
      DEFAULT_ARTIFACT_OWNERSHIP.map((owner) => verifyArtifactFreshness(owner, process.cwd())),
    );
    check(
      "production ownership records invoke their real freshness guards",
      productionFreshness.every((result) => result.ok && result.evidence.some((e) => e.includes("freshness verified"))),
      JSON.stringify(productionFreshness),
    );
  }

  // --- 11. Production default rules sanity -------------------------------------
  console.log("\n[11] production default trigger/core rules");
  {
    // Task #3789: scripts/ is no longer one blanket prefix trigger — only
    // harness-relevant scripts widen to the full set; one-off backfill or
    // analysis scripts flow through normal import tracing.
    check("scripts/gate.ts is a global trigger", matchGlobalTrigger("scripts/gate.ts", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check(
      "the gate's lint worker is a global trigger",
      matchGlobalTrigger("scripts/gate-lint-worker.mjs", DEFAULT_GLOBAL_TRIGGERS) !== null,
    );
    check(
      "lint scripts are global triggers",
      matchGlobalTrigger("scripts/lint-sql-array-bindings.ts", DEFAULT_GLOBAL_TRIGGERS) !== null,
    );
    check(
      "lint baselines are global triggers",
      matchGlobalTrigger("scripts/lint-getdb-attribution.baseline.txt", DEFAULT_GLOBAL_TRIGGERS) !== null,
    );
    check("predeploy.sh is a global trigger", matchGlobalTrigger("scripts/predeploy.sh", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check("post-merge.sh is a global trigger", matchGlobalTrigger("scripts/post-merge.sh", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check(
      "one-off backfill/analysis scripts are NOT global triggers (Task #3789)",
      matchGlobalTrigger("scripts/backfill-front-coverage.ts", DEFAULT_GLOBAL_TRIGGERS) === null,
    );
    check("tests/run-all.ts is a global trigger", matchGlobalTrigger("tests/run-all.ts", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check(
      "the selector itself is a global trigger",
      matchGlobalTrigger("tests/relatedSmokeSelection.ts", DEFAULT_GLOBAL_TRIGGERS) !== null,
    );
    check("tsconfig.tests.json is a global trigger", matchGlobalTrigger("tsconfig.tests.json", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check("shared/schema.ts is a global trigger", matchGlobalTrigger("shared/schema.ts", DEFAULT_GLOBAL_TRIGGERS) !== null);
    check("ordinary source files are not triggers", matchGlobalTrigger("client/src/pages/Home.tsx", DEFAULT_GLOBAL_TRIGGERS) === null);
    const lintCore = DEFAULT_CORE_RULES.some(
      (r) => r.kind === "pattern" && new RegExp(r.value).test("tests/lint-unbounded-caches.test.ts"),
    );
    check("lint-*.test.ts files match the core pattern", lintCore);
    const selfCore = DEFAULT_CORE_RULES.some((r) => r.kind === "exact" && r.value === "tests/smoke-related-selection.test.ts");
    check("this test is in the always-run core", selfCore);
    check(
      "extraNodeArgs entry extraction picks local hook files only",
      extraNodeArgsEntryFiles(["--import", "./tests/x-setup.mjs", "--no-warnings"]).join(",") === "tests/x-setup.mjs",
      extraNodeArgsEntryFiles(["--import", "./tests/x-setup.mjs", "--no-warnings"]).join(","),
    );
  }

  // --- 12. Real git repo: base resolution + working-tree union ------------------
  console.log("\n[12] computeChangedFiles against a real temp git repo");
  {
    const gitRoot = mkdtempSync(join(tmpdir(), "related-smoke-git-"));
    const git = (...args: string[]) => {
      const res = spawnSync("git", args, { cwd: gitRoot, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
      return res.stdout;
    };
    try {
      git("init", "--initial-branch=main");
      git("config", "user.email", "fixture@example.com");
      git("config", "user.name", "Fixture");
      writeFileSync(join(gitRoot, "f1.ts"), "export const A = 1;\n");
      git("add", ".");
      git("commit", "-m", "base");
      git("checkout", "-b", "task-branch");
      writeFileSync(join(gitRoot, "f2.ts"), "export const B = 2;\n");
      git("add", "f2.ts");
      git("commit", "-m", "branch work");
      writeFileSync(join(gitRoot, "f1.ts"), "export const A = 11;\n"); // uncommitted edit
      writeFileSync(join(gitRoot, "f3.ts"), "export const C = 3;\n"); // untracked

      const runGit = makeGitRunner(gitRoot);
      const changed = computeChangedFiles(runGit, {});
      check("real-git detection succeeds", changed.ok, changed.error ?? "");
      check(
        "committed + uncommitted + untracked all captured",
        changed.files.join(",") === "f1.ts,f2.ts,f3.ts",
        changed.files.join(","),
      );
      check(
        "base description names merge-base with main",
        changed.baseDescription.includes("merge-base with main"),
        changed.baseDescription,
      );

      const viaEnv = computeChangedFiles(runGit, { SMOKE_RELATED_BASE: "main" });
      check("SMOKE_RELATED_BASE override succeeds", viaEnv.ok, viaEnv.error ?? "");
      check("override yields the same changed set", viaEnv.files.join(",") === "f1.ts,f2.ts,f3.ts", viaEnv.files.join(","));
      check(
        "override is reflected in the base description",
        viaEnv.baseDescription.includes("SMOKE_RELATED_BASE=main"),
        viaEnv.baseDescription,
      );

      const badBase = computeChangedFiles(runGit, { SMOKE_RELATED_BASE: "no-such-ref" });
      check("invalid SMOKE_RELATED_BASE fails closed (→ full)", !badBase.ok, JSON.stringify(badBase));
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
    }
  }

  // --- 13. Manifest write --------------------------------------------------------
  console.log("\n[13] machine-readable manifest write");
  {
    const m = await selectWith(["tests/direct.test.ts"]);
    const outPath = join(ROOT, "out", "manifest.json");
    check("manifest write succeeds", writeSelectionManifest(m, outPath));
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    check("manifest round-trips with schemaVersion 1", parsed.schemaVersion === 1 && parsed.mode === "related");
    check(
      "manifest carries per-test reasons",
      Array.isArray(parsed.selected) && parsed.selected.every((s: { file?: string; reason?: string }) => s.file && s.reason),
    );
    check("manifest records the changed files", parsed.changedFiles.join(",") === "tests/direct.test.ts");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke-related-selection.test.ts crashed:", err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
