// @db-pool-intent: ambient
//
// Task #4330 — lead intake and lifecycle stages.
//
// Storage helpers for the account lifecycle (lead → session_booked →
// opportunity → customer). Invariants owned here:
//
//   - clients.lifecycle_stage changes ONLY through advanceClientLifecycle()
//     (forward-only, system or actor) or setClientLifecycleManual() (any
//     direction, actor REQUIRED) — both write the client_lifecycle_history
//     row in the SAME transaction as the stage update, so a transition can
//     never exist without its audit entry.
//   - Automatic movement never goes backwards: advanceClientLifecycle is a
//     rank-compared CAS under a row lock; a no-op advance writes no history.
//   - matchOrCreateLeadClient is the ONLY minting path for prospect rows.
//     It serializes per-email via pg_advisory_xact_lock (two concurrent
//     submissions of the same address yield one lead) and deliberately does
//     NOT consume an NB-XXXX client code (codes are operator-facing and
//     minted from client_code_seq only for real clients in createClient).
//
// This module must stay import-light (schema + db only) — dealsStorage
// imports it for the deal-created/deal-won hooks, so importing dealsStorage
// or any service from here would create a cycle.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  bookingClientTokens,
  clientContacts,
  clientContactsAudit,
  clientLifecycleHistory,
  clients,
  dealStages,
  deals,
  emailSequenceEnrollments,
  scheduledMeetings,
  websiteInquiries,
  type Client,
  type ClientLifecycleChangeSource,
  type ClientLifecycleHistoryEntry,
  type ClientLifecycleStage,
  type LeadSource,
  type WebsiteInquiry,
  clientLifecycleStageRank,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { digitsOnly, normalizeToE164 } from "../services/phoneNormalization";

/** Leads-view list hard bound. */
export const LEADS_LIST_MAX_LIMIT = 200;
export const LEADS_LIST_DEFAULT_LIMIT = 100;
/** Lifecycle-history read bound (audit trail is small; every list gets a limit). */
export const LIFECYCLE_HISTORY_LIMIT = 200;
/** Merge-target search hard bound (typeahead — small by design). */
export const MERGE_CANDIDATE_SEARCH_LIMIT = 20;

export interface LifecycleChangeResult {
  changed: boolean;
  fromStage: ClientLifecycleStage | null;
  toStage: ClientLifecycleStage;
  client: Client | null;
}

/**
 * Forward-only lifecycle advance. No-ops (without history) when the client
 * is already at or past `target`, or does not exist. Row-locked CAS: the
 * SELECT ... FOR UPDATE + rank compare + UPDATE + history INSERT commit
 * atomically. `actorUserId` null = system-initiated (intake/deal hooks).
 */
/**
 * Task #4335 — entering "customer" exits any active email-sequence
 * enrollments for the client immediately (visible cancel), instead of
 * waiting for the next advance-time lifecycle check. Runs AFTER the
 * lifecycle transaction commits. Both canonical writers
 * (advanceClientLifecycle + setClientLifecycleManual) call this, so
 * intake, deal hooks, and manual corrections are all covered. Lazy
 * import keeps the storage→service edge out of the static import graph.
 * Never throws.
 */
