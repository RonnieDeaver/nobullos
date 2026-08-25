/* test-registration
{
  "name": "Email sequences seam — per-contact enrollment uniqueness under concurrency, step-gate + claim-ledger double-send defenses with duplicate alert, approval-gated drafts vs owner-gated auto-send (missing-merge refusal), AI-personalized drafts (never auto-send, failure = fallback draft with visible reason, editable before approval), cancel-on-reply/suppression/lifecycle with eager creation-path + lifecycle-writer hooks and approve-time suppression backstop, kill-switch + pause defer, funnel analytics (Tasks #4335/#4478)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4335: the double-send bug class is this feature's named enemy, and this suite pins all three structural defenses end to end against the real per-run DB: (1) the partial-unique active-enrollment guard makes concurrent enrolls collapse to ONE row; (2) the step-gate makes replayed/stale jobs no-ops; (3) the (enrollment, step) claim ledger refuses a second send record even when the step-gate is subverted, and raises the duplicate alert instead of absorbing the bug. Also pins the approval policy that must never drift: steps are DRAFTS by default, auto-send fires only when the sequence opts in AND the merge is complete (missing fields always wait for human eyes), an inbound reply / suppression / lifecycle-exit cancels the rest of the run visibly, and the global kill switch defers instead of sending. Alerts via the injected sink, outbound compose asserted at the batch ledger (send handler never runs), zero egress, hermetic per-run DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #4335 — email sequences service: enrollment, scheduler, approvals.
 *
 * Covers, against the real per-run DB (only the alert sink is injected):
 *
 *   1. Concurrent enrollEntity × 5 → exactly one active enrollment row and
 *      one scheduled step job (partial-unique guard, defense #1).
 *   2. Step handler mints a DRAFT step-send with frozen rendered content;
 *      re-running the job before approval stays a single row, no alert.
 *   3. approveStepSend → composes via the outbound seam (batch rows exist),
 *      CAS-advances the enrollment, schedules the next step; re-approve is
 *      idempotent (not_pending).
 *   4. Replayed step-1 job after advancing → step-gate no-op (defense #2).
 *   5. Enrollment forced BACK to step 0 (simulated advance bug) → claim
 *      ledger blocks the duplicate and the duplicate alert fires with the
 *      email_seq_dup dedupe key (defense #3) — no second outbound compose.
 *   6. Global kill switch defers (no step-send, nextStepAt pushed out,
 *      :paused: job) — never sends, never fails; sequence-paused defers too.
 *   7. Auto-send ON + complete merge → step auto-approves and composes;
 *      auto-send ON + missing merge fields → stays draft (human required),
 *      reject = skip → single-step enrollment completes.
 *   8. Segment enrollment: per-member outcomes (enrolled / already_active /
 *      skipped no_email).
 *   9. Reply-detected trigger event (front_inbound_reply) cancels the
 *      active enrollment ('replied') and its pending draft, visibly.
 *  10. Suppression cancels at the next advance; enroll-time suppression is
 *      refused; lifecycle transition to customer cancels; unsubscribe-path
 *      helper cancels by email; manual cancel is idempotent (false 2nd).
 *  11. getSequenceAnalytics funnel + per-step counts match every outcome
 *      minted above exactly.
 *  12. Eager cancel hooks (review hardening): the canonical lifecycle
 *      writer (advanceClientLifecycle → customer) cancels the enrollment
 *      and its pending draft immediately — no queued job involved; the
 *      shared suppression helper (the manual admin route's path) cancels
 *      immediately; and approveStepSend refuses a suppressed recipient
 *      even when the suppression row was inserted directly (backstop) —
 *      a drafted send can never be approved after suppression or
 *      lifecycle exit.
 *
 * DB: hermetic per-run Postgres (migrations applied by the harness).
 * Settings writes use the seeded CEO id (system_settings.updated_by FK).
 */

process.env.NODE_ENV = "test";
// Belt & braces: the send handler never runs here, but make sure a bug
// could not reach SendGrid either.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";

