/* test-registration
{
  "name": "async-correctness lint guard (real tree + fixtures)",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: last published green was 168.1s, above the medium ceiling. The gate lint phase still runs the same async-correctness scan on every gate; this heavyweight self-test remains in the nightly/post-merge regression lane and is re-added by related selection when its closure changes.",
  "extraNodeArgs": ["--max-old-space-size=6144"],
  "timeoutMs": 420000,
  "tier": "large",
  "tierReason": "Last published green measurement was 168133ms, above the medium tier ceiling."
}
test-registration */
// extraNodeArgs (Task #4548): the typed real-tree scan plus the fixture
// ESLint programs share one process; as the repo grew the cumulative heap
// crossed V8's default ~4GB old-space cap and the suite began dying with
// SIGABRT (exit 134, "Reached heap limit") — the same signature main's
// nightly recorded. 6GB keeps honest headroom on the 16GB runner; the flag
// also makes the runner execute this suite solo, so the budget is not
// shared with batched siblings.
// fs-scan-fixture-only -- this file's own fs reads touch only mkdtemp fixture trees and the tmp lane ledger it writes itself; the real-tree scan runs inside the imported lint module (visible to import tracing), no live repo source is fs-read here
/**
 * Task #3817 — Gate + regression test for the async-correctness lint.
 *
 * Assertion 1 runs the lint over the REAL tree (server/, client/src/,
 * shared/, scripts/) against the committed count baseline — in full-set runs
 * this test complements the managed Long validation workflow's reviewed routine-gate profile;
 * related-smoke gate runs are covered by the LINT_CHECKS entry instead, see
 * the registration block above for why this file is not lint-*-named).
 *
 * Fixture cases then prove the lint itself works:
 *   2. All four rules fire on a file that violates each one.
 *   3. `void`-annotated fire-and-forget passes (the sanctioned convention).
 *   4. A baselined count is grandfathered (ok, counted).
 *   5. A count above the baseline allowance is a NEW offender.
 *   6. A count below baseline (and a deleted file) is STALE and fails —
 *      the ratchet that keeps the allowance equal to reality.
 *   7. An eslint-disable comment naming a gated rule is a hard offender.
 *   8. A fatal parse error fails and is not baselinable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint, runLintCachedRealTree } from "../scripts/lint-async-correctness";

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

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    skipLibCheck: true,
  },
  include: ["src"],
});

function mkFixture(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "async-lint-"));
  writeFileSync(join(dir, "tsconfig.json"), FIXTURE_TSCONFIG);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function runFixture(
  dir: string,
  baseline?: string,
): ReturnType<typeof runLint> {
  if (baseline !== undefined) {
    writeFileSync(join(dir, "baseline.txt"), baseline);
  }
  return runLint({
    cwd: dir,
    patterns: ["src/**/*.ts"],
    baselinePath: "baseline.txt",
    tsconfigPath: "./tsconfig.json",
  });
}

