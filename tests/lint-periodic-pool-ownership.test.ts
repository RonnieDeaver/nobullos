/* test-registration
{
  "name": "lint-periodic-pool-ownership guard (Task #3944)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3944: guards the periodic-pool-ownership lint — AST classification of periodic/background modules (setInterval, node-cron, supervised samplers, boot-seeded services) and request-pool consumption detection, incl. the aliased-import forms text matching gets wrong. Pins the sanctioned exception-marker set so it cannot silently grow. Fast, DB-free, deterministic (tmp fixtures + real server/ scan).",
  "tier": "small"
}
test-registration */
/**
 * Task #3944 — guard tests for scripts/lint-periodic-pool-ownership.ts.
 *
 * Spec fixture matrix (all eight):
 *   1. Periodic service importing the request pool → fails.
 *   2. Same service on the worker boundary (workerDb) → passes.
 *   3. Request-only module importing db (no periodic construct) → passes.
 *   4. `setInterval` appearing only in a comment → not periodic → passes.
 *   5. Import-looking text inside a string literal → no violation (AST).
 *   6. Aliased imports classified by IMPORTED name:
 *      `workerDb as db` passes; `db as apiDb` fails.
 *   7. Type-only imports from the db module → pass.
 *   8. The exception mechanism is the ONLY escape: marker with reason
 *      passes; missing/short reason fails; stale marker (no violation
 *      underneath) fails; there is no filename allow-list.
 * Plus repo-level pins: the real server/ tree passes, and the documented
 * exception set is EXACTLY the seven sanctioned files.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runLint, EXCEPTION_MARKER } from "../scripts/lint-periodic-pool-ownership";

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

function fixture(): { root: string; write: (rel: string, content: string) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-periodic-pool-"));
  return {
    root,
    write: (rel, content) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const DB_MODULE = "export const db = 1; export const apiPool = 2; export const workerDb = 3;\n";

function run(files: Record<string, string>, bootSeedFiles: string[] = []) {
  const { root, write, cleanup } = fixture();
  try {
    write("server/db.ts", DB_MODULE);
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    return runLint({ cwd: root, bootSeedFiles });
  } finally {
    cleanup();
  }
}

console.log("1) periodic service consuming the request pool fails");
{
  const res = run({
    "server/services/bad.ts":
      'import { db } from "../db";\nsetInterval(() => { void db; }, 60_000);\n',
  });
  assert(!res.ok && res.violations.length === 1, "setInterval + db import fails");
  assert(
    res.violations[0].message.includes("server/services/bad.ts") &&
      res.violations[0].message.includes("workerDb") &&
      res.violations[0].message.includes("runWithWorkerDb"),
    "error names the file and the approved worker boundary",
  );
  assert(res.periodicFiles.includes("server/services/bad.ts"), "file classified periodic");

  const cron = run({
    "server/services/cronjob.ts":
      'import cron from "node-cron";\nimport { apiPool } from "../db";\ncron.schedule("* * * * *", () => { void apiPool; });\n',
  });
  assert(!cron.ok, "node-cron + apiPool import fails");

  const dyn = run({
    "server/services/dyn.ts":
      'setInterval(async () => {\n  const { db } = await import("../db");\n  void db;\n}, 1000);\n',
  });
  assert(!dyn.ok && dyn.violations[0].kind === "dynamic-destructure", "dynamic `{ db }` destructure in a periodic module fails");

  const ns = run({
    "server/services/ns.ts":
      'import * as dbmod from "../db";\nsetInterval(() => { void dbmod.db; }, 1000);\n',
  });
  assert(!ns.ok && ns.violations[0].kind === "namespace-access", "namespace-import access `dbmod.db` fails");
}

console.log("2) the same service on the worker boundary passes");
{
  const res = run({
    "server/services/good.ts":
      'import { workerDb, runWithWorkerDb } from "../db";\nsetInterval(() => runWithWorkerDb(async () => { void workerDb; }), 60_000);\n',
  });
  assert(res.ok, "setInterval + workerDb/runWithWorkerDb passes");

  const dynOk = run({
    "server/services/dyngood.ts":
      'setInterval(async () => {\n  const { workerDb, withDbHoldLabel } = await import("../db");\n  void workerDb; void withDbHoldLabel;\n}, 1000);\n',
  });
  assert(dynOk.ok, "dynamic destructure of worker/helper exports passes");
}

console.log("3) request-only module importing db passes");
{
  const res = run({
    "server/routes/orders.ts": 'import { db } from "../db";\nexport function handler() { return db; }\n',
  });
  assert(res.ok, "route file importing db with no periodic construct passes");
  assert(res.periodicFiles.length === 0, "not classified periodic");
}

console.log("4) setInterval only in a comment is not periodic");
{
  const res = run({
    "server/services/commented.ts":
      'import { db } from "../db";\n// we used to setInterval( here — removed in Task #123\n/* setInterval(tick, 500) */\nexport const x = db;\n',
  });
  assert(res.ok, "comment-mentioned setInterval does not classify the file periodic");
}

console.log("5) import-looking text inside a string is not a violation");
{
  const res = run({
    "server/services/strimport.ts":
      'const doc = `import { db } from "../db"`;\nconst hint = "const { db } = await import(\\"../db\\")";\nsetInterval(() => { void doc; void hint; }, 1000);\n',
  });
  assert(res.ok, "db-import text in strings/templates never trips the AST detector");
}

