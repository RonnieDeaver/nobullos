/**
 * Task #2798 — Catch page-crashing rules-of-hooks violations before they ship.
 * Task #2806 — Add a separate, NON-BLOCKING exhaustive-deps report pass.
 *
 * Background
 * ----------
 * Task #2791 fixed a rules-of-hooks violation in
 * `client/src/pages/ConversationHub.tsx`: an `if (!user) return null` early
 * return sat ABOVE several `useCallback` hooks. React hard-crashes with
 * "Rendered more hooks than during the previous render" the moment the
 * condition flips after mount — a whole-page crash, invisible until the exact
 * auth-resolution timing hits in production. The project has no ESLint config,
 * so nothing caught this bug class anywhere else in the client.
 *
 * What this lint asserts
 * ----------------------
 * Runs the official `eslint-plugin-react-hooks` `rules-of-hooks` rule (the
 * exact rule that would have flagged the #2791 bug) over every `.ts`/`.tsx`
 * file under `client/src/`, via the ESLint Node API with an inline flat
 * config — no eslint.config.js is introduced, so this cannot change any other
 * tooling behavior. Any violation, and any fatal parse error (a file the
 * scanner cannot read is a file the guard cannot vouch for), fails the lint.
 *
 * Scope decisions:
 *   - The HARD GATE enables ONLY `react-hooks/rules-of-hooks`.
 *   - `exhaustive-deps` (stale-closure bugs: effects/callbacks silently
 *     reading stale values because a dependency was omitted) runs as a
 *     SEPARATE, NON-BLOCKING pass (Task #2806) with its own baseline —
 *     see `runExhaustiveDepsLint` below. It was deliberately kept out of the
 *     hard gate in #2798 because it is noisy on the existing tree and would
 *     bury the page-crash signal.
 *   - Plugin pinned to v5.x: v7 requires `zod-validation-error/v4` (a package
 *     this app no longer declares at all); v5 has no such dependency and
 *     contains the same battle-tested rules.
 *
 * Exhaustive-deps pass (Task #2806)
 * ---------------------------------
 * `runExhaustiveDepsLint()` runs `react-hooks/exhaustive-deps` over the same
 * tree with its own baseline (`scripts/lint-react-hooks.exhaustive-deps.baseline.txt`,
 * seeded with the 54 pre-existing hits at introduction). Semantics differ from
 * the hard gate on purpose:
 *   - `ok` means "no NEW (non-baselined) hits" — but the SMOKE test treats
 *     this pass as REPORT-ONLY: new hits are printed loudly, they do NOT fail
 *     the routine validation run.
 *   - Stale baseline entries never fail this pass (baselined line numbers
 *     drift as files are edited; a report-only pass must not demand baseline
 *     maintenance). They are surfaced so the baseline can be pruned.
 *   - Fatal parse errors are IGNORED here — the hard gate already fails on
 *     them; double-reporting would just duplicate the failure.
 *
 * PROMOTION DECISION (recorded per Task #2806): keep exhaustive-deps
 * report-only for now. Promote it to a hard "no new hits" gate (make the SMOKE
 * test assert `res.ok`) only after BOTH of these hold:
 *   1. The seeded baseline has been burned down below ~20 entries, so line
 *      drift in grandfathered files stops producing false "new" hits on
 *      unrelated edits, and
 *   2. A few weeks of report output show the new-hit signal is quiet enough
 *      not to bury the rules-of-hooks crash signal in the same test's logs.
 *
 * PROMOTED (Task #2808): the seeded 54-entry baseline was burned down to 13
 * via real fixes (stable-`mutate` destructuring, useMemo wrapping, primitive
 * field extraction, ref guards for fire-once effects, module-scope constants
 * — not blind dep-adding), and the report showed 0 new hits at flip time.
 * The SMOKE test's real-tree section now asserts `res.ok`: a NEW
 * exhaustive-deps hit fails routine validation. Fix it, or baseline it with
 * a justifying comment. Stale baseline entries still never fail the pass.
 *
 * Gating
 * ------
 * The managed Long validation workflow runs the reviewed routine-gate profile, so this lint is gated through
 * `tests/lint-react-hooks.test.ts` (registered in tests/run-all.ts SMOKE_FILES
 * with `regression: true`), whose first assertion runs runLint() on the real
 * tree — the established pattern for post-cap lint guards.
 *
 * Baseline
 * --------
 * `scripts/lint-react-hooks.baseline.txt` may list one `<file>:<line>` entry
 * per row (relative to repo root; `#` comments allowed) for explicitly
 * grandfathered violations. Baselined hits are reported but do not fail.
 * The rules-of-hooks baseline is empty today — keep it that way; it exists so
 * a future emergency has a documented escape hatch that still names the debt.
 * The exhaustive-deps baseline holds the pre-existing hits; burn it down,
 * never add to it without a comment naming the owner.
 *
 * CLI
 * ---
 *   npx tsx scripts/lint-react-hooks.ts
 *       Hard gate (rules-of-hooks). Exit 1 on any non-baselined violation.
 *   npx tsx scripts/lint-react-hooks.ts --exhaustive-deps
 *       Report-only pass. Prints hits; ALWAYS exits 0 (unless it crashes).
 *   npx tsx scripts/lint-react-hooks.ts --exhaustive-deps --update-baseline
 *       Regenerates the exhaustive-deps baseline from the current tree.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import {
  computeVerdictKey,
  readGreenVerdict,
  verdictCacheEnabled,
  writeGreenVerdict,
} from "./lintVerdictCache";

// Scope intentionally fixed (Task #2846): React hook rules only apply to the
// client React tree; server/scripts/tests contain no React components.
const DEFAULT_PATTERNS = ["client/src/**/*.{ts,tsx}"];
const DEFAULT_BASELINE = "scripts/lint-react-hooks.baseline.txt";
const DEFAULT_EXHAUSTIVE_DEPS_BASELINE =
  "scripts/lint-react-hooks.exhaustive-deps.baseline.txt";
