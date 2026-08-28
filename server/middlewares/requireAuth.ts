import { getAuth } from "@clerk/express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db } from "../db";
import { users } from "@shared/schema";

// ── Test-only module-level registry ──────────────────────────────────────────
// Tests that seed users inside an uncommitted runInTxSandbox transaction call
// __test_markUserReconciled(userId, profile) to pre-register the user here.
// requireAuthImpl uses the profile directly (no SELECT/INSERT) so it never
// lock-waits on the tx-sandbox row. Replaces replitAuth.__test_markUserReconciled.
const __testProvisionedUsers = new Map<string, Record<string, unknown>>();

// ── Closed admission helpers (Task #4554) ────────────────────────────────────
// JIT provisioning is REMOVED: the `users` table is the sign-in allowlist.
// A session whose id has no row is admitted only when its email matches a
// pre-approved (admin-created), non-deleted row AND the Clerk Backend API
// confirms that address is a VERIFIED email of the signed-in Clerk user
// (session claims alone carry no verification guarantee); everyone else is
// denied WITHOUT writing anything.
//
// Optional hardening (Task #4611):
// Clerk Dashboard → Configure → Restrictions → Sign-up mode: Restricted can
// additionally block sign-UP for non-invited emails so strangers never even
// get a Clerk account. This middleware is the authoritative gate either way —
// the dashboard setting only reduces noise (orphaned Clerk accounts that
// would sit denied here).
// ENABLING: CEO navigates to /admin/system-health?tab=auth and presses
// "Enable Restricted Sign-up". The button calls POST
// /api/admin/clerk/enable-restricted-signup (CEO-only), which PATCHes the
// Clerk instance allowlist flag via the Backend API. Must be done separately
// for the Development instance (dev app) and the Production instance
// (deployed app at its prod URL).
// STATE (Task #4569 / Task #4611): NOT yet enabled on dev or prod.
// Update this note once the CEO has pressed the button in both environments.

function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim().toLowerCase();
  return email.length > 0 ? email : undefined;
}

/**
 * Resolve the session's CANDIDATE email. Test seam first (mirrors
 * __test_clerkUserId): tests set (req as any).__test_clerkEmail. Real path
 * reads Clerk session claims; getAuth throws when clerkMiddleware is not
 * mounted — treated as "no email" (deny, never crash). The claim names a
 * candidate only — admission additionally requires isClerkEmailVerified()
 * to confirm verification status on the match path.
 */
function resolveSessionEmail(
  req: Parameters<RequestHandler>[0],
): string | undefined {
  if (
    process.env.NODE_ENV === "test" &&
    (req as any).__test_clerkEmail !== undefined
  ) {
    return normalizeEmail((req as any).__test_clerkEmail);
  }
  try {
    const auth = getAuth(req);
    return normalizeEmail(auth?.sessionClaims?.email);
  } catch {
    return undefined;
  }
}

/**
 * The company operates BOTH of these Google Workspace domains; staff rows
 * created in the Replit-login era may store either variant while the
 * person's Google account uses the other. Owner-approved equivalence
 * (2026-08-13): a login address on one domain also matches a row stored
 * under the other — SAME local part, these two domains ONLY. Safe because
 * both domains are company-controlled, the login address must still be
 * Clerk-VERIFIED (isClerkEmailVerified, fail-closed), and the roster stays
 * closed — no row, no entry.
 */
const EQUIVALENT_COMPANY_DOMAINS = ["nobullmarketing.com", "nobullmarketing.co"] as const;

/** Company-domain twin of a NORMALIZED (lowercase) email — exact local
 *  part, .com↔.co — or undefined for every other domain. */
function companyDomainVariant(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const [com, co] = EQUIVALENT_COMPANY_DOMAINS;
  if (domain === com) return `${local}@${co}`;
  if (domain === co) return `${local}@${com}`;
  return undefined;
}

/**
 * Match a verified email against the allowlist: non-deleted rows compared
 * case-insensitively (approved rows store lowercase; legacy rows may be
 * mixed-case). Deterministic when several legacy rows collide on
 * lower(email): oldest row wins (created_at ASC NULLS LAST, id tie-break).
 * An EXACT-address match always beats the company-domain variant — the
 * variant is queried only when the login address itself matches no row.
 */
