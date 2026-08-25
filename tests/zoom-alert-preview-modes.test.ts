/* test-registration
{
  "name": "Zoom alert preview modes",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the Zoom review-queue alert preview modes
 * (task #738).
 *
 * The Zoom review-queue alert settings page exposes two preview-only entry
 * points (`forceBackedUp` and `forceCleared`) that must NEVER write
 * persisted alert state — no lastSentAt, cycleState, eventHistory,
 * lastClearedAt, or lastStatus updates. They send a sample notification
 * only. We also pin the regular "no-op" path (no breach, cycle already
 * cleared) — it MUST write `lastStatus` (so the dashboard can show the
 * most recent evaluation) but MUST NOT touch the alert lifecycle keys.
 *
 * Pinned behavior:
 *   1. `forceBackedUp` returns a status object with slack/in-app delivery
 *      reflected, but leaves all SETTINGS_KEYS values unchanged — both
 *      when thresholds are unreachable AND when they are currently
 *      breached.
 *   2. `forceCleared` returns `cleared=true` with slack/in-app delivery
 *      reflected, but leaves all SETTINGS_KEYS values unchanged — both
 *      when thresholds are unreachable AND when they are currently
 *      breached.
 *   3. The regular no-op path (no breach + cycleState='cleared') records
 *      `skipReason='no_breach'` and updates lastStatus, but leaves
 *      lastSentAt / cycleState / eventHistory / lastClearedAt unchanged.
 */

import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { deleteSystemSetting } from "../server/storage/settingsStorage";
import {
  runZoomReviewAlertCheck,
  getZoomReviewAlertSettings,
  getZoomReviewQueueMetrics,
  updateZoomReviewAlertSettings,
} from "../server/services/zoomReviewQueueAlerts";
import { agentMatchDecisions } from "@shared/schema";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const SETTINGS_KEYS = [
  "zoom_review_alert_enabled",
  "zoom_review_alert_count_threshold",
  "zoom_review_alert_age_hours_threshold",
  "zoom_review_alert_slack_channel",
  "zoom_review_alert_recipient_emails",
  "zoom_review_alert_cooldown_minutes",
  "zoom_review_alert_last_sent_at",
  "zoom_review_alert_last_status",
  "zoom_review_alert_cycle_state",
  "zoom_review_alert_last_cleared_at",
  "zoom_review_alert_event_history",
] as const;

type Snapshot = Record<string, string | null>;

async function snapshotSettings(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const key of SETTINGS_KEYS) {
    const row = await storage.getSystemSetting(key);
    out[key] = row?.value ?? null;
  }
  return out;
}

// Preview branches must not touch ANY of these — the full lifecycle plus
// lastStatus, since the preview-mode contract is "send a sample, write
// nothing". For preview runs we enforce a literal full-key freeze
// (every entry in SETTINGS_KEYS must round-trip identically).
const PREVIEW_PRESERVE_KEYS = SETTINGS_KEYS;

// The no-op (no_breach) path may rewrite lastStatus (dashboard needs the
// latest evaluatedAt) but must preserve the rest of the alert lifecycle.
const NOOP_PRESERVE_KEYS = [
  "zoom_review_alert_last_sent_at",
  "zoom_review_alert_cycle_state",
  "zoom_review_alert_event_history",
  "zoom_review_alert_last_cleared_at",
] as const;

function assertPreserved(
  before: Snapshot,
  after: Snapshot,
  keys: readonly string[],
  ctx: string,
): void {
  for (const key of keys) {
    assert(
      before[key] === after[key],
      `${ctx}: setting ${key} must not change (before=${JSON.stringify(before[key])} after=${JSON.stringify(after[key])})`,
    );
  }
}

