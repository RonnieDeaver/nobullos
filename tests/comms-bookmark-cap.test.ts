/* test-registration
{
  "name": "Comms per-channel bookmark cap — 422 at 25 bookmarks, no 26th row (Task #3289)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3289: per-channel bookmark cap. POST bookmarks returns 422 once the channel holds 25 bookmarks and never persists a 26th row.",
  "tier": "small"
}
test-registration */
/**
 * Task #3289 — server-side per-channel bookmark cap.
 *
 * POST /api/comms/channels/:id/bookmarks must return 422 once the channel
 * already holds 25 bookmarks, so a bot/script cannot silently flood a
 * channel whose bookmarks bar is hidden from non-admin members.
 *
 * Contract locked in:
 *   1. A member can create a bookmark while under the cap.
 *   2. At 25 existing bookmarks, create returns 422 with a human-readable
 *      string `error` (the AddBookmarkDialog surfaces body.error directly).
 *   3. No 26th row is persisted.
 *
 * Isolation note (.agents/memory/route-test-public-schema-collision.md):
 * this route test writes to the shared dev DB public tables — all seeded
 * ids/names carry a per-run random token and are deleted in finally.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { commsChannels, commsBookmarks } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");
const MEMBER_ID = `bmcap-3289-member-${RUN}`;
const CAP = 25;

let channelId = "";

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: MEMBER_ID,
      email: `bmcap-3289-member-${RUN}@test.local`,
      firstName: "Bookmark",
      lastName: `Capper-${RUN}`,
      role: "account_manager",
    },
  ]);

  const channel = await commsStorage.createChannel({
    name: `bmcap-test-${RUN}`,
    slug: `bmcap-test-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: MEMBER_ID,
  } as any);
  channelId = channel.id;
  await commsStorage.addChannelMember(channelId, MEMBER_ID, "owner");
}

async function cleanup(): Promise<void> {
  if (channelId) await db.delete(commsChannels).where(eq(commsChannels.id, channelId));
  await db.delete(users).where(inArray(users.id, [MEMBER_ID]));
}

function makeApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticates as
    // this user id; requireAuth resolves the real seeded users row and
    // populates req.user. (The pre-Clerk passport-shape injection stopped
    // working when auth migrated.)
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp<T>(
  actingUserId: string,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeApp(actingUserId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function countBookmarks(): Promise<number> {
  const rows = await db
    .select()
    .from(commsBookmarks)
    .where(eq(commsBookmarks.channelId, channelId));
  return rows.length;
}

async function main(): Promise<void> {
  console.log("Per-channel bookmark cap (Task #3289)");

  await seed();
  try {
    await withApp(MEMBER_ID, async (baseUrl) => {
      const post = (label: string) =>
        fetch(`${baseUrl}/api/comms/channels/${channelId}/bookmarks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "link", label, url: "https://example.com" }),
        });

      await step("member creates a bookmark while under the cap", async () => {
        const r = await post(`bm-${RUN}-first`);
        assert.equal(r.status, 201, `expected 201, got ${r.status}`);
        const body = await r.json();
        assert.equal(body.label, `bm-${RUN}-first`);
      });

      await step(`create returns 422 once the channel holds ${CAP} bookmarks`, async () => {
        // Seed the remaining rows directly (1 already created via the route).
        const existing = await countBookmarks();
        const rows = [];
        for (let i = existing; i < CAP; i++) {
          rows.push({
            channelId,
            type: "link" as const,
            label: `bm-${RUN}-fill-${i}`,
            url: "https://example.com",
            sortOrder: i,
            createdBy: MEMBER_ID,
          });
        }
        if (rows.length > 0) await db.insert(commsBookmarks).values(rows);
        assert.equal(await countBookmarks(), CAP);

        const r = await post(`bm-${RUN}-overflow`);
        assert.equal(r.status, 422, `expected 422, got ${r.status}`);
        const body = await r.json();
        assert.equal(typeof body.error, "string", "error must be a human-readable string");
        assert.match(body.error, /25/, "message should mention the cap");
      });

      await step("no 26th bookmark row is persisted", async () => {
        assert.equal(await countBookmarks(), CAP);
      });
    });
  } finally {
    await cleanup();
    await closeDbPools().catch(() => {});
    const undici = await import("undici");
    await undici.getGlobalDispatcher().close().catch(() => {});
  }

  if (failures > 0) {
    console.error(`${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("All steps passed");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