async function matchApprovedRowByEmail(
  email: string,
): Promise<typeof users.$inferSelect | undefined> {
  const exact = await selectLiveRowByEmail(email);
  if (exact) return exact;
  const variant = companyDomainVariant(email);
  return variant ? await selectLiveRowByEmail(variant) : undefined;
}

async function selectLiveRowByEmail(
  email: string,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
    .orderBy(sql`${users.createdAt} asc nulls last`, asc(users.id))
    .limit(1);
  return row;
}

/**
 * One-time identity link: writes the matched row's id into the Clerk user's
 * externalId so the session token's `userId` claim resolves straight to the
 * row once the token refreshes (~60s). Until then requests re-match by email
 * — harmless, read-only. Idempotent (fixed value → safe to retry).
 *
 * Fail-open BY DESIGN (link only, never admission): a Clerk API outage must
 * not lock out an approved user — the request still adopts the matched row
 * and the link retries on a later request. The writer is injectable for
 * tests; the default never egresses under NODE_ENV=test so suites stay
 * hermetic even without an override.
 */
type ClerkLinkWriter = (
  clerkUserId: string,
  localUserId: string,
) => Promise<void>;
let __clerkLinkWriterOverride: ClerkLinkWriter | null = null;
export function __test_setClerkLinkWriter(
  writer: ClerkLinkWriter | null,
): void {
  __clerkLinkWriterOverride = writer;
}

async function linkClerkExternalId(
  clerkUserId: string,
  localUserId: string,
): Promise<void> {
  try {
    if (__clerkLinkWriterOverride) {
      await __clerkLinkWriterOverride(clerkUserId, localUserId);
      return;
    }
    if (process.env.NODE_ENV === "test") return;
    const { clerkClient } = await import("@clerk/express");
    await clerkClient.users.updateUser(clerkUserId, {
      externalId: localUserId,
    });
  } catch (err) {
    console.warn(
      `[requireAuth] Clerk externalId link failed (clerkUserId=${clerkUserId} → user=${localUserId}); admission proceeds, link retries next request:`,
      err,
    );
  }
}

/**
 * Verified-email gate for the one-time email-match path. The session claim
 * names a CANDIDATE address; before an unlinked Clerk identity may adopt a
 * pre-approved row, the Clerk Backend API must confirm that exact address
 * belongs to the signed-in user WITH verification.status === "verified" —
 * sessionClaims.email alone carries no verification guarantee (custom claim
 * configs can surface unverified addresses).
 *
 * Fail-CLOSED (opposite of the link writer, deliberately): any error —
 * Clerk outage, missing native id — denies with the standard zero-write
 * not-approved response; the next request retries. Only FIRST sign-ins pass
 * through here (already-linked identities resolve id → row above), so an
 * outage never locks out existing users. Injectable for tests; under
 * NODE_ENV=test without an override the seam email counts as verified
 * (rejection cases inject via __test_setClerkEmailVerifier).
 */
type ClerkEmailVerifier = (
  clerkUserId: string,
  email: string,
) => Promise<boolean>;
let __clerkEmailVerifierOverride: ClerkEmailVerifier | null = null;
export function __test_setClerkEmailVerifier(
  verifier: ClerkEmailVerifier | null,
): void {
  __clerkEmailVerifierOverride = verifier;
}

async function isClerkEmailVerified(
  clerkUserId: string | undefined,
  email: string,
): Promise<boolean> {
  try {
    if (__clerkEmailVerifierOverride) {
      return await __clerkEmailVerifierOverride(clerkUserId ?? "", email);
    }
    if (process.env.NODE_ENV === "test") return true;
    if (!clerkUserId) return false;
    const { clerkClient } = await import("@clerk/express");
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    return clerkUser.emailAddresses.some(
      (e) =>
        normalizeEmail(e.emailAddress) === email &&
        e.verification?.status === "verified",
    );
  } catch (err) {
    console.warn(
      `[requireAuth] Clerk email verification check failed (clerkUserId=${clerkUserId}); admission denied fail-closed, retries next request:`,
      err,
    );
    return false;
  }
}

