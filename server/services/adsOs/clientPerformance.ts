/**
 * Ads OS — client-profile Performance overview: daily spend/leads series per
 * account. Port of backend/app/client_performance.py.
 *
 * `GET /api/ads-os/client/performance?name&start&end` returns a zero-filled
 * DAILY series of {date, spend, leads} for EVERY one of the client's accounts
 * — including ClickUp Ads Status = Off ones (reporting covers all accounts in
 * the range). The frontend derives the blended series, weekly/monthly
 * bucketing, and per-bucket CPL, so switching timeframe never refetches (and
 * never costs Ads API quota).
 *
 * Account list comes from the combined-dashboard row (same seam as the client
 * profile, so the two always agree; offboarded clients have no row -> null ->
 * 404). Queries mirror the dashboards' own daily pulls: GAds = labeled
 * monitored campaigns' cost + conversions by segments.date; LSA =
 * LOCAL_SERVICES cost by segments.date + charged leads by creation date.
 * Strictly read-only. Cached in-process ~1h per (client, start, end) with
 * single-flight; a build where any account failed is cached only briefly so a
 * transient blip's flat-zero chart self-repairs.
 */

import { normClientName } from "./clickUpDirectory";
import { buildCombinedDashboardCached, retryTransient } from "./combinedDashboardService";
import { AUDIT_CACHE_TTL_SECONDS, KI_CAMPAIGN_LABEL } from "./config";
import { labeledCampaignIds } from "./enrollment";
import { AdsOsApiError, adsOsGaqlSearch } from "./googleAdsClient";
import { KeyedLocks, mapPool } from "./singleflight";
import { AdsStatus, CombinedMember, Product } from "./types";

// Hard cap on the requested span — "last 12 months" is ~366 days; anything
// beyond is a typo'd custom range, and each extra month is real Ads API quota
// on a cache miss.
export const MAX_SPAN_DAYS = 400;

export interface PerfPoint {
  date: string; // ISO YYYY-MM-DD
  spend: number;
  leads: number;
}

export interface PerfSeries {
  product: Product;
  customer_id: string;
  name: string;
  city: string | null;
  ads_status: AdsStatus;
  metrics_failed: boolean; // series couldn't load — points are placeholder zeros
  points: PerfPoint[];
}

export interface ClientPerformanceResponse {
  client: string;
  currency_code: string | null;
  start: string;
  end: string;
  accounts: PerfSeries[];
  generated_at: string;
  from_cache?: boolean;
}

/** {date: PerfPoint} for a GAds account — cost + conversions summed per day
 *  across the account's labeled monitored campaigns (mirrors the dashboard's
 *  account metrics). No labeled campaigns -> {} (an all-zero series, matching
 *  the dashboards). */
async function dailyGads(cid: string, start: string, end: string): Promise<Map<string, PerfPoint>> {
  const campaignIds = await labeledCampaignIds(cid, KI_CAMPAIGN_LABEL);
  const out = new Map<string, PerfPoint>();
  if (!campaignIds.length) return out;
  const query =
    "SELECT segments.date, metrics.cost_micros, metrics.conversions FROM campaign " +
    `WHERE campaign.id IN (${campaignIds.join(", ")}) ` +
    `AND segments.date BETWEEN '${start}' AND '${end}'`;
  const rows = await adsOsGaqlSearch(cid, query);
  for (const row of rows) {
    // one row per campaign per day — sum per date
    const d = String(row.segments?.date ?? "");
    if (!d) continue;
    let pt = out.get(d);
    if (!pt) out.set(d, (pt = { date: d, spend: 0, leads: 0 }));
    pt.spend += Number(row.metrics?.costMicros ?? 0) / 1e6;
    pt.leads += Number(row.metrics?.conversions ?? 0);
  }
  return out;
}

/** {date: PerfPoint} for an LSA account — LOCAL_SERVICES cost per day +
 *  charged leads counted by creation date (mirrors the LSA dashboard's account
 *  metrics). Lean local queries on purpose: shared helpers that swallow errors
 *  into empties would masquerade as real zeros and defeat metrics_failed. */
async function dailyLsa(cid: string, start: string, end: string): Promise<Map<string, PerfPoint>> {
  const out = new Map<string, PerfPoint>();

  const costQ =
    "SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign " +
    "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' " +
    `AND segments.date BETWEEN '${start}' AND '${end}'`;
  for (const row of await adsOsGaqlSearch(cid, costQ)) {
    // per campaign per day — sum per date
    const d = String(row.segments?.date ?? "");
    if (!d) continue;
    let pt = out.get(d);
    if (!pt) out.set(d, (pt = { date: d, spend: 0, leads: 0 }));
    pt.spend += Number(row.metrics?.costMicros ?? 0) / 1e6;
  }

  const leadsQ =
    "SELECT local_services_lead.lead_charged, local_services_lead.creation_date_time " +
    "FROM local_services_lead WHERE local_services_lead.creation_date_time " +
    `BETWEEN '${start} 00:00:00' AND '${end} 23:59:59'`;
  for (const row of await adsOsGaqlSearch(cid, leadsQ)) {
    const lead = row.localServicesLead ?? {};
    if (!lead.leadCharged) continue; // proto omits false — truthiness handles it
    const m = String(lead.creationDateTime ?? "").match(/^(\d{4}-\d{2}-\d{2})([ T]|$)/);
    if (!m) continue;
    const d = m[1];
    let pt = out.get(d);
    if (!pt) out.set(d, (pt = { date: d, spend: 0, leads: 0 }));
    pt.leads += 1;
  }
  return out;
}

