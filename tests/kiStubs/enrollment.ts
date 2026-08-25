// Stub for server/services/adsOs/enrollment.ts (see ads-os-ki-hooks.mjs).
// Shadows the three network-backed lookups the analyzer engines use; everything
// else re-exports the real module.
export * from "../../server/services/adsOs/enrollment";

type State = {
  enrolled?: { cid: string }[];
  campaignIds?: string[];
  accounts?: Record<string, { name: string; currency: string | null }>;
};
const g = (): State => ((globalThis as any).__kiTest ??= {});

export async function enrolledAccounts(_product: string): Promise<any[]> {
  return (g().enrolled ?? []) as any[];
}

export async function labeledCampaignIds(_customerId: string, _labelName: string): Promise<string[]> {
  return g().campaignIds ?? [];
}

export async function mccEnabledAccounts(): Promise<Map<string, any>> {
  return new Map(Object.entries(g().accounts ?? {}));
}
