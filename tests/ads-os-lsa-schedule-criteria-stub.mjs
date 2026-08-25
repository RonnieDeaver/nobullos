// Stub for server/services/adsOs/criteriaService.ts (Task #3681 test).
//
// Re-exports the REAL module (so saveCriteria/toCriteria/emptyCriteria etc.
// stay genuine) and shadows only `loadCriteria` with a delegate that can be
// flipped into a throwing mode — the only way to exercise overlayLive's
// store-read-failure catch, since the underlying storeGet swallows DB errors
// into null. See .agents/memory/stub-static-named-export.md.
export * from "../server/services/adsOs/criteriaService";
import * as real from "../server/services/adsOs/criteriaService";

let failWith = null;

/** Test control: pass an Error to make loadCriteria throw it; null to restore. */
export function __setLoadCriteriaFailure(err) {
  failWith = err;
}

export async function loadCriteria(customerId) {
  if (failWith) throw failWith;
  return real.loadCriteria(customerId);
}
