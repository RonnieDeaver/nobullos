/* test-registration
{
  "name": "Redis cache env-detection lint guard (Task #3340)",
  "smoke": true,
  "smokeReason": "Task #3340: redisCache.ts env-namespace detection drift guard. The Jul 20 incident: ENV_KEY was derived from the nonexistent REPL_DEPLOYMENT var (always falsy in both envs), so dev and prod shared nobull:dev:* on the shared Upstash instance. First assertion group exercises the lint on the exact bug fixture; B1 runs scripts/lint-redis-cache-env-detection.ts on the REAL redisCache.ts. Task #3379 added a repo-wide pass (Group C / runRepoLint): no file under server/ except the allow-listed canonical helper may inline process.env.REPLIT_DEPLOYMENT / REPL_DEPLOYMENT. The managed Long validation workflow runs the reviewed routine-gate profile, including this SMOKE_FILES coverage. Fast, DB-free, deterministic.",
  "tier": "medium",
  "tierReason": "Scans cache environment usage and validates detection against fixture source trees."
}
test-registration */
// Task #3340 — Drift guard: redisCache.ts env-namespace detection.
//
// Group A — lint behavior on fixture files (tmpdir):
//   A1. Old-bug fixture (`process.env.REPL_DEPLOYMENT === "production"`) → violations
//       (ENV_KEY not from helper, missing import, inline env access).
//   A2. Inline REPLIT_DEPLOYMENT expression (right variable, wrong pattern) → violation.
//   A3. Drifted import path (local copy of the helper) → violation.
//   A4. Correct fixture (canonical import + helper-derived ENV_KEY) → passes.
//   A5. Comments naming the old variable are NOT flagged.
//   A6. KEY_PREFIX no longer derived from ENV_KEY → violation.
//   A7. ENV_KEY removed entirely → violation.
//
// Group B — real tree:
//   B1. The real server/services/cache/redisCache.ts passes the lint.
//
// Group C — repo-wide scan (Task #3379):
//   C1. Fixture tree with an inline REPLIT_DEPLOYMENT check in a non-allow-listed
//       file → violation naming that file.
//   C2. The nonexistent REPL_DEPLOYMENT variable anywhere → violation.
//   C3. Allow-listed file with the raw variable → passes.
//   C4. REPLIT_DEPLOYMENT_URL (different, legitimate variable) → NOT flagged.
//   C5. Old variable named only in comments → NOT flagged.
//   C6. Real repo-wide scan of server/ passes (only the canonical helper touches
//       the raw variables).
//
// Usage: tsx tests/lint-redis-cache-env-detection.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLint,
  runRepoLint,
  stripComments,
  REPO_SCAN_ALLOWLIST,
} from "../scripts/lint-redis-cache-env-detection";

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

console.log("\n[lint-redis-cache-env-detection] regression suite");

const tmpRoot = mkdtempSync(join(tmpdir(), "lint-redis-env-"));

function writeFixture(name: string, src: string): string {
  const p = join(tmpRoot, name);
  writeFileSync(p, src);
  return p;
}

const GOOD_HEADER = `import { Redis } from "@upstash/redis";
import { isRunningInDeployment } from "../../lib/deploymentEnv";
`;

// ─── A1: the exact Jul 20 incident pattern ──────────────────────────────────
{
  const file = writeFixture(
    "oldBug.ts",
    `import { Redis } from "@upstash/redis";
const ENV_KEY = process.env.REPL_DEPLOYMENT === "production" ? "prod" : "dev";
const KEY_PREFIX = \`nobull:\${ENV_KEY}\`;
`,
  );
  const result = runLint({ targetFile: file });
  assert(!result.ok, "A1: old REPL_DEPLOYMENT bug pattern fails the lint");
  assert(
    result.violations.some((v) => v.reason.includes("isRunningInDeployment")),
    "A1: ENV_KEY-not-from-helper violation reported",
  );
  assert(
    result.violations.some((v) => v.reason.includes("REPL_DEPLOYMENT")),
    "A1: inline REPL_DEPLOYMENT access flagged",
  );
}

