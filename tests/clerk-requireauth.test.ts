/* test-registration
{
  "name": "Clerk requireAuth — unauthenticated 401, closed admission (approved-email allowlist, company-domain .com↔.co equivalence, deny-without-write), soft-delete gate, req.user legacy bridge, approval-endpoint authz (Tasks #4378 + #4554)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #4378 + #4554: requireAuth is the sole auth gate for all API routes, and closed admission made the users table the sign-in allowlist. Its unauthenticated-401, approved-email-match (case-insensitive, deterministic on collisions, Clerk externalId link), deny-WITHOUT-write for unapproved emails, soft-delete-revocation, and req.user-legacy-bridge behaviors are invariants whose regression would silently admit strangers or lock out the whole team. Also locks the POST /api/users approval endpoint (team_lead can approve, account_manager cannot, dup → 409) and the owner-approved company-domain email equivalence (.com↔.co: variant admits, exact match wins, verification still gates, foreign domains never swap). Fast, isolated, DB-backed, deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Tasks #4378 + #4554 — Clerk requireAuth coverage (closed admission).
 *
 * Tests the concrete contracts that requireAuth provides for all routes:
 *
 *   (A) Unauthenticated request (no __test_clerkUserId / no Clerk session)
 *       → 401 JSON { message: "Unauthorized" }
 *
 *   (B) Authenticated request for a known user
 *       → next() called; req.dbUser populated; req.user legacy bridge has
 *         correct claims.sub, role, dbUser, and username shape.
 *
 *   (C) Closed admission (Task #4554 — replaces the JIT-provisioning
 *       contract): a session whose id has no users row is admitted ONLY
 *       when its verified email matches a pre-approved, non-deleted row:
 *       (C1) no email claim → 403 account_not_approved, ZERO rows written
 *       (C2) email matching nothing → 403 + email echoed, ZERO rows written
 *       (C3) HTML navigation denial → redirect /not-approved
 *       (C4) approved email (case-insensitive) → admitted with the row's
 *            role, Clerk link writer called once with (clerkId, rowId),
 *            claims.sub/id = the ADOPTED row id (not the Clerk id); the
 *            email VERIFIER is consulted with (clerkId, normalized email)
 *            before any link/adopt
 *       (C4b) matching email that Clerk reports UNVERIFIED → 403
 *            account_not_approved, NO link write, NO row adoption, zero
 *            rows written (broken-access-control guard: a claim alone
 *            must never admit)
 *       (C4c) verifier THROWS (Clerk outage) → fail-CLOSED: same zero-write
 *            denial, no link write
 *       (C5) legacy casing collision on lower(email) → deterministic:
 *            oldest created_at wins
 *       (C6) soft-deleted row's email → denied (allowlist is live rows)
 *       (C7) company-domain equivalence (owner-approved 2026-08-13): a
 *            login on one company domain matches a row stored under the
 *            other (.com↔.co, same local part). Exact match beats the
 *            variant, verification still gates the variant path, deleted
 *            variant rows never match, and NO other domain ever swaps
 *
 *   (D) Soft-deleted user (deletedAt IS NOT NULL), API request
 *       → 401 JSON { message: "Access revoked" } without calling next().
 *
 *   (E) Soft-deleted user, HTML page request
 *       → 302 redirect to /access-revoked without calling next().
 *
 *   (F) __test_isClaimsSubRevoked seam:
 *       → returns false for undefined/empty, false for live users,
 *         true for soft-deleted users, false for users not in DB.
 *
 *   (G) POST /api/users approval endpoint (real settings routes + real
 *       role middleware): 401 unauthenticated, 403 account_manager,
 *       201 team_lead (email lowercased, role derived from authority),
 *       409 case-insensitive duplicate, 400 invalid body.
 *
 * Uses the per-request __test_clerkUserId / __test_clerkEmail seams so no
 * real Clerk session is required; the Clerk externalId link writer is
 * captured via __test_setClerkLinkWriter and the verified-email check via
 * __test_setClerkEmailVerifier (defaults under NODE_ENV=test: no-op link,
 * verifier treats the seam email as verified — never egresses). All DB
 * writes use unique per-run prefixes and are cleaned up.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import {
  isAuthenticated,
  __test_isClaimsSubRevoked,
  __test_setClerkLinkWriter,
  __test_setClerkEmailVerifier,
} from "../server/middlewares/requireAuth";
import { registerSettingsRoutes } from "../server/routes/settings";

const TAG = `clerk-auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Outcome {
  nextCalled: boolean;
  statusCode: number | null;
  jsonBody: unknown;
  redirectedTo: string | null;
  req: any;
}

/**
 * Invoke the real requireAuth middleware with a synthetic Express req/res.
 * @param userId - inject via __test_clerkUserId (null = unauthenticated)
 * @param opts.email - inject via __test_clerkEmail (session's verified email)
 * @param opts.accept - Accept header value
 */
