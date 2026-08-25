/* test-registration
{
  "name": "Comms attachment serving route — 401 unauth, member 200 + content type, thumbnail_key lookup, non-member 403, clean 404s (Task #3313)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3313: attachment serving route (GET /api/comms/attachments/*) — 401 gate, member 200 with storage content type, thumbnail_key lookup, non-member 403, and clean 404s for unknown keys / missing storage objects. Object storage is prototype-stubbed; per-run random-suffixed seeds.",
  "tier": "small"
}
test-registration */
/**
 * Attachment serving endpoint — GET /api/comms/attachments/{objectKey}.
 *
 * The FileThumb UI test (tests/comms-file-search-thumbnail.test.tsx) only
 * asserts the img src attribute; this test covers the serving route itself so
 * a regression in auth gating, object lookup, or content-type handling can't
 * silently break every thumbnail and download.
 *
 * Verifies:
 *   - Unauthenticated request returns 401
 *   - Authenticated channel member gets the object with the right content type
 *   - Thumbnail keys (comms-attachments/thumb/...) resolve via thumbnail_key
 *   - Non-member gets 403
 *   - Unknown attachment key returns a clean 404 (not 500)
 *   - Attachment row present but object missing in storage returns 404 (not 500)
 *
 * Object storage is stubbed by patching ObjectStorageService.prototype, so no
 * real storage calls escape the test.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { inArray } from "drizzle-orm";

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
const MEMBER_ID = `comms-att-member-${RUN}`;
const OUTSIDER_ID = `comms-att-outsider-${RUN}`;
const OBJECT_KEY = `comms-attachments/${RUN}-file.png`;
const THUMB_KEY = `comms-attachments/thumb/${RUN}-file.png`;
const MISSING_STORAGE_KEY = `comms-attachments/${RUN}-gone.pdf`;

// ─── Object storage stub (prototype patch — no real storage calls) ──────────
const FILE_BYTES = Buffer.from(`fake-png-bytes-${RUN}`);
const knownObjects = new Map<string, string>([
  [OBJECT_KEY, "image/png"],
  [THUMB_KEY, "image/png"],
  // MISSING_STORAGE_KEY intentionally absent: DB row exists, storage object doesn't.
]);
const storageCalls: string[] = [];

(ObjectStorageService.prototype as any).getPrivateObjectFileByKey = async function (
  objectKey: string,
) {
  storageCalls.push(objectKey);
  if (!knownObjects.has(objectKey)) throw new Error("Object not found");
  return { __stubKey: objectKey };
};
(ObjectStorageService.prototype as any).downloadObject = async function (
  file: any,
  res: express.Response,
) {
  const contentType = knownObjects.get(file.__stubKey) ?? "application/octet-stream";
  res.set({ "Content-Type": contentType, "Content-Length": String(FILE_BYTES.length) });
  res.status(200).end(FILE_BYTES);
};

// ─── Test app harness ────────────────────────────────────────────────────────
function makeApp(actingUserId: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    // requireAuth resolves the real seeded users row and populates req.user.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp(
  actingUserId: string | null,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = makeApp(actingUserId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Seed data ───────────────────────────────────────────────────────────────
const seedUserIds: string[] = [];
const seedChannelIds: string[] = [];

async function seed(): Promise<void> {
  for (const id of [MEMBER_ID, OUTSIDER_ID]) {
    await db
      .insert(users)
      .values({
        id,
        username: id,
        email: `${id}@test.invalid`,
        firstName: "Attachment",
        lastName: "Test",
        role: "account_manager",
      })
      .onConflictDoNothing();
    seedUserIds.push(id);
  }

  const [channel] = await db
    .insert(commsChannels)
    .values({
      name: `att-test-${RUN}`,
      slug: `att-test-${RUN}`,
      type: "channel",
      visibility: "private",
      createdBy: MEMBER_ID,
    })
    .returning();
  seedChannelIds.push(channel.id);

  await db.insert(commsChannelMembers).values({
    channelId: channel.id,
    userId: MEMBER_ID,
    role: "member",
  });

  const [msg] = await db
    .insert(commsMessages)
    .values({ channelId: channel.id, userId: MEMBER_ID, content: "attachment test" })
    .returning();

  await db.insert(commsAttachments).values([
    {
      messageId: msg.id,
      uploadedBy: MEMBER_ID,
      objectKey: OBJECT_KEY,
      thumbnailKey: THUMB_KEY,
      filename: "file.png",
      contentType: "image/png",
      sizeBytes: FILE_BYTES.length,
    },
    {
      messageId: msg.id,
      uploadedBy: MEMBER_ID,
      objectKey: MISSING_STORAGE_KEY,
      filename: "gone.pdf",
      contentType: "application/pdf",
      sizeBytes: 123,
    },
  ]);
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

// ─── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  await seed();

  // (A) Unauthenticated → 401, storage never touched
  await withApp(null, async (base) => {
    const before = storageCalls.length;
    const res = await undici.request(`${base}/api/comms/attachments/${OBJECT_KEY}`);
    assert.equal(res.statusCode, 401, "(A) unauth should 401");
    await res.body.dump();
    assert.equal(storageCalls.length, before, "(A) storage must not be touched when unauth");
    console.log("  ✓ unauthenticated request returns 401 without touching storage");
  });

  // (B) Authenticated member → 200 with the right content type and body
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/attachments/${OBJECT_KEY}`);
    assert.equal(res.statusCode, 200, "(B) member should 200");
    assert.equal(res.headers["content-type"], "image/png", "(B) content type from storage metadata");
    const disposition = String(res.headers["content-disposition"] ?? "");
    assert.ok(disposition.includes('filename="file.png"'), `(B) disposition: ${disposition}`);
    const body = Buffer.from(await res.body.arrayBuffer());
    assert.ok(body.equals(FILE_BYTES), "(B) body should be the stored bytes");
    console.log("  ✓ authenticated member gets object with right content type");
  });

  // (C) Thumbnail key resolves via thumbnail_key column
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/attachments/${THUMB_KEY}`);
    assert.equal(res.statusCode, 200, "(C) thumb key should 200");
    assert.equal(res.headers["content-type"], "image/png", "(C) thumb content type");
    const body = Buffer.from(await res.body.arrayBuffer());
    assert.ok(body.equals(FILE_BYTES), "(C) thumb body served");
    console.log("  ✓ thumbnail key resolves via thumbnail_key lookup");
  });

  // (D) Authenticated non-member → 403, storage never touched
  await withApp(OUTSIDER_ID, async (base) => {
    const before = storageCalls.length;
    const res = await undici.request(`${base}/api/comms/attachments/${OBJECT_KEY}`);
    assert.equal(res.statusCode, 403, "(D) non-member should 403");
    await res.body.dump();
    assert.equal(storageCalls.length, before, "(D) storage must not be touched for non-member");
    console.log("  ✓ non-member gets 403 without touching storage");
  });

  // (E) Unknown attachment key → clean 404, not 500
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(
      `${base}/api/comms/attachments/comms-attachments/${RUN}-nonexistent.bin`,
    );
    assert.equal(res.statusCode, 404, "(E) unknown key should 404");
    const body: any = await res.body.json();
    assert.equal(body.error, "Attachment not found", "(E) clean 404 body");
    console.log("  ✓ unknown attachment key returns clean 404");
  });

  // (F) DB row exists but object missing in storage → 404, not 500
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/attachments/${MISSING_STORAGE_KEY}`);
    assert.equal(res.statusCode, 404, "(F) missing storage object should 404, not 500");
    const body: any = await res.body.json();
    assert.equal(body.error, "File not found in storage", "(F) clean 404 body");
    console.log("  ✓ missing storage object returns 404, not 500");
  });

  console.log("comms-attachment-serving: PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("comms-attachment-serving: FAILED", err);
  process.exit(1);
});
