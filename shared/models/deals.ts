/**
 * Task #4327 — Deals pipeline foundation.
 *
 * Native sales-pipeline CRM object: deals move through configurable stages
 * on a kanban board, with an append-only stage history recording who moved
 * what and when. Follows the in-house precedent set by the ATS candidate
 * pipeline and the roadmap quarter boards rather than importing a CRM.
 *
 *   - deal_pipelines      pipeline containers. The schema supports many, but
 *     only the seeded default "Sales" pipeline gets UI in this task
 *     (multi-pipeline UI is a deliberate non-goal). `slug` is the stable
 *     seed-identity key (ON CONFLICT target), mirroring roadmap value sets.
 *   - deal_stages         configurable stage rows (name, order, win
 *     probability, open/won/lost type) — data, not hardcoded enums, so the
 *     board renders whatever the config says. `requiredFields` lists deal
 *     properties that must be present before a deal may ENTER the stage
 *     (closed key set — see dealRequiredFieldKeys); the move flow prompts
 *     for missing ones.
 *   - deals               the core record. `stageId` changes ONLY via the
 *     move endpoint (excluded from the generic update schema) so every
 *     transition is guaranteed a history row. `stageEnteredAt` powers
 *     time-in-stage on board cards. `clientId` is nullable — a deal may
 *     represent a prospect that has no clients row yet.
 *   - deal_contacts       join to client_contacts (a deal can involve
 *     several people at the firm).
 *   - deal_stage_history  append-only transition log (fromStageId null =
 *     deal creation). Never updated, never pruned (low cardinality, audit
 *     value).
 *
 * Seed rows live here in lockstep with
 * migrations/20260810194500_deals_pipeline.sql (dev/test get them from the
 * migration; production gets them from the lazy runtime ensure in
 * server/storage/dealsStorage.ts because the Publish diff is structure-only).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  real,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients, clientContacts } from "./clients";
import { users } from "./auth";

// ── Stage vocabulary ─────────────────────────────────────────────────────────

export const dealStageTypes = ["open", "won", "lost"] as const;
export type DealStageType = (typeof dealStageTypes)[number];

export const dealStageTypeLabels: Record<DealStageType, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
};

/**
 * Closed set of deal properties a stage may declare as required-on-entry.
 * Keys are snake_case (stored in deal_stages.required_fields text[]);
 * dealRequiredFieldColumn maps each to the camelCase deals column the move
 * flow reads/writes. Extending this set is a deliberate schema decision —
 * add the key here, the column mapping, and UI collection support together.
 */
export const dealRequiredFieldKeys = [
  "amount",
  "expected_close_date",
  "lost_reason",
] as const;
export type DealRequiredFieldKey = (typeof dealRequiredFieldKeys)[number];

export const dealRequiredFieldLabels: Record<DealRequiredFieldKey, string> = {
  amount: "Deal amount",
  expected_close_date: "Expected close date",
  lost_reason: "Lost reason",
};

// ── Tables ───────────────────────────────────────────────────────────────────

export const dealPipelines = pgTable(
  "deal_pipelines",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar("slug", { length: 80 }).notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex("deal_pipelines_slug_uq").on(t.slug),
  }),
);

export const dealStages = pgTable(
  "deal_stages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    pipelineId: varchar("pipeline_id")
      .references(() => dealPipelines.id, { onDelete: "cascade" })
      .notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** 0–100 — the board's weighted forecast is amount × probability / 100. */
    winProbability: integer("win_probability").default(0).notNull(),
    stageType: varchar("stage_type", { length: 10 })
      .default("open")
      .notNull()
      .$type<DealStageType>(),
    /** DealRequiredFieldKey[] a deal must have before entering this stage. */
    requiredFields: text("required_fields")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull()
      .$type<DealRequiredFieldKey[]>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    pipelineSlugUq: uniqueIndex("deal_stages_pipeline_slug_uq").on(
      t.pipelineId,
      t.slug,
    ),
    pipelinePositionIdx: index("deal_stages_pipeline_position_idx").on(
      t.pipelineId,
      t.position,
    ),
  }),
);

