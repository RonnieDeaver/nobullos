// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type TwilioConversation, type InsertTwilioConversation, twilioConversations,
  type UpdateTwilioConversation, updateTwilioConversationSchema,
  type TwilioMessage, type InsertTwilioMessage, twilioMessages,
  type UpdateTwilioMessage, updateTwilioMessageSchema,
  type TwilioCall, type InsertTwilioCall, twilioCalls,
  type UpdateTwilioCall, updateTwilioCallSchema,
  type ThreadNote, threadNotes,
  type ThreadAssignment, threadAssignments,
  type ThreadAssignmentNotification, threadAssignmentNotifications,
  type ThreadReadState, threadReadStates,
  clientContacts, clients, users,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { desc, asc, eq, and, sql, ilike, or, gte, lte, gt, lt, ne, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import { normalizeToTen } from "../services/phoneNormalization";
import { buildNormalizedFields } from "../services/conversationDedupe";

export async function createTwilioConversation(data: InsertTwilioConversation): Promise<TwilioConversation> {
  // Task #849: always populate the normalized columns + directThreadKey on
  // insert. Group rows leave directThreadKey null (the helper handles that).
  // Callers that want race-safe direct-thread creation should use
  // `findOrCreateDirectConversation` from `services/conversationDedupe.ts`
  // instead — this storage helper is the low-level primitive.
  const normalized = buildNormalizedFields({
    contactPhone: data.contactPhone,
    twilioPhoneNumber: data.twilioPhoneNumber,
    conversationType: data.conversationType,
  });
  const [conv] = await getDb()
    .insert(twilioConversations)
    .values({ ...data, ...normalized })
    .returning();
  return conv;
}

export async function getTwilioConversation(id: string): Promise<TwilioConversation | undefined> {
  const [conv] = await getDb().select().from(twilioConversations).where(eq(twilioConversations.id, id));
  return conv;
}

/**
 * Direct-thread lookup by phone pair. Task #849 rewrote this to use the
 * canonical `directThreadKey` (last-10-digit normalized) instead of strict
 * equality on raw phone strings, so inbound webhooks no longer miss
 * existing threads stored with raw formats like `(267) 639-8995`.
 *
 * Group conversations are excluded — direct lookup must never return a
 * group row. If multiple direct rows share the same key (a residual of
 * the old bug, until backfill+merge runs), we deterministically pick the
 * oldest. The dedupe service emits a structured warning in that case so
 * the merge script can clean up.
 */
export async function getTwilioConversationByPhone(contactPhone: string, twilioPhoneNumber: string): Promise<TwilioConversation | undefined> {
  const { findDirectConversationByKey, getDirectConversationKey } = await import("../services/conversationDedupe");
  const key = getDirectConversationKey({ contactPhone, twilioPhoneNumber });
  if (key) {
    return findDirectConversationByKey(key);
  }
  // Fall back to strict equality only when normalization produced no key
  // (e.g. fewer than 10 digits) — that path is best-effort.
  const [conv] = await getDb()
    .select()
    .from(twilioConversations)
    .where(
      and(
        eq(twilioConversations.contactPhone, contactPhone),
        eq(twilioConversations.twilioPhoneNumber, twilioPhoneNumber),
        ne(twilioConversations.conversationType, "group"),
      ),
    )
    .limit(1);
  return conv;
}

// Task #4222: runtime-parsed focused edit shape — contact/thread-state fields
// only; clientId/clientContactId re-linking goes through dedicated paths.
export async function updateTwilioConversation(id: string, data: UpdateTwilioConversation): Promise<TwilioConversation | undefined> {
  const parsed = updateTwilioConversationSchema.parse(data);
  const [conv] = await getDb().update(twilioConversations)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(twilioConversations.id, id))
    .returning();
  return conv;
}

export async function listTwilioConversations(filters?: {
  clientId?: string;
  status?: string;
  search?: string;
}): Promise<TwilioConversation[]> {
  const conditions: any[] = [];
  if (filters?.clientId) conditions.push(eq(twilioConversations.clientId, filters.clientId));
  if (filters?.status) conditions.push(eq(twilioConversations.status, filters.status));
  if (filters?.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(twilioConversations.contactName, pattern),
        ilike(twilioConversations.contactPhone, pattern),
        ilike(twilioConversations.lastMessagePreview, pattern),
      )!
    );
  }
  return getDb().select().from(twilioConversations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(twilioConversations.lastMessageAt));
}

