/**
 * lint-async-correctness.ts — Task #3817: catch un-awaited async bugs mechanically.
 *
 * Background
 * ----------
 * The most expensive recurring bug class in this app's history is async misuse:
 * fire-and-forget promises that race tests and restarts, missing awaits, and
 * double-driven refreshes. Multiple past incidents required drain helpers,
 * single-flight wrappers, and audit-after-finished repairs (see e.g. the
 * OAuth refresh single-flight family, `__test_drainPending*` helpers, and the
 * "drain finished races its audit write" class). The repo had no generic
 * static analysis for this — only bespoke invariant lints. This lint adds the
 * standard typescript-eslint async-correctness rule set underneath them.
 *
 * Rules (type-aware, via the repo tsconfig)
 * -----------------------------------------
 *   @typescript-eslint/no-floating-promises  — a Promise created and dropped.
 *       THE fire-and-forget catcher. `ignoreVoid: true`, so prefixing a call
 *       with the `void` operator is the sanctioned, visible-at-the-call-site
 *       annotation for INTENTIONAL fire-and-forget. Convention: only `void` a
 *       promise whose rejection is handled (internally or via `.catch`), and
 *       say why on the line: `void kickRefresh(); // fire-and-forget: <why>`.
 *       `ignoreIIFE: false` — a dropped `(async () => …)()` needs the same
 *       explicit `void` annotation.
 *   @typescript-eslint/no-misused-promises   — Promise used where a value/void
 *       is expected (e.g. `if (somePromise)` is always truthy — a real past
 *       bug class). `checksVoidReturn` is tuned: `arguments: false` (every
 *       async express handler / array callback would flood the baseline and
 *       triple the runtime — the untuned rule blew the scan past 5 minutes)
 *       and `attributes: false` (async JSX handlers are idiomatic). Checks on
 *       conditionals, variables, properties, returns, and spreads stay ON.
 *   @typescript-eslint/await-thenable        — `await` on a non-promise
 *       (usually a forgotten `()` or a sync function — dead await).
 *   @typescript-eslint/require-await         — `async` function with no
 *       `await`: either the `async` is noise, or an await was forgotten.
 *
 * Baseline (count-based — deliberately NOT the file:line format)
 * --------------------------------------------------------------
 * `scripts/lint-async-correctness.baseline.txt` freezes pre-existing hits as
 * `<file> <rule> <count>` rows. The gate fails only NEW violations: a (file,
 * rule) count above its baselined allowance. Unlike the react-hooks lint's
 * `file:line` entries, counts are immune to line drift (the baseline here is
 * ~100x larger, so per-line entries would spray false "new" hits on every
 * unrelated edit). The trade-off — within one file's allowance a fixed hit
 * could mask an added one — is closed by the ratchet: a count BELOW baseline
 * (or a deleted file) also fails until the baseline is regenerated, so the
 * allowance always equals current reality. Regenerate with:
 *
 *   npx tsx scripts/lint-async-correctness.ts --update-baseline
 *
 * (add `--scope=server,shared` etc. to rewrite only those scopes' entries).
 *
 * Bypass guard: `eslint-disable` comments naming any of these four rules are
 * hard offenders — `void` is the single sanctioned annotation, so intent
 * stays visible at every call site instead of hiding in a directive.
 *
 * Scope & performance
 * -------------------
 * Scans server/, client/src/, shared/, and scripts/ TS code (tests excluded —
 * they have their own harness conventions like deliberately dropped promises
 * in race fixtures). Type-aware linting builds one TS program from
 * `tsconfig.eslint.json` (~55s) plus rule execution (~75s): a full serial run
 * is ~2-2.5 min single-threaded (~3.75 min by 2026-08 tree size). Task #4605:
 * full-tree runs now shard the target files across child processes (see
 * LintOptions.concurrency — ESLint ≥9.34 worker THREADS were tried first and
 * rejected: V8 heap flags cannot reach worker threads, so each one rides the
 * ~4GB default cap while building the full typed program and SIGABRTs).
 * Default shard count is memory-bounded (3); override or kill with
 * ASYNC_LINT_CONCURRENCY=<n|off>. Each child builds its own TS program, so
 * this trades memory+CPU for wall time — the verdict cache still removes the
 * steady-state cost entirely. Any shard failure falls back to one serial
 * scan. `--scope=<dir>` runs and fixture runs stay serial (tiny trees;
 * findings are per-file and identical either way).
 *
 * Enforcement wiring (Task #3817)
 * -------------------------------
 * The managed Long validation workflow runs the reviewed routine-gate profile; this check is
 * registered in scripts/gate.ts LINT_CHECKS. The guard test
 * (tests/async-correctness-lint.test.ts) asserts the real tree against the
 * baseline in full-set runs (the managed Long validation workflow / predeploy `npm test`)
 * — it is deliberately NOT named `tests/lint-*.test.ts`, so related-smoke
 * gate runs don't pay the ~2.5 min scan twice on top of the LINT_CHECKS
 * entry that already covers them. Contributor doc: ASYNC_CORRECTNESS.md.
 *
 * CLI
 * ---
 *   npx tsx scripts/lint-async-correctness.ts                 # full gate run
 *   npx tsx scripts/lint-async-correctness.ts --scope=server  # one scope only
 *   npx tsx scripts/lint-async-correctness.ts --update-baseline [--scope=…]
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import ts from "typescript";
import {
  computeVerdictKey,
  readGreenVerdict,
  verdictCacheEnabled,
  writeGreenVerdict,
} from "./lintVerdictCache";

export const RULE_CONFIG: Record<string, unknown> = {
  "@typescript-eslint/no-floating-promises": [
    "error",
    { ignoreVoid: true, ignoreIIFE: false },
  ],
  "@typescript-eslint/no-misused-promises": [
    "error",
    { checksVoidReturn: { arguments: false, attributes: false } },
  ],
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/require-await": "error",
};
const RULE_IDS = new Set(Object.keys(RULE_CONFIG));
/** Baseline rows use the short rule name (prefix stripped) for readability. */
const RULE_PREFIX = "@typescript-eslint/";

