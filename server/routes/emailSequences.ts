// Task #4335 — Email templates and approval-gated sequences: admin surface.
//
// Templates (`/api/email-templates`): CRUD + merge-field preview against a
//   real client/contact record. Unknown merge tokens are a 400 at save time
//   — never a silently-sent literal.
// Sequences (`/api/email-sequences`): definition CRUD (created paused),
//   step editing (blocked while enrollments are active), manual + segment
//   enrollment, the approval queue (drafts by default), per-sequence
//   owner-or-CEO-gated auto-send, a CEO-gated global kill switch, and
//   funnel analytics.
//
// All routes are authenticated; mutations run under writeLimiter. Request
// bodies are parsed through focused zod schemas — req.body is never spread.

import type { Express, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, writeLimiter, hasRole } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";
import {
  EMAIL_SEQUENCES_PAUSED_KEY,
  MERGE_FIELD_VOCABULARY,
  approveStepSend,
  cancelEnrollment,
  editStepSendDraft,
  enrollEntity,
  enrollSegment,
  findUnknownMergeTokens,
  getSequenceAnalytics,
  rejectStepSend,
  renderTemplateForTarget,
  resolveEntityTarget,
} from "../services/emailSequences";
import {
  countActiveEnrollments,
  createEmailSequence,
  createEmailTemplate,
  getEmailSequence,
  getEmailTemplate,
  getEnrollment,
  getSequenceListCounts,
  listApprovalQueue,
  listEmailSequences,
  listEmailTemplates,
  listEnrollments,
  listSequenceSteps,
  replaceSequenceSteps,
  updateEmailSequence,
  updateEmailTemplate,
} from "../storage/emailSequencesStorage";
import {
  emailSequenceStatuses,
  enrollmentStatuses,
  type EmailSequenceStep,
} from "@shared/schema";
import { getSystemSettingFresh, setSystemSetting } from "../storage/settingsStorage";

// ── Schemas ──────────────────────────────────────────────────────────────────

const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).optional().nullable(),
});

const templateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    subject: z.string().trim().min(1).max(500).optional(),
    bodyText: z.string().min(1).max(50_000).optional(),
    bodyHtml: z.string().max(200_000).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "no fields provided" });

const previewSchema = z.object({
  entityType: z.enum(["client", "contact"]),
  entityId: z.string().uuid(),
  senderUserId: z.string().trim().min(1).max(100).optional(),
});

const stepInputSchema = z.object({
  templateId: z.string().uuid(),
  // 0 = immediately after the previous step (or enrollment); cap 90 days.
  delayMinutes: z.number().int().min(0).max(129_600),
  // Task #4478 — AI-personalize this step's template per contact. AI steps
  // always land in the approval queue (auto-send stays template-only).
  aiPersonalizationEnabled: z.boolean().optional().default(false),
});

// Task #4478 — edit a pending draft's content in the approval queue.
const stepSendEditSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().min(1).max(50_000),
});

const sequenceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  steps: z.array(stepInputSchema).min(1).max(20).optional(),
});

const sequencePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    status: z.enum(emailSequenceStatuses).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "no fields provided" });

const stepsPutSchema = z.object({
  steps: z.array(stepInputSchema).min(1).max(20),
});

const autoSendSchema = z.object({ enabled: z.boolean() });

const enrollSchema = z.object({
  entityType: z.enum(["client", "contact"]),
  entityId: z.string().uuid(),
  senderUserId: z.string().trim().min(1).max(100).optional(),
});

const enrollSegmentSchema = z.object({
  segmentId: z.string().uuid(),
  senderUserId: z.string().trim().min(1).max(100).optional(),
});

const cancelSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

const settingsSchema = z.object({ paused: z.boolean() });

