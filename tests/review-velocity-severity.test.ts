/* test-registration
{
  "name": "Review velocity goal band classification (Task #2579)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2579: the review-velocity goal band drives client-facing green/yellow/ red coloring; its critical invariant is \"no target → neutral, never silent green/red\". Gate this fast, DB-free unit test so band-threshold or no-target-degradation drift fails fast.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  getReviewVelocityBand,
  getReviewVelocityBandLabel,
  resolveReviewMonthlyTarget,
  REVIEW_VELOCITY_BEHIND_RATIO,
} from "../shared/reviewVelocitySeverity";

/**
 * Task #2579 — review velocity goal band classification.
 *
 * The client-facing Review Generation panel colors the 90-day trailing-average
 * velocity headline (and draws a target reference line) from these bands. The
 * critical invariant is the "no target → neutral, never silent green/red" rule
 * so a client never sees a judgement the firm never set.
 */
async function run() {
  // === No target → neutral `none` (the core "no silent green" guarantee) ===
  assert.equal(getReviewVelocityBand(0, undefined), "none", "undefined target = none");
  assert.equal(getReviewVelocityBand(0, null), "none", "null target = none");
  assert.equal(getReviewVelocityBand(50, 0), "none", "zero target = none, even with strong velocity");
  assert.equal(getReviewVelocityBand(50, -5), "none", "negative target = none");
  assert.equal(getReviewVelocityBand(50, NaN), "none", "non-finite target = none");

  // === At / above target → on_track (green) ===
  assert.equal(getReviewVelocityBand(20, 20), "on_track", "exactly at target = on_track");
  assert.equal(getReviewVelocityBand(25, 20), "on_track", "above target = on_track");
  assert.equal(getReviewVelocityBand(20.0001, 20), "on_track", "just above target = on_track");

  // === Behind band: [target * BEHIND_RATIO, target) → behind (yellow) ===
  const target = 20;
  const behindFloor = target * REVIEW_VELOCITY_BEHIND_RATIO; // 14
  assert.equal(getReviewVelocityBand(behindFloor, target), "behind", "exactly at behind floor = behind");
  assert.equal(getReviewVelocityBand(target - 0.5, target), "behind", "just below target = behind");
  assert.equal(getReviewVelocityBand(15, target), "behind", "mid-behind-band = behind");

  // === Off track: below target * BEHIND_RATIO → off_track (red) ===
  assert.equal(getReviewVelocityBand(behindFloor - 0.5, target), "off_track", "just below behind floor = off_track");
  assert.equal(getReviewVelocityBand(0, target), "off_track", "zero velocity with a target = off_track");

  // === Negative / non-finite velocity is clamped to 0 (still off_track vs a target) ===
  assert.equal(getReviewVelocityBand(-10, target), "off_track", "negative velocity clamps to 0 = off_track");
  assert.equal(getReviewVelocityBand(NaN, target), "off_track", "NaN velocity clamps to 0 = off_track");

  // === Target resolution precedence (Task #2596) ===
  // Per-report target present → it wins, even when a client default also exists.
  assert.equal(
    resolveReviewMonthlyTarget(30, 10),
    30,
    "per-report target wins over client default",
  );
  assert.equal(
    resolveReviewMonthlyTarget(30, undefined),
    30,
    "per-report target used when no client default",
  );
  // Per-report absent (or <= 0) + client target set → fall back to client default.
  assert.equal(
    resolveReviewMonthlyTarget(undefined, 12),
    12,
    "client default used when per-report absent",
  );
  assert.equal(
    resolveReviewMonthlyTarget(null, 12),
    12,
    "client default used when per-report null",
  );
  assert.equal(
    resolveReviewMonthlyTarget(0, 12),
    12,
    "stored per-report 0 does not win — falls back to client default",
  );
  assert.equal(
    resolveReviewMonthlyTarget(-5, 12),
    12,
    "negative per-report target falls back to client default",
  );
  // Both absent / <= 0 → no target (null → neutral band).
  assert.equal(
    resolveReviewMonthlyTarget(undefined, undefined),
    null,
    "both absent = no target",
  );
  assert.equal(
    resolveReviewMonthlyTarget(0, 0),
    null,
    "both zero = no target",
  );
  assert.equal(
    resolveReviewMonthlyTarget(null, -3),
    null,
    "null per-report + negative client = no target",
  );
  assert.equal(
    resolveReviewMonthlyTarget(NaN, NaN),
    null,
    "non-finite at both levels = no target",
  );
  // The resolved target feeds the band classifier — end-to-end the client
  // default drives the band when no per-report target is set.
  assert.equal(
    getReviewVelocityBand(8, resolveReviewMonthlyTarget(undefined, 10)),
    "behind",
    "client-default target drives the band when per-report absent",
  );
  assert.equal(
    getReviewVelocityBand(50, resolveReviewMonthlyTarget(undefined, undefined)),
    "none",
    "no target at either level → neutral band even with strong velocity",
  );

  // === Labels are stable, client-facing, and distinct per band ===
  assert.equal(getReviewVelocityBandLabel("on_track"), "On track");
  assert.equal(getReviewVelocityBandLabel("behind"), "Behind pace");
  assert.equal(getReviewVelocityBandLabel("off_track"), "Off track");
  assert.equal(getReviewVelocityBandLabel("none"), "No target set");

  console.log("review-velocity-severity: all cases passed");
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