/** Scope name → glob patterns. Tests are excluded everywhere (see header). */
export const SCOPES: Record<string, string[]> = {
  server: ["server/**/*.ts"],
  client: ["client/src/**/*.{ts,tsx}"],
  shared: ["shared/**/*.ts"],
  scripts: ["scripts/**/*.ts"],
};
const TEST_IGNORES = ["**/*.test.ts", "**/*.test.tsx"];
const DEFAULT_BASELINE = "scripts/lint-async-correctness.baseline.txt";
const DEFAULT_TSCONFIG = "./tsconfig.eslint.json";

export interface AsyncHit {
  /** Path relative to `cwd`. */
  file: string;
  /** Short rule name (no @typescript-eslint/ prefix); "(parse)" for fatals. */
  rule: string;
  line: number;
  column: number;
  message: string;
  fatal: boolean;
}

export interface PairDelta {
  file: string;
  rule: string;
  count: number;
  baselineCount: number;
  /** Individual hits for offender pairs (empty for stale pairs). */
  hits: AsyncHit[];
}

export interface DirectiveOffender {
  file: string;
  line: number;
  text: string;
}

export interface LintResult {
  ok: boolean;
  filesScanned: number;
  /** Every async-rule hit found (baselined or not) plus fatal parse errors. */
  hits: AsyncHit[];
  /** (file, rule) pairs whose count EXCEEDS the baselined allowance. */
  offenders: PairDelta[];
  /** (file, rule) pairs whose count is BELOW baseline — ratchet the baseline down. */
  stale: PairDelta[];
  /** eslint-disable comments naming one of the gated rules (hard offenders). */
  directiveOffenders: DirectiveOffender[];
  /** Fatal parse errors (never baselinable — subset of `hits`). */
  fatals: AsyncHit[];
  /** Total hits per short rule name. */
  totals: Record<string, number>;
  /** Number of hits covered by the baseline allowance. */
  baselinedCount: number;
}

export interface LintOptions {
  /** Working directory for globbing + relative paths. Default: repo root. */
  cwd?: string;
  /** Glob patterns to lint. Default: every scope in SCOPES. */
  patterns?: string[];
  /** Baseline file path relative to cwd. Default: the committed baseline. */
  baselinePath?: string;
  /** tsconfig for the type-aware program, relative to cwd. */
  tsconfigPath?: string;
  /**
   * Baseline entries are only compared for staleness when their file falls
   * under one of these prefixes. Default [""] (all entries). The CLI passes
   * scope dirs (e.g. ["server/"]) for --scope runs so a partial scan never
   * misreports other scopes' entries as stale.
   */
  baselineScopePrefixes?: string[];
  /**
   * Task #4605 — child-process sharding for the type-aware full-tree scan.
   * "off" (default) keeps the original single-process path. A number > 1
   * enables the SHARDS lane: scope-clustered `tsx` child processes, each
   * with its own bounded V8 heap and a scoped tsconfig (worker THREADS were
   * tried first and rejected: V8 flags cannot reach them, so every worker
   * rides the ~4GB default cap while building the full typed program, which
   * SIGABRTs intermittently). Findings are per-file and each shard's program
   * contains the same transitive closure, so the merged result is identical
   * to a serial scan; any shard failure falls back to one serial scan (never
   * a false verdict). Only the full-tree lanes pass this; fixture/scoped
   * runs stay serial.
   */
  concurrency?: number | "off";
  /**
   * Task #4669 — where full-tree runs append their lane record (sharded vs
   * serial fallback; see LaneRecord). Default LANE_LEDGER_PATH. Pass null to
   * disable. Ignored for fixture/scoped runs (they never record a lane).
   */
  laneLedgerPath?: string | null;
}

