// @db-pool-intent: ambient
// (Called from routes in API-request context and from the work-queue step
// handler under runWithWorkerDb; inherits whichever pool the caller set.)
//
// Task #4335 — email templates and approval-gated sequences.
//
// The automation layer over the outbound email seam (Task #4334): merge-
// field templates, fixed-step sequences (email + wait delay), enrollment,
// and a draft-by-default approval queue. Governor L2 — the double-send bug
// class is the named enemy. Layered defenses, in order:
//
//   1. Enrollment uniqueness — partial unique index, ON CONFLICT DO NOTHING
//      (a contact can never be in the same sequence twice concurrently).
//   2. Payload step-gate — a job only acts when its stepOrder is EXACTLY
//      the enrollment's next expected step; stale/replayed jobs no-op.
//   3. Claim ledger — UNIQUE(enrollment, step) send record inserted with
//      ON CONFLICT DO NOTHING; losing the insert means the step was already
//      handled. A lost claim against an already-APPROVED record raises the
//      duplicate-send alert (systemic replay bug — noticed, not absorbed).
//   4. CAS transitions — approval (draft→approved) and enrollment advance
//      (currentStepOrder N-1→N while active) are compare-and-set; compose
//      runs ONLY after both CAS wins.
//   5. The outbound seam's own idempotency (clientBatchKey + per-row claim)
//      backstops everything downstream.
//
// Content is FROZEN at draft time — what the approver saw is what sends.
// Delays count from the previous step's approval (or from enrollment).

import {
  clientContacts,
  deals,
  type Client,
  type ClientContact,
  type Deal,
  type EmailSequence,
  type EmailSequenceEnrollment,
  type EmailSequenceStep,
  type EmailSequenceStepSend,
  type EmailTemplate,
  type EnrollmentCancelReason,
  type EnrollmentEntityType,
  type User,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { and, desc, eq } from "drizzle-orm";
import {
  cancelEnrollmentAndPendingStepSends,
  casAdvanceEnrollment,
  casUpdateStepSend,
  enrollmentStatusCounts,
  getEmailSequence,
  getEmailTemplate,
  getEnrollment,
  getNextSequenceStep,
  getStepSend,
  getStepSendForStep,
  insertEnrollmentIfAbsent,
  insertStepSendIfAbsent,
  listActiveEnrollmentsByClient,
  listActiveEnrollmentsByEmail,
  listSequenceSteps,
  stepSendCountsBySequence,
  updateEnrollment,
  updateStepSend,
} from "../storage/emailSequencesStorage";
import { isEmailSuppressed, normalizeEmailAddress } from "../storage/outboundEmailStorage";
import { getClient, getUser } from "../storage/clientStorage";
import { getSegment, listSegmentMembers } from "../storage/tagsSegmentsStorage";
import { getSystemSettingFresh } from "../storage/settingsStorage";
import { composeOutboundEmails } from "./outboundEmail";
import { listOutboundEmailsByBatch } from "../storage/outboundEmailStorage";

// ── Constants ────────────────────────────────────────────────────────────────

export const EMAIL_SEQUENCE_QUEUE = "email_sequence_step";

/** Global kill switch: 'true' pauses ALL sequence advancement (steps defer,
 *  never fail or send). CEO-gated write. */
export const EMAIL_SEQUENCES_PAUSED_KEY = "email_sequences_paused";

/** Deferred-step recheck interval while paused (global or per-sequence). */
const PAUSE_DEFER_MS = 30 * 60 * 1000;

/** Segment enrollment is bounded per call — a fat-finger on a huge segment
 *  must not fan out unbounded outreach in one press. */
export const SEGMENT_ENROLL_CAP = 1000;

export const EMAIL_SEQ_DUPLICATE_ALERT_ID = "workflow.email_sequences.duplicate_step_send";
export const EMAIL_SEQ_RENDER_FAILED_ALERT_ID = "workflow.email_sequences.render_failed";

// ── Alerting (leaf-alert-sink pattern; keeps this module test-hermetic) ─────

type EmailSequenceAlertNotify = (
  registryId: string,
  dedupeKey: string,
  text: string,
  preview: Record<string, unknown>,
) => Promise<void>;

let testAlertNotify: EmailSequenceAlertNotify | null = null;

export function __setEmailSequenceAlertNotifyForTests(fn: EmailSequenceAlertNotify | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setEmailSequenceAlertNotifyForTests is test-only");
  }
  testAlertNotify = fn;
}

