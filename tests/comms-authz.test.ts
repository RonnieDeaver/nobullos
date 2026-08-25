/* test-registration
{
  "name": "Comms authorization matrix — non-member 403 on all write paths + reaction-delete authz fix (Task #3247)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3247: Comms authorization matrix — verifies that every comms write route (send, edit, delete, add-reaction, remove-reaction, mark-read) returns 403 for non-members, and confirms commsWriteLimiter is wired (rate-limit header present). Also locks in the reaction-delete authz gap fix. Real routes + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms authorization audit — matrix tests (Task #3247).
 *
 * Verifies the server-side authorization contracts for every comms write path:
 *
 *  1. Non-member cannot send a message to a private channel (403).
 *  2. Non-member cannot edit a message in a channel they don't belong to (403).
 *  3. Non-member cannot delete a message in a channel they don't belong to (403).
 *  4. Non-member cannot add a reaction to a message in a foreign channel (403).
 *  5. Non-member cannot remove a reaction from a message in a foreign channel (403)
 *     — this is the authz gap fixed in this task; the route previously skipped
 *     the isChannelMember check.
 *  6. Non-member cannot mark a message as read in a foreign channel (403).
 *  7. Rate-limit header (X-RateLimit-Limit) is present on comms write responses
 *     confirming that commsWriteLimiter is wired in.
 *  8. Non-member cannot send a typing indicator to a foreign channel (403).
 *  9. Non-member cannot pin a message in a foreign channel (403).
 * 10. Non-member cannot unpin a message in a foreign channel (403).
 * 11. Non-member cannot save a message from a foreign channel (403).
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

const MEMBER_ID = `comms-authz-mem-${RUN}`;
const OUTSIDER_ID = `comms-authz-out-${RUN}`;

let channelId = "";
let messageId = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeApp(actingUserId: string, role = "account_manager"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticates as
    // this user id; requireAuth resolves the real seeded users row (its role
    // governs gating) and populates req.user. The `role` arg is retained for
    // call-site compatibility but no longer injected — the DB row is source of
    // truth now that requireAuth ignores the legacy passport-shape.
    void role;
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp<T>(
  actingUserId: string,
  role: string,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeApp(actingUserId, role);
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
      email: `comms-authz-mem-${RUN}@test.local`,
      firstName: "Member",
      lastName: `Staff-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `comms-authz-out-${RUN}@test.local`,
      firstName: "Outsider",
      lastName: `Staff-${RUN}`,
      role: "account_manager",
    },
  ]);

  const channel = await commsStorage.createChannel({
    name: `authz-test-${RUN}`,
    slug: `authz-test-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: MEMBER_ID,
  } as any);
  channelId = channel.id;
  await commsStorage.addChannelMember(channelId, MEMBER_ID, "owner");

  const msg = await commsStorage.createMessage({
    channelId,
    userId: MEMBER_ID,
    content: `authz test seed message ${RUN}`,
  } as any);
  messageId = msg.id;

  // Seed a reaction by the member so the outsider can attempt to remove it.
  await commsStorage.addReaction(messageId, MEMBER_ID, "👍");
}

async function cleanup(): Promise<void> {
  if (channelId) await db.delete(commsChannels).where(eq(commsChannels.id, channelId));
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
  console.log("comms-authz: authorization matrix (Task #3247)");

  await seed();
  try {
    await withApp(OUTSIDER_ID, "account_manager", async (baseUrl) => {
      // ── 1. send message ────────────────────────────────────────────────────
      await step("non-member cannot send a message to a private channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "unauthorized send" }),
        });
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 2. edit message ────────────────────────────────────────────────────
      await step("non-member cannot edit a message in a foreign channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "unauthorized edit" }),
        });
        // The message owner check fires first (403 own, 403 non-member); either
        // way the outsider must be blocked.
        assert.ok(
          r.status === 403 || r.status === 404,
          `expected 403 or 404 for non-member edit, got ${r.status}`,
        );
      });

      // ── 3. delete message ──────────────────────────────────────────────────
      await step(
        "non-member account_manager cannot delete a message in a foreign channel (403)",
        async () => {
          const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}`, {
            method: "DELETE",
          });
          assert.ok(
            r.status === 403 || r.status === 404,
            `expected 403 or 404 for non-member delete, got ${r.status}`,
          );
        },
      );

      // ── 4. add reaction ────────────────────────────────────────────────────
      await step("non-member cannot add a reaction in a foreign channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji: "❤️" }),
        });
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 5. remove reaction — authz gap fixed in Task #3247 ─────────────────
      await step(
        "non-member cannot remove a reaction from a foreign channel (403) — authz gap fix",
        async () => {
          const r = await fetch(
            `${baseUrl}/api/comms/messages/${messageId}/reactions/${encodeURIComponent("👍")}`,
            { method: "DELETE" },
          );
          assert.equal(r.status, 403, `expected 403 for non-member reaction removal, got ${r.status}`);
        },
      );

      // ── 6. mark read ───────────────────────────────────────────────────────
      await step("non-member cannot mark-read a foreign channel (403)", async () => {
        const r = await fetch(
          `${baseUrl}/api/comms/channels/${channelId}/read-state`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lastReadMessageId: messageId }),
          },
        );
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 8. typing indicator ────────────────────────────────────────────────
      await step("non-member cannot send a typing indicator to a foreign channel (403)", async () => {
        const r = await fetch(
          `${baseUrl}/api/comms/channels/${channelId}/typing`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isTyping: true }),
          },
        );
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 9. pin message ─────────────────────────────────────────────────────
      await step("non-member cannot pin a message in a foreign channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}/pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 10. unpin message ──────────────────────────────────────────────────
      await step("non-member cannot unpin a message in a foreign channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}/pin`, {
          method: "DELETE",
        });
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });

      // ── 11. save message ───────────────────────────────────────────────────
      await step("non-member cannot save a message from a foreign channel (403)", async () => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });
    });

    // ── 12. former-member owner edit/delete rejection ────────────────────────
    // A user who was removed from a private channel must not be able to
    // edit or delete their own historical messages in that channel.
    await step(
      "former member cannot edit their own historical message after removal (403)",
      async () => {
        await withApp(MEMBER_ID, "account_manager", async (baseUrl) => {
          // Remove the member from the channel, then attempt to edit their message
          await commsStorage.removeChannelMember(channelId, MEMBER_ID);
          try {
            const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "attempted edit after removal" }),
            });
            assert.equal(
              r.status,
              403,
              `expected 403 for ex-member owner edit, got ${r.status}`,
            );
          } finally {
            // Restore membership so subsequent steps still work
            await commsStorage.addChannelMember(channelId, MEMBER_ID, "owner");
          }
        });
      },
    );

    await step(
      "former member cannot delete their own historical message after removal (403)",
      async () => {
        await withApp(MEMBER_ID, "account_manager", async (baseUrl) => {
          await commsStorage.removeChannelMember(channelId, MEMBER_ID);
          try {
            const r = await fetch(`${baseUrl}/api/comms/messages/${messageId}`, {
              method: "DELETE",
            });
            assert.equal(
              r.status,
              403,
              `expected 403 for ex-member owner delete, got ${r.status}`,
            );
          } finally {
            await commsStorage.addChannelMember(channelId, MEMBER_ID, "owner");
          }
        });
      },
    );

    // ── 7. rate-limit header on comms write routes ─────────────────────────────
    await step(
      "commsWriteLimiter is wired: X-RateLimit-Limit header present on send-message route",
      async () => {
        // Use the member who IS in the channel to confirm the header is present
        // (a 403 short-circuits before the rate-limiter header is set).
        await withApp(MEMBER_ID, "account_manager", async (baseUrl) => {
          const r = await fetch(`${baseUrl}/api/comms/channels/${channelId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `rate-limit-header-probe ${RUN}` }),
          });
          // Should succeed (201) and carry the standard express-rate-limit header.
          assert.ok(
            r.status === 200 || r.status === 201,
            `expected 2xx for member send, got ${r.status}`,
          );
          const limitHeader = r.headers.get("X-RateLimit-Limit") ?? r.headers.get("ratelimit-limit");
          assert.ok(
            limitHeader !== null,
            "X-RateLimit-Limit header must be present when commsWriteLimiter is applied",
          );
        });
      },
    );
  } finally {
    await cleanup();
  }

  const label = "comms-authz";
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