/**
 * Task #4669 — durable lane telemetry for the full-tree scan.
 *
 * Task #4642 audited whether the sharded lane (Task #4605) ever falls back
 * to the slow serial scan on busy runners; the only evidence channel was
 * grep-ing transient gate output (per-invocation evidence is not a fixed
 * shared-run contract), so a regression to ROUTINE fallback would be invisible until someone
 * repeated the manual audit. Every full-tree scan now appends one JSON line
 * to LANE_LEDGER_PATH (append-only, survives across runs) recording which
 * lane actually ran and why. Verdict-cache hits skip the scan entirely and
 * append nothing — the previous line still describes the last real scan.
 * Audit at a glance: `cat .local/runs/async-lint-lane-history.jsonl`.
 * Recording is best-effort and must never change the lint verdict.
 */
export const LANE_LEDGER_PATH = ".local/runs/async-lint-lane-history.jsonl";

export interface LaneRecord {
  /** ISO timestamp of the scan's completion. */
  at: string;
  /** Which lane produced the verdict for this full-tree scan. */
  lane: "sharded" | "serial-fallback" | "serial-off";
  /** Why a serial lane ran (fallback error message, or the off switch). */
  reason?: string;
  /** Wall time of the scan itself (ms). */
  wallMs: number;
  filesScanned: number;
}

/** Append one lane record. Best-effort: telemetry must never fail the lint. */
export function appendLaneRecord(record: LaneRecord, ledgerPath: string): void {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.warn(
      `lint-async-correctness: could not append lane record to ${ledgerPath} ` +
        `(${err instanceof Error ? err.message : String(err)}) — verdict unaffected.`,
    );
  }
}

/**
 * Sharding on/off default for full-tree runs. Each shard child peaks ~4GB
 * (scoped typed program), so the lane is memory-bounded, not core-bounded:
 * the 3 scope-clustered children fit the 16GB runner alongside the dev
 * server. Kill via ASYNC_LINT_CONCURRENCY=off (or any value < 2); boxes with
 * fewer than 4 cores also stay serial (children would just contend).
 */
export function defaultConcurrency(): number | "off" {
  const raw = (process.env.ASYNC_LINT_CONCURRENCY ?? "").trim();
  if (raw === "off") return "off";
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n > 1 ? n : "off";
  }
  return availableParallelism() >= 4 ? SHARDS.length : "off";
}

/**
 * Scope-clustered shards (Task #4605). Each shard lints whole scopes and gets
 * a generated tsconfig whose `include` seeds only those scopes' files — the
 * TS program still contains every transitively imported file (so types are
 * identical to the full-program scan), but the program each child builds is
 * much smaller than the full union. Measured on the 2026-08 tree: client 65s,
 * scripts+shared 84s, server 140s (the long pole) vs ~225s serial — and each
 * child peaks ~4GB instead of the full program's near-cap footprint.
 * Clustering by scope (not size-balancing arbitrary file sets) is what keeps
 * each child's import closure — and therefore its program — small.
 */
const SHARDS: { name: string; scopes: string[]; include: string[] }[] = [
  { name: "server", scopes: ["server"], include: ["server/**/*"] },
  { name: "client", scopes: ["client"], include: ["client/src/**/*"] },
  { name: "rest", scopes: ["scripts", "shared"], include: ["scripts/**/*", "shared/**/*"] },
];

interface ShardOutput {
  hits: AsyncHit[];
  filesScanned: number;
  /** Absolute paths of the files ESLint scanned (for the directive scan). */
  files: string[];
}

/**
 * Minimal structural slice of ChildProcess the sharded lane needs — the seam
 * the guard suite's failure-path test injects a fake spawn through.
 */
export interface ShardChildProcess {
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export type ShardSpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: ["ignore", "inherit", "inherit"] },
) => ShardChildProcess;

/**
 * Run the full-tree scan as scope-clustered shard children and merge their
 * outputs. Child lifecycle contract (completion-review requirement): on the
 * FIRST failing shard every other live child is SIGKILLed, and this function
 * settles only after EVERY child has exited — so the caller's serial
 * fallback can never run concurrently with leftover multi-GB shard
 * processes, and the scratch dir is only removed once nothing can still
 * write into it. Rejects on any shard failure (caller falls back serially).
 */
