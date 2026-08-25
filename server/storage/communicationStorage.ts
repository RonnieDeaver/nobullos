// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type RawCommunicationRecord, type InsertRawCommunication, rawCommunicationRecords,
  type AiSuggestion, type InsertAiSuggestion, aiSuggestions,
  type UpdateAiSuggestion, updateAiSuggestionSchema,
  type FrontSyncEmail, type InsertFrontSyncEmail, frontSyncEmails,
  type UpdateFrontSyncEmail, updateFrontSyncEmailSchema,
  type FrontPipelineState, isValidPipelineTransition,
  type FrontHydrateSnapshot, type InsertFrontHydrateSnapshot, frontHydrateSnapshots,
  type FrontMatchAuditLog, type InsertFrontMatchAuditLog, frontMatchAuditLog,
  type SlackChannelMapping, type InsertSlackChannelMapping, slackChannelMappings,
  type UpdateSlackChannelMapping, updateSlackChannelMappingSchema,
  type SlackSyncHistory, type InsertSlackSyncHistory, slackSyncHistory,
  type UpdateSlackSyncHistory, updateSlackSyncHistorySchema,
  type PandadocDocument, type InsertPandadocDocument, pandadocDocuments,
  type UpdatePandadocDocument, updatePandadocDocumentSchema,
  type ClientConversationSummary, type InsertClientConversationSummary, clientConversationSummaries,
  type CommunicationClientLink, type InsertCommunicationClientLink, communicationClientLinks,
  type UpdateCommunicationClientLink, updateCommunicationClientLinkSchema,
  type CommunicationOrphanEvent, type InsertCommunicationOrphanEvent, communicationOrphanEvents,
} from "@shared/schema";
import { getDb, dbRetry } from "../db";
import { desc, asc, eq, ne, and, sql, gte, lte, gt, ilike, or, isNull, inArray, type SQL } from "drizzle-orm";

export async function createRawCommunication(data: InsertRawCommunication, options?: { isTouchpoint?: boolean }): Promise<RawCommunicationRecord> {
  const preview = data.contentText ? data.contentText.substring(0, 200) : undefined;
  const [record] = await getDb().insert(rawCommunicationRecords).values({
    ...data,
    contentPreview: data.contentPreview || preview,
    ...(options?.isTouchpoint !== undefined ? { isTouchpoint: options.isTouchpoint } : {}),
  }).returning();
  queueScoreBumpForNewActivity(record);
  return record;
}

// Task #4333 — new captured activity bumps the client's deal scores
// (fire-and-forget + write-safe: recent records only, per-client
// debounced inside the engine; the nightly sweep heals anything skipped).
// Dynamic import keeps storage → services from becoming a static cycle
// (the sanctioned break — see scripts/lint-server-import-cycles).
function queueScoreBumpForNewActivity(record: RawCommunicationRecord | undefined): void {
  if (!record?.clientId) return;
  const clientId = record.clientId;
  // The import chain is registered on a globalThis set (created here, drained
  // by scoringEngine.__test_drainPendingScoreBumps) so tests can await the
  // fire-and-forget hook without a storage→services static import cycle —
  // the dynamic import can outlive a macrotask under the tsx loader, so a
  // plain "yield then check pendingBumps" drain would race it.
  const chains = scoreBumpImportChains();
  const chain = import("../services/scoringEngine")
    .then((m) => m.queueClientActivityScoreBump(clientId, record.timestamp))
    .catch((err) => {
      console.warn("[CommStorage] score bump enqueue failed:", err?.message ?? err);
    })
    .finally(() => {
      chains.delete(chain);
    });
  chains.add(chain);
}

function scoreBumpImportChains(): Set<Promise<unknown>> {
  const g = globalThis as unknown as {
    __scoringBumpImportChains?: Set<Promise<unknown>>;
  };
  if (!g.__scoringBumpImportChains) g.__scoringBumpImportChains = new Set();
  return g.__scoringBumpImportChains;
}

// Task #2713 — idempotent insert keyed on `external_source_id`. Used by the
// per-message materializer where concurrent ticks / autoscale instances can
// race on the SAME Front message id. The DB owns the dedupe via the partial
// unique index `raw_comm_external_source_id_unique_idx (external_source_id)
// WHERE external_source_id IS NOT NULL` (created at bootstrap in server/index.ts,
// intentionally not in shared/schema.ts). A conflict is a CLEAN skip — the row
// already exists — so it returns `undefined` instead of throwing a duplicate-key
// error. The `where` clause mirrors the index predicate so Postgres can infer
// the partial unique index as the conflict arbiter. A row with a NULL
// external_source_id has no arbiter and always inserts (returns the record).
// Task #3703 — the ON CONFLICT clause above depends on the raw-SQL-managed
// partial unique index as its arbiter. If that index vanishes (schema-diffing
// operations can drop it — see .agents/memory/bootstrap-raw-sql-objects-drift.md),
// EVERY insert here raises 42P10 and Front email materialization silently
// stops. Detect that error class specifically, run the one-shot self-heal +
// infra alert, and retry the insert once when the heal recreated the index.
export async function createRawCommunicationOnConflictSkip(
  data: InsertRawCommunication,
): Promise<RawCommunicationRecord | undefined> {
  const preview = data.contentText ? data.contentText.substring(0, 200) : undefined;
  const attemptInsert = async (): Promise<RawCommunicationRecord | undefined> => {
    const rows = await getDb().insert(rawCommunicationRecords).values({
      ...data,
      contentPreview: data.contentPreview || preview,
    }).onConflictDoNothing({
      target: rawCommunicationRecords.externalSourceId,
      where: sql`${rawCommunicationRecords.externalSourceId} IS NOT NULL`,
    }).returning();
    return rows[0];
  };
  try {
    const inserted = await attemptInsert();
    queueScoreBumpForNewActivity(inserted);
    return inserted;
  } catch (err) {
    const { isMissingOnConflictArbiterError, reportAndHealMissingArbiterIndex } =
      await import("../services/rawCommIndexSelfHeal");
    if (!isMissingOnConflictArbiterError(err)) throw err;
    const healed = await reportAndHealMissingArbiterIndex();
    if (!healed) throw err;
    const healedInsert = await attemptInsert();
    queueScoreBumpForNewActivity(healedInsert);
    return healedInsert;
  }
}

