/* test-registration
{
  "name": "Twilio thread assignment notifications (Task #1288)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1288 — assignment notifications regression.
// Verifies that `upsertThreadAssignment` enqueues per-user notifications
// only when the assignee transitions to a new (non-null) user that
// isn't the actor; re-assigning to the same user, status-only edits,
// unassigning, and self-assignment are all no-ops. Also verifies the
// listUnread / markRead helpers.
// Usage: tsx tests/twilio-thread-assignment-notifications.test.ts

import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { users, threadAssignmentNotifications } from "@shared/schema";
import * as twilioStorage from "../server/storage/twilioStorage";

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

async function unreadFor(userId: string) {
  return twilioStorage.listUnreadAssignmentNotifications(userId);
}

async function main(): Promise<void> {
  console.log("Task #1288 — thread assignment notifications");

  await runInTxSandbox(async () => {
    const actor = await seedUser("a");
    const alice = await seedUser("b");
    const bob = await seedUser("c");
    const threadKey = `phone:5551234567-${Date.now()}`;

    // (1) New assignment to a different user → 1 notification for that user.
    await twilioStorage.upsertThreadAssignment({
      threadKey,
      assignedToUserId: alice,
      updatedByUserId: actor,
    });
    let aliceUnread = await unreadFor(alice);
    check("assigning to a new user enqueues a notification for them",
      aliceUnread.length === 1 && aliceUnread[0].threadKey === threadKey);
    check("notification records the actor as assigned_by",
      aliceUnread[0]?.assignedByUserId === actor);

    // (2) Re-assigning to the same user is a no-op.
    await twilioStorage.upsertThreadAssignment({
      threadKey,
      assignedToUserId: alice,
      updatedByUserId: actor,
    });
    aliceUnread = await unreadFor(alice);
    check("re-assigning to the same user does not duplicate", aliceUnread.length === 1);

    // (3) Status-only edits never touch notifications.
    await twilioStorage.upsertThreadAssignment({
      threadKey,
      status: "needs_follow_up",
      updatedByUserId: actor,
    });
    aliceUnread = await unreadFor(alice);
    check("status-only PATCH does not enqueue", aliceUnread.length === 1);

    // (4) Reassigning to a new user pings the new user and leaves the old
    // user's unread alone (we only clear via the explicit mark-read API).
    await twilioStorage.upsertThreadAssignment({
      threadKey,
      assignedToUserId: bob,
      updatedByUserId: actor,
    });
    const bobUnread = await unreadFor(bob);
    check("reassigning to a new user enqueues for the new user", bobUnread.length === 1);
    aliceUnread = await unreadFor(alice);
    check("prior assignee's unread row is not retroactively cleared",
      aliceUnread.length === 1);

    // (5) Self-assignment never pings yourself.
    const otherKey = `phone:5559998888-${Date.now()}`;
    await twilioStorage.upsertThreadAssignment({
      threadKey: otherKey,
      assignedToUserId: actor,
      updatedByUserId: actor,
    });
    const actorUnread = await unreadFor(actor);
    check("self-assignment does not notify the actor", actorUnread.length === 0);

    // (6) Unassign (assignedToUserId: null) is a no-op.
    await twilioStorage.upsertThreadAssignment({
      threadKey,
      assignedToUserId: null,
      updatedByUserId: actor,
    });
    const bobUnreadAfter = await unreadFor(bob);
    check("unassigning does not enqueue another row for prior assignee",
      bobUnreadAfter.length === 1);

    // (7) markAssignmentNotificationsRead clears unread.
    const marked = await twilioStorage.markAssignmentNotificationsRead(alice);
    check("markRead returns the count cleared", marked === 1);
    const aliceAfter = await unreadFor(alice);
    check("after markRead, unread list is empty", aliceAfter.length === 0);

    // Sanity: the read row physically exists with read_at set.
    const persisted = await getDb()
      .select()
      .from(threadAssignmentNotifications)
      .where(eq(threadAssignmentNotifications.userId, alice));
    check("read row is preserved (not deleted) with read_at stamped",
      persisted.length === 1 && persisted[0].readAt !== null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