export async function markTwilioConversationRead(id: string): Promise<TwilioConversation | undefined> {
  const [conv] = await getDb().update(twilioConversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(eq(twilioConversations.id, id))
    .returning();
  return conv;
}

// Task #1685: derive the set of `twilio_conversations.id` values that
// belong to a given unified thread key. Used by the read-state PATCH to
// (a) validate any client-supplied IDs and (b) discover any IDs the
// client may have missed (e.g. a brand-new SMS conv created server-side
// after the client snapshot was taken). Mirrors the key shapes produced
// by `resolveThreadKey` in `client/src/lib/conversationModel.ts`.
export async function listThreadSmsConversationIds(threadKey: string): Promise<string[]> {
  if (!threadKey) return [];
  const db = getDb();
  const pluck = (rows: { id: string }[]) => rows.map((r) => r.id);
  if (threadKey.startsWith("group:")) {
    const convId = threadKey.slice("group:".length);
    if (!convId) return [];
    const rows = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(eq(twilioConversations.id, convId));
    return pluck(rows);
  }
  if (threadKey.startsWith("contact:")) {
    const contactId = threadKey.slice("contact:".length);
    if (!contactId) return [];
    const rows = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(eq(twilioConversations.clientContactId, contactId));
    return pluck(rows);
  }
  if (threadKey.startsWith("client-phone:")) {
    const rest = threadKey.slice("client-phone:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return [];
    const clientId = rest.slice(0, sep);
    const digits = rest.slice(sep + 1);
    if (!clientId || !digits) return [];
    const rows = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(and(
        eq(twilioConversations.clientId, clientId),
        sql`right(regexp_replace(coalesce(${twilioConversations.contactPhoneNormalized}, ${twilioConversations.contactPhone}), '\\D', '', 'g'), 10) = ${digits}`,
      ));
    return pluck(rows);
  }
  if (threadKey.startsWith("phone:")) {
    const digits = threadKey.slice("phone:".length);
    if (!digits) return [];
    const rows = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(sql`right(regexp_replace(coalesce(${twilioConversations.contactPhoneNormalized}, ${twilioConversations.contactPhone}), '\\D', '', 'g'), 10) = ${digits}`);
    return pluck(rows);
  }
  return [];
}

export async function createTwilioMessage(data: InsertTwilioMessage): Promise<TwilioMessage> {
  // Task #875: explicitly stamp createdAt/updatedAt with a JS Date so the
  // values are millisecond-precision. Postgres' DEFAULT now() is
  // microsecond-precision, but ISO strings round-trip through JSON to
  // the client at millisecond precision; if writes used now() (us) and
  // the client echoed the ms-truncated value back as `updatedSince`,
  // the comparison `updated_at > $watermark` would always be true and
  // the no-op poll would re-return every row forever. Writing JS Dates
  // on every path keeps the precision consistent end-to-end.
  const now = new Date();
  const [msg] = await getDb()
    .insert(twilioMessages)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return msg;
}

export async function getTwilioMessage(id: string): Promise<TwilioMessage | undefined> {
  const [msg] = await getDb().select().from(twilioMessages).where(eq(twilioMessages.id, id));
  return msg;
}

export async function getTwilioMessageByTwilioSid(sid: string): Promise<TwilioMessage | undefined> {
  const [msg] = await getDb().select().from(twilioMessages).where(eq(twilioMessages.twilioSid, sid));
  return msg;
}

export async function listTwilioMessages(
  conversationId: string,
  limit = 100,
  opts?: { afterId?: string; since?: Date; updatedSince?: Date },
): Promise<TwilioMessage[]> {
  // Two distinct fetch modes:
  //  - "new messages since marker" (afterId / since)  → Task #848 Phase 5
  //  - "rows updated since marker" (updatedSince)     → Task #875
  // When both are supplied (the common polling case once the thread is
  // hot), we OR them at the SQL level so the response is the union of
  // (a) freshly inserted rows and (b) rows whose status was mutated by
  // the Twilio delivery-status callback. Without (b), in-place status
  // updates would never reach the client because the row's created_at
  // is unchanged.
  const baseFilter = eq(twilioMessages.conversationId, conversationId);
  const orParts: ReturnType<typeof sql>[] = [];

  if (opts?.afterId) {
    const [marker] = await getDb()
      .select({ createdAt: twilioMessages.createdAt })
      .from(twilioMessages)
      .where(eq(twilioMessages.id, opts.afterId));
    if (marker?.createdAt) {
      // Tuple comparison so two rows sharing the exact same timestamp
      // are still ordered deterministically and never silently skipped.
      orParts.push(
        sql`(${twilioMessages.createdAt}, ${twilioMessages.id}) > (${marker.createdAt}, ${opts.afterId})`,
      );
    }
  } else if (opts?.since) {
    orParts.push(sql`${twilioMessages.createdAt} > ${opts.since}`);
  }

  if (opts?.updatedSince) {
    orParts.push(sql`${twilioMessages.updatedAt} > ${opts.updatedSince}`);
  }

  // No incremental markers → full fetch (initial load or refresh).
  const where =
    orParts.length === 0
      ? baseFilter
      : and(baseFilter, sql`(${sql.join(orParts, sql` OR `)})`);

  return getDb()
    .select()
    .from(twilioMessages)
    .where(where)
    .orderBy(desc(twilioMessages.createdAt))
    .limit(limit);
}

// Task #4222: runtime-parsed focused edit shape — delivery-status surface
// only; body/direction/numbers/claim columns stay protected.
export async function updateTwilioMessage(id: string, data: UpdateTwilioMessage): Promise<TwilioMessage | undefined> {
  const parsed = updateTwilioMessageSchema.parse(data);
  const [msg] = await getDb().update(twilioMessages).set(parsed).where(eq(twilioMessages.id, id)).returning();
  return msg;
}

/**
 * Task #875: Twilio SMS delivery-status webhook handler updates the
 * message row by Twilio MessageSid. Returns the updated row so the
 * caller can log / verify, or undefined if no row matched (e.g. a
 * status callback for a message that was never persisted, which can
 * happen if `messages.create` succeeded but our DB insert failed).
 *
 * `errorCode` / `errorMessage` are passed through verbatim — Twilio
 * sends them only on failure paths (`failed` / `undelivered`), and we
 * always overwrite (including with NULL) so a row that briefly had an
 * error and later succeeds reflects the final state.
 */
export async function updateTwilioMessageStatusBySid(
  twilioSid: string,
  data: {
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    // Task #883: forwarded from the status callback's `MessagingServiceSid`.
    // Only written when the callback supplied a value — undefined means
    // "the callback did not include this field, leave the existing value
    // alone" (so a row that already knows its transport from the insert
    // path is never wiped). Inbound rows + outbound rows that went out
    // through the legacy single-`from` path simply never receive a value
    // here and stay NULL.
    messagingServiceSid?: string;
  },
): Promise<TwilioMessage | undefined> {
  // Bump `updatedAt` explicitly so the thread view's "updated since"
  // poll sees the row even though `created_at` is unchanged. Postgres
  // CURRENT_TIMESTAMP is the same time-source the column default uses.
  const updateSet: Record<string, unknown> = {
    status: data.status,
    errorCode: data.errorCode ?? null,
    errorMessage: data.errorMessage ?? null,
    updatedAt: new Date(),
  };
  if (data.messagingServiceSid && data.messagingServiceSid.length > 0) {
    updateSet.messagingServiceSid = data.messagingServiceSid;
  }
  const [msg] = await getDb()
    .update(twilioMessages)
    .set(updateSet)
    .where(eq(twilioMessages.twilioSid, twilioSid))
    .returning();
  return msg;
}

export async function linkMessageRawCommunication(twilioSid: string, rawCommunicationRecordId: string): Promise<void> {
  await getDb()
    .update(twilioMessages)
    .set({ rawCommunicationRecordId })
    .where(eq(twilioMessages.twilioSid, twilioSid));
}

// ---------------------------------------------------------------------------
// Task #3896 (audit B-003): outbound dispatch claims.
//
// The row id of `twilio_messages` / `twilio_calls` is the durable identity of
// one logical outbound operation. `claimOutbound*Operation` runs BEFORE the
// Twilio REST create and guarantees (via single-statement conditional writes)
// that at most one invocation owns the dispatch at a time:
//
//   - no `operationId` supplied → mint a fresh row (fresh logical operation;
//     matches the pre-#3896 contract where every call is a new send).
//   - `operationId` supplied and the row already carries a Twilio SID →
//     `already_sent` (stored-SID short-circuit; the caller must NOT create).
//   - row exists, no SID, claim fresh → `in_progress` (another invocation is
//     mid-dispatch; the caller must NOT create).
//   - row exists, no SID, claim NULL or stale → atomically re-claim (crash /
//     definitive-failure recovery; legacy rows whose claim columns are NULL
//     are claimable the same way).
//
// `finalize*` / `fail*` are ownership-checked (the claim token must still
// match) so an invocation that lost its claim to a stale-claim recovery can
// never write a SID or clobber the winner's state. Both clear the claim; a
// failed row (no SID, no claim) is deliberately re-claimable so a HUMAN retry
// of the same operation id can re-dispatch after a definitive failure.
// Nothing in the system re-dispatches automatically.
// ---------------------------------------------------------------------------

export type OutboundClaimResult<Row> =
  | { kind: "claimed"; row: Row; claimToken: string; mode: "minted" | "inserted" | "reclaimed" }
  | { kind: "already_sent"; row: Row }
  | { kind: "in_progress"; row: Row };

export async function claimOutboundSmsOperation(params: {
  operationId?: string;
  staleClaimMs: number;
  data: {
    conversationId: string;
    fromNumber: string;
    toNumber: string;
    body: string;
    messagingServiceSid?: string | null;
    sentByUserId?: string | null;
  };
}): Promise<OutboundClaimResult<TwilioMessage>> {
  return withDbAttribution("twilioStorage:claimOutboundSmsOperation", async () => {
    const claimToken = randomUUID();
    const now = new Date();
    const values = {
      conversationId: params.data.conversationId,
      twilioSid: null,
      direction: "outbound",
      fromNumber: params.data.fromNumber,
      toNumber: params.data.toNumber,
      body: params.data.body,
      status: "queued",
      messagingServiceSid: params.data.messagingServiceSid ?? null,
      sentByUserId: params.data.sentByUserId ?? null,
      dispatchClaimToken: claimToken,
      dispatchClaimedAt: now,
      // Task #875 convention: JS-Date stamps for ms-precision polling.
      createdAt: now,
      updatedAt: now,
    };
    if (!params.operationId) {
      const [row] = await getDb().insert(twilioMessages).values(values).returning();
      return { kind: "claimed" as const, row, claimToken, mode: "minted" as const };
    }
    const inserted = await getDb()
      .insert(twilioMessages)
      .values({ ...values, id: params.operationId })
      .onConflictDoNothing({ target: twilioMessages.id })
      .returning();
    if (inserted.length > 0) {
      return { kind: "claimed" as const, row: inserted[0], claimToken, mode: "inserted" as const };
    }
    // The row already exists — classify it, re-claiming atomically when the
    // previous claim is cleared or stale. Two passes: between a failed reclaim
    // and the SELECT the row can settle (SID arrives), which the second pass
    // then reports as `already_sent`.
    for (let pass = 0; pass < 2; pass++) {
      const staleBefore = new Date(Date.now() - params.staleClaimMs);
      const reclaimed = await getDb()
        .update(twilioMessages)
        .set({
          // The re-claimed row is re-dispatched with the CALLER's current
          // content so the row always reflects what actually went out.
          fromNumber: params.data.fromNumber,
          toNumber: params.data.toNumber,
          body: params.data.body,
          messagingServiceSid: params.data.messagingServiceSid ?? null,
          sentByUserId: params.data.sentByUserId ?? null,
          dispatchClaimToken: claimToken,
          dispatchClaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(twilioMessages.id, params.operationId),
          isNull(twilioMessages.twilioSid),
          or(
            isNull(twilioMessages.dispatchClaimedAt),
            lt(twilioMessages.dispatchClaimedAt, staleBefore),
          ),
        ))
        .returning();
      if (reclaimed.length > 0) {
        return { kind: "claimed" as const, row: reclaimed[0], claimToken, mode: "reclaimed" as const };
      }
      const row = await getTwilioMessage(params.operationId);
      if (!row) continue;
      if (row.twilioSid) return { kind: "already_sent" as const, row };
      return { kind: "in_progress" as const, row };
    }
    throw new Error(
      `[Twilio][dispatch] operation row ${params.operationId} disappeared during claim — refusing to dispatch`,
    );
  });
}

/**
 * Ownership-checked failure: records an explicit, investigable failure state
 * on the operation row and releases the claim. No-op (returns undefined) when
 * the caller no longer owns the row or a SID has already been persisted —
 * a lost owner must never clobber the winner's state.
 */
export async function failClaimedSmsOperation(
  id: string,
  claimToken: string,
  fields: { errorMessage: string; errorCode?: string | null },
): Promise<TwilioMessage | undefined> {
  return withDbAttribution("twilioStorage:failClaimedSmsOperation", async () => {
    const [row] = await getDb()
      .update(twilioMessages)
      .set({
        status: "failed",
        errorMessage: fields.errorMessage,
        errorCode: fields.errorCode ?? null,
        dispatchClaimToken: null,
        dispatchClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(twilioMessages.id, id),
        eq(twilioMessages.dispatchClaimToken, claimToken),
        isNull(twilioMessages.twilioSid),
      ))
      .returning();
    return row;
  });
}

/**
 * Ownership-checked success: persists the Twilio SID + initial status and
 * releases the claim. Returns undefined when the caller lost ownership
 * (stale-claim recovery re-claimed the row mid-flight) — the caller must NOT
 * treat the dispatch as recorded and must NOT write the SID any other way.
 * Clears any error fields left over from a previous failed dispatch of the
 * same operation.
 */
export async function finalizeClaimedSmsOperation(
  id: string,
  claimToken: string,
  fields: { twilioSid: string; status: string },
): Promise<TwilioMessage | undefined> {
  return withDbAttribution("twilioStorage:finalizeClaimedSmsOperation", async () => {
    const [row] = await getDb()
      .update(twilioMessages)
      .set({
        twilioSid: fields.twilioSid,
        status: fields.status,
        errorCode: null,
        errorMessage: null,
        dispatchClaimToken: null,
        dispatchClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(twilioMessages.id, id),
        eq(twilioMessages.dispatchClaimToken, claimToken),
        isNull(twilioMessages.twilioSid),
      ))
      .returning();
    return row;
  });
}

export async function claimOutboundCallOperation(params: {
  operationId?: string;
  staleClaimMs: number;
  data: {
    clientId?: string | null;
    clientContactId?: string | null;
    fromNumber: string;
    toNumber: string;
    initiatedByUserId?: string | null;
  };
}): Promise<OutboundClaimResult<TwilioCall>> {
  return withDbAttribution("twilioStorage:claimOutboundCallOperation", async () => {
    const claimToken = randomUUID();
    const values = {
      clientId: params.data.clientId ?? null,
      clientContactId: params.data.clientContactId ?? null,
      twilioSid: null,
      direction: "outbound",
      fromNumber: params.data.fromNumber,
      toNumber: params.data.toNumber,
      status: "initiated",
      initiatedByUserId: params.data.initiatedByUserId ?? null,
      dispatchClaimToken: claimToken,
      dispatchClaimedAt: new Date(),
    };
    if (!params.operationId) {
      const [row] = await getDb().insert(twilioCalls).values(values).returning();
      return { kind: "claimed" as const, row, claimToken, mode: "minted" as const };
    }
    const inserted = await getDb()
      .insert(twilioCalls)
      .values({ ...values, id: params.operationId })
      .onConflictDoNothing({ target: twilioCalls.id })
      .returning();
    if (inserted.length > 0) {
      return { kind: "claimed" as const, row: inserted[0], claimToken, mode: "inserted" as const };
    }
    for (let pass = 0; pass < 2; pass++) {
      const staleBefore = new Date(Date.now() - params.staleClaimMs);
      const reclaimed = await getDb()
        .update(twilioCalls)
        .set({
          clientId: params.data.clientId ?? null,
          clientContactId: params.data.clientContactId ?? null,
          fromNumber: params.data.fromNumber,
          toNumber: params.data.toNumber,
          initiatedByUserId: params.data.initiatedByUserId ?? null,
          dispatchClaimToken: claimToken,
          dispatchClaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(twilioCalls.id, params.operationId),
          isNull(twilioCalls.twilioSid),
          or(
            isNull(twilioCalls.dispatchClaimedAt),
            lt(twilioCalls.dispatchClaimedAt, staleBefore),
          ),
        ))
        .returning();
      if (reclaimed.length > 0) {
        return { kind: "claimed" as const, row: reclaimed[0], claimToken, mode: "reclaimed" as const };
      }
      const row = await getTwilioCall(params.operationId);
      if (!row) continue;
      if (row.twilioSid) return { kind: "already_sent" as const, row };
      return { kind: "in_progress" as const, row };
    }
    throw new Error(
      `[Twilio][dispatch] operation row ${params.operationId} disappeared during claim — refusing to dispatch`,
    );
  });
}

/**
 * Ownership-checked failure for calls. `twilio_calls` has no error columns —
 * the failure classification goes to the dispatch log; the row records the
 * terminal `failed` status and releases the claim (re-claimable for a human
 * retry, exactly like SMS).
 */
export async function failClaimedCallOperation(
  id: string,
  claimToken: string,
): Promise<TwilioCall | undefined> {
  return withDbAttribution("twilioStorage:failClaimedCallOperation", async () => {
    const [row] = await getDb()
      .update(twilioCalls)
      .set({
        status: "failed",
        dispatchClaimToken: null,
        dispatchClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(twilioCalls.id, id),
        eq(twilioCalls.dispatchClaimToken, claimToken),
        isNull(twilioCalls.twilioSid),
      ))
      .returning();
    return row;
  });
}

export async function finalizeClaimedCallOperation(
  id: string,
  claimToken: string,
  fields: { twilioSid: string; status: string },
): Promise<TwilioCall | undefined> {
  return withDbAttribution("twilioStorage:finalizeClaimedCallOperation", async () => {
    const [row] = await getDb()
      .update(twilioCalls)
      .set({
        twilioSid: fields.twilioSid,
        status: fields.status,
        dispatchClaimToken: null,
        dispatchClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(twilioCalls.id, id),
        eq(twilioCalls.dispatchClaimToken, claimToken),
        isNull(twilioCalls.twilioSid),
      ))
      .returning();
    return row;
  });
}

export async function createTwilioCall(data: InsertTwilioCall): Promise<TwilioCall> {
  const [call] = await getDb().insert(twilioCalls).values(data).returning();
  return call;
}

export async function getTwilioCall(id: string): Promise<TwilioCall | undefined> {
  const [call] = await getDb().select().from(twilioCalls).where(eq(twilioCalls.id, id));
  return call;
}

export async function getTwilioCallByTwilioSid(sid: string): Promise<TwilioCall | undefined> {
  const [call] = await getDb().select().from(twilioCalls).where(eq(twilioCalls.twilioSid, sid));
  return call;
}

// Task #4222: runtime-parsed focused edit shape — lifecycle/recording/
// voicemail fields only; identity, dispatch-claim and archive-pipeline
// state-machine columns stay protected.
export async function updateTwilioCall(id: string, data: UpdateTwilioCall): Promise<TwilioCall | undefined> {
  const parsed = updateTwilioCallSchema.parse(data);
  const [call] = await getDb().update(twilioCalls)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(twilioCalls.id, id))
    .returning();
  return call;
}

export async function listTwilioCalls(filters?: { clientId?: string; limit?: number }): Promise<TwilioCall[]> {
  const conditions: any[] = [];
  if (filters?.clientId) conditions.push(eq(twilioCalls.clientId, filters.clientId));
  return getDb().select().from(twilioCalls)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(twilioCalls.createdAt))
    .limit(filters?.limit || 100);
}

