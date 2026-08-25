import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  FEEDBACK_ATTACHMENT_PREFIX,
  canStreamFeedbackAttachment,
} from "@shared/attachments";
import { ObjectNotFoundError } from "../replit_integrations/object_storage";

/**
 * The slice of `ObjectStorageService` the feedback attachment streaming route
 * actually uses. Declaring it as an interface lets `registerRoutes` pass the
 * real service while `tests/feedback-attachment-streaming.test.ts` injects a
 * fake that records what it was asked to stream — so the test can exercise the
 * REAL handler (ACL confinement + namespace check + byte streaming) without
 * talking to Replit Object Storage.
 */
export interface FeedbackAttachmentStorage {
  getObjectEntityAclPolicy(
    path: string,
  ): Promise<{ owner?: string | null } | null | undefined>;
  getObjectEntityFile(path: string): Promise<unknown>;
  downloadObject(file: unknown, res: Response): Promise<void>;
}

/** Minimal DB handle shape the handler needs (injectable for tests). */
export interface FeedbackAttachmentDb {
  execute(query: unknown): Promise<{ rows?: any[] }>;
}

export interface FeedbackAttachmentHandlerDeps {
  storage: FeedbackAttachmentStorage;
  /** Defaults to the request-scoped `db` pool from `server/db.ts`. */
  db?: FeedbackAttachmentDb;
}

/**
 * Builds the handler for `GET /api/feedback/:id/attachment` — admin-gated
 * streaming of a feedback attachment (image or video) via `downloadObject`,
 * which bypasses the generic object ACL. Because that bypass is dangerous the
 * request must clear three independent checks (delegated to the shared,
 * unit-tested `canStreamFeedbackAttachment`):
 *
 *   1. the path is inside the feedback upload namespace (cannot reference
 *      arbitrary object keys);
 *   2. the path is in that feedback row's stored attachment list;
 *   3. the object's ACL owner is the user who submitted that feedback row —
 *      proving it was genuinely claimed through the feedback upload flow rather
 *      than injected/forged.
 *
 * Extracted from the monolithic `registerRoutes` so a test can mount the REAL
 * handler directly (mirrors `server/routes/blockedRateLimitEventsCsv.ts`).
 */
export function createFeedbackAttachmentHandler(
  deps: FeedbackAttachmentHandlerDeps,
) {
  const storage = deps.storage;
  const db = deps.db ?? defaultDb;

  return async function feedbackAttachmentHandler(
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const id = Number(req.params.id);
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!Number.isFinite(id) || !path.startsWith(FEEDBACK_ATTACHMENT_PREFIX)) {
        res.status(400).json({ error: "Invalid request" });
        return;
      }
      const row = await db.execute(sql`
        SELECT user_id, screenshots FROM user_feedback WHERE id = ${id} LIMIT 1
      `);
      const record = row.rows?.[0] as any;
      if (!record) {
        res.status(404).json({ error: "Feedback not found" });
        return;
      }
      let attachmentPaths: string[] = [];
      try {
        const parsed = JSON.parse(String(record.screenshots || "[]"));
        if (Array.isArray(parsed)) {
          attachmentPaths = parsed.filter((s: any) => typeof s === "string");
        }
      } catch {
        attachmentPaths = [];
      }
      if (!attachmentPaths.includes(path)) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }
      // Provenance: the object must be owned by the feedback submitter. This
      // closes the gap where a forged path somehow lands in the stored list —
      // such an object would not be ACL-owned by this row's author. The pure
      // decision lives in `canStreamFeedbackAttachment` (shared, unit-tested).
      const aclPolicy = await storage.getObjectEntityAclPolicy(path);
      if (
        !canStreamFeedbackAttachment({
          requestedPath: path,
          storedPaths: attachmentPaths,
          aclOwner: aclPolicy?.owner,
          feedbackUserId: record.user_id,
        })
      ) {
        res.status(403).json({ error: "Attachment access denied" });
        return;
      }
      const objectFile = await storage.getObjectEntityFile(path);
      await storage.downloadObject(objectFile, res);
    } catch (err: any) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }
      console.error("[Feedback] Attachment stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to load attachment" });
      }
    }
  };
}
