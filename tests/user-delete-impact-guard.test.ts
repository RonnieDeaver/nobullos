/* test-registration
{
  "name": "User delete-impact guard \u2014 sole-assignee 409/force (Task #1935)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1935 — regression coverage for the Task #1909 pre-delete impact
 * guard on DELETE /api/users/:id.
 *
 * Pins:
 *   (A) GET /api/users/:id/delete-impact returns the same counts/samples
 *       as the storage layer for a user who owns an active client, is
 *       the sole assignee on an open thread, and is the AM on an
 *       upcoming meeting.
 *   (B) DELETE without ?force=true returns 409 / code
 *       `user_delete_requires_force` with the expected impact body and
 *       the user row is NOT soft-deleted.
 *   (C) DELETE with ?force=true succeeds (200), soft-deletes the user,
 *       and writes a `user_deleted` activity-log row.
 *   (D) A user with no active assignments deletes cleanly without any
 *       `?force=true` override.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerSettingsRoutes } from "../server/routes/settings";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-1935";

interface SeededUser {
  id: string;
  email: string;
}

async function seedUser(opts: { role: string; suffix: string }): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = `${id}@test.example`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${`${TAG}-${opts.suffix}`}, 'User',
            ${opts.role}, ${opts.role === "ceo" ? "ceo" : "core"})
  `);
  return { id, email };
}

async function seedOwnedClient(ownerId: string, firmName: string): Promise<string> {
  const id = `${TAG}-client-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES (${id}, ${firmName}, ${ownerId}, false, false)
  `);
  return id;
}

async function seedOpenThreadAssignment(userId: string): Promise<string> {
  const threadKey = `${TAG}-thread-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO thread_assignments (thread_key, assigned_to_user_id, status)
    VALUES (${threadKey}, ${userId}, 'open')
  `);
  return threadKey;
}

async function seedUpcomingMeeting(
  userId: string,
  inviteeName: string,
): Promise<string> {
  const id = `${TAG}-mtg-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO scheduled_meetings (
      id, account_manager_user_id, booking_source,
      invitee_name, start_time_utc, end_time_utc, timezone, status
    )
    VALUES (
      ${id}, ${userId}, 'native',
      ${inviteeName},
      NOW() + INTERVAL '7 days',
      NOW() + INTERVAL '7 days 30 minutes',
      'America/New_York', 'confirmed'
    )
  `);
  return id;
}

async function fetchUserRow(id: string): Promise<{ deletedAt: Date | null } | undefined> {
  const res: any = await db.execute(sql`
    SELECT deleted_at FROM users WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  if (!rows[0]) return undefined;
  return {
    deletedAt: rows[0].deleted_at ? new Date(rows[0].deleted_at as string) : null,
  };
}

async function countUserDeletedLogs(targetId: string, actorId: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM user_activity_logs
    WHERE action_type = 'user_deleted'
      AND user_id = ${actorId}
      AND (metadata->>'targetUserId') = ${targetId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function cleanup(opts: {
  userIds: string[];
  clientIds: string[];
  threadKeys: string[];
  meetingIds: string[];
}): Promise<void> {
  if (opts.meetingIds.length) {
    const lit = `{${opts.meetingIds.join(",")}}`;
    await db.execute(sql`DELETE FROM scheduled_meetings WHERE id = ANY(${lit}::text[])`);
  }
  if (opts.threadKeys.length) {
    const lit = `{${opts.threadKeys.join(",")}}`;
    await db.execute(sql`DELETE FROM thread_assignments WHERE thread_key = ANY(${lit}::text[])`);
  }
  if (opts.clientIds.length) {
    const lit = `{${opts.clientIds.join(",")}}`;
    await db.execute(sql`DELETE FROM clients WHERE id = ANY(${lit}::text[])`);
  }
  if (opts.userIds.length) {
    const lit = `{${opts.userIds.join(",")}}`;
    await db.execute(sql`
      DELETE FROM user_activity_logs
      WHERE (metadata->>'targetUserId') = ANY(${lit}::text[])
         OR user_id = ANY(${lit}::text[])
    `);
    await db.execute(sql`
      DELETE FROM sessions
      WHERE sess->'passport'->'user'->'claims'->>'sub' = ANY(${lit}::text[])
    `);
    await db.execute(sql`DELETE FROM users WHERE id = ANY(${lit}::text[])`);
  }
}

function buildApp(actorId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actorId;
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

async function jsonReq(
  baseUrl: string,
  path: string,
  method: "GET" | "DELETE",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function testImpactGuard(): Promise<void> {
  console.log("(A/B/C) delete-impact guard — sole-assignee user");
  const userIds: string[] = [];
  const clientIds: string[] = [];
  const threadKeys: string[] = [];
  const meetingIds: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim" });
    userIds.push(ceo.id, victim.id);

    const firmName = `${TAG} Active Firm ${randomUUID()}`;
    const clientId = await seedOwnedClient(victim.id, firmName);
    clientIds.push(clientId);

    const threadKey = await seedOpenThreadAssignment(victim.id);
    threadKeys.push(threadKey);

    const inviteeName = `${TAG} Invitee`;
    const meetingId = await seedUpcomingMeeting(victim.id, inviteeName);
    meetingIds.push(meetingId);

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      // (A) GET /api/users/:id/delete-impact mirrors the storage counts.
      const impactRes = await jsonReq(baseUrl, `/api/users/${victim.id}/delete-impact`, "GET");
      assert.equal(impactRes.status, 200, "delete-impact GET → 200");
      const impact = impactRes.body?.impact;
      assert.ok(impact, "impact object returned");
      assert.equal(impact.hasImpact, true, "hasImpact true with active work");
      assert.equal(impact.assignedClients.count, 1, "1 assigned client counted");
      assert.equal(impact.assignedClients.sample[0]?.id, clientId, "client sample id");
      assert.equal(impact.assignedClients.sample[0]?.firmName, firmName, "client sample firmName");
      assert.equal(impact.openThreads.count, 1, "1 open thread counted");
      assert.equal(impact.openThreads.sample[0]?.threadKey, threadKey, "thread sample key");
      assert.equal(impact.openThreads.sample[0]?.status, "open", "thread sample status");
      assert.equal(impact.upcomingBookings.count, 1, "1 upcoming booking counted");
      assert.equal(impact.upcomingBookings.sample[0]?.id, meetingId, "booking sample id");
      assert.equal(
        impact.upcomingBookings.sample[0]?.inviteeName,
        inviteeName,
        "booking sample invitee name",
      );

      // (B) DELETE without ?force=true → 409 + code + impact body.
      const refused = await jsonReq(baseUrl, `/api/users/${victim.id}`, "DELETE");
      assert.equal(refused.status, 409, "DELETE without force → 409");
      assert.equal(
        refused.body?.code,
        "user_delete_requires_force",
        "response code is user_delete_requires_force",
      );
      assert.ok(refused.body?.impact, "409 body carries the impact summary");
      assert.equal(refused.body.impact.assignedClients.count, 1, "409 impact: client count");
      assert.equal(refused.body.impact.openThreads.count, 1, "409 impact: thread count");
      assert.equal(refused.body.impact.upcomingBookings.count, 1, "409 impact: booking count");

      const stillLive = await fetchUserRow(victim.id);
      assert.ok(stillLive, "victim row still present after 409");
      assert.equal(stillLive!.deletedAt, null, "victim NOT soft-deleted after 409");
      assert.equal(
        await countUserDeletedLogs(victim.id, ceo.id),
        0,
        "no user_deleted activity log after refusal",
      );

      // (C) DELETE with ?force=true → 200, soft-delete + activity log.
      const forced = await jsonReq(baseUrl, `/api/users/${victim.id}?force=true`, "DELETE");
      assert.equal(forced.status, 200, "DELETE with ?force=true → 200");
      assert.equal(forced.body?.ok, true, "forced response ok=true");
      assert.equal(forced.body?.id, victim.id, "forced response echoes id");

      const afterRow = await fetchUserRow(victim.id);
      assert.ok(afterRow, "victim row still present after force-delete (soft delete)");
      assert.ok(
        afterRow!.deletedAt instanceof Date,
        "deletedAt set after force delete",
      );
      assert.equal(
        await countUserDeletedLogs(victim.id, ceo.id),
        1,
        "one user_deleted activity-log row written after force delete",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ GET delete-impact mirrors storage; 409 refuses without force; ?force=true succeeds + logs");
  } finally {
    await cleanup({ userIds, clientIds, threadKeys, meetingIds });
  }
}

async function testNoImpactDeletesWithoutForce(): Promise<void> {
  console.log("(D) user with no active assignments deletes without ?force=true");
  const userIds: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo2" });
    const victim = await seedUser({ role: "account_manager", suffix: "clean" });
    userIds.push(ceo.id, victim.id);

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      // delete-impact reports no impact.
      const impactRes = await jsonReq(baseUrl, `/api/users/${victim.id}/delete-impact`, "GET");
      assert.equal(impactRes.status, 200, "delete-impact GET → 200");
      const impact = impactRes.body?.impact;
      assert.ok(impact, "impact object returned");
      assert.equal(impact.hasImpact, false, "hasImpact false with no active work");
      assert.equal(impact.assignedClients.count, 0, "0 assigned clients");
      assert.equal(impact.openThreads.count, 0, "0 open threads");
      assert.equal(impact.upcomingBookings.count, 0, "0 upcoming bookings");

      // DELETE without ?force=true succeeds (no 409 path).
      const res = await jsonReq(baseUrl, `/api/users/${victim.id}`, "DELETE");
      assert.equal(res.status, 200, "DELETE without force → 200 when no impact");
      assert.equal(res.body?.ok, true, "response ok=true");

      const afterRow = await fetchUserRow(victim.id);
      assert.ok(afterRow, "victim row still present (soft delete)");
      assert.ok(
        afterRow!.deletedAt instanceof Date,
        "deletedAt set without needing force",
      );
      assert.equal(
        await countUserDeletedLogs(victim.id, ceo.id),
        1,
        "one user_deleted activity-log row written",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ no-impact user deletes cleanly without ?force=true");
  } finally {
    await cleanup({ userIds, clientIds: [], threadKeys: [], meetingIds: [] });
  }
}

async function main(): Promise<void> {
  await testImpactGuard();
  await testNoImpactDeletesWithoutForce();
  console.log("\nAll Task #1935 delete-impact guard tests passed ✓");
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
