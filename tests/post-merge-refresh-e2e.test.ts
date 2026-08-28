/* test-registration
{
  "name": "Post-merge artifact auto-refresh — real-git end-to-end proof (Task #4135)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4135: the Task #4111/#4115 post-merge auto-refresh hooks were only proven with fully-mocked deps (tests/post-merge-generated-artifact-refresh.test.ts, tests/post-merge-route-inventory-refresh.test.ts) — nothing exercised the real decision core against a real git repo. This guard builds a synthetic real-git fixture (temp repo, real git init/add/commit, no global config, no network) and drives the REAL refreshRouteInventoryIfStale/refreshArtifactIfStale exports against it with real fs-based lint/regen and real git commits, proving staleness is actually detected, regenerated, committed in dependency order, and — for a genuine source bug regen cannot fix — that the failure is loud-but-non-fatal and the run continues to the next phase, exactly like scripts/post-merge.sh. Builds tiny synthetic git repos in tmpdir (git CLI only): no DB, no network.",
  "tier": "small",
  "tierReason": "Unmeasured suites default to the mechanical 'medium' classification, but this is a DB-free, network-free, browser-free suite: both cases build a tiny synthetic git repo in mkdtemp and shell out to the git CLI only (same shape as tests/diff-provenance.test.ts and tests/merge-integrity.test.ts), completing in a couple of seconds."
}
test-registration */
// fs-scan-fixture-only -- reads/writes only inside mkdtemp git fixture repos created by this test; never touches real repo source.
/**
 * Task #4135 — Real end-to-end proof for the post-merge generated-artifact
 * auto-refresh hooks (Task #4111 route-inventory + Task #4115 generalized
 * artifact refresh).
 *
 * The existing decision-core unit tests (tests/post-merge-route-inventory-
 * refresh.test.ts, tests/post-merge-generated-artifact-refresh.test.ts)
 * exercise refreshRouteInventoryIfStale()/refreshArtifactIfStale() with
 * fully-mocked lint/regen/commit deps — proof of control flow, not proof
 * that the hooks actually repair staleness against real git state. This
 * file complements (does not replace) those tests by driving the same REAL,
 * unmodified exported decision-core functions against a synthetic temp git
 * repo seeded with a minimal, self-contained analog of the real artifact
 * chain:
 *
 *   src/fixture-routes.ts  (routes source, analog of server/routes/**)
 *     -> generated/route-inventory.json + route-inventory-report.md
 *        (analog of tests/route-inventory.json, via refreshRouteInventoryIfStale)
 *     -> generated/contract-table.json + .md
 *        (analog of audits/D-endpoint-contract-table.*, derived FROM the
 *        inventory — proves the #4115 dependency ordering — via
 *        refreshArtifactIfStale)
 *   src/website-input.txt -> generated/bundle-manifest.json
 *     (light analog of website/public's input-fingerprint stamp, covered
 *     for consistency only — its dedicated freshness lint has its own
 *     coverage elsewhere)
 *
 * The lint/regen functions below are fixture-scale re-implementations of
 * the real freshness-check/generate shape (the real ones are tied to the
 * actual server/routes and client/tests corpus and cannot be sandboxed
 * without duplicating the whole app tree); the git commit step is REAL —
 * real `git add` / `git diff --cached --quiet` / `git commit --no-verify
 * --only`, scoped via `-c user.name=`/`user.email=` with no global git
 * config, mirroring scripts/post-merge-route-inventory-refresh.ts's and
 * scripts/post-merge-generated-artifact-refresh.ts's realCommit() byte-for-
 * byte (those functions are private and not cwd-parametrized, so this test
 * reimplements the identical git invocation scoped to the fixture repo
 * rather than calling them directly).
 *
 * Proves, against real git history/diffs and real file contents (not
 * mocked deps):
 *   1. A known-stale post-merge state (source changed, generated artifacts
 *      not regenerated) gets detected, regenerated, and committed by the
 *      REAL refreshRouteInventoryIfStale(), then the REAL
 *      refreshArtifactIfStale() regenerates the contract table FROM the
 *      just-committed (fresh) inventory — proving the dependency ordering
 *      actually holds end-to-end, not just asserted via mocked call order.
 *   2. Each commit touches ONLY its own artifact paths (git diff-tree
 *      name-only), and the repo ends fully fresh (every fixture lint
 *      passes afterward).
 *   3. A genuine source-level bug (duplicate route registration, the
 *      documented "regen cannot fix it" case) makes the real script exit
 *      non-zero after still committing the best-effort regenerated
 *      artifacts — and a thin stand-in for post-merge.sh's `cmd || { warn;
 *      }` calling convention proceeds to the next phase rather than
 *      aborting the run, exactly as scripts/post-merge.sh:299-331 does.
 *
 * Corroborating (not primary) evidence: this environment's own
 * .local/runs/post-merge-history.jsonl already shows ~200 real post-merge
 * runs completing both the route-inventory-refresh and
 * generated-artifact-refresh phases at exit 0 across real merges — this
 * test is what proves the self-heal path actually REPAIRS staleness rather
 * than just running its "nothing to do" fast path every time.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshRouteInventoryIfStale,
  type RefreshDeps as RouteRefreshDeps,
  type RefreshResult as RouteRefreshResult,
} from "../scripts/post-merge-route-inventory-refresh";
import type { RouteInventoryLintResult } from "../scripts/lint-route-inventory-freshness";
import {
  refreshArtifactIfStale,
  type ArtifactSpec,
  type RefreshDeps as ArtifactRefreshDeps,
  type RefreshResult as ArtifactRefreshResult,
  type FreshnessLintResult,
} from "../scripts/post-merge-generated-artifact-refresh";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Synthetic real-git fixture helpers (same conventions as
// tests/merge-integrity.test.ts: scoped identity, no global config).
// ---------------------------------------------------------------------------

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

function initFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "post-merge-refresh-e2e-"));
  git(root, "init", "-q", "-b", "main");
  return root;
}

function commitFiles(root: string, ref = "HEAD"): string[] {
  return execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", ref], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function commitSubject(root: string, ref = "HEAD"): string {
  return execFileSync("git", ["log", "-1", "--format=%s", ref], { cwd: root, encoding: "utf8" }).trim();
}

/**
 * Real git commit, scoped to `root`, mirroring realCommit() in both
 * production refresh scripts byte-for-byte: `git add -- <paths>`, a
 * `git diff --cached --quiet` staged check, then `git commit --no-verify
 * --only -- <paths>` with inline (never global) identity flags.
 */
