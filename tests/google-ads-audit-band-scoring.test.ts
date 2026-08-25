/* test-registration
{
  "name": "Google Ads Hygiene Audit — bandFor() ascending/descending scoring (Task #2784)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2784: the Google Ads Hygiene Audit's `bandFor()` scoring resolver must handle BOTH ascending (\"lower is better\") and descending (\"higher is better\") band configs; a fixed-ascending assumption silently mis-scores every descending check (quality score, budget utilization, optimization score) as critical/0. Gate this fast, DB-free unit test so a future band-ordering regression fails fast instead of corrupting every audit's H/H_final scores and ranking.",
  "tier": "small"
}
test-registration */
// Task #2784: guards the Google Ads Hygiene Audit's continuous-metric scoring
// bands. Checks are configured two ways depending on which direction is
// "better" — ascending `min` for "lower is better" metrics, descending `min`
// for "higher is better" metrics (see server/config/googleAdsAuditChecks.ts).
// bandFor() must resolve BOTH orderings correctly; a fixed-ascending
// assumption silently mis-scores every descending config as critical/0.
import { bandFor } from "../server/services/googleAdsAuditEngine";
import { AUDIT_CHECKS as GOOGLE_ADS_AUDIT_CHECKS } from "../server/config/googleAdsAuditChecks";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
}

// Ascending ("lower is better") — e.g. search_term_irrelevance_spend.
const ascendingBands = [
  { min: 0, status: "good" as const, score: 100 },
  { min: 0.05, status: "okay" as const, score: 70 },
  { min: 0.15, status: "bad" as const, score: 35 },
  { min: 0.3, status: "critical" as const, score: 0 },
];
assert(bandFor(0, ascendingBands).status === "good", "ascending: value=0 -> good");
assert(bandFor(0.02, ascendingBands).status === "good", "ascending: value=0.02 -> good");
assert(bandFor(0.1, ascendingBands).status === "okay", "ascending: value=0.1 -> okay");
assert(bandFor(0.2, ascendingBands).status === "bad", "ascending: value=0.2 -> bad");
assert(bandFor(0.5, ascendingBands).status === "critical", "ascending: value=0.5 -> critical");

// Descending ("higher is better") — e.g. quality_score_health (1-10 scale).
const descendingBands = [
  { min: 7, status: "good" as const, score: 100 },
  { min: 5, status: "okay" as const, score: 70 },
  { min: 3, status: "bad" as const, score: 35 },
  { min: 0, status: "critical" as const, score: 0 },
];
assert(bandFor(9, descendingBands).status === "good", "descending: value=9 -> good");
assert(bandFor(7, descendingBands).status === "good", "descending: value=7 (boundary) -> good");
assert(bandFor(6, descendingBands).status === "okay", "descending: value=6 -> okay");
assert(bandFor(4, descendingBands).status === "bad", "descending: value=4 -> bad");
assert(bandFor(1, descendingBands).status === "critical", "descending: value=1 -> critical");
assert(bandFor(0, descendingBands).status === "critical", "descending: value=0 -> critical");

// Descending — budget_utilization (fraction 0-1, higher is better).
const budgetUtilBands = [
  { min: 0.85, status: "good" as const, score: 100 },
  { min: 0.6, status: "okay" as const, score: 70 },
  { min: 0.3, status: "bad" as const, score: 35 },
  { min: 0, status: "critical" as const, score: 0 },
];
assert(bandFor(0.95, budgetUtilBands).status === "good", "budget: 0.95 -> good");
assert(bandFor(0.7, budgetUtilBands).status === "okay", "budget: 0.7 -> okay");
assert(bandFor(0.4, budgetUtilBands).status === "bad", "budget: 0.4 -> bad");
assert(bandFor(0.1, budgetUtilBands).status === "critical", "budget: 0.1 -> critical");

// Config-level guard: every registered continuous check's own bands must
// resolve a "clearly good" and a "clearly critical" input to the expected
// status under bandFor, whichever direction they're configured in. This
// prevents a future edit to googleAdsAuditChecks.ts from silently
// reintroducing a broken ordering for any specific check.
let continuousChecked = 0;
for (const check of GOOGLE_ADS_AUDIT_CHECKS) {
  const bands = (check as any).bands as
    | { min: number; status: "good" | "okay" | "bad" | "critical"; score: number }[]
    | undefined;
  if (!bands || bands.length === 0) continue;
  continuousChecked++;
  const mins = bands.map((b) => b.min);
  const ascending = bands[0].min <= bands[bands.length - 1].min;
  const bestBand = ascending ? bands[0] : bands[0];
  const worstBand = bands[bands.length - 1];
  assert(
    bestBand.status === "good",
    `${check.id}: first configured band must be "good" (found "${bestBand.status}")`,
  );
  assert(
    worstBand.status === "critical",
    `${check.id}: last configured band must be "critical" (found "${worstBand.status}")`,
  );
  const bestProbe = ascending ? Math.min(...mins) : Math.max(...mins) + 1000;
  const worstProbe = ascending ? Math.max(...mins) + 1000 : Math.min(...mins) - 1000;
  assert(
    bandFor(bestProbe, bands).status === "good",
    `${check.id}: an extreme "best" value must resolve to "good"`,
  );
  assert(
    bandFor(worstProbe, bands).status === "critical",
    `${check.id}: an extreme "worst" value must resolve to "critical"`,
  );
}
assert(continuousChecked > 0, "expected at least one continuous (banded) check to be configured");

console.log(
  `google-ads-audit-band-scoring: all assertions passed (${continuousChecked} continuous checks validated)`,
);