const RULE_ID = "react-hooks/rules-of-hooks";
const EXHAUSTIVE_DEPS_RULE_ID = "react-hooks/exhaustive-deps";

export interface HookViolation {
  /** Path relative to `cwd`. */
  file: string;
  line: number;
  column: number;
  message: string;
  /** True when the hit is grandfathered by the baseline file. */
  baselined: boolean;
  /** True for fatal parse errors (always fail — never baselinable). */
  fatal: boolean;
}

export interface LintResult {
  ok: boolean;
  /** Every rule hit + fatal parse error found, baselined or not. */
  violations: HookViolation[];
  /** Non-baselined subset of `violations`. */
  offenders: HookViolation[];
  filesScanned: number;
  baselinedCount: number;
  /** Baseline entries that no longer match any violation (stale). */
  staleBaselineEntries: string[];
}

export interface LintOptions {
  /** Glob patterns to lint, relative to `cwd`. Default: client/src TS/TSX. */
  patterns?: string[];
  /** Working directory for globbing + relative paths. Default: repo root. */
  cwd?: string;
  /** Baseline file path (default depends on the pass). */
  baselinePath?: string;
}

function readBaseline(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const out = new Set<string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (line) out.add(line);
  }
  return out;
}

async function runRuleLint(
  ruleId: string,
  defaultBaseline: string,
  behavior: {
    /** Fatal parse errors become offenders (hard gate) or are dropped. */
    includeFatal: boolean;
    /** Stale baseline entries flip `ok` to false (hard gate only). */
    staleBaselineFails: boolean;
  },
  opts?: LintOptions,
): Promise<LintResult> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  const patterns = opts?.patterns ?? DEFAULT_PATTERNS;
  const baseline = readBaseline(
    resolve(cwd, opts?.baselinePath ?? defaultBaseline),
  );

  const eslint = new ESLint({
    cwd,
    // `true` = do NOT look for an eslint.config.js; the inline flat config
    // below is the entire configuration. Keeps this guard hermetic.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
        },
        plugins: { "react-hooks": reactHooks },
        rules: { [ruleId]: "error" },
      },
    ],
  });

  const results = await eslint.lintFiles(patterns);

  const violations: HookViolation[] = [];
  const matchedBaselineEntries = new Set<string>();
  for (const r of results) {
    const file = relative(cwd, r.filePath);
    for (const m of r.messages) {
      const isFatal = Boolean(m.fatal);
      if (isFatal && !behavior.includeFatal) continue;
      if (!isFatal && m.ruleId !== ruleId) continue;
      const key = `${file}:${m.line ?? 0}`;
      const baselined = !isFatal && baseline.has(key);
      if (baselined) matchedBaselineEntries.add(key);
      violations.push({
        file,
        line: m.line ?? 0,
        column: m.column ?? 0,
        message: isFatal ? `parse error: ${m.message}` : m.message,
        baselined,
        fatal: isFatal,
      });
    }
  }

  const offenders = violations.filter((v) => !v.baselined);
  const staleBaselineEntries = [...baseline].filter(
    (e) => !matchedBaselineEntries.has(e),
  );

  return {
    ok:
      offenders.length === 0 &&
      (!behavior.staleBaselineFails || staleBaselineEntries.length === 0),
    violations,
    offenders,
    filesScanned: results.length,
    baselinedCount: matchedBaselineEntries.size,
    staleBaselineEntries,
  };
}