/** A continuous daily list over [start, end] — missing days become explicit
 *  zeros so the charts get an unbroken axis and the frontend can bucket by
 *  simple grouping. (Also drops any stray out-of-range dates.) */
function zeroFilled(byDate: Map<string, PerfPoint>, start: string, end: string): PerfPoint[] {
  const out: PerfPoint[] = [];
  const day = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`).getTime();
  while (day.getTime() <= stop) {
    const iso = day.toISOString().slice(0, 10);
    const pt = byDate.get(iso) ?? { date: iso, spend: 0, leads: 0 };
    pt.spend = Math.round(pt.spend * 100) / 100;
    out.push(pt);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/** One account's daily series. Transient Ads errors are retried; a persistent
 *  failure yields a zero-filled series FLAGGED metrics_failed (never sinks the
 *  payload). Quota exhaustion re-raises so the route returns the clean 503. */
async function seriesFor(m: CombinedMember, start: string, end: string): Promise<PerfSeries> {
  const fetch = () =>
    m.product === "gads" ? dailyGads(m.customer_id, start, end) : dailyLsa(m.customer_id, start, end);

  let byDate = new Map<string, PerfPoint>();
  let failed = false;
  try {
    byDate = await retryTransient(fetch, `performance series for ${m.product}:${m.customer_id}`);
  } catch (err) {
    if (err instanceof AdsOsApiError && err.kind === "quota_exceeded") {
      throw err; // quota — surface it, don't mask as zeros
    }
    if (!(err instanceof AdsOsApiError)) throw err; // programming error — never mask
    failed = true;
  }
  return {
    product: m.product,
    customer_id: m.customer_id,
    name: m.descriptive_name,
    city: m.city,
    ads_status: m.ads_status,
    metrics_failed: failed,
    points: zeroFilled(byDate, start, end),
  };
}

/** The performance payload for one client (matched by normalized name against
 *  the combined dashboard's rows — identical seam to the client profile), or
 *  null when no client matches (unknown name / offboarded). */
export async function buildClientPerformance(
  name: string,
  start: string,
  end: string,
): Promise<ClientPerformanceResponse | null> {
  const { resp } = await buildCombinedDashboardCached(false);
  const want = normClientName(name);
  const row = resp.rows.find((r) => normClientName(r.client) === want);
  if (!row) return null;

  let series: PerfSeries[] = [];
  if (row.members.length) {
    series = await mapPool(row.members, 6, (m) => seriesFor(m, start, end));
  }
  series.sort((a, b) =>
    a.product === b.product
      ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      : a.product === "gads"
        ? -1
        : 1,
  );
  return {
    client: row.client,
    currency_code: row.currency_code,
    start,
    end,
    accounts: series,
    generated_at: new Date().toISOString(),
  };
}

// --- 1-hour cache. Unlike the dashboards' bounded {window}:{compare} key
// space, custom date ranges make this key space unbounded — cap the entry
// count (drop oldest). A build where any account failed is cached only briefly
// so the flat-zero chart self-repairs. (KeyedLocks also keeps one tiny lock
// per seen key — bounded in practice by MAX_ENTRIES turnover; acceptable.)
const _cache = new Map<string, { at: number; resp: ClientPerformanceResponse }>();
const _locks = new KeyedLocks();
const MAX_ENTRIES = 64;
const PARTIAL_TTL_MS = 120_000; // for payloads with any metrics_failed series

export async function buildClientPerformanceCached(
  name: string,
  start: string,
  end: string,
): Promise<{ resp: ClientPerformanceResponse | null; fromCache: boolean }> {
  const key = `${normClientName(name)}:${start}:${end}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): ClientPerformanceResponse | null => {
    const cached = _cache.get(key);
    if (!cached) return null;
    const age = Date.now() - cached.at;
    const partial = cached.resp.accounts.some((s) => s.metrics_failed);
    return age < (partial ? PARTIAL_TTL_MS : ttlMs) ? cached.resp : null;
  };

  let resp = hit();
  if (resp !== null) return { resp, fromCache: true };
  return _locks.withLock(key, async () => {
    resp = hit();
    if (resp !== null) return { resp, fromCache: true };
    resp = await buildClientPerformance(name, start, end);
    if (resp !== null) {
      if (_cache.size >= MAX_ENTRIES) {
        // evict oldest so custom ranges can't grow unbounded
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of _cache) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) _cache.delete(oldestKey);
      }
      _cache.set(key, { at: Date.now(), resp });
    }
    return { resp, fromCache: false };
  });
}

/** Test hook: reset the performance cache. */
export function __testResetClientPerformanceCache(): void {
  _cache.clear();
}
