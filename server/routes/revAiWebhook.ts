// Task #3963 (audit B-012) — Rev.ai transcription-completion webhook.
//
// Rev.ai POSTs `{ "job": { id, status, ... } }` here when an async
// transcription job completes or fails; the URL + Authorization header are
// registered per-job via `notification_config` at submission time
// (server/services/atsTranscription.ts). Contract decisions:
//
//   * AUTH — Rev.ai does not sign webhook bodies; the bearer secret we embed
//     in notification_config.auth_headers (REV_AI_CALLBACK_SECRET) IS the
//     authentication, compared timing-safely below.
//   * FAIL CLOSED — when the secret is unconfigured the route rejects 503 in
//     EVERY environment (production included); an unauthenticated callback is
//     never processed. The pipeline stays functional: the fallback sweeper
//     (atsTranscriptionSweep.ts) reconciles jobs without callbacks.
//   * The body is used for job-id correlation ONLY; job status and the
//     transcript are re-fetched from Rev.ai's API, so a forged or stale body
//     can never write bogus terminal state.
//   * IDEMPOTENT — redelivery of an already-finalized job answers 200
//     "already_terminal" without touching Rev.ai again.
//   * 200 unsubscribes Rev.ai's redelivery loop; unknown job ids answer 404
//     so Rev.ai keeps retrying every 30 min (for up to 24 h) — this covers
//     the race where the callback outruns our rev_job_id persistence.
//   * Path sits under the `/api/webhooks` prefix, inheriting the shared
//     webhookLimiter mount (server/routes/limiterMounts.ts) with no session
//     auth — same class as the Zoom/Twilio/Front receivers. The literal path
//     must stay in lockstep with REV_AI_CALLBACK_PATH (route test pins it).
import type { Express } from "express";
import crypto from "crypto";
import {
  getRevAiCallbackSecret,
  processRevAiCallback,
} from "../services/atsTranscription";

/** Constant-time comparison over same-length digests of both inputs. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a).digest();
  const dbuf = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(da, dbuf);
}

export function registerRevAiWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/rev-ai", async (req, res) => {
    try {
      const secret = getRevAiCallbackSecret();
      if (!secret) {
        console.error(
          "[rev-ai-webhook] REV_AI_CALLBACK_SECRET is not configured — rejecting callback (fail closed).",
        );
        return res
          .status(503)
          .json({ error: "Rev.ai callback secret not configured" });
      }
      const provided =
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : "";
      if (!provided || !timingSafeStringEqual(provided, `Bearer ${secret}`)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const result = await processRevAiCallback(req.body);
      switch (result.outcome) {
        case "bad_payload":
          return res
            .status(400)
            .json({ error: "Malformed callback payload (expected job.id)" });
        case "unknown_job":
          // 404 (not 200) keeps Rev.ai's 30-min redelivery alive — covers the
          // submit-response race where the callback beats rev_job_id persistence.
          console.warn(
            "[rev-ai-webhook] Callback for unknown Rev.ai job id — answering 404 so Rev.ai redelivers.",
          );
          return res.status(404).json({ error: "Unknown Rev.ai job id" });
        default:
          return res.json({ ok: true, outcome: result.outcome });
      }
    } catch (err) {
      // Transient failure (Rev.ai API/transcript fetch/DB): answer 500 so
      // Rev.ai redelivers in 30 minutes; the sweeper is the final backstop.
      console.error("[rev-ai-webhook] Callback processing failed:", err);
      return res.status(500).json({ error: "Callback processing failed" });
    }
  });
}