/**
 * HARD GATE (Task #2798): react-hooks/rules-of-hooks. Any non-baselined
 * violation, fatal parse error, or stale baseline entry fails.
 */
export async function runLint(opts?: LintOptions): Promise<LintResult> {
  return runRuleLint(
    RULE_ID,
    DEFAULT_BASELINE,
    { includeFatal: true, staleBaselineFails: true },
    opts,
  );
}

/**
 * REPORT-ONLY PASS (Task #2806): react-hooks/exhaustive-deps against its own
 * baseline. `ok === false` means new (non-baselined) stale-dependency hits
 * exist — callers decide whether that blocks; the SMOKE test only reports.
 * Stale baseline entries and fatal parse errors never fail this pass (the
 * hard gate owns parse errors; baselined line numbers drift as files change).
 */
export async function runExhaustiveDepsLint(
  opts?: LintOptions,
): Promise<LintResult> {
  return runRuleLint(
    EXHAUSTIVE_DEPS_RULE_ID,
    DEFAULT_EXHAUSTIVE_DEPS_BASELINE,
    { includeFatal: false, staleBaselineFails: false },
    opts,
  );
}

/**
 * Task #4531 — verdict-cached real-tree runs. The two real-tree passes
 * (rules-of-hooks hard gate + promoted exhaustive-deps gate) scan ~470
 * client files (~80s) on every full-set validation even when nothing under
 * client/src changed. This wrapper memoizes GREEN verdicts only, keyed on
 * the exact content of every scanned file plus both baselines, the lockfile
 * (plugin/parser versions), this script and the cache module. A red verdict
 * on EITHER pass is never cached; any cache error falls open to a full scan.
 * Kill switch: LINT_VERDICT_CACHE=0.
 */
const VERDICT_CACHE_NAME = "lint-react-hooks";

interface RealTreeVerdictMeta {
  hard: { filesScanned: number; baselinedCount: number };
  deps: {
    filesScanned: number;
    baselinedCount: number;
    staleBaselineEntries: string[];
  };
}

export interface RealTreeHookLints {
  hard: LintResult;
  deps: LintResult;
  fromCache?: boolean;
}

function listClientTreeFiles(cwd: string): string[] | null {
  try {
    const out: string[] = [];
    const walk = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
    };
    walk(resolve(cwd, "client/src"));
    return out;
  } catch {
    return null;
  }
}

function syntheticGreen(meta: {
  filesScanned: number;
  baselinedCount: number;
  staleBaselineEntries?: string[];
}): LintResult {
  return {
    ok: true,
    violations: [],
    offenders: [],
    filesScanned: meta.filesScanned,
    baselinedCount: meta.baselinedCount,
    staleBaselineEntries: meta.staleBaselineEntries ?? [],
  };
}

/** Both real-tree passes with green-verdict memoization (see block comment
 * above). Fixture/scoped callers must use runLint/runExhaustiveDepsLint. */
