// @db-pool-intent: ambient
//
// Task #4334 — storage for the outbound client-facing email seam:
// suppression list, user→Front-channel identity mappings, and the
// per-recipient send log (which doubles as the idempotency/claim ledger).

import {
  emailSuppressions,
  type EmailSuppression,
  userEmailIdentities,
  type UserEmailIdentity,
  outboundEmails,
  type OutboundEmail,
  type InsertOutboundEmail,
  users,
  type SuppressionReason,
  type SuppressionSource,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

// ── Suppressions ─────────────────────────────────────────────────────────────

/**
 * Idempotent add: ON CONFLICT (email) bumps last_event_at (a later signal
 * re-confirming an existing suppression) and fills notes if provided, but
 * preserves the ORIGINAL reason/source — the first consent-revoking event is
 * the auditable one.
 */
export async function upsertEmailSuppression(params: {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  notes?: string | null;
  createdBy?: string | null;
}): Promise<{ row: EmailSuppression; inserted: boolean }> {
  return withDbAttribution("outboundEmailStorage:upsertEmailSuppression", async () => {
    const email = normalizeEmailAddress(params.email);
    const inserted = await getDb()
      .insert(emailSuppressions)
      .values({
        email,
        reason: params.reason,
        source: params.source,
        notes: params.notes ?? null,
        createdBy: params.createdBy ?? null,
      })
      .onConflictDoNothing({ target: emailSuppressions.email })
      .returning();
    if (inserted.length > 0) return { row: inserted[0], inserted: true };
    const [updated] = await getDb()
      .update(emailSuppressions)
      .set({ // spread-write-approved: conditional-include of one typed scalar (params.notes: string from the internal params interface), not a request-body spread; column set is fixed
        lastEventAt: new Date(),
        ...(params.notes ? { notes: params.notes } : {}),
      })
      .where(eq(emailSuppressions.email, email))
      .returning();
    return { row: updated, inserted: false };
  });
}

export async function bulkInsertEmailSuppressions(rows: Array<{
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
}>): Promise<number> {
  if (rows.length === 0) return 0;
  return withDbAttribution("outboundEmailStorage:bulkInsertEmailSuppressions", async () => {
    // De-dupe within the batch after normalization (the seed sweep can carry
    // the same address with different casing).
    const seen = new Set<string>();
    const values = rows.flatMap((r) => {
      const email = normalizeEmailAddress(r.email);
      if (!email || seen.has(email)) return [];
      seen.add(email);
      return [{ email, reason: r.reason, source: r.source }];
    });
    if (values.length === 0) return 0;
    const inserted = await getDb()
      .insert(emailSuppressions)
      .values(values)
      .onConflictDoNothing({ target: emailSuppressions.email })
      .returning({ id: emailSuppressions.id });
    return inserted.length;
  });
}

export async function isEmailSuppressed(email: string): Promise<EmailSuppression | undefined> {
  return withDbAttribution("outboundEmailStorage:isEmailSuppressed", async () => {
    const [row] = await getDb()
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.email, normalizeEmailAddress(email)))
      .limit(1);
    return row;
  });
}

