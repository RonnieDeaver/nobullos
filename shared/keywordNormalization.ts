/**
 * Canonical SEMrush keyword normalization.
 *
 * SEMrush's API and operator-managed campaign keyword lists are inconsistent
 * about casing and whitespace ("Plumber", "plumber ", "  PLUMBER", "plumber  near me").
 * Without a single normalization pass the same conceptual keyword can:
 *   - be inserted multiple times as separate snapshots (write path),
 *   - be missed by the coverage / dedupe lookup (read path),
 *   - be wrongly classified as "stale" and pruned (cleanup path),
 *   - be reported as missing in the coverage check.
 *
 * This module is the single source of truth used everywhere we compare
 * keyword names — read path, write path, stale-keyword cleanup, and coverage
 * reporting. NEVER inline `.trim().toLowerCase()` instead — go through here.
 *
 * Rules:
 *  - Trim leading/trailing whitespace.
 *  - Collapse runs of internal whitespace (any unicode whitespace) to a single
 *    ASCII space.
 *  - Lowercase using locale-independent semantics (`String#toLowerCase`).
 *
 * The function is a pure string -> string transform, suitable for both
 * application code and Drizzle SQL via the helper below.
 */
export function normalizeKeyword(input: string | null | undefined): string {
  if (!input) return "";
  return String(input).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Returns true iff two keyword names refer to the same canonical keyword.
 */
export function keywordEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeKeyword(a) === normalizeKeyword(b);
}

/**
 * Build a normalized Set from an iterable of keyword names. Useful for
 * fast `has(...)` membership testing in cleanup/coverage paths.
 */
export function normalizedKeywordSet(
  values: Iterable<string | null | undefined>,
): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(normalizeKeyword(v));
  return out;
}
