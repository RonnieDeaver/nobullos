/* test-registration
{
  "name": "Heatmap fetch no-report-dates signal (Task #2493)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2493 — fetch-heatmap "no scans yet" signal.
 *
 * A brand-new SEMrush Map Rank Tracker campaign returns an EMPTY `reportDates`
 * until its first scheduled scan runs. The fetch-heatmap route used to map that
 * to a generic 400 the UI rendered as a connection error. It now returns the
 * distinct, machine-readable `no_report_dates_yet` payload (HTTP 422) carrying
 * the campaign's own schedule so the picker can say "no scans yet, next scan
 * <date>" and steer to manual upload.
 *
 * Field names confirmed against the SEMrush Map Rank Tracker GetCampaign docs
 * (https://developer.semrush.com/api/v4/map-rank-tracker-2/, reviewed
 * 2026-06-11): `reportDates`, `lastReportDate`, `nextReportDate`, and
 * `collectingFrequency: { frequency: DAILY|WEEKLY|MONTHLY, positions, enable }`.
 */
import assert from "node:assert/strict";
import {
  NO_REPORT_DATES_CODE,
  campaignHasNoReportDates,
  buildCampaignSchedulingInfo,
  buildNoReportDatesPayload,
} from "../server/services/heatmapFetchReason";

let failures = 0;
function step(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

function main(): void {
  console.log("Heatmap fetch no-report-dates signal (Task #2493)");

  step("campaignHasNoReportDates is true for empty/missing reportDates", () => {
    assert.equal(campaignHasNoReportDates({ reportDates: [] }), true);
    assert.equal(campaignHasNoReportDates({}), true);
    assert.equal(campaignHasNoReportDates({ reportDates: null }), true);
    assert.equal(campaignHasNoReportDates({ reportDates: "2025-01-01" }), true);
  });

  step("campaignHasNoReportDates is false once a report date exists", () => {
    assert.equal(campaignHasNoReportDates({ reportDates: ["2025-01-01"] }), false);
  });

  step("scheduling info parses the documented collectingFrequency OBJECT shape", () => {
    const info = buildCampaignSchedulingInfo({
      lastReportDate: "2025-01-08",
      nextReportDate: "2025-01-15",
      collectingFrequency: { frequency: "WEEKLY", positions: [1], enable: true },
    });
    assert.deepEqual(info, {
      lastReportDate: "2025-01-08",
      nextReportDate: "2025-01-15",
      frequency: "WEEKLY",
      collectionEnabled: true,
    });
  });

  step("scheduling info tolerates a bare-string collectingFrequency", () => {
    const info = buildCampaignSchedulingInfo({ collectingFrequency: "DAILY" });
    assert.equal(info.frequency, "DAILY");
    assert.equal(info.lastReportDate, null);
    assert.equal(info.nextReportDate, null);
  });

  step("buildNoReportDatesPayload returns the distinct code + fallback + schedule", () => {
    const payload = buildNoReportDatesPayload({
      reportDates: [],
      nextReportDate: "2025-01-15",
      collectingFrequency: { frequency: "WEEKLY", positions: [1], enable: true },
    });
    assert.equal(payload.code, NO_REPORT_DATES_CODE);
    assert.equal(payload.code, "no_report_dates_yet");
    assert.equal(payload.fallback, "manual_upload");
    assert.equal(payload.campaignScheduling.nextReportDate, "2025-01-15");
    assert.equal(payload.campaignScheduling.frequency, "WEEKLY");
    assert.match(payload.error, /scan/i, "message mentions scans");
    assert.match(payload.error, /2025-01-15/, "message surfaces the next scan date");
    assert.match(payload.error, /manual/i, "message steers to manual upload");
  });

  step("message degrades gracefully with no schedule fields", () => {
    const payload = buildNoReportDatesPayload({ reportDates: [] });
    assert.equal(payload.code, "no_report_dates_yet");
    assert.equal(payload.campaignScheduling.nextReportDate, null);
    assert.match(payload.error, /manual/i);
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll heatmap fetch no-report-dates tests passed");
}

try {
  main();
} catch (err: any) {
  console.error("Test runner failed:", err?.message ?? err);
  process.exitCode = 1;
}
