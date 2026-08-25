import type { Express } from "express";
import {
  resolveAndValidateLocalPath,
  downloadFromObjectStorage,
  submitVideo,
  getJobStatus,
  getJobsByUser,
  getVideoTranscription,
  analyzeVideo,
  searchInVideo,
  getFullAnalysis,
  isTerminalStatus,
  getFrameFromStorage,
  isTwelveLabsWebhookConfigured,
  parseTlSignatureHeader,
  verifyTwelveLabsWebhookSignature,
  isTwelveLabsTimestampWithinWindow,
  applyTwelveLabsTaskUpdate,
} from "../services/videoAnalysis";
import { isAuthenticated } from "../middlewares/requireAuth";

function getUserId(req: any): string {
  const userId = req.user?.claims?.sub;
  if (!userId) throw new Error("User not authenticated");
  return userId;
}

export function registerVideoAnalysisRoutes(app: Express): void {
  app.post("/api/video-analysis/submit", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const { filePath, attachedAsset, objectStoragePath } = req.body;

      let resolvedPath: string;

      if (objectStoragePath) {
        if (typeof objectStoragePath !== "string" || !objectStoragePath.startsWith("/objects/")) {
          return res.status(400).json({
            error: "objectStoragePath must start with /objects/",
          });
        }
        try {
          resolvedPath = await downloadFromObjectStorage(objectStoragePath, userId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(404).json({ error: `Object storage error: ${message}` });
        }
      } else if (filePath || attachedAsset) {
        try {
          resolvedPath = resolveAndValidateLocalPath(filePath, attachedAsset);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(400).json({ error: message });
        }
      } else {
        return res.status(400).json({
          error: "Provide one of: filePath, attachedAsset, or objectStoragePath",
        });
      }

      let job;
      try {
        job = await submitVideo(resolvedPath, userId);
      } catch (submitErr: unknown) {
        if (objectStoragePath && resolvedPath) {
          const os = await import("os");
          const fs = await import("fs");
          if (resolvedPath.startsWith(os.tmpdir())) {
            fs.unlink(resolvedPath, () => {});
          }
        }
        throw submitErr;
      }

      res.json({
        taskId: job.taskId,
        status: job.status,
        message:
          "Video submitted for indexing. Poll /api/video-analysis/status/:taskId for progress.",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Submit error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/video-analysis/status/:taskId", isAuthenticated, (req, res) => {
    try {
      const userId = getUserId(req);
      const job = getJobStatus(req.params.taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }

      res.json({
        taskId: job.taskId,
        status: job.status,
        videoId: job.videoId,
        filePath: job.filePath,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        error: job.error,
        isTerminal: isTerminalStatus(job.status),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Status error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/video-analysis/jobs", isAuthenticated, (req, res) => {
    try {
      const userId = getUserId(req);
      const jobs = getJobsByUser(userId);
      res.json({ jobs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] List jobs error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/video-analysis/transcript/:taskId", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const job = getJobStatus(req.params.taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }
      if (job.status === "failed" || job.status === "timeout") {
        return res.status(422).json({
          error: "Video indexing failed",
          status: job.status,
          detail: job.error,
        });
      }
      if (job.status !== "ready") {
        return res.status(202).json({
          message: "Video is still being indexed",
          status: job.status,
        });
      }

      const result = await getVideoTranscription(req.params.taskId, userId);
      if (!result) {
        return res
          .status(500)
          .json({ error: "Failed to retrieve transcription" });
      }

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Transcript error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/video-analysis/analyze/:taskId", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const job = getJobStatus(req.params.taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }
      if (job.status === "failed" || job.status === "timeout") {
        return res.status(422).json({
          error: "Video indexing failed",
          status: job.status,
          detail: job.error,
        });
      }
      if (job.status !== "ready") {
        return res.status(202).json({
          message: "Video is still being indexed",
          status: job.status,
        });
      }

      const { prompt } = req.body;
      const result = await analyzeVideo(req.params.taskId, userId, prompt);
      if (!result) {
        return res
          .status(500)
          .json({ error: "Failed to analyze video" });
      }

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Analyze error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/video-analysis/search/:taskId", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const job = getJobStatus(req.params.taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }
      if (job.status === "failed" || job.status === "timeout") {
        return res.status(422).json({
          error: "Video indexing failed",
          status: job.status,
          detail: job.error,
        });
      }
      if (job.status !== "ready") {
        return res.status(202).json({
          message: "Video is still being indexed",
          status: job.status,
        });
      }

      const { query } = req.body;
      if (!query) {
        return res.status(400).json({ error: "query is required" });
      }

      const result = await searchInVideo(req.params.taskId, userId, query);
      if (!result) {
        return res
          .status(500)
          .json({ error: "Failed to search video" });
      }

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Search error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/video-analysis/full/:taskId", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const job = getJobStatus(req.params.taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }
      if (job.status === "failed" || job.status === "timeout") {
        return res.status(422).json({
          error: "Video indexing failed",
          status: job.status,
          detail: job.error,
        });
      }
      if (job.status !== "ready") {
        return res.status(202).json({
          message: "Video is still being indexed",
          status: job.status,
        });
      }

      const result = await getFullAnalysis(req.params.taskId, userId);
      if (!result) {
        return res
          .status(500)
          .json({ error: "Failed to retrieve full analysis" });
      }

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Full analysis error:", message);
      res.status(500).json({ error: message });
    }
  });

  // Task #3972 — TwelveLabs indexing-completion webhook receiver. The
  // endpoint is registered ONCE, account-wide, on the TwelveLabs dashboard
  // (the current v1.3 API has no per-task callback_url — see TWELVELABS.md
  // § Webhook completion), so this route serves every indexing task. No
  // session auth by design: authentication is the TL-Signature HMAC (raw
  // body + HMAC-bound timestamp with a bounded replay window, same shape as
  // the Zoom receiver / audit A-004). The path is listed in WEBHOOK_PATHS
  // (server/routes/limiterMounts.ts), which swaps apiLimiter for
  // webhookLimiter. Processing is idempotent — repeated deliveries and the
  // webhook-vs-fallback-poll race resolve to a single terminal write.
  app.post("/api/integrations/twelvelabs/webhook", async (req, res) => {
    try {
      if (!isTwelveLabsWebhookConfigured()) {
        // Fail closed in EVERY environment: webhook mode is opt-in via
        // TWELVELABS_WEBHOOK_SECRET, and without the secret no delivery can
        // be authenticated. Submissions made without the secret are still on
        // the primary poll cadence, so nothing is lost by rejecting here.
        console.warn(
          "[TwelveLabs Webhook] Delivery received but TWELVELABS_WEBHOOK_SECRET is not configured — rejecting",
        );
        return res.status(503).json({ error: "TwelveLabs webhook not configured" });
      }

      const parsed = parseTlSignatureHeader(req.header("TL-Signature"));
      if (!parsed) {
        console.warn("[TwelveLabs Webhook] Missing or malformed TL-Signature header — rejecting");
        return res.status(401).json({ error: "Missing or malformed TL-Signature header" });
      }

      // Signature covers `${t}.${rawBody}` — must use the exact raw bytes
      // captured by express.json's verify hook (server/boot/httpApp.ts).
      const rawBody = req.rawBody;
      if (!Buffer.isBuffer(rawBody)) {
        return res.status(400).json({ error: "Missing raw request body" });
      }

      if (!verifyTwelveLabsWebhookSignature(rawBody, parsed.t, parsed.v1)) {
        console.warn("[TwelveLabs Webhook] Signature verification failed — rejecting");
        return res.status(401).json({ error: "Invalid signature" });
      }

      // `t` is HMAC-bound inside the signed payload, so after signature
      // verification it is cryptographically trustworthy — enforce the
      // bounded past+future replay window (audit A-004 pattern).
      if (!isTwelveLabsTimestampWithinWindow(parsed.t)) {
        console.warn("[TwelveLabs Webhook] Signed timestamp outside allowed replay window — rejecting");
        return res.status(401).json({ error: "Timestamp outside allowed window" });
      }

      const type = typeof req.body?.type === "string" ? req.body.type : null;
      if (type !== "index.task.ready" && type !== "index.task.failed") {
        // Other event families (analyze.task.*) are not consumed today; a
        // 2xx keeps the dashboard endpoint status green per vendor docs.
        return res.status(200).json({ status: "ignored", type });
      }

      const dataId = typeof req.body?.data?.id === "string" ? req.body.data.id : null;
      if (!dataId) {
        return res.status(400).json({ error: "Missing data.id" });
      }

      const result = await applyTwelveLabsTaskUpdate(
        dataId,
        type === "index.task.ready" ? "ready" : "failed",
      );
      if (result.outcome === "unknown_task") {
        // Restart or foreign-instance delivery — the submitting process owns
        // the taskId → job mapping and its bounded fallback poller owns
        // recovery. Benign; acknowledge so the vendor does not mark the
        // endpoint failed.
        console.log(`[TwelveLabs Webhook] No local job for task ${dataId} — acknowledged`);
      } else {
        console.log(`[TwelveLabs Webhook] ${type} for task ${dataId}: ${result.outcome}`);
      }
      // Always 2xx once authenticated: recovery from transient apply
      // failures (retrieve_failed / not_terminal_on_retrieve) is the
      // fallback poller's job, and a non-2xx only flips the vendor
      // dashboard's endpoint status to Failed.
      return res.status(200).json({ status: "accepted", ...result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[TwelveLabs Webhook] Error:", message);
      return res.status(200).json({ status: "error", message });
    }
  });

  app.get("/api/video-analysis/frames/:taskId/:filename", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const { taskId, filename } = req.params;

      const job = getJobStatus(taskId, userId);
      if (!job) {
        return res.status(404).json({ error: "Task not found" });
      }

      if (!/^[a-zA-Z0-9_\-.]+\.png$/.test(filename)) {
        return res.status(400).json({ error: "Invalid filename" });
      }

      const result = await getFrameFromStorage(taskId, filename);
      if (!result) {
        return res.status(404).json({ error: "Frame not found" });
      }

      res.set({
        "Content-Type": result.contentType,
        "Cache-Control": "private, max-age=86400",
      });

      (result.stream as NodeJS.ReadableStream).pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[VideoAnalysis] Frame serve error:", message);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });
}