const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const seqService = await import("../server/services/emailSequences");
const {
  enrollEntity,
  enrollSegment,
  handleEmailSequenceStepJob,
  approveStepSend,
  rejectStepSend,
  cancelEnrollment,
  cancelActiveEnrollmentsForEmail,
  getSequenceAnalytics,
  findUnknownMergeTokens,
  editStepSendDraft,
  __setEmailSequenceAlertNotifyForTests,
  __setSequenceAiGenerateForTests,
  EMAIL_SEQUENCES_PAUSED_KEY,
} = seqService;
const {
  createEmailTemplate,
  createEmailSequence,
  updateEmailSequence,
  replaceSequenceSteps,
  getEnrollment,
  listEnrollments,
  getStepSend,
  getStepSendForStep,
  listApprovalQueue,
  listSequenceSteps,
} = await import("../server/storage/emailSequencesStorage");
const { upsertEmailSuppression, listOutboundEmailsByBatch } = await import(
  "../server/storage/outboundEmailStorage"
);
const { deriveOutboundEmailBatchId, addEmailSuppressionWithSideEffects } = await import(
  "../server/services/outboundEmail"
);
const { advanceClientLifecycle } = await import("../server/storage/leadLifecycleStorage");
const { getSystemSettingFresh, setSystemSetting } = await import(
  "../server/storage/settingsStorage"
);
const { insertTriggerEvent } = await import("../server/storage/dealTriggersStorage");
const { processTriggerEvent } = await import("../server/services/dealTriggers");
const { createSegment } = await import("../server/storage/tagsSegmentsStorage");
const { clients, clientContacts } = await import("@shared/models/clients");
const { segmentMembers } = await import("@shared/models/tagsSegments");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4335-ceo-${RUN}`;
const OWNER_ID = `test-4335-owner-${RUN}`;
const rcpt = (tag: string) => `${tag}-${RUN}@recipient-seq4335.test`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Jobs the scheduler enqueued for one enrollment (by dedupe prefix). */
async function stepJobKeys(enrollmentId: string): Promise<string[]> {
  const res = await db.execute(
    sql`SELECT dedupe_key FROM work_queue WHERE dedupe_key LIKE ${`email_seq_step:${enrollmentId}:%`} ORDER BY dedupe_key`,
  );
  return (res.rows as Array<{ dedupe_key: string }>).map((r) => r.dedupe_key);
}

/** Outbound rows composed for one step-send (batch id is hash-derived). */
async function stepSendBatch(stepSendId: string) {
  return listOutboundEmailsByBatch(
    deriveOutboundEmailBatchId(OWNER_ID, `email_seq_send:${stepSendId}`),
  );
}

async function main(): Promise<void> {
  // ── Fixtures ───────────────────────────────────────────────────────────────
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name, email) VALUES
      (${CEO_ID}, 'ceo', 'Ceo4335', 'Seq', ${`ceo-${RUN}@seq4335.test`}),
      (${OWNER_ID}, 'team_lead', 'Seq', 'Owner', ${`owner-${RUN}@seq4335.test`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);

  const [clientA] = await db
    .insert(clients)
    .values({
      firmName: `Firm A ${RUN}`,
      contactName: "Alice Anders",
      contactEmail: rcpt("a"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientB] = await db
    .insert(clients)
    .values({
      firmName: `Firm B ${RUN}`,
      contactName: "Bob Boyd",
      contactEmail: rcpt("b-firm"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [contactB] = await db
    .insert(clientContacts)
    .values({
      clientId: clientB.id,
      name: "Bobby Contact",
      emails: [rcpt("b-contact")],
      isPrimary: true,
    })
    .returning();
  const [clientC] = await db
    .insert(clients)
    .values({
      firmName: `Firm C ${RUN}`,
      contactName: "Cara Cole",
      contactEmail: rcpt("c"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientD] = await db
    .insert(clients)
    .values({
      firmName: `Firm D ${RUN}`,
      contactName: "Dan Drew",
      contactEmail: rcpt("d"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientE] = await db
    .insert(clients)
    .values({
      firmName: `Firm E ${RUN}`,
      contactName: "Eve East",
      contactEmail: rcpt("e"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientF] = await db
    .insert(clients)
    .values({
      firmName: `Firm F ${RUN}`,
      contactName: "Fay Frost",
      contactEmail: null,
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  // G/H/I: eager-cancel hook fixtures (sections 19-21).
  const [clientG] = await db
    .insert(clients)
    .values({
      firmName: `Firm G ${RUN}`,
      contactName: "Gil Gray",
      contactEmail: rcpt("g"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientH] = await db
    .insert(clients)
    .values({
      firmName: `Firm H ${RUN}`,
      contactName: "Hal Hart",
      contactEmail: rcpt("h"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();
  const [clientI] = await db
    .insert(clients)
    .values({
      firmName: `Firm I ${RUN}`,
      contactName: "Ida Iles",
      contactEmail: rcpt("i"),
      ownerId: OWNER_ID,
      lifecycleStage: "lead",
    })
    .returning();

  const t1 = await createEmailTemplate({
    name: `T1 intro ${RUN}`,
    subject: "Intro for {{client.firmName}}",
    bodyText: "Hi {{contact.firstName|there}}, note from {{sender.email}}.",
    createdBy: CEO_ID,
  });
  const t2 = await createEmailTemplate({
    name: `T2 follow ${RUN}`,
    subject: "Follow-up {{client.firmName}}",
    bodyText: "Still interested? — {{sender.name}}",
    createdBy: CEO_ID,
  });
  const t3 = await createEmailTemplate({
    name: `T3 dealref ${RUN}`,
    subject: "About {{deal.name}}",
    bodyText: "Regarding {{deal.name}}.",
    createdBy: CEO_ID,
  });

  const seqA = await createEmailSequence({
    name: `Seq A ${RUN}`,
    status: "active",
    autoSendEnabled: false,
    createdBy: CEO_ID,
  });
  await replaceSequenceSteps(seqA.id, [
    { templateId: t1.id, delayMinutes: 0 },
    { templateId: t2.id, delayMinutes: 60 },
    { templateId: t2.id, delayMinutes: 120 },
  ]);
  const seqASteps = await listSequenceSteps(seqA.id);

  const seqB = await createEmailSequence({
    name: `Seq B ${RUN}`,
    status: "active",
    autoSendEnabled: true,
    createdBy: CEO_ID,
  });
  await replaceSequenceSteps(seqB.id, [{ templateId: t3.id, delayMinutes: 0 }]);
  const seqBSteps = await listSequenceSteps(seqB.id);

  const alerts: Array<{ registryId: string; dedupeKey: string; text: string }> = [];
  __setEmailSequenceAlertNotifyForTests(async (registryId, dedupeKey, text) => {
    alerts.push({ registryId, dedupeKey, text });
  });

  try {
    // ── 1. Merge vocabulary guard (pure) ─────────────────────────────────────
    const unknown = findUnknownMergeTokens("{{bogus.x}} {{contact.name}} {{deal.name|the deal}}");
    check("unknown merge tokens detected", unknown.length === 1 && unknown[0] === "bogus.x",
      JSON.stringify(unknown));

    // ── 2. Concurrent enrollment collapses to ONE row ────────────────────────
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        enrollEntity({
          sequenceId: seqA.id,
          entityType: "client",
          entityId: clientA.id,
          enrolledBy: CEO_ID,
        }),
      ),
    );
    const enrolledResults = results.filter((r) => r.outcome === "enrolled");
    const alreadyActive = results.filter((r) => r.outcome === "already_active");
    check(
      "concurrent enroll × 5 → exactly 1 enrolled + 4 already_active",
      enrolledResults.length === 1 && alreadyActive.length === 4,
      JSON.stringify(results.map((r) => r.outcome)),
    );
    const enrA = enrolledResults[0]!.enrollmentId!;
    const activeRows = (await listEnrollments(seqA.id, "active")).filter(
      (e) => e.entityId === clientA.id,
    );
    check("exactly one active enrollment row for the contact", activeRows.length === 1);
    check("sender defaulted to the client's assigned owner",
      activeRows[0]?.senderUserId === OWNER_ID, activeRows[0]?.senderUserId ?? "none");
    const jobs1 = await stepJobKeys(enrA);
    check("exactly one step-1 job scheduled", jobs1.length === 1 && jobs1[0]!.endsWith(":1"),
      JSON.stringify(jobs1));

    // ── 3. Handler mints a DRAFT with frozen content ─────────────────────────
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 1 } });
    const draft1 = await getStepSendForStep(enrA, seqASteps[0]!.id);
    check("step 1 → draft in the approval queue (not sent)", draft1?.status === "draft",
      draft1?.status ?? "missing");
    check("rendered subject froze real merge values",
      draft1?.renderedSubject === `Intro for Firm A ${RUN}`, draft1?.renderedSubject);
    check("complete merge → no missing fields", (draft1?.missingFields ?? ["x"]).length === 0,
      JSON.stringify(draft1?.missingFields));
    const queue = await listApprovalQueue({});
    check("approval queue lists the draft", queue.some((q) => q.id === draft1!.id));
    const enrAfterDraft = await getEnrollment(enrA);
    check("enrollment does NOT advance at draft time", enrAfterDraft?.currentStepOrder === 0);

    // ── 4. Replay before approval: single row, no alert ──────────────────────
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 1 } });
    const step1Rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM email_sequence_step_sends WHERE enrollment_id = ${enrA}`,
    );
    check("replayed job before approval → still one step-send row",
      (step1Rows.rows[0] as { n: number }).n === 1);
    check("benign replay raises no alert", alerts.length === 0, JSON.stringify(alerts));

    // ── 5. Approve → compose + CAS advance + next step scheduled ─────────────
    const approve = await approveStepSend({ stepSendId: draft1!.id, actorUserId: CEO_ID });
    check("approve → sent", approve.outcome === "sent", approve.outcome);
    const sent1 = await getStepSend(draft1!.id);
    check("step-send approved with actor stamped",
      sent1?.status === "approved" && sent1?.approvedBy === CEO_ID,
      `${sent1?.status}/${sent1?.approvedBy}`);
    const batch1 = await stepSendBatch(draft1!.id);
    check("outbound compose created exactly one batch row", batch1.length === 1,
      `${batch1.length}`);
    const enrAfterApprove = await getEnrollment(enrA);
    check("enrollment CAS-advanced to step 1", enrAfterApprove?.currentStepOrder === 1);
    const expectStep2At = Date.now() + 60 * 60 * 1000;
    const nextAt = enrAfterApprove?.nextStepAt ? new Date(enrAfterApprove.nextStepAt).getTime() : 0;
    check("next step scheduled ~60min out",
      Math.abs(nextAt - expectStep2At) < 5 * 60 * 1000, new Date(nextAt).toISOString());
    const jobs2 = await stepJobKeys(enrA);
    check("step-2 job enqueued", jobs2.some((k) => k.endsWith(":2")), JSON.stringify(jobs2));
    const reApprove = await approveStepSend({ stepSendId: draft1!.id, actorUserId: CEO_ID });
    check("re-approve is idempotent (not_pending)", reApprove.outcome === "not_pending",
      reApprove.outcome);
    const batch1b = await stepSendBatch(draft1!.id);
    check("re-approve composed nothing new", batch1b.length === 1);

    // ── 6. Step-gate: stale step-1 replay is a no-op (defense #2) ────────────
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 1 } });
    const rowsAfterStale = await db.execute(
      sql`SELECT count(*)::int AS n FROM email_sequence_step_sends WHERE enrollment_id = ${enrA}`,
    );
    check("stale replayed job → no new rows, no alert",
      (rowsAfterStale.rows[0] as { n: number }).n === 1 && alerts.length === 0);

    // ── 7. Subverted step-gate → claim ledger + duplicate alert (defense #3) ─
    await db.execute(
      sql`UPDATE email_sequence_enrollments SET current_step_order = 0 WHERE id = ${enrA}`,
    );
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 1 } });
    check("claim ledger blocked the double-send and alerted",
      alerts.length === 1 && alerts[0]!.dedupeKey.startsWith("email_seq_dup:"),
      JSON.stringify(alerts));
    const batch1c = await stepSendBatch(draft1!.id);
    const rowsAfterForced = await db.execute(
      sql`SELECT count(*)::int AS n FROM email_sequence_step_sends WHERE enrollment_id = ${enrA}`,
    );
    check("no second send record, no second compose",
      (rowsAfterForced.rows[0] as { n: number }).n === 1 && batch1c.length === 1);
    await db.execute(
      sql`UPDATE email_sequence_enrollments SET current_step_order = 1 WHERE id = ${enrA}`,
    );
    alerts.length = 0;

    // ── 8. Global kill switch defers ─────────────────────────────────────────
    await setSystemSetting(EMAIL_SEQUENCES_PAUSED_KEY, "true", CEO_ID);
    try {
      await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 2 } });
      const step2Send = await getStepSendForStep(enrA, seqASteps[1]!.id);
      check("kill switch ON → step 2 NOT minted", step2Send === undefined,
        step2Send?.status);
      const deferred = await getEnrollment(enrA);
      const deferredAt = deferred?.nextStepAt ? new Date(deferred.nextStepAt).getTime() : 0;
      check("kill switch defers nextStepAt out (not cancel, not send)",
        deferred?.status === "active" && deferredAt > Date.now() + 20 * 60 * 1000,
        new Date(deferredAt).toISOString());
      const pausedJobs = (await stepJobKeys(enrA)).filter((k) => k.includes(":paused:"));
      check("deferred re-check job enqueued", pausedJobs.length >= 1, JSON.stringify(pausedJobs));
    } finally {
      await setSystemSetting(EMAIL_SEQUENCES_PAUSED_KEY, "false", CEO_ID);
    }

    // ── 9. Sequence-level pause defers too ───────────────────────────────────
    await updateEmailSequence(seqA.id, { status: "paused" });
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 2 } });
    check("sequence paused → step 2 still not minted",
      (await getStepSendForStep(enrA, seqASteps[1]!.id)) === undefined);
    await updateEmailSequence(seqA.id, { status: "active" });

    // ── 10. Auto-send: complete merge sends without approval ─────────────────
    await updateEmailSequence(seqA.id, { autoSendEnabled: true });
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 2 } });
    const auto2 = await getStepSendForStep(enrA, seqASteps[1]!.id);
    check("auto-send → step 2 approved without an operator", auto2?.status === "approved",
      auto2?.status ?? "missing");
    const batch2 = await stepSendBatch(auto2!.id);
    check("auto-send composed the step", batch2.length === 1);
    const enrAfterAuto = await getEnrollment(enrA);
    check("auto-send advanced to step 2", enrAfterAuto?.currentStepOrder === 2);
    await updateEmailSequence(seqA.id, { autoSendEnabled: false });

    // ── 11. Segment enrollment: per-member outcomes ──────────────────────────
    const segment = await createSegment({
      entityType: "client",
      name: `Seg ${RUN}`,
      criteria: { combinator: "and", groups: [] },
      createdBy: CEO_ID,
    });
    await db.insert(segmentMembers).values([
      { segmentId: segment.id, entityId: clientA.id },
      { segmentId: segment.id, entityId: clientE.id },
      { segmentId: segment.id, entityId: clientF.id },
    ]);
    const segSummary = await enrollSegment({
      sequenceId: seqA.id,
      segmentId: segment.id,
      enrolledBy: CEO_ID,
    });
    check(
      "segment enroll: 1 enrolled, 1 already_active, 1 skipped no_email",
      segSummary.total === 3 &&
        segSummary.enrolled === 1 &&
        segSummary.alreadyActive === 1 &&
        segSummary.skipped.length === 1 &&
        segSummary.skipped[0]!.entityId === clientF.id &&
        segSummary.skipped[0]!.outcome === "no_email",
      JSON.stringify(segSummary),
    );
    const enrE = (await listEnrollments(seqA.id, "active")).find(
      (e) => e.entityId === clientE.id,
    );
    check("segment enrollment stamped with its segment id",
      enrE?.segmentId === segment.id, enrE?.segmentId ?? "none");

    // ── 12. Cancel-on-reply: trigger event cancels enrollment + pending draft ─
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 3 } });
    const draft3 = await getStepSendForStep(enrA, seqASteps[2]!.id);
    check("step 3 draft pending before the reply", draft3?.status === "draft");
    const replyEvent = await insertTriggerEvent({
      triggerType: "front_inbound_reply",
      eventKey: `front_reply:test-${RUN}`,
      sourceId: `conv-${RUN}`,
      clientId: clientA.id,
      payload: {
        messageId: `msg-${RUN}`,
        receivedAt: new Date().toISOString(),
        subject: null,
      },
      attempts: 1,
    });
    assert(replyEvent, "trigger event row inserted");
    await processTriggerEvent(replyEvent);
    const enrAfterReply = await getEnrollment(enrA);
    check(
      "inbound reply cancelled the enrollment with reason 'replied'",
      enrAfterReply?.status === "cancelled" && enrAfterReply?.cancelReason === "replied",
      `${enrAfterReply?.status}/${enrAfterReply?.cancelReason}`,
    );
    check("cancellation is visible (cancelledAt + note)",
      !!enrAfterReply?.cancelledAt && !!enrAfterReply?.cancelNote,
      enrAfterReply?.cancelNote ?? "no note");
    const draft3After = await getStepSend(draft3!.id);
    check("pending draft discarded on reply", draft3After?.status === "cancelled",
      draft3After?.status);
    await handleEmailSequenceStepJob({ payload: { enrollmentId: enrA, stepOrder: 3 } });
    const rowsAfterReplyReplay = await db.execute(
      sql`SELECT count(*)::int AS n FROM email_sequence_step_sends WHERE enrollment_id = ${enrA} AND status IN ('draft','approved')`,
    );
    check("post-cancel replay sends nothing",
      (rowsAfterReplyReplay.rows[0] as { n: number }).n === 2 && alerts.length === 0,
      `pending=${JSON.stringify(rowsAfterReplyReplay.rows[0])} alerts=${alerts.length}`);

    // ── 13. Suppression: advance-time cancel + enroll-time refusal ───────────
    const enrCRes = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientC.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrCRes.outcome, "enrolled");
    await upsertEmailSuppression({
      email: rcpt("c"),
      reason: "manual",
      source: "manual",
      createdBy: CEO_ID,
    });
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrCRes.enrollmentId!, stepOrder: 1 },
    });
    const enrC = await getEnrollment(enrCRes.enrollmentId!);
    check("suppression at advance-time cancels (reason 'suppressed')",
      enrC?.status === "cancelled" && enrC?.cancelReason === "suppressed",
      `${enrC?.status}/${enrC?.cancelReason}`);
    check("suppressed advance minted NO send record",
      (await getStepSendForStep(enrCRes.enrollmentId!, seqASteps[0]!.id)) === undefined);
    const reEnrollC = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientC.id,
    });
    check("enroll-time suppression refused", reEnrollC.outcome === "suppressed",
      reEnrollC.outcome);

    // ── 14. Lifecycle exit: transition to customer cancels ───────────────────
    const enrDRes = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientD.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrDRes.outcome, "enrolled");
    await db.execute(
      sql`UPDATE clients SET lifecycle_stage = 'customer' WHERE id = ${clientD.id}`,
    );
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrDRes.enrollmentId!, stepOrder: 1 },
    });
    const enrD = await getEnrollment(enrDRes.enrollmentId!);
    check("lifecycle transition to customer cancels (reason 'lifecycle_exit')",
      enrD?.status === "cancelled" && enrD?.cancelReason === "lifecycle_exit",
      `${enrD?.status}/${enrD?.cancelReason}`);

    // ── 15. Unsubscribe-path helper cancels by email ─────────────────────────
    const cancelledByEmail = await cancelActiveEnrollmentsForEmail(
      rcpt("e"),
      "unsubscribed",
      "Unsubscribe link redeemed",
    );
    check("cancelActiveEnrollmentsForEmail cancelled the segment enrollee",
      cancelledByEmail === 1, `${cancelledByEmail}`);
    const enrEAfter = await getEnrollment(enrE!.id);
    check("unsubscribe cancel visible on the row",
      enrEAfter?.status === "cancelled" && enrEAfter?.cancelReason === "unsubscribed");

    // ── 16. Terminal enrollment frees the uniqueness slot; manual cancel ─────
    const reEnrollA = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientA.id,
      enrolledBy: CEO_ID,
    });
    check("re-enroll after terminal state allowed", reEnrollA.outcome === "enrolled",
      reEnrollA.outcome);
    const manualCancel = await cancelEnrollment(reEnrollA.enrollmentId!, "manual", "operator note");
    check("manual cancel succeeds", manualCancel === true);
    const manualCancel2 = await cancelEnrollment(reEnrollA.enrollmentId!, "manual");
    check("second manual cancel is a no-op (false)", manualCancel2 === false);

    // ── 17. Missing merge fields refuse auto-send; reject = skip → complete ──
    const enrBRes = await enrollEntity({
      sequenceId: seqB.id,
      entityType: "contact",
      entityId: contactB.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrBRes.outcome, "enrolled");
    const enrBRow = await getEnrollment(enrBRes.enrollmentId!);
    check("contact enrollment targets the contact's own email",
      enrBRow?.recipientEmail === rcpt("b-contact"), enrBRow?.recipientEmail);
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrBRes.enrollmentId!, stepOrder: 1 },
    });
    const draftB = await getStepSendForStep(enrBRes.enrollmentId!, seqBSteps[0]!.id);
    check(
      "auto-send ON but missing fields → stays draft for human review",
      draftB?.status === "draft" && (draftB?.missingFields ?? []).includes("deal.name"),
      `${draftB?.status}/${JSON.stringify(draftB?.missingFields)}`,
    );
    const batchB = await stepSendBatch(draftB!.id);
    check("no compose happened for the held draft", batchB.length === 0);
    const reject = await rejectStepSend({ stepSendId: draftB!.id, actorUserId: CEO_ID });
    check("reject → rejected (skip semantics)", reject.outcome === "rejected", reject.outcome);
    const enrBAfter = await getEnrollment(enrBRes.enrollmentId!);
    check("skipping the last step completes the enrollment",
      enrBAfter?.status === "completed" && !!enrBAfter?.completedAt,
      `${enrBAfter?.status}`);

    // ── 18. Analytics funnel matches every outcome above ─────────────────────
    const aA = await getSequenceAnalytics(seqA.id);
    check(
      "seq A funnel: 5 enrolled, 1 replied, 4 cancelled-other, 0 in progress/completed",
      !!aA &&
        aA.enrolled === 5 &&
        aA.replied === 1 &&
        aA.cancelledOther === 4 &&
        aA.inProgress === 0 &&
        aA.completed === 0,
      JSON.stringify(aA),
    );
    const s1 = aA?.perStep.find((p) => p.stepOrder === 1);
    const s2 = aA?.perStep.find((p) => p.stepOrder === 2);
    const s3 = aA?.perStep.find((p) => p.stepOrder === 3);
    check(
      "seq A per-step: step1 sent 1, step2 sent 1, step3 cancelled 1",
      s1?.approved === 1 && s2?.approved === 1 && s3?.cancelled === 1 && s3?.approved === 0,
      JSON.stringify(aA?.perStep),
    );
    const aB = await getSequenceAnalytics(seqB.id);
    check(
      "seq B funnel: 1 enrolled → 1 completed, step rejected 1",
      !!aB &&
        aB.enrolled === 1 &&
        aB.completed === 1 &&
        aB.perStep.find((p) => p.stepOrder === 1)?.rejected === 1,
      JSON.stringify(aB),
    );

    // ── 19. Eager lifecycle-exit: canonical writer cancels, no job needed ────
    const alertsLenBefore19 = alerts.length;
    const enrGRes = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientG.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrGRes.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrGRes.enrollmentId!, stepOrder: 1 },
    });
    const draftG = await getStepSendForStep(enrGRes.enrollmentId!, seqASteps[0]!.id);
    check("draft pending before lifecycle transition", draftG?.status === "draft",
      draftG?.status);
    const lcRes = await advanceClientLifecycle(clientG.id, "customer", { source: "deal_won" });
    check("canonical lifecycle writer reports the transition",
      lcRes.changed === true && lcRes.toStage === "customer",
      JSON.stringify({ changed: lcRes.changed, to: lcRes.toStage }));
    const stageG = await db.execute(
      sql`SELECT lifecycle_stage FROM clients WHERE id = ${clientG.id}`,
    );
    check("client row actually moved to customer",
      (stageG.rows[0] as { lifecycle_stage: string })?.lifecycle_stage === "customer",
      JSON.stringify(stageG.rows[0]));
    const enrG = await getEnrollment(enrGRes.enrollmentId!);
    check("customer entry cancelled the enrollment immediately (no job ran)",
      enrG?.status === "cancelled" && enrG?.cancelReason === "lifecycle_exit",
      `${enrG?.status}/${enrG?.cancelReason}`);
    const draftGAfter = await getStepSend(draftG!.id);
    check("pending draft discarded on lifecycle exit", draftGAfter?.status === "cancelled",
      draftGAfter?.status);
    const approveG = await approveStepSend({ stepSendId: draftG!.id, actorUserId: CEO_ID });
    check("drafted send can no longer be approved after lifecycle exit",
      approveG.outcome === "not_pending", approveG.outcome);
    check("no compose happened for the lifecycle-cancelled draft",
      (await stepSendBatch(draftG!.id)).length === 0);

    // ── 20. Manual suppression (admin-route helper) cancels eagerly ──────────
    const enrHRes = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientH.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrHRes.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrHRes.enrollmentId!, stepOrder: 1 },
    });
    const draftH = await getStepSendForStep(enrHRes.enrollmentId!, seqASteps[0]!.id);
    check("draft pending before manual suppression", draftH?.status === "draft",
      draftH?.status);
    await addEmailSuppressionWithSideEffects({
      email: rcpt("h"),
      reason: "manual",
      source: "manual",
      createdBy: CEO_ID,
      cancelNote: "Suppressed manually from the admin list",
    });
    const enrH = await getEnrollment(enrHRes.enrollmentId!);
    check("manual suppression cancelled the enrollment immediately",
      enrH?.status === "cancelled" && enrH?.cancelReason === "suppressed",
      `${enrH?.status}/${enrH?.cancelReason}`);
    const draftHAfter = await getStepSend(draftH!.id);
    check("pending draft discarded on manual suppression",
      draftHAfter?.status === "cancelled", draftHAfter?.status);
    const approveH = await approveStepSend({ stepSendId: draftH!.id, actorUserId: CEO_ID });
    check("drafted send can no longer be approved after manual suppression",
      approveH.outcome === "not_pending", approveH.outcome);

    // ── 21. Approve-time suppression backstop (direct row insert) ────────────
    const enrIRes = await enrollEntity({
      sequenceId: seqA.id,
      entityType: "client",
      entityId: clientI.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrIRes.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrIRes.enrollmentId!, stepOrder: 1 },
    });
    const draftI = await getStepSendForStep(enrIRes.enrollmentId!, seqASteps[0]!.id);
    check("draft pending before direct suppression insert", draftI?.status === "draft",
      draftI?.status);
    // Deliberately BYPASSES the side-effect helper: only the raw row exists,
    // so the approve-time backstop is the only line of defense here.
    await upsertEmailSuppression({
      email: rcpt("i"),
      reason: "manual",
      source: "manual",
      createdBy: CEO_ID,
    });
    const approveI = await approveStepSend({ stepSendId: draftI!.id, actorUserId: CEO_ID });
    check("approve refuses a suppressed recipient (backstop)",
      approveI.outcome === "suppressed", approveI.outcome);
    const enrI = await getEnrollment(enrIRes.enrollmentId!);
    check("backstop cancelled the enrollment",
      enrI?.status === "cancelled" && enrI?.cancelReason === "suppressed",
      `${enrI?.status}/${enrI?.cancelReason}`);
    const draftIAfter = await getStepSend(draftI!.id);
    check("draft cancelled by the backstop", draftIAfter?.status === "cancelled",
      draftIAfter?.status);
    check("no compose happened via the backstop path",
      (await stepSendBatch(draftI!.id)).length === 0);
    check("eager-cancel paths raised no alerts", alerts.length === alertsLenBefore19,
      `${alerts.length} vs ${alertsLenBefore19}`);

    // ── 22. AI personalization (Task #4478): drafts only, never auto-send ────
    const seqC = await createEmailSequence({
      name: `Seq C ai ${RUN}`,
      status: "active",
      autoSendEnabled: true, // deliberately ON — AI steps must ignore it
      createdBy: CEO_ID,
    });
    const seqCSteps = await replaceSequenceSteps(seqC.id, [
      { templateId: t1.id, delayMinutes: 0, aiPersonalizationEnabled: true },
    ]);
    check("step persists aiPersonalizationEnabled through replaceSequenceSteps",
      seqCSteps[0]?.aiPersonalizationEnabled === true);

    const aiCalls: Array<{ subject: string; bodyText: string; firmName: unknown }> = [];
    __setSequenceAiGenerateForTests(async (input) => {
      aiCalls.push({
        subject: input.subject,
        bodyText: input.bodyText,
        firmName: (input.ctx as Record<string, unknown>)["client.firmName"],
      });
      return { subject: `AI subject ${RUN}`, bodyText: `AI body ${RUN}` };
    });
    const enrSeqCAi = await enrollEntity({
      sequenceId: seqC.id,
      entityType: "client",
      entityId: clientA.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrSeqCAi.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrSeqCAi.enrollmentId!, stepOrder: 1 },
    });
    const draftC = await getStepSendForStep(enrSeqCAi.enrollmentId!, seqCSteps[0]!.id);
    check("AI step → DRAFT despite auto-send ON + complete merge",
      draftC?.status === "draft", draftC?.status ?? "missing");
    check("AI draft froze the AI content (text-only)",
      draftC?.renderedSubject === `AI subject ${RUN}` &&
        draftC?.renderedBodyText === `AI body ${RUN}` &&
        draftC?.renderedBodyHtml === null,
      JSON.stringify({ s: draftC?.renderedSubject, h: draftC?.renderedBodyHtml }));
    check("AI draft flagged aiPersonalized with no error",
      draftC?.aiPersonalized === true && draftC?.errorMessage === null,
      `${draftC?.aiPersonalized}/${draftC?.errorMessage}`);
    check("AI prompt received the rendered template + merge context",
      aiCalls.length === 1 &&
        aiCalls[0]!.subject === `Intro for Firm A ${RUN}` &&
        aiCalls[0]!.firmName === `Firm A ${RUN}`,
      JSON.stringify(aiCalls));
    check("no compose happened for the AI draft (auto-send skipped)",
      (await stepSendBatch(draftC!.id)).length === 0);

    // ── 23. Drafts are editable before approval; frozen after ────────────────
    const edited = await editStepSendDraft({
      stepSendId: draftC!.id,
      subject: `Edited subject ${RUN}`,
      bodyText: `Edited body ${RUN}`,
    });
    check("draft edit accepted", edited.outcome === "edited", edited.outcome);
    const draftCEdited = await getStepSend(draftC!.id);
    check("edit froze the operator's content and cleared advisories",
      draftCEdited?.renderedSubject === `Edited subject ${RUN}` &&
        draftCEdited?.renderedBodyText === `Edited body ${RUN}` &&
        draftCEdited?.renderedBodyHtml === null &&
        (draftCEdited?.missingFields ?? ["x"]).length === 0 &&
        draftCEdited?.errorMessage === null,
      JSON.stringify(draftCEdited?.renderedSubject));
    const approveC = await approveStepSend({ stepSendId: draftC!.id, actorUserId: CEO_ID });
    check("edited AI draft approves and composes", approveC.outcome === "sent",
      approveC.outcome);
    const editAfterApprove = await editStepSendDraft({
      stepSendId: draftC!.id,
      subject: "too late",
      bodyText: "too late",
    });
    check("approved content is immutable (edit → not_pending)",
      editAfterApprove.outcome === "not_pending", editAfterApprove.outcome);

    // ── 24. AI failure → fallback draft with visible reason ─────────────────
    __setSequenceAiGenerateForTests(async () => {
      throw new Error(`vendor down ${RUN}`);
    });
    const seqD = await createEmailSequence({
      name: `Seq D ai-fail ${RUN}`,
      status: "active",
      autoSendEnabled: true,
      createdBy: CEO_ID,
    });
    const seqDSteps = await replaceSequenceSteps(seqD.id, [
      { templateId: t1.id, delayMinutes: 0, aiPersonalizationEnabled: true },
    ]);
    const enrAiDRes = await enrollEntity({
      sequenceId: seqD.id,
      entityType: "client",
      entityId: clientA.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrAiDRes.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrAiDRes.enrollmentId!, stepOrder: 1 },
    });
    const draftD = await getStepSendForStep(enrAiDRes.enrollmentId!, seqDSteps[0]!.id);
    check("AI failure → step held as draft (never blocks, never sends)",
      draftD?.status === "draft", draftD?.status ?? "missing");
    check("fallback draft shows the TEMPLATE content, not AI output",
      draftD?.renderedSubject === `Intro for Firm A ${RUN}` && draftD?.aiPersonalized === false,
      JSON.stringify({ s: draftD?.renderedSubject, ai: draftD?.aiPersonalized }));
    check("AI-failure reason visible on the draft",
      (draftD?.errorMessage ?? "").startsWith("AI personalization failed:") &&
        (draftD?.errorMessage ?? "").includes(`vendor down ${RUN}`),
      draftD?.errorMessage ?? "none");
    check("no compose for the AI-failure draft despite auto-send ON",
      (await stepSendBatch(draftD!.id)).length === 0);
    check("AI paths raised no alerts", alerts.length === alertsLenBefore19,
      `${alerts.length}`);
    __setSequenceAiGenerateForTests(null);

    // ── 25. Hermetic default: AI path with NO stub falls back visibly ───────
    // (test mode must never reach the vendor; unset stub throws → fallback)
    const seqE = await createEmailSequence({
      name: `Seq E ai-nostub ${RUN}`,
      status: "active",
      autoSendEnabled: false,
      createdBy: CEO_ID,
    });
    const seqESteps = await replaceSequenceSteps(seqE.id, [
      { templateId: t1.id, delayMinutes: 0, aiPersonalizationEnabled: true },
    ]);
    const enrERes2 = await enrollEntity({
      sequenceId: seqE.id,
      entityType: "client",
      entityId: clientA.id,
      enrolledBy: CEO_ID,
    });
    assert.equal(enrERes2.outcome, "enrolled");
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: enrERes2.enrollmentId!, stepOrder: 1 },
    });
    const draftE = await getStepSendForStep(enrERes2.enrollmentId!, seqESteps[0]!.id);
    check("no-stub test mode → fallback draft with stub-not-set reason",
      draftE?.status === "draft" &&
        draftE?.aiPersonalized === false &&
        (draftE?.errorMessage ?? "").includes("stub not set"),
      JSON.stringify({ st: draftE?.status, e: draftE?.errorMessage }));

    // Kill switch really restored (paranoia — shared-setting hygiene).
    const killAfter = await getSystemSettingFresh(EMAIL_SEQUENCES_PAUSED_KEY);
    check("kill switch restored to false", killAfter?.value !== "true", killAfter?.value);
  } finally {
    __setEmailSequenceAlertNotifyForTests(null);
    __setSequenceAiGenerateForTests(null);
    await setSystemSetting(EMAIL_SEQUENCES_PAUSED_KEY, "false", CEO_ID).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await closeDbPools();
}
