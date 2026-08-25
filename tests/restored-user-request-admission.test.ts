/* test-registration
{
  "name": "Restored-user per-request admission via isAuthenticated (Task #2018)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2018 — confirm a restored user can actually open the app on their
 * NEXT in-flight request, and that a user soft-deleted mid-session is
 * booted.
 *
 * Task #1989 proved the OIDC `verify` callback admits a restored user and
 * rejects a still-soft-deleted one. That closes the LOGIN-admission link.
 * The next link in the chain is the per-request `isAuthenticated`
 * middleware (the defense-in-depth revocation re-check + token-refresh
 * path). A restore that clears `deleted_at` but is not honoured by the
 * per-request gate would still leave the user locked out — 401'd or
 * redirected to /access-revoked — on their very next API/page request.
 *
 * This test drives the real exported `isAuthenticated` handler with
 * synthetic Express req/res objects, for:
 *
 *   (A) a live/restored user (session already established) → next() is
 *       called, request proceeds, no 401/redirect;
 *   (B) a user soft-deleted AFTER their session was established, hitting
 *       an API endpoint (Accept: application/json) → logout + 401 JSON
 *       { message: "Access revoked" }, next() NOT called;
 *   (C) the same mid-session soft-delete, hitting an HTML page
 *       (Accept: text/html) → logout + 302 redirect to /access-revoked,
 *       next() NOT called.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { isAuthenticated } from "../server/middlewares/requireAuth";
import {
  deleteUser as storageDeleteUser,
  restoreUser as storageRestoreUser,
  isUserRevoked as storageIsUserRevoked,
} from "../server/storage/clientStorage";

const TAG = "task-2018";

interface SeededUser {
  id: string;
  email: string;
}

async function seedUser(opts: { role: string; suffix: string }): Promise<SeededUser> {
  const id = `${TAG}-${opts.suffix}-${randomUUID()}`;
  const email = `${id}@test.example`.toLowerCase();
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${`${TAG}-${opts.suffix}`}, 'User',
            ${opts.role}, ${opts.role === "ceo" ? "ceo" : "core"})
  `);
  return { id, email };
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

interface MockOutcome {
  nextCalled: boolean;
  statusCode: number | null;
  jsonBody: any;
  redirectedTo: string | null;
  logoutCalled: boolean;
}

/**
 * Build a synthetic Express req/res/next and run the real
 * `isAuthenticated` handler once. The `req.user` shape mirrors what
 * passport's session deserializer hands a route handler: a live session
 * carrying claims (with `sub`), a fresh-enough `expires_at`, and tokens.
 *
 * `expires_at` is parked an hour in the future so the handler's
 * token-refresh branch is never reached — this test pins the revocation
 * re-check, not the refresh path.
 */
async function runIsAuthenticated(opts: {
  sub: string;
  accept: string;
  authenticated?: boolean;
}): Promise<MockOutcome> {
  const outcome: MockOutcome = {
    nextCalled: false,
    statusCode: null,
    jsonBody: undefined,
    redirectedTo: null,
    logoutCalled: false,
  };

  const req: any = {
    // Clerk test seam: requireAuth reads __test_clerkUserId to resolve the
    // user without a real Clerk session.  null = unauthenticated.
    __test_clerkUserId: (opts.authenticated ?? true) ? opts.sub : null,
    headers: { accept: opts.accept },
  };

  const res: any = {
    status: (code: number) => {
      outcome.statusCode = code;
      return res;
    },
    json: (body: any) => {
      outcome.jsonBody = body;
      return res;
    },
    redirect: (target: string) => {
      outcome.redirectedTo = target;
      return res;
    },
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Wrap the response terminals so we resolve once the handler has
    // produced its decision (next / json / redirect).
    const origJson = res.json;
    res.json = (body: any) => {
      const r = origJson(body);
      finish();
      return r;
    };
    const origRedirect = res.redirect;
    res.redirect = (target: string) => {
      const r = origRedirect(target);
      finish();
      return r;
    };
    const next = (err?: any) => {
      outcome.nextCalled = true;
      if (err) {
        reject(err);
        return;
      }
      finish();
    };

    Promise.resolve(isAuthenticated(req, res, next as any)).catch(reject);
  });

  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Live/restored user's next request proceeds (next() called)
