/* test-registration
{
  "name": "User notification inbox (Task #1686)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1686 — Per-user in-app notification inbox regression.
// Verifies notifyUser() insert + dedupe behaviour, list/unreadCount,
// markRead/markAllRead, and archive owner-scoping.
// Usage: tsx tests/user-notifications-inbox.test.ts

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { clients, users } from "@shared/schema";
import { notifyUser } from "../server/services/notifications/userInbox";
import {
  archiveNotification,
  countUserNotifications,
  getUnreadCount,
  listUserNotifications,
  markAllRead,
  markRead,
  markUnread,
  userExists,
} from "../server/storage/userNotificationsStorage";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(suffix: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(users).values({ id, email: `${id}@test.local` });
  return id;
}

async function main(): Promise<void> {
  console.log("Task #1686 — user notification inbox");

  await runInTxSandbox(async () => {
    const alice = await seedUser("a");
    const bob = await seedUser("b");

    // (1) notifyUser inserts a row and the unread count reflects it.
    const r1 = await notifyUser(alice, {
      category: "system",
      title: "Hello Alice",
      body: "first one",
      deepLink: "/notifications",
    });
    check("notifyUser returns a row", !!r1 && !r1!.deduped);
    check("unread count is 1 after first insert", (await getUnreadCount(alice)) === 1);
    check("other user's unread count is 0", (await getUnreadCount(bob)) === 0);

    // (2) Without dedupeKey, repeated calls insert separate rows.
    await notifyUser(alice, { category: "system", title: "again" });
    check("second insert without dedupeKey adds another row",
      (await getUnreadCount(alice)) === 2);

    // (3) dedupeKey causes a second insert to return the existing unread
    // row rather than creating a new one (no time window — dedupe holds
    // for as long as the original stays unread/unarchived).
    const r3a = await notifyUser(alice, {
      category: "comms.sms",
      title: "SMS",
      dedupeKey: "thread:abc",
    });
    const r3b = await notifyUser(alice, {
      category: "comms.sms",
      title: "SMS again",
      dedupeKey: "thread:abc",
    });
    check("dedupe match returns existing row id",
      r3a?.notification.id === r3b?.notification.id);
    check("dedupe second call is flagged deduped=true",
      r3b?.deduped === true);
    check("unread count only bumped by 1 across the deduped pair",
      (await getUnreadCount(alice)) === 3);

    // (4) listUserNotifications returns most-recent-first and respects
    // the unreadOnly + category filters.
    const all = await listUserNotifications(alice);
    check("list returns all non-archived rows", all.length === 3);
    check("list is sorted desc by createdAt",
      all[0].createdAt >= all[all.length - 1].createdAt);
    const onlySms = await listUserNotifications(alice, { category: "comms.sms" });
    check("category filter narrows results", onlySms.length === 1);

    // (4b) Task #4472 — client-name enrichment: rows whose metadata carries
    // a clientId get a display-ready clientName from the read-time join;
    // rows without one (or with a dangling id) get null.
    const [clientRow] = await getDb()
      .insert(clients)
      .values({ firmName: `Harper & Lane ${Date.now()}-${Math.floor(Math.random() * 1e6)}` })
      .returning({ id: clients.id, firmName: clients.firmName });
    await notifyUser(alice, {
      category: "comms.sms",
      title: "Client-scoped SMS",
      metadata: { clientId: clientRow.id },
    });
    await notifyUser(alice, {
      category: "comms.sms",
      title: "Dangling client SMS",
      metadata: { clientId: "00000000-0000-0000-0000-000000000000" },
    });
    const withClient = await listUserNotifications(alice, { category: "comms.sms" });
    const scoped = withClient.find((n) => n.title === "Client-scoped SMS");
    const dangling = withClient.find((n) => n.title === "Dangling client SMS");
    const plain = withClient.find((n) => n.title === "SMS");
    check("clientId metadata resolves to clientName", scoped?.clientName === clientRow.firmName);
    check("dangling clientId yields null clientName", !!dangling && dangling.clientName === null);
    check("no-clientId row has null clientName", !!plain && plain.clientName === null);
    check("enriched list count includes new rows", withClient.length === 3);
    const cleanupIds = [scoped?.id, dangling?.id].filter((v): v is string => !!v);
    for (const id of cleanupIds) await archiveNotification(alice, id);
    check("post-enrichment unread count restored",
      (await getUnreadCount(alice)) === 3);

    // (5) Owner scoping — Bob cannot mark Alice's notification read.
    const targetId = all[0].id;
    const badMark = await markRead(bob, targetId);
    check("markRead by wrong user is a no-op", badMark === undefined);
    check("alice's unread count unchanged after wrong-user markRead",
      (await getUnreadCount(alice)) === 3);

    // (6) markRead by the right owner clears that row from unread.
    const okMark = await markRead(alice, targetId);
    check("markRead by owner returns the updated row",
      !!okMark && okMark!.readAt !== null);
    check("unread count decrements",
      (await getUnreadCount(alice)) === 2);

    // (7) After markRead, the same dedupeKey may produce a fresh row
    // (the partial unique index excludes read/archived rows).
    const r7 = await notifyUser(alice, {
      category: "comms.sms",
      title: "SMS post-read",
      dedupeKey: "thread:abc",
    });
    const dedupedRowWasRead = okMark?.id === r3a?.notification.id;
    if (dedupedRowWasRead) {
      check("dedupe post-read inserts a fresh row", r7?.deduped === false);
    } else {
      // The "all[0]" we marked read might have been the title="again"
      // row rather than the SMS-deduped one; in that case the deduped
      // unread row still exists and the call returns it.
      check("dedupe post-read returns the still-unread row",
        r7?.deduped === true);
    }

    // (8) markAllRead clears everything outstanding.
    const updated = await markAllRead(alice);
    check("markAllRead reports the number cleared", updated > 0);
    check("unread count is zero after markAllRead",
      (await getUnreadCount(alice)) === 0);

    // (9) Archive — sets archivedAt and removes from default list.
    const archived = await archiveNotification(alice, targetId);
    check("archive sets archivedAt", !!archived?.archivedAt);
    const defaultList = await listUserNotifications(alice);
    check("default list excludes archived rows",
      defaultList.every((n) => !n.archivedAt));
    const withArchived = await listUserNotifications(alice, { includeArchived: true });
    check("includeArchived=true brings them back",
      withArchived.some((n) => n.id === targetId && n.archivedAt));

    // (10) Bob cannot archive Alice's row.
    const aliceUnarchived = (await listUserNotifications(alice)).find((n) => !n.archivedAt);
    if (aliceUnarchived) {
      const wrongArchive = await archiveNotification(bob, aliceUnarchived.id);
      check("archive by wrong user is a no-op", wrongArchive === undefined);
    } else {
      check("archive owner-scoping covered (no unarchived row left)", true);
    }

    // (11) markUnread — owner-scoped, only flips read rows back to unread.
    const carol = await seedUser("c");
    const c1 = await notifyUser(carol, { category: "system", title: "to flip" });
    check("seed notification for markUnread test", !!c1);
    const readRow = await markRead(carol, c1!.notification.id);
    check("seed markRead sets readAt", !!readRow?.readAt);
    check("unread count is 0 after seed mark-read", (await getUnreadCount(carol)) === 0);
    const wrongUnread = await markUnread(bob, c1!.notification.id);
    check("markUnread by wrong user is a no-op", wrongUnread === undefined);
    const flipped = await markUnread(carol, c1!.notification.id);
    check("markUnread by owner clears readAt", !!flipped && flipped!.readAt === null);
    check("unread count is 1 after markUnread", (await getUnreadCount(carol)) === 1);
    // Archived rows must not flip back to unread — partial index assumes
    // unread excludes archived, and the UI hides the action for archived
    // rows. Verify the storage layer also enforces this.
    await markRead(carol, c1!.notification.id);
    await archiveNotification(carol, c1!.notification.id);
    const noFlipArchived = await markUnread(carol, c1!.notification.id);
    check("markUnread on archived row is a no-op", noFlipArchived === undefined);

    // (12) notifyUser rejects unknown categories (Phase 2/3 contract).
    const badCat = await notifyUser(carol, {
      category: "totally.bogus.category" as any,
      title: "should not insert",
    });
    check("notifyUser returns null on unknown category", badCat === null);

    // (13) notifyUser rejects unknown recipient ids (prevents FK fail
    // for misrouted webhook handlers).
    const phantom = `u-phantom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    check("userExists() returns false for unseeded id",
      (await userExists(phantom)) === false);
    const badRecipient = await notifyUser(phantom, {
      category: "system",
      title: "to nobody",
    });
    check("notifyUser returns null for unknown recipient", badRecipient === null);

    // (14) Pagination — countUserNotifications + offset/limit slice
    // the dataset consistently for the inbox page.
    const dave = await seedUser("d");
    for (let i = 0; i < 5; i++) {
      await notifyUser(dave, { category: "system", title: `n${i}` });
    }
    const totalDave = await countUserNotifications(dave);
    check("countUserNotifications matches inserted total", totalDave === 5);
    const page1 = await listUserNotifications(dave, { limit: 2, offset: 0 });
    const page2 = await listUserNotifications(dave, { limit: 2, offset: 2 });
    const page3 = await listUserNotifications(dave, { limit: 2, offset: 4 });
    check("page 1 has limit rows", page1.length === 2);
    check("page 2 has limit rows", page2.length === 2);
    check("page 3 has remaining tail", page3.length === 1);
    const pagedIds = new Set([
      ...page1.map((r) => r.id),
      ...page2.map((r) => r.id),
      ...page3.map((r) => r.id),
    ]);
    check("paginated pages are disjoint and cover the full set",
      pagedIds.size === 5);

    // (15) archivedOnly filter excludes non-archived rows.
    await archiveNotification(dave, page1[0].id);
    const archivedSlice = await listUserNotifications(dave, { archivedOnly: true });
    check("archivedOnly returns only archived rows",
      archivedSlice.length === 1 && !!archivedSlice[0].archivedAt);
    const archivedCount = await countUserNotifications(dave, { archivedOnly: true });
    check("countUserNotifications honours archivedOnly", archivedCount === 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