export type CallWithDetails = TwilioCall & {
  clientName?: string;
  initiatedByUserName?: string;
  routedToUserName?: string;
  accountManagerUserId?: string;
  accountManagerName?: string;
};

const sortColumnMap: Record<string, typeof twilioCalls.createdAt | typeof twilioCalls.duration | typeof twilioCalls.status | typeof twilioCalls.direction> = {
  createdAt: twilioCalls.createdAt,
  duration: twilioCalls.duration,
  status: twilioCalls.status,
  direction: twilioCalls.direction,
};

export async function listTwilioCallsWithDetails(filters?: {
  clientId?: string;
  direction?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: string;
  limit?: number;
}): Promise<CallWithDetails[]> {
  const conditions: any[] = [];
  if (filters?.clientId) conditions.push(eq(twilioCalls.clientId, filters.clientId));
  if (filters?.direction) conditions.push(eq(twilioCalls.direction, filters.direction));
  if (filters?.status) {
    if (filters.status === "missed") {
      conditions.push(or(
        eq(twilioCalls.status, "no-answer"),
        eq(twilioCalls.status, "busy"),
        eq(twilioCalls.status, "failed"),
        eq(twilioCalls.status, "canceled"),
      )!);
    } else if (filters.status === "completed") {
      conditions.push(eq(twilioCalls.status, "completed"));
    } else {
      conditions.push(eq(twilioCalls.status, filters.status));
    }
  }
  if (filters?.dateFrom) conditions.push(gte(twilioCalls.createdAt, new Date(filters.dateFrom)));
  if (filters?.dateTo) conditions.push(lte(twilioCalls.createdAt, new Date(filters.dateTo)));

  const rows = await getDb().select({
    call: twilioCalls,
    clientName: clients.firmName,
    accountManagerUserId: clients.ownerId,
  })
    .from(twilioCalls)
    .leftJoin(clients, eq(twilioCalls.clientId, clients.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy((() => {
      const col = (filters?.sortBy && sortColumnMap[filters.sortBy]) || sortColumnMap.createdAt;
      return filters?.sortDir === "asc" ? asc(col) : desc(col);
    })())
    .limit(filters?.limit || 200);

  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.call.initiatedByUserId) userIds.add(row.call.initiatedByUserId);
    if (row.call.routedToUserId) userIds.add(row.call.routedToUserId);
    if (row.accountManagerUserId) userIds.add(row.accountManagerUserId);
  }

  const userMap = new Map<string, string>();
  if (userIds.size > 0) {
    const allUsers = await getDb().select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    }).from(users).where(
      or(...Array.from(userIds).map(id => eq(users.id, id)))!
    );
    for (const u of allUsers) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "Unknown";
      userMap.set(u.id, name);
    }
  }

  return rows.map(r => ({
    ...r.call,
    clientName: r.clientName || undefined,
    initiatedByUserName: r.call.initiatedByUserId ? userMap.get(r.call.initiatedByUserId) : undefined,
    routedToUserName: r.call.routedToUserId ? userMap.get(r.call.routedToUserId) : undefined,
    accountManagerUserId: r.accountManagerUserId || undefined,
    accountManagerName: r.accountManagerUserId ? userMap.get(r.accountManagerUserId) : undefined,
  }));
}

