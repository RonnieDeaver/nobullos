/* test-registration
{
  "name": "User reassign-history route \u2014 out/in keying + shared mapper parity + CEO gate (Task #1999)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1999 — regression coverage for GET /api/users/reassign-history
 * (Tasks #1950 / #1981). This endpoint feeds both the deleted-users
 * panel ("what this user shed" — the default `out` direction, keyed by
 * source user) and the active-user Reassignments popover ("what this
 * user inherited" — `direction=in`, keyed by destination user). The two
 * directions read the SAME `user_work_reassigned` audit rows through one
 * shared row-mapper; only the metadata key used for filtering and
 * bucketing differs. A silent regression (metadata key rename, mapper
 * drift, direction routing slip, CEO-gate slip) would empty one or both
 * UIs without anyone noticing.
 *
 * Layers pinned here:
 *
 *   (A) Out direction (default):
 *         - Seeds `user_work_reassigned` rows and asserts the route keys
 *           events by source user (`fromUserId`), newest-first, with the
 *           actor display name resolved via the `users` JOIN and the
 *           counts / items payload preserved.
 *
 *   (B) In direction (`?direction=in`):
 *         - Asserts the same audit rows are bucketed by destination user
 *           (`toUserId`) and that the per-event shape is identical to the
 *           out direction (shared mapper) — same counts, same items.
 *
 *   (C) Auth gating:
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

const TAG = "task-1999";

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

interface ReassignMeta {
  fromUserId: string;
  fromUserName?: string | null;
  toUserId: string;
  toUserName?: string | null;
  counts: { clients: number; threads: number; bookings: number };
  items: {
    clients: { id: string; label: string }[];
    threads: { threadKey: string }[];
    bookings: { id: string; label: string; startTimeUtc: string }[];
  };
}

async function insertReassignEvent(opts: {
  actorId: string | null;
  meta: ReassignMeta;
  timestamp: Date;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_activity_logs (user_id, action_type, route, action_detail, metadata, timestamp)
    VALUES (
      ${opts.actorId},
      'user_work_reassigned',
      '/admin/users',
      ${`reassigned ${opts.meta.fromUserId} -> ${opts.meta.toUserId}`},
      ${JSON.stringify(opts.meta)}::jsonb,
      ${opts.timestamp.toISOString()}::timestamp
    )
  `);
}

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db.execute(sql`
    DELETE FROM user_activity_logs
    WHERE (metadata->>'fromUserId') = ANY(${literal}::text[])
       OR (metadata->>'toUserId') = ANY(${literal}::text[])
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

function assertEventShape(
  ev: any,
  expected: { actorId: string; actorName: string; meta: ReassignMeta },
  label: string,
): void {
  assert.equal(ev.actorId, expected.actorId, `${label}: actorId`);
  assert.equal(ev.actorName, expected.actorName, `${label}: actorName via users JOIN`);
  assert.equal(ev.fromUserId, expected.meta.fromUserId, `${label}: fromUserId`);
  assert.equal(ev.fromUserName, expected.meta.fromUserName ?? null, `${label}: fromUserName`);
  assert.equal(ev.toUserId, expected.meta.toUserId, `${label}: toUserId`);
  assert.equal(ev.toUserName, expected.meta.toUserName ?? null, `${label}: toUserName`);
  assert.deepEqual(ev.counts, expected.meta.counts, `${label}: counts`);
  assert.deepEqual(ev.items, expected.meta.items, `${label}: items`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture: three reassignment events.
//   - sam → alex (newest)
//   - sam → jordan
//   - pat → alex (oldest)
// "out" keyed by source: sam has 2 events, pat has 1.
// "in"  keyed by destination: alex has 2 events, jordan has 1.
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  ceo: SeededUser;
  actor: SeededUser;
  sam: SeededUser;
  pat: SeededUser;
  alex: SeededUser;
  jordan: SeededUser;
  metaSamAlex: ReassignMeta;
  metaSamJordan: ReassignMeta;
  metaPatAlex: ReassignMeta;
  allIds: string[];
}

async function seedFixture(): Promise<Fixture> {
  const ceo = await seedUser({ role: "ceo", suffix: "ceo", firstName: "Cleo", lastName: "Boss" });
  const actor = await seedUser({ role: "account_manager", suffix: "actor", firstName: "Audra", lastName: "Actor" });
  const sam = await seedUser({ role: "account_manager", suffix: "sam", firstName: "Sam", lastName: "Source" });
  const pat = await seedUser({ role: "account_manager", suffix: "pat", firstName: "Pat", lastName: "Source" });
  const alex = await seedUser({ role: "account_manager", suffix: "alex", firstName: "Alex", lastName: "Dest" });
  const jordan = await seedUser({ role: "account_manager", suffix: "jordan", firstName: "Jordan", lastName: "Dest" });

  const t0 = new Date("2026-01-01T00:00:00Z");
  const mins = (n: number) => new Date(t0.getTime() + n * 60_000);

  const metaSamAlex: ReassignMeta = {
    fromUserId: sam.id,
    fromUserName: "Sam Source",
    toUserId: alex.id,
    toUserName: "Alex Dest",
    counts: { clients: 2, threads: 1, bookings: 1 },
    items: {
      clients: [
        { id: "c1", label: "Acme Co" },
        { id: "c2", label: "Beta LLC" },
      ],
      threads: [{ threadKey: "thread:abc" }],
      bookings: [{ id: "b1", label: "Intro call", startTimeUtc: "2026-02-01T15:00:00Z" }],
    },
  };
  const metaSamJordan: ReassignMeta = {
    fromUserId: sam.id,
    fromUserName: "Sam Source",
    toUserId: jordan.id,
    toUserName: "Jordan Dest",
    counts: { clients: 1, threads: 0, bookings: 0 },
    items: {
      clients: [{ id: "c3", label: "Gamma Inc" }],
      threads: [],
      bookings: [],
    },
  };
  const metaPatAlex: ReassignMeta = {
    fromUserId: pat.id,
    fromUserName: "Pat Source",
    toUserId: alex.id,
    toUserName: "Alex Dest",
    counts: { clients: 0, threads: 2, bookings: 0 },
    items: {
      clients: [],
      threads: [{ threadKey: "thread:xyz" }, { threadKey: "thread:qrs" }],
      bookings: [],
    },
  };

  // Insert out-of-order so the route's ORDER BY is exercised.
  await insertReassignEvent({ actorId: actor.id, meta: metaPatAlex, timestamp: mins(10) }); // oldest
  await insertReassignEvent({ actorId: ceo.id, meta: metaSamAlex, timestamp: mins(30) }); // newest
  await insertReassignEvent({ actorId: actor.id, meta: metaSamJordan, timestamp: mins(20) });

  return {
    ceo, actor, sam, pat, alex, jordan,
    metaSamAlex, metaSamJordan, metaPatAlex,
    allIds: [ceo.id, actor.id, sam.id, pat.id, alex.id, jordan.id],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Out direction (default): keyed by source user, newest-first, actor JOIN.
// ─────────────────────────────────────────────────────────────────────────────

async function testOutDirection(): Promise<void> {
  console.log("(A) GET /api/users/reassign-history — default 'out' keyed by source user");

  const created: string[] = [];
  try {
    const f = await seedFixture();
    created.push(...f.allIds);

    const app = buildApp({ userId: f.ceo.id });
    const { server, baseUrl } = await listen(app);
    let body: any;
    try {
      const ids = [f.sam.id, f.pat.id, f.alex.id, f.jordan.id].join(",");
      const r = await httpJson(baseUrl, `/api/users/reassign-history?ids=${encodeURIComponent(ids)}`);
      assert.equal(r.status, 200, "CEO call → 200");
      body = r.body;
    } finally {
      server.close();
    }

    assert.equal(typeof body, "object", "body is a JSON object");
    assert.ok(!Array.isArray(body), "body is not an array");

    // Keyed by source user: sam has 2 events, pat has 1. alex/jordan are
    // destinations only → must NOT appear as out-direction keys.
    assert.ok(!(f.alex.id in body), "destination alex not a key in out direction");
    assert.ok(!(f.jordan.id in body), "destination jordan not a key in out direction");

    const samEvents = body[f.sam.id];
    assert.ok(Array.isArray(samEvents) && samEvents.length === 2, "sam has 2 out events");
    // Newest-first: sam→alex (30m) before sam→jordan (20m).
    assert.equal(samEvents[0].toUserId, f.alex.id, "newest sam event is sam→alex");
    assert.equal(samEvents[1].toUserId, f.jordan.id, "older sam event is sam→jordan");
    assert.ok(
      new Date(samEvents[0].timestamp).getTime() > new Date(samEvents[1].timestamp).getTime(),
      "sam events newest-first",
    );
    assertEventShape(samEvents[0], { actorId: f.ceo.id, actorName: "Cleo Boss", meta: f.metaSamAlex }, "sam→alex");
    assertEventShape(samEvents[1], { actorId: f.actor.id, actorName: "Audra Actor", meta: f.metaSamJordan }, "sam→jordan");

    const patEvents = body[f.pat.id];
    assert.ok(Array.isArray(patEvents) && patEvents.length === 1, "pat has 1 out event");
    assertEventShape(patEvents[0], { actorId: f.actor.id, actorName: "Audra Actor", meta: f.metaPatAlex }, "pat→alex");

    console.log("  ✓ out direction keyed by source, newest-first, actor JOIN, counts/items preserved");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) In direction: keyed by destination user, identical per-event shape.
// ─────────────────────────────────────────────────────────────────────────────

async function testInDirection(): Promise<void> {
  console.log("(B) GET /api/users/reassign-history?direction=in — keyed by destination user");

  const created: string[] = [];
  try {
    const f = await seedFixture();
    created.push(...f.allIds);

    const app = buildApp({ userId: f.ceo.id });
    const { server, baseUrl } = await listen(app);
    let inBody: any;
    let outBody: any;
    try {
      const ids = [f.sam.id, f.pat.id, f.alex.id, f.jordan.id].join(",");
      const rIn = await httpJson(
        baseUrl,
        `/api/users/reassign-history?direction=in&ids=${encodeURIComponent(ids)}`,
      );
      assert.equal(rIn.status, 200, "CEO call (in) → 200");
      inBody = rIn.body;
      const rOut = await httpJson(baseUrl, `/api/users/reassign-history?ids=${encodeURIComponent(ids)}`);
      assert.equal(rOut.status, 200, "CEO call (out) → 200");
      outBody = rOut.body;
    } finally {
      server.close();
    }

    // Keyed by destination: alex has 2 events, jordan has 1. sam/pat are
    // sources only → must NOT appear as in-direction keys.
    assert.ok(!(f.sam.id in inBody), "source sam not a key in in direction");
    assert.ok(!(f.pat.id in inBody), "source pat not a key in in direction");

    const alexEvents = inBody[f.alex.id];
    assert.ok(Array.isArray(alexEvents) && alexEvents.length === 2, "alex has 2 in events");
    // Newest-first: sam→alex (30m) before pat→alex (10m).
    assert.equal(alexEvents[0].fromUserId, f.sam.id, "newest alex event is sam→alex");
    assert.equal(alexEvents[1].fromUserId, f.pat.id, "older alex event is pat→alex");
    assert.ok(
      new Date(alexEvents[0].timestamp).getTime() > new Date(alexEvents[1].timestamp).getTime(),
      "alex events newest-first",
    );
    assertEventShape(alexEvents[0], { actorId: f.ceo.id, actorName: "Cleo Boss", meta: f.metaSamAlex }, "in:sam→alex");
    assertEventShape(alexEvents[1], { actorId: f.actor.id, actorName: "Audra Actor", meta: f.metaPatAlex }, "in:pat→alex");

    const jordanEvents = inBody[f.jordan.id];
    assert.ok(Array.isArray(jordanEvents) && jordanEvents.length === 1, "jordan has 1 in event");
    assertEventShape(jordanEvents[0], { actorId: f.actor.id, actorName: "Audra Actor", meta: f.metaSamJordan }, "in:sam→jordan");

    // Shared row-mapper parity: the sam→alex event must be byte-identical
    // (same counts/items/actor) whether reached via the out bucket (sam)
    // or the in bucket (alex). Only the bucketing key differs.
    const outSamAlex = outBody[f.sam.id].find((e: any) => e.toUserId === f.alex.id);
    const inSamAlex = inBody[f.alex.id].find((e: any) => e.fromUserId === f.sam.id);
    assert.ok(outSamAlex && inSamAlex, "sam→alex reachable from both directions");
    assert.deepEqual(
      inSamAlex,
      outSamAlex,
      "shared mapper: identical event object regardless of direction",
    );

    console.log("  ✓ in direction keyed by destination; shared mapper yields identical event shape");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (C) CEO-only gating: 401 anon, 403 non-CEO (both directions).
// ─────────────────────────────────────────────────────────────────────────────

async function testAuthGating(): Promise<void> {
  console.log("(C) GET /api/users/reassign-history — 401 anon, 403 non-CEO");

  const created: string[] = [];
  try {
    const am = await seedUser({ role: "account_manager", suffix: "am" });
    const dest = await seedUser({ role: "account_manager", suffix: "dest" });
    created.push(am.id, dest.id);

    await insertReassignEvent({
      actorId: am.id,
      meta: {
        fromUserId: am.id,
        fromUserName: "AM Source",
        toUserId: dest.id,
        toUserName: "Dest User",
        counts: { clients: 1, threads: 0, bookings: 0 },
        items: { clients: [{ id: "c9", label: "Secret Co" }], threads: [], bookings: [] },
      },
      timestamp: new Date("2026-01-01T00:00:00Z"),
    });

    for (const dir of ["", "?direction=in"] as const) {
      // Anonymous → 401, no history leak.
      {
        const app = buildApp("anon");
        const { server, baseUrl } = await listen(app);
        try {
          const sep = dir ? "&" : "?";
          const r = await httpJson(
            baseUrl,
            `/api/users/reassign-history${dir}${sep}ids=${encodeURIComponent([am.id, dest.id].join(","))}`,
          );
          assert.equal(r.status, 401, `anon → 401 (${dir || "out"})`);
          assert.ok(
            !(r.body && typeof r.body === "object" && (am.id in r.body || dest.id in r.body)),
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
          const sep = dir ? "&" : "?";
          const r = await httpJson(
            baseUrl,
            `/api/users/reassign-history${dir}${sep}ids=${encodeURIComponent([am.id, dest.id].join(","))}`,
          );
          assert.equal(r.status, 403, `non-CEO → 403 (${dir || "out"})`);
          assert.ok(
            !(r.body && typeof r.body === "object" && (am.id in r.body || dest.id in r.body)),
            "non-CEO body must not contain history",
          );
        } finally {
          server.close();
        }
      }
    }

    console.log("  ✓ 401 for anon, 403 for non-CEO (both directions)");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testOutDirection();
  await testInDirection();
  await testAuthGating();
  console.log("user-reassign-history-route: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-reassign-history-route: FAILED");
  console.error(err);
  process.exitCode = 1;
});
