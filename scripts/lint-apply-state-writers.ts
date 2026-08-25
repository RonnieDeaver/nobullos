/**
 * Task #1836 — Lint guard against direct writers to `apply_state`.
 *
 * Background: `apply_state` carries a UNIQUE constraint on
 * (work_result_id, apply_target). Historically two independent writers
 * inserted rows under that key — applyPipeline's `getOrCreateApplyState`
 * (safe, used `onConflictDoNothing`) and pipelineProcessor's
 * `recordApplyOutcome` (unsafe, plain `.insert`) — and the second one
 * dead-lettered ~700 `front_webhook_apply` jobs in May 2026 when the
 * warp drain stressed the race.
 *
 * The root fix consolidated both onto `upsertApplyState` in
 * `server/services/applyPipeline.ts`. This guard prevents the regression
 * class by failing CI when any OTHER file:
 *
 *   1. Calls `.insert(applyState)` directly, or
 *   2. Issues raw `INSERT INTO apply_state` SQL, or
 *   3. Issues raw `INSERT INTO "apply_state"` SQL.
 *
 * Only `server/services/applyPipeline.ts` is allow-listed — that's
 * where the canonical helper lives, and the bootstrap that runs
 * `CREATE TABLE IF NOT EXISTS apply_state` is in the same file.
 *
 * Tests and migration files are also allow-listed.
 *
 * Exit code 0 if clean, 1 if any offender is found.
 */
import { readFileSync } from "node:fs";
import { isScannablePath, listTrackedFiles } from "./lintFileDiscovery";

// Repo-wide scope (Task #2846): a writer to apply_state can appear in ANY
// tracked TypeScript file — this guard was already broadened once (scripts/
// was a blind spot until architect feedback added it), so discovery now
// comes from `git ls-files` instead of a hand-maintained root list. Only a
// semantic filter remains: .ts/.tsx files (the pattern is Drizzle/raw-SQL
// TypeScript code), minus tests/ (allow-listed by design — fixtures may
// mention the forbidden pattern; migrations are .sql and thus out of scope).
const EXCLUDED_PREFIXES = ["tests/"];

// Files where direct writes are intentional. Keep the list tight.
const ALLOWLIST = new Set<string>([
  // Canonical writer + bootstrap CREATE TABLE.
  "server/services/applyPipeline.ts",
  // The lint script itself mentions the forbidden patterns in its
  // error-message prose; skip it from the scan.
  "scripts/lint-apply-state-writers.ts",
]);

const DIRECT_INSERT_RE = /\.insert\s*\(\s*applyState\s*\)/;
const RAW_SQL_INSERT_RE = /INSERT\s+INTO\s+"?apply_state"?/i;

type Offender = { file: string; line: number; snippet: string; kind: string };

export function cliMain(): number {
  const files: string[] = listTrackedFiles().filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".tsx")) &&
      isScannablePath(f) &&
      !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)),
  );

  const offenders: Offender[] = [];

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (ALLOWLIST.has(normalized)) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("apply_state") && !src.includes("applyState")) continue;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip single-line / JSDoc comment lines so prose mentions of the
      // forbidden pattern (e.g. "// Plain .insert(applyState) here…")
      // don't trip the guard. Real code lines never start with // or *.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (DIRECT_INSERT_RE.test(line)) {
        offenders.push({
          file: normalized,
          line: i + 1,
          snippet: line.trim(),
          kind: "direct_insert_applystate",
        });
      } else if (RAW_SQL_INSERT_RE.test(line)) {
        offenders.push({
          file: normalized,
          line: i + 1,
          snippet: line.trim(),
          kind: "raw_sql_insert_apply_state",
        });
      }
    }
  }

  if (offenders.length > 0) {
    console.error("");
    console.error(
      "✗ lint-apply-state-writers: direct writer(s) to apply_state outside the canonical helper",
    );
    console.error("");
    console.error(
      "  Every write to apply_state must go through upsertApplyState() in",
    );
    console.error(
      "  server/services/applyPipeline.ts. That helper performs INSERT ... ON",
    );
    console.error(
      "  CONFLICT (work_result_id, apply_target) DO UPDATE, which is the only",
    );
    console.error(
      "  safe shape given the table's UNIQUE constraint. Plain .insert(applyState)",
    );
    console.error(
      "  dead-lettered ~700 front_webhook_apply jobs in May 2026 before the fix.",
    );
    console.error("");
    console.error("  Fix:");
    console.error("");
    console.error(
      '    import { upsertApplyState } from "./applyPipeline";',
    );
    console.error(
      "    await upsertApplyState({ workResultId, sourceEventId, sourceSystem,",
    );
    console.error(
      "      applyTarget, outcome, /* …optional fields… */ });",
    );
    console.error("");
    console.error("  Offenders:");
    for (const o of offenders) {
      console.error(`    [${o.kind}] ${o.file}:${o.line}`);
      console.error(`      ${o.snippet}`);
    }
    console.error("");
    return 1;
  }

  console.log(
    `lint-apply-state-writers: OK (scanned ${files.length} tracked .ts/.tsx files repo-wide)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-apply-state-writers.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
