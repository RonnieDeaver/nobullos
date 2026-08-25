// Task #4335 — email templates and approval-gated sequences.
//
// The automation layer on top of the outbound email seam (Task #4334):
// a template library with merge fields, and fixed-step sequences (email
// steps separated by wait delays) that enroll leads/contacts. Deliberately
// NOT a generic workflow builder — ordered steps + delays only.
//
// Double-send is the named enemy (Governor L2). Two structural guards:
//   1. `email_seq_enrollments_active_uq` — a contact can never be enrolled
//      twice CONCURRENTLY in the same sequence (partial unique on active).
//   2. `email_seq_step_sends_enrollment_step_uq` — one send record per
//      (enrollment, step), EVER. The claim-ledger row is inserted with
//      ON CONFLICT DO NOTHING; losing the insert means the step was already
//      handled (replayed job) and the worker no-ops + alerts on anomaly.
//
// Content is FROZEN at draft time: what the approver saw is exactly what
// sends. Template edits never mutate pending drafts.

import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { clients } from "./clients";
import { segments } from "./tagsSegments";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const emailSequenceStatuses = ["active", "paused", "archived"] as const;
export type EmailSequenceStatus = (typeof emailSequenceStatuses)[number];

/** Matches the segments feature's polymorphic entity vocabulary. */
export const enrollmentEntityTypes = ["client", "contact"] as const;
export type EnrollmentEntityType = (typeof enrollmentEntityTypes)[number];

export const enrollmentStatuses = ["active", "completed", "cancelled"] as const;
export type EnrollmentStatus = (typeof enrollmentStatuses)[number];

/**
 * Why each cancelled enrollment stopped — surfaced in the UI so cancel-on-
 * reply is VISIBLE, not silent. `replied` doubles as the funnel's
 * "replied" analytics bucket.
 */
export const enrollmentCancelReasons = [
  "replied",
  "suppressed",
  "unsubscribed",
  "lifecycle_exit",
  "manual",
  "sequence_archived",
] as const;
export type EnrollmentCancelReason = (typeof enrollmentCancelReasons)[number];

/**
 * Step-send lifecycle. `draft` waits in the approval queue; `approved`
 * means the content was handed to the outbound email seam (which owns
 * actual delivery status from there); `rejected` skips the step but the
 * enrollment continues; `cancelled` follows enrollment cancellation;
 * `suppressed` = recipient was on the suppression list at compose time;
 * `render_failed` = the template could not be rendered (surfaced for a
 * human — the enrollment holds at this step until rejected/cancelled).
 */
export const stepSendStatuses = [
  "draft",
  "approved",
  "rejected",
  "cancelled",
  "suppressed",
  "render_failed",
] as const;
export type StepSendStatus = (typeof stepSendStatuses)[number];

// ── Templates ────────────────────────────────────────────────────────────────

