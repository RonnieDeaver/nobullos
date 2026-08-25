/* test-registration
{
  "name": "Client-file pipeline delivery (Task #4025)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4025/#4084: the Zoom/Twilio → in-app files delivery seam (the only sink since the Drive mirror was retired) — in-app Zoom delivery stores the canonical-named file and links the communication record, retries reuse by name instead of duplicating, and the Twilio call-archive fan-out writes recording+transcript into the client's folders exactly once (per-sink saved_at idempotency). A drift here silently drops new recordings or duplicates them on every pipeline retry.",
  "tier": "small"
}
test-registration */
/**
 * Task #4025 (delivery seam) / Task #4084 (Drive mirror retired — in-app
 * client files are the ONLY pipeline sink).
 *
 * Exercises the REAL delivery seam end-to-end against the hermetic DB and
 * the REAL object storage sidecar (tiny buffers, cleaned up in finally).
 * No Zoom network: the Zoom download is injected through the
 * deliverZoomRecording test seam.
 *
 *   1. ensureClientFileFolderPath — creates nested paths once, then reuses.
 *   2. storeClientFile — uploads, sniffs, claims; name-reuse returns the
 *      existing row without new content; reuseExistingByName:false
 *      supersedes into a version instead.
 *   3. deliverZoomRecording — file lands in "Zoom Recordings" + the
 *      communication record links the copy; re-delivery reuses instead of
 *      duplicating.
 *   4. saveToClientFiles (call archive) — recording streamed from object
 *      storage + transcript buffer land in "Call Recordings"/"Call
 *      Transcripts", the twilio_calls columns are stamped, and a second
 *      call is a per-sink no-op.
 */

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { sql, eq } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  ZOOM_RECORDINGS_FOLDER,
  CALL_RECORDINGS_FOLDER,
  CALL_TRANSCRIPTS_FOLDER,
  ensureClientFileFolderPath,
  storeClientFile,
  deliverZoomRecording,
} from "../server/services/clientFileDelivery";
import { saveToClientFiles } from "../server/services/callArchivePipeline";
import { findLiveFileByName, findLiveFolderByName, type FileActor } from "../server/services/clientFileService";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { twilioCalls, rawCommunicationRecords } from "@shared/schema";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4025d-${HEX}`;
const USER_ID = `${RUN}-user`;
const CLIENT_ID = `a4025d01-${HEX}-${randomBytes(3).toString("hex")}`;
const ACTOR: FileActor = { id: null, name: "Delivery test" };

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function clientFileCount(): Promise<number> {
  const r = await db.execute(
    sql`SELECT count(*)::int AS n FROM client_files WHERE client_id = ${CLIENT_ID} AND trashed_at IS NULL`,
  );
  return (r as any).rows[0].n as number;
}

/** MP3-looking bytes (ID3 magic) so the claim sniff sees audio/mpeg. */
function fakeMp3(size = 96): Buffer {
  return Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), randomBytes(size)]);
}
/** MP4-looking bytes (ftyp box at offset 4). */
function fakeMp4(size = 128): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom\x00\x00\x02\x00isomiso2"),
    randomBytes(size),
  ]);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err?.message ?? err}`);
  }
}

