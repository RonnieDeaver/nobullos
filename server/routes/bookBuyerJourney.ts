/**
 * Public, capability-gated buyer conversion journey.
 *
 * GHL owns calendar/appointment operations. This surface only creates and
 * transitions the existing durable book application, conditionally returns an
 * operator-approved GHL embed URL, and reads trusted mirrored appointment facts.
 * It never changes book access, payment, consent, or entitlement state.
 */
import type { Express, Request, Response } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { storage } from "../storage";
import { asyncHandler, HttpError } from "../observability/httpErrors";
import { bookCheckoutLimiter, requireCheckoutSession } from "./bookCheckout";
import {
  createBookAuditApplication,
  findBookBuyerCheckoutContext,
  getBookBuyerJourneyState,
  transitionBookAuditApplication,
  upsertBookAppointment,
  type BookBuyerJourneyState,
} from "../storage/bookCommerceEngagementStorage";
import {
  BOOK_BUYER_GHL_CALENDAR_SETTING,
  BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
  bookBuyerAnswersSchema,
  buildBookBuyerCalendarUrl,
  evaluateBookBuyerQualification,
  parseBookBuyerGhlCalendar,
  parseBookBuyerQualificationPolicy,
  type BookBuyerQualificationDecision,
  type BookBuyerRoutingOutcome,
} from "../services/bookBuyerQualification";
import { IdempotencyConflictError, insertOutboxEntry } from "../storage/bookCommerceStorage";

const JOURNEY_TOKEN_DOMAIN = "book-buyer-journey:application:v1";
const JOURNEY_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ROUTING_MARKER_PREFIX = "book-buyer-routing:v1:";

const resumeTokenSchema = z.string().length(64).regex(/^[0-9a-f]+$/);
const applicationTokenSchema = z.string().min(40).max(1024);

const startSchema = z
  .object({
    resumeToken: resumeTokenSchema,
  })
  .strict();

const submitSchema = z
  .object({
    applicationToken: applicationTokenSchema,
    answers: bookBuyerAnswersSchema.optional(),
  })
  .strict();

const statusSchema = z
  .object({
    applicationToken: applicationTokenSchema,
  })
  .strict();

type SettingReader = (key: string) => Promise<string | null>;

export interface BookBuyerJourneyRouteDeps {
  requireCheckout: typeof requireCheckoutSession;
  findBuyerContext: typeof findBookBuyerCheckoutContext;
  createApplication: typeof createBookAuditApplication;
  transitionApplication: typeof transitionBookAuditApplication;
  upsertAppointment: typeof upsertBookAppointment;
  getJourneyState: typeof getBookBuyerJourneyState;
  getSetting: SettingReader;
}

const defaultDeps: BookBuyerJourneyRouteDeps = {
  requireCheckout: requireCheckoutSession,
  findBuyerContext: findBookBuyerCheckoutContext,
  createApplication: createBookAuditApplication,
  transitionApplication: transitionBookAuditApplication,
  upsertAppointment: upsertBookAppointment,
  getJourneyState: getBookBuyerJourneyState,
  getSetting: async (key) => (await storage.getSystemSetting(key))?.value ?? null,
};

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpError(503, "Service configuration error", { expose: false });
  }
  return secret;
}

function signApplicationToken(applicationId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      applicationId,
      expiresAt: Date.now() + JOURNEY_TOKEN_TTL_MS,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", getSessionSecret())
    .update(`${JOURNEY_TOKEN_DOMAIN}\n${payload}`, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

function signaturesEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function verifyApplicationToken(token: string): string {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw new HttpError(404, "Application not found");
  }
  const expected = createHmac("sha256", getSessionSecret())
    .update(`${JOURNEY_TOKEN_DOMAIN}\n${payload}`, "utf8")
    .digest("base64url");
  if (!signaturesEqual(expected, suppliedSignature)) {
    throw new HttpError(404, "Application not found");
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      applicationId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof decoded.applicationId !== "string" ||
      decoded.applicationId.length < 1 ||
      typeof decoded.expiresAt !== "number" ||
      !Number.isFinite(decoded.expiresAt) ||
      decoded.expiresAt <= Date.now()
    ) {
      throw new Error("invalid application token");
    }
    return decoded.applicationId;
  } catch {
    throw new HttpError(404, "Application not found");
  }
}

