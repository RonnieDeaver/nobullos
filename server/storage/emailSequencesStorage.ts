// @db-pool-intent: ambient
//
// Task #4335 — storage for email templates + approval-gated sequences:
// template library, sequence/step definitions, enrollments (with the
// active-uniqueness guard) and the per-(enrollment, step) send-claim
// ledger. All double-send defenses live in UNIQUE indexes + CAS updates
// here — callers must treat "0 rows returned" as "someone else already
// did this" and no-op.

import {
  emailTemplates,
  type EmailTemplate,
  type InsertEmailTemplate,
  emailSequences,
  type EmailSequence,
  type InsertEmailSequence,
  emailSequenceSteps,
  type EmailSequenceStep,
  emailSequenceEnrollments,
  type EmailSequenceEnrollment,
  type InsertEmailSequenceEnrollment,
  emailSequenceStepSends,
  type EmailSequenceStepSend,
  type InsertEmailSequenceStepSend,
  type EnrollmentCancelReason,
  type EnrollmentStatus,
  type StepSendStatus,
  emailTemplatePatchSchema,
  type EmailTemplatePatch,
  emailSequencePatchSchema,
  type EmailSequencePatch,
  type EmailSequenceEnrollmentPatch,
  type EmailSequenceCasAdvancePatch,
  type EmailSequenceStepSendPatch,
  emailSequenceEnrollmentPatchSchema,
  emailSequenceCasAdvancePatchSchema,
  emailSequenceStepSendPatchSchema,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

// ── Templates ────────────────────────────────────────────────────────────────

export async function createEmailTemplate(data: InsertEmailTemplate): Promise<EmailTemplate> {
  return withDbAttribution("emailSequences:createTemplate", async () => {
    const [row] = await getDb().insert(emailTemplates).values(data).returning();
    return row;
  });
}

export async function updateEmailTemplate(
  id: string,
  patch: EmailTemplatePatch,
): Promise<EmailTemplate | undefined> {
  return withDbAttribution("emailSequences:updateTemplate", async () => {
    // F8 boundary (Task #4548): runtime-parse to the focused content shape —
    // unknown keys are stripped; audit stamps stay server-controlled here.
    const parsed = emailTemplatePatchSchema.parse(patch);
    const [row] = await getDb()
      .update(emailTemplates)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(emailTemplates.id, id))
      .returning();
    return row;
  });
}

export async function getEmailTemplate(id: string): Promise<EmailTemplate | undefined> {
  return withDbAttribution("emailSequences:getTemplate", async () => {
    const [row] = await getDb()
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, id))
      .limit(1);
    return row;
  });
}

export async function listEmailTemplates(includeArchived: boolean): Promise<EmailTemplate[]> {
  return withDbAttribution("emailSequences:listTemplates", async () => {
    const where = includeArchived ? undefined : eq(emailTemplates.archived, false);
    const q = getDb().select().from(emailTemplates);
    return (where ? q.where(where) : q).orderBy(desc(emailTemplates.createdAt)).limit(500);
  });
}

// ── Sequences + steps ────────────────────────────────────────────────────────

export async function createEmailSequence(data: InsertEmailSequence): Promise<EmailSequence> {
  return withDbAttribution("emailSequences:createSequence", async () => {
    const [row] = await getDb().insert(emailSequences).values(data).returning();
    return row;
  });
}

export async function updateEmailSequence(
  id: string,
  patch: EmailSequencePatch,
): Promise<EmailSequence | undefined> {
  return withDbAttribution("emailSequences:updateSequence", async () => {
    // F8 boundary (Task #4548): runtime-parse to the focused patch shape
    // (name/description/status/autoSendEnabled); ownership/audit stay out.
    const parsed = emailSequencePatchSchema.parse(patch);
    const [row] = await getDb()
      .update(emailSequences)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(emailSequences.id, id))
      .returning();
    return row;
  });
}

export async function getEmailSequence(id: string): Promise<EmailSequence | undefined> {
  return withDbAttribution("emailSequences:getSequence", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequences)
      .where(eq(emailSequences.id, id))
      .limit(1);
    return row;
  });
}

