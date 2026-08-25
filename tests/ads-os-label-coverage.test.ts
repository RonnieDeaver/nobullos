/* test-registration
{
  "name": "Ads OS monitor-label coverage classifier — full/partial/zero/no_active/unknown grading, error never classified as zero, per-account isolation (Task #4964)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4964: this classifier is the single source for the label-apply prod action's target set, the drift-guard alert, and the dashboard 'setup needed' state. A regression that grades a partially-labeled account as zero would make the action WRITE labels into an intentionally-scoped client Google Ads account. Pure injected deps, no network, no DB, fast.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4964 — label-coverage classification contract.
 *
 * Rules pinned here:
 *   • zero      = active non-LSA campaigns > 0 AND none labeled.
 *   • partial   = some but not all labeled (INTENTIONAL scoping — the action
 *                 and drift guard must never treat it as broken).
 *   • full      = all active labeled.
 *   • no_active = no active non-LSA campaigns.
 *   • unknown   = the Ads API errored — NEVER graded zero on error.
 *   • Portfolio classification isolates per-account failures as unknown rows.
 *
 * Google Ads fully stubbed via injected deps — no vendor calls.
 */
import assert from "node:assert/strict";
import {
  activeNonLsaCampaignIds,
  classifyAccountLabelCoverage,
  classifyEnrolledLabelCoverage,
  type LabelCoverageDeps,
} from "../server/services/adsOs/labelCoverage";

// gaql stub: per-cid active campaign rows (labelCoverage only issues the
// active-campaign query through gaqlSearch).
function gaqlStub(activeByCid: Record<string, string[] | Error>): LabelCoverageDeps["gaqlSearch"] {
  return async (cid: string) => {
    const v = activeByCid[cid];
    if (v instanceof Error) throw v;
    return (v ?? []).map((id) => ({ campaign: { id } }));
  };
}

async function main() {
  // ── activeNonLsaCampaignIds normalizes + stringifies ────────────────────
  {
    const ids = await activeNonLsaCampaignIds("108-509-2927", async (cid, query) => {
      assert.equal(cid, "1085092927", "CID must be digit-normalized");
      assert.match(query, /campaign\.status = 'ENABLED'/);
      assert.match(query, /advertising_channel_type != 'LOCAL_SERVICES'/);
      return [{ campaign: { id: 111 } }, { campaign: { id: "222" } }];
    });
    assert.deepEqual(ids, ["111", "222"]);
  }

  // ── per-account grading ──────────────────────────────────────────────────
  const grade = (active: string[] | Error, labeled: string[] | Error) =>
    classifyAccountLabelCoverage("1085092927", "Geman Law", {
      deps: {
        gaqlSearch: gaqlStub({ "1085092927": active }),
        labeledIds: async () => {
          if (labeled instanceof Error) throw labeled;
          return labeled;
        },
      },
    });

  assert.equal((await grade(["1", "2"], [])).coverage, "zero", "active + none labeled = zero");
  assert.equal((await grade(["1", "2", "3"], ["2"])).coverage, "partial", "some labeled = partial");
  assert.equal((await grade(["1", "2"], ["1", "2"])).coverage, "full", "all labeled = full");
  assert.equal((await grade([], [])).coverage, "no_active", "no active campaigns = no_active");
  // labeled ids outside the active set (paused labeled campaigns) don't count
  assert.equal((await grade(["1", "2"], ["9"])).coverage, "zero", "labels on inactive campaigns don't rescue zero");

  // errors are UNKNOWN, never zero
  const errActive = await grade(new Error("GAQL boom"), []);
  assert.equal(errActive.coverage, "unknown");
  assert.match(errActive.error ?? "", /GAQL boom/);
  const errLabeled = await grade(["1"], new Error("label lookup boom"));
  assert.equal(errLabeled.coverage, "unknown", "labeled-id fetch failure must not grade zero");

  // knownLabeledIds short-circuits the labeled fetch
  {
    const acct = await classifyAccountLabelCoverage("1085092927", "Geman Law", {
      knownLabeledIds: ["1"],
      deps: {
        gaqlSearch: gaqlStub({ "1085092927": ["1", "2"] }),
        labeledIds: async () => {
          throw new Error("must not be called when knownLabeledIds provided");
        },
      },
    });
    assert.equal(acct.coverage, "partial");
    assert.deepEqual(acct.labeledActiveCampaignIds, ["1"]);
  }

  // ── portfolio classification isolates per-account failures ──────────────
  {
    const rows = await classifyEnrolledLabelCoverage({
      listEnrolled: async () => [
        { cid: "1085092927", name: "Geman Law", currency: "USD" },
        { cid: "2222222222", name: "Weber Law", currency: "USD" },
        { cid: "3333333333", name: "Broken Acct", currency: "USD" },
      ],
      gaqlSearch: gaqlStub({
        "1085092927": ["10", "11"],
        "2222222222": ["20", "21", "22"],
        "3333333333": new Error("permission denied"),
      }),
      labeledIds: async (cid) => (cid === "2222222222" ? ["20"] : []),
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].coverage, "zero");
    assert.equal(rows[0].customer_id, "1085092927");
    assert.equal(rows[1].coverage, "partial", "partial account stays partial in the portfolio");
    assert.equal(rows[2].coverage, "unknown", "one broken account isolates, does not poison the sweep");
  }

  console.log("ads-os-label-coverage: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
