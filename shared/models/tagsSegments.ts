/**
 * Task #4329 — tags & segments engine.
 *
 * HubSpot-style tag management + saved segments (active lists), both powered
 * by the shared criteria evaluator in shared/criteria.ts:
 *
 *   - tags             tag definitions. `entityType` scopes a tag to deals
 *     OR clients (criteria are per-entity, so a tag can never straddle
 *     both; the same NAME may exist once per entity type). `criteria` is
 *     nullable — null = manual-only tag; non-null = rule tag whose rows the
 *     engine reconciles.
 *   - deal_tags /      record↔tag joins. `source` records HOW the row got
 *     client_tags       there: 'manual' rows are operator statements the
 *     reconciler NEVER touches; 'rule' rows are owned by the engine and
 *     appear/disappear as records match/stop matching. UNIQUE(record, tag)
 *     means a record carries a tag at most once — a manual row survives the
 *     engine's ON CONFLICT DO NOTHING insert attempts.
 *   - segments         saved criteria over clients or contacts. Criteria is
 *     NOT NULL (a segment IS its rule; static lists are a non-goal).
 *   - segment_members  cached membership — a DERIVED projection, fully
 *     rewritten by recompute/reconciliation. `entityId` is polymorphic
 *     (client id or contact id, per the segment's entityType) with no FK:
 *     reads always join the entity table so orphans are invisible, and the
 *     next evaluation reaps them. memberCount on segments is stamped by the
 *     same writers.
 *
 * Evaluation bookkeeping (`lastEvaluatedAt` on both definition tables) is
 * stamped by every full evaluation (sweep or on-demand recompute) so the
 * admin status view can show staleness honestly. Single-record on-write
 * evaluation deliberately does NOT stamp it — it touches one record, not
 * the definition's whole population.
 *
 * No seed rows: everything here is operator-created (nothing for prod's
 * lazy-ensure pattern to do).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { clients } from "./clients";
import { deals } from "./deals";
import { users } from "./auth";
import {
  criteriaSetSchema,
  tagEntityTypes,
  segmentEntityTypes,
  type CriteriaSet,
  type TagEntityType,
  type SegmentEntityType,
} from "../criteria";

// ── Tag-row provenance ───────────────────────────────────────────────────────

export const tagSources = ["manual", "rule"] as const;
export type TagSource = (typeof tagSources)[number];

/** Preset chip palette (hex). The UI offers these; the schema accepts any
 * #rrggbb so future theming doesn't need a migration. */
export const tagColorPalette = [
  "#2563eb", // blue
  "#0891b2", // cyan
  "#059669", // green
  "#ca8a04", // yellow
  "#ea580c", // orange
  "#dc2626", // red
  "#db2777", // pink
  "#9333ea", // purple
  "#4f46e5", // indigo
  "#64748b", // slate
] as const;

// ── Tables ───────────────────────────────────────────────────────────────────

export const tags = pgTable(
  "tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: varchar("entity_type", { length: 10 })
      .notNull()
      .$type<TagEntityType>(),
    name: varchar("name", { length: 80 }).notNull(),
    /** #rrggbb hex. */
    color: varchar("color", { length: 7 }).notNull(),
    description: text("description"),
    /** null = manual-only tag; non-null = rule tag (CriteriaSet). */
    criteria: jsonb("criteria").$type<CriteriaSet | null>(),
    /** Stamped by every FULL evaluation of this tag (sweep/recompute). */
    lastEvaluatedAt: timestamp("last_evaluated_at"),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    entityNameUq: uniqueIndex("tags_entity_type_name_uq").on(t.entityType, t.name),
  }),
);

export const dealTags = pgTable(
  "deal_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    tagId: varchar("tag_id")
      .references(() => tags.id, { onDelete: "cascade" })
      .notNull(),
    source: varchar("source", { length: 10 }).notNull().$type<TagSource>(),
    /** Operator who applied a manual row; null on rule rows. */
    appliedBy: varchar("applied_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    dealTagUq: uniqueIndex("deal_tags_deal_tag_uq").on(t.dealId, t.tagId),
    tagIdx: index("deal_tags_tag_id_idx").on(t.tagId),
  }),
);