export async function getRawCommunication(id: string): Promise<RawCommunicationRecord | undefined> {
  const [record] = await getDb().select().from(rawCommunicationRecords).where(eq(rawCommunicationRecords.id, id));
  return record;
}

export async function getRawCommunicationsByIds(ids: string[]): Promise<RawCommunicationRecord[]> {
  if (ids.length === 0) return [];
  return getDb().select().from(rawCommunicationRecords).where(inArray(rawCommunicationRecords.id, ids));
}

type UpdatableCommFields = Omit<Partial<RawCommunicationRecord>, "isTouchpoint" | "id">;

export async function updateRawCommunication(id: string, data: UpdatableCommFields): Promise<RawCommunicationRecord | undefined> {
  const [record] = await getDb().update(rawCommunicationRecords)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(rawCommunicationRecords.id, id))
    .returning();
  return record;
}

// Task #2637 — Front conversation-wide attribution. Updates EVERY raw record
// that belongs to one Front thread (the `email_thread` rollup row AND every
// per-message `email_message` row sharing the same externalThreadId) in a
// single statement. Used to propagate a resolved client_id (or null) across the
// whole conversation instead of only the row the matcher touched. The UPDATE is
// idempotent (scoped to one externalThreadId) so it is safe to retry. Returns
// the number of rows stamped.
export async function updateRawCommunicationsByThreadId(externalThreadId: string, data: UpdatableCommFields): Promise<number> {
  if (!externalThreadId) return 0;
  const rows = await dbRetry(
    () => getDb().update(rawCommunicationRecords)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(rawCommunicationRecords.externalThreadId, externalThreadId))
      .returning({ id: rawCommunicationRecords.id }),
    "updateRawCommunicationsByThreadId",
  );
  return rows.length;
}

// Task #818 Phase 1: Close the retry gap. The UPDATE is fully idempotent
// (it only flips isTouchpoint=false → the supplied value, scoped to one
// externalSourceId) so it is safe to retry on transient pool/connection
// errors. Previously this was the one ingestion-tail mutation without
// `dbRetry`, leaving a small but real failure window during pool pressure
// or Neon connection recycling.
export async function finalizeTouchpointClassification(externalSourceId: string, isTouchpoint: boolean): Promise<void> {
  await dbRetry(
    () => getDb().update(rawCommunicationRecords)
      .set({ isTouchpoint, updatedAt: new Date() })
      .where(
        and(
          eq(rawCommunicationRecords.externalSourceId, externalSourceId),
          eq(rawCommunicationRecords.isTouchpoint, false)
        )
      ),
    "finalizeTouchpointClassification",
  );
}

export async function deleteRawCommunication(id: string): Promise<void> {
  await getDb().delete(rawCommunicationRecords).where(eq(rawCommunicationRecords.id, id));
}

export async function listRawCommunications(clientId: string, filters?: {
  sourceType?: string;
  direction?: string;
  processingStatus?: string;
  reviewStatus?: string;
  dateFrom?: Date;
  dateTo?: Date;
  hasSuggestions?: boolean;
  search?: string;
  // Task #904: orphaned rows (parent client deleted, see clientStorage.deleteClient)
  // are kept for forensic queries but excluded from client-linked views by
  // default. Admin/forensic callers can opt in by setting this to true.
  includeOrphaned?: boolean;
}): Promise<RawCommunicationRecord[]> {
  const linkedRecordIds = await getDb().select({ id: communicationClientLinks.rawCommunicationRecordId })
    .from(communicationClientLinks)
    .where(
      and(
        eq(communicationClientLinks.clientId, clientId),
        ne(communicationClientLinks.status, "rejected"),
      )
    );
  const linkedIds = linkedRecordIds.map(r => r.id);

  const clientCondition = linkedIds.length > 0
    ? or(
        eq(rawCommunicationRecords.clientId, clientId),
        inArray(rawCommunicationRecords.id, linkedIds),
      )!
    : eq(rawCommunicationRecords.clientId, clientId);

  const conditions = [clientCondition];
  if (!filters?.includeOrphaned) {
    // Task #904: hide orphaned rows from client-linked views. Use a
    // NULL-safe predicate because match_status is NULL on most pre-#897
    // rows and `ne(col, 'orphaned')` would drop those (NULL <> 'x' → NULL).
    conditions.push(or(
      isNull(rawCommunicationRecords.matchStatus),
      ne(rawCommunicationRecords.matchStatus, "orphaned"),
    )!);
  }
  if (filters?.sourceType) conditions.push(eq(rawCommunicationRecords.sourceType, filters.sourceType));
  if (filters?.direction) conditions.push(eq(rawCommunicationRecords.direction, filters.direction));
  if (filters?.processingStatus) conditions.push(eq(rawCommunicationRecords.processingStatus, filters.processingStatus));
  if (filters?.reviewStatus) conditions.push(eq(rawCommunicationRecords.reviewStatus, filters.reviewStatus));
  if (filters?.dateFrom) conditions.push(gte(rawCommunicationRecords.timestamp, filters.dateFrom));
  if (filters?.dateTo) conditions.push(lte(rawCommunicationRecords.timestamp, filters.dateTo));
  if (filters?.hasSuggestions !== undefined) conditions.push(eq(rawCommunicationRecords.hasSuggestions, filters.hasSuggestions));
  if (filters?.search) {
    const searchPattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(rawCommunicationRecords.title, searchPattern),
        ilike(rawCommunicationRecords.contentText, searchPattern),
        ilike(rawCommunicationRecords.contentPreview, searchPattern),
      )!
    );
  }
  return getDb().select().from(rawCommunicationRecords)
    .where(and(...conditions))
    .orderBy(desc(rawCommunicationRecords.timestamp));
}

