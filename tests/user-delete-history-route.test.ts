/* test-registration
{
  "name": "User delete-history route \u2014 keying + ordering + actor JOIN + priorEmail + CEO gate (Task #1942)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1942 — regression coverage for GET /api/users/delete-history
 * (Task #1912). This endpoint is the only source of truth for the User
 * Management delete/restore audit popover and the "Deleted by …" line,
 * so a silent regression (metadata key rename, JOIN drift, array-binding
 * bug, CEO-gate slip) would empty the UI without anyone noticing.
 *
 * Layers pinned here:
 *
 *   (A) Happy path:
 *         - Seeds a deleted user, a restored user, and a third user
 *           with multiple delete/restore cycles.
 *         - Asserts the route returns history keyed by target user id,
 *           that each target's events are newest-first, that the actor
 *           display name resolves via the `users` JOIN, and that
 *           `priorEmail` is populated for restore events.
 *
 *   (B) Auth gating:
 *         - 401 for unauthenticated callers.
 *         - 403 for authenticated non-CEO callers.
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

const TAG = "task-1942";

interface SeededUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

async function seedUser(opts: {
  role: string;
  suffix: string;
  firstName?: string;
  lastName?: string;
}): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = `${id}@test.example`;
  const firstName = opts.firstName ?? `${TAG}-${opts.suffix}`;
  const lastName = opts.lastName ?? "User";
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${firstName}, ${lastName},
            ${opts.role}, ${opts.role === "ceo" ? "ceo" : "core"})
  `);
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

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db.execute(sql`
    DELETE FROM user_activity_logs
    WHERE (metadata->>'targetUserId') = ANY(${literal}::text[])
       OR user_id = ANY(${literal}::text[])
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`);
}

type AuthMode = "anon" | { userId: string };

function buildApp(mode: AuthMode): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
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
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Happy path: events keyed by target, newest-first, actor JOIN, priorEmail
// ─────────────────────────────────────────────────────────────────────────────

async function testHappyPath(): Promise<void> {
  console.log("(A) GET /api/users/delete-history — keying, ordering, actor JOIN, priorEmail");

  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo", firstName: "Cleo", lastName: "Boss" });
    const actor = await seedUser({
      role: "account_manager",
      suffix: "actor",
      firstName: "Audra",
      lastName: "Actor",
    });
    const deletedUser = await seedUser({ role: "account_manager", suffix: "del" });
    const restoredUser = await seedUser({ role: "account_manager", suffix: "rest" });
    const cyclingUser = await seedUser({ role: "account_manager", suffix: "cyc" });
    const noisyOther = await seedUser({ role: "account_manager", suffix: "noise" });
    created.push(
      ceo.id, actor.id,
      deletedUser.id, restoredUser.id, cyclingUser.id, noisyOther.id,
    );

    const t0 = new Date("2026-01-01T00:00:00Z");
    const mins = (n: number) => new Date(t0.getTime() + n * 60_000);

    // deletedUser: one user_deleted event only.
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: deletedUser.id,
      timestamp: mins(10),
    });

    // restoredUser: deleted, then restored (with priorEmail).
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

    // cyclingUser: two full delete/restore cycles, inserted out-of-order
    // so the route's ORDER BY is exercised — not just the insertion order.
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

    // noisyOther: has delete/restore events too — must NOT appear in the
    // response when the caller scopes `ids` to the three target users.
    await insertEvent({
      actorId: actor.id,
      actionType: "user_deleted",
      targetUserId: noisyOther.id,
      timestamp: mins(60),
    });

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    let body: any;
    try {
      const ids = [deletedUser.id, restoredUser.id, cyclingUser.id].join(",");
      const r = await httpJson(baseUrl, `/api/users/delete-history?ids=${encodeURIComponent(ids)}`);
      assert.equal(r.status, 200, "CEO call → 200");
      body = r.body;
    } finally {
      server.close();
    }

    assert.equal(typeof body, "object", "body is a JSON object");
    assert.ok(!Array.isArray(body), "body is not an array");

    // Scoped `ids` must filter out the unrelated noisyOther target.
    assert.ok(!(noisyOther.id in body), "noisyOther not present when not requested");

    // deletedUser → exactly one user_deleted event with actor JOIN'd.
    const delEvents = body[deletedUser.id];
    assert.ok(Array.isArray(delEvents) && delEvents.length === 1, "deletedUser has 1 event");
    assert.equal(delEvents[0].actionType, "user_deleted", "event is user_deleted");
    assert.equal(delEvents[0].actorId, actor.id, "actorId matches inserter");
    assert.equal(
      delEvents[0].actorName,
      `${actor.firstName} ${actor.lastName}`,
      "actorName resolved via users JOIN (first + last)",
    );
    assert.equal(delEvents[0].priorEmail, null, "priorEmail null for delete event");

    // restoredUser → 2 events, restore newest, priorEmail populated on restore.
    const restEvents = body[restoredUser.id];
    assert.ok(Array.isArray(restEvents) && restEvents.length === 2, "restoredUser has 2 events");
    assert.equal(restEvents[0].actionType, "user_restored", "newest is the restore");
    assert.equal(restEvents[1].actionType, "user_deleted", "older is the delete");
    assert.equal(
      restEvents[0].actorName,
      `${ceo.firstName} ${ceo.lastName}`,
      "restore actorName resolved (CEO)",
    );
    assert.equal(
      restEvents[0].priorEmail,
      `${restoredUser.email}.deleted.1700000000000`,
      "priorEmail populated on restore event",
    );
    assert.equal(restEvents[1].priorEmail, null, "priorEmail null on delete event");
    assert.ok(
      new Date(restEvents[0].timestamp).getTime() >
        new Date(restEvents[1].timestamp).getTime(),
      "restore timestamp > delete timestamp (newest first)",
    );

    // cyclingUser → 4 events, strictly descending by timestamp regardless
    // of insertion order. Expected order: 80m(restore) > 70m(delete)
    // > 50m(restore) > 40m(delete).
    const cycEvents = body[cyclingUser.id];
    assert.ok(Array.isArray(cycEvents) && cycEvents.length === 4, "cyclingUser has 4 events");
    const types = cycEvents.map((e: any) => e.actionType);
    assert.deepEqual(
      types,
      ["user_restored", "user_deleted", "user_restored", "user_deleted"],
      "cycling events ordered newest-first regardless of insertion order",
    );
    for (let i = 1; i < cycEvents.length; i++) {
      assert.ok(
        new Date(cycEvents[i - 1].timestamp).getTime() >
          new Date(cycEvents[i].timestamp).getTime(),
        `cycling event ${i - 1} timestamp > event ${i} timestamp`,
      );
    }
    // priorEmail only on the two restore events, and matches what was written.
    assert.equal(
      cycEvents[0].priorEmail,
      `${cyclingUser.email}.deleted.1700000002000`,
      "newest restore priorEmail matches",
    );
    assert.equal(cycEvents[1].priorEmail, null, "delete priorEmail null");
    assert.equal(
      cycEvents[2].priorEmail,
      `${cyclingUser.email}.deleted.1700000001000`,
      "older restore priorEmail matches",
    );
    assert.equal(cycEvents[3].priorEmail, null, "oldest delete priorEmail null");

    console.log("  ✓ events keyed by target, newest-first, actorName JOIN, priorEmail populated");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) CEO-only gating: 401 anon, 403 non-CEO
// ─────────────────────────────────────────────────────────────────────────────

async function testAuthGating(): Promise<void> {
  console.log("(B) GET /api/users/delete-history — 401 anon, 403 non-CEO");

  const created: string[] = [];
  try {
    const am = await seedUser({ role: "account_manager", suffix: "am" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim" });
    created.push(am.id, victim.id);

    await insertEvent({
      actorId: am.id,
      actionType: "user_deleted",
      targetUserId: victim.id,
      timestamp: new Date("2026-01-01T00:00:00Z"),
    });

    // Anonymous → 401, no body leak of history.
    {
      const app = buildApp("anon");
      const { server, baseUrl } = await listen(app);
      try {
        const r = await httpJson(
          baseUrl,
          `/api/users/delete-history?ids=${encodeURIComponent(victim.id)}`,
        );
        assert.equal(r.status, 401, "anon → 401");
        assert.ok(
          !(r.body && typeof r.body === "object" && victim.id in r.body),
          "anon body must not contain history",
        );
      } finally {
        server.close();
      }
    }

    // Authenticated non-CEO → 403.
    {
      const app = buildApp({ userId: am.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await httpJson(
          baseUrl,
          `/api/users/delete-history?ids=${encodeURIComponent(victim.id)}`,
        );
        assert.equal(r.status, 403, "non-CEO → 403");
        assert.ok(
          !(r.body && typeof r.body === "object" && victim.id in r.body),
          "non-CEO body must not contain history",
        );
      } finally {
        server.close();
      }
    }

    console.log("  ✓ 401 for anon, 403 for non-CEO");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testHappyPath();
  await testAuthGating();
  console.log("user-delete-history-route: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-delete-history-route: FAILED");
  console.error(err);
  process.exitCode = 1;
});
