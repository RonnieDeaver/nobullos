// @db-pool-intent: none
//
// Task #4964 — monitor-label coverage classification (READ-ONLY).
//
// The combined dashboard, hygiene, pacing and traffic quality all scope their
// Google Ads pulls to campaigns carrying the NBM_GADS_MONITOR_CAMPAIGN label
// (config KI_CAMPAIGN_LABEL). An enrolled account whose active campaigns carry
// ZERO labels silently renders $0.00 everywhere. This module is the SINGLE
// shared classifier used by all three consumers:
//   1. the combined dashboard / client profile "Setup needed" surfacing,
//   2. the one-press label-apply prod action (targets zero-label accounts only),
//   3. the daily label-drift guard alert.
//
// Classification (per enrolled GAds account, active non-LSA campaigns only):
//   • "zero"      — has active campaigns, NONE labeled → broken monitoring.
//   • "partial"   — some but not all active campaigns labeled → INTENTIONAL
//                   scoping (e.g. Weber Law 3/19). NEVER treated as broken and
//                   NEVER modified by the label-apply action.
//   • "full"      — every active campaign labeled.
//   • "no_active" — no active non-LSA campaigns (nothing to monitor).
//   • "unknown"   — the Ads API errored for this account; consumers must treat
//                   this as "cannot tell" (no alert, no action, no chip) so a
//                   transient failure can never mislabel an account as broken.
//
// STRICTLY READ-ONLY: GAQL searchStream queries only (the mutate guard applies
// to this whole directory). The label-apply write path lives OUTSIDE this
// directory in server/services/googleAdsLabelMutate.ts.

import { adsOsGaqlSearch } from "./googleAdsClient";
import { enrolledAccounts, labeledCampaignIds, type EnrolledAccount } from "./enrollment";
import { KI_CAMPAIGN_LABEL } from "./config";

export type LabelCoverage = "full" | "partial" | "zero" | "no_active" | "unknown";

export interface AccountLabelCoverage {
  customer_id: string;
  descriptive_name: string;
  coverage: LabelCoverage;
  /** Active (ENABLED) non-LSA campaign ids in the account. */
  activeCampaignIds: string[];
  /** Subset of activeCampaignIds carrying the monitor label. */
  labeledActiveCampaignIds: string[];
  /** Set when coverage === "unknown" — the Ads API failure message. */
  error?: string;
}

export interface LabelCoverageDeps {
  gaqlSearch: typeof adsOsGaqlSearch;
  labeledIds: (cid: string, label: string) => Promise<string[]>;
  listEnrolled: () => Promise<EnrolledAccount[]>;
  labelName: string;
}

const defaultDeps: LabelCoverageDeps = {
  gaqlSearch: adsOsGaqlSearch,
  labeledIds: labeledCampaignIds,
  listEnrolled: () => enrolledAccounts("gads"),
  labelName: KI_CAMPAIGN_LABEL,
};

/** Active (ENABLED) non-LSA campaign ids in one account. Throws on API error
 *  (callers classify the account as "unknown" — never as zero/broken). */
export async function activeNonLsaCampaignIds(
  customerId: string,
  gaqlSearch: typeof adsOsGaqlSearch = adsOsGaqlSearch,
): Promise<string[]> {
  const cid = customerId.replace(/[^0-9]/g, "");
  const query =
    "SELECT campaign.id FROM campaign " +
    "WHERE campaign.status = 'ENABLED' " +
    "AND campaign.advertising_channel_type != 'LOCAL_SERVICES'";
  const ids: string[] = [];
  for (const row of await gaqlSearch(cid, query)) {
    const id = row.campaign?.id;
    if (id !== undefined && id !== null) ids.push(String(id));
  }
  return ids;
}

/** Classify ONE account. Reuses an already-fetched labeled-id list when the
 *  caller (combined dashboard) has it in hand — zero extra queries for the
 *  common fully/partially-labeled case. */
export async function classifyAccountLabelCoverage(
  customerId: string,
  descriptiveName: string,
  opts: { knownLabeledIds?: string[]; deps?: Partial<LabelCoverageDeps> } = {},
): Promise<AccountLabelCoverage> {
  const deps = { ...defaultDeps, ...opts.deps };
  const base: AccountLabelCoverage = {
    customer_id: customerId,
    descriptive_name: descriptiveName,
    coverage: "unknown",
    activeCampaignIds: [],
    labeledActiveCampaignIds: [],
  };
  try {
    const labeled = new Set(
      opts.knownLabeledIds ?? (await deps.labeledIds(customerId, deps.labelName)),
    );
    const active = await activeNonLsaCampaignIds(customerId, deps.gaqlSearch);
    const labeledActive = active.filter((id) => labeled.has(id));
    base.activeCampaignIds = active;
    base.labeledActiveCampaignIds = labeledActive;
    if (active.length === 0) base.coverage = "no_active";
    else if (labeledActive.length === 0) base.coverage = "zero";
    else if (labeledActive.length < active.length) base.coverage = "partial";
    else base.coverage = "full";
    return base;
  } catch (err: any) {
    // API failure (incl. permission/transient): cannot tell — NEVER classify
    // as zero on error; a transient blip must not page the team or enqueue a
    // label write.
    base.coverage = "unknown";
    base.error = err?.message ?? String(err);
    return base;
  }
}

/** Classify EVERY enrolled GAds account. Per-account failures isolate as
 *  "unknown" rows; enrollment/list failures throw (nothing to classify). */
export async function classifyEnrolledLabelCoverage(
  depsOverride: Partial<LabelCoverageDeps> = {},
): Promise<AccountLabelCoverage[]> {
  const deps = { ...defaultDeps, ...depsOverride };
  const enrolled = await deps.listEnrolled();
  const out: AccountLabelCoverage[] = [];
  for (const acct of enrolled) {
    out.push(
      await classifyAccountLabelCoverage(acct.cid, acct.name, { deps: depsOverride }),
    );
  }
  return out;
}
