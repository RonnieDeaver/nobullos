/* test-registration
{
  "name": "User reassign flow \u2014 surfaces moved + impact zeroed + log + negatives (Task #1951)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "tier": "small"
}
test-registration */
/**
 * Task #1951 — regression coverage for the Task #1934 in-dialog
 * reassignment route POST /api/users/:id/reassign.
 *
 * The reassign route is the only path that can flip a "Delete anyway"
 * warning back to "Delete user" without manually visiting each surface.
 * A regression that silently no-ops the reassignment (e.g. a change to
 * the active-client filter or the upcoming-booking status set) would let
 * the CEO believe work was handed off when it wasn't.
 *
 * Pins:
 *   (Happy path) A user owning one active client, one open thread
 *     assignment, and one future confirmed booking is reassigned to a
 *     new owner. Asserts:
 *       (a) per-surface counts in the response,
 *       (b) the underlying rows now point at the new owner,
 *       (c) the refreshed impact summary is all zeros,
 *       (d) a `user_work_reassigned` activity-log entry is written.
 *   (Negative) non-CEO → 403, target == source → 400, missing target
 *     user → 404.
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

const TAG = "task-1951";

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

async function fetchClientOwner(id: string): Promise<string | null> {
  const res: any = await db.execute(sql`SELECT owner_id FROM clients WHERE id = ${id}`);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows[0]?.owner_id ?? null;
}

async function fetchThreadAssignee(threadKey: string): Promise<string | null> {
  const res: any = await db.execute(sql`
    SELECT assigned_to_user_id FROM thread_assignments WHERE thread_key = ${threadKey}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows[0]?.assigned_to_user_id ?? null;
}

async function fetchMeetingManager(id: string): Promise<string | null> {
  const res: any = await db.execute(sql`
    SELECT account_manager_user_id FROM scheduled_meetings WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows[0]?.account_manager_user_id ?? null;
}

async function countReassignLogs(fromUserId: string, actorId: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM user_activity_logs
    WHERE action_type = 'user_work_reassigned'
      AND user_id = ${actorId}
      AND (metadata->>'fromUserId') = ${fromUserId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function fetchReassignLogMetadata(
  fromUserId: string,
  actorId: string,
): Promise<any | null> {
  const res: any = await db.execute(sql`
    SELECT metadata
    FROM user_activity_logs
    WHERE action_type = 'user_work_reassigned'
      AND user_id = ${actorId}
      AND (metadata->>'fromUserId') = ${fromUserId}
    ORDER BY timestamp DESC
    LIMIT 1
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const meta = rows[0]?.metadata ?? null;
  if (meta == null) return null;
  return typeof meta === "string" ? JSON.parse(meta) : meta;
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
      WHERE (metadata->>'fromUserId') = ANY(${lit}::text[])
         OR (metadata->>'toUserId') = ANY(${lit}::text[])
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

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function testReassignHappyPath(): Promise<void> {
  console.log("(Happy path) reassign moves all three surfaces + logs + zeroes impact");
  const userIds: string[] = [];
  const clientIds: string[] = [];
  const threadKeys: string[] = [];
  const meetingIds: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const fromUser = await seedUser({ role: "account_manager", suffix: "from" });
    const toUser = await seedUser({ role: "account_manager", suffix: "to" });
    userIds.push(ceo.id, fromUser.id, toUser.id);

    const firmName = `${TAG} Active Firm ${randomUUID()}`;
    const clientId = await seedOwnedClient(fromUser.id, firmName);
    clientIds.push(clientId);

    const threadKey = await seedOpenThreadAssignment(fromUser.id);
    threadKeys.push(threadKey);

    const meetingId = await seedUpcomingMeeting(fromUser.id, `${TAG} Invitee`);
    meetingIds.push(meetingId);

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      const res = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
        targetUserId: toUser.id,
      });
      assert.equal(res.status, 200, "reassign → 200");

      // (a) per-surface counts in the response.
      assert.ok(res.body?.result, "result object returned");
      assert.equal(res.body.result.clients, 1, "1 client reassigned");
      assert.equal(res.body.result.threads, 1, "1 thread reassigned");
      assert.equal(res.body.result.bookings, 1, "1 booking reassigned");

      // (b) the underlying rows now point at the new owner.
      assert.equal(await fetchClientOwner(clientId), toUser.id, "client owner now target");
      assert.equal(await fetchThreadAssignee(threadKey), toUser.id, "thread assignee now target");
      assert.equal(await fetchMeetingManager(meetingId), toUser.id, "meeting AM now target");

      // (c) the refreshed impact summary is all zeros for the source.
      assert.ok(res.body?.impact, "impact object returned");
      assert.equal(res.body.impact.hasImpact, false, "source has no impact after reassign");
      assert.equal(res.body.impact.assignedClients.count, 0, "0 clients left on source");
      assert.equal(res.body.impact.openThreads.count, 0, "0 open threads left on source");
      assert.equal(res.body.impact.upcomingBookings.count, 0, "0 upcoming bookings left on source");

      // (d) a `user_work_reassigned` activity-log entry is written.
      assert.equal(
        await countReassignLogs(fromUser.id, ceo.id),
        1,
        "one user_work_reassigned activity-log row written",
      );

      // (e) the log's metadata.items captures *which* exact items moved,
      // not just the numeric counts (Task #2011). A regression that drops
      // or mislabels the per-surface items would otherwise go unnoticed.
      const meta = await fetchReassignLogMetadata(fromUser.id, ceo.id);
      assert.ok(meta, "activity-log metadata read back");
      assert.ok(meta.items, "metadata.items present");

      // clients: the moved client id + its human-friendly firm-name label.
      assert.ok(Array.isArray(meta.items.clients), "items.clients is an array");
      assert.equal(meta.items.clients.length, 1, "exactly one client item recorded");
      const clientItem = meta.items.clients.find((c: any) => c.id === clientId);
      assert.ok(clientItem, "moved client id present in items.clients");
      assert.equal(clientItem.label, firmName, "client item label is the firm name");

      // threads: the moved thread key.
      assert.ok(Array.isArray(meta.items.threads), "items.threads is an array");
      assert.equal(meta.items.threads.length, 1, "exactly one thread item recorded");
      assert.ok(
        meta.items.threads.some((t: any) => t.threadKey === threadKey),
        "moved thread key present in items.threads",
      );

      // bookings: the moved booking id + a human-friendly label.
      assert.ok(Array.isArray(meta.items.bookings), "items.bookings is an array");
      assert.equal(meta.items.bookings.length, 1, "exactly one booking item recorded");
      const bookingItem = meta.items.bookings.find((b: any) => b.id === meetingId);
      assert.ok(bookingItem, "moved booking id present in items.bookings");
      assert.ok(
        typeof bookingItem.label === "string" && bookingItem.label.includes(`${TAG} Invitee`),
        "booking item label includes the invitee name",
      );

      // Items line up with the counts the response reported.
      assert.equal(
        meta.items.clients.length,
        res.body.result.clients,
        "client items length matches reported count",
      );
      assert.equal(
        meta.items.threads.length,
        res.body.result.threads,
        "thread items length matches reported count",
      );
      assert.equal(
        meta.items.bookings.length,
        res.body.result.bookings,
        "booking items length matches reported count",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ reassign moves clients/threads/bookings to target, zeroes source impact, logs the action with per-item metadata");
  } finally {
    await cleanup({ userIds, clientIds, threadKeys, meetingIds });
  }
}

async function testReassignSelectiveSurface(): Promise<void> {
  console.log("(Selective) surfaces:['clients'] moves only the client, leaves the thread");
  const userIds: string[] = [];
  const clientIds: string[] = [];
  const threadKeys: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo3" });
    const fromUser = await seedUser({ role: "account_manager", suffix: "from3" });
    const toUser = await seedUser({ role: "account_manager", suffix: "to3" });
    userIds.push(ceo.id, fromUser.id, toUser.id);

    const firmName = `${TAG} Selective Firm ${randomUUID()}`;
    const clientId = await seedOwnedClient(fromUser.id, firmName);
    clientIds.push(clientId);

    const threadKey = await seedOpenThreadAssignment(fromUser.id);
    threadKeys.push(threadKey);

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      const res = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
        targetUserId: toUser.id,
        surfaces: ["clients"],
      });
      assert.equal(res.status, 200, "selective reassign → 200");

      // Per-surface counts reflect only the requested surface.
      assert.ok(res.body?.result, "result object returned");
      assert.equal(res.body.result.clients, 1, "1 client reassigned");
      assert.equal(res.body.result.threads, 0, "0 threads reassigned (not requested)");

      // Only the client row moved; the thread assignment stayed on the source.
      assert.equal(await fetchClientOwner(clientId), toUser.id, "client owner now target");
      assert.equal(
        await fetchThreadAssignee(threadKey),
        fromUser.id,
        "thread assignee unchanged on source",
      );

      // Refreshed impact still reports the untouched open thread on the source.
      assert.ok(res.body?.impact, "impact object returned");
      assert.equal(res.body.impact.assignedClients.count, 0, "0 clients left on source");
      assert.equal(res.body.impact.openThreads.count, 1, "1 open thread still on source");

      // (Task #2027) The activity-log metadata must record *only* the surface
      // that actually moved. A regression that logs items for an unrequested
      // surface (e.g. recording threads when only clients were requested)
      // would otherwise go unnoticed.
      const meta = await fetchReassignLogMetadata(fromUser.id, ceo.id);
      assert.ok(meta, "activity-log metadata read back");

      // metadata.surfaces reflects only the requested surface.
      assert.deepEqual(meta.surfaces, ["clients"], "metadata.surfaces is only ['clients']");

      // metadata.items.clients holds the moved client (id + firm-name label).
      assert.ok(meta.items, "metadata.items present");
      assert.ok(Array.isArray(meta.items.clients), "items.clients is an array");
      assert.equal(meta.items.clients.length, 1, "exactly one client item recorded");
      const clientItem = meta.items.clients.find((c: any) => c.id === clientId);
      assert.ok(clientItem, "moved client id present in items.clients");
      assert.equal(clientItem.label, firmName, "client item label is the firm name");

      // The unrequested surfaces logged nothing — empty arrays, not the
      // source's still-open thread or any booking.
      assert.ok(Array.isArray(meta.items.threads), "items.threads is an array");
      assert.equal(meta.items.threads.length, 0, "no thread items recorded (not requested)");
      assert.ok(Array.isArray(meta.items.bookings), "items.bookings is an array");
      assert.equal(meta.items.bookings.length, 0, "no booking items recorded (not requested)");
    } finally {
      server.close();
    }

    console.log("  ✓ surfaces:['clients'] moves only the client, leaves the open thread on source, and logs only the client surface");
  } finally {
    await cleanup({ userIds, clientIds, threadKeys, meetingIds: [] });
  }
}

async function testReassignInvalidSurfaces(): Promise<void> {
  console.log("(Negative) a surfaces array with no valid entries → 400");
  const userIds: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo4" });
    const fromUser = await seedUser({ role: "account_manager", suffix: "from4" });
    const toUser = await seedUser({ role: "account_manager", suffix: "to4" });
    userIds.push(ceo.id, fromUser.id, toUser.id);

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      const res = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
        targetUserId: toUser.id,
        surfaces: ["bogus", "not-a-surface"],
      });
      assert.equal(res.status, 400, "invalid surfaces → 400");
      assert.equal(res.body?.error, "No valid surfaces requested", "plain-English error");

      // A rejected reassignment must never write an audit-log entry. A
      // regression that moved the `user_work_reassigned` write before the
      // surfaces guard (or logged a no-op) would record a phantom hand-off.
      assert.equal(
        await countReassignLogs(fromUser.id, ceo.id),
        0,
        "no user_work_reassigned row written for an invalid-surfaces rejection",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ a surfaces array with no recognised entries is rejected with 400 and logs nothing");
  } finally {
    await cleanup({ userIds, clientIds: [], threadKeys: [], meetingIds: [] });
  }
}

async function testReassignNegatives(): Promise<void> {
  console.log("(Negative) non-CEO 403, target==source 400, missing target 404");
  const userIds: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo2" });
    const nonCeo = await seedUser({ role: "account_manager", suffix: "noauth" });
    const fromUser = await seedUser({ role: "account_manager", suffix: "from2" });
    const toUser = await seedUser({ role: "account_manager", suffix: "to2" });
    userIds.push(ceo.id, nonCeo.id, fromUser.id, toUser.id);

    // Non-CEO actor is rejected by requireCeo.
    {
      const app = buildApp(nonCeo.id);
      const { server, baseUrl } = await listen(app);
      try {
        const res = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
          targetUserId: toUser.id,
        });
        assert.equal(res.status, 403, "non-CEO → 403");

        // A rejected reassignment must never write an audit-log entry. The
        // non-CEO is stopped by requireCeo before the handler runs, so no
        // `user_work_reassigned` row may exist for the would-be actor.
        assert.equal(
          await countReassignLogs(fromUser.id, nonCeo.id),
          0,
          "no user_work_reassigned row written for a non-CEO rejection",
        );
      } finally {
        server.close();
      }
    }

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      // target == source is rejected.
      const same = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
        targetUserId: fromUser.id,
      });
      assert.equal(same.status, 400, "target == source → 400");

      // The target==source guard fires before the audit-log write, so the
      // no-op hand-off must leave no `user_work_reassigned` row behind.
      assert.equal(
        await countReassignLogs(fromUser.id, ceo.id),
        0,
        "no user_work_reassigned row written for a target==source rejection",
      );

      // missing target user returns 404.
      const missing = await postJson(baseUrl, `/api/users/${fromUser.id}/reassign`, {
        targetUserId: `${TAG}-does-not-exist-${randomUUID()}`,
      });
      assert.equal(missing.status, 404, "missing target user → 404");

      // The missing-target guard also fires before the audit-log write.
      assert.equal(
        await countReassignLogs(fromUser.id, ceo.id),
        0,
        "no user_work_reassigned row written for a missing-target rejection",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ non-CEO rejected, target==source rejected, missing target 404 — and none of them log");
  } finally {
    await cleanup({ userIds, clientIds: [], threadKeys: [], meetingIds: [] });
  }
}

async function main(): Promise<void> {
  await testReassignHappyPath();
  await testReassignSelectiveSurface();
  await testReassignInvalidSurfaces();
  await testReassignNegatives();
  console.log("\nAll Task #1951 reassign-flow tests passed ✓");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {
    // This suite imports server/db (api/worker/probe pools), whose open
    // handles keep the event loop alive after main() resolves — the
    // process would otherwise hang until the harness SIGTERMs it at the
    // timeout and records the (passing) suite as a failure. Exit cleanly.
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