async function runAuth(
  userId: string | null,
  opts: { email?: string | null; accept?: string; url?: string } = {},
): Promise<Outcome> {
  const outcome: Outcome = {
    nextCalled: false,
    statusCode: null,
    jsonBody: undefined,
    redirectedTo: null,
    req: null,
  };

  const req: any = {
    __test_clerkUserId: userId,
    headers: { accept: opts.accept ?? "application/json" },
  };
  if (opts.url !== undefined) {
    req.originalUrl = opts.url;
    req.url = opts.url;
  }
  if (opts.email !== undefined) req.__test_clerkEmail = opts.email;
  outcome.req = req;

  const res: any = {
    status(code: number) {
      outcome.statusCode = code;
      return res;
    },
    json(body: unknown) {
      outcome.jsonBody = body;
      settle();
      return res;
    },
    redirect(target: string) {
      outcome.redirectedTo = target;
      settle();
      return res;
    },
  };

  let settle: () => void;
  await new Promise<void>((resolve, reject) => {
    settle = resolve;
    const next = (err?: unknown) => {
      if (err) {
        reject(err as Error);
        return;
      }
      outcome.nextCalled = true;
      resolve();
    };
    // requireAuth is a void RequestHandler; it settles via res or next.
    Promise.resolve(isAuthenticated(req, res, next as any)).catch(reject);
  });

  return outcome;
}

async function seedUser(
  suffix: string,
  role = "account_manager",
  opts: { email?: string; createdAt?: string } = {},
): Promise<string> {
  const id = `${TAG}-${suffix}`;
  const email = opts.email ?? `${id}@test.local`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level, created_at)
    VALUES (${id}, ${email}, ${"Clerk"}, ${"Test"},
            ${role}, ${"core"}, ${opts.createdAt ?? new Date().toISOString()})
    ON CONFLICT (id) DO NOTHING
  `);
  return id;
}

async function softDeleteUser(id: string): Promise<void> {
  await db.execute(sql`
    UPDATE users SET deleted_at = NOW() WHERE id = ${id}
  `);
}

/** Count rows attributable to a denied identity — must stay 0 (deny-without-write). */
async function countRowsFor(id: string, email: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT count(*)::int AS n FROM users WHERE id = ${id} OR lower(email) = ${email.toLowerCase()}
  `);
  return Number((res.rows ?? [])[0]?.n ?? 0);
}

