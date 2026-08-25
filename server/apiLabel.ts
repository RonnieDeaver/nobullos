// Task #836 Phase 1: pure helpers for API DB-hold-label attribution.
// Extracted into a standalone module so tests can import them without
// booting the Express server (which is a top-level side effect of
// `server/index.ts`).

const NORMALIZE_RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NORMALIZE_RE_NUM = /\/\d+(?=\/|$)/g;
const NORMALIZE_RE_LONGHEX = /\b[0-9a-f]{16,}\b/gi;

export function normalizeApiPathForLabel(rawPath: string): string {
  // Strip query string and trailing slash, replace UUIDs and numeric
  // path segments with `:id` to bound label cardinality.
  let p = rawPath.split("?")[0] || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  p = p.replace(NORMALIZE_RE_UUID, ":id");
  p = p.replace(NORMALIZE_RE_NUM, "/:id");
  p = p.replace(NORMALIZE_RE_LONGHEX, ":id");
  return p;
}
