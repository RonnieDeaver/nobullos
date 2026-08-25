/**
 * Cycle-free Paid Search role-cutover contract.
 *
 * These identifiers are shared by destination configuration, the execution
 * gate, evidence/import, and Ads OS overlays. Keeping them in one leaf prevents
 * a policy check from silently drifting to a different department or People
 * field while avoiding imports of the stateful cutover service.
 */

export const PAID_SEARCH_DEPT_NAME =
  "Fulfillment \u2013 Paid Search (Google Ads / LSA)";

/** Owner-approved production ClickUp contract. Never env-overridden. */
export const CANONICAL_PRODUCTION_LIST_ID = "901417549202";
export const CLICKUP_DOER_FIELD_ID = "21335dc5-98ba-470c-b8a9-944e3cfed343";
export const CLICKUP_CHECKER_FIELD_ID = "0bfb4a38-47e4-4343-bb83-051a9fd40122";
/** Canonical Client List multi-select contract discovered from ClickUp. */
export const CLICKUP_PRACTICE_AREA_FIELD_ID = "237317f2-e612-4983-baf7-97166de73a77";
export const CLICKUP_PRACTICE_AREA_FIELD_NAME = "Practice Area";
export const CLICKUP_PRACTICE_AREA_FIELD_TYPE = "labels";

export function canonicalPaidSearchFieldForResponsibility(
  responsibility: string | null | undefined,
): string | null {
  if (responsibility === "doer") return CLICKUP_DOER_FIELD_ID;
  if (responsibility === "checker") return CLICKUP_CHECKER_FIELD_ID;
  return null;
}