// ─────────────────────────────────────────────────────────────────────────────

async function testRestoredUserRequestProceeds(): Promise<void> {
  console.log("(A) restored user → next request proceeds (next() called, no 401/redirect)");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "restored" });
    created.push(user.id);

    // Soft-delete then restore — the user is live again.
    await storageDeleteUser(user.id);
    await storageRestoreUser(user.id);
    assert.equal(
      await storageIsUserRevoked(user.id),
      false,
      "restored user is not revoked",
    );

    const outcome = await runIsAuthenticated({
      sub: user.id,
      accept: "application/json",
    });

    assert.equal(outcome.nextCalled, true, "restored user → next() called (request proceeds)");
    assert.equal(outcome.logoutCalled, false, "restored user is NOT logged out");
    assert.equal(outcome.statusCode, null, "no 401 status set for a live user");
    assert.equal(outcome.redirectedTo, null, "no redirect for a live user");

    console.log("  ✓ restored user's next request proceeds");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Mid-session soft-delete on an API request → logout + 401 JSON
// ─────────────────────────────────────────────────────────────────────────────

async function testMidSessionDeleteApiBooted(): Promise<void> {
  console.log("(B) soft-deleted mid-session, API request → logout + 401 JSON, next() not called");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "api-booted" });
    created.push(user.id);

    // Session was already established (req.user is live), THEN the user is
    // soft-deleted. The defense-in-depth gate must catch the in-flight
    // request.
    await storageDeleteUser(user.id);
    assert.equal(await storageIsUserRevoked(user.id), true, "user is revoked after delete");

    const outcome = await runIsAuthenticated({
      sub: user.id,
      accept: "application/json",
    });

    assert.equal(outcome.nextCalled, false, "booted request does NOT proceed (next not called)");
    assert.equal(outcome.statusCode, 401, "API request gets 401");
    assert.deepEqual(
      outcome.jsonBody,
      { message: "Access revoked" },
      "API request gets the 'Access revoked' JSON body",
    );
    assert.equal(outcome.redirectedTo, null, "API request is not redirected");

    console.log("  ✓ mid-session soft-deleted user is 401'd on an API request");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (C) Mid-session soft-delete on an HTML request → logout + redirect
// ─────────────────────────────────────────────────────────────────────────────

async function testMidSessionDeleteHtmlRedirected(): Promise<void> {
  console.log("(C) soft-deleted mid-session, HTML request → logout + redirect to /access-revoked");
  const created: string[] = [];
  try {
    const user = await seedUser({ role: "account_manager", suffix: "html-booted" });
    created.push(user.id);

    await storageDeleteUser(user.id);
    assert.equal(await storageIsUserRevoked(user.id), true, "user is revoked after delete");

    const outcome = await runIsAuthenticated({
      sub: user.id,
      accept: "text/html,application/xhtml+xml",
    });

    assert.equal(outcome.nextCalled, false, "booted request does NOT proceed (next not called)");
    assert.equal(
      outcome.redirectedTo,
      "/access-revoked",
      "HTML request is redirected to /access-revoked",
    );
    assert.equal(outcome.statusCode, null, "HTML request is not given a 401 status");

    console.log("  ✓ mid-session soft-deleted user is redirected to /access-revoked on a page request");
  } finally {
    await cleanupUsers(created);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testRestoredUserRequestProceeds();
  await testMidSessionDeleteApiBooted();
  await testMidSessionDeleteHtmlRedirected();
  console.log("restored-user-request-admission: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("restored-user-request-admission: FAILED");
  console.error(err);
  process.exitCode = 1;
});