export async function listEmailSuppressions(params: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: EmailSuppression[]; total: number }> {
  return withDbAttribution("outboundEmailStorage:listEmailSuppressions", async () => {
    const where = params.search
      ? ilike(emailSuppressions.email, `%${params.search.trim().toLowerCase()}%`)
      : undefined;
    const rows = await getDb()
      .select()
      .from(emailSuppressions)
      .where(where)
      .orderBy(desc(emailSuppressions.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(emailSuppressions)
      .where(where);
    return { rows, total: count };
  });
}

export async function deleteEmailSuppression(id: string): Promise<boolean> {
  return withDbAttribution("outboundEmailStorage:deleteEmailSuppression", async () => {
    const deleted = await getDb()
      .delete(emailSuppressions)
      .where(eq(emailSuppressions.id, id))
      .returning({ id: emailSuppressions.id });
    return deleted.length > 0;
  });
}

// ── Identity mappings ────────────────────────────────────────────────────────

export async function getUserEmailIdentity(userId: string): Promise<UserEmailIdentity | undefined> {
  return withDbAttribution("outboundEmailStorage:getUserEmailIdentity", async () => {
    const [row] = await getDb()
      .select()
      .from(userEmailIdentities)
      .where(eq(userEmailIdentities.userId, userId))
      .limit(1);
    return row;
  });
}

export interface UserEmailIdentityListItem extends UserEmailIdentity {
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
}

export async function listUserEmailIdentities(): Promise<UserEmailIdentityListItem[]> {
  return withDbAttribution("outboundEmailStorage:listUserEmailIdentities", async () => {
    const rows = await getDb()
      .select({
        identity: userEmailIdentities,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(userEmailIdentities)
      .innerJoin(users, eq(users.id, userEmailIdentities.userId))
      .orderBy(desc(userEmailIdentities.createdAt));
    return rows.map((r) => ({
      ...r.identity,
      userEmail: r.userEmail,
      userFirstName: r.userFirstName,
      userLastName: r.userLastName,
    }));
  });
}

export async function upsertUserEmailIdentity(params: {
  userId: string;
  frontChannelId: string;
  fromEmail: string;
  dailyCap: number | null;
  active: boolean;
  updatedBy: string;
}): Promise<UserEmailIdentity> {
  return withDbAttribution("outboundEmailStorage:upsertUserEmailIdentity", async () => {
    const [row] = await getDb()
      .insert(userEmailIdentities)
      .values({
        userId: params.userId,
        frontChannelId: params.frontChannelId,
        fromEmail: normalizeEmailAddress(params.fromEmail),
        dailyCap: params.dailyCap,
        active: params.active,
        updatedBy: params.updatedBy,
      })
      .onConflictDoUpdate({
        target: userEmailIdentities.userId,
        set: {
          frontChannelId: params.frontChannelId,
          fromEmail: normalizeEmailAddress(params.fromEmail),
          dailyCap: params.dailyCap,
          active: params.active,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  });
}

// ── Send log rows ────────────────────────────────────────────────────────────

/**
 * Idempotent per-recipient row creation: ids are caller-derived hashes of
 * (batchId, recipient), so a compose re-POST with the same client batch key
 * lands on ON CONFLICT DO NOTHING instead of minting duplicate sends.
 * Returns only the rows actually inserted this call.
 */
export async function insertOutboundEmails(rows: InsertOutboundEmail[]): Promise<OutboundEmail[]> {
  if (rows.length === 0) return [];
  return withDbAttribution("outboundEmailStorage:insertOutboundEmails", async () => {
    return getDb()
      .insert(outboundEmails)
      .values(rows)
      .onConflictDoNothing({ target: outboundEmails.id })
      .returning();
  });
}

export async function getOutboundEmail(id: string): Promise<OutboundEmail | undefined> {
  return withDbAttribution("outboundEmailStorage:getOutboundEmail", async () => {
    const [row] = await getDb()
      .select()
      .from(outboundEmails)
      .where(eq(outboundEmails.id, id))
      .limit(1);
    return row;
  });
}

export async function listOutboundEmailsByBatch(batchId: string): Promise<OutboundEmail[]> {
  return withDbAttribution("outboundEmailStorage:listOutboundEmailsByBatch", async () => {
    return getDb()
      .select()
      .from(outboundEmails)
      .where(eq(outboundEmails.batchId, batchId))
      .orderBy(outboundEmails.toEmail);
  });
}

export async function listOutboundEmails(params: {
  status?: string;
  senderUserId?: string;
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: OutboundEmail[]; total: number }> {
  return withDbAttribution("outboundEmailStorage:listOutboundEmails", async () => {
    const conds = [];
    if (params.status) conds.push(eq(outboundEmails.status, params.status));
    if (params.senderUserId) conds.push(eq(outboundEmails.senderUserId, params.senderUserId));
    if (params.search) {
      const term = `%${params.search.trim().toLowerCase()}%`;
      conds.push(or(ilike(outboundEmails.toEmail, term), ilike(outboundEmails.subject, term)));
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await getDb()
      .select()
      .from(outboundEmails)
      .where(where)
      .orderBy(desc(outboundEmails.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundEmails)
      .where(where);
    return { rows, total: count };
  });
}

/**
 * Per-user daily cap consumption for a UTC day window. Counts Front-path
 * rows that consumed mailbox budget: in-flight claims, accepted sends, and
 * ambiguous outcomes (conservative — an unknown may have gone out).
 * Backed by the partial index outbound_emails_cap_count_idx.
 */
export async function countCapWindowSends(senderUserId: string, capWindowDay: string): Promise<number> {
  return withDbAttribution("outboundEmailStorage:countCapWindowSends", async () => {
    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundEmails)
      .where(and(
        eq(outboundEmails.senderUserId, senderUserId),
        eq(outboundEmails.capWindowDay, capWindowDay),
        eq(outboundEmails.path, "front_channel"),
        inArray(outboundEmails.status, ["sending", "sent", "unknown"]),
      ));
    return count;
  });
}

export type OutboundDispatchClaim =
  | { kind: "claimed"; row: OutboundEmail; claimToken: string }
  | { kind: "already_sent"; row: OutboundEmail }
  | { kind: "in_progress"; row: OutboundEmail }
  | { kind: "not_claimable"; row: OutboundEmail | undefined };

/**
 * At-most-once dispatch claim (twilio_messages convention, pressure case
 * P11): CAS the claim columns before ANY vendor call. Claimable states are
 * queued/deferred with no live claim (or a stale one). A lost claim is
 * classified — already_sent (vendor id present) or in_progress — and the
 * caller must NEVER re-send on those.
 */
export async function claimOutboundEmailDispatch(params: {
  id: string;
  path: "front_channel" | "sendgrid";
  frontChannelId?: string | null;
  capWindowDay: string;
  staleClaimMs: number;
}): Promise<OutboundDispatchClaim> {
  return withDbAttribution("outboundEmailStorage:claimOutboundEmailDispatch", async () => {
    const claimToken = randomUUID();
    for (let pass = 0; pass < 2; pass++) {
      const staleBefore = new Date(Date.now() - params.staleClaimMs);
      const claimed = await getDb()
        .update(outboundEmails)
        .set({
          status: "sending",
          path: params.path,
          frontChannelId: params.frontChannelId ?? null,
          capWindowDay: params.capWindowDay,
          dispatchClaimToken: claimToken,
          dispatchClaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(outboundEmails.id, params.id),
          inArray(outboundEmails.status, ["queued", "deferred"]),
          isNull(outboundEmails.frontMessageId),
          isNull(outboundEmails.sendgridMessageId),
          or(
            isNull(outboundEmails.dispatchClaimedAt),
            lt(outboundEmails.dispatchClaimedAt, staleBefore),
          ),
        ))
        .returning();
      if (claimed.length > 0) return { kind: "claimed", row: claimed[0], claimToken };
      const row = await getOutboundEmail(params.id);
      if (!row) continue;
      if (row.status === "sent" || row.frontMessageId || row.sendgridMessageId) {
        return { kind: "already_sent", row };
      }
      if (row.status === "sending") return { kind: "in_progress", row };
      return { kind: "not_claimable", row };
    }
    return { kind: "not_claimable", row: undefined };
  });
}

/** Terminal/transition updates keyed by id; single-row indexed writes. */
export async function updateOutboundEmail(
  id: string,
  set: Partial<Pick<
    OutboundEmail,
    | "status" | "path" | "frontChannelId" | "frontMessageId" | "sendgridMessageId"
    | "deliveryStatus" | "errorCode" | "errorMessage" | "scheduledFor" | "sentAt"
    | "deferredCount" | "capWindowDay" | "unsubscribeToken"
    | "dispatchClaimToken" | "dispatchClaimedAt"
  >>,
): Promise<OutboundEmail | undefined> {
  return withDbAttribution("outboundEmailStorage:updateOutboundEmail", async () => {
    const [row] = await getDb()
      .update(outboundEmails)
      .set({ ...set, updatedAt: new Date() }) // spread-write-approved: `set` is Partial<Pick<OutboundEmail, …>> — a compile-time column whitelist used by internal send-pipeline transitions; ownership/audit columns are excluded by the Pick
      .where(eq(outboundEmails.id, id))
      .returning();
    return row;
  });
}

export async function findOutboundEmailBySendgridMessageId(sendgridMessageId: string): Promise<OutboundEmail | undefined> {
  return withDbAttribution("outboundEmailStorage:findOutboundEmailBySendgridMessageId", async () => {
    const [row] = await getDb()
      .select()
      .from(outboundEmails)
      .where(eq(outboundEmails.sendgridMessageId, sendgridMessageId))
      .limit(1);
    return row;
  });
}

export interface OutboundEmailDayCounters {
  perUser: Array<{
    senderUserId: string;
    fromEmail: string | null;
    sentCount: number;
    deferredCount: number;
    cap: number | null;
  }>;
  perDomain: Array<{ domain: string; sentCount: number }>;
  suppressedToday: number;
}

/**
 * Daily counters for the admin surface: per-user Front-path consumption vs
 * cap, per-sending-domain volume (both paths), and suppressions skipped
 * today. All reads bounded by the day window + partial indexes.
 */
export async function getOutboundEmailDayCounters(capWindowDay: string): Promise<{
  perUser: Array<{ senderUserId: string; sentCount: number }>;
  perDomain: Array<{ domain: string; sentCount: number }>;
  suppressedToday: number;
  deferredPending: number;
}> {
  return withDbAttribution("outboundEmailStorage:getOutboundEmailDayCounters", async () => {
    const perUser = await getDb()
      .select({
        senderUserId: outboundEmails.senderUserId,
        sentCount: sql<number>`count(*)::int`,
      })
      .from(outboundEmails)
      .where(and(
        eq(outboundEmails.capWindowDay, capWindowDay),
        eq(outboundEmails.path, "front_channel"),
        inArray(outboundEmails.status, ["sending", "sent", "unknown"]),
      ))
      .groupBy(outboundEmails.senderUserId);
    const perDomain = await getDb()
      .select({
        domain: sql<string>`split_part(to_email, '@', 2)`,
        sentCount: sql<number>`count(*)::int`,
      })
      .from(outboundEmails)
      .where(and(
        eq(outboundEmails.capWindowDay, capWindowDay),
        inArray(outboundEmails.status, ["sending", "sent", "unknown"]),
      ))
      .groupBy(sql`split_part(to_email, '@', 2)`);
    const [{ count: suppressedToday }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundEmails)
      .where(and(
        eq(outboundEmails.status, "suppressed"),
        sql`created_at >= (${capWindowDay} || ' 00:00:00')::timestamp`,
        sql`created_at < ((${capWindowDay})::date + interval '1 day')`,
      ));
    const [{ count: deferredPending }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundEmails)
      .where(eq(outboundEmails.status, "deferred"));
    return { perUser, perDomain, suppressedToday, deferredPending };
  });
}

/** Distinct historical unsubscribe emails from the website intake (seed source). */
export async function listWebsiteUnsubscribeEmails(): Promise<string[]> {
  return withDbAttribution("outboundEmailStorage:listWebsiteUnsubscribeEmails", async () => {
    const rows = await getDb().execute(
      sql`SELECT DISTINCT lower(trim(email)) AS email FROM website_inquiries WHERE kind = 'unsubscribe' AND email IS NOT NULL AND trim(email) <> ''`,
    );
    return (rows.rows as Array<{ email: string }>).map((r) => r.email);
  });
}