export async function listEmailSequences(): Promise<EmailSequence[]> {
  return withDbAttribution("emailSequences:listSequences", async () => {
    return getDb().select().from(emailSequences).orderBy(desc(emailSequences.createdAt)).limit(500);
  });
}

/** step + active-enrollment counts for the sequences list, one query each. */
export async function getSequenceListCounts(): Promise<{
  steps: Map<string, number>;
  activeEnrollments: Map<string, number>;
  pendingDrafts: Map<string, number>;
}> {
  return withDbAttribution("emailSequences:listCounts", async () => {
    const stepRows = await getDb()
      .select({ sequenceId: emailSequenceSteps.sequenceId, n: sql<number>`count(*)::int` })
      .from(emailSequenceSteps)
      .groupBy(emailSequenceSteps.sequenceId);
    const enrollRows = await getDb()
      .select({ sequenceId: emailSequenceEnrollments.sequenceId, n: sql<number>`count(*)::int` })
      .from(emailSequenceEnrollments)
      .where(eq(emailSequenceEnrollments.status, "active"))
      .groupBy(emailSequenceEnrollments.sequenceId);
    const draftRows = await getDb()
      .select({ sequenceId: emailSequenceStepSends.sequenceId, n: sql<number>`count(*)::int` })
      .from(emailSequenceStepSends)
      .where(inArray(emailSequenceStepSends.status, ["draft", "render_failed"]))
      .groupBy(emailSequenceStepSends.sequenceId);
    return {
      steps: new Map(stepRows.map((r) => [r.sequenceId, r.n])),
      activeEnrollments: new Map(enrollRows.map((r) => [r.sequenceId, r.n])),
      pendingDrafts: new Map(draftRows.map((r) => [r.sequenceId, r.n])),
    };
  });
}

/**
 * Replace the full step list atomically. Route-guarded to sequences with
 * ZERO active enrollments — in-flight runs must never have steps swapped
 * under them (the job payload's stepOrder would silently point elsewhere).
 */
export async function replaceSequenceSteps(
  sequenceId: string,
  steps: Array<{ templateId: string; delayMinutes: number; aiPersonalizationEnabled?: boolean }>,
): Promise<EmailSequenceStep[]> {
  return withDbAttribution("emailSequences:replaceSteps", async () => {
    return getDb().transaction(async (tx) => {
      await tx.delete(emailSequenceSteps).where(eq(emailSequenceSteps.sequenceId, sequenceId));
      if (steps.length === 0) return [];
      return tx
        .insert(emailSequenceSteps)
        .values(
          steps.map((s, i) => ({
            sequenceId,
            stepOrder: i + 1,
            templateId: s.templateId,
            delayMinutes: s.delayMinutes,
            aiPersonalizationEnabled: s.aiPersonalizationEnabled ?? false,
          })),
        )
        .returning();
    });
  });
}

export async function listSequenceSteps(sequenceId: string): Promise<EmailSequenceStep[]> {
  return withDbAttribution("emailSequences:listSteps", async () => {
    return getDb()
      .select()
      .from(emailSequenceSteps)
      .where(eq(emailSequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(emailSequenceSteps.stepOrder));
  });
}

export async function getSequenceStep(
  sequenceId: string,
  stepOrder: number,
): Promise<EmailSequenceStep | undefined> {
  return withDbAttribution("emailSequences:getStep", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequenceSteps)
      .where(
        and(
          eq(emailSequenceSteps.sequenceId, sequenceId),
          eq(emailSequenceSteps.stepOrder, stepOrder),
        ),
      )
      .limit(1);
    return row;
  });
}

/** The next defined step AFTER a given order (steps need not be contiguous). */
export async function getNextSequenceStep(
  sequenceId: string,
  afterOrder: number,
): Promise<EmailSequenceStep | undefined> {
  return withDbAttribution("emailSequences:getNextStep", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequenceSteps)
      .where(
        and(
          eq(emailSequenceSteps.sequenceId, sequenceId),
          gt(emailSequenceSteps.stepOrder, afterOrder),
        ),
      )
      .orderBy(asc(emailSequenceSteps.stepOrder))
      .limit(1);
    return row;
  });
}

