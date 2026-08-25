/* test-registration
{
  "name": "Front Analytics coverage completeness status (Task #2087)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2087 — Front Analytics coverage *completeness* status.
 *
 * Phase 2 of the Front backlog epic adds a derived per-month
 * completeness status so the coverage table stops rendering gap months
 * as "final" / done. This test pins the classifier
 * (`deriveCoverageCompleteness`) directly — it is a pure function over
 * the row fields, so no DB / Front HTTP is required.
 *
 * Regression intents:
 *   1. A finalized month with a large ingest gap is NOT "covered" — it
 *      classifies as `ingest-gap` (the masked 2026-04-style case).
 *   2. A month with no measured denominator (never pulled, or a
 *      terminal auth failure, or non-comparable units) classifies as
 *      `not-measured` — never silently shown as covered / 100%.
 *   3. `is_finalized_month` semantics are untouched: a finalized,
 *      fully-covered month is `covered`; a non-finalized / current
 *      month is `in-progress`.
 *   4. A finalized month whose ingest is complete but apply lags is
 *      `apply-gap`; a per-direction inbound/outbound shortfall folds
 *      into `ingest-gap` (messages still missing).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #1837 (per-direction inbound/outbound coverage + plain-English
 *   errors), #1974 (reasonHuman / needsReconnect derivation, removal of
 *   the mixed-direction denominator), #1983 (per-message enumeration),
 *   #1786 / #1643 (coverage denominator + all-time coverage model).
 */
import assert from "node:assert/strict";
import {
  __frontAnalyticsCoverageTestHelpers,
  COVERAGE_MATERIAL_GAP_PCT,
  type DeriveCompletenessInput,
} from "../server/services/frontAnalyticsCoverage";

const { deriveCoverageCompleteness } = __frontAnalyticsCoverageTestHelpers;

// A finalized, measured, fully-covered baseline. Each case below
// overrides only the fields it cares about so the intent stays legible.
function baseline(
  overrides: Partial<DeriveCompletenessInput> = {},
): DeriveCompletenessInput {
  return {
    isCurrentMonth: false,
    isFinalizedMonth: true,
    pulledAt: new Date("2026-04-01T00:00:00Z"),
    frontTotalMessages: 1000,
    ingestGap: 0,
    applyGap: 0,
    unitsComparable: true,
    frontAnalyticsStatus: "done",
    frontAnalyticsError: null,
    needsReconnect: false,
    unrecoverable: false,
    messagesInboundCoveragePct: 100,
    messagesOutboundCoveragePct: 100,
    ...overrides,
  };
}

// ── 1. Large ingest gap → NOT covered (the masked 2026-04 case). ──────
// Front has 21,130 messages; NoBull only ever fetched 1,858 → ~19.3k
// never fetched. Before this task the row read "final"; now it must be
// an explicit ingest gap.
{
  const r = deriveCoverageCompleteness(
    baseline({ frontTotalMessages: 21130, ingestGap: 19272 }),
  );
  assert.equal(
    r.status,
    "ingest-gap",
    `large ingest gap must classify as ingest-gap, got ${r.status}`,
  );
  assert.notEqual(r.status, "covered", "a 19k-message gap is never covered");
  assert.ok(r.reason.length > 0, "ingest-gap carries a plain-English reason");
}

// ── 2. No measured denominator → not-measured (never 100%/covered). ──
// 2a — never pulled.
{
  const r = deriveCoverageCompleteness(baseline({ pulledAt: null }));
  assert.equal(r.status, "not-measured", "never-pulled month is not-measured");
}
// 2b — terminal auth failure needing reconnect.
{
  const r = deriveCoverageCompleteness(
    baseline({
      frontAnalyticsStatus: "error",
      frontAnalyticsError: "front_auth_expired: token revoked",
      needsReconnect: true,
    }),
  );
  assert.equal(
    r.status,
    "not-measured",
    "auth-failed month is not-measured, not covered",
  );
}
// 2c — permanent / unrecoverable failure.
{
  const r = deriveCoverageCompleteness(
    baseline({
      frontAnalyticsStatus: "error",
      frontAnalyticsError: "front_analytics_report_failed: gone",
      unrecoverable: true,
    }),
  );
  assert.equal(r.status, "not-measured", "unrecoverable month is not-measured");
}
// 2d — units not comparable (denominator can't be trusted).
{
  const r = deriveCoverageCompleteness(baseline({ unitsComparable: false }));
  assert.equal(
    r.status,
    "not-measured",
    "non-comparable units must not be reported as covered",
  );
}

// ── 3. is_finalized_month semantics intact. ──────────────────────────
// 3a — finalized + fully covered → covered.
{
  const r = deriveCoverageCompleteness(baseline());
  assert.equal(r.status, "covered", "finalized + no gap is covered");
}
// 3b — current month → in-progress (even with zero gaps).
{
  const r = deriveCoverageCompleteness(
    baseline({ isCurrentMonth: true, isFinalizedMonth: false }),
  );
  assert.equal(r.status, "in-progress", "current month is in-progress");
}
// 3c — non-finalized historical month → in-progress.
{
  const r = deriveCoverageCompleteness(baseline({ isFinalizedMonth: false }));
  assert.equal(
    r.status,
    "in-progress",
    "non-finalized denominator is in-progress, not covered",
  );
}
// 3d — pending pull → in-progress.
{
  const r = deriveCoverageCompleteness(
    baseline({ frontAnalyticsStatus: "pending" }),
  );
  assert.equal(r.status, "in-progress", "pending pull is in-progress");
}

// ── 4. apply-gap and per-direction shortfall. ────────────────────────
// 4a — ingest complete, apply lags materially → apply-gap.
{
  const r = deriveCoverageCompleteness(
    baseline({ frontTotalMessages: 1000, ingestGap: 0, applyGap: 200 }),
  );
  assert.equal(r.status, "apply-gap", "fetched-but-not-applied is apply-gap");
}
// 4b — ingest gap takes precedence over apply gap.
{
  const r = deriveCoverageCompleteness(
    baseline({ frontTotalMessages: 1000, ingestGap: 300, applyGap: 200 }),
  );
  assert.equal(
    r.status,
    "ingest-gap",
    "ingest gap outranks apply gap when both are material",
  );
}
// 4c — per-direction inbound shortfall folds into ingest-gap.
{
  const r = deriveCoverageCompleteness(
    baseline({ messagesInboundCoveragePct: 40, messagesOutboundCoveragePct: 100 }),
  );
  assert.equal(
    r.status,
    "ingest-gap",
    "an inbound per-direction shortfall means messages are still missing",
  );
}
// 4d — immaterial gap below threshold stays covered.
{
  const tiny = Math.max(0, Math.floor((COVERAGE_MATERIAL_GAP_PCT - 1) * 10)); // < material % of 1000
  const r = deriveCoverageCompleteness(
    baseline({ frontTotalMessages: 1000, ingestGap: tiny }),
  );
  assert.equal(
    r.status,
    "covered",
    "a sub-threshold ingest gap is still covered",
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("front-analytics-coverage-completeness: all assertions passed");

// Importing the service module pulls in `server/db`, whose pool
// keepalives keep the event loop busy; force a clean exit so the harness
// can move on to the next test file.