async function main(): Promise<void> {
  // ── 1. THE GATE: the real tree must hold the line against the baseline ──
  // Task #4531: goes through the green-verdict cache — a byte-identical tree
  // (program files, tsconfigs, baseline, lockfile, lint script) reuses the
  // recorded green instead of re-paying the ~166s typed scan. Red verdicts
  // are never cached; fixtures below always execute. LINT_VERDICT_CACHE=0
  // forces the full scan.
  {
    const res = await runLintCachedRealTree();
    if (!res.ok) {
      for (const d of res.offenders) {
        console.error(`    NEW ${d.file} [${d.rule}] ${d.count} vs allowance ${d.baselineCount}`);
        for (const h of d.hits) console.error(`      ${d.file}:${h.line} ${h.message}`);
      }
      for (const d of res.stale) {
        console.error(`    STALE ${d.file} [${d.rule}] allowance ${d.baselineCount}, found ${d.count}`);
      }
      for (const f of res.fatals) console.error(`    FATAL ${f.file}:${f.line} ${f.message}`);
      for (const d of res.directiveOffenders) {
        console.error(`    DIRECTIVE ${d.file}:${d.line} ${d.text}`);
      }
    }
    assert(
      res.ok,
      `REAL TREE: no new async-correctness violations, no stale baseline rows ` +
        `(${res.filesScanned} files, ${res.baselinedCount} baselined — fix new hits or ` +
        `void-annotate intentional fire-and-forget; if you fixed debt run ` +
        `\`npx tsx scripts/lint-async-correctness.ts --update-baseline\`; see ASYNC_CORRECTNESS.md)`,
    );
    assert(
      res.filesScanned > 900,
      `real-tree scan covered the expected corpus (${res.filesScanned} files > 900 — a collapse here means the glob/tsconfig broke)`,
    );
  }

  // ── 2. All four rules fire ──
  {
    const { dir, cleanup } = mkFixture({
      "src/allfour.ts": [
        "async function doWork(): Promise<number> { return 1; } // require-await",
        "export async function run(): Promise<void> {",
        "  doWork(); // no-floating-promises",
        "  if (doWork()) { // no-misused-promises (conditional)",
        "    console.log('x');",
        "  }",
        "  await 5; // await-thenable",
        "}",
        "",
      ].join("\n"),
    });
    try {
      const res = await runFixture(dir);
      const rules = new Set(res.hits.map((h) => h.rule));
      assert(!res.ok && res.offenders.length > 0, "violating fixture fails with offenders");
      for (const rule of [
        "no-floating-promises",
        "no-misused-promises",
        "await-thenable",
        "require-await",
      ]) {
        assert(rules.has(rule), `rule fires: ${rule}`);
      }
    } finally {
      cleanup();
    }
  }

  // ── 3. `void` annotation passes ──
  {
    const { dir, cleanup } = mkFixture({
      "src/clean.ts": [
        "async function doWork(): Promise<void> { await Promise.resolve(); }",
        "export function kick(): void {",
        "  void doWork(); // fire-and-forget: sanctioned annotation",
        "}",
        "export async function waits(): Promise<void> { await doWork(); }",
        "",
      ].join("\n"),
    });
    try {
      const res = await runFixture(dir);
      assert(
        res.ok && res.hits.length === 0,
        "void-annotated fire-and-forget + proper awaits produce zero hits",
      );
    } finally {
      cleanup();
    }
  }

  // ── 4./5. Baselined count grandfathered; count above allowance fails ──
  {
    const { dir, cleanup } = mkFixture({
      "src/legacy.ts": [
        "async function doWork(): Promise<void> { await Promise.resolve(); }",
        "export function kick(): void {",
        "  doWork();",
        "  doWork();",
        "}",
        "",
      ].join("\n"),
    });
    try {
      const grandfathered = await runFixture(
        dir,
        "# frozen\nsrc/legacy.ts no-floating-promises 2\n",
      );
      assert(
        grandfathered.ok && grandfathered.baselinedCount === 2 && grandfathered.offenders.length === 0,
        "a (file, rule) count at its baseline allowance is grandfathered",
      );
      const exceeded = await runFixture(
        dir,
        "src/legacy.ts no-floating-promises 1\n",
      );
      assert(
        !exceeded.ok &&
          exceeded.offenders.length === 1 &&
          exceeded.offenders[0].count === 2 &&
          exceeded.offenders[0].baselineCount === 1,
        "a count above the allowance is a NEW offender (2 hits vs allowance 1)",
      );
    } finally {
      cleanup();
    }
  }

  // ── 6. Stale rows fail: count below allowance + deleted file ──
  {
    const { dir, cleanup } = mkFixture({
      "src/improved.ts": [
        "async function doWork(): Promise<void> { await Promise.resolve(); }",
        "export function kick(): void {",
        "  doWork();",
        "}",
        "",
      ].join("\n"),
    });
    try {
      const res = await runFixture(
        dir,
        "src/improved.ts no-floating-promises 3\nsrc/gone.ts require-await 1\n",
      );
      assert(
        !res.ok && res.offenders.length === 0 && res.stale.length === 2,
        "counts below allowance AND rows for deleted files are stale (ratchet forces --update-baseline)",
      );
      const staleFiles = res.stale.map((s) => `${s.file}:${s.count}/${s.baselineCount}`).sort();
      assert(
        staleFiles[0] === "src/gone.ts:0/1" && staleFiles[1] === "src/improved.ts:1/3",
        `stale rows carry found/allowance counts (${staleFiles.join(", ")})`,
      );
    } finally {
      cleanup();
    }
  }

  // ── 7. eslint-disable bypass is a hard offender ──
  {
    const { dir, cleanup } = mkFixture({
      "src/sneaky.ts": [
        "async function doWork(): Promise<void> { await Promise.resolve(); }",
        "export function kick(): void {",
        "  // eslint-disable-next-line @typescript-eslint/no-floating-promises",
        "  doWork();",
        "}",
        "",
      ].join("\n"),
    });
    try {
      const res = await runFixture(dir);
      assert(
        !res.ok && res.directiveOffenders.length === 1 && res.directiveOffenders[0].file === "src/sneaky.ts",
        "an eslint-disable comment naming a gated rule hard-fails (void is the only sanctioned annotation)",
      );
    } finally {
      cleanup();
    }
  }

  // ── 8. Parse errors are never baselinable ──
  {
    const { dir, cleanup } = mkFixture({
      "src/broken.ts": "export function (( {\n",
    });
    try {
      const res = await runFixture(dir, "src/broken.ts no-floating-promises 5\n");
      assert(
        !res.ok && res.fatals.length > 0,
        "a fatal parse error fails the lint even with baseline rows present",
      );
    } finally {
      cleanup();
    }
  }

  // ── 9. Sharded-lane controls (Task #4605) ──
  // The scope-clustered child-process lane only engages on default full-tree
  // runs; fixture/custom-cwd calls must stay serial even when concurrency is
  // requested (spawning shard children against a fixture tree would lint the
  // wrong repo). Findings-parity of the sharded lane itself is proven by a
  // seeded-violation A/B on the real tree (audits/gate-duration-budget §7).
  {
    const { dir, cleanup } = mkFixture({
      "src/float.ts": "async function f() { return 1; }\nexport function g() { f(); }\n",
    });
    try {
      const res = await runLint({
        cwd: dir,
        patterns: ["src/**/*.ts"],
        tsconfigPath: "./tsconfig.json",
        concurrency: 3,
      });
      assert(
        !res.ok && res.hits.some((h) => h.rule === "no-floating-promises"),
        "custom-cwd run with concurrency>1 stays serial and still finds the violation",
      );
    } finally {
      cleanup();
    }
  }
  // Shard-failure lifecycle: on the first failing child every other live
  // child is killed, and the sharded scan settles only after ALL children
  // have exited — so the caller's serial fallback never overlaps leftover
  // shard processes. Exercised via the injectable spawn seam (fake children;
  // no real processes).
  {
    const { runShardedFullTreeScan } = await import("../scripts/lint-async-correctness");
    type ExitCb = (code: number | null, signal: NodeJS.Signals | null) => void;
    class FakeChild {
      exitCode: number | null = null;
      signalCode: string | null = null;
      killed = false;
      private exitCb: ExitCb | null = null;
      on(event: string, cb: unknown): void {
        if (event === "exit") this.exitCb = cb as ExitCb;
      }
      kill(): void {
        this.killed = true;
        // Deliver the exit asynchronously, like a real SIGKILL.
        setTimeout(() => this.emitExit(null, "SIGKILL"), 5);
      }
      emitExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.exitCb?.(code, signal);
      }
    }
    const fakes: FakeChild[] = [];
    const fakeSpawn = () => {
      const c = new FakeChild();
      fakes.push(c);
      if (fakes.length === 1) setTimeout(() => c.emitExit(1, null), 10); // first shard fails
      return c;
    };
    let rejected = false;
    try {
      await runShardedFullTreeScan(process.cwd(), fakeSpawn as never);
    } catch {
      rejected = true;
    }
    assert(rejected, "a failing shard child rejects the sharded scan (serial fallback engages)");
    assert(
      fakes.length === 3 && fakes.slice(1).every((c) => c.killed),
      "the first shard failure kills every other live shard child",
    );
    assert(
      fakes.every((c) => c.exitCode !== null || c.signalCode !== null),
      "the sharded scan settles only after ALL shard children have exited",
    );
  }
  {
    const { defaultConcurrency } = await import("../scripts/lint-async-correctness");
    const prev = process.env.ASYNC_LINT_CONCURRENCY;
    try {
      process.env.ASYNC_LINT_CONCURRENCY = "off";
      assert(defaultConcurrency() === "off", "ASYNC_LINT_CONCURRENCY=off disables sharding");
      process.env.ASYNC_LINT_CONCURRENCY = "1";
      assert(defaultConcurrency() === "off", "concurrency < 2 disables sharding");
      process.env.ASYNC_LINT_CONCURRENCY = "5";
      assert(defaultConcurrency() === 5, "numeric override is honored");
    } finally {
      if (prev === undefined) delete process.env.ASYNC_LINT_CONCURRENCY;
      else process.env.ASYNC_LINT_CONCURRENCY = prev;
    }
  }

  // ── 10. Lane ledger (Task #4669) ──
  // Full-tree scans append one JSON line to a durable ledger recording which
  // lane ran (sharded / serial-fallback / serial-off), so a regression to
  // routine serial fallback is observable without grep-ing transient gate
  // logs. Recording is best-effort: an unwritable path must never throw.
  {
    const { appendLaneRecord } = await import("../scripts/lint-async-correctness");
    const dir = mkdtempSync(join(tmpdir(), "async-lint-lane-"));
    try {
      const ledger = join(dir, "nested", "lane-history.jsonl");
      appendLaneRecord(
        { at: "2026-08-13T00:00:00.000Z", lane: "sharded", wallMs: 100, filesScanned: 5 },
        ledger,
      );
      appendLaneRecord(
        {
          at: "2026-08-13T00:01:00.000Z",
          lane: "serial-fallback",
          reason: "shard child exited 1",
          wallMs: 200,
          filesScanned: 5,
        },
        ledger,
      );
      const lines = (await import("node:fs")).readFileSync(ledger, "utf8").trim().split("\n"); // fs-scan-inputs-ignore -- reads back the tmp lane-ledger file this test just wrote under its own mkdtemp dir; never repo source
      const records = lines.map((l) => JSON.parse(l) as { lane: string; reason?: string });
      assert(
        records.length === 2 && records[0].lane === "sharded" && !records[0].reason,
        "lane ledger appends one JSON line per record (sharded records carry no reason)",
      );
      assert(
        records[1].lane === "serial-fallback" && records[1].reason === "shard child exited 1",
        "a serial-fallback record carries the failure reason",
      );
      let threw = false;
      try {
        appendLaneRecord(
          { at: "2026-08-13T00:02:00.000Z", lane: "serial-off", wallMs: 1, filesScanned: 0 },
          join(ledger, "ledger-is-a-file-not-a-dir.jsonl"),
        );
      } catch {
        threw = true;
      }
      assert(!threw, "an unwritable ledger path never throws (telemetry must not fail the lint)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n  passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
