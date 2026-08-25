/* test-registration
{
  "name": "User inbound reassignment history storage helper (Task #2023)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2023 — Storage-level regression coverage for
 * `getUserInboundReassignmentHistory` (Task #1981) in
 * `server/storage/activityStorage.ts`.
 *
 * This is the mirror of `getUserReassignmentHistory` (covered by
 * `tests/user-reassign-history-storage.test.ts`, Task #2002): it reads the
 * exact same `user_work_reassigned` activity-log rows, but keys/buckets each
 * event by the *destination* user (`metadata->>'toUserId'`) to power the
 * active-user panel's "what each user inherited" popover. Both directions
 * share `getReassignmentHistoryByDirection` + `mapReassignmentRow`; only the
 * metadata key used for filtering and bucketing differs. Task #2002 pinned the
 * outbound ("out") direction only, so a refactor of the direction switch or
 * the `toUserId` bucketing could silently empty the inbound popover with no
 * test failing. This test exercises the inbound helper directly.
 *
 * Pins:
 *   1. Keying + actor JOIN — events bucket by `metadata->>'toUserId'`, with
 *      the actor name resolved via the `users` JOIN (first + last, email
 *      fallback).
 *   2. Ordering — multiple reassignment events into one to-user come back
 *      newest-first by timestamp regardless of insertion order.
 *   3. Unpacking — nested `counts` (clients/threads/bookings) and `items`
 *      (clients/threads/bookings arrays) are read back faithfully, with
 *      `fromUserId`/`fromUserName` resolved from metadata.
 *   4. Direction switch — querying by to-user id does NOT return events whose
 *      to-user is some other user (and an out-only from-user is never a key),
 *      pinning the `metaKey`/bucket direction.
 *
 * Follows the live-DB pattern of `tests/user-reassign-history-storage.test.ts`:
 * rows are written synchronously before the helper is called, so no polling is
 * needed.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { getUserInboundReassignmentHistory } from "../server/storage/activityStorage";

const TAG = `task-2023-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

interface SeededUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

const createdUserIds: string[] = [];

async function seedUser(opts: {
  suffix: string;
  role?: string;
  firstName?: string;
  lastName?: string;
}): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = `${id}@test.example`;
  const firstName = opts.firstName ?? `${TAG}-${opts.suffix}`;
  const lastName = opts.lastName ?? "User";
  const role = opts.role ?? "account_manager";
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${firstName}, ${lastName}, ${role},
            ${role === "ceo" ? "ceo" : "core"})
  `);
  createdUserIds.push(id);
  return { id, email, firstName, lastName };
}

interface ReassignMeta {
  actorId: string | null;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  toUserName: string;
  counts: { clients: number; threads: number; bookings: number };
  items: {
    clients: { id: string; label: string }[];
    threads: { threadKey: string }[];
    bookings: { id: string; label: string; startTimeUtc: string }[];
  };
  timestamp: Date;
}

async function insertReassignEvent(opts: ReassignMeta): Promise<void> {
  const metadata = {
    fromUserId: opts.fromUserId,
    fromUserName: opts.fromUserName,
    toUserId: opts.toUserId,
    toUserName: opts.toUserName,
    counts: opts.counts,
    items: opts.items,
  };
  await db.execute(sql`
    INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
    VALUES (
      ${opts.actorId},
      'user_work_reassigned',
      '/admin/users',
      ${`reassigned from ${opts.fromUserId} to ${opts.toUserId}`},
      ${JSON.stringify(metadata)}::jsonb,
      ${opts.timestamp.toISOString()}::timestamp
    )
  `);
}

async function cleanup(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const literal = `{${createdUserIds.join(",")}}`;
  // Activity-log rows are keyed to from/to users via metadata (no FK),
  // so remove them explicitly by actor and by the tagged from/to id.
  await db
    .execute(
      sql`DELETE FROM user_activity_logs
          WHERE user_id = ANY(${literal}::text[])
             OR (metadata->>'fromUserId') = ANY(${literal}::text[])
             OR (metadata->>'toUserId') = ANY(${literal}::text[])`,
    )
    .catch(() => 0);
  await db
    .execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`)
    .catch(() => 0);
}

async function run(): Promise<void> {
  try {
    const ceo = await seedUser({ suffix: "ceo", role: "ceo", firstName: "Cleo", lastName: "Boss" });
    const actor = await seedUser({ suffix: "actor", firstName: "Audra", lastName: "Actor" });
    const toUser = await seedUser({ suffix: "to", firstName: "Tia", lastName: "Target" });
    const cyclingTo = await seedUser({ suffix: "cyc", firstName: "Cy", lastName: "Cycle" });
    const fromUserA = await seedUser({ suffix: "fromA", firstName: "Alex", lastName: "Alpha" });
    const fromUserB = await seedUser({ suffix: "fromB", firstName: "Bea", lastName: "Beta" });
    const noisyTo = await seedUser({ suffix: "noise", firstName: "Nina", lastName: "Noise" });

    const t0 = new Date("2026-01-01T00:00:00Z");
    const mins = (n: number) => new Date(t0.getTime() + n * 60_000);

    // ── Empty input → empty result (no DB round-trip). ─────────────────
    {
      const res = await getUserInboundReassignmentHistory([]);
      ok(
        res && typeof res === "object" && Object.keys(res).length === 0,
        "empty toUserIds → empty object",
      );
    }

    // toUser: a single reassignment of clients + threads + bookings FROM
    // Alex into Tia, with nested counts and items to unpack.
    await insertReassignEvent({
      actorId: actor.id,
      fromUserId: fromUserA.id,
      fromUserName: "Alex Alpha",
      toUserId: toUser.id,
      toUserName: "Tia Target",
      counts: { clients: 12, threads: 3, bookings: 2 },
      items: {
        clients: [
          { id: "client-1", label: "Acme Law" },
          { id: "client-2", label: "Beta Legal" },
        ],
        threads: [{ threadKey: "front:thread:42" }],
        bookings: [
          { id: "booking-1", label: "Intro call", startTimeUtc: "2026-02-01T15:00:00Z" },
        ],
      },
      timestamp: mins(10),
    });

    // cyclingTo: three reassignments INTO Cy inserted OUT of timestamp order
    // so the helper's ORDER BY is what produces newest-first, not insert order.
    await insertReassignEvent({
      actorId: actor.id,
      fromUserId: fromUserA.id,
      fromUserName: "Alex Alpha",
      toUserId: cyclingTo.id,
      toUserName: "Cy Cycle",
      counts: { clients: 1, threads: 0, bookings: 0 },
      items: { clients: [{ id: "c-mid", label: "Mid" }], threads: [], bookings: [] },
      timestamp: mins(40), // middle
    });
    await insertReassignEvent({
      actorId: ceo.id,
      fromUserId: fromUserB.id,
      fromUserName: "Bea Beta",
      toUserId: cyclingTo.id,
      toUserName: "Cy Cycle",
      counts: { clients: 5, threads: 1, bookings: 0 },
      items: { clients: [{ id: "c-new", label: "Newest" }], threads: [{ threadKey: "t-new" }], bookings: [] },
      timestamp: mins(80), // newest
    });
    await insertReassignEvent({
      actorId: actor.id,
      fromUserId: fromUserA.id,
      fromUserName: "Alex Alpha",
      toUserId: cyclingTo.id,
      toUserName: "Cy Cycle",
      counts: { clients: 0, threads: 0, bookings: 3 },
      items: { clients: [], threads: [], bookings: [{ id: "b-old", label: "Old", startTimeUtc: "2026-01-05T10:00:00Z" }] },
      timestamp: mins(20), // oldest
    });

    // noisyTo: a real reassignment event into another user that must be
    // excluded when not requested in the ids scope.
    await insertReassignEvent({
      actorId: actor.id,
      fromUserId: fromUserA.id,
      fromUserName: "Alex Alpha",
      toUserId: noisyTo.id,
      toUserName: "Nina Noise",
      counts: { clients: 9, threads: 0, bookings: 0 },
      items: { clients: [], threads: [], bookings: [] },
      timestamp: mins(60),
    });

    // A user_deleted row referencing toUser — wrong action type, must be
    // ignored by the action-type filter even though it shares the table.
    await db.execute(sql`
      INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
      VALUES (
        ${actor.id}, 'user_deleted', '/admin/users', 'noise',
        ${JSON.stringify({ targetUserId: toUser.id, toUserId: toUser.id })}::jsonb,
        ${mins(90).toISOString()}::timestamp
      )
    `);

    // ── 1. Keying + actor JOIN + nested unpacking. ─────────────────────
    const history = await getUserInboundReassignmentHistory([toUser.id, cyclingTo.id]);

    ok(
      history && typeof history === "object" && !Array.isArray(history),
      "result is a plain object keyed by to-user id",
    );
    ok(!(noisyTo.id in history), "unrequested to-user (noisyTo) excluded");
    // Direction switch: an out-only from-user is never a key in the inbound
    // result even though it appears as fromUserId on every event above.
    ok(!(fromUserA.id in history), "from-user id is never a bucket key (inbound keys by toUserId)");

    const toEvents = history[toUser.id] ?? [];
    ok(toEvents.length === 1, `toUser has exactly 1 event (got ${toEvents.length})`);
    const ev = toEvents[0];
    ok(ev?.toUserId === toUser.id, "event keyed/populated with toUserId");
    ok(ev?.fromUserId === fromUserA.id, "fromUserId unpacked from metadata");
    ok(ev?.fromUserName === "Alex Alpha", "fromUserName unpacked from metadata");
    ok(ev?.actorId === actor.id, "actorId matches the inserter");
    ok(
      ev?.actorName === `${actor.firstName} ${actor.lastName}`,
      "actorName resolved via users JOIN (first + last)",
    );

    // counts unpacked faithfully.
    ok(
      ev?.counts.clients === 12 && ev?.counts.threads === 3 && ev?.counts.bookings === 2,
      "nested counts unpacked (clients/threads/bookings)",
    );
    // items unpacked faithfully.
    ok(ev?.items.clients.length === 2, "items.clients array unpacked (2 clients)");
    ok(
      ev?.items.clients[0]?.id === "client-1" && ev?.items.clients[0]?.label === "Acme Law",
      "items.clients entry shape preserved (id + label)",
    );
    ok(
      ev?.items.threads.length === 1 && ev?.items.threads[0]?.threadKey === "front:thread:42",
      "items.threads array unpacked (threadKey preserved)",
    );
    ok(
      ev?.items.bookings.length === 1 &&
        ev?.items.bookings[0]?.id === "booking-1" &&
        ev?.items.bookings[0]?.startTimeUtc === "2026-02-01T15:00:00Z",
      "items.bookings entry shape preserved (id + startTimeUtc)",
    );

    // ── 2. Ordering — newest-first regardless of insertion order. ──────
    const cyc = history[cyclingTo.id] ?? [];
    ok(cyc.length === 3, `cyclingTo has 3 events (got ${cyc.length})`);
    ok(
      cyc[0]?.fromUserId === fromUserB.id &&
        cyc[1]?.fromUserId === fromUserA.id &&
        cyc[2]?.fromUserId === fromUserA.id,
      "cyclingTo events newest-first regardless of insertion order",
    );
    let descending = true;
    for (let i = 1; i < cyc.length; i++) {
      if (cyc[i - 1]!.timestamp.getTime() <= cyc[i]!.timestamp.getTime()) descending = false;
    }
    ok(descending, "cyclingTo timestamps strictly descending");
    // Newest event's nested counts confirm per-event unpacking, not a
    // shared/last-write-wins object.
    ok(
      cyc[0]?.counts.clients === 5 && cyc[0]?.counts.threads === 1 && cyc[0]?.counts.bookings === 0,
      "cyclingTo newest event counts unpacked independently",
    );
    ok(
      cyc[2]?.counts.bookings === 3 && cyc[2]?.items.bookings[0]?.id === "b-old",
      "cyclingTo oldest event items unpacked independently",
    );
    ok(
      cyc[0]?.actorName === `${ceo.firstName} ${ceo.lastName}`,
      "cyclingTo newest event actorName resolved (CEO actor)",
    );

    // ── 3. Direction switch — outbound query must not see inbound buckets. ─
    // Querying the OUT direction (covered fully in Task #2002's test) by the
    // *from* user must surface events; querying the IN direction by that same
    // from-user id must NOT. We already asserted fromUserA is not a key above;
    // here we confirm the inbound query keyed by the to-user only ever returns
    // events whose toUserId equals the requested key.
    ok(
      toEvents.every((e) => e.toUserId === toUser.id),
      "every event under toUser key has toUserId === toUser.id",
    );
    ok(
      cyc.every((e) => e.toUserId === cyclingTo.id),
      "every event under cyclingTo key has toUserId === cyclingTo.id",
    );
  } finally {
    await cleanup();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
