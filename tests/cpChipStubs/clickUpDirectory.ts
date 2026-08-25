// Stub for server/services/adsOs/clickUpDirectory.ts (see
// ads-os-cp-chip-hooks.mjs): the profile only needs clientRecord (identity /
// log link) and normClientName for matching — no network, no directory cache.

export function normClientName(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

export async function clientBlocks(): Promise<any[]> {
  return [];
}

export async function clientRecord(name: string): Promise<any> {
  return { name, doer: null, checker: null, log_url: null };
}
