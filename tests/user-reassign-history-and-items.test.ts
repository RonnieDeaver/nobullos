/* test-registration
{
  "name": "User reassign items capture + reassign-history keying/legacy fallback (Task #1982)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1982 — regression coverage for the per-item capture added to
 * `reassignUserWork` (Task #1950) and the audit trail it feeds.
 *
 * Task #1950 changed the bulk-reassign path so the activity-log row no
 * longer records only *counts* of moved work — it captures *which*
 * clients / threads / bookings ended up with the new owner (ids + human
 * labels), so a future CEO can answer "which clients did Alex inherit
 * after I deleted Sam?" straight from the audit trail. Three layers must
 * not silently regress:
 *
 *   (A) Storage — `reassignUserWork` must populate `result.items` from the
 *       `.returning()` rows, one entry per surface, and only for rows it
 *       actually updated (active clients, non-resolved threads, future
 *       creating/confirmed bookings). Exercised against the live DB inside
 *       a transactional sandbox so nothing leaks.
 *
 *   (B) Route — `POST /api/users/:id/reassign` must persist `metadata.items`
 *       (not just `metadata.counts`) onto the `user_work_reassigned`
 *       activity-log row.
 *
 *   (C) Route — `GET /api/users/reassign-history` must key results by the
 *       *source* user id, round-trip the captured items intact, AND fall
 *       back to empty arrays for legacy rows whose metadata predates the
 *       `items` key (instead of crashing or returning `undefined`).
 *
 * Registered in tests/run-all.ts.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import { reassignUserWork } from "../server/storage/clientStorage";
import { registerSettingsRoutes } from "../server/routes/settings";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-1982";

// ─────────────────────────────────────────────────────────────────────────────
// Shared seeding helpers (raw SQL so they work both inside the tx sandbox via
// getDb() and against committed rows for the HTTP route tests via db).
// ─────────────────────────────────────────────────────────────────────────────

type Exec = { execute: (q: any) => Promise<any> };

async function seedUser(
  exec: Exec,
  opts: { role: string; suffix: string; firstName?: string; lastName?: string },
): Promise<{ id: string; email: string; firstName: string; lastName: string }> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = `${id}@test.example`;
  const firstName = opts.firstName ?? `${TAG}-${opts.suffix}`;
  const lastName = opts.lastName ?? "User";
  await exec.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${firstName}, ${lastName},
            ${opts.role}, ${opts.role === "ceo" ? "ceo" : "core"})
  `);
  return { id, email, firstName, lastName };
}

async function seedClient(
  exec: Exec,
  opts: { firmName: string; ownerId: string; isArchived?: boolean; isDemo?: boolean },
): Promise<string> {
  const id = `${TAG}-client-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES (${id}, ${opts.firmName}, ${opts.ownerId},
            ${opts.isArchived ?? false}, ${opts.isDemo ?? false})
  `);
  return id;
}

async function seedThread(
  exec: Exec,
  opts: { assignedToUserId: string; status?: string },
): Promise<string> {
  const threadKey = `${TAG}-thread-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO thread_assignments (thread_key, assigned_to_user_id, status)
    VALUES (${threadKey}, ${opts.assignedToUserId}, ${opts.status ?? "open"})
  `);
  return threadKey;
}

async function seedBooking(
  exec: Exec,
  opts: {
    accountManagerUserId: string;
    startTimeUtc: Date;
    status?: string;
    meetingTypeName?: string | null;
    inviteeName?: string | null;
  },
): Promise<string> {
  const id = `${TAG}-booking-${randomUUID()}`;
  const end = new Date(opts.startTimeUtc.getTime() + 30 * 60_000);
  await exec.execute(sql`
    INSERT INTO scheduled_meetings (
      id, account_manager_user_id, booking_source,
      meeting_type_name, invitee_name,
      start_time_utc, end_time_utc, timezone, status
    )
    VALUES (
      ${id}, ${opts.accountManagerUserId}, 'internal',
      ${opts.meetingTypeName ?? null}, ${opts.inviteeName ?? null},
      ${opts.startTimeUtc.toISOString()}::timestamp,
      ${end.toISOString()}::timestamp,
      'America/Chicago', ${opts.status ?? "confirmed"}
    )
  `);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Storage: reassignUserWork populates result.items per surface, only for
//     the rows it actually updated.
// ─────────────────────────────────────────────────────────────────────────────

async function testStorageItemsCapture(): Promise<void> {
  console.log("(A) reassignUserWork — result.items match the rows updated, per surface");

  await runInTxSandbox(async () => {
    const exec = getDb() as unknown as Exec;
    const fromUser = await seedUser(exec, { role: "account_manager", suffix: "from" });
    const toUser = await seedUser(exec, { role: "account_manager", suffix: "to" });
    const actor = await seedUser(exec, { role: "ceo", suffix: "actor" });

    // Clients: two active owned by fromUser (should move), one archived
    // (excluded), one demo (excluded), one already owned by toUser (control).
    const activeClientA = await seedClient(exec, { firmName: "Alpha Firm", ownerId: fromUser.id });
    const activeClientB = await seedClient(exec, { firmName: "Bravo Firm", ownerId: fromUser.id });
    await seedClient(exec, { firmName: "Archived Firm", ownerId: fromUser.id, isArchived: true });
    await seedClient(exec, { firmName: "Demo Firm", ownerId: fromUser.id, isDemo: true });
    await seedClient(exec, { firmName: "Control Firm", ownerId: toUser.id });

    // Threads: two open assigned to fromUser (move), one resolved (excluded).
    const openThreadA = await seedThread(exec, { assignedToUserId: fromUser.id, status: "open" });
    const openThreadB = await seedThread(exec, { assignedToUserId: fromUser.id, status: "pending" });
    await seedThread(exec, { assignedToUserId: fromUser.id, status: "resolved" });

    // Bookings: two future creating/confirmed (move), one past (excluded),
    // one future but cancelled (excluded).
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const future2 = new Date(Date.now() + 8 * 24 * 60 * 60_000);
    const past = new Date(Date.now() - 24 * 60 * 60_000);
    const bookingA = await seedBooking(exec, {
      accountManagerUserId: fromUser.id,
      startTimeUtc: future,
      status: "confirmed",
      meetingTypeName: "Quarterly Review",
      inviteeName: "Jane Client",
    });
    const bookingB = await seedBooking(exec, {
      accountManagerUserId: fromUser.id,
      startTimeUtc: future2,
      status: "creating",
      meetingTypeName: null,
      inviteeName: null,
    });
    await seedBooking(exec, {
      accountManagerUserId: fromUser.id,
      startTimeUtc: past,
      status: "confirmed",
    });
    await seedBooking(exec, {
      accountManagerUserId: fromUser.id,
      startTimeUtc: future,
      status: "cancelled",
    });

    const result = await reassignUserWork(
      fromUser.id,
      toUser.id,
      ["clients", "threads", "bookings"],
      actor.id,
    );

    // Counts.
    assert.equal(result.clients, 2, "2 active clients moved (archived + demo excluded)");
    assert.equal(result.threads, 2, "2 non-resolved threads moved (resolved excluded)");
    assert.equal(result.bookings, 2, "2 future creating/confirmed bookings moved");

    // items.length must equal counts (the .returning() actually populated them).
    assert.equal(result.items.clients.length, 2, "items.clients length matches count");
    assert.equal(result.items.threads.length, 2, "items.threads length matches count");
    assert.equal(result.items.bookings.length, 2, "items.bookings length matches count");

    // Client items: exact id set with firm-name labels.
    const clientIds = new Set(result.items.clients.map((c) => c.id));
    assert.ok(clientIds.has(activeClientA), "activeClientA captured");
    assert.ok(clientIds.has(activeClientB), "activeClientB captured");
    const alpha = result.items.clients.find((c) => c.id === activeClientA);
    assert.equal(alpha?.label, "Alpha Firm", "client label is the firm name");

    // Thread items: exact threadKey set.
    const threadKeys = new Set(result.items.threads.map((t) => t.threadKey));
    assert.ok(threadKeys.has(openThreadA), "openThreadA captured");
    assert.ok(threadKeys.has(openThreadB), "openThreadB captured");

    // Booking items: ids + labels + ISO startTimeUtc.
    const bookingIds = new Set(result.items.bookings.map((b) => b.id));
    assert.ok(bookingIds.has(bookingA), "bookingA captured");
    assert.ok(bookingIds.has(bookingB), "bookingB captured");
    const a = result.items.bookings.find((b) => b.id === bookingA);
    assert.equal(a?.label, "Quarterly Review — Jane Client", "booking label joins type + invitee");
    assert.equal(a?.startTimeUtc, future.toISOString(), "booking startTimeUtc is ISO of seeded time");
    const b = result.items.bookings.find((b) => b.id === bookingB);
    assert.equal(b?.label, "Meeting", "booking label falls back to 'Meeting' when no name fields");

    // Verify the rows actually changed owner (the .returning() reflects real updates).
    const movedClients = await exec.execute(sql`
      SELECT id FROM clients WHERE owner_id = ${toUser.id} AND id IN (${activeClientA}, ${activeClientB})
    `);
    const movedRows = Array.isArray(movedClients) ? movedClients : (movedClients as any).rows ?? [];
    assert.equal(movedRows.length, 2, "both active clients now owned by toUser in the DB");

    console.log("  ✓ items populated from .returning(), scoped to updated rows, per surface");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route harness (committed-row pattern; HTTP boundary can't see the tx sandbox)
// ─────────────────────────────────────────────────────────────────────────────

type AuthMode = "anon" | { userId: string };

function buildApp(mode: AuthMode): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    // Route tests seed committed public-schema users, so requireAuth's real
    // user lookup + role gating resolves them without the registry.
    (req as any).__test_clerkUserId = mode === "anon" ? null : mode.userId;
    next();
  });
  registerSettingsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function httpJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function cleanupCommitted(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const literal = `{${userIds.join(",")}}`;
  await db.execute(sql`DELETE FROM scheduled_meetings WHERE account_manager_user_id = ANY(${literal}::text[])`);
  await db.execute(sql`DELETE FROM thread_assignments WHERE assigned_to_user_id = ANY(${literal}::text[]) OR updated_by_user_id = ANY(${literal}::text[])`);
  await db.execute(sql`DELETE FROM clients WHERE owner_id = ANY(${literal}::text[])`);
  await db.execute(sql`
    DELETE FROM user_activity_logs
    WHERE user_id = ANY(${literal}::text[])
       OR (metadata->>'fromUserId') = ANY(${literal}::text[])
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`);
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Route: POST /api/users/:id/reassign persists metadata.items.
// ─────────────────────────────────────────────────────────────────────────────

async function testRoutePersistsItems(): Promise<void> {
  console.log("(B) POST /api/users/:id/reassign — metadata.items persisted on the audit row");

  const created: string[] = [];
  try {
    const ceo = await seedUser(db, { role: "ceo", suffix: "ceo", firstName: "Cleo", lastName: "Boss" });
    const fromUser = await seedUser(db, { role: "account_manager", suffix: "rfrom", firstName: "Sam", lastName: "Source" });
    const toUser = await seedUser(db, { role: "account_manager", suffix: "rto", firstName: "Alex", lastName: "Target" });
    created.push(ceo.id, fromUser.id, toUser.id);

    const clientId = await seedClient(db, { firmName: "Persisted Firm", ownerId: fromUser.id });
    const threadKey = await seedThread(db, { assignedToUserId: fromUser.id, status: "open" });
    const future = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    const bookingId = await seedBooking(db, {
      accountManagerUserId: fromUser.id,
      startTimeUtc: future,
      status: "confirmed",
      meetingTypeName: "Onboarding",
      inviteeName: "Dana Lead",
    });

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    let body: any;
    try {
      const r = await httpJson(baseUrl, `/api/users/${encodeURIComponent(fromUser.id)}/reassign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: toUser.id }),
      });
      assert.equal(r.status, 200, "CEO reassign → 200");
      body = r.body;
    } finally {
      server.close();
    }

    assert.equal(body.result.clients, 1, "response result.clients === 1");
    assert.equal(body.result.threads, 1, "response result.threads === 1");
    assert.equal(body.result.bookings, 1, "response result.bookings === 1");

    // The audit row must carry the items, not just the counts.
    const rows = await db.execute(sql`
      SELECT metadata FROM user_activity_logs
      WHERE action_type = 'user_work_reassigned'
        AND (metadata->>'fromUserId') = ${fromUser.id}
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
    assert.equal(list.length, 1, "exactly one user_work_reassigned row written");
    const meta = list[0].metadata as Record<string, any>;
    assert.equal(meta.fromUserId, fromUser.id, "metadata.fromUserId persisted");
    assert.equal(meta.toUserId, toUser.id, "metadata.toUserId persisted");
    assert.ok(meta.items, "metadata.items present");
    assert.deepEqual(
      meta.items.clients.map((c: any) => c.id).sort(),
      [clientId],
      "metadata.items.clients carries the moved client id",
    );
    assert.equal(meta.items.clients[0].label, "Persisted Firm", "client label persisted");
    assert.deepEqual(
      meta.items.threads.map((t: any) => t.threadKey).sort(),
      [threadKey],
      "metadata.items.threads carries the moved thread key",
    );
    assert.equal(meta.items.bookings.length, 1, "one booking item persisted");
    assert.equal(meta.items.bookings[0].id, bookingId, "booking id persisted");
    assert.equal(meta.items.bookings[0].label, "Onboarding — Dana Lead", "booking label persisted");

    console.log("  ✓ metadata.items (clients/threads/bookings) round-trips onto the audit row");
  } finally {
    await cleanupCommitted(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (C) Route: GET /api/users/reassign-history — keying + legacy fallback.
// ─────────────────────────────────────────────────────────────────────────────

async function insertReassignLog(opts: {
  actorId: string;
  fromUserId: string;
  toUserId: string;
  includeItems: boolean;
  timestamp: Date;
}): Promise<void> {
  const metadata: Record<string, any> = {
    fromUserId: opts.fromUserId,
    fromUserName: "Source Person",
    toUserId: opts.toUserId,
    toUserName: "Target Person",
    surfaces: ["clients", "threads", "bookings"],
    counts: { clients: 1, threads: 0, bookings: 0 },
  };
  if (opts.includeItems) {
    metadata.items = {
      clients: [{ id: "c-1", label: "Captured Firm" }],
      threads: [],
      bookings: [],
    };
  }
  await db.execute(sql`
    INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
    VALUES (
      ${opts.actorId}, 'user_work_reassigned', '/admin/users',
      'reassign', ${JSON.stringify(metadata)}::jsonb,
      ${opts.timestamp.toISOString()}::timestamp
    )
  `);
}

async function testHistoryKeyingAndLegacyFallback(): Promise<void> {
  console.log("(C) GET /api/users/reassign-history — keying by fromUserId + legacy fallback");

  const created: string[] = [];
  try {
    const ceo = await seedUser(db, { role: "ceo", suffix: "hceo", firstName: "Hilda", lastName: "Head" });
    const actor = await seedUser(db, { role: "account_manager", suffix: "hactor", firstName: "Ann", lastName: "Actor" });
    const modernFrom = await seedUser(db, { role: "account_manager", suffix: "hmod" });
    const legacyFrom = await seedUser(db, { role: "account_manager", suffix: "hleg" });
    const toUser = await seedUser(db, { role: "account_manager", suffix: "hto" });
    created.push(ceo.id, actor.id, modernFrom.id, legacyFrom.id, toUser.id);

    const t0 = new Date("2026-02-01T00:00:00Z");
    // modernFrom: a row WITH the items key (Task #1950 shape).
    await insertReassignLog({
      actorId: actor.id,
      fromUserId: modernFrom.id,
      toUserId: toUser.id,
      includeItems: true,
      timestamp: t0,
    });
    // legacyFrom: a row WITHOUT the items key (pre-Task #1950 shape).
    await insertReassignLog({
      actorId: actor.id,
      fromUserId: legacyFrom.id,
      toUserId: toUser.id,
      includeItems: false,
      timestamp: t0,
    });

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    let body: any;
    try {
      const ids = [modernFrom.id, legacyFrom.id].join(",");
      const r = await httpJson(baseUrl, `/api/users/reassign-history?ids=${encodeURIComponent(ids)}`);
      assert.equal(r.status, 200, "CEO call → 200");
      body = r.body;
    } finally {
      server.close();
    }

    // Keyed by the SOURCE user id.
    assert.ok(modernFrom.id in body, "history keyed by modern fromUserId");
    assert.ok(legacyFrom.id in body, "history keyed by legacy fromUserId");

    const modernEvents = body[modernFrom.id];
    assert.ok(Array.isArray(modernEvents) && modernEvents.length === 1, "modernFrom has 1 event");
    assert.equal(modernEvents[0].fromUserId, modernFrom.id, "event.fromUserId matches key");
    assert.equal(modernEvents[0].items.clients.length, 1, "modern event keeps captured client item");
    assert.equal(modernEvents[0].items.clients[0].label, "Captured Firm", "captured label intact");

    // Legacy row (no items key) must render empty arrays, not crash / undefined.
    const legacyEvents = body[legacyFrom.id];
    assert.ok(Array.isArray(legacyEvents) && legacyEvents.length === 1, "legacyFrom has 1 event");
    assert.deepEqual(legacyEvents[0].items.clients, [], "legacy items.clients → []");
    assert.deepEqual(legacyEvents[0].items.threads, [], "legacy items.threads → []");
    assert.deepEqual(legacyEvents[0].items.bookings, [], "legacy items.bookings → []");
    // Counts still round-trip even on the legacy row.
    assert.equal(legacyEvents[0].counts.clients, 1, "legacy counts still parsed");

    console.log("  ✓ keyed by fromUserId; modern items intact; legacy rows → empty arrays");
  } finally {
    await cleanupCommitted(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testStorageItemsCapture();
  await testRoutePersistsItems();
  await testHistoryKeyingAndLegacyFallback();
  console.log("user-reassign-history-and-items: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-reassign-history-and-items: FAILED");
  console.error(err);
  process.exitCode = 1;
});
