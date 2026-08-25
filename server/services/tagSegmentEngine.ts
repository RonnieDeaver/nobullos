// @db-pool-intent: ambient
/**
 * Task #4329 — tags & segments evaluation engine.
 *
 * ONE convergence engine behind every evaluation surface:
 *   - on-write single-record evaluation (`evaluateRecordWriteSafe`) awaited
 *     inline by deal/client/contact write routes — failures are logged and
 *     swallowed (a tagging hiccup must never fail the user's write; the
 *     sweep heals),
 *   - on-demand full evaluation of one definition (`evaluateTagFully` /
 *     `evaluateSegmentFully`) — run synchronously on create/criteria-edit
 *     and via POST /api/segments/:id/recompute,
 *   - the periodic reconciliation sweep (`runTagSegmentReconciliation`),
 *     driven by the `tag_segment_reconcile` work-queue job.
 *
 * Ownership contract (see shared/models/tagsSegments.ts): the engine only
 * ever writes `source='rule'` join rows. Manual rows are operator
 * statements — inserts collide into them harmlessly (ON CONFLICT DO
 * NOTHING on the UNIQUE(record, tag) composite; P1 dup-key-storm-safe) and
 * deletes always filter `source='rule'`.
 *
 * Pool intent is ambient: routes call this in API-request context; the
 * work-queue handler runs it inside the scheduler's worker-pool context.
 * Every DB touch is lexically inside its own `withDbAttribution` label.
 *
 * No module-global state (deliberate — definitions are re-read per
 * evaluation, so there is no cache to go stale or to reset between tests).
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  clientContacts,
  clients,
  clientTags,
  dealStages,
  deals,
  dealTags,
  segmentMembers,
  segments,
  tags,
  type ClientContact,
  type Segment,
  type Tag,
} from "@shared/schema";
import {
  evaluateCriteriaSet,
  type CriteriaRecord,
  type SegmentEntityType,
  type TagEntityType,
} from "@shared/criteria";
import { getDb, withDbAttribution } from "../db";
import { setSystemSetting } from "../storage/settingsStorage";

export const TAG_SEGMENT_RECONCILE_QUEUE = "tag_segment_reconcile";
export const TAG_SEGMENT_SWEEP_STATUS_SETTING = "tags_segments_sweep_status";

/** Records per keyset page while scanning an entity population. */
const RECORD_BATCH_SIZE = 500;
/** Ids per INSERT/DELETE statement while writing diffs. */
const WRITE_CHUNK_SIZE = 500;
/** Definitions per sweep — a cap, not a page (well above realistic use). */
const DEFINITION_SCAN_LIMIT = 500;

// ── Record extraction ────────────────────────────────────────────────────────
// Keys MUST match shared/criteria.ts registries (asserted in
// tests/tags-segments.test.ts). Extending a registry means extending the
// matching extractor here in the same change.

type DealEvalRow = Pick<
  typeof deals.$inferSelect,
  | "id"
  | "name"
  | "amount"
  | "expectedCloseDate"
  | "lostReason"
  | "clientId"
  | "isArchived"
  | "createdAt"
> & { stageName: string | null };

export function dealToCriteriaRecord(row: DealEvalRow): CriteriaRecord {
  return {
    name: row.name,
    amount: row.amount,
    stage_name: row.stageName,
    expected_close_date: row.expectedCloseDate,
    lost_reason: row.lostReason,
    has_client: row.clientId !== null && row.clientId !== undefined,
    is_archived: row.isArchived,
    created_at: row.createdAt,
  };
}

type ClientEvalRow = Pick<
  typeof clients.$inferSelect,
  | "id"
  | "firmName"
  | "contactName"
  | "contactEmail"
  | "consultType"
  | "practiceAreas"
  | "products"
  | "averageCaseValue"
  | "monthlyReviewTarget"
  | "isDemo"
  | "isArchived"
  | "clientStartDate"
  | "createdAt"
>;

export function clientToCriteriaRecord(row: ClientEvalRow): CriteriaRecord {
  return {
    firm_name: row.firmName,
    contact_name: row.contactName,
    contact_email: row.contactEmail,
    consult_type: row.consultType,
    practice_areas: row.practiceAreas ?? [],
    products: row.products ?? [],
    average_case_value: row.averageCaseValue,
    monthly_review_target: row.monthlyReviewTarget,
    is_demo: row.isDemo,
    is_archived: row.isArchived,
    client_start_date: row.clientStartDate,
    created_at: row.createdAt,
  };
}

