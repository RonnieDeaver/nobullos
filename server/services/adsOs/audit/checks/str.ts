/** STR checks — Account Structure & Settings (port of audit/checks/str.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext } from "../context";
import { result } from "./base";

/** STR-01 (discrete): network settings. Display expansion off is best for lead gen. */
export function str01(ctx: AuditContext): CheckResult {
  const searchCampaigns = [...ctx.campaigns.values()].filter((c) => c.channel_type === "SEARCH");
  if (!searchCampaigns.length) {
    return result("STR-01", { status: Status.NA, score: null, value: "No search campaigns" });
  }
  const contentOn = searchCampaigns.filter((c) => c.net_content);
  const partnersOn = searchCampaigns.filter((c) => c.net_search_partners);
  if (contentOn.length) {
    const ev: Evidence[] = contentOn.map((c) => ({
      name: c.name,
      id: c.id,
      detail: "Display expansion ON",
    }));
    return result("STR-01", {
      status: Status.BAD,
      score: null,
      value: `${contentOn.length} search campaign(s) with Display expansion on`,
      evidence: ev,
    });
  }
  if (partnersOn.length) {
    const ev: Evidence[] = partnersOn.map((c) => ({
      name: c.name,
      id: c.id,
      detail: "Search Partners ON",
    }));
    return result("STR-01", {
      status: Status.OKAY,
      score: null,
      value: `${partnersOn.length} campaign(s) with Search Partners on`,
      evidence: ev,
    });
  }
  return result("STR-01", { status: Status.GOOD, score: null, value: "Search-only network settings" });
}

// STR-02 (ad schedule) and STR-04 (audiences) removed per the 2026 team review.
// STR-03 (brand vs non-brand) and STR-05 (conversion-goal assignment) removed earlier.
