/**
 * Integrations routes — Zoom transcript backfill.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 5066–5081, 6419–6509); sections: Zoom transcript backfill; Zoom webhook receiver.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireTeamLead } from "../middleware";
import type { RawBodyWebhookRequest } from "../requestContext";

export function registerIntegrationsZoomRoutes(app: Express) {
  app.post("/api/integrations/zoom/transcript-backfill", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { submitRepairJob } = await import("../../services/workQueueHandlers");
      const jobId = await submitRepairJob({
        queueName: "zoom_transcript_backfill",
        workloadClass: "interactive_repair",
        maxAttempts: 2,
      });

      return res.status(202).json({ success: true, jobId, message: "Zoom transcript backfill job enqueued." });
    } catch (error: any) {
      console.error("[Integrations] Zoom transcript backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // F9 (Task #4155): typed webhook context. This receiver's known quirk —
  // signing input derived via JSON.stringify(req.body) rather than req.rawBody
  // — is preserved verbatim; F9 must not change byte-path behavior.
  app.post("/api/integrations/zoom/webhook", async (req: RawBodyWebhookRequest, res) => {
    try {
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (body?.event === "endpoint.url_validation") {
        const plainToken = body?.payload?.plainToken;
        if (!plainToken) {
          return res.status(400).json({ error: "Missing plainToken in CRC challenge" });
        }
        const { handleZoomCrcChallenge } = await import("../../services/zoomIntegration");
        // Task #3982 — pass the request's own signature context so the CRC
        // answer is HMAC'd with the token of whichever app (legacy or S2S)
        // is performing the validation.
        const response = handleZoomCrcChallenge(plainToken, {
          rawBody,
          timestamp: req.headers["x-zm-request-timestamp"] as string | undefined,
          signature: req.headers["x-zm-signature"] as string | undefined,
        });
        return res.status(200).json(response);
      }

      const timestamp = req.headers["x-zm-request-timestamp"] as string;
      const signature = req.headers["x-zm-signature"] as string;

      if (!timestamp || !signature) {
        console.warn("[Zoom Webhook] Missing required signature headers — rejecting");
        return res.status(401).json({ error: "Missing signature headers" });
      }

      const {
        verifyZoomWebhookSignatureDetailed,
        isZoomWebhookTimestampWithinWindow,
        recordZoomS2sWebhookVerified,
      } = await import("../../services/zoomIntegration");
      const verdict = verifyZoomWebhookSignatureDetailed(rawBody, timestamp, signature);
      if (!verdict.valid) {
        console.warn("[Zoom Webhook] Signature verification failed");
        return res.status(401).json({ error: "Invalid signature" });
      }

      // Audit A-004: replay-window enforcement. `x-zm-request-timestamp` is
      // HMAC-bound (`v0:${timestamp}:${body}`), so once the signature is
      // valid the timestamp is cryptographically trustworthy — reject
      // deliveries outside the bounded past+future drift window. Signature
      // verification stays first-line; dedupe keys remain the independent
      // second line downstream.
      if (!isZoomWebhookTimestampWithinWindow(timestamp)) {
        console.warn("[Zoom Webhook] Signed timestamp outside allowed replay window — rejecting");
        return res.status(401).json({ error: "Timestamp outside allowed window" });
      }

      const eventType = body?.event;

      // Task #4019 — a fully verified (signature + replay window) non-CRC
      // delivery signed by the S2S app is the durable retirement evidence
      // ZOOM.md § Retirement requires (CRC validations prove endpoint config,
      // not live event flow, so they deliberately do not count).
      // Fire-and-forget + throttled inside; must never add latency or
      // failure modes to the receiver.
      if (verdict.matchedSource === "s2s" && eventType !== "endpoint.url_validation") {
        void recordZoomS2sWebhookVerified();
      }
      const payload = body?.payload;

      if (!eventType || !payload) {
        return res.status(400).json({ error: "Missing event or payload" });
      }

      const { handleZoomWebhookEvent } = await import("../../services/zoomIntegration");
      const { withDbHoldLabel } = await import("../../db");
      // Task #818 Phase 0: tag the API-side Zoom webhook receiver.
      const result = await withDbHoldLabel("zoom_webhook_receive", () =>
        handleZoomWebhookEvent(eventType, payload),
      );

      if (!result.accepted) {
        console.log(`[Zoom Webhook] Event not accepted: ${result.reason}`);
      }

      return res.status(200).json({
        status: result.accepted ? "accepted" : "ignored",
        eventType: result.eventType,
        deduplicated: result.deduplicated,
      });
    } catch (error: any) {
      console.error("[Zoom Webhook] Error:", error);
      // F10 (Task #4156): keep the deliberate 200-ack + {status,message}
      // shape, but guarantee `message` is a string — a non-Error throw
      // (e.g. JSON.parse of a string body) previously serialized to
      // `{ status: "error" }` with the diagnostic dropped.
      const msg = typeof error?.message === "string" && error.message ? error.message : String(error);
      return res.status(200).json({ status: "error", message: msg });
    }
  });

}