console.log("6) aliasing is classified by IMPORTED name");
{
  const aliasOk = run({
    "server/services/aliasok.ts":
      'import { workerDb as db } from "../db";\nsetInterval(() => { void db; }, 1000);\n',
  });
  assert(aliasOk.ok, "`import { workerDb as db }` passes (local name db is irrelevant)");

  const aliasBad = run({
    "server/services/aliasbad.ts":
      'import { db as quietPool } from "../db";\nsetInterval(() => { void quietPool; }, 1000);\n',
  });
  assert(!aliasBad.ok, "`import { db as quietPool }` fails (imported name is db)");
  assert(
    aliasBad.violations[0].message.includes("`db`") && aliasBad.violations[0].message.includes("quietPool"),
    "message names both the pool export and the local alias",
  );
}

console.log("7) type-only imports are exempt");
{
  const res = run({
    "server/services/typeonly.ts":
      'import type { db } from "../db";\nimport { type apiPool } from "../db";\nsetInterval(() => {}, 1000);\nexport type X = typeof db; export type Y = typeof apiPool;\n',
  });
  assert(res.ok, "type-only and inline-type imports never fail");
}

console.log("8) exception mechanism is the only escape, and it cannot rot");
{
  const withMarker = run({
    "server/services/sanctioned.ts":
      `// ${EXCEPTION_MARKER} dual-use module: interval only enqueues; db serves request-path exports\n` +
      'import { db } from "../db";\nsetInterval(() => { void db; }, 1000);\n',
  });
  assert(withMarker.ok && withMarker.exceptionFiles.includes("server/services/sanctioned.ts"),
    "marker with a real justification is honored and reported");

  const emptyReason = run({
    "server/services/lazy.ts":
      `// ${EXCEPTION_MARKER}\n` + 'import { db } from "../db";\nsetInterval(() => { void db; }, 1000);\n',
  });
  assert(!emptyReason.ok && emptyReason.violations[0].kind === "empty-exception-reason",
    "marker without a justification fails");

  const stale = run({
    "server/services/stale.ts":
      `// ${EXCEPTION_MARKER} historical reason that no longer applies\n` +
      'import { workerDb } from "../db";\nsetInterval(() => { void workerDb; }, 1000);\n',
  });
  assert(!stale.ok && stale.violations[0].kind === "stale-exception-marker",
    "marker on a file that no longer trips fails (stale)");
}

console.log("9) boot-seeded modules are periodic; boot files themselves are exempt");
{
  const res = run(
    {
      "server/boot/seed.ts": 'export async function init() { await import("../services/seeded"); }\n',
      "server/services/seeded.ts": 'import { db } from "../db";\nexport function tick() { return db; }\n',
    },
    ["server/boot/seed.ts"],
  );
  assert(!res.ok && res.violations[0].file === "server/services/seeded.ts",
    "module registered by a boot seed file is periodic — db import fails");
  assert(res.violations[0].message.includes("boot-seeded"), "message explains the boot-seeded classification");

  const bootOwn = run(
    {
      "server/boot/seed.ts":
        'setInterval(() => {}, 1000);\nexport async function once() { const { db } = await import("../db"); void db; }\n',
    },
    ["server/boot/seed.ts"],
  );
  assert(bootOwn.ok, "boot seed files themselves are exempt (audited one-shot startup code)");
}

console.log("10) barrel re-exports of the request pool are structural violations");
{
  const named = run({ "server/services/barrel.ts": 'export { db } from "../db";\n' });
  assert(!named.ok && named.violations[0].kind === "barrel-reexport", "named re-export of db fails");

  const star = run({ "server/services/starbarrel.ts": 'export * from "../db";\n' });
  assert(!star.ok && star.violations[0].kind === "barrel-reexport", "`export *` from the db module fails");

  const typeOnly = run({ "server/services/typebarrel.ts": 'export type { db } from "../db";\n' });
  assert(typeOnly.ok, "type-only re-export passes");

  const workerBarrel = run({ "server/services/workerbarrel.ts": 'export { workerDb } from "../db";\n' });
  assert(workerBarrel.ok, "re-export of worker exports passes (only db/apiPool are guarded)");
}

console.log("11) real repository state");
{
  const real = runLint();
  assert(real.ok, `REAL server/ tree passes (violations: ${real.violations.map((v) => v.message).join(" | ")})`);
  const expected = [
    "server/routes/twilio.ts",
    "server/services/frontAnalyticsCoverage.ts",
    "server/services/frontHistoricalRecovery.ts",
    "server/services/frontIntegration.ts",
    "server/services/healthMetrics.ts",
    "server/services/postDeployVerification.ts",
    "server/services/slackIntegration.ts",
  ];
  assert(
    JSON.stringify(real.exceptionFiles) === JSON.stringify(expected),
    `documented exception set is EXACTLY the ${expected.length} sanctioned files (got: ${real.exceptionFiles.join(", ")}) — ` +
      "adding an exception requires updating this pin WITH justification in the same reviewed diff",
  );
  assert(real.periodicFiles.length >= 100,
    `periodic surface stays broad (${real.periodicFiles.length} files — schedulerInits seeds + setInterval/cron/sampler users)`);
  assert(
    real.periodicFiles.includes("server/services/workScheduler.ts"),
    "the continuously polling workScheduler is classified periodic (and passes on the worker boundary)",
  );
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
