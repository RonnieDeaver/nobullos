// Task #4334 — Outbound client-facing email: admin surface + public endpoints.
//
// Admin (`/api/outbound-email/*`, team-lead+ reads, CEO-gated lane settings):
//   compose, send log, day counters, suppression CRUD, user→Front-channel
//   mailbox mapping, settings, domain verification, owner-gated SendGrid
//   fallback enable (structurally impossible without a passing, just-run
//   verification — see services/outboundEmail.setSendgridFallbackEnabled).
//
// Public:
//   GET/POST /api/email/unsubscribe — per-recipient capability token
//     (`{sendId}.{random128}` compared constant-time against the stored row).
//     GET renders a confirm page and NEVER suppresses (link scanners follow
//     GETs); POST performs the suppression — the same URL serves RFC 8058
//     one-click POSTs from mail clients.
//   POST /api/webhooks/sendgrid-events — SendGrid signed event webhook
//     (ECDSA P-256 over timestamp+rawBody). FAIL CLOSED: 503 when
//     SENDGRID_WEBHOOK_PUBLIC_KEY is unset, 401 on bad signature or stale
//     timestamp. Feeds bounce/complaint/unsubscribe into the suppression
//     list and annotates send-log rows via custom_args.send_id.

import type { Express, Response } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireTeamLead, writeLimiter, hasRole } from "./middleware";
import type { AuthenticatedRequest, RawBodyWebhookRequest } from "./requestContext";
import {
  composeOutboundEmails,
  ensureSuppressionSeeded,
  redeemUnsubscribeToken,
  applySendgridEvents,
  runSendgridDomainVerification,
  setSendgridFallbackEnabled,
  SendgridEnableBlockedError,
  readVerificationSnapshot,
  getDefaultDailyCap,
  utcDayOf,
  OUTBOUND_EMAIL_DAILY_CAP_DEFAULT_KEY,
  OUTBOUND_EMAIL_PAUSED_KEY,
  OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY,
  OUTBOUND_MARKETING_DOMAIN_KEY,
  OUTBOUND_SENDGRID_FROM_EMAIL_KEY,
  addEmailSuppressionWithSideEffects,
} from "../services/outboundEmail";
import {
  listEmailSuppressions,
  deleteEmailSuppression,
  listUserEmailIdentities,
  getUserEmailIdentity,
  upsertUserEmailIdentity,
  listOutboundEmails,
  listOutboundEmailsByBatch,
  getOutboundEmailDayCounters,
  normalizeEmailAddress,
} from "../storage/outboundEmailStorage";
import {
  SUPPRESSION_REASONS,
  OUTBOUND_EMAIL_STATUSES,
  OUTBOUND_EMAIL_PATHS,
} from "@shared/schema";
import {
  getSystemSettingFresh,
  setSystemSetting,
} from "../storage/settingsStorage";

// ── Schemas ──────────────────────────────────────────────────────────────────

const composeSchema = z.object({
  senderUserId: z.string().trim().min(1).max(100).optional(),
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().trim().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).optional().nullable(),
  messageClass: z.enum(["transactional", "marketing"]),
  recipients: z
    .array(
      z.object({
        email: z.string().trim().email().max(320),
        clientId: z.string().uuid().optional().nullable(),
      }),
    )
    .min(1)
    .max(200),
  clientBatchKey: z.string().trim().min(1).max(200).optional(),
});

