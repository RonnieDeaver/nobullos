/**
 * Shared firm-name normalization for deterministic client option matching.
 *
 * Used by the Service Desk "Sync client options" endpoint to extend exact
 * case-insensitive matching with a normalization pass that strips common legal
 * suffixes, leading "The ", and punctuation so options like "Ackah Law, PC"
 * match NoBull clients registered as "Ackah Law".
 *
 * Only auto-applies when exactly one NoBull client maps to the normalized form
 * (ambiguous pairs are passed to the AI suggestion tier instead).
 */

/**
 * Trailing legal suffixes stripped during normalization.
 * Longer / more specific patterns are listed first so they are tried before
 * their sub-patterns (e.g. "Law Offices of" before "Law Offices").
 */
const TRAILING_SUFFIXES = [
  "attorneys at law",
  "law offices of",
  "law offices",
  "law office of",
  "law office",
  "law firm",
  "pllc",
  "llp",
  "llc",
  "p.c.",
  "pc",
  "p.a.",
  "pa",
] as const;

/**
 * Normalize a firm name for fuzzy matching:
 *  1. Lowercase
 *  2. Strip leading "The " (case-insensitive)
 *  3. Strip trailing legal suffixes (iteratively until stable)
 *  4. Strip commas and periods that remain
 *  5. Collapse internal whitespace
 *
 * The result is suitable for Map-based equality comparison; it is NOT intended
 * for display to users.
 */
export function normalizeFirmName(name: string): string {
  let n = name.toLowerCase().trim();

  n = n.replace(/^the\s+/, "");

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of TRAILING_SUFFIXES) {
      const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = n;
      n = n.replace(new RegExp(`[,\\s]*${escaped}\\s*$`), "").trim();
      if (n !== before) changed = true;
    }
  }

  n = n.replace(/[.,]/g, "");
  n = n.replace(/\s+/g, " ").trim();

  return n;
}
