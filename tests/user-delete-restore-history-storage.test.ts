/* test-registration
{
  "name": "User delete/restore history storage helper \u2014 keying + ordering + actor JOIN + priorEmail + audit-history parity (Task #1987)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1987 — Storage-level regression coverage for
 * `getUserDeleteRestoreHistory` (Task #1912) in
 * `server/storage/activityStorage.ts`.
 *
 * The User Management delete/restore history popover renders whatever
 * this helper returns. `tests/user-delete-history-route.test.ts` already
 * pins the HTTP route (auth gate + JSON shape), but the storage helper —
 * its action-type filter, its `metadata->>'targetUserId'` keying, the
 * `users` actor JOIN, the `priorEmail` extraction, and the newest-first
 * ordering — shares a code shape with `getEntityAuditHistory`
 * (Task #1941, the generic audit-history popover). A refactor of that
 * shared activity-log shape could quietly empty BOTH popovers. This test
 * exercises the helper directly so a storage-layer regression fails here
 * even if the route wrapper is untouched.
 *
 * Pins:
 *   1. Lifecycle — delete + restore rows resolve into newest-first events
 *      keyed by `targetUserId`, with the actor name resolved via the
 *      `users` JOIN and `priorEmail` populated only on restore events.
 *   2. Scoping — only requested target ids come back; unrelated targets
 *      and non-delete/restore action types are excluded.
 *   3. Parity with the audit-history contract — the same underlying
 *      `user_activity_logs` rows, read by `getEntityAuditHistory`, obey
 *      the identical newest-first-per-bucket ordering and actor-JOIN
 *      name-resolution assumptions the two helpers share.
 *
 * Follows the live-DB pattern of `tests/audit-history.test.ts`: rows are
 * written synchronously before the helper is called, so no polling is
 * needed.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  getUserDeleteRestoreHistory,
  getEntityAuditHistory,
} from "../server/storage/activityStorage";

const TAG = `task-1987-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

async function insertEvent(opts: {
  actorId: string | null;
  actionType: "user_deleted" | "user_restored";
  targetUserId: string;
  priorEmail?: string | null;
  timestamp: Date;
}): Promise<void> {
  const metadata: Record<string, any> = { targetUserId: opts.targetUserId };
  if (opts.actionType === "user_restored" && opts.priorEmail != null) {
    metadata.priorEmail = opts.priorEmail;
  }
  await db.execute(sql`
    INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
    VALUES (
      ${opts.actorId},
      ${opts.actionType},
      '/admin/users',
      ${`${opts.actionType} ${opts.targetUserId}`},
      ${JSON.stringify(metadata)}::jsonb,
      ${opts.timestamp.toISOString()}::timestamp
    )
  `);
}

// A client-entity row written to the same activity-log table, so the
// parity check can read it back through `getEntityAuditHistory`.
async function insertClientEvent(opts: {
  actorId: string | null;
  actionType: "client_created" | "client_updated" | "client_deleted";
  clientId: string;
  timestamp: Date;
}): Promise<void> {
  const metadata = { clientId: opts.clientId };
  await db.execute(sql`
    INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
    VALUES (
      ${opts.actorId},
      ${opts.actionType},
      '/api/clients',
      ${`${opts.actionType} ${opts.clientId}`},
      ${JSON.stringify(metadata)}::jsonb,
      ${opts.timestamp.toISOString()}::timestamp
    )
  `);
}

async function cleanup(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const literal = `{${createdUserIds.join(",")}}`;
  // Activity-log rows are keyed to targets/clients via metadata (no FK),
  // so remove them explicitly by actor and by the tagged target/client id.
  await db
    .execute(
      sql`DELETE FROM user_activity_logs
          WHERE user_id = ANY(${literal}::text[])
             OR (metadata->>'targetUserId') = ANY(${literal}::text[])
             OR (metadata->>'clientId') LIKE ${`${TAG}%`}`,
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
    const deletedUser = await seedUser({ suffix: "del" });
    const restoredUser = await seedUser({ suffix: "rest" });
    const cyclingUser = await seedUser({ suffix: "cyc" });
    const noisyOther = await seedUser({ suffix: "noise" });

    const t0 = new Date("2026-01-01T00:00:00Z");
    const mins = (n: number) => new Date(t0.getTime() + n * 60_000);

    // ── Empty input → empty result (no DB round-trip). ─────────────────
    {
      const res = await getUserDeleteRestoreHistory([]);
      ok(
        res && typeof res === "object" && Object.keys(res).length === 0,
        "empty targetUserIds → empty object",
      );
    }

    // deletedUser: a single delete event.
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: deletedUser.id,
      timestamp: mins(10),
    });

    // restoredUser: delete then restore (restore carries priorEmail).
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: restoredUser.id,
      timestamp: mins(20),
    });
    await insertEvent({
      actorId: ceo.id,
      actionType: "user_restored",
      targetUserId: restoredUser.id,
      priorEmail: `${restoredUser.email}.deleted.1700000000000`,
      timestamp: mins(30),
    });

    // cyclingUser: two delete/restore cycles inserted OUT of timestamp
    // order so the helper's ORDER BY is what produces newest-first, not
    // the insertion order.
    await insertEvent({
      actorId: actor.id,
      actionType: "user_restored",
      targetUserId: cyclingUser.id,
      priorEmail: `${cyclingUser.email}.deleted.1700000002000`,
      timestamp: mins(80), // newest
    });
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: cyclingUser.id,
      timestamp: mins(40),
    });
    await insertEvent({
      actorId: ceo.id,
      actionType: "user_deleted",
      targetUserId: cyclingUser.id,
      timestamp: mins(70),
    });
    await insertEvent({
      actorId: ceo.id,
      actionType: "user_restored",
      targetUserId: cyclingUser.id,
      priorEmail: `${cyclingUser.email}.deleted.1700000001000`,
      timestamp: mins(50),
    });

    // noisyOther: real delete/restore events that must be excluded when
    // not requested in the `ids` scope.
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: noisyOther.id,
      timestamp: mins(60),
    });

    // A page_view row for deletedUser's id as target — wrong action type,
    // must be ignored by the action-type filter.
    await db.execute(sql`
      INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
      VALUES (
        ${actor.id}, 'page_view', '/admin/users', 'noise',
        ${JSON.stringify({ targetUserId: deletedUser.id })}::jsonb,
        ${mins(90).toISOString()}::timestamp
      )
    `);

    // ── 1. Lifecycle + keying + actor JOIN + priorEmail. ───────────────
    const history = await getUserDeleteRestoreHistory([
      deletedUser.id,
      restoredUser.id,
      cyclingUser.id,
    ]);

    ok(
      history && typeof history === "object" && !Array.isArray(history),
      "result is a plain object keyed by target id",
    );
    ok(!(noisyOther.id in history), "unrequested target (noisyOther) excluded");

    // deletedUser → exactly one user_deleted event, actor JOIN resolved,
    // page_view noise filtered out.
    const del = history[deletedUser.id] ?? [];
    ok(del.length === 1, `deletedUser has exactly 1 event (got ${del.length})`);
    ok(del[0]?.actionType === "user_deleted", "deletedUser event is user_deleted");
    ok(del[0]?.actorId === actor.id, "deletedUser actorId matches the inserter");
    ok(
      del[0]?.actorName === `${actor.firstName} ${actor.lastName}`,
      "deletedUser actorName resolved via users JOIN (first + last)",
    );
    ok(del[0]?.priorEmail === null, "deletedUser delete event priorEmail is null");

    // restoredUser → restore newest, delete oldest, priorEmail on restore.
    const rest = history[restoredUser.id] ?? [];
    ok(rest.length === 2, `restoredUser has 2 events (got ${rest.length})`);
    ok(rest[0]?.actionType === "user_restored", "restoredUser newest is the restore");
    ok(rest[1]?.actionType === "user_deleted", "restoredUser oldest is the delete");
    ok(
      rest[0]?.actorName === `${ceo.firstName} ${ceo.lastName}`,
      "restore actorName resolved (CEO actor)",
    );
    ok(
      rest[0]?.priorEmail === `${restoredUser.email}.deleted.1700000000000`,
      "priorEmail populated on the restore event",
    );
    ok(rest[1]?.priorEmail === null, "priorEmail null on the delete event");
    ok(
      rest[0]!.timestamp.getTime() > rest[1]!.timestamp.getTime(),
      "restoredUser ordered newest-first by timestamp",
    );

    // cyclingUser → 4 events strictly descending regardless of insert order.
    const cyc = history[cyclingUser.id] ?? [];
    ok(cyc.length === 4, `cyclingUser has 4 events (got ${cyc.length})`);
    ok(
      JSON.stringify(cyc.map((e) => e.actionType)) ===
        JSON.stringify(["user_restored", "user_deleted", "user_restored", "user_deleted"]),
      "cyclingUser events newest-first regardless of insertion order",
    );
    let descending = true;
    for (let i = 1; i < cyc.length; i++) {
      if (cyc[i - 1]!.timestamp.getTime() <= cyc[i]!.timestamp.getTime()) descending = false;
    }
    ok(descending, "cyclingUser timestamps strictly descending");
    ok(
      cyc[0]?.priorEmail === `${cyclingUser.email}.deleted.1700000002000` &&
        cyc[1]?.priorEmail === null &&
        cyc[2]?.priorEmail === `${cyclingUser.email}.deleted.1700000001000` &&
        cyc[3]?.priorEmail === null,
      "cyclingUser priorEmail present only on restore events, matching values",
    );

    // ── 2. Parity with the audit-history contract. ─────────────────────
    // Both helpers read the same `user_activity_logs` table and share the
    // newest-first-per-bucket ordering + actor-JOIN name resolution. Write
    // a client lifecycle through the same table and confirm
    // getEntityAuditHistory returns the identical contract shape.
    const clientId = `${TAG}-client-${randomUUID()}`;
    await insertClientEvent({
      actorId: actor.id,
      actionType: "client_created",
      clientId,
      timestamp: mins(100),
    });
    await insertClientEvent({
      actorId: ceo.id,
      actionType: "client_deleted",
      clientId,
      timestamp: mins(120),
    });

    const audit = await getEntityAuditHistory("client", [clientId]);
    const clientEvents = audit[clientId] ?? [];
    ok(clientEvents.length === 2, `audit-history client bucket has 2 events (got ${clientEvents.length})`);
    ok(
      clientEvents[0]?.actionType === "client_deleted" &&
        clientEvents[1]?.actionType === "client_created",
      "audit-history newest-first ordering parity (delete before create)",
    );
    ok(
      clientEvents[0]?.actorName === `${ceo.firstName} ${ceo.lastName}`,
      "audit-history actorName JOIN parity (CEO on newest event)",
    );
    // The shared assumption: newest event is index [0] in both helpers, so
    // a popover can read `events[0]` as "latest" against either source.
    ok(
      history[restoredUser.id]![0].actionType === "user_restored" &&
        audit[clientId]![0].actionType === "client_deleted",
      "both helpers expose the latest event at index [0] (shared popover contract)",
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
