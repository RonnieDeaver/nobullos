/* test-registration
{
  "name": "Ads OS KI snapshot refresh prod action — forced mixed-account drain, ineligible isolation, audit tally, nothing-to-do (Task #4973)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4973: a label-less enrolled account returns a normal ineligible KI report, but must not falsely count as a refreshed snapshot or abort the rest of the manual drain. Injected account/analyzer deps and the drain audit loader keep this DB-free, network-free, and fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/prodActionDrainSetup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "medium",
  "tierReason": "Covers a multi-account production-action drain through its setup import and injected dependencies."
}
test-registration */
/**
 * The refresh lever invokes the real analyzer only through its injectable
 * dependency. This verifies the drain contract without Google Ads, OpenAI, or
 * prod_action_runs storage: each account is attempted with force=true; a
 * returned ineligible report and a thrown analyzer error are recorded as
 * per-account failures, while an eligible account still completes.
 */
import assert from "node:assert/strict";
import {
  __resetAdsOsKiRefreshActionDepsForTest,
  __setAdsOsKiRefreshActionDepsForTest,
  refreshKiTrafficQualitySnapshotsAction,
} from "../server/services/prodActions/adsOsKiRefreshActions";
import {
  getDrainState,
  __resetDrainsForTest,
  isDrainRunning,
} from "../server/services/prodActionBackgroundDrain";
import {
  __getRecordedRuns,
  __resetRecordedRuns,
} from "./helpers/prodActionRunsStub.mjs";
import type { EnrolledAccount } from "../server/services/adsOs/enrollment";
import type { KeywordIntelReport } from "../server/services/adsOs/keywordIntel/models";

const ACTION_ID = "refresh_ki_traffic_quality_snapshots";

const accounts: EnrolledAccount[] = [
  { cid: "1010101010", name: "Eligible Law", currency: "USD" },
  { cid: "2020202020", name: "No Label Law", currency: "USD" },
  { cid: "3030303030", name: "Unavailable Law", currency: "USD" },
];

function keywordIntelReport(
  cid: string,
  eligible: boolean,
  scopeNote: string,
): KeywordIntelReport {
  return {
    customer_id: cid,
    account_name: accounts.find((account) => account.cid === cid)?.name ?? cid,
    currency_code: "USD",
    generated_at: "2026-08-24T12:00:00.000Z",
    lookback_days: 30,
    candidate_count: 0,
    reviewed_cost: 0,
    waste_terms: 0,
    wasted_spend: 0,
    suggestions: [],
    keyword_spend: 0,
    traffic_quality: eligible ? 100 : null,
    coverage: null,
    eligible,
    monitored_campaigns: eligible ? 1 : 0,
    scope_note: scopeNote,
    has_criteria: false,
    warnings: [],
    from_cache: false,
  };
}

async function waitForDrainDone(timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (isDrainRunning(ACTION_ID)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("KI refresh drain never finished");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function main(): Promise<void> {
  const refreshCalls: Array<{ cid: string; force: boolean }> = [];
  __resetRecordedRuns();
  __setAdsOsKiRefreshActionDepsForTest({
    listAccounts: async () => accounts,
    refreshAccount: async (cid, force) => {
      refreshCalls.push({ cid, force });
      if (cid === "2020202020") {
        return {
          report: keywordIntelReport(
            cid,
            false,
            "No campaigns carry the 'KI_CAMPAIGN_LABEL' label in this account.",
          ),
          fromCache: false,
        };
      }
      if (cid === "3030303030") throw new Error("Google Ads request timed out");
      return {
        report: keywordIntelReport(cid, true, "Reviewing 1 labeled campaign."),
        fromCache: false,
      };
    },
  });

  try {
    const outcome = await refreshKiTrafficQualitySnapshotsAction.apply("test-actor");
    assert.equal(outcome.state, "applied", "the mixed-account press starts a drain");
    await waitForDrainDone();

    assert.deepEqual(
      refreshCalls,
      [
        { cid: "1010101010", force: true },
        { cid: "2020202020", force: true },
        { cid: "3030303030", force: true },
      ],
      "every enrolled account is counted and attempted with force=true",
    );

    const drain = getDrainState(ACTION_ID);
    assert.ok(drain, "the completed drain state remains available for progress reads");
    assert.equal(drain.totalAtStart, 3);
    assert.equal(drain.processed, 3);
    assert.equal(drain.perKey["Eligible Law (1010101010)"], 1);
    assert.equal(drain.perKey["No Label Law (2020202020) — FAILED"], 1);
    assert.equal(drain.perKey["Unavailable Law (3030303030) — FAILED"], 1);

    const runs = __getRecordedRuns().filter((run: any) => run.actionId === ACTION_ID);
    assert.equal(runs.length, 1, "the completed drain writes one audit entry");
    assert.equal(runs[0].outcomeState, "applied");
    assert.equal(runs[0].rowsAffected, 3, "failed accounts still count as processed");
    assert.match(runs[0].detail, /Re-ran Search Term Analyzer for 1 of 3 enrolled account/);
    assert.match(runs[0].detail, /No Label Law \(2020202020\) — No campaigns carry/);
    assert.match(runs[0].detail, /Unavailable Law \(3030303030\) — Google Ads request timed out/);
    assert.match(runs[0].detail, /Refreshed: Eligible Law \(1010101010\)/);

    __resetDrainsForTest();
    __setAdsOsKiRefreshActionDepsForTest({
      listAccounts: async () => [],
      refreshAccount: async () => {
        throw new Error("nothing-to-do must not invoke the analyzer");
      },
    });
    const nothingToDo = await refreshKiTrafficQualitySnapshotsAction.apply("test-actor");
    assert.equal(nothingToDo.state, "not-needed");
    assert.match(nothingToDo.detail, /No enrolled Google Ads accounts/);

    console.log("ads-os-ki-refresh-action: all assertions passed");
  } finally {
    __resetAdsOsKiRefreshActionDepsForTest();
    __resetDrainsForTest();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