async function runPreviewScenario(
  label: string,
  thresholds: { countThreshold: number; ageHoursThreshold: number },
  baseline: Snapshot,
): Promise<void> {
  await updateZoomReviewAlertSettings(thresholds);
  const baselineForScenario = await snapshotSettings();
  // Verify the lifecycle sentinels survived the threshold update — the
  // updateZoomReviewAlertSettings helper only touches the threshold/config
  // keys, not the lifecycle keys.
  const LIFECYCLE_KEYS = [
    "zoom_review_alert_last_sent_at",
    "zoom_review_alert_cycle_state",
    "zoom_review_alert_event_history",
    "zoom_review_alert_last_cleared_at",
    "zoom_review_alert_last_status",
  ] as const;
  for (const key of LIFECYCLE_KEYS) {
    assert(
      baselineForScenario[key] === baseline[key],
      `${label}: precondition — lifecycle key ${key} drifted before preview ran`,
    );
  }

  // forceBackedUp preview
  const backedUp = await runZoomReviewAlertCheck({
    force: true,
    bypassCooldown: true,
    forceBackedUp: true,
  });
  assert(
    typeof backedUp.evaluatedAt === "string",
    `${label}/forceBackedUp: should return a status with evaluatedAt`,
  );
  assert(
    backedUp.slackAttempted === true,
    `${label}/forceBackedUp: status.slackAttempted must be true (Slack delivery is always attempted in preview)`,
  );
  assert(
    typeof backedUp.slackSent === "boolean",
    `${label}/forceBackedUp: status.slackSent must be reflected (boolean)`,
  );
  assert(
    typeof backedUp.inAppRecipients === "number" && backedUp.inAppRecipients >= 0,
    `${label}/forceBackedUp: status.inAppRecipients must be a non-negative number reflecting the in-app delivery attempt`,
  );
  assert(
    backedUp.notificationSent === (backedUp.slackSent || backedUp.inAppRecipients > 0),
    `${label}/forceBackedUp: notificationSent must reflect the OR of slackSent / inAppRecipients>0`,
  );
  // The preview path never sends email — emailSent stays false and
  // emailRecipients stays 0 (the per-channel email outcome is recorded
  // via the absence of slackAttempted-style flag).
  assert(
    backedUp.emailSent === false && backedUp.emailRecipients === 0,
    `${label}/forceBackedUp: preview must never attempt email send`,
  );
  const afterBackedUp = await snapshotSettings();
  assertPreserved(
    baselineForScenario,
    afterBackedUp,
    PREVIEW_PRESERVE_KEYS,
    `${label}/forceBackedUp`,
  );

  // forceCleared preview
  const cleared = await runZoomReviewAlertCheck({
    force: true,
    bypassCooldown: true,
    forceCleared: true,
  });
  assert(
    cleared.cleared === true,
    `${label}/forceCleared: status.cleared must be true`,
  );
  assert(
    cleared.slackAttempted === true,
    `${label}/forceCleared: status.slackAttempted must be true (Slack delivery is always attempted in preview)`,
  );
  assert(
    typeof cleared.slackSent === "boolean",
    `${label}/forceCleared: status.slackSent must be reflected (boolean)`,
  );
  assert(
    typeof cleared.inAppRecipients === "number" && cleared.inAppRecipients >= 0,
    `${label}/forceCleared: status.inAppRecipients must be a non-negative number reflecting the in-app delivery attempt`,
  );
  assert(
    cleared.notificationSent === (cleared.slackSent || cleared.inAppRecipients > 0),
    `${label}/forceCleared: notificationSent must reflect the OR of slackSent / inAppRecipients>0`,
  );
  assert(
    cleared.emailSent === false && cleared.emailRecipients === 0,
    `${label}/forceCleared: preview must never attempt email send`,
  );
  const afterCleared = await snapshotSettings();
  assertPreserved(
    baselineForScenario,
    afterCleared,
    PREVIEW_PRESERVE_KEYS,
    `${label}/forceCleared`,
  );
}