function encodeRoutingDecision(decision: BookBuyerQualificationDecision): string {
  return `${ROUTING_MARKER_PREFIX}${decision.outcome}:${decision.reason}`;
}

function decodeRoutingDecision(
  value: string | null,
): BookBuyerQualificationDecision | null {
  if (!value?.startsWith(ROUTING_MARKER_PREFIX)) return null;
  const [outcome, reason, extra] = value.slice(ROUTING_MARKER_PREFIX.length).split(":");
  if (
    extra ||
    !["qualified", "alternate_next_step", "manual_review"].includes(outcome) ||
    ![
      "policy_missing_or_invalid",
      "policy_disabled",
      "role_not_eligible",
      "timeline_not_eligible",
      "answer_band_ambiguous",
      "approved_policy_match",
      "approved_policy_no_match",
    ].includes(reason)
  ) {
    return null;
  }
  return {
    outcome: outcome as BookBuyerRoutingOutcome,
    reason: reason as BookBuyerQualificationDecision["reason"],
  };
}

function outcomeForState(
  state: BookBuyerJourneyState,
): BookBuyerRoutingOutcome | "in_progress" | "processing" {
  const status = state.application.status;
  if (status === "qualified") return "qualified";
  if (status === "not_qualified") return "alternate_next_step";
  if (status === "submitted") {
    const decision = decodeRoutingDecision(state.application.decisionReason);
    if (
      decision?.outcome === "qualified" ||
      decision?.outcome === "alternate_next_step"
    ) {
      return "processing";
    }
    return "manual_review";
  }
  return "in_progress";
}

function publicAppointment(state: BookBuyerJourneyState) {
  const appointment = state.appointment;
  if (!appointment || appointment.status !== "scheduled" || !appointment.scheduledAt) {
    return { status: appointment?.status ?? "pending" };
  }
  return {
    status: "scheduled" as const,
    scheduledAt: appointment.scheduledAt.toISOString(),
    endAt: appointment.endAt?.toISOString() ?? null,
    timezone: appointment.timezone,
    meetingTypeName: appointment.meetingTypeName,
    hostName: appointment.hostName,
    meetingLink: appointment.meetingLink,
  };
}

async function publicJourneyState(
  deps: BookBuyerJourneyRouteDeps,
  state: BookBuyerJourneyState,
  applicationToken: string,
) {
  const outcome = outcomeForState(state);
  let calendar: { available: boolean; url?: string } = { available: false };
  if (outcome === "qualified") {
    const config = parseBookBuyerGhlCalendar(
      await deps.getSetting(BOOK_BUYER_GHL_CALENDAR_SETTING),
    );
    if (config) {
      calendar = {
        available: true,
        url: buildBookBuyerCalendarUrl(config, state.buyer),
      };
    }
  }
  return {
    applicationToken,
    outcome,
    calendar,
    appointment: publicAppointment(state),
  };
}

async function advanceSubmittedApplication(
  deps: BookBuyerJourneyRouteDeps,
  state: BookBuyerJourneyState,
): Promise<BookBuyerJourneyState> {
  if (state.application.status !== "submitted") return state;
  const decision = decodeRoutingDecision(state.application.decisionReason);
  if (!decision || decision.outcome === "manual_review") return state;

  if (decision.outcome === "qualified") {
    // Provision first. If this idempotent step fails, status remains submitted
    // with the durable routing marker so any retry can safely resume.
    await deps.upsertAppointment({ auditApplicationId: state.application.id });
  }
  await deps.transitionApplication({
    applicationId: state.application.id,
    fromStatus: "submitted",
    toStatus:
      decision.outcome === "qualified" ? "qualified" : "not_qualified",
    decisionReason: decision.reason,
  });
  return (await deps.getJourneyState(state.application.id)) ?? state;
}

async function requireJourneyState(
  deps: BookBuyerJourneyRouteDeps,
  token: string,
): Promise<{ applicationId: string; state: BookBuyerJourneyState }> {
  const applicationId = verifyApplicationToken(token);
  const state = await deps.getJourneyState(applicationId);
  if (!state) throw new HttpError(404, "Application not found");
  return { applicationId, state };
}