export const deals = pgTable(
  "deals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    pipelineId: varchar("pipeline_id")
      .references(() => dealPipelines.id)
      .notNull(),
    stageId: varchar("stage_id")
      .references(() => dealStages.id)
      .notNull(),
    name: text("name").notNull(),
    clientId: varchar("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    amount: real("amount"),
    expectedCloseDate: date("expected_close_date"),
    ownerId: varchar("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lostReason: text("lost_reason"),
    notes: text("notes"),
    isArchived: boolean("is_archived").default(false).notNull(),
    // Task #4337 — immutable first-touch attribution inherited from the
    // linked client at creation (or adopted ONCE on first client link while
    // still NULL). Deliberately absent from createDealBodySchema /
    // updateDealBodySchema — requests can never write these. NULL renders
    // as "Unknown" (customer-era deals, pre-feature rows).
    firstTouchSource: varchar("first_touch_source", { length: 80 }),
    firstTouchCampaign: varchar("first_touch_campaign", { length: 120 }),
    /** Server-stamped on every stage move — powers time-in-stage on cards. */
    stageEnteredAt: timestamp("stage_entered_at").defaultNow().notNull(),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    pipelineStageIdx: index("deals_pipeline_stage_idx").on(
      t.pipelineId,
      t.stageId,
    ),
    clientIdx: index("deals_client_id_idx").on(t.clientId),
    ownerIdx: index("deals_owner_id_idx").on(t.ownerId),
    // Task #4337 — campaign detail pages look up attributed deals by key;
    // stamped rows are a minority, so the index is partial.
    firstTouchCampaignIdx: index("deals_first_touch_campaign_idx")
      .on(t.firstTouchCampaign)
      .where(sql`first_touch_campaign IS NOT NULL`),
  }),
);

export const dealContacts = pgTable(
  "deal_contacts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    contactId: varchar("contact_id")
      .references(() => clientContacts.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    dealContactUq: uniqueIndex("deal_contacts_deal_contact_uq").on(
      t.dealId,
      t.contactId,
    ),
    dealIdx: index("deal_contacts_deal_id_idx").on(t.dealId),
  }),
);

export const dealStageHistory = pgTable(
  "deal_stage_history",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    /** null = the deal-creation entry (no prior stage). */
    fromStageId: varchar("from_stage_id").references(() => dealStages.id),
    toStageId: varchar("to_stage_id")
      .references(() => dealStages.id)
      .notNull(),
    movedByUserId: varchar("moved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Task #4332 — source attribution for native trigger auto-moves. NULL =
    // manual/user move (all pre-feature rows). System moves leave
    // movedByUserId NULL and set movedBySource to the DealTriggerType
    // (vocabulary owned by models/dealTriggers.ts — plain varchar here to
    // avoid a model import cycle) plus the deal_trigger_events row id as a
    // soft reference (no FK: the log is append-only, never hard-deleted).
    movedBySource: varchar("moved_by_source", { length: 40 }),
    triggerEventId: varchar("trigger_event_id"),
    movedAt: timestamp("moved_at").defaultNow().notNull(),
  },
  (t) => ({
    dealMovedIdx: index("deal_stage_history_deal_moved_idx").on(
      t.dealId,
      t.movedAt,
    ),
  }),
);

// ── Row types ────────────────────────────────────────────────────────────────

export type DealPipeline = typeof dealPipelines.$inferSelect;
export type DealStage = typeof dealStages.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type DealContact = typeof dealContacts.$inferSelect;
export type DealStageHistoryEntry = typeof dealStageHistory.$inferSelect;

export type InsertDeal = typeof deals.$inferInsert;
export type InsertDealStage = typeof dealStages.$inferInsert;