export async function countActiveEnrollments(sequenceId: string): Promise<number> {
  return withDbAttribution("emailSequences:countActiveEnrollments", async () => {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(emailSequenceEnrollments)
      .where(
        and(
          eq(emailSequenceEnrollments.sequenceId, sequenceId),
          eq(emailSequenceEnrollments.status, "active"),
        ),
      );
    return row?.n ?? 0;
  });
}

// ── Enrollments ──────────────────────────────────────────────────────────────

/**
 * THE enrollment write. ON CONFLICT DO NOTHING against the partial active
 * unique index — a concurrent/duplicate enrollment returns undefined and
 * the caller reports "already active" instead of inserting a second run.
 */
export async function insertEnrollmentIfAbsent(
  data: InsertEmailSequenceEnrollment,
): Promise<EmailSequenceEnrollment | undefined> {
  return withDbAttribution("emailSequences:insertEnrollment", async () => {
    const [row] = await getDb()
      .insert(emailSequenceEnrollments)
      .values(data)
      .onConflictDoNothing()
      .returning();
    return row;
  });
}

export async function getEnrollment(id: string): Promise<EmailSequenceEnrollment | undefined> {
  return withDbAttribution("emailSequences:getEnrollment", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequenceEnrollments)
      .where(eq(emailSequenceEnrollments.id, id))
      .limit(1);
    return row;
  });
}

export async function listEnrollments(
  sequenceId: string,
  status?: EnrollmentStatus,
): Promise<EmailSequenceEnrollment[]> {
  return withDbAttribution("emailSequences:listEnrollments", async () => {
    const conds = [eq(emailSequenceEnrollments.sequenceId, sequenceId)];
    if (status) conds.push(eq(emailSequenceEnrollments.status, status));
    return getDb()
      .select()
      .from(emailSequenceEnrollments)
      .where(and(...conds))
      .orderBy(desc(emailSequenceEnrollments.createdAt))
      .limit(500);
  });
}

/** Generic bookkeeping update (nextStepAt on defers etc.) — never flips status. */
export async function updateEnrollment(
  id: string,
  patch: EmailSequenceEnrollmentPatch,
): Promise<void> {
  return withDbAttribution("emailSequences:updateEnrollment", async () => {
    // F8 boundary (Task #4521): runtime-parse to the focused bookkeeping
    // shape — status/CAS/identity columns stay with their dedicated writers.
    const parsed = emailSequenceEnrollmentPatchSchema.parse(patch);
    await getDb()
      .update(emailSequenceEnrollments)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(emailSequenceEnrollments.id, id));
  });
}

/**
 * CAS advance — the step-gate's write half. Only succeeds while the
 * enrollment is still ACTIVE at exactly `fromStepOrder`; a replayed or
 * concurrent advance returns undefined and the caller MUST not compose.
 */
export async function casAdvanceEnrollment(
  id: string,
  fromStepOrder: number,
  patch: EmailSequenceCasAdvancePatch,
): Promise<EmailSequenceEnrollment | undefined> {
  return withDbAttribution("emailSequences:casAdvanceEnrollment", async () => {
    // F8 boundary (Task #4521): runtime-parse to the CAS transition shape —
    // identity/audit columns are structurally absent, status is confined to
    // the advance vocabulary (cancellation has its own dedicated writer).
    const parsed = emailSequenceCasAdvancePatchSchema.parse(patch);
    const [row] = await getDb()
      .update(emailSequenceEnrollments)
      .set({ ...parsed, updatedAt: new Date() })
      .where(
        and(
          eq(emailSequenceEnrollments.id, id),
          eq(emailSequenceEnrollments.status, "active"),
          eq(emailSequenceEnrollments.currentStepOrder, fromStepOrder),
        ),
      )
      .returning();
    return row;
  });
}