async function alertEmailSequences(
  registryId: string,
  dedupeKey: string,
  text: string,
  preview: Record<string, unknown>,
): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test") {
      await testAlertNotify?.(registryId, dedupeKey, text, preview);
      return;
    }
    const { notifyByType } = await import("./notifications/dispatcher");
    await notifyByType(
      registryId,
      { text, preview },
      { triggerSource: "alert_service", dedupeKey, mirrorDeepLink: "/admin/email-sequences" },
    );
  } catch (err) {
    // Alerting must never take the sequence pipeline down with it.
    console.error(
      `[email-sequences] alert dispatch failed (${registryId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Merge fields ─────────────────────────────────────────────────────────────

/**
 * The full merge vocabulary. Templates are validated against this at save
 * time — an unknown token is a 400, never a silently-sent literal.
 * Values come from the enrollment's pinned recipient/sender plus live
 * client/contact/deal reads at RENDER time (draft creation).
 */
export const MERGE_FIELD_VOCABULARY: Record<string, string> = {
  "contact.name": "Contact full name (falls back to the client's contact name)",
  "contact.firstName": "Contact first name",
  "contact.email": "Recipient email address (pinned at enrollment)",
  "contact.roleTitle": "Contact role/title",
  "client.firmName": "Client firm name",
  "client.contactName": "Client primary contact name",
  "deal.name": "Most recent open deal name",
  "deal.amount": "Most recent open deal amount (USD)",
  "sender.name": "Sender full name",
  "sender.firstName": "Sender first name",
  "sender.email": "Sender email address",
};

/** {{entity.field}} or {{entity.field|fallback text}} */
const MERGE_TOKEN_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)\s*(?:\|([^{}]*))?\}\}/g;

/** Unknown tokens in a template string (save-time validation). */
export function findUnknownMergeTokens(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(MERGE_TOKEN_RE)) {
    const token = match[1];
    if (!(token in MERGE_FIELD_VOCABULARY)) unknown.add(token);
  }
  return [...unknown];
}

export type MergeContext = Record<string, string | null>;

function firstWord(value: string | null | undefined): string | null {
  if (!value) return null;
  const w = value.trim().split(/\s+/)[0];
  return w || null;
}

export function buildMergeContext(inputs: {
  client: Client | undefined;
  contact: ClientContact | undefined;
  deal: Deal | undefined;
  sender: User | undefined;
  recipientEmail: string;
}): MergeContext {
  const { client, contact, deal, sender } = inputs;
  const contactName = contact?.name ?? client?.contactName ?? null;
  const senderName =
    [sender?.firstName, sender?.lastName].filter(Boolean).join(" ").trim() || null;
  return {
    "contact.name": contactName,
    "contact.firstName": firstWord(contactName),
    "contact.email": inputs.recipientEmail || null,
    "contact.roleTitle": contact?.roleTitle ?? null,
    "client.firmName": client?.firmName ?? null,
    "client.contactName": client?.contactName ?? null,
    "deal.name": deal?.name ?? null,
    "deal.amount":
      deal?.amount != null ? `$${Number(deal.amount).toLocaleString("en-US")}` : null,
    "sender.name": senderName,
    "sender.firstName": firstWord(senderName) ?? firstWord(sender?.email ?? null),
    "sender.email": sender?.email ?? null,
  };
}

/**
 * Render one string against the context. A token with no value uses its
 * `|fallback` when present; otherwise it renders empty AND is reported in
 * `missing` — the approval queue shows these, and auto-send refuses to
 * fire while any are present (a human must look at incomplete merges).
 */
export function renderMergeText(
  template: string,
  ctx: MergeContext,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(MERGE_TOKEN_RE, (_all, token: string, fallback?: string) => {
    const value = ctx[token];
    if (value != null && value !== "") return value;
    if (fallback !== undefined) return fallback;
    missing.add(token);
    return "";
  });
  return { text, missing: [...missing] };
}

// Cross-model readers scoped to rendering (contact by id; latest open deal).

async function getContactById(id: string): Promise<ClientContact | undefined> {
  return withDbAttribution("emailSequences:getContactById", async () => {
    const [row] = await getDb()
      .select()
      .from(clientContacts)
      .where(eq(clientContacts.id, id))
      .limit(1);
    return row;
  });
}

async function getLatestOpenDealForClient(clientId: string): Promise<Deal | undefined> {
  return withDbAttribution("emailSequences:getLatestDeal", async () => {
    const [row] = await getDb()
      .select()
      .from(deals)
      .where(and(eq(deals.clientId, clientId), eq(deals.isArchived, false)))
      .orderBy(desc(deals.createdAt))
      .limit(1);
    return row;
  });
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  missing: string[];
  /** The merge context the render used — Task #4478: also feeds the AI
   *  personalization prompt so both paths see identical facts. */
  ctx: MergeContext;
}

/** Load live context and render a template for a (pinned) recipient. */
export async function renderTemplateForTarget(
  template: Pick<EmailTemplate, "subject" | "bodyText" | "bodyHtml">,
  target: {
    entityType: EnrollmentEntityType;
    entityId: string;
    clientId: string;
    recipientEmail: string;
    senderUserId: string;
  },
): Promise<RenderedEmail> {
  const [client, contact, deal, sender] = await Promise.all([
    getClient(target.clientId),
    target.entityType === "contact" ? getContactById(target.entityId) : Promise.resolve(undefined),
    getLatestOpenDealForClient(target.clientId),
    getUser(target.senderUserId),
  ]);
  const ctx = buildMergeContext({
    client,
    contact,
    deal,
    sender,
    recipientEmail: target.recipientEmail,
  });
  const subject = renderMergeText(template.subject, ctx);
  const bodyText = renderMergeText(template.bodyText, ctx);
  const bodyHtml = template.bodyHtml ? renderMergeText(template.bodyHtml, ctx) : null;
  const missing = [...new Set([...subject.missing, ...bodyText.missing, ...(bodyHtml?.missing ?? [])])];
  return {
    subject: subject.text,
    bodyText: bodyText.text,
    bodyHtml: bodyHtml?.text ?? null,
    missing,
    ctx,
  };
}

// ── AI personalization (Task #4478) ─────────────────────────────────────────
//
// Per-step opt-in: the worker asks the AI to personalize the merge-rendered
// template. Success or failure, the result is ALWAYS a draft in the approval
// queue — auto-send stays template-only. Failures fall back to the plain
// template render with the reason stored on the draft (same "human must
// look" contract as missing merge fields).

type SequenceAiGenerate = (input: {
  subject: string;
  bodyText: string;
  ctx: MergeContext;
}) => Promise<{ subject: string; bodyText: string }>;

let testAiGenerate: SequenceAiGenerate | null = null;

export function __setSequenceAiGenerateForTests(fn: SequenceAiGenerate | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setSequenceAiGenerateForTests is test-only");
  }
  testAiGenerate = fn;
}

async function generateAiPersonalization(input: {
  subject: string;
  bodyText: string;
  ctx: MergeContext;
}): Promise<{ subject: string; bodyText: string }> {
  if (process.env.NODE_ENV === "test") {
    if (!testAiGenerate) {
      // Hermetic-by-default: a test that exercises the AI path must inject
      // its stub; anything else fails loudly into the fallback branch.
      throw new Error("AI personalization stub not set (test mode)");
    }
    return testAiGenerate(input);
  }
  const { personalizeSequenceEmail } = await import("./emailSequenceAi");
  return personalizeSequenceEmail(input);
}

// ── Enrollment ───────────────────────────────────────────────────────────────

export type EnrollOutcome =
  | "enrolled"
  | "already_active"
  | "not_found"
  | "sequence_archived"
  | "no_steps"
  | "no_email"
  | "suppressed"
  | "no_sender";

export interface EnrollResult {
  outcome: EnrollOutcome;
  enrollmentId?: string;
  detail?: string;
}

/** Resolve an enrollable entity to its client + best recipient address.
 *  Shared by enrollment and template preview (preview renders against the
 *  same records a real send would use). */
export async function resolveEntityTarget(
  entityType: EnrollmentEntityType,
  entityId: string,
): Promise<
  | { ok: true; client: Client; recipientEmail: string | null }
  | { ok: false; detail: string }
> {
  if (entityType === "client") {
    const client = await getClient(entityId);
    if (!client) return { ok: false, detail: "Client not found" };
    return { ok: true, client, recipientEmail: client.contactEmail ?? null };
  }
  const contact = await getContactById(entityId);
  if (!contact) return { ok: false, detail: "Contact not found" };
  const client = await getClient(contact.clientId);
  if (!client) return { ok: false, detail: "Contact's client not found" };
  return { ok: true, client, recipientEmail: contact.emails?.[0] ?? null };
}

/**
 * Enroll one lead/contact. Sender defaults to the client's assigned owner
 * (the email service's mailbox routing applies at send time). Refusals are
 * explicit outcomes — nothing is silently skipped.
 */
export async function enrollEntity(params: {
  sequenceId: string;
  entityType: EnrollmentEntityType;
  entityId: string;
  senderUserId?: string | null;
  segmentId?: string | null;
  enrolledBy?: string | null;
}): Promise<EnrollResult> {
  const sequence = await getEmailSequence(params.sequenceId);
  if (!sequence) return { outcome: "not_found", detail: "Sequence not found" };
  if (sequence.status === "archived") return { outcome: "sequence_archived" };
  const steps = await listSequenceSteps(sequence.id);
  if (steps.length === 0) return { outcome: "no_steps", detail: "Sequence has no steps" };

  const target = await resolveEntityTarget(params.entityType, params.entityId);
  if (!target.ok) return { outcome: "not_found", detail: target.detail };
  const { client } = target;
  const recipientEmail = target.recipientEmail;
  if (!recipientEmail || !recipientEmail.trim()) {
    return { outcome: "no_email", detail: "No email address on record" };
  }
  const normalized = normalizeEmailAddress(recipientEmail);
  const suppression = await isEmailSuppressed(normalized);
  if (suppression) {
    return { outcome: "suppressed", detail: `Recipient is suppressed (${suppression.reason})` };
  }
  const senderUserId = params.senderUserId ?? client.ownerId ?? null;
  if (!senderUserId) {
    return {
      outcome: "no_sender",
      detail: "No sender: pass one explicitly or assign an owner to the client",
    };
  }

  const firstStep = steps[0];
  const dueAt = new Date(Date.now() + firstStep.delayMinutes * 60 * 1000);
  const enrollment = await insertEnrollmentIfAbsent({
    sequenceId: sequence.id,
    entityType: params.entityType,
    entityId: params.entityId,
    clientId: client.id,
    recipientEmail: normalized,
    senderUserId,
    lifecycleStageAtEnrollment: client.lifecycleStage ?? null,
    segmentId: params.segmentId ?? null,
    enrolledBy: params.enrolledBy ?? null,
    nextStepAt: dueAt,
  });
  if (!enrollment) return { outcome: "already_active" };

  await scheduleStepJob(enrollment.id, firstStep.stepOrder, dueAt);
  return { outcome: "enrolled", enrollmentId: enrollment.id };
}

export interface SegmentEnrollSummary {
  total: number;
  enrolled: number;
  alreadyActive: number;
  skipped: Array<{ entityId: string; outcome: EnrollOutcome; detail?: string }>;
}

/** Enroll every member of a segment (bounded; per-member outcomes reported). */
export async function enrollSegment(params: {
  sequenceId: string;
  segmentId: string;
  senderUserId?: string | null;
  enrolledBy?: string | null;
}): Promise<SegmentEnrollSummary | { error: string }> {
  const segment = await getSegment(params.segmentId);
  if (!segment) return { error: "Segment not found" };
  const members = await listSegmentMembers(segment);
  if (members.length > SEGMENT_ENROLL_CAP) {
    return {
      error: `Segment has ${members.length} members — the per-call cap is ${SEGMENT_ENROLL_CAP}. Narrow the segment.`,
    };
  }
  const summary: SegmentEnrollSummary = {
    total: members.length,
    enrolled: 0,
    alreadyActive: 0,
    skipped: [],
  };
  for (const member of members) {
    const res = await enrollEntity({
      sequenceId: params.sequenceId,
      entityType: segment.entityType as EnrollmentEntityType,
      entityId: member.entityId,
      senderUserId: params.senderUserId ?? null,
      segmentId: params.segmentId,
      enrolledBy: params.enrolledBy ?? null,
    });
    if (res.outcome === "enrolled") summary.enrolled++;
    else if (res.outcome === "already_active") summary.alreadyActive++;
    else summary.skipped.push({ entityId: member.entityId, outcome: res.outcome, detail: res.detail });
  }
  return summary;
}

async function scheduleStepJob(
  enrollmentId: string,
  stepOrder: number,
  dueAt: Date,
  dedupeSuffix?: string,
): Promise<void> {
  const { enqueueJob } = await import("./workScheduler");
  await enqueueJob({
    queueName: EMAIL_SEQUENCE_QUEUE,
    workloadClass: "interactive",
    payload: { enrollmentId, stepOrder },
    dedupeKey: `email_seq_step:${enrollmentId}:${stepOrder}${dedupeSuffix ?? ""}`,
    maxAttempts: 3,
    retryAt: dueAt,
  });
}

// ── Step advancement (queue handler) ─────────────────────────────────────────

interface StepJobPayload {
  enrollmentId: string;
  stepOrder: number;
}

function parseStepJobPayload(payload: unknown): StepJobPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.enrollmentId !== "string" || typeof p.stepOrder !== "number") return null;
  return { enrollmentId: p.enrollmentId, stepOrder: p.stepOrder };
}

/**
 * Queue handler for `email_sequence_step`. Draft-by-default: renders the
 * step into the claim ledger and stops for approval; only sequences with
 * auto-send enabled AND a complete merge (zero missing fields) compose
 * immediately. Every guard here re-reads fresh state — job payloads are
 * hints, never authority.
 */
export async function handleEmailSequenceStepJob(job: { payload?: unknown }): Promise<void> {
  const payload = parseStepJobPayload(job.payload);
  if (!payload) {
    console.warn("[email-sequences] malformed step job payload — dropping", job.payload);
    return;
  }
  const enrollment = await getEnrollment(payload.enrollmentId);
  if (!enrollment) return; // deleted (client cascade) — nothing to do
  if (enrollment.status !== "active") return; // cancelled/completed — visible cancel already happened

  // Step-gate (defense #2): the ONLY actionable job is the one for the
  // enrollment's next expected step. Anything else is a replay or stale.
  const expected = await getNextSequenceStep(enrollment.sequenceId, enrollment.currentStepOrder);
  if (!expected) {
    // Steps were removed underneath the run (route guards make this rare):
    // no next step means the run is finished.
    await casAdvanceEnrollment(enrollment.id, enrollment.currentStepOrder, {
      currentStepOrder: enrollment.currentStepOrder,
      nextStepAt: null,
      status: "completed",
      completedAt: new Date(),
    });
    return;
  }
  if (expected.stepOrder !== payload.stepOrder) return; // stale/replayed job — no-op

  // Global kill switch — fresh read; defer, never fail.
  const paused = await getSystemSettingFresh(EMAIL_SEQUENCES_PAUSED_KEY);
  if (paused?.value === "true") {
    await deferStep(enrollment, payload.stepOrder, "global kill switch");
    return;
  }

  const sequence = await getEmailSequence(enrollment.sequenceId);
  if (!sequence) return;
  if (sequence.status === "paused") {
    await deferStep(enrollment, payload.stepOrder, "sequence paused");
    return;
  }
  if (sequence.status === "archived") {
    await cancelEnrollment(enrollment.id, "sequence_archived", "Sequence was archived");
    return;
  }

  // Lifecycle exit: cancel on TRANSITION to customer since enrollment.
  const client = await getClient(enrollment.clientId);
  if (
    client &&
    enrollment.lifecycleStageAtEnrollment &&
    client.lifecycleStage !== enrollment.lifecycleStageAtEnrollment &&
    client.lifecycleStage === "customer"
  ) {
    await cancelEnrollment(
      enrollment.id,
      "lifecycle_exit",
      `Client became a customer after enrollment (was ${enrollment.lifecycleStageAtEnrollment})`,
    );
    return;
  }

  // Suppression — checked at EVERY advance, not just enrollment.
  const suppression = await isEmailSuppressed(enrollment.recipientEmail);
  if (suppression) {
    await cancelEnrollment(
      enrollment.id,
      "suppressed",
      `Recipient suppressed (${suppression.reason}) before step ${expected.stepOrder}`,
    );
    return;
  }

  // Render — content frozen into the claim row.
  const template = await getEmailTemplate(expected.templateId);
  let rendered: RenderedEmail | null = null;
  let renderError: string | null = null;
  if (!template) {
    renderError = `Template ${expected.templateId} not found`;
  } else {
    try {
      rendered = await renderTemplateForTarget(template, {
        entityType: enrollment.entityType,
        entityId: enrollment.entityId,
        clientId: enrollment.clientId,
        recipientEmail: enrollment.recipientEmail,
        senderUserId: enrollment.senderUserId,
      });
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err);
    }
  }

  // AI personalization (Task #4478) — per-step opt-in, runs BEFORE the
  // claim insert (no DB held during the vendor call). Success freezes the
  // AI content into the draft; failure falls back to the template render
  // with a visible reason. Either way the step ALWAYS waits for approval.
  let aiPersonalized = false;
  let aiError: string | null = null;
  if (rendered && expected.aiPersonalizationEnabled) {
    try {
      const ai = await generateAiPersonalization({
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        ctx: rendered.ctx,
      });
      // AI drafts send text-only: the approver reads exactly what goes out.
      rendered = { ...rendered, subject: ai.subject, bodyText: ai.bodyText, bodyHtml: null };
      aiPersonalized = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      aiError = `AI personalization failed: ${message} — template content shown; edit or approve manually.`;
      console.warn(
        `[email-sequences] AI personalization failed for enrollment ${enrollment.id} step ${expected.stepOrder}: ${message}`,
      );
    }
  }

  // Claim (defense #3): one send record per (enrollment, step), EVER.
  const claim = await insertStepSendIfAbsent({
    enrollmentId: enrollment.id,
    sequenceId: enrollment.sequenceId,
    stepId: expected.id,
    stepOrder: expected.stepOrder,
    templateId: expected.templateId,
    recipientEmail: enrollment.recipientEmail,
    senderUserId: enrollment.senderUserId,
    renderedSubject: rendered?.subject ?? "",
    renderedBodyText: rendered?.bodyText ?? "",
    renderedBodyHtml: rendered?.bodyHtml ?? null,
    missingFields: rendered?.missing ?? [],
    aiPersonalized,
    status: rendered ? "draft" : "render_failed",
    errorMessage: renderError ?? aiError,
  });
  if (!claim) {
    const existing = await getStepSendForStep(enrollment.id, expected.id);
    if (existing && (existing.status === "approved" || existing.status === "suppressed")) {
      // The step already went out yet the step-gate let us this far — a
      // systemic replay/advance bug. The unique index PREVENTED the
      // duplicate; alert so it's investigated, not absorbed.
      await alertEmailSequences(
        EMAIL_SEQ_DUPLICATE_ALERT_ID,
        `email_seq_dup:${enrollment.id}:${expected.id}`,
        `Duplicate send attempt blocked for sequence step ${expected.stepOrder} (enrollment ${enrollment.id}). The claim ledger refused a second send record — investigate what replayed the job.`,
        {
          enrollmentId: enrollment.id,
          sequenceId: enrollment.sequenceId,
          stepOrder: expected.stepOrder,
          existingStatus: existing.status,
          recipientEmail: existing.recipientEmail,
        },
      );
    }
    return; // benign replay of a pending draft — the record already exists
  }

  if (claim.status === "render_failed") {
    await alertEmailSequences(
      EMAIL_SEQ_RENDER_FAILED_ALERT_ID,
      `email_seq_render:${claim.id}`,
      `Sequence step ${expected.stepOrder} failed to render for ${enrollment.recipientEmail}: ${renderError}. The enrollment holds at this step — fix the template and reject the item to skip, or cancel the enrollment.`,
      { enrollmentId: enrollment.id, sequenceId: enrollment.sequenceId, error: renderError },
    );
    return;
  }

  // Auto-send: owner-gated per sequence, template-only (an AI-personalized
  // step ALWAYS waits for approval — Task #4478), and ONLY for complete
  // merges — a draft with missing fields always waits for human eyes.
  if (
    sequence.autoSendEnabled &&
    !expected.aiPersonalizationEnabled &&
    (rendered?.missing.length ?? 0) === 0
  ) {
    await approveStepSend({ stepSendId: claim.id, actorUserId: null, auto: true });
  }
  // Otherwise: the draft sits in the approval queue.
}

async function deferStep(
  enrollment: EmailSequenceEnrollment,
  stepOrder: number,
  reason: string,
): Promise<void> {
  const resumeAt = new Date(Date.now() + PAUSE_DEFER_MS);
  await updateEnrollment(enrollment.id, { nextStepAt: resumeAt });
  // Hour bucket bounds job litter while paused (mirrors the outbound seam).
  const bucket = resumeAt.toISOString().slice(0, 13);
  await scheduleStepJob(enrollment.id, stepOrder, resumeAt, `:paused:${bucket}`);
  console.log(
    `[email-sequences] deferred step ${stepOrder} for enrollment ${enrollment.id} (${reason})`,
  );
}

// ── Approval / rejection ─────────────────────────────────────────────────────

export type ApproveOutcome =
  | "sent"
  | "not_found"
  | "not_pending"
  | "enrollment_not_active"
  | "suppressed"
  | "compose_failed";

export interface ApproveResult {
  outcome: ApproveOutcome;
  detail?: string;
  stepSend?: EmailSequenceStepSend;
}

/**
 * Approve a draft: CAS draft→approved, CAS-advance the enrollment, THEN
 * compose via the outbound seam (which owns delivery). Compose is
 * idempotent on `email_seq_send:<stepSendId>` — if it fails after the CAS
 * pair, re-approving the same record enters the recovery branch and
 * re-composes without any risk of a second send.
 */
export async function approveStepSend(params: {
  stepSendId: string;
  actorUserId: string | null;
  auto?: boolean;
}): Promise<ApproveResult> {
  const existing = await getStepSend(params.stepSendId);
  if (!existing) return { outcome: "not_found" };

  // Recovery: approved but compose never linked an outbound batch (crash /
  // transient failure between CAS and compose). Re-run compose only.
  const recovering = existing.status === "approved" && !existing.outboundBatchId;

  let stepSend = existing;
  if (!recovering) {
    if (existing.status !== "draft") {
      return { outcome: "not_pending", detail: `Step send is ${existing.status}` };
    }
    const enrollment = await getEnrollment(existing.enrollmentId);
    if (!enrollment || enrollment.status !== "active") {
      // Reply/suppression cancel won the race — never send after cancel.
      await casUpdateStepSend(existing.id, ["draft"], { status: "cancelled" });
      return { outcome: "enrollment_not_active" };
    }

    // Approve-time suppression backstop: the creation-path hooks
    // (manual route, unsubscribe redeem, SendGrid events) cancel
    // enrollments eagerly, so this normally never fires — but if a
    // suppression row exists anyway (direct insert, seed overlap, race),
    // refuse the approval and cancel now rather than relying on compose
    // to skip the send.
    if (await isEmailSuppressed(existing.recipientEmail)) {
      await cancelEnrollment(
        existing.enrollmentId,
        "suppressed",
        "Recipient suppressed before approval",
      );
      return { outcome: "suppressed" };
    }

    const approved = await casUpdateStepSend(existing.id, ["draft"], {
      status: "approved",
      approvedBy: params.actorUserId,
      approvedAt: new Date(),
      autoApproved: params.auto === true,
    });
    if (!approved) {
      const now = await getStepSend(existing.id);
      return { outcome: "not_pending", detail: `Step send is ${now?.status ?? "gone"}` };
    }
    stepSend = approved;

    // Advance the enrollment (defense #4) BEFORE compose: the CAS pair is
    // what authorizes exactly one send per step.
    const nextStep = await getNextSequenceStep(enrollment.sequenceId, stepSend.stepOrder);
    const nextDueAt = nextStep
      ? new Date(Date.now() + nextStep.delayMinutes * 60 * 1000)
      : null;
    const advanced = await casAdvanceEnrollment(enrollment.id, enrollment.currentStepOrder, {
      currentStepOrder: stepSend.stepOrder,
      nextStepAt: nextDueAt,
      status: nextStep ? "active" : "completed",
      completedAt: nextStep ? null : new Date(),
    });
    if (!advanced) {
      const fresh = await getEnrollment(enrollment.id);
      if (fresh && fresh.status === "active") {
        // Still active but the step pointer moved — a concurrent advance
        // this design should make impossible. Block the send + alert.
        await alertEmailSequences(
          EMAIL_SEQ_DUPLICATE_ALERT_ID,
          `email_seq_dup_advance:${enrollment.id}:${stepSend.stepOrder}`,
          `Approve blocked: enrollment ${enrollment.id} advanced concurrently past step ${stepSend.stepOrder}. No email was sent — investigate the double-advance.`,
          { enrollmentId: enrollment.id, stepOrder: stepSend.stepOrder },
        );
      }
      await casUpdateStepSend(stepSend.id, ["approved"], { status: "cancelled" });
      return { outcome: "enrollment_not_active" };
    }
    if (nextStep) {
      await scheduleStepJob(enrollment.id, nextStep.stepOrder, nextDueAt as Date);
    }
  }

  // Compose — the outbound seam owns suppression re-checks, mailbox
  // routing, caps, and per-row idempotency from here.
  const enrollmentForCompose = await getEnrollment(stepSend.enrollmentId);
  try {
    const result = await composeOutboundEmails({
      senderUserId: stepSend.senderUserId,
      createdBy: params.actorUserId ?? stepSend.senderUserId,
      subject: stepSend.renderedSubject,
      bodyText: stepSend.renderedBodyText,
      bodyHtml: stepSend.renderedBodyHtml,
      messageClass: "marketing",
      consentSource: "sequence",
      recipients: [
        { email: stepSend.recipientEmail, clientId: enrollmentForCompose?.clientId ?? null },
      ],
      clientBatchKey: `email_seq_send:${stepSend.id}`,
    });
    if (result.suppressed > 0) {
      await casUpdateStepSend(stepSend.id, ["approved"], {
        status: "suppressed",
        errorMessage: "Recipient was suppressed at compose time",
        outboundBatchId: result.batchId,
      });
      await cancelEnrollment(
        stepSend.enrollmentId,
        "suppressed",
        `Recipient suppressed at step ${stepSend.stepOrder} compose`,
      );
      return { outcome: "suppressed" };
    }
    const rows = await listOutboundEmailsByBatch(result.batchId);
    const row = rows.find((r) => r.toEmail === stepSend.recipientEmail) ?? rows[0];
    await updateStepSend(stepSend.id, {
      outboundBatchId: result.batchId,
      outboundEmailId: row?.id ?? null,
      errorMessage: null,
    });
    const final = await getStepSend(stepSend.id);
    return { outcome: "sent", stepSend: final ?? stepSend };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateStepSend(stepSend.id, {
      errorMessage: `Compose failed: ${message} — approve again to retry (idempotent).`,
    });
    return { outcome: "compose_failed", detail: message };
  }
}

export type EditDraftOutcome = "edited" | "not_found" | "not_pending";

/**
 * Task #4478 — edit a PENDING draft's frozen content before approval (the
 * approval queue's editable-drafts contract; AI output is a starting
 * point, not gospel). CAS on `draft` only: approved/rejected/cancelled
 * content is immutable history. An edit is a human review of the full
 * content, so the missing-fields report and any AI-failure reason are
 * cleared — what the editor saved is exactly what an approval sends.
 */
export async function editStepSendDraft(params: {
  stepSendId: string;
  subject: string;
  bodyText: string;
}): Promise<{ outcome: EditDraftOutcome; detail?: string; stepSend?: EmailSequenceStepSend }> {
  const existing = await getStepSend(params.stepSendId);
  if (!existing) return { outcome: "not_found" };
  if (existing.status !== "draft") {
    return { outcome: "not_pending", detail: `Step send is ${existing.status}` };
  }
  const updated = await casUpdateStepSend(existing.id, ["draft"], {
    renderedSubject: params.subject,
    renderedBodyText: params.bodyText,
    // Edited drafts send exactly the text the editor saw — drop any stale
    // HTML twin rather than sending markup nobody reviewed.
    renderedBodyHtml: null,
    missingFields: [],
    errorMessage: null,
  });
  if (!updated) {
    const now = await getStepSend(existing.id);
    return { outcome: "not_pending", detail: `Step send is ${now?.status ?? "gone"}` };
  }
  return { outcome: "edited", stepSend: updated };
}

export type RejectOutcome = "rejected" | "not_found" | "not_pending";

/**
 * Reject skips THIS step only — the enrollment advances to the next step
 * (or completes). Cancelling the whole enrollment is a separate action.
 */
export async function rejectStepSend(params: {
  stepSendId: string;
  actorUserId: string | null;
}): Promise<{ outcome: RejectOutcome; detail?: string }> {
  const existing = await getStepSend(params.stepSendId);
  if (!existing) return { outcome: "not_found" };
  if (existing.status !== "draft" && existing.status !== "render_failed") {
    return { outcome: "not_pending", detail: `Step send is ${existing.status}` };
  }
  const rejected = await casUpdateStepSend(existing.id, ["draft", "render_failed"], {
    status: "rejected",
    rejectedBy: params.actorUserId,
    rejectedAt: new Date(),
  });
  if (!rejected) return { outcome: "not_pending" };

  const enrollment = await getEnrollment(existing.enrollmentId);
  if (enrollment && enrollment.status === "active") {
    const nextStep = await getNextSequenceStep(enrollment.sequenceId, existing.stepOrder);
    const nextDueAt = nextStep
      ? new Date(Date.now() + nextStep.delayMinutes * 60 * 1000)
      : null;
    const advanced = await casAdvanceEnrollment(enrollment.id, enrollment.currentStepOrder, {
      currentStepOrder: existing.stepOrder,
      nextStepAt: nextDueAt,
      status: nextStep ? "active" : "completed",
      completedAt: nextStep ? null : new Date(),
    });
    if (advanced && nextStep) {
      await scheduleStepJob(enrollment.id, nextStep.stepOrder, nextDueAt as Date);
    }
  }
  return { outcome: "rejected" };
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Cancel one enrollment (visible: status + reason + note on the row,
 * pending drafts flipped to cancelled). Queued jobs no-op via the status
 * gate. Safe to call for already-terminal enrollments (returns false).
 */
export async function cancelEnrollment(
  enrollmentId: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<boolean> {
  return cancelEnrollmentAndPendingStepSends(enrollmentId, reason, note);
}

/**
 * Reply-detected cancel: every ACTIVE enrollment for the client stops.
 * The reply event carries no author email, so cancelling client-wide is
 * the safe direction — nobody gets a follow-up after their firm answered.
 * NEVER throws (callers are event settlers / webhook paths).
 */
export async function cancelActiveEnrollmentsForClient(
  clientId: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<number> {
  try {
    const rows = await listActiveEnrollmentsByClient(clientId);
    let cancelled = 0;
    for (const row of rows) {
      if (await cancelEnrollment(row.id, reason, note)) cancelled++;
    }
    return cancelled;
  } catch (err) {
    console.error(
      `[email-sequences] cancel-by-client failed (${clientId}):`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

async function cancelActiveEnrollmentsForEmailCore(
  email: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<number> {
  const normalized = normalizeEmailAddress(email);
  const rows = await listActiveEnrollmentsByEmail(normalized);
  let cancelled = 0;
  for (const row of rows) {
    if (await cancelEnrollment(row.id, reason, note)) cancelled++;
  }
  return cancelled;
}

/**
 * Retryable webhook callers need cancellation failure to remain visible so
 * they can return non-2xx after the suppression safety row is written.
 */
export async function cancelActiveEnrollmentsForEmailOrThrow(
  email: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<number> {
  return cancelActiveEnrollmentsForEmailCore(email, reason, note);
}

/** Suppression/unsubscribe cancel by pinned recipient address. NEVER throws. */
export async function cancelActiveEnrollmentsForEmail(
  email: string,
  reason: EnrollmentCancelReason,
  note?: string | null,
): Promise<number> {
  try {
    return await cancelActiveEnrollmentsForEmailCore(email, reason, note);
  } catch (err) {
    console.error(
      `[email-sequences] cancel-by-email failed:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface SequenceAnalytics {
  enrolled: number;
  inProgress: number;
  completed: number;
  replied: number;
  cancelledOther: number;
  perStep: Array<{
    stepOrder: number;
    draft: number;
    approved: number;
    rejected: number;
    cancelled: number;
    suppressed: number;
    renderFailed: number;
  }>;
}

export async function getSequenceAnalytics(sequenceId: string): Promise<SequenceAnalytics> {
  const [statusRows, stepRows] = await Promise.all([
    enrollmentStatusCounts(sequenceId),
    stepSendCountsBySequence(sequenceId),
  ]);
  const analytics: SequenceAnalytics = {
    enrolled: 0,
    inProgress: 0,
    completed: 0,
    replied: 0,
    cancelledOther: 0,
    perStep: [],
  };
  for (const row of statusRows) {
    analytics.enrolled += row.n;
    if (row.status === "active") analytics.inProgress += row.n;
    else if (row.status === "completed") analytics.completed += row.n;
    else if (row.status === "cancelled") {
      if (row.cancelReason === "replied") analytics.replied += row.n;
      else analytics.cancelledOther += row.n;
    }
  }
  const byStep = new Map<number, SequenceAnalytics["perStep"][number]>();
  for (const row of stepRows) {
    let entry = byStep.get(row.stepOrder);
    if (!entry) {
      entry = {
        stepOrder: row.stepOrder,
        draft: 0,
        approved: 0,
        rejected: 0,
        cancelled: 0,
        suppressed: 0,
        renderFailed: 0,
      };
      byStep.set(row.stepOrder, entry);
    }
    if (row.status === "draft") entry.draft += row.n;
    else if (row.status === "approved") entry.approved += row.n;
    else if (row.status === "rejected") entry.rejected += row.n;
    else if (row.status === "cancelled") entry.cancelled += row.n;
    else if (row.status === "suppressed") entry.suppressed += row.n;
    else if (row.status === "render_failed") entry.renderFailed += row.n;
  }
  analytics.perStep = [...byStep.values()].sort((a, b) => a.stepOrder - b.stepOrder);
  return analytics;
}
