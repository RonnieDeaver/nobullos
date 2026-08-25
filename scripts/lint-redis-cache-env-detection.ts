/**
 * Task #3340 — Guard the Redis key-prefix env detection in redisCache.ts.
 *
 * Background (Jul 20 2026 incident): the Redis key namespace was derived from
 * `process.env.REPL_DEPLOYMENT === "production"` — a variable Replit never
 * sets (the real one is `REPLIT_DEPLOYMENT=1`). The expression was falsy in
 * BOTH environments, so dev and prod shared `nobull:dev:*` on the same
 * Upstash instance and dev breaker/settings state bled into prod badges.
 * The fix routes env detection through the canonical
 * `isRunningInDeployment()` helper in `server/lib/deploymentEnv.ts`.
 *
 * This lint fails fast (before tests run) if that fix regresses:
 *   1. `redisCache.ts` must import `isRunningInDeployment` from
 *      `../../lib/deploymentEnv` (the single canonical helper — no local
 *      re-implementation, no drifted copy).
 *   2. The `ENV_KEY` assignment must call `isRunningInDeployment()`.
 *   3. No bare `process.env.REPLIT_DEPLOYMENT` / `process.env.REPL_DEPLOYMENT`
 *      inline expression anywhere in redisCache.ts CODE (comments stripped) —
 *      env detection must not be re-inlined, and the old always-falsy
 *      REPL_DEPLOYMENT variable must never come back.
 *   4. `KEY_PREFIX` must still be derived from `ENV_KEY` (so the guarded
 *      detection actually feeds the namespace).
 *
 * Task #3379 extends this with a REPO-WIDE pass: no file under server/
 * (other than the canonical helper) may inline
 * `process.env.REPLIT_DEPLOYMENT` / `process.env.REPL_DEPLOYMENT` — every
 * dev-vs-prod check must route through `isRunningInDeployment()` from
 * `server/lib/deploymentEnv.ts`. The `\b` word boundary deliberately
 * excludes `process.env.REPLIT_DEPLOYMENT_URL` (a different, legitimate
 * variable used for alert links).
 *
 * Exit codes: 0 ok, 1 if any violation found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TARGET = "server/services/cache/redisCache.ts";
const REQUIRED_IMPORT_SOURCE = "../../lib/deploymentEnv";
const REPO_SCAN_ROOT = "server";

/**
 * Files allowed to touch the raw deployment env vars. Keep this list SHORT —
 * the whole point is that new code uses isRunningInDeployment() instead.
 */
export const REPO_SCAN_ALLOWLIST = new Set<string>([
  "server/lib/deploymentEnv.ts",
]);

export interface LintResult {
  ok: boolean;
  violations: Array<{ file: string; reason: string }>;
}

