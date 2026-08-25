/* test-registration
{
  "name": "Front cross-path dedup — webhook-then-reconciliation materializes once (Task #3992)",
  "regression": true,
  "sweepOnlyReason": "Exercises the real ingest → normalize → apply pipeline against the test DB for both the webhook and reconciliation paths; too heavy for the routine TEST_SMOKE gate. Runs in the full suite and the nightly --regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #3992 requirement 7 — one Front event received through the WEBHOOK
 * and later through POLLING/RECONCILIATION must materialize exactly once
 * with no duplicate downstream effect. Both paths converge on the apply
 * stage's existing-row skip (`findRawCommunicationByExternalSourceId` keyed
 * by conversationId); reconciliation hydration is test-overridable so no
 * Front API call is ever made.
 *
 * Flow proven:
 *   1. Webhook delivery ingested (handleFrontWebhook) → normalized →
 *      applied → exactly one raw_communication_records row for the
 *      conversation, apply outcome `success`.
 *   2. Reconciliation envelope for the SAME conversation ingested
 *      (sourceEventType=reconciliation_scan, hydration override installed)
 *      → normalized → applied → `applied:false, reason:'already_exists'`,
 *      apply outcome `skipped`, STILL exactly one
 *      raw_communication_records row.
 *
 * All rows are created with run-unique IDs and deleted in finally
 * (workerDb bypasses any tx sandbox, so cleanup is explicit).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

const RUN_ID = `t3992x_${process.pid}_${Date.now().toString(36)}`;

async function main(): Promise<void> {
  const {
    handleFrontWebhook,
    normalizeFrontWebhookEvent,
    normalizeReconciliationEvent,
    applyFrontWebhookResult,
    __setReconciliationHydrationOverrideForTest,
  } = await import("../server/services/frontWebhookIngestion");
  const { ingestEvent } = await import("../server/services/pipelineProcessor");
  const { workerDb } = await import("../server/db");

  const convId = `cnv_${RUN_ID}`;
  const msgId = `msg_${RUN_ID}`;
  const senderEmail = `sender_${RUN_ID}@example.com`;
  const createdSec = Math.floor(Date.now() / 1000);

  const sourceEventIds: string[] = [];

  const rawRowCount = async (): Promise<number> => {
    const r: any = await workerDb.execute(
      sql`SELECT COUNT(*)::int AS n FROM raw_communication_records WHERE external_source_id = ${convId}`,
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  const workResultIdFor = async (sourceEventId: string): Promise<string> => {
    const r: any = await workerDb.execute(
      sql`SELECT id FROM work_result_log WHERE source_event_id = ${sourceEventId} ORDER BY created_at DESC LIMIT 1`,
    );
    const id = r.rows[0]?.id;
    assert.ok(id, `work result exists for source event ${sourceEventId}`);
    return String(id);
  };

  try {
    // ── Path 1: webhook delivery ─────────────────────────────────────────
    const webhookPayload = {
      type: "inbound",
      payload: {
        conversation: { id: convId, subject: `Cross-path dedup ${RUN_ID}` },
        message: {
          id: msgId,
          body: "cross-path dedup body",
          is_inbound: true,
          created_at: createdSec,
          author: { email: senderEmail, username: "xdedup" },
        },
      },
    } as any;

    const ingest = await handleFrontWebhook(webhookPayload);
    assert.ok(!ingest.featureDisabled, "front event ingest feature flags enabled");
    assert.equal(ingest.deduplicated, false, "webhook delivery ingested fresh");
    assert.ok(ingest.id, "webhook source event id returned");
    sourceEventIds.push(ingest.id);

    // Normalize is a no-op if the inline (non-split) path already ran it.
    await normalizeFrontWebhookEvent(ingest.id);
    const webhookWorkResultId = await workResultIdFor(ingest.id);

    const firstApply = await applyFrontWebhookResult(ingest.id, webhookWorkResultId);
    assert.equal(firstApply.applied, true, "webhook path materializes the record");
    assert.ok(firstApply.recordId, "record id returned");
    assert.equal(await rawRowCount(), 1, "exactly one raw record after webhook apply");

    // ── Path 2: the SAME event later arrives via polling/reconciliation ──
    // Hydration override: network-free; the envelope carries last_message
    // so direction/timestamp normalize from the payload itself.
    __setReconciliationHydrationOverrideForTest(async () => ({ messages: [] }));

    const reconEnvelope = {
      id: convId,
      subject: `Cross-path dedup ${RUN_ID}`,
      created_at: createdSec,
      last_message: {
        id: msgId,
        body: "cross-path dedup body",
        is_inbound: true,
        created_at: createdSec,
      },
      recipient: { handle: senderEmail, role: "from" },
    };
    const reconIngest = await ingestEvent({
      sourceSystem: "front",
      sourceEventType: "reconciliation_scan",
      sourceObjectId: convId,
      dedupeKey: `front:reconciliation:${RUN_ID}`,
      payloadJson: reconEnvelope as any,
      receivedAt: new Date(),
    });
    assert.equal(
      reconIngest.deduplicated,
      false,
      "reconciliation envelope has its own dedupe key (distinct source event is expected)",
    );
    sourceEventIds.push(reconIngest.id);

    const reconNormalized = await normalizeReconciliationEvent(reconIngest.id);
    assert.ok(reconNormalized, "reconciliation envelope normalized");
    assert.equal(reconNormalized!.conversationId, convId, "same conversation");
    const reconWorkResultId = await workResultIdFor(reconIngest.id);

    const secondApply = await applyFrontWebhookResult(reconIngest.id, reconWorkResultId);
    assert.equal(secondApply.applied, false, "reconciliation apply does NOT create a second record");
    assert.equal(secondApply.reason, "already_exists", "apply converges on the existing-row skip");
    assert.equal(
      secondApply.recordId,
      firstApply.recordId,
      "skip points at the record the webhook path created",
    );

    assert.equal(await rawRowCount(), 1, "STILL exactly one raw record after both paths");

    // No duplicate downstream effect: the reconciliation pass recorded a
    // `skipped` apply outcome (not a second `success`).
    const outcomes: any = await workerDb.execute(
      sql`SELECT outcome, work_result_id FROM apply_state WHERE source_event_id = ${reconIngest.id}`,
    );
    assert.equal(outcomes.rows.length, 1, "one apply-state row for the reconciliation event");
    assert.equal(outcomes.rows[0].outcome, "skipped", "reconciliation apply outcome is skipped");

    console.log("front-cross-path-dedup: all assertions passed");
  } finally {
    __setReconciliationHydrationOverrideForTest(null);
    // Cleanup litter (order: dependents first). Best-effort per statement.
    const cleanups: Array<() => Promise<any>> = [
      () => workerDb.execute(sql`DELETE FROM raw_communication_records WHERE external_source_id = ${convId}`),
      () => workerDb.execute(sql`DELETE FROM raw_communication_records WHERE external_thread_id = ${convId}`),
      () => workerDb.execute(sql`DELETE FROM front_sync_emails WHERE conversation_id = ${convId}`),
      ...sourceEventIds.map((id) => () =>
        workerDb.execute(sql`DELETE FROM apply_state WHERE source_event_id = ${id}`),
      ),
      ...sourceEventIds.map((id) => () =>
        workerDb.execute(sql`DELETE FROM work_result_log WHERE source_event_id = ${id}`),
      ),
      ...sourceEventIds.map((id) => () =>
        workerDb.execute(
          sql`DELETE FROM work_queue WHERE dedupe_key IN (${"normalize:" + id}, ${"apply:" + id})`,
        ),
      ),
      ...sourceEventIds.map((id) => () =>
        workerDb.execute(sql`DELETE FROM source_event_log WHERE id = ${id}`),
      ),
    ];
    for (const fn of cleanups) {
      try {
        await fn();
      } catch (err) {
        console.error("[front-cross-path-dedup] cleanup step failed:", err);
      }
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
