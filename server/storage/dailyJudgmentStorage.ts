// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type ClientDailyJudgment, type InsertClientDailyJudgment, clientDailyJudgments,
  type ClientCommunicationInsight, type InsertClientCommunicationInsight, clientCommunicationInsights,
  type ClientRelationshipSignal, type InsertClientRelationshipSignal, clientRelationshipSignals,
  type ClientOpenAsk, type InsertClientOpenAsk, clientOpenAsks,
  type UpdateClientOpenAsk, updateClientOpenAskSchema,
  type ClientSavePlay, type InsertClientSavePlay, clientSavePlays,
  type UpdateClientSavePlay, updateClientSavePlaySchema,
  type ClientConcernIntel, type InsertClientConcernIntel, clientConcernIntel,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { desc, eq, and, gte, lte, sql, or, asc } from "drizzle-orm";

export async function createClientDailyJudgment(data: InsertClientDailyJudgment): Promise<ClientDailyJudgment> {
  const [judgment] = await getDb().insert(clientDailyJudgments).values(data).returning();
  return judgment;
}

export async function getClientDailyJudgments(clientId: string, limit = 30): Promise<ClientDailyJudgment[]> {
  return getDb().select().from(clientDailyJudgments)
    .where(eq(clientDailyJudgments.clientId, clientId))
    .orderBy(desc(clientDailyJudgments.judgmentDate))
    .limit(limit);
}

export async function getClientDailyJudgment(id: string): Promise<ClientDailyJudgment | undefined> {
  const [judgment] = await getDb().select().from(clientDailyJudgments).where(eq(clientDailyJudgments.id, id));
  return judgment;
}

export async function listClientDailyJudgments(clientId: string, filters?: {
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  hasUnresolvedAsks?: boolean;
  negativeRelationship?: boolean;
}): Promise<ClientDailyJudgment[]> {
  const conditions = [eq(clientDailyJudgments.clientId, clientId)];
  if (filters?.dateFrom) conditions.push(gte(clientDailyJudgments.judgmentDate, filters.dateFrom.toISOString().split("T")[0]));
  if (filters?.dateTo) conditions.push(lte(clientDailyJudgments.judgmentDate, filters.dateTo.toISOString().split("T")[0]));
  if (filters?.status) conditions.push(eq(clientDailyJudgments.status, filters.status));
  if (filters?.hasUnresolvedAsks) conditions.push(sql`${clientDailyJudgments.unresolvedAskCount} > 0`);
  if (filters?.negativeRelationship) {
    conditions.push(
      or(
        eq(clientDailyJudgments.relationshipHealth, "Strained"),
        eq(clientDailyJudgments.relationshipHealth, "At Risk"),
      )!
    );
  }
  return getDb().select().from(clientDailyJudgments)
    .where(and(...conditions))
    .orderBy(desc(clientDailyJudgments.judgmentDate));
}

export async function getClientDailyJudgmentByDate(clientId: string, judgmentDate: string): Promise<ClientDailyJudgment | undefined> {
  const [judgment] = await getDb().select().from(clientDailyJudgments)
    .where(and(eq(clientDailyJudgments.clientId, clientId), eq(clientDailyJudgments.judgmentDate, judgmentDate)));
  return judgment;
}

export async function upsertClientDailyJudgment(data: InsertClientDailyJudgment): Promise<ClientDailyJudgment> {
  const [judgment] = await getDb().insert(clientDailyJudgments)
    .values(data)
    .onConflictDoUpdate({
      target: [clientDailyJudgments.clientId, clientDailyJudgments.judgmentDate],
      set: {
        status: data.status,
        overallStatus: data.overallStatus,
        // Task #3697 — the Dashboard summaries SQL and the judgment stream
        // still read the legacy `relationship_health` / `confidence` columns,
        // so a re-generated row must update them in lockstep with the new
        // columns instead of leaving stale values behind.
        relationshipHealth: data.relationshipHealth,
        confidence: data.confidence,
        relationshipStatus: data.relationshipStatus,
        confidenceLevel: data.confidenceLevel,
        summaryText: data.summaryText,
        sentimentSummary: data.sentimentSummary,
        changeSummary: data.changeSummary,
        concernsJson: data.concernsJson,
        unresolvedAsksJson: data.unresolvedAsksJson,
        winsJson: data.winsJson,
        actionsJson: data.actionsJson,
        relationshipHealthScore: data.relationshipHealthScore,
        sentimentScore: data.sentimentScore,
        complaintScore: data.complaintScore,
        riskScore: data.riskScore,
        // Task #3697 — basis inventory + analyzed-comms count are now part of
        // every judgment write (including carried-forward copies).
        communicationsAnalyzed: data.communicationsAnalyzed,
        dataSourcesSummary: data.dataSourcesSummary,
        generatedFromStartAt: data.generatedFromStartAt,
        generatedFromEndAt: data.generatedFromEndAt,
        modelVersion: data.modelVersion,
        updatedAt: new Date(),
      },
    })
    .returning();
  return judgment;
}