export async function runShardedFullTreeScan(
  cwd: string,
  spawnImpl: ShardSpawn = spawn as unknown as ShardSpawn,
): Promise<ShardOutput> {
  // Generated shard tsconfigs live under the repo (.local/tmp — the
  // sanctioned scratch zone) because tsconfig include/exclude globs resolve
  // relative to the config file's directory (a /tmp config would silently
  // re-root the inherited excludes and pull tests into the program).
  const scratchRoot = join(cwd, ".local", "tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const tmp = mkdtempSync(join(scratchRoot, "async-lint-shards-"));
  const children: ShardChildProcess[] = [];
  let firstFailure: Error | null = null;
  const killRemaining = () => {
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        try {
          c.kill("SIGKILL");
        } catch {
          /* child already gone */
        }
      }
    }
  };
  try {
    const promises = SHARDS.map((shard) => {
      const shardTsconfig = join(tmp, `tsconfig.shard-${shard.name}.json`);
      writeFileSync(
        shardTsconfig,
        JSON.stringify(
          {
            extends: resolve(cwd, "tsconfig.eslint.json"),
            include: shard.include.map((p) => join(cwd, p)),
            exclude: [join(cwd, "node_modules"), "**/*.test.ts", "**/*.test.tsx"],
          },
          null,
          2,
        ),
      );
      const outPath = join(tmp, `shard-${shard.name}.out.json`);
      return new Promise<ShardOutput>((resolvePromise, rejectPromise) => {
        const child = spawnImpl(
          process.execPath,
          [
            // Bounded per-child heap: a scoped program peaks ~4GB (vs the
            // guard suite's 6144 for the FULL program, Task #4548); 4608
            // keeps three concurrent children + the dev server inside the
            // 16GB runner.
            "--max-old-space-size=4608",
            "--import",
            "tsx",
            resolve(cwd, "scripts/lint-async-correctness.ts"),
            `--shard-scopes=${shard.scopes.join(",")}`,
            `--shard-tsconfig=${shardTsconfig}`,
            `--shard-out=${outPath}`,
          ],
          { cwd, stdio: ["ignore", "inherit", "inherit"] },
        );
        children.push(child);
        child.on("error", rejectPromise);
        child.on("exit", (code, signal) => {
          if (code !== 0) {
            rejectPromise(
              new Error(
                `shard [${shard.scopes.join(",")}] child exited with code ${code} signal ${signal ?? "none"}`,
              ),
            );
            return;
          }
          try {
            resolvePromise(JSON.parse(readFileSync(outPath, "utf8")) as ShardOutput);
          } catch (err) {
            rejectPromise(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }).catch((err: Error) => {
        // First failure hard-stops the other children immediately …
        if (!firstFailure) firstFailure = err;
        killRemaining();
        throw err;
      });
    });
    // … and allSettled waits for EVERY child (including the killed ones) to
    // exit before we either merge or surface the failure.
    const settled = await Promise.allSettled(promises);
    if (firstFailure) throw firstFailure;
    const outputs = settled.map(
      (s) => (s as PromiseFulfilledResult<ShardOutput>).value,
    );
    return {
      hits: outputs.flatMap((o) => o.hits),
      filesScanned: outputs.reduce((a, o) => a + o.filesScanned, 0),
      files: outputs.flatMap((o) => o.files),
    };
  } finally {
    // All children have exited by now (allSettled above), so nothing can
    // still write into the scratch dir.
    rmSync(tmp, { recursive: true, force: true });
  }
}

function shortRule(ruleId: string): string {
  return ruleId.startsWith(RULE_PREFIX) ? ruleId.slice(RULE_PREFIX.length) : ruleId;
}

/** Parse `<file> <rule> <count>` rows; `#` starts a comment. */
export function readBaseline(path: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const count = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    out.set(`${parts[0]}\u0000${parts[1]}`, count);
  }
  return out;
}

/**
 * Scan file contents for eslint-disable directives naming a gated rule.
 * `void` is the sanctioned annotation; a disable comment hides intent.
 */
function findDirectiveOffenders(files: string[], cwd: string): DirectiveOffender[] {
  const ruleNames = [...RULE_IDS].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const rx = new RegExp(`eslint-disable[^\\n]*(?:${ruleNames.join("|")})`);
  const out: DirectiveOffender[] = [];
  for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!content.includes("eslint-disable")) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        out.push({ file: relative(cwd, abs), line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return out;
}

/** The exact ESLint options both lanes use (findings must be identical). */
function buildEslintOptions(cwd: string, tsconfigPath: string): ESLint.Options {
  return {
    cwd,
    // `true` = ignore any eslint.config.js; the inline flat config below is
    // the entire configuration, so this guard is hermetic (same decision as
    // scripts/lint-react-hooks.ts).
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts", "**/*.tsx"],
        ignores: TEST_IGNORES,
        languageOptions: {
          parser: tsParser as never,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            sourceType: "module",
            project: [tsconfigPath],
            tsconfigRootDir: cwd,
          },
        },
        plugins: { "@typescript-eslint": tsPlugin as never },
        rules: RULE_CONFIG as never,
      },
    ],
  };
}

/** Serial ESLint scan → AsyncHit[] (shared by the serial lane + shard children). */
export async function scanHits(
  cwd: string,
  tsconfigPath: string,
  patterns: string[],
): Promise<ShardOutput> {
  const eslint = new ESLint(buildEslintOptions(cwd, tsconfigPath));
  const results = await eslint.lintFiles(patterns);
  return {
    hits: resultsToHits(results, cwd),
    filesScanned: results.length,
    files: results.map((r) => r.filePath),
  };
}

function resultsToHits(results: ESLint.LintResult[], cwd: string): AsyncHit[] {
  const hits: AsyncHit[] = [];
  for (const r of results) {
    const file = relative(cwd, r.filePath);
    for (const m of r.messages) {
      if (m.fatal) {
        // A file the scanner cannot parse is a file the guard cannot vouch
        // for — always fails, never baselinable (react-hooks lint precedent).
        const hit: AsyncHit = {
          file,
          rule: "(parse)",
          line: m.line ?? 0,
          column: m.column ?? 0,
          message: `parse error: ${m.message}`,
          fatal: true,
        };
        hits.push(hit);
        continue;
      }
      // Foreign ruleIds appear here when a file carries eslint-disable
      // directives for rules this config does not define (e.g. the
      // react-hooks burndown comments) — ESLint reports "Definition for rule
      // … was not found" with ruleId set to that rule. Only OUR rules count.
      if (!m.ruleId || !RULE_IDS.has(m.ruleId)) continue;
      const rule = shortRule(m.ruleId);
      const hit: AsyncHit = {
        file,
        rule,
        line: m.line ?? 0,
        column: m.column ?? 0,
        message: m.message,
        fatal: false,
      };
      hits.push(hit);
    }
  }
  return hits;
}

export async function runLint(opts?: LintOptions): Promise<LintResult> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  const patterns = opts?.patterns ?? Object.values(SCOPES).flat();
  const baselinePath = resolve(cwd, opts?.baselinePath ?? DEFAULT_BASELINE);
  const tsconfigPath = opts?.tsconfigPath ?? DEFAULT_TSCONFIG;
  const scopePrefixes = opts?.baselineScopePrefixes ?? [""];
  const baseline = readBaseline(baselinePath);
  const concurrency = opts?.concurrency ?? "off";

  // Task #4669 — lane telemetry (full-tree default runs only, matching the
  // sharded-lane eligibility below). Records which lane actually ran.
  const fullTreeRun = !opts?.patterns && !opts?.cwd;
  const scanStart = Date.now();
  let lane: LaneRecord["lane"] = "serial-off";
  let laneReason: string | undefined =
    concurrency === "off" || concurrency <= 1
      ? "concurrency off (ASYNC_LINT_CONCURRENCY kill switch or <4 cores)"
      : undefined;

  let scan: ShardOutput | null = null;
  if (concurrency !== "off" && concurrency > 1 && !opts?.patterns && !opts?.cwd) {
    // Sharded lane (Task #4605) — full-tree default runs only (custom
    // patterns/cwd callers, i.e. fixtures and --scope, stay serial).
    try {
      console.log(
        `lint-async-correctness: sharding the full-tree scan across ` +
          `${SHARDS.length} scope-clustered child process(es) ` +
          `(ASYNC_LINT_CONCURRENCY=off to disable)…`,
      );
      scan = await runShardedFullTreeScan(cwd);
      lane = "sharded";
      laneReason = undefined;
    } catch (err) {
      // Fall back to the serial lane — a failed shard must never surface as
      // a green (or partial) verdict. runShardedFullTreeScan only settles
      // after every shard child has exited, so the serial scan below never
      // runs concurrently with leftover shard processes.
      console.warn(
        `lint-async-correctness: sharded scan failed (${err instanceof Error ? err.message : String(err)}) — falling back to the serial scan.`,
      );
      lane = "serial-fallback";
      laneReason = err instanceof Error ? err.message : String(err);
      scan = null;
    }
  }
  if (!scan) {
    const eslint = new ESLint(buildEslintOptions(cwd, tsconfigPath));
    const results = await eslint.lintFiles(patterns);
    scan = {
      hits: resultsToHits(results, cwd),
      filesScanned: results.length,
      files: results.map((r) => r.filePath),
    };
  }

  const { hits, filesScanned } = scan;
  if (fullTreeRun && opts?.laneLedgerPath !== null) {
    appendLaneRecord(
      {
        at: new Date().toISOString(),
        lane,
        ...(laneReason ? { reason: laneReason } : {}),
        wallMs: Date.now() - scanStart,
        filesScanned,
      },
      resolve(cwd, opts?.laneLedgerPath ?? LANE_LEDGER_PATH),
    );
  }
  const scannedAbsFiles = scan.files;
  const fatals: AsyncHit[] = hits.filter((h) => h.fatal);
  const pairHits = new Map<string, AsyncHit[]>();
  for (const hit of hits) {
    if (hit.fatal) continue;
    const key = `${hit.file}\u0000${hit.rule}`;
    const arr = pairHits.get(key) ?? [];
    arr.push(hit);
    pairHits.set(key, arr);
  }

  const offenders: PairDelta[] = [];
  const stale: PairDelta[] = [];
  let baselinedCount = 0;
  for (const [key, arr] of pairHits) {
    const [file, rule] = key.split("\u0000");
    const allowance = baseline.get(key) ?? 0;
    if (arr.length > allowance) {
      offenders.push({ file, rule, count: arr.length, baselineCount: allowance, hits: arr });
      baselinedCount += allowance;
    } else {
      baselinedCount += arr.length;
      if (arr.length < allowance) {
        stale.push({ file, rule, count: arr.length, baselineCount: allowance, hits: [] });
      }
    }
  }
  // Baseline entries with zero current hits (fixed or file deleted/renamed).
  for (const [key, allowance] of baseline) {
    if (pairHits.has(key)) continue;
    const [file, rule] = key.split("\u0000");
    if (!scopePrefixes.some((p) => file.startsWith(p))) continue;
    stale.push({ file, rule, count: 0, baselineCount: allowance, hits: [] });
  }

  const directiveOffenders = findDirectiveOffenders(scannedAbsFiles, cwd);

  const totals: Record<string, number> = {};
  for (const h of hits) {
    if (!h.fatal) totals[h.rule] = (totals[h.rule] ?? 0) + 1;
  }

  offenders.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  stale.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));

  return {
    ok: offenders.length === 0 && stale.length === 0 && fatals.length === 0 && directiveOffenders.length === 0,
    filesScanned,
    hits,
    offenders,
    stale,
    directiveOffenders,
    fatals,
    totals,
    baselinedCount,
  };
}

/**
 * Rebuild baseline rows for files under `scopePrefixes` from `hits`,
 * preserving rows outside those prefixes verbatim (by re-deriving them from
 * the parsed baseline). Returns the full sorted row list.
 */
export function buildBaselineRows(
  hits: AsyncHit[],
  existing: Map<string, number>,
  scopePrefixes: string[],
): string[] {
  const merged = new Map<string, number>();
  for (const [key, count] of existing) {
    const [file] = key.split("\u0000");
    if (scopePrefixes.some((p) => file.startsWith(p))) continue; // rebuilt below
    merged.set(key, count);
  }
  for (const h of hits) {
    if (h.fatal) continue;
    if (!scopePrefixes.some((p) => h.file.startsWith(p))) continue;
    const key = `${h.file}\u0000${h.rule}`;
    merged.set(key, (merged.get(key) ?? 0) + 1);
  }
  return [...merged.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => {
      const [file, rule] = key.split("\u0000");
      return `${file} ${rule} ${count}`;
    });
}

/**
 * Task #4531 — verdict-cached full-tree run. The full type-aware scan costs
 * ~166s; the gate and the guard suite both pay it on every run even when not
 * one input byte changed. This wrapper memoizes GREEN verdicts only, keyed on
 * the exact content of every input that can change the verdict: the resolved
 * tsconfig.eslint.json program file list (a superset of the ESLint targets —
 * any linted file OUTSIDE the program makes typescript-eslint error, which is
 * a red verdict and therefore never cached), both tsconfigs, the baseline,
 * package-lock.json, this script and the cache module. Red verdicts, cache
 * errors and key-computation errors all fall open to a full scan, so the
 * cache can never hide a violation. Kill switch: LINT_VERDICT_CACHE=0.
 */
const VERDICT_CACHE_NAME = "lint-async-correctness";

interface CachedVerdictMeta {
  filesScanned: number;
  baselinedCount: number;
  totals: Record<string, number>;
}

export type AsyncLintResult = Awaited<ReturnType<typeof runLint>>;

function collectRealTreeVerdictInputs(
  cwd: string,
): { files: string[]; extra: string[] } | null {
  try {
    const configPath = resolve(cwd, "tsconfig.eslint.json");
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed || parsed.errors.length > 0) return null;
    return {
      files: [
        ...parsed.fileNames,
        resolve(cwd, "tsconfig.eslint.json"),
        resolve(cwd, "tsconfig.json"),
        resolve(cwd, DEFAULT_BASELINE),
        resolve(cwd, "package-lock.json"),
        resolve(cwd, "scripts/lint-async-correctness.ts"),
        resolve(cwd, "scripts/lintVerdictCache.ts"),
      ],
      // The scope map shapes the ESLint target set; its patterns live in this
      // script (hashed above) but fold the names in explicitly for clarity.
      extra: [JSON.stringify(Object.keys(SCOPES).sort())],
    };
  } catch {
    return null;
  }
}

/** Full-tree run with green-verdict memoization (see block comment above).
 * Callers that pass custom scopes/baselines must use runLint directly. */
export async function runLintCachedRealTree(): Promise<
  AsyncLintResult & { fromCache?: boolean }
> {
  const cwd = process.cwd();
  let key: string | null = null;
  if (verdictCacheEnabled()) {
    const inputs = collectRealTreeVerdictInputs(cwd);
    if (inputs) {
      key = computeVerdictKey({
        label: VERDICT_CACHE_NAME,
        repoRoot: cwd,
        files: inputs.files,
        extra: inputs.extra,
      });
    }
  }
  if (key) {
    const hit = readGreenVerdict<CachedVerdictMeta>(cwd, VERDICT_CACHE_NAME, key);
    if (hit) {
      console.log(
        `lint-async-correctness: reused cached green verdict from ${hit.cachedAt} — ` +
          `all inputs (program files, tsconfigs, baseline, lockfile, lint script) are ` +
          `byte-identical to that green run (${hit.meta.filesScanned} file(s), ` +
          `${hit.meta.baselinedCount} baselined). LINT_VERDICT_CACHE=0 forces a full rescan.`,
      );
      return {
        ok: true,
        filesScanned: hit.meta.filesScanned,
        hits: [],
        offenders: [],
        stale: [],
        directiveOffenders: [],
        fatals: [],
        totals: hit.meta.totals,
        baselinedCount: hit.meta.baselinedCount,
        fromCache: true,
      };
    }
  }
  const res = await runLint({ concurrency: defaultConcurrency() });
  if (key && res.ok) {
    writeGreenVerdict<CachedVerdictMeta>(cwd, VERDICT_CACHE_NAME, key, {
      filesScanned: res.filesScanned,
      baselinedCount: res.baselinedCount,
      totals: res.totals,
    });
  }
  return res;
}

const BASELINE_HEADER = [
  "# lint-async-correctness baseline (Task #3817).",
  "# `<file> <rule> <count>` — the frozen pre-existing violation allowance for that",
  "# (file, rule) pair. The gate fails when a pair's count EXCEEDS its allowance",
  "# (new violation) or DROPS BELOW it (ratchet: regenerate so fixed debt cannot",
  "# silently refill). Burn this down; never hand-raise a count — fix the code or",
  "# annotate intentional fire-and-forget with the `void` operator instead.",
  "# Regenerate: npx tsx scripts/lint-async-correctness.ts --update-baseline",
].join("\n");

/**
 * Gate entry point (scripts/gate.ts lint-phase contract, Task #3789): importing
 * this module has no side effects; the gate's worker awaits cliMain() and uses
 * the returned exit code. `argv` deliberately defaults to [] (NOT
 * process.argv.slice(2)): inside a gate worker thread process.argv is the
 * gate's own argv, and honoring it could flip --update-baseline mid-gate. The
 * isMain guard below passes the real CLI args for standalone runs.
 */
export async function cliMain(argv: string[] = []): Promise<number> {
  // Task #4605 — shard-child mode (spawned only by runLint's sharded lane):
  // lint the given scopes serially against the shard tsconfig and emit raw
  // hits as JSON. Verdict evaluation (baseline/ratchet/directives) stays in
  // the parent.
  const shardScopesArg = argv.find((a) => a.startsWith("--shard-scopes="));
  const shardTsconfigArg = argv.find((a) => a.startsWith("--shard-tsconfig="));
  const shardOutArg = argv.find((a) => a.startsWith("--shard-out="));
  if (shardScopesArg && shardTsconfigArg && shardOutArg) {
    const shardScopes = shardScopesArg.slice("--shard-scopes=".length).split(",");
    const shardPatterns = shardScopes.flatMap((s) => SCOPES[s] ?? []);
    if (shardPatterns.length === 0) {
      console.error(`shard child: unknown scopes ${shardScopes.join(",")}`);
      return 1;
    }
    const out = await scanHits(
      process.cwd(),
      shardTsconfigArg.slice("--shard-tsconfig=".length),
      shardPatterns,
    );
    writeFileSync(shardOutArg.slice("--shard-out=".length), JSON.stringify(out));
    return 0;
  }

  const updateBaseline = argv.includes("--update-baseline");
  const scopeArg = argv.find((a) => a.startsWith("--scope="));
  const scopeNames = scopeArg
    ? scopeArg
        .slice("--scope=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  if (scopeNames) {
    const unknown = scopeNames.filter((s) => !SCOPES[s]);
    if (unknown.length > 0) {
      console.error(
        `lint-async-correctness: unknown scope(s) ${unknown.join(", ")} — valid: ${Object.keys(SCOPES).join(", ")}`,
      );
      return 1;
    }
  }
  const patterns = (scopeNames ?? Object.keys(SCOPES)).flatMap((s) => SCOPES[s]);
  // Scope prefix = the scope's root dir ("server/", "client/src/", …).
  const prefixes = scopeNames
    ? scopeNames.map((s) => SCOPES[s][0].split("*")[0])
    : [""];

  // Task #4531: the default no-flag invocation (gate lint phase, bare CLI) is
  // exactly the full-tree run, so it goes through the green-verdict cache.
  // Baseline updates and scoped runs always execute the real scan.
  const useVerdictCache =
    !updateBaseline && !scopeNames && !argv.includes("--no-verdict-cache");
  const res = useVerdictCache
    ? await runLintCachedRealTree()
    : await runLint({
        // Sharding only engages on default-pattern full-tree runs, so pass
        // patterns only for --scope runs (which stay serial — small trees).
        patterns: scopeNames ? patterns : undefined,
        baselineScopePrefixes: prefixes,
        concurrency: scopeNames ? "off" : defaultConcurrency(),
      });

  if (updateBaseline) {
    const baselinePath = resolve(process.cwd(), DEFAULT_BASELINE);
    const rows = buildBaselineRows(res.hits, readBaseline(baselinePath), prefixes);
    writeFileSync(baselinePath, `${BASELINE_HEADER}\n${rows.join("\n")}\n`);
    console.log(
      `lint-async-correctness: wrote ${rows.length} baseline row(s) to ${DEFAULT_BASELINE}` +
        (scopeNames ? ` (scopes rebuilt: ${scopeNames.join(", ")})` : " (all scopes rebuilt)"),
    );
    if (res.fatals.length > 0) {
      for (const f of res.fatals) console.error(`  FATAL ${f.file}:${f.line} ${f.message}`);
      console.error("baseline written, but parse errors above must be fixed — they are never baselinable.");
      return 1;
    }
    return 0;
  }

  for (const d of res.offenders) {
    console.error(
      `NEW: ${d.file} [${d.rule}] ${d.count} hit(s) vs baseline allowance ${d.baselineCount}:`,
    );
    for (const h of d.hits) {
      console.error(`    ${d.file}:${h.line}:${h.column} ${h.message}`);
    }
  }
  for (const d of res.stale) {
    console.error(
      `STALE: ${d.file} [${d.rule}] baseline allows ${d.baselineCount} but only ${d.count} remain — run --update-baseline to ratchet down`,
    );
  }
  for (const f of res.fatals) {
    console.error(`FATAL: ${f.file}:${f.line} ${f.message}`);
  }
  for (const d of res.directiveOffenders) {
    console.error(
      `DIRECTIVE: ${d.file}:${d.line} eslint-disable for a gated async rule — use the \`void\` operator convention instead (ASYNC_CORRECTNESS.md): ${d.text}`,
    );
  }
  const totalHits = Object.values(res.totals).reduce((a, b) => a + b, 0);
  // Honest reporting: on a verdict-cache hit the wrapper already printed
  // "reused cached green verdict" — never claim a scan happened.
  if (!("fromCache" in res && res.fromCache)) {
    console.log(
      `lint-async-correctness: scanned ${res.filesScanned} file(s)` +
        (scopeNames ? ` (scopes: ${scopeNames.join(", ")})` : "") +
        ` — ${totalHits} hit(s), ${res.baselinedCount} baselined, ` +
        `${res.offenders.length} offending pair(s), ${res.stale.length} stale pair(s).`,
    );
  }
  if (!res.ok) {
    console.error(
      "\nFAIL — new async-correctness violations (or a stale baseline).\n" +
        "Fix: await the promise, or for INTENTIONAL fire-and-forget prefix the\n" +
        "call with `void` and a brief reason comment (rejections must be handled\n" +
        "— add `.catch` if the callee doesn't). See ASYNC_CORRECTNESS.md.\n" +
        "If counts genuinely dropped (you fixed debt), run:\n" +
        "  npx tsx scripts/lint-async-correctness.ts --update-baseline",
    );
    return 1;
  }
  console.log("OK");
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-async-correctness.ts");

if (isMain) {
  cliMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error("lint-async-correctness crashed:", err);
      process.exit(1);
    },
  );
}
