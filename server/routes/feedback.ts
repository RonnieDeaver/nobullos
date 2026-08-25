// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 5963–6325 + module helpers 224–257 at split time).
 *
 * User feedback: user_feedback bootstrap DDL kick, attachment claim/ownership stamping, upload-url minting, submission, Slack retry/requeue admin routes, feedback list, and admin-gated attachment streaming.
 *
 * Mount-order contract: registerFeedbackRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../db";
import { sql, and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import { ObjectStorageService, ObjectNotFoundError } from "../replit_integrations/object_storage";
import {
  relayFeedbackToSlack,
  recordFeedbackSlackResult,
  resetFeedbackSlackLookupCache,
  FEEDBACK_SLACK_RELAY_BUDGET_MS,
  type FeedbackSlackResult,
  buildFeedbackAdminUrl,
} from "../services/feedbackSlackRelay";
import {
  summarizeAttachments,
  feedbackAttachmentClaimAllowed,
  isVideoAttachmentPath,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_VIDEO_BYTES,
} from "@shared/attachments";
import type { UploadContentConstraints } from "../replit_integrations/object_storage";
import { createFeedbackAttachmentHandler } from "./feedbackAttachment";
// Map a feedback attachment's content type (preferred) or client-supplied
// filename extension to a canonical file extension that gets stamped onto the
// object-storage key so the stored path is self-describing (image vs video).
// Returns undefined when nothing usable is provided — the key then stays
// extensionless and the attachment is treated as an image (legacy behavior).
const FEEDBACK_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
};

