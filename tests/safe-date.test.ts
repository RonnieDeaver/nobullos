/* test-registration
{
  "name": "Safe date / ISO string helper (Task #1045)",
  "tier": "medium"
}
test-registration */
/**
 * Task #1045 — Coverage for `toSafeDate` / `toSafeIsoString`.
 *
 * The Front webhook apply queue dead-lettered 255+ jobs with
 * `e.toISOString is not a function` because a `Date` field on the
 * normalized payload had been serialized to a string by the jsonb
 * round-trip and was then handed straight to Drizzle's `timestamp`
 * column. These helpers are the canonical defence — every value we
 * intend to pass to a `timestamp` column (or call `.toISOString()` on)
 * goes through them first.
 *
 * Pinned behaviours:
 *   1. `null` / `undefined` → `null`, never thrown.
 *   2. Real `Date` instances pass through untouched (and `Invalid Date`
 *      reduces to `null`).
 *   3. ISO 8601 strings parse back to the same instant.
 *   4. Numeric millisecond epochs parse to the same instant; non-finite
 *      numbers (`NaN`, `Infinity`) reduce to `null`.
 *   5. Empty / whitespace strings reduce to `null` (we do not silently
 *      stamp them as the unix epoch).
 *   6. Garbage strings reduce to `null` rather than throwing.
 *   7. `toSafeIsoString` returns the round-trip-stable ISO form for any
 *      input `toSafeDate` accepts, and `null` for everything it
 *      rejects.
 *   8. The combined helper survives the full jsonb round-trip that
 *      caused the original crash:  Date → JSON.stringify →
 *      JSON.parse → toSafeDate → real Date again.
 */
import { toSafeDate, toSafeIsoString } from "../shared/utils/safeDate";

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

console.log("safe-date: null / undefined inputs");
expectEq(toSafeDate(null), null, "toSafeDate(null) → null");
expectEq(toSafeDate(undefined), null, "toSafeDate(undefined) → null");
expectEq(toSafeIsoString(null), null, "toSafeIsoString(null) → null");
expectEq(toSafeIsoString(undefined), null, "toSafeIsoString(undefined) → null");

console.log("safe-date: Date instances");
{
  const d = new Date("2025-06-15T12:34:56.000Z");
  const out = toSafeDate(d);
  assert(out instanceof Date && out.getTime() === d.getTime(), "real Date passes through");
  expectEq(toSafeIsoString(d), "2025-06-15T12:34:56.000Z", "toSafeIsoString preserves the instant");
}
{
  const invalid = new Date("not a real date");
  expectEq(toSafeDate(invalid), null, "Invalid Date instance → null");
  expectEq(toSafeIsoString(invalid), null, "toSafeIsoString(InvalidDate) → null");
}

console.log("safe-date: ISO and RFC strings");
{
  const iso = "2025-06-15T12:34:56.000Z";
  const d = toSafeDate(iso);
  assert(d instanceof Date, "ISO string parses to a Date");
  expectEq(d?.toISOString() ?? null, iso, "ISO string round-trips through toSafeDate");
  expectEq(toSafeIsoString(iso), iso, "toSafeIsoString preserves ISO input");
}
{
  // Front sends epoch-seconds; the apply path multiplies by 1000 first,
  // but we still want the raw jsonb-serialized form to round-trip.
  const iso = "2025-01-01T00:00:00.000Z";
  expectEq(toSafeIsoString(iso), iso, "midnight UTC round-trips");
}

console.log("safe-date: numeric epochs");
{
  const ms = Date.UTC(2025, 5, 15, 12, 34, 56);
  const d = toSafeDate(ms);
  assert(d instanceof Date && d.getTime() === ms, "numeric ms epoch parses to matching Date");
  expectEq(toSafeIsoString(ms), new Date(ms).toISOString(), "toSafeIsoString matches new Date(ms).toISOString()");
}
{
  expectEq(toSafeDate(NaN), null, "NaN → null");
  expectEq(toSafeDate(Infinity), null, "Infinity → null");
  expectEq(toSafeDate(-Infinity), null, "-Infinity → null");
}

console.log("safe-date: empty / garbage strings");
expectEq(toSafeDate(""), null, "empty string → null");
expectEq(toSafeDate("   "), null, "whitespace string → null");
expectEq(toSafeDate("not a date"), null, "garbage string → null");
expectEq(toSafeIsoString(""), null, "toSafeIsoString('') → null");
expectEq(toSafeIsoString("not a date"), null, "toSafeIsoString('not a date') → null");

console.log("safe-date: never throws on hostile inputs");
{
  const hostile: unknown[] = [{}, [], true, false, Symbol("x"), () => 0];
  for (const h of hostile) {
    let threw = false;
    try { toSafeDate(h as never); } catch { threw = true; }
    assert(!threw, `toSafeDate does not throw on ${String(h.toString?.() ?? typeof h)}`);
    let threw2 = false;
    try { toSafeIsoString(h as never); } catch { threw2 = true; }
    assert(!threw2, `toSafeIsoString does not throw on ${String(h.toString?.() ?? typeof h)}`);
  }
}

console.log("safe-date: jsonb round-trip (the actual #1045 crash scenario)");
{
  // Reproduce the exact data path: Date object goes into jsonb, comes
  // back as a string, gets handed to Drizzle's `timestamp` column. The
  // helper must turn it back into a real Date so `mapToDriverValue`
  // can call `.toISOString()` on it without throwing.
  const original = new Date("2025-06-15T12:34:56.789Z");
  const roundTripped = JSON.parse(JSON.stringify({ ts: original })).ts;
  assert(typeof roundTripped === "string", "jsonb round-trip yields a string (precondition)");
  const recovered = toSafeDate(roundTripped);
  assert(recovered instanceof Date, "toSafeDate recovers a real Date from the jsonb string");
  expectEq(recovered?.getTime() ?? -1, original.getTime(), "recovered Date matches the original instant");
  // And the recovered Date must support `.toISOString()` (which is what
  // Drizzle calls under the hood).
  let drizzleStyleThrew = false;
  try {
    (recovered as Date).toISOString();
  } catch {
    drizzleStyleThrew = true;
  }
  assert(!drizzleStyleThrew, "recovered Date supports .toISOString() (Drizzle's mapToDriverValue path)");
}

if (failed > 0) {
  console.error(`safe-date: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`safe-date: PASSED (${passed} assertions)`);
