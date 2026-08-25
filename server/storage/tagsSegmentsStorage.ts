// @db-pool-intent: ambient
/**
 * Task #4329 — storage for tag/segment definitions, manual tag
 * application, and segment member reads.
 *
 * Split of responsibilities with server/services/tagSegmentEngine.ts:
 * this module owns operator-driven CRUD + manual join rows; the engine
 * owns everything `source='rule'` and all membership computation. The
 * one rule enforced HERE is manual-row provenance: `removeManualTag`
 * refuses to delete rule rows (routes surface that as 409 — a rule row
 * would just be re-added by the next evaluation, so "removing" it is a
 * lie; operators edit the tag's criteria instead).
 *
 * Name uniqueness rides the (entity_type, name) unique index — callers
 * catch 23505 and return 409 (isUniqueViolation helper below).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  clientContacts,
  clients,
  clientTags,
  dealTags,
  deals,
  segmentMembers,
  segments,
  tags,
  workQueue,
  type Segment,
  type Tag,
  type TagSource,
} from "@shared/schema";
import type {
  CriteriaSet,
  SegmentEntityType,
  TagEntityType,
} from "@shared/criteria";
import { getDb, withDbAttribution } from "../db";

/** Assignments returned to list views (chips) in one bounded read. */
const ASSIGNMENT_LIST_LIMIT = 20_000;
/** Segment member page — plan bound, not pagination (lists are small). */
export const SEGMENT_MEMBER_LIST_LIMIT = 1_000;

