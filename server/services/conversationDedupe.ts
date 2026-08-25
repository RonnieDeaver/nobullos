// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  // Direct-conversation dedupe and idempotent creation (Task #849).
// All direct (non-group) twilio_conversations writes should go through
// findOrCreateDirectConversation. The merge helpers collapse pre-existing
// duplicates created before the partial unique index was added.

import { sql, and, eq, asc, desc, inArray, isNotNull, ne, count } from "drizzle-orm";
import { getDb } from "../db";
import {
  twilioConversations,
  twilioMessages,
  rawCommunicationRecords,
  type TwilioConversation,
  type InsertTwilioConversation,
} from "@shared/schema";
import { getDirectConversationKey, getPhoneMatchKey } from "./phoneNormalization";

const DEDUPE_AUDIT_TAG = "system:conversation-dedupe";

// Task #858 — Slack notification fired when a merge is skipped due to a
// client-id conflict. Uses the unified dispatcher so channel/enabled state
// lives in the standard notification_settings table. Best-effort: never
// throws into the merge path. Tests can replace the implementation via
// `__setClientConflictNotifierForTests`.
const CLIENT_CONFLICT_NOTIFICATION_ID = "infra.conversation_dedupe.client_conflict";

type ClientConflictNotifier = (entry: MergeAuditEntry) => Promise<void>;

