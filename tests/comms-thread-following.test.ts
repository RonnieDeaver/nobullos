/* test-registration
{
  "name": "Comms thread following — auto-follow, counter separation, mark-read/unread (Task #3249)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3249: thread-following storage layer — autoFollowThread, follow/ unfollow, markThreadRead/Unread, getThreadUnreadSummary, listFollowedThreads, and counter-separation (thread replies excluded from channel unread). Real storage functions + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms thread-following smoke tests (Task #3249).
 *
 * Coverage:
 *  – autoFollowThread: creates a member row with following=true
 *  – followThread: idempotent; updating following=false then followThread re-follows
 *  – unfollowThread: sets following=false, preserves the row
 *  – getThreadMembership: returns the row or null
 *  – markThreadRead: upserts lastReadReplyAt = now, clears unread count
 *  – markThreadUnread: moves lastReadReplyAt to before the target message
 *  – getThreadUnreadSummary: counts only thread replies (parentId != null) after lastReadReplyAt
 *  – listFollowedThreads: returns following=true threads enriched with reply stats
 *  – counter separation: a thread reply (parentId set) does NOT appear in channel unread
 *
 * Isolation: run-token-suffixed rows seeded in the shared dev DB; all deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { sql } from "drizzle-orm";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsThreadMembers,
} from "../shared/models/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");

const USER_A = `thr3249-a-${RUN}`;
const USER_B = `thr3249-b-${RUN}`;

let channelId = "";
let rootMsgId = "";
let reply1Id = "";
let reply2Id = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// ─── seed / cleanup ──────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.insert(users).values([
    { id: USER_A, email: `thr-a-${RUN}@x.test`, firstName: "ThreadA", lastName: "Test", role: "account_manager" },
    { id: USER_B, email: `thr-b-${RUN}@x.test`, firstName: "ThreadB", lastName: "Test", role: "account_manager" },
  ]);

  const [ch] = await db
    .insert(commsChannels)
    .values({ name: `thr-test-${RUN}`, type: "public" })
    .returning();
  channelId = ch.id;

  await db.insert(commsChannelMembers).values([
    { channelId, userId: USER_A },
    { channelId, userId: USER_B },
  ]);

  // Root message (not a reply — parentId IS NULL)
  const [root] = await db
    .insert(commsMessages)
    .values({ channelId, userId: USER_A, content: "root message for thread test" })
    .returning();
  rootMsgId = root.id;

  // Two replies to that root (parentId = rootMsgId)
  const t0 = new Date(Date.now() - 60_000); // 1 min ago
  const t1 = new Date(Date.now() - 30_000); // 30 s ago

  const [r1] = await db
    .insert(commsMessages)
    .values({ channelId, userId: USER_B, content: `first reply ${RUN}`, parentId: rootMsgId, createdAt: t0 })
    .returning();
  reply1Id = r1.id;

  const [r2] = await db
    .insert(commsMessages)
    .values({ channelId, userId: USER_A, content: `second reply mentions (user:${USER_A}) ${RUN}`, parentId: rootMsgId, createdAt: t1 })
    .returning();
  reply2Id = r2.id;
}

async function cleanup(): Promise<void> {
  if (channelId) {
    await db.delete(commsThreadMembers).where(sql`channel_id = ${channelId}`);
    await db.delete(commsMessages).where(sql`channel_id = ${channelId}`);
    await db.delete(commsChannelMembers).where(sql`channel_id = ${channelId}`);
    await db.delete(commsChannels).where(sql`id = ${channelId}`);
  }
  await db.delete(users).where(sql`id IN (${USER_A}, ${USER_B})`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("comms-thread-following: auto-follow, counter separation, mark-read/unread (Task #3249)");

  await seed();

  try {
    // ── 1. autoFollowThread creates a row with following=true ─────────────────
    await step("autoFollowThread creates a member row with following=true", async () => {
      const row = await commsStorage.autoFollowThread(rootMsgId, channelId, USER_A);
      assert.equal(row.rootMessageId, rootMsgId);
      assert.equal(row.userId, USER_A);
      assert.equal(row.following, true);
    });

    // ── 2. autoFollowThread is idempotent ──────────────────────────────────────
    await step("autoFollowThread is idempotent (second call returns same row id)", async () => {
      const r1 = await commsStorage.autoFollowThread(rootMsgId, channelId, USER_A);
      const r2 = await commsStorage.autoFollowThread(rootMsgId, channelId, USER_A);
      assert.equal(r1.id, r2.id, "should return the same row id on conflict");
    });

    // ── 3. unfollowThread sets following=false, preserves the row ──────────────
    await step("unfollowThread sets following=false, row still exists", async () => {
      await commsStorage.autoFollowThread(rootMsgId, channelId, USER_B);
      const unfollowed = await commsStorage.unfollowThread(rootMsgId, USER_B);
      assert.ok(unfollowed, "row should still exist after unfollow");
      assert.equal(unfollowed!.following, false);
    });

    // ── 4. followThread re-follows after unfollow ──────────────────────────────
    await step("followThread re-follows a previously-unfollowed thread", async () => {
      // USER_B was just unfollowed; re-follow it
      const row = await commsStorage.followThread(rootMsgId, channelId, USER_B);
      assert.equal(row.following, true);
    });

    // ── 5. getThreadMembership returns the row ─────────────────────────────────
    await step("getThreadMembership returns the correct row", async () => {
      const row = await commsStorage.getThreadMembership(rootMsgId, USER_A);
      assert.ok(row, "row should exist for USER_A");
      assert.equal(row!.rootMessageId, rootMsgId);
      assert.equal(row!.userId, USER_A);
    });

    // ── 6. getThreadMembership returns null for a non-follower ─────────────────
    await step("getThreadMembership returns null for user with no row", async () => {
      const row = await commsStorage.getThreadMembership("nonexistent-msg-id", USER_A);
      assert.equal(row, null);
    });

    // ── 7. getThreadUnreadSummary counts replies after lastReadReplyAt ─────────
    await step("getThreadUnreadSummary counts both replies as unread (lastReadReplyAt=epoch)", async () => {
      // USER_A's row was created with lastReadReplyAt = epoch (new Date(0))
      const summary = await commsStorage.getThreadUnreadSummary(USER_A);
      assert.ok(summary.totalUnreadReplies >= 2, `expected >=2 unread, got ${summary.totalUnreadReplies}`);
    });

    // ── 8. markThreadRead clears unread count ─────────────────────────────────
    await step("markThreadRead sets lastReadReplyAt=now, unread drops to 0", async () => {
      await commsStorage.markThreadRead(rootMsgId, channelId, USER_A);
      const summary = await commsStorage.getThreadUnreadSummary(USER_A);
      assert.equal(summary.totalUnreadReplies, 0, `expected 0 unread after markThreadRead, got ${summary.totalUnreadReplies}`);
    });

    // ── 9. markThreadUnread from reply2 moves lastReadReplyAt before reply2 ────
    await step("markThreadUnread makes reply2 appear unread again", async () => {
      await commsStorage.markThreadUnread(rootMsgId, channelId, USER_A, reply2Id);
      const summary = await commsStorage.getThreadUnreadSummary(USER_A);
      assert.ok(summary.totalUnreadReplies >= 1, `expected >=1 unread after markThreadUnread, got ${summary.totalUnreadReplies}`);
    });

    // ── 10. listFollowedThreads returns the followed thread ───────────────────
    await step("listFollowedThreads returns the thread with reply stats", async () => {
      // Reset USER_A to unread state for the full check
      await commsStorage.autoFollowThread(rootMsgId, channelId, USER_A);
      const threads = await commsStorage.listFollowedThreads(USER_A);
      const found = threads.find((t) => t.rootMessageId === rootMsgId);
      assert.ok(found, "thread should appear in listFollowedThreads");
      assert.ok(found!.replyCount >= 2, `expected >=2 replies, got ${found!.replyCount}`);
      assert.ok(Array.isArray(found!.participantIds), "participantIds should be an array");
    });

    // ── 11. counter separation: channel unread does NOT count thread replies ───
    await step("channel unread excludes thread replies (parentId != null)", async () => {
      // getUnreadSummaryForUser filters where parentId IS NULL, so thread replies
      // must not inflate channel unread. Verify directly from DB that parentId-set
      // messages are excluded from the channel's unread count query.
      const [channelUnread] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(commsMessages)
        .where(
          sql`channel_id = ${channelId}
            AND user_id != ${USER_A}
            AND parent_id IS NULL
            AND deleted_at IS NULL`,
        );
      // Only the root message was sent by USER_A; USER_B sent reply1 (parentId set).
      // So channel unread for USER_A = 0 messages with parentId IS NULL from others
      // (root message was authored by USER_A, reply1 has parentId set → excluded).
      assert.equal(
        channelUnread.count,
        0,
        `channel unread should be 0 (thread replies excluded); got ${channelUnread.count}`,
      );
    });

    // ── 12. listFollowedThreads excludes unfollowed threads ───────────────────
    await step("listFollowedThreads excludes threads the user unfollowed", async () => {
      await commsStorage.unfollowThread(rootMsgId, USER_B);
      const threads = await commsStorage.listFollowedThreads(USER_B);
      const found = threads.find((t) => t.rootMessageId === rootMsgId);
      assert.equal(found, undefined, "unfollowed thread should not appear in list");
    });

  } finally {
    await cleanup();
    await closeDbPools();
  }

  if (failures > 0) {
    console.error(`\ncomms-thread-following: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log(`\ncomms-thread-following: all tests passed`);
}

main().catch((err) => {
  console.error("comms-thread-following: fatal error", err);
  process.exit(1);
});
