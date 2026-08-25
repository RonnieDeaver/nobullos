// Stub for server/services/adsOs/combinedDashboardService.ts (see
// ads-os-cp-chip-hooks.mjs): serves the client-profile test's fixture rows
// instead of building the real combined dashboard (which would need the whole
// Ads API / ClickUp graph). isCurrentMonth is reimplemented (same semantics)
// so the real module's heavy import chain never loads.

export async function buildCombinedDashboardCached(): Promise<{ resp: any; fromCache: boolean }> {
  return { resp: (globalThis as any).__cpChip.resp, fromCache: true };
}

export function isCurrentMonth(iso?: string | null): boolean {
  if (!iso || typeof iso !== "string") return false;
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return iso.slice(0, 7) === cur;
}