export async function listTwilioConversationsWithClients(filters?: {
  clientId?: string;
  status?: string;
  search?: string;
}): Promise<Array<TwilioConversation & { clientName?: string }>> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.clientId) conditions.push(eq(twilioConversations.clientId, filters.clientId) as ReturnType<typeof eq>);
  if (filters?.status) conditions.push(eq(twilioConversations.status, filters.status) as ReturnType<typeof eq>);
  if (filters?.search) {
    const pattern = `%${filters.search}%`;
    // Task #848 Phase 8: dropped `participants::text ILIKE` (full-row JSON
    // text cast on every row). Search now relies on indexed/text columns
    // and the joined client firm name. Phone search digits are matched
    // against contactPhone with the digits-only form so "555-1234",
    // "5551234", and "+15551234" all resolve.
    const baseSearch = or(
      ilike(twilioConversations.contactName, pattern),
      ilike(twilioConversations.contactPhone, pattern),
      ilike(twilioConversations.lastMessagePreview, pattern),
      ilike(twilioConversations.displayName, pattern),
      ilike(clients.firmName, pattern),
    );
    const digits = filters.search.replace(/\D/g, "");
    const conds: any[] = [baseSearch];
    if (digits.length >= 4) {
      conds.push(ilike(twilioConversations.contactPhone, `%${digits}%`));
    }
    const searchCondition = or(...conds);
    if (searchCondition) conditions.push(searchCondition as ReturnType<typeof eq>);
  }
  const rows = await getDb().select({
    conv: twilioConversations,
    clientName: clients.firmName,
  })
    .from(twilioConversations)
    .leftJoin(clients, eq(twilioConversations.clientId, clients.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(twilioConversations.lastMessageAt));

  return rows.map(r => ({
    ...r.conv,
    clientName: r.clientName || undefined,
  }));
}

