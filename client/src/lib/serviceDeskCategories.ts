/**
 * Presentation-layer helpers for grouping Service Desk request types into
 * collapsible categories derived from the "Prefix – Short Label" naming
 * convention used in ClickUp (Task #3540).
 *
 * No DB column — categories are pure name-parse derivations. If a stored
 * category field is added later, consumers can prefer it and fall back here.
 */

/** Strip a leading "Option N" artifact (e.g. "Option 1Fulfillment – GBP / Local SEO"). */
export function stripOptionPrefix(name: string): string {
  return name.replace(/^Option\s*\d+\s*/i, "").trim();
}

/**
 * Parse "Category – Short Label" (en dash U+2013, em dash U+2014, or plain hyphen).
 * A single space on each side of the dash is required so bare-hyphenated words
 * like "follow-up" don't split incorrectly.
 *
 * Falls back to { category: "General", shortLabel: name } for names with no
 * recognisable prefix.
 */
export function parseTypeName(rawName: string): { category: string; shortLabel: string } {
  const name = stripOptionPrefix(rawName);
  const match = name.match(/^(.+?)\s+[–—\-]\s+(.+)$/);
  if (match) return { category: match[1].trim(), shortLabel: match[2].trim() };
  return { category: "General", shortLabel: name };
}

export interface TypeGroupItem<T> {
  rt: T;
  shortLabel: string;
}

export interface TypeGroup<T> {
  category: string;
  items: TypeGroupItem<T>[];
}

/**
 * Group a list of request types into ordered TypeGroups.
 * "General" (un-prefixed names) is sorted last; everything else is sorted
 * alphabetically by category name.
 */
export function groupTypesByCategory<T extends { name: string }>(types: T[]): TypeGroup<T>[] {
  const map = new Map<string, TypeGroupItem<T>[]>();
  for (const rt of types) {
    const { category, shortLabel } = parseTypeName(rt.name);
    const existing = map.get(category) ?? [];
    existing.push({ rt, shortLabel });
    map.set(category, existing);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === "General") return 1;
      if (b === "General") return -1;
      return a.localeCompare(b);
    })
    .map(([category, items]) => ({ category, items }));
}
