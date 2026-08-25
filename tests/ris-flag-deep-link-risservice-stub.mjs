// Test stub for server/services/ris/risService.ts.
//
// `risFlagging` only needs `rankSeverity` from this module, but the real
// risService imports the storage layer (and therefore the DB pool). This stub
// re-implements `rankSeverity` IDENTICALLY to the production version so the
// flag-worthiness check behaves the same without pulling in the DB.

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function rankSeverity(s) {
  return SEVERITY_RANK[s] ?? 0;
}