export function registerBookBuyerJourneyRoutes(
  app: Express,
  overrides: Partial<BookBuyerJourneyRouteDeps> = {},
): void {
  const deps = { ...defaultDeps, ...overrides };

  // capability_token: completed checkout resume token.
  app.post(
    "/api/book/journey/start",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Invalid request");

      const checkout = await deps.requireCheckout(parsed.data.resumeToken, {
        allowCompleted: true,
      });
      if (checkout.status !== "completed" || checkout.paymentState !== "captured") {
        throw new HttpError(409, "Purchase confirmation is still processing");
      }
      const buyer = await deps.findBuyerContext(checkout.id);
      if (!buyer) throw new HttpError(409, "Purchase confirmation is still processing");

      try {
        const created = await deps.createApplication({
          contactId: buyer.contactId,
          orderId: buyer.orderId,
          // Server-derived identity: one completed order can create exactly one
          // buyer application regardless of caller retries or browser storage.
          idempotencyKey: `book-buyer-order:${buyer.orderId}`,
          answers: null,
        });

        // Task #5105 — emit bonus.viewed outbox entry on first entry into the
        // buyer bonus qualification journey. Idempotent: onConflictDoNothing on
        // the key prevents duplicates on replay. The write is AWAITED before we
        // respond so the entry cannot be lost by process death, then a
        // post-commit kick drains it; a lost kick is recovered by boot catch-up.
        // A failure here is logged but does not fail the (already successful)
        // application creation.
        if (created.created) {
          try {
            await insertOutboxEntry({
              eventType: "bonus.viewed",
              sourceType: "application",
              sourceId: created.application.id,
              payload: {
                applicationId: created.application.id,
                contactId: buyer.contactId,
                orderId: buyer.orderId,
              },
              idempotencyKey: `bonus-viewed:${created.application.id}`,
            });
            const { kickGhlOutboundSyncFireAndForget } = await import(
              "../services/ghlOutboundKick"
            );
            kickGhlOutboundSyncFireAndForget();
          } catch (err: unknown) {
            console.error(
              `[bookBuyerJourney] bonus.viewed outbox insert failed for application ${created.application.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        const applicationToken = signApplicationToken(created.application.id);
        let state = await deps.getJourneyState(created.application.id);
        if (!state) throw new HttpError(503, "Unable to prepare application");
        state = await advanceSubmittedApplication(deps, state);
        res.status(created.created ? 201 : 200).json(
          await publicJourneyState(deps, state, applicationToken),
        );
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          throw new HttpError(409, "Application conflict");
        }
        throw error;
      }
    }),
  );

  // capability_token: signed application token.
  app.post(
    "/api/book/journey/submit",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Invalid request");
      const { applicationId, state: initial } = await requireJourneyState(
        deps,
        parsed.data.applicationToken,
      );
      let state = initial;
      if (initial.application.status === "draft") {
        if (!parsed.data.answers) throw new HttpError(400, "Invalid request");
        const policy = parseBookBuyerQualificationPolicy(
          await deps.getSetting(BOOK_BUYER_QUALIFICATION_POLICY_SETTING),
        );
        const decision = evaluateBookBuyerQualification(parsed.data.answers, policy);
        await deps.transitionApplication({
          applicationId,
          fromStatus: "draft",
          toStatus: "submitted",
          answers: parsed.data.answers,
          decisionReason: encodeRoutingDecision(decision),
        });
      }

      const refreshed = await deps.getJourneyState(applicationId);
      if (!refreshed) throw new HttpError(404, "Application not found");
      state = refreshed;
      state = await advanceSubmittedApplication(deps, state);
      res.json(await publicJourneyState(deps, state, parsed.data.applicationToken));
    }),
  );

  // capability_token: signed application token, including direct-refresh recovery.
  app.post(
    "/api/book/journey/status",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Invalid request");
      const { state } = await requireJourneyState(deps, parsed.data.applicationToken);
      res.json(await publicJourneyState(deps, state, parsed.data.applicationToken));
    }),
  );
}