/** Strip // line comments and /* block comments so commented-out code
 *  (including the incident post-mortem comment that NAMES the old variable)
 *  is never flagged. String contents are irrelevant here — the patterns we
 *  scan for (`process.env.X`) don't appear inside string literals in this
 *  file, and masking strings would risk the regex-literal pitfall. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function runLint(opts?: { targetFile?: string }): LintResult {
  const target = opts?.targetFile ?? DEFAULT_TARGET;
  const violations: LintResult["violations"] = [];

  let src: string;
  try {
    src = readFileSync(target, "utf8");
  } catch (err: any) {
    return {
      ok: false,
      violations: [
        { file: target, reason: `Could not read target file: ${err?.message ?? err}` },
      ],
    };
  }

  const code = stripComments(src);

  // 1. Canonical import: isRunningInDeployment from ../../lib/deploymentEnv.
  const importRe =
    /import\s*\{[^}]*\bisRunningInDeployment\b[^}]*\}\s*from\s*["']([^"']+)["']/;
  const importMatch = code.match(importRe);
  if (!importMatch) {
    violations.push({
      file: target,
      reason:
        "missing `import { isRunningInDeployment } from \"../../lib/deploymentEnv\"` — env detection must use the canonical deployment helper",
    });
  } else if (importMatch[1] !== REQUIRED_IMPORT_SOURCE) {
    violations.push({
      file: target,
      reason: `isRunningInDeployment imported from "${importMatch[1]}" instead of the canonical "${REQUIRED_IMPORT_SOURCE}" — a drifted copy can silently disagree with the real helper`,
    });
  }

  // 2. ENV_KEY assignment must call isRunningInDeployment().
  const envKeyRe = /const\s+ENV_KEY\s*=\s*([^;\n]+)/;
  const envKeyMatch = code.match(envKeyRe);
  if (!envKeyMatch) {
    violations.push({
      file: target,
      reason:
        "no `const ENV_KEY = ...` assignment found — the env-namespace derivation was removed or renamed; update this lint if the rename is intentional",
    });
  } else if (!/\bisRunningInDeployment\s*\(\s*\)/.test(envKeyMatch[1])) {
    violations.push({
      file: target,
      reason: `ENV_KEY is derived from \`${envKeyMatch[1].trim()}\` instead of isRunningInDeployment() — this is the exact regression that caused the Jul 20 2026 dev/prod key-prefix bleed`,
    });
  }

  // 3. No inline process.env deployment checks (the old bug pattern).
  const inlineEnvRe = /process\.env\.(REPLIT_DEPLOYMENT|REPL_DEPLOYMENT)\b/g;
  let m: RegExpExecArray | null;
  while ((m = inlineEnvRe.exec(code)) !== null) {
    violations.push({
      file: target,
      reason: `inline \`process.env.${m[1]}\` found in code — env detection must route through isRunningInDeployment() (and REPL_DEPLOYMENT is a nonexistent variable: always falsy in both envs)`,
    });
  }

  // 4. KEY_PREFIX must be derived from ENV_KEY.
  const keyPrefixRe = /const\s+KEY_PREFIX\s*=\s*([^;\n]+)/;
  const keyPrefixMatch = code.match(keyPrefixRe);
  if (!keyPrefixMatch) {
    violations.push({
      file: target,
      reason:
        "no `const KEY_PREFIX = ...` assignment found — the namespace prefix was removed or renamed; update this lint if the rename is intentional",
    });
  } else if (!/\bENV_KEY\b/.test(keyPrefixMatch[1])) {
    violations.push({
      file: target,
      reason: `KEY_PREFIX (\`${keyPrefixMatch[1].trim()}\`) does not reference ENV_KEY — the guarded env detection no longer feeds the Redis key namespace`,
    });
  }

  return { ok: violations.length === 0, violations };
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
}

/**
 * Task #3379 — repo-wide pass: scan every source file under server/ for
 * inline `process.env.REPLIT_DEPLOYMENT` / `process.env.REPL_DEPLOYMENT`
 * (comments stripped). Only files in REPO_SCAN_ALLOWLIST may touch the raw
 * variables. `REPLIT_DEPLOYMENT_URL` is a different variable and is NOT
 * matched (word boundary).
 */
export function runRepoLint(opts?: {
  root?: string;
  allowlist?: Set<string>;
}): LintResult {
  const root = opts?.root ?? REPO_SCAN_ROOT;
  const allowlist = opts?.allowlist ?? REPO_SCAN_ALLOWLIST;
  const violations: LintResult["violations"] = [];

  let files: string[] = [];
  try {
    walkTsFiles(root, files);
  } catch (err: any) {
    return {
      ok: false,
      violations: [
        { file: root, reason: `Could not walk scan root: ${err?.message ?? err}` },
      ],
    };
  }

  const inlineEnvRe = /process\.env\.(REPLIT_DEPLOYMENT|REPL_DEPLOYMENT)\b/g;
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (allowlist.has(normalized)) continue;
    let code: string;
    try {
      code = stripComments(readFileSync(file, "utf8"));
    } catch (err: any) {
      violations.push({
        file: normalized,
        reason: `Could not read file: ${err?.message ?? err}`,
      });
      continue;
    }
    let m: RegExpExecArray | null;
    inlineEnvRe.lastIndex = 0;
    while ((m = inlineEnvRe.exec(code)) !== null) {
      violations.push({
        file: normalized,
        reason: `inline \`process.env.${m[1]}\` — dev-vs-prod detection must route through isRunningInDeployment() from server/lib/deploymentEnv.ts (and REPL_DEPLOYMENT is a nonexistent variable: always falsy in both envs)`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

function main(): void {
  const target = runLint();
  const repo = runRepoLint();
  if (target.ok && repo.ok) {
    console.log("lint-redis-cache-env-detection: OK");
    process.exit(0);
  }
  const violations = [...target.violations, ...repo.violations];
  console.error(
    `lint-redis-cache-env-detection: ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error(
    "\nFix: derive every dev-vs-prod check from isRunningInDeployment()\n" +
      "imported from server/lib/deploymentEnv.ts. Never inline a\n" +
      "process.env.REPLIT_DEPLOYMENT check (and REPL_DEPLOYMENT does not exist).\n" +
      "If a file legitimately needs the raw variable, add it to\n" +
      "REPO_SCAN_ALLOWLIST in scripts/lint-redis-cache-env-detection.ts.\n" +
      "See .agents/memory/redis-cache-env-namespace-collision.md.",
  );
  process.exit(1);
}

// Guard against process.exit firing when imported as a module in tests.
const isMain =
  process.argv[1]?.endsWith("lint-redis-cache-env-detection.ts") ||
  process.argv[1]?.endsWith("lint-redis-cache-env-detection.js");
if (isMain) main();
