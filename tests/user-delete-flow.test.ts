/* test-registration
{
  "name": "User delete flow \u2014 storage + route + revocation gate (Task #1871)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1871 — regression coverage for the user delete flow.
 *
 * Three layers are pinned here so a future change cannot quietly
 * regress any of them:
 *
 *   (A) Storage-level deleteUser:
 *         - row gets deletedAt + email suffix
 *         - matching `sessions` rows are removed in the same tx
 *         - a second call is idempotent (no error, no double-suffix)
 *
 *   (B) Route-level DELETE /api/users/:id:
 *         - 403 for non-CEO
 *         - 400 for self-delete
 *         - 404 for unknown
 *         - 200 + `user_deleted` activity-log row on success
 *
 *   (C) Auth layer isClaimsSubRevoked:
 *         - returns false for a live user
 *         - returns true after soft-delete (the gate that stops the
 *           OIDC `verify` callback from upserting a revoked sub back
 *           into existence)
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
import { __test_isClaimsSubRevoked } from "../server/middlewares/requireAuth";
import {
  deleteUser as storageDeleteUser,
  restoreUser as storageRestoreUser,
  RestoreEmailConflictError,
} from "../server/storage/clientStorage";

const TAG = "task-1871";

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

async function seedSession(userId: string): Promise<string> {
  const sid = `${TAG}-sess-${randomUUID()}`;
  const sess = {
    cookie: {},
    passport: { user: { claims: { sub: userId } } },
  };
  await db.execute(sql`
    INSERT INTO sessions (sid, sess, expire)
    VALUES (${sid}, ${JSON.stringify(sess)}::jsonb, NOW() + INTERVAL '1 hour')
  `);
  return sid;
}

async function countSessionsForUser(userId: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM sessions
    WHERE sess->'passport'->'user'->'claims'->>'sub' = ${userId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function fetchUserRow(id: string): Promise<{
  email: string | null;
  deletedAt: Date | null;
} | undefined> {
  const res: any = await db.execute(sql`
    SELECT email, deleted_at FROM users WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  if (!rows[0]) return undefined;
  return {
    email: rows[0].email as string | null,
    deletedAt: rows[0].deleted_at ? new Date(rows[0].deleted_at as string) : null,
  };
}

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  // Clean dependent rows that route handlers / sessions may have
  // written for these synthetic users.
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

type AuthMode = "anon" | { userId: string };

function buildApp(mode: AuthMode): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    // requireAuth loads the committed users row and populates
    // req.user.claims.sub itself.
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

async function del(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function post(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method: "POST" });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
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

async function countUserRestoredLogs(targetId: string, actorId: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM user_activity_logs
    WHERE action_type = 'user_restored'
      AND user_id = ${actorId}
      AND (metadata->>'targetUserId') = ${targetId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Storage-level deleteUser
// ─────────────────────────────────────────────────────────────────────────────

async function testStorageDeleteUser(): Promise<void> {
  console.log("(A) storage.deleteUser");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "storage" });
    created.push(user.id);
    await seedSession(user.id);
    await seedSession(user.id);
    assert.equal(await countSessionsForUser(user.id), 2, "two sessions seeded");

    const first = await storageDeleteUser(user.id);
    assert.ok(first, "first deleteUser returns a row");
    assert.ok(first!.deletedAt instanceof Date, "deletedAt set after first call");
    assert.ok(
      typeof first!.email === "string" && first!.email!.startsWith(`${user.email}.deleted.`),
      `email suffixed (got ${first!.email})`,
    );

    const row = await fetchUserRow(user.id);
    assert.ok(row, "row still present (soft delete, not hard delete)");
    assert.ok(row!.deletedAt instanceof Date, "deletedAt persisted to DB");
    assert.ok(
      row!.email && row!.email.startsWith(`${user.email}.deleted.`),
      "email suffix persisted to DB",
    );

    assert.equal(
      await countSessionsForUser(user.id),
      0,
      "sessions purged in the same transaction",
    );

    const emailAfterFirst = first!.email;
    const deletedAtAfterFirst = (first!.deletedAt as Date).toISOString();

    // Idempotency — calling again must NOT re-suffix the email (which
    // would produce `…deleted.<t1>.deleted.<t2>`) and must NOT throw.
    const second = await storageDeleteUser(user.id);
    assert.ok(second, "second deleteUser still returns the existing row");
    assert.equal(second!.email, emailAfterFirst, "email unchanged on second call");
    assert.equal(
      (second!.deletedAt as Date).toISOString(),
      deletedAtAfterFirst,
      "deletedAt unchanged on second call",
    );

    const unknown = await storageDeleteUser(`${TAG}-ghost-${randomUUID()}`);
    assert.equal(unknown, undefined, "unknown id returns undefined, no throw");

    console.log("  ✓ storage.deleteUser: soft delete + email suffix + session purge + idempotent");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Route-level DELETE /api/users/:id
// ─────────────────────────────────────────────────────────────────────────────

async function testRouteDeleteUser(): Promise<void> {
  console.log("(B) DELETE /api/users/:id");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const am = await seedUser({ role: "account_manager", suffix: "am" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim" });
    created.push(ceo.id, am.id, victim.id);

    // 403 — non-CEO can't delete anyone
    {
      const app = buildApp({ userId: am.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${victim.id}`);
        assert.equal(r.status, 403, "non-CEO → 403");
      } finally {
        server.close();
      }
      // Victim must still be live.
      const row = await fetchUserRow(victim.id);
      assert.ok(row && row.deletedAt === null, "victim untouched after 403");
    }

    // 400 — CEO can't delete themselves
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${ceo.id}`);
        assert.equal(r.status, 400, "self-delete → 400");
        assert.match(
          String(r.body?.error ?? ""),
          /own account/i,
          "self-delete error mentions own account",
        );
      } finally {
        server.close();
      }
      const row = await fetchUserRow(ceo.id);
      assert.ok(row && row.deletedAt === null, "CEO untouched after self-delete refusal");
    }

    // 404 — unknown id
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${TAG}-nope-${randomUUID()}`);
        assert.equal(r.status, 404, "unknown id → 404");
      } finally {
        server.close();
      }
    }

    // 200 — CEO deletes victim + activity-log row written
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await del(baseUrl, `/api/users/${victim.id}`);
        assert.equal(r.status, 200, "happy path → 200");
        assert.equal(r.body?.ok, true, "response body ok=true");
        assert.equal(r.body?.id, victim.id, "response body echoes deleted id");
      } finally {
        server.close();
      }
      const row = await fetchUserRow(victim.id);
      assert.ok(row && row.deletedAt instanceof Date, "victim soft-deleted in DB");
      assert.equal(
        await countUserDeletedLogs(victim.id, ceo.id),
        1,
        "one user_deleted activity-log row written",
      );

      // Second delete attempt should now 404 (storage.getUser hides
      // soft-deleted rows, so the route's pre-check rejects).
      const app2 = buildApp({ userId: ceo.id });
      const { server: s2, baseUrl: b2 } = await listen(app2);
      try {
        const r2 = await del(b2, `/api/users/${victim.id}`);
        assert.equal(r2.status, 404, "second delete of soft-deleted user → 404");
      } finally {
        s2.close();
      }
    }

    console.log("  ✓ DELETE /api/users/:id: 403/400/404/200 + activity log");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (C) Auth-layer isClaimsSubRevoked
// ─────────────────────────────────────────────────────────────────────────────

async function testIsClaimsSubRevoked(): Promise<void> {
  console.log("(C) isClaimsSubRevoked");
  const created: string[] = [];
  try {
    // Empty / undefined sub must not call into storage and must be
    // treated as "not revoked" (fail-open, matches inline comment).
    assert.equal(await __test_isClaimsSubRevoked(undefined), false, "undefined sub → false");
    assert.equal(await __test_isClaimsSubRevoked(""), false, "empty sub → false");

    const user = await seedUser({ role: "account_manager", suffix: "revoke" });
    created.push(user.id);

    assert.equal(
      await __test_isClaimsSubRevoked(user.id),
      false,
      "live user → not revoked (verify callback would proceed to upsert)",
    );

    await storage.deleteUser(user.id);

    assert.equal(
      await __test_isClaimsSubRevoked(user.id),
      true,
      "soft-deleted user → revoked (verify callback short-circuits BEFORE upsert)",
    );

    // A previously-unknown sub is also not revoked — verify must
    // proceed to upsert a brand-new user on first login.
    assert.equal(
      await __test_isClaimsSubRevoked(`${TAG}-never-seen-${randomUUID()}`),
      false,
      "unknown sub → not revoked",
    );

    console.log("  ✓ isClaimsSubRevoked: live=false, deleted=true, unknown=false, empty=false");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (D) Storage-level restoreUser (Task #1870)
// ─────────────────────────────────────────────────────────────────────────────

async function testStorageRestoreUser(): Promise<void> {
  console.log("(D) storage.restoreUser");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "restore" });
    created.push(user.id);

    // Restoring a live user is a no-op that returns the row unchanged.
    const noop = await storageRestoreUser(user.id);
    assert.ok(noop, "restoring a live user returns the row");
    assert.equal(noop!.deletedAt, null, "live user remains live");
    assert.equal(noop!.email, user.email, "live user email unchanged");

    // Delete, then restore.
    await storageDeleteUser(user.id);
    const restored = await storageRestoreUser(user.id);
    assert.ok(restored, "restoreUser returns a row");
    assert.equal(restored!.deletedAt, null, "deletedAt cleared after restore");
    assert.equal(restored!.email, user.email, "email suffix stripped on restore");

    const row = await fetchUserRow(user.id);
    assert.ok(row, "row still present after restore");
    assert.equal(row!.deletedAt, null, "deletedAt cleared in DB");
    assert.equal(row!.email, user.email, "email unsuffixed in DB");

    // Idempotency — restoring again is a no-op.
    const again = await storageRestoreUser(user.id);
    assert.ok(again, "second restore returns the row");
    assert.equal(again!.deletedAt, null, "still live after second restore");
    assert.equal(again!.email, user.email, "email unchanged on second restore");

    // Unknown id returns undefined, not a throw.
    const unknown = await storageRestoreUser(`${TAG}-ghost-${randomUUID()}`);
    assert.equal(unknown, undefined, "unknown id returns undefined, no throw");

    console.log("  ✓ storage.restoreUser: clears deletedAt + strips email suffix + idempotent");
  } finally {
    await cleanupUsers(created);
  }
}

async function testStorageRestoreEmailConflict(): Promise<void> {
  console.log("(D2) storage.restoreUser email conflict");
  const created: string[] = [];
  try {
    const original = await seedUser({ role: "account_manager", suffix: "rconflict" });
    created.push(original.id);
    await storageDeleteUser(original.id);

    // Re-create a NEW live user with the SAME original email — this is
    // exactly the case the suffix freed up.
    const claimantId = `${TAG}-claimant-${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO users (id, email, first_name, last_name, role, authority_level)
      VALUES (${claimantId}, ${original.email}, ${`${TAG}-claimant`}, 'User',
              'account_manager', 'core')
    `);
    created.push(claimantId);

    await assert.rejects(
      () => storageRestoreUser(original.id),
      (err: any) =>
        err instanceof RestoreEmailConflictError && err.email === original.email,
      "restore must throw RestoreEmailConflictError when email is taken",
    );

    // Original row must remain soft-deleted; nothing partially applied.
    const row = await fetchUserRow(original.id);
    assert.ok(row && row.deletedAt instanceof Date, "original still soft-deleted after conflict");
    assert.ok(
      row!.email && row!.email.startsWith(`${original.email}.deleted.`),
      "original email still suffixed after conflict",
    );

    console.log("  ✓ storage.restoreUser: RestoreEmailConflictError when original email is taken");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (E) Route-level POST /api/users/:id/restore + GET /api/users/deleted
// ─────────────────────────────────────────────────────────────────────────────

async function testRouteRestoreUser(): Promise<void> {
  console.log("(E) POST /api/users/:id/restore");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo2" });
    const am = await seedUser({ role: "account_manager", suffix: "am2" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim2" });
    created.push(ceo.id, am.id, victim.id);

    // Soft-delete victim up front for the restore tests.
    await storageDeleteUser(victim.id);

    // 403 — non-CEO can't restore
    {
      const app = buildApp({ userId: am.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await post(baseUrl, `/api/users/${victim.id}/restore`);
        assert.equal(r.status, 403, "non-CEO → 403");
      } finally {
        server.close();
      }
      const row = await fetchUserRow(victim.id);
      assert.ok(row && row.deletedAt instanceof Date, "victim still soft-deleted after 403");
    }

    // 404 — unknown id
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await post(baseUrl, `/api/users/${TAG}-nope-${randomUUID()}/restore`);
        assert.equal(r.status, 404, "unknown id → 404");
      } finally {
        server.close();
      }
    }

    // 400 — restoring a user who is not deleted
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await post(baseUrl, `/api/users/${ceo.id}/restore`);
        assert.equal(r.status, 400, "restoring a live user → 400");
        assert.match(
          String(r.body?.error ?? ""),
          /not deleted/i,
          "error mentions not deleted",
        );
      } finally {
        server.close();
      }
    }

    // GET /api/users/deleted lists the victim while soft-deleted
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await get(baseUrl, `/api/users/deleted`);
        assert.equal(r.status, 200, "deleted listing → 200");
        assert.ok(Array.isArray(r.body), "response is an array");
        const ids = (r.body as any[]).map((u) => u.id);
        assert.ok(ids.includes(victim.id), "victim is in the deleted listing");
        assert.ok(!ids.includes(ceo.id), "live CEO is NOT in the deleted listing");

        // Non-CEO must not be able to list deleted users.
        const app2 = buildApp({ userId: am.id });
        const { server: s2, baseUrl: b2 } = await listen(app2);
        try {
          const r2 = await get(b2, `/api/users/deleted`);
          assert.equal(r2.status, 403, "non-CEO listing → 403");
        } finally {
          s2.close();
        }
      } finally {
        server.close();
      }
    }

    // 200 — CEO restores victim + activity-log row written
    {
      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await post(baseUrl, `/api/users/${victim.id}/restore`);
        assert.equal(r.status, 200, "happy path → 200");
        assert.equal(r.body?.ok, true, "response body ok=true");
        assert.equal(r.body?.id, victim.id, "response body echoes restored id");
        assert.equal(r.body?.user?.email, victim.email, "restored email returned");
      } finally {
        server.close();
      }
      const row = await fetchUserRow(victim.id);
      assert.ok(row, "victim row present after restore");
      assert.equal(row!.deletedAt, null, "victim is live again in DB");
      assert.equal(row!.email, victim.email, "victim email unsuffixed in DB");
      assert.equal(
        await countUserRestoredLogs(victim.id, ceo.id),
        1,
        "one user_restored activity-log row written",
      );

      // After restore the user is visible again to getUser, and the
      // deleted listing no longer includes them.
      const live = await storage.getUser(victim.id);
      assert.ok(live, "getUser surfaces restored user");

      const app2 = buildApp({ userId: ceo.id });
      const { server: s2, baseUrl: b2 } = await listen(app2);
      try {
        const r2 = await get(b2, `/api/users/deleted`);
        assert.equal(r2.status, 200);
        const ids = (r2.body as any[]).map((u) => u.id);
        assert.ok(!ids.includes(victim.id), "restored user dropped from deleted listing");
      } finally {
        s2.close();
      }

      // After restore, the auth-layer revocation gate clears too — the
      // OIDC verify callback would now admit the user on next login.
      assert.equal(
        await __test_isClaimsSubRevoked(victim.id),
        false,
        "restored user → no longer revoked",
      );
    }

    // 409 — restore refused when email was claimed by a new live user.
    {
      const original = await seedUser({ role: "account_manager", suffix: "rconflict2" });
      created.push(original.id);
      await storageDeleteUser(original.id);

      const claimantId = `${TAG}-claimant-${randomUUID()}`;
      await db.execute(sql`
        INSERT INTO users (id, email, first_name, last_name, role, authority_level)
        VALUES (${claimantId}, ${original.email}, ${`${TAG}-claimant`}, 'User',
                'account_manager', 'core')
      `);
      created.push(claimantId);

      const app = buildApp({ userId: ceo.id });
      const { server, baseUrl } = await listen(app);
      try {
        const r = await post(baseUrl, `/api/users/${original.id}/restore`);
        assert.equal(r.status, 409, "email collision → 409");
        assert.match(
          String(r.body?.error ?? ""),
          /already/i,
          "error mentions email already in use",
        );
      } finally {
        server.close();
      }

      // Original still soft-deleted; nothing partially applied; no
      // user_restored log emitted on the failure path.
      const row = await fetchUserRow(original.id);
      assert.ok(row && row.deletedAt instanceof Date, "original still soft-deleted after 409");
      assert.equal(
        await countUserRestoredLogs(original.id, ceo.id),
        0,
        "no user_restored log written on 409",
      );
    }

    console.log("  ✓ POST /api/users/:id/restore: 403/404/400/200/409 + activity log + listing");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testStorageDeleteUser();
  await testRouteDeleteUser();
  await testIsClaimsSubRevoked();
  await testStorageRestoreUser();
  await testStorageRestoreEmailConflict();
  await testRouteRestoreUser();
  console.log("user-delete-flow: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-delete-flow: FAILED");
  console.error(err);
  process.exitCode = 1;
});
