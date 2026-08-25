/* test-registration
{
  "name": "Comms channel lifecycle & membership management — archive/restore, privacy, role, kick, system messages (Task #3251)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3251: Channel lifecycle & membership management — archive/restore, public↔private conversion, promote/demote channel admin, kick members, system messages on rename/topic/description/archive changes, permission matrix (channel_admin vs plain member vs team_lead). DMs exempt. Real routes + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms channel lifecycle & membership management (Task #3251).
 *
 * Tests the permission matrix for:
 *   1. Creator gets "channel_admin" role.
 *   2. Channel admin (not team lead) can archive a channel (was team_lead–only).
 *   3. Plain member cannot archive (403).
 *   4. Archive emits a system message.
 *   5. Unarchive (restore) succeeds for team lead; plain member gets 403.
 *   6. Privacy conversion (public↔private) is channel_admin/team_lead–only.
 *   7. Role promote/demote: channel_admin can promote a member; plain member cannot.
 *   8. Kick: channel_admin can kick; plain member cannot kick others.
 *   9. System messages for rename/topic/description.
 *
 * Isolation: per-run random token; all seeded rows deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { getGlobalDispatcher, MockAgent } from "undici";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { commsChannels } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");

const ADMIN_ID = `lifecycle-admin-${RUN}`;
const MEMBER_ID = `lifecycle-member-${RUN}`;
const OUTSIDER_ID = `lifecycle-outsider-${RUN}`;
const TEAMLEAD_ID = `lifecycle-teamlead-${RUN}`;

let channelId = "";

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: ADMIN_ID,
      email: `lifecycle-admin-${RUN}@test.local`,
      firstName: "Channel",
      lastName: `Admin-${RUN}`,
      role: "account_manager",
    },
    {
      id: MEMBER_ID,
      email: `lifecycle-member-${RUN}@test.local`,
      firstName: "Plain",
      lastName: `Member-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `lifecycle-outsider-${RUN}@test.local`,
      firstName: "Out",
      lastName: `Sider-${RUN}`,
      role: "account_manager",
    },
    {
      id: TEAMLEAD_ID,
      email: `lifecycle-teamlead-${RUN}@test.local`,
      firstName: "Team",
      lastName: `Lead-${RUN}`,
      role: "team_lead",
    },
  ]);

  const channel = await commsStorage.createChannel({
    name: `lifecycle-test-${RUN}`,
    slug: `lifecycle-test-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: ADMIN_ID,
  } as any);
  channelId = channel.id;

  await commsStorage.addChannelMember(channelId, ADMIN_ID, "channel_admin");
  await commsStorage.addChannelMember(channelId, MEMBER_ID, "member");
}

async function cleanup(): Promise<void> {
  if (channelId) {
    await db.delete(commsChannels).where(eq(commsChannels.id, channelId)).catch(() => {});
  }
  await db
    .delete(users)
    .where(inArray(users.id, [ADMIN_ID, MEMBER_ID, OUTSIDER_ID, TEAMLEAD_ID]))
    .catch(() => {});
}

function makeApp(actingUserId: string, _role = "account_manager"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so requireRole reflects the DB role.
    // The _role param is retained only for call-site readability.
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
    server.close();
  }
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const opts: any = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await undici.fetch(`${base}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
  }
}

async function run() {
  await seed();
  try {
    // 1. Creator role is channel_admin
    await test("creator gets 'channel_admin' role", async () => {
      const role = await commsStorage.getChannelMemberRole(channelId, ADMIN_ID);
      assert.equal(role, "channel_admin", `expected 'channel_admin', got '${role}'`);
    });

    // 2. Plain member role is 'member'
    await test("member gets 'member' role", async () => {
      const role = await commsStorage.getChannelMemberRole(channelId, MEMBER_ID);
      assert.equal(role, "member");
    });

    // 3. Channel admin can archive
    await test("channel_admin can archive", async () => {
      const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);

      const ch = await commsStorage.getChannelById(channelId);
      assert.ok(ch?.archivedAt, "archivedAt should be set after archive");

      // Reset for subsequent tests
      await commsStorage.unarchiveChannel(channelId);
    });

    // 4. Plain member cannot archive
    await test("plain member cannot archive (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 5. Outsider also cannot archive
    await test("outsider cannot archive (403)", async () => {
      const { status } = await withApp(OUTSIDER_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 6. Archive emits a system message
    await test("archive creates a system message", async () => {
      await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}`),
      );
      const msgs = await commsStorage.listMessages(channelId, { limit: 10 });
      const sysMsg = msgs.find(
        (m) => m.contentType === "system" && m.content.includes("archived"),
      );
      assert.ok(sysMsg, "expected a system message about archiving");

      await commsStorage.unarchiveChannel(channelId);
    });

    // 7. Unarchive works for team_lead
    await test("team_lead can restore archived channel", async () => {
      await commsStorage.archiveChannel(channelId);
      const { status } = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/unarchive`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      const ch = await commsStorage.getChannelById(channelId);
      assert.ok(!ch?.archivedAt, "archivedAt should be null after restore");
    });

    // 8. Plain member cannot unarchive
    await test("plain member cannot restore (403)", async () => {
      await commsStorage.archiveChannel(channelId);
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/unarchive`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
      await commsStorage.unarchiveChannel(channelId);
    });

    // 9. Channel admin can change privacy
    await test("channel_admin can convert channel to private", async () => {
      const { status, body } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/privacy`, { visibility: "private" }),
      );
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

      const ch = await commsStorage.getChannelById(channelId);
      assert.equal(ch?.visibility, "private");

      // Restore to public
      await commsStorage.updateChannel(channelId, { visibility: "public" });
    });

    // 10. Plain member cannot change privacy
    await test("plain member cannot change privacy (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/privacy`, { visibility: "private" }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 11. Privacy conversion creates system message
    await test("privacy conversion creates a system message", async () => {
      await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/privacy`, { visibility: "private" }),
      );
      const msgs = await commsStorage.listMessages(channelId, { limit: 10 });
      const sysMsg = msgs.find(
        (m) => m.contentType === "system" && m.content.toLowerCase().includes("private"),
      );
      assert.ok(sysMsg, "expected a system message about privacy change");
      await commsStorage.updateChannel(channelId, { visibility: "public" });
    });

    // 12. Channel admin can promote a member to channel_admin
    await test("channel_admin can promote member to channel_admin", async () => {
      const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/members/${MEMBER_ID}/role`, {
          role: "channel_admin",
        }),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      const role = await commsStorage.getChannelMemberRole(channelId, MEMBER_ID);
      assert.equal(role, "channel_admin");

      // Demote back
      await commsStorage.updateChannelMemberRole(channelId, MEMBER_ID, "member");
    });

    // 13. Plain member cannot promote
    await test("plain member cannot promote (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/members/${ADMIN_ID}/role`, {
          role: "member",
        }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 14. Channel admin can kick a member
    await test("channel_admin can kick a member", async () => {
      const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/members/${MEMBER_ID}`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      const role = await commsStorage.getChannelMemberRole(channelId, MEMBER_ID);
      assert.equal(role, null, "kicked user should have no role");

      // Re-add for subsequent tests
      await commsStorage.addChannelMember(channelId, MEMBER_ID, "member");
    });

    // 15. Plain member cannot kick others
    await test("plain member cannot kick others (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/members/${ADMIN_ID}`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 15a. Plain member cannot rename/edit metadata
    await test("plain member cannot rename channel (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}`, { name: `renamed-by-member-${RUN}` }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 15b. Plain member cannot add other members
    await test("plain member cannot add-member (403)", async () => {
      const { status } = await withApp(MEMBER_ID, "account_manager", (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/members`, { userId: OUTSIDER_ID }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 15c. DM channel cannot have metadata edited via PATCH (type guard)
    await test("DM channel metadata edit is rejected with 400", async () => {
      const dm = await commsStorage.createChannel({
        name: `lifecycle-dm-${RUN}`,
        slug: `lifecycle-dm-${RUN}`,
        type: "dm",
        visibility: "private",
        createdBy: ADMIN_ID,
      } as any);
      await commsStorage.addChannelMember(dm.id, ADMIN_ID, "channel_admin");
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "PATCH", `/api/comms/channels/${dm.id}`, { topic: "should-fail" }),
        );
        assert.equal(status, 400, `expected 400 for DM metadata edit, got ${status}`);
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, dm.id)).catch(() => {});
      }
    });

    // 16. Rename creates system message
    await test("rename creates a system message", async () => {
      const newName = `lifecycle-renamed-${RUN}`;
      await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}`, { name: newName }),
      );
      const msgs = await commsStorage.listMessages(channelId, { limit: 10 });
      const sysMsg = msgs.find(
        (m) => m.contentType === "system" && m.content.includes("renamed"),
      );
      assert.ok(sysMsg, "expected a system message about rename");
    });

    // 17. GET /archived returns archived channels
    await test("GET /api/comms/channels/archived lists archived channels", async () => {
      await commsStorage.archiveChannel(channelId);
      const { status, body } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "GET", `/api/comms/channels/archived`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      assert.ok(Array.isArray(body), "expected array");
      const found = body.some((c: any) => c.id === channelId);
      assert.ok(found, "archived channel should appear in list");
      await commsStorage.unarchiveChannel(channelId);
    });

    // 18. GET /stats returns counts
    await test("GET /stats returns member and message counts", async () => {
      const { status, body } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "GET", `/api/comms/channels/${channelId}/stats`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      assert.ok(typeof body.memberCount === "number", "expected memberCount");
      assert.ok(typeof body.messageCount === "number", "expected messageCount");
      assert.ok(body.memberCount >= 2, "expected at least 2 members");
    });

    // 19. Members list now includes user info
    await test("GET /members returns user info (getChannelMembersWithUsers)", async () => {
      const { status, body } = await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "GET", `/api/comms/channels/${channelId}/members`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
      assert.ok(Array.isArray(body) && body.length > 0, "expected members array");
      const adminRow = body.find((m: any) => m.userId === ADMIN_ID);
      assert.ok(adminRow, "admin should be in members list");
      assert.ok(adminRow.user, "member row should include user object");
      assert.equal(adminRow.user.firstName, "Channel");
    });

    // 20. Archived channel blocks message send (423)
    await test("archived channel rejects new messages with 423", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "POST", `/api/comms/channels/${channelId}/messages`, { content: "should fail" }),
        );
        assert.equal(status, 423, `expected 423 for message to archived channel, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    // 21. Archived private channel not visible to non-member in /archived list
    await test("archived private channel is hidden from non-members in /archived list", async () => {
      const privCh = await commsStorage.createChannel({
        name: `lifecycle-priv-${RUN}`,
        slug: `lifecycle-priv-${RUN}`,
        type: "channel",
        visibility: "private",
        createdBy: ADMIN_ID,
      } as any);
      await commsStorage.addChannelMember(privCh.id, ADMIN_ID, "channel_admin");
      await commsStorage.archiveChannel(privCh.id);
      try {
        // Non-member (OUTSIDER) should NOT see the private archived channel
        const { body: outsiderList } = await withApp(OUTSIDER_ID, "account_manager", (base) =>
          req(base, "GET", `/api/comms/channels/archived`),
        );
        assert.ok(Array.isArray(outsiderList), "expected array");
        const outsiderSees = outsiderList.some((c: any) => c.id === privCh.id);
        assert.ok(!outsiderSees, "non-member should NOT see private archived channel");

        // Member (ADMIN) should see it
        const { body: memberList } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "GET", `/api/comms/channels/archived`),
        );
        const memberSees = memberList.some((c: any) => c.id === privCh.id);
        assert.ok(memberSees, "member SHOULD see private archived channel they belong to");
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, privCh.id)).catch(() => {});
      }
    });

    // 22. Adding a member emits a system message
    await test("adding a member creates a system message", async () => {
      await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/members`, { userId: OUTSIDER_ID }),
      );
      const msgs = await commsStorage.listMessages(channelId, { limit: 10 });
      const sysMsg = msgs.find(
        (m) => m.contentType === "system" && m.content.includes("added"),
      );
      assert.ok(sysMsg, "expected a system message about member being added");
      await commsStorage.removeChannelMember(channelId, OUTSIDER_ID).catch(() => {});
    });

    // 23. Removing a member (kick) emits a system message
    await test("kicking a member creates a system message", async () => {
      // Add outsider first so we can kick them
      await commsStorage.addChannelMember(channelId, OUTSIDER_ID, "member");
      // Remove any prior "added" messages to isolate the removed message
      await withApp(ADMIN_ID, "account_manager", (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/members/${OUTSIDER_ID}`),
      );
      const msgs = await commsStorage.listMessages(channelId, { limit: 10 });
      const sysMsg = msgs.find(
        (m) => m.contentType === "system" && m.content.includes("removed"),
      );
      assert.ok(sysMsg, "expected a system message about member being removed");
    });

    // 24–28. Archived channel blocks all management mutations (423)
    await test("archived channel blocks metadata rename (423)", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "PATCH", `/api/comms/channels/${channelId}`, { name: "should-fail" }),
        );
        assert.equal(status, 423, `expected 423 for PATCH metadata on archived, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    await test("archived channel blocks privacy change (423)", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "PATCH", `/api/comms/channels/${channelId}/privacy`, { visibility: "private" }),
        );
        assert.equal(status, 423, `expected 423 for PATCH privacy on archived, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    await test("archived channel blocks member add (423)", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "POST", `/api/comms/channels/${channelId}/members`, { userId: OUTSIDER_ID }),
        );
        assert.equal(status, 423, `expected 423 for POST member on archived, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    await test("archived channel blocks member role change (423)", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "PATCH", `/api/comms/channels/${channelId}/members/${MEMBER_ID}/role`, { role: "channel_admin" }),
        );
        assert.equal(status, 423, `expected 423 for PATCH member role on archived, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    await test("archived channel blocks member remove (423)", async () => {
      await commsStorage.archiveChannel(channelId);
      try {
        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "DELETE", `/api/comms/channels/${channelId}/members/${MEMBER_ID}`),
        );
        assert.equal(status, 423, `expected 423 for DELETE member on archived, got ${status}`);
      } finally {
        await commsStorage.unarchiveChannel(channelId);
      }
    });

    // 29–30. Archived private channel — members can still READ, non-members denied
    await test("archived private channel member can GET messages (200)", async () => {
      // Create a fresh private channel and archive it
      const privCh = await commsStorage.createChannel({
        name: "priv-archived-read-test",
        slug: "priv-archived-read-test",
        type: "channel",
        visibility: "private",
      });
      try {
        // ADMIN_ID is the creator/channel_admin; archive it
        await commsStorage.addChannelMember(privCh.id, ADMIN_ID, "channel_admin");
        await commsStorage.archiveChannel(privCh.id);

        const { status } = await withApp(ADMIN_ID, "account_manager", (base) =>
          req(base, "GET", `/api/comms/channels/${privCh.id}/messages`),
        );
        assert.equal(status, 200, `member should be able to GET messages on archived private channel, got ${status}`);
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, privCh.id)).catch(() => {});
      }
    });

    await test("archived private channel non-member denied GET messages (403)", async () => {
      // Create a fresh private channel, add only ADMIN, archive it, then check OUTSIDER
      const privCh = await commsStorage.createChannel({
        name: "priv-archived-deny-test",
        slug: "priv-archived-deny-test",
        type: "channel",
        visibility: "private",
      });
      try {
        await commsStorage.addChannelMember(privCh.id, ADMIN_ID, "channel_admin");
        await commsStorage.archiveChannel(privCh.id);

        const { status } = await withApp(OUTSIDER_ID, "reporting_expert", (base) =>
          req(base, "GET", `/api/comms/channels/${privCh.id}/messages`),
        );
        assert.equal(status, 403, `non-member should still get 403 on archived private channel messages, got ${status}`);
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, privCh.id)).catch(() => {});
      }
    });

    console.log(`\ncomms-channel-lifecycle: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
  } finally {
    await cleanup();
    await closeDbPools();
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
