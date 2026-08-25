/* test-registration
{
  "name": "recompute_front_analytics_units.ts boots on the hermetic DB and reaches its dry-run summary without mutating anything (Task #4138)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~seconds), deterministic spawned dry-run; guards a script-boot bug class (a dead import shipped that made the operator script unbootable).",
  "scanPaths": ["scripts/recompute_front_analytics_units.ts"],
  "tier": "small"
}
test-registration */
/**
 * Task #4138 — the operator script `scripts/recompute_front_analytics_units.ts`
 * shipped with a dead `import "../server/loadEnv"` (a module that never
 * existed), so it could not boot at all. This suite proves:
 *
 *   1. The module graph resolves and environment bootstrap does not throw —
 *      the script is spawned as a child (it self-executes `main()` at module
 *      load, so a naked in-process import would RUN it; a spawn against the
 *      hermetic per-run DB is the safe harness).
 *   2. The default (no-flag) invocation is a dry-run: it prints the dry-run
 *      summary lines and exits 0.
 *   3. No database mutation and no Front API call occurs on the dry-run
 *      path: the coverage table's row set is byte-identical before and
 *      after, and the child is spawned with network egress poisoned via a
 *      bogus proxy env so any accidental external HTTP would fail loudly
 *      (the dry-run path performs no fetch at all).
 *   4. The source no longer references the never-existed bootstrap module.
 *
 * Hermetic: the harness injects the per-run Postgres URL into this process's
 * env; the child inherits it, so `server/db.ts`'s test-mode guard admits it
 * and no shared/dev/prod database can be touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/recompute_front_analytics_units.ts");

async function main(): Promise<void> {
  // ── 4. Dead bootstrap import stays dead ────────────────────────────────
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(
    !/(?:import|require)\s*\(?\s*["'][^"']*loadEnv/.test(source),
    "script must not import the never-existed server/loadEnv module",
  );

  // Snapshot the coverage table before the run (proves no mutation after).
  const { db } = await import("../server/db");
  const { frontAnalyticsMonthlyCoverage } = await import(
    "../shared/models/frontAnalyticsCoverage"
  );
  const before = JSON.stringify(
    await db.select().from(frontAnalyticsMonthlyCoverage),
  );

  // ── 1–2. Spawned dry-run boots and reaches the summary ────────────────
  const res = spawnSync("npx", ["tsx", SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      // Poison external egress: the dry-run path must not perform any
      // HTTP call. If one sneaks in, it fails against this dead proxy
      // instead of reaching Front (undici/fetch honor these).
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      NO_PROXY: "",
      no_proxy: "",
    },
  });

  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  assert.equal(
    res.status,
    0,
    `dry-run must exit 0 (got ${res.status}, signal ${res.signal}). Output:\n${out}`,
  );
  assert.match(
    out,
    /dry-run mode \(pass --apply to commit\)/,
    "dry-run banner missing",
  );
  assert.match(
    out,
    /total rows\. Already comparable: \d+\. Relabel-only: \d+\. Need Front pull: \d+\./,
    "dry-run summary line missing",
  );
  assert.match(out, /Re-run with --apply to recompute\./, "dry-run epilogue missing");
  assert.ok(!out.includes("--apply with frontPullsBudget"), "apply path must not run");

  // ── 3. No DB mutation ──────────────────────────────────────────────────
  const after = JSON.stringify(
    await db.select().from(frontAnalyticsMonthlyCoverage),
  );
  assert.equal(after, before, "dry-run must not mutate the coverage table");

  console.log("recompute-front-analytics-units-boot: all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