/**
 * Deny an authenticated-but-unapproved session. JSON callers get a 403 with
 * a stable `code` (distinct from 401 signed-out and 401 access-revoked so
 * the client can route the states differently); browser navigations go to
 * the public /not-approved page. Never writes anything.
 */
function denyNotApproved(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  email: string | undefined,
): void {
  // API routes and non-navigation callers ALWAYS get machine-readable JSON:
  // a fetch()/curl caller with no Accept header (or */*) must never receive
  // a 302-to-HTML — mini-app route tests without the SPA catch-all surfaced
  // that as mysterious 404s. Only a genuine browser navigation (Accept:
  // text/html on a non-/api path) is routed to the public page.
  const acceptHeader = String((req.headers as any).accept ?? "");
  const isApiPath = String(
    (req as any).originalUrl ?? (req as any).url ?? "",
  ).startsWith("/api");
  if (!isApiPath && /text\/html/.test(acceptHeader)) {
    (res as any).redirect("/not-approved");
  } else {
    res.status(403).json({
      message: "Account not approved",
      code: "account_not_approved",
      email: email ?? null,
    });
  }
}

// ── Async implementation ──────────────────────────────────────────────────────
const requireAuthImpl = async (
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): Promise<void> => {
  // ── Step 1: resolve the local userId ───────────────────────────────────────

  // Per-request test seam: tests that build mini Express apps without a real
  // Clerk session set (req as any).__test_clerkUserId = userId (string) or null
  // to inject an authenticated or unauthenticated identity.
  const perRequestTestId =
    process.env.NODE_ENV === "test"
      ? ((req as any).__test_clerkUserId as string | null | undefined)
      : undefined;

  let userId: string | undefined;
  if (perRequestTestId !== undefined) {
    userId = perRequestTestId ?? undefined; // null → undefined → 401 below
  } else {
    // Guard: getAuth() throws when clerkMiddleware was not mounted (e.g. in an
    // isolated route test that does not boot the full app). Treat as anonymous.
    let auth: ReturnType<typeof getAuth> | null = null;
    try {
      auth = getAuth(req);
    } catch {
      // Clerk middleware not mounted — unauthenticated.
    }
    // sessionClaims.userId = legacy Replit Auth sub ID (preserved as Clerk
    // externalId for migrated users) or Clerk native ID for new users. Always
    // use for local DB lookups. auth.userId = Clerk native ID; Clerk API only.
    userId =
      (auth?.sessionClaims?.userId as string | undefined) ||
      auth?.userId ||
      undefined;
  }

  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  // ── Step 2: resolve / provision the local users row ───────────────────────

  let dbUser: (typeof users.$inferSelect) | Record<string, unknown> | undefined;

  // Fast path: test-mode pre-provisioned profile (avoids lock-wait on sandbox).
  const provisioned = __testProvisionedUsers.get(userId);
  if (provisioned) {
    dbUser = provisioned;
  } else {
    [dbUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!dbUser) {
      // Closed admission (Task #4554): no JIT row creation. Admit only when
      // the session's verified email matches a pre-approved, non-deleted
      // row; otherwise deny without writing anything.
      const email = resolveSessionEmail(req);
      const matched = email ? await matchApprovedRowByEmail(email) : undefined;
      if (!matched) {
        denyNotApproved(req, res, email);
        return;
      }
      // auth.userId is the Clerk-native id the Backend API needs; under the
      // test seam getAuth is unmounted → fall back to the seam id.
      let clerkNativeId: string | undefined;
      try {
        clerkNativeId = getAuth(req)?.userId ?? undefined;
      } catch {
        // Clerk middleware not mounted.
      }
      // Verification gate BEFORE any link/adopt side effect: the matched
      // address must be a verified email of the signed-in Clerk user
      // (fail-closed — see isClerkEmailVerified). Same zero-write denial as
      // an unmatched email.
      if (!(await isClerkEmailVerified(clerkNativeId ?? userId, email!))) {
        denyNotApproved(req, res, email);
        return;
      }
      // First sign-in for this approved row: link the Clerk identity to it
      // (best-effort — see linkClerkExternalId) and adopt it for this
      // request.
      await linkClerkExternalId(clerkNativeId ?? userId, matched.id);
      // First-sign-in side effect: idempotent default Comms channel join
      // (pre-approved rows never went through an insert-time join).
      try {
        const { autoJoinDefaultChannels } = await import(
          "../services/commsDefaultChannels"
        );
        await autoJoinDefaultChannels(matched.id);
      } catch (e) {
        // Non-fatal: best-effort channel join (same policy as the JIT era).
        console.warn("[requireAuth] autoJoinDefaultChannels failed:", e);
      }
      dbUser = matched;
    }
  }

  // ── Step 3: reject soft-deleted users ─────────────────────────────────────
  // Mirrors the Replit Auth per-request revocation re-check gate. Follows the
  // same isApiPath-aware branching as denyNotApproved: API routes and any
  // caller not explicitly asking for an HTML navigation (fetch()'s default
  // Accept is "*/*", not "application/json") must always get machine-readable
  // JSON — a 302-to-HTML here made /api/auth/user's own fetch() follow the
  // redirect and choke on non-JSON, so the client never learned it was
  // revoked and fell through to a sign-in loop instead of /access-revoked.
  if ((dbUser as any).deletedAt) {
    const acceptHeader = String((req.headers as any).accept ?? "");
    const isApiPath = String(
      (req as any).originalUrl ?? (req as any).url ?? "",
    ).startsWith("/api");
    if (!isApiPath && /text\/html/.test(acceptHeader)) {
      (res as any).redirect("/access-revoked");
    } else {
      res.status(401).json({ message: "Access revoked", code: "account_revoked" });
    }
    return;
  }

  // ── Step 4: populate request context ──────────────────────────────────────
  (req as any).dbUser = dbUser;

  // Effective local identity: the users row id. On the email-match path the
  // session claim id is a Clerk-native id with no row — attribution/FK
  // writes must use the adopted row's id, not the claim (Task #4554).
  const effectiveUserId = ((dbUser as any).id as string | undefined) ?? userId;

  // Populate req.user with a legacy-compatible shape so the hundreds of route
  // handlers that still read req.user?.claims?.sub / req.user?.dbUser / etc.
  // continue to work without per-file rewrites. New code should prefer
  // req.dbUser (already typed) or getAuth(req) directly.
  (req as any).user = {
    claims: {
      sub: effectiveUserId,
      role: (dbUser as any).role ?? undefined,
    },
    dbUser,
    id: effectiveUserId,
    username: (dbUser as any).username ?? (dbUser as any).email ?? "",
  };

  next();
};

