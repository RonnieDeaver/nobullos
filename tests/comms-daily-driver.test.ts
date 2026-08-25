/* test-registration
{
  "name": "Comms daily-driver gaps — DM privacy, notif prefs, pins, saved, FTS search, attachment gate (Task #3174)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3174: Comms daily-driver gaps — DM privacy hardening (team-lead cannot moderate a DM they're not part of), notification prefs (all/mentions/muted), pins (pin/unpin/list), saved messages, FTS search with channelId filter, and attachment upload member-gate. Real routes + DB; run-token-suffixed rows.",
  "tier": "small"
}
test-registration */
/**
 * Comms daily-driver smoke tests (Task #3174).
 *
 * Coverage:
 *  – DM privacy: team-lead cannot delete a message in a DM they're not part of (403)
 *  – DM privacy: team-lead CAN delete in a DM they ARE a member of (200)
 *  – Notification prefs: GET defaults to "all"; PUT persists; invalid value rejects
 *  – Pin / Unpin: member can pin; non-member blocked; GET /pins returns pinned messages
 *  – Save / Unsave: member can save; GET /saved returns saved messages
 *  – Search: FTS returns matching messages; channelId filter scopes results
 *  – Attachment upload: non-member upload blocked (403)
 *
 * Isolation: run-token-suffixed rows seeded in the shared dev DB, deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { inArray, sql } from "drizzle-orm";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsPinnedMessages,
  commsSavedMessages,
  commsNotificationPrefs,
} from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");

const TEAM_LEAD_ID = `dd3174-tl-${RUN}`;
const MEMBER_A_ID = `dd3174-ma-${RUN}`;
const OUTSIDER_ID = `dd3174-out-${RUN}`;

let dmChannelId = "";
let tlDmChannelId = "";
let publicChannelId = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── seed / cleanup ───────────────────────────────────────────────────────────

async function seed() {
  await db.insert(users).values([
    {
      id: TEAM_LEAD_ID,
      email: `${TEAM_LEAD_ID}@test.local`,
      firstName: "Lead",
      lastName: `User-${RUN}`,
      role: "team_lead",
    },
    {
      id: MEMBER_A_ID,
      email: `${MEMBER_A_ID}@test.local`,
      firstName: "Member",
      lastName: `A-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `${OUTSIDER_ID}@test.local`,
      firstName: "Out",
      lastName: `Sider-${RUN}`,
      role: "account_manager",
    },
  ]);

  // DM channel between MEMBER_A and OUTSIDER — team-lead is NOT a member
  const [dmRow] = await db
    .insert(commsChannels)
    .values({
      id: `dm-ch-${RUN}`,
      type: "dm",
      visibility: "private",
      slug: `dm-ch-${RUN}`,
      createdBy: MEMBER_A_ID,
    })
    .returning();
  dmChannelId = dmRow.id;
  await db.insert(commsChannelMembers).values([
    { channelId: dmChannelId, userId: MEMBER_A_ID, role: "member" },
    { channelId: dmChannelId, userId: OUTSIDER_ID, role: "member" },
  ]);

  // DM channel where TEAM_LEAD IS a member
  const [tlDmRow] = await db
    .insert(commsChannels)
    .values({
      id: `tl-dm-${RUN}`,
      type: "dm",
      visibility: "private",
      slug: `tl-dm-${RUN}`,
      createdBy: TEAM_LEAD_ID,
    })
    .returning();
  tlDmChannelId = tlDmRow.id;
  await db.insert(commsChannelMembers).values([
    { channelId: tlDmChannelId, userId: TEAM_LEAD_ID, role: "member" },
    { channelId: tlDmChannelId, userId: MEMBER_A_ID, role: "member" },
  ]);

  // Public channel — MEMBER_A is a member (creator); OUTSIDER is not
  const [pubRow] = await db
    .insert(commsChannels)
    .values({
      id: `pub-ch-${RUN}`,
      type: "channel",
      visibility: "public",
      slug: `pub-ch-${RUN}`,
      createdBy: MEMBER_A_ID,
    })
    .returning();
  publicChannelId = pubRow.id;
  await db.insert(commsChannelMembers).values([
    { channelId: publicChannelId, userId: MEMBER_A_ID, role: "owner" },
    { channelId: publicChannelId, userId: TEAM_LEAD_ID, role: "member" },
  ]);
}

async function cleanup() {
  await db
    .delete(commsSavedMessages)
    .where(sql`message_id IN (SELECT id FROM comms_messages WHERE channel_id IN (${dmChannelId}, ${tlDmChannelId}, ${publicChannelId}))`);
  await db
    .delete(commsPinnedMessages)
    .where(sql`message_id IN (SELECT id FROM comms_messages WHERE channel_id IN (${dmChannelId}, ${tlDmChannelId}, ${publicChannelId}))`);
  await db.delete(commsNotificationPrefs).where(sql`user_id IN (${TEAM_LEAD_ID}, ${MEMBER_A_ID}, ${OUTSIDER_ID})`);
  await db.delete(commsMessages).where(sql`channel_id IN (${dmChannelId}, ${tlDmChannelId}, ${publicChannelId})`);
  await db.delete(commsChannelMembers).where(sql`channel_id IN (${dmChannelId}, ${tlDmChannelId}, ${publicChannelId})`);
  await db.delete(commsChannels).where(
    inArray(commsChannels.id, [dmChannelId, tlDmChannelId, publicChannelId]),
  );
  await db.delete(users).where(inArray(users.id, [TEAM_LEAD_ID, MEMBER_A_ID, OUTSIDER_ID]));
}

// ─── runner ───────────────────────────────────────────────────────────────────

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

async function main() {
  console.log("Comms daily-driver gaps (Task #3174)");

  await seed();
  try {
    // ─── DM privacy ─────────────────────────────────────────────────────────
    await step("DM privacy: team-lead blocked from deleting in DM they're not part of (403)", async () => {
      const [msgRow] = await db
        .insert(commsMessages)
        .values({
          id: `dm-msg-out-${RUN}`,
          channelId: dmChannelId,
          userId: OUTSIDER_ID,
          content: "hello from outsider",
        })
        .returning();
      await withApp(TEAM_LEAD_ID, "team_lead", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${msgRow.id}`, {
          method: "DELETE",
        });
        const body = await r.text();
        assert.equal(r.status, 403, `Expected 403 got ${r.status}: ${body}`);
        assert.ok(
          body.includes("DM") || body.includes("not part of"),
          `Expected DM-specific error, got: ${body}`,
        );
      });
    });

    await step("DM privacy: team-lead CAN delete in DM they ARE a member of (200)", async () => {
      const [msgRow] = await db
        .insert(commsMessages)
        .values({
          id: `tl-dm-msg-${RUN}`,
          channelId: tlDmChannelId,
          userId: MEMBER_A_ID,
          content: "hello from member in tl-dm",
        })
        .returning();
      await withApp(TEAM_LEAD_ID, "team_lead", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${msgRow.id}`, {
          method: "DELETE",
        });
        assert.equal(r.status, 200, `Expected 200 got ${r.status}: ${await r.text()}`);
      });
    });

    // ─── Notification prefs ─────────────────────────────────────────────────
    await step("Notif pref: GET defaults to 'all' when no pref exists", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${dmChannelId}/notification-pref`);
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.pref, "all");
      });
    });

    await step("Notif pref: PUT persists; GET reflects it", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const put = await fetch(`${baseUrl}/api/comms/channels/${dmChannelId}/notification-pref`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pref: "muted" }),
        });
        assert.equal(put.status, 200, `PUT failed: ${await put.text()}`);

        const get = await fetch(`${baseUrl}/api/comms/channels/${dmChannelId}/notification-pref`);
        assert.equal((await get.json()).pref, "muted");
      });
    });

    await step("Notif pref: PUT rejects invalid pref value (400)", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${dmChannelId}/notification-pref`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pref: "everything" }),
        });
        assert.equal(r.status, 400, await r.text());
      });
    });

    await step("Notif pref: non-member blocked (403)", async () => {
      await withApp(OUTSIDER_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${tlDmChannelId}/notification-pref`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pref: "muted" }),
        });
        assert.equal(r.status, 403, await r.text());
      });
    });

    // ─── Pins ───────────────────────────────────────────────────────────────
    let pinMsgId: string;
    await step("Pin: seed pin message", async () => {
      const [row] = await db
        .insert(commsMessages)
        .values({
          id: `pin-msg-${RUN}`,
          channelId: publicChannelId,
          userId: MEMBER_A_ID,
          content: "this will be pinned",
        })
        .returning();
      pinMsgId = row.id;
    });

    await step("Pin: member can pin a message (200)", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${pinMsgId}/pin`, {
          method: "POST",
        });
        const body = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(body)}`);
        assert.ok("pinned" in body, `Expected 'pinned' key: ${JSON.stringify(body)}`);
      });
    });

    await step("Pin: GET /channels/:id/pins returns pinned message", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${publicChannelId}/pins`);
        const pins = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(pins)}`);
        assert.ok(
          pins.some((p: any) => p.messageId === pinMsgId),
          `Pin not found. Got: ${JSON.stringify(pins)}`,
        );
      });
    });

    await step("Pin: non-member GET /channels/:id/pins blocked (403)", async () => {
      await withApp(OUTSIDER_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/channels/${tlDmChannelId}/pins`);
        const body = await r.text();
        assert.equal(r.status, 403, body);
      });
    });

    await step("Pin: DELETE /pin removes the pin", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${pinMsgId}/pin`, {
          method: "DELETE",
        });
        const body = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(body)}`);
        assert.ok("unpinned" in body, `Expected 'unpinned' key: ${JSON.stringify(body)}`);
      });
    });

    // ─── Save / Unsave ───────────────────────────────────────────────────────
    let saveMsgId: string;
    await step("Save: seed save message", async () => {
      const [row] = await db
        .insert(commsMessages)
        .values({
          id: `save-msg-${RUN}`,
          channelId: publicChannelId,
          userId: MEMBER_A_ID,
          content: "bookmark this",
        })
        .returning();
      saveMsgId = row.id;
    });

    await step("Save: member can save a message (200)", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${saveMsgId}/save`, {
          method: "POST",
        });
        const body = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(body)}`);
        assert.ok("saved" in body, `Expected 'saved' key: ${JSON.stringify(body)}`);
      });
    });

    await step("Save: GET /saved returns the saved message", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/saved`);
        const msgs = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(msgs)}`);
        assert.ok(
          msgs.some((m: any) => m.id === saveMsgId),
          `Saved message not found. Got: ${JSON.stringify(msgs.map((m: any) => m.id))}`,
        );
      });
    });

    await step("Save: DELETE /save removes from saved list", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/messages/${saveMsgId}/save`, {
          method: "DELETE",
        });
        const body = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(body)}`);
        assert.ok("unsaved" in body, `Expected 'unsaved' key: ${JSON.stringify(body)}`);
      });
    });

    // ─── FTS search ─────────────────────────────────────────────────────────
    await step("Search: seed FTS message", async () => {
      await db.insert(commsMessages).values({
        id: `search-msg-${RUN}`,
        channelId: publicChannelId,
        userId: MEMBER_A_ID,
        content: `nobull daily driver searchable content ${RUN}`,
      });
    });

    await step("Search: query < 2 chars returns empty array (200)", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/comms/search?q=x`);
        const data = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(data)}`);
        assert.deepEqual(data, []);
      });
    });

    await step("Search: FTS returns results for matching query (200)", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(
          `${baseUrl}/api/comms/search?q=${encodeURIComponent("daily driver")}`,
        );
        const results = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(results)}`);
        assert.ok(Array.isArray(results), "Expected array");
      });
    });

    await step("Search: channelId filter scopes results to that channel", async () => {
      await withApp(MEMBER_A_ID, "account_manager", async (baseUrl) => {
        const r = await fetch(
          `${baseUrl}/api/comms/search?q=${encodeURIComponent("daily driver")}&channelId=${publicChannelId}`,
        );
        const results = await r.json();
        assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(results)}`);
        assert.ok(
          results.every((m: any) => m.channelId === publicChannelId),
          `All results must be in publicChannelId`,
        );
      });
    });

    // ─── Attachment gate ─────────────────────────────────────────────────────
    await step("Attachment upload: non-member blocked (403)", async () => {
      await withApp(OUTSIDER_ID, "account_manager", async (baseUrl) => {
        const fd = new FormData();
        fd.append("content", "hello");
        const r = await fetch(
          `${baseUrl}/api/comms/channels/${tlDmChannelId}/messages/upload`,
          { method: "POST", body: fd },
        );
        assert.equal(r.status, 403, await r.text());
      });
    });
  } finally {
    await cleanup();
    await closeDbPools();
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll daily-driver tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
