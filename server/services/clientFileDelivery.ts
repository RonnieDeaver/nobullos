// @db-pool-intent: ambient
//
// Task #4025 — client-file delivery for automated pipelines.
//
// The Zoom recording sync and the Twilio call-archive pipeline historically
// wrote recordings/transcripts to each client's Google Drive folder. The
// Drive integration was retired (Task #4084 — least-privilege migration,
// end-state D): this module's in-app sink is now the ONLY delivery channel.
// It stores pipeline artifacts as rows in the client's in-app file space
// (shared/models/clientFiles.ts) backed by private object storage.
//
// Storage flow per artifact (mirrors the browser claim route in
// server/routes/clientFiles.ts, minus the presign hop):
//   1. Reuse-by-name check (idempotency) so retries never duplicate content.
//   2. Stream bytes to a fresh `client-files/<clientId>/<uuid>[.ext]` key.
//   3. verifyClientFileObjectContent — size cap + magic-byte sniff; the
//      SAFE mime is what gets persisted/served, never the declared one.
//   4. claimUploadedFile — DB row + activity trail (same-name ⇒ versioning).
//   Failed claims delete the just-written object so nothing leaks.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import {
  CLIENT_FILE_MAX_BYTES,
  sanitizeClientFileName,
  splitClientFileName,
} from "@shared/clientFiles";
import {
  claimUploadedFile,
  createFolder,
  findLiveFileByName,
  findLiveFolderByName,
  ClientFileError,
  type FileActor,
} from "./clientFileService";
import type { ClientFile, ClientFileFolder } from "@shared/schema";

// In-app folder names used by the pipeline sinks. The call folder names
// match the legacy Drive subfolder names so any manually migrated content
// merges into the same folders instead of creating parallel trees.
export const ZOOM_RECORDINGS_FOLDER = "Zoom Recordings";
export const CALL_RECORDINGS_FOLDER = "Call Recordings";
export const CALL_TRANSCRIPTS_FOLDER = "Call Transcripts";

/**
 * Find-or-create a folder chain (e.g. ["Call Recordings"]) under the client
 * root. Race-safe: createFolder throws `conflict` under the per-client
 * advisory lock, in which case the concurrent winner is re-read.
 */
export async function ensureClientFileFolderPath(
  clientId: string,
  pathNames: string[],
  actor: FileActor,
): Promise<ClientFileFolder> {
  if (pathNames.length === 0) throw new Error("ensureClientFileFolderPath: empty path");
  let parentId: string | null = null;
  let folder: ClientFileFolder | null = null;
  for (const rawName of pathNames) {
    const name = sanitizeClientFileName(rawName);
    if (!name) throw new Error(`Invalid folder name in path: ${rawName}`);
    folder = await findLiveFolderByName(clientId, parentId, name);
    if (!folder) {
      try {
        folder = await createFolder({ clientId, parentId, name, actor });
      } catch (err) {
        if (err instanceof ClientFileError && err.code === "conflict") {
          folder = await findLiveFolderByName(clientId, parentId, name);
        }
        if (!folder) throw err;
      }
    }
    parentId = folder.id;
  }
  return folder!;
}

export interface StoreClientFileArgs {
  clientId: string;
  folderId: string | null;
  fileName: string;
  /** Buffer, or a factory producing a fresh Node readable (large objects). */
  content: Buffer | (() => Promise<NodeJS.ReadableStream>);
  /** Declared content type — advisory only; serving mime comes from the sniff. */
  contentType?: string;
  actor: FileActor;
  /**
   * When true (default) and a live file with the same name already exists in
   * the folder, reuse it WITHOUT writing new content — the per-sink
   * idempotency behavior pipelines need on retry. When false, a same-name
   * claim versions the existing file (supersede).
   */
  reuseExistingByName?: boolean;
  /** ACL owner stamp for the object (admin imports). Omitted for system actors. */
  aclOwnerId?: string | null;
}

export interface StoreClientFileResult {
  file: ClientFile;
  reused: boolean;
  supersededVersionNumber?: number;
}

