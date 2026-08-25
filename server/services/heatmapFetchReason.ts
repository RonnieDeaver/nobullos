/**
 * Task #2493 — distinguish a brand-new Map Rank Tracker campaign that simply has
 * not run its first scheduled report yet from a genuine fetch failure.
 *
 * The SEMrush Map Rank Tracker `GetCampaign` response (v0
 * `/apis/v4/map-rank-tracker/v0/campaigns/:campaignId`) returns:
 *   - `reportDates`     — array of dates on which reports were generated. EMPTY
 *                         for a campaign that has not collected data yet.
 *   - `lastReportDate`  — date of the last report (absent until the first runs).
 *   - `nextReportDate`  — date of the next scheduled report.
 *   - `collectingFrequency` — object `{ frequency: DAILY|WEEKLY|MONTHLY,
 *                             positions: number[] }`, with a sibling `enable`
 *                             boolean indicating scheduled collection is active.
 * (Confirmed against https://developer.semrush.com/api/v4/map-rank-tracker-2/ —
 *  "GetCampaign" Response Parameters, reviewed 2026-06-11.)
 *
 * When `reportDates` is empty the OLD code returned a generic 400 that the UI
 * surfaced as a connection error. We now return a distinct, machine-readable
 * code plus the campaign's own schedule so the picker can say "no scans yet,
 * next report <date>" and steer the operator to manual screenshot upload.
 */

export const NO_REPORT_DATES_CODE = "no_report_dates_yet";

export interface CampaignSchedulingInfo {
  lastReportDate: string | null;
  nextReportDate: string | null;
  frequency: string | null;
  collectionEnabled: boolean | null;
}

export interface NoReportDatesPayload {
  error: string;
  code: typeof NO_REPORT_DATES_CODE;
  fallback: "manual_upload";
  campaignScheduling: CampaignSchedulingInfo;
}

// True when the campaign carries no generated-report dates yet (a fresh
// campaign that has not collected data). Treats a missing/non-array field as
// empty.
export function campaignHasNoReportDates(campaign: any): boolean {
  const dates = campaign?.reportDates;
  return !Array.isArray(dates) || dates.length === 0;
}

// Normalize the campaign's scheduling fields. `collectingFrequency` may arrive
// as the documented object, or (defensively) as a bare frequency string.
export function buildCampaignSchedulingInfo(
  campaign: any,
): CampaignSchedulingInfo {
  const cf = campaign?.collectingFrequency;
  let frequency: string | null = null;
  let collectionEnabled: boolean | null = null;
  if (cf && typeof cf === "object") {
    frequency = typeof cf.frequency === "string" ? cf.frequency : null;
    collectionEnabled = typeof cf.enable === "boolean" ? cf.enable : null;
  } else if (typeof cf === "string") {
    frequency = cf;
  }
  // `enable` can also be a sibling of collectingFrequency in some responses.
  if (collectionEnabled === null && typeof campaign?.enable === "boolean") {
    collectionEnabled = campaign.enable;
  }
  return {
    lastReportDate:
      typeof campaign?.lastReportDate === "string"
        ? campaign.lastReportDate
        : null,
    nextReportDate:
      typeof campaign?.nextReportDate === "string"
        ? campaign.nextReportDate
        : null,
    frequency,
    collectionEnabled,
  };
}

// Human sentence describing when the first scan is expected, using whatever the
// schedule exposes.
function buildNoReportDatesMessage(info: CampaignSchedulingInfo): string {
  const base =
    "This Map Rank campaign hasn't collected any scans yet, so there's no map rank data to fetch.";
  if (info.nextReportDate) {
    return `${base} The first scheduled scan is due ${info.nextReportDate}. Until then, upload a screenshot manually.`;
  }
  if (info.frequency) {
    return `${base} Scans are scheduled ${info.frequency.toLowerCase()}; the first one hasn't run. Until then, upload a screenshot manually.`;
  }
  return `${base} Once SEMrush runs the first scan it'll be available; until then, upload a screenshot manually.`;
}

export function buildNoReportDatesPayload(campaign: any): NoReportDatesPayload {
  const campaignScheduling = buildCampaignSchedulingInfo(campaign);
  return {
    error: buildNoReportDatesMessage(campaignScheduling),
    code: NO_REPORT_DATES_CODE,
    fallback: "manual_upload",
    campaignScheduling,
  };
}