/** Cancel exactly one ACTIVE enrollment (no-op if already terminal). */
export async function cancelEnrollmentRow(
  id: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<EmailSequenceEnrollment | undefined> {
  return withDbAttribution("emailSequences:cancelEnrollment", async () => {
    const [row] = await getDb()
      .update(emailSequenceEnrollments)
      .set({
        status: "cancelled",
        cancelReason: reason,
        cancelNote: note ?? null,
        cancelledAt: new Date(),
        nextStepAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(emailSequenceEnrollments.id, id), eq(emailSequenceEnrollments.status, "active")),
      )
      .returning();
    return row;
  });
}

/**
 * Atomically closes one active enrollment and cancels its unsent drafts.
 * Webhook retry semantics depend on both writes committing together: a partial
 * cancellation must never leave a terminal enrollment with an approvable draft.
 */
export async function cancelEnrollmentAndPendingStepSends(
  id: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<boolean> {
  return withDbAttribution("emailSequences:cancelEnrollmentAndDrafts", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(emailSequenceEnrollments)
        .set({
          status: "cancelled",
          cancelReason: reason,
          cancelNote: note ?? null,
          cancelledAt: new Date(),
          nextStepAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailSequenceEnrollments.id, id),
            eq(emailSequenceEnrollments.status, "active"),
          ),
        )
        .returning({ id: emailSequenceEnrollments.id });
      if (!row) return false;

      await tx
        .update(emailSequenceStepSends)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(emailSequenceStepSends.enrollmentId, id),
            inArray(emailSequenceStepSends.status, ["draft", "render_failed"]),
          ),
        );
      return true;
    });
  });
}

export async function listActiveEnrollmentsByClient(
  clientId: string,
): Promise<EmailSequenceEnrollment[]> {
  return withDbAttribution("emailSequences:activeByClient", async () => {
    return getDb()
      .select()
      .from(emailSequenceEnrollments)
      .where(
        and(
          eq(emailSequenceEnrollments.clientId, clientId),
          eq(emailSequenceEnrollments.status, "active"),
        ),
      );
  });
}

export async function listActiveEnrollmentsByEmail(
  email: string,
): Promise<EmailSequenceEnrollment[]> {
  return withDbAttribution("emailSequences:activeByEmail", async () => {
    return getDb()
      .select()
      .from(emailSequenceEnrollments)
      .where(
        and(
          eq(emailSequenceEnrollments.recipientEmail, email),
          eq(emailSequenceEnrollments.status, "active"),
        ),
      );
  });
}

/** Funnel counts: status totals plus the replied bucket. */
export async function enrollmentStatusCounts(sequenceId: string): Promise<
  Array<{ status: string; cancelReason: string | null; n: number }>
> {
  return withDbAttribution("emailSequences:enrollmentCounts", async () => {
    return getDb()
      .select({
        status: emailSequenceEnrollments.status,
        cancelReason: emailSequenceEnrollments.cancelReason,
        n: sql<number>`count(*)::int`,
      })
      .from(emailSequenceEnrollments)
      .where(eq(emailSequenceEnrollments.sequenceId, sequenceId))
      .groupBy(emailSequenceEnrollments.status, emailSequenceEnrollments.cancelReason);
  });
}

// ── Step sends (claim ledger) ────────────────────────────────────────────────

/**
 * THE claim write. ON CONFLICT DO NOTHING against the (enrollment, step)
 * unique index — undefined means the step already has a send record and
 * the worker must no-op (duplicate-send defense).
 */
export async function insertStepSendIfAbsent(
  data: InsertEmailSequenceStepSend,
): Promise<EmailSequenceStepSend | undefined> {
  return withDbAttribution("emailSequences:insertStepSend", async () => {
    const [row] = await getDb()
      .insert(emailSequenceStepSends)
      .values(data)
      .onConflictDoNothing()
      .returning();
    return row;
  });
}

export async function getStepSend(id: string): Promise<EmailSequenceStepSend | undefined> {
  return withDbAttribution("emailSequences:getStepSend", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequenceStepSends)
      .where(eq(emailSequenceStepSends.id, id))
      .limit(1);
    return row;
  });
}

export async function getStepSendForStep(
  enrollmentId: string,
  stepId: string,
): Promise<EmailSequenceStepSend | undefined> {
  return withDbAttribution("emailSequences:getStepSendForStep", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSequenceStepSends)
      .where(
        and(
          eq(emailSequenceStepSends.enrollmentId, enrollmentId),
          eq(emailSequenceStepSends.stepId, stepId),
        ),
      )
      .limit(1);
    return row;
  });
}

/**
 * CAS status transition (draft→approved, draft→rejected, …). Losing the
 * CAS (0 rows) means a concurrent actor got there first — callers report
 * the current state instead of double-acting.
 */