export const emailTemplates = pgTable("email_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  /** Subject/body carry {{entity.field}} / {{entity.field|fallback}} merge
   *  tokens; the vocabulary is validated at save time (unknown tokens are a
   *  400, not a silent literal). */
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  bodyHtml: text("body_html"),
  /** Soft delete — archived templates disappear from pickers but stay
   *  resolvable for historical step provenance. Hard delete is blocked by
   *  the steps FK. */
  archived: boolean("archived").default(false).notNull(),
  createdBy: varchar("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type InsertEmailTemplate = typeof emailTemplates.$inferInsert;

// ── Sequences + steps ────────────────────────────────────────────────────────

export const emailSequences = pgTable("email_sequences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  /** Born `paused` — an operator explicitly activates once steps look
   *  right. Paused sequences accept enrollments but defer advancement. */
  status: varchar("status", { length: 12 })
    .notNull()
    .default("paused")
    .$type<EmailSequenceStatus>(),
  /**
   * Owner-gated auto-send: when true, rendered steps with ZERO missing
   * merge fields skip the approval queue and compose immediately. Flipping
   * this is restricted to the sequence creator or the CEO (route-enforced)
   * — pre-approved content only, per the task's research consensus.
   */
  autoSendEnabled: boolean("auto_send_enabled").default(false).notNull(),
  createdBy: varchar("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type EmailSequence = typeof emailSequences.$inferSelect;
export type InsertEmailSequence = typeof emailSequences.$inferInsert;

export const emailSequenceSteps = pgTable(
  "email_sequence_steps",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sequenceId: varchar("sequence_id")
      .references(() => emailSequences.id, { onDelete: "cascade" })
      .notNull(),
    /** 1-based position. Enrollments advance strictly by this order. */
    stepOrder: integer("step_order").notNull(),
    /** Plain FK (no cascade): deleting a referenced template is refused by
     *  Postgres — archive instead. */
    templateId: varchar("template_id")
      .references(() => emailTemplates.id)
      .notNull(),
    /** Wait before this step, in minutes — from enrollment for step 1,
     *  from the previous step's approval/send for later steps. */
    delayMinutes: integer("delay_minutes").notNull().default(0),
    /**
     * Per-step AI personalization: when true, the worker asks the AI to
     * personalize the template against the contact/client/deal merge
     * context, and the result ALWAYS lands in the approval queue as an
     * editable draft — auto-send never applies to AI-personalized steps.
     * Generation failures fall back to the plain template render with a
     * visible reason (same "human must look" pattern as missing merges).
     */
    aiPersonalizationEnabled: boolean("ai_personalization_enabled").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    sequenceOrderUq: uniqueIndex("email_seq_steps_sequence_order_uq").on(
      t.sequenceId,
      t.stepOrder,
    ),
    templateIdx: index("email_seq_steps_template_id_idx").on(t.templateId),
  }),
);

export type EmailSequenceStep = typeof emailSequenceSteps.$inferSelect;
export type InsertEmailSequenceStep = typeof emailSequenceSteps.$inferInsert;

// ── Enrollments ──────────────────────────────────────────────────────────────

export const emailSequenceEnrollments = pgTable(
  "email_sequence_enrollments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sequenceId: varchar("sequence_id")
      .references(() => emailSequences.id, { onDelete: "cascade" })
      .notNull(),
    /** Polymorphic target, matching segments: 'client' (entityId = client
     *  id) or 'contact' (entityId = client_contacts id). */
    entityType: varchar("entity_type", { length: 10 })
      .notNull()
      .$type<EnrollmentEntityType>(),
    entityId: varchar("entity_id").notNull(),
    /** Always resolvable (a contact's parent, or the client itself) — the
     *  lifecycle-exit check and reply-cancel matching key off this. */
    clientId: varchar("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    /** PINNED at enrollment (normalized lowercase). The address the whole
     *  run targets — contact edits mid-sequence don't re-route sends. */
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    /** PINNED at enrollment: explicit choice or the client's assigned
     *  owner. Mailbox routing/caps from the email service apply per-send. */
    senderUserId: varchar("sender_user_id")
      .references(() => users.id)
      .notNull(),
    status: varchar("status", { length: 12 })
      .notNull()
      .default("active")
      .$type<EnrollmentStatus>(),
    cancelReason: varchar("cancel_reason", { length: 24 }).$type<EnrollmentCancelReason>(),
    /** Human-readable context (e.g. which Front message triggered the
     *  reply-cancel). */
    cancelNote: text("cancel_note"),
    /** Last COMPLETED step order; 0 = none yet. Advancement is CAS-guarded
     *  on this value (the payload step-gate) so replayed jobs no-op. */
    currentStepOrder: integer("current_step_order").notNull().default(0),
    /** When the next step is due (display + defer bookkeeping). */
    nextStepAt: timestamp("next_step_at"),
    /** Lifecycle stage snapshot at enrollment — the exit check fires only
     *  on a TRANSITION to customer, so deliberately enrolling an existing
     *  customer (e.g. onboarding outreach) is not instantly cancelled. */
    lifecycleStageAtEnrollment: varchar("lifecycle_stage_at_enrollment", { length: 40 }),
    /** Provenance when enrolled from a segment. */
    segmentId: varchar("segment_id").references(() => segments.id, {
      onDelete: "set null",
    }),
    enrolledBy: varchar("enrolled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    /** THE concurrent-enrollment guard: one ACTIVE enrollment per entity
     *  per sequence. Completed/cancelled history rows don't block
     *  re-enrollment later. Enrollment inserts use ON CONFLICT DO NOTHING
     *  against this index. */
    activeUq: uniqueIndex("email_seq_enrollments_active_uq")
      .on(t.sequenceId, t.entityType, t.entityId)
      .where(sql`status = 'active'`),
    sequenceStatusIdx: index("email_seq_enrollments_sequence_status_idx").on(
      t.sequenceId,
      t.status,
    ),
    /** Reply-cancel matches by client. */
    clientActiveIdx: index("email_seq_enrollments_client_active_idx")
      .on(t.clientId)
      .where(sql`status = 'active'`),
    /** Suppression/unsubscribe-cancel matches by pinned address. */
    emailActiveIdx: index("email_seq_enrollments_email_active_idx")
      .on(t.recipientEmail)
      .where(sql`status = 'active'`),
  }),
);

export type EmailSequenceEnrollment = typeof emailSequenceEnrollments.$inferSelect;
export type InsertEmailSequenceEnrollment = typeof emailSequenceEnrollments.$inferInsert;

// ── Step sends (claim ledger + approval queue) ──────────────────────────────

export const emailSequenceStepSends = pgTable(
  "email_sequence_step_sends",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    enrollmentId: varchar("enrollment_id")
      .references(() => emailSequenceEnrollments.id, { onDelete: "cascade" })
      .notNull(),
    /** Denormalized for approval-queue/analytics reads. */
    sequenceId: varchar("sequence_id")
      .references(() => emailSequences.id, { onDelete: "cascade" })
      .notNull(),
    stepId: varchar("step_id")
      .references(() => emailSequenceSteps.id, { onDelete: "cascade" })
      .notNull(),
    stepOrder: integer("step_order").notNull(),
    /** Frozen provenance — which template rendered this draft. */
    templateId: varchar("template_id").references(() => emailTemplates.id, {
      onDelete: "set null",
    }),
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    senderUserId: varchar("sender_user_id")
      .references(() => users.id)
      .notNull(),
    /** FROZEN rendered content — what's approved is exactly what sends. */
    renderedSubject: text("rendered_subject").notNull().default(""),
    renderedBodyText: text("rendered_body_text").notNull().default(""),
    renderedBodyHtml: text("rendered_body_html"),
    /** Merge tokens that had no value and no fallback — shown in the
     *  approval queue; auto-send refuses to fire when non-empty. */
    missingFields: text("missing_fields").array().default([]),
    /** True when the frozen content is AI-personalized output (badge in
     *  the approval queue). False for plain template renders — including
     *  AI-enabled steps whose generation failed (errorMessage says why). */
    aiPersonalized: boolean("ai_personalized").default(false).notNull(),
    status: varchar("status", { length: 16 })
      .notNull()
      .default("draft")
      .$type<StepSendStatus>(),
    errorMessage: text("error_message"),
    /** Link into the outbound email seam once approved/composed. */
    outboundBatchId: varchar("outbound_batch_id"),
    outboundEmailId: varchar("outbound_email_id"),
    autoApproved: boolean("auto_approved").default(false).notNull(),
    approvedBy: varchar("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    rejectedBy: varchar("rejected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedAt: timestamp("rejected_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    /** THE per-step idempotency claim: one send record per (enrollment,
     *  step) EVER — replays/retries lose the ON CONFLICT DO NOTHING insert
     *  and no-op. */
    enrollmentStepUq: uniqueIndex("email_seq_step_sends_enrollment_step_uq").on(
      t.enrollmentId,
      t.stepId,
    ),
    statusIdx: index("email_seq_step_sends_status_idx").on(t.status),
    enrollmentIdx: index("email_seq_step_sends_enrollment_idx").on(t.enrollmentId),
    sequenceStepIdx: index("email_seq_step_sends_sequence_step_idx").on(
      t.sequenceId,
      t.stepOrder,
    ),
  }),
);

export type EmailSequenceStepSend = typeof emailSequenceStepSends.$inferSelect;
export type InsertEmailSequenceStepSend = typeof emailSequenceStepSends.$inferInsert;

// ── Focused update boundaries (Task #4548, F8 convention) ───────────────────
// Runtime-parsed patch shapes for the storage update paths
// (server/storage/emailSequencesStorage.ts). Each schema enumerates exactly
// the caller-editable columns; `.parse()` strips everything else. Kept OUT of
// caller control: row identity (`id`), server-stamped audit (`createdBy`,
// `createdAt`, `updatedAt` — the storage layer stamps `updatedAt` itself) and,
// for step sends, the claim-ledger linkage/pinning columns (`enrollmentId`,
// `sequenceId`, `stepId`, `stepOrder`, `templateId`, `recipientEmail`,
// `senderUserId`) plus render provenance (`aiPersonalized`).

export const emailTemplatePatchSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    subject: z.string(),
    bodyText: z.string(),
    bodyHtml: z.string().nullable(),
    archived: z.boolean(),
  })
  .partial();
