// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type User, users,
  type Client, type InsertClient, clients,
  type UpdateClient, updateClientSchema,
  type ClientLocation, type InsertClientLocation, clientLocations,
  type UpdateClientLocation, updateClientLocationSchema,
  clientLocationsAudit,
  type ClientDataAccess, type InsertClientDataAccess, clientDataAccess,
  type ClientContact, type InsertClientContact, clientContacts,
  type UpdateClientContact, updateClientContactSchema,
  clientContactsAudit,
  type ImportEntitySuggestion, type InsertImportEntitySuggestion, importEntitySuggestions,
  reports, reportSections,
  commandPanelVersions, commandPanelHistory, commandPanels,
  intelligenceFeedEntries, actionLogEntries,
  clientAgentMemory, agentMatchDecisions, clientAgentChats,
  pandadocDocuments,
  clientDailyJudgments, clientCommunicationInsights,
  clientRelationshipSignals, clientOpenAsks,
  rawCommunicationRecords,
  communicationOrphanEvents,
  scheduledMeetings,
  threadAssignments,
  systemSettings,
} from "@shared/schema";
import { getDb } from "../db";
import { desc, eq, and, sql, inArray, or, ne, not, count, gt, arrayContains, arrayOverlaps, type SQL } from "drizzle-orm";
import { REVENUE_FUNCTIONS, FULFILLMENT_FUNCTIONS } from "../auth/permissions";
import { stageClientMirrorIntentInTx } from "../services/clickUpClientMirrorKick";

/**
 * Task #1909 — pre-delete impact summary for a user.
 *
 * Counts the active work for which `userId` is the sole assignee, so
 * the User Management UI can warn the CEO before a soft-delete silently
 * orphans clients, threads, or upcoming bookings. The CEO must
 * reassign first, or override with `?force=true`.
 *
 * Surfaces:
 *  - `assignedClients`: non-archived, non-demo clients whose `ownerId`
 *    is this user. The single-owner column means losing them = orphan.
 *  - `openThreads`: rows in `thread_assignments` assigned to this user
 *    whose status is not `resolved` (so `open` + `needs_follow_up`).
 *    Covers both Front and Twilio surfaces since the table is unified.
 *  - `upcomingBookings`: scheduled meetings where this user is the
 *    `account_manager_user_id`, the meeting starts in the future, and
 *    the status is live (`creating` or `confirmed` — canceled / failed
 *    are excluded).
 *
 * Returns a small sample list (max 5) for each surface so the UI can
 * show *which* work would be orphaned, not just a count.
 */
export type UserAssignmentImpact = {
  assignedClients: {
    count: number;
    sample: Array<{ id: string; firmName: string }>;
  };
  openThreads: {
    count: number;
    sample: Array<{ threadKey: string; status: string }>;
  };
  upcomingBookings: {
    count: number;
    sample: Array<{
      id: string;
      startTimeUtc: Date;
      inviteeName: string | null;
      clientId: string | null;
    }>;
  };
  hasImpact: boolean;
};

const IMPACT_SAMPLE_SIZE = 5;

export async function getUserAssignmentImpact(
  userId: string,
): Promise<UserAssignmentImpact> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:getAssignmentImpact", async () => {
    const now = new Date();
    const [clientRows, threadRows, bookingRows] = await Promise.all([
      getDb()
        .select({ id: clients.id, firmName: clients.firmName })
        .from(clients)
        .where(
          and(
            eq(clients.ownerId, userId),
            or(eq(clients.isArchived, false), sql`${clients.isArchived} IS NULL`),
            or(eq(clients.isDemo, false), sql`${clients.isDemo} IS NULL`),
          ),
        ),
      getDb()
        .select({
          threadKey: threadAssignments.threadKey,
          status: threadAssignments.status,
        })
        .from(threadAssignments)
        .where(
          and(
            eq(threadAssignments.assignedToUserId, userId),
            ne(threadAssignments.status, "resolved"),
          ),
        ),
      getDb()
        .select({
          id: scheduledMeetings.id,
          startTimeUtc: scheduledMeetings.startTimeUtc,
          inviteeName: scheduledMeetings.inviteeName,
          clientId: scheduledMeetings.clientId,
        })
        .from(scheduledMeetings)
        .where(
          and(
            eq(scheduledMeetings.accountManagerUserId, userId),
            gt(scheduledMeetings.startTimeUtc, now),
            inArray(scheduledMeetings.status, ["creating", "confirmed"]),
          ),
        )
        .orderBy(scheduledMeetings.startTimeUtc),
    ]);

    const impact: UserAssignmentImpact = {
      assignedClients: {
        count: clientRows.length,
        sample: clientRows.slice(0, IMPACT_SAMPLE_SIZE).map((r) => ({
          id: r.id,
          firmName: r.firmName,
        })),
      },
      openThreads: {
        count: threadRows.length,
        sample: threadRows.slice(0, IMPACT_SAMPLE_SIZE).map((r) => ({
          threadKey: r.threadKey,
          status: r.status,
        })),
      },
      upcomingBookings: {
        count: bookingRows.length,
        sample: bookingRows.slice(0, IMPACT_SAMPLE_SIZE),
      },
      hasImpact: false,
    };
    impact.hasImpact =
      impact.assignedClients.count > 0 ||
      impact.openThreads.count > 0 ||
      impact.upcomingBookings.count > 0;
    return impact;
  });
}

/**
 * Task #1934 — bulk-reassign every surface a soon-to-be-deleted user
 * still owns to a single new owner. Mirrors the surfaces counted by
 * `getUserAssignmentImpact` so the delete dialog can flip the impact
 * counts to zero in one round-trip:
 *
 *  - clients.owner_id        (non-archived, non-demo)
 *  - thread_assignments      (status != 'resolved')
 *  - scheduled_meetings      (future, status ∈ creating|confirmed)
 *
 * Returns the number of rows updated per surface so the caller can
 * record the reassignment in the activity log alongside the eventual
 * `user_deleted` entry.
 */
export type ReassignUserWorkSurface = "clients" | "threads" | "bookings";

// Task #1950 — per-surface items moved by a reassignment, captured so
// the audit log records *which* clients / threads / bookings ended up
// with the new owner, not just the counts. `label` is a human-friendly
// name suitable for direct display in the admin UI.
export type ReassignedClientItem = { id: string; label: string };
export type ReassignedThreadItem = { threadKey: string };
export type ReassignedBookingItem = {
  id: string;
  label: string;
  startTimeUtc: string;
};

export type ReassignUserWorkItems = {
  clients: ReassignedClientItem[];
  threads: ReassignedThreadItem[];
  bookings: ReassignedBookingItem[];
};

export type ReassignUserWorkResult = {
  clients: number;
  threads: number;
  bookings: number;
  items: ReassignUserWorkItems;
};

