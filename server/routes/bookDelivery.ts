/**
 * Secure paid-book delivery API.
 *
 * Public calls have deliberately uniform responses. A valid buyer capability
 * is accepted only in a POST body, then replaced by an HttpOnly session cookie;
 * no permanent object URL, token, object key, card detail, or intake state is
 * ever returned.
 */
import type { Express, Request, Response } from "express";
import { Transform } from "node:stream";
import { z } from "zod";
import { asyncHandler } from "../observability/httpErrors";
import { bookCheckoutLimiter } from "./bookCheckout";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { ObjectStorageService } from "../replit_integrations/object_storage";
import {
  BOOK_DELIVERY_COOKIE,
  authorizeBookDeliveryDownload,
  exchangeBookDeliveryCapability,
  getBookDeliveryOrderStatusForSession,
  listBookDeliveryAssetsForSession,
  recordBookDeliveryDownloadOutcome,
  requestBookDeliveryResend,
  supportReissueBookDelivery,
  supportResendBookDelivery,
} from "../services/bookDelivery";
import { revokeBookEntitlement } from "../storage/bookCommerceEventStorage";
import { revokeBookDeliveryCredentials } from "../storage/bookDeliveryStorage";

const exchangeSchema = z.object({ token: z.string().min(1).max(200) }).strict();
const resendSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const deliveryAssetIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const supportActionSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(96).regex(/^[A-Za-z0-9_-]+$/),
  reason: z.string().trim().min(3).max(400).optional(),
}).strict();

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function genericAccessDenied(res: Response): Response {
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(404).json({ error: "Access is unavailable." });
}

function attachmentName(name: string): string {
  return name.replace(/[^\w.\- ]/g, "_").slice(0, 180) || "download";
}

export interface BookDeliveryRouteDeps {
  listBookDeliveryAssetsForSession: typeof listBookDeliveryAssetsForSession;
  authorizeBookDeliveryDownload: typeof authorizeBookDeliveryDownload;
  recordBookDeliveryDownloadOutcome: typeof recordBookDeliveryDownloadOutcome;
  createPrivateObjectReadStream: (
    objectKey: string,
  ) => Promise<NodeJS.ReadableStream>;
}

const defaultBookDeliveryRouteDeps: BookDeliveryRouteDeps = {
  listBookDeliveryAssetsForSession,
  authorizeBookDeliveryDownload,
  recordBookDeliveryDownloadOutcome,
  createPrivateObjectReadStream: async (objectKey) =>
    new ObjectStorageService().createPrivateObjectReadStream(objectKey),
};

