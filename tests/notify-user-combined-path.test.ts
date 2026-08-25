/* test-registration
{
  "name": "notifyUser combined-CTE path (Task #1721 Phase 1.1)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1721 Phase 1.1 — Regression test for the combined-CTE notifyUser
// path. Verifies:
//   - missing recipient → status: 'missing_user'
//   - happy path → status: 'inserted', row written, unreadCount accurate
//   - dedupe match → status: 'deduped', no new row, unreadCount unchanged
//   - dedupe key reuse after mark-read → fresh insert
//   - behavioural parity with the legacy 4-roundtrip path via the
//     NOTIFY_USER_OPTIMIZED_PATH_DISABLED kill switch.
// Usage: tsx tests/notify-user-combined-path.test.ts

import { sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import { notifyUser } from "../server/services/notifications/userInbox";
import {
  getUnreadCount,
  markRead,
  notifyUserCombined,
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
  console.log("Task #1721 Phase 1.1 — notifyUser combined-CTE path");

  await runInTxSandbox(async () => {
    const alice = await seedUser("a");
    const bob = await seedUser("b");

    // (1) missing user → status: 'missing_user'
    const missing = await notifyUserCombined({
      userId: `u-phantom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      category: "system",
      title: "to nobody",
    });
    check("combined.notifyUserCombined returns missing_user for unknown id",
      missing.status === "missing_user" && missing.row === null);

    // (2) happy path → status: 'inserted'
    const r1 = await notifyUserCombined({
      userId: alice,
      category: "system",
      title: "First",
    });
    check("first call returns status=inserted", r1.status === "inserted");
    check("first call returns a row", !!r1.row);
    check("first call unreadCount=1", r1.unreadCount === 1);

    // (3) Without dedupeKey, repeat insert always status=inserted
    const r2 = await notifyUserCombined({
      userId: alice,
      category: "system",
      title: "Second",
    });
    check("non-dedupe repeat is also inserted", r2.status === "inserted");
    check("unreadCount progresses to 2", r2.unreadCount === 2);

    // (4) With dedupeKey, first call inserts and second returns deduped
    const r3a = await notifyUserCombined({
      userId: alice,
      category: "comms.sms",
      title: "SMS",
      dedupeKey: "thread:xyz",
    });
    const r3b = await notifyUserCombined({
      userId: alice,
      category: "comms.sms",
      title: "SMS again",
      dedupeKey: "thread:xyz",
    });
    check("first dedupe call inserts", r3a.status === "inserted");
    check("repeat dedupe call returns deduped", r3b.status === "deduped");
    check("deduped result reuses original row id",
      r3a.row?.id === r3b.row?.id);
    check("unreadCount unchanged on dedupe",
      r3a.unreadCount === 3 && r3b.unreadCount === 3);

    // (5) After mark-read, same dedupeKey produces a fresh row (partial
    // unique index excludes read rows).
    await markRead(alice, r3a.row!.id);
    const r3c = await notifyUserCombined({
      userId: alice,
      category: "comms.sms",
      title: "SMS post-read",
      dedupeKey: "thread:xyz",
    });
    check("dedupe after mark-read returns inserted", r3c.status === "inserted");
    check("dedupe after mark-read uses a new row id",
      r3c.row?.id !== r3a.row?.id);

    // (6) unreadCount is scoped to recipient
    const bobCount = await notifyUserCombined({
      userId: bob,
      category: "system",
      title: "Bob's first",
    });
    check("bob's unreadCount starts at 1", bobCount.unreadCount === 1);
    check("alice's unreadCount unaffected by bob's insert",
      (await getUnreadCount(alice)) === 3);

    // (7) Behavioural parity between optimized and legacy paths.
    const carol = await seedUser("c");
    process.env.NOTIFY_USER_OPTIMIZED_PATH_DISABLED = "true";
    try {
      const legacyMissing = await notifyUser(
        `u-phantom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        { category: "system", title: "x" },
      );
      check("legacy path also rejects unknown recipient",
        legacyMissing === null);
      const legacy1 = await notifyUser(carol, {
        category: "system",
        title: "legacy-1",
      });
      check("legacy path returns a row", !!legacy1 && !legacy1.deduped);
      const legacy2 = await notifyUser(carol, {
        category: "comms.sms",
        title: "legacy-dedupe",
        dedupeKey: "thread:legacy",
      });
      const legacy3 = await notifyUser(carol, {
        category: "comms.sms",
        title: "legacy-dedupe-2",
        dedupeKey: "thread:legacy",
      });
      check("legacy dedupe returns same row",
        legacy2?.notification.id === legacy3?.notification.id);
      check("legacy dedupe flag set", legacy3?.deduped === true);
    } finally {
      delete process.env.NOTIFY_USER_OPTIMIZED_PATH_DISABLED;
    }

    // (8) Optimized path through notifyUser() (no kill switch) — same shape
    const dan = await seedUser("d");
    const opt = await notifyUser(dan, {
      category: "system",
      title: "opt-1",
    });
    check("optimized notifyUser returns row + not-deduped",
      !!opt && opt.deduped === false);
    const optDedupe1 = await notifyUser(dan, {
      category: "booking",
      title: "opt-book",
      dedupeKey: "booking:1",
    });
    const optDedupe2 = await notifyUser(dan, {
      category: "booking",
      title: "opt-book-2",
      dedupeKey: "booking:1",
    });
    check("optimized dedupe path reuses row",
      optDedupe1?.notification.id === optDedupe2?.notification.id);
    check("optimized dedupe flag set",
      optDedupe2?.deduped === true);

    // (9) No time window: an OLD unread row with the same dedupeKey still
    // dedupes. The dedupe used to expire after a 1h window, which is what
    // let duplicate unread notifications accrete; the partial unique index
    // has no time predicate, so an aged unread row must still suppress a
    // same-key dispatch. Backdate the seed row well past the old window.
    const erin = await seedUser("e");
    const aged0 = await notifyUserCombined({
      userId: erin,
      category: "comms.sms",
      title: "old-unread",
      dedupeKey: "thread:aged",
    });
    check("aged-dedupe seed inserts", aged0.status === "inserted");
    await getDb().execute(
      sql`UPDATE user_notifications SET created_at = now() - interval '25 hours' WHERE id = ${aged0.row!.id}`,
    );
    const aged1 = await notifyUserCombined({
      userId: erin,
      category: "comms.sms",
      title: "new-attempt",
      dedupeKey: "thread:aged",
    });
    check("dedupe still applies to a >24h-old unread row (no window)",
      aged1.status === "deduped" && aged1.row?.id === aged0.row?.id);
    check("aged-dedupe leaves unreadCount at 1", aged1.unreadCount === 1);
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
