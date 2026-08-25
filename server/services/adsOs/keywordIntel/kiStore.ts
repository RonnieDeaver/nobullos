/**
 * Keyword Intelligence — store helpers over the Phase 0 jsonb collections
 * (port of the keyword-intel parts of backend/app/store.py).
 *
 *   - Traffic-quality snapshots (dashboard pill + the finder's cross-check):
 *     one doc per account in `ads_os_traffic_quality`, carrying the pending
 *     suggested negatives per lookback window ("negatives_by_window").
 *   - Actioned keyword suggestions (New Keywords tool): once a converting term
 *     is added as a keyword (or dismissed), it stops resurfacing. One doc per
 *     account in `ads_os_keyword_actioned`, `{terms: [sorted normalized terms]}`.
 *
 * All best-effort like the bundle: a failed read degrades to "nothing stored",
 * a failed write logs and swallows (the store layer already does both).
 */

import { KeyedLocks } from "../singleflight";
import { keywordActionedStore, trafficQualityStore } from "../store";

function normCid(customerId: string): string {
  return customerId.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Traffic-quality snapshots
// ---------------------------------------------------------------------------

/**
 * How long a persisted negatives snapshot stays usable for the cross-check.
 * After this the account has likely shifted (seasonality, new campaigns) and a
 * stale pending negative must not keep holding back keyword suggestions.
 */
export const SNAPSHOT_MAX_AGE_DAYS = 30;

/** True when a snapshot window entry is too old to trust (or unparseable). */
export function snapshotEntryExpired(generatedAt: unknown): boolean {
  const ms = Date.parse(String(generatedAt ?? ""));
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms >= SNAPSHOT_MAX_AGE_DAYS * 86_400_000;
}

export async function loadTrafficQuality(customerId: string): Promise<Record<string, any> | null> {
  return trafficQualityStore.get(normCid(customerId));
}

export async function saveTrafficQuality(customerId: string, data: Record<string, any>): Promise<void> {
  return trafficQualityStore.put(normCid(customerId), data);
}

// ---------------------------------------------------------------------------
// Actioned keyword suggestions (New Keywords tool)
// ---------------------------------------------------------------------------

const actionedLocks = new KeyedLocks(); // serialize the RMW per account

export async function loadActioned(customerId: string): Promise<Set<string>> {
  const doc = (await keywordActionedStore.get(normCid(customerId))) ?? {};
  const terms = Array.isArray(doc.terms) ? doc.terms : [];
  return new Set(terms.map((t: unknown) => String(t)));
}

/** Add or remove a normalized term from the account's actioned set (best-effort). */
export async function setActioned(customerId: string, term: string, actioned: boolean): Promise<void> {
  const cid = normCid(customerId);
  await actionedLocks.withLock(cid, async () => {
    const doc = (await keywordActionedStore.get(cid)) ?? {};
    const terms = new Set<string>((Array.isArray(doc.terms) ? doc.terms : []).map((t: unknown) => String(t)));
    if (actioned) terms.add(term);
    else terms.delete(term);
    await keywordActionedStore.put(cid, { terms: [...terms].sort() });
  });
}
