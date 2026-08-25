// Stub for server/services/adsOs/criteriaService.ts (see ads-os-pyramid-hooks.mjs).
// Shadows only the DB-backed loadCriteria; deriveDefaults/effectiveCriteria
// (pure) stay the shipped implementations via the re-export.
export * from "../../server/services/adsOs/criteriaService";

const g = (): any => ((globalThis as any).__pyrTest ??= {});

export async function loadCriteria(
  _customerId: string,
): Promise<{ criteria: any; hasSaved: boolean; updatedAt: string | null }> {
  return { criteria: g().criteria, hasSaved: !!g().hasSaved, updatedAt: null };
}
