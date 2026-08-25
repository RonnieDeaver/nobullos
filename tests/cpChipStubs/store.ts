// Stub for server/services/adsOs/store.ts (see ads-os-cp-chip-hooks.mjs):
// every collection the profile builder reads returns "nothing stored"; the
// status-check doc comes from the test's fixture, with a read counter so the
// test can assert the verdicts come from ONE read of the single document.

const nullColl = {
  async get(_key: string): Promise<Record<string, any> | null> {
    return null;
  },
  async put(_key: string, _data: Record<string, any>): Promise<void> {},
};

export const auditScoresStore = nullColl;
export const budgetPacingStore = nullColl;
export const lsaAuditScoresStore = nullColl;
export const lsaBudgetPacingStore = nullColl;
export const pyramidBreakdownStore = nullColl;
export const trafficQualityStore = nullColl;

export async function getAlerts(_product: string, _cid: string): Promise<Record<string, any> | null> {
  const g = (globalThis as any).__cpChip;
  g.alertDocReads = (g.alertDocReads ?? 0) + 1;
  return null;
}

export async function getStatusCheckDoc(): Promise<Record<string, any>> {
  const g = (globalThis as any).__cpChip;
  g.statusDocReads = (g.statusDocReads ?? 0) + 1;
  return g.checkDoc ?? {};
}
