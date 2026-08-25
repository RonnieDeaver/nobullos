// Stub for server/services/adsOs/alertsQueries.ts (see ads-os-p6-hooks.mjs).
// Shadows the five Ads API fetchers with test-state readers so the alerts
// engine's severity/suppression logic runs network-free; interfaces and any
// other exports stay the real module via the star re-export.
export * from "../../server/services/adsOs/alertsQueries";

const g = (): any => ((globalThis as any).__p6 ??= {});

export async function fetchGadsAlertRows(
  customerId: string,
  campaignIds: string[],
  cplCampaignIds: string[],
  dailyStart: string,
  dailyEnd: string,
  weekStart: string,
  weekEnd: string,
  cplStart: string,
  cplEnd: string,
): Promise<any> {
  g().gadsCalls = (g().gadsCalls ?? 0) + 1;
  g().lastGadsArgs = {
    customerId,
    campaignIds,
    cplCampaignIds,
    dailyStart,
    dailyEnd,
    weekStart,
    weekEnd,
    cplStart,
    cplEnd,
  };
  return g().gads ?? { data: {}, warnings: [] };
}

export async function fetchCustomerStatus(_customerId: string): Promise<string> {
  g().lsaApiCalls = (g().lsaApiCalls ?? 0) + 1;
  return g().customerStatus ?? "ENABLED";
}

export async function fetchLsaCampaigns(_customerId: string): Promise<any> {
  g().lsaApiCalls = (g().lsaApiCalls ?? 0) + 1;
  return { rows: g().lsaCampaigns ?? [], warning: null };
}

export async function fetchLsaLeads(_customerId: string, startIso: string, endIso: string): Promise<any> {
  g().lsaApiCalls = (g().lsaApiCalls ?? 0) + 1;
  g().lastLeadRange = { startIso, endIso };
  return { rows: g().lsaLeads ?? [], warning: g().lsaLeadsWarning ?? null };
}

export async function fetchLsaCost(_customerId: string, startIso: string, endIso: string): Promise<any> {
  g().lsaApiCalls = (g().lsaApiCalls ?? 0) + 1;
  g().lastLsaCostRange = { startIso, endIso };
  return { rows: g().lsaCost ?? [], warning: g().lsaCostWarning ?? null };
}

export async function fetchLsaVerificationArtifacts(_customerId: string): Promise<any> {
  g().lsaApiCalls = (g().lsaApiCalls ?? 0) + 1;
  return { rows: g().lsaArtifacts ?? [], warning: null };
}