export async function reassignUserWork(
  fromUserId: string,
  toUserId: string,
  surfaces: ReassignUserWorkSurface[],
  actorUserId: string,
): Promise<ReassignUserWorkResult> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:reassignWork", async () => {
    const now = new Date();
    const items: ReassignUserWorkItems = { clients: [], threads: [], bookings: [] };
    const result: ReassignUserWorkResult = {
      clients: 0,
      threads: 0,
      bookings: 0,
      items,
    };
    const want = new Set(surfaces);

    if (want.has("clients")) {
      const rows = await getDb()
        .update(clients)
        .set({ ownerId: toUserId, updatedAt: now })
        .where(
          and(
            eq(clients.ownerId, fromUserId),
            or(eq(clients.isArchived, false), sql`${clients.isArchived} IS NULL`),
            or(eq(clients.isDemo, false), sql`${clients.isDemo} IS NULL`),
          ),
        )
        .returning({ id: clients.id, firmName: clients.firmName });
      result.clients = rows.length;
      items.clients = rows.map((r) => ({ id: r.id, label: r.firmName }));
    }

    if (want.has("threads")) {
      const rows = await getDb()
        .update(threadAssignments)
        .set({
          assignedToUserId: toUserId,
          updatedByUserId: actorUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(threadAssignments.assignedToUserId, fromUserId),
            ne(threadAssignments.status, "resolved"),
          ),
        )
        .returning({ threadKey: threadAssignments.threadKey });
      result.threads = rows.length;
      items.threads = rows.map((r) => ({ threadKey: r.threadKey }));
    }

    if (want.has("bookings")) {
      const rows = await getDb()
        .update(scheduledMeetings)
        .set({ accountManagerUserId: toUserId, updatedAt: now })
        .where(
          and(
            eq(scheduledMeetings.accountManagerUserId, fromUserId),
            gt(scheduledMeetings.startTimeUtc, now),
            inArray(scheduledMeetings.status, ["creating", "confirmed"]),
          ),
        )
        .returning({
          id: scheduledMeetings.id,
          meetingTypeName: scheduledMeetings.meetingTypeName,
          inviteeName: scheduledMeetings.inviteeName,
          startTimeUtc: scheduledMeetings.startTimeUtc,
        });
      result.bookings = rows.length;
      items.bookings = rows.map((r) => ({
        id: r.id,
        label:
          [r.meetingTypeName, r.inviteeName].filter(Boolean).join(" — ") ||
          "Meeting",
        startTimeUtc:
          r.startTimeUtc instanceof Date
            ? r.startTimeUtc.toISOString()
            : String(r.startTimeUtc),
      }));
    }

    return result;
  });
}

export async function getUser(id: string): Promise<User | undefined> {
  // Task #1866: soft-deleted users are gone from the app — they must
  // not surface in role checks, pickers, or any normal read path.
  // Auth-layer revocation checks must use `getUserIncludingDeleted`.
  const [user] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.id, id), sql`${users.deletedAt} IS NULL`));
  return user;
}

export async function getUserIncludingDeleted(id: string): Promise<User | undefined> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:getIncludingDeleted", async () => {
    const [user] = await getDb().select().from(users).where(eq(users.id, id));
    return user;
  });
}

/**
 * Task #4554 — thrown when an approval targets an email that already has a
 * live (non-deleted) users row. The route maps this to 409.
 */
