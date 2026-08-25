// @db-pool-intent: ambient
//
// Task #4327 — storage helpers for the deals pipeline (deal_pipelines,
// deal_stages, deals, deal_contacts, deal_stage_history). All callers are
// request-scoped routes, so every getDb() here lands on the ambient api
// pool. See scripts/lint-db-pool-tenancy.ts for the contract.
//
// Invariants owned here:
//   - deals.stage_id changes ONLY through moveDealStage(), which writes the
//     deal update and its deal_stage_history row in ONE transaction — a
//     stage transition can never exist without its history entry.
//   - Required-fields-on-entry: moveDealStage() re-checks the target stage's
//     requiredFields against the deal AFTER overlaying the caller-provided
//     values and throws MissingRequiredFieldsError listing what is still
//     missing (routes map it to 422 so the UI can prompt).
//   - Seeding: ensureDefaultDealPipelineSeeded() is the production seed path
//     (Publish diffs are structure-only, so the migration's INSERTs never
//     reach prod). Single-flight latch + ON CONFLICT DO NOTHING, mirroring
//     ensureRoadmapValueSetsSeeded in server/routes/roadmap.ts; a failure
//     clears the latch so the next request retries loudly.

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  dealContacts,
  dealPipelines,
  dealRequiredFieldKeys,
  dealSeedPipeline,
  dealSeedStages,
  dealStageEvents,
  dealStageHistory,
  dealStages,
  deals,
  clientContacts,
  clients,
  entityScores,
  users,
  type Deal,
  type DealPipeline,
  type DealRequiredFieldKey,
  type DealStage,
  type DealStageHistoryEntry,
  type ScoreBreakdownEntry,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { advanceClientLifecycle } from "./leadLifecycleStorage";

/**
 * Task #4330 — deal events drive the account lifecycle: a deal attached to
 * a client advances it to 'opportunity' (or straight to 'customer' when the
 * deal lands in a won stage). Lives at the STORAGE layer so every caller —
 * routes today, the automation rules engine later — inherits the semantics.
 *
 * Runs AFTER the deal transaction commits: the advance is forward-only and
 * idempotent, so a failure here only delays the lifecycle until the next
 * event; throwing would misreport an already-committed deal write. Logged
 * loudly instead.
 */
async function advanceLifecycleForDealEvent(
  clientId: string | null,
  stageType: DealStage["stageType"],
  actorUserId: string | null,
  event: "deal_created" | "deal_won" | "deal_linked",
): Promise<void> {
  if (!clientId) return;
  try {
    if (stageType === "won") {
      await advanceClientLifecycle(clientId, "customer", {
        source: "deal_won",
        actorUserId,
      });
    } else {
      await advanceClientLifecycle(clientId, "opportunity", {
        source: "deal_created",
        actorUserId,
      });
    }
  } catch (err: any) {
    console.error(
      `[DealsLifecycle] lifecycle advance failed (event=${event}, client=${clientId}): ${err?.message || err}`,
    );
  }
}

/** Board list hard bound (Impact Review §9) — revisit if a pipeline nears it. */
export const DEAL_BOARD_LIMIT = 1000;
/** Stage-history read bound; history is tiny but every list gets a limit. */
export const DEAL_HISTORY_LIMIT = 200;

// ── Errors (routes map these to 4xx) ────────────────────────────────────────

export class MissingRequiredFieldsError extends Error {
  constructor(public readonly missingFields: DealRequiredFieldKey[]) {
    super(`Missing required fields: ${missingFields.join(", ")}`);
    this.name = "MissingRequiredFieldsError";
  }
}

export class StageMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageMismatchError";
  }
}

