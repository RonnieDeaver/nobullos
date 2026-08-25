/**
 * Ads OS — account enrollment resolver (port of backend/app/enrollment.py).
 *
 * WHICH accounts each dashboard shows, from two sources:
 *   1. ClickUp Client List directory (authoritative when live) — Ads Status
 *      On/blank = monitored, Paused = monitored (shown), Off = enrolled only.
 *   2. Legacy Google Ads ACCOUNT labels (NBM_GADS_MONITOR / NBM_LSA_MONITOR) —
 *      fallback + migration-gap union.
 *
 * ACCOUNT_ENROLLMENT=auto|clickup|label (spec §9):
 *   - label:   pure label enrollment.
 *   - clickup: pure ClickUp (a CID unknown to ClickUp isn't enrolled).
 *   - auto:    ClickUp while CURRENTLY live (last directory fetch succeeded);
 *              labels when ClickUp is unreachable or never fetched. When live,
 *              unions in label-carrying CIDs ClickUp has NEVER heard of under
 *              either product (`known` includes offboarded clients' CIDs, so a
 *              stale label can't resurrect a dropped account or invent a second
 *              product). During an outage fallback, a stale bundle (if any)
 *              still enforces the existing per-product exclusion — offboarded
 *              clients stay gone while labels remain the outage safety net.
 *
 * All GAQL goes through adsOsGaqlSearch (REST v24, camelCase rows).
 * GAQL field citations: see ADS_OS.md "GAQL fields used (Phase 1)".
 */

import { adsOsGaqlSearch, AdsOsApiError } from "./googleAdsClient";
import {
  getLoginCustomerId, ACCOUNT_ENROLLMENT,
  KI_ACCOUNT_LABEL, LSA_ACCOUNT_LABEL,
} from "./config";
import * as directory from "./clickUpDirectory";
import type { Product } from "./types";

// id/name/currency for name/currency display; applied_labels only in the label path.
const MCC_ACCOUNTS_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, " +
  "customer_client.currency_code, customer_client.manager " +
  "FROM customer_client WHERE customer_client.status = 'ENABLED'";

