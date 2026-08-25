/* test-registration
{
  "name": "Comms SSE reconnect catch-up — /events/catch-up returns active channels since disconnect (Task #3247)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3247: SSE reconnect catch-up — GET /api/comms/events/catch-up returns the list of channel IDs with message activity since a ?since timestamp; validates 400 on missing/invalid params, correct channel inclusion, foreign- channel exclusion, empty list when since=future, and serverTime field. Real routes + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms SSE reconnect catch-up (Task #3247).
 *
 * Verifies the GET /api/comms/events/catch-up endpoint that the client calls
 * immediately after re-establishing an SSE connection to find which channels
 * received messages while the connection was dropped.
 *
 * Contract locked in:
 *  1. Missing `since` → 400 with a readable error.
 *  2. Invalid ISO string → 400.
 *  3. `since` in the distant past → returns the channel(s) that have had
 *     message activity since that time (including channels the user is a member
 *     of that received messages after `since`).
 *  4. `since` = now → returns empty activeChannelIds (no future activity yet).
 *  5. Channels the user is NOT a member of are excluded from the result.
 *  6. Response carries a `serverTime` ISO field for anchoring the next window.
 *  7. Reaction-only activity (no new/edited message) also triggers inclusion
 *     so emoji changes are not silently missed after a reconnect.
 *
 * Isolation: all seeded rows carry a per-run random token and are deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { commsChannels } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");

const MEMBER_ID = `comms-catchup-mem-${RUN}`;
const OUTSIDER_ID = `comms-catchup-out-${RUN}`;

let memberChannelId = "";
let outsiderChannelId = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeApp(actingUserId: string, _role = "account_manager"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so requireRole reflects the DB role.
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

// ─── seed / cleanup ───────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: MEMBER_ID,
      email: `comms-catchup-mem-${RUN}@test.local`,
      firstName: "Member",
      lastName: `User-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `comms-catchup-out-${RUN}@test.local`,
      firstName: "Outsider",
      lastName: `User-${RUN}`,
      role: "account_manager",
    },
  ]);

  // Channel the MEMBER belongs to — will receive a message during the test
  const memberCh = await commsStorage.createChannel({
    name: `catchup-member-ch-${RUN}`,
    slug: `catchup-member-ch-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: MEMBER_ID,
  } as any);
  memberChannelId = memberCh.id;
  await commsStorage.addChannelMember(memberChannelId, MEMBER_ID, "owner");

  // Channel the OUTSIDER owns — member is NOT a member of this channel
  const outsiderCh = await commsStorage.createChannel({
    name: `catchup-outsider-ch-${RUN}`,
    slug: `catchup-outsider-ch-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: OUTSIDER_ID,
  } as any);
  outsiderChannelId = outsiderCh.id;
  await commsStorage.addChannelMember(outsiderChannelId, OUTSIDER_ID, "owner");
}

async function cleanup(): Promise<void> {
  if (memberChannelId) await db.delete(commsChannels).where(eq(commsChannels.id, memberChannelId));
  if (outsiderChannelId) await db.delete(commsChannels).where(eq(commsChannels.id, outsiderChannelId));
  await db.delete(users).where(inArray(users.id, [MEMBER_ID, OUTSIDER_ID]));
}

// ─── test runner ──────────────────────────────────────────────────────────────

let failures = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("comms-reconnect-catchup: SSE reconnect catch-up endpoint (Task #3247)");

  await seed();
  try {
    await withApp(MEMBER_ID, async (baseUrl) => {
      // ── 1. missing since param → 400 ──────────────────────────────────────
      await step("missing since → 400", async () => {
        const r = await fetch(`${baseUrl}/api/comms/events/catch-up`);
        assert.equal(r.status, 400, `expected 400, got ${r.status}`);
        const body = await r.json();
        assert.ok(
          typeof body.error === "string" && body.error.length > 0,
          "error field must be a non-empty string",
        );
      });

      // ── 2. invalid since string → 400 ─────────────────────────────────────
      await step("invalid ISO since → 400", async () => {
        const r = await fetch(
          `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent("not-a-date")}`,
        );
        assert.equal(r.status, 400, `expected 400, got ${r.status}`);
      });

      // ── 3. past since with activity → channel appears ─────────────────────
      await step(
        "channel with activity after `since` is returned in activeChannelIds",
        async () => {
          const since = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago

          // Create a message in the member's channel — it should appear in catch-up
          await commsStorage.createMessage({
            channelId: memberChannelId,
            userId: MEMBER_ID,
            content: `catch-up probe message ${RUN}`,
          } as any);

          const r = await fetch(
            `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
          );
          assert.equal(r.status, 200, `expected 200, got ${r.status}`);
          const body: { activeChannelIds: string[]; serverTime: string } = await r.json();

          assert.ok(
            Array.isArray(body.activeChannelIds),
            "activeChannelIds must be an array",
          );
          assert.ok(
            body.activeChannelIds.includes(memberChannelId),
            `memberChannelId (${memberChannelId}) must be in activeChannelIds`,
          );
        },
      );

      // ── 4. since=now → empty list (no future activity) ────────────────────
      await step("since=now returns empty activeChannelIds", async () => {
        const since = new Date(Date.now() + 5_000).toISOString(); // 5 seconds in the future
        const r = await fetch(
          `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
        );
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const body: { activeChannelIds: string[]; serverTime: string } = await r.json();
        assert.ok(
          Array.isArray(body.activeChannelIds),
          "activeChannelIds must be an array",
        );
        assert.equal(
          body.activeChannelIds.length,
          0,
          "no channels should have activity in the future",
        );
      });

      // ── 5. foreign channel excluded ────────────────────────────────────────
      await step(
        "channels the user is NOT a member of are excluded even if they have activity",
        async () => {
          const since = new Date(Date.now() - 60_000).toISOString();

          // Post a message in the outsider's channel (directly via storage,
          // as the member has no route access to it)
          await commsStorage.createMessage({
            channelId: outsiderChannelId,
            userId: OUTSIDER_ID,
            content: `outsider probe message ${RUN}`,
          } as any);

          const r = await fetch(
            `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
          );
          assert.equal(r.status, 200, `expected 200, got ${r.status}`);
          const body: { activeChannelIds: string[]; serverTime: string } = await r.json();
          assert.ok(
            !body.activeChannelIds.includes(outsiderChannelId),
            "outsiderChannelId must NOT be in activeChannelIds — user is not a member",
          );
        },
      );

      // ── 7. reaction-only activity detected ────────────────────────────────
      await step(
        "channel with only reaction activity after `since` is returned in activeChannelIds",
        async () => {
          // Create a message whose updated_at is in the past (before `since`)
          const targetMsg = await commsStorage.createMessage({
            channelId: memberChannelId,
            userId: MEMBER_ID,
            content: `reaction-catch-up probe ${RUN}`,
          } as any);

          // Anchor `since` AFTER the message was created so it won't match message activity
          const since = new Date().toISOString();

          // Add a reaction — this is purely in commsReactions (created_at >= since)
          // and does NOT update comms_messages.updated_at on its own.
          await commsStorage.addReaction(targetMsg.id, MEMBER_ID, "🔥");

          const r = await fetch(
            `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
          );
          assert.equal(r.status, 200, `expected 200, got ${r.status}`);
          const body: { activeChannelIds: string[]; serverTime: string } = await r.json();
          assert.ok(
            body.activeChannelIds.includes(memberChannelId),
            `memberChannelId (${memberChannelId}) must appear when only a reaction was added after since`,
          );
        },
      );

      // ── 6. serverTime field present ────────────────────────────────────────
      await step("response carries a serverTime ISO field", async () => {
        const since = new Date(Date.now() - 60_000).toISOString();
        const r = await fetch(
          `${baseUrl}/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
        );
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const body: { activeChannelIds: string[]; serverTime: string } = await r.json();
        assert.ok(typeof body.serverTime === "string", "serverTime must be a string");
        const parsed = new Date(body.serverTime);
        assert.ok(!isNaN(parsed.getTime()), "serverTime must be a valid ISO timestamp");
      });
    });
  } finally {
    await cleanup();
  }

  const label = "comms-reconnect-catchup";
  if (failures > 0) {
    console.error(`\n${label}: ${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${label}: all steps passed`);
  }

  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    await cleanup();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
