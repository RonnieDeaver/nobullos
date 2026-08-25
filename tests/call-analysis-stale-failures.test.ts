/* test-registration
{
  "name": "Call-analysis stale-failure partition (Task #4466)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure in-memory partition logic, no DB or DOM; runs in well under a second and is fully deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #4466: months-old failed call-analysis jobs must not bury fresh
 * results. Unit tests for the pure partition helper the Call Answer Time
 * Analyzer uses to collapse stale failures:
 *   (a) failed jobs older than STALE_FAILURE_DAYS go to the stale group,
 *   (b) recent failures stay fresh (still actionable, critical pill),
 *   (c) a failure superseded by a LATER successful run for the same
 *       external_id is stale even if recent,
 *   (d) a complete run OLDER than the failure does not supersede it,
 *   (e) non-failed jobs are never collapsed and order is preserved,
 *   (f) failures with missing/unparseable created_at stay visible.
 *
 * Times are derived from a fixed `now` passed to the helper — no
 * wall-clock-relative literals that detonate later.
 */
import assert from "node:assert/strict";
import {
  partitionStaleFailures,
  STALE_FAILURE_DAYS,
} from "../client/src/lib/callAnalysisStaleFailures";

const NOW = new Date("2026-08-11T12:00:00Z");
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

type J = {
  analysis_id: string;
  external_id: string;
  status: string;
  created_at: string | null;
};
const job = (
  analysis_id: string,
  external_id: string,
  status: string,
  created_at: string | null,
): J => ({ analysis_id, external_id, status, created_at });

// (a)+(b): age split around the cutoff.
{
  const jobs = [
    job("a1", "x1", "failed", daysAgo(1)),
    job("a2", "x2", "failed", daysAgo(STALE_FAILURE_DAYS + 30)),
    job("a3", "x3", "failed", daysAgo(STALE_FAILURE_DAYS - 1)),
  ];
  const { fresh, staleFailures } = partitionStaleFailures(jobs, NOW);
  assert.deepEqual(fresh.map((j) => j.analysis_id), ["a1", "a3"]);
  assert.deepEqual(staleFailures.map((j) => j.analysis_id), ["a2"]);
}

// (c): recent failure superseded by a later complete run for the same
// external_id is stale.
{
  const jobs = [
    job("c1", "same", "complete", daysAgo(1)),
    job("c2", "same", "failed", daysAgo(2)),
    job("c3", "other", "failed", daysAgo(2)),
  ];
  const { fresh, staleFailures } = partitionStaleFailures(jobs, NOW);
  assert.deepEqual(staleFailures.map((j) => j.analysis_id), ["c2"]);
  assert.deepEqual(fresh.map((j) => j.analysis_id), ["c1", "c3"]);
}

// (d): a complete run OLDER than the failure does not supersede it.
{
  const jobs = [
    job("d1", "same", "failed", daysAgo(1)),
    job("d2", "same", "complete", daysAgo(3)),
  ];
  const { fresh, staleFailures } = partitionStaleFailures(jobs, NOW);
  assert.equal(staleFailures.length, 0);
  assert.deepEqual(fresh.map((j) => j.analysis_id), ["d1", "d2"]);
}

// (e): non-failed statuses never collapse, even when ancient; relative
// order within each group is preserved.
{
  const jobs = [
    job("e1", "x1", "complete", daysAgo(200)),
    job("e2", "x2", "failed", daysAgo(200)),
    job("e3", "x3", "queued", daysAgo(200)),
    job("e4", "x4", "failed", daysAgo(150)),
    job("e5", "x5", "processing", null),
  ];
  const { fresh, staleFailures } = partitionStaleFailures(jobs, NOW);
  assert.deepEqual(fresh.map((j) => j.analysis_id), ["e1", "e3", "e5"]);
  assert.deepEqual(staleFailures.map((j) => j.analysis_id), ["e2", "e4"]);
}

// (f): failures with missing or unparseable created_at stay visible —
// never hide a failure we cannot prove is old.
{
  const jobs = [
    job("f1", "x1", "failed", null),
    job("f2", "x2", "failed", "not-a-date"),
  ];
  const { fresh, staleFailures } = partitionStaleFailures(jobs, NOW);
  assert.equal(staleFailures.length, 0);
  assert.deepEqual(fresh.map((j) => j.analysis_id), ["f1", "f2"]);
}

console.log("call-analysis-stale-failures: all assertions passed");
