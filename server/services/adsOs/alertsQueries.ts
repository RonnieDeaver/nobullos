/**
 * Ads OS — read-only GAQL pulls for the Account Alerts engine.
 *
 * Port of backend/app/alerts/queries.py, plus the lean LSA fetchers the LSA
 * checks need (mirroring backend/app/lsa/queries.py fetch_campaigns /
 * fetch_leads / fetch_verification_artifacts — lean local queries on purpose,
 * matching the shapes the alerts engine consumes).
 *
 * Every GAds dataset is pulled concurrently; a per-query failure degrades to
 * empty rows plus a "{label}: {message}" warning so one broken pull never
 * sinks the whole account's alert run. The engine checks the warnings before
 * trusting absence-of-rows (e.g. asset_groups -> "can't serve").
 *
 * Strictly read-only against the Google Ads API (searchStream only).
 */

import { adsOsGaqlSearch, SearchStreamRow } from "./googleAdsClient";

export interface GadsAlertRows {
  data: Record<string, SearchStreamRow[]>;
  warnings: string[];
}

/** Run one labeled query, degrading to empty rows + a warning on failure. */
async function safeSearch(
  cid: string,
  label: string,
  query: string,
): Promise<{ label: string; rows: SearchStreamRow[]; warning: string | null }> {
  try {
    const rows = await adsOsGaqlSearch(cid, query);
    return { label, rows, warning: null };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    return { label, rows: [], warning: `${label}: ${msg}` };
  }
}

/**
 * Pull every dataset the GAds checks need. Serving-health datasets use the
 * narrowed scannable campaign set; the rolling-CPL aggregate separately uses
 * every labeled monitored campaign so historical performance matches the
 * dashboards. Each scoped query is skipped when its own id set is empty.
 */
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
): Promise<GadsAlertRows> {
  const cid = customerId.replace(/-/g, "").trim();
  const queries: Record<string, string> = {
    customer: "SELECT customer.status FROM customer LIMIT 1",
  };
  if (campaignIds.length) {
    const campIn = `campaign.id IN (${campaignIds.join(", ")})`;
    Object.assign(queries, {
      campaigns:
        "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, " +
        "campaign.advertising_channel_type, campaign.advertising_channel_sub_type " +
        `FROM campaign WHERE ${campIn}`,
      daily:
        "SELECT campaign.id, segments.date, metrics.impressions, metrics.cost_micros " +
        `FROM campaign WHERE ${campIn} ` +
        `AND segments.date BETWEEN '${dailyStart}' AND '${dailyEnd}'`,
      weekly:
        "SELECT campaign.id, metrics.cost_micros, metrics.conversions " +
        `FROM campaign WHERE ${campIn} ` +
        `AND segments.date BETWEEN '${weekStart}' AND '${weekEnd}'`,
      ads_policy:
        "SELECT campaign.id, ad_group_ad.policy_summary.approval_status, " +
        "ad_group_ad.policy_summary.review_status, " +
        "ad_group_ad.policy_summary.policy_topic_entries " +
        "FROM ad_group_ad " +
        "WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
        `AND ${campIn}`,
      has_keywords:
        "SELECT campaign.id FROM ad_group_criterion " +
        "WHERE ad_group_criterion.type = 'KEYWORD' " +
        "AND ad_group_criterion.status = 'ENABLED' " +
        "AND ad_group_criterion.negative = FALSE " +
        "AND ad_group.status = 'ENABLED' " +
        `AND ${campIn}`,
      asset_policy:
        "SELECT campaign.id, campaign_asset.field_type, " +
        "campaign_asset.primary_status FROM campaign_asset " +
        "WHERE campaign_asset.status = 'ENABLED' " +
        "AND campaign_asset.primary_status IN ('LIMITED', 'NOT_ELIGIBLE') " +
        `AND ${campIn}`,
      // PMax serves via asset groups, not ads — this is how we tell whether a
      // Performance Max campaign can serve. Non-PMax campaigns have no asset
      // groups, so this is naturally empty for them.
      asset_groups:
        "SELECT campaign.id, asset_group.primary_status " +
        "FROM asset_group " +
        `WHERE ${campIn} AND asset_group.status != 'REMOVED'`,
    });
  }
  if (cplCampaignIds.length) {
    const cplCampIn = `campaign.id IN (${cplCampaignIds.join(", ")})`;
    queries.cpl =
      "SELECT campaign.id, metrics.cost_micros, metrics.conversions " +
      `FROM campaign WHERE ${cplCampIn} ` +
      `AND segments.date BETWEEN '${cplStart}' AND '${cplEnd}'`;
  }

  const results = await Promise.all(
    Object.entries(queries).map(([label, q]) => safeSearch(cid, label, q)),
  );
  const data: Record<string, SearchStreamRow[]> = {};
  const warnings: string[] = [];
  for (const r of results) {
    data[r.label] = r.rows;
    if (r.warning) warnings.push(r.warning);
  }
  return { data, warnings };
}

