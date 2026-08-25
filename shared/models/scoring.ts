/**
 * Task #4333 — Deal & lead scoring (deterministic fit + engagement).
 *
 * HubSpot-style manual score builder, no AI: admins configure point rules
 * inside a score range; the engine (server/services/scoringEngine.ts) sums
 * matched rules per record and caches the result.
 *
 *   - score_configs   one row per entity type ("deal" today; "lead" joins
 *     when the lead entity lands — Task #4330). Holds the configured score
 *     range and the enabled switch. Lazily ensured at first config read
 *     (Publish diffs are structure-only, so seed INSERTs never reach prod).
 *   - score_rules     the point groups. Two kinds, shape-enforced by a DB
 *     CHECK and the zod schemas below:
 *       fit         — a shared-criteria CriteriaSet over record properties
 *                     (validated with validateCriteriaSet at the route);
 *                     worth `points` when the record matches.
 *       engagement  — captured activity from the timeline sources: at least
 *                     `minCount` events of `eventType` (optionally filtered
 *                     to a direction) within the last `windowDays` days,
 *                     worth `points` when satisfied.
 *   - entity_scores   derived cache, the ONLY score storage. Polymorphic
 *     (entity_type, entity_id) without FK — mirroring segment_members —
 *     because it must span entity tables; recomputes reap orphans. Sole
 *     writer is the scoring engine: scores are structurally unreachable
 *     from the deal write routes' body schemas.
 *
 * Scoring semantics (deterministic, pure given inputs):
 *   fitScore        = Σ points of matched fit rules (can be negative)
 *   engagementScore = Σ points of satisfied engagement rules
 *   score           = clamp(fitScore + engagementScore, scoreMin, scoreMax)
 * Breakdown stores ONLY matched/satisfied rules (id, name, kind, points,
 * human detail) plus the computed components, so cards and the detail view
 * can explain a score without re-running the engine.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { criteriaSetSchema, type CriteriaSet } from "../criteria";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Entity types the scoring engine can score. Extending this set is a
 * schema decision: add the population/record loaders + engagement linkage
 * in server/services/scoringEngine.ts in the same change. */
export const scoringEntityTypes = ["deal"] as const;
export type ScoringEntityType = (typeof scoringEntityTypes)[number];

export const scoreRuleKinds = ["fit", "engagement"] as const;
export type ScoreRuleKind = (typeof scoreRuleKinds)[number];

/**
 * Engagement activity vocabulary — one entry per timeline source of record
 * (Task #4328): email → raw_communication_records(front_email),
 * sms → twilio_messages⋈twilio_conversations, call → twilio_calls,
 * meeting → scheduled_meetings (held meetings only, not future bookings).
 */
export const engagementEventTypes = ["email", "sms", "call", "meeting"] as const;
export type EngagementEventType = (typeof engagementEventTypes)[number];

export const engagementEventTypeLabels: Record<EngagementEventType, string> = {
  email: "Email",
  sms: "SMS",
  call: "Call",
  meeting: "Meeting held",
};

/** Meetings have no direction; the schema refines that to "any". */
export const engagementDirections = ["inbound", "outbound", "any"] as const;
export type EngagementDirection = (typeof engagementDirections)[number];

export const engagementDirectionLabels: Record<EngagementDirection, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
  any: "Any direction",
};

// ── Bounds ───────────────────────────────────────────────────────────────────

export const SCORE_RULE_MAX_PER_CONFIG = 50;
export const SCORE_POINTS_MIN = -1000;
export const SCORE_POINTS_MAX = 1000;
export const SCORE_RANGE_MIN = -10000;
export const SCORE_RANGE_MAX = 10000;
export const ENGAGEMENT_WINDOW_MIN_DAYS = 1;
export const ENGAGEMENT_WINDOW_MAX_DAYS = 365;
export const ENGAGEMENT_MIN_COUNT_MIN = 1;
export const ENGAGEMENT_MIN_COUNT_MAX = 100;

// ── Tables ───────────────────────────────────────────────────────────────────

export const scoreConfigs = pgTable(
  "score_configs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: varchar("entity_type", { length: 20 })
      .notNull()
      .$type<ScoringEntityType>(),
    scoreMin: integer("score_min").default(0).notNull(),
    scoreMax: integer("score_max").default(100).notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    entityTypeUq: uniqueIndex("score_configs_entity_type_uq").on(t.entityType),
  }),
);

export const scoreRules = pgTable(
  "score_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    configId: varchar("config_id")
      .references(() => scoreConfigs.id, { onDelete: "cascade" })
      .notNull(),
    kind: varchar("kind", { length: 12 }).notNull().$type<ScoreRuleKind>(),
    name: text("name").notNull(),
    points: integer("points").notNull(),
    position: integer("position").default(0).notNull(),
    /** fit rules only — CriteriaSet for the config's entity type. */
    criteria: jsonb("criteria").$type<CriteriaSet | null>(),
    /** engagement rules only ↓ */
    eventType: varchar("event_type", { length: 20 }).$type<EngagementEventType | null>(),
    direction: varchar("direction", { length: 10 }).$type<EngagementDirection | null>(),
    windowDays: integer("window_days"),
    minCount: integer("min_count"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    configPositionIdx: index("score_rules_config_id_idx").on(t.configId, t.position),
  }),
);