export class ContactClientMismatchError extends Error {
  constructor() {
    super("Contacts must belong to the deal's client");
    this.name = "ContactClientMismatchError";
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

let dealSeedPromise: Promise<void> | null = null;
export function ensureDefaultDealPipelineSeeded(): Promise<void> {
  if (!dealSeedPromise) {
    dealSeedPromise = (async () => {
      await withDbAttribution("deals:ensureSeed", async () => {
        const db = getDb();
        await db
          .insert(dealPipelines)
          .values({ ...dealSeedPipeline }) // spread-write-approved: compile-time seed constant from shared/models/deals.ts — no request data can reach this
          .onConflictDoNothing({ target: dealPipelines.slug });
        const [pipeline] = await db
          .select({ id: dealPipelines.id })
          .from(dealPipelines)
          .where(eq(dealPipelines.slug, dealSeedPipeline.slug))
          .limit(1);
        if (!pipeline) throw new Error("Default deal pipeline seed missing after insert");
        await db
          .insert(dealStages)
          .values(
            dealSeedStages.map((s) => ({
              pipelineId: pipeline.id,
              slug: s.slug,
              name: s.name,
              position: s.position,
              winProbability: s.winProbability,
              stageType: s.stageType,
              requiredFields: [...s.requiredFields],
            })),
          )
          .onConflictDoNothing({
            target: [dealStages.pipelineId, dealStages.slug],
          });
      });
    })().catch((err) => {
      dealSeedPromise = null;
      throw err;
    });
  }
  return dealSeedPromise;
}

// ── Pipelines & stages ───────────────────────────────────────────────────────

export interface PipelineWithStages extends DealPipeline {
  stages: DealStage[];
}

export async function listPipelinesWithStages(): Promise<PipelineWithStages[]> {
  return withDbAttribution("deals:listPipelines", async () => {
    const db = getDb();
    const pipelines = await db
      .select()
      .from(dealPipelines)
      .orderBy(asc(dealPipelines.position), asc(dealPipelines.createdAt));
    if (pipelines.length === 0) return [];
    const stages = await db
      .select()
      .from(dealStages)
      .where(inArray(dealStages.pipelineId, pipelines.map((p) => p.id)))
      .orderBy(asc(dealStages.position), asc(dealStages.createdAt));
    return pipelines.map((p) => ({
      ...p,
      stages: stages.filter((s) => s.pipelineId === p.id),
    }));
  });
}

export async function getPipeline(id: string): Promise<DealPipeline | undefined> {
  return withDbAttribution("deals:getPipeline", async () => {
    const [row] = await getDb()
      .select()
      .from(dealPipelines)
      .where(eq(dealPipelines.id, id))
      .limit(1);
    return row;
  });
}

export async function getDefaultPipeline(): Promise<DealPipeline | undefined> {
  return withDbAttribution("deals:getDefaultPipeline", async () => {
    const rows = await getDb()
      .select()
      .from(dealPipelines)
      .orderBy(desc(dealPipelines.isDefault), asc(dealPipelines.position))
      .limit(1);
    return rows[0];
  });
}

export async function getStage(id: string): Promise<DealStage | undefined> {
  return withDbAttribution("deals:getStage", async () => {
    const [row] = await getDb()
      .select()
      .from(dealStages)
      .where(eq(dealStages.id, id))
      .limit(1);
    return row;
  });
}

export async function createStage(input: {
  pipelineId: string;
  name: string;
  winProbability: number;
  stageType: DealStage["stageType"];
  requiredFields?: DealRequiredFieldKey[];
  position?: number;
}): Promise<DealStage> {
  return withDbAttribution("deals:createStage", async () => {
    const db = getDb();
    const slugBase = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "stage";
    return db.transaction(async (tx) => {
      const [{ maxPosition }] = await tx
        .select({ maxPosition: sql<number>`coalesce(max(${dealStages.position}), 0)` })
        .from(dealStages)
        .where(eq(dealStages.pipelineId, input.pipelineId));
      // Unique (pipeline_id, slug): suffix with a short random tail on
      // collision instead of failing the operator.
      const existing = await tx
        .select({ slug: dealStages.slug })
        .from(dealStages)
        .where(eq(dealStages.pipelineId, input.pipelineId));
      const taken = new Set(existing.map((r) => r.slug));
      let slug = slugBase;
      while (taken.has(slug)) {
        slug = `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
      }
      const [stage] = await tx
        .insert(dealStages)
        .values({
          pipelineId: input.pipelineId,
          slug,
          name: input.name,
          position: input.position ?? maxPosition + 1,
          winProbability: input.winProbability,
          stageType: input.stageType,
          requiredFields: input.requiredFields ?? [],
        })
        .returning();
      return stage;
    });
  });
}

export async function updateStage(
  id: string,
  patch: Partial<{
    name: string;
    winProbability: number;
    stageType: DealStage["stageType"];
    requiredFields: DealRequiredFieldKey[];
    position: number;
  }>,
): Promise<DealStage | undefined> {
  return withDbAttribution("deals:updateStage", async () => {
    const [row] = await getDb()
      .update(dealStages)
      .set({ ...patch, updatedAt: new Date() }) // spread-write-approved: patch is zod-parsed updateDealStageBodySchema output (stage-config columns only; no ownership/audit fields in the schema)
      .where(eq(dealStages.id, id))
      .returning();
    return row;
  });
}

// ── Deals ────────────────────────────────────────────────────────────────────

export interface DealListItem extends Deal {
  clientFirmName: string | null;
  ownerName: string | null;
  stageName: string | null;
  contactIds: string[];
  // Task #4333 — deterministic fit+engagement score (null until first compute).
  score: number | null;
  fitScore: number | null;
  engagementScore: number | null;
  scoreComputedAt: Date | null;
}

interface ListDealsOptions {
  /** Board scope. At least one of pipelineId/clientId must be provided. */
  pipelineId?: string;
  /** When set, only deals owned by this user (sales-role scoping). */
  ownerId?: string;
  clientId?: string;
  includeArchived?: boolean;
}

export async function listDeals(opts: ListDealsOptions): Promise<DealListItem[]> {
  if (!opts.pipelineId && !opts.clientId) {
    throw new Error("listDeals requires pipelineId or clientId");
  }
  return withDbAttribution("deals:list", async () => {
    const db = getDb();
    const conditions: SQL[] = [];
    if (opts.pipelineId) conditions.push(eq(deals.pipelineId, opts.pipelineId));
    if (!opts.includeArchived) conditions.push(eq(deals.isArchived, false));
    if (opts.ownerId) conditions.push(eq(deals.ownerId, opts.ownerId));
    if (opts.clientId) conditions.push(eq(deals.clientId, opts.clientId));
    const rows = await db
      .select({
        deal: deals,
        clientFirmName: clients.firmName,
        stageName: dealStages.name,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
        ownerEmail: users.email,
        score: entityScores.score,
        fitScore: entityScores.fitScore,
        engagementScore: entityScores.engagementScore,
        scoreComputedAt: entityScores.computedAt,
      })
      .from(deals)
      .leftJoin(clients, eq(deals.clientId, clients.id))
      .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
      .leftJoin(users, eq(deals.ownerId, users.id))
      .leftJoin(
        entityScores,
        and(eq(entityScores.entityType, "deal"), eq(entityScores.entityId, deals.id)),
      )
      .where(and(...conditions))
      .orderBy(desc(deals.createdAt))
      .limit(DEAL_BOARD_LIMIT);
    const dealIds = rows.map((r) => r.deal.id);
    const contactRows = dealIds.length
      ? await db
          .select({ dealId: dealContacts.dealId, contactId: dealContacts.contactId })
          .from(dealContacts)
          .where(inArray(dealContacts.dealId, dealIds))
      : [];
    const contactsByDeal = new Map<string, string[]>();
    for (const c of contactRows) {
      const list = contactsByDeal.get(c.dealId) ?? [];
      list.push(c.contactId);
      contactsByDeal.set(c.dealId, list);
    }
    return rows.map((r) => ({
      ...r.deal,
      clientFirmName: r.clientFirmName ?? null,
      stageName: r.stageName ?? null,
      ownerName: formatUserName(r.ownerFirstName, r.ownerLastName, r.ownerEmail),
      contactIds: contactsByDeal.get(r.deal.id) ?? [],
      score: r.score ?? null,
      fitScore: r.fitScore ?? null,
      engagementScore: r.engagementScore ?? null,
      scoreComputedAt: r.scoreComputedAt ?? null,
    }));
  });
}

function formatUserName(
  first: string | null,
  last: string | null,
  email: string | null,
): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || email || null;
}

export interface DealDetail extends Deal {
  clientFirmName: string | null;
  ownerName: string | null;
  createdByName: string | null;
  contacts: { id: string; name: string; roleTitle: string | null; isPrimary: boolean }[];
  history: (DealStageHistoryEntry & {
    fromStageName: string | null;
    toStageName: string | null;
    movedByName: string | null;
  })[];
  // Task #4333 — score with component breakdown (null until first compute).
  score: number | null;
  fitScore: number | null;
  engagementScore: number | null;
  scoreBreakdown: ScoreBreakdownEntry[] | null;
  scoreComputedAt: Date | null;
}

export async function getDealDetail(id: string): Promise<DealDetail | undefined> {
  return withDbAttribution("deals:getDetail", async () => {
    const db = getDb();
    const [row] = await db
      .select({
        deal: deals,
        clientFirmName: clients.firmName,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
        ownerEmail: users.email,
      })
      .from(deals)
      .leftJoin(clients, eq(deals.clientId, clients.id))
      .leftJoin(users, eq(deals.ownerId, users.id))
      .where(eq(deals.id, id))
      .limit(1);
    if (!row) return undefined;

    const contacts = await db
      .select({
        id: clientContacts.id,
        name: clientContacts.name,
        roleTitle: clientContacts.roleTitle,
        isPrimary: clientContacts.isPrimary,
      })
      .from(dealContacts)
      .innerJoin(clientContacts, eq(dealContacts.contactId, clientContacts.id))
      .where(eq(dealContacts.dealId, id))
      .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.name));

    const fromStage = alias(dealStages, "from_stage");
    const toStage = alias(dealStages, "to_stage");
    const history = await db
      .select({
        entry: dealStageHistory,
        fromStageName: fromStage.name,
        toStageName: toStage.name,
        movedByFirstName: users.firstName,
        movedByLastName: users.lastName,
        movedByEmail: users.email,
      })
      .from(dealStageHistory)
      .leftJoin(fromStage, eq(dealStageHistory.fromStageId, fromStage.id))
      .leftJoin(toStage, eq(dealStageHistory.toStageId, toStage.id))
      .leftJoin(users, eq(dealStageHistory.movedByUserId, users.id))
      .where(eq(dealStageHistory.dealId, id))
      .orderBy(desc(dealStageHistory.movedAt))
      .limit(DEAL_HISTORY_LIMIT);

    const [createdByRow] = row.deal.createdBy
      ? await db
          .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(eq(users.id, row.deal.createdBy))
          .limit(1)
      : [];

    // Task #4333 — score row (separate select: breakdown jsonb rides only
    // the detail view, never the board list).
    const [scoreRow] = await db
      .select()
      .from(entityScores)
      .where(and(eq(entityScores.entityType, "deal"), eq(entityScores.entityId, id)))
      .limit(1);

    return {
      ...row.deal,
      clientFirmName: row.clientFirmName ?? null,
      ownerName: formatUserName(row.ownerFirstName, row.ownerLastName, row.ownerEmail),
      createdByName: createdByRow
        ? formatUserName(createdByRow.firstName, createdByRow.lastName, createdByRow.email)
        : null,
      contacts,
      history: history.map((h) => ({
        ...h.entry,
        fromStageName: h.fromStageName ?? null,
        toStageName: h.toStageName ?? null,
        movedByName: formatUserName(h.movedByFirstName, h.movedByLastName, h.movedByEmail),
      })),
      score: scoreRow?.score ?? null,
      fitScore: scoreRow?.fitScore ?? null,
      engagementScore: scoreRow?.engagementScore ?? null,
      scoreBreakdown: scoreRow?.breakdown ?? null,
      scoreComputedAt: scoreRow?.computedAt ?? null,
    };
  });
}

export async function getDeal(id: string): Promise<Deal | undefined> {
  return withDbAttribution("deals:get", async () => {
    const [row] = await getDb().select().from(deals).where(eq(deals.id, id)).limit(1);
    return row;
  });
}

/**
 * Validates that every contact id exists and belongs to the given client.
 * Deals without a client cannot carry contacts (contacts are client-scoped).
 */
async function assertContactsBelongToClient(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  contactIds: string[],
  clientId: string | null,
): Promise<void> {
  if (contactIds.length === 0) return;
  if (!clientId) throw new ContactClientMismatchError();
  const rows = await tx
    .select({ id: clientContacts.id })
    .from(clientContacts)
    .where(
      and(
        inArray(clientContacts.id, contactIds),
        eq(clientContacts.clientId, clientId),
      ),
    );
  if (rows.length !== new Set(contactIds).size) {
    throw new ContactClientMismatchError();
  }
}

export interface CreateDealInput {
  name: string;
  pipelineId: string;
  stageId: string;
  clientId: string | null;
  contactIds: string[];
  amount: number | null;
  expectedCloseDate: string | null;
  ownerId: string | null;
  notes: string | null;
  createdBy: string;
}

/** Creates the deal, its contact links, and the creation history row atomically. */
export async function createDeal(input: CreateDealInput): Promise<Deal> {
  const { deal, stageType, eventId } = await withDbAttribution("deals:create", async () => {
    return getDb().transaction(async (tx) => {
      await assertContactsBelongToClient(tx, input.contactIds, input.clientId);
      const [stage] = await tx
        .select({ stageType: dealStages.stageType })
        .from(dealStages)
        .where(eq(dealStages.id, input.stageId))
        .limit(1);
      // Task #4337 — inherit the linked client's immutable first-touch
      // stamp at creation. Deals without a client — or for pre-feature /
      // operator-created clients whose stamps are NULL — stay NULL and
      // render as "Unknown". Never writable from request bodies.
      let firstTouchSource: string | null = null;
      let firstTouchCampaign: string | null = null;
      if (input.clientId) {
        const [touch] = await tx
          .select({
            firstTouchSource: clients.firstTouchSource,
            firstTouchCampaign: clients.firstTouchCampaign,
          })
          .from(clients)
          .where(eq(clients.id, input.clientId))
          .limit(1);
        firstTouchSource = touch?.firstTouchSource ?? null;
        firstTouchCampaign = touch?.firstTouchCampaign ?? null;
      }
      const [deal] = await tx
        .insert(deals)
        .values({
          name: input.name,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          clientId: input.clientId,
          amount: input.amount,
          expectedCloseDate: input.expectedCloseDate,
          ownerId: input.ownerId,
          notes: input.notes,
          createdBy: input.createdBy,
          firstTouchSource,
          firstTouchCampaign,
        })
        .returning();
      if (input.contactIds.length > 0) {
        await tx
          .insert(dealContacts)
          .values(input.contactIds.map((contactId) => ({ dealId: deal.id, contactId })))
          .onConflictDoNothing();
      }
      const [historyEntry] = await tx
        .insert(dealStageHistory)
        .values({
          dealId: deal.id,
          fromStageId: null,
          toStageId: input.stageId,
          movedByUserId: input.createdBy,
        })
        .returning();
      // Task #4331 — creation IS a stage entry: emit the automation event
      // in the SAME transaction as its history row (UNIQUE stage_history_id
      // keeps this exactly-once even under replays).
      const [eventRow] = await tx
        .insert(dealStageEvents)
        .values({
          stageHistoryId: historyEntry.id,
          dealId: deal.id,
          pipelineId: input.pipelineId,
          fromStageId: null,
          toStageId: input.stageId,
          movedByUserId: input.createdBy,
        })
        .onConflictDoNothing()
        .returning({ id: dealStageEvents.id });
      return { deal, stageType: stage?.stageType ?? "open", eventId: eventRow?.id ?? null };
    });
  });
  // Task #4330 — deal created for a client ⇒ lifecycle 'opportunity'
  // ('customer' when created directly in a won stage). Post-commit hook.
  await advanceLifecycleForDealEvent(deal.clientId, stageType, input.createdBy, "deal_created");
  // Task #4331 — post-commit automation kick (never throws; the pending
  // event row is the durable source of truth if the enqueue hiccups).
  await kickDealStageAutomation(eventId);
  return deal;
}

export interface UpdateDealInput {
  name?: string;
  clientId?: string | null;
  contactIds?: string[];
  amount?: number | null;
  expectedCloseDate?: string | null;
  ownerId?: string | null;
  lostReason?: string | null;
  notes?: string | null;
  isArchived?: boolean;
}

export async function updateDeal(
  id: string,
  patch: UpdateDealInput,
): Promise<Deal | undefined> {
  const result = await withDbAttribution("deals:update", async () => {
    return getDb().transaction(async (tx) => {
      const [existing] = await tx.select().from(deals).where(eq(deals.id, id)).limit(1);
      if (!existing) return undefined;
      const { contactIds, ...fields } = patch;
      const nextClientId =
        fields.clientId !== undefined ? fields.clientId : existing.clientId;
      if (contactIds !== undefined) {
        await assertContactsBelongToClient(tx, contactIds, nextClientId);
      } else if (
        fields.clientId !== undefined &&
        fields.clientId !== existing.clientId
      ) {
        // Client changed without an explicit contact list: stale contact
        // links would point at another firm's people — drop them.
        await tx.delete(dealContacts).where(eq(dealContacts.dealId, id));
      }
      // Task #4337 — adopt the client's first-touch stamp ONCE when the
      // deal gains a client link while still unstamped (upgrade-from-
      // unknown only; an existing stamp is never overwritten, and
      // unlinking never clears it).
      let adoptedTouch: {
        firstTouchSource: string | null;
        firstTouchCampaign: string | null;
      } | null = null;
      if (
        fields.clientId &&
        fields.clientId !== existing.clientId &&
        existing.firstTouchSource === null &&
        existing.firstTouchCampaign === null
      ) {
        const [touch] = await tx
          .select({
            firstTouchSource: clients.firstTouchSource,
            firstTouchCampaign: clients.firstTouchCampaign,
          })
          .from(clients)
          .where(eq(clients.id, fields.clientId))
          .limit(1);
        if (touch && (touch.firstTouchSource || touch.firstTouchCampaign)) {
          adoptedTouch = {
            firstTouchSource: touch.firstTouchSource,
            firstTouchCampaign: touch.firstTouchCampaign,
          };
        }
      }
      const [updated] = await tx
        .update(deals)
        .set({ ...fields, ...(adoptedTouch ?? {}), updatedAt: new Date() }) // spread-write-approved: fields is zod-parsed updateDealBodySchema output (stageId excluded — stage changes only via moveDealStage; no ownership/audit/sync columns in the schema); adoptedTouch is server-derived (Task #4337 adopt-once first-touch)
        .where(eq(deals.id, id))
        .returning();
      if (contactIds !== undefined) {
        await tx.delete(dealContacts).where(eq(dealContacts.dealId, id));
        if (contactIds.length > 0) {
          await tx
            .insert(dealContacts)
            .values(contactIds.map((contactId) => ({ dealId: id, contactId })))
            .onConflictDoNothing();
        }
      }
      return { updated, previousClientId: existing.clientId };
    });
  });
  if (!result) return undefined;
  // Task #4330 — a deal newly LINKED to a client is that client's
  // opportunity signal (won stage ⇒ customer). Only fires when clientId
  // transitions from null/other to a new non-null value.
  if (result.updated.clientId && result.updated.clientId !== result.previousClientId) {
    const [stage] = await withDbAttribution("deals:stageForLifecycleHook", async () =>
      getDb()
        .select({ stageType: dealStages.stageType })
        .from(dealStages)
        .where(eq(dealStages.id, result.updated.stageId))
        .limit(1),
    );
    await advanceLifecycleForDealEvent(
      result.updated.clientId,
      stage?.stageType ?? "open",
      null,
      "deal_linked",
    );
  }
  return result.updated;
}

export interface MoveDealInput {
  toStageId: string;
  /** null = system move (native trigger auto-move) — pair with movedBySource. */
  movedByUserId: string | null;
  /**
   * Task #4332 — source attribution for auto-moves. A DealTriggerType
   * (vocabulary in shared/models/dealTriggers.ts) plus the
   * deal_trigger_events row id; both land on the history row so the board
   * shows WHY a deal moved. Absent for manual moves.
   */
  movedBySource?: string;
  triggerEventId?: string;
  fields?: Partial<{
    amount: number;
    expectedCloseDate: string;
    lostReason: string;
  }>;
}

export interface MoveDealResult {
  deal: Deal;
  historyEntry: DealStageHistoryEntry;
}

/**
 * The ONLY stage-transition writer. Validates the target stage belongs to
 * the deal's pipeline, enforces required-fields-on-entry (after overlaying
 * caller-provided values), then updates the deal and appends the history
 * row in one transaction.
 */
export async function moveDealStage(
  dealId: string,
  input: MoveDealInput,
): Promise<MoveDealResult | undefined> {
  const result = await withDbAttribution("deals:move", async () => {
    return getDb().transaction(async (tx) => {
      const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).limit(1);
      if (!deal) return undefined;
      const [stage] = await tx
        .select()
        .from(dealStages)
        .where(eq(dealStages.id, input.toStageId))
        .limit(1);
      if (!stage) throw new StageMismatchError("Target stage not found");
      if (stage.pipelineId !== deal.pipelineId) {
        throw new StageMismatchError("Target stage belongs to a different pipeline");
      }

      const overlay = input.fields ?? {};
      const effective = {
        amount: overlay.amount !== undefined ? overlay.amount : deal.amount,
        expected_close_date:
          overlay.expectedCloseDate !== undefined
            ? overlay.expectedCloseDate
            : deal.expectedCloseDate,
        lost_reason:
          overlay.lostReason !== undefined ? overlay.lostReason : deal.lostReason,
      } satisfies Record<DealRequiredFieldKey, unknown>;
      const missing = (stage.requiredFields ?? []).filter(
        (key) =>
          dealRequiredFieldKeys.includes(key) &&
          (effective[key] === null || effective[key] === undefined || effective[key] === ""),
      );
      if (missing.length > 0) throw new MissingRequiredFieldsError(missing);

      const [updated] = await tx
        .update(deals)
        .set({ // spread-write-approved: overlay is zod-parsed moveDealBodySchema.fields output narrowed to the three declared required-field keys; stage/audit columns are set explicitly above
          stageId: stage.id,
          stageEnteredAt: new Date(),
          updatedAt: new Date(),
          ...(overlay.amount !== undefined ? { amount: overlay.amount } : {}),
          ...(overlay.expectedCloseDate !== undefined
            ? { expectedCloseDate: overlay.expectedCloseDate }
            : {}),
          ...(overlay.lostReason !== undefined ? { lostReason: overlay.lostReason } : {}),
        })
        .where(eq(deals.id, dealId))
        .returning();
      const [historyEntry] = await tx
        .insert(dealStageHistory)
        .values({
          dealId,
          fromStageId: deal.stageId,
          toStageId: stage.id,
          movedByUserId: input.movedByUserId,
          // Task #4332 — trigger auto-moves attribute their source event.
          movedBySource: input.movedBySource ?? null,
          triggerEventId: input.triggerEventId ?? null,
        })
        .returning();
      // Task #4331 — emit the automation event atomically with the history
      // row (a stage transition can never exist without its event).
      const [eventRow] = await tx
        .insert(dealStageEvents)
        .values({
          stageHistoryId: historyEntry.id,
          dealId,
          pipelineId: deal.pipelineId,
          fromStageId: deal.stageId,
          toStageId: stage.id,
          movedByUserId: input.movedByUserId,
        })
        .onConflictDoNothing()
        .returning({ id: dealStageEvents.id });
      return { deal: updated, historyEntry, stageType: stage.stageType, eventId: eventRow?.id ?? null };
    });
  });
  if (!result) return undefined;
  // Task #4330 — deal moved into a won stage ⇒ the client is a customer.
  if (result.stageType === "won") {
    await advanceLifecycleForDealEvent(
      result.deal.clientId,
      result.stageType,
      input.movedByUserId ?? null,
      "deal_won",
    );
  }
  // Task #4331 — post-commit automation kick (never throws).
  await kickDealStageAutomation(result.eventId);
  return { deal: result.deal, historyEntry: result.historyEntry };
}

/**
 * Task #4331 — post-commit kick for the automation queue. Dynamic import
 * is the sanctioned static-cycle break (storage → services); failures are
 * logged, never thrown — the in-transaction event row is durable and the
 * boot catch-up / admin requeue lever re-enqueues it.
 */
async function kickDealStageAutomation(
  eventId: string | null | undefined,
): Promise<void> {
  if (!eventId) return;
  try {
    const { kickDealStageAutomationJobSafe } = await import(
      "../services/dealAutomationQueue"
    );
    await kickDealStageAutomationJobSafe(eventId);
  } catch (err: any) {
    console.error(
      `[dealsStorage] automation kick failed for event ${eventId}:`,
      err?.message ?? err,
    );
  }
}
export async function deleteDeal(id: string): Promise<boolean> {
  return withDbAttribution("deals:delete", async () => {
    const rows = await getDb().delete(deals).where(eq(deals.id, id)).returning({ id: deals.id });
    return rows.length > 0;
  });
}