export function isUniqueViolation(err: unknown): boolean {
  // Drizzle wraps the pg error (code lives on .cause); walk a short chain.
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 4; depth++) {
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

// ── Tag definitions ──────────────────────────────────────────────────────────

export interface TagWithCount extends Tag {
  taggedCount: number;
}

export async function listTags(entityType?: TagEntityType): Promise<TagWithCount[]> {
  return withDbAttribution("tagseg:list-tags", async () => {
    const db = getDb();
    const defs = await db
      .select()
      .from(tags)
      .where(entityType ? eq(tags.entityType, entityType) : undefined)
      .orderBy(asc(tags.entityType), asc(tags.name));
    if (defs.length === 0) return [];

    const [dealCounts, clientCounts] = await Promise.all([
      db
        .select({ tagId: dealTags.tagId, count: sql<number>`count(*)::int` })
        .from(dealTags)
        .groupBy(dealTags.tagId),
      db
        .select({ tagId: clientTags.tagId, count: sql<number>`count(*)::int` })
        .from(clientTags)
        .groupBy(clientTags.tagId),
    ]);
    const counts = new Map<string, number>();
    for (const row of [...dealCounts, ...clientCounts]) {
      counts.set(row.tagId, row.count);
    }
    return defs.map((t) => ({ ...t, taggedCount: counts.get(t.id) ?? 0 }));
  });
}

export async function getTag(id: string): Promise<Tag | undefined> {
  return withDbAttribution("tagseg:get-tag", async () => {
    const db = getDb();
    const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    return row;
  });
}

export interface CreateTagInput {
  entityType: TagEntityType;
  name: string;
  color: string;
  description?: string | null;
  criteria?: CriteriaSet | null;
  createdBy: string;
}

export async function createTag(input: CreateTagInput): Promise<Tag> {
  return withDbAttribution("tagseg:create-tag", async () => {
    const db = getDb();
    const [row] = await db
      .insert(tags)
      .values({
        entityType: input.entityType,
        name: input.name,
        color: input.color,
        description: input.description ?? null,
        criteria: input.criteria ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    return row;
  });
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
  description?: string | null;
  criteria?: CriteriaSet | null;
}

export async function updateTag(
  id: string,
  patch: UpdateTagInput,
): Promise<Tag | undefined> {
  return withDbAttribution("tagseg:update-tag", async () => {
    const db = getDb();
    const [row] = await db
      .update(tags)
      .set({ ...patch, updatedAt: new Date() }) // spread-write-approved: zod-parsed UpdateTagBody subset, server-owned columns absent from the type
      .where(eq(tags.id, id))
      .returning();
    return row;
  });
}

export async function deleteTag(id: string): Promise<boolean> {
  return withDbAttribution("tagseg:delete-tag", async () => {
    const db = getDb();
    const deleted = await db
      .delete(tags)
      .where(eq(tags.id, id))
      .returning({ id: tags.id });
    return deleted.length > 0;
  });
}

// ── Assignments (chips for list views) ───────────────────────────────────────

export interface TagAssignment {
  tagId: string;
  entityId: string;
  source: TagSource;
}

export async function listTagAssignments(
  entityType: TagEntityType,
): Promise<TagAssignment[]> {
  return withDbAttribution("tagseg:list-assignments", async () => {
    const db = getDb();
    if (entityType === "deal") {
      return db
        .select({
          tagId: dealTags.tagId,
          entityId: dealTags.dealId,
          source: dealTags.source,
        })
        .from(dealTags)
        .limit(ASSIGNMENT_LIST_LIMIT);
    }
    return db
      .select({
        tagId: clientTags.tagId,
        entityId: clientTags.clientId,
        source: clientTags.source,
      })
      .from(clientTags)
      .limit(ASSIGNMENT_LIST_LIMIT);
  });
}

export interface RecordTag extends Tag {
  source: TagSource;
  appliedBy: string | null;
}

export async function getRecordTags(
  entityType: TagEntityType,
  recordId: string,
): Promise<RecordTag[]> {
  return withDbAttribution("tagseg:record-tags", async () => {
    const db = getDb();
    if (entityType === "deal") {
      const rows = await db
        .select({ tag: tags, source: dealTags.source, appliedBy: dealTags.appliedBy })
        .from(dealTags)
        .innerJoin(tags, eq(dealTags.tagId, tags.id))
        .where(eq(dealTags.dealId, recordId))
        .orderBy(asc(tags.name));
      return rows.map((r) => ({ ...r.tag, source: r.source, appliedBy: r.appliedBy }));
    }
    const rows = await db
      .select({ tag: tags, source: clientTags.source, appliedBy: clientTags.appliedBy })
      .from(clientTags)
      .innerJoin(tags, eq(clientTags.tagId, tags.id))
      .where(eq(clientTags.clientId, recordId))
      .orderBy(asc(tags.name));
    return rows.map((r) => ({ ...r.tag, source: r.source, appliedBy: r.appliedBy }));
  });
}

// ── Manual application ───────────────────────────────────────────────────────

/**
 * Apply a tag manually. Dup-safe: if the record already carries the tag
 * (either source) this is a no-op (P1 — ON CONFLICT DO NOTHING on the
 * UNIQUE(record, tag) composite).
 */
export async function applyManualTag(
  entityType: TagEntityType,
  recordId: string,
  tagId: string,
  appliedBy: string,
): Promise<void> {
  return withDbAttribution("tagseg:apply-manual", async () => {
    const db = getDb();
    if (entityType === "deal") {
      await db
        .insert(dealTags)
        .values({ dealId: recordId, tagId, source: "manual", appliedBy })
        .onConflictDoNothing();
    } else {
      await db
        .insert(clientTags)
        .values({ clientId: recordId, tagId, source: "manual", appliedBy })
        .onConflictDoNothing();
    }
  });
}

export type RemoveManualTagResult = "removed" | "not_found" | "rule_protected";

/**
 * Remove a manual tag row. Rule rows are engine-owned: deleting one here
 * would silently resurrect on the next evaluation, so we refuse instead
 * (routes surface 409 with guidance to edit the tag's criteria).
 */
export async function removeManualTag(
  entityType: TagEntityType,
  recordId: string,
  tagId: string,
): Promise<RemoveManualTagResult> {
  return withDbAttribution("tagseg:remove-manual", async () => {
    const db = getDb();
    const join =
      entityType === "deal"
        ? { table: dealTags, entityCol: dealTags.dealId, tagCol: dealTags.tagId, sourceCol: dealTags.source }
        : { table: clientTags, entityCol: clientTags.clientId, tagCol: clientTags.tagId, sourceCol: clientTags.source };

    const [existing] = await db
      .select({ source: join.sourceCol })
      .from(join.table)
      .where(and(eq(join.entityCol, recordId), eq(join.tagCol, tagId)))
      .limit(1);
    if (!existing) return "not_found";
    if (existing.source === "rule") return "rule_protected";

    await db
      .delete(join.table)
      .where(
        and(
          eq(join.entityCol, recordId),
          eq(join.tagCol, tagId),
          eq(join.sourceCol, "manual"),
        ),
      );
    return "removed";
  });
}

// ── Segments ─────────────────────────────────────────────────────────────────

export async function listSegments(): Promise<Segment[]> {
  return withDbAttribution("tagseg:list-segments", async () => {
    const db = getDb();
    return db
      .select()
      .from(segments)
      .orderBy(asc(segments.entityType), asc(segments.name));
  });
}

export async function getSegment(id: string): Promise<Segment | undefined> {
  return withDbAttribution("tagseg:get-segment", async () => {
    const db = getDb();
    const [row] = await db.select().from(segments).where(eq(segments.id, id)).limit(1);
    return row;
  });
}

export interface CreateSegmentInput {
  entityType: SegmentEntityType;
  name: string;
  description?: string | null;
  criteria: CriteriaSet;
  createdBy: string;
}

export async function createSegment(input: CreateSegmentInput): Promise<Segment> {
  return withDbAttribution("tagseg:create-segment", async () => {
    const db = getDb();
    const [row] = await db
      .insert(segments)
      .values({
        entityType: input.entityType,
        name: input.name,
        description: input.description ?? null,
        criteria: input.criteria,
        createdBy: input.createdBy,
      })
      .returning();
    return row;
  });
}

export interface UpdateSegmentInput {
  name?: string;
  description?: string | null;
  criteria?: CriteriaSet;
}

export async function updateSegment(
  id: string,
  patch: UpdateSegmentInput,
): Promise<Segment | undefined> {
  return withDbAttribution("tagseg:update-segment", async () => {
    const db = getDb();
    const [row] = await db
      .update(segments)
      .set({ ...patch, updatedAt: new Date() }) // spread-write-approved: zod-parsed UpdateSegmentBody subset, server-owned columns absent from the type
      .where(eq(segments.id, id))
      .returning();
    return row;
  });
}

export async function deleteSegment(id: string): Promise<boolean> {
  return withDbAttribution("tagseg:delete-segment", async () => {
    const db = getDb();
    const deleted = await db
      .delete(segments)
      .where(eq(segments.id, id))
      .returning({ id: segments.id });
    return deleted.length > 0;
  });
}

// ── Segment member reads ─────────────────────────────────────────────────────

export interface SegmentMemberRow {
  entityId: string;
  /** Firm name (client segments) or contact name (contact segments). */
  name: string;
  /** Secondary line: contact email / role + firm. */
  detail: string | null;
  clientId: string | null;
  addedAt: Date | null;
}

/**
 * Joined member list — the entity join makes orphaned cache rows
 * invisible even before the next reconciliation reaps them.
 */
export async function listSegmentMembers(
  segment: Segment,
): Promise<SegmentMemberRow[]> {
  return withDbAttribution("tagseg:list-members", async () => {
    const db = getDb();
    if (segment.entityType === "client") {
      const rows = await db
        .select({
          entityId: segmentMembers.entityId,
          name: clients.firmName,
          contactName: clients.contactName,
          contactEmail: clients.contactEmail,
          addedAt: segmentMembers.addedAt,
        })
        .from(segmentMembers)
        .innerJoin(clients, eq(clients.id, segmentMembers.entityId))
        .where(eq(segmentMembers.segmentId, segment.id))
        .orderBy(asc(clients.firmName))
        .limit(SEGMENT_MEMBER_LIST_LIMIT);
      return rows.map((r) => ({
        entityId: r.entityId,
        name: r.name,
        detail: r.contactEmail ?? r.contactName,
        clientId: r.entityId,
        addedAt: r.addedAt,
      }));
    }
    const rows = await db
      .select({
        entityId: segmentMembers.entityId,
        name: clientContacts.name,
        roleTitle: clientContacts.roleTitle,
        emails: clientContacts.emails,
        clientId: clientContacts.clientId,
        firmName: clients.firmName,
        addedAt: segmentMembers.addedAt,
      })
      .from(segmentMembers)
      .innerJoin(clientContacts, eq(clientContacts.id, segmentMembers.entityId))
      .innerJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(eq(segmentMembers.segmentId, segment.id))
      .orderBy(asc(clientContacts.name))
      .limit(SEGMENT_MEMBER_LIST_LIMIT);
    return rows.map((r) => ({
      entityId: r.entityId,
      name: r.name,
      detail: [r.roleTitle, r.firmName].filter(Boolean).join(" · ") || (r.emails?.[0] ?? null),
      clientId: r.clientId,
      addedAt: r.addedAt,
    }));
  });
}

// ── Sweep queue depth (admin status view) ────────────────────────────────────

export interface SweepQueueInfo {
  pending: number;
  processing: number;
  lastFinished: {
    status: string;
    createdAt: Date | null;
    completedAt: Date | null;
    errorMessage: string | null;
  } | null;
}

export async function getSweepQueueInfo(queueName: string): Promise<SweepQueueInfo> {
  return withDbAttribution("tagseg:queue-info", async () => {
    const db = getDb();
    const counts = await db
      .select({ status: workQueue.status, count: sql<number>`count(*)::int` })
      .from(workQueue)
      .where(eq(workQueue.queueName, queueName))
      .groupBy(workQueue.status);
    const byStatus = new Map(counts.map((r) => [r.status, r.count]));
    const [last] = await db
      .select({
        status: workQueue.status,
        createdAt: workQueue.createdAt,
        completedAt: workQueue.completedAt,
        errorMessage: workQueue.errorMessage,
      })
      .from(workQueue)
      .where(
        and(
          eq(workQueue.queueName, queueName),
          sql`${workQueue.status} IN ('completed', 'failed', 'dead_letter')`,
        ),
      )
      .orderBy(desc(workQueue.createdAt))
      .limit(1);
    return {
      pending: byStatus.get("pending") ?? 0,
      processing: byStatus.get("processing") ?? 0,
      lastFinished: last ?? null,
    };
  });
}

// ── Deal/client existence checks for tag routes ──────────────────────────────

export interface TaggableRecordAccess {
  id: string;
  ownerId: string | null;
  isDemo: boolean;
}

/** Minimal row for route-level access checks (mirrors deals/clients rules). */
export async function getTaggableRecord(
  entityType: TagEntityType,
  recordId: string,
): Promise<TaggableRecordAccess | undefined> {
  return withDbAttribution("tagseg:taggable-record", async () => {
    const db = getDb();
    if (entityType === "deal") {
      const [row] = await db
        .select({ id: deals.id, ownerId: deals.ownerId })
        .from(deals)
        .where(eq(deals.id, recordId))
        .limit(1);
      return row ? { ...row, isDemo: false } : undefined;
    }
    const [row] = await db
      .select({ id: clients.id, ownerId: clients.ownerId, isDemo: clients.isDemo })
      .from(clients)
      .where(eq(clients.id, recordId))
      .limit(1);
    return row ? { ...row, isDemo: row.isDemo ?? false } : undefined;
  });
}