export async function casUpdateStepSend(
  id: string,
  fromStatuses: StepSendStatus[],
  patch: EmailSequenceStepSendPatch,
): Promise<EmailSequenceStepSend | undefined> {
  return withDbAttribution("emailSequences:casUpdateStepSend", async () => {
    // F8 boundary (Task #4548): even internal-literal patches go through the
    // focused parse — claim-ledger linkage/pinning columns stay unwritable.
    const parsed = emailSequenceStepSendPatchSchema.parse(patch);
    const [row] = await getDb()
      .update(emailSequenceStepSends)
      .set({ ...parsed, updatedAt: new Date() })
      .where(
        and(
          eq(emailSequenceStepSends.id, id),
          inArray(emailSequenceStepSends.status, fromStatuses),
        ),
      )
      .returning();
    return row;
  });
}

/** Non-status bookkeeping (outbound linkage, error messages). */
export async function updateStepSend(
  id: string,
  patch: EmailSequenceStepSendPatch,
): Promise<void> {
  return withDbAttribution("emailSequences:updateStepSend", async () => {
    // F8 boundary (Task #4548): same focused parse as casUpdateStepSend.
    const parsed = emailSequenceStepSendPatchSchema.parse(patch);
    await getDb()
      .update(emailSequenceStepSends)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(emailSequenceStepSends.id, id));
  });
}

export interface ApprovalQueueItem extends EmailSequenceStepSend {
  sequenceName: string;
  clientId: string;
  entityType: string;
  entityId: string;
}

/** Pending human work: drafts + render failures, oldest first. */
export async function listApprovalQueue(params: {
  sequenceId?: string;
  limit?: number;
}): Promise<ApprovalQueueItem[]> {
  return withDbAttribution("emailSequences:approvalQueue", async () => {
    const conds = [inArray(emailSequenceStepSends.status, ["draft", "render_failed"])];
    if (params.sequenceId) conds.push(eq(emailSequenceStepSends.sequenceId, params.sequenceId));
    const rows = await getDb()
      .select({
        send: emailSequenceStepSends,
        sequenceName: emailSequences.name,
        clientId: emailSequenceEnrollments.clientId,
        entityType: emailSequenceEnrollments.entityType,
        entityId: emailSequenceEnrollments.entityId,
      })
      .from(emailSequenceStepSends)
      .innerJoin(emailSequences, eq(emailSequenceStepSends.sequenceId, emailSequences.id))
      .innerJoin(
        emailSequenceEnrollments,
        eq(emailSequenceStepSends.enrollmentId, emailSequenceEnrollments.id),
      )
      .where(and(...conds))
      .orderBy(asc(emailSequenceStepSends.createdAt))
      .limit(params.limit ?? 200);
    return rows.map((r) => ({
      ...r.send,
      sequenceName: r.sequenceName,
      clientId: r.clientId,
      entityType: r.entityType,
      entityId: r.entityId,
    }));
  });
}

/** Follows enrollment cancellation: pending drafts become `cancelled`. */
export async function cancelPendingStepSendsForEnrollment(
  enrollmentId: string,
): Promise<number> {
  return withDbAttribution("emailSequences:cancelPendingStepSends", async () => {
    const rows = await getDb()
      .update(emailSequenceStepSends)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(emailSequenceStepSends.enrollmentId, enrollmentId),
          inArray(emailSequenceStepSends.status, ["draft", "render_failed"]),
        ),
      )
      .returning({ id: emailSequenceStepSends.id });
    return rows.length;
  });
}

/** Per-step outcome counts for the analytics funnel. */
export async function stepSendCountsBySequence(sequenceId: string): Promise<
  Array<{ stepOrder: number; status: string; n: number }>
> {
  return withDbAttribution("emailSequences:stepSendCounts", async () => {
    return getDb()
      .select({
        stepOrder: emailSequenceStepSends.stepOrder,
        status: emailSequenceStepSends.status,
        n: sql<number>`count(*)::int`,
      })
      .from(emailSequenceStepSends)
      .where(eq(emailSequenceStepSends.sequenceId, sequenceId))
      .groupBy(emailSequenceStepSends.stepOrder, emailSequenceStepSends.status);
  });
}