async function cancelSequenceEnrollmentsOnCustomerEntry(
  clientId: string,
  result: LifecycleChangeResult,
): Promise<void> {
  if (!result.changed || result.toStage !== "customer") return;
  try {
    const { cancelActiveEnrollmentsForClient } = await import("../services/emailSequences");
    await cancelActiveEnrollmentsForClient(
      clientId,
      "lifecycle_exit",
      `Lifecycle moved to customer (was ${result.fromStage ?? "unknown"})`,
    );
  } catch (err) {
    console.error(
      "[leadLifecycle] sequence cancel on customer entry failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function advanceClientLifecycle(
  clientId: string,
  target: ClientLifecycleStage,
  opts: {
    source: ClientLifecycleChangeSource;
    actorUserId?: string | null;
    reason?: string | null;
  },
): Promise<LifecycleChangeResult> {
  const result = await withDbAttribution("leadLifecycle:advance", async () => {
    return getDb().transaction(async (tx) => {
      const [row] = await tx
        .select({ id: clients.id, lifecycleStage: clients.lifecycleStage })
        .from(clients)
        .where(eq(clients.id, clientId))
        .for("update");
      if (!row) return { changed: false, fromStage: null, toStage: target, client: null };

      const from = row.lifecycleStage;
      if (clientLifecycleStageRank[from] >= clientLifecycleStageRank[target]) {
        // Already at or past the target — forward-only means no movement and
        // no history. Still bump last-activity for prospects so the Leads
        // view reflects the intake event that triggered this call.
        let client: Client | null = null;
        if (from !== "customer") {
          const [updated] = await tx
            .update(clients)
            .set({ leadLastActivityAt: new Date(), updatedAt: new Date() })
            .where(eq(clients.id, clientId))
            .returning();
          client = updated ?? null;
        }
        return { changed: false, fromStage: from, toStage: from, client };
      }

      const [updated] = await tx
        .update(clients)
        .set({ lifecycleStage: target, leadLastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(clients.id, clientId))
        .returning();
      await tx.insert(clientLifecycleHistory).values({
        clientId,
        fromStage: from,
        toStage: target,
        changedByUserId: opts.actorUserId ?? null,
        source: opts.source,
        reason: opts.reason ?? null,
      });
      return { changed: true, fromStage: from, toStage: target, client: updated ?? null };
    });
  });
  await cancelSequenceEnrollmentsOnCustomerEntry(clientId, result);
  return result;
}

/**
 * Manual correction — the ONLY path that may move a lifecycle backwards.
 * Requires the acting operator; always writes history (source 'manual').
 */
export async function setClientLifecycleManual(
  clientId: string,
  target: ClientLifecycleStage,
  actorUserId: string,
  reason?: string | null,
): Promise<LifecycleChangeResult> {
  const result = await withDbAttribution("leadLifecycle:manualSet", async () => {
    return getDb().transaction(async (tx) => {
      const [row] = await tx
        .select({ id: clients.id, lifecycleStage: clients.lifecycleStage })
        .from(clients)
        .where(eq(clients.id, clientId))
        .for("update");
      if (!row) return { changed: false, fromStage: null, toStage: target, client: null };

      const from = row.lifecycleStage;
      if (from === target) {
        return { changed: false, fromStage: from, toStage: target, client: null };
      }

      const [updated] = await tx
        .update(clients)
        .set({ lifecycleStage: target, leadLastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(clients.id, clientId))
        .returning();
      await tx.insert(clientLifecycleHistory).values({
        clientId,
        fromStage: from,
        toStage: target,
        changedByUserId: actorUserId,
        source: "manual",
        reason: reason ?? null,
      });
      return { changed: true, fromStage: from, toStage: target, client: updated ?? null };
    });
  });
  await cancelSequenceEnrollmentsOnCustomerEntry(clientId, result);
  return result;
}

export type LeadMatchKind = "client_email" | "contact_email" | "contact_phone" | "client_phone";

export interface MatchOrCreateLeadResult {
  client: Client;
  created: boolean;
  matchedBy: LeadMatchKind | null;
  /** The lifecycle transition applied to a matched existing record (if any). */
  lifecycle: LifecycleChangeResult | null;
}

interface LeadIdentity {
  email: string;
  name?: string | null;
  phone?: string | null;
}

/** Case-insensitive identity match against clients + client_contacts.
 *  Archived clients are INCLUDED — a former client writing in is the same
 *  identity, and linking beats minting a duplicate lead for them. */
async function findClientByIdentity(
  db: ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  identity: LeadIdentity,
): Promise<{ clientId: string; matchedBy: LeadMatchKind } | null> {
  const email = identity.email.trim().toLowerCase();
  if (email) {
    const byClientEmail = await db
      .select({ id: clients.id })
      .from(clients)
      .where(sql`lower(${clients.contactEmail}) = ${email}`)
      .limit(1);
    if (byClientEmail.length > 0) return { clientId: byClientEmail[0].id, matchedBy: "client_email" };

    const byContactEmail = await db
      .select({ clientId: clientContacts.clientId })
      .from(clientContacts)
      .where(sql`EXISTS (SELECT 1 FROM unnest(${clientContacts.emails}) AS e WHERE lower(e) = ${email})`)
      .limit(1);
    if (byContactEmail.length > 0) return { clientId: byContactEmail[0].clientId, matchedBy: "contact_email" };
  }

  const normalizedPhone = identity.phone ? normalizeToE164(identity.phone) : "";
  if (normalizedPhone) {
    const byContactPhone = await db
      .select({ clientId: clientContacts.clientId })
      .from(clientContacts)
      .where(sql`${normalizedPhone} = ANY(${clientContacts.phonesNormalized})`)
      .limit(1);
    if (byContactPhone.length > 0) return { clientId: byContactPhone[0].clientId, matchedBy: "contact_phone" };

    const phoneDigits = digitsOnly(normalizedPhone);
    if (phoneDigits.length >= 10) {
      const last10 = phoneDigits.slice(-10);
      const byClientPhone = await db
        .select({ id: clients.id })
        .from(clients)
        .where(sql`${clients.contactPhone} IS NOT NULL AND right(regexp_replace(${clients.contactPhone}, '\\D', '', 'g'), 10) = ${last10}`)
        .limit(1);
      if (byClientPhone.length > 0) return { clientId: byClientPhone[0].id, matchedBy: "client_phone" };
    }
  }

  return null;
}

/**
 * Match-or-create for intake events (website inquiry, booking).
 *
 * Matched existing record → forward-only advance toward `initialStage`
 * (customers no-op; prospects get their last-activity bumped either way).
 * No match → mint a prospect row + its primary contact (so Front/Twilio
 * matching sees the lead immediately) + the creation history entry, all in
 * one transaction serialized per-email by an advisory lock (P1: concurrent
 * duplicate submissions collapse to one lead).
 */
export async function matchOrCreateLeadClient(input: {
  email: string;
  name?: string | null;
  phone?: string | null;
  initialStage: Extract<ClientLifecycleStage, "lead" | "session_booked">;
  leadSource: LeadSource;
  changeSource: ClientLifecycleChangeSource;
  reason?: string | null;
  /**
   * Task #4337 — normalized first-touch attribution, applied ONLY on the
   * mint path below. Matched records are never re-stamped: first touch is
   * immutable by contract, so a repeat inquiry from a different campaign
   * cannot rewrite where the lead originally came from.
   */
  firstTouch?: { source: string; campaign: string | null };
}): Promise<MatchOrCreateLeadResult | null> {
  const email = input.email?.trim().toLowerCase();
  if (!email) return null;

  return withDbAttribution("leadLifecycle:matchOrCreate", async () => {
    // Fast path outside the lock: most intake events hit an existing record.
    const existing = await findClientByIdentity(getDb(), { email, phone: input.phone });
    if (existing) {
      const lifecycle = await advanceClientLifecycle(existing.clientId, input.initialStage, {
        source: input.changeSource,
        reason: input.reason ?? null,
      });
      const client = lifecycle.client ?? (await getClientRow(existing.clientId));
      if (!client) return null;
      return { client, created: false, matchedBy: existing.matchedBy, lifecycle };
    }

    return getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"lead_intake:" + email}))`);

      // Re-check under the lock — a concurrent submission may have minted it.
      const raced = await findClientByIdentity(tx, { email, phone: input.phone });
      if (raced) {
        const [row] = await tx.select().from(clients).where(eq(clients.id, raced.clientId));
        if (!row) return null;
        // Advance is a separate short transaction after this one commits —
        // matching the fast path — but we are inside a tx; do it inline.
        const from = row.lifecycleStage;
        if (clientLifecycleStageRank[from] < clientLifecycleStageRank[input.initialStage]) {
          const [updated] = await tx
            .update(clients)
            .set({ lifecycleStage: input.initialStage, leadLastActivityAt: new Date(), updatedAt: new Date() })
            .where(eq(clients.id, row.id))
            .returning();
          await tx.insert(clientLifecycleHistory).values({
            clientId: row.id,
            fromStage: from,
            toStage: input.initialStage,
            changedByUserId: null,
            source: input.changeSource,
            reason: input.reason ?? null,
          });
          return {
            client: updated ?? row,
            created: false,
            matchedBy: raced.matchedBy,
            lifecycle: { changed: true, fromStage: from, toStage: input.initialStage, client: updated ?? row },
          };
        }
        if (from !== "customer") {
          const [updated] = await tx
            .update(clients)
            .set({ leadLastActivityAt: new Date(), updatedAt: new Date() })
            .where(eq(clients.id, row.id))
            .returning();
          return {
            client: updated ?? row,
            created: false,
            matchedBy: raced.matchedBy,
            lifecycle: { changed: false, fromStage: from, toStage: from, client: updated ?? row },
          };
        }
        return {
          client: row,
          created: false,
          matchedBy: raced.matchedBy,
          lifecycle: { changed: false, fromStage: from, toStage: from, client: row },
        };
      }

      // Mint the prospect. NO client code (operator-facing NB-XXXX codes are
      // reserved for real clients), NO products (nothing sold yet), owner
      // unset until an operator claims it.
      const displayName = input.name?.trim() || email.split("@")[0];
      const [created] = await tx
        .insert(clients)
        .values({
          firmName: displayName,
          contactName: input.name?.trim() || null,
          contactEmail: email,
          contactPhone: input.phone?.trim() || null,
          products: [],
          lifecycleStage: input.initialStage,
          leadSource: input.leadSource,
          leadLastActivityAt: new Date(),
          firstTouchSource: input.firstTouch?.source ?? null,
          firstTouchCampaign: input.firstTouch?.campaign ?? null,
        })
        .returning();

      const phonesNormalized = input.phone ? [normalizeToE164(input.phone)].filter(Boolean) : [];
      const [contact] = await tx
        .insert(clientContacts)
        .values({
          clientId: created.id,
          name: displayName,
          emails: [email],
          phones: input.phone?.trim() ? [input.phone.trim()] : [],
          phonesNormalized,
          isPrimary: true,
        })
        .returning();
      await tx.insert(clientContactsAudit).values({
        contactId: contact.id,
        clientId: created.id,
        action: "insert",
        actorUserId: null,
        source: `lead_intake:${input.leadSource}`,
        reason: null,
        oldName: null,
        newName: contact.name,
        oldRoleTitle: null,
        newRoleTitle: null,
        oldIsPrimary: null,
        newIsPrimary: true,
        oldEmails: null,
        newEmails: (contact.emails as string[] | null) ?? [],
        oldPhones: null,
        newPhones: (contact.phones as string[] | null) ?? [],
      });

      await tx.insert(clientLifecycleHistory).values({
        clientId: created.id,
        fromStage: null,
        toStage: input.initialStage,
        changedByUserId: null,
        source: input.changeSource,
        reason: input.reason ?? null,
      });

      return { client: created, created: true, matchedBy: null, lifecycle: null };
    });
  });
}

async function getClientRow(id: string): Promise<Client | null> {
  return withDbAttribution("leadLifecycle:getClientRow", async () => {
    const [row] = await getDb().select().from(clients).where(eq(clients.id, id));
    return row ?? null;
  });
}

export interface ProspectListFilters {
  /** Stages to include; defaults to all non-customer stages. */
  stages?: ClientLifecycleStage[];
  leadSource?: string;
  ownerId?: string;
  limit?: number;
  offset?: number;
}

export interface ProspectListRow extends Client {
  openDealId: string | null;
  openDealName: string | null;
}

/** Leads-view list: prospect rows (or an explicit stage filter), newest
 *  activity first, each annotated with its first open deal (if any) so the
 *  UI can offer "view deal" vs "promote to deal". */
export async function getProspectClients(filters: ProspectListFilters = {}): Promise<{ data: ProspectListRow[]; total: number }> {
  return withDbAttribution("leadLifecycle:listProspects", async () => {
    const stages = (filters.stages && filters.stages.length > 0)
      ? filters.stages
      : (["lead", "session_booked", "opportunity"] as ClientLifecycleStage[]);
    const limit = Math.min(Math.max(filters.limit ?? LEADS_LIST_DEFAULT_LIMIT, 1), LEADS_LIST_MAX_LIMIT);
    const offset = Math.max(filters.offset ?? 0, 0);

    const conditions = [inArray(clients.lifecycleStage, stages)];
    if (filters.leadSource) conditions.push(eq(clients.leadSource, filters.leadSource));
    if (filters.ownerId) conditions.push(eq(clients.ownerId, filters.ownerId));
    const where = and(...conditions);

    const [countResult] = await getDb().select({ count: sql<number>`count(*)::int` }).from(clients).where(where);
    const rows = await getDb()
      .select()
      .from(clients)
      .where(where)
      .orderBy(sql`${clients.leadLastActivityAt} DESC NULLS LAST`, desc(clients.createdAt))
      .limit(limit)
      .offset(offset);

    const ids = rows.map((r) => r.id);
    const openByClient = new Map<string, { id: string; name: string }>();
    if (ids.length > 0) {
      const openDeals = await getDb()
        .select({ id: deals.id, name: deals.name, clientId: deals.clientId, createdAt: deals.createdAt })
        .from(deals)
        .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(and(
          inArray(deals.clientId, ids),
          eq(dealStages.stageType, "open"),
          eq(deals.isArchived, false),
        ))
        .orderBy(desc(deals.createdAt));
      for (const d of openDeals) {
        if (d.clientId && !openByClient.has(d.clientId)) {
          openByClient.set(d.clientId, { id: d.id, name: d.name });
        }
      }
    }

    const data: ProspectListRow[] = rows.map((r) => ({
      ...r,
      openDealId: openByClient.get(r.id)?.id ?? null,
      openDealName: openByClient.get(r.id)?.name ?? null,
    }));
    return { data, total: countResult?.count || 0 };
  });
}

/** Slim client row for the merge-target typeahead (Task #4584). */
export interface MergeCandidateRow {
  id: string;
  firmName: string;
  contactName: string | null;
  contactEmail: string | null;
  lifecycleStage: string;
}

/** Task #4584 — merge-target search: any client (customers included, the
 *  "former client wrote in with a new address" case) matched by firm name,
 *  contact name, or email. Bounded, read-only; demo rows excluded unless the
 *  actor may see them; the merging-away record is excluded server-side. */
export async function searchMergeCandidateClients(input: {
  q: string;
  excludeId?: string;
  includeDemo?: boolean;
}): Promise<MergeCandidateRow[]> {
  return withDbAttribution("leadLifecycle:searchMergeCandidates", async () => {
    const pattern = `%${input.q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const conditions = [
      sql`(${clients.firmName} ILIKE ${pattern} OR ${clients.contactName} ILIKE ${pattern} OR ${clients.contactEmail} ILIKE ${pattern})`,
    ];
    if (input.excludeId) conditions.push(sql`${clients.id} <> ${input.excludeId}`);
    if (!input.includeDemo) conditions.push(eq(clients.isDemo, false));
    return getDb()
      .select({
        id: clients.id,
        firmName: clients.firmName,
        contactName: clients.contactName,
        contactEmail: clients.contactEmail,
        lifecycleStage: clients.lifecycleStage,
      })
      .from(clients)
      .where(and(...conditions))
      .orderBy(sql`${clients.leadLastActivityAt} DESC NULLS LAST`, desc(clients.createdAt))
      .limit(MERGE_CANDIDATE_SEARCH_LIMIT);
  });
}

/** True when the client already has a non-archived deal in an open stage —
 *  the auto-deal dedupe (rebookings must not spawn deal spam). */
export async function hasOpenDealForClient(clientId: string): Promise<boolean> {
  return withDbAttribution("leadLifecycle:hasOpenDeal", async () => {
    const rows = await getDb()
      .select({ id: deals.id })
      .from(deals)
      .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(and(
        eq(deals.clientId, clientId),
        eq(deals.isArchived, false),
        eq(dealStages.stageType, "open"),
      ))
      .limit(1);
    return rows.length > 0;
  });
}

export async function getClientLifecycleHistory(clientId: string): Promise<ClientLifecycleHistoryEntry[]> {
  return withDbAttribution("leadLifecycle:history", async () => {
    return getDb()
      .select()
      .from(clientLifecycleHistory)
      .where(eq(clientLifecycleHistory.clientId, clientId))
      .orderBy(desc(clientLifecycleHistory.createdAt))
      .limit(LIFECYCLE_HISTORY_LIMIT);
  });
}

/** Inquiries promoted/linked to this lead (Leads-view detail). */
export async function getWebsiteInquiriesForLead(clientId: string): Promise<WebsiteInquiry[]> {
  return withDbAttribution("leadLifecycle:inquiriesForLead", async () => {
    return getDb()
      .select()
      .from(websiteInquiries)
      .where(eq(websiteInquiries.leadClientId, clientId))
      .orderBy(desc(websiteInquiries.createdAt))
      .limit(50);
  });
}

export async function linkWebsiteInquiryToLead(inquiryId: string, clientId: string): Promise<void> {
  return withDbAttribution("leadLifecycle:linkInquiry", async () => {
    await getDb()
      .update(websiteInquiries)
      .set({ leadClientId: clientId })
      .where(eq(websiteInquiries.id, inquiryId));
  });
}

// ── Lead merge (Task #4424) ─────────────────────────────────────────────────

export interface MergeLeadMoved {
  inquiries: number;
  meetings: number;
  deals: number;
  contacts: number;
  historyEntries: number;
  sequenceEnrollments: number;
  bookingTokens: number;
}

export type MergeLeadError =
  | "source_not_found"
  | "target_not_found"
  | "same_record"
  | "source_is_customer";

export interface MergeLeadResult {
  ok: boolean;
  error?: MergeLeadError;
  winner?: Client;
  moved?: MergeLeadMoved;
}

/**
 * Task #4424 — fold a duplicate lead (`sourceId`, the loser) into another
 * record (`targetId`, the winner) without losing history.
 *
 * One transaction, both rows locked FOR UPDATE in deterministic id order
 * (no deadlock between two concurrent merges). Guards:
 *   - the loser must be a prospect (lifecycle_stage <> 'customer') — real
 *     paying clients can never be merge-deleted; prospects also never hold
 *     an NB-XXXX client code, so no code is lost.
 *   - loser ≠ winner; both must exist.
 *
 * All child rows relink to the winner BEFORE the delete, so the set-null /
 * cascade FK actions never fire on linked data: website_inquiries
 * (lead_client_id), scheduled_meetings, deals, client_contacts (demoted to
 * non-primary when the winner already has a primary), the full
 * client_lifecycle_history timeline, email_sequence_enrollments, and
 * booking_client_tokens.
 *
 * The winner keeps the furthest-forward lifecycle stage (forward-only: the
 * winner never moves backwards) and the earliest created_at; last activity
 * bumps to now. Exactly one manual-source history entry is written for the
 * winner documenting who merged what (it doubles as the stage-change entry
 * when the loser was further along). The loser row is then deleted.
 */
export async function mergeLeadIntoClient(
  sourceId: string,
  targetId: string,
  actorUserId: string,
  reason?: string | null,
): Promise<MergeLeadResult> {
  if (sourceId === targetId) return { ok: false, error: "same_record" };

  const result = await withDbAttribution("leadLifecycle:merge", async () => {
    return getDb().transaction(async (tx): Promise<MergeLeadResult> => {
      // Lock both rows in deterministic order to avoid deadlocks between
      // concurrent merges touching the same pair.
      const lockIds = [sourceId, targetId].sort();
      const locked = await tx
        .select()
        .from(clients)
        .where(inArray(clients.id, lockIds))
        .for("update");
      const source = locked.find((r) => r.id === sourceId);
      const target = locked.find((r) => r.id === targetId);
      if (!source) return { ok: false, error: "source_not_found" };
      if (!target) return { ok: false, error: "target_not_found" };
      if (source.lifecycleStage === "customer") {
        return { ok: false, error: "source_is_customer" };
      }

      // Relink children (counts feed the route response / UI toast).
      const inquiries = await tx
        .update(websiteInquiries)
        .set({ leadClientId: targetId })
        .where(eq(websiteInquiries.leadClientId, sourceId))
        .returning({ id: websiteInquiries.id });
      const meetings = await tx
        .update(scheduledMeetings)
        .set({ clientId: targetId })
        .where(eq(scheduledMeetings.clientId, sourceId))
        .returning({ id: scheduledMeetings.id });
      const movedDeals = await tx
        .update(deals)
        .set({ clientId: targetId })
        .where(eq(deals.clientId, sourceId))
        .returning({ id: deals.id });

      // Contacts: move them over; if the winner already has a primary
      // contact, incoming contacts arrive demoted so there is one primary.
      const [existingPrimary] = await tx
        .select({ id: clientContacts.id })
        .from(clientContacts)
        .where(and(eq(clientContacts.clientId, targetId), eq(clientContacts.isPrimary, true)))
        .limit(1);
      const contacts = await tx
        .update(clientContacts)
        .set(existingPrimary ? { clientId: targetId, isPrimary: false } : { clientId: targetId })
        .where(eq(clientContacts.clientId, sourceId))
        .returning({ id: clientContacts.id });

      // The loser's full lifecycle timeline moves — history is preserved,
      // not cascaded away.
      const historyEntries = await tx
        .update(clientLifecycleHistory)
        .set({ clientId: targetId })
        .where(eq(clientLifecycleHistory.clientId, sourceId))
        .returning({ id: clientLifecycleHistory.id });

      // Collision semantics BEFORE relinking entity ids: the partial unique
      // index email_seq_enrollments_active_uq allows one ACTIVE enrollment
      // per (sequence, entity). Two duplicate leads enrolled in the same
      // campaign is a normal state — cancel the loser's colliding active
      // client-entity enrollments (history retained, reason visible in the
      // UI) so the relink below can never abort the merge transaction.
      await tx.execute(sql`
        UPDATE email_sequence_enrollments AS losing
        SET status = 'cancelled',
            cancel_reason = 'manual',
            cancel_note = ${'Duplicate enrollment cancelled when lead ' + sourceId + ' was merged into ' + targetId},
            updated_at = NOW()
        WHERE losing.entity_type = 'client'
          AND losing.entity_id = ${sourceId}
          AND losing.status = 'active'
          AND EXISTS (
            SELECT 1 FROM email_sequence_enrollments AS winning
            WHERE winning.sequence_id = losing.sequence_id
              AND winning.entity_type = 'client'
              AND winning.entity_id = ${targetId}
              AND winning.status = 'active'
          )
      `);
      const enrollments = await tx
        .update(emailSequenceEnrollments)
        .set({ clientId: targetId })
        .where(eq(emailSequenceEnrollments.clientId, sourceId))
        .returning({ id: emailSequenceEnrollments.id });
      // Polymorphic client-entity enrollments point at the loser id directly
      // (contact-entity rows keep their entity id — the contact rows
      // themselves moved above, so no unique-index interaction there).
      await tx
        .update(emailSequenceEnrollments)
        .set({ entityId: targetId })
        .where(and(eq(emailSequenceEnrollments.entityType, "client"), eq(emailSequenceEnrollments.entityId, sourceId)));

      const tokens = await tx
        .update(bookingClientTokens)
        .set({ clientId: targetId })
        .where(eq(bookingClientTokens.clientId, sourceId))
        .returning({ id: bookingClientTokens.id });

      // Winner keeps the furthest-forward stage + earliest created_at.
      const fromStage = target.lifecycleStage;
      const finalStage =
        clientLifecycleStageRank[source.lifecycleStage] > clientLifecycleStageRank[fromStage]
          ? source.lifecycleStage
          : fromStage;
      const earliestCreatedAt =
        source.createdAt && target.createdAt && source.createdAt < target.createdAt
          ? source.createdAt
          : target.createdAt;
      const [winner] = await tx
        .update(clients)
        .set({
          lifecycleStage: finalStage,
          createdAt: earliestCreatedAt,
          leadLastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(clients.id, targetId))
        .returning();

      // One manual-source audit entry documents the merge (and doubles as
      // the stage-change entry when the loser was further along).
      const mergeNote =
        `Merged duplicate lead "${source.firmName}" (${source.contactEmail ?? "no email"}, id ${source.id}) into this record` +
        (reason?.trim() ? ` — ${reason.trim()}` : "");
      await tx.insert(clientLifecycleHistory).values({
        clientId: targetId,
        fromStage,
        toStage: finalStage,
        changedByUserId: actorUserId,
        source: "manual",
        reason: mergeNote,
      });

      // Everything is relinked — the delete removes only the loser row
      // itself (any straggler cascade/set-null children are, by
      // construction, empty).
      await tx.delete(clients).where(eq(clients.id, sourceId));

      return {
        ok: true,
        winner,
        moved: {
          inquiries: inquiries.length,
          meetings: meetings.length,
          deals: movedDeals.length,
          contacts: contacts.length,
          historyEntries: historyEntries.length,
          sequenceEnrollments: enrollments.length,
          bookingTokens: tokens.length,
        },
      };
    });
  });

  // Task #4335 policy: a record at 'customer' must not carry active
  // sequence enrollments — covers merging a lead's enrollments into an
  // existing customer (post-commit, same lazy helper as the lifecycle
  // writers; never throws).
  if (result.ok && result.winner?.lifecycleStage === "customer") {
    await cancelSequenceEnrollmentsOnCustomerEntry(targetId, {
      changed: true,
      fromStage: null,
      toStage: "customer",
      client: result.winner,
    });
  }
  return result;
}