export async function createAiSuggestion(data: InsertAiSuggestion): Promise<AiSuggestion> {
  const [suggestion] = await getDb().insert(aiSuggestions).values(data).returning();
  return suggestion;
}

export async function getAiSuggestion(id: string): Promise<AiSuggestion | undefined> {
  const [suggestion] = await getDb().select().from(aiSuggestions).where(eq(aiSuggestions.id, id));
  return suggestion;
}

// Task #4222: runtime-parsed focused edit shape — strips unknown/protected
// keys (row id, clientId, source FK, AI content) and rejects bad types.
export async function updateAiSuggestion(id: string, data: UpdateAiSuggestion): Promise<AiSuggestion | undefined> {
  const parsed = updateAiSuggestionSchema.parse(data);
  const [suggestion] = await getDb().update(aiSuggestions).set(parsed).where(eq(aiSuggestions.id, id)).returning();
  return suggestion;
}

export async function listAiSuggestions(clientId: string, filters?: {
  status?: string;
  destinationType?: string;
  rawCommunicationRecordId?: string;
}): Promise<AiSuggestion[]> {
  const conditions = [eq(aiSuggestions.clientId, clientId)];
  if (filters?.status) conditions.push(eq(aiSuggestions.status, filters.status));
  if (filters?.destinationType) conditions.push(eq(aiSuggestions.destinationType, filters.destinationType));
  if (filters?.rawCommunicationRecordId) conditions.push(eq(aiSuggestions.rawCommunicationRecordId, filters.rawCommunicationRecordId));
  return getDb().select().from(aiSuggestions)
    .where(and(...conditions))
    .orderBy(desc(aiSuggestions.createdAt));
}

export async function countPendingSuggestions(clientId: string): Promise<number> {
  const result = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.clientId, clientId), eq(aiSuggestions.status, "pending")));
  return result[0]?.count ?? 0;
}

export async function createFrontSyncEmail(data: InsertFrontSyncEmail): Promise<FrontSyncEmail> {
  const [record] = await getDb().insert(frontSyncEmails).values(data).onConflictDoNothing({ target: frontSyncEmails.conversationId }).returning();
  if (!record) {
    const existing = await getFrontSyncEmailByConversationId(data.conversationId);
    if (existing) return existing;
    throw new Error(`Failed to create front sync email for conversation ${data.conversationId}`);
  }
  return record;
}

export async function getFrontSyncEmail(id: string): Promise<FrontSyncEmail | undefined> {
  const [record] = await getDb().select().from(frontSyncEmails).where(eq(frontSyncEmails.id, id));
  return record;
}

export async function getFrontSyncEmailByConversationId(conversationId: string): Promise<FrontSyncEmail | undefined> {
  const [record] = await getDb().select().from(frontSyncEmails).where(eq(frontSyncEmails.conversationId, conversationId));
  return record;
}

export async function getExistingConversationIds(conversationIds: string[]): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const CHUNK_SIZE = 500;
  const result = new Set<string>();
  for (let i = 0; i < conversationIds.length; i += CHUNK_SIZE) {
    const chunk = conversationIds.slice(i, i + CHUNK_SIZE);
    const rows = await getDb()
      .select({ conversationId: frontSyncEmails.conversationId })
      .from(frontSyncEmails)
      .where(inArray(frontSyncEmails.conversationId, chunk));
    for (const row of rows) {
      result.add(row.conversationId);
    }
  }
  return result;
}

// Task #4222: runtime-parsed focused edit shape — match/triage outcome
// fields only; pipeline-state columns belong to transitionFrontSyncPipelineState.
export async function updateFrontSyncEmail(id: string, data: UpdateFrontSyncEmail): Promise<FrontSyncEmail | undefined> {
  const parsed = updateFrontSyncEmailSchema.parse(data);
  const [record] = await getDb().update(frontSyncEmails).set(parsed).where(eq(frontSyncEmails.id, id)).returning();
  return record;
}