export async function createClientCommunicationInsight(data: InsertClientCommunicationInsight): Promise<ClientCommunicationInsight> {
  const [insight] = await getDb().insert(clientCommunicationInsights).values(data).returning();
  return insight;
}

export async function getClientCommunicationInsightByCommId(rawCommunicationRecordId: string): Promise<ClientCommunicationInsight | undefined> {
  const [insight] = await getDb().select().from(clientCommunicationInsights)
    .where(eq(clientCommunicationInsights.rawCommunicationRecordId, rawCommunicationRecordId));
  return insight;
}

export async function listClientCommunicationInsights(clientId: string, filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<ClientCommunicationInsight[]> {
  const conditions = [eq(clientCommunicationInsights.clientId, clientId)];
  if (filters?.dateFrom) conditions.push(gte(clientCommunicationInsights.enrichedAt, filters.dateFrom));
  if (filters?.dateTo) conditions.push(lte(clientCommunicationInsights.enrichedAt, filters.dateTo));
  return getDb().select().from(clientCommunicationInsights)
    .where(and(...conditions))
    .orderBy(desc(clientCommunicationInsights.enrichedAt));
}

export async function createClientRelationshipSignal(data: InsertClientRelationshipSignal): Promise<ClientRelationshipSignal> {
  const [signal] = await getDb().insert(clientRelationshipSignals).values(data).returning();
  return signal;
}

export async function getClientRelationshipSignals(clientId: string, limit = 30): Promise<ClientRelationshipSignal[]> {
  return getDb().select().from(clientRelationshipSignals)
    .where(eq(clientRelationshipSignals.clientId, clientId))
    .orderBy(desc(clientRelationshipSignals.signalDate))
    .limit(limit);
}

export async function upsertClientRelationshipSignal(data: InsertClientRelationshipSignal): Promise<ClientRelationshipSignal> {
  const [signal] = await getDb().insert(clientRelationshipSignals)
    .values(data)
    .onConflictDoUpdate({
      target: [clientRelationshipSignals.clientId, clientRelationshipSignals.signalDate],
      set: {
        judgmentId: data.judgmentId,
        relationshipHealthScore: data.relationshipHealthScore,
        sentimentScore: data.sentimentScore,
        complaintScore: data.complaintScore,
        trustScore: data.trustScore,
        responsivenessRiskScore: data.responsivenessRiskScore,
        executionRiskScore: data.executionRiskScore,
        leadVolumeConcernScore: data.leadVolumeConcernScore,
        unresolvedTaskScore: data.unresolvedTaskScore,
      },
    })
    .returning();
  return signal;
}

export async function listClientRelationshipSignals(clientId: string, filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<ClientRelationshipSignal[]> {
  const conditions = [eq(clientRelationshipSignals.clientId, clientId)];
  if (filters?.dateFrom) conditions.push(gte(clientRelationshipSignals.signalDate, filters.dateFrom.toISOString().split("T")[0]));
  if (filters?.dateTo) conditions.push(lte(clientRelationshipSignals.signalDate, filters.dateTo.toISOString().split("T")[0]));
  return getDb().select().from(clientRelationshipSignals)
    .where(and(...conditions))
    .orderBy(desc(clientRelationshipSignals.signalDate));
}

export async function createClientSavePlay(data: InsertClientSavePlay): Promise<ClientSavePlay> {
  const [play] = await withDbAttribution("savePlays:create", () =>
    getDb().insert(clientSavePlays).values(data).returning(),
  );
  return play;
}
export async function getClientOpenAsks(clientId: string, filters?: { status?: string }): Promise<ClientOpenAsk[]> {
  const conditions: any[] = [eq(clientOpenAsks.clientId, clientId)];
  if (filters?.status) conditions.push(eq(clientOpenAsks.status, filters.status));
  return getDb().select().from(clientOpenAsks)
    .where(and(...conditions))
    .orderBy(desc(clientOpenAsks.createdAt));
}

export async function createClientOpenAsk(data: InsertClientOpenAsk): Promise<ClientOpenAsk> {
  const [ask] = await getDb().insert(clientOpenAsks).values(data).returning();
  return ask;
}

export async function getClientOpenAsk(id: string): Promise<ClientOpenAsk | undefined> {
  const [ask] = await getDb().select().from(clientOpenAsks).where(eq(clientOpenAsks.id, id));
  return ask;
}

// Task #4222: runtime-parsed focused edit shape — status/resolution/
// recurrence fields only; clientId and ask identity stay protected.
export async function updateClientOpenAsk(id: string, data: UpdateClientOpenAsk): Promise<ClientOpenAsk | undefined> {
  const parsed = updateClientOpenAskSchema.parse(data);
  const [ask] = await getDb().update(clientOpenAsks)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(clientOpenAsks.id, id))
    .returning();
  return ask;
}

export async function listClientOpenAsks(clientId: string, filters?: {
  status?: string;
  askType?: string;
}): Promise<ClientOpenAsk[]> {
  const conditions = [eq(clientOpenAsks.clientId, clientId)];
  if (filters?.status) conditions.push(eq(clientOpenAsks.status, filters.status));
  if (filters?.askType) conditions.push(eq(clientOpenAsks.askType, filters.askType));
  return getDb().select().from(clientOpenAsks)
    .where(and(...conditions))
    .orderBy(desc(clientOpenAsks.concernScore), desc(clientOpenAsks.lastReferencedAt));
}

export async function listClientSavePlays(clientId: string, filters?: { status?: string }): Promise<ClientSavePlay[]> {
  const conditions = [eq(clientSavePlays.clientId, clientId)];
  if (filters?.status) conditions.push(eq(clientSavePlays.status, filters.status));
  // Active plays first (soonest due on top), then closed history newest-first.
  return withDbAttribution("savePlays:list", () =>
    getDb().select().from(clientSavePlays)
      .where(and(...conditions))
      .orderBy(
        sql`CASE WHEN ${clientSavePlays.status} = 'active' THEN 0 ELSE 1 END`,
        asc(clientSavePlays.dueDate),
        desc(clientSavePlays.createdAt),
      ),
  );
}

// Task #4222: runtime-parsed focused edit shape — route-editable fields +
// close bookkeeping; clientId ownership and attribution stay protected.
export async function updateClientSavePlay(id: string, data: UpdateClientSavePlay): Promise<ClientSavePlay | undefined> {
  const parsed = updateClientSavePlaySchema.parse(data);
  const [play] = await withDbAttribution("savePlays:update", () =>
    getDb().update(clientSavePlays)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(clientSavePlays.id, id))
      .returning(),
  );
  return play;
}