export type EmailTemplatePatch = z.infer<typeof emailTemplatePatchSchema>;

export const emailSequencePatchSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(emailSequenceStatuses),
    autoSendEnabled: z.boolean(),
  })
  .partial();
export type EmailSequencePatch = z.infer<typeof emailSequencePatchSchema>;

/** Enrollment bookkeeping (defers / sender re-route) — schedule + pinned-
 *  sender fields ONLY. Status, CAS step counters, cancel fields and identity
 *  (sequenceId/entityType/entityId/clientId/recipientEmail) are all excluded:
 *  status flips belong to the dedicated CAS/cancel writers. */
export const emailSequenceEnrollmentPatchSchema = z
  .object({
    nextStepAt: z.date().nullable(),
    senderUserId: z.string(),
  })
  .partial();
export type EmailSequenceEnrollmentPatch = z.infer<typeof emailSequenceEnrollmentPatchSchema>;

/** The CAS advance shape (casAdvanceEnrollment): exactly the step-gate's
 *  transition columns. `status` may only move within the advance vocabulary
 *  (active→active/completed) — cancellation goes through cancelEnrollmentRow,
 *  never this writer. Identity/audit columns are structurally absent. */
export const emailSequenceCasAdvancePatchSchema = z.object({
  currentStepOrder: z.number().int().nonnegative(),
  nextStepAt: z.date().nullable(),
  status: z.enum(["active", "completed"]).optional(),
  completedAt: z.date().nullable().optional(),
});
export type EmailSequenceCasAdvancePatch = z.infer<typeof emailSequenceCasAdvancePatchSchema>;

/** Shared by the CAS transition and bookkeeping update paths: status moves,
 *  approval/rejection audit fields, draft-edit content rewrites and the
 *  outbound-email seam linkage. */
export const emailSequenceStepSendPatchSchema = z
  .object({
    status: z.enum(stepSendStatuses),
    errorMessage: z.string().nullable(),
    outboundBatchId: z.string().nullable(),
    outboundEmailId: z.string().nullable(),
    autoApproved: z.boolean(),
    approvedBy: z.string().nullable(),
    approvedAt: z.date().nullable(),
    rejectedBy: z.string().nullable(),
    rejectedAt: z.date().nullable(),
    renderedSubject: z.string(),
    renderedBodyText: z.string(),
    renderedBodyHtml: z.string().nullable(),
    missingFields: z.array(z.string()),
  })
  .partial();
export type EmailSequenceStepSendPatch = z.infer<typeof emailSequenceStepSendPatchSchema>;
