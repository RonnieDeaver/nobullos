/**
 * Thin, local-only operator surface for book commerce oversight.
 *
 * Ordinary reads are deliberately confined to durable application records and
 * already-cached integration status. The only writes are narrowly-scoped,
 * idempotent repair commands that delegate to the existing payment replay,
 * delivery, and GHL outbox owners.
 */
// @db-pool-intent: api
import crypto from "node:crypto";
import type { Express, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { bookPaymentEvents } from "@shared/schema";
import { isAuthenticated } from "../middlewares/requireAuth";
import { asyncHandler } from "../observability/httpErrors";
import { requireTeamLead } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";

const idSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._~:-]*$/);
const idempotencyKeySchema = z.string().trim().min(16).max(96);

const rangeQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be before to",
  })
  .refine((value) => value.to.getTime() - value.from.getTime() <= 366 * 86_400_000, {
    message: "date range may not exceed 366 days",
  });

const recordsQuerySchema = z.object({
  search: z.string().trim().max(256).optional(),
  status: z
    .enum([
      "all",
      "pending",
      "completed",
      "exception",
      "refunded",
      "cancelled",
    ])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const exceptionsQuerySchema = z.object({
  kind: z
    .enum(["all", "payments", "ghl", "analytics", "delivery"])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const repairBodySchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

type UnknownRecord = Record<string, unknown>;

class BookPaymentReplayNotFoundError extends Error {
  constructor(paymentEventId: string) {
    super(`Book payment event ${paymentEventId} was not found.`);
    this.name = "BookPaymentReplayNotFoundError";
  }
}

class BookPaymentReplayNotEligibleError extends Error {
  constructor(paymentEventId: string, provider: string) {
    super(
      `Book payment event ${paymentEventId} is owned by ${provider}, not the Stripe replay lane.`,
    );
    this.name = "BookPaymentReplayNotEligibleError";
  }
}

class BookPaymentReplayPausedError extends Error {
  constructor() {
    super("Book payment processing is paused.");
    this.name = "BookPaymentReplayPausedError";
  }
}

export interface BookOperationsRouteDeps {
  authenticate?: RequestHandler;
  authorizeTeamLead?: RequestHandler;
  getSummary?: (input: { from: Date; to: Date }) => Promise<UnknownRecord>;
  listRecords?: (input: {
    search?: string;
    status?: string;
    limit: number;
    offset: number;
  }) => Promise<UnknownRecord>;
  getRecord?: (recordId: string) => Promise<UnknownRecord | null>;
  listExceptions?: (input: {
    kind?: "all" | "payments" | "ghl" | "analytics" | "delivery";
    limit: number;
    offset: number;
  }) => Promise<UnknownRecord>;
  readHealth?: () => Promise<UnknownRecord>;
  retryPaymentEvent?: (input: {
    paymentEventId: string;
    actorUserId: string;
    idempotencyKey: string;
  }) => Promise<UnknownRecord>;
  /** Test seam for the canonical book_payment_processing kill-switch read. */
  isPaymentProcessingPaused?: () => Promise<boolean>;
  replayOutbox?: (input: {
    outboxId: string;
    actorUserId: string;
    idempotencyKey: string;
  }) => Promise<UnknownRecord>;
}

async function defaultReadHealth(): Promise<UnknownRecord> {
  const { readCachedIntegrationStatusOnly } = await import(
    "../services/integrationStatusCache"
  );
  const { getBookLaunchReadinessReport } = await import(
    "../services/bookLaunchReadiness"
  );
  const [stripe, ghl, launchReadiness] = await Promise.all([
    readCachedIntegrationStatusOnly<{ connected: boolean; disconnectReason: string | null }>(
      "stripe",
    ),
    readCachedIntegrationStatusOnly<{ connected: boolean; disconnectReason: string | null }>(
      "ghl",
    ),
    getBookLaunchReadinessReport(),
  ]);
  return {
    source: "cache_only",
    providers: {
      stripe: {
        connected: stripe.value?.connected ?? null,
        disconnectReason: stripe.value?.disconnectReason ? "disconnected" : null,
        lastCheckedAt: stripe.lastCheckedAt,
        lastProbeError: stripe.lastProbeError ? "probe_failed" : null,
      },
      ghl: {
        connected: ghl.value?.connected ?? null,
        disconnectReason: ghl.value?.disconnectReason ? "disconnected" : null,
        lastCheckedAt: ghl.lastCheckedAt,
        lastProbeError: ghl.lastProbeError ? "probe_failed" : null,
      },
    },
    launchReadiness,
  };
}

async function auditPaymentReplay(input: {
  paymentEventId: string;
  actorUserId: string;
  idempotencyKey: string;
  outcome: UnknownRecord;
}): Promise<void> {
  const [{ getDb, withDbAttribution }, { insertLifecycleEventTx }] =
    await Promise.all([
      import("../db"),
      import("../storage/bookCommerceStorage"),
    ]);
  const keyDigest = crypto
    .createHash("sha256")
    .update(input.idempotencyKey)
    .digest("hex")
    .slice(0, 24);
  await withDbAttribution("route:book-operations:payment-replay-audit", async () => {
    await getDb().transaction(async (tx) => {
      const [event] = await tx
        .select({
          orderId: bookPaymentEvents.orderId,
          checkoutSessionId: bookPaymentEvents.checkoutSessionId,
          providerEventId: bookPaymentEvents.providerEventId,
        })
        .from(bookPaymentEvents)
        .where(eq(bookPaymentEvents.id, input.paymentEventId))
        .limit(1);
      if (!event) return;
      await insertLifecycleEventTx(tx, {
        orderId: event.orderId,
        checkoutSessionId: event.checkoutSessionId,
        eventType: "manual_correction",
        actorUserId: input.actorUserId,
        reason: "operator_requested_payment_reconciliation_retry",
        metadata: {
          paymentEventId: input.paymentEventId,
          providerEventId: event.providerEventId,
          attempted: Number(input.outcome.attempted ?? 0),
          processed: Number(input.outcome.processed ?? 0),
          needsReconciliation: Number(input.outcome.needsReconciliation ?? 0),
          errorCount: Array.isArray(input.outcome.errors)
            ? input.outcome.errors.length
            : 0,
        },
        idempotencyKey: `ops:reconcile:${input.paymentEventId.slice(0, 48)}:${keyDigest}`,
      });
    });
  });
}

async function defaultRetryPaymentEvent(input: {
  paymentEventId: string;
  actorUserId: string;
  idempotencyKey: string;
}, readPaused?: () => Promise<boolean>): Promise<UnknownRecord> {
  const isPaused =
    readPaused ??
    (async () => {
      const { ensureKillSwitchesLoaded, isKillSwitchEnabled } = await import(
        "../services/killSwitches"
      );
      await ensureKillSwitchesLoaded();
      return isKillSwitchEnabled("book_payment_processing");
    });
  if (await isPaused()) {
    throw new BookPaymentReplayPausedError();
  }

  const { getDb, withDbAttribution } = await import("../db");
  const [event] = await withDbAttribution(
    "route:book-operations:payment-replay-precheck",
    async () =>
      getDb()
        .select({
          id: bookPaymentEvents.id,
          provider: bookPaymentEvents.provider,
          processedAt: bookPaymentEvents.processedAt,
        })
        .from(bookPaymentEvents)
        .where(eq(bookPaymentEvents.id, input.paymentEventId))
        .limit(1),
  );
  if (!event) {
    throw new BookPaymentReplayNotFoundError(input.paymentEventId);
  }
  if (event.provider !== "stripe") {
    throw new BookPaymentReplayNotEligibleError(input.paymentEventId, event.provider);
  }
  if (event.processedAt) {
    const alreadySettled = {
      attempted: 0,
      processed: 0,
      needsReconciliation: 0,
      errors: [],
      moreLikely: false,
      alreadySettled: true,
    };
    await auditPaymentReplay({ ...input, outcome: alreadySettled });
    return alreadySettled;
  }

  const { replayPendingVerifiedBookEvents } = await import(
    "../storage/bookCheckoutEngineStorage"
  );
  const outcome = await replayPendingVerifiedBookEvents({
    limit: 1,
    paymentEventId: input.paymentEventId,
    onlyPaused: false,
    effectsPaused: false,
  });
  await auditPaymentReplay({ ...input, outcome: outcome as unknown as UnknownRecord });
  return outcome as unknown as UnknownRecord;
}

function badRequest(res: Response, issues: unknown): Response {
  return res.status(400).json({ error: "Invalid book operations request.", issues });
}

export function registerBookOperationsRoutes(
  app: Express,
  deps: BookOperationsRouteDeps = {},
): void {
  const authenticate = deps.authenticate ?? isAuthenticated;
  const authorizeTeamLead = deps.authorizeTeamLead ?? requireTeamLead;
  app.get(
    "/api/admin/book-operations/summary",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req, res) => {
      const parsed = rangeQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error.issues);
      const load =
        deps.getSummary ??
        (async (input) =>
          (await import("../services/bookOperations")).getBookOperationsSummary(input));
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(await load(parsed.data));
    }),
  );

  app.get(
    "/api/admin/book-operations/records",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req, res) => {
      const parsed = recordsQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error.issues);
      const load =
        deps.listRecords ??
        (async (input) =>
          (await import("../services/bookOperations")).listBookOperationRecords(input));
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(
        await load({
          ...parsed.data,
          search: parsed.data.search || undefined,
        }),
      );
    }),
  );

  app.get(
    "/api/admin/book-operations/records/:recordId",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req, res) => {
      const parsed = idSchema.safeParse(req.params.recordId);
      if (!parsed.success) return badRequest(res, parsed.error.issues);
      const load =
        deps.getRecord ??
        (async (recordId) =>
          (await import("../services/bookOperations")).getBookOperationRecord(recordId));
      const record = await load(parsed.data);
      if (!record) return res.status(404).json({ error: "Book commerce record not found." });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(record);
    }),
  );

  app.get(
    "/api/admin/book-operations/exceptions",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req, res) => {
      const parsed = exceptionsQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error.issues);
      const load =
        deps.listExceptions ??
        (async (input) =>
          (await import("../services/bookOperations")).listBookOperationExceptions(input));
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(await load(parsed.data));
    }),
  );

  app.get(
    "/api/admin/book-operations/health",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (_req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(await (deps.readHealth ?? defaultReadHealth)());
    }),
  );

  app.post(
    "/api/admin/book-operations/payment-events/:paymentEventId/retry",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const id = idSchema.safeParse(req.params.paymentEventId);
      const body = repairBodySchema.safeParse(req.body ?? {});
      if (!id.success || !body.success) {
        return badRequest(res, {
          id: id.success ? undefined : id.error.issues,
          body: body.success ? undefined : body.error.issues,
        });
      }
      const actorUserId = req.user?.claims?.sub;
      if (!actorUserId) return res.status(401).json({ error: "Unauthorized" });
      const repair =
        deps.retryPaymentEvent ??
        ((input) =>
          defaultRetryPaymentEvent(input, deps.isPaymentProcessingPaused));
      try {
        return res.status(202).json(await repair({
          paymentEventId: id.data,
          actorUserId,
          idempotencyKey: body.data.idempotencyKey,
        }));
      } catch (error) {
        if ((error as Error).name === "BookPaymentReplayNotFoundError") {
          return res.status(404).json({ error: "Book payment event not found." });
        }
        if ((error as Error).name === "BookPaymentReplayNotEligibleError") {
          return res.status(409).json({ error: "Payment event is not eligible for replay." });
        }
        if ((error as Error).name === "BookPaymentReplayPausedError") {
          return res.status(409).json({
            error: "Book payment processing is paused; reconciliation was not replayed.",
          });
        }
        throw error;
      }
    }),
  );

  app.post(
    "/api/admin/book-operations/outbox/:outboxId/replay",
    authenticate, // inventory-auth: isAuthenticated
    authorizeTeamLead, // inventory-role: requireTeamLead
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const id = idSchema.safeParse(req.params.outboxId);
      const body = repairBodySchema.safeParse(req.body ?? {});
      if (!id.success || !body.success) {
        return badRequest(res, {
          id: id.success ? undefined : id.error.issues,
          body: body.success ? undefined : body.error.issues,
        });
      }
      const actorUserId = req.user?.claims?.sub;
      if (!actorUserId) return res.status(401).json({ error: "Unauthorized" });
      const replay =
        deps.replayOutbox ??
        (async (input) =>
          (await import("../services/bookOperations")).replayBookOutboxEntry(input));
      let result: UnknownRecord;
      try {
        result = await replay({
          outboxId: id.data,
          actorUserId,
          idempotencyKey: body.data.idempotencyKey,
        });
      } catch (error) {
        if ((error as Error).name === "OutboxReplayNotFoundError") {
          return res.status(404).json({ error: "Book outbox entry not found." });
        }
        if ((error as Error).name === "OutboxReplayNotEligibleError") {
          return res.status(409).json({ error: "Outbox entry is not eligible for replay." });
        }
        throw error;
      }
      if (result.outcome === "replayed" || result.replayed === true) {
        const { kickGhlOutboundSyncJobSafe } = await import(
          "../services/ghlOutboundKick"
        );
        await kickGhlOutboundSyncJobSafe();
      }
      return res.status(202).json(result);
    }),
  );
}