export async function listFrontSyncEmails(filters?: {
  matchStatus?: string;
  matchStatuses?: string[];
  limit?: number;
  offset?: number;
  afterCursor?: { createdAt: Date; id: string };
}): Promise<FrontSyncEmail[]> {
  const conditions: SQL[] = [];
  if (filters?.matchStatuses && filters.matchStatuses.length > 0) {
    conditions.push(inArray(frontSyncEmails.matchStatus, filters.matchStatuses));
  } else if (filters?.matchStatus) {
    conditions.push(eq(frontSyncEmails.matchStatus, filters.matchStatus));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filters?.limit || 100;

  if (filters?.afterCursor) {
    conditions.push(
      sql`(${frontSyncEmails.createdAt}, ${frontSyncEmails.id}) > (${filters.afterCursor.createdAt}, ${filters.afterCursor.id})`
    );
    return getDb().select().from(frontSyncEmails)
      .where(and(...conditions))
      .orderBy(asc(frontSyncEmails.createdAt), asc(frontSyncEmails.id))
      .limit(limit);
  }

  return getDb().select().from(frontSyncEmails)
    .where(whereClause)
    .orderBy(desc(frontSyncEmails.createdAt), desc(frontSyncEmails.id))
    .limit(limit)
    .offset(filters?.offset || 0);
}

export async function getFrontSyncEmailsByIds(ids: string[]): Promise<FrontSyncEmail[]> {
  if (ids.length === 0) return [];
  return getDb().select().from(frontSyncEmails).where(inArray(frontSyncEmails.id, ids));
}

export async function countUnmatchedFrontSyncEmails(): Promise<number> {
  const result = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(frontSyncEmails)
    .where(eq(frontSyncEmails.matchStatus, "unmatched"));
  return result[0]?.count ?? 0;
}

export async function countFrontSyncEmailsByStatus(status: string): Promise<number> {
  const result = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(frontSyncEmails)
    .where(eq(frontSyncEmails.matchStatus, status));
  return result[0]?.count ?? 0;
}

export async function getOldestUnmatchedFrontSyncTimestamp(): Promise<Date | null> {
  const result = await getDb().select({ lastMessageAt: frontSyncEmails.lastMessageAt })
    .from(frontSyncEmails)
    .where(eq(frontSyncEmails.matchStatus, "unmatched"))
    .orderBy(asc(frontSyncEmails.lastMessageAt))
    .limit(1);
  return result[0]?.lastMessageAt ?? null;
}

export async function deleteAllFrontSyncEmails(): Promise<number> {
  const result = await getDb().delete(frontSyncEmails).returning({ id: frontSyncEmails.id });
  return result.length;
}

export async function transitionFrontSyncPipelineState(
  id: string,
  toState: FrontPipelineState,
  options?: { error?: string; force?: boolean }
): Promise<FrontSyncEmail | undefined> {
  const existing = await getFrontSyncEmail(id);
  if (!existing) return undefined;

  const fromState = (existing.pipelineState || "discovered") as FrontPipelineState;
  if (!options?.force && !isValidPipelineTransition(fromState, toState)) {
    throw new Error(`Invalid pipeline transition: ${fromState} -> ${toState} for front_sync_email ${id}`);
  }

  const updates: Partial<FrontSyncEmail> = {
    pipelineState: toState,
    stateChangedAt: new Date(),
  };

  if (toState === "failed") {
    updates.pipelineError = options?.error || null;
    updates.pipelineAttempts = (existing.pipelineAttempts || 0) + 1;
  } else {
    updates.pipelineError = null;
  }

  const [record] = await getDb().update(frontSyncEmails)
    .set(updates)
    .where(eq(frontSyncEmails.id, id))
    .returning();
  return record;
}

export async function getExistingConversationVersionKeys(
  conversationIds: string[]
): Promise<Map<string, { id: string; versionKey: string | null; pipelineState: string }>> {
  if (conversationIds.length === 0) return new Map();
  const CHUNK_SIZE = 500;
  const result = new Map<string, { id: string; versionKey: string | null; pipelineState: string }>();
  for (let i = 0; i < conversationIds.length; i += CHUNK_SIZE) {
    const chunk = conversationIds.slice(i, i + CHUNK_SIZE);
    const rows = await getDb()
      .select({
        id: frontSyncEmails.id,
        conversationId: frontSyncEmails.conversationId,
        versionKey: frontSyncEmails.versionKey,
        pipelineState: frontSyncEmails.pipelineState,
      })
      .from(frontSyncEmails)
      .where(inArray(frontSyncEmails.conversationId, chunk));
    for (const row of rows) {
      result.set(row.conversationId, {
        id: row.id,
        versionKey: row.versionKey,
        pipelineState: row.pipelineState,
      });
    }
  }
  return result;
}

export async function listFrontSyncEmailsByPipelineState(
  states: FrontPipelineState[],
  limit = 100
): Promise<FrontSyncEmail[]> {
  return getDb().select().from(frontSyncEmails)
    .where(inArray(frontSyncEmails.pipelineState, states))
    .orderBy(asc(frontSyncEmails.stateChangedAt))
    .limit(limit);
}

export async function createSlackChannelMapping(data: InsertSlackChannelMapping): Promise<SlackChannelMapping> {
  const [mapping] = await getDb().insert(slackChannelMappings).values(data).returning();
  return mapping;
}

export async function getSlackChannelMapping(id: string): Promise<SlackChannelMapping | undefined> {
  const [mapping] = await getDb().select().from(slackChannelMappings).where(eq(slackChannelMappings.id, id));
  return mapping;
}

export async function getSlackChannelMappingByChannelId(channelId: string): Promise<SlackChannelMapping | undefined> {
  const [mapping] = await getDb().select().from(slackChannelMappings).where(eq(slackChannelMappings.channelId, channelId));
  return mapping;
}

// Task #4200 (F8 follow-up) — latent cat-6 boundary hardened. The patch is
// runtime-parsed through the focused update schema (strips unknown keys and
// rejects protected ones by omission: id, channelId, autoCreated, createdAt,
// updatedAt) so a future caller cannot forward a raw request body into the
// spread. `updatedAt` stays server-stamped.
export async function updateSlackChannelMapping(id: string, data: UpdateSlackChannelMapping): Promise<SlackChannelMapping | undefined> {
  const patch = updateSlackChannelMappingSchema.parse(data);
  const [mapping] = await getDb().update(slackChannelMappings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(slackChannelMappings.id, id))
    .returning();
  return mapping;
}

export async function deleteSlackChannelMapping(id: string): Promise<void> {
  await getDb().delete(slackChannelMappings).where(eq(slackChannelMappings.id, id));
}

export async function listSlackChannelMappings(filters?: { isActive?: boolean }): Promise<SlackChannelMapping[]> {
  const conditions = [];
  if (filters?.isActive !== undefined) {
    conditions.push(eq(slackChannelMappings.isActive, filters.isActive));
  }
  if (conditions.length > 0) {
    return getDb().select().from(slackChannelMappings).where(and(...conditions)).orderBy(slackChannelMappings.channelName);
  }
  return getDb().select().from(slackChannelMappings).orderBy(slackChannelMappings.channelName);
}

export async function createSlackSyncHistory(data: InsertSlackSyncHistory): Promise<SlackSyncHistory> {
  const [record] = await getDb().insert(slackSyncHistory).values(data).returning();
  return record;
}

// Task #4222: runtime-parsed focused edit shape — progress counters/status/
// completedAt only; id and triggeredBy attribution stay server-controlled.
export async function updateSlackSyncHistory(id: string, data: UpdateSlackSyncHistory): Promise<SlackSyncHistory | undefined> {
  const parsed = updateSlackSyncHistorySchema.parse(data);
  const [record] = await getDb().update(slackSyncHistory).set(parsed).where(eq(slackSyncHistory.id, id)).returning();
  return record;
}

export async function listSlackSyncHistory(limit = 20): Promise<SlackSyncHistory[]> {
  return getDb().select().from(slackSyncHistory).orderBy(desc(slackSyncHistory.startedAt)).limit(limit);
}

export async function findRawCommunicationByExternalSourceId(externalSourceId: string): Promise<RawCommunicationRecord | undefined> {
  const [record] = await getDb().select().from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.externalSourceId, externalSourceId));
  return record;
}