export function registerBookDeliveryRoutes(
  app: Express,
  overrides: Partial<BookDeliveryRouteDeps> = {},
): void {
  const deps: BookDeliveryRouteDeps = {
    ...defaultBookDeliveryRouteDeps,
    ...overrides,
  };
  // This body-only capability exchange is intentionally public. The future
  // access-center page reads an emailed URL fragment and immediately POSTs it;
  // fragments are never sent to this server or placed in query strings.
  app.post(
    "/api/book/delivery/exchange",
    bookCheckoutLimiter,
    asyncHandler(async (req, res) => {
      const parsed = exchangeSchema.safeParse(req.body);
      const session = parsed.success ? await exchangeBookDeliveryCapability(parsed.data.token) : null;
      if (!session) return genericAccessDenied(res);
      res.setHeader("Cache-Control", "private, no-store");
      res.cookie(BOOK_DELIVERY_COOKIE, session, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== "test",
        sameSite: "strict",
        path: "/api/book/delivery",
        maxAge: 30 * 60 * 1000,
      });
      return res.status(204).end();
    }),
  );

  // Always 202 with the same shape, even for malformed/unknown/suppressed
  // buyers. Rate limiting makes this non-enumerating path bounded.
  app.post(
    "/api/book/delivery/resend",
    bookCheckoutLimiter,
    asyncHandler(async (req, res) => {
      const parsed = resendSchema.safeParse(req.body);
      if (parsed.success) {
        try {
          await requestBookDeliveryResend(parsed.data.email);
        } catch (error) {
          // Do not leak configuration/mailbox status or an email/order match.
          console.error("[book-delivery] generic resend request failed", error instanceof Error ? error.message : "unknown");
        }
      }
      return res.status(202).json({ accepted: true });
    }),
  );

  app.get(
    "/api/book/delivery/assets",
    bookCheckoutLimiter,
    asyncHandler(async (req, res) => {
      const result = await deps.listBookDeliveryAssetsForSession(
        readCookie(req, BOOK_DELIVERY_COOKIE),
      );
      if (!result) return genericAccessDenied(res);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ assets: result.assets });
    }),
  );

  app.get(
    "/api/book/delivery/order-status",
    bookCheckoutLimiter,
    asyncHandler(async (req, res) => {
      const status = await getBookDeliveryOrderStatusForSession(
        readCookie(req, BOOK_DELIVERY_COOKIE),
      );
      if (!status) return genericAccessDenied(res);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ order: status });
    }),
  );

  app.get(
    "/api/book/delivery/download/:assetId",
    bookCheckoutLimiter,
    asyncHandler(async (req, res) => {
      const assetId = deliveryAssetIdSchema.safeParse(String(req.params.assetId ?? ""));
      if (!assetId.success) return genericAccessDenied(res);
      const authorization = await deps.authorizeBookDeliveryDownload({
        cookieValue: readCookie(req, BOOK_DELIVERY_COOKIE),
        assetId: assetId.data,
      });
      if (!authorization) return genericAccessDenied(res);
      const { asset, entitlement } = authorization;
      let outcomeRecorded = false;
      const recordOutcome = (
        outcome: "completed" | "unavailable" | "failed",
      ): void => {
        if (outcomeRecorded) return;
        outcomeRecorded = true;
        void deps.recordBookDeliveryDownloadOutcome({
          entitlementId: entitlement.id,
          assetId: asset.id,
          outcome,
        }).catch(() => {
          console.error("[book-delivery] download outcome audit failed");
        });
      };
      try {
        const stream = await deps.createPrivateObjectReadStream(asset.objectKey);
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${attachmentName(asset.filename)}"`);
        res.setHeader("Cache-Control", "private, no-store");
        let sent = 0;
        const sizeBound = new Transform({
          transform(chunk, _encoding, callback) {
            sent += Buffer.byteLength(chunk);
            if (sent > asset.maxBytes) {
              callback(new Error("asset exceeded configured delivery bound"));
              return;
            }
            callback(null, chunk);
          },
        });
        stream.on("error", () => {
          recordOutcome("unavailable");
          if (!res.headersSent) res.status(503).json({ error: "Download is temporarily unavailable." });
          else res.destroy();
        });
        sizeBound.on("error", () => {
          recordOutcome("failed");
          if (!res.headersSent) res.status(503).json({ error: "Download is temporarily unavailable." });
          else res.destroy();
        });
        res.once("finish", () => {
          if (res.statusCode < 400) recordOutcome("completed");
        });
        res.once("close", () => {
          if (res.writableFinished) return;
          const destroy = (stream as NodeJS.ReadableStream & {
            destroy?: () => void;
          }).destroy;
          if (typeof destroy === "function") destroy.call(stream);
          recordOutcome("failed");
        });
        stream.pipe(sizeBound).pipe(res);
      } catch (error) {
        // Object key and provider error intentionally never enter a buyer
        // response or an application log. Asset configuration is server-only.
        console.error("[book-delivery] authorized private stream unavailable");
        recordOutcome("unavailable");
        if (!res.headersSent) res.status(503).json({ error: "Download is temporarily unavailable." });
      }
    }),
  );

  app.post(
    "/api/admin/book-delivery/entitlements/:entitlementId/resend",
    isAuthenticated,
    requireTeamLead,
    asyncHandler(async (req: any, res) => {
      const parsed = supportActionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid support action." });
      await supportResendBookDelivery({
        entitlementId: req.params.entitlementId,
        actorUserId: req.user.claims.sub,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return res.status(202).json({ accepted: true });
    }),
  );

  app.post(
    "/api/admin/book-delivery/entitlements/:entitlementId/reissue",
    isAuthenticated,
    requireTeamLead,
    asyncHandler(async (req: any, res) => {
      const parsed = supportActionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid support action." });
      await supportReissueBookDelivery({
        entitlementId: req.params.entitlementId,
        actorUserId: req.user.claims.sub,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return res.status(202).json({ accepted: true });
    }),
  );

  app.post(
    "/api/admin/book-delivery/entitlements/:entitlementId/revoke",
    isAuthenticated,
    requireTeamLead,
    asyncHandler(async (req: any, res) => {
      const parsed = supportActionSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data.reason) {
        return res.status(400).json({ error: "A valid revocation reason is required." });
      }
      const actorUserId = req.user.claims.sub;
      const result = await revokeBookEntitlement({
        entitlementId: req.params.entitlementId,
        actorUserId,
        revokedReason: parsed.data.reason,
      });
      await revokeBookDeliveryCredentials({
        entitlementIds: [req.params.entitlementId],
        actorUserId,
        reason: `support_revoke:${parsed.data.idempotencyKey}`,
      });
      return res.status(200).json({ revoked: result.revoked });
    }),
  );
}