export const clientTags = pgTable(
  "client_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    tagId: varchar("tag_id")
      .references(() => tags.id, { onDelete: "cascade" })
      .notNull(),
    source: varchar("source", { length: 10 }).notNull().$type<TagSource>(),
    appliedBy: varchar("applied_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    clientTagUq: uniqueIndex("client_tags_client_tag_uq").on(t.clientId, t.tagId),
    tagIdx: index("client_tags_tag_id_idx").on(t.tagId),
  }),
);

export const segments = pgTable(
  "segments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: varchar("entity_type", { length: 10 })
      .notNull()
      .$type<SegmentEntityType>(),
    name: varchar("name", { length: 80 }).notNull(),
    description: text("description"),
    criteria: jsonb("criteria").$type<CriteriaSet>().notNull(),
    /** Stamped together with segment_members by every full evaluation. */
    memberCount: integer("member_count").default(0).notNull(),
    lastEvaluatedAt: timestamp("last_evaluated_at"),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    entityNameUq: uniqueIndex("segments_entity_type_name_uq").on(
      t.entityType,
      t.name,
    ),
  }),
);

export const segmentMembers = pgTable(
  "segment_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    segmentId: varchar("segment_id")
      .references(() => segments.id, { onDelete: "cascade" })
      .notNull(),
    /** client id or contact id per the segment's entityType (polymorphic —
     * derived cache; reads join the entity table, orphans get reaped). */
    entityId: varchar("entity_id").notNull(),
    addedAt: timestamp("added_at").defaultNow(),
  },
  (t) => ({
    segmentEntityUq: uniqueIndex("segment_members_segment_entity_uq").on(
      t.segmentId,
      t.entityId,
    ),
    /** Inline prune on entity delete + orphan reaping scan. */
    entityIdx: index("segment_members_entity_id_idx").on(t.entityId),
  }),
);

// ── Row types ────────────────────────────────────────────────────────────────

export type Tag = typeof tags.$inferSelect;
export type DealTag = typeof dealTags.$inferSelect;
export type ClientTag = typeof clientTags.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type SegmentMember = typeof segmentMembers.$inferSelect;

// ── Request-body schemas (persistence-write boundary) ───────────────────────
// Routes parse through these focused schemas (unknown keys stripped,
// 400 { error: issues }). Server-owned columns — lastEvaluatedAt,
// memberCount, createdBy, timestamps, join-row source — are absent.
// Criteria get shape-checked here; field/operator semantics are checked
// against the entity registry via validateCriteriaSet in the route.

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected #rrggbb hex color");

export const createTagBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: hexColor,
  entityType: z.enum(tagEntityTypes),
  description: z.string().trim().max(500).nullable().optional(),
  criteria: criteriaSetSchema.nullable().optional(),
});
export type CreateTagBody = z.infer<typeof createTagBodySchema>;

export const updateTagBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: hexColor,
    description: z.string().trim().max(500).nullable(),
    criteria: criteriaSetSchema.nullable(),
  })
  .partial();
export type UpdateTagBody = z.infer<typeof updateTagBodySchema>;

export const applyTagBodySchema = z.object({
  tagId: z.string().min(1),
});
export type ApplyTagBody = z.infer<typeof applyTagBodySchema>;

export const createSegmentBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  entityType: z.enum(segmentEntityTypes),
  description: z.string().trim().max(500).nullable().optional(),
  criteria: criteriaSetSchema,
});
export type CreateSegmentBody = z.infer<typeof createSegmentBodySchema>;

export const updateSegmentBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable(),
    criteria: criteriaSetSchema,
  })
  .partial();
export type UpdateSegmentBody = z.infer<typeof updateSegmentBodySchema>;