export async function listEmailMessageSiblingsByThreadId(
  externalThreadId: string,
  clientId: string,
): Promise<RawCommunicationRecord[]> {
  if (!externalThreadId || !clientId) return [];
  return getDb().select().from(rawCommunicationRecords)
    .where(and(
      eq(rawCommunicationRecords.externalThreadId, externalThreadId),
      eq(rawCommunicationRecords.clientId, clientId),
      eq(rawCommunicationRecords.sourceType, "front_email"),
      eq(rawCommunicationRecords.sourceSubtype, "email_message"),
    ))
    .orderBy(asc(rawCommunicationRecords.timestamp));
}

/**
 * Task #2963 — shared canonical helper for composing a human- (or AI-)
 * readable thread body from an ordered array of email_message sibling rows.
 *
 * This is the SINGLE implementation consumed by both the detail-modal route
 * (Task #2926) and the AI analysis content builder (Task #2963). Never
 * duplicate it in either caller — that is the whole point.
 *
 * Returns null when no sibling has a non-empty contentText (caller decides
 * how to handle the gap: the route sets threadContentUnavailable=true; the
 * analysis path falls back to contentPreview or "(no content available)").
 */
export function composeEmailThreadTextFromSiblings(
  siblings: Pick<
    RawCommunicationRecord,
    "direction" | "participantsJson" | "timestamp" | "contentText"
  >[],
): string | null {
  const withBody = siblings.filter((s) => s.contentText);
  if (withBody.length === 0) return null;
  return withBody
    .map((s) => {
      const dir =
        s.direction === "inbound"
          ? "Inbound"
          : s.direction === "outbound"
            ? "Outbound"
            : "Internal";
      const author =
        Array.isArray(s.participantsJson) && s.participantsJson.length > 0
          ? (s.participantsJson as any[])[0]?.email ||
            (s.participantsJson as any[])[0]?.name ||
            ""
          : "";
      const ts = s.timestamp
        ? new Date(s.timestamp).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      const header = [dir, author, ts].filter(Boolean).join(" — ");
      return `[${header}]\n${s.contentText}`;
    })
    .join("\n\n");
}

export async function listUnmatchedFrontSyncEmails(limit = 100): Promise<FrontSyncEmail[]> {
  return getDb().select().from(frontSyncEmails)
    .where(eq(frontSyncEmails.matchStatus, "unmatched"))
    .orderBy(desc(frontSyncEmails.createdAt))
    .limit(limit);
}

// Task #2512 — targeted lookup of the unmatched Front backlog rows whose
// participants include a specific sender email OR sender domain. Powers the
// "attach sender to client → re-evaluate only the affected rows" operator
// action without scanning the whole corpus. Deliberately NOT the test-only
// `restrictToIds` shortcut on the guarded sweeps — this is a real, indexed
// query scoped by participant, so `lint-front-rematch-restrict-to-ids` stays
// satisfied. Matching is done in SQL over the jsonb participants array
// (`split_part(email,'@',2)` gives an exact domain compare, immune to LIKE
// wildcard edge cases). Newest-first, capped.
export async function listUnmatchedFrontSyncEmailsByParticipant(
  target: { email?: string; domain?: string },
  limit = 5000,
): Promise<FrontSyncEmail[]> {
  const email = (target.email || "").trim().toLowerCase();
  const domain = (target.domain || "").trim().toLowerCase().replace(/^@/, "");
  if (!email && !domain) return [];

  const participantMatch = email
    ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${frontSyncEmails.participantsJson}) AS e WHERE lower(e->>'email') = ${email})`
    : sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${frontSyncEmails.participantsJson}) AS e WHERE lower(split_part(e->>'email', '@', 2)) = ${domain})`;

  return getDb().select().from(frontSyncEmails)
    .where(and(eq(frontSyncEmails.matchStatus, "unmatched"), participantMatch))
    .orderBy(desc(frontSyncEmails.createdAt))
    .limit(Math.max(1, Math.min(limit, 10000)));
}

export async function listUnmatchedRawCommunications(filters?: { sourceType?: string; limit?: number; includeOrphaned?: boolean }): Promise<RawCommunicationRecord[]> {
  const conditions: any[] = [eq(rawCommunicationRecords.reviewStatus, "unreviewed")];
  if (filters?.sourceType) conditions.push(eq(rawCommunicationRecords.sourceType, filters.sourceType));
  if (!filters?.includeOrphaned) {
    // Task #904: orphaned rows (parent client deleted) are not real candidates
    // for matching review — keep them out of the unmatched feed.
    conditions.push(or(
      isNull(rawCommunicationRecords.matchStatus),
      ne(rawCommunicationRecords.matchStatus, "orphaned"),
    )!);
  }
  return getDb().select().from(rawCommunicationRecords)
    .where(and(...conditions))
    .orderBy(desc(rawCommunicationRecords.timestamp))
    .limit(filters?.limit || 100);
}