async function cleanupUsers(): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${TAG + "%"}`).catch(() => {});
  // Approval-endpoint rows have generated uuids — clean by email domain tag.
  await db
    .execute(sql`DELETE FROM users WHERE email LIKE ${"%" + TAG.toLowerCase() + "%"}`)
    .catch(() => {});
}

/**
 * Real settings routes behind the per-request Clerk test seam (pattern from
 * users-paged-route.test.ts). requireTeamLead reads the REAL users row, so
 * 401/403/201 are end-to-end.
 */
async function withSettingsApp<T>(
  sub: string | null,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.__test_clerkUserId = sub;
    next();
  });
  registerSettingsRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function run(): Promise<void> {
  try {
    // (A) Unauthenticated → 401
    console.log("(A) unauthenticated request → 401 Unauthorized");
    {
      const out = await runAuth(null);
      ok(out.nextCalled === false, "unauthenticated: next() NOT called");
      ok(out.statusCode === 401, "unauthenticated: status 401");
      ok(
        typeof out.jsonBody === "object" &&
          (out.jsonBody as any)?.message === "Unauthorized",
        "unauthenticated: JSON body { message: 'Unauthorized' }",
      );
    }

    // (B) Authenticated known user → next() + bridge
    console.log("(B) authenticated known user → next(), req.user bridge");
    const knownId = await seedUser("known", "team_lead");
    {
      const out = await runAuth(knownId);
      ok(out.nextCalled, "known user: next() called");
      ok(out.req.dbUser?.id === knownId, "known user: req.dbUser.id matches");
      ok(out.req.user?.claims?.sub === knownId, "known user: req.user.claims.sub set");
      ok(out.req.user?.claims?.role === "team_lead", "known user: req.user.claims.role set from DB");
      ok(out.req.user?.dbUser?.id === knownId, "known user: req.user.dbUser populated");
    }

    // (C) Closed admission — Task #4554
    console.log("(C1) unknown id, NO email claim → 403 account_not_approved, zero writes");
    {
      const strangerId = `${TAG}-stranger-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(strangerId);
      ok(out.nextCalled === false, "no-email stranger: next() NOT called");
      ok(out.statusCode === 403, "no-email stranger: status 403");
      ok(
        (out.jsonBody as any)?.code === "account_not_approved",
        "no-email stranger: code account_not_approved",
      );
      ok((out.jsonBody as any)?.email === null, "no-email stranger: email null in body");
      ok(
        (await countRowsFor(strangerId, `${strangerId}@nowhere.local`)) === 0,
        "no-email stranger: ZERO users rows written",
      );
    }

    console.log("(C2) unknown id, unapproved email → 403 + email echoed, zero writes");
    {
      const strangerId = `${TAG}-stranger2-${randomUUID().slice(0, 8)}`;
      const strangerEmail = `unapproved-${TAG}@Example.COM`;
      const out = await runAuth(strangerId, { email: strangerEmail });
      ok(out.nextCalled === false, "unapproved email: next() NOT called");
      ok(out.statusCode === 403, "unapproved email: status 403");
      ok(
        (out.jsonBody as any)?.code === "account_not_approved",
        "unapproved email: code account_not_approved",
      );
      ok(
        (out.jsonBody as any)?.email === strangerEmail.toLowerCase().trim(),
        "unapproved email: normalized email echoed in body",
      );
      ok(
        (await countRowsFor(strangerId, strangerEmail)) === 0,
        "unapproved email: ZERO users rows written",
      );
    }

    console.log("(C3) unapproved, HTML navigation → redirect /not-approved");
    {
      const strangerId = `${TAG}-stranger3-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(strangerId, {
        email: `unapproved-html-${TAG}@example.com`,
        accept: "text/html,application/xhtml+xml",
      });
      ok(out.nextCalled === false, "HTML deny: next() NOT called");
      ok(out.redirectedTo === "/not-approved", "HTML deny: redirect to /not-approved");
      ok(out.statusCode === null, "HTML deny: no JSON status");
    }

    console.log("(C3b) unapproved API call → 403 JSON regardless of Accept");
    {
      // /api/* paths NEVER redirect — even a text/html Accept (browser URL
      // bar, misconfigured client) gets machine-readable JSON. And callers
      // with no meaningful Accept (curl, fetch default */*) get JSON too;
      // the gate's mini-app route tests surfaced redirects as 404s.
      const strangerId = `${TAG}-stranger3b-${randomUUID().slice(0, 8)}`;
      const htmlApi = await runAuth(strangerId, {
        email: `unapproved-api-${TAG}@example.com`,
        accept: "text/html,application/xhtml+xml",
        url: "/api/churn/leaderboard",
      });
      ok(htmlApi.redirectedTo === null, "API deny: no redirect even for text/html");
      ok(htmlApi.statusCode === 403, "API deny: 403");
      ok(
        (htmlApi.jsonBody as any)?.code === "account_not_approved",
        "API deny: stable code",
      );
      const bareAccept = await runAuth(`${TAG}-stranger3c-${randomUUID().slice(0, 8)}`, {
        email: `unapproved-bare-${TAG}@example.com`,
        accept: "*/*",
      });
      ok(bareAccept.statusCode === 403, "bare-Accept deny: 403 JSON, no redirect");
      ok(bareAccept.redirectedTo === null, "bare-Accept deny: no redirect");
    }

    console.log("(C4) approved email → admitted with row role, linked, row adopted");
    {
      const approvedEmail = `approved-${TAG}@test.local`;
      const approvedRowId = await seedUser("approved-row", "team_lead", {
        email: approvedEmail,
      });
      const clerkId = `${TAG}-clerk-${randomUUID().slice(0, 8)}`;
      const linkCalls: Array<{ clerkUserId: string; localUserId: string }> = [];
      __test_setClerkLinkWriter(async (clerkUserId, localUserId) => {
        linkCalls.push({ clerkUserId, localUserId });
      });
      const verifierCalls: Array<{ clerkUserId: string; email: string }> = [];
      __test_setClerkEmailVerifier(async (clerkUserId, email) => {
        verifierCalls.push({ clerkUserId, email });
        return true;
      });
      try {
        // Email claim deliberately differs in CASE from the stored row —
        // the match must be case-insensitive.
        const out = await runAuth(clerkId, { email: `Approved-${TAG}@TEST.local` });
        ok(out.nextCalled, "approved: next() called");
        ok(out.req.dbUser?.id === approvedRowId, "approved: matched row adopted as req.dbUser");
        ok(
          out.req.user?.claims?.sub === approvedRowId,
          "approved: claims.sub = ADOPTED row id (not the Clerk id)",
        );
        ok(out.req.user?.id === approvedRowId, "approved: req.user.id = adopted row id");
        ok(
          out.req.user?.claims?.role === "team_lead",
          "approved: role comes from the pre-assigned row",
        );
        ok(linkCalls.length === 1, "approved: Clerk link writer called exactly once");
        ok(
          linkCalls[0]?.clerkUserId === clerkId && linkCalls[0]?.localUserId === approvedRowId,
          "approved: link writer got (clerkId, adopted row id)",
        );
        ok(
          verifierCalls.length === 1,
          "approved: email verifier consulted exactly once before link/adopt",
        );
        ok(
          verifierCalls[0]?.clerkUserId === clerkId &&
            verifierCalls[0]?.email === approvedEmail.toLowerCase(),
          "approved: verifier got (clerkId, NORMALIZED matched email)",
        );
        // Second request (token not yet refreshed → same unlinked id):
        // re-matches by email, admits again, link retried idempotently.
        const out2 = await runAuth(clerkId, { email: approvedEmail });
        ok(out2.nextCalled, "approved repeat: next() called again (pre-refresh window)");
        ok(out2.req.dbUser?.id === approvedRowId, "approved repeat: same row adopted");
        ok(linkCalls.length === 2, "approved repeat: link writer re-fired (idempotent value)");
      } finally {
        __test_setClerkLinkWriter(null);
        __test_setClerkEmailVerifier(null);
      }
    }

    console.log("(C4b) matching but UNVERIFIED email → denied, no link, zero writes");
    {
      // Broken-access-control guard: a session CLAIM naming an approved
      // address is not enough — Clerk must confirm the address is a
      // verified email of the signed-in user. Unverified ⇒ the standard
      // zero-write denial, and the link writer must never fire.
      const unverifiedEmail = `unverified-${TAG}@test.local`;
      await seedUser("unverified-row", "team_lead", { email: unverifiedEmail });
      const clerkId = `${TAG}-clerk-unv-${randomUUID().slice(0, 8)}`;
      const linkCalls: string[] = [];
      __test_setClerkLinkWriter(async (cid) => {
        linkCalls.push(cid);
      });
      __test_setClerkEmailVerifier(async () => false);
      try {
        const out = await runAuth(clerkId, { email: unverifiedEmail });
        ok(out.nextCalled === false, "unverified: next() NOT called");
        ok(out.statusCode === 403, "unverified: status 403");
        ok(
          (out.jsonBody as any)?.code === "account_not_approved",
          "unverified: code account_not_approved",
        );
        ok(linkCalls.length === 0, "unverified: Clerk link writer NEVER called");
        const [ghost] = await db.execute(
          sql`select 1 from users where id = ${clerkId} limit 1`,
        ).then((r: any) => r.rows);
        ok(ghost === undefined, "unverified: ZERO rows written for the Clerk id");
      } finally {
        __test_setClerkLinkWriter(null);
        __test_setClerkEmailVerifier(null);
      }
    }

    console.log("(C4c) verifier throws (Clerk outage) → fail-CLOSED denial, no link");
    {
      const outageEmail = `outage-${TAG}@test.local`;
      await seedUser("outage-row", "team_lead", { email: outageEmail });
      const clerkId = `${TAG}-clerk-outage-${randomUUID().slice(0, 8)}`;
      const linkCalls: string[] = [];
      __test_setClerkLinkWriter(async (cid) => {
        linkCalls.push(cid);
      });
      __test_setClerkEmailVerifier(async () => {
        throw new Error(`${TAG} synthetic Clerk outage`);
      });
      try {
        const out = await runAuth(clerkId, { email: outageEmail });
        ok(out.nextCalled === false, "outage: next() NOT called (fail-closed)");
        ok(out.statusCode === 403, "outage: status 403");
        ok(
          (out.jsonBody as any)?.code === "account_not_approved",
          "outage: standard zero-write denial code",
        );
        ok(linkCalls.length === 0, "outage: Clerk link writer NEVER called");
      } finally {
        __test_setClerkLinkWriter(null);
        __test_setClerkEmailVerifier(null);
      }
    }

    console.log("(C5) legacy casing collision → deterministic oldest-row match");
    {
      const collideLower = `collide-${TAG}@test.local`;
      const olderId = await seedUser("collide-older", "team_lead", {
        email: `Collide-${TAG}@test.local`,
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      await seedUser("collide-newer", "account_manager", {
        email: collideLower,
        createdAt: new Date().toISOString(),
      });
      const clerkId = `${TAG}-clerk-collide-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, { email: collideLower.toUpperCase() });
      ok(out.nextCalled, "collision: next() called");
      ok(
        out.req.dbUser?.id === olderId,
        "collision: OLDEST created_at row wins deterministically",
      );
    }

    console.log("(C6) soft-deleted row's email → denied (allowlist = live rows only)");
    {
      const deadEmail = `dead-${TAG}@test.local`;
      const deadRowId = await seedUser("dead-email-row", "account_manager", {
        email: deadEmail,
      });
      await softDeleteUser(deadRowId);
      const clerkId = `${TAG}-clerk-dead-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, { email: deadEmail });
      ok(out.nextCalled === false, "deleted-email: next() NOT called");
      ok(out.statusCode === 403, "deleted-email: status 403 (not revoked — no id match)");
      ok(
        (out.jsonBody as any)?.code === "account_not_approved",
        "deleted-email: code account_not_approved",
      );
    }

    console.log("(C7) company-domain equivalence: .co row admits .com login");
    {
      const expectedLogin = `eqv-${TAG}@nobullmarketing.com`.toLowerCase();
      const coRowId = await seedUser("eqv-co-row", "account_manager", {
        email: `eqv-${TAG}@nobullmarketing.co`,
      });
      const clerkId = `${TAG}-clerk-eqv-${randomUUID().slice(0, 8)}`;
      const linkCalls: Array<{ clerkUserId: string; localUserId: string }> = [];
      __test_setClerkLinkWriter(async (clerkUserId, localUserId) => {
        linkCalls.push({ clerkUserId, localUserId });
      });
      const verifierCalls: Array<{ clerkUserId: string; email: string }> = [];
      __test_setClerkEmailVerifier(async (clerkUserId, email) => {
        verifierCalls.push({ clerkUserId, email });
        return true;
      });
      try {
        // Mixed case on purpose — normalization must precede the swap.
        const out = await runAuth(clerkId, {
          email: `Eqv-${TAG}@NoBullMarketing.COM`,
        });
        ok(out.nextCalled, "equivalence: next() called");
        ok(
          out.req.dbUser?.id === coRowId,
          "equivalence: .co-stored row adopted for the .com login",
        );
        ok(
          out.req.user?.claims?.sub === coRowId,
          "equivalence: claims.sub = adopted row id",
        );
        ok(
          linkCalls.length === 1 && linkCalls[0]?.localUserId === coRowId,
          "equivalence: Clerk link writer got the adopted row id",
        );
        ok(
          verifierCalls.length === 1 && verifierCalls[0]?.email === expectedLogin,
          "equivalence: verifier consulted with the LOGIN address (not the stored variant)",
        );
      } finally {
        __test_setClerkLinkWriter(null);
        __test_setClerkEmailVerifier(null);
      }
    }

    console.log("(C7b) exact-address match beats an OLDER company-domain variant row");
    {
      const local = `eqv-both-${TAG}`;
      await seedUser("eqv-older-variant", "team_lead", {
        email: `${local}@nobullmarketing.co`,
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      const exactId = await seedUser("eqv-exact", "account_manager", {
        email: `${local}@nobullmarketing.com`,
        createdAt: new Date().toISOString(),
      });
      const clerkId = `${TAG}-clerk-eqvb-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, { email: `${local}@nobullmarketing.com` });
      ok(out.nextCalled, "exact-vs-variant: next() called");
      ok(
        out.req.dbUser?.id === exactId,
        "exact-vs-variant: exact-address row wins even though the variant row is OLDER",
      );
    }

    console.log("(C7c) equivalence is scoped to the two company domains ONLY");
    {
      // A generic .co↔.com heuristic would wrongly match this row; the
      // allow-listed pair must not.
      await seedUser("eqv-foreign", "account_manager", {
        email: `eqv-foreign-${TAG}@example.co`,
      });
      const clerkId = `${TAG}-clerk-eqvc-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, { email: `eqv-foreign-${TAG}@example.com` });
      ok(
        out.nextCalled === false,
        "foreign-domain: next() NOT called (no generic .co↔.com swap)",
      );
      ok(out.statusCode === 403, "foreign-domain: status 403");
      ok(
        (out.jsonBody as any)?.code === "account_not_approved",
        "foreign-domain: denied as not approved",
      );
    }

    console.log("(C7d) variant match still requires Clerk-verified login email");
    {
      await seedUser("eqv-unverified", "account_manager", {
        email: `eqv-unv-${TAG}@nobullmarketing.co`,
      });
      const clerkId = `${TAG}-clerk-eqvd-${randomUUID().slice(0, 8)}`;
      const linkCalls: string[] = [];
      __test_setClerkLinkWriter(async (cid) => {
        linkCalls.push(cid);
      });
      __test_setClerkEmailVerifier(async () => false);
      try {
        const out = await runAuth(clerkId, {
          email: `eqv-unv-${TAG}@nobullmarketing.com`,
        });
        ok(out.nextCalled === false, "variant-unverified: next() NOT called");
        ok(out.statusCode === 403, "variant-unverified: status 403");
        ok(
          (out.jsonBody as any)?.code === "account_not_approved",
          "variant-unverified: code account_not_approved",
        );
        ok(linkCalls.length === 0, "variant-unverified: link writer NEVER called");
      } finally {
        __test_setClerkLinkWriter(null);
        __test_setClerkEmailVerifier(null);
      }
    }

    console.log("(C7e) soft-deleted variant row → denied (live rows only)");
    {
      const deadId = await seedUser("eqv-dead", "account_manager", {
        email: `eqv-dead-${TAG}@nobullmarketing.co`,
      });
      await softDeleteUser(deadId);
      const clerkId = `${TAG}-clerk-eqve-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, {
        email: `eqv-dead-${TAG}@nobullmarketing.com`,
      });
      ok(out.nextCalled === false, "deleted-variant: next() NOT called");
      ok(
        (out.jsonBody as any)?.code === "account_not_approved",
        "deleted-variant: denied as not approved",
      );
    }

    console.log("(C7f) symmetric direction: .com row admits .co login");
    {
      const comRowId = await seedUser("eqv-com-row", "team_lead", {
        email: `eqv-sym-${TAG}@nobullmarketing.com`,
      });
      const clerkId = `${TAG}-clerk-eqvf-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, {
        email: `eqv-sym-${TAG}@nobullmarketing.co`,
      });
      ok(out.nextCalled, "symmetric: next() called");
      ok(
        out.req.dbUser?.id === comRowId,
        "symmetric: .com-stored row adopted for the .co login",
      );
    }

    console.log("(C7g) twin-path collision → oldest row wins on the variant lookup too");
    {
      // Two LIVE rows case-colliding on the variant address: the second
      // lookup must keep the same deterministic oldest-wins ordering as
      // the exact-address path (C5).
      const local = `eqv-coll-${TAG}`;
      const olderId = await seedUser("eqv-coll-older", "team_lead", {
        email: `${local.toUpperCase()}@nobullmarketing.co`,
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      await seedUser("eqv-coll-newer", "account_manager", {
        email: `${local}@nobullmarketing.co`,
        createdAt: new Date().toISOString(),
      });
      const clerkId = `${TAG}-clerk-eqvg-${randomUUID().slice(0, 8)}`;
      const out = await runAuth(clerkId, { email: `${local}@nobullmarketing.com` });
      ok(out.nextCalled, "twin collision: next() called");
      ok(
        out.req.dbUser?.id === olderId,
        "twin collision: OLDEST created_at row wins through the variant lookup",
      );
    }

    // (D) Soft-deleted user — API request → 401 Access revoked
    console.log("(D) soft-deleted user, API request → 401");
    const deletedId = await seedUser("deleted");
    await softDeleteUser(deletedId);
    {
      const out = await runAuth(deletedId, { accept: "application/json" });
      ok(out.nextCalled === false, "deleted: next() NOT called");
      ok(out.statusCode === 401, "deleted API: status 401");
      ok(
        (out.jsonBody as any)?.message === "Access revoked",
        "deleted API: JSON body { message: 'Access revoked' }",
      );
    }

    // (E) Soft-deleted user — HTML request → redirect
    console.log("(E) soft-deleted user, HTML request → redirect /access-revoked");
    {
      const out = await runAuth(deletedId, { accept: "text/html,application/xhtml+xml" });
      ok(out.nextCalled === false, "deleted HTML: next() NOT called");
      ok(out.redirectedTo === "/access-revoked", "deleted HTML: redirect to /access-revoked");
      ok(out.statusCode === null, "deleted HTML: no 401 status");
    }

    // (F) __test_isClaimsSubRevoked seam
    console.log("(F) __test_isClaimsSubRevoked seam");
    {
      const liveId = await seedUser("revoke-live");
      const deadId = await seedUser("revoke-dead");
      await softDeleteUser(deadId);
      const neverSeenId = `${TAG}-never-seen-${randomUUID()}`;

      ok(await __test_isClaimsSubRevoked(undefined) === false, "isClaimsSubRevoked: undefined → false");
      ok(await __test_isClaimsSubRevoked("") === false, "isClaimsSubRevoked: empty → false");
      ok(await __test_isClaimsSubRevoked(liveId) === false, "isClaimsSubRevoked: live user → false");
      ok(await __test_isClaimsSubRevoked(deadId) === true, "isClaimsSubRevoked: soft-deleted → true");
      ok(await __test_isClaimsSubRevoked(neverSeenId) === false, "isClaimsSubRevoked: unknown → false (fail-open)");
    }

    // (G) POST /api/users approval endpoint — authz parity + contract
    console.log("(G) POST /api/users — approval endpoint authz + contract");
    {
      const tlId = await seedUser("g-teamlead", "team_lead");
      const amId = await seedUser("g-member", "account_manager");
      const newEmail = `Newly.Approved-${TAG}@Test.Local`;

      await withSettingsApp(null, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: newEmail }),
        });
        ok(r.status === 401, "endpoint: unauthenticated → 401");
      });

      await withSettingsApp(amId, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: newEmail }),
        });
        ok(r.status === 403, "endpoint: account_manager → 403 (cannot approve)");
      });

      await withSettingsApp(tlId, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: newEmail,
            firstName: "Newly",
            functions: [],
            authorityLevel: "core",
          }),
        });
        ok(r.status === 201, `endpoint: team_lead → 201 (got ${r.status})`);
        const created: any = await r.json();
        ok(
          created?.email === newEmail.trim().toLowerCase(),
          "endpoint: email stored lowercased",
        );
        ok(
          created?.role === "account_manager",
          "endpoint: role derived from core authority",
        );
        ok(typeof created?.id === "string" && created.id.length > 0, "endpoint: id generated");

        // Case-insensitive duplicate → 409.
        const dup = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: newEmail.toUpperCase() }),
        });
        ok(dup.status === 409, "endpoint: case-insensitive duplicate → 409");

        // Invalid body → 400.
        const bad = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "not-an-email" }),
        });
        ok(bad.status === 400, "endpoint: invalid email → 400");

        // The approved row is now admissible end-to-end: a fresh Clerk
        // identity with that email (any casing) is admitted with the row.
        const clerkId = `${TAG}-clerk-endpoint-${randomUUID().slice(0, 8)}`;
        const out = await runAuth(clerkId, { email: newEmail });
        ok(out.nextCalled, "endpoint→admission: approved email admits the new identity");
        ok(
          out.req.dbUser?.id === created.id,
          "endpoint→admission: adopted row is the endpoint-created one",
        );
      });
    }
  } finally {
    await cleanupUsers();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;

  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

run().catch(async (err) => {
  console.error("clerk-requireauth test crashed:", err);
  process.exitCode = 1;
  try {
    await cleanupUsers();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