async function main(): Promise<void> {
  const objectStorage = new ObjectStorageService();
  // Extra object keys written OUTSIDE client_files rows (staged call
  // recordings); client_files/version keys are collected at cleanup.
  const extraKeys: string[] = [];

  try {
    await db.execute(sql`
      INSERT INTO users (id, email, first_name, last_name, role, authority_level)
      VALUES (${USER_ID}, ${`${USER_ID}@t4025.example`}, 'Task4025', 'Delivery', 'account_manager', 'core')
    `);
    await db.execute(sql`
      INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
      VALUES (${CLIENT_ID}, ${`${RUN} Firm`}, ${USER_ID}, false, false)
    `);

    await step("ensureClientFileFolderPath creates once and reuses", async () => {
      const first = await ensureClientFileFolderPath(CLIENT_ID, ["Nest", "Inner"], ACTOR);
      const again = await ensureClientFileFolderPath(CLIENT_ID, ["Nest", "Inner"], ACTOR);
      assertEq(again.id, first.id, "same folder id on repeat");
      const outer = await findLiveFolderByName(CLIENT_ID, null, "Nest");
      assert(outer, "outer folder exists at root");
      const inner = await findLiveFolderByName(CLIENT_ID, outer!.id, "Inner");
      assertEq(inner?.id, first.id, "inner nested under outer");
    });

    await step("storeClientFile stores, reuses by name, supersedes when told", async () => {
      const folder = await ensureClientFileFolderPath(CLIENT_ID, ["Store"], ACTOR);
      const bytes = fakeMp3();
      const stored = await storeClientFile({
        clientId: CLIENT_ID,
        folderId: folder.id,
        fileName: "take.mp3",
        content: bytes,
        contentType: "audio/mpeg",
        actor: ACTOR,
      });
      assertEq(stored.reused, false, "first store writes");
      assertEq(stored.file.sizeBytes, bytes.length, "size from sniff");
      assertEq(stored.file.mimeType, "audio/mpeg", "mime from sniff");

      const reused = await storeClientFile({
        clientId: CLIENT_ID,
        folderId: folder.id,
        fileName: "take.mp3",
        content: fakeMp3(500), // different content — must NOT be written
        contentType: "audio/mpeg",
        actor: ACTOR,
      });
      assertEq(reused.reused, true, "same name reused");
      assertEq(reused.file.id, stored.file.id, "same row");
      assertEq(reused.file.sizeBytes, bytes.length, "original bytes kept");

      const superseded = await storeClientFile({
        clientId: CLIENT_ID,
        folderId: folder.id,
        fileName: "take.mp3",
        content: fakeMp3(200),
        contentType: "audio/mpeg",
        actor: ACTOR,
        reuseExistingByName: false,
      });
      assertEq(superseded.reused, false, "supersede writes new content");
      assertEq(superseded.file.id, stored.file.id, "same file id (versioned)");
      assertEq(superseded.supersededVersionNumber, 1, "old content became version 1");
    });

    await step("deliverZoomRecording stores, links, and reuses on retry", async () => {
      const recordId = `${RUN}-rec-live`;
      await db.execute(sql`
        INSERT INTO raw_communication_records (id, source_type, title, timestamp, client_id)
        VALUES (${recordId}, 'zoom_meeting', ${`${RUN} live meeting`}, NOW(), ${CLIENT_ID})
      `);
      const meeting = {
        topic: `${RUN} Strategy Call`,
        start_time: "2026-08-06T10:00:00Z",
        recording_files: [{ file_type: "MP4", download_url: "https://fake.invalid/live" }],
      };
      let downloads = 0;
      const download = async () => { downloads += 1; return fakeMp4(); };

      await deliverZoomRecording(recordId, meeting, CLIENT_ID, { download });
      assertEq(downloads, 1, "downloaded once");

      const folder = await findLiveFolderByName(CLIENT_ID, null, ZOOM_RECORDINGS_FOLDER);
      assert(folder, "Zoom Recordings folder created");
      const file = await findLiveFileByName(CLIENT_ID, folder!.id, `2026-08-06 — ${RUN} Strategy Call.mp4`);
      assert(file, "canonical-named recording stored");
      assertEq(file!.mimeType, "video/mp4", "sniffed as mp4");

      const [rec] = await db.select().from(rawCommunicationRecords).where(eq(rawCommunicationRecords.id, recordId));
      assertEq(rec.clientFileId, file!.id, "communication record links the in-app copy");

      const before = await clientFileCount();
      await deliverZoomRecording(recordId, meeting, CLIENT_ID, { download });
      assertEq(downloads, 2, "retry downloads again (before the sink check)");
      assertEq(await clientFileCount(), before, "retry reused — no duplicate file");
    });

    await step("saveToClientFiles archives recording + transcript exactly once", async () => {
      // Stage the "Twilio recording" in object storage where the archive
      // pipeline expects it (the call row's objectStorageKey).
      const stagedKey = `client-files/${CLIENT_ID}/staged-${HEX}.mp3`;
      const recordingBytes = fakeMp3(256);
      await objectStorage.streamUploadToPrivateKey(stagedKey, Readable.from(recordingBytes), "audio/mpeg");
      extraKeys.push(stagedKey);

      const inserted = await db.execute(sql`
        INSERT INTO twilio_calls (direction, from_number, to_number, status, client_id, object_storage_key, transcript_text)
        VALUES ('inbound', '+15550001111', '+15550002222', 'completed', ${CLIENT_ID}, ${stagedKey}, ${`${RUN} transcript body`})
        RETURNING id
      `);
      const callId = (inserted as any).rows[0].id as string;

      const [call] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
      await saveToClientFiles(call);

      const recFolder = await findLiveFolderByName(CLIENT_ID, null, CALL_RECORDINGS_FOLDER);
      const txtFolder = await findLiveFolderByName(CLIENT_ID, null, CALL_TRANSCRIPTS_FOLDER);
      assert(recFolder && txtFolder, "both call folders created");

      const [updated] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
      assert(updated.clientFileRecordingId, "recording file id stamped");
      assert(updated.clientFileRecordingSavedAt, "recording saved_at stamped");
      assert(updated.clientFileTranscriptId, "transcript file id stamped");
      assert(updated.clientFileTranscriptSavedAt, "transcript saved_at stamped");

      const recRow = await db.execute(sql`
        SELECT name, size_bytes, folder_id FROM client_files WHERE id = ${updated.clientFileRecordingId}
      `);
      const rec = (recRow as any).rows[0];
      assertEq(rec.folder_id, recFolder!.id, "recording in Call Recordings");
      assert(String(rec.name).endsWith(".mp3"), "recording named .mp3");
      assertEq(Number(rec.size_bytes), recordingBytes.length, "recording bytes streamed from storage");

      const txtRow = await db.execute(sql`
        SELECT name, folder_id FROM client_files WHERE id = ${updated.clientFileTranscriptId}
      `);
      const txt = (txtRow as any).rows[0];
      assertEq(txt.folder_id, txtFolder!.id, "transcript in Call Transcripts");
      assert(String(txt.name).endsWith(".txt"), "transcript named .txt");

      // Second call with the refreshed row: both saved_at columns set → no-op.
      const before = await clientFileCount();
      await saveToClientFiles(updated);
      assertEq(await clientFileCount(), before, "re-run adds nothing");
      const [after] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
      assertEq(
        String(after.clientFileRecordingSavedAt),
        String(updated.clientFileRecordingSavedAt),
        "recording stamp unchanged",
      );
    });
  } finally {
    // Delete every object this run wrote (current + versions + staged).
    try {
      const keys = await db.execute(sql`
        SELECT object_key AS k FROM client_files WHERE client_id = ${CLIENT_ID}
        UNION ALL
        SELECT v.object_key FROM client_file_versions v
          JOIN client_files f ON f.id = v.file_id WHERE f.client_id = ${CLIENT_ID}
      `);
      const all = [...((keys as any).rows.map((r: any) => r.k as string)), ...extraKeys];
      for (const key of all) {
        try {
          const f = await objectStorage.getPrivateObjectFileByKey(key);
          await f.delete();
        } catch {}
      }
    } catch (err: any) {
      console.warn("cleanup (objects):", err?.message);
    }
    try {
      await db.execute(sql`DELETE FROM raw_communication_records WHERE client_id = ${CLIENT_ID}`);
      await db.execute(sql`DELETE FROM twilio_calls WHERE client_id = ${CLIENT_ID}`);
      await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    } catch (err: any) {
      console.warn("cleanup (rows):", err?.message);
    }
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll client-file delivery tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("client-file-delivery: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