export async function listUnmatchedSlackMessages(limit = 100, options?: { includeOrphaned?: boolean }): Promise<RawCommunicationRecord[]> {
  const conditions: any[] = [
    eq(rawCommunicationRecords.sourceType, "slack"),
    isNull(rawCommunicationRecords.clientId),
  ];
  if (!options?.includeOrphaned) {
    // Task #904: orphaned rows have client_id = NULL too — exclude explicitly
    // so the unmatched-Slack feed doesn't surface evidence of deleted clients.
    conditions.push(or(
      isNull(rawCommunicationRecords.matchStatus),
      ne(rawCommunicationRecords.matchStatus, "orphaned"),
    )!);
  }
  return getDb().select().from(rawCommunicationRecords)
    .where(and(...conditions))
    .orderBy(desc(rawCommunicationRecords.timestamp))
    .limit(limit);
}

export async function createPandadocDocument(data: InsertPandadocDocument): Promise<PandadocDocument> {
  const [doc] = await getDb().insert(pandadocDocuments).values(data).returning();
  return doc;
}

export async function getPandadocDocument(id: string): Promise<PandadocDocument | undefined> {
  const [doc] = await getDb().select().from(pandadocDocuments).where(eq(pandadocDocuments.id, id));
  return doc;
}

export async function getPandadocDocumentByDocumentId(documentId: string): Promise<PandadocDocument | undefined> {
  const [doc] = await getDb().select().from(pandadocDocuments).where(eq(pandadocDocuments.documentId, documentId));
  return doc;
}

// Task #4222: runtime-parsed focused edit shape — the vendor natural key
// (documentId) is immutable on edit; unknown keys are stripped.
export async function updatePandadocDocument(id: string, data: UpdatePandadocDocument): Promise<PandadocDocument | undefined> {
  const parsed = updatePandadocDocumentSchema.parse(data);
  const [doc] = await getDb().update(pandadocDocuments).set(parsed).where(eq(pandadocDocuments.id, id)).returning();
  return doc;
}

export async function listPandadocDocuments(filters?: { linkedClientId?: string; search?: string }): Promise<PandadocDocument[]> {
  const conditions: any[] = [];
  if (filters?.linkedClientId) conditions.push(eq(pandadocDocuments.linkedClientId, filters.linkedClientId));
  if (filters?.search) conditions.push(ilike(pandadocDocuments.title, `%${filters.search}%`));
  return getDb().select().from(pandadocDocuments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(pandadocDocuments.createdDate));
}

export async function linkPandadocDocumentToClient(id: string, clientId: string | null): Promise<PandadocDocument | undefined> {
  const [doc] = await getDb().update(pandadocDocuments)
    .set({ linkedClientId: clientId })
    .where(eq(pandadocDocuments.id, id))
    .returning();
  return doc;
}

/**
 * Task #4048 — the single communication grain shared by the window COUNT and
 * the daily-judgment RETRIEVAL query (getRecentCommunications in
 * server/services/dailyJudgment.ts). Both must build their WHERE clause from
 * THIS helper: a row that would never be analyzed must never be counted (or
 * the judgment tier/basis claims communications the model was never shown),
 * and vice versa. The optional `until` bound exists for the same reason —
 * past-dated generation windows cap retrieval at endAt, so the count has to
 * cap there too.
 *
 * Grain rules encoded here:
 *   - Matched rows only (Task #965 defense-in-depth): orphaned rows have
 *     client_id=NULL so the clientId equality already excludes them, but the
 *     explicit match_status filter keeps a future migration that leaves
 *     client_id populated on an orphan from sneaking deleted-client comms in.
 *   - One row per real communication (Task #4048): Front email threads exist
 *     at TWO grains sharing external_thread_id — a legacy per-thread rollup
 *     row (source_subtype='email_thread') plus per-message rows
 *     (source_subtype='email_message') written by materialization. Counting
 *     both double-counts every materialized thread, so the rollup row is
 *     excluded whenever the same client+thread has at least one countable
 *     per-message row INSIDE THE SAME WINDOW; rollup-only threads (never
 *     materialized) still count once. The sibling check is window-scoped so
 *     counted==retrievable holds per window — a rollup whose messages all
 *     fall outside the window still represents that thread inside it.
 */
export function countableCommunicationConditions(clientId: string, since: Date, until?: Date): SQL[] {
  const conditions: SQL[] = [
    eq(rawCommunicationRecords.clientId, clientId),
    gte(rawCommunicationRecords.timestamp, since),
    or(
      isNull(rawCommunicationRecords.matchStatus),
      ne(rawCommunicationRecords.matchStatus, "orphaned"),
    )!,
  ];
  if (until) conditions.push(lte(rawCommunicationRecords.timestamp, until));
  conditions.push(sql`NOT (
    ${rawCommunicationRecords.sourceSubtype} = 'email_thread'
    AND ${rawCommunicationRecords.externalThreadId} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${rawCommunicationRecords} AS sibling_msg
      WHERE sibling_msg.external_thread_id = ${rawCommunicationRecords.externalThreadId}
        AND sibling_msg.client_id = ${rawCommunicationRecords.clientId}
        AND sibling_msg.source_subtype = 'email_message'
        AND sibling_msg.timestamp >= ${since}
        ${until ? sql`AND sibling_msg.timestamp <= ${until}` : sql``}
        AND (sibling_msg.match_status IS NULL OR sibling_msg.match_status <> 'orphaned')
    )
  )`);
  return conditions;
}

