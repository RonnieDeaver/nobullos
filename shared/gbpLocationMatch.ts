/**
 * Shared, framework-free helpers for resolving an imported / parsed GBP
 * location name against a client's real Command Panel locations.
 *
 * These live in `shared/` (not `client/src/lib`) so BOTH the client report
 * builder (`client/src/lib/gbpLocationMerge.ts`) and the server webhook
 * import path (`server/routes/reports.ts`) resolve names through ONE matcher.
 * Before this module existed the two paths had divergent matchers — the
 * webhook used naive exact-equality against `client_locations.name` and
 * minted a fresh `crypto.randomUUID()` "confident" row for anything that
 * did not match. That is how a foreign source PDF (e.g. Lansing / Waverly)
 * silently became published GBP rows on a client whose real locations were
 * "Firm (Lehi)" / "Firm (Las Vegas)" — the short PDF city names never
 * exact-matched the firm-qualified Command Panel names, so every row fell
 * through to a ghost.
 *
 * Matching is deliberately narrow to avoid false positives across a client's
 * own locations:
 *   1. Exact match after normalization, OR
 *   2. The parsed name equals the parenthetical "(City)" of the candidate
 *      Command Panel name (the established "Firm (City)" naming convention).
 *
 * No substring / fuzzy / edit-distance matching: a foreign city like
 * "Lansing" must NOT resolve to "...(Lehi)".
 */

export type GbpMatchCandidate = { id: string; name: string };

/**
 * Narrow normalization shared with `gbpLocationMerge.ts`. Lowercases, strips
 * a small punctuation set (including parentheses), and collapses whitespace.
 * Intentionally narrow — hyphens are preserved so "Lake-Worth" !== "Lake Worth".
 */
export function normalizeGbpLocationName(name: string): string {
  return (name || '').toLowerCase().replace(/[.,'"()]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the LAST parenthetical group from a raw (un-normalized) name and
 * return it normalized, or "" when there is no parenthetical. Operates on the
 * raw name because `normalizeGbpLocationName` strips parentheses.
 *
 *   "Trusted Estate Planning Attorneys (Lehi)" -> "lehi"
 *   "Speedwell Law, PLLC (Alexandria)"          -> "alexandria"
 *   "Adolphe Law Group Fort Pierce"             -> ""
 */
export function parentheticalCity(rawName: string): string {
  const matches = (rawName || '').match(/\(([^)]*)\)/g);
  if (!matches || matches.length === 0) return '';
  const last = matches[matches.length - 1];
  return normalizeGbpLocationName(last.replace(/[()]/g, ''));
}

/**
 * True when `parsedName` resolves to `candidateName` by exact-normalized
 * equality OR by the candidate's parenthetical city. Empty parsed names
 * never match.
 */
export function gbpNameMatches(parsedName: string, candidateName: string): boolean {
  const p = normalizeGbpLocationName(parsedName);
  if (!p) return false;
  if (normalizeGbpLocationName(candidateName) === p) return true;
  const paren = parentheticalCity(candidateName);
  return paren !== '' && paren === p;
}

/**
 * Resolve a parsed location name to a Command Panel location, or null when
 * none matches. Callers MUST treat a null result as "unresolved — surface to
 * the operator", never as a license to mint a fresh-UUID confident row.
 */
export function matchCommandPanelLocation<T extends GbpMatchCandidate>(
  parsedName: string,
  commandPanelLocations: T[],
): T | null {
  for (const cp of commandPanelLocations) {
    if (gbpNameMatches(parsedName, cp.name || '')) return cp;
  }
  return null;
}