export async function storeClientFile(args: StoreClientFileArgs): Promise<StoreClientFileResult> {
  const name = sanitizeClientFileName(args.fileName);
  if (!name) throw new Error(`Invalid client file name: ${args.fileName}`);

  const reuse = args.reuseExistingByName !== false;
  if (reuse) {
    const existing = await findLiveFileByName(args.clientId, args.folderId, name);
    if (existing) return { file: existing, reused: true };
  }

  const objectStorage = new ObjectStorageService();
  const { ext } = splitClientFileName(name);
  // NOTE: splitClientFileName's ext INCLUDES the leading dot (".mp4").
  const objectKey = `client-files/${args.clientId}/${randomUUID()}${ext.toLowerCase()}`;

  const body: NodeJS.ReadableStream = Buffer.isBuffer(args.content)
    ? Readable.from(args.content)
    : await args.content();
  await objectStorage.streamUploadToPrivateKey(
    objectKey,
    body,
    args.contentType || "application/octet-stream",
  );

  const objectPath = `/objects/${objectKey}`;
  try {
    // Same gate as the browser claim route: size cap + magic-byte sniff.
    // The verdict mime is the SAFE serving mime (metadata already laundered).
    const verdict = await objectStorage.verifyClientFileObjectContent(objectPath, {
      maxBytes: CLIENT_FILE_MAX_BYTES,
      fileName: name,
    });
    if (!verdict.ok) {
      throw new Error(
        verdict.reason === "too_large"
          ? `File exceeds the ${Math.round(CLIENT_FILE_MAX_BYTES / (1024 * 1024))} MB in-app storage limit`
          : "File content is empty",
      );
    }
    if (args.aclOwnerId) {
      await objectStorage.trySetObjectEntityAclPolicy(objectPath, {
        owner: args.aclOwnerId,
        visibility: "private",
      });
    }
    const result = await claimUploadedFile({
      clientId: args.clientId,
      folderId: args.folderId,
      name,
      objectKey,
      mimeType: verdict.mime,
      sizeBytes: verdict.sizeBytes,
      actor: args.actor,
    });
    return {
      file: result.file,
      reused: false,
      supersededVersionNumber: result.supersededVersionNumber,
    };
  } catch (err) {
    // Claim/verify failed — remove the just-written object so nothing leaks
    // outside the ledger. Best-effort: the abandoned-upload sweep is the
    // backstop for keys that slip through.
    try {
      const file = await objectStorage.getPrivateObjectFileByKey(objectKey);
      await file.delete();
    } catch (cleanupErr: any) {
      console.warn(
        `[ClientFileDelivery] cleanup of rejected object ${objectKey} failed:`,
        cleanupErr?.message ?? cleanupErr,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Zoom recording delivery
// ---------------------------------------------------------------------------

/**
 * Download a Zoom cloud recording (Zoom-side auth; nothing Google about it —
 * moved here verbatim from the retired googleDriveIntegration module).
 */
export async function downloadZoomRecording(downloadUrl: string): Promise<Buffer> {
  const { getAccessToken: getZoomToken } = await import("./zoomIntegration");
  const zoomToken = await getZoomToken();

  const urlWithToken = `${downloadUrl}?access_token=${zoomToken}`;
  const res = await fetch(urlWithToken);

  if (!res.ok) {
    throw new Error(`Failed to download Zoom recording: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Pick the downloadable MP4 recording file from a Zoom meeting payload. */
export function pickZoomRecordingFile(meeting: any): any | null {
  const recordingFiles = meeting?.recording_files || [];
  return (
    recordingFiles.find(
      (f: any) => (f.file_type === "MP4" || f.file_type === "SHARED_SCREEN_WITH_SPEAKER_VIEW") && f.download_url
    ) ?? null
  );
}

/** Canonical recording filename (`YYYY-MM-DD — Topic.mp4`). */
export function zoomRecordingFileName(meeting: any): string {
  const startTime = meeting?.start_time ? new Date(meeting.start_time) : new Date();
  const dateStr = startTime.toISOString().split("T")[0];
  const topic = (meeting?.topic || "Zoom Meeting").replace(/[/\\?%*:|"<>]/g, "-");
  return `${dateStr} — ${topic}.mp4`;
}

/**
 * Deliver a Zoom recording for a matched client to their in-app client
 * files (Task #4025; sole sink since the Task #4084 Drive retirement).
 *
 * Failures THROW so callers' catch blocks surface them — the recording
 * remains recoverable from Zoom cloud until its retention window lapses.
 */
export async function deliverZoomRecording(
  recordId: string,
  meeting: any,
  clientId: string,
  /** Test seam: replaces the Zoom download (token mint + fetch). */
  testDeps?: { download?: (downloadUrl: string) => Promise<Buffer> },
): Promise<void> {
  const mp4File = pickZoomRecordingFile(meeting);
  if (!mp4File) return;

  const buffer = testDeps?.download
    ? await testDeps.download(mp4File.download_url)
    : await downloadZoomRecording(mp4File.download_url);

  const actor: FileActor = { id: null, name: "Zoom delivery" };
  const folder = await ensureClientFileFolderPath(clientId, [ZOOM_RECORDINGS_FOLDER], actor);
  const { file, reused } = await storeClientFile({
    clientId,
    folderId: folder.id,
    fileName: zoomRecordingFileName(meeting),
    content: buffer,
    contentType: "video/mp4",
    actor,
  });
  const { getDb, withDbAttribution } = await import("../db");
  const { rawCommunicationRecords } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  await withDbAttribution("clientFileDelivery:linkZoomRecording", async () => {
    await getDb()
      .update(rawCommunicationRecords)
      .set({ clientFileId: file.id, updatedAt: new Date() })
      .where(eq(rawCommunicationRecords.id, recordId));
  });
  console.log(
    `[ClientFileDelivery] Zoom recording ${reused ? "reused" : "stored"} in-app`,
    { recordId, clientId, fileId: file.id },
  );
}