export const requireAuth: RequestHandler = (req, res, next) => {
  void requireAuthImpl(req, res, next).catch((err) => {
    console.error("[requireAuth] middleware threw:", err);
    next(err);
  });
};

// Backward-compatible alias — route files that imported `isAuthenticated` from the
// old Replit Auth module continue to work without renaming each call site.
export const isAuthenticated = requireAuth;

// ── Test-only helpers ─────────────────────────────────────────────────────────

/**
 * Pre-register a user for test mode so requireAuth uses the provided profile
 * directly (no DB SELECT/INSERT). Call before making authenticated requests in
 * tests that seed users inside an uncommitted runInTxSandbox transaction.
 *
 * Replaces replitAuth.__test_markUserReconciled.
 */
export function __test_markUserReconciled(
  userId: string,
  profile?: Record<string, unknown>,
): void {
  __testProvisionedUsers.set(userId, profile ?? { id: userId });
}

/**
 * Clear all pre-registered test users. Call in finally blocks or between suites.
 * Replaces replitAuth.__test_resetReconciledUsers.
 */
export function __test_resetReconciledUsers(): void {
  __testProvisionedUsers.clear();
}

/**
 * Returns true when the user is soft-deleted in the DB (deleted_at IS NOT NULL).
 * Returns false for undefined/empty id or users not found in DB (fail-open).
 *
 * Replaces replitAuth.__test_isClaimsSubRevoked for the Clerk migration era:
 * revocation is now stored in the users.deleted_at column rather than an
 * in-memory Set populated by the OIDC verify callback.
 */
export async function __test_isClaimsSubRevoked(
  id: string | undefined,
): Promise<boolean> {
  if (!id) return false;
  const [row] = await db
    .select({ deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return !!row?.deletedAt;
}
