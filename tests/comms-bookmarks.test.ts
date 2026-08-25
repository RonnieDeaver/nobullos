/* test-registration
{
  "name": "Comms channel bookmarks — CRUD permission matrix + SSE comms:bookmark broadcast on create/delete/reorder (Task #3287)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3287: channel bookmarks CRUD permission matrix + SSE broadcast. Member create/list, non-member 403, plain-member 403 on update/delete/ reorder, channel_admin update/delete/reorder, comms:bookmark SSE events (created/deleted/reordered) with member-scoped targetUserIds. Real routes + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Channel bookmarks — CRUD permission matrix + SSE broadcast (Task #3287).
 *
 * Guards the five bookmark endpoints in server/routes/comms.ts:
 *   1. Member can list + create bookmarks (201).
 *   2. Non-member gets 403 on list and create.
 *   3. Plain member cannot update / delete / reorder (403).
 *   4. channel_admin can update, delete, and reorder.
 *   5. SSE: `comms:bookmark` broadcast captured on create, delete, and
 *      reorder (via a fake local SSE subscriber; LISTEN client disabled).
 *   6. Broadcasts carry the channel-member targetUserIds allow-list.
 *
 * Isolation: per-run random token; all seeded rows deleted in finally.
 * Registered in tests/run-all.ts.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { getGlobalDispatcher } from "undici";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { commsChannels } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";
import {
  addTwilioEventSubscriber,
  __disableTwilioEventListenerForTest,
} from "../server/services/twilioEvents";

const RUN = randomBytes(4).toString("hex");

const ADMIN_ID = `bm-admin-${RUN}`;
const MEMBER_ID = `bm-member-${RUN}`;
const OUTSIDER_ID = `bm-outsider-${RUN}`;

let channelId = "";
let otherChannelId = "";

// ─── SSE capture ──────────────────────────────────────────────────────────────
// broadcastTwilioEvent delivers locally + synchronously to subscribers, so a
// fake Response with a write() recorder is enough. Disable the Postgres
// LISTEN client so the test drains naturally (non-pool resource).
__disableTwilioEventListenerForTest();

type CapturedEvent = { type: string; [k: string]: any };
const captured: CapturedEvent[] = [];

const fakeRes = {
  write(payload: string) {
    // payload: "event: <type>\ndata: <json>\n\n"
    const m = payload.match(/\ndata: (.*)\n\n$/s);
    if (m) captured.push(JSON.parse(m[1]));
    return true;
  },
} as any;

function bookmarkEvents(): CapturedEvent[] {
  return captured.filter(
    (e) => e.type === "comms:bookmark" && e.channelId === channelId,
  );
}

// ─── Seed / cleanup ───────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: ADMIN_ID,
      email: `bm-admin-${RUN}@test.local`,
      firstName: "Bm",
      lastName: `Admin-${RUN}`,
      role: "account_manager",
    },
    {
      id: MEMBER_ID,
      email: `bm-member-${RUN}@test.local`,
      firstName: "Bm",
      lastName: `Member-${RUN}`,
      role: "account_manager",
    },
    {
      id: OUTSIDER_ID,
      email: `bm-outsider-${RUN}@test.local`,
      firstName: "Bm",
      lastName: `Outsider-${RUN}`,
      role: "account_manager",
    },
  ]);

  const channel = await commsStorage.createChannel({
    name: `bm-test-${RUN}`,
    slug: `bm-test-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: ADMIN_ID,
  } as any);
  channelId = channel.id;

  await commsStorage.addChannelMember(channelId, ADMIN_ID, "channel_admin");
  await commsStorage.addChannelMember(channelId, MEMBER_ID, "member");

  // Second channel, owned by OUTSIDER — victim channel for the cross-wire test.
  const other = await commsStorage.createChannel({
    name: `bm-other-${RUN}`,
    slug: `bm-other-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: OUTSIDER_ID,
  } as any);
  otherChannelId = other.id;
  await commsStorage.addChannelMember(otherChannelId, OUTSIDER_ID, "channel_admin");
}

async function cleanup(): Promise<void> {
  const chanIds = [channelId, otherChannelId].filter(Boolean);
  if (chanIds.length) {
    await db.delete(commsChannels).where(inArray(commsChannels.id, chanIds)).catch(() => {});
  }
  await db
    .delete(users)
    .where(inArray(users.id, [ADMIN_ID, MEMBER_ID, OUTSIDER_ID]))
    .catch(() => {});
}

// ─── HTTP harness ─────────────────────────────────────────────────────────────

function makeApp(actingUserId: string, _role = "account_manager"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth then loads the real users
    // row (public schema, seeded above) so role gating reflects the DB.
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
  const unsubscribe = addTwilioEventSubscriber(fakeRes, { userId: MEMBER_ID });
  try {
    let bookmarkId = "";
    let secondId = "";

    // 1. Member can create a bookmark
    await test("member can create a link bookmark (201)", async () => {
      const { status, body } = await withApp(MEMBER_ID, (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/bookmarks`, {
          type: "link",
          label: `Docs-${RUN}`,
          url: "https://example.com/docs",
        }),
      );
      assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
      assert.equal(body.label, `Docs-${RUN}`);
      assert.equal(body.channelId, channelId);
      bookmarkId = body.id;
    });

    // 2. SSE broadcast on create
    await test("SSE comms:bookmark broadcast on create (action=created)", async () => {
      const evts = bookmarkEvents();
      const created = evts.find((e) => e.action === "created");
      assert.ok(created, `expected a created event, got ${JSON.stringify(evts)}`);
      assert.equal(created!.bookmark?.id, bookmarkId);
      assert.ok(
        Array.isArray(created!.targetUserIds) &&
          created!.targetUserIds.includes(MEMBER_ID) &&
          created!.targetUserIds.includes(ADMIN_ID) &&
          !created!.targetUserIds.includes(OUTSIDER_ID),
        "targetUserIds should be the channel-member allow-list",
      );
    });

    // 3. Member can list
    await test("member can list bookmarks", async () => {
      const { status, body } = await withApp(MEMBER_ID, (base) =>
        req(base, "GET", `/api/comms/channels/${channelId}/bookmarks`),
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body) && body.some((b: any) => b.id === bookmarkId));
    });

    // 4. Non-member gets 403 on list + create
    await test("non-member gets 403 on list", async () => {
      const { status } = await withApp(OUTSIDER_ID, (base) =>
        req(base, "GET", `/api/comms/channels/${channelId}/bookmarks`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    await test("non-member gets 403 on create", async () => {
      const { status } = await withApp(OUTSIDER_ID, (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/bookmarks`, {
          type: "link",
          label: "nope",
          url: "https://example.com",
        }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 5. Plain member cannot update / delete / reorder
    await test("plain member cannot update (403)", async () => {
      const { status } = await withApp(MEMBER_ID, (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/bookmarks/${bookmarkId}`, {
          label: "hax",
        }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    await test("plain member cannot delete (403)", async () => {
      const { status } = await withApp(MEMBER_ID, (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/bookmarks/${bookmarkId}`),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    await test("plain member cannot reorder (403)", async () => {
      const { status } = await withApp(MEMBER_ID, (base) =>
        req(base, "PUT", `/api/comms/channels/${channelId}/bookmarks/reorder`, {
          ids: [bookmarkId],
        }),
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    });

    // 6. channel_admin can update
    await test("channel_admin can update label + url", async () => {
      const { status, body } = await withApp(ADMIN_ID, (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/bookmarks/${bookmarkId}`, {
          label: `Docs-v2-${RUN}`,
          url: "https://example.com/v2",
        }),
      );
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.equal(body.label, `Docs-v2-${RUN}`);
      assert.equal(body.url, "https://example.com/v2");
    });

    // 7. channel_admin can reorder (create a second bookmark first)
    await test("channel_admin can reorder; SSE reordered event carries new order", async () => {
      const created = await withApp(ADMIN_ID, (base) =>
        req(base, "POST", `/api/comms/channels/${channelId}/bookmarks`, {
          type: "link",
          label: `Second-${RUN}`,
          url: "https://example.com/second",
        }),
      );
      assert.equal(created.status, 201);
      secondId = created.body.id;

      const before = captured.length;
      const { status, body } = await withApp(ADMIN_ID, (base) =>
        req(base, "PUT", `/api/comms/channels/${channelId}/bookmarks/reorder`, {
          ids: [secondId, bookmarkId],
        }),
      );
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.deepEqual(
        body.map((b: any) => b.id),
        [secondId, bookmarkId],
        "response should reflect the new order",
      );

      const evt = captured
        .slice(before)
        .find((e) => e.type === "comms:bookmark" && e.action === "reordered");
      assert.ok(evt, "expected a reordered SSE event");
      assert.deepEqual(
        evt!.bookmarks.map((b: any) => b.id),
        [secondId, bookmarkId],
      );
    });

    // 7b. reorder cap matches the create cap (25)
    await test("reorder rejects payloads over the shared 25-bookmark cap (400)", async () => {
      const tooMany = Array.from({ length: 26 }, (_, i) => `id-${i}-${RUN}`);
      const over = await withApp(ADMIN_ID, (base) =>
        req(base, "PUT", `/api/comms/channels/${channelId}/bookmarks/reorder`, {
          ids: tooMany,
        }),
      );
      assert.equal(over.status, 400, `expected 400, got ${over.status}: ${JSON.stringify(over.body)}`);
    });

    // 7c. Cross-channel reorder: foreign ids must be ignored, victim untouched
    await test("reorder with another channel's bookmark ids leaves that channel untouched", async () => {
      // Seed two bookmarks in the victim channel (owned by OUTSIDER).
      const victimIds: string[] = [];
      for (const label of [`Victim-A-${RUN}`, `Victim-B-${RUN}`]) {
        const { status, body } = await withApp(OUTSIDER_ID, (base) =>
          req(base, "POST", `/api/comms/channels/${otherChannelId}/bookmarks`, {
            type: "link",
            label,
            url: "https://example.com/victim",
          }),
        );
        assert.equal(status, 201, `victim seed expected 201, got ${status}`);
        victimIds.push(body.id);
      }

      const before = await commsStorage.listBookmarksForChannel(otherChannelId);
      const beforeSnapshot = before.map((b) => ({
        id: b.id,
        sortOrder: (b as any).sortOrder,
        updatedAt: String((b as any).updatedAt),
      }));

      // ADMIN (channel_admin of channelId only) sends a malicious ids list
      // mixing the victim channel's bookmark ids into their own reorder.
      const { status, body } = await withApp(ADMIN_ID, (base) =>
        req(base, "PUT", `/api/comms/channels/${channelId}/bookmarks/reorder`, {
          ids: [victimIds[1], victimIds[0], bookmarkId, secondId],
        }),
      );
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

      // Response contains only the attacker's own channel's bookmarks.
      const returnedIds = body.map((b: any) => b.id);
      assert.ok(
        !returnedIds.includes(victimIds[0]) && !returnedIds.includes(victimIds[1]),
        "response must never include foreign bookmarks",
      );
      assert.deepEqual(
        [...returnedIds].sort(),
        [bookmarkId, secondId].sort(),
        "own channel must contain exactly its own bookmarks",
      );

      // Own-channel ordering reflects positional indices of the mixed list:
      // foreign ids consumed positions 0-1, so own bookmarks got 2 and 3 —
      // relative order (bookmarkId before secondId) must hold.
      assert.deepEqual(
        returnedIds,
        [bookmarkId, secondId],
        "own bookmarks should be ordered by their position in the ids list",
      );

      // Victim channel is byte-for-byte untouched (ids, sortOrder, updatedAt).
      const after = await commsStorage.listBookmarksForChannel(otherChannelId);
      const afterSnapshot = after.map((b) => ({
        id: b.id,
        sortOrder: (b as any).sortOrder,
        updatedAt: String((b as any).updatedAt),
      }));
      assert.deepEqual(
        afterSnapshot,
        beforeSnapshot,
        "victim channel bookmarks must be completely untouched",
      );
    });

    // 8. channel_admin can delete; SSE deleted event
    await test("channel_admin can delete; SSE deleted event carries bookmarkId", async () => {
      const before = captured.length;
      const { status } = await withApp(ADMIN_ID, (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/bookmarks/${secondId}`),
      );
      assert.equal(status, 200, `expected 200, got ${status}`);

      const evt = captured
        .slice(before)
        .find((e) => e.type === "comms:bookmark" && e.action === "deleted");
      assert.ok(evt, "expected a deleted SSE event");
      assert.equal(evt!.bookmarkId, secondId);

      const list = await commsStorage.listBookmarksForChannel(channelId);
      assert.ok(!list.some((b) => b.id === secondId), "bookmark should be gone");
    });

    // 9. Cross-channel 404: bId under wrong channel id
    await test("update with mismatched channel id returns 404", async () => {
      const { status } = await withApp(ADMIN_ID, (base) =>
        req(
          base,
          "PATCH",
          `/api/comms/channels/00000000-0000-0000-0000-000000000000/bookmarks/${bookmarkId}`,
          { label: "x" },
        ),
      );
      assert.equal(status, 404, `expected 404, got ${status}`);
    });

    // 10. Archived channel: all bookmark writes are locked (423), reads still work
    await test("archived channel: update/delete/reorder return 423, list still 200", async () => {
      await db
        .update(commsChannels)
        .set({ archivedAt: new Date() })
        .where(eq(commsChannels.id, channelId));

      const upd = await withApp(ADMIN_ID, (base) =>
        req(base, "PATCH", `/api/comms/channels/${channelId}/bookmarks/${bookmarkId}`, {
          label: "nope",
        }),
      );
      assert.equal(upd.status, 423, `update: expected 423, got ${upd.status}`);

      const del = await withApp(ADMIN_ID, (base) =>
        req(base, "DELETE", `/api/comms/channels/${channelId}/bookmarks/${bookmarkId}`),
      );
      assert.equal(del.status, 423, `delete: expected 423, got ${del.status}`);

      const reorder = await withApp(ADMIN_ID, (base) =>
        req(base, "PUT", `/api/comms/channels/${channelId}/bookmarks/reorder`, {
          ids: [bookmarkId],
        }),
      );
      assert.equal(reorder.status, 423, `reorder: expected 423, got ${reorder.status}`);

      // Bookmark untouched
      const list = await commsStorage.listBookmarksForChannel(channelId);
      const bm = list.find((b) => b.id === bookmarkId);
      assert.ok(bm, "bookmark should still exist");
      assert.notEqual(bm!.label, "nope", "label should not have changed");

      // Read path still allowed for members of the archived channel
      const listRes = await withApp(MEMBER_ID, (base) =>
        req(base, "GET", `/api/comms/channels/${channelId}/bookmarks`),
      );
      assert.equal(listRes.status, 200, `list: expected 200, got ${listRes.status}`);
    });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    unsubscribe();
    await cleanup();
    await getGlobalDispatcher().close().catch(() => {});
    await closeDbPools();
  }
}

run().catch(async (err) => {
  console.error("Fatal:", err);
  await closeDbPools().catch(() => {});
  process.exit(1);
});