// ─── A2: inline REPLIT_DEPLOYMENT (right var, wrong pattern) ────────────────
{
  const file = writeFixture(
    "inlineReplit.ts",
    `import { Redis } from "@upstash/redis";
const ENV_KEY = process.env.REPLIT_DEPLOYMENT === "1" ? "prod" : "dev";
const KEY_PREFIX = \`nobull:\${ENV_KEY}\`;
`,
  );
  const result = runLint({ targetFile: file });
  assert(!result.ok, "A2: inline process.env.REPLIT_DEPLOYMENT fails the lint");
  assert(
    result.violations.some((v) => v.reason.includes("process.env.REPLIT_DEPLOYMENT")),
    "A2: inline REPLIT_DEPLOYMENT access flagged",
  );
}

// ─── A3: drifted import path ─────────────────────────────────────────────────
{
  const file = writeFixture(
    "driftedImport.ts",
    `import { isRunningInDeployment } from "./localDeploymentEnv";
const ENV_KEY = isRunningInDeployment() ? "prod" : "dev";
const KEY_PREFIX = \`nobull:\${ENV_KEY}\`;
`,
  );
  const result = runLint({ targetFile: file });
  assert(!result.ok, "A3: drifted import path fails the lint");
  assert(
    result.violations.some((v) => v.reason.includes("./localDeploymentEnv")),
    "A3: the wrong import source is named in the violation",
  );
}

// ─── A4: correct fixture passes ──────────────────────────────────────────────
{
  const file = writeFixture(
    "good.ts",
    GOOD_HEADER +
      `const ENV_KEY = isRunningInDeployment() ? "prod" : "dev";
const KEY_PREFIX = \`nobull:\${ENV_KEY}\`;
`,
  );
  const result = runLint({ targetFile: file });
  assert(result.ok, "A4: canonical helper-derived fixture passes");
}

// ─── A5: comments naming the old variable are not flagged ───────────────────
{
  const file = writeFixture(
    "commented.ts",
    GOOD_HEADER +
      `// The old expression used process.env.REPL_DEPLOYMENT — never do that.
/* Also not this: process.env.REPLIT_DEPLOYMENT inline */
const ENV_KEY = isRunningInDeployment() ? "prod" : "dev";
const KEY_PREFIX = \`nobull:\${ENV_KEY}\`;
`,
  );
  const result = runLint({ targetFile: file });
  assert(result.ok, "A5: old variable named only in comments is not flagged");
  assert(
    !stripComments("// process.env.REPL_DEPLOYMENT\nconst x = 1;").includes("REPL_DEPLOYMENT"),
    "A5: stripComments removes line comments",
  );
}

// ─── A6: KEY_PREFIX detached from ENV_KEY ────────────────────────────────────
{
  const file = writeFixture(
    "detachedPrefix.ts",
    GOOD_HEADER +
      `const ENV_KEY = isRunningInDeployment() ? "prod" : "dev";
const KEY_PREFIX = "nobull:dev";
`,
  );
  const result = runLint({ targetFile: file });
  assert(!result.ok, "A6: KEY_PREFIX not derived from ENV_KEY fails the lint");
  assert(
    result.violations.some((v) => v.reason.includes("KEY_PREFIX")),
    "A6: KEY_PREFIX violation reported",
  );
}

// ─── A7: ENV_KEY removed entirely ────────────────────────────────────────────
{
  const file = writeFixture(
    "noEnvKey.ts",
    GOOD_HEADER + `const KEY_PREFIX = "nobull:prod";\n`,
  );
  const result = runLint({ targetFile: file });
  assert(!result.ok, "A7: missing ENV_KEY assignment fails the lint");
  assert(
    result.violations.some((v) => v.reason.includes("ENV_KEY")),
    "A7: missing-ENV_KEY violation reported",
  );
}

rmSync(tmpRoot, { recursive: true, force: true });

// ─── Group B: real tree ──────────────────────────────────────────────────────
console.log("\n  [B] Real redisCache.ts scan …");
{
  const result = runLint();
  if (result.ok) {
    console.log("  ✓ B1: real server/services/cache/redisCache.ts passes the lint");
    passed++;
  } else {
    failed++;
    console.error("  ✗ B1: real redisCache.ts FAILED the env-detection lint:");
    for (const v of result.violations) {
      console.error(`    ${v.file}: ${v.reason}`);
    }
  }
}

