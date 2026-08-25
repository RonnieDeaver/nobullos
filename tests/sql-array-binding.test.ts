/* test-registration
{
  "name": "SQL array binding helper",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for `bindArrayParam` (Task #733).
 *
 * `bindArrayParam` is the single canonical helper for binding a JS array
 * into a Postgres `ANY(...)` lookup safely. It replaces the broken
 * `ANY(${jsArray}::text[])` pattern that historically caused
 * "cannot cast type record to text[]" errors and silent data loss.
 *
 * Behaviors pinned here:
 *   1. Empty arrays compile to `ARRAY[]::<castType>[]` with no parameters.
 *      Postgres requires the cast on empty arrays so it knows the element
 *      type.
 *   2. Single-element arrays compile to `ARRAY[$1]::<castType>[]` with
 *      exactly one bound parameter.
 *   3. Multi-element arrays compile to `ARRAY[$1, $2, ...]::<castType>[]`
 *      with one bound parameter per element, preserving order.
 *   4. `null` elements are passed through as SQL NULL bound parameters,
 *      not stringified into the SQL.
 *   5. Allowed cast types (text/varchar/uuid/int/bigint) produce the
 *      matching `::<type>[]` cast suffix.
 *   6. Disallowed cast types throw, so callers can't accidentally inject
 *      SQL via the cast slot.
 *   7. Sweep guard: no scanned source file (server/, shared/, scripts/ —
 *      via the lint's own exported runLint, Task #3944) still uses the
 *      broken `ANY(${...}::TYPE[])` pattern. If a new occurrence shows up,
 *      the regression has come back and the test fails.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bindArrayParam, type SqlArrayCastType } from "../server/utils/sqlArray";
import { runLint as runSqlArrayLint } from "../scripts/lint-sql-array-bindings";

const dialect = new PgDialect();

function compile(frag: ReturnType<typeof bindArrayParam>): {
  sql: string;
  params: unknown[];
} {
  const q = dialect.sqlToQuery(sql`${frag}`);
  return { sql: q.sql, params: q.params as unknown[] };
}

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

function expectEq<T>(actual: T, expected: T, msg: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

// (1) Empty array
{
  const c = compile(bindArrayParam([] as string[]));
  expectEq(c.sql, "ARRAY[]::text[]", "empty array compiles to ARRAY[]::text[]");
  expectEq(c.params, [], "empty array binds zero parameters");
}

// (2) Single element
{
  const c = compile(bindArrayParam(["abc"]));
  expectEq(c.sql, "ARRAY[$1]::text[]", "single element compiles to ARRAY[$1]::text[]");
  expectEq(c.params, ["abc"], "single-element array binds one parameter");
}

// (3) Multi-element preserves order
{
  const c = compile(bindArrayParam(["a", "b", "c", "d"]));
  expectEq(
    c.sql,
    "ARRAY[$1, $2, $3, $4]::text[]",
    "four elements compile to ARRAY[$1, $2, $3, $4]::text[]",
  );
  expectEq(c.params, ["a", "b", "c", "d"], "multi-element params preserve order");
}

// (4) Nulls pass through as bound parameters (not stringified)
{
  const c = compile(bindArrayParam(["a", null, "b"]));
  expectEq(
    c.sql,
    "ARRAY[$1, $2, $3]::text[]",
    "null elements still occupy a parameter slot",
  );
  expectEq(c.params, ["a", null, "b"], "null elements bound as SQL NULL, not the string 'null'");
}

// (5) Allowed cast types render correctly
{
  const cases: Array<{ cast: SqlArrayCastType; vals: ReadonlyArray<string | number | null> }> = [
    { cast: "text", vals: ["x"] },
    { cast: "varchar", vals: ["x"] },
    { cast: "uuid", vals: ["x"] },
    { cast: "int", vals: [1, 2] },
    { cast: "bigint", vals: [1] },
    { cast: "date", vals: ["2024-01-01"] },
  ];
  for (const { cast, vals } of cases) {
    const c = compile(bindArrayParam(vals, cast));
    assert(
      c.sql.endsWith(`]::${cast}[]`),
      `cast type "${cast}" produces trailing ::${cast}[] (got "${c.sql}")`,
    );
  }
  const empty = compile(bindArrayParam([], "uuid"));
  expectEq(empty.sql, "ARRAY[]::uuid[]", "empty array honors non-default cast type");
}

// (6) Disallowed cast types throw
{
  let threw = false;
  try {
    bindArrayParam(["a"], "text[]; DROP TABLE clients; --" as unknown as SqlArrayCastType);
  } catch {
    threw = true;
  }
  assert(threw, "disallowed cast type throws (no SQL injection via cast slot)");
}

// (7) Sweep guard: no `ANY(${...}::TYPE[])` pattern in production or
// operational-script code. Task #3944: delegated to the lint's own exported
// runLint()/ROOTS so this sweep can never drift from the gate lint (the old
// shape kept a private copy of the regex + roots here).
{
  const { offenders, scannedRoots } = runSqlArrayLint();
  assert(
    scannedRoots.includes("server") && scannedRoots.includes("shared") && scannedRoots.includes("scripts"),
    `lint ROOTS cover server, shared, and scripts (got: ${scannedRoots.join(", ")})`,
  );
  assert(
    offenders.length === 0,
    `no scanned file still uses the broken ANY(\${...}::TYPE[]) pattern (offenders: ${offenders.join(", ")})`,
  );
}

if (failed > 0) {
  console.error(`sql-array-binding: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`sql-array-binding: PASSED (${passed} assertions)`);
process.exit(0);
