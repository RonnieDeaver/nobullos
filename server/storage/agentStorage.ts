// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type ClientAgentMemory, type InsertClientAgentMemory, clientAgentMemory,
  type AgentKnowledgeBase, type InsertAgentKnowledgeBase, agentKnowledgeBase,
  type UpdateAgentKnowledgeEntry, updateAgentKnowledgeEntrySchema,
  type AgentFeedback, type InsertAgentFeedback, agentFeedback,
  type AgentMatchDecision, type InsertAgentMatchDecision, agentMatchDecisions,
  type UpdateAgentMatchDecision, updateAgentMatchDecisionSchema,
  type ClientAgentChat, type InsertClientAgentChat, clientAgentChats,
  type OperationalFilterMemory, type InsertOperationalFilterMemory, operationalFilterMemory,
} from "@shared/schema";
import { getDb } from "../db";
import { desc, eq, and, sql, inArray } from "drizzle-orm";

export async function getClientAgentMemory(clientId: string): Promise<ClientAgentMemory[]> {
  return getDb().select().from(clientAgentMemory)
    .where(eq(clientAgentMemory.clientId, clientId))
    .orderBy(clientAgentMemory.identifierType, clientAgentMemory.identifierValue);
}

export async function getClientAgentMemoryByType(clientId: string, identifierType: string): Promise<ClientAgentMemory[]> {
  return getDb().select().from(clientAgentMemory)
    .where(and(eq(clientAgentMemory.clientId, clientId), eq(clientAgentMemory.identifierType, identifierType)));
}

export async function createClientAgentMemory(data: InsertClientAgentMemory): Promise<ClientAgentMemory> {
  const [memory] = await getDb().insert(clientAgentMemory).values(data).returning();
  return memory;
}

export async function upsertClientAgentMemory(data: InsertClientAgentMemory): Promise<ClientAgentMemory> {
  const existing = await getDb().select().from(clientAgentMemory)
    .where(and(
      eq(clientAgentMemory.clientId, data.clientId),
      eq(clientAgentMemory.identifierType, data.identifierType),
      eq(clientAgentMemory.identifierValue, data.identifierValue),
    ));

  if (existing.length > 0) {
    const [updated] = await getDb().update(clientAgentMemory)
      .set({
        lastSeenAt: new Date(),
        usageCount: sql`${clientAgentMemory.usageCount} + 1`,
        confidenceWeight: data.confidenceWeight ?? existing[0].confidenceWeight,
        updatedAt: new Date(),
      })
      .where(eq(clientAgentMemory.id, existing[0].id))
      .returning();
    return updated;
  }

  const [memory] = await getDb().insert(clientAgentMemory).values(data).returning();
  return memory;
}

// Task #4380 (F8): dedicated narrow writer type. The agents PUT route
// parses its own focused schema first; the promote endpoint and internal
// learners set source/manuallyAdded/lastSeenAt. Ownership (clientId), row
// identity, and counters stay out of the patch.
export type ClientAgentMemoryStoragePatch = Partial<
  Pick<
    InsertClientAgentMemory,
    "identifierType" | "identifierValue" | "confidenceWeight" | "source" | "manuallyAdded"
  >
> & { lastSeenAt?: Date };

export async function updateClientAgentMemory(id: string, data: ClientAgentMemoryStoragePatch): Promise<ClientAgentMemory | undefined> {
  const [memory] = await getDb().update(clientAgentMemory)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(clientAgentMemory.id, id))
    .returning();
  return memory;
}

export async function deleteClientAgentMemory(id: string): Promise<void> {
  await getDb().delete(clientAgentMemory).where(eq(clientAgentMemory.id, id));
}

export async function getAllAgentMemories(): Promise<ClientAgentMemory[]> {
  return getDb().select().from(clientAgentMemory)
    .orderBy(clientAgentMemory.clientId, clientAgentMemory.identifierType);
}