function makeFixtureCommit(
  root: string,
  paths: readonly string[],
  message: string,
): () => "committed" | "nothing-to-commit" | "failed" {
  return () => {
    const add = spawnSync("git", ["add", "--", ...paths], { cwd: root, encoding: "utf8" });
    if (add.status !== 0) return "failed";
    const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...paths], {
      cwd: root,
      encoding: "utf8",
    });
    if (staged.status === 0) return "nothing-to-commit"; // exit 0 = nothing staged
    const commit = spawnSync(
      "git",
      [
        "-c",
        "user.name=post-merge-e2e-fixture",
        "-c",
        "user.email=post-merge-e2e-fixture@example.com",
        "commit",
        "--no-verify",
        "-m",
        message,
        "--only",
        "--",
        ...paths,
      ],
      { cwd: root, encoding: "utf8" },
    );
    return commit.status === 0 ? "committed" : "failed";
  };
}

function makeLogger() {
  const logs: string[] = [];
  return { logs, log: (l: string) => logs.push(l) };
}

// ---------------------------------------------------------------------------
// Fixture artifact chain: routes source -> inventory -> contract table
// (dependency chain, mirrors #4115) + a light website-bundle analog.
// ---------------------------------------------------------------------------

interface FixtureRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

const ROUTE_LINE_RE = /^\s*app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/;
const ROUTES_SRC = "src/fixture-routes.ts";
const INV_JSON = "generated/route-inventory.json";
const INV_REPORT = "generated/route-inventory-report.md";
const CONTRACT_JSON = "generated/contract-table.json";
const CONTRACT_MD = "generated/contract-table.md";
const BUNDLE_INPUT = "src/website-input.txt";
const BUNDLE_STAMP = "generated/bundle-manifest.json";

