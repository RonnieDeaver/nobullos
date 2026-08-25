// @db-pool-intent: ambient
/**
 * Task #3421 — Backfill thumbnails for image attachments sent BEFORE
 * upload-time thumbnail generation shipped (Task #3301/#3318).
 *
 * Those rows have `comms_attachments.thumbnail_key = NULL`, so old
 * messages keep downloading full-resolution originals. This module is
 * the shared core for the "Backfill comms attachment thumbnails"
 * CEO prod-action: it owns
 *   - the single source of truth for which image content types are
 *     resizable (shared with the upload path in server/routes/comms.ts
 *     so the two can't drift), and
 *   - the shared sharp pipeline (600px-wide webp under
 *     comms-attachments/thumb/) used by BOTH upload-time generation and
 *     this backfill, and
 *   - chunked count/process helpers for the background drain.
 *
 * Best-effort per row: a row whose original is missing from object
 * storage, or whose bytes sharp cannot decode, is logged and added to an
 * in-process skip set so the drain and its `countPending` converge
 * (memory "Prod-action convergence" — terminal items must stop
 * counting). Skipped rows are surfaced in the action status; they simply
 * keep serving full-res like they do today. A process restart clears the
 * skip set, so a later press retries them (useful if the failure was a
 * transient storage blip).
 *
 * DB-hold discipline: chunks SELECT a small batch (short hold), do all
 * object-storage downloads + sharp work OUTSIDE any hold, then issue one
 * short per-row UPDATE guarded by `thumbnail_key IS NULL` — so re-runs
 * and a concurrent upload-path write can never clobber each other.
 */
import { and, isNull, like, notInArray, sql } from "drizzle-orm";
import { Readable } from "node:stream";
import { commsAttachments } from "@shared/schema";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";

/** Drizzle handle that supports the query builder — `api` or `worker` pool. */
export type BackfillDb = ReturnType<typeof import("../db")["getDb"]>;

/**
 * Image types sharp can safely downscale for thumbnails. SVGs are
 * excluded (already small, vector) and unknown types fall back to
 * full-res. Single source of truth — the upload path in
 * server/routes/comms.ts imports this same set.
 */
export const RESIZABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
]);

/** Attachments processed per background-drain chunk. Small on purpose —
 * each row costs a storage download + a sharp resize + a storage upload. */
export const COMMS_THUMBNAIL_BACKFILL_CHUNK = 10;

const objectStorage = new ObjectStorageService();

/**
 * Shared sharp pipeline: generate a 600px-wide webp thumbnail from the
 * original bytes and upload it under `comms-attachments/thumb/<fileId>.webp`.
 * Returns the thumbnail object key. Throws on any failure — callers treat
 * thumbnail generation as best-effort. Used by BOTH the upload route and
 * the backfill below.
 */
export async function generateAttachmentThumbnail(
  buffer: Buffer,
  fileId: string,
  // Draft pre-uploads store thumbs under their own prefix so the DB-row-less
  // draft serving branch (comms-draft-attachments/) covers them too.
  thumbKeyPrefix: string = "comms-attachments/thumb/",
): Promise<string> {
  const { default: sharp } = await import("sharp");
  const thumbBuffer = await sharp(buffer, { animated: false })
    .rotate() // respect EXIF orientation
    .resize({ width: 600, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const thumbnailKey = `${thumbKeyPrefix}${fileId}.webp`;
  await objectStorage.streamUploadToPrivateKey(
    thumbnailKey,
    Readable.from(thumbBuffer),
    "image/webp",
  );
  return thumbnailKey;
}

// ─── Skip set (convergence) ──────────────────────────────────────────────────

/** Attachment IDs that failed this process's backfill attempts, with the
 * reason — excluded from countPending so the drain converges. */
const skippedRows = new Map<string, string>();

export function getThumbnailBackfillSkippedCount(): number {
  return skippedRows.size;
}

export function __resetThumbnailBackfillSkipsForTest(): void {
  skippedRows.clear();
}

function pendingWhere() {
  // Task requirement: EVERY `image/%` row with a NULL thumbnail_key is a
  // backfill candidate — not just the upload-path fast-list in
  // RESIZABLE_IMAGE_TYPES. Rows sharp can't decode (e.g. exotic vendor
  // image types) fail per-row in processThumbnailBackfillChunk's
  // try/catch and land in the skip set WITH a logged reason, instead of
  // being silently pre-filtered out here.
  const conditions = [
    isNull(commsAttachments.thumbnailKey),
    like(commsAttachments.contentType, "image/%"),
  ];
  if (skippedRows.size > 0) {
    conditions.push(notInArray(commsAttachments.id, Array.from(skippedRows.keys())));
  }
  return and(...conditions);
}

/**
 * Count image attachments still needing a thumbnail (excluding rows this
 * process already failed on) — the drain's `countPending`.
 */
export async function countPendingThumbnailBackfill(db: BackfillDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(commsAttachments)
    .where(pendingWhere());
  return Number(row?.n ?? 0);
}

export interface ThumbnailBackfillChunkOutcome {
  /** Rows attempted this chunk (drives drain progress/termination). */
  processed: number;
  /** Rows that now have a thumbnail_key. */
  thumbnailed: number;
  /** Rows skipped this chunk (failure logged + added to the skip set). */
  skipped: number;
}

/**
 * Derive the fileId used for the thumb key from the original object key
 * (`comms-attachments/<fileId>.<ext>`), falling back to the attachment
 * row id for any legacy key shape. Either way the key is unique per row.
 */
function thumbFileIdFor(objectKey: string, attachmentId: string): string {
  const m = /^comms-attachments\/([^/]+?)(?:\.[A-Za-z0-9]+)?$/.exec(objectKey);
  return m?.[1] ?? attachmentId;
}

/**
 * Process one backfill chunk: pick up to `limit` pending rows, download
 * each original, generate + upload the 600px webp thumbnail, and stamp
 * `thumbnail_key` (guarded by `thumbnail_key IS NULL`). Best-effort per
 * row — a failed row is logged and added to the skip set so the drain
 * keeps moving and converges.
 */
export async function processThumbnailBackfillChunk(
  db: BackfillDb,
  limit: number = COMMS_THUMBNAIL_BACKFILL_CHUNK,
): Promise<ThumbnailBackfillChunkOutcome> {
  const rows = await db
    .select({
      id: commsAttachments.id,
      objectKey: commsAttachments.objectKey,
    })
    .from(commsAttachments)
    .where(pendingWhere())
    .orderBy(commsAttachments.id)
    .limit(limit);

  let thumbnailed = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      // All external work (storage download, sharp, storage upload)
      // happens between the SELECT above and the UPDATE below — no DB
      // hold spans it.
      const file = await objectStorage.getPrivateObjectFileByKey(row.objectKey);
      const [buffer] = await file.download();
      const thumbnailKey = await generateAttachmentThumbnail(
        buffer,
        thumbFileIdFor(row.objectKey, row.id),
      );
      await db
        .update(commsAttachments)
        .set({ thumbnailKey })
        .where(and(sql`${commsAttachments.id} = ${row.id}`, isNull(commsAttachments.thumbnailKey)));
      thumbnailed += 1;
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      skippedRows.set(row.id, reason);
      skipped += 1;
      console.warn(
        `[Comms] Thumbnail backfill skipped attachment ${row.id} (${row.objectKey}): ${reason}`,
      );
    }
  }
  return { processed: rows.length, thumbnailed, skipped };
}
