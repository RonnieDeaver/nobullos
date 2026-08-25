// Stub for server/services/adsOs/keywordIntel/kiStore.ts (see
// ads-os-ki-hooks.mjs). In-memory traffic-quality + actioned stores so
// persistQuality/cross-check mechanics run DB-free; snapshotEntryExpired and
// SNAPSHOT_MAX_AGE_DAYS stay the shipped implementations via the re-export.
export * from "../../server/services/adsOs/keywordIntel/kiStore";

type State = { tq?: Map<string, any>; actioned?: Map<string, Set<string>> };
const g = (): State => ((globalThis as any).__kiTest ??= {});
const norm = (cid: string) => String(cid).replace(/-/g, "").trim();

export async function loadTrafficQuality(customerId: string): Promise<Record<string, any> | null> {
  return (g().tq ??= new Map()).get(norm(customerId)) ?? null;
}

export async function saveTrafficQuality(customerId: string, data: Record<string, any>): Promise<void> {
  (g().tq ??= new Map()).set(norm(customerId), data);
}

export async function loadActioned(customerId: string): Promise<Set<string>> {
  return new Set((g().actioned ??= new Map()).get(norm(customerId)) ?? []);
}

export async function setActioned(customerId: string, term: string, actioned: boolean): Promise<void> {
  const map = (g().actioned ??= new Map());
  const key = norm(customerId);
  const set = map.get(key) ?? new Set<string>();
  if (actioned) set.add(term);
  else set.delete(term);
  map.set(key, set);
}
