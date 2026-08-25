/* test-registration
{
  "name": "Comms call recording serving route — 401 unauth, member 200 + download filename, non-member 403, clean 404s for unknown/incomplete/missing-object (Task #3431)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3431: call recording serving route (GET /api/comms/calls/:id/ recording) — 401 gate, member 200 with download filename, non-member 403, clean 404s for unknown call / incomplete recording / missing storage object. Object storage is prototype-stubbed; per-run random-suffixed seeds.",
  "tier": "small"
}
test-registration */
/**
 * Call recording serving endpoint — GET /api/comms/calls/:id/recording.
 *
 * The recording download route (server/routes/comms.ts) serves
 * call.recordingObjectKey via object storage with channel-member gating.
 * This test covers the route directly so a regression in auth gating or
 * missing-object handling can't silently break call playback while UI
 * tests still pass (Task #3431).
 *
 * Verifies:
 *   - Unauthenticated request returns 401, storage never touched
 *   - Authenticated channel member gets the recording bytes with the
 *     expected Content-Disposition filename
 *   - Non-member gets 403, storage never touched
 *   - Unknown call id returns a clean 404 (not 500)
 *   - Recording not completed (no object key) returns 404 with status
 *   - DB row completed but object missing in storage returns 404, not 500
 *
 * Object storage is stubbed by patching ObjectStorageService.prototype
 * (same pattern as tests/comms-attachment-serving.test.ts), so no real
 * storage calls escape the test.
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
import { commsChannels, commsChannelMembers, commsCalls } from "../shared/models/comms";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");
const MEMBER_ID = `comms-rec-member-${RUN}`;
const OUTSIDER_ID = `comms-rec-outsider-${RUN}`;
const RECORDING_KEY = `comms-recordings/${RUN}-call.mp4`;
const MISSING_STORAGE_KEY = `comms-recordings/${RUN}-gone.mp4`;

// ─── Object storage stub (prototype patch — no real storage calls) ──────────
const FILE_BYTES = Buffer.from(`fake-mp4-bytes-${RUN}`);
const knownObjects = new Map<string, string>([
  [RECORDING_KEY, "video/mp4"],
  // MISSING_STORAGE_KEY intentionally absent: call row says completed, object gone.
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
const seedChannelIds: string[] = [];
let completedCallId = "";
let pendingCallId = "";
let missingObjectCallId = "";

async function seed(): Promise<void> {
  for (const id of [MEMBER_ID, OUTSIDER_ID]) {
    await db
      .insert(users)
      .values({
        id,
        username: id,
        email: `${id}@test.invalid`,
        firstName: "Recording",
        lastName: "Test",
        role: "account_manager",
      })
      .onConflictDoNothing();
    seedUserIds.push(id);
  }

  const [channel] = await db
    .insert(commsChannels)
    .values({
      name: `rec-test-${RUN}`,
      slug: `rec-test-${RUN}`,
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

  const [completed] = await db
    .insert(commsCalls)
    .values({
      channelId: channel.id,
      initiatedBy: MEMBER_ID,
      status: "ended",
      recordingStatus: "completed",
      recordingObjectKey: RECORDING_KEY,
    })
    .returning();
  completedCallId = completed.id;

  const [pending] = await db
    .insert(commsCalls)
    .values({
      channelId: channel.id,
      initiatedBy: MEMBER_ID,
      status: "ended",
      recordingStatus: "recording",
    })
    .returning();
  pendingCallId = pending.id;

  const [missing] = await db
    .insert(commsCalls)
    .values({
      channelId: channel.id,
      initiatedBy: MEMBER_ID,
      status: "ended",
      recordingStatus: "completed",
      recordingObjectKey: MISSING_STORAGE_KEY,
    })
    .returning();
  missingObjectCallId = missing.id;
}

process.on("exit", async () => {
  // Channel delete cascades to members and calls.
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
    const res = await undici.request(`${base}/api/comms/calls/${completedCallId}/recording`);
    assert.equal(res.statusCode, 401, "(A) unauth should 401");
    await res.body.dump();
    assert.equal(storageCalls.length, before, "(A) storage must not be touched when unauth");
    console.log("  ✓ unauthenticated request returns 401 without touching storage");
  });

  // (B) Authenticated member → 200 with recording bytes + download filename
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/calls/${completedCallId}/recording`);
    assert.equal(res.statusCode, 200, "(B) member should 200");
    const disposition = String(res.headers["content-disposition"] ?? "");
    assert.ok(
      disposition.includes(`filename="call-${completedCallId}.mp4"`),
      `(B) disposition: ${disposition}`,
    );
    const body = Buffer.from(await res.body.arrayBuffer());
    assert.ok(body.equals(FILE_BYTES), "(B) body should be the stored recording bytes");
    console.log("  ✓ authenticated member gets recording with download filename");
  });

  // (C) Authenticated non-member → 403, storage never touched
  await withApp(OUTSIDER_ID, async (base) => {
    const before = storageCalls.length;
    const res = await undici.request(`${base}/api/comms/calls/${completedCallId}/recording`);
    assert.equal(res.statusCode, 403, "(C) non-member should 403");
    await res.body.dump();
    assert.equal(storageCalls.length, before, "(C) storage must not be touched for non-member");
    console.log("  ✓ non-member gets 403 without touching storage");
  });

  // (D) Unknown call id → clean 404, not 500
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(
      `${base}/api/comms/calls/00000000-0000-0000-0000-000000000000/recording`,
    );
    assert.equal(res.statusCode, 404, "(D) unknown call should 404");
    const body: any = await res.body.json();
    assert.equal(body.error, "Call not found", "(D) clean 404 body");
    console.log("  ✓ unknown call id returns clean 404");
  });

  // (E) Recording not completed (no object key) → 404 with status echo
  await withApp(MEMBER_ID, async (base) => {
    const before = storageCalls.length;
    const res = await undici.request(`${base}/api/comms/calls/${pendingCallId}/recording`);
    assert.equal(res.statusCode, 404, "(E) incomplete recording should 404");
    const body: any = await res.body.json();
    assert.equal(body.error, "Recording not available", "(E) clean body");
    assert.equal(body.status, "recording", "(E) status echoed for the client");
    assert.equal(storageCalls.length, before, "(E) storage must not be touched");
    console.log("  ✓ incomplete recording returns 404 with status, storage untouched");
  });

  // (F) DB row completed but object missing in storage → 404, not 500
  await withApp(MEMBER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/calls/${missingObjectCallId}/recording`);
    assert.equal(res.statusCode, 404, "(F) missing storage object should 404, not 500");
    const body: any = await res.body.json();
    assert.equal(body.error, "Recording file not found in storage", "(F) clean 404 body");
    console.log("  ✓ missing storage object returns 404, not 500");
  });

  console.log("comms-call-recording-serving: PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("comms-call-recording-serving: FAILED", err);
  process.exit(1);
});