export async function getClientSavePlay(id: string): Promise<ClientSavePlay | undefined> {
  const [play] = await withDbAttribution("savePlays:get", () =>
    getDb().select().from(clientSavePlays).where(eq(clientSavePlays.id, id)),
  );
  return play;
}

export async function deleteClientSavePlay(id: string): Promise<void> {
  await withDbAttribution("savePlays:delete", () =>
    getDb().delete(clientSavePlays).where(eq(clientSavePlays.id, id)),
  );
}

// ── Task #4292 — operator concern intel ─────────────────────────────────────

export async function createClientConcernIntel(data: InsertClientConcernIntel): Promise<ClientConcernIntel> {
  const [row] = await withDbAttribution("concernIntel:create", () =>
    getDb().insert(clientConcernIntel).values(data).returning(),
  );
  return row;
}

/**
 * Recent intel for one client, newest first — the judgment-build read
 * (operator-intel prompt section + fingerprint inputs). Backed by
 * client_concern_intel_client_created_idx (client_id, created_at).
 */
export async function listRecentConcernIntel(
  clientId: string,
  since: Date,
  limit = 50,
): Promise<ClientConcernIntel[]> {
  return withDbAttribution("concernIntel:listRecent", () =>
    getDb().select().from(clientConcernIntel)
      .where(and(
        eq(clientConcernIntel.clientId, clientId),
        gte(clientConcernIntel.createdAt, since),
      ))
      .orderBy(desc(clientConcernIntel.createdAt))
      .limit(limit),
  );
}
