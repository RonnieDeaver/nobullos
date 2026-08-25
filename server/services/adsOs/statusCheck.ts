/**
 * Ads Status verification — is a ClickUp Paused/Off account ACTUALLY not running?
 *
 * Port of the reference app's status_check.py (AM Dashboard handoff, Task #3988).
 *
 * The Paused/Off chips across Ads OS come from the ClickUp Client List's Ads
 * Status dropdown, which is a human-maintained CLAIM. This engine checks the
 * claim against the account's real state each morning (same cron as
 * pacing/alerts) so every chip can carry a verification mark:
 *
 *   ✓  the claim holds — nothing is enabled in the account
 *   ✗  mismatch — campaigns are ENABLED although ClickUp says Paused/Off,
 *      meaning either the Ads Status is stale or the account is spending when
 *      it shouldn't be
 *
 * The check per account is one read-only GAQL query, channel-scoped because
 * one CID can host BOTH products (a Search campaign and a LOCAL_SERVICES
 * campaign under the same account — Paxton Law is the live example):
 *
 *   GAds = any ENABLED campaign whose channel is NOT LOCAL_SERVICES
 *   LSA  = any ENABLED LOCAL_SERVICES campaign
 *
 * Deliberately NOT scoped to labeled campaigns: "paused" is an account-level
 * claim, and an unlabeled-but-running campaign still spends the client's
 * money. Only accounts whose ClickUp status is explicitly paused/off are
 * checked — On accounts are the normal case and the alerts engine already
 * watches those.
 *
 * Results persist as ONE store document (saveStatusChecks); readers overlay
 * them on the AM Dashboard (and later the client profile's account list).
 * Strictly read-only against the Google Ads API — adsOsGaqlSearch is the
 * module's searchStream-only client (the mutate-guard test pins that).
 */

import { adsStatusFor, bundleIsLive, enrolledCids } from "./clickUpDirectory";
import { AdsOsApiError, adsOsGaqlSearch } from "./googleAdsClient";
import { saveStatusChecks } from "./store";
import type { Product } from "./types";

/** How many offending campaign NAMES to persist per account. The tooltip's job
 *  is "which campaign trips this ✗?" — the count carries the rest. */
const MAX_NAMES = 5;

/** Reference runs the batch on a 6-thread pool; same fan-out here. */
const CONCURRENCY = 6;

export interface StatusCheckEntry {
  expected: string; // the ClickUp claim: "paused" | "off"
  matches?: boolean; // claim holds (no enabled campaigns)?
  enabled_campaigns?: number;
  enabled_campaign_names?: string[];
  error?: string;
  checked_at: string;
}

export interface StatusCheckRunResult {
  skipped?: "clickup_unavailable" | "no_targets" | "all_errored";
  errors?: number;
  checked?: number;
  mismatches?: number;
  saved?: boolean;
}

/**
 * (count, names) of campaigns that could still serve for this product here.
 *
 * Two conditions, both needed: campaign.status = ENABLED (the human switch)
 * AND serving_status != ENDED — a campaign whose end date has passed keeps
 * status ENABLED forever but can never serve again, so counting it would flag
 * a cleanly wound-down account as a mismatch. PENDING (scheduled to start
 * later) IS counted: a future-scheduled campaign genuinely contradicts a
 * Paused/Off claim.
 *
 * Names are returned so a ✗ chip can say WHICH campaign trips it — the live
 * lesson from O'Brien Law, where one still-serving flight sat between five
 * ended ones and the ✗ read as a false alarm until the campaign was named.
 */
async function enabledCampaigns(cid: string, product: Product): Promise<{ n: number; names: string[] }> {
  const op = product === "lsa" ? "=" : "!=";
  const query =
    "SELECT campaign.name FROM campaign WHERE campaign.status = 'ENABLED' " +
    "AND campaign.serving_status != 'ENDED' " +
    `AND campaign.advertising_channel_type ${op} 'LOCAL_SERVICES'`;
  const rows = await adsOsGaqlSearch(cid, query);
  const names: string[] = [];
  for (const row of rows) {
    if (names.length < MAX_NAMES) {
      names.push(String(row?.campaign?.name ?? "").slice(0, 80));
    }
  }
  return { n: rows.length, names };
}