export function contactToCriteriaRecord(
  row: Pick<
    ClientContact,
    "id" | "name" | "emails" | "phones" | "roleTitle" | "isPrimary" | "createdAt"
  >,
): CriteriaRecord {
  return {
    name: row.name,
    emails: row.emails ?? [],
    phones: row.phones ?? [],
    role_title: row.roleTitle,
    is_primary: row.isPrimary,
    created_at: row.createdAt,
  };
}

// ── Population loaders (keyset-paged; bounded batches, no long tx) ──────────

interface EvalRecord {
  id: string;
  record: CriteriaRecord;
}

const DEAL_EVAL_COLUMNS = {
  id: deals.id,
  name: deals.name,
  amount: deals.amount,
  expectedCloseDate: deals.expectedCloseDate,
  lostReason: deals.lostReason,
  clientId: deals.clientId,
  isArchived: deals.isArchived,
  createdAt: deals.createdAt,
  stageName: dealStages.name,
} as const;

async function loadDealPopulation(): Promise<EvalRecord[]> {
  return withDbAttribution("tagseg:load-deals", async () => {
    const db = getDb();
    const out: EvalRecord[] = [];
    let cursor = "";
    for (;;) {
      const batch = await db
        .select(DEAL_EVAL_COLUMNS)
        .from(deals)
        .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(gt(deals.id, cursor))
        .orderBy(asc(deals.id))
        .limit(RECORD_BATCH_SIZE);
      for (const row of batch) {
        out.push({ id: row.id, record: dealToCriteriaRecord(row) });
      }
      if (batch.length < RECORD_BATCH_SIZE) return out;
      cursor = batch[batch.length - 1].id;
    }
  });
}

const CLIENT_EVAL_COLUMNS = {
  id: clients.id,
  firmName: clients.firmName,
  contactName: clients.contactName,
  contactEmail: clients.contactEmail,
  consultType: clients.consultType,
  practiceAreas: clients.practiceAreas,
  products: clients.products,
  averageCaseValue: clients.averageCaseValue,
  monthlyReviewTarget: clients.monthlyReviewTarget,
  isDemo: clients.isDemo,
  isArchived: clients.isArchived,
  clientStartDate: clients.clientStartDate,
  createdAt: clients.createdAt,
} as const;

async function loadClientPopulation(): Promise<EvalRecord[]> {
  return withDbAttribution("tagseg:load-clients", async () => {
    const db = getDb();
    const out: EvalRecord[] = [];
    let cursor = "";
    for (;;) {
      const batch = await db
        .select(CLIENT_EVAL_COLUMNS)
        .from(clients)
        .where(gt(clients.id, cursor))
        .orderBy(asc(clients.id))
        .limit(RECORD_BATCH_SIZE);
      for (const row of batch) {
        out.push({ id: row.id, record: clientToCriteriaRecord(row) });
      }
      if (batch.length < RECORD_BATCH_SIZE) return out;
      cursor = batch[batch.length - 1].id;
    }
  });
}

const CONTACT_EVAL_COLUMNS = {
  id: clientContacts.id,
  name: clientContacts.name,
  emails: clientContacts.emails,
  phones: clientContacts.phones,
  roleTitle: clientContacts.roleTitle,
  isPrimary: clientContacts.isPrimary,
  createdAt: clientContacts.createdAt,
} as const;

async function loadContactPopulation(): Promise<EvalRecord[]> {
  return withDbAttribution("tagseg:load-contacts", async () => {
    const db = getDb();
    const out: EvalRecord[] = [];
    let cursor = "";
    for (;;) {
      const batch = await db
        .select(CONTACT_EVAL_COLUMNS)
        .from(clientContacts)
        .where(gt(clientContacts.id, cursor))
        .orderBy(asc(clientContacts.id))
        .limit(RECORD_BATCH_SIZE);
      for (const row of batch) {
        out.push({ id: row.id, record: contactToCriteriaRecord(row) });
      }
      if (batch.length < RECORD_BATCH_SIZE) return out;
      cursor = batch[batch.length - 1].id;
    }
  });
}

async function loadSegmentPopulation(
  entityType: SegmentEntityType,
): Promise<EvalRecord[]> {
  return entityType === "client" ? loadClientPopulation() : loadContactPopulation();
}

