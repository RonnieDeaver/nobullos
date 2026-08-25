/* test-registration
{
  "name": "User restore flow \u2014 soft-delete + restore + 409 collision (Task #1899)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1899 — regression coverage for the user soft-delete + restore
 * flow (Task #1866 added soft-delete, Task #1870 added restore).
 *
 * Layers pinned here:
 *
 *   (A) Storage:
 *         - deleteUser → row hidden from `getAllUsers`; isUserRevoked
 *           returns true; row shows up in listDeletedUsers.
 *         - restoreUser → deletedAt cleared, `.deleted.<ts>` suffix
 *           stripped from email, idempotent on a live row.
 *         - restoreUser throws RestoreEmailConflictError when the
 *           original email has been claimed by a new active user.
 *
 *   (B) Routes:
 *         - GET  /api/users/deleted          — 403 for non-CEO
 *         - POST /api/users/:id/restore      — 403 for non-CEO
 *         - POST /api/users/:id/restore      — 409 on email collision
 *         - POST /api/users/:id/restore      — 200 happy path +
 *           `user_restored` activity-log row written
 */

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
  listDeletedUsers as storageListDeletedUsers,
  isUserRevoked as storageIsUserRevoked,
  RestoreEmailConflictError,
} from "../server/storage/clientStorage";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-1899";

interface SeededUser {
  id: string;
  email: string;
}