/**
 * Task #951: atomically attach a client to a client-less conversation.
 *
 * Returns:
 *   - { ok: true, conversation } on a successful link or no-op (already
 *     linked to the same client).
 *   - { ok: false, reason: "conflict", conversation } if the row is
 *     already linked to a *different* client (concurrent operator) — the
 *     caller surfaces this as a 409 with the current state so the UI can
 *     refresh.
 *   - { ok: false, reason: "not_found" } if the conversation id doesn't
 *     exist.
 *
 * Uses a single conditional UPDATE (`WHERE client_id IS NULL`) so two
 * operators racing each other can never both succeed — Postgres returns
 * an empty result set to whichever transaction comes second, and we then
 * re-read the row to decide between "same client → ok" and "different
 * client → conflict".
 */
export async function attachClientToConversation(
  id: string,
  data: { clientId: string; clientContactId?: string | null },
): Promise<
  | { ok: true; conversation: TwilioConversation }
  | { ok: false; reason: "conflict"; conversation: TwilioConversation }
  | { ok: false; reason: "not_found" }
> {
  const [updated] = await getDb()
    .update(twilioConversations)
    .set({
      clientId: data.clientId,
      clientContactId: data.clientContactId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(twilioConversations.id, id),
        sql`${twilioConversations.clientId} IS NULL`,
      ),
    )
    .returning();

  if (updated) return { ok: true, conversation: updated };

  const [current] = await getDb()
    .select()
    .from(twilioConversations)
    .where(eq(twilioConversations.id, id));
  if (!current) return { ok: false, reason: "not_found" };

  if (current.clientId === data.clientId) {
    return { ok: true, conversation: current };
  }
  return { ok: false, reason: "conflict", conversation: current };
}

/**
 * Task #968: reassign a conversation to a different client, or unlink it
 * entirely (`clientId: null`). Race-safe via the `expectedClientId`
 * guard — the conditional UPDATE only matches when the row's current
 * `client_id` still equals what the operator was looking at when they
 * opened the menu, so a concurrent reassign by another user surfaces as
 * a 409 instead of silently overwriting their work.
 *
 * Use `IS NOT DISTINCT FROM` so a `null` expected value matches a `null`
 * column value (plain `=` would be `null = null → null → false`).
 */
export async function reassignConversationClient(
  id: string,
  data: {
    clientId: string | null;
    clientContactId: string | null;
    expectedClientId: string | null;
  },
): Promise<
  | { ok: true; conversation: TwilioConversation }
  | { ok: false; reason: "conflict"; conversation: TwilioConversation }
  | { ok: false; reason: "not_found" }
> {
  const [updated] = await getDb()
    .update(twilioConversations)
    .set({
      clientId: data.clientId,
      clientContactId: data.clientContactId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(twilioConversations.id, id),
        sql`${twilioConversations.clientId} IS NOT DISTINCT FROM ${data.expectedClientId}`,
      ),
    )
    .returning();

  if (updated) return { ok: true, conversation: updated };

  const [current] = await getDb()
    .select()
    .from(twilioConversations)
    .where(eq(twilioConversations.id, id));
  if (!current) return { ok: false, reason: "not_found" };

  if (current.clientId === data.clientId) {
    return { ok: true, conversation: current };
  }
  return { ok: false, reason: "conflict", conversation: current };
}

export async function updateConversationDisplayName(id: string, displayName: string | null): Promise<TwilioConversation | undefined> {
  const [conv] = await getDb().update(twilioConversations)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(twilioConversations.id, id))
    .returning();
  return conv;
}

export async function findConversationByParticipantPhone(phone: string, twilioNumber: string): Promise<TwilioConversation | undefined> {
  const normalizedPhone = phone.replace(/\D/g, "");
  const shortPhone = normalizedPhone.slice(-10);
  const phoneVariants = [
    JSON.stringify([{ phone: `+1${shortPhone}` }]),
    JSON.stringify([{ phone: shortPhone }]),
    JSON.stringify([{ phone: normalizedPhone }]),
    JSON.stringify([{ phone }]),
  ];
  const conditions = [
    ne(twilioConversations.conversationType, "group"),
    sql`(${twilioConversations.participants}::jsonb @> ${phoneVariants[0]}::jsonb
      OR ${twilioConversations.participants}::jsonb @> ${phoneVariants[1]}::jsonb
      OR ${twilioConversations.participants}::jsonb @> ${phoneVariants[2]}::jsonb
      OR ${twilioConversations.participants}::jsonb @> ${phoneVariants[3]}::jsonb)`,
  ];
  if (twilioNumber) {
    conditions.push(eq(twilioConversations.twilioPhoneNumber, twilioNumber));
  }
  const rows = await getDb().select().from(twilioConversations)
    .where(and(...conditions))
    .orderBy(desc(twilioConversations.lastMessageAt))
    .limit(1);
  return rows[0] || undefined;
}

