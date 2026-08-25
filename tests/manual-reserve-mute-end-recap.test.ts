/* test-registration
{
  "name": "Manual reserve mute-end Slack recap (Task #1195)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1195 — Slack recap when a manual-reserve mute window ends.
 *
 * Covers:
 *   1. Natural expiry (pollManualReserveMuteEnd) posts a single recap that
 *      aggregates the "muted" dispatch rows in the window and clears the row.
 *   2. Manual operator clear path (notifyManualReserveMuteWindowEnded with
 *      reason="cleared_manual") posts the same recap.
 *   3. Backfill auto-clear path (clearManualReserveMuteForBackfillJob)
 *      triggers the recap when an auto-mute is released.
 *   4. Zero suppressed alerts → no Slack post.
 *   5. Idempotency — calling the notifier twice for the same mute window
 *      only posts once.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const mod = await import("../server/services/manualReserveAlerts");

  type DispatchedCall = {
    id: string;
    text: string;
    metadata: any;
  };
  let dispatched: DispatchedCall[] = [];
  mod.__test_setMuteEndDispatcherOverride(async (id, payload, opts) => {
    dispatched.push({ id, text: payload.text, metadata: opts.metadata });
    return { delivered: true, status: "delivered", channelId: "C-TEST" };
  });

  // Drive the dispatch listing from an in-memory list that the override
  // returns. We don't touch the DB at all.
  type Row = {
    id: number;
    timestamp: number;
    eventType: string;
    metric: string;
    severity: string;
    message: string;
    value: number;
    threshold: number;
    status: string;
    detail: string | null;
    mutedBy: string | null;
    muteReason: string | null;
    triggeredBy: string | null;
    triggerSource: string | null;
    isResend: boolean;
  };
  let storedRows: Row[] = [];
  mod.__test_setListManualReserveAlertDispatchesOverride(async (opts: any) => {
    let out = storedRows;
    if (opts?.sinceTimestamp !== undefined) {
      out = out.filter((r) => r.timestamp >= opts.sinceTimestamp);
    }
    if (opts?.eventTypes) {
      const set = new Set(opts.eventTypes);
      out = out.filter((r) => set.has(r.eventType));
    }
    return out
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, opts?.limit ?? 200) as any;
  });

  function makeRow(over: Partial<Row>): Row {
    return {
      id: storedRows.length + 1,
      timestamp: Date.now(),
      eventType: "muted",
      metric: "manual_wait_p95_ms",
      severity: "warning",
      message: "synthetic",
      value: 100,
      threshold: 50,
      status: "muted",
      detail: null,
      mutedBy: "alice",
      muteReason: "test",
      triggeredBy: null,
      triggerSource: null,
      isResend: false,
      ...over,
    };
  }

  // ─── 1. Natural expiry posts recap ───────────────────────────────
  await mod.clearManualReserveMute();
  mod.__resetManualReserveMuteEndDedupForTest();
  storedRows = [];
  dispatched = [];

  const mutedAt = Date.now() - 30 * 60_000; // started 30 min ago
  const mutedUntil = Date.now() - 1_000; // expired 1 s ago
  // Seed mute row directly via setManualReserveMute requires future expiry,
  // so write through the storage layer to install an already-expired mute.
  const settings = await import("../server/storage/settingsStorage");
  await settings.setSystemSetting(
    "manual_reserve_alert_mute",
    JSON.stringify({
      mutedAt,
      mutedUntil,
      mutedBy: "alice",
      reason: "scheduled backfill",
      source: "manual",
      jobId: null,
      jobLabel: null,
    }),
  );
  // Two suppressed alerts in the window: one critical, one warning.
  storedRows.push(
    makeRow({
      timestamp: mutedAt + 5 * 60_000,
      severity: "critical",
      metric: "manual_wait_p95_ms",
      value: 9999,
      threshold: 5000,
    }),
    makeRow({
      timestamp: mutedAt + 10 * 60_000,
      severity: "warning",
      metric: "manual_timeout_window",
      value: 12,
      threshold: 8,
    }),
    makeRow({
      timestamp: mutedAt + 15 * 60_000,
      severity: "critical",
      metric: "manual_wait_p95_ms",
      value: 12000,
      threshold: 5000,
    }),
  );

  const polled = await mod.pollManualReserveMuteEnd();
  assert(polled.notified === true, "expected pollManualReserveMuteEnd to notify on expiry");
  assert(dispatched.length === 1, `expected one Slack post, got ${dispatched.length}`);
  const post = dispatched[0];
  assert(post.id === "usage.manual_reserve.starvation", "wrong notification id");
  assert(post.metadata.endReason === "expired", "endReason should be 'expired'");
  assert(post.metadata.suppressedCount === 3, "suppressedCount should match row count");
  assert(post.text.includes("expired"), "recap should mention 'expired'");
  assert(post.text.includes("alice"), "recap should mention muter");
  assert(post.text.includes("manual_wait_p95_ms"), "recap should list metric");
  assert(post.text.includes("12000"), "recap should include peak value");
  // Mute row should be cleared after natural expiry recap.
  const after = await mod.getManualReserveMuteState();
  assert(after.muted === false && after.mutedAt === null, "mute row should be cleared");

  // ─── 2. Manual operator clear posts recap ────────────────────────
  mod.__resetManualReserveMuteEndDedupForTest();
  dispatched = [];
  storedRows = [];
  const m2At = Date.now() - 15 * 60_000;
  const m2Until = Date.now() + 60 * 60_000;
  storedRows.push(
    makeRow({ timestamp: m2At + 60_000, severity: "warning", value: 80, threshold: 50 }),
  );
  const r2 = await mod.notifyManualReserveMuteWindowEnded(
    {
      mutedAt: m2At,
      mutedUntil: m2Until,
      mutedBy: "bob",
      reason: "manual hold",
      source: "manual",
      jobId: null,
      jobLabel: null,
    },
    "cleared_manual",
  );
  assert(r2.posted === true, "manual-clear recap should post");
  assert(dispatched.length === 1, "manual-clear should produce one post");
  assert(
    dispatched[0].text.includes("cleared by operator"),
    "manual-clear recap should label end reason",
  );
  assert(dispatched[0].metadata.endReason === "cleared_manual", "metadata endReason");

  // ─── 3. Idempotency: second call for same mute is a no-op ────────
  dispatched = [];
  const r3 = await mod.notifyManualReserveMuteWindowEnded(
    {
      mutedAt: m2At,
      mutedUntil: m2Until,
      mutedBy: "bob",
      reason: "manual hold",
      source: "manual",
      jobId: null,
      jobLabel: null,
    },
    "cleared_manual",
  );
  assert(r3.posted === false && r3.reason === "already_announced", "expected dedup");
  assert(dispatched.length === 0, "no second post on dedup");

  // ─── 4. Zero suppressed → no post ────────────────────────────────
  mod.__resetManualReserveMuteEndDedupForTest();
  dispatched = [];
  storedRows = [];
  const r4 = await mod.notifyManualReserveMuteWindowEnded(
    {
      mutedAt: Date.now() - 60_000,
      mutedUntil: Date.now() - 1_000,
      mutedBy: "carol",
      reason: "quiet window",
      source: "manual",
      jobId: null,
      jobLabel: null,
    },
    "expired",
  );
  assert(r4.posted === false && r4.reason === "zero_suppressed", "zero suppressed → skip");
  assert(dispatched.length === 0, "no Slack post when nothing was suppressed");

  // ─── 5. Backfill auto-clear path triggers recap ──────────────────
  await mod.clearManualReserveMute();
  mod.__resetManualReserveMuteEndDedupForTest();
  dispatched = [];
  storedRows = [];
  const setRes = await mod.setManualReserveMuteForBackfillJob({
    jobId: "job-xyz",
    jobLabel: "semrush_inventory_sync",
    durationMs: 60 * 60_000,
    reason: "auto for backfill",
  });
  assert(setRes.applied === true, "auto-mute should install");
  // Seed a suppressed dispatch in the window.
  // Row must land between mutedAt and now-at-clear-time. Use mutedAt itself
  // since the install→clear gap is sub-millisecond.
  storedRows.push(
    makeRow({
      timestamp: setRes.state.mutedAt!,
      severity: "warning",
      value: 200,
      threshold: 100,
      mutedBy: null,
      muteReason: "auto for backfill",
    }),
  );
  const cleared = await mod.clearManualReserveMuteForBackfillJob("job-xyz");
  assert(cleared.cleared === true, "auto-clear should release");
  // The clear schedules notify via void; wait for the async chain to settle.
  for (let i = 0; i < 20; i++) {
    if (dispatched.length > 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(dispatched.length === 1, `expected one auto-clear post, got ${dispatched.length}`);
  assert(
    dispatched[0].metadata.endReason === "cleared_auto",
    "auto-clear endReason in metadata",
  );
  assert(
    dispatched[0].text.includes("auto-cleared by backfill"),
    "auto-clear label in text",
  );
  assert(
    dispatched[0].text.includes("semrush_inventory_sync"),
    "auto-clear should mention jobLabel",
  );

  // Cleanup overrides.
  mod.__test_setMuteEndDispatcherOverride(null);
  mod.__test_setListManualReserveAlertDispatchesOverride(null);
  await mod.clearManualReserveMute();

  console.log("manual-reserve-mute-end-recap: all cases passed");
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