const logQuerySchema = z.object({
  status: z.enum(OUTBOUND_EMAIL_STATUSES).optional(),
  path: z.enum(OUTBOUND_EMAIL_PATHS).optional(),
  senderUserId: z.string().trim().min(1).max(100).optional(),
  batchId: z.string().trim().min(1).max(100).optional(),
  toEmail: z.string().trim().min(1).max(320).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const suppressionAddSchema = z.object({
  email: z.string().trim().email().max(320),
  reason: z.enum(SUPPRESSION_REASONS).default("manual"),
  notes: z.string().trim().max(500).optional(),
});

const suppressionListQuerySchema = z.object({
  search: z.string().trim().max(320).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const identityPutSchema = z.object({
  frontChannelId: z.string().trim().min(1).max(200),
  fromEmail: z.string().trim().email().max(320),
  dailyCap: z.number().int().min(1).max(2000).optional().nullable(),
  active: z.boolean().default(true),
});

const settingsPutSchema = z
  .object({
    defaultDailyCap: z.number().int().min(1).max(2000).optional(),
    marketingDomain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a bare domain like example.com")
      .max(253)
      .optional(),
    sendgridFromEmail: z.string().trim().toLowerCase().email().max(320).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "no settings provided" });

const pauseSchema = z.object({ paused: z.boolean() });
const fallbackEnabledSchema = z.object({ enabled: z.boolean() });

// ── Public unsubscribe page helpers ──────────────────────────────────────────

const unsubscribeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in a minute." },
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unsubscribePage(body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Email preferences — NoBull Marketing</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0b0c;color:#f5f5f4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{max-width:420px;padding:40px 36px;background:#161618;border:1px solid #2a2a2e;border-radius:12px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:14px;line-height:1.6;color:#a8a8ad;margin:0 0 20px}
  button{background:#d4a843;color:#111;border:none;border-radius:8px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#e0b957}
</style></head>
<body><div class="card">${body}</div></body></html>`;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerOutboundEmailRoutes(app: Express): void {
  // ── Compose (the seam's front door) ────────────────────────────────────
  app.post(
    "/api/outbound-email/compose",
    isAuthenticated,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = composeSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const actorId = req.user?.claims?.sub as string | undefined;
        if (!actorId) return res.status(401).json({ error: "Unauthorized" });
        const d = parsed.data;
        const senderUserId = d.senderUserId ?? actorId;
        if (senderUserId !== actorId) {
          // Sending AS someone else is a lead+ operation.
          const actor = await storage.getUser(actorId);
          if (!actor || !hasRole(actor.role, "team_lead")) {
            return res.status(403).json({ error: "Only team leads can compose on behalf of another sender" });
          }
          const sender = await storage.getUser(senderUserId);
          if (!sender) return res.status(400).json({ error: "Unknown sender user" });
        }
        const result = await composeOutboundEmails({
          senderUserId,
          createdBy: actorId,
          subject: d.subject,
          bodyText: d.bodyText,
          bodyHtml: d.bodyHtml ?? null,
          messageClass: d.messageClass,
          recipients: d.recipients,
          clientBatchKey: d.clientBatchKey,
        });
        return res.status(202).json(result);
      } catch (err) {
        console.error("[outbound-email] compose failed:", err);
        return res.status(500).json({ error: "Compose failed" });
      }
    },
  );

  // ── Send log + batch detail + counters ─────────────────────────────────
  app.get("/api/outbound-email/log", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = logQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
    const { limit, offset, ...filters } = parsed.data;
    const result = await listOutboundEmails({ ...filters, limit, offset });
    return res.json(result);
  });

  app.get("/api/outbound-email/batches/:batchId", isAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
    const actorId = req.user?.claims?.sub as string | undefined;
    if (!actorId) return res.status(401).json({ error: "Unauthorized" });
    const batchId = String(req.params.batchId || "").slice(0, 100);
    const rows = await listOutboundEmailsByBatch(batchId);
    if (rows.length === 0) return res.json({ rows: [] });
    if (rows[0].senderUserId !== actorId && rows[0].createdBy !== actorId) {
      const actor = await storage.getUser(actorId);
      if (!actor || !hasRole(actor.role, "team_lead")) {
        return res.status(403).json({ error: "Not your batch" });
      }
    }
    return res.json({ rows });
  });

  app.get("/api/outbound-email/counters", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res: Response) => {
    const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
      ? req.query.day
      : utcDayOf(new Date());
    const [counters, identities, defaultCap] = await Promise.all([
      getOutboundEmailDayCounters(day),
      listUserEmailIdentities(),
      getDefaultDailyCap(),
    ]);
    const capsByUser: Record<string, number> = {};
    for (const identity of identities) {
      capsByUser[identity.userId] = identity.dailyCap ?? defaultCap;
    }
    return res.json({ day, defaultCap, capsByUser, ...counters });
  });

  // ── Suppression list ────────────────────────────────────────────────────
  app.get("/api/outbound-email/suppressions", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = suppressionListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
    // Lazy one-time seed from historical website unsubscribe inquiries.
    await ensureSuppressionSeeded();
    const result = await listEmailSuppressions(parsed.data);
    return res.json(result);
  });

  app.post(
    "/api/outbound-email/suppressions",
    isAuthenticated,
    requireTeamLead,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = suppressionAddSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const actorId = req.user?.claims?.sub as string | undefined;
      // Task #4335 — suppression side effects (cancel active sequence
      // enrollments for the address) are centralized in the service
      // helper; never write the row directly from a route.
      const row = await addEmailSuppressionWithSideEffects({
        email: parsed.data.email,
        reason: parsed.data.reason,
        source: "manual",
        notes: parsed.data.notes,
        createdBy: actorId,
        cancelNote: "Suppressed manually from the admin list",
      });
      return res.status(201).json(row);
    },
  );

  app.delete(
    "/api/outbound-email/suppressions/:id",
    isAuthenticated,
    requireTeamLead,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const id = String(req.params.id || "").slice(0, 100);
      const removed = await deleteEmailSuppression(id);
      return res.json({ ok: true, removed });
    },
  );

  // ── Mailbox mapping (user → own Front channel) ─────────────────────────
  app.get("/api/outbound-email/identities", isAuthenticated, requireTeamLead, async (_req: AuthenticatedRequest, res: Response) => {
    const identities = await listUserEmailIdentities();
    return res.json({ identities });
  });

  app.get("/api/outbound-email/front-channels", isAuthenticated, requireTeamLead, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const { listFrontChannels } = await import("../services/frontIntegration");
      const channels = await listFrontChannels();
      return res.json({
        channels: channels.map((c: any) => ({
          id: c?.id ?? null,
          name: c?.name ?? null,
          address: c?.address ?? null,
          type: c?.types?.[0] ?? c?.type ?? null,
          sendAs: c?.send_as ?? null,
        })),
      });
    } catch (err) {
      // Visible degraded state — the mapping table still renders.
      const message = err instanceof Error ? err.message : "Front channel listing failed";
      return res.json({ channels: [], error: message });
    }
  });

  app.put(
    "/api/outbound-email/identities/:userId",
    isAuthenticated,
    requireTeamLead,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = identityPutSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const actorId = req.user?.claims?.sub as string | undefined;
      if (!actorId) return res.status(401).json({ error: "Unauthorized" });
      const userId = String(req.params.userId || "").slice(0, 100);
      const target = await storage.getUser(userId);
      if (!target) return res.status(404).json({ error: "Unknown user" });
      const identity = await upsertUserEmailIdentity({
        userId,
        frontChannelId: parsed.data.frontChannelId,
        fromEmail: normalizeEmailAddress(parsed.data.fromEmail),
        dailyCap: parsed.data.dailyCap ?? null,
        active: parsed.data.active,
        updatedBy: actorId,
      });
      return res.json(identity);
    },
  );

  // ── Settings + SendGrid lane governance ────────────────────────────────
  app.get("/api/outbound-email/settings", isAuthenticated, requireTeamLead, async (_req: AuthenticatedRequest, res: Response) => {
    const [capSetting, paused, enabled, domain, fromEmail, snapshot, defaultCap] = await Promise.all([
      getSystemSettingFresh(OUTBOUND_EMAIL_DAILY_CAP_DEFAULT_KEY),
      getSystemSettingFresh(OUTBOUND_EMAIL_PAUSED_KEY),
      getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY),
      getSystemSettingFresh(OUTBOUND_MARKETING_DOMAIN_KEY),
      getSystemSettingFresh(OUTBOUND_SENDGRID_FROM_EMAIL_KEY),
      readVerificationSnapshot(),
      getDefaultDailyCap(),
    ]);
    return res.json({
      defaultDailyCap: defaultCap,
      defaultDailyCapRaw: capSetting?.value ?? null,
      paused: paused?.value === "true",
      fallbackEnabled: enabled?.value === "true",
      marketingDomain: domain?.value ?? null,
      sendgridFromEmail: fromEmail?.value ?? null,
      verification: snapshot,
      sendgridConfigured: !!process.env.SENDGRID_API_KEY,
      webhookConfigured: !!process.env.SENDGRID_WEBHOOK_PUBLIC_KEY,
    });
  });

  app.put(
    "/api/outbound-email/settings",
    isAuthenticated,
    requireCeo,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = settingsPutSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const actorId = req.user?.claims?.sub as string | undefined;
      const d = parsed.data;
      let fallbackDisabled = false;
      if (d.defaultDailyCap !== undefined) {
        await setSystemSetting(OUTBOUND_EMAIL_DAILY_CAP_DEFAULT_KEY, String(d.defaultDailyCap), actorId);
      }
      if (d.marketingDomain !== undefined || d.sendgridFromEmail !== undefined) {
        if (d.marketingDomain !== undefined) {
          await setSystemSetting(OUTBOUND_MARKETING_DOMAIN_KEY, d.marketingDomain, actorId);
        }
        if (d.sendgridFromEmail !== undefined) {
          await setSystemSetting(OUTBOUND_SENDGRID_FROM_EMAIL_KEY, d.sendgridFromEmail, actorId);
        }
        // Changing the lane's identity invalidates the enablement decision:
        // force the owner to re-run the enable ceremony (which re-verifies).
        const enabled = await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY);
        if (enabled?.value === "true") {
          await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "false", actorId);
          fallbackDisabled = true;
        }
      }
      return res.json({ ok: true, fallbackDisabled });
    },
  );

  app.post(
    "/api/outbound-email/pause",
    isAuthenticated,
    requireTeamLead,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = pauseSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const actorId = req.user?.claims?.sub as string | undefined;
      await setSystemSetting(OUTBOUND_EMAIL_PAUSED_KEY, parsed.data.paused ? "true" : "false", actorId);
      return res.json({ ok: true, paused: parsed.data.paused });
    },
  );

  app.post(
    "/api/outbound-email/verify-domain",
    isAuthenticated,
    requireCeo,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const actorId = req.user?.claims?.sub as string | undefined;
      const snapshot = await runSendgridDomainVerification(actorId);
      if (!snapshot) {
        return res.status(400).json({ error: "Set the marketing domain first (Settings tab)" });
      }
      return res.json({ verification: snapshot });
    },
  );

  app.post(
    "/api/outbound-email/fallback-enabled",
    isAuthenticated,
    requireCeo,
    writeLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = fallbackEnabledSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const actorId = req.user?.claims?.sub as string | undefined;
      if (!actorId) return res.status(401).json({ error: "Unauthorized" });
      try {
        const snapshot = await setSendgridFallbackEnabled(parsed.data.enabled, actorId);
        return res.json({ ok: true, enabled: parsed.data.enabled, verification: snapshot });
      } catch (err) {
        if (err instanceof SendgridEnableBlockedError) {
          return res.status(400).json({ error: err.message, failures: err.failures });
        }
        throw err;
      }
    },
  );

  // ── Public: unsubscribe (capability token) ─────────────────────────────
  app.get("/api/email/unsubscribe", unsubscribeLimiter, (req, res) => {
    const t = typeof req.query.t === "string" ? req.query.t : "";
    if (!t || t.length > 140) {
      return res
        .status(400)
        .type("html")
        .send(unsubscribePage("<h1>Link not valid</h1><p>This unsubscribe link is incomplete. Please use the link from your email.</p>"));
    }
    // NEVER suppress on GET — mail scanners prefetch links. Confirm via POST.
    return res.type("html").send(
      unsubscribePage(
        `<h1>Unsubscribe from our emails?</h1>
         <p>You will stop receiving marketing emails from NoBull Marketing at this address.</p>
         <form method="POST" action="/api/email/unsubscribe?t=${encodeURIComponent(t)}">
           <button type="submit">Unsubscribe</button>
         </form>`,
      ),
    );
  });

  app.post("/api/email/unsubscribe", unsubscribeLimiter, async (req, res) => {
    const t =
      typeof req.query.t === "string"
        ? req.query.t
        : typeof (req.body as any)?.t === "string"
          ? String((req.body as any).t)
          : "";
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (!t || t.length > 140) {
      return wantsHtml
        ? res.status(400).type("html").send(unsubscribePage("<h1>Link not valid</h1><p>This unsubscribe link is incomplete.</p>"))
        : res.status(400).json({ error: "missing token" });
    }
    const result = await redeemUnsubscribeToken(t);
    if (!result.ok) {
      const status = result.reasonCode === "malformed" ? 400 : 404;
      return wantsHtml
        ? res.status(status).type("html").send(unsubscribePage("<h1>Link not valid</h1><p>This unsubscribe link is invalid or has expired.</p>"))
        : res.status(status).json({ error: "invalid token" });
    }
    // Idempotent — repeat POSTs land here again harmlessly.
    return wantsHtml
      ? res.type("html").send(
          unsubscribePage(
            `<h1>You're unsubscribed</h1><p>${escapeHtml(result.email || "This address")} will no longer receive marketing emails from NoBull Marketing.</p>`,
          ),
        )
      : res.json({ ok: true });
  });

  // ── Public: SendGrid signed event webhook ──────────────────────────────
  app.post("/api/webhooks/sendgrid-events", async (req: RawBodyWebhookRequest, res: Response) => {
    try {
      const publicKeyB64 = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY?.trim();
      if (!publicKeyB64) {
        // FAIL CLOSED in every environment — an unverified event stream
        // must never feed the suppression list or the send log.
        console.error(
          "[sendgrid-webhook] SENDGRID_WEBHOOK_PUBLIC_KEY is not configured — rejecting events (fail closed).",
        );
        return res.status(503).json({ error: "SendGrid webhook verification key not configured" });
      }
      const signature = String(req.headers["x-twilio-email-event-webhook-signature"] || "");
      const timestamp = String(req.headers["x-twilio-email-event-webhook-timestamp"] || "");
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (!signature || !timestamp || !rawBody || rawBody.length === 0) {
        return res.status(401).json({ error: "Missing signature headers" });
      }
      // Bound replay: SendGrid stamps epoch seconds.
      const tsSeconds = Number(timestamp);
      if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 600) {
        return res.status(401).json({ error: "Stale or invalid timestamp" });
      }
      let verified = false;
      try {
        const key = crypto.createPublicKey({
          key: Buffer.from(publicKeyB64, "base64"),
          format: "der",
          type: "spki",
        });
        verified = crypto.verify(
          "sha256",
          Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]),
          { key, dsaEncoding: "der" },
          Buffer.from(signature, "base64"),
        );
      } catch {
        verified = false;
      }
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      const events = Array.isArray(req.body) ? req.body : [];
      const summary = await applySendgridEvents(events);
      return res.json({ ok: true, ...summary });
    } catch (err) {
      console.error("[sendgrid-webhook] event processing failed:", err);
      // 5xx keeps SendGrid's redelivery alive for transient failures.
      return res.status(500).json({ error: "Event processing failed" });
    }
  });
}