// ─── Group C: repo-wide scan (Task #3379) ────────────────────────────────────
console.log("\n  [C] Repo-wide inline-env scan …");

const repoTmp = mkdtempSync(join(tmpdir(), "lint-repo-env-"));

function writeRepoFixture(relPath: string, src: string): string {
  const p = join(repoTmp, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, src);
  return p.replace(/\\/g, "/");
}

// C1: inline REPLIT_DEPLOYMENT in a non-allow-listed file → violation.
{
  const bad = writeRepoFixture(
    "services/newCache.ts",
    `const isProd = process.env.REPLIT_DEPLOYMENT === "1";\nexport const ns = isProd ? "prod" : "dev";\n`,
  );
  const result = runRepoLint({ root: repoTmp, allowlist: new Set() });
  assert(!result.ok, "C1: inline REPLIT_DEPLOYMENT in a new file fails the repo scan");
  assert(
    result.violations.some((v) => v.file === bad && v.reason.includes("REPLIT_DEPLOYMENT")),
    "C1: the offending file is named in the violation",
  );
  rmSync(join(repoTmp, "services"), { recursive: true, force: true });
}

// C2: the nonexistent REPL_DEPLOYMENT variable → violation.
{
  writeRepoFixture(
    "workers/gate.ts",
    `export const gate = process.env.REPL_DEPLOYMENT === "production";\n`,
  );
  const result = runRepoLint({ root: repoTmp, allowlist: new Set() });
  assert(!result.ok, "C2: nonexistent REPL_DEPLOYMENT variable fails the repo scan");
  assert(
    result.violations.some((v) => v.reason.includes("REPL_DEPLOYMENT")),
    "C2: REPL_DEPLOYMENT named in the violation",
  );
  rmSync(join(repoTmp, "workers"), { recursive: true, force: true });
}

// C3: allow-listed file with the raw variable → passes.
{
  const allowed = writeRepoFixture(
    "lib/deploymentEnv.ts",
    `export function isRunningInDeployment(): boolean {\n  return process.env.REPLIT_DEPLOYMENT === "1";\n}\n`,
  );
  const result = runRepoLint({ root: repoTmp, allowlist: new Set([allowed]) });
  assert(result.ok, "C3: allow-listed canonical helper passes the repo scan");
  rmSync(join(repoTmp, "lib"), { recursive: true, force: true });
}

// C4: REPLIT_DEPLOYMENT_URL (different variable) → NOT flagged.
{
  writeRepoFixture(
    "services/alerts.ts",
    `const base = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN;\nexport const link = \`https://\${base}/admin\`;\n`,
  );
  const result = runRepoLint({ root: repoTmp, allowlist: new Set() });
  assert(result.ok, "C4: REPLIT_DEPLOYMENT_URL is not flagged (word boundary)");
  rmSync(join(repoTmp, "services"), { recursive: true, force: true });
}

// C5: old variable named only in comments → NOT flagged.
{
  writeRepoFixture(
    "services/commented.ts",
    `// never use process.env.REPL_DEPLOYMENT here\n/* nor process.env.REPLIT_DEPLOYMENT inline */\nexport const x = 1;\n`,
  );
  const result = runRepoLint({ root: repoTmp, allowlist: new Set() });
  assert(result.ok, "C5: variables named only in comments are not flagged");
}

rmSync(repoTmp, { recursive: true, force: true });

// C6: real server/ tree passes the repo-wide scan.
{
  const result = runRepoLint();
  if (result.ok) {
    console.log("  ✓ C6: real server/ tree passes the repo-wide inline-env scan");
    passed++;
  } else {
    failed++;
    console.error("  ✗ C6: real server/ tree FAILED the repo-wide inline-env scan:");
    for (const v of result.violations) {
      console.error(`    ${v.file}: ${v.reason}`);
    }
  }
  assert(
    REPO_SCAN_ALLOWLIST.has("server/lib/deploymentEnv.ts"),
    "C6: canonical helper is on the allow-list",
  );
}

console.log(`\n[lint-redis-cache-env-detection] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
