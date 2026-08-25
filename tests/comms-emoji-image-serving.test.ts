/* test-registration
{
  "name": "Comms custom emoji image serving route — 401 unauth, 200 + content type + immutable cache headers, clean 404 for unknown emoji and missing storage object (Task #3430)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3430: custom emoji image serving route (GET /api/comms/emoji/:id/image) — 401 gate, authenticated 200 with content type + immutable private cache headers, clean 404 for unknown emoji id and for a DB row whose storage object is missing (was a 500 before the route fix in this task). Object storage is prototype-stubbed; per-run random-suffixed seeds.",
  "tier": "small"
}
test-registration */
/**
 * Custom emoji image serving endpoint — GET /api/comms/emoji/:id/image.
 *
 * The emoji serving route streams objects from private storage just like the
 * attachment route (tests/comms-attachment-serving.test.ts) but had no
 * route-level test; a regression in lookup or storage handling would break
 * every custom emoji render silently.
 *
 * Verifies:
 *   - Unauthenticated request returns 401 without touching storage
 *   - Authenticated user gets the image with the stored content type and
 *     immutable private cache headers
 *   - Unknown emoji id returns a clean 404 (not 500)
 *   - Emoji row present but object missing in storage returns 404 (not 500)
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
import { commsCustomEmoji } from "../shared/models/comms";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");
const USER_ID = `comms-emoji-user-${RUN}`;
const OBJECT_KEY = `comms-emoji/${RUN}-party.png`;
const MISSING_STORAGE_KEY = `comms-emoji/${RUN}-gone.gif`;

// ─── Object storage stub (prototype patch — no real storage calls) ──────────
const IMAGE_BYTES = Buffer.from(`fake-emoji-png-${RUN}`);
const knownObjects = new Map<string, string>([
  [OBJECT_KEY, "image/png"],
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
  // The route sets Content-Type from the emoji row before calling this; only
  // fill it in if missing so the test observes the route's own header.
  if (!res.getHeader("Content-Type")) {
    res.set("Content-Type", knownObjects.get(file.__stubKey) ?? "application/octet-stream");
  }
  res.set("Content-Length", String(IMAGE_BYTES.length));
  res.status(200).end(IMAGE_BYTES);
};

// ─── Test app harness ────────────────────────────────────────────────────────
function makeApp(actingUserId: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated
    // (requireAuth → 401). requireAuth loads the real users row (public
    // schema, seeded above) so role gating reflects the DB.
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
const seedEmojiIds: string[] = [];
let emojiId = "";
let missingStorageEmojiId = "";

async function seed(): Promise<void> {
  await db
    .insert(users)
    .values({
      id: USER_ID,
      username: USER_ID,
      email: `${USER_ID}@test.invalid`,
      firstName: "Emoji",
      lastName: "Test",
      role: "account_manager",
    })
    .onConflictDoNothing();
  seedUserIds.push(USER_ID);

  const rows = await db
    .insert(commsCustomEmoji)
    .values([
      {
        name: `party-${RUN}`,
        objectKey: OBJECT_KEY,
        contentType: "image/png",
        sizeBytes: IMAGE_BYTES.length,
        createdBy: USER_ID,
      },
      {
        name: `gone-${RUN}`,
        objectKey: MISSING_STORAGE_KEY,
        contentType: "image/gif",
        sizeBytes: 123,
        createdBy: USER_ID,
      },
    ])
    .returning();
  emojiId = rows.find((r) => r.objectKey === OBJECT_KEY)!.id;
  missingStorageEmojiId = rows.find((r) => r.objectKey === MISSING_STORAGE_KEY)!.id;
  seedEmojiIds.push(...rows.map((r) => r.id));
}

process.on("exit", async () => {
  if (seedEmojiIds.length > 0) {
    await db
      .delete(commsCustomEmoji)
      .where(inArray(commsCustomEmoji.id, seedEmojiIds))
      .catch(() => {});
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
    const res = await undici.request(`${base}/api/comms/emoji/${emojiId}/image`);
    assert.equal(res.statusCode, 401, "(A) unauth should 401");
    await res.body.dump();
    assert.equal(storageCalls.length, before, "(A) storage must not be touched when unauth");
    console.log("  ✓ unauthenticated request returns 401 without touching storage");
  });

  // (B) Authenticated user → 200 with content type + immutable private cache headers
  await withApp(USER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/emoji/${emojiId}/image`);
    assert.equal(res.statusCode, 200, "(B) authenticated should 200");
    assert.equal(res.headers["content-type"], "image/png", "(B) content type from emoji row");
    const cache = String(res.headers["cache-control"] ?? "");
    assert.ok(cache.includes("private"), `(B) cache must be private: ${cache}`);
    assert.ok(cache.includes("immutable"), `(B) cache must be immutable: ${cache}`);
    const body = Buffer.from(await res.body.arrayBuffer());
    assert.ok(body.equals(IMAGE_BYTES), "(B) body should be the stored bytes");
    assert.ok(storageCalls.includes(OBJECT_KEY), "(B) storage looked up by the emoji's objectKey");
    console.log("  ✓ authenticated user gets emoji image with right headers");
  });

  // (C) Unknown emoji id → clean 404, not 500, storage never touched
  await withApp(USER_ID, async (base) => {
    const before = storageCalls.length;
    const res = await undici.request(
      `${base}/api/comms/emoji/00000000-0000-4000-8000-${RUN}00000000/image`,
    );
    assert.equal(res.statusCode, 404, "(C) unknown emoji should 404");
    const body: any = await res.body.json();
    assert.equal(body.error, "Emoji not found", "(C) clean 404 body");
    assert.equal(storageCalls.length, before, "(C) storage must not be touched for unknown emoji");
    console.log("  ✓ unknown emoji id returns clean 404 without touching storage");
  });

  // (D) Emoji row exists but object missing in storage → 404, not 500
  await withApp(USER_ID, async (base) => {
    const res = await undici.request(
      `${base}/api/comms/emoji/${missingStorageEmojiId}/image`,
    );
    assert.equal(res.statusCode, 404, "(D) missing storage object should 404, not 500");
    const body: any = await res.body.json();
    assert.equal(body.error, "Emoji image not found in storage", "(D) clean 404 body");
    console.log("  ✓ missing storage object returns 404, not 500");
  });

  console.log("comms-emoji-image-serving: PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("comms-emoji-image-serving: FAILED", err);
  process.exit(1);
});