/** customer.status name for an account (read-only). '' on any error. */
export async function fetchCustomerStatus(customerId: string): Promise<string> {
  const cid = customerId.replace(/-/g, "").trim();
  try {
    const rows = await adsOsGaqlSearch(cid, "SELECT customer.status FROM customer LIMIT 1");
    for (const row of rows) return String(row.customer?.status ?? "");
    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// LSA fetchers (lean, alerts-scoped — mirror lsa/queries.py shapes)
// ---------------------------------------------------------------------------

export interface LsaCampaignRow {
  id: string;
  status: string;
}

/** Every LOCAL_SERVICES campaign's id + status. ([], warning) on failure. */
export async function fetchLsaCampaigns(
  customerId: string,
): Promise<{ rows: LsaCampaignRow[]; warning: string | null }> {
  const cid = customerId.replace(/-/g, "").trim();
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      "SELECT campaign.id, campaign.status FROM campaign " +
        "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'",
    );
    return {
      rows: rows.map((r) => ({
        id: String(r.campaign?.id ?? ""),
        status: String(r.campaign?.status ?? ""),
      })),
      warning: null,
    };
  } catch (err: any) {
    return { rows: [], warning: `campaigns: ${String(err?.message ?? err)}` };
  }
}

export interface LsaLeadRow {
  charged: boolean;
  creationDateTime: string;
}

export interface LsaCostRow {
  costMicros: number;
}

/** Local Services campaign spend over [start, end]. ([], warning) on failure. */
export async function fetchLsaCost(
  customerId: string,
  startIso: string,
  endIso: string,
): Promise<{ rows: LsaCostRow[]; warning: string | null }> {
  const cid = customerId.replace(/-/g, "").trim();
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      "SELECT campaign.id, metrics.cost_micros FROM campaign " +
        "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' " +
        `AND segments.date BETWEEN '${startIso}' AND '${endIso}'`,
    );
    return {
      rows: rows.map((r) => ({ costMicros: Number(r.metrics?.costMicros ?? 0) })),
      warning: null,
    };
  } catch (err: any) {
    return { rows: [], warning: `cost: ${String(err?.message ?? err)}` };
  }
}

/** Leads with charged flag + creation timestamp over [start, end]. */
export async function fetchLsaLeads(
  customerId: string,
  startIso: string,
  endIso: string,
): Promise<{ rows: LsaLeadRow[]; warning: string | null }> {
  const cid = customerId.replace(/-/g, "").trim();
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      "SELECT local_services_lead.lead_charged, local_services_lead.creation_date_time " +
        "FROM local_services_lead WHERE local_services_lead.creation_date_time " +
        `BETWEEN '${startIso} 00:00:00' AND '${endIso} 23:59:59'`,
    );
    return {
      rows: rows.map((r) => ({
        // REST omits lead_charged when false; truthy check covers both.
        charged: Boolean(r.localServicesLead?.leadCharged),
        creationDateTime: String(r.localServicesLead?.creationDateTime ?? ""),
      })),
      warning: null,
    };
  } catch (err: any) {
    return { rows: [], warning: `leads: ${String(err?.message ?? err)}` };
  }
}

export interface LsaVerificationArtifactRow {
  artifactType: string;
  status: string;
  creationDateTime: string;
}

/** Every verification artifact's type + status + creation timestamp. */
export async function fetchLsaVerificationArtifacts(
  customerId: string,
): Promise<{ rows: LsaVerificationArtifactRow[]; warning: string | null }> {
  const cid = customerId.replace(/-/g, "").trim();
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      "SELECT local_services_verification_artifact.artifact_type, " +
        "local_services_verification_artifact.status, " +
        "local_services_verification_artifact.creation_date_time " +
        "FROM local_services_verification_artifact",
    );
    return {
      rows: rows.map((r) => ({
        artifactType: String(r.localServicesVerificationArtifact?.artifactType ?? ""),
        status: String(r.localServicesVerificationArtifact?.status ?? ""),
        creationDateTime: String(r.localServicesVerificationArtifact?.creationDateTime ?? ""),
      })),
      warning: null,
    };
  } catch (err: any) {
    return { rows: [], warning: `verification: ${String(err?.message ?? err)}` };
  }
}
