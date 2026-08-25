/**
 * Task #1045 — Safe Date / ISO-string coercion helpers.
 *
 * Background
 * ----------
 * The Front webhook apply path stores its normalized result inside
 * `work_result_log.result_json` (a `jsonb` column). When the apply
 * worker reads it back, every `Date` field on that payload has already
 * been serialized to a string by `JSON.stringify` and is no longer a
 * real `Date` instance. Passing the resulting string straight into a
 * Drizzle column whose `mapToDriverValue` calls `value.toISOString()`
 * (the default `timestamp` mode) crashes the whole job with
 * `e.toISOString is not a function` and the row dead-letters.
 *
 * These helpers normalize anything that "looks like a moment in time"
 * — a real `Date`, an ISO/RFC date string, or numeric milliseconds —
 * into either a real `Date` or a real ISO string (or `null`), without
 * ever throwing on `null` / `undefined` / invalid input. Call sites
 * that previously did `someValue.toISOString()` directly (and crashed
 * on string input) can use `toSafeIsoString(someValue)` instead, and
 * call sites that hand a value to Drizzle's `timestamp` column should
 * route it through `toSafeDate(someValue)` first.
 *
 * Returning `null` (rather than throwing) is intentional: this layer is
 * defensive plumbing, not a validator. The caller decides whether a
 * missing timestamp is a hard error for its specific row.
 */

export type DateLike = Date | string | number | null | undefined;

/**
 * Coerce a {@link DateLike} value into a real `Date`.
 *
 * Returns `null` for `null`, `undefined`, empty strings, `NaN`, and any
 * input that does not produce a finite/valid `Date`. Never throws.
 */
export function toSafeDate(value: DateLike): Date | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  return null;
}

/**
 * Coerce a {@link DateLike} value into an ISO 8601 string, or `null`
 * if the input cannot be parsed into a valid `Date`. Never throws.
 *
 * Use this in place of any direct `value.toISOString()` call where
 * `value` may have round-tripped through JSON, an external API, or a
 * jsonb column and may therefore already be a string / number / null.
 */
export function toSafeIsoString(value: DateLike): string | null {
  const d = toSafeDate(value);
  return d === null ? null : d.toISOString();
}