function pickFeedbackAttachmentExtension(
  contentType?: unknown,
  ext?: unknown,
): string | undefined {
  if (typeof contentType === "string") {
    const mapped = FEEDBACK_CONTENT_TYPE_EXTENSIONS[contentType.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  if (typeof ext === "string") {
    const clean = ext.trim().replace(/^\.+/, "").toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(clean)) return clean;
  }
  return undefined;
}

// Task #3964 (audit A-006) — server-side caps for claimed feedback
// attachments. The presigned PUT is unconstrained at mint time, so the claim
// step verifies the stored bytes: images ≤ FEEDBACK_MAX_IMAGE_BYTES, videos
// ≤ FEEDBACK_MAX_VIDEO_BYTES (shared constants keep the FeedbackButton
// pre-filter in lockstep), and the sniffed kind must match what the storage
// key's extension advertises — a "video" path actually holding an image (or
// vice versa) would route the object down the wrong downstream pipeline
// (video analysis vs <img> rendering).
const FEEDBACK_IMAGE_UPLOAD_CONSTRAINTS: UploadContentConstraints = {
  kinds: { image: { maxBytes: FEEDBACK_MAX_IMAGE_BYTES } },
};
const FEEDBACK_VIDEO_UPLOAD_CONSTRAINTS: UploadContentConstraints = {
  kinds: { video: { maxBytes: FEEDBACK_MAX_VIDEO_BYTES } },
};

/**
 * Task #4777 — display-name snapshot for a feedback submission, derived from
 * the authenticated user's `users` row (req.dbUser): trimmed "First Last",
 * else the email, else "Unknown" — the last only when genuinely no data
 * exists (the pre-fix bug filed EVERY submission as "Unknown" because it
 * read claim fields the Clerk cutover retired). Exported pure so the
 * regression suite can pin the fallback chain directly, and kept in
 * lockstep with the SQL derivation in the
 * `repair_feedback_unknown_submitter_names` prod action
 * (server/services/prodActions/platformOpsActions.ts) — the shared test
 * fixtures assert both produce identical names.
 */
export function deriveFeedbackSubmitterName(dbUser: unknown): string {
  const user = (dbUser ?? {}) as Record<string, unknown>;
  const first = typeof user.firstName === "string" ? user.firstName.trim() : "";
  const last = typeof user.lastName === "string" ? user.lastName.trim() : "";
  const fullName = [first, last].filter(Boolean).join(" ");
  if (fullName) return fullName;
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (email) return email;
  return "Unknown";
}

export function registerFeedbackRoutes(app: Express): void {
  db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL,
      user_name varchar NOT NULL,
      topic varchar NOT NULL DEFAULT 'OTHER',
      feedback_text text NOT NULL,
      current_page varchar,
      screenshots text DEFAULT '[]',
      status varchar NOT NULL DEFAULT 'pending',
      slack_status varchar NOT NULL DEFAULT 'pending',
      slack_reason text,
      slack_updated_at timestamp,
      slack_attempts integer NOT NULL DEFAULT 0,
      created_at timestamp DEFAULT now()
    )
  `)
    .then(() =>
      // Task #2064 / #2131 — additive migration for existing deployments
      // whose user_feedback table predates the Slack-relay columns. IF NOT
      // EXISTS keeps this idempotent across reboots. `slack_attempts`
      // (Task #2131) backs the give-up-after-N-retries terminal transition.
      db.execute(sql`
        ALTER TABLE user_feedback
          ADD COLUMN IF NOT EXISTS slack_status varchar NOT NULL DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS slack_reason text,
          ADD COLUMN IF NOT EXISTS slack_updated_at timestamp,
          ADD COLUMN IF NOT EXISTS slack_attempts integer NOT NULL DEFAULT 0
      `),
    )
    .then(() =>
      // Task #2409 — additive column holding the TwelveLabs-derived transcript
      // + key-moment frames for any uploaded feedback video. IF NOT EXISTS
      // keeps this idempotent across reboots.
      db.execute(sql`
        ALTER TABLE user_feedback
          ADD COLUMN IF NOT EXISTS video_analysis jsonb
      `),
    )
    .then(() =>
      // Task #4545 — collapse historical pending duplicates for SYSTEM
      // submitters so the dedupe index below can always be created.
      // Mirrors migrations/20260812010510_user_feedback_system_pending_dedupe.sql
      // (boot ensure — the table itself is boot-created raw SQL, so the
      // migration alone cannot be relied on in every environment).
      db.execute(sql`
        UPDATE user_feedback
        SET status = 'resolved',
            feedback_text = feedback_text || e'\n\n[Auto-resolved] Duplicate of an earlier open item for the same test (collapsed by the dedupe-index backfill, Task #4545).'
        WHERE user_id LIKE 'system:%'
          AND status = 'pending'
          AND current_page IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id)
            FROM user_feedback
            WHERE user_id LIKE 'system:%'
              AND status = 'pending'
              AND current_page IS NOT NULL
            GROUP BY user_id, current_page
          )
      `),
    )
    .then(() =>
      // Task #4545 — partial unique index backing the conflict-safe insert in
      // regressionSweepFeedback.insertSweepItem (ON CONFLICT DO NOTHING).
      db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS user_feedback_system_pending_dedupe_idx
          ON user_feedback (user_id, current_page)
          WHERE status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL
      `),
    )
    .catch((err) => console.error("[Feedback] Table init error:", err.message));

  const feedbackStorage = new ObjectStorageService();

  // Validate + take ownership of a single user-submitted feedback attachment
  // path. Returns true only when the path is in the feedback namespace, the
  // object exists, and it is either unclaimed or already owned by this user —
  // in which case we stamp the submitter as its ACL owner so later provenance
  // checks (and the generic /objects ACL) recognize it. A path that resolves to
  // an object already owned by someone else (an injected/forged reference) is
  // rejected, so a submitter cannot attach objects they do not own. The pure
  // decision lives in `feedbackAttachmentClaimAllowed` (shared, unit-tested);
  // here we read the existing owner and perform the side-effecting stamp.
  const claimFeedbackAttachment = async (
    objectPath: string,
    ownerUserId: string,
  ): Promise<boolean> => {
    if (typeof objectPath !== "string") return false;
    try {
      const existing = await feedbackStorage.getObjectEntityAclPolicy(objectPath);
      if (
        !feedbackAttachmentClaimAllowed({
          path: objectPath,
          existingOwner: existing?.owner,
          userId: ownerUserId,
        })
      ) {
        console.warn(
          `[Feedback] Rejected attachment (forged/foreign-owned): ${objectPath}`,
        );
        return false;
      }
      // Task #3964 (audit A-006) — the presigned PUT was unconstrained, so
      // verify the stored bytes BEFORE taking ownership: real image/video
      // magic bytes, within the per-kind cap, matching the kind the key's
      // extension advertises. Rejected objects are deleted — the claim gate
      // above already proved they are unclaimed or this submitter's own, so
      // the delete can never destroy someone else's object.
      const verdict = await feedbackStorage.verifyObjectEntityContent(
        objectPath,
        isVideoAttachmentPath(objectPath)
          ? FEEDBACK_VIDEO_UPLOAD_CONSTRAINTS
          : FEEDBACK_IMAGE_UPLOAD_CONSTRAINTS,
      );
      if (!verdict.ok) {
        console.warn(
          `[Feedback] Rejected attachment (${verdict.reason}): ${objectPath} — ${verdict.detail}`,
        );
        await feedbackStorage.deleteRejectedUploadObject(objectPath, {
          // The claim gate above accepted unclaimed OR self-owned objects, so
          // cleanup may remove the object while it is still in either of
          // those states — but never after a DIFFERENT user claimed it.
          expectedOwner: ownerUserId,
        });
        return false;
      }
      await feedbackStorage.trySetObjectEntityAclPolicy(objectPath, {
        owner: ownerUserId,
        visibility: "private",
      });
      return true;
    } catch (err: any) {
      if (!(err instanceof ObjectNotFoundError)) {
        console.warn(
          `[Feedback] Attachment claim failed for ${objectPath}: ${err?.message ?? err}`,
        );
      }
      return false;
    }
  };

  app.post("/api/feedback/upload-url", isAuthenticated, async (req: any, res) => {
    try {
      // Stamp the attachment's extension onto the generated key so the stored
      // path is self-describing (image vs video). Prefer a known content-type
      // mapping; fall back to the client-supplied filename extension.
      const extension = pickFeedbackAttachmentExtension(
        req.body?.contentType,
        req.body?.ext,
      );
      const uploadUrl = await feedbackStorage.getObjectEntityUploadURL({
        extension,
        prefix: "feedback-uploads",
      });
      const objectPath = feedbackStorage.normalizeObjectEntityPath(uploadUrl);
      res.json({ uploadUrl, objectPath });
    } catch (err: any) {
      console.error("[Feedback] Upload URL error:", err.message);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  app.post("/api/feedback", isAuthenticated, async (req: any, res) => {
    try {
      const { topic, text, currentPage, screenshots } = req.body;
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Feedback text is required" });
      }
      const validTopics = ["BUG_REPORT", "FEATURE_REQUEST", "DESIGN", "CONTENT", "OTHER"];
      const safeTopic = validTopics.includes(topic) ? topic : "OTHER";
      // Task #4777 — the Clerk-era legacy-compat claims carry only
      // { sub, role } (server/middlewares/requireAuth.ts Step 4), so the
      // retired claims.first_name/claims.email reads filed every submission
      // as "Unknown" after the 2026-08-13 cutover. Derive the display-name
      // snapshot from the authenticated user's DB row instead — requireAuth
      // always sets req.dbUser before admitting the request. user_id
      // derivation is deliberately untouched (it was never wrong).
      const userName = deriveFeedbackSubmitterName(req.dbUser);
      const userId = req.user?.claims?.sub || "unknown";
      const feedbackText = text.trim().substring(0, 5000);
      const page = typeof currentPage === "string" ? currentPage.substring(0, 200) : null;

      // Only attachments this user actually uploaded through the feedback flow
      // are accepted: each candidate must be in the feedback namespace AND be
      // claimable (unclaimed or already owned by this user). This prevents a
      // submitter from persisting arbitrary `/objects/...` paths they don't own,
      // which the admin streaming route would otherwise serve ACL-bypassed.
      let screenshotPaths: string[] = [];
      if (Array.isArray(screenshots)) {
        const candidates = screenshots
          .filter((s: any) => typeof s === "string")
          .slice(0, 5);
        for (const candidate of candidates) {
          if (await claimFeedbackAttachment(candidate, userId)) {
            screenshotPaths.push(candidate);
          }
        }
      }

      const feedbackInsert = await db.execute(sql`
        INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots)
        VALUES (${userId}, ${userName}, ${safeTopic}, ${feedbackText}, ${page}, ${JSON.stringify(screenshotPaths)})
        RETURNING id
      `);
      const feedbackRowId = (feedbackInsert.rows?.[0] as any)?.id ?? null;

      const attachments = summarizeAttachments(screenshotPaths);
      console.log(`[Feedback] ${safeTopic} submitted by ${userName} on ${page || "/"} (${attachments.imageCount} screenshots, ${attachments.videoCount} videos)`);

      // Task #2409 — if the submission carried any video, kick off background
      // auto-processing (TwelveLabs transcript + key-moment frames) detached
      // from this request so the submit stays fast. The results land on the
      // row's `video_analysis` column for the admin console and planning agent.
      if (attachments.videoCount > 0 && feedbackRowId != null) {
        const reporterUserId = userId;
        import("../services/feedbackVideoProcessing")
          .then(({ processFeedbackVideos }) =>
            processFeedbackVideos(Number(feedbackRowId), screenshotPaths, reporterUserId),
          )
          .catch((err: any) =>
            console.warn("[Feedback] video processing failed to start:", err?.message ?? err),
          );
      }

      // Task #1688 — Per-user inbox: ping responsible admins (CEO /
      // team_lead) that new feedback landed so they can triage from the
      // bell without waiting for Slack. Best-effort.
      try {
        const { getResponsibleAdminsForAlert, excludeActor } = await import(
          "../services/notifications/recipients"
        );
        const { notifyUser } = await import(
          "../services/notifications/userInbox"
        );
        const admins = excludeActor(
          await getResponsibleAdminsForAlert(),
          userId,
        );
        const preview = feedbackText.length > 200
          ? feedbackText.slice(0, 197) + "..."
          : feedbackText;
        for (const uid of admins) {
          await notifyUser(uid, {
            category: "feedback",
            title: `New ${safeTopic} from ${userName}`,
            body: preview,
            deepLink: "/admin/feedback",
            dedupeKey: feedbackRowId ? `feedback:${feedbackRowId}:${uid}` : undefined,
            metadata: {
              feedbackId: feedbackRowId,
              topic: safeTopic,
              reporterUserId: userId,
              page: page ?? null,
            },
          });
        }
      } catch (err: any) {
        console.warn("[Feedback] notifyUser fan-out failed:", err?.message ?? err);
      }

      // Task #2064 — relay to Slack and capture the outcome instead of
      // swallowing it in a detached `.catch(() => {})`. The feedback row is
      // already persisted above, so the submission is never lost even if the
      // relay fails. To keep the submit request fast (Slack can rate-limit /
      // back off for seconds), we race the relay against a short budget: the
      // relay always runs to completion and persists its terminal status in
      // the background, but the HTTP response returns whatever is ready within
      // the budget — `pending` if Slack hasn't answered yet.
      const relayDone = relayFeedbackToSlack({
        topic: safeTopic,
        userName,
        page,
        feedbackText,
        screenshotCount: attachments.imageCount,
        videoCount: attachments.videoCount,
        viewUrl: attachments.videoCount > 0 ? buildFeedbackAdminUrl() : null,
      })
        .catch((err: any) => {
          console.warn("[Feedback] Slack relay threw:", err?.message ?? err);
          return {
            status: "failed",
            reason: "Slack relay failed unexpectedly — it can be re-sent.",
          } as FeedbackSlackResult;
        })
        .then(async (result) => {
          await recordFeedbackSlackResult(feedbackRowId, result);
          return result;
        });

      let budgetTimer: NodeJS.Timeout | undefined;
      const budget = new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), FEEDBACK_SLACK_RELAY_BUDGET_MS);
      });
      const raced = await Promise.race([relayDone, budget]);
      if (budgetTimer) clearTimeout(budgetTimer);

      res.json({
        success: true,
        slackStatus: raced ? raced.status : "pending",
        slackReason: raced
          ? raced.reason
          : "Saved — still sending to Slack in the background.",
      });
    } catch (err: any) {
      console.error("[Feedback] Error:", err.message);
      // Task #4789 — fire an immediate ops alert for feedback 5xxs. The
      // requestMetricsAlerts evaluator requires ≥30 requests per 10-minute
      // window before it flags a route — feedback sees ~2 req/day and is
      // structurally invisible to that generic check. Best-effort, detached.
      import("../services/feedbackSubmitFailureAlert")
        .then(({ alertFeedbackSubmitFailure }) =>
          alertFeedbackSubmitFailure(err, {
            userId: req.user?.claims?.sub,
            page: typeof req.body?.currentPage === "string" ? req.body.currentPage : null,
          }),
        )
        .catch((alertErr: any) =>
          console.warn("[Feedback] 5xx alert dispatch failed:", alertErr?.message ?? alertErr),
        );
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  app.post("/api/feedback/:id/retry-slack", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { id } = req.params;
      const result = await db.execute(sql`SELECT * FROM user_feedback WHERE id = ${Number(id)}`);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: "Feedback not found" });

      // Task #2064 — force a fresh channel/user resolution, relay via the
      // shared helper, and persist the new per-row Slack status so the admin
      // view reflects the retry's success/failure.
      resetFeedbackSlackLookupCache();
      const text = String(row.feedback_text || "");
      let attachmentPaths: string[] = [];
      try {
        const parsed = JSON.parse(String(row.screenshots || "[]"));
        if (Array.isArray(parsed)) {
          attachmentPaths = parsed.filter((s: any) => typeof s === "string");
        }
      } catch {
        attachmentPaths = [];
      }
      const retryAttachments = summarizeAttachments(attachmentPaths);
      const slackResult = await relayFeedbackToSlack({
        topic: String(row.topic),
        userName: String(row.user_name),
        page: row.current_page != null ? String(row.current_page) : null,
        feedbackText: text,
        screenshotCount: retryAttachments.imageCount,
        videoCount: retryAttachments.videoCount,
        viewUrl: retryAttachments.videoCount > 0 ? buildFeedbackAdminUrl() : null,
      });
      await recordFeedbackSlackResult(Number(id), slackResult);

      res.json({
        success: slackResult.status === "delivered",
        slackStatus: slackResult.status,
        slackReason: slackResult.reason,
      });
    } catch (err: any) {
      console.error("[Feedback] Retry Slack error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Task #2206 — re-queue a single terminally-`undeliverable` feedback row
  // (give-up state from Task #2131) so the auto-resend scheduler re-drives
  // it. Resets it to the retryable `failed` state with `slack_attempts`
  // zeroed and the backoff stamp cleared. Guarded on the row actually being
  // `undeliverable` so it can't disturb delivered/pending/failed rows.
  app.post("/api/feedback/:id/requeue-slack", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid feedback id" });
      }
      const { reviveFeedbackSlackUndeliverable } = await import(
        "../services/feedbackSlackRelay"
      );
      const revived = await reviveFeedbackSlackUndeliverable(id);
      if (revived === 0) {
        return res.status(409).json({
          error:
            "Feedback is not in the undeliverable state — nothing to re-queue.",
        });
      }
      res.json({ success: true, revived });
    } catch (err: any) {
      console.error("[Feedback] Re-queue Slack error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Task #2206 — bulk re-queue: revive every `undeliverable` feedback row at
  // once after Slack is fixed. Returns the number of rows re-queued.
  app.post("/api/feedback/requeue-undeliverable", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { reviveAllFeedbackSlackUndeliverable } = await import(
        "../services/feedbackSlackRelay"
      );
      const revived = await reviveAllFeedbackSlackUndeliverable();
      res.json({ success: true, revived });
    } catch (err: any) {
      console.error("[Feedback] Bulk re-queue Slack error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/feedback", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT id, user_id, user_name, topic, feedback_text, current_page, screenshots, status,
               slack_status, slack_reason, slack_updated_at, slack_attempts, video_analysis, created_at
        FROM user_feedback
        ORDER BY created_at DESC
        LIMIT 100
      `);
      res.json(rows.rows);
    } catch (err: any) {
      console.error("[Feedback] List error:", err.message);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  // Task #2409 — admin-gated streaming of a feedback attachment (image or
  // video) using `downloadObject` (ACL-bypassing). To keep that bypass safe the
  // request must clear three independent checks: (1) the path is in the feedback
  // upload namespace (cannot reference arbitrary object keys); (2) the path is
  // in that feedback row's stored attachment list; (3) the object's ACL owner is
  // the user who submitted that feedback row — i.e. it was genuinely claimed
  // through the feedback upload flow, not an injected/forged reference.
  app.get(
    "/api/feedback/:id/attachment",
    isAuthenticated,
    requireTeamLead,
    createFeedbackAttachmentHandler({ storage: feedbackStorage }),
  );
}