async function main(): Promise<void> {
  // Save original config so the test is non-destructive.
  const originalSnapshot = await snapshotSettings();

  try {
    // Configure a known clean state. Alerts must be enabled or the
    // regular path short-circuits with `alerts_disabled`. Slack channel
    // and recipient emails are blank so preview paths skip external
    // sends and we can still observe state writes.
    await updateZoomReviewAlertSettings({
      enabled: true,
      countThreshold: 1_000_000, // unreachable → no breach for the no-op path
      ageHoursThreshold: 1_000_000,
      cooldownMinutes: 60,
      slackChannel: "",
      recipientEmails: [],
    });

    // Manually write stable lifecycle sentinels so we can detect any
    // accidental writes from the preview branches.
    const SENTINEL_SENT_AT = "2025-01-01T00:00:00.000Z";
    const SENTINEL_CYCLE = "cleared";
    const SENTINEL_HISTORY = JSON.stringify([
      { type: "cleared", at: SENTINEL_SENT_AT, pendingCount: 0, oldestAgeHours: null },
    ]);
    const SENTINEL_LAST_CLEARED_AT = "2025-01-02T00:00:00.000Z";
    const SENTINEL_LAST_STATUS = JSON.stringify({
      evaluatedAt: SENTINEL_SENT_AT,
      pendingCount: 0,
      oldestAgeHours: null,
      breached: false,
      breachReasons: [],
      notificationSent: false,
      slackSent: false,
      emailSent: false,
      emailRecipients: 0,
      inAppRecipients: 0,
      skipReason: "test_sentinel",
    });
    await storage.setSystemSetting("zoom_review_alert_last_sent_at", SENTINEL_SENT_AT);
    await storage.setSystemSetting("zoom_review_alert_cycle_state", SENTINEL_CYCLE);
    await storage.setSystemSetting("zoom_review_alert_event_history", SENTINEL_HISTORY);
    await storage.setSystemSetting("zoom_review_alert_last_cleared_at", SENTINEL_LAST_CLEARED_AT);
    await storage.setSystemSetting("zoom_review_alert_last_status", SENTINEL_LAST_STATUS);

    const baseline = await snapshotSettings();
    assert(
      baseline["zoom_review_alert_last_sent_at"] === SENTINEL_SENT_AT,
      "baseline lastSentAt should be the sentinel",
    );
    assert(
      baseline["zoom_review_alert_last_status"] === SENTINEL_LAST_STATUS,
      "baseline lastStatus should be the sentinel",
    );

    // (1) Preview modes when thresholds are unreachable (no current breach).
    await runPreviewScenario(
      "no-breach",
      { countThreshold: 1_000_000, ageHoursThreshold: 1_000_000 },
      baseline,
    );

    // (2) Preview modes when the queue is *deterministically* breached.
    //     We seed one zoom `review_required` row aged ~2h old and lower
    //     thresholds to {1, 1} so both the count rule and the age rule
    //     trip. The preview must still write nothing.
    const seededDecisionId = "test-zoom-preview-modes-breach-seed";
    // Defensive cleanup in case a prior run crashed mid-test.
    await db
      .delete(agentMatchDecisions)
      .where(eq(agentMatchDecisions.id, seededDecisionId));
    await db.insert(agentMatchDecisions).values({
      id: seededDecisionId,
      communicationId: `test-comm-${seededDecisionId}`,
      communicationType: "zoom_recording",
      sourceType: "zoom",
      clientId: null,
      confidenceScore: 0,
      status: "review_required",
      evidenceType: "structured",
      reviewResolution: null,
      // Force createdAt 2h in the past so age-threshold of 1h breaches.
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    try {
      // Sanity: queue metrics now reflect the seeded breach.
      const metrics = await getZoomReviewQueueMetrics();
      assert(
        metrics.pendingCount >= 1,
        `precondition: seeded row should make pendingCount >= 1, got ${metrics.pendingCount}`,
      );
      assert(
        metrics.oldestAgeHours != null && metrics.oldestAgeHours >= 1,
        `precondition: seeded row should make oldestAgeHours >= 1, got ${metrics.oldestAgeHours}`,
      );
      await runPreviewScenario(
        "currently-breached",
        { countThreshold: 1, ageHoursThreshold: 1 },
        baseline,
      );
    } finally {
      await db
        .delete(agentMatchDecisions)
        .where(eq(agentMatchDecisions.id, seededDecisionId))
        .catch(() => undefined);
    }

    // (3) Regular no-op path: thresholds unreachable, cycleState already
    //     cleared. The engine reaches the `!breached` branch and records
    //     skipReason='no_breach'. lastStatus IS rewritten (dashboard) but
    //     the alert lifecycle keys must be preserved.
    await updateZoomReviewAlertSettings({
      countThreshold: 1_000_000,
      ageHoursThreshold: 1_000_000,
    });
    // Re-establish lifecycle sentinels (preview scenarios should have
    // left them intact, but be defensive in case a regression slips
    // through and we want the no-op assertion to remain meaningful).
    await storage.setSystemSetting("zoom_review_alert_last_sent_at", SENTINEL_SENT_AT);
    await storage.setSystemSetting("zoom_review_alert_cycle_state", SENTINEL_CYCLE);
    await storage.setSystemSetting("zoom_review_alert_event_history", SENTINEL_HISTORY);
    await storage.setSystemSetting("zoom_review_alert_last_cleared_at", SENTINEL_LAST_CLEARED_AT);
    const noOpBaseline = await snapshotSettings();

    const settingsBeforeNoOp = await getZoomReviewAlertSettings();
    assert(
      settingsBeforeNoOp.cycleState === "cleared",
      `precondition: cycleState should be 'cleared' for the no-op path, got ${settingsBeforeNoOp.cycleState}`,
    );
    const noOpStatus = await runZoomReviewAlertCheck({ bypassCooldown: true });
    assert(
      noOpStatus.breached === false,
      `no-op path should report breached=false, got ${noOpStatus.breached}`,
    );
    assert(
      noOpStatus.skipReason === "no_breach",
      `no-op path should report skipReason='no_breach', got ${noOpStatus.skipReason}`,
    );
    const afterNoOp = await snapshotSettings();
    assertPreserved(noOpBaseline, afterNoOp, NOOP_PRESERVE_KEYS, "no-op (no_breach)");
    // The no-op path is allowed to rewrite lastStatus, and in fact must —
    // verify it changed away from the sentinel so the dashboard reflects
    // the latest evaluation.
    assert(
      afterNoOp["zoom_review_alert_last_status"] !== SENTINEL_LAST_STATUS,
      "no-op path should rewrite lastStatus with the latest evaluation",
    );

    console.log("zoom-alert-preview-modes: PASSED");
  } finally {
    // Restore original settings exactly so we don't poison later tests.
    for (const key of SETTINGS_KEYS) {
      const original = originalSnapshot[key];
      if (original == null) {
        await deleteSystemSetting(key).catch(() => undefined);
      } else {
        await storage.setSystemSetting(key, original).catch(() => undefined);
      }
    }
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch((err) => {
  console.error("zoom-alert-preview-modes: FAILED", err);
  process.exitCode = 1;
});
