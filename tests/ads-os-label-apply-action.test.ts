/* test-registration
{
  "name": "Ads OS monitor-label apply prod action — zero-label targeting only, partial never touched, idempotent re-press, per-account failure isolation, cache invalidation, audit tally (Task #4964)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4964: this action WRITES to client Google Ads accounts. A regression that lets it touch a partially-labeled account modifies a client's intentional campaign scoping; a broken idempotency contract double-fires vendor mutates. Vendor + storage fully stubbed via injected deps and the drain resolve hook — no network, no DB.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/prodActionDrainSetup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4964 — one-press monitor-label apply action contract:
 *
 *   1. MANUAL LEVER + converging (Apply-all must skip it; nothing schedules it).
 *   2. Targets ONLY coverage === "zero" accounts — partial/full/no_active/
 *      unknown never receive a mutate call.
 *   3. Per-account audit tally (perKey) with campaign counts; failures land
 *      as explicit FAILED keys.
 *   4. Per-account failure isolation: one account's mutate error doesn't stop
 *      the others.
 *   5. Combined-dashboard cache invalidated once the last account is done.
 *   6. Idempotent re-press: when re-detection finds no zero accounts, the
 *      press reports not-needed and performs ZERO mutate calls.
 *
 * `recordProdActionRun` is stubbed by the drain resolve hook; Google Ads is
 * stubbed via the action's injected deps.
 */
import assert from "node:assert/strict";
import {
  applyAdsOsMonitorLabelsAction,
  __setAdsOsLabelActionDepsForTest,
  __resetAdsOsLabelActionDepsForTest,
  __resetAdsOsLabelStatusCacheForTest,
} from "../server/services/prodActions/adsOsLabelActions";
import {
  isDrainRunning,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import {
  __getRecordedRuns,
  __resetRecordedRuns,
} from "./helpers/prodActionRunsStub.mjs";
import type { AccountLabelCoverage } from "../server/services/adsOs/labelCoverage";

const ACTION_ID = "apply_ads_os_monitor_labels";

function acct(
  cid: string,
  name: string,
  coverage: AccountLabelCoverage["coverage"],
  active: string[],
  labeled: string[] = [],
): AccountLabelCoverage {
  return {
    customer_id: cid,
    descriptive_name: name,
    coverage,
    activeCampaignIds: active,
    labeledActiveCampaignIds: labeled,
  };
}

async function waitForDrainDone(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (isDrainRunning(ACTION_ID)) {
    if (Date.now() - start > timeoutMs) throw new Error("drain never finished");
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function main() {
  // ── 1. Registry semantics ────────────────────────────────────────────────
  assert.equal(applyAdsOsMonitorLabelsAction.id, ACTION_ID);
  assert.equal(applyAdsOsMonitorLabelsAction.convergence.kind, "converging");
  assert.equal(
    (applyAdsOsMonitorLabelsAction as any).manualLever,
    true,
    "must be a manual lever — Apply-all/schedulers must never fire a client-account write",
  );
  assert.equal((applyAdsOsMonitorLabelsAction as any).selfHeal, undefined);
  assert.equal((applyAdsOsMonitorLabelsAction as any).humanGate, undefined);

  // ── 2–5. Press with a mixed portfolio ───────────────────────────────────
  const ensured: string[] = [];
  const applied: Array<{ cid: string; label: string; campaigns: string[] }> = [];
  let invalidations = 0;
  const portfolio = [
    acct("1085092927", "Geman Law", "zero", ["10", "11", "12"]),
    acct("2222222222", "Weber Law", "partial", ["20", "21", "22"], ["20"]),
    acct("3333333333", "Full Law", "full", ["30"], ["30"]),
    acct("4444444444", "Broken Law", "zero", ["40", "41"]),
    acct("5555555555", "Mystery Law", "unknown", []),
    acct("6666666666", "Idle Law", "no_active", []),
  ];
  __setAdsOsLabelActionDepsForTest({
    classify: async () => portfolio,
    ensureLabel: async (cid) => {
      ensured.push(cid);
      if (cid === "4444444444") throw new Error("label create denied");
      return `customers/${cid}/labels/777`;
    },
    applyLabel: async (cid, label, campaignIds) => {
      applied.push({ cid, label, campaigns: campaignIds });
      return { labelResourceName: label, appliedCampaignIds: campaignIds };
    },
    invalidateDashboardCache: () => {
      invalidations += 1;
    },
  });
  __resetAdsOsLabelStatusCacheForTest();
  __resetRecordedRuns();

  const outcome = await applyAdsOsMonitorLabelsAction.apply("test-actor");
  assert.equal(outcome.state, "applied");
  await waitForDrainDone();

  // Only the two zero accounts were touched; partial/full/unknown/no_active never.
  assert.deepEqual(ensured.sort(), ["1085092927", "4444444444"]);
  assert.equal(applied.length, 1, "failed account isolates — only Geman Law got the apply call");
  assert.deepEqual(applied[0], {
    cid: "1085092927",
    label: "customers/1085092927/labels/777",
    campaigns: ["10", "11", "12"],
  });
  assert.equal(invalidations, 1, "cache invalidated exactly once, at drain completion");

  // Audit: one recorded run, applied, with per-account tally incl. the failure.
  const runs = __getRecordedRuns().filter((r: any) => r.actionId === ACTION_ID);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcomeState, "applied");
  assert.match(runs[0].detail, /Geman Law \(1085092927\): labeled 3 campaign\(s\) \[10, 11, 12\]/);
  assert.match(runs[0].detail, /Broken Law \(4444444444\): FAILED — label create denied/);

  // ── 6. Idempotent re-press: re-detection finds no zero accounts ─────────
  __resetDrainsForTest();
  __setAdsOsLabelActionDepsForTest({
    classify: async () => [
      acct("1085092927", "Geman Law", "full", ["10", "11", "12"], ["10", "11", "12"]),
      acct("2222222222", "Weber Law", "partial", ["20", "21", "22"], ["20"]),
    ],
    ensureLabel: async () => {
      throw new Error("re-press must not mutate anything");
    },
    applyLabel: async () => {
      throw new Error("re-press must not mutate anything");
    },
  });
  __resetAdsOsLabelStatusCacheForTest();
  const second = await applyAdsOsMonitorLabelsAction.apply("test-actor");
  assert.equal(second.state, "not-needed", "repeat press converges to not-needed");

  // Status readout mirrors the same detection (fresh cache → not-needed).
  __resetAdsOsLabelStatusCacheForTest();
  const status = await applyAdsOsMonitorLabelsAction.status();
  assert.equal(status.state, "not-needed");

  __resetAdsOsLabelActionDepsForTest();
  __resetDrainsForTest();
  console.log("ads-os-label-apply-action: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
