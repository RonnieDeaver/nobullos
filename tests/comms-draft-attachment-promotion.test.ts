/* test-registration
{
  "name": "Comms draft attachment promotion — draftObjectKey copies bytes to comms-attachments/, runs the 600px webp thumbnail pipeline + thumbnail_key, 404 without orphan message, spoofed prefix ignored (Task #3422)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3422: draft attachment promotion (POST upload route, draftObjectKey) — draft-flow pre-uploads promoted server-side get a canonical comms-attachments/ copy + the same 600px webp thumbnail pipeline with thumbnail_key persisted; missing draft object 404s without an orphan message; keys outside comms-draft-attachments/ are ignored (never read). Object storage is prototype-stubbed; per-run random-suffixed seeds.",
  "tier": "small"
}
test-registration */
/**
 * Draft attachment promotion — POST /api/comms/channels/:id/messages/upload
 * with `draftObjectKey` instead of raw file bytes.
 *
 * Files pre-uploaded through the draft flow (POST .../draft/attachments) land
 * under comms-draft-attachments/ with no DB row and historically skipped the
 * thumbnail pipeline. The upload route now accepts a promotion request that
 * re-reads the stored bytes, copies them to a canonical comms-attachments/
 * key, runs the same 600px webp thumbnail generation, and persists
 * thumbnail_key on the attachment row.
 *
 * Verifies:
 *   - Draft pre-upload endpoint stores bytes under comms-draft-attachments/
 *   - Promoting an image draft key → 201, attachment row with a
 *     comms-attachments/ object key, byte-identical copy, real 600px webp
 *     thumbnail uploaded, and thumbnail_key persisted
 *   - Promoting a non-image draft key → 201, thumbnail_key NULL, no thumb upload
 *   - Promoting a missing draft key → 404 and NO orphan message created
 *   - A draftObjectKey outside the comms-draft-attachments/ prefix is ignored
 *     (no attachment row, no storage read of the spoofed key)
 *   - Draft pre-upload of a resizable image returns a thumbnailKey under
 *     comms-draft-attachments/thumb/, the stored thumb is a real 600px webp,
 *     and GET /api/comms/attachments/<thumbKey> serves it back (draft branch)
 *   - Draft pre-upload of a non-image returns thumbnailKey null
 *   - Promotion REUSES an existing draft thumbnail (byte-for-byte copy to the
 *     canonical comms-attachments/thumb/ key, no sharp re-generation) —
 *     proven by replacing the stored draft thumb with sentinel bytes
 *   - Promotion falls back to fresh generation when the draft thumbnail
 *     object is absent (pre-thumbnail-era drafts)
 *
 * Object storage is stubbed by patching ObjectStorageService.prototype, so no
 * real storage calls escape the test. sharp runs for real.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsAttachments,
} from "../shared/models/comms";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");
const MEMBER_ID = `comms-draft-promo-${RUN}`;

// ─── Object storage stub (prototype patch — no real storage calls) ──────────
const uploadedObjects = new Map<string, { buffer: Buffer; contentType: string }>();
const readKeys: string[] = [];

(ObjectStorageService.prototype as any).streamUploadToPrivateKey = async function (
  objectKey: string,
  stream: NodeJS.ReadableStream,
  contentType: string,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  uploadedObjects.set(objectKey, { buffer: Buffer.concat(chunks), contentType });
};

(ObjectStorageService.prototype as any).downloadPrivateKeyToBuffer = async function (
  objectKey: string,
) {
  readKeys.push(objectKey);
  const stored = uploadedObjects.get(objectKey);
  if (!stored) throw new Error("Object not found");
  return stored.buffer;
};

// Serving-side stubs backed by the same captured-uploads map, so the GET
// attachment route serves exactly what the upload route stored.
(ObjectStorageService.prototype as any).getPrivateObjectFileByKey = async function (
  objectKey: string,
) {
  if (!uploadedObjects.has(objectKey)) throw new Error(`object not found: ${objectKey}`);
  return { __stubKey: objectKey };
};
(ObjectStorageService.prototype as any).downloadObject = async function (
  file: any,
  res: express.Response,
) {
  const obj = uploadedObjects.get(file.__stubKey)!;
  res.set({ "Content-Type": obj.contentType, "Content-Length": String(obj.buffer.length) });
  res.status(200).end(obj.buffer);
};

// ─── Test app harness ────────────────────────────────────────────────────────
function makeApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so role gating reflects the DB.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

// ─── Seed data ───────────────────────────────────────────────────────────────
const seedUserIds: string[] = [];
const seedChannelIds: string[] = [];
let channelId = "";

async function seed(): Promise<void> {
  await db
    .insert(users)
    .values({
      id: MEMBER_ID,
      username: MEMBER_ID,
      email: `${MEMBER_ID}@test.invalid`,
      firstName: "Draft",
      lastName: "Promo",
      role: "account_manager",
    })
    .onConflictDoNothing();
  seedUserIds.push(MEMBER_ID);

  const [channel] = await db
    .insert(commsChannels)
    .values({
      name: `draft-promo-${RUN}`,
      slug: `draft-promo-${RUN}`,
      type: "channel",
      visibility: "private",
      createdBy: MEMBER_ID,
    })
    .returning();
  channelId = channel.id;
  seedChannelIds.push(channel.id);

  await db.insert(commsChannelMembers).values({
    channelId: channel.id,
    userId: MEMBER_ID,
    role: "member",
  });
}

process.on("exit", async () => {
  // Channel delete cascades to members, messages, and attachments.
  if (seedChannelIds.length > 0) {
    await db.delete(commsChannels).where(inArray(commsChannels.id, seedChannelIds)).catch(() => {});
  }
  if (seedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, seedUserIds)).catch(() => {});
  }
  await closeDbPools();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function draftPreUpload(
  baseUrl: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<{ statusCode: number; body: any }> {
  const form = new undici.FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  const res = await undici.request(
    `${baseUrl}/api/comms/channels/${channelId}/draft/attachments`,
    { method: "POST", body: form },
  );
  const body: any = await res.body.json();
  return { statusCode: res.statusCode, body };
}

async function promote(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const res = await undici.request(
    `${baseUrl}/api/comms/channels/${channelId}/messages/upload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const body: any = await res.body.json();
  return { statusCode: res.statusCode, body };
}

async function countMessages(): Promise<number> {
  const rows = await db
    .select({ id: commsMessages.id })
    .from(commsMessages)
    .where(eq(commsMessages.channelId, channelId));
  return rows.length;
}

async function getAttachmentRow(id: string) {
  const [row] = await db
    .select()
    .from(commsAttachments)
    .where(eq(commsAttachments.id, id));
  return row;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  await seed();

  const app = makeApp(MEMBER_ID);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // (A) Image draft → promote → attachment + 600px webp thumbnail + thumbnail_key
    {
      const bigPng = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: { r: 60, g: 120, b: 40 } },
      })
        .png()
        .toBuffer();

      const pre = await draftPreUpload(base, "draft-big.png", "image/png", bigPng);
      assert.equal(pre.statusCode, 200, "(A) draft pre-upload should 200");
      const draftKey: string = pre.body.objectKey;
      assert.ok(
        draftKey?.startsWith("comms-draft-attachments/"),
        `(A) draft key prefix: ${draftKey}`,
      );
      assert.ok(uploadedObjects.get(draftKey)?.buffer.equals(bigPng), "(A) draft bytes stored");

      const before = uploadedObjects.size;
      const { statusCode, body } = await promote(base, {
        draftObjectKey: draftKey,
        filename: "draft-big.png",
        contentType: "image/png",
        content: `draft promo test ${RUN}`,
      });
      assert.equal(statusCode, 201, "(A) promotion should 201");
      assert.ok(body.attachment?.id, "(A) attachment returned");
      assert.equal(
        uploadedObjects.size - before,
        2,
        "(A) exactly two storage uploads on promotion (copy + thumbnail)",
      );

      const row = await getAttachmentRow(body.attachment.id);
      assert.ok(row, "(A) attachment row persisted");
      assert.ok(
        row.objectKey.startsWith("comms-attachments/") &&
          !row.objectKey.startsWith("comms-attachments/thumb/"),
        `(A) promoted object key is canonical: ${row.objectKey}`,
      );
      assert.ok(
        uploadedObjects.get(row.objectKey)?.buffer.equals(bigPng),
        "(A) promoted copy is byte-identical to the draft upload",
      );
      assert.ok(row.thumbnailKey, "(A) thumbnail_key must be set for a promoted image");
      assert.ok(
        row.thumbnailKey!.startsWith("comms-attachments/thumb/") &&
          row.thumbnailKey!.endsWith(".webp"),
        `(A) thumbnail key shape: ${row.thumbnailKey}`,
      );
      const thumb = uploadedObjects.get(row.thumbnailKey!);
      assert.ok(thumb, "(A) thumbnail object uploaded under the recorded key");
      assert.equal(thumb!.contentType, "image/webp", "(A) thumbnail content type is webp");
      const meta = await sharp(thumb!.buffer).metadata();
      assert.equal(meta.format, "webp", "(A) thumbnail decodes as webp");
      assert.equal(meta.width, 600, "(A) thumbnail downscaled to 600px wide");
      console.log("  ✓ promoted image draft gets a 600px webp thumbnail + thumbnail_key");
    }

    // (B) Non-image draft → promote → thumbnail_key NULL, single copy upload
    {
      const pdfBytes = Buffer.from(`%PDF-1.4 fake draft ${RUN}`);
      const pre = await draftPreUpload(base, "doc.pdf", "application/pdf", pdfBytes);
      assert.equal(pre.statusCode, 200, "(B) draft pre-upload should 200");

      const before = uploadedObjects.size;
      const { statusCode, body } = await promote(base, {
        draftObjectKey: pre.body.objectKey,
        filename: "doc.pdf",
        contentType: "application/pdf",
        content: `pdf promo ${RUN}`,
      });
      assert.equal(statusCode, 201, "(B) promotion should 201");
      assert.equal(uploadedObjects.size - before, 1, "(B) one storage upload for non-image");
      const row = await getAttachmentRow(body.attachment.id);
      assert.equal(row.thumbnailKey, null, "(B) thumbnail_key NULL for non-image promotion");
      assert.equal(row.sizeBytes, pdfBytes.length, "(B) sizeBytes recorded from stored bytes");
      console.log("  ✓ non-image draft promotion skips thumbnail (thumbnail_key NULL)");
    }

    // (C) Missing draft key → 404, no orphan message
    {
      const msgsBefore = await countMessages();
      const { statusCode } = await promote(base, {
        draftObjectKey: `comms-draft-attachments/${randomBytes(8).toString("hex")}.png`,
        filename: "gone.png",
        contentType: "image/png",
        content: "should not land",
      });
      assert.equal(statusCode, 404, "(C) missing draft object must 404");
      assert.equal(await countMessages(), msgsBefore, "(C) no orphan message created on 404");
      console.log("  ✓ missing draft object 404s without creating an orphan message");
    }

    // (D) Spoofed key outside the draft prefix is ignored (no read, no attachment)
    {
      const spoofed = "comms-attachments/spoofed-key.png";
      const readsBefore = readKeys.length;
      const { statusCode, body } = await promote(base, {
        draftObjectKey: spoofed,
        filename: "spoof.png",
        contentType: "image/png",
        content: `spoof promo ${RUN}`,
      });
      assert.equal(statusCode, 201, "(D) request still succeeds as a plain message");
      assert.equal(body.attachment, null, "(D) no attachment created for a spoofed key");
      assert.equal(readKeys.length, readsBefore, "(D) spoofed key never read from storage");
      console.log("  ✓ draftObjectKey outside comms-draft-attachments/ is ignored");
    }

    // (E) Draft pre-upload thumbnail: image → thumbnailKey under the draft
    //     thumb prefix, real 600px webp, served via the draft GET branch;
    //     non-image → thumbnailKey null.
    {
      const bigJpeg = await sharp({
        create: { width: 1400, height: 800, channels: 3, background: { r: 200, g: 40, b: 90 } },
      })
        .jpeg()
        .toBuffer();

      const pre = await draftPreUpload(base, "draft-thumb.jpg", "image/jpeg", bigJpeg);
      assert.equal(pre.statusCode, 200, "(E) draft pre-upload should 200");
      const thumbKey: string | null = pre.body.thumbnailKey;
      assert.ok(thumbKey, "(E) pre-upload must return a thumbnailKey for a resizable image");
      assert.ok(
        thumbKey!.startsWith("comms-draft-attachments/thumb/") && thumbKey!.endsWith(".webp"),
        `(E) draft thumbnail key shape: ${thumbKey}`,
      );
      const storedThumb = uploadedObjects.get(thumbKey!);
      assert.ok(storedThumb, "(E) draft thumbnail object uploaded under the returned key");
      assert.equal(storedThumb!.contentType, "image/webp", "(E) draft thumb content type");
      const thumbMeta = await sharp(storedThumb!.buffer).metadata();
      assert.equal(thumbMeta.format, "webp", "(E) draft thumb decodes as webp");
      assert.equal(thumbMeta.width, 600, "(E) draft thumb downscaled to 600px wide");

      // Serving: the draft branch of GET /api/comms/attachments/* must serve
      // the thumb key (no DB row exists for draft objects).
      const serve = await undici.request(
        `${base}/api/comms/attachments/${thumbKey}`,
      );
      assert.equal(serve.statusCode, 200, "(E) GET draft thumb key should 200");
      const served = Buffer.from(await serve.body.arrayBuffer());
      assert.ok(served.equals(storedThumb!.buffer), "(E) served bytes match stored thumbnail");

      const prePdf = await draftPreUpload(
        base,
        "no-thumb.pdf",
        "application/pdf",
        Buffer.from(`%PDF-1.4 draft ${RUN}`),
      );
      assert.equal(prePdf.statusCode, 200, "(E) non-image pre-upload should 200");
      assert.equal(prePdf.body.thumbnailKey, null, "(E) non-image pre-upload thumbnailKey null");
      console.log("  ✓ draft pre-upload generates + serves a 600px webp thumbnail (image only)");
    }

    // (F) Promotion reuses the existing draft thumbnail: replace the stored
    //     draft thumb with sentinel bytes; the promoted thumbnail must be a
    //     byte-identical copy of the sentinel (a sharp re-generation from the
    //     original could never produce these bytes).
    {
      const bigPng = await sharp({
        create: { width: 1500, height: 700, channels: 3, background: { r: 10, g: 90, b: 180 } },
      })
        .png()
        .toBuffer();

      const pre = await draftPreUpload(base, "reuse-me.png", "image/png", bigPng);
      assert.equal(pre.statusCode, 200, "(F) draft pre-upload should 200");
      const draftThumbKey: string = pre.body.thumbnailKey;
      assert.ok(draftThumbKey, "(F) draft pre-upload must return a thumbnailKey");

      const sentinel = Buffer.concat([
        Buffer.from(`sentinel-draft-thumb-${RUN}`),
        randomBytes(64),
      ]);
      uploadedObjects.set(draftThumbKey, { buffer: sentinel, contentType: "image/webp" });

      const readsBefore = readKeys.length;
      const { statusCode, body } = await promote(base, {
        draftObjectKey: pre.body.objectKey,
        filename: "reuse-me.png",
        contentType: "image/png",
        content: `reuse promo ${RUN}`,
      });
      assert.equal(statusCode, 201, "(F) promotion should 201");
      assert.ok(
        readKeys.slice(readsBefore).includes(draftThumbKey),
        "(F) promotion must read the existing draft thumbnail key",
      );

      const row = await getAttachmentRow(body.attachment.id);
      assert.ok(row.thumbnailKey, "(F) thumbnail_key set on the promoted attachment");
      assert.ok(
        row.thumbnailKey!.startsWith("comms-attachments/thumb/") &&
          row.thumbnailKey!.endsWith(".webp"),
        `(F) copied thumbnail lands under the canonical prefix: ${row.thumbnailKey}`,
      );
      const copied = uploadedObjects.get(row.thumbnailKey!);
      assert.ok(copied, "(F) copied thumbnail object uploaded");
      assert.ok(
        copied!.buffer.equals(sentinel),
        "(F) promoted thumbnail is a byte-identical COPY of the draft thumbnail (no re-generation)",
      );
      assert.equal(copied!.contentType, "image/webp", "(F) copied thumb keeps webp content type");
      console.log("  ✓ promotion copies the existing draft thumbnail instead of re-generating");
    }

    // (G) Fallback: draft thumbnail object absent (pre-thumbnail-era draft) →
    //     promotion still generates a fresh 600px webp thumbnail.
    {
      const bigPng = await sharp({
        create: { width: 1300, height: 650, channels: 3, background: { r: 180, g: 160, b: 20 } },
      })
        .png()
        .toBuffer();

      const pre = await draftPreUpload(base, "no-draft-thumb.png", "image/png", bigPng);
      assert.equal(pre.statusCode, 200, "(G) draft pre-upload should 200");
      // Simulate a pre-thumbnail-era draft: remove the draft thumbnail object.
      assert.ok(pre.body.thumbnailKey, "(G) precondition: draft thumb existed");
      uploadedObjects.delete(pre.body.thumbnailKey);

      const { statusCode, body } = await promote(base, {
        draftObjectKey: pre.body.objectKey,
        filename: "no-draft-thumb.png",
        contentType: "image/png",
        content: `fallback promo ${RUN}`,
      });
      assert.equal(statusCode, 201, "(G) promotion should 201");
      const row = await getAttachmentRow(body.attachment.id);
      assert.ok(row.thumbnailKey, "(G) thumbnail_key still set via fallback generation");
      const thumb = uploadedObjects.get(row.thumbnailKey!);
      assert.ok(thumb, "(G) fallback thumbnail uploaded");
      const meta = await sharp(thumb!.buffer).metadata();
      assert.equal(meta.format, "webp", "(G) fallback thumb decodes as webp");
      assert.equal(meta.width, 600, "(G) fallback thumb downscaled to 600px wide");
      console.log("  ✓ missing draft thumbnail falls back to fresh generation");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const dispatcher = undici.getGlobalDispatcher();
    await dispatcher.close().catch(() => {});
  }

  console.log("comms-draft-attachment-promotion: PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("comms-draft-attachment-promotion: FAILED", err);
  process.exit(1);
});
