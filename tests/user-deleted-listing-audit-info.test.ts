/* test-registration
{
  "name": "Deleted Users listing audit info (Task #1898 / #1939)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1939 — regression coverage for the Deleted Users audit info.
 *
 * Task #1898 added "Deleted <relative time> by <actor>" to each row in
 * the CEO-only Deleted Users card by joining `users` against the most
 * recent `user_deleted` row in `user_activity_logs`. This test pins:
 *
 *   (A) A user soft-deleted via DELETE /api/users/:id (which writes the
 *       `user_deleted` activity-log row) shows up in both
 *       `storage.listDeletedUsers()` and `GET /api/users/deleted` with
 *       the correct `deletedByUserId`, `deletedByName`, `deletedByEmail`
 *       and `deletedAt`.
 *
 *   (B) A user with `deleted_at` set but no matching activity-log row
 *       still appears in the listing with `deletedByUserId`,
 *       `deletedByName`, `deletedByEmail` all null (fallback path,
 *       does not break the response).
 *
 *   (C) Delete → restore → re-delete by a different actor: the listing
 *       reports the most recent actor (DISTINCT ON the target id,
 *       ORDER BY timestamp DESC).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerSettingsRoutes } from "../server/routes/settings";
import {
  deleteUser as storageDeleteUser,
  restoreUser as storageRestoreUser,
} from "../server/storage/clientStorage";

const TAG = "task-1939";

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

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db.execute(sql`
    DELETE FROM sessions
    WHERE sess->'passport'->'user'->'claims'->>'sub' = ANY(${literal}::text[])
  `);
  await db.execute(sql`
    DELETE FROM user_activity_logs
    WHERE (metadata->>'targetUserId') = ANY(${literal}::text[])
       OR user_id = ANY(${literal}::text[])
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`);
}

function buildApp(actorUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. requireAuth loads the committed users
    // row and populates req.user.claims.sub itself.
    (req as any).__test_clerkUserId = actorUserId;
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

async function del(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function findRow(rows: any[], id: string): any {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, `row for ${id} present in listing`);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Enriched fields flow through the full stack
// ─────────────────────────────────────────────────────────────────────────────

async function testEnrichedFieldsHappyPath(): Promise<void> {
  console.log("(A) enriched deletedBy* fields flow through listDeletedUsers + GET /api/users/deleted");
  const created: string[] = [];
  try {
    const ceo = await seedUser({
      role: "ceo",
      suffix: "ceo-actor",
      firstName: "Casey",
      lastName: "Officer",
    });
    const victim = await seedUser({ role: "account_manager", suffix: "victim-a" });
    created.push(ceo.id, victim.id);

    const tStart = Date.now();

    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      // Route-driven delete is what produces the `user_deleted`
      // activity-log row the listing joins against.
      const r = await del(baseUrl, `/api/users/${victim.id}`);
      assert.equal(r.status, 200, "DELETE /api/users/:id → 200");

      // Storage layer
      const storageRows = await storage.listDeletedUsers();
      const sRow = findRow(storageRows, victim.id);
      assert.equal(sRow.deletedByUserId, ceo.id, "storage: deletedByUserId is the CEO");
      assert.equal(sRow.deletedByName, "Casey Officer", "storage: deletedByName is the CEO's full name");
      assert.equal(sRow.deletedByEmail, ceo.email, "storage: deletedByEmail is the CEO's email");
      assert.ok(sRow.deletedAt, "storage: deletedAt present");
      const sDeletedAt = new Date(sRow.deletedAt).getTime();
      assert.ok(
        sDeletedAt >= tStart - 5_000 && sDeletedAt <= Date.now() + 5_000,
        "storage: deletedAt is around now",
      );

      // HTTP route
      const listResp = await getJson(baseUrl, "/api/users/deleted");
      assert.equal(listResp.status, 200, "GET /api/users/deleted → 200");
      assert.ok(Array.isArray(listResp.body), "response body is an array");
      const rRow = findRow(listResp.body, victim.id);
      assert.equal(rRow.deletedByUserId, ceo.id, "route: deletedByUserId is the CEO");
      assert.equal(rRow.deletedByName, "Casey Officer", "route: deletedByName is the CEO's full name");
      assert.equal(rRow.deletedByEmail, ceo.email, "route: deletedByEmail is the CEO's email");
      assert.ok(rRow.deletedAt, "route: deletedAt present in JSON response");
    } finally {
      server.close();
    }

    console.log("  ✓ deletedByUserId/Name/Email/deletedAt populated end-to-end");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Fallback when there is no matching activity-log row
// ─────────────────────────────────────────────────────────────────────────────

async function testNoAuditRowFallback(): Promise<void> {
  console.log("(B) missing activity-log row → nulls, listing still well-formed");
  const created: string[] = [];
  try {
    const id = `${TAG}-orphan-${randomUUID()}`;
    const email = `${id}@test.example`;
    // Insert directly with `deleted_at` set, NO matching `user_deleted`
    // activity-log row — mirrors older deletions written before Task
    // #1898's metadata.targetUserId enrichment existed.
    await db.execute(sql`
      INSERT INTO users (id, email, first_name, last_name, role, authority_level, deleted_at)
      VALUES (${id}, ${email}, ${`${TAG}-orphan`}, 'User',
              'account_manager', 'core', NOW())
    `);
    created.push(id);

    const storageRows = await storage.listDeletedUsers();
    const sRow = findRow(storageRows, id);
    assert.equal(sRow.deletedByUserId, null, "deletedByUserId is null");
    assert.equal(sRow.deletedByName, null, "deletedByName is null");
    assert.equal(sRow.deletedByEmail, null, "deletedByEmail is null");
    assert.ok(sRow.deletedAt, "deletedAt still surfaces");
    // The base user fields must still be intact.
    assert.equal(sRow.id, id, "row id intact");
    assert.equal(sRow.email, email, "row email intact");

    // The route must also return the row without erroring.
    const ceo = await seedUser({ role: "ceo", suffix: "ceo-fallback" });
    created.push(ceo.id);
    const app = buildApp(ceo.id);
    const { server, baseUrl } = await listen(app);
    try {
      const listResp = await getJson(baseUrl, "/api/users/deleted");
      assert.equal(listResp.status, 200, "GET /api/users/deleted → 200");
      const rRow = findRow(listResp.body, id);
      assert.equal(rRow.deletedByUserId, null, "route: deletedByUserId null");
      assert.equal(rRow.deletedByName, null, "route: deletedByName null");
      assert.equal(rRow.deletedByEmail, null, "route: deletedByEmail null");
    } finally {
      server.close();
    }

    console.log("  ✓ missing audit row → all actor fields null, listing unaffected");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (C) DISTINCT ON picks the most recent actor after restore + re-delete
// ─────────────────────────────────────────────────────────────────────────────

async function testMostRecentActorAfterRestore(): Promise<void> {
  console.log("(C) delete → restore → re-delete: listing reports the latest actor");
  const created: string[] = [];
  try {
    const ceo1 = await seedUser({
      role: "ceo",
      suffix: "ceo-first",
      firstName: "First",
      lastName: "Chief",
    });
    const ceo2 = await seedUser({
      role: "ceo",
      suffix: "ceo-second",
      firstName: "Second",
      lastName: "Chief",
    });
    const victim = await seedUser({ role: "account_manager", suffix: "victim-c" });
    created.push(ceo1.id, ceo2.id, victim.id);

    // First delete — by ceo1, via the route so the activity log row
    // mirrors production.
    {
      const app = buildApp(ceo1.id);
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${victim.id}`);
        assert.equal(r.status, 200, "first DELETE → 200");
      } finally {
        server.close();
      }
    }

    // Restore so we can delete again.
    const restored = await storageRestoreUser(victim.id);
    assert.ok(restored, "restoreUser returns the row");

    // Force the second activity-log row to have a strictly later
    // timestamp so the DISTINCT ON … ORDER BY timestamp DESC tiebreak
    // is unambiguous (the two route DELETEs can otherwise land in the
    // same millisecond).
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Second delete — by ceo2.
    {
      const app = buildApp(ceo2.id);
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${victim.id}`);
        assert.equal(r.status, 200, "second DELETE → 200");
      } finally {
        server.close();
      }
    }

    // Listing must show ceo2 as the actor (DISTINCT ON target,
    // ORDER BY timestamp DESC).
    const storageRows = await storage.listDeletedUsers();
    const sRow = findRow(storageRows, victim.id);
    assert.equal(sRow.deletedByUserId, ceo2.id, "latest actor wins (storage)");
    assert.equal(sRow.deletedByName, "Second Chief", "latest actor name (storage)");
    assert.equal(sRow.deletedByEmail, ceo2.email, "latest actor email (storage)");

    // And sanity-check the same via the HTTP route as well.
    const app = buildApp(ceo2.id);
    const { server, baseUrl } = await listen(app);
    try {
      const listResp = await getJson(baseUrl, "/api/users/deleted");
      assert.equal(listResp.status, 200, "GET /api/users/deleted → 200");
      const rRow = findRow(listResp.body, victim.id);
      assert.equal(rRow.deletedByUserId, ceo2.id, "latest actor wins (route)");
      assert.equal(rRow.deletedByName, "Second Chief", "latest actor name (route)");
      assert.equal(rRow.deletedByEmail, ceo2.email, "latest actor email (route)");
    } finally {
      server.close();
    }

    console.log("  ✓ most-recent user_deleted row wins after restore + re-delete");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testEnrichedFieldsHappyPath();
  await testNoAuditRowFallback();
  await testMostRecentActorAfterRestore();
  console.log("user-deleted-listing-audit-info: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-deleted-listing-audit-info: FAILED");
  console.error(err);
  process.exitCode = 1;
});