async function seedUser(opts: { role: string; suffix: string; email?: string }): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = opts.email ?? `${id}@test.example`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${`${TAG}-${opts.suffix}`}, 'User',
            ${opts.role}, ${opts.role === "ceo" ? "ceo" : "core"})
  `);
  return { id, email };
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
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function countActivityLogs(
  actionType: string,
  targetId: string,
  actorId: string,
): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM user_activity_logs
    WHERE action_type = ${actionType}
      AND user_id = ${actorId}
      AND (metadata->>'targetUserId') = ${targetId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Storage-level soft-delete + restore
// ─────────────────────────────────────────────────────────────────────────────

async function testStorageSoftDeleteAndRestore(): Promise<void> {
  console.log("(A1) storage.deleteUser hides + revokes; restoreUser brings back");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "rt" });
    created.push(user.id);

    // Sanity — live user is in listings and not revoked.
    const allBefore = await storage.getAllUsers();
    assert.ok(allBefore.some((u) => u.id === user.id), "live user in getAllUsers");
    assert.equal(await storageIsUserRevoked(user.id), false, "live user not revoked");

    // Soft-delete.
    const deleted = await storageDeleteUser(user.id);
    assert.ok(deleted && deleted.deletedAt instanceof Date, "deleteUser set deletedAt");

    const allAfterDelete = await storage.getAllUsers();
    assert.ok(
      !allAfterDelete.some((u) => u.id === user.id),
      "soft-deleted user hidden from getAllUsers",
    );
    assert.equal(
      await storageIsUserRevoked(user.id),
      true,
      "soft-deleted user is revoked (OIDC verify gate)",
    );

    const deletedList = await storageListDeletedUsers();
    assert.ok(
      deletedList.some((u) => u.id === user.id),
      "soft-deleted user appears in listDeletedUsers",
    );

    // Restore.
    const restored = await storageRestoreUser(user.id);
    assert.ok(restored, "restoreUser returned a row");
    assert.equal(restored!.deletedAt, null, "deletedAt cleared on restore");
    assert.equal(
      restored!.email,
      user.email,
      "email suffix stripped on restore (back to original)",
    );

    const row = await fetchUserRow(user.id);
    assert.ok(row, "row still present after restore");
    assert.equal(row!.deletedAt, null, "deletedAt cleared in DB");
    assert.equal(row!.email, user.email, "email back to original in DB");

    const allAfterRestore = await storage.getAllUsers();
    assert.ok(
      allAfterRestore.some((u) => u.id === user.id),
      "restored user back in getAllUsers",
    );
    assert.equal(
      await storageIsUserRevoked(user.id),
      false,
      "restored user no longer revoked",
    );
    assert.ok(
      !(await storageListDeletedUsers()).some((u) => u.id === user.id),
      "restored user no longer in listDeletedUsers",
    );

    // Idempotency — restoring a live user is a no-op, returns row unchanged,
    // does not throw, does not double-mutate the email.
    const second = await storageRestoreUser(user.id);
    assert.ok(second, "second restoreUser returned a row");
    assert.equal(second!.email, user.email, "email unchanged on idempotent restore");
    assert.equal(second!.deletedAt, null, "deletedAt still null on idempotent restore");

    console.log("  ✓ storage soft-delete + restore + idempotent");
  } finally {
    await cleanupUsers(created);
  }
}

async function testStorageRestoreEmailCollision(): Promise<void> {
  console.log("(A2) storage.restoreUser throws RestoreEmailConflictError on email collision");
  const created: string[] = [];
  try {
    const original = await seedUser({ role: "account_manager", suffix: "orig" });
    created.push(original.id);

    // Soft-delete original — frees the email (with suffix) so a new
    // account can claim the bare address.
    await storageDeleteUser(original.id);

    // A new active user now holds the original email.
    const replacement = await seedUser({
      role: "account_manager",
      suffix: "replace",
      email: original.email,
    });
    created.push(replacement.id);

    let caught: unknown = null;
    try {
      await storageRestoreUser(original.id);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "restoreUser threw");
    assert.ok(
      caught instanceof RestoreEmailConflictError,
      "thrown error is RestoreEmailConflictError",
    );
    assert.equal(
      (caught as RestoreEmailConflictError).email,
      original.email,
      "error carries the colliding email",
    );

    // Original must remain soft-deleted with its suffixed email intact —
    // the failed restore must NOT have partially mutated the row.
    const row = await fetchUserRow(original.id);
    assert.ok(row && row.deletedAt instanceof Date, "original still soft-deleted");
    assert.ok(
      row!.email && row!.email.startsWith(`${original.email}.deleted.`),
      "original email still has .deleted.<ts> suffix",
    );

    console.log("  ✓ storage restore email collision rejected, original untouched");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Route-level GET /api/users/deleted + POST /api/users/:id/restore
// ─────────────────────────────────────────────────────────────────────────────

async function testRouteCeoGating(): Promise<void> {
  console.log("(B1) GET /api/users/deleted + POST /api/users/:id/restore — 403 for non-CEO");
  const created: string[] = [];
  try {
    const am = await seedUser({ role: "account_manager", suffix: "am" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim" });
    created.push(am.id, victim.id);

    await storageDeleteUser(victim.id);

    const app = buildApp({ userId: am.id });
    const { server, baseUrl } = await listen(app);
    try {
      const listResp = await httpJson(baseUrl, `/api/users/deleted`);
      assert.equal(listResp.status, 403, "non-CEO GET /api/users/deleted → 403");

      const restoreResp = await httpJson(baseUrl, `/api/users/${victim.id}/restore`, {
        method: "POST",
      });
      assert.equal(restoreResp.status, 403, "non-CEO POST /restore → 403");
    } finally {
      server.close();
    }

    // Victim must still be soft-deleted — the 403 must not have leaked through.
    const row = await fetchUserRow(victim.id);
    assert.ok(row && row.deletedAt instanceof Date, "victim still soft-deleted after 403");

    console.log("  ✓ non-CEO blocked from both endpoints");
  } finally {
    await cleanupUsers(created);
  }
}

async function testRouteRestoreHappyPath(): Promise<void> {
  console.log("(B2) POST /api/users/:id/restore — 200 + user_restored activity log");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const victim = await seedUser({ role: "account_manager", suffix: "victim" });
    created.push(ceo.id, victim.id);

    await storageDeleteUser(victim.id);

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    try {
      // The deleted-listing should include the victim before restore.
      const listBefore = await httpJson(baseUrl, `/api/users/deleted`);
      assert.equal(listBefore.status, 200, "CEO can list deleted");
      assert.ok(
        Array.isArray(listBefore.body) &&
          listBefore.body.some((u: any) => u.id === victim.id),
        "victim listed in /api/users/deleted before restore",
      );

      const r = await httpJson(baseUrl, `/api/users/${victim.id}/restore`, {
        method: "POST",
      });
      assert.equal(r.status, 200, "happy path → 200");
      assert.equal(r.body?.ok, true, "response ok=true");
      assert.equal(r.body?.id, victim.id, "response echoes restored id");
      assert.equal(
        r.body?.user?.email,
        victim.email,
        "response user has email restored (suffix stripped)",
      );

      // Listing should no longer include the victim.
      const listAfter = await httpJson(baseUrl, `/api/users/deleted`);
      assert.ok(
        Array.isArray(listAfter.body) &&
          !listAfter.body.some((u: any) => u.id === victim.id),
        "victim gone from /api/users/deleted after restore",
      );

      // Idempotency at the route: a second restore on a live user
      // returns 400 ("User is not deleted") per the route's pre-check.
      const second = await httpJson(baseUrl, `/api/users/${victim.id}/restore`, {
        method: "POST",
      });
      assert.equal(second.status, 400, "second restore of live user → 400");
    } finally {
      server.close();
    }

    const row = await fetchUserRow(victim.id);
    assert.ok(row && row.deletedAt === null, "victim live in DB");
    assert.equal(row!.email, victim.email, "victim email restored in DB");

    assert.equal(
      await countActivityLogs("user_restored", victim.id, ceo.id),
      1,
      "exactly one user_restored activity-log row written",
    );

    console.log("  ✓ CEO restore happy path + activity log");
  } finally {
    await cleanupUsers(created);
  }
}

async function testRouteRestoreEmailCollision(): Promise<void> {
  console.log("(B3) POST /api/users/:id/restore — 409 on email collision");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const original = await seedUser({ role: "account_manager", suffix: "orig" });
    created.push(ceo.id, original.id);

    await storageDeleteUser(original.id);

    const replacement = await seedUser({
      role: "account_manager",
      suffix: "replace",
      email: original.email,
    });
    created.push(replacement.id);

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await httpJson(baseUrl, `/api/users/${original.id}/restore`, {
        method: "POST",
      });
      assert.equal(r.status, 409, "email collision → 409");
      assert.match(
        String(r.body?.error ?? ""),
        /already uses/i,
        "409 error mentions the address is already in use",
      );
      assert.ok(
        String(r.body?.error ?? "").includes(original.email),
        "409 error includes the colliding email",
      );
    } finally {
      server.close();
    }

    // No activity log on a failed restore.
    assert.equal(
      await countActivityLogs("user_restored", original.id, ceo.id),
      0,
      "no user_restored activity log on 409",
    );

    // Original still soft-deleted.
    const row = await fetchUserRow(original.id);
    assert.ok(row && row.deletedAt instanceof Date, "original still soft-deleted after 409");

    console.log("  ✓ route returns 409, no activity log, original untouched");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testStorageSoftDeleteAndRestore();
  await testStorageRestoreEmailCollision();
  await testRouteCeoGating();
  await testRouteRestoreHappyPath();
  await testRouteRestoreEmailCollision();
  console.log("user-restore-flow: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-restore-flow: FAILED");
  console.error(err);
  process.exitCode = 1;
});
