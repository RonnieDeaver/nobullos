/* test-registration
{
  "name": "Client channel rename + unlink via PATCH (Task #3100)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3100: client channel rename + unlink. Locks the PATCH /api/comms/channels/:id contract: rename recomputes the slug, clientId:null unlinks without deleting history, omitted clientId leaves the binding, client-bound channels stay team-wide while linked but fall back to member-only once unlinked. Real routes + DB; run-token-suffixed rows seeded/removed in finally.",
  "tier": "small"
}
test-registration */
/**
 * Task #3100 — staff can rename or unlink auto-provisioned client channels.
 *
 * System-provisioned channels are named `client-<slug>` and carry a
 * `clientId` binding. Staff must be able to (a) rename the channel and
 * (b) detach it from the client (`clientId = null`) without deleting
 * history, via PATCH /api/comms/channels/:id.
 *
 * Contract locked in:
 *   1. A channel member can rename the channel (name + recomputed slug).
 *   2. Sending `clientId: null` unlinks the channel from its client;
 *      message history rows survive.
 *   3. A PATCH that omits clientId leaves the existing binding untouched.
 *   4. A non-member gets 403 and the channel is unchanged.
 *
 * Isolation note (.agents/memory/route-test-public-schema-collision.md):
 * this route test writes to the shared dev DB public tables — all seeded
 * ids/names carry a per-run random token and are deleted in finally.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users, clients } from "@shared/schema";
import { commsChannels, commsMessages } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");
const MEMBER_ID = `unlink-3100-member-${RUN}`;
const OUTSIDER_ID = `unlink-3100-outsider-${RUN}`;

let clientId = "";
let channelId = "";
let messageId = "";

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: MEMBER_ID,
      email: `unlink-3100-member-${RUN}@test.local`,
      firstName: "Member",
      lastName: `Staff-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `unlink-3100-outsider-${RUN}@test.local`,
      firstName: "Outsider",
      lastName: `Staff-${RUN}`,
      role: "account_manager",
    },
  ]);

  const [client] = await db
    .insert(clients)
    .values({ firmName: `Unlink Test Firm ${RUN}` })
    .returning();
  clientId = client.id;

  const channel = await commsStorage.createChannel({
    name: `client-unlink-test-${RUN}`,
    slug: `client-unlink-test-${RUN}`,
    type: "channel",
    visibility: "private",
    clientId,
    createdBy: MEMBER_ID,
  } as any);
  channelId = channel.id;
  await commsStorage.addChannelMember(channelId, MEMBER_ID, "owner");

  const msg = await commsStorage.createMessage({
    channelId,
    userId: MEMBER_ID,
    content: `history survives unlink ${RUN}`,
  } as any);
  messageId = msg.id;
}

async function cleanup(): Promise<void> {
  if (channelId) await db.delete(commsChannels).where(eq(commsChannels.id, channelId));
  if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(users).where(inArray(users.id, [MEMBER_ID, OUTSIDER_ID]));
}

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

async function main(): Promise<void> {
  console.log("Client channel rename + unlink (Task #3100)");

  await seed();
  try {
    await withApp(MEMBER_ID, async (baseUrl) => {
      await step("member renames the channel — name + slug updated, clientId untouched", async () => {
        const newName = `Acme Injury Team ${RUN}`;
        const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const body = await r.json();
        assert.equal(body.name, newName);
        assert.equal(body.slug, `acme-injury-team-${RUN}`);
        assert.equal(body.clientId, clientId, "rename alone must NOT unlink the client");
      });

      await step("clientId:null unlinks the channel; history survives", async () => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: null }),
        });
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const body = await r.json();
        assert.equal(body.clientId, null, "clientId must be null after unlink");

        const [row] = await db
          .select()
          .from(commsChannels)
          .where(eq(commsChannels.id, channelId));
        assert.equal(row.clientId, null, "persisted clientId must be null");

        const [msg] = await db
          .select()
          .from(commsMessages)
          .where(eq(commsMessages.id, messageId));
        assert.ok(msg, "message history must survive the unlink");
        assert.equal(msg.deletedAt, null, "message must not be soft-deleted");
      });

      await step("PATCH omitting clientId leaves the binding untouched (relink + rename)", async () => {
        // Re-link directly, then PATCH only the name — binding must persist.
        await db
          .update(commsChannels)
          .set({ clientId })
          .where(eq(commsChannels.id, channelId));
        const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Renamed Again ${RUN}` }),
        });
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const body = await r.json();
        assert.equal(body.clientId, clientId, "omitted clientId must not clear the binding");
      });
    });

    await withApp(OUTSIDER_ID, async (baseUrl) => {
      await step(
        "client-bound channels are team-wide: any staff member may unlink (200)",
        async () => {
          const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId: null }),
          });
          assert.equal(r.status, 200, `expected 200 (team-wide access), got ${r.status}`);
          const body = await r.json();
          assert.equal(body.clientId, null, "unlink by non-member staff must succeed");
        },
      );

      await step(
        "once unlinked, the private channel is member-only again — non-member gets 403",
        async () => {
          const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: `Hijack Attempt ${RUN}` }),
          });
          assert.equal(r.status, 403, `expected 403 after unlink, got ${r.status}`);
          const [row] = await db
            .select()
            .from(commsChannels)
            .where(eq(commsChannels.id, channelId));
          assert.notEqual(row.name, `Hijack Attempt ${RUN}`, "403 PATCH must not mutate");
        },
      );
    });
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (see route-test-undici-drain-hang memory).
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
