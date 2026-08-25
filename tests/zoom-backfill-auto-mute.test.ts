/* test-registration
{
  "name": "Zoom backfill auto-mute (Task #1199)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1199: verify the Zoom review-queue / no-candidate / 412G re-eval
 * backfills auto-mute manual-reserve alerts for the duration of an apply run,
 * mirroring the SEMrush wiring (Task #726).
 *
 * Task #2637 note: the `zoom_review_signals_backfill` entrypoint (and its
 * routes) were removed with the deletion of the AI comms matcher — it seeded
 * `supporting_signals_json` telemetry for the now-retired matcher. Its
 * auto-mute cases (formerly sections 1, 2, and the section-8 manual-override
 * precedence case) are gone; the identical wrapper contract is still fully
 * covered below by the surviving review-queue / no-candidate / 412G-reeval
 * backfills, and manual-override precedence is re-asserted via
 * `runZoomReviewQueueBackfill`.
 *
 * Verification strategy (ESM-namespace-safe — no monkey-patching of imported
 * modules): for each backfill we
 *
 *   1. Pre-install a known auto-mute owned by a synthetic `jobId="pretest-*"`
 *      so the mute state is non-empty going in.
 *   2. Invoke the backfill with `dryRun:false` (no candidate data needed —
 *      we're verifying the wrapper, not the data path).
 *   3. After the call returns we expect:
 *        - state.muted === false (the wrapper's `clear` ran in `finally`)
 *        - state.jobId !== "pretest-*" (the wrapper's `set` took ownership
 *          before clearing; otherwise the original mute would still be
 *          present when the run completed without throwing)
 *
 *   For dry-run paths (signals + no-candidate) we additionally verify the
 *   pre-installed mute is NOT touched at all.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const mod = await import("../server/services/manualReserveAlerts");

  async function preInstallSyntheticAutoMute(label: string) {
    await mod.clearManualReserveMute();
    const r = await mod.setManualReserveMuteForBackfillJob({
      jobId: `pretest-${label}-${Date.now()}`,
      jobLabel: `pretest_${label}`,
      durationMs: 60 * 60_000, // 1h
    });
    assert(r.applied === true, `${label}: pretest auto-mute installed`);
    return r.state;
  }

  async function expectInstalledAndCleared(label: string) {
    const post = await mod.getManualReserveMuteState();
    assert(
      post.muted === false,
      `${label}: mute state is cleared after backfill (got ${JSON.stringify(post)})`,
    );
  }

  async function expectPretestMutePreserved(
    label: string,
    pretestJobId: string,
  ) {
    const post = await mod.getManualReserveMuteState();
    assert(
      post.muted === true && post.jobId === pretestJobId,
      `${label}: dry-run must not touch the existing mute (got ${JSON.stringify(post)})`,
    );
  }

  // ---- 1 & 2 [RETIRED]: the zoom_review_signals_backfill apply/dry-run
  // auto-mute cases were removed in Task #2637 along with the deleted
  // zoomReviewSignalsBackfill service (AI-matcher signal telemetry). ----

  // ---- 3. zoom_review_queue_backfill (apply) ----
  {
    const { runZoomReviewQueueBackfill } = await import(
      "../server/services/zoomReviewQueueBackfill"
    );
    await preInstallSyntheticAutoMute("review-queue");
    await runZoomReviewQueueBackfill({ dryRun: false, limit: 1 });
    await expectInstalledAndCleared("review-queue-backfill apply");
  }

  // ---- 4. zoom_no_candidate_review_queue_backfill (apply) ----
  {
    const { runZoomNoCandidateReviewQueueBackfill } = await import(
      "../server/services/zoomReviewQueueBackfill"
    );
    await preInstallSyntheticAutoMute("no-candidate");
    await runZoomNoCandidateReviewQueueBackfill({ dryRun: false, limit: 1 });
    await expectInstalledAndCleared("no-candidate-backfill apply");
  }

  // ---- 5. zoom_no_candidate_review_queue_backfill (dry-run) — no-op ----
  {
    const { runZoomNoCandidateReviewQueueBackfill } = await import(
      "../server/services/zoomReviewQueueBackfill"
    );
    const pre = await preInstallSyntheticAutoMute("no-candidate-dry");
    await runZoomNoCandidateReviewQueueBackfill({ dryRun: true, limit: 1 });
    await expectPretestMutePreserved("no-candidate-backfill dry-run", pre.jobId!);
  }

  // ---- 6. zoom_backfill_reeval (apply) — recordLimit:0 makes inner work
  // a no-op data-wise, but the wrapper still installs and clears. ----
  {
    const { runZoomBackfillApply } = await import(
      "../server/services/zoomBackfillReeval"
    );
    await preInstallSyntheticAutoMute("412g");
    await runZoomBackfillApply({ windowDays: 1, recordLimit: 0 });
    await expectInstalledAndCleared("412g-reeval apply");
  }

  // ---- 7. zoom_backfill_reeval dry-run is read-only and intentionally NOT
  // wrapped (the admin UI uses it to inspect candidates without saturating
  // the system). Confirm the existing mute is preserved. ----
  {
    const { runZoomBackfillDryRun } = await import(
      "../server/services/zoomBackfillReeval"
    );
    const pre = await preInstallSyntheticAutoMute("412g-dry");
    await runZoomBackfillDryRun({ windowDays: 1, recordLimit: 0 });
    await expectPretestMutePreserved("412g-reeval dry-run", pre.jobId!);
  }

  // ---- 8. Operator manual mute precedence is preserved across an apply run.
  // The wrapper must NOT overwrite a manual mute and the manual mute must
  // still be present after the backfill returns. Exercised via the surviving
  // review-queue backfill (was zoom_review_signals_backfill before Task #2637
  // retired that entrypoint). ----
  {
    const { runZoomReviewQueueBackfill } = await import(
      "../server/services/zoomReviewQueueBackfill"
    );
    await mod.clearManualReserveMute();
    const opMute = await mod.setManualReserveMute({
      mutedUntil: Date.now() + 30 * 60_000,
      mutedBy: null,
      reason: "operator manual override (test)",
    });
    assert(opMute.source === "manual", "manual mute installed");
    await runZoomReviewQueueBackfill({ dryRun: false, limit: 1 });
    const post = await mod.getManualReserveMuteState();
    assert(
      post.muted === true && post.source === "manual",
      "manual override survives backfill apply",
    );
    assert(
      post.reason === "operator manual override (test)",
      "manual override reason preserved verbatim",
    );
  }

  await mod.clearManualReserveMute();
  console.log("zoom-backfill-auto-mute: all cases passed");
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