// See countableCommunicationConditions above — this count and the judgment
// retrieval share that predicate verbatim (counted == retrievable).
export async function countClientCommunicationsInRange(clientId: string, since: Date, until?: Date): Promise<number> {
  const result = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(rawCommunicationRecords)
    .where(and(...countableCommunicationConditions(clientId, since, until)));
  return result[0]?.count ?? 0;
}

export async function getPandadocDocumentsByClient(clientId: string): Promise<PandadocDocument[]> {
  return getDb().select().from(pandadocDocuments)
    .where(eq(pandadocDocuments.linkedClientId, clientId))
    .orderBy(desc(pandadocDocuments.createdDate));
}

export async function getClientConversationSummary(clientId: string): Promise<ClientConversationSummary | undefined> {
  const [record] = await getDb().select().from(clientConversationSummaries)
    .where(eq(clientConversationSummaries.clientId, clientId));
  return record;
}

export async function upsertClientConversationSummary(data: InsertClientConversationSummary): Promise<ClientConversationSummary> {
  const [record] = await getDb().insert(clientConversationSummaries)
    .values(data)
    .onConflictDoUpdate({
      target: clientConversationSummaries.clientId,
      set: {
        summaryJson: data.summaryJson,
        generatedAt: data.generatedAt,
        windowStart: data.windowStart,
        windowEnd: data.windowEnd,
        commCount: data.commCount,
        updatedAt: new Date(),
      },
    })
    .returning();
  return record;
}

export async function createCommunicationClientLink(data: InsertCommunicationClientLink): Promise<CommunicationClientLink> {
  const [link] = await getDb().insert(communicationClientLinks).values(data).onConflictDoNothing().returning();
  return link;
}

export async function listCommunicationClientLinks(recordId: string): Promise<CommunicationClientLink[]> {
  return getDb().select().from(communicationClientLinks)
    .where(eq(communicationClientLinks.rawCommunicationRecordId, recordId))
    .orderBy(desc(communicationClientLinks.matchConfidence));
}

export async function listClientLinksForClient(clientId: string): Promise<CommunicationClientLink[]> {
  return getDb().select().from(communicationClientLinks)
    .where(eq(communicationClientLinks.clientId, clientId))
    .orderBy(desc(communicationClientLinks.createdAt));
}

// Task #4222: runtime-parsed focused edit shape — a link edit can never
// re-point rawCommunicationRecordId/clientId (link identity).
export async function updateCommunicationClientLink(id: string, data: UpdateCommunicationClientLink): Promise<CommunicationClientLink | undefined> {
  const parsed = updateCommunicationClientLinkSchema.parse(data);
  const [link] = await getDb().update(communicationClientLinks)
    .set(parsed)
    .where(eq(communicationClientLinks.id, id))
    .returning();
  return link;
}

export async function deleteCommunicationClientLink(id: string): Promise<void> {
  await getDb().delete(communicationClientLinks).where(eq(communicationClientLinks.id, id));
}

export async function upsertFrontHydrateSnapshot(data: InsertFrontHydrateSnapshot): Promise<FrontHydrateSnapshot> {
  const [record] = await getDb().insert(frontHydrateSnapshots)
    .values(data)
    .onConflictDoUpdate({
      target: frontHydrateSnapshots.versionKey,
      set: {
        conversationJson: data.conversationJson,
        messagesJson: data.messagesJson,
        messageCount: data.messageCount,
        hydratedAt: new Date(),
        expiresAt: data.expiresAt,
      },
    })
    .returning();
  return record;
}

export async function getFrontHydrateSnapshotByVersionKey(versionKey: string): Promise<FrontHydrateSnapshot | undefined> {
  const [record] = await getDb().select()
    .from(frontHydrateSnapshots)
    .where(and(
      eq(frontHydrateSnapshots.versionKey, versionKey),
      or(
        isNull(frontHydrateSnapshots.expiresAt),
        gt(frontHydrateSnapshots.expiresAt, new Date()),
      ),
    ));
  return record;
}

export async function getFrontHydrateSnapshotByConversationId(conversationId: string): Promise<FrontHydrateSnapshot | undefined> {
  const [record] = await getDb().select()
    .from(frontHydrateSnapshots)
    .where(and(
      eq(frontHydrateSnapshots.conversationId, conversationId),
      or(
        isNull(frontHydrateSnapshots.expiresAt),
        gt(frontHydrateSnapshots.expiresAt, new Date()),
      ),
    ))
    .orderBy(desc(frontHydrateSnapshots.hydratedAt))
    .limit(1);
  return record;
}

export async function deleteFrontHydrateSnapshot(id: string): Promise<void> {
  await getDb().delete(frontHydrateSnapshots).where(eq(frontHydrateSnapshots.id, id));
}

export async function deleteExpiredFrontHydrateSnapshots(): Promise<number> {
  const result = await getDb().delete(frontHydrateSnapshots)
    .where(and(
      lte(frontHydrateSnapshots.expiresAt, new Date()),
      sql`${frontHydrateSnapshots.expiresAt} IS NOT NULL`
    ))
    .returning();
  return result.length;
}

// Task #867 — Front hard-match audit log helpers.
//
// One row per re-evaluation outcome from the hard matcher. The audit table
// is append-only; nobody updates rows, only inserts and reads. The list
// helper is intentionally narrow (used by an admin "why did this email
// move?" surface and by the dashboard tile aggregator).

export async function createFrontMatchAuditLog(
  data: InsertFrontMatchAuditLog,
): Promise<FrontMatchAuditLog> {
  const [row] = await getDb().insert(frontMatchAuditLog).values(data).returning();
  return row;
}