export function escGaql(s: string): string {
  return String(s).replace(/'/g, "\\'");
}

function digits(customerId: string): string {
  return customerId.replace(/-/g, "").trim().replace(/[^0-9]/g, "");
}

function labelFor(product: Product): string {
  return product === "gads" ? KI_ACCOUNT_LABEL : LSA_ACCOUNT_LABEL;
}

/** {cid: {name, currency}} for every ENABLED, non-manager account under the MCC.
 *  One query; the combined dashboard fetches it once and reuses it for both products. */
export type MccAccounts = Map<string, { name: string; currency: string | null }>;

export async function mccEnabledAccounts(): Promise<MccAccounts> {
  const rows = await adsOsGaqlSearch(getLoginCustomerId(), MCC_ACCOUNTS_QUERY);
  const out: MccAccounts = new Map();
  for (const row of rows) {
    const cc = row.customerClient ?? {};
    if (cc.manager) continue;
    const id = String(cc.id ?? "");
    if (!id) continue;
    out.set(id, {
      name: cc.descriptiveName || `Account ${id}`,
      currency: cc.currencyCode || null,
    });
  }
  return out;
}

/** CIDs carrying the given ACCOUNT label. Empty on error or when the label doesn't
 *  exist. Account labels are MCC-owned: resolve the label's resource name from the
 *  MCC, then read each ENABLED child's applied_labels. */
async function labelCidsByName(labelName: string): Promise<Set<string>> {
  const mcc = getLoginCustomerId();

  let labelRes: string | null = null;
  try {
    const q1 = `SELECT label.resource_name FROM label WHERE label.name = '${escGaql(labelName)}'`;
    for (const row of await adsOsGaqlSearch(mcc, q1)) {
      if (row.label?.resourceName) labelRes = row.label.resourceName;
    }
  } catch (err) {
    if (err instanceof AdsOsApiError) return new Set();
    throw err; // creds-missing / non-Ads errors propagate
  }
  if (!labelRes) return new Set();

  const out = new Set<string>();
  const q2 =
    "SELECT customer_client.id, customer_client.manager, customer_client.applied_labels " +
    "FROM customer_client WHERE customer_client.status = 'ENABLED'";
  try {
    for (const row of await adsOsGaqlSearch(mcc, q2)) {
      const cc = row.customerClient ?? {};
      if (cc.manager) continue;
      const applied: string[] = cc.appliedLabels ?? [];
      if (applied.includes(labelRes)) out.add(String(cc.id ?? ""));
    }
  } catch (err) {
    if (err instanceof AdsOsApiError) return new Set();
    throw err;
  }
  out.delete("");
  return out;
}

/** CIDs carrying the legacy account label for `product` (auto union + fallback). */
export async function labelCids(product: Product): Promise<Set<string>> {
  return labelCidsByName(labelFor(product));
}

export interface EnrolledAccount {
  cid: string;
  name: string;
  currency: string | null;
}

/** Turn a CID set into account tuples, keeping only CIDs that actually exist
 *  ENABLED under the MCC (an enrolled CID absent here = typo / closed account). */
function toAccounts(cids: Set<string>, mcc: MccAccounts): EnrolledAccount[] {
  const out: EnrolledAccount[] = [];
  for (const cid of cids) {
    const acct = mcc.get(cid);
    if (acct) out.push({ cid, name: acct.name, currency: acct.currency });
  }
  return out;
}

/** True when enrollment should read from ClickUp: strict clickup mode, or auto
 *  mode while the ClickUp directory is live. */
export function clickUpAuthoritative(mode: string = ACCOUNT_ENROLLMENT): boolean {
  return mode === "clickup" || (mode === "auto" && directory.bundleIsLive());
}

function warnMissing(product: Product, cids: Set<string>, mcc: MccAccounts): void {
  const missing = [...cids].filter((c) => !mcc.has(c)).sort();
  if (missing.length) {
    console.warn(
      `[AdsOs/enrollment] ${product}: ${missing.length} enrolled CID(s) not found ` +
      `ENABLED under the MCC (typo / closed / wrong account?): ${missing.join(", ")}`,
    );
  }
}

/** Shared body for monitoredAccounts / enrolledAccounts. `clickUpCidsFn` is
 *  directory.monitoredCids or directory.enrolledCids. */
async function resolve(
  product: Product,
  clickUpCidsFn: (product: Product) => Promise<Set<string>>,
  mcc?: MccAccounts,
): Promise<EnrolledAccount[]> {
  const mode = ACCOUNT_ENROLLMENT;
  // Refresh the directory first so bundleIsLive() reflects the current fetch.
  await directory.getClientDirectory();
  const mccMap = mcc ?? (await mccEnabledAccounts());

  if (!clickUpAuthoritative(mode)) {
    // label mode, or auto with ClickUp not live (unreachable / never fetched):
    // label enrollment. In auto, a stale bundle (if any) still enforces the one
    // exclusion that survives everything — a CID ClickUp knows but does NOT
    // place under a live client block (offboarded/unlinked) stays gone. With
    // no bundle at all both sets are empty and this is pure labels.
    const labels = await labelCids(product);
    if (mode === "auto") {
      const known = await directory.knownCids(product);
      const enrolled = await directory.enrolledCids(product);
      for (const c of [...labels]) {
        if (known.has(c) && !enrolled.has(c)) labels.delete(c);
      }
    }
    return toAccounts(labels, mccMap);
  }

  const cids = new Set(await clickUpCidsFn(product));
  if (mode === "auto") {
    // Migration-gap safety net: union in accounts still enrolled only via the
    // Google label — but ONLY ones ClickUp has never heard of under either
    // product. A missing product is authoritative for every known CID, so a
    // stale label cannot invent a second product or resurrect an offboarded CID.
    const known = await directory.knownCidsAcrossProducts();
    for (const c of await labelCids(product)) {
      if (!known.has(c)) cids.add(c);
    }
  }
  warnMissing(product, cids, mccMap);
  return toAccounts(cids, mccMap);
}

/** On + Paused accounts (drops Off). Drives the GAds/LSA/Main dashboards. */
export async function monitoredAccounts(product: Product, mcc?: MccAccounts): Promise<EnrolledAccount[]> {
  return resolve(product, directory.monitoredCids, mcc);
}

/** All accounts incl. Off. Drives the combined member list (+ future pacing refresh). */
export async function enrolledAccounts(product: Product, mcc?: MccAccounts): Promise<EnrolledAccount[]> {
  return resolve(product, directory.enrolledCids, mcc);
}

// ---------------------------------------------------------------------------
// Campaign scopes (keyword_intel/queries.py + lsa/queries.py ports)
// ---------------------------------------------------------------------------

/** Campaign ids in this account carrying the given CAMPAIGN label. Empty on
 *  Ads API error (partial-access accounts show zeros, never crash the board). */
export async function labeledCampaignIds(customerId: string, labelName: string): Promise<string[]> {
  const cid = digits(customerId);
  const query = `SELECT campaign.id FROM campaign_label WHERE label.name = '${escGaql(labelName)}'`;
  const ids: string[] = [];
  try {
    for (const row of await adsOsGaqlSearch(cid, query)) {
      const id = row.campaign?.id;
      if (id !== undefined && id !== null) ids.push(String(id));
    }
  } catch (err) {
    if (err instanceof AdsOsApiError) return [];
    throw err;
  }
  return ids;
}

/** Every LOCAL_SERVICES campaign id in the account (any status). Empty on error. */
export async function lsaCampaignIds(customerId: string): Promise<string[]> {
  const cid = digits(customerId);
  const query =
    "SELECT campaign.id FROM campaign " +
    "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'";
  const ids: string[] = [];
  try {
    for (const row of await adsOsGaqlSearch(cid, query)) {
      const id = row.campaign?.id;
      if (id !== undefined && id !== null) ids.push(String(id));
    }
  } catch (err) {
    if (err instanceof AdsOsApiError) return [];
    throw err;
  }
  return ids;
}