export async function penalizeAgentMemoryWeight(id: string, factor: number, minWeight: number): Promise<ClientAgentMemory | undefined> {
  const [memory] = await getDb().update(clientAgentMemory)
    .set({
      confidenceWeight: sql`GREATEST(${minWeight}, ${clientAgentMemory.confidenceWeight} * ${factor})`,
      usageCount: sql`${clientAgentMemory.usageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(clientAgentMemory.id, id))
    .returning();
  return memory;
}

export async function boostAgentMemoryWeight(id: string, factor: number, maxWeight: number): Promise<ClientAgentMemory | undefined> {
  const [memory] = await getDb().update(clientAgentMemory)
    .set({
      confidenceWeight: sql`LEAST(${maxWeight}, ${clientAgentMemory.confidenceWeight} * ${factor})`,
      usageCount: sql`${clientAgentMemory.usageCount} + 1`,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clientAgentMemory.id, id))
    .returning();
  return memory;
}

export async function getAgentKnowledgeByClient(clientId: string, filters?: { category?: string; isActive?: boolean }): Promise<AgentKnowledgeBase[]> {
  const conditions = [eq(agentKnowledgeBase.clientId, clientId)];
  if (filters?.category) conditions.push(eq(agentKnowledgeBase.factCategory, filters.category));
  if (filters?.isActive !== undefined) conditions.push(eq(agentKnowledgeBase.isActive, filters.isActive));
  return getDb().select().from(agentKnowledgeBase)
    .where(and(...conditions))
    .orderBy(desc(agentKnowledgeBase.confidence), desc(agentKnowledgeBase.lastSeenAt));
}

export async function getAgentKnowledgeEntry(id: string): Promise<AgentKnowledgeBase | undefined> {
  const [entry] = await getDb().select().from(agentKnowledgeBase).where(eq(agentKnowledgeBase.id, id));
  return entry;
}

export async function createAgentKnowledgeEntry(data: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase> {
  const [entry] = await getDb().insert(agentKnowledgeBase).values(data).returning();
  return entry;
}

export async function upsertAgentKnowledgeEntry(data: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase> {
  const existing = await getDb().select().from(agentKnowledgeBase)
    .where(and(
      eq(agentKnowledgeBase.clientId, data.clientId),
      eq(agentKnowledgeBase.factCategory, data.factCategory),
      eq(agentKnowledgeBase.factText, data.factText),
    ));

  if (existing.length > 0) {
    const newConfidence = Math.min(1.0, Math.max(existing[0].confidence, data.confidence ?? 0.7));
    const [updated] = await getDb().update(agentKnowledgeBase)
      .set({
        lastSeenAt: new Date(),
        usageCount: sql`${agentKnowledgeBase.usageCount} + 1`,
        confidence: newConfidence,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(agentKnowledgeBase.id, existing[0].id))
      .returning();
    return updated;
  }

  const [entry] = await getDb().insert(agentKnowledgeBase).values(data).returning();
  return entry;
}

// Task #4222: runtime-parsed focused edit shape — fact content/curation only;
// clientId ownership and source attribution stay server-controlled.
export async function updateAgentKnowledgeEntry(id: string, data: UpdateAgentKnowledgeEntry): Promise<AgentKnowledgeBase | undefined> {
  const parsed = updateAgentKnowledgeEntrySchema.parse(data);
  const [entry] = await getDb().update(agentKnowledgeBase)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(agentKnowledgeBase.id, id))
    .returning();
  return entry;
}

export async function deleteAgentKnowledgeEntry(id: string): Promise<void> {
  await getDb().delete(agentKnowledgeBase).where(eq(agentKnowledgeBase.id, id));
}

export async function bulkUpsertAgentKnowledge(entries: InsertAgentKnowledgeBase[]): Promise<AgentKnowledgeBase[]> {
  const results: AgentKnowledgeBase[] = [];
  for (const entry of entries) {
    const result = await upsertAgentKnowledgeEntry(entry);
    results.push(result);
  }
  return results;
}

export async function createAgentFeedback(data: InsertAgentFeedback): Promise<AgentFeedback> {
  const [feedback] = await getDb().insert(agentFeedback).values(data).returning();
  return feedback;
}

export async function getAgentFeedbackByTarget(targetRecordId: string, targetRecordType: string): Promise<AgentFeedback[]> {
  return getDb().select().from(agentFeedback)
    .where(and(
      eq(agentFeedback.targetRecordId, targetRecordId),
      eq(agentFeedback.targetRecordType, targetRecordType),
    ))
    .orderBy(desc(agentFeedback.createdAt));
}

export async function getAgentFeedbackByClient(clientId: string, limit?: number): Promise<AgentFeedback[]> {
  let query = getDb().select().from(agentFeedback)
    .where(eq(agentFeedback.clientId, clientId))
    .orderBy(desc(agentFeedback.createdAt));
  if (limit) query = query.limit(limit) as any;
  return query;
}

export async function listAgentFeedback(filters?: { agentType?: string; feedbackType?: string; clientId?: string; limit?: number }): Promise<AgentFeedback[]> {
  const conditions = [];
  if (filters?.agentType) conditions.push(eq(agentFeedback.agentType, filters.agentType));
  if (filters?.feedbackType) conditions.push(eq(agentFeedback.feedbackType, filters.feedbackType));
  if (filters?.clientId) conditions.push(eq(agentFeedback.clientId, filters.clientId));
  let query = getDb().select().from(agentFeedback)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentFeedback.createdAt));
  if (filters?.limit) query = query.limit(filters.limit) as any;
  return query;
}

export async function createAgentMatchDecision(data: InsertAgentMatchDecision): Promise<AgentMatchDecision> {
  const [decision] = await getDb().insert(agentMatchDecisions).values(data).returning();
  return decision;
}

export async function getAgentMatchDecision(id: string): Promise<AgentMatchDecision | undefined> {
  const [decision] = await getDb().select().from(agentMatchDecisions).where(eq(agentMatchDecisions.id, id));
  return decision;
}

// Task #4222: runtime-parsed focused edit shape — review/correction fields
// only; communication identity, clientId and AI evidence stay protected.
export async function updateAgentMatchDecision(id: string, data: UpdateAgentMatchDecision): Promise<AgentMatchDecision | undefined> {
  const parsed = updateAgentMatchDecisionSchema.parse(data);
  const [decision] = await getDb().update(agentMatchDecisions)
    .set(parsed)
    .where(eq(agentMatchDecisions.id, id))
    .returning();
  return decision;
}

export async function listAgentMatchDecisions(filters?: {
  clientId?: string;
  communicationId?: string;
  status?: string;
  sourceType?: string;
  unresolvedOnly?: boolean;
  reviewResolution?: string;
  /**
   * When true, only return decisions with reopenCount > 0 (i.e. were reopened
   * at least once). Used by the Zoom review queue's "reopened" resolution
   * filter (#734) which is logically a resolution outcome but actually lives
   * in a separate column.
   */
  reopenedOnly?: boolean;
  dismissReason?: string;
  since?: Date;
  limit?: number;
  /**
   * Optional list of LIKE patterns; matches if explanationSummary matches ANY.
   */
  explanationSummaryLikeAny?: string[];
  /**
   * Optional list of LIKE patterns; matches only if explanationSummary
   * matches NONE of them (NULL summaries are treated as not-matching).
   */
  explanationSummaryNotLikeAny?: string[];
}): Promise<AgentMatchDecision[]> {
  const conditions: any[] = [];
  if (filters?.clientId) conditions.push(eq(agentMatchDecisions.clientId, filters.clientId));
  if (filters?.communicationId) conditions.push(eq(agentMatchDecisions.communicationId, filters.communicationId));
  if (filters?.status) conditions.push(eq(agentMatchDecisions.status, filters.status));
  if (filters?.sourceType) conditions.push(eq(agentMatchDecisions.sourceType, filters.sourceType));
  if (filters?.unresolvedOnly) {
    conditions.push(sql`${agentMatchDecisions.reviewResolution} IS NULL`);
  }
  if (filters?.reviewResolution) {
    conditions.push(eq(agentMatchDecisions.reviewResolution, filters.reviewResolution));
  }
  if (filters?.reopenedOnly) {
    conditions.push(sql`${agentMatchDecisions.reopenCount} > 0`);
  }
  if (filters?.dismissReason) {
    if (filters.dismissReason === "unspecified") {
      conditions.push(sql`${agentMatchDecisions.dismissReason} IS NULL`);
    } else {
      conditions.push(eq(agentMatchDecisions.dismissReason, filters.dismissReason as any));
    }
  }
  if (filters?.since) {
    conditions.push(sql`${agentMatchDecisions.createdAt} >= ${filters.since}`);
  }
  if (filters?.explanationSummaryLikeAny && filters.explanationSummaryLikeAny.length > 0) {
    const patterns = filters.explanationSummaryLikeAny;
    const ors = patterns.map((p) => sql`${agentMatchDecisions.explanationSummary} LIKE ${p}`);
    conditions.push(sql`(${sql.join(ors, sql` OR `)})`);
  }
  if (filters?.explanationSummaryNotLikeAny && filters.explanationSummaryNotLikeAny.length > 0) {
    const patterns = filters.explanationSummaryNotLikeAny;
    const ands = patterns.map(
      (p) => sql`${agentMatchDecisions.explanationSummary} NOT LIKE ${p}`,
    );
    // NULL summaries are treated as not-matching any pattern (so they pass
    // through "not like any" filters). This keeps legitimate live rows with
    // missing summaries from being silently dropped from the result set.
    conditions.push(
      sql`(${agentMatchDecisions.explanationSummary} IS NULL OR (${sql.join(ands, sql` AND `)}))`,
    );
  }

  return getDb().select().from(agentMatchDecisions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentMatchDecisions.createdAt))
    .limit(filters?.limit || 100);
}

export async function getAgentMatchDecisionStatsInWindow(filters: {
  sourceType?: string;
  since: Date;
  until: Date;
}): Promise<{
  total: number;
  claimed: number;
  reviewRequired: number;
  ambiguous: number;
  notClaimed: number;
  corrected: number;
}> {
  const conds: any[] = [
    sql`${agentMatchDecisions.createdAt} >= ${filters.since}`,
    sql`${agentMatchDecisions.createdAt} < ${filters.until}`,
  ];
  if (filters.sourceType) {
    conds.push(eq(agentMatchDecisions.sourceType, filters.sourceType));
  }

  const [row] = await getDb().select({
    total: sql<number>`count(*)::int`,
    claimed: sql<number>`count(*) filter (where ${agentMatchDecisions.status} = 'claimed')::int`,
    reviewRequired: sql<number>`count(*) filter (where ${agentMatchDecisions.status} = 'review_required')::int`,
    ambiguous: sql<number>`count(*) filter (where ${agentMatchDecisions.status} = 'ambiguous')::int`,
    notClaimed: sql<number>`count(*) filter (where ${agentMatchDecisions.status} = 'not_claimed')::int`,
    corrected: sql<number>`count(*) filter (where ${agentMatchDecisions.correctedByHuman} = true)::int`,
  }).from(agentMatchDecisions).where(and(...conds));

  return row || { total: 0, claimed: 0, reviewRequired: 0, ambiguous: 0, notClaimed: 0, corrected: 0 };
}

export async function getAgentMatchStats(clientId: string): Promise<{
  totalDecisions: number;
  claimedCount: number;
  correctedCount: number;
  avgConfidence: number;
}> {
  const [result] = await getDb().select({
    totalDecisions: sql<number>`count(*)::int`,
    claimedCount: sql<number>`count(*) filter (where ${agentMatchDecisions.status} = 'claimed')::int`,
    correctedCount: sql<number>`count(*) filter (where ${agentMatchDecisions.correctedByHuman} = true)::int`,
    avgConfidence: sql<number>`coalesce(avg(${agentMatchDecisions.confidenceScore}), 0)::real`,
  }).from(agentMatchDecisions).where(eq(agentMatchDecisions.clientId, clientId));

  return result || { totalDecisions: 0, claimedCount: 0, correctedCount: 0, avgConfidence: 0 };
}

export async function getClientAgentChatMessages(clientId: string): Promise<ClientAgentChat[]> {
  return getDb().select().from(clientAgentChats)
    .where(eq(clientAgentChats.clientId, clientId))
    .orderBy(clientAgentChats.createdAt);
}

export async function createClientAgentChatMessage(data: InsertClientAgentChat): Promise<ClientAgentChat> {
  const [msg] = await getDb().insert(clientAgentChats).values(data).returning();
  return msg;
}

export async function deleteClientAgentChatMessages(clientId: string): Promise<void> {
  await getDb().delete(clientAgentChats).where(eq(clientAgentChats.clientId, clientId));
}

export async function upsertOperationalFilterMemory(data: InsertOperationalFilterMemory): Promise<OperationalFilterMemory> {
  const existing = await getDb().select().from(operationalFilterMemory)
    .where(and(
      eq(operationalFilterMemory.identifierType, data.identifierType),
      eq(operationalFilterMemory.identifierValue, data.identifierValue),
    ));

  if (existing.length > 0) {
    const currentWeight = existing[0].confidenceWeight;
    const incomingWeight = data.confidenceWeight ?? 0.5;
    const boostIncrement = incomingWeight * 0.15;
    const boostedWeight = Math.min(1.0, currentWeight + boostIncrement);
    const [updated] = await getDb().update(operationalFilterMemory)
      .set({
        lastSeenAt: new Date(),
        usageCount: sql`${operationalFilterMemory.usageCount} + 1`,
        confidenceWeight: boostedWeight,
        source: data.source ?? existing[0].source,
        updatedAt: new Date(),
      })
      .where(eq(operationalFilterMemory.id, existing[0].id))
      .returning();
    return updated;
  }

  const [memory] = await getDb().insert(operationalFilterMemory).values(data).returning();
  return memory;
}

export async function getOperationalFilterMemoryBySignals(
  signals: Array<{ type: string; value: string }>
): Promise<OperationalFilterMemory[]> {
  if (signals.length === 0) return [];

  const types = [...new Set(signals.map(s => s.type))];
  const values = [...new Set(signals.map(s => s.value))];

  return getDb().select().from(operationalFilterMemory)
    .where(and(
      inArray(operationalFilterMemory.identifierType, types),
      inArray(operationalFilterMemory.identifierValue, values),
    ));
}

export async function getAllOperationalFilterMemories(): Promise<OperationalFilterMemory[]> {
  return getDb().select().from(operationalFilterMemory)
    .orderBy(desc(operationalFilterMemory.confidenceWeight));
}

export async function penalizeOperationalFilterMemory(id: string, factor: number, minWeight: number): Promise<OperationalFilterMemory | undefined> {
  const [memory] = await getDb().update(operationalFilterMemory)
    .set({
      confidenceWeight: sql`GREATEST(${minWeight}, ${operationalFilterMemory.confidenceWeight} * ${factor})`,
      source: "penalized",
      updatedAt: new Date(),
    })
    .where(eq(operationalFilterMemory.id, id))
    .returning();
  return memory;
}

export async function deleteOperationalFilterMemory(id: string): Promise<void> {
  await getDb().delete(operationalFilterMemory).where(eq(operationalFilterMemory.id, id));
}
