/* test-registration
{
  "name": "User fallback-restore + email-cleanup flow (Task #1946)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1946 — regression coverage for the combined fallback-restore +
 * email-cleanup recovery story.
 *
 * Task #1910 added the suffix-fallback restore path
 * (`restoreUser({ emailConflictStrategy: "suffix" })` →
 * `<original>.restored.<ts>`) and Task #1933 added the CEO-only
 * PATCH /api/users/:id/email cleanup. The combined flow is multi-step and
 * was previously only verifiable by hand; a regression leaves a synthetic
 * fallback email on a live login that only bites at the user's next OIDC
 * login.
 *
 * Layers pinned here:
 *
 *   (A) End-to-end recovery flow:
 *         delete original → recreate active account with the same email →
 *         restore-with-fallback (suffix expected, badge true) →
 *         PATCH /api/users/:id/email to a fresh address (suffix gone,
 *         badge false) → the fresh address is now itself subject to the
 *         uniqueness check (a second user can't claim it).
 *
 *   (B) PATCH /api/users/:id/email 409 EMAIL_CONFLICT response shape —
 *         collider id + displayName surfaced, colliding email echoed.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerSettingsRoutes } from "../server/routes/settings";
import {
  deleteUser as storageDeleteUser,
  isRestoredFallbackEmail,
} from "../server/storage/clientStorage";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-1946";

interface SeededUser {
  id: string;
  email: string;
}

async function seedUser(opts: { role: string; suffix: string; email?: string }): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = (opts.email ?? `${id}@test.example`).toLowerCase();
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

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
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
// (A) Full recovery flow: fallback-restore → email cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function testFallbackRestoreThenEmailCleanup(): Promise<void> {
  console.log("(A) delete → recreate same email → restore-with-fallback → PATCH cleanup");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const original = await seedUser({ role: "account_manager", suffix: "orig" });
    created.push(ceo.id, original.id);

    // Soft-delete the original — frees the bare email (it gets a
    // `.deleted.<ts>` suffix) so a new account can claim it.
    await storageDeleteUser(original.id);

    // A new active user reclaims the original email.
    const replacement = await seedUser({
      role: "account_manager",
      suffix: "replace",
      email: original.email,
    });
    created.push(replacement.id);

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    try {
      // Restore with the suffix fallback — must succeed (no collision
      // thrown) and leave a `<original>.restored.<ts>` email behind.
      const restoreResp = await httpJson(
        baseUrl,
        `/api/users/${original.id}/restore`,
        jsonInit("POST", { emailConflictStrategy: "suffix" }),
      );
      assert.equal(restoreResp.status, 200, "suffix-fallback restore → 200");
      assert.equal(restoreResp.body?.ok, true, "restore ok=true");
      const restoredEmail: string = restoreResp.body?.user?.email;
      assert.ok(
        restoredEmail.startsWith(`${original.email}.restored.`),
        `restored email carries .restored.<ts> suffix (got ${restoredEmail})`,
      );
      assert.equal(
        isRestoredFallbackEmail(restoredEmail),
        true,
        "isRestoredFallbackEmail badge true on the synthetic address",
      );

      // The fallback address is live in the DB and the row is no longer
      // soft-deleted.
      const afterRestore = await fetchUserRow(original.id);
      assert.ok(afterRestore && afterRestore.deletedAt === null, "restored row is live");
      assert.equal(afterRestore!.email, restoredEmail, "DB has the fallback email");

      // Now clean up the synthetic address to a fresh, unused email.
      const freshEmail = `${TAG}-fresh-${randomUUID()}@test.example`.toLowerCase();
      const patchResp = await httpJson(
        baseUrl,
        `/api/users/${original.id}/email`,
        jsonInit("PATCH", { email: freshEmail }),
      );
      assert.equal(patchResp.status, 200, "email cleanup PATCH → 200");
      assert.equal(patchResp.body?.id, original.id, "PATCH echoes the user id");
      assert.equal(patchResp.body?.email, freshEmail, "PATCH set the fresh email");
      assert.equal(
        isRestoredFallbackEmail(patchResp.body?.email),
        false,
        "fallback badge gone after cleanup",
      );

      const afterPatch = await fetchUserRow(original.id);
      assert.equal(afterPatch!.email, freshEmail, "DB has the fresh email");

      // A `user_email_updated` audit row was written for the cleanup.
      assert.equal(
        await countActivityLogs("user_email_updated", original.id, ceo.id),
        1,
        "exactly one user_email_updated activity-log row written",
      );

      // The fresh address is now itself subject to the uniqueness check:
      // a second active user cannot claim it.
      const claimResp = await httpJson(
        baseUrl,
        `/api/users/${replacement.id}/email`,
        jsonInit("PATCH", { email: freshEmail }),
      );
      assert.equal(claimResp.status, 409, "fresh email is now uniqueness-protected → 409");
      assert.equal(claimResp.body?.code, "EMAIL_CONFLICT", "409 carries EMAIL_CONFLICT code");
      assert.equal(
        claimResp.body?.collidingUser?.id,
        original.id,
        "collider is the recovered user that now owns the fresh email",
      );
    } finally {
      server.close();
    }

    console.log("  ✓ fallback-restore + email cleanup full flow");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) PATCH /api/users/:id/email — 409 EMAIL_CONFLICT response shape
// ─────────────────────────────────────────────────────────────────────────────

async function testPatchEmailConflictShape(): Promise<void> {
  console.log("(B) PATCH /api/users/:id/email — 409 EMAIL_CONFLICT shape");
  const created: string[] = [];
  try {
    const ceo = await seedUser({ role: "ceo", suffix: "ceo" });
    const subject = await seedUser({ role: "account_manager", suffix: "subject" });
    const collider = await seedUser({ role: "account_manager", suffix: "collider" });
    created.push(ceo.id, subject.id, collider.id);

    const app = buildApp({ userId: ceo.id });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await httpJson(
        baseUrl,
        `/api/users/${subject.id}/email`,
        jsonInit("PATCH", { email: collider.email }),
      );
      assert.equal(r.status, 409, "collision → 409");
      assert.equal(r.body?.code, "EMAIL_CONFLICT", "code is EMAIL_CONFLICT");
      assert.equal(r.body?.email, collider.email, "echoes the colliding email");
      assert.equal(r.body?.collidingUser?.id, collider.id, "surfaces collider id");
      assert.ok(
        typeof r.body?.collidingUser?.displayName === "string" &&
          r.body.collidingUser.displayName.length > 0,
        "surfaces collider displayName",
      );
      assert.ok(
        String(r.body?.error ?? "").includes(collider.email),
        "error message includes the colliding email",
      );
    } finally {
      server.close();
    }

    // The failed PATCH must not have mutated the subject's email.
    const row = await fetchUserRow(subject.id);
    assert.equal(row!.email, subject.email, "subject email unchanged after 409");

    // No audit row on a rejected edit.
    assert.equal(
      await countActivityLogs("user_email_updated", subject.id, ceo.id),
      0,
      "no user_email_updated activity log on 409",
    );

    console.log("  ✓ 409 EMAIL_CONFLICT shape + no mutation");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testFallbackRestoreThenEmailCleanup();
  await testPatchEmailConflictShape();
  console.log("user-email-cleanup-flow: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("user-email-cleanup-flow: FAILED");
  console.error(err);
  process.exitCode = 1;
});
