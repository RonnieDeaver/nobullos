// @db-pool-intent: none
//
// Task #4964 — Google Ads monitor-label WRITE adapter.
//
// This is deliberately OUTSIDE server/services/adsOs/ — that directory is
// guarded read-only by tests/ads-os-mutate-guard.test.ts (Ads OS analytics
// must never mutate client accounts). This adapter is the ONE sanctioned
// Google Ads write path in the codebase, and it can do exactly one thing:
// ensure the monitor campaign label exists in a client account and attach it
// to campaigns. It is only ever invoked from the operator-gated one-press
// prod action (never scheduled, never automatic).
//
// Idempotency / retry-doubling safety (P11): attaching a label a campaign
// already carries is a duplicate the API rejects per-operation — and the
// action only ever targets accounts with ZERO labels, re-detected fresh on
// every press, so a timed-out call that actually landed simply drops the
// account from the next press's target set.

import {
  ADS_OS_API_VERSION,
  adsOsGaqlSearch,
  getEnvAccessToken,
} from "./adsOs/googleAdsClient";
import { getDeveloperToken, getLoginCustomerId } from "./adsOs/config";
import { escGaql } from "./adsOs/enrollment";

const API_BASE = `https://googleads.googleapis.com/${ADS_OS_API_VERSION}`;

export interface LabelMutateDeps {
  /** Injected for tests — production default is global fetch. */
  fetchImpl: typeof fetch;
  gaqlSearch: typeof adsOsGaqlSearch;
  getAccessToken: () => Promise<string>;
}

const defaultDeps: LabelMutateDeps = {
  fetchImpl: (...args) => fetch(...args),
  gaqlSearch: adsOsGaqlSearch,
  getAccessToken: getEnvAccessToken,
};

async function postMutate(
  deps: LabelMutateDeps,
  customerId: string,
  path: "labels" | "campaignLabels",
  operations: unknown[],
): Promise<any> {
  const cid = customerId.replace(/[^0-9]/g, "");
  const token = await deps.getAccessToken();
  const res = await deps.fetchImpl(`${API_BASE}/customers/${cid}/${path}:mutate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": getDeveloperToken(),
      "login-customer-id": getLoginCustomerId(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operations }),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Google Ads ${path}:mutate returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || `Google Ads ${path}:mutate failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return parsed;
}

/** Find the label's resource name in the account, creating it when absent.
 *  Labels are account-local, so this runs per client account. */
export async function ensureCampaignLabel(
  customerId: string,
  labelName: string,
  depsOverride: Partial<LabelMutateDeps> = {},
): Promise<string> {
  const deps = { ...defaultDeps, ...depsOverride };
  const cid = customerId.replace(/[^0-9]/g, "");
  const rows = await deps.gaqlSearch(
    cid,
    `SELECT label.resource_name, label.name FROM label WHERE label.name = '${escGaql(labelName)}' AND label.status = 'ENABLED'`,
  );
  const existing = rows[0]?.label?.resourceName;
  if (existing) return String(existing);
  const resp = await postMutate(deps, cid, "labels", [{ create: { name: labelName } }]);
  const created = resp?.results?.[0]?.resourceName;
  if (!created) throw new Error("Label create returned no resourceName");
  return String(created);
}

export interface ApplyLabelResult {
  labelResourceName: string;
  appliedCampaignIds: string[];
}

/** Attach the label to every given campaign in one mutate batch. */
export async function applyLabelToCampaigns(
  customerId: string,
  labelResourceName: string,
  campaignIds: string[],
  depsOverride: Partial<LabelMutateDeps> = {},
): Promise<ApplyLabelResult> {
  const deps = { ...defaultDeps, ...depsOverride };
  const cid = customerId.replace(/[^0-9]/g, "");
  if (campaignIds.length === 0) {
    return { labelResourceName, appliedCampaignIds: [] };
  }
  const operations = campaignIds.map((id) => ({
    create: {
      campaign: `customers/${cid}/campaigns/${id}`,
      label: labelResourceName,
    },
  }));
  await postMutate(deps, cid, "campaignLabels", operations);
  return { labelResourceName, appliedCampaignIds: campaignIds };
}