/** Single-record loaders for the on-write path. null = record gone. */
async function loadOneDealRecord(id: string): Promise<CriteriaRecord | null> {
  return withDbAttribution("tagseg:load-one-deal", async () => {
    const db = getDb();
    const [row] = await db
      .select(DEAL_EVAL_COLUMNS)
      .from(deals)
      .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(eq(deals.id, id))
      .limit(1);
    return row ? dealToCriteriaRecord(row) : null;
  });
}

async function loadOneClientRecord(id: string): Promise<CriteriaRecord | null> {
  return withDbAttribution("tagseg:load-one-client", async () => {
    const db = getDb();
    const [row] = await db
      .select(CLIENT_EVAL_COLUMNS)
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1);
    return row ? clientToCriteriaRecord(row) : null;
  });
}

async function loadOneContactRecord(id: string): Promise<CriteriaRecord | null> {
  return withDbAttribution("tagseg:load-one-contact", async () => {
    const db = getDb();
    const [row] = await db
      .select(CONTACT_EVAL_COLUMNS)
      .from(clientContacts)
      .where(eq(clientContacts.id, id))
      .limit(1);
    return row ? contactToCriteriaRecord(row) : null;
  });
}

// ── Join-table plumbing ──────────────────────────────────────────────────────

function tagJoinFor(entityType: TagEntityType) {
  return entityType === "deal"
    ? { table: dealTags, entityCol: dealTags.dealId, tagCol: dealTags.tagId, sourceCol: dealTags.source }
    : { table: clientTags, entityCol: clientTags.clientId, tagCol: clientTags.tagId, sourceCol: clientTags.source };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Insert rule rows (chunked, dup-safe). Returns attempted-add count. */
async function insertRuleRows(
  entityType: TagEntityType,
  tagId: string,
  entityIds: string[],
): Promise<number> {
  if (entityIds.length === 0) return 0;
  return withDbAttribution("tagseg:insert-rule-rows", async () => {
    const db = getDb();
    let added = 0;
    for (const ids of chunk(entityIds, WRITE_CHUNK_SIZE)) {
      if (entityType === "deal") {
        const inserted = await db
          .insert(dealTags)
          .values(ids.map((dealId) => ({ dealId, tagId, source: "rule" as const })))
          .onConflictDoNothing()
          .returning({ id: dealTags.id });
        added += inserted.length;
      } else {
        const inserted = await db
          .insert(clientTags)
          .values(ids.map((clientId) => ({ clientId, tagId, source: "rule" as const })))
          .onConflictDoNothing()
          .returning({ id: clientTags.id });
        added += inserted.length;
      }
    }
    return added;
  });
}

/** Delete rule rows for (tag, entities) — never touches manual rows. */
async function deleteRuleRows(
  entityType: TagEntityType,
  tagId: string,
  entityIds: string[],
): Promise<number> {
  if (entityIds.length === 0) return 0;
  return withDbAttribution("tagseg:delete-rule-rows", async () => {
    const db = getDb();
    const join = tagJoinFor(entityType);
    let removed = 0;
    for (const ids of chunk(entityIds, WRITE_CHUNK_SIZE)) {
      const deleted = await db
        .delete(join.table)
        .where(
          and(
            eq(join.tagCol, tagId),
            eq(join.sourceCol, "rule"),
            inArray(join.entityCol, ids),
          ),
        )
        .returning({ id: join.table.id });
      removed += deleted.length;
    }
    return removed;
  });
}

// ── Full-definition evaluation ───────────────────────────────────────────────

export interface TagEvalResult {
  added: number;
  removed: number;
  matched: number;
}

/**
 * Reconcile one tag's rule rows against a (pre-loaded or freshly loaded)
 * population. Criteria-less tags converge to zero rule rows — removing
 * criteria from a tag demotes every rule row it had.
 */
export async function evaluateTagFully(
  tag: Tag,
  population?: EvalRecord[],
): Promise<TagEvalResult> {
  const records =
    population ??
    (tag.entityType === "deal" ? await loadDealPopulation() : await loadClientPopulation());

  const criteria = tag.criteria;
  const matchingIds = new Set<string>();
  if (criteria) {
    for (const { id, record } of records) {
      if (evaluateCriteriaSet(criteria, record)) matchingIds.add(id);
    }
  }

  const existing = await withDbAttribution("tagseg:read-tag-rows", async () => {
    const db = getDb();
    const join = tagJoinFor(tag.entityType);
    return db
      .select({ entityId: join.entityCol, source: join.sourceCol })
      .from(join.table)
      .where(eq(join.tagCol, tag.id));
  });

  const existingAny = new Set(existing.map((r) => r.entityId));
  const toAdd = [...matchingIds].filter((id) => !existingAny.has(id));
  const toRemove = existing
    .filter((r) => r.source === "rule" && !matchingIds.has(r.entityId))
    .map((r) => r.entityId);

  const added = await insertRuleRows(tag.entityType, tag.id, toAdd);
  const removed = await deleteRuleRows(tag.entityType, tag.id, toRemove);

  await withDbAttribution("tagseg:stamp-tag", async () => {
    const db = getDb();
    await db
      .update(tags)
      .set({ lastEvaluatedAt: new Date() })
      .where(eq(tags.id, tag.id));
  });

  return { added, removed, matched: matchingIds.size };
}

export interface SegmentEvalResult {
  memberCount: number;
  added: number;
  removed: number;
}

/**
 * Recompute one segment's cached membership from live records. The diff
 * against existing rows also reaps orphans (deleted entities can't appear
 * in the live population).
 */
export async function evaluateSegmentFully(
  segment: Segment,
  population?: EvalRecord[],
): Promise<SegmentEvalResult> {
  const records = population ?? (await loadSegmentPopulation(segment.entityType));

  const matchingIds = new Set<string>();
  for (const { id, record } of records) {
    if (evaluateCriteriaSet(segment.criteria, record)) matchingIds.add(id);
  }

  const existing = await withDbAttribution("tagseg:read-members", async () => {
    const db = getDb();
    return db
      .select({ entityId: segmentMembers.entityId })
      .from(segmentMembers)
      .where(eq(segmentMembers.segmentId, segment.id));
  });
  const existingIds = new Set(existing.map((r) => r.entityId));

  const toAdd = [...matchingIds].filter((id) => !existingIds.has(id));
  const toRemove = [...existingIds].filter((id) => !matchingIds.has(id));

  let added = 0;
  let removed = 0;
  await withDbAttribution("tagseg:write-members", async () => {
    const db = getDb();
    for (const ids of chunk(toAdd, WRITE_CHUNK_SIZE)) {
      const inserted = await db
        .insert(segmentMembers)
        .values(ids.map((entityId) => ({ segmentId: segment.id, entityId })))
        .onConflictDoNothing()
        .returning({ id: segmentMembers.id });
      added += inserted.length;
    }
    for (const ids of chunk(toRemove, WRITE_CHUNK_SIZE)) {
      const deleted = await db
        .delete(segmentMembers)
        .where(
          and(
            eq(segmentMembers.segmentId, segment.id),
            inArray(segmentMembers.entityId, ids),
          ),
        )
        .returning({ id: segmentMembers.id });
      removed += deleted.length;
    }
    await db
      .update(segments)
      .set({ memberCount: matchingIds.size, lastEvaluatedAt: new Date() })
      .where(eq(segments.id, segment.id));
  });

  return { memberCount: matchingIds.size, added, removed };
}

// ── On-write single-record evaluation ────────────────────────────────────────

async function evaluateTagsForRecord(
  entityType: TagEntityType,
  recordId: string,
  record: CriteriaRecord,
): Promise<void> {
  const ruleTags = await withDbAttribution("tagseg:read-rule-tags", async () => {
    const db = getDb();
    return db
      .select()
      .from(tags)
      .where(and(eq(tags.entityType, entityType), sql`${tags.criteria} IS NOT NULL`))
      .limit(DEFINITION_SCAN_LIMIT);
  });
  for (const tag of ruleTags) {
    if (!tag.criteria) continue;
    const matches = evaluateCriteriaSet(tag.criteria, record);
    if (matches) {
      await insertRuleRows(entityType, tag.id, [recordId]);
    } else {
      await deleteRuleRows(entityType, tag.id, [recordId]);
    }
  }
}

async function evaluateSegmentsForRecord(
  entityType: SegmentEntityType,
  recordId: string,
  record: CriteriaRecord,
): Promise<void> {
  const defs = await withDbAttribution("tagseg:read-segments", async () => {
    const db = getDb();
    return db
      .select()
      .from(segments)
      .where(eq(segments.entityType, entityType))
      .limit(DEFINITION_SCAN_LIMIT);
  });
  for (const segment of defs) {
    const matches = evaluateCriteriaSet(segment.criteria, record);
    const changed = await withDbAttribution("tagseg:write-one-member", async () => {
      const db = getDb();
      if (matches) {
        const inserted = await db
          .insert(segmentMembers)
          .values({ segmentId: segment.id, entityId: recordId })
          .onConflictDoNothing()
          .returning({ id: segmentMembers.id });
        return inserted.length > 0;
      }
      const deleted = await db
        .delete(segmentMembers)
        .where(
          and(
            eq(segmentMembers.segmentId, segment.id),
            eq(segmentMembers.entityId, recordId),
          ),
        )
        .returning({ id: segmentMembers.id });
      return deleted.length > 0;
    });
    if (changed) {
      await withDbAttribution("tagseg:refresh-member-count", async () => {
        const db = getDb();
        await db
          .update(segments)
          .set({
            memberCount: sql`(SELECT COUNT(*)::int FROM ${segmentMembers} WHERE ${segmentMembers.segmentId} = ${segment.id})`,
          })
          .where(eq(segments.id, segment.id));
      });
    }
  }
}

export type WriteEvalEntityType = "deal" | "client" | "contact";

/**
 * On-write hook: re-evaluate ONE record against every rule definition for
 * its entity type. Awaited inline by write routes; never throws — a
 * tagging failure must not fail the user's write (the sweep heals drift).
 * Deliberately does NOT stamp definition-level lastEvaluatedAt (that
 * belongs to full-population evaluations only).
 */
export async function evaluateRecordWriteSafe(
  entityType: WriteEvalEntityType,
  recordId: string,
): Promise<void> {
  try {
    if (entityType === "deal") {
      const record = await loadOneDealRecord(recordId);
      if (!record) return; // deleted — cascades already cleaned join rows
      await evaluateTagsForRecord("deal", recordId, record);
    } else if (entityType === "client") {
      const record = await loadOneClientRecord(recordId);
      if (!record) return;
      await evaluateTagsForRecord("client", recordId, record);
      await evaluateSegmentsForRecord("client", recordId, record);
    } else {
      const record = await loadOneContactRecord(recordId);
      if (!record) return;
      await evaluateSegmentsForRecord("contact", recordId, record);
    }
  } catch (err: any) {
    console.error(
      `[TagSegment] on-write evaluation failed for ${entityType} ${recordId}:`,
      err?.message ?? err,
    );
  }
}

/**
 * Inline membership prune when a client/contact is deleted (their
 * segment_members rows have no FK — see shared/models/tagsSegments.ts).
 * Best-effort: the sweep and every full recompute also reap orphans.
 */
export async function pruneSegmentMembershipSafe(entityId: string): Promise<void> {
  try {
    await withDbAttribution("tagseg:prune-membership", async () => {
      const db = getDb();
      const deleted = await db
        .delete(segmentMembers)
        .where(eq(segmentMembers.entityId, entityId))
        .returning({ segmentId: segmentMembers.segmentId });
      const touched = [...new Set(deleted.map((r) => r.segmentId))];
      for (const segmentId of touched) {
        await db
          .update(segments)
          .set({
            memberCount: sql`(SELECT COUNT(*)::int FROM ${segmentMembers} WHERE ${segmentMembers.segmentId} = ${segmentId})`,
          })
          .where(eq(segments.id, segmentId));
      }
    });
  } catch (err: any) {
    console.error(
      `[TagSegment] membership prune failed for entity ${entityId}:`,
      err?.message ?? err,
    );
  }
}

// ── Periodic reconciliation sweep ────────────────────────────────────────────

export interface TagSegmentSweepSummary {
  startedAt: string;
  durationMs: number;
  tagsEvaluated: number;
  segmentsEvaluated: number;
  tagRowsAdded: number;
  tagRowsRemoved: number;
  membersAdded: number;
  membersRemoved: number;
  orphansPruned: number;
  errors: string[];
}

/**
 * Full reconciliation: every rule tag and every segment converges to its
 * criteria; orphaned membership rows (entities deleted since the last
 * pass) are reaped even when their segment's evaluation failed. Pure
 * convergence — re-running after a crash/replay lands on the same state
 * (P5: no step chaining to guard).
 */
export async function runTagSegmentReconciliation(): Promise<TagSegmentSweepSummary> {
  const startedAtMs = Date.now();
  const summary: TagSegmentSweepSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    tagsEvaluated: 0,
    segmentsEvaluated: 0,
    tagRowsAdded: 0,
    tagRowsRemoved: 0,
    membersAdded: 0,
    membersRemoved: 0,
    orphansPruned: 0,
    errors: [],
  };

  const allTags = await withDbAttribution("tagseg:sweep-read-tags", async () => {
    const db = getDb();
    return db.select().from(tags).limit(DEFINITION_SCAN_LIMIT);
  });
  const allSegments = await withDbAttribution("tagseg:sweep-read-segments", async () => {
    const db = getDb();
    return db.select().from(segments).limit(DEFINITION_SCAN_LIMIT);
  });

  // Load each population at most once per sweep, and only when needed.
  const ruleTags = allTags.filter((t) => t.criteria !== null);
  const populations = new Map<"deal" | "client" | "contact", EvalRecord[]>();
  const need = (k: "deal" | "client" | "contact") =>
    populations.has(k)
      ? Promise.resolve(populations.get(k)!)
      : (k === "deal"
          ? loadDealPopulation()
          : k === "client"
            ? loadClientPopulation()
            : loadContactPopulation()
        ).then((records) => {
          populations.set(k, records);
          return records;
        });

  for (const tag of ruleTags) {
    try {
      const population = await need(tag.entityType);
      const result = await evaluateTagFully(tag, population);
      summary.tagsEvaluated += 1;
      summary.tagRowsAdded += result.added;
      summary.tagRowsRemoved += result.removed;
    } catch (err: any) {
      summary.errors.push(`tag ${tag.name}: ${err?.message ?? String(err)}`);
    }
  }

  // Criteria-less tags own ZERO rule rows. The PATCH route demotes them on
  // criteria removal, but the sweep must also converge any drift (crashed
  // demotion, hand-planted rows) — no population scan needed for a bare
  // source='rule' delete.
  for (const tag of allTags.filter((t) => t.criteria === null)) {
    try {
      const removed = await withDbAttribution("tagseg:reap-manual-tag-rule-rows", async () => {
        const db = getDb();
        const join = tagJoinFor(tag.entityType);
        const rows = await db
          .delete(join.table)
          .where(and(eq(join.tagCol, tag.id), eq(join.sourceCol, "rule")))
          .returning({ id: join.entityCol });
        return rows.length;
      });
      summary.tagRowsRemoved += removed;
    } catch (err: any) {
      summary.errors.push(`tag ${tag.name} (rule-row reap): ${err?.message ?? String(err)}`);
    }
  }

  for (const segment of allSegments) {
    try {
      const population = await need(segment.entityType);
      const result = await evaluateSegmentFully(segment, population);
      summary.segmentsEvaluated += 1;
      summary.membersAdded += result.added;
      summary.membersRemoved += result.removed;
    } catch (err: any) {
      summary.errors.push(`segment ${segment.name}: ${err?.message ?? String(err)}`);
    }
  }

  // Safety-net orphan reap (covers rows whose segment evaluation errored).
  try {
    summary.orphansPruned = await withDbAttribution("tagseg:orphan-reap", async () => {
      const db = getDb();
      const clientOrphans = await db.execute(sql`
        DELETE FROM ${segmentMembers}
        USING ${segments}
        WHERE ${segmentMembers.segmentId} = ${segments.id}
          AND ${segments.entityType} = 'client'
          AND NOT EXISTS (
            SELECT 1 FROM ${clients} WHERE ${clients.id} = ${segmentMembers.entityId}
          )
      `);
      const contactOrphans = await db.execute(sql`
        DELETE FROM ${segmentMembers}
        USING ${segments}
        WHERE ${segmentMembers.segmentId} = ${segments.id}
          AND ${segments.entityType} = 'contact'
          AND NOT EXISTS (
            SELECT 1 FROM ${clientContacts} WHERE ${clientContacts.id} = ${segmentMembers.entityId}
          )
      `);
      return (clientOrphans.rowCount ?? 0) + (contactOrphans.rowCount ?? 0);
    });
  } catch (err: any) {
    summary.errors.push(`orphan reap: ${err?.message ?? String(err)}`);
  }

  summary.durationMs = Date.now() - startedAtMs;

  // Best-effort status stamp for the admin view; never fails the sweep.
  // updatedBy stays undefined — background writes have no acting user
  // (system_settings.updated_by is a users FK; markers would 23503).
  try {
    await setSystemSetting(
      TAG_SEGMENT_SWEEP_STATUS_SETTING,
      JSON.stringify(summary),
      undefined,
    );
  } catch (err: any) {
    console.warn(
      "[TagSegment] failed to record sweep status:",
      err?.message ?? err,
    );
  }

  return summary;
}