/**
 * Task #950: progressive "did you mean this client?" lookup for the New
 * Message phone input. Returns up to `limit` client contact matches keyed
 * off `clientContacts.phonesNormalized` (last-10-digit canonical form).
 *
 * - Fewer than 4 digits → no lookup (too noisy / too many matches).
 * - 10+ digits → array-contains against the GIN index on
 *   `phones_normalized` (matches `findClientByPhone`'s fast path).
 * - 4–9 digits → suffix-style match via `unnest` + `LIKE %digits%`. Not
 *   indexed, but the `LIMIT` keeps the worst case bounded.
 */
export async function searchClientContactsByPhone(
  phone: string,
  limit = 5,
): Promise<Array<{ clientId: string; firmName: string; contactId: string; contactName: string; phone: string }>> {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 4) return [];
  const cap = Math.max(1, Math.min(limit, 10));

  const matchExpr = digits.length >= 10
    ? sql`${clientContacts.phonesNormalized} @> ARRAY[${digits.slice(-10)}]::text[]`
    : sql`EXISTS (SELECT 1 FROM unnest(${clientContacts.phonesNormalized}) AS p WHERE p LIKE ${'%' + digits + '%'})`;

  const rows = await getDb()
    .select({
      contactId: clientContacts.id,
      clientId: clientContacts.clientId,
      contactName: clientContacts.name,
      phones: clientContacts.phones,
      firmName: clients.firmName,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(matchExpr)
    .limit(cap);

  // Pick the specific phone variant (from the original `phones` array) that
  // best matches what the user typed, so the suggestion shows the same
  // formatting the contact was saved with.
  const out: Array<{ clientId: string; firmName: string; contactId: string; contactName: string; phone: string }> = [];
  for (const r of rows) {
    const phones = (r.phones || []).filter((p): p is string => typeof p === "string" && p.length > 0);
    let best = phones[0] || "";
    for (const p of phones) {
      const pd = p.replace(/\D/g, "");
      if (digits.length >= 10) {
        if (pd.endsWith(digits.slice(-10))) { best = p; break; }
      } else if (pd.includes(digits)) {
        best = p;
        break;
      }
    }
    if (!best) continue;
    out.push({
      clientId: r.clientId,
      firmName: r.firmName,
      contactId: r.contactId,
      contactName: r.contactName,
      phone: best,
    });
  }
  return out;
}

/**
 * Task #969: aggregated client suggestions for the Link-to-client picker.
 *
 * Surfaces the most likely client(s) for an unmatched conversation so an
 * admin doesn't have to scroll/search the full firm list when there's
 * already a strong signal. Three signal sources, all keyed off the
 * inbound contact phone (last-10-digit canonical form):
 *
 *  1. Saved contact match — `client_contacts.phones_normalized` already
 *     contains the number. This is the strongest signal (+100) and
 *     mirrors what `findClientByPhone` would auto-match on its own.
 *  2. Prior matched calls — count of `twilio_calls` rows with the same
 *     normalized last-10 (either side of the call) AND a non-null
 *     `client_id`. Each prior call adds to the score (+10 each, capped).
 *  3. Prior matched conversations — count of `twilio_conversations`
 *     where `contact_phone_normalized` matches AND `client_id` is set.
 *     Each prior thread adds to the score (+15 each, capped).
 *
 * Suggestions are merged per-client (a single firm can hit multiple
 * signals) and returned sorted by score desc, capped at `limit`.
 */
export async function getClientSuggestionsForPhone(
  phone: string,
  limit = 5,
): Promise<Array<{ clientId: string; firmName: string; score: number; reasons: string[] }>> {
  const normalized = normalizeToTen(phone);
  if (!normalized) return [];
  const cap = Math.max(1, Math.min(limit, 10));

  type Bucket = { firmName: string; score: number; reasons: string[] };
  const byClient = new Map<string, Bucket>();
  const upsert = (clientId: string, firmName: string, score: number, reason: string) => {
    const cur = byClient.get(clientId);
    if (cur) {
      cur.score += score;
      cur.reasons.push(reason);
      if (firmName && !cur.firmName) cur.firmName = firmName;
    } else {
      byClient.set(clientId, { firmName: firmName || "Unknown", score, reasons: [reason] });
    }
  };

  // 1. Saved contact match (clientContacts.phonesNormalized GIN).
  const contactRows = await getDb()
    .select({
      clientId: clientContacts.clientId,
      contactName: clientContacts.name,
      firmName: clients.firmName,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(sql`${clientContacts.phonesNormalized} @> ARRAY[${normalized}]::text[]`)
    .limit(10);
  for (const r of contactRows) {
    upsert(r.clientId, r.firmName, 100, `Saved contact: ${r.contactName}`);
  }

  // 2. Prior matched calls — both inbound (fromNumber) and outbound (toNumber).
  // Use `right(regexp_replace(...))` to compare the last-10 digits regardless
  // of the stored format (E.164, raw, formatted).
  const callRows = await getDb().execute<{ client_id: string; firm_name: string; n: number }>(
    sql`
      SELECT c.client_id, cl.firm_name, COUNT(*)::int AS n
      FROM ${twilioCalls} c
      INNER JOIN ${clients} cl ON cl.id = c.client_id
      WHERE c.client_id IS NOT NULL
        AND (
          right(regexp_replace(c.from_number, '\\D', '', 'g'), 10) = ${normalized}
          OR right(regexp_replace(c.to_number, '\\D', '', 'g'), 10) = ${normalized}
        )
      GROUP BY c.client_id, cl.firm_name
      ORDER BY n DESC
      LIMIT 10
    `,
  );
  for (const r of callRows.rows) {
    const n = Number(r.n) || 0;
    if (n <= 0) continue;
    const score = Math.min(50, n * 10);
    const label = n === 1 ? "1 prior call matched to this firm" : `${n} prior calls matched to this firm`;
    upsert(r.client_id, r.firm_name, score, label);
  }

  // 3. Prior matched conversations — uses the indexed normalized column.
  const convRows = await getDb()
    .select({
      clientId: twilioConversations.clientId,
      firmName: clients.firmName,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(twilioConversations)
    .innerJoin(clients, eq(clients.id, twilioConversations.clientId))
    .where(
      and(
        sql`${twilioConversations.clientId} IS NOT NULL`,
        eq(twilioConversations.contactPhoneNormalized, normalized),
      ),
    )
    .groupBy(twilioConversations.clientId, clients.firmName)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(10);
  for (const r of convRows) {
    const n = Number(r.n) || 0;
    if (n <= 0 || !r.clientId) continue;
    const score = Math.min(60, n * 15);
    const label = n === 1 ? "1 prior conversation matched to this firm" : `${n} prior conversations matched to this firm`;
    upsert(r.clientId, r.firmName, score, label);
  }

  return Array.from(byClient.entries())
    .map(([clientId, b]) => ({ clientId, firmName: b.firmName, score: b.score, reasons: b.reasons }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

export async function findClientByPhone(phone: string): Promise<{ clientId: string; contactId: string; contactName: string } | null> {
  // Task #848 Phase 7: indexed lookup against client_contacts.phones_normalized
  // (GIN). The previous implementation scanned every contact in JS.
  const normalized = normalizeToTen(phone);
  if (!normalized) return null;
  const [contact] = await getDb()
    .select({
      id: clientContacts.id,
      clientId: clientContacts.clientId,
      name: clientContacts.name,
    })
    .from(clientContacts)
    .where(sql`${clientContacts.phonesNormalized} @> ARRAY[${normalized}]::text[]`)
    .limit(1);
  if (!contact) return null;
  return {
    clientId: contact.clientId,
    contactId: contact.id,
    contactName: contact.name,
  };
}

/**
 * Task #855: deterministic per-client variant of `findClientByPhone`.
 *
 * The global helper picks the first matching contact across all clients
 * (LIMIT 1 against the GIN index). When the caller already knows which
 * client they care about — e.g. the conversation-link auto-fill, where
 * the operator just chose a specific client — we want a contact that
 * actually belongs to *that* client even if other firms happen to have
 * the same phone in their roster. Filters on `client_id` first (also
 * indexed), then array-contains on `phones_normalized`.
 */
export async function findClientContactByPhoneForClient(
  clientId: string,
  phone: string,
): Promise<{ contactId: string; contactName: string } | null> {
  const normalized = normalizeToTen(phone);
  if (!normalized || !clientId) return null;
  const [contact] = await getDb()
    .select({
      id: clientContacts.id,
      name: clientContacts.name,
    })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.clientId, clientId),
        sql`${clientContacts.phonesNormalized} @> ARRAY[${normalized}]::text[]`,
      ),
    )
    .limit(1);
  if (!contact) return null;
  return { contactId: contact.id, contactName: contact.name };
}

// ============================================================================
// Task #850: Thread notes + assignments
// Keyed by the unified thread key the client builds in
// `client/src/lib/conversationModel.ts#resolveThreadKey`.
// ============================================================================

export type ThreadNoteWithAuthor = ThreadNote & {
  createdByName: string | null;
};

export async function listThreadNotes(threadKey: string): Promise<ThreadNoteWithAuthor[]> {
  const rows = await getDb()
    .select({
      note: threadNotes,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(threadNotes)
    .leftJoin(users, eq(users.id, threadNotes.createdByUserId))
    .where(eq(threadNotes.threadKey, threadKey))
    .orderBy(asc(threadNotes.createdAt));
  return rows.map((r) => ({
    ...r.note,
    createdByName:
      [r.firstName, r.lastName].filter(Boolean).join(" ") ||
      r.email ||
      null,
  }));
}

export async function listThreadNotesForKeys(keys: string[]): Promise<ThreadNoteWithAuthor[]> {
  if (keys.length === 0) return [];
  const rows = await getDb()
    .select({
      note: threadNotes,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(threadNotes)
    .leftJoin(users, eq(users.id, threadNotes.createdByUserId))
    .where(inArray(threadNotes.threadKey, keys))
    .orderBy(asc(threadNotes.createdAt));
  return rows.map((r) => ({
    ...r.note,
    createdByName:
      [r.firstName, r.lastName].filter(Boolean).join(" ") ||
      r.email ||
      null,
  }));
}

// Task #1700 — Used by the Conversation Hub bulk fetch to paint note
// counts across every thread in a single round-trip. Mirrors the
// assignments side (`listThreadAssignments()`), which also returns
// every row. The `thread_notes` table is small (operator-authored
// scratch notes), so a single unfiltered scan is fine here.
export async function listAllThreadNotes(): Promise<ThreadNoteWithAuthor[]> {
  const rows = await getDb()
    .select({
      note: threadNotes,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(threadNotes)
    .leftJoin(users, eq(users.id, threadNotes.createdByUserId))
    .orderBy(asc(threadNotes.createdAt));
  return rows.map((r) => ({
    ...r.note,
    createdByName:
      [r.firstName, r.lastName].filter(Boolean).join(" ") ||
      r.email ||
      null,
  }));
}

export async function createThreadNote(data: {
  threadKey: string;
  body: string;
  createdByUserId: string;
}): Promise<ThreadNoteWithAuthor> {
  const [row] = await getDb()
    .insert(threadNotes)
    .values({
      threadKey: data.threadKey,
      body: data.body,
      createdByUserId: data.createdByUserId,
    })
    .returning();
  const [author] = await getDb()
    .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, data.createdByUserId));
  return {
    ...row,
    createdByName:
      [author?.firstName, author?.lastName].filter(Boolean).join(" ") ||
      author?.email ||
      null,
  };
}

/**
 * Only the note's author can delete it. Returns true iff a row was removed.
 */
export async function deleteThreadNote(id: string, requestingUserId: string): Promise<boolean> {
  const result = await getDb()
    .delete(threadNotes)
    .where(and(eq(threadNotes.id, id), eq(threadNotes.createdByUserId, requestingUserId)))
    .returning({ id: threadNotes.id });
  return result.length > 0;
}

export async function getThreadAssignment(threadKey: string): Promise<ThreadAssignment | undefined> {
  const [row] = await getDb()
    .select()
    .from(threadAssignments)
    .where(eq(threadAssignments.threadKey, threadKey));
  return row;
}

export async function listThreadAssignments(): Promise<ThreadAssignment[]> {
  return getDb().select().from(threadAssignments);
}

export async function upsertThreadAssignment(data: {
  threadKey: string;
  assignedToUserId?: string | null;
  status?: "open" | "needs_follow_up" | "resolved";
  updatedByUserId: string;
}): Promise<ThreadAssignment> {
  const now = new Date();
  // Insert-or-update, but only overwrite the columns the caller actually
  // sent so a status-only PATCH doesn't blow away an existing assignee
  // (and vice versa).
  const setClause: Record<string, unknown> = {
    updatedByUserId: data.updatedByUserId,
    updatedAt: now,
  };
  if (data.assignedToUserId !== undefined) setClause.assignedToUserId = data.assignedToUserId;
  if (data.status !== undefined) setClause.status = data.status;

  // Task #1288: read the prior assignee BEFORE the upsert so we can
  // decide whether to enqueue a notification. We only notify when the
  // assignee transitions to a NEW (non-null) user that isn't the actor —
  // re-assigning to the same user is a no-op, and self-assignment never
  // pings yourself.
  const prior = await getThreadAssignment(data.threadKey);

  const [row] = await getDb()
    .insert(threadAssignments)
    .values({
      threadKey: data.threadKey,
      assignedToUserId: data.assignedToUserId ?? null,
      status: data.status ?? "open",
      updatedByUserId: data.updatedByUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: threadAssignments.threadKey,
      set: setClause,
    })
    .returning();

  if (
    data.assignedToUserId !== undefined &&
    data.assignedToUserId !== null &&
    data.assignedToUserId !== (prior?.assignedToUserId ?? null) &&
    data.assignedToUserId !== data.updatedByUserId
  ) {
    try {
      await getDb().insert(threadAssignmentNotifications).values({
        threadKey: data.threadKey,
        userId: data.assignedToUserId,
        assignedByUserId: data.updatedByUserId,
      });
    } catch (err: any) {
      // Don't fail the assignment write if the notification insert
      // fails (e.g. user row was deleted between read and write).
      console.error("[Twilio] Failed to enqueue assignment notification:", err?.message ?? err);
    }
  }

  return row;
}

// Task #1288 — Conversation Hub assignment notifications.

export async function listUnreadAssignmentNotifications(
  userId: string,
): Promise<ThreadAssignmentNotification[]> {
  return getDb()
    .select()
    .from(threadAssignmentNotifications)
    .where(
      and(
        eq(threadAssignmentNotifications.userId, userId),
        isNull(threadAssignmentNotifications.readAt),
      ),
    )
    .orderBy(desc(threadAssignmentNotifications.createdAt));
}

// ============================================================================
// Task #1685 — manual read/unread toggle for Conversation Hub threads.
// See `thread_read_states` in shared/models/communications.ts for the
// global-vs-per-user rationale. The flag is upserted on every toggle so
// the row only exists for threads an operator has touched.
// ============================================================================

export async function listThreadReadStates(): Promise<ThreadReadState[]> {
  return getDb().select().from(threadReadStates);
}

// Task #1685: existence check for the unified thread key used by the
// hub. Mirrors the key shapes produced by `resolveThreadKey` in
// `client/src/lib/conversationModel.ts`:
//   - `group:<convId>`              → twilio_conversations.id
//   - `contact:<id>`                → client_contacts.id OR any conv/call
//     pointing at that contact
//   - `client-phone:<clientId>:<d>` → clients.id with a conv/call carrying
//     a matching normalized phone
//   - `phone:<digits>`              → any conv or call whose normalized
//     contact phone matches
// `inbound:*` (synthetic ringing thread) and `unknown:*` are rejected.
export async function threadKeyExists(threadKey: string): Promise<boolean> {
  if (!threadKey) return false;
  return withDbAttribution("twilioStorage:threadKeyExists", async () => {
  const db = getDb();
  if (threadKey.startsWith("group:")) {
    const convId = threadKey.slice("group:".length);
    if (!convId) return false;
    const [row] = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(eq(twilioConversations.id, convId))
      .limit(1);
    return !!row;
  }
  if (threadKey.startsWith("contact:")) {
    const contactId = threadKey.slice("contact:".length);
    if (!contactId) return false;
    const [contact] = await db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .where(eq(clientContacts.id, contactId))
      .limit(1);
    if (contact) return true;
    const [convHit] = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(eq(twilioConversations.clientContactId, contactId))
      .limit(1);
    if (convHit) return true;
    const [callHit] = await db
      .select({ id: twilioCalls.id })
      .from(twilioCalls)
      .where(eq(twilioCalls.clientContactId, contactId))
      .limit(1);
    return !!callHit;
  }
  if (threadKey.startsWith("client-phone:")) {
    const rest = threadKey.slice("client-phone:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return false;
    const clientId = rest.slice(0, sep);
    const digits = rest.slice(sep + 1);
    if (!clientId || !digits) return false;
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) return false;
    // Either a conversation or a call against this client with a
    // matching last-10-digits phone is enough to consider the thread
    // real. We use the normalized columns where available and fall
    // back to a SQL right(...,10) compare for legacy rows.
    const [convHit] = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(and(
        eq(twilioConversations.clientId, clientId),
        sql`right(regexp_replace(coalesce(${twilioConversations.contactPhoneNormalized}, ${twilioConversations.contactPhone}), '\\D', '', 'g'), 10) = ${digits}`,
      ))
      .limit(1);
    if (convHit) return true;
    const [callHit] = await db
      .select({ id: twilioCalls.id })
      .from(twilioCalls)
      .where(and(
        eq(twilioCalls.clientId, clientId),
        sql`(
          right(regexp_replace(coalesce(${twilioCalls.fromNumber}, ''), '\\D', '', 'g'), 10) = ${digits}
          OR right(regexp_replace(coalesce(${twilioCalls.toNumber}, ''), '\\D', '', 'g'), 10) = ${digits}
        )`,
      ))
      .limit(1);
    return !!callHit;
  }
  if (threadKey.startsWith("phone:")) {
    const digits = threadKey.slice("phone:".length);
    if (!digits) return false;
    const [convHit] = await db
      .select({ id: twilioConversations.id })
      .from(twilioConversations)
      .where(sql`right(regexp_replace(coalesce(${twilioConversations.contactPhoneNormalized}, ${twilioConversations.contactPhone}), '\\D', '', 'g'), 10) = ${digits}`)
      .limit(1);
    if (convHit) return true;
    const [callHit] = await db
      .select({ id: twilioCalls.id })
      .from(twilioCalls)
      .where(sql`(
        right(regexp_replace(coalesce(${twilioCalls.fromNumber}, ''), '\\D', '', 'g'), 10) = ${digits}
        OR right(regexp_replace(coalesce(${twilioCalls.toNumber}, ''), '\\D', '', 'g'), 10) = ${digits}
      )`)
      .limit(1);
    return !!callHit;
  }
  return false;
  });
}

export async function getThreadReadState(threadKey: string): Promise<ThreadReadState | undefined> {
  const [row] = await getDb()
    .select()
    .from(threadReadStates)
    .where(eq(threadReadStates.threadKey, threadKey));
  return row;
}

export async function upsertThreadReadState(data: {
  threadKey: string;
  manuallyUnread: boolean;
  updatedByUserId: string;
}): Promise<ThreadReadState> {
  const now = new Date();
  const [row] = await getDb()
    .insert(threadReadStates)
    .values({
      threadKey: data.threadKey,
      manuallyUnread: data.manuallyUnread,
      updatedByUserId: data.updatedByUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: threadReadStates.threadKey,
      set: {
        manuallyUnread: data.manuallyUnread,
        updatedByUserId: data.updatedByUserId,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function markAssignmentNotificationsRead(
  userId: string,
  ids?: string[],
): Promise<number> {
  const now = new Date();
  const conds = [
    eq(threadAssignmentNotifications.userId, userId),
    isNull(threadAssignmentNotifications.readAt),
  ];
  if (ids && ids.length > 0) {
    conds.push(inArray(threadAssignmentNotifications.id, ids));
  }
  const result = await getDb()
    .update(threadAssignmentNotifications)
    .set({ readAt: now })
    .where(and(...conds))
    .returning({ id: threadAssignmentNotifications.id });
  return result.length;
}
