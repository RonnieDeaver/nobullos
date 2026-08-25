/**
 * Ads OS — authoritative monthly-budget source seam.
 *
 * ClickUp's Client List is the sole budget authority. Every consumer still
 * resolves budgets through getSheetBudgets() (the legacy name is retained to
 * avoid a broad call-site rename), but the retired Google Sheet is never read.
 *
 * Source health is explicit:
 *   - authoritative=true means the latest ClickUp directory fetch succeeded;
 *     zero, blank, or a missing per-product value is final and may clear a
 *     previously persisted pacing summary.
 *   - authoritative=false means ClickUp is unavailable. The directory may
 *     still serve its stale cached bundle for display, but refresh writers must
 *     not interpret absent values as authoritative clears.
 *
 * The directory owns caching, stale serving, failure backoff, and single-flight
 * behavior. This module only converts its per-CID object into the historical
 * Map shape expected by pacing and hygiene consumers.
 */

import { bundleIsLive, clickUpBudgets } from "./clickUpDirectory";

export interface SheetBudget {
  gads: number;
  lsa: number;
}

export interface BudgetSourceResult {
  budgets: Map<string, SheetBudget>;
  warning: string | null;
  /** True only when the latest completed ClickUp directory fetch succeeded. */
  authoritative: boolean;
}

function toBudgetMap(
  raw: Record<string, { gads?: number; lsa?: number }>,
): Map<string, SheetBudget> {
  const out = new Map<string, SheetBudget>();
  for (const [cid, budget] of Object.entries(raw)) {
    out.set(cid, {
      gads: budget.gads ?? 0,
      lsa: budget.lsa ?? 0,
    });
  }
  return out;
}

/**
 * Return per-CID ClickUp budgets plus source health. Never raises.
 *
 * `force` refreshes the owning ClickUp directory once. Fleet callers normally
 * reuse its existing cache; rollout tooling can force one authoritative read
 * before invoking the existing per-account refresh paths.
 */
export async function getSheetBudgets(force = false): Promise<BudgetSourceResult> {
  try {
    const budgets = toBudgetMap(await clickUpBudgets(force));
    const authoritative = bundleIsLive();
    return {
      budgets,
      authoritative,
      warning: authoritative
        ? null
        : "ClickUp budgets unavailable — using the last cached ClickUp copy without clearing stored budgets.",
    };
  } catch (err: any) {
    console.warn(`[AdsOs/budget] ClickUp budgets unavailable: ${err?.message ?? err}`);
    return {
      budgets: new Map(),
      authoritative: false,
      warning: "ClickUp budgets unavailable — stored budgets were left unchanged.",
    };
  }
}