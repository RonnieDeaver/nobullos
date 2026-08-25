/**
 * Safe array binding helper for Postgres queries built with drizzle's
 * `sql` template tag (Task #733).
 *
 * Background — the broken pattern:
 *
 *   sql`... WHERE id = ANY(${jsArray}::text[])`
 *
 * When drizzle binds a JS array as a single parameter it expands it into a
 * Postgres `record` (a parameter list), and `record::text[]` is illegal —
 * Postgres rejects the query with `cannot cast type record to text[]`.
 * The error was historically swallowed by callers' try/catch blocks,
 * silently dropping data (e.g., review-decision lookups in the Activity
 * Feed returned empty for every row).
 *
 * The safe pattern is to emit a literal array constructor:
 *
 *   ANY(ARRAY[$1, $2, $3]::text[])
 *
 * `bindArrayParam` is the single canonical way to produce that fragment.
 * Callers should use `ANY(${bindArrayParam(values)})` instead of the broken
 * `ANY(${values}::text[])` pattern.
 *
 * Behaviors pinned by tests/sql-array-binding.test.ts:
 *   - Empty array → `ARRAY[]::<castType>[]` (Postgres requires the cast on
 *     empty arrays to know the element type).
 *   - Single-element / multi-element arrays → `ARRAY[$1, ...]::<castType>[]`
 *     with each element passed as its own bound parameter.
 *   - `null` elements are bound as SQL NULL, not stringified.
 *   - The cast type is restricted to a small allow-list so callers can't
 *     accidentally inject SQL via the cast slot.
 */
import { sql, type SQL } from "drizzle-orm";

export type SqlArrayCastType =
  | "text"
  | "varchar"
  | "uuid"
  | "int"
  | "bigint"
  | "date";

const ALLOWED_CASTS: readonly SqlArrayCastType[] = [
  "text",
  "varchar",
  "uuid",
  "int",
  "bigint",
  "date",
];

export function bindArrayParam(
  values: ReadonlyArray<string | number | null>,
  castType: SqlArrayCastType = "text",
): SQL {
  if (!ALLOWED_CASTS.includes(castType)) {
    throw new Error(`bindArrayParam: disallowed cast type "${castType}"`);
  }
  if (!Array.isArray(values)) {
    throw new Error("bindArrayParam: values must be an array");
  }
  if (values.length === 0) {
    return sql.raw(`ARRAY[]::${castType}[]`);
  }
  const items = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`ARRAY[${items}]::${sql.raw(`${castType}[]`)}`;
}