// ── Request-body schemas (persistence-write boundary) ───────────────────────
// Routes parse bodies through these focused schemas (unknown keys stripped,
// 400 { error: issues } on failure). Server-owned columns — stageId (moves
// only), stageEnteredAt, createdBy, timestamps — are deliberately absent.

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const createDealBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Defaults to the default pipeline when omitted. */
  pipelineId: z.string().min(1).optional(),
  /** Defaults to the pipeline's first open stage when omitted. */
  stageId: z.string().min(1).optional(),
  clientId: z.string().min(1).nullable().optional(),
  contactIds: z.array(z.string().min(1)).max(20).optional(),
  amount: z.number().finite().nonnegative().nullable().optional(),
  expectedCloseDate: isoDateString.nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
});
export type CreateDealBody = z.infer<typeof createDealBodySchema>;

export const updateDealBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    clientId: z.string().min(1).nullable(),
    contactIds: z.array(z.string().min(1)).max(20),
    amount: z.number().finite().nonnegative().nullable(),
    expectedCloseDate: isoDateString.nullable(),
    ownerId: z.string().min(1).nullable(),
    lostReason: z.string().trim().max(2000).nullable(),
    notes: z.string().max(10000).nullable(),
    isArchived: z.boolean(),
  })
  .partial();
export type UpdateDealBody = z.infer<typeof updateDealBodySchema>;

/**
 * Values the move dialog may supply to satisfy a target stage's
 * requiredFields. Keys mirror dealRequiredFieldKeys' deal columns.
 */
export const moveDealFieldsSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    expectedCloseDate: isoDateString,
    lostReason: z.string().trim().min(1).max(2000),
  })
  .partial();

export const moveDealBodySchema = z.object({
  toStageId: z.string().min(1),
  fields: moveDealFieldsSchema.optional(),
});
export type MoveDealBody = z.infer<typeof moveDealBodySchema>;

export const createDealStageBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  winProbability: z.number().int().min(0).max(100),
  stageType: z.enum(dealStageTypes),
  requiredFields: z.array(z.enum(dealRequiredFieldKeys)).max(8).optional(),
  /** Appended after the pipeline's last stage when omitted. */
  position: z.number().int().min(0).optional(),
});
export type CreateDealStageBody = z.infer<typeof createDealStageBodySchema>;

export const updateDealStageBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    winProbability: z.number().int().min(0).max(100),
    stageType: z.enum(dealStageTypes),
    requiredFields: z.array(z.enum(dealRequiredFieldKeys)).max(8),
    position: z.number().int().min(0),
  })
  .partial();
export type UpdateDealStageBody = z.infer<typeof updateDealStageBodySchema>;

// Legacy-shaped insert schemas for parity with sibling models (used by the
// storage layer's typing, not by request parsing).
export const insertDealSchema = createInsertSchema(deals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  stageEnteredAt: true,
});

// ── Seed data (lockstep with the migration + runtime ensure) ─────────────────

export const dealSeedPipeline = {
  slug: "sales",
  name: "Sales",
  isDefault: true,
  position: 0,
} as const;

export const dealSeedStages: ReadonlyArray<{
  slug: string;
  name: string;
  position: number;
  winProbability: number;
  stageType: DealStageType;
  requiredFields: DealRequiredFieldKey[];
}> = [
  { slug: "new-opportunity", name: "New Opportunity", position: 1, winProbability: 10, stageType: "open", requiredFields: [] },
  { slug: "discovery-call", name: "Discovery Call", position: 2, winProbability: 25, stageType: "open", requiredFields: [] },
  { slug: "proposal-sent", name: "Proposal Sent", position: 3, winProbability: 50, stageType: "open", requiredFields: ["amount"] },
  { slug: "negotiation", name: "Negotiation", position: 4, winProbability: 75, stageType: "open", requiredFields: ["amount", "expected_close_date"] },
  { slug: "closed-won", name: "Closed Won", position: 5, winProbability: 100, stageType: "won", requiredFields: ["amount"] },
  { slug: "closed-lost", name: "Closed Lost", position: 6, winProbability: 0, stageType: "lost", requiredFields: ["lost_reason"] },
];