export async function listFrontMatchAuditLog(opts: {
  syncEmailId?: string;
  conversationId?: string;
  limit?: number;
} = {}): Promise<FrontMatchAuditLog[]> {
  const conds: SQL[] = [];
  if (opts.syncEmailId) conds.push(eq(frontMatchAuditLog.syncEmailId, opts.syncEmailId));
  if (opts.conversationId) conds.push(eq(frontMatchAuditLog.conversationId, opts.conversationId));
  const base = getDb().select().from(frontMatchAuditLog);
  const filtered = conds.length > 0 ? base.where(and(...conds)) : base;
  return filtered.orderBy(desc(frontMatchAuditLog.createdAt)).limit(opts.limit ?? 50);
}

// Task #966 — Structured orphan-event audit helpers.
//
// Append-only: callers insert one row per orphaning event. The list
// helper powers the admin/CLI report ("orphans created in the last
// N days").

export async function recordCommunicationOrphanEvent(
  data: InsertCommunicationOrphanEvent,
): Promise<CommunicationOrphanEvent> {
  const [row] = await getDb()
    .insert(communicationOrphanEvents)
    .values(data)
    .returning();
  return row;
}

export async function recordCommunicationOrphanEvents(
  rows: InsertCommunicationOrphanEvent[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await getDb()
    .insert(communicationOrphanEvents)
    .values(rows)
    .returning({ id: communicationOrphanEvents.id });
  return inserted.length;
}

export interface ListOrphanEventOptions {
  cause?: "client_deleted" | "sweep_backfill";
  priorClientId?: string;
  rawCommunicationRecordId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function listCommunicationOrphanEvents(
  opts: ListOrphanEventOptions = {},
): Promise<CommunicationOrphanEvent[]> {
  const conds: SQL[] = [];
  if (opts.cause) conds.push(eq(communicationOrphanEvents.cause, opts.cause));
  if (opts.priorClientId)
    conds.push(eq(communicationOrphanEvents.priorClientId, opts.priorClientId));
  if (opts.rawCommunicationRecordId)
    conds.push(
      eq(communicationOrphanEvents.rawCommunicationRecordId, opts.rawCommunicationRecordId),
    );
  if (opts.since) conds.push(gte(communicationOrphanEvents.occurredAt, opts.since));
  if (opts.until) conds.push(lte(communicationOrphanEvents.occurredAt, opts.until));
  const base = getDb().select().from(communicationOrphanEvents);
  const filtered = conds.length > 0 ? base.where(and(...conds)) : base;
  return filtered
    .orderBy(desc(communicationOrphanEvents.occurredAt))
    .limit(opts.limit ?? 100);
}

export async function countCommunicationOrphanEvents(
  opts: Omit<ListOrphanEventOptions, "limit"> = {},
): Promise<{ total: number; byCause: Record<string, number> }> {
  const conds: SQL[] = [];
  if (opts.cause) conds.push(eq(communicationOrphanEvents.cause, opts.cause));
  if (opts.priorClientId)
    conds.push(eq(communicationOrphanEvents.priorClientId, opts.priorClientId));
  if (opts.rawCommunicationRecordId)
    conds.push(
      eq(communicationOrphanEvents.rawCommunicationRecordId, opts.rawCommunicationRecordId),
    );
  if (opts.since) conds.push(gte(communicationOrphanEvents.occurredAt, opts.since));
  if (opts.until) conds.push(lte(communicationOrphanEvents.occurredAt, opts.until));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const baseTotal = getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(communicationOrphanEvents);
  const totalRowsQ = where ? baseTotal.where(where) : baseTotal;
  const totalRows = await totalRowsQ;

  const baseGroup = getDb()
    .select({
      cause: communicationOrphanEvents.cause,
      count: sql<number>`count(*)::int`,
    })
    .from(communicationOrphanEvents);
  const groupQ = where ? baseGroup.where(where) : baseGroup;
  const grouped = await groupQ.groupBy(communicationOrphanEvents.cause);

  const byCause: Record<string, number> = {};
  for (const r of grouped) byCause[r.cause] = r.count;
  return { total: totalRows[0]?.count ?? 0, byCause };
}

/**
 * Task #867 — dashboard tile aggregator. Returns a count for every
 * `match_status` value present in `front_sync_emails` plus a count for
 * every distinct `match_method` (best-effort split on the leading
 * `[REASON_CODE]` prefix produced by the pipeline). Single round-trip.
 */
export async function getFrontMatchStats(): Promise<{
  byStatus: Record<string, number>;
  byMethod: Record<string, number>;
  total: number;
}> {
  const statusRows = await getDb().execute(sql`
    SELECT match_status::text AS status, COUNT(*)::int AS count
    FROM front_sync_emails
    GROUP BY match_status
  `);
  const methodRows = await getDb().execute(sql`
    SELECT
      CASE
        WHEN match_reason ~ '^\\[[A-Z_]+\\]' THEN substring(match_reason from '^\\[([A-Z_]+)\\]')
        WHEN match_reason ILIKE 'Manually assigned%' THEN 'MANUAL'
        WHEN match_reason ILIKE 'Filter rule%' THEN 'FILTER_RULE'
        WHEN match_reason IS NULL THEN 'UNKNOWN'
        ELSE 'OTHER'
      END AS method,
      COUNT(*)::int AS count
    FROM front_sync_emails
    WHERE matched_client_id IS NOT NULL
    GROUP BY 1
  `);

  const byStatus: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  let total = 0;
  const sRows = Array.isArray(statusRows) ? statusRows : (statusRows as any).rows ?? [];
  for (const r of sRows) {
    const status = r.status || "unknown";
    const count = Number(r.count) || 0;
    byStatus[status] = count;
    total += count;
  }
  const mRows = Array.isArray(methodRows) ? methodRows : (methodRows as any).rows ?? [];
  for (const r of mRows) {
    byMethod[r.method || "UNKNOWN"] = Number(r.count) || 0;
  }
  return { byStatus, byMethod, total };
}