export const entityScores = pgTable(
  "entity_scores",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** No FK — polymorphic across entity tables (segment_members precedent);
     * recomputes reap rows whose entity no longer exists. */
    entityType: varchar("entity_type", { length: 20 })
      .notNull()
      .$type<ScoringEntityType>(),
    entityId: varchar("entity_id").notNull(),
    /** clamp(fitScore + engagementScore, config.scoreMin, config.scoreMax) */
    score: integer("score").notNull(),
    fitScore: integer("fit_score").notNull(),
    engagementScore: integer("engagement_score").notNull(),
    breakdown: jsonb("breakdown")
      .$type<ScoreBreakdownEntry[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => ({
    entityUq: uniqueIndex("entity_scores_entity_uq").on(t.entityType, t.entityId),
    typeScoreIdx: index("entity_scores_type_score_idx").on(t.entityType, t.score),
  }),
);

// ── Row types ────────────────────────────────────────────────────────────────

export type ScoreConfig = typeof scoreConfigs.$inferSelect;
export type ScoreRule = typeof scoreRules.$inferSelect;
export type EntityScore = typeof entityScores.$inferSelect;

/** One matched/satisfied rule's contribution (unmatched rules are omitted). */
export interface ScoreBreakdownEntry {
  ruleId: string;
  name: string;
  kind: ScoreRuleKind;
  points: number;
  /** Human explanation, e.g. "4 inbound emails in the last 14 days". */
  detail: string | null;
}

export interface ScoreConfigWithRules extends ScoreConfig {
  rules: ScoreRule[];
}

/** The slice of EntityScore that list/detail payloads embed. */
export interface EntityScoreSummary {
  score: number;
  fitScore: number;
  engagementScore: number;
  computedAt: string;
}

// ── Request-body schemas (persistence-write boundary) ───────────────────────
// Routes parse bodies through these focused schemas (unknown keys stripped,
// 400 { error: issues } on failure). Semantic criteria validation
// (validateCriteriaSet against the config's entity type) happens at the
// route — it needs the entity type and returns human-readable problems.

const pointsSchema = z
  .number()
  .int()
  .min(SCORE_POINTS_MIN)
  .max(SCORE_POINTS_MAX)
  .refine((p) => p !== 0, "Points must not be zero");

const ruleNameSchema = z.string().trim().min(1).max(120);

const engagementFieldsSchema = z.object({
  eventType: z.enum(engagementEventTypes),
  direction: z.enum(engagementDirections).default("any"),
  windowDays: z
    .number()
    .int()
    .min(ENGAGEMENT_WINDOW_MIN_DAYS)
    .max(ENGAGEMENT_WINDOW_MAX_DAYS),
  minCount: z
    .number()
    .int()
    .min(ENGAGEMENT_MIN_COUNT_MIN)
    .max(ENGAGEMENT_MIN_COUNT_MAX)
    .default(1),
});

/** Meetings carry no direction — only "any" is coherent. */
function meetingDirectionCoherent(v: {
  eventType: EngagementEventType;
  direction: EngagementDirection;
}): boolean {
  return v.eventType !== "meeting" || v.direction === "any";
}

// The meeting-direction rule lives in a superRefine on the union because
// discriminatedUnion options must be bare ZodObjects (a .refine()-wrapped
// option is a ZodEffects and is rejected at the type level).
export const createScoreRuleBodySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("fit"),
      name: ruleNameSchema,
      points: pointsSchema,
      criteria: criteriaSetSchema,
    }),
    z
      .object({
        kind: z.literal("engagement"),
        name: ruleNameSchema,
        points: pointsSchema,
      })
      .merge(engagementFieldsSchema),
  ])
  .superRefine((v, ctx) => {
    if (v.kind === "engagement" && !meetingDirectionCoherent(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Meetings have no direction — use "any"',
        path: ["direction"],
      });
    }
  });
export type CreateScoreRuleBody = z.infer<typeof createScoreRuleBodySchema>;

/**
 * Kind is immutable after create (delete + recreate to switch). The route
 * rejects fields that do not belong to the stored rule's kind.
 */
export const updateScoreRuleBodySchema = z
  .object({
    name: ruleNameSchema,
    points: pointsSchema,
    position: z.number().int().min(0).max(10000),
    criteria: criteriaSetSchema,
    eventType: z.enum(engagementEventTypes),
    direction: z.enum(engagementDirections),
    windowDays: z
      .number()
      .int()
      .min(ENGAGEMENT_WINDOW_MIN_DAYS)
      .max(ENGAGEMENT_WINDOW_MAX_DAYS),
    minCount: z
      .number()
      .int()
      .min(ENGAGEMENT_MIN_COUNT_MIN)
      .max(ENGAGEMENT_MIN_COUNT_MAX),
  })
  .partial();
export type UpdateScoreRuleBody = z.infer<typeof updateScoreRuleBodySchema>;

export const updateScoreConfigBodySchema = z
  .object({
    scoreMin: z.number().int().min(SCORE_RANGE_MIN).max(SCORE_RANGE_MAX),
    scoreMax: z.number().int().min(SCORE_RANGE_MIN).max(SCORE_RANGE_MAX),
    isEnabled: z.boolean(),
  })
  .partial();
export type UpdateScoreConfigBody = z.infer<typeof updateScoreConfigBodySchema>;

/** Preview a record's score, optionally against unsaved draft rules. */
export const scorePreviewBodySchema = z.object({
  entityType: z.enum(scoringEntityTypes),
  entityId: z.string().min(1).max(200),
  /** When present, preview uses EXACTLY these rules instead of saved ones. */
  draftRules: z.array(createScoreRuleBodySchema).max(SCORE_RULE_MAX_PER_CONFIG).optional(),
});
export type ScorePreviewBody = z.infer<typeof scorePreviewBodySchema>;

// ── Seed (lockstep with the lazy runtime ensure in scoringStorage) ──────────

export const defaultScoreConfigSeed = {
  entityType: "deal" as ScoringEntityType,
  scoreMin: 0,
  scoreMax: 100,
  isEnabled: true,
} as const;