const approvalsQuerySchema = z.object({
  sequenceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const enrollmentsQuerySchema = z.object({
  status: z.enum(enrollmentStatuses).optional(),
});

const templatesQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function actorIdOf(req: AuthenticatedRequest): string | undefined {
  return req.user?.claims?.sub as string | undefined;
}

/** Unknown-token check across every template text field being written. */
function unknownTokensIn(fields: {
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}): string[] {
  const unknown = new Set<string>();
  for (const text of [fields.subject, fields.bodyText, fields.bodyHtml]) {
    if (!text) continue;
    for (const t of findUnknownMergeTokens(text)) unknown.add(t);
  }
  return [...unknown];
}

async function validateStepTemplates(
  steps: Array<{ templateId: string }>,
): Promise<string[]> {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.templateId)) continue;
    seen.add(step.templateId);
    const template = await getEmailTemplate(step.templateId);
    if (!template) missing.push(step.templateId);
  }
  return missing;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerEmailSequencesRoutes(app: Express): void {
  // ── Templates ──────────────────────────────────────────────────────────

  app.get(
    "/api/email-templates",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = templatesQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const templates = await listEmailTemplates(parsed.data.includeArchived === true);
        res.json({ templates, mergeFields: MERGE_FIELD_VOCABULARY });
      } catch (err) {
        console.error("[email-sequences] template list failed:", err);
        res.status(500).json({ error: "Failed to list templates" });
      }
    },
  );

  app.post(
    "/api/email-templates",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = templateCreateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const unknown = unknownTokensIn(parsed.data);
        if (unknown.length > 0) {
          return res.status(400).json({
            error: `Unknown merge fields: ${unknown.join(", ")}`,
            unknownTokens: unknown,
          });
        }
        const template = await createEmailTemplate({
          ...parsed.data,
          description: parsed.data.description ?? null,
          bodyHtml: parsed.data.bodyHtml ?? null,
          createdBy: actorId,
        });
        res.status(201).json({ template });
      } catch (err) {
        console.error("[email-sequences] template create failed:", err);
        res.status(500).json({ error: "Failed to create template" });
      }
    },
  );

  app.patch(
    "/api/email-templates/:id",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = templateUpdateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const existing = await getEmailTemplate(req.params.id);
        if (!existing) return res.status(404).json({ error: "Template not found" });
        const unknown = unknownTokensIn({
          subject: parsed.data.subject ?? null,
          bodyText: parsed.data.bodyText ?? null,
          bodyHtml: parsed.data.bodyHtml ?? null,
        });
        if (unknown.length > 0) {
          return res.status(400).json({
            error: `Unknown merge fields: ${unknown.join(", ")}`,
            unknownTokens: unknown,
          });
        }
        const template = await updateEmailTemplate(existing.id, parsed.data);
        res.json({ template });
      } catch (err) {
        console.error("[email-sequences] template update failed:", err);
        res.status(500).json({ error: "Failed to update template" });
      }
    },
  );

  // Preview a template against a REAL record — renders exactly what a
  // sequence send would, including the missing-fields report.
  app.post(
    "/api/email-templates/:id/preview",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = previewSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const template = await getEmailTemplate(req.params.id);
        if (!template) return res.status(404).json({ error: "Template not found" });
        const target = await resolveEntityTarget(parsed.data.entityType, parsed.data.entityId);
        if (!target.ok) return res.status(404).json({ error: target.detail });
        const senderUserId =
          parsed.data.senderUserId ?? target.client.ownerId ?? actorId;
        const rendered = await renderTemplateForTarget(template, {
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          clientId: target.client.id,
          recipientEmail: target.recipientEmail ?? "",
          senderUserId,
        });
        res.json({
          preview: rendered,
          target: {
            clientId: target.client.id,
            clientName: target.client.firmName,
            recipientEmail: target.recipientEmail,
            senderUserId,
          },
        });
      } catch (err) {
        console.error("[email-sequences] template preview failed:", err);
        res.status(500).json({ error: "Failed to render preview" });
      }
    },
  );

  // ── Sequence collection + static-path routes (before /:id) ───────────────

  app.get(
    "/api/email-sequences",
    isAuthenticated,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const [sequences, counts] = await Promise.all([
          listEmailSequences(),
          getSequenceListCounts(),
        ]);
        res.json({
          sequences: sequences.map((s) => ({
            ...s,
            stepCount: counts.steps.get(s.id) ?? 0,
            activeEnrollments: counts.activeEnrollments.get(s.id) ?? 0,
            pendingDrafts: counts.pendingDrafts.get(s.id) ?? 0,
          })),
        });
      } catch (err) {
        console.error("[email-sequences] list failed:", err);
        res.status(500).json({ error: "Failed to list sequences" });
      }
    },
  );

  app.post(
    "/api/email-sequences",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = sequenceCreateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        if (parsed.data.steps) {
          const missing = await validateStepTemplates(parsed.data.steps);
          if (missing.length > 0) {
            return res.status(400).json({ error: `Unknown template ids: ${missing.join(", ")}` });
          }
        }
        // Sequences are born paused — an operator activates deliberately.
        const sequence = await createEmailSequence({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          status: "paused",
          autoSendEnabled: false,
          createdBy: actorId,
        });
        let steps: EmailSequenceStep[] = [];
        if (parsed.data.steps && parsed.data.steps.length > 0) {
          steps = await replaceSequenceSteps(sequence.id, parsed.data.steps);
        }
        res.status(201).json({ sequence, steps });
      } catch (err) {
        console.error("[email-sequences] create failed:", err);
        res.status(500).json({ error: "Failed to create sequence" });
      }
    },
  );

  // Global kill switch — static path, registered before /:id.
  app.get(
    "/api/email-sequences/settings",
    isAuthenticated,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const paused = await getSystemSettingFresh(EMAIL_SEQUENCES_PAUSED_KEY);
        res.json({ paused: paused?.value === "true" });
      } catch (err) {
        console.error("[email-sequences] settings read failed:", err);
        res.status(500).json({ error: "Failed to read settings" });
      }
    },
  );

  app.post(
    "/api/email-sequences/settings",
    isAuthenticated,
    writeLimiter,
    requireCeo,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        const parsed = settingsSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        await setSystemSetting(
          EMAIL_SEQUENCES_PAUSED_KEY,
          parsed.data.paused ? "true" : "false",
          actorId,
        );
        res.json({ paused: parsed.data.paused });
      } catch (err) {
        console.error("[email-sequences] settings write failed:", err);
        res.status(500).json({ error: "Failed to update settings" });
      }
    },
  );

  // Approval queue — drafts (and render failures) across all sequences.
  app.get(
    "/api/email-sequences/approvals",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = approvalsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const items = await listApprovalQueue({
          sequenceId: parsed.data.sequenceId,
          limit: parsed.data.limit,
        });
        res.json({ items });
      } catch (err) {
        console.error("[email-sequences] approvals list failed:", err);
        res.status(500).json({ error: "Failed to list approval queue" });
      }
    },
  );

  // ── Step-send approval actions ────────────────────────────────────────

  app.post(
    "/api/email-sequences/step-sends/:id/approve",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const result = await approveStepSend({
          stepSendId: req.params.id,
          actorUserId: actorId,
        });
        switch (result.outcome) {
          case "sent":
          case "suppressed":
            return res.json(result);
          case "not_found":
            return res.status(404).json(result);
          case "not_pending":
          case "enrollment_not_active":
            return res.status(409).json(result);
          case "compose_failed":
            return res.status(502).json(result);
        }
      } catch (err) {
        console.error("[email-sequences] approve failed:", err);
        res.status(500).json({ error: "Failed to approve step send" });
      }
    },
  );

  // Task #4478 — drafts are editable before approval: what the editor
  // saves is exactly what an approval sends. CAS-guarded to `draft` only.
  app.patch(
    "/api/email-sequences/step-sends/:id",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = stepSendEditSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const result = await editStepSendDraft({
          stepSendId: req.params.id,
          subject: parsed.data.subject,
          bodyText: parsed.data.bodyText,
        });
        switch (result.outcome) {
          case "edited":
            return res.json(result);
          case "not_found":
            return res.status(404).json(result);
          case "not_pending":
            return res.status(409).json(result);
        }
      } catch (err) {
        console.error("[email-sequences] step-send edit failed:", err);
        res.status(500).json({ error: "Failed to edit step send" });
      }
    },
  );

  app.post(
    "/api/email-sequences/step-sends/:id/reject",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const result = await rejectStepSend({
          stepSendId: req.params.id,
          actorUserId: actorId,
        });
        switch (result.outcome) {
          case "rejected":
            return res.json(result);
          case "not_found":
            return res.status(404).json(result);
          case "not_pending":
            return res.status(409).json(result);
        }
      } catch (err) {
        console.error("[email-sequences] reject failed:", err);
        res.status(500).json({ error: "Failed to reject step send" });
      }
    },
  );

  // Manual enrollment cancel — the operator-visible off switch per contact.
  app.post(
    "/api/email-sequences/enrollments/:enrollmentId/cancel",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = cancelSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const enrollment = await getEnrollment(req.params.enrollmentId);
        if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
        const cancelled = await cancelEnrollment(
          enrollment.id,
          "manual",
          parsed.data.note ? `Cancelled by operator: ${parsed.data.note}` : "Cancelled by operator",
        );
        if (!cancelled) {
          return res
            .status(409)
            .json({ error: `Enrollment is already ${enrollment.status}` });
        }
        res.json({ cancelled: true });
      } catch (err) {
        console.error("[email-sequences] enrollment cancel failed:", err);
        res.status(500).json({ error: "Failed to cancel enrollment" });
      }
    },
  );

  // ── Per-sequence routes ───────────────────────────────────────────────

  app.get(
    "/api/email-sequences/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const [steps, analytics] = await Promise.all([
          listSequenceSteps(sequence.id),
          getSequenceAnalytics(sequence.id),
        ]);
        const templates = await Promise.all(steps.map((s) => getEmailTemplate(s.templateId)));
        res.json({
          sequence,
          steps: steps.map((s, i) => ({ ...s, templateName: templates[i]?.name ?? "(deleted)" })),
          analytics,
        });
      } catch (err) {
        console.error("[email-sequences] get failed:", err);
        res.status(500).json({ error: "Failed to load sequence" });
      }
    },
  );

  app.patch(
    "/api/email-sequences/:id",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = sequencePatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const existing = await getEmailSequence(req.params.id);
        if (!existing) return res.status(404).json({ error: "Sequence not found" });
        const sequence = await updateEmailSequence(existing.id, parsed.data);
        // Archiving is terminal for its enrollments — cancel them visibly
        // now rather than waiting for each next step advance.
        if (parsed.data.status === "archived" && existing.status !== "archived") {
          const active = await listEnrollments(existing.id, "active");
          for (const row of active) {
            await cancelEnrollment(row.id, "sequence_archived", "Sequence archived by operator");
          }
        }
        res.json({ sequence });
      } catch (err) {
        console.error("[email-sequences] patch failed:", err);
        res.status(500).json({ error: "Failed to update sequence" });
      }
    },
  );

  // Auto-send is the one owner-gated toggle: only the sequence creator or
  // the CEO may waive per-step human approval — and only for sequences
  // whose content they have pre-approved.
  app.patch(
    "/api/email-sequences/:id/auto-send",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = autoSendSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const actor = await storage.getUser(actorId);
        const isOwner = sequence.createdBy === actorId;
        if (!actor || (!isOwner && !hasRole(actor.role, "ceo"))) {
          return res.status(403).json({
            error: "Only the sequence owner or the CEO can change auto-send",
          });
        }
        const updated = await updateEmailSequence(sequence.id, {
          autoSendEnabled: parsed.data.enabled,
        });
        res.json({ sequence: updated });
      } catch (err) {
        console.error("[email-sequences] auto-send toggle failed:", err);
        res.status(500).json({ error: "Failed to update auto-send" });
      }
    },
  );

  app.put(
    "/api/email-sequences/:id/steps",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = stepsPutSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const activeCount = await countActiveEnrollments(sequence.id);
        if (activeCount > 0) {
          // Editing steps under live runs re-points in-flight enrollments
          // at different content/ordering — refuse instead of surprising.
          return res.status(409).json({
            error: `${activeCount} enrollment(s) are active. Wait for them to finish or cancel them before editing steps.`,
          });
        }
        const missing = await validateStepTemplates(parsed.data.steps);
        if (missing.length > 0) {
          return res.status(400).json({ error: `Unknown template ids: ${missing.join(", ")}` });
        }
        const steps = await replaceSequenceSteps(sequence.id, parsed.data.steps);
        res.json({ steps });
      } catch (err) {
        console.error("[email-sequences] steps update failed:", err);
        res.status(500).json({ error: "Failed to update steps" });
      }
    },
  );

  app.post(
    "/api/email-sequences/:id/enroll",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = enrollSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const result = await enrollEntity({
          sequenceId: req.params.id,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          senderUserId: parsed.data.senderUserId ?? null,
          enrolledBy: actorId,
        });
        switch (result.outcome) {
          case "enrolled":
            return res.status(201).json(result);
          case "already_active":
            return res.status(409).json(result);
          case "not_found":
            return res.status(404).json(result);
          default:
            return res.status(400).json(result);
        }
      } catch (err) {
        console.error("[email-sequences] enroll failed:", err);
        res.status(500).json({ error: "Failed to enroll" });
      }
    },
  );

  app.post(
    "/api/email-sequences/:id/enroll-segment",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actorId = actorIdOf(req);
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const parsed = enrollSegmentSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const result = await enrollSegment({
          sequenceId: sequence.id,
          segmentId: parsed.data.segmentId,
          senderUserId: parsed.data.senderUserId ?? null,
          enrolledBy: actorId,
        });
        if ("error" in result) return res.status(400).json(result);
        res.json({ summary: result });
      } catch (err) {
        console.error("[email-sequences] segment enroll failed:", err);
        res.status(500).json({ error: "Failed to enroll segment" });
      }
    },
  );

  app.get(
    "/api/email-sequences/:id/enrollments",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = enrollmentsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const enrollments = await listEnrollments(sequence.id, parsed.data.status);
        res.json({ enrollments });
      } catch (err) {
        console.error("[email-sequences] enrollments list failed:", err);
        res.status(500).json({ error: "Failed to list enrollments" });
      }
    },
  );

  app.get(
    "/api/email-sequences/:id/analytics",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sequence = await getEmailSequence(req.params.id);
        if (!sequence) return res.status(404).json({ error: "Sequence not found" });
        const analytics = await getSequenceAnalytics(sequence.id);
        res.json({ analytics });
      } catch (err) {
        console.error("[email-sequences] analytics failed:", err);
        res.status(500).json({ error: "Failed to compute analytics" });
      }
    },
  );
}