function writeRoutesSource(root: string, lines: string[]): void {
  mkdirSync(join(root, "src"), { recursive: true });
  const content = ["// Fixture Express-style route registrations.", ...lines, ""].join("\n");
  writeFileSync(join(root, ROUTES_SRC), content);
}

function parseFixtureRoutes(root: string): FixtureRoute[] {
  const text = readFileSync(join(root, ROUTES_SRC), "utf8"); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
  const routes: FixtureRoute[] = [];
  text.split("\n").forEach((line, idx) => {
    const m = line.match(ROUTE_LINE_RE);
    if (m) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], file: ROUTES_SRC, line: idx + 1 });
    }
  });
  return routes;
}

/** Fixture analog of lint-route-inventory-freshness.ts's runLint(). */
function fixtureInventoryLint(root: string): RouteInventoryLintResult {
  const fresh = parseFixtureRoutes(root);
  const problems: string[] = [];

  const seen = new Map<string, FixtureRoute>();
  for (const r of fresh) {
    const key = `${r.method} ${r.path}`;
    const prior = seen.get(key);
    if (prior) {
      problems.push(
        `duplicate live registration for ${key}: ${prior.file}:${prior.line} wins at dispatch; ` +
          `${r.file}:${r.line} is dead code`,
      );
    } else {
      seen.set(key, r);
    }
  }

  const jsonPath = join(root, INV_JSON);
  let committedCount: number | null = null;
  if (!existsSync(jsonPath)) {
    problems.push(`${INV_JSON} is missing`);
  } else {
    const committed: FixtureRoute[] = JSON.parse(readFileSync(jsonPath, "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    committedCount = committed.length;
    if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
      problems.push(`${INV_JSON} is STALE — committed ${committed.length} route(s), fresh scan finds ${fresh.length}`);
    }
  }

  const reportPath = join(root, INV_REPORT);
  if (!existsSync(reportPath)) {
    problems.push(`${INV_REPORT} is missing`);
  } else {
    const report = readFileSync(reportPath, "utf8"); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    const m = report.match(/^Total routes discovered: (\d+)$/m);
    if (!m || Number(m[1]) !== fresh.length) {
      problems.push(`${INV_REPORT} header count mismatch`);
    }
  }

  return { ok: problems.length === 0, freshCount: fresh.length, committedCount, problems };
}

function fixtureRegenInventory(root: string): boolean {
  try {
    const fresh = parseFixtureRoutes(root);
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, INV_JSON), JSON.stringify(fresh, null, 2) + "\n");
    writeFileSync(
      join(root, INV_REPORT),
      `# Fixture Route Inventory\n\nTotal routes discovered: ${fresh.length}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

interface ContractRow {
  method: string;
  path: string;
  handler: string;
}

function deriveContractRows(inventory: FixtureRoute[]): ContractRow[] {
  return inventory.map((r) => ({ method: r.method, path: r.path, handler: `${r.file}:${r.line}` }));
}

/** Fixture analog of lint-contract-table-freshness.ts — derives from the COMMITTED inventory, never the source. */
function fixtureContractLint(root: string): FreshnessLintResult {
  const invPath = join(root, INV_JSON);
  if (!existsSync(invPath)) {
    return { ok: false, problems: [`${INV_JSON} missing — cannot derive contract table`] };
  }
  const inventory: FixtureRoute[] = JSON.parse(readFileSync(invPath, "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
  const freshRows = deriveContractRows(inventory);

  const problems: string[] = [];
  const jsonPath = join(root, CONTRACT_JSON);
  if (!existsSync(jsonPath)) {
    problems.push(`${CONTRACT_JSON} is missing`);
  } else {
    const committed = JSON.parse(readFileSync(jsonPath, "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    if (JSON.stringify(committed) !== JSON.stringify(freshRows)) {
      problems.push(`${CONTRACT_JSON} is STALE relative to the committed route inventory`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function fixtureRegenContractTable(root: string): boolean {
  try {
    const invPath = join(root, INV_JSON);
    if (!existsSync(invPath)) return false;
    const inventory: FixtureRoute[] = JSON.parse(readFileSync(invPath, "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    const rows = deriveContractRows(inventory);
    mkdirSync(join(root, "generated"), { recursive: true });
    const md = [
      "# Fixture Contract Table",
      "",
      "| Method | Path | Handler |",
      "|---|---|---|",
      ...rows.map((r) => `| ${r.method} | ${r.path} | ${r.handler} |`),
      "",
    ].join("\n");
    writeFileSync(join(root, CONTRACT_MD), md);
    writeFileSync(join(root, CONTRACT_JSON), JSON.stringify(rows, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Light website-bundle analog: input-fingerprint stamp, covered for consistency only. */
function fixtureBundleLint(root: string): FreshnessLintResult {
  const inputPath = join(root, BUNDLE_INPUT);
  if (!existsSync(inputPath)) return { ok: false, problems: [`${BUNDLE_INPUT} missing`] };
  const freshHash = createHash("sha256").update(readFileSync(inputPath, "utf8")).digest("hex"); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
  const stampPath = join(root, BUNDLE_STAMP);
  if (!existsSync(stampPath)) return { ok: false, problems: [`${BUNDLE_STAMP} missing`] };
  const stamp = JSON.parse(readFileSync(stampPath, "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
  if (stamp.inputHash !== freshHash) {
    return { ok: false, problems: [`${BUNDLE_STAMP} inputHash is stale relative to ${BUNDLE_INPUT}`] };
  }
  return { ok: true, problems: [] };
}

function fixtureRegenBundle(root: string): boolean {
  try {
    const inputPath = join(root, BUNDLE_INPUT);
    const freshHash = createHash("sha256").update(readFileSync(inputPath, "utf8")).digest("hex"); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, BUNDLE_STAMP), JSON.stringify({ inputHash: freshHash }, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin stand-in for scripts/post-merge.sh's `cmd || { ec=$?; echo "!!! WARN
 * ..."; }` calling convention: every phase runs regardless of the previous
 * phase's exit code; a non-zero exit is recorded as a loud warning, never
 * aborts the loop.
 */
function runLikePostMergeSh<T extends { exitCode: 0 | 1 }>(
  phases: Array<{ name: string; run: () => T }>,
): { ranPhases: string[]; warnings: string[]; results: T[] } {
  const ranPhases: string[] = [];
  const warnings: string[] = [];
  const results: T[] = [];
  for (const phase of phases) {
    ranPhases.push(phase.name);
    const result = phase.run();
    results.push(result);
    if (result.exitCode !== 0) {
      warnings.push(`!!! WARN: ${phase.name} needs attention — see output above.`);
    }
  }
  return { ranPhases, warnings, results };
}

// ---------------------------------------------------------------------------
// 1. Regen-and-commit proof: real decision core + real git, dependency
//    ordering, commits scoped to their own paths, fully fresh at the end.
// ---------------------------------------------------------------------------

test("real refresh scripts detect merge-shifted staleness, regen+commit in dependency order, end fully fresh", () => {
  const root = initFixtureRepo();
  try {
    // Base state: one route, everything generated fresh, all committed.
    writeRoutesSource(root, ['app.get("/api/ping", pingHandler);']);
    writeFileSync(join(root, BUNDLE_INPUT), "hello v1\n");
    assert.ok(fixtureRegenInventory(root));
    assert.ok(fixtureRegenContractTable(root));
    assert.ok(fixtureRegenBundle(root));
    commitAll(root, "base: fresh fixture chain");

    // Simulate the merge landing (Task #4111's failure mode): source gains a
    // new route; nobody regenerated the committed artifacts.
    writeRoutesSource(root, [
      'app.get("/api/ping", pingHandler);',
      'app.post("/api/widgets", createWidget);',
    ]);
    commitAll(root, "merge: source gains /api/widgets (generated artifacts not regenerated)");

    const before = fixtureInventoryLint(root);
    assert.equal(before.ok, false, "precondition: inventory is stale immediately after the simulated merge");
    const contractBefore = fixtureContractLint(root);
    assert.equal(
      contractBefore.ok,
      true,
      "precondition: contract table still matches the (stale) committed inventory — only the source has drifted so far",
    );

    // --- Phase 1: real refreshRouteInventoryIfStale(), real git commit. ---
    const routeLogger = makeLogger();
    const routeDeps: RouteRefreshDeps = {
      lint: () => fixtureInventoryLint(root),
      regen: () => fixtureRegenInventory(root),
      commit: makeFixtureCommit(root, [INV_JSON, INV_REPORT], "post-merge: fixture auto-regenerate route inventory"),
      log: routeLogger.log,
    };
    const routeResult: RouteRefreshResult = refreshRouteInventoryIfStale(routeDeps);
    assert.equal(routeResult.outcome, "refreshed-committed", "route-inventory: regen + commit path");
    assert.equal(routeResult.exitCode, 0);
    assert.ok(routeLogger.logs.length > 0, "route-inventory: decision core logged something");

    assert.equal(
      commitSubject(root),
      "post-merge: fixture auto-regenerate route inventory",
      "route-inventory refresh produced a REAL git commit with the expected subject",
    );
    assert.deepEqual(
      commitFiles(root),
      [INV_JSON, INV_REPORT].sort(),
      "route-inventory commit touches ONLY the inventory artifact paths",
    );

    const inventoryAfterPhase1: FixtureRoute[] = JSON.parse(readFileSync(join(root, INV_JSON), "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    assert.equal(inventoryAfterPhase1.length, 2, "regenerated inventory now includes the merge-added route");
    assert.equal(fixtureInventoryLint(root).ok, true, "route-inventory is fresh again after phase 1");

    // The #4115 cascading-staleness proof: committing the fresh inventory
    // immediately stales the (unchanged) contract table.
    assert.equal(
      fixtureContractLint(root).ok,
      false,
      "contract table is now stale AS A RESULT of the inventory commit (Task #4115's documented cascade)",
    );

    // --- Phase 2: real refreshArtifactIfStale() for the contract table. ---
    const contractLogger = makeLogger();
    const contractSpec: ArtifactSpec = {
      name: "fixture-contract-table",
      paths: [CONTRACT_MD, CONTRACT_JSON],
      regenCommand: "fixture-regen-contract-table",
      commitMessage: "post-merge: fixture auto-regenerate contract table",
    };
    const contractDeps: ArtifactRefreshDeps = {
      lint: () => fixtureContractLint(root),
      regen: () => fixtureRegenContractTable(root),
      commit: makeFixtureCommit(root, contractSpec.paths, contractSpec.commitMessage),
      log: contractLogger.log,
    };
    const contractResult: ArtifactRefreshResult = refreshArtifactIfStale(contractSpec, contractDeps);
    assert.equal(contractResult.outcome, "refreshed-committed", "contract-table: regen + commit path");
    assert.equal(contractResult.exitCode, 0);

    assert.equal(
      commitSubject(root),
      "post-merge: fixture auto-regenerate contract table",
      "contract-table refresh produced a REAL git commit with the expected subject",
    );
    assert.deepEqual(
      commitFiles(root),
      [CONTRACT_MD, CONTRACT_JSON].sort(),
      "contract-table commit touches ONLY the contract-table artifact paths",
    );

    // Dependency-ordering proof: the freshly committed contract table
    // reflects the route added in phase 1 — it was derived from the
    // POST-refresh inventory, not a stale cached read.
    const contractAfterPhase2 = JSON.parse(readFileSync(join(root, CONTRACT_JSON), "utf8")) as ContractRow[]; // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    assert.ok(
      contractAfterPhase2.some((r) => r.path === "/api/widgets"),
      "contract table was derived from the FRESHLY COMMITTED inventory (dependency ordering held end-to-end)",
    );
    assert.equal(fixtureContractLint(root).ok, true, "contract table is fresh again after phase 2");

    // --- Phase 3 (light, for consistency): the website-bundle analog. ---
    writeFileSync(join(root, BUNDLE_INPUT), "hello v2 — merge-shifted content\n");
    commitAll(root, "merge: website-bundle input changed (bundle not regenerated)");
    assert.equal(fixtureBundleLint(root).ok, false, "precondition: bundle stamp is stale after its input changed");

    const bundleSpec: ArtifactSpec = {
      name: "fixture-website-bundle",
      paths: [BUNDLE_STAMP],
      regenCommand: "fixture-regen-bundle",
      commitMessage: "post-merge: fixture auto-regenerate website bundle",
    };
    const bundleDeps: ArtifactRefreshDeps = {
      lint: () => fixtureBundleLint(root),
      regen: () => fixtureRegenBundle(root),
      commit: makeFixtureCommit(root, bundleSpec.paths, bundleSpec.commitMessage),
      log: () => {},
    };
    const bundleResult = refreshArtifactIfStale(bundleSpec, bundleDeps);
    assert.equal(bundleResult.outcome, "refreshed-committed", "website-bundle analog: regen + commit path");
    assert.equal(bundleResult.exitCode, 0);
    assert.deepEqual(commitFiles(root), [BUNDLE_STAMP], "website-bundle commit touches ONLY its own stamp path");

    // Final state: every fixture artifact is fresh.
    assert.equal(fixtureInventoryLint(root).ok, true, "final: route inventory fresh");
    assert.equal(fixtureContractLint(root).ok, true, "final: contract table fresh");
    assert.equal(fixtureBundleLint(root).ok, true, "final: website-bundle analog fresh");

    // Ordering proof over the full history: base, merge (source), inventory
    // refresh, then contract-table refresh — inventory strictly before
    // contract table.
    const subjects = git(root, "log", "--format=%s").split("\n");
    const invIdx = subjects.findIndex((s) => s.includes("auto-regenerate route inventory"));
    const contractIdx = subjects.findIndex((s) => s.includes("auto-regenerate contract table"));
    assert.ok(invIdx > contractIdx, "in newest-first log, the inventory commit is OLDER than the contract-table commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Unfixable-staleness proof: a genuine source bug (duplicate route
//    registration) survives regen, exits 1, but the run still commits the
//    best-effort artifacts and a post-merge.sh-style caller continues on.
// ---------------------------------------------------------------------------

test("duplicate route registration survives regen (source bug) — exits 1, best-effort commit lands, run continues past the failure", () => {
  const root = initFixtureRepo();
  try {
    writeRoutesSource(root, ['app.get("/api/widgets", createWidget);']);
    assert.ok(fixtureRegenInventory(root));
    assert.ok(fixtureRegenContractTable(root));
    commitAll(root, "base: fresh fixture chain (single route)");

    // Simulate a merge that lands a genuine source bug: two live
    // registrations for the same method+path (Task #4111's documented
    // "regen cannot fix it" case).
    writeRoutesSource(root, [
      'app.get("/api/widgets", createWidget);',
      'app.get("/api/widgets", createWidgetDuplicate);',
    ]);
    commitAll(root, "merge: duplicate /api/widgets registration lands (source bug)");

    const before = fixtureInventoryLint(root);
    assert.equal(before.ok, false);
    assert.ok(before.problems.some((p) => p.includes("duplicate")), "precondition: duplicate flagged before any refresh");

    const routeDeps: RouteRefreshDeps = {
      lint: () => fixtureInventoryLint(root),
      regen: () => fixtureRegenInventory(root),
      commit: makeFixtureCommit(root, [INV_JSON, INV_REPORT], "post-merge: fixture auto-regenerate route inventory"),
      log: () => {},
    };
    const contractSpec: ArtifactSpec = {
      name: "fixture-contract-table",
      paths: [CONTRACT_MD, CONTRACT_JSON],
      regenCommand: "fixture-regen-contract-table",
      commitMessage: "post-merge: fixture auto-regenerate contract table",
    };
    const contractDeps: ArtifactRefreshDeps = {
      lint: () => fixtureContractLint(root),
      regen: () => fixtureRegenContractTable(root),
      commit: makeFixtureCommit(root, contractSpec.paths, contractSpec.commitMessage),
      log: () => {},
    };

    // Real invocation order + calling convention: run route-inventory
    // refresh first, then generated-artifact refresh, exactly like
    // scripts/post-merge.sh:299-331 — a non-zero exit warns loudly but the
    // loop proceeds to the next phase regardless.
    const { ranPhases, warnings, results } = runLikePostMergeSh<RouteRefreshResult | ArtifactRefreshResult>([
      { name: "route-inventory-refresh", run: () => refreshRouteInventoryIfStale(routeDeps) },
      { name: "generated-artifact-refresh:contract-table", run: () => refreshArtifactIfStale(contractSpec, contractDeps) },
    ]);
    const [routeResult, contractResult] = results;

    assert.deepEqual(
      ranPhases,
      ["route-inventory-refresh", "generated-artifact-refresh:contract-table"],
      "BOTH phases ran — the failing phase 1 did not abort the run",
    );
    assert.equal(warnings.length, 1, "exactly one loud warning was raised (for the failing phase)");
    assert.ok(warnings[0].includes("route-inventory-refresh"), "the warning names the phase that failed");

    assert.equal(routeResult.outcome, "still-stale-after-regen", "duplicate registration: regen cannot fix it");
    assert.equal(routeResult.exitCode, 1, "duplicate registration: real script exits non-zero");
    assert.ok(
      routeResult.problemsAfter.some((p) => p.includes("duplicate")),
      "duplicate problem still present after regen",
    );

    // Best-effort commit still landed despite the exit 1 — proven via real
    // git history, not just the returned outcome string.
    assert.equal(
      commitSubject(root, "HEAD~1"),
      "post-merge: fixture auto-regenerate route inventory",
      "the regenerated (still-red) inventory was committed anyway (accurate, best-effort)",
    );
    assert.deepEqual(
      commitFiles(root, "HEAD~1"),
      [INV_JSON, INV_REPORT].sort(),
      "the best-effort inventory commit touches ONLY the inventory artifact paths",
    );
    const committedInventory: FixtureRoute[] = JSON.parse(readFileSync(join(root, INV_JSON), "utf8")); // fs-scan-inputs-ignore -- reads only inside mkdtemp fixture repos created by this test (root/paths are always temp-dir-local, never repo source)
    assert.equal(committedInventory.length, 2, "the committed (red) inventory accurately reflects both duplicate entries");

    // Phase 2 ran to completion and succeeded — the contract table doesn't
    // care about duplicate keys, only about matching whatever inventory is
    // currently committed.
    assert.equal(contractResult.outcome, "refreshed-committed", "contract-table phase completed normally after phase 1's failure");
    assert.equal(contractResult.exitCode, 0);
    assert.equal(
      commitSubject(root),
      "post-merge: fixture auto-regenerate contract table",
      "contract-table refresh also produced a real commit",
    );
    assert.deepEqual(commitFiles(root), [CONTRACT_MD, CONTRACT_JSON].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
console.log(`\n${tests.length - failures}/${tests.length} post-merge-refresh-e2e tests passed`);
process.exit(failures > 0 ? 1 : 0);
