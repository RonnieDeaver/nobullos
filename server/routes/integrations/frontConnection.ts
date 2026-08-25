/**
 * Integrations routes — Front webhook receiver.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 1132–1250, 1316–1337); sections: Front webhook receiver; auth history; disconnect; reset-sync.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import {
  invalidateIntegrationStatus,
} from "../../services/integrationStatusCache";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import type { FrontWebhookPayload } from "../../services/frontWebhookIngestion";
import type { AuthenticatedRequest, RawBodyWebhookRequest } from "../requestContext";

export function registerIntegrationsFrontConnectionRoutes(app: Express) {
  // F9 (Task #4155): typed contexts on the high-risk mutating handlers below;
  // `challenge` extends the payload type for the legacy body-borne echo only.
  app.post("/api/integrations/front/webhook", async (req: RawBodyWebhookRequest<FrontWebhookPayload & { challenge?: unknown }>, res) => {
    try {
      const { PERF } = await import("../../perfConfig");
      if (!PERF.FRONT_EVENT_INGEST_ENABLED) {
        return res.status(200).json({ ok: true, status: "feature_disabled" });
      }

      // Audit A-003: fail closed. A missing/blank FRONT_WEBHOOK_SECRET must
      // never authenticate a delivery in production (mirrors the Twilio
      // `validateTwilioWebhook` and report-import A-002 conventions: 503 in
      // production, explicit warn-and-allow in dev/test only). Rejection
      // happens before any DB mutation or downstream ingestion.
      //
      // Task #3992: FRONT_WEBHOOK_SECRET holds the Front APPLICATION SIGNING
      // KEY (not the OAuth client secret, not an API token). Front signs
      // `base64(HMAC-SHA256("{x-front-request-timestamp}:" + rawBody, key))`,
      // so verification is timestamp-prefixed and the timestamp freshness
      // check runs BEFORE the signature check. ALL handlers below (the Front
      // `sync` save-time validation, the legacy `url_validation` echo, and
      // normal ingestion) run only after secret-presence + timestamp +
      // signature validation pass; the non-production missing-secret
      // warn-and-allow is the sole explicit exception (audit A-003).
      const {
        isFrontWebhookSecretConfigured,
        isFrontWebhookTimestampWithinWindow,
        verifyFrontWebhookSignature,
      } = await import("../../services/frontWebhookIngestion");
      const webhookSecret = process.env.FRONT_WEBHOOK_SECRET;
      if (!isFrontWebhookSecretConfigured()) {
        if (process.env.NODE_ENV === "production") {
          console.error(
            "[FrontWebhook] Refusing webhook: FRONT_WEBHOOK_SECRET not configured — cannot verify X-Front-Signature in production",
          );
          return res.status(503).json({ error: "Webhook auth not configured" });
        }
        console.warn(
          "[FrontWebhook] FRONT_WEBHOOK_SECRET not configured — skipping signature verification (non-production only)",
        );
      } else {
        const timestamp = req.headers["x-front-request-timestamp"] as string | undefined;
        if (!isFrontWebhookTimestampWithinWindow(timestamp)) {
          console.warn(
            "[FrontWebhook] Missing/malformed/stale x-front-request-timestamp — rejecting",
          );
          return res.status(401).json({ error: "Invalid or stale timestamp" });
        }
        const signature = req.headers["x-front-signature"] as string | undefined;
        // F9: the boot verify hook (httpApp.ts) stores the exact request bytes
        // as a Buffer; `rawBody` is declared `unknown` globally — narrow at the
        // verification call only, never re-serialize.
        const rawBody = req.rawBody as Buffer | undefined;
        if (!rawBody || !verifyFrontWebhookSignature(rawBody, signature, timestamp, webhookSecret!)) {
          console.warn("[FrontWebhook] Invalid signature — rejecting");
          return res.status(401).json({ error: "Invalid signature" });
        }
      }

      // Task #3992 — Front application-webhook save-time validation: Front
      // POSTs `{type:'sync', authorization:{id}}` with the challenge in the
      // `x-front-challenge` HEADER and expects it echoed back within 10s
      // (a JSON `{"challenge":"<value>"}` reply is valid). Runs only after
      // the gate above.
      if (req.body?.type === "sync") {
        const challenge = req.headers["x-front-challenge"];
        return res
          .status(200)
          .json({ challenge: typeof challenge === "string" ? challenge : "" });
      }

      // Legacy compatibility echo (body-borne challenge) — retained
      // unchanged; also gated above.
      if (req.body?.type === "url_validation") {
        return res.status(200).json({ challenge: req.body.challenge });
      }

      const { handleFrontWebhook } = await import("../../services/frontWebhookIngestion");
      const { withDbHoldLabel } = await import("../../db");
      // Task #818 Phase 0: tag the API-side Front webhook receiver so
      // burst-time client holds attribute back to this entry point.
      const result = await withDbHoldLabel("front_webhook_receive", () =>
        handleFrontWebhook(req.body),
      );
      res.status(200).json({ ok: true, id: result.id, deduplicated: result.deduplicated });
    } catch (error: any) {
      console.error("[FrontWebhook] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task #2142 — read-only Front auth-death history for the Integrations
  // Hub. Surfaces the durable death records (`front_auth_death:last` /
  // `:recent`) so an operator can see *when/why* Front last died (HTTP
  // status, body snippet, environment, last successful Front call) and
  // confirm a reconnect actually fixed it. Account-manager read access.
  app.get("/api/integrations/front/auth-history", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getLastFrontAuthDeath, getRecentFrontAuthDeaths } = await import(
        "../../services/frontAuthDeathDiagnostics"
      );
      const [last, recent] = await Promise.all([
        getLastFrontAuthDeath(),
        getRecentFrontAuthDeaths(),
      ]);
      res.json({ last, recent });
    } catch (error: any) {
      console.error("[Front] auth-history read failed:", error?.message ?? error);
      res.status(500).json({ error: "Failed to read Front auth history" });
    }
  });

  app.post("/api/integrations/front/disconnect", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { disconnect } = await import("../../services/frontIntegration");
      await disconnect(req.user?.claims?.sub, { trigger: "manual_disconnect" });
      await invalidateIntegrationStatus(["front", "unmatchedCount"]);
      res.json({ success: true, message: "Front disconnected — all tokens and sync state cleared" });
    } catch (error: any) {
      console.error("[Front] Disconnect error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/front/reset-sync", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { purgeRecords } = (req.body || {}) as { purgeRecords?: unknown };
      const { reEvaluateExistingUnmatchedProducer } = await import("../../services/frontIntegration");

      let deletedCount = 0;
      if (purgeRecords) {
        deletedCount = await storage.deleteAllFrontSyncEmails();
      }
      console.log(`[Front] Sync reset. ${purgeRecords ? `Purged ${deletedCount} sync records.` : "Records preserved."}`);

      let reEvalResult = null;
      reEvalResult = await reEvaluateExistingUnmatchedProducer();
      console.log(`[Front] Re-evaluation enqueued: ${reEvalResult.enqueued} jobs for ${reEvalResult.total} unmatched emails`);

      res.json({ success: true, recordsPurged: deletedCount, reEvalResult });
    } catch (error: any) {
      console.error("[Front] Reset sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

}