/** Run `fn` over `items` with at most `limit` in flight (order preserved). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Check every ClickUp-paused/off ENROLLED account (Off accounts are enrolled
 * even though they're not monitored) and persist the batch. Returns a small
 * summary for the cron log / Refresh response. A per-account failure records
 * an error entry — the chip then shows no mark rather than a stale verdict.
 */
export async function runStatusChecks(): Promise<StatusCheckRunResult> {
  // A dead ClickUp directory returns an EMPTY roster, and persisting an empty
  // batch over yesterday's would wipe every ✓/✗ for the day on a transient
  // outage. Keep the last-known batch instead — stale marks with their
  // checked_at beat no marks.
  if (!bundleIsLive()) {
    console.warn("[AdsOs/statusCheck] skipped: ClickUp directory unavailable (kept last batch)");
    return { skipped: "clickup_unavailable" };
  }

  const now = new Date().toISOString();
  const targets: Array<{ product: Product; cid: string; status: string }> = [];
  for (const product of ["gads", "lsa"] as Product[]) {
    for (const cid of await enrolledCids(product)) {
      const status = await adsStatusFor(product, cid);
      if (status === "paused" || status === "off") {
        targets.push({ product, cid, status });
      }
    }
  }

  // Nothing to check (every enrolled account is On, or the roster came back
  // thin) — persisting {} here would erase yesterday's marks app-wide on the
  // strength of a roster we have no reason to trust more than the batch we
  // already hold.
  if (targets.length === 0) {
    console.warn("[AdsOs/statusCheck] skipped: no paused/off targets (kept last batch)");
    return { skipped: "no_targets" };
  }

  const results = await mapPool(targets, CONCURRENCY, async (t): Promise<[string, StatusCheckEntry]> => {
    const key = `${t.product}:${t.cid}`;
    try {
      const { n, names } = await enabledCampaigns(t.cid, t.product);
      return [
        key,
        {
          expected: t.status,
          matches: n === 0,
          enabled_campaigns: n,
          enabled_campaign_names: names,
          checked_at: now,
        },
      ];
    } catch (err: any) {
      // The Ads API's own message is the useful part (mirrors the reference's
      // GoogleAdsException branch); anything else degrades to the class name.
      const msg =
        err instanceof AdsOsApiError
          ? String(err.message).slice(0, 200)
          : String(err?.constructor?.name || err?.name || "Error");
      return [key, { expected: t.status, error: msg, checked_at: now }];
    }
  });

  const checks: Record<string, StatusCheckEntry> = {};
  for (const [key, entry] of results) checks[key] = entry;

  // An MCC-wide Ads API outage turns EVERY entry into an error, and an error
  // entry renders as a bare chip — so saving this batch would silently strip
  // every ✓ and, worse, every ✗ from both dashboards. A batch with no verdicts
  // in it is not an improvement on the last one that had some: keep the old
  // one. (A partial failure still saves: those accounts individually degrade
  // to a bare chip, which is the honest answer for them.)
  const entries = Object.values(checks);
  if (entries.every((c) => c.error !== undefined)) {
    console.error(`[AdsOs/statusCheck] all ${entries.length} accounts errored — kept last batch`);
    return { skipped: "all_errored", errors: entries.length };
  }

  const saved = await saveStatusChecks({ checks, generated_at: now });
  const mismatches = entries.filter((c) => c.matches === false).length;
  const errors = entries.filter((c) => c.error !== undefined).length;
  console.log(
    `[AdsOs/statusCheck] ${entries.length} checked, ${mismatches} mismatches, ${errors} errors, saved=${saved}`,
  );
  // `saved` is reported, not just logged: every chip renders bare when the
  // batch is missing, so a failed write looks exactly like a run that never
  // happened. The caller (cron / AM Refresh) surfaces it instead of leaving it
  // to a log nobody reads.
  return { checked: entries.length, mismatches, errors, saved };
}
