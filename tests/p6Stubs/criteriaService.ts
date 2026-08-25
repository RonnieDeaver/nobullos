// Stub for server/services/adsOs/criteriaService.ts (see ads-os-p6-hooks.mjs).
// Shadows loadCriteria so the engine's schedule-aware no-impressions check
// reads the test's schedule_days instead of the store/DB.
export * from "../../server/services/adsOs/criteriaService";

const g = (): any => ((globalThis as any).__p6 ??= {});

export async function loadCriteria(_cid: string): Promise<any> {
  // Keep BOTH schedule defaults present (GAds schedule_days + LSA
  // lsa_schedule_days) so schedule-aware consumers never see undefined.
  return { criteria: { schedule_days: [], lsa_schedule_days: [], ...(g().criteria ?? {}) } };
}