async function defaultClientConflictNotifier(entry: MergeAuditEntry): Promise<void> {
  try {
    const { notifyByType } = await import("./notifications/dispatcher");
    const involved = (entry.clientIdsInvolved ?? []).map((id) => id ?? "<none>");
    // Task #1285 — include a link straight to the in-app resolver so the
    // operator doesn't have to hand-edit the DB and rerun a script.
    let resolveLink = "/admin/conversation-dedupe-conflicts";
    try {
      const { getPublicBaseUrl } = await import("./publicUrl");
      resolveLink = `${getPublicBaseUrl({ allowLocalhostFallback: true })}/admin/conversation-dedupe-conflicts`;
    } catch {
      // best-effort; fall back to a relative path
    }
    const text = [
      `:warning: *Conversation dedupe skipped a duplicate group — client conflict*`,
      `• Conversation IDs: \`${entry.mergedConversationIds.join("`, `")}\``,
      `• Linked clientIds: \`${involved.join("`, `")}\``,
      `• Direct-thread key: \`direct:${entry.twilioPhoneKey}:${entry.contactPhoneKey}\``,
      `• Actor: ${entry.actor}`,
      `Resolve in one click: ${resolveLink}`,
    ].join("\n");
    await notifyByType(
      CLIENT_CONFLICT_NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // One alert per (key, clientIds) tuple; let the dispatcher
        // collapse repeats while the conflict remains unresolved.
        dedupeKey: `direct:${entry.twilioPhoneKey}:${entry.contactPhoneKey}`,
        failureType: involved.sort().join("|"),
        metadata: {
          conversationIds: entry.mergedConversationIds,
          clientIdsInvolved: entry.clientIdsInvolved,
          contactPhoneKey: entry.contactPhoneKey,
          twilioPhoneKey: entry.twilioPhoneKey,
          actor: entry.actor,
        },
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[conversation-dedupe] client-conflict notification failed: ${msg}`,
    );
  }
}

let clientConflictNotifier: ClientConflictNotifier = defaultClientConflictNotifier;

export function __setClientConflictNotifierForTests(
  fn: ClientConflictNotifier | null,
): void {
  clientConflictNotifier = fn ?? defaultClientConflictNotifier;
}

// Audit log entry emitted for every auto-merge or skip decision.
export interface MergeAuditEntry {
  timestamp: string;
  actor: string;
  survivorConversationId: string;
  mergedConversationIds: string[];
  contactPhoneKey: string;
  twilioPhoneKey: string;
  movedMessageCount: number;
  movedRawCommRecordCount: number;
  skipReason?: string;
  clientIdsInvolved?: Array<string | null>;
}

export type DedupeOutcome =
  | { status: "merged"; entry: MergeAuditEntry }
  | { status: "skipped_client_conflict"; entry: MergeAuditEntry };

function emitAudit(entry: MergeAuditEntry): void {
  console.log(`[conversation-dedupe] ${JSON.stringify(entry)}`);
}

export function buildNormalizedFields(args: {
  contactPhone: string | null | undefined;
  twilioPhoneNumber: string | null | undefined;
  conversationType: string | null | undefined;
}): {
  contactPhoneNormalized: string | null;
  twilioPhoneNumberNormalized: string | null;
  directThreadKey: string | null;
} {
  const contactKey = getPhoneMatchKey(args.contactPhone);
  const twilioKey = getPhoneMatchKey(args.twilioPhoneNumber);
  const isGroup = (args.conversationType ?? "direct") === "group";
  return {
    contactPhoneNormalized: contactKey,
    twilioPhoneNumberNormalized: twilioKey,
    directThreadKey:
      isGroup || !contactKey || !twilioKey ? null : `direct:${twilioKey}:${contactKey}`,
  };
}

// Look up the canonical direct thread for a (contact, twilio) pair.
// Returns a deterministic survivor when multiple rows share the key
// (possible before merge has run). Group rows are excluded.
export async function findDirectConversationByKey(
  directThreadKey: string,
  preferClientId?: string | null,
): Promise<TwilioConversation | undefined> {
  const rows = await getDb()
    .select()
    .from(twilioConversations)
    .where(
      and(
        eq(twilioConversations.directThreadKey, directThreadKey),
        ne(twilioConversations.conversationType, "group"),
      ),
    );

  if (rows.length === 0) return undefined;

  if (rows.length > 1) {
    console.warn(
      `[conversation-dedupe] multiple direct rows share key ${directThreadKey} (count=${rows.length}, ids=${rows.map((r) => r.id).join(",")}) — run mergeDuplicateDirectConversations to clean up`,
    );
  }

  return pickSurvivor(rows, preferClientId ?? undefined);
}

// Survivor selection: most messages -> oldest -> linked client -> id.
export function pickSurvivor(
  rows: TwilioConversation[],
  preferClientId?: string,
  messagesByConv?: Map<string, number>,
): TwilioConversation {
  const sorted = [...rows].sort((a, b) => {
    if (messagesByConv) {
      const ma = messagesByConv.get(a.id) ?? 0;
      const mb = messagesByConv.get(b.id) ?? 0;
      if (ma !== mb) return mb - ma;
    }
    const at = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    if (preferClientId) {
      const aMatch = a.clientId === preferClientId ? 1 : 0;
      const bMatch = b.clientId === preferClientId ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

// Idempotent direct-conversation creation. Returns created=true only
// when this call inserted the row; created=false when an existing row
// was reused (initial lookup or race retry on unique-violation).
export async function findOrCreateDirectConversation(args: {
  data: InsertTwilioConversation;
  preferClientId?: string | null;
}): Promise<{ conversation: TwilioConversation; created: boolean }> {
  const conversationType = args.data.conversationType ?? "direct";
  if (conversationType === "group") {
    throw new Error(
      "findOrCreateDirectConversation called with a group conversation — use the group create path",
    );
  }

  const normalizedFields = buildNormalizedFields({
    contactPhone: args.data.contactPhone,
    twilioPhoneNumber: args.data.twilioPhoneNumber,
    conversationType,
  });

  // No canonical key derivable (e.g. <10-digit phone): insert without
  // unique-key dedupe but still write the raw fields for addressability.
  if (!normalizedFields.directThreadKey) {
    const [conv] = await getDb()
      .insert(twilioConversations)
      .values({ ...args.data, ...normalizedFields, conversationType })
      .returning();
    return { conversation: conv, created: true };
  }

  const existing = await findDirectConversationByKey(
    normalizedFields.directThreadKey,
    args.preferClientId,
  );
  if (existing) return { conversation: existing, created: false };

  try {
    const [conv] = await getDb()
      .insert(twilioConversations)
      .values({ ...args.data, ...normalizedFields, conversationType })
      .returning();
    return { conversation: conv, created: true };
  } catch (err: unknown) {
    // Race: concurrent insert won; fetch the surviving row.
    if (isUniqueViolation(err)) {
      const winner = await findDirectConversationByKey(
        normalizedFields.directThreadKey,
        args.preferClientId,
      );
      if (winner) return { conversation: winner, created: false };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "23505";
}

// Merge a set of duplicate direct conversations into a single survivor.
// Skips with audit entry when duplicates link to different clientIds.
export async function mergeDirectConversationGroup(args: {
  conversations: TwilioConversation[];
  contactPhoneKey: string;
  twilioPhoneKey: string;
  actor?: string;
  // Task #1285 — operator-driven merges (via resolveClientConflict)
  // pass the exact survivor id picked from the UI, overriding the
  // default "most messages → oldest" survivor selection so the
  // operator's choice is respected end-to-end.
  forceSurvivorId?: string;
}): Promise<DedupeOutcome> {
  const db = getDb();
  const { conversations, contactPhoneKey, twilioPhoneKey } = args;
  const actor = args.actor ?? DEDUPE_AUDIT_TAG;

  if (conversations.length < 2) {
    throw new Error("mergeDirectConversationGroup needs at least 2 conversations");
  }

  const distinctClientIds = new Set(
    conversations.map((c) => c.clientId).filter((id): id is string => Boolean(id)),
  );
  if (distinctClientIds.size > 1) {
    const entry: MergeAuditEntry = {
      timestamp: new Date().toISOString(),
      actor,
      survivorConversationId: "",
      mergedConversationIds: conversations.map((c) => c.id),
      contactPhoneKey,
      twilioPhoneKey,
      movedMessageCount: 0,
      movedRawCommRecordCount: 0,
      skipReason: "duplicate_direct_thread_conflict",
      clientIdsInvolved: conversations.map((c) => c.clientId),
    };
    emitAudit(entry);
    // Surface the conflict to operators so it doesn't sit in the script's
    // stdout unnoticed. Awaited so callers (notably the merge script,
    // which `process.exit`s as soon as `runMerge` resolves) don't drop the
    // delivery before it lands in Slack / the deliveries table. The
    // notifier swallows its own errors, so this never throws.
    await clientConflictNotifier(entry);
    return { status: "skipped_client_conflict", entry };
  }

  const convIds = conversations.map((c) => c.id);
  const messageCounts = await db
    .select({
      conversationId: twilioMessages.conversationId,
      count: count(twilioMessages.id),
    })
    .from(twilioMessages)
    .where(inArray(twilioMessages.conversationId, convIds))
    .groupBy(twilioMessages.conversationId);
  const messagesByConv = new Map(messageCounts.map((m) => [m.conversationId, Number(m.count)]));

  const preferClientId = distinctClientIds.size === 1 ? [...distinctClientIds][0] : undefined;
  let survivor: TwilioConversation;
  if (args.forceSurvivorId) {
    const forced = conversations.find((c) => c.id === args.forceSurvivorId);
    if (!forced) {
      throw new Error(
        `forceSurvivorId ${args.forceSurvivorId} is not in the conversation group for direct:${twilioPhoneKey}:${contactPhoneKey}`,
      );
    }
    survivor = forced;
  } else {
    survivor = pickSurvivor(conversations, preferClientId, messagesByConv);
  }
  const losers = conversations.filter((c) => c.id !== survivor.id);

  await db.transaction(async (tx) => {
    for (const loser of losers) {
      await tx
        .update(twilioMessages)
        .set({ conversationId: survivor.id })
        .where(eq(twilioMessages.conversationId, loser.id));
    }

    const promotion: Partial<TwilioConversation> = {};
    if (!survivor.clientId) {
      const donor = losers.find((l) => l.clientId);
      if (donor?.clientId) promotion.clientId = donor.clientId;
    }
    if (!survivor.clientContactId) {
      const donor = losers.find((l) => l.clientContactId);
      if (donor?.clientContactId) promotion.clientContactId = donor.clientContactId;
    }
    if (!survivor.contactName) {
      const donor = losers.find((l) => l.contactName);
      if (donor?.contactName) promotion.contactName = donor.contactName;
    }

    const [latest] = await tx
      .select({
        lastMessageAt: twilioMessages.createdAt,
        lastBody: twilioMessages.body,
      })
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, survivor.id))
      .orderBy(desc(twilioMessages.createdAt))
      .limit(1);

    const [unread] = await tx
      .select({ c: count(twilioMessages.id) })
      .from(twilioMessages)
      .where(
        and(
          eq(twilioMessages.conversationId, survivor.id),
          eq(twilioMessages.direction, "inbound"),
          eq(twilioMessages.status, "received"),
        ),
      );

    await tx
      .update(twilioConversations)
      .set({
        ...promotion,
        lastMessageAt: latest?.lastMessageAt ?? survivor.lastMessageAt ?? null,
        lastMessagePreview:
          latest?.lastBody?.substring(0, 100) ?? survivor.lastMessagePreview ?? null,
        unreadCount: Number(unread?.c ?? 0),
        updatedAt: new Date(),
      })
      .where(eq(twilioConversations.id, survivor.id));

    await tx
      .delete(twilioConversations)
      .where(inArray(twilioConversations.id, losers.map((l) => l.id)));
  });

  const movedMessageRows = await db
    .select({ rawCommId: twilioMessages.rawCommunicationRecordId })
    .from(twilioMessages)
    .where(
      and(
        eq(twilioMessages.conversationId, survivor.id),
        isNotNull(twilioMessages.rawCommunicationRecordId),
      ),
    );
  const movedRawCommIds = new Set(
    movedMessageRows.map((m) => m.rawCommId).filter((id): id is string => Boolean(id)),
  );
  const movedMessageCount = losers.reduce(
    (sum, l) => sum + (messagesByConv.get(l.id) ?? 0),
    0,
  );

  if (movedRawCommIds.size > 0) {
    await db
      .select({ id: rawCommunicationRecords.id })
      .from(rawCommunicationRecords)
      .where(inArray(rawCommunicationRecords.id, [...movedRawCommIds]));
  }

  const entry: MergeAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    survivorConversationId: survivor.id,
    mergedConversationIds: losers.map((l) => l.id),
    contactPhoneKey,
    twilioPhoneKey,
    movedMessageCount,
    movedRawCommRecordCount: movedRawCommIds.size,
    clientIdsInvolved: conversations.map((c) => c.clientId),
  };
  emitAudit(entry);
  return { status: "merged", entry };
}

// Returns all direct-conversation groups (computed key) of size >= 2.
// Includes rows where directThreadKey is still NULL (key computed from
// raw fields), since the unique index forces the backfill to leave
// NULLs on losing duplicate rows.
export async function findDuplicateDirectGroups(): Promise<
  Array<{ key: string; rows: TwilioConversation[] }>
> {
  const rows = await getDb()
    .select()
    .from(twilioConversations)
    .where(ne(twilioConversations.conversationType, "group"))
    .orderBy(asc(twilioConversations.createdAt));

  const byKey = new Map<string, TwilioConversation[]>();
  for (const r of rows) {
    let key = r.directThreadKey;
    if (!key) {
      const computed = buildNormalizedFields({
        contactPhone: r.contactPhone,
        twilioPhoneNumber: r.twilioPhoneNumber,
        conversationType: r.conversationType,
      });
      key = computed.directThreadKey;
    }
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  const dups: Array<{ key: string; rows: TwilioConversation[] }> = [];
  for (const [key, list] of byKey.entries()) {
    if (list.length > 1) dups.push({ key, rows: list });
  }
  return dups;
}

export const DEDUPE_AUDIT_ACTOR = DEDUPE_AUDIT_TAG;

// ---------------------------------------------------------------------------
// Task #1285 — operator-facing helpers for the duplicate-thread conflict
// resolver UI. The Slack alert fired by `defaultClientConflictNotifier`
// links straight to `/admin/conversation-dedupe-conflicts`, which lists
// every open conflict via `listOpenClientConflicts` and lets the operator
// pick a survivor + correct client via `resolveClientConflict`.
// ---------------------------------------------------------------------------

export interface ClientConflictConversation {
  id: string;
  clientId: string | null;
  contactPhone: string | null;
  twilioPhoneNumber: string | null;
  conversationType: string | null;
  status: string | null;
  createdAt: Date | null;
  lastMessageAt: Date | null;
  messageCount: number;
}

export interface ClientConflictGroup {
  key: string;
  contactPhoneKey: string;
  twilioPhoneKey: string;
  conversations: ClientConflictConversation[];
  conflictingClientIds: string[];
}

// Returns every duplicate-direct-thread group where the rows link to
// more than one distinct clientId — exactly the set of groups
// `mergeDirectConversationGroup` would skip with reason
// `duplicate_direct_thread_conflict`.
export async function listOpenClientConflicts(): Promise<ClientConflictGroup[]> {
  const groups = await findDuplicateDirectGroups();
  if (groups.length === 0) return [];

  const conflictGroups = groups.filter((g) => {
    const distinct = new Set(
      g.rows.map((r) => r.clientId).filter((id): id is string => Boolean(id)),
    );
    return distinct.size > 1;
  });
  if (conflictGroups.length === 0) return [];

  const allConvIds = conflictGroups.flatMap((g) => g.rows.map((r) => r.id));
  const counts = await getDb()
    .select({
      conversationId: twilioMessages.conversationId,
      count: count(twilioMessages.id),
    })
    .from(twilioMessages)
    .where(inArray(twilioMessages.conversationId, allConvIds))
    .groupBy(twilioMessages.conversationId);
  const countsByConv = new Map(counts.map((m) => [m.conversationId, Number(m.count)]));

  const result: ClientConflictGroup[] = [];
  for (const g of conflictGroups) {
    const parsed = parseDirectThreadKey(g.key);
    if (!parsed) continue;
    const distinctClients = Array.from(
      new Set(g.rows.map((r) => r.clientId).filter((id): id is string => Boolean(id))),
    );
    result.push({
      key: g.key,
      contactPhoneKey: parsed.contactPhoneKey,
      twilioPhoneKey: parsed.twilioPhoneKey,
      conflictingClientIds: distinctClients,
      conversations: g.rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        contactPhone: r.contactPhone,
        twilioPhoneNumber: r.twilioPhoneNumber,
        conversationType: r.conversationType,
        status: r.status,
        createdAt: r.createdAt,
        lastMessageAt: r.lastMessageAt,
        messageCount: countsByConv.get(r.id) ?? 0,
      })),
    });
  }
  return result;
}

export type ResolveClientConflictResult =
  | { status: "merged"; entry: MergeAuditEntry }
  | { status: "no_conflict"; reason: string };

// Operator one-click resolver: re-points every duplicate row in a
// client-conflict group to `targetClientId`, then runs the standard
// merge. Validates that the survivor and target client are both part
// of the current open conflict to avoid stamping over a state the
// operator hasn't actually seen.
export async function resolveClientConflict(args: {
  key: string;
  survivorConversationId: string;
  targetClientId: string;
  actor?: string;
}): Promise<ResolveClientConflictResult> {
  const actor = args.actor ?? DEDUPE_AUDIT_TAG;
  const parsed = parseDirectThreadKey(args.key);
  if (!parsed) throw new Error(`Malformed direct-thread key: ${args.key}`);

  const rows = await getDb()
    .select()
    .from(twilioConversations)
    .where(
      and(
        eq(twilioConversations.directThreadKey, args.key),
        ne(twilioConversations.conversationType, "group"),
      ),
    );

  // Include any rows that share the computed key but still have a
  // NULL `directThreadKey` (e.g. losing rows skipped by the partial
  // unique index during backfill). `findDuplicateDirectGroups` does
  // the same merge so the resolver matches what the operator saw.
  if (rows.length < 2) {
    const groups = await findDuplicateDirectGroups();
    const fromKey = groups.find((g) => g.key === args.key);
    if (!fromKey || fromKey.rows.length < 2) {
      return { status: "no_conflict", reason: "group_no_longer_has_duplicates" };
    }
    rows.length = 0;
    rows.push(...fromKey.rows);
  }

  const distinctClients = new Set(
    rows.map((r) => r.clientId).filter((id): id is string => Boolean(id)),
  );
  if (distinctClients.size < 2) {
    return { status: "no_conflict", reason: "group_no_longer_in_conflict" };
  }

  if (!rows.some((r) => r.id === args.survivorConversationId)) {
    throw new Error(
      `Survivor conversation ${args.survivorConversationId} is not part of conflict group ${args.key}`,
    );
  }
  if (!distinctClients.has(args.targetClientId)) {
    throw new Error(
      `Target client ${args.targetClientId} is not one of the conflicting clients for group ${args.key}`,
    );
  }

  // Repoint every row in the group to the chosen client so the
  // standard merge no longer sees a conflict. The repoint runs in
  // its own transaction; mergeDirectConversationGroup below runs in
  // a separate transaction. If the merge fails the repoint is NOT
  // rolled back — that's intentional: the rows now agree on a
  // client, and the next scheduled merge run (or a retried resolve)
  // will collapse them cleanly. Idempotency is covered by the
  // status="no_conflict" branch above.
  await getDb().transaction(async (tx) => {
    await tx
      .update(twilioConversations)
      .set({ clientId: args.targetClientId, updatedAt: new Date() })
      .where(inArray(twilioConversations.id, rows.map((r) => r.id)));
  });

  const refreshed = await getDb()
    .select()
    .from(twilioConversations)
    .where(inArray(twilioConversations.id, rows.map((r) => r.id)));

  const outcome = await mergeDirectConversationGroup({
    conversations: refreshed,
    contactPhoneKey: parsed.contactPhoneKey,
    twilioPhoneKey: parsed.twilioPhoneKey,
    actor,
    forceSurvivorId: args.survivorConversationId,
  });
  if (outcome.status !== "merged") {
    throw new Error(
      `Merge unexpectedly returned status ${outcome.status} after client conflict resolution for ${args.key}`,
    );
  }
  return { status: "merged", entry: outcome.entry };
}

// Inbound webhook idempotency: returns the prior row if MessageSid was
// already persisted (Twilio retry).
export async function findExistingInboundMessageBySid(messageSid: string): Promise<
  | { messageId: string; conversationId: string }
  | undefined
> {
  if (!messageSid) return undefined;
  const [row] = await getDb()
    .select({ id: twilioMessages.id, conversationId: twilioMessages.conversationId })
    .from(twilioMessages)
    .where(eq(twilioMessages.twilioSid, messageSid))
    .limit(1);
  return row ? { messageId: row.id, conversationId: row.conversationId } : undefined;
}

// Reverse of getDirectConversationKey; returns null for malformed input.
export function parseDirectThreadKey(
  key: string,
): { twilioPhoneKey: string; contactPhoneKey: string } | null {
  const match = /^direct:([^:]+):([^:]+)$/.exec(key);
  if (!match) return null;
  return { twilioPhoneKey: match[1], contactPhoneKey: match[2] };
}

/**
 * Re-export the normalization helpers under the dedupe namespace so
 * callers don't have to import from two places.
 */
export { getDirectConversationKey, getPhoneMatchKey };
