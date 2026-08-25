// Stub for server/services/adsOs/store.ts (see ads-os-p6-hooks.mjs).
// Shadows the alerts / notified-fingerprint / client-log-summary collections
// with in-memory maps (local exports win over the star re-export); every other
// collection stays the real module. Keys mirror the real alertKey (digits-only
// cid) so cross-checks in tests match production key shapes.
export * from "../../server/services/adsOs/store";

const g = (): any => ((globalThis as any).__p6 ??= {});
const coll = (name: string): Map<string, any> => {
  const s = (g().stores ??= {});
  return (s[name] ??= new Map());
};
const alertKey = (product: string, cid: string): string => `${product}:${String(cid).replace(/-/g, "").trim()}`;

export async function putAlerts(product: string, cid: string, data: Record<string, any>): Promise<void> {
  coll("alerts").set(alertKey(product, cid), data);
}
export async function getAlerts(product: string, cid: string): Promise<Record<string, any> | null> {
  return coll("alerts").get(alertKey(product, cid)) ?? null;
}

export async function getNotified(product: string, cid: string): Promise<Set<string>> {
  const doc = coll("notified").get(alertKey(product, cid));
  const arr = Array.isArray(doc?.fingerprints) ? doc.fingerprints : [];
  return new Set(arr.map((v: any) => String(v)));
}
export async function putNotified(product: string, cid: string, fps: Set<string>): Promise<void> {
  coll("notified").set(alertKey(product, cid), {
    fingerprints: [...fps].sort(),
    updated_at: new Date().toISOString(),
  });
}

export async function getClientLogSummary(sheetId: string): Promise<Record<string, any> | null> {
  return coll("clientlog").get(sheetId) ?? null;
}
export async function putClientLogSummary(sheetId: string, data: Record<string, any>): Promise<void> {
  coll("clientlog").set(sheetId, data);
}