export class DuplicateApprovedEmailError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists`);
    this.name = "DuplicateApprovedEmailError";
  }
}

/** Walk the drizzle wrapper's `.cause` chain for the pg SQLSTATE — the
 *  top-level error's `code` is undefined on drizzle-wrapped violations. */
function isUniqueViolation(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === "23505") return true;
    e = e.cause;
  }
  return false;
}

/**
 * Task #4554 — closed admission: pre-create ("approve") a users row by
 * email + role profile BEFORE that person's first sign-in. The auth
 * middleware admits a new Clerk identity only when its verified email
 * matches such a row (case-insensitive), so this is the ONLY runtime
 * path that creates users rows.
 *
 * Email is stored lowercased (canonical form; the route schema already
 * normalizes, this re-normalizes defensively). Duplicates are refused
 * case-insensitively against live rows — soft-deleted rows don't collide
 * because deleteUser suffixes their email (`.deleted.<ts>`), which keeps
 * re-approving a previously deleted person's address possible. The
 * unique(email) constraint backstops the check under concurrency; the
 * race loser surfaces as DuplicateApprovedEmailError, never a 500.
 */
export async function createApprovedUser(args: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  functions: string[];
  authorityLevel: string;
}): Promise<User> {
  const { deriveLegacyRole } = await import("../auth/permissions");
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:createApproved", async () => {
    const email = args.email.trim().toLowerCase();
    const [existing] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, sql`${users.deletedAt} IS NULL`))
      .limit(1);
    if (existing) throw new DuplicateApprovedEmailError(email);
    // Legacy `users.role` bridge derived from authority at write time —
    // same derivation updateUserRoleProfile uses (no current role to
    // preserve, so the sales carve-out never applies here).
    const role = deriveLegacyRole(args.authorityLevel as any, undefined);
    try {
      const [row] = await getDb()
        .insert(users)
        .values({
          email,
          firstName: args.firstName ?? null,
          lastName: args.lastName ?? null,
          functions: args.functions,
          authorityLevel: args.authorityLevel,
          role,
        })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateApprovedEmailError(email);
      throw err;
    }
  });
}

export async function isUserRevoked(id: string): Promise<boolean> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:isRevoked", async () => {
    const [row] = await getDb()
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, id));
    return !!row?.deletedAt;
  });
}

export async function getAllUsers(): Promise<User[]> {
  // Task #1866: hide soft-deleted users from every admin/list surface.
  return getDb()
    .select()
    .from(users)
    .where(sql`${users.deletedAt} IS NULL`)
    .orderBy(users.firstName);
}

export type ListUsersPagedOpts = {
  page: number;
  pageSize: number;
  search?: string;
  facet?: "revenue" | "fulfillment" | "both" | "unassigned";
  fn?: string;
  authority?: string;
  unableOnly?: boolean;
};
/**
 * Task #1870 — list soft-deleted users for the CEO-only restore UI.
 * Mirror of `getAllUsers` for rows where `deleted_at IS NOT NULL`.
 * Ordered by most-recently-deleted first so the CEO sees the row they
 * likely just removed at the top.
 *
 * Task #1898 — enriches each row with the actor who soft-deleted the
 * user, sourced from the most recent `user_deleted` activity-log entry
 * whose `metadata.targetUserId` matches. Falls back to `null` when no
 * audit row is found (older deletions, missing metadata).
 */
export type DeletedUserRow = User & {
  deletedByUserId: string | null;
  deletedByName: string | null;
  deletedByEmail: string | null;
};

export async function listDeletedUsers(): Promise<DeletedUserRow[]> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:listDeleted", async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(sql`${users.deletedAt} IS NOT NULL`)
      .orderBy(desc(users.deletedAt));

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const { bindArrayParam } = await import("../utils/sqlArray");
    const actorRows = await db.execute<{
      target_user_id: string;
      actor_user_id: string | null;
      actor_first_name: string | null;
      actor_last_name: string | null;
      actor_email: string | null;
    }>(sql`
      SELECT DISTINCT ON (al.metadata->>'targetUserId')
        al.metadata->>'targetUserId' AS target_user_id,
        al.user_id AS actor_user_id,
        au.first_name AS actor_first_name,
        au.last_name AS actor_last_name,
        au.email AS actor_email
      FROM user_activity_logs al
      LEFT JOIN users au ON au.id = al.user_id
      WHERE al.action_type = 'user_deleted'
        AND al.metadata->>'targetUserId' = ANY(${bindArrayParam(ids, "text")})
      ORDER BY al.metadata->>'targetUserId', al.timestamp DESC
    `);

    const actorByTarget = new Map<
      string,
      {
        actorId: string | null;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
      }
    >();
    for (const row of (actorRows as any).rows ?? actorRows ?? []) {
      actorByTarget.set(row.target_user_id, {
        actorId: row.actor_user_id ?? null,
        firstName: row.actor_first_name ?? null,
        lastName: row.actor_last_name ?? null,
        email: row.actor_email ?? null,
      });
    }

    return rows.map((u) => {
      const actor = actorByTarget.get(u.id);
      const name = actor
        ? [actor.firstName, actor.lastName].filter(Boolean).join(" ").trim() ||
          (actor.email ?? "").replace(/\.deleted\.\d+$/, "") ||
          null
        : null;
      return {
        ...u,
        deletedByUserId: actor?.actorId ?? null,
        deletedByName: name,
        deletedByEmail: actor?.email
          ? actor.email.replace(/\.deleted\.\d+$/, "")
          : null,
      };
    });
  });
}

export async function updateUserRole(id: string, role: string): Promise<User | undefined> {
  const [user] = await getDb().update(users).set({ role }).where(eq(users.id, id)).returning();
  return user;
}

/**
 * Task #1866 — soft-delete a user.
 *
 * Implementation choice: SOFT delete via `users.deleted_at` rather than
 * a hard DELETE, because the schema has 50+ FK references to
 * `users.id` (assignments, created_by, audit columns, notifications,
 * bookings, calendar credentials, Slack identity, etc.). Hard-deleting
 * would either need cascade everywhere — destroying audit history —
 * or be blocked by FK constraints. Soft-delete preserves every
 * historical reference (`X assigned to Alice`, `report created_by
 * Alice`) while making Alice gone from the app:
 *   - `getUser` / `getAllUsers` filter `deleted_at IS NULL`, so she
 *     disappears from User Management, pickers, role checks,
 *     readiness panels, etc.
 *   - The OIDC `verify` callback in `server/replit_integrations/auth/
 *     replitAuth.ts` checks `isUserRevoked()` BEFORE upsert, so a
 *     re-login does not resurrect the row.
 *   - Every existing session is purged from the `sessions` table
 *     below so any live tab 401s on its next request.
 *
 * Email is suffixed (`<original>.deleted.<ts>`) so a new account can
 * be created with the same address later without violating the unique
 * constraint on `users.email`.
 */
export async function deleteUser(id: string): Promise<User | undefined> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:delete", async () => {
    return getDb().transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) return existing;
      const ts = Date.now();
      const suffix = `.deleted.${ts}`;
      const newEmail = existing.email ? `${existing.email}${suffix}` : null;
      const [updated] = await tx
        .update(users)
        .set({ deletedAt: new Date(), email: newEmail, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      // Kill every live session for this user so any open tab 401s on
      // its next request. connect-pg-simple stores the passport user
      // payload inside `sess`; the `sub` claim is the same string as
      // `users.id`. NB: we run this inside the transaction so a
      // partial failure rolls back the soft-delete too.
      await tx.execute(sql`
        DELETE FROM sessions
        WHERE sess->'passport'->'user'->'claims'->>'sub' = ${id}
      `);
      return updated;
    });
  });
}

/**
 * Task #1870 — restore a previously soft-deleted user.
 *
 * Counterpart to `deleteUser` (Task #1866). Clears `deleted_at`, strips
 * the `.deleted.<ts>` suffix that was appended to `email` to free the
 * unique constraint, and stamps `updated_at`. Idempotent: restoring an
 * already-active user is a no-op and returns the row unchanged.
 *
 * Once `deleted_at` is null again, every existing read path
 * (`getUser`, `getAllUsers`, `isUserRevoked`, the OIDC `verify` gate)
 * sees the row as a normal active user — no further wiring needed.
 *
 * Email uniqueness: if a NEW account was created with the original
 * email after the original was deleted, restoring would collide on the
 * `users.email` unique index. We detect that case inside the
 * transaction and surface a typed error so the route can return a
 * clean 409 instead of a raw DB error.
 */
export type RestoreEmailConflictCollider = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

export class RestoreEmailConflictError extends Error {
  constructor(
    public readonly email: string,
    public readonly collider: RestoreEmailConflictCollider,
  ) {
    super(`email ${email} is already in use by another active user`);
    this.name = "RestoreEmailConflictError";
  }
}

const DELETED_EMAIL_SUFFIX_RE = /\.deleted\.\d+$/;

export type RestoreUserOptions = {
  /**
   * When "suffix", an email collision is resolved by restoring the user
   * with `<original>.restored.<ts>` instead of throwing
   * `RestoreEmailConflictError`. The CEO can then edit the address
   * later. Default is "strict" — collisions throw.
   */
  emailConflictStrategy?: "strict" | "suffix";
};

export async function restoreUser(
  id: string,
  opts: RestoreUserOptions = {},
): Promise<User | undefined> {
  const strategy = opts.emailConflictStrategy ?? "strict";
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:restore", async () => {
    return getDb().transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.id, id));
      if (!existing) return undefined;
      if (!existing.deletedAt) return existing;

      const originalEmail = existing.email
        ? existing.email.replace(DELETED_EMAIL_SUFFIX_RE, "")
        : null;

      let restoredEmail = originalEmail;

      if (originalEmail) {
        const [collision] = await tx
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(
            and(
              eq(users.email, originalEmail),
              ne(users.id, id),
              sql`${users.deletedAt} IS NULL`,
            ),
          );
        if (collision) {
          if (strategy === "strict") {
            throw new RestoreEmailConflictError(originalEmail, collision);
          }
          // Suffix fallback: keep the row recoverable without forcing
          // the CEO to touch the colliding account first.
          restoredEmail = `${originalEmail}.restored.${Date.now()}`;
        }
      }

      const [updated] = await tx
        .update(users)
        .set({ deletedAt: null, email: restoredEmail, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return updated;
    });
  });
}

export const RESTORED_EMAIL_SUFFIX_RE = /\.restored\.\d+$/;

/**
 * Strip the synthetic `.restored.<ts>` suffix left behind by
 * `restoreUser({ emailConflictStrategy: "suffix" })`, returning the
 * original address. Idempotent for addresses without the suffix.
 */
export function stripRestoredFallbackSuffix(email: string): string {
  return email.replace(RESTORED_EMAIL_SUFFIX_RE, "");
}

/**
 * Task #1933 — CEO-only inline email edit from User Management. Used
 * primarily to clean up the synthetic `<original>.restored.<ts>` address
 * left behind by `restoreUser({ emailConflictStrategy: "suffix" })` once
 * the colliding account has been reassigned or removed.
 *
 * Mirrors `restoreUser`'s uniqueness check: throws
 * `RestoreEmailConflictError` (re-used so the route can return the same
 * 409 shape) if another active user already owns the requested address.
 * Self-collisions and idempotent re-sets are allowed.
 *
 * Emails are normalized to lowercase + trimmed. Empty input is rejected
 * at the route boundary, not here.
 */
export async function updateUserEmail(
  id: string,
  rawEmail: string,
): Promise<User | undefined> {
  const email = rawEmail.trim().toLowerCase();
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:updateEmail", async () => {
    return getDb().transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.id, id));
      if (!existing) return undefined;
      if (existing.email === email) return existing;

      const [collision] = await tx
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(
          and(
            eq(users.email, email),
            ne(users.id, id),
            sql`${users.deletedAt} IS NULL`,
          ),
        );
      if (collision) {
        throw new RestoreEmailConflictError(email, collision);
      }

      const [updated] = await tx
        .update(users)
        .set({ email, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return updated;
    });
  });
}

export function isRestoredFallbackEmail(email: string | null | undefined): boolean {
  return !!email && RESTORED_EMAIL_SUFFIX_RE.test(email);
}

/**
 * Task #1758 — write-side update for the function + authority profile.
 * Derives and persists the legacy `users.role` bridge so legacy
 * read-side code keeps working without a separate migration.
 */
export async function updateUserRoleProfile(
  id: string,
  args: { functions: string[]; authorityLevel: string },
): Promise<User | undefined> {
  const { deriveLegacyRole } = await import("../auth/permissions");
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:updateRoleProfile", async () => {
    const existing = await getUser(id);
    if (!existing) return undefined;
    const derivedRole = deriveLegacyRole(
      args.authorityLevel as any,
      existing.role,
    );
    const [user] = await getDb()
      .update(users)
      .set({
        functions: args.functions,
        authorityLevel: args.authorityLevel,
        role: derivedRole,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    return user;
  });
}

/**
 * Update a user's display timezone preference and record who set it
 * (Task #1033). `source` is 'user' for explicit picks in Profile and
 * 'google_calendar' for values seeded from the connected calendar's
 * settings — the seeder uses this column to avoid clobbering an
 * explicit user pick.
 */
export async function updateUserDisplayTimezone(
  id: string,
  timezone: string,
  source: "user" | "google_calendar",
): Promise<User | undefined> {
  const [user] = await getDb()
    .update(users)
    .set({ timezone, displayTimezoneSource: source, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return user;
}

// Task #4330 — lifecycle gate. Prospect rows (lifecycle_stage <> 'customer')
// are lead records created by the intake paths; every operational
// client-enumeration accessor filters them out centrally so reports,
// judgments, churn, service desk, command center, etc. never pick them up.
// Surfaces that WANT prospects use the explicit accessors below
// (getClientsIncludingProspects for matching, getProspectClients for the
// Leads view). Single-row getClient(id)/getClientByCode stay ungated —
// by-id resolution of an already-linked record must keep working for leads
// (deal detail, meeting links, comm links).
const isCustomerLifecycle = eq(clients.lifecycleStage, "customer");

export async function getClients(): Promise<Client[]> {
  return getDb().select().from(clients).where(isCustomerLifecycle).orderBy(clients.firmName);
}

/**
 * Task #4330 — prospect-INCLUSIVE enumeration for identity-matching
 * surfaces (Front hard match). Leads must be matchable before they are
 * paying clients — that is the point of promoting them to first-class
 * records. Do NOT use this for operational lists.
 */
export async function getClientsIncludingProspects(): Promise<Client[]> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("clients:listIncludingProspects", async () => {
    return getDb().select().from(clients).orderBy(clients.firmName);
  });
}

export async function getClientsPaginated(limit: number, offset: number): Promise<{ data: Client[]; total: number }> {
  const [countResult] = await getDb().select({ count: sql<number>`count(*)::int` }).from(clients).where(isCustomerLifecycle);
  const data = await getDb().select().from(clients).where(isCustomerLifecycle).orderBy(clients.firmName).limit(limit).offset(offset);
  return { data, total: countResult?.count || 0 };
}

export async function getClient(id: string): Promise<Client | undefined> {
  const [client] = await getDb().select().from(clients).where(eq(clients.id, id));
  return client;
}

export async function getClientByCode(code: string): Promise<Client | undefined> {
  const [client] = await getDb().select().from(clients).where(eq(clients.clientCode, code));
  return client;
}

export async function getClientsByOwner(ownerId: string): Promise<Client[]> {
  return getDb().select().from(clients).where(and(eq(clients.ownerId, ownerId), isCustomerLifecycle)).orderBy(clients.firmName);
}

export async function getClientsByOwnerPaginated(ownerId: string, limit: number, offset: number): Promise<{ data: Client[]; total: number }> {
  const ownerAndCustomer = and(eq(clients.ownerId, ownerId), isCustomerLifecycle);
  const [countResult] = await getDb().select({ count: sql<number>`count(*)::int` }).from(clients).where(ownerAndCustomer);
  const data = await getDb().select().from(clients).where(ownerAndCustomer).orderBy(clients.firmName).limit(limit).offset(offset);
  return { data, total: countResult?.count || 0 };
}

export async function createClient(data: InsertClient): Promise<Client> {
  return getDb().transaction(async (tx) => {
    const result = await tx.execute(sql`SELECT nextval('client_code_seq') as nextval`);
    const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
    const nextval = rows[0]?.nextval;
    const clientCode = `NB-${String(Number(nextval)).padStart(4, '0')}`;
    const [client] = await tx.insert(clients).values({ ...data, clientCode }).returning();
    if (client.lifecycleStage === "customer") {
      await stageClientMirrorIntentInTx(tx, {
        clientId: client.id,
        desiredName: client.firmName,
        desiredArchived: client.isArchived === true,
      });
    }
    return client;
  });
}

export async function updateClient(id: string, data: UpdateClient): Promise<Client | undefined> {
  // Task #4380 (F8): runtime parse — strips unknown keys and keeps row
  // identity (id) / generated clientCode / server timestamps out even if a
  // caller forwards a raw request-shaped patch.
  const parsed = updateClientSchema.parse(data);
  return getDb().transaction(async (tx) => {
    const [client] = await tx.update(clients).set({ ...parsed, updatedAt: new Date() })
      .where(eq(clients.id, id)).returning();
    if (client?.lifecycleStage === "customer") {
      await stageClientMirrorIntentInTx(tx, {
        clientId: client.id,
        desiredName: client.firmName,
        desiredArchived: client.isArchived === true,
      });
    }
    return client;
  });
}

export async function deleteClient(id: string): Promise<void> {
  // Task #897 Phase 5: orphaned-record policy. raw_communication_records
  // are evidence of customer interactions and must NOT be deleted along
  // with a client. Default policy: preserve the row, null the client
  // linkage, and stamp `match_status='orphaned'` so client-linked views
  // can suppress them while audit/forensic queries can still find them.
  // This both retroactively handles existing 933 orphans (next time the
  // sweep runs over them) and prevents new silent orphans on future
  // client deletes — replacing the previous behavior where the FK to
  // `clients.id` (no cascade) would either block deletion or leave
  // dangling client_id values depending on whether the constraint was
  // enforced at runtime.
  // Task #966: the structured `communication_orphan_events` insert
  // and the `raw_communication_records` orphan-stamp UPDATE must be
  // atomic. If they were not, a partial failure (UPDATE commits, INSERT
  // fails, then we retry) would leave a row stamped 'orphaned' with
  // `client_id=NULL` but no audit row — and the retry's affected-set
  // query would return zero rows because client_id was already nulled,
  // permanently violating "every orphaning event writes a structured
  // audit row". The wrap below makes both writes commit-or-rollback
  // together. The free-text suffix on
  // `operational_classification_reason` remains for backwards compat
  // with old rows; new code reads from the structured audit table.
  const occurredAt = new Date();
  const reason = `client ${id} deleted at ${occurredAt.toISOString()}`;
  await getDb().transaction(async (tx) => {
    // Derive the audit set from the exact rows mutated by the orphan
    // UPDATE — eliminates the read/write race where a concurrent insert
    // pointing at this client between a separate SELECT and UPDATE
    // could be orphaned without a matching audit row. The CTE locks
    // (FOR UPDATE) the rows and snapshots their pre-update
    // match_status; the UPDATE then joins that snapshot back so
    // RETURNING can emit both the row id and the prior status (vanilla
    // RETURNING reflects post-UPDATE values, which would always be
    // 'orphaned' here).
    const affected = await tx.execute<{
      id: string;
      prior_match_status: string | null;
    }>(sql`
      WITH prior AS (
        SELECT id, match_status FROM ${rawCommunicationRecords}
        WHERE client_id = ${id}
        FOR UPDATE
      )
      UPDATE ${rawCommunicationRecords} r
      SET
        client_id = NULL,
        match_status = 'orphaned',
        operational_classification_reason =
          COALESCE(r.operational_classification_reason, '')
          || ${`[orphaned: ${reason}]`},
        updated_at = ${occurredAt}
      FROM prior
      WHERE r.id = prior.id
      RETURNING r.id AS id, prior.match_status AS prior_match_status
    `);

    const rows = (affected.rows ?? affected) as Array<{
      id: string;
      prior_match_status: string | null;
    }>;
    if (rows.length === 0) return;

    await tx.insert(communicationOrphanEvents).values(
      rows.map((r) => ({
        rawCommunicationRecordId: r.id,
        priorClientId: id,
        priorMatchStatus: r.prior_match_status,
        cause: "client_deleted",
        source: "deleteClient",
        reason,
        occurredAt,
      })),
    );
  });

  await getDb().delete(reportSections).where(
    inArray(reportSections.reportId,
      getDb().select({ id: reports.id }).from(reports).where(eq(reports.clientId, id))
    )
  );
  await getDb().delete(reports).where(eq(reports.clientId, id));
  await getDb().delete(clientLocations).where(eq(clientLocations.clientId, id));
  await getDb().delete(clientDataAccess).where(eq(clientDataAccess.clientId, id));
  await getDb().delete(commandPanelVersions).where(eq(commandPanelVersions.clientId, id));
  await getDb().delete(commandPanelHistory).where(eq(commandPanelHistory.clientId, id));
  await getDb().delete(commandPanels).where(eq(commandPanels.clientId, id));
  await getDb().delete(intelligenceFeedEntries).where(eq(intelligenceFeedEntries.clientId, id));
  await getDb().delete(actionLogEntries).where(eq(actionLogEntries.clientId, id));
  await getDb().delete(clientContacts).where(eq(clientContacts.clientId, id));
  await getDb().delete(clientAgentMemory).where(eq(clientAgentMemory.clientId, id));
  await getDb().delete(agentMatchDecisions).where(eq(agentMatchDecisions.clientId, id));
  await getDb().delete(clientAgentChats).where(eq(clientAgentChats.clientId, id));
  await getDb().update(pandadocDocuments).set({ linkedClientId: null }).where(eq(pandadocDocuments.linkedClientId, id));
  await getDb().delete(clientDailyJudgments).where(eq(clientDailyJudgments.clientId, id));
  await getDb().delete(clientCommunicationInsights).where(eq(clientCommunicationInsights.clientId, id));
  await getDb().delete(clientRelationshipSignals).where(eq(clientRelationshipSignals.clientId, id));
  await getDb().delete(clientOpenAsks).where(eq(clientOpenAsks.clientId, id));
  await getDb().delete(clients).where(eq(clients.id, id));
}

export async function getClientLocations(clientId: string): Promise<ClientLocation[]> {
  return getDb().select().from(clientLocations).where(eq(clientLocations.clientId, clientId));
}

export async function getClientLocation(id: string): Promise<ClientLocation | undefined> {
  const [loc] = await getDb().select().from(clientLocations).where(eq(clientLocations.id, id));
  return loc;
}

/**
 * Options accepted by every authoritative write to `client_locations`.
 * Used to populate the `client_locations_audit` shadow table (migration
 * 0048, Task #999) so we can answer "who/what changed this location"
 * from the audit trail directly. Mirrors `ClientContactWriteOpts`.
 */
export interface ClientLocationWriteOpts {
  /** ID of the auth user performing the action. Null for system writes. */
  actorUserId?: string | null;
  /** High-level source label, e.g. "operator_ui", "system", "legacy_migration". */
  source?: string;
  /** Free-form context (route path, function name, ...). */
  reason?: string;
}

export async function createClientLocation(
  data: InsertClientLocation,
  opts: ClientLocationWriteOpts = {},
): Promise<ClientLocation> {
  return getDb().transaction(async (tx) => {
    const [loc] = await tx.insert(clientLocations).values(data).returning();
    await tx.insert(clientLocationsAudit).values({
      locationId: loc.id,
      clientId: loc.clientId,
      action: "insert",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: null,
      newName: loc.name,
      oldAddress: null,
      newAddress: loc.address ?? null,
      oldCity: null,
      newCity: loc.city ?? null,
      oldState: null,
      newState: loc.state ?? null,
      oldLat: null,
      newLat: loc.lat ?? null,
      oldLng: null,
      newLng: loc.lng ?? null,
      oldIsActive: null,
      newIsActive: loc.isActive ?? null,
    });
    return loc;
  });
}

export async function updateClientLocation(
  id: string,
  data: UpdateClientLocation,
  opts: ClientLocationWriteOpts = {},
): Promise<ClientLocation | undefined> {
  // Task #4380 (F8): runtime parse — ownership (clientId) and row identity
  // stay server-controlled even against raw request-shaped patches.
  const parsed = updateClientLocationSchema.parse(data);
  return getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(clientLocations).where(eq(clientLocations.id, id));
    if (!before) return undefined;
    const [after] = await tx.update(clientLocations).set(parsed).where(eq(clientLocations.id, id)).returning();
    if (!after) return undefined;
    await tx.insert(clientLocationsAudit).values({
      locationId: after.id,
      clientId: after.clientId,
      action: "update",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: before.name,
      newName: after.name,
      oldAddress: before.address ?? null,
      newAddress: after.address ?? null,
      oldCity: before.city ?? null,
      newCity: after.city ?? null,
      oldState: before.state ?? null,
      newState: after.state ?? null,
      oldLat: before.lat ?? null,
      newLat: after.lat ?? null,
      oldLng: before.lng ?? null,
      newLng: after.lng ?? null,
      oldIsActive: before.isActive ?? null,
      newIsActive: after.isActive ?? null,
    });
    return after;
  });
}

export async function deleteClientLocation(
  id: string,
  opts: ClientLocationWriteOpts = {},
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(clientLocations).where(eq(clientLocations.id, id));
    if (!before) return;
    await tx.delete(clientLocations).where(eq(clientLocations.id, id));
    await tx.insert(clientLocationsAudit).values({
      locationId: before.id,
      clientId: before.clientId,
      action: "delete",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: before.name,
      newName: null,
      oldAddress: before.address ?? null,
      newAddress: null,
      oldCity: before.city ?? null,
      newCity: null,
      oldState: before.state ?? null,
      newState: null,
      oldLat: before.lat ?? null,
      newLat: null,
      oldLng: before.lng ?? null,
      newLng: null,
      oldIsActive: before.isActive ?? null,
      newIsActive: null,
    });
  });
}

export interface ClientLocationAuditSummary {
  locationId: string;
  action: string;
  createdAt: Date | null;
  actorUserId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorEmail: string | null;
  source: string | null;
  reason: string | null;
}

export async function getLatestClientLocationAuditByClient(
  clientId: string,
): Promise<ClientLocationAuditSummary[]> {
  const ranked = sql/* sql */`
    SELECT
      a.location_id,
      a.action,
      a.created_at,
      a.actor_user_id,
      a.source,
      a.reason,
      u.first_name,
      u.last_name,
      u.email,
      ROW_NUMBER() OVER (PARTITION BY a.location_id ORDER BY a.created_at DESC NULLS LAST) AS rn
    FROM client_locations_audit a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.client_id = ${clientId}
  `;
  const rows = await getDb().execute(sql/* sql */`SELECT * FROM (${ranked}) ranked WHERE rn = 1`);
  return (rows.rows as any[]).map((r) => ({
    locationId: r.location_id as string,
    action: r.action as string,
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorFirstName: (r.first_name as string | null) ?? null,
    actorLastName: (r.last_name as string | null) ?? null,
    actorEmail: (r.email as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  }));
}

export interface ClientLocationAuditEntry extends ClientLocationAuditSummary {
  oldName: string | null;
  newName: string | null;
  oldAddress: string | null;
  newAddress: string | null;
  oldCity: string | null;
  newCity: string | null;
  oldState: string | null;
  newState: string | null;
  oldLat: number | null;
  newLat: number | null;
  oldLng: number | null;
  newLng: number | null;
  oldIsActive: boolean | null;
  newIsActive: boolean | null;
}

export async function getClientLocationAuditHistory(
  locationId: string,
  clientId?: string,
): Promise<ClientLocationAuditEntry[]> {
  const rows = await getDb().execute(sql/* sql */`
    SELECT
      a.*,
      u.first_name,
      u.last_name,
      u.email
    FROM client_locations_audit a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.location_id = ${locationId}
      ${clientId ? sql`AND a.client_id = ${clientId}` : sql``}
    ORDER BY a.created_at DESC NULLS LAST
  `);
  return (rows.rows as any[]).map((r) => ({
    locationId: r.location_id as string,
    action: r.action as string,
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorFirstName: (r.first_name as string | null) ?? null,
    actorLastName: (r.last_name as string | null) ?? null,
    actorEmail: (r.email as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    oldName: (r.old_name as string | null) ?? null,
    newName: (r.new_name as string | null) ?? null,
    oldAddress: (r.old_address as string | null) ?? null,
    newAddress: (r.new_address as string | null) ?? null,
    oldCity: (r.old_city as string | null) ?? null,
    newCity: (r.new_city as string | null) ?? null,
    oldState: (r.old_state as string | null) ?? null,
    newState: (r.new_state as string | null) ?? null,
    oldLat: r.old_lat != null ? Number(r.old_lat) : null,
    newLat: r.new_lat != null ? Number(r.new_lat) : null,
    oldLng: r.old_lng != null ? Number(r.old_lng) : null,
    newLng: r.new_lng != null ? Number(r.new_lng) : null,
    oldIsActive: (r.old_is_active as boolean | null) ?? null,
    newIsActive: (r.new_is_active as boolean | null) ?? null,
  }));
}

export async function getClientDataAccess(clientId: string): Promise<ClientDataAccess[]> {
  return getDb().select().from(clientDataAccess).where(eq(clientDataAccess.clientId, clientId));
}

export async function getAllDataAccessForClients(clientIds: string[]): Promise<ClientDataAccess[]> {
  if (clientIds.length === 0) return [];
  return getDb().select().from(clientDataAccess).where(inArray(clientDataAccess.clientId, clientIds));
}

export async function upsertClientDataAccess(data: InsertClientDataAccess): Promise<ClientDataAccess> {
  const [record] = await getDb().insert(clientDataAccess)
    .values(data)
    .onConflictDoUpdate({
      target: [clientDataAccess.clientId, clientDataAccess.category],
      set: { status: data.status, notes: data.notes, updatedAt: new Date() },
    })
    .returning();
  return record;
}

export async function getClientContacts(clientId: string): Promise<ClientContact[]> {
  return getDb().select().from(clientContacts)
    .where(eq(clientContacts.clientId, clientId))
    .orderBy(desc(clientContacts.isPrimary), clientContacts.name);
}

// Task #818 Phase 3: batched fan-in for callers (notably the Zoom matcher)
// that previously walked allClients and issued one `getClientContacts(id)`
// query per client — a clear N+1 against the worker pool. Returning a
// Map<clientId, ClientContact[]> lets the caller iterate exactly as before
// after a single round-trip. Empty input ⇒ empty Map (no DB hit).
export async function getClientContactsForClients(
  clientIds: string[],
): Promise<Map<string, ClientContact[]>> {
  const result = new Map<string, ClientContact[]>();
  if (clientIds.length === 0) return result;
  const rows = await getDb()
    .select()
    .from(clientContacts)
    .where(inArray(clientContacts.clientId, clientIds))
    .orderBy(desc(clientContacts.isPrimary), clientContacts.name);
  for (const row of rows) {
    const bucket = result.get(row.clientId);
    if (bucket) {
      bucket.push(row);
    } else {
      result.set(row.clientId, [row]);
    }
  }
  return result;
}

// Task #813: batched contact-count lookup so the periodic Client Matching
// sweep can answer "does each client have any contact rows?" in a single
// query instead of N round-trips on the API pool.
export async function getClientContactCounts(
  clientIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (clientIds.length === 0) return result;
  const rows = await getDb()
    .select({
      clientId: clientContacts.clientId,
      count: count(clientContacts.id),
    })
    .from(clientContacts)
    .where(inArray(clientContacts.clientId, clientIds))
    .groupBy(clientContacts.clientId);
  for (const r of rows) {
    result.set(r.clientId, Number(r.count) || 0);
  }
  return result;
}

export async function getClientContact(id: string): Promise<ClientContact | undefined> {
  const [contact] = await getDb().select().from(clientContacts).where(eq(clientContacts.id, id));
  return contact;
}

/**
 * Options accepted by every authoritative write to `client_contacts`.
 * Used to populate the `client_contacts_audit` shadow table (migration
 * 0045) so we can answer "who/what changed this contact" from logs.
 */
export interface ClientContactWriteOpts {
  /** ID of the auth user performing the action. Null for system writes. */
  actorUserId?: string | null;
  /** High-level source label, e.g. "operator_ui", "operator_promotion",
   *  "trusted_domain_promotion", "system", "legacy_migration". */
  source?: string;
  /** Free-form context (route path, function name, ...). */
  reason?: string;
  /**
   * Optimistic-concurrency token for `updateClientContact` only. When
   * provided, the UPDATE is gated on `updated_at = expectedUpdatedAt`. If
   * the row has moved on, we throw `OptimisticConcurrencyError` so the
   * route can return 409 and force the caller to refetch. This blocks
   * the "stale form overwrites a fresher delete" failure mode where an
   * operator removes an email in tab A, then a tab B opened earlier
   * silently puts the deleted email back on save.
   */
  expectedUpdatedAt?: Date | string | null;
}

export class OptimisticConcurrencyError extends Error {
  readonly code = "OPTIMISTIC_CONCURRENCY_CONFLICT";
  readonly currentUpdatedAt: Date | null;
  constructor(currentUpdatedAt: Date | null) {
    super("client_contacts row was modified by someone else; refetch and retry");
    this.name = "OptimisticConcurrencyError";
    this.currentUpdatedAt = currentUpdatedAt;
  }
}

export async function createClientContact(
  data: InsertClientContact,
  opts: ClientContactWriteOpts = {},
): Promise<ClientContact> {
  // Task #848 Phase 7: keep `phones_normalized` in lockstep with `phones` so
  // `findClientByPhone` can rely on its GIN index.
  const { normalizePhoneArray } = await import("../services/phoneNormalization");
  const phonesNormalized = normalizePhoneArray(data.phones as readonly string[] | null | undefined);

  return getDb().transaction(async (tx) => {
    const [contact] = await tx.insert(clientContacts).values({ ...data, phonesNormalized }).returning();
    await tx.insert(clientContactsAudit).values({
      contactId: contact.id,
      clientId: contact.clientId,
      action: "insert",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: null,
      newName: contact.name,
      oldRoleTitle: null,
      newRoleTitle: contact.roleTitle ?? null,
      oldIsPrimary: null,
      newIsPrimary: contact.isPrimary,
      oldEmails: null,
      newEmails: (contact.emails as string[] | null) ?? [],
      oldPhones: null,
      newPhones: (contact.phones as string[] | null) ?? [],
    });
    return contact;
  });
}

export async function updateClientContact(
  id: string,
  data: UpdateClientContact,
  opts: ClientContactWriteOpts = {},
): Promise<ClientContact | undefined> {
  // Task #4380 (F8): runtime parse — the contacts PUT route forwards a
  // munged req.body; parsing here strips unknown keys and keeps ownership
  // (clientId), row identity, and derived phonesNormalized server-controlled.
  const parsed = updateClientContactSchema.parse(data);
  const expected = opts.expectedUpdatedAt
    ? (opts.expectedUpdatedAt instanceof Date
        ? opts.expectedUpdatedAt
        : new Date(opts.expectedUpdatedAt))
    : null;

  if (parsed.isPrimary === true) {
    const existing = await getClientContact(id);
    if (existing) {
      await getDb().update(clientContacts)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(clientContacts.clientId, existing.clientId), ne(clientContacts.id, id)));
    }
  }

  const updateData: Record<string, unknown> = { ...parsed, updatedAt: new Date() };
  if (parsed.phones !== undefined) {
    const { normalizePhoneArray } = await import("../services/phoneNormalization");
    updateData.phonesNormalized = normalizePhoneArray(parsed.phones as readonly string[] | null | undefined);
  }

  return getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(clientContacts).where(eq(clientContacts.id, id));
    if (!before) return undefined;

    if (expected && before.updatedAt && before.updatedAt.getTime() !== expected.getTime()) {
      throw new OptimisticConcurrencyError(before.updatedAt);
    }

    const whereExpr = expected
      ? and(eq(clientContacts.id, id), eq(clientContacts.updatedAt, expected))
      : eq(clientContacts.id, id);

    const updated = await tx.update(clientContacts)
      .set(updateData)
      .where(whereExpr)
      .returning();

    if (updated.length === 0) {
      // Row exists but the expected_updated_at didn't match the current
      // value (race between SELECT and UPDATE inside the transaction).
      throw new OptimisticConcurrencyError(before.updatedAt ?? null);
    }

    const after = updated[0];

    await tx.insert(clientContactsAudit).values({
      contactId: after.id,
      clientId: after.clientId,
      action: "update",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: before.name,
      newName: after.name,
      oldRoleTitle: before.roleTitle ?? null,
      newRoleTitle: after.roleTitle ?? null,
      oldIsPrimary: before.isPrimary,
      newIsPrimary: after.isPrimary,
      oldEmails: (before.emails as string[] | null) ?? [],
      newEmails: (after.emails as string[] | null) ?? [],
      oldPhones: (before.phones as string[] | null) ?? [],
      newPhones: (after.phones as string[] | null) ?? [],
    });

    return after;
  });
}

/**
 * Audit row for the contacts list view, joined with the actor's name/email
 * so the UI can render "Last edited by Jane Doe · 2h ago" without a second
 * query. Returns the most recent audit row per contact for the given client.
 * Task #991.
 */
export interface ClientContactAuditSummary {
  contactId: string;
  action: string;
  createdAt: Date | null;
  actorUserId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorEmail: string | null;
  source: string | null;
  reason: string | null;
}

export async function getLatestClientContactAuditByClient(
  clientId: string,
): Promise<ClientContactAuditSummary[]> {
  // Pick one audit row per contactId — the newest. We rank by createdAt
  // desc and take rank=1. Left join the users table so deleted/system
  // actors still surface (just without a name).
  const ranked = sql/* sql */`
    SELECT
      a.contact_id,
      a.action,
      a.created_at,
      a.actor_user_id,
      a.source,
      a.reason,
      u.first_name,
      u.last_name,
      u.email,
      ROW_NUMBER() OVER (PARTITION BY a.contact_id ORDER BY a.created_at DESC NULLS LAST) AS rn
    FROM client_contacts_audit a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.client_id = ${clientId}
  `;
  const rows = await getDb().execute(sql/* sql */`SELECT * FROM (${ranked}) ranked WHERE rn = 1`);
  return (rows.rows as any[]).map((r) => ({
    contactId: r.contact_id as string,
    action: r.action as string,
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorFirstName: (r.first_name as string | null) ?? null,
    actorLastName: (r.last_name as string | null) ?? null,
    actorEmail: (r.email as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  }));
}

export interface ClientContactAuditEntry extends ClientContactAuditSummary {
  oldName: string | null;
  newName: string | null;
  oldRoleTitle: string | null;
  newRoleTitle: string | null;
  oldIsPrimary: boolean | null;
  newIsPrimary: boolean | null;
  oldEmails: string[] | null;
  newEmails: string[] | null;
  oldPhones: string[] | null;
  newPhones: string[] | null;
}

export async function getClientContactAuditHistory(
  contactId: string,
  clientId?: string,
): Promise<ClientContactAuditEntry[]> {
  // Scope by clientId when provided so a deleted contact's history can't
  // be fetched by guessing the contactId from a different tenant.
  const rows = await getDb().execute(sql/* sql */`
    SELECT
      a.*,
      u.first_name,
      u.last_name,
      u.email
    FROM client_contacts_audit a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.contact_id = ${contactId}
      ${clientId ? sql`AND a.client_id = ${clientId}` : sql``}
    ORDER BY a.created_at DESC NULLS LAST
  `);
  return (rows.rows as any[]).map((r) => ({
    contactId: r.contact_id as string,
    action: r.action as string,
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorFirstName: (r.first_name as string | null) ?? null,
    actorLastName: (r.last_name as string | null) ?? null,
    actorEmail: (r.email as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    oldName: (r.old_name as string | null) ?? null,
    newName: (r.new_name as string | null) ?? null,
    oldRoleTitle: (r.old_role_title as string | null) ?? null,
    newRoleTitle: (r.new_role_title as string | null) ?? null,
    oldIsPrimary: (r.old_is_primary as boolean | null) ?? null,
    newIsPrimary: (r.new_is_primary as boolean | null) ?? null,
    oldEmails: (r.old_emails as string[] | null) ?? null,
    newEmails: (r.new_emails as string[] | null) ?? null,
    oldPhones: (r.old_phones as string[] | null) ?? null,
    newPhones: (r.new_phones as string[] | null) ?? null,
  }));
}

export async function deleteClientContact(
  id: string,
  opts: ClientContactWriteOpts = {},
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(clientContacts).where(eq(clientContacts.id, id));
    if (!before) return;
    await tx.delete(clientContacts).where(eq(clientContacts.id, id));
    await tx.insert(clientContactsAudit).values({
      contactId: before.id,
      clientId: before.clientId,
      action: "delete",
      actorUserId: opts.actorUserId ?? null,
      source: opts.source ?? null,
      reason: opts.reason ?? null,
      oldName: before.name,
      newName: null,
      oldRoleTitle: before.roleTitle ?? null,
      newRoleTitle: null,
      oldIsPrimary: before.isPrimary,
      newIsPrimary: null,
      oldEmails: (before.emails as string[] | null) ?? [],
      newEmails: null,
      oldPhones: (before.phones as string[] | null) ?? [],
      newPhones: null,
    });
  });
}

export async function createImportEntitySuggestion(data: InsertImportEntitySuggestion): Promise<ImportEntitySuggestion> {
  const [row] = await getDb().insert(importEntitySuggestions).values(data).returning();
  return row;
}

export async function listImportEntitySuggestions(opts: {
  clientId?: string;
  surface?: string;
  entityKind?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ImportEntitySuggestion[]> {
  const conds: SQL[] = [];
  if (opts.clientId) conds.push(eq(importEntitySuggestions.clientId, opts.clientId));
  if (opts.surface) conds.push(eq(importEntitySuggestions.surface, opts.surface));
  if (opts.entityKind) conds.push(eq(importEntitySuggestions.entityKind, opts.entityKind));
  if (opts.status) conds.push(eq(importEntitySuggestions.status, opts.status));
  const baseQuery = getDb().select().from(importEntitySuggestions);
  const filtered = conds.length > 0 ? baseQuery.where(and(...conds)) : baseQuery;
  return filtered
    .orderBy(desc(importEntitySuggestions.createdAt), desc(importEntitySuggestions.id))
    .limit(opts.limit || 200)
    .offset(opts.offset || 0);
}

export async function countImportEntitySuggestions(opts: {
  clientId?: string;
  surface?: string;
  entityKind?: string;
  status?: string;
} = {}): Promise<number> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("clients:countImportEntitySuggestions", async () => {
    const conds: SQL[] = [];
    if (opts.clientId) conds.push(eq(importEntitySuggestions.clientId, opts.clientId));
    if (opts.surface) conds.push(eq(importEntitySuggestions.surface, opts.surface));
    if (opts.entityKind) conds.push(eq(importEntitySuggestions.entityKind, opts.entityKind));
    if (opts.status) conds.push(eq(importEntitySuggestions.status, opts.status));
    const base = getDb().select({ total: sql<number>`count(*)::int` }).from(importEntitySuggestions);
    const rows = conds.length > 0 ? await base.where(and(...conds)) : await base;
    return rows[0]?.total ?? 0;
  });
}
export async function getImportEntitySuggestion(id: string): Promise<ImportEntitySuggestion | undefined> {
  const [row] = await getDb().select().from(importEntitySuggestions).where(eq(importEntitySuggestions.id, id)).limit(1);
  return row;
}

export async function updateImportEntitySuggestion(
  id: string,
  patch: {
    status?: string;
    reviewedByUserId?: string | null;
    reviewedAt?: Date | null;
    promotedEntityId?: string | null;
  },
): Promise<ImportEntitySuggestion | undefined> {
  const [row] = await getDb().update(importEntitySuggestions)
    .set(patch)
    .where(eq(importEntitySuggestions.id, id))
    .returning();
  return row;
}

export async function getActiveClients(): Promise<Client[]> {
  return getDb().select().from(clients)
    .where(and(
      or(eq(clients.isArchived, false), sql`${clients.isArchived} IS NULL`),
      or(eq(clients.isDemo, false), sql`${clients.isDemo} IS NULL`),
      isCustomerLifecycle
    ))
    .orderBy(clients.firmName);
}

export type PagedUserRow = User & {
  // Only set on rows with a `.restored.<ts>` fallback email: true when the
  // stripped original address is unavailable (owned by another active user
  // or underivable). Lets the page show "Restore original email" vs
  // "Original taken" without shipping every user's email to the client.
  originalEmailTaken?: boolean;
};

export async function listUsersPaged(opts: ListUsersPagedOpts): Promise<ListUsersPagedResult> {
  const { withDbAttribution } = await import("../db");
  return withDbAttribution("users:listPaged", async () => {
    const db = getDb();

    // Twilio call-readiness flags — same raw system_settings reads the
    // /api/twilio/config endpoint performs, so the SQL "unable" filter
    // agrees with the client-side readiness chips.
    const settingRows = await db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(inArray(systemSettings.key, [
        "twilio_account_sid",
        "twilio_api_key_sid",
        "twilio_api_key_secret",
        "twilio_twiml_app_sid",
      ]));
    const settingVal = (k: string) =>
      (settingRows.find((r) => r.key === k)?.value ?? "").trim();
    const twilioConfigured = settingVal("twilio_account_sid").length > 0;
    const browserCallingConfigured =
      settingVal("twilio_api_key_sid").length > 0 &&
      settingVal("twilio_api_key_secret").length > 0 &&
      settingVal("twilio_twiml_app_sid").length > 0;

    const digitsLen = sql`length(regexp_replace(coalesce(${users.callRoutingPhone}, ''), '\\D', '', 'g'))`;
    const forwardBlocked = sql`(${users.callMode} = 'forward' and (${digitsLen} < 10 or ${digitsLen} > 15))`;
    const unableCond: SQL = !twilioConfigured
      ? sql`true`
      : browserCallingConfigured
        ? sql`${forwardBlocked}`
        : sql`(${forwardBlocked} or coalesce(${users.callMode}, 'browser') <> 'forward')`;

    const activeCond = sql`${users.deletedAt} IS NULL`;
    const conds: SQL[] = [activeCond];
    if (opts.search) {
      const escaped = opts.search.replace(/[\\%_]/g, (m) => `\\${m}`);
      conds.push(
        sql`(coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '') || ' ' || coalesce(${users.email}, '')) ilike ${"%" + escaped + "%"}`,
      );
    }
    if (opts.facet) {
      const rev = arrayOverlaps(users.functions, [...REVENUE_FUNCTIONS]);
      const ful = arrayOverlaps(users.functions, [...FULFILLMENT_FUNCTIONS]);
      if (opts.facet === "revenue") conds.push(and(rev, not(ful))!);
      else if (opts.facet === "fulfillment") conds.push(and(not(rev), ful)!);
      else if (opts.facet === "both") conds.push(and(rev, ful)!);
      else conds.push(and(not(rev), not(ful))!);
    }
    if (opts.fn) conds.push(arrayContains(users.functions, [opts.fn]));
    if (opts.authority) {
      if (opts.authority === "core") {
        // Legacy rows may have NULL/unknown authority; the UI treats those
        // as Core, so the filter must too.
        conds.push(
          sql`(${users.authorityLevel} = 'core' or ${users.authorityLevel} is null or ${users.authorityLevel} not in ('lead', 'director', 'ceo'))`,
        );
      } else {
        conds.push(eq(users.authorityLevel, opts.authority));
      }
    }
    if (opts.unableOnly) conds.push(unableCond);

    const whereExpr = and(...conds)!;
    const offset = (Math.max(1, opts.page) - 1) * opts.pageSize;
    const fallbackEmailCond = sql`${users.email} ~ '\\.restored\\.[0-9]+$'`;

    const [rows, totalRows, globalRows] = await Promise.all([
      db
        .select()
        .from(users)
        .where(whereExpr)
        .orderBy(users.firstName, users.id)
        .limit(opts.pageSize)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(users).where(whereExpr),
      db
        .select({
          unableTotal: sql<number>`(count(*) filter (where ${unableCond}))::int`,
          fallbackEmailTotal: sql<number>`(count(*) filter (where ${fallbackEmailCond}))::int`,
        })
        .from(users)
        .where(activeCond),
    ]);

    // Enrich fallback-email rows with whether their original address is
    // still free (mirrors the legacy client-side originalEmailIsTaken).
    let data: PagedUserRow[] = rows;
    const fallbackPageRows = rows.filter((u) => RESTORED_EMAIL_SUFFIX_RE.test(u.email ?? ""));
    if (fallbackPageRows.length > 0) {
      const originals = Array.from(new Set(
        fallbackPageRows
          .map((u) => (u.email ?? "").replace(RESTORED_EMAIL_SUFFIX_RE, "").toLowerCase())
          .filter((e) => e.length > 0),
      ));
      const owners = originals.length > 0
        ? await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(and(activeCond, inArray(sql`lower(${users.email})`, originals)))
        : [];
      const ownerByEmail = new Map(owners.map((o) => [(o.email ?? "").toLowerCase(), o.id]));
      data = rows.map((u) => {
        if (!RESTORED_EMAIL_SUFFIX_RE.test(u.email ?? "")) return u;
        const original = (u.email ?? "").replace(RESTORED_EMAIL_SUFFIX_RE, "").toLowerCase();
        const owner = original ? ownerByEmail.get(original) : undefined;
        return { ...u, originalEmailTaken: !original || (!!owner && owner !== u.id) };
      });
    }

    return {
      data,
      total: totalRows[0]?.total ?? 0,
      unableTotal: globalRows[0]?.unableTotal ?? 0,
      fallbackEmailTotal: globalRows[0]?.fallbackEmailTotal ?? 0,
    };
  });
}

export type ListUsersPagedResult = {
  data: PagedUserRow[];
  total: number;
  // Global counts (base filter only — active users), independent of the
  // current search/facet filters, matching the legacy chip semantics.
  unableTotal: number;
  fallbackEmailTotal: number;
};