export async function runRealTreeHookLintsCached(): Promise<RealTreeHookLints> {
  const cwd = process.cwd();
  let key: string | null = null;
  if (verdictCacheEnabled()) {
    const files = listClientTreeFiles(cwd);
    if (files) {
      key = computeVerdictKey({
        label: VERDICT_CACHE_NAME,
        repoRoot: cwd,
        files: [
          ...files,
          resolve(cwd, DEFAULT_BASELINE),
          resolve(cwd, DEFAULT_EXHAUSTIVE_DEPS_BASELINE),
          resolve(cwd, "package-lock.json"),
          resolve(cwd, "scripts/lint-react-hooks.ts"),
          resolve(cwd, "scripts/lintVerdictCache.ts"),
        ],
      });
    }
  }
  if (key) {
    const hit = readGreenVerdict<RealTreeVerdictMeta>(cwd, VERDICT_CACHE_NAME, key);
    if (hit) {
      console.log(
        `lint-react-hooks: reused cached green verdict from ${hit.cachedAt} — ` +
          `client tree, baselines, lockfile and lint script are byte-identical to that ` +
          `green run (${hit.meta.hard.filesScanned} file(s)). LINT_VERDICT_CACHE=0 forces a full rescan.`,
      );
      return {
        hard: syntheticGreen(hit.meta.hard),
        deps: syntheticGreen(hit.meta.deps),
        fromCache: true,
      };
    }
  }
  const hard = await runLint();
  const deps = await runExhaustiveDepsLint();
  if (key && hard.ok && deps.ok) {
    writeGreenVerdict<RealTreeVerdictMeta>(cwd, VERDICT_CACHE_NAME, key, {
      hard: { filesScanned: hard.filesScanned, baselinedCount: hard.baselinedCount },
      deps: {
        filesScanned: deps.filesScanned,
        baselinedCount: deps.baselinedCount,
        staleBaselineEntries: deps.staleBaselineEntries,
      },
    });
  }
  return { hard, deps };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-react-hooks.ts");

if (isMain) {
  const args = process.argv.slice(2);
  const exhaustiveDepsMode = args.includes("--exhaustive-deps");
  const updateBaseline = args.includes("--update-baseline");

  if (exhaustiveDepsMode) {
    runExhaustiveDepsLint()
      .then((res) => {
        if (updateBaseline) {
          const header = [
            "# lint-react-hooks exhaustive-deps baseline (Task #2806).",
            "# One `<file>:<line>` per row, relative to repo root. `#` starts a comment.",
            "# These are PRE-EXISTING react-hooks/exhaustive-deps hits grandfathered when",
            "# the report-only pass was introduced. Burn this list down; never add to it",
            "# without a comment naming why and who owns removing it.",
            "# Regenerate: npx tsx scripts/lint-react-hooks.ts --exhaustive-deps --update-baseline",
          ].join("\n");
          const entries = res.violations
            .map((v) => `${v.file}:${v.line}`)
            .sort();
          writeFileSync(
            resolve(process.cwd(), DEFAULT_EXHAUSTIVE_DEPS_BASELINE),
            `${header}\n${entries.join("\n")}\n`,
          );
          console.log(
            `wrote ${entries.length} entries to ${DEFAULT_EXHAUSTIVE_DEPS_BASELINE}`,
          );
          return;
        }
        for (const v of res.violations) {
          const tag = v.baselined ? " [grandfathered]" : " [NEW]";
          console.log(`${v.file}:${v.line}:${v.column} ${v.message}${tag}`);
        }
        for (const s of res.staleBaselineEntries) {
          console.log(
            `stale baseline entry (no longer matches — prune when convenient): ${s}`,
          );
        }
        console.log(
          `lint-react-hooks (exhaustive-deps, report-only): scanned ${res.filesScanned} file(s), ` +
            `${res.offenders.length} NEW hit(s), ${res.baselinedCount} grandfathered.`,
        );
        if (res.offenders.length > 0) {
          console.log(
            "NOTE — new stale-dependency hits above are advisory (this pass " +
              "never blocks); fix them or, with a justifying comment, baseline them.",
          );
        }
        console.log("OK (report-only)");
      })
      .catch((err) => {
        console.error("lint-react-hooks (exhaustive-deps) crashed:", err);
        process.exit(1);
      });
  } else {
    runLint()
      .then((res) => {
        for (const v of res.violations) {
          const tag = v.baselined ? " [grandfathered]" : "";
          console.log(`${v.file}:${v.line}:${v.column} ${v.message}${tag}`);
        }
        for (const s of res.staleBaselineEntries) {
          console.error(
            `stale baseline entry (no longer matches a violation — remove it): ${s}`,
          );
        }
        console.log(
          `lint-react-hooks: scanned ${res.filesScanned} file(s), ` +
            `${res.offenders.length} violation(s), ${res.baselinedCount} grandfathered.`,
        );
        if (!res.ok) {
          console.error(
            "FAIL — hooks must be called unconditionally at the top level of a " +
              "component/hook, above any early return. See Task #2791 " +
              "(ConversationHub) for the crash this prevents.",
          );
          process.exit(1);
        }
        console.log("OK");
      })
      .catch((err) => {
        console.error("lint-react-hooks crashed:", err);
        process.exit(1);
      });
  }
}
