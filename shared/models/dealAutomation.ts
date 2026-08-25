/**
 * Task #4331 — Stage automation rules engine.
 *
 * The HubSpot "Automate"-tab equivalent for the deals pipeline: rules are
 * DATA (this model), execution rides the existing work queue. Three tables:
 *
 *   - deal_stage_events     ONE durable row per deal_stage_history write
 *     (UNIQUE stage_history_id — emitted inside the SAME transaction as the
 *     history row by dealsStorage.createDeal/moveDealStage). The
 *     `deal_stage_automation` work-queue job consumes an event exactly once:
 *     status flips pending → processed after every matching rule has a
 *     terminal run row. Replayed/duplicate jobs no-op on processed events.
 *   - deal_automation_rules trigger = deal ENTERS `stageId` (optionally only
 *     when coming FROM `fromStageId`), payload = ordered bounded `actions`
 *     (see dealAutomationActionSchema). Creation counts as entering the
 *     initial stage (fromStageId-filtered rules never match creation rows,
 *     whose from is null). Same-stage history rows (from === to) never fire.
 *   - deal_automation_runs  run log: one row per (rule, event) — the UNIQUE
 *     pair index IS the per-rule idempotency claim (INSERT … ON CONFLICT DO
 *     NOTHING; a terminal existing row means "already ran, skip"). Snapshots
 *     rule/deal names so history stays readable after renames; rows cascade
 *     away with their rule/event (mirrors deal_stage_history's cascade).
 *
 * Action config is a zod discriminated union — the four bounded actions:
 *   notify            in-app notification (owner or explicit user)
 *   clickup_task      create a ClickUp task via the per-user connection
 *                     (degrades to a skipped outcome when nobody is connected)
 *   set_property      set ONE scalar deal property (closed key set)
 *   advance_lifecycle advance the linked client's lifecycle stage
 *
 * Template strings (notify title/body, ClickUp name/description) support
 * {{deal_name}} {{pipeline_name}} {{stage_name}} {{from_stage_name}}
 * {{client_name}} {{owner_name}} {{amount}} tokens, rendered at execution.
 *
 * The global kill switch is the `deal_automation_enabled` system_settings
 * key (missing = enabled), read fresh per event by the worker.
 *
 * Lockstep with migrations/20260811003748_deal_automation.sql.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { dealPipelines, dealStages, deals, dealStageHistory } from "./deals";
import { clientLifecycleStages } from "./clients";
import { users } from "./auth";

// ── Action config (zod-validated jsonb) ──────────────────────────────────────

export const dealAutomationActionTypes = [
  "notify",
  "clickup_task",
  "set_property",
  "advance_lifecycle",
] as const;
export type DealAutomationActionType =
  (typeof dealAutomationActionTypes)[number];

export const dealAutomationActionTypeLabels: Record<
  DealAutomationActionType,
  string
> = {
  notify: "Send in-app notification",
  clickup_task: "Create ClickUp task",
  set_property: "Set deal property",
  advance_lifecycle: "Advance client lifecycle",
};

/** Closed set of deal columns the set_property action may write. */
export const dealAutomationSettableProperties = [
  "amount",
  "expectedCloseDate",
  "ownerId",
  "notes",
  "lostReason",
] as const;
export type DealAutomationSettableProperty =
  (typeof dealAutomationSettableProperties)[number];

export const dealAutomationSettablePropertyLabels: Record<
  DealAutomationSettableProperty,
  string
> = {
  amount: "Deal amount",
  expectedCloseDate: "Expected close date",
  ownerId: "Deal owner",
  notes: "Notes",
  lostReason: "Lost reason",
};

const templateString = (max: number) => z.string().trim().min(1).max(max);
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// NOTE: the union members below stay PLAIN ZodObjects — z.discriminatedUnion
// rejects ZodEffects members, so the per-type value checks live in the
// union-level .superRefine further down.
export const dealAutomationNotifyActionSchema = z.object({
  type: z.literal("notify"),
  /** owner = the deal's owner at fire time; user = explicit userId. */
  target: z.enum(["owner", "user"]),
  userId: z.string().min(1).optional(),
  title: templateString(200),
  body: z.string().trim().max(2000).optional(),
});

export const dealAutomationClickUpActionSchema = z.object({
  type: z.literal("clickup_task"),
  listId: z.string().trim().min(1).max(40),
  nameTemplate: templateString(300),
  descriptionTemplate: z.string().trim().max(4000).optional(),
  /** Task due date = fire time + N days (omitted = no due date). */
  dueInDays: z.number().int().min(0).max(365).optional(),
});

export const dealAutomationSetPropertyActionSchema = z.object({
  type: z.literal("set_property"),
  property: z.enum(dealAutomationSettableProperties),
  value: z.union([z.string(), z.number()]),
});

export const dealAutomationAdvanceLifecycleActionSchema = z.object({
  type: z.literal("advance_lifecycle"),
  targetStage: z.enum(clientLifecycleStages),
});

export const dealAutomationActionSchema = z
  .discriminatedUnion("type", [
    dealAutomationNotifyActionSchema,
    dealAutomationClickUpActionSchema,
    dealAutomationSetPropertyActionSchema,
    dealAutomationAdvanceLifecycleActionSchema,
  ])
  .superRefine((val, ctx) => {
    if (val.type === "notify" && val.target === "user" && !val.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userId"],
        message: "userId is required when target is 'user'",
      });
    }
    if (val.type === "set_property") {
      const fail = (message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message });
      switch (val.property) {
        case "amount": {
          const n = typeof val.value === "number" ? val.value : Number.NaN;
          if (!Number.isFinite(n) || n < 0) fail("amount needs a number ≥ 0");
          break;
        }
        case "expectedCloseDate": {
          if (
            typeof val.value !== "string" ||
            !isoDateString.safeParse(val.value).success
          ) {
            fail("expectedCloseDate needs a YYYY-MM-DD string");
          }
          break;
        }
        case "ownerId": {
          if (typeof val.value !== "string" || val.value.length === 0) {
            fail("ownerId needs a user id string");
          }
          break;
        }
        case "notes": {
          if (typeof val.value !== "string" || val.value.length > 10000) {
            fail("notes needs a string (max 10000 chars)");
          }
          break;
        }
        case "lostReason": {
          if (
            typeof val.value !== "string" ||
            val.value.length === 0 ||
            val.value.length > 2000
          ) {
            fail("lostReason needs a non-empty string (max 2000 chars)");
          }
          break;
        }
      }
    }
  });
export type DealAutomationAction = z.infer<typeof dealAutomationActionSchema>;

export const dealAutomationActionsSchema = z
  .array(dealAutomationActionSchema)
  .min(1)
  .max(10);

// ── Run/event vocabulary ─────────────────────────────────────────────────────

export const dealStageEventStatuses = ["pending", "processed"] as const;
export type DealStageEventStatus = (typeof dealStageEventStatuses)[number];

export const dealAutomationRunStatuses = [
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type DealAutomationRunStatus =
  (typeof dealAutomationRunStatuses)[number];

export const dealAutomationActionResultStatuses = [
  "attempting",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type DealAutomationActionResultStatus =
  (typeof dealAutomationActionResultStatuses)[number];

/**
 * Per-action outcome stored on the run row (write-ahead: status flips to
 * "attempting" BEFORE a non-idempotent vendor call so a crash-replay never
 * re-fires it — it records failed/unknown instead).
 */
export interface DealAutomationActionResult {
  index: number;
  type: DealAutomationActionType;
  status: DealAutomationActionResultStatus;
  /** Human-readable outcome (e.g. created task id/url, skip reason). */
  detail?: string;
  error?: string;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export const dealAutomationRules = pgTable(
  "deal_automation_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    pipelineId: varchar("pipeline_id")
      .references(() => dealPipelines.id, { onDelete: "cascade" })
      .notNull(),
    /** Trigger: a deal ENTERS this stage. */
    stageId: varchar("stage_id")
      .references(() => dealStages.id, { onDelete: "cascade" })
      .notNull(),
    /** Optional filter: only when the deal came FROM this stage. */
    fromStageId: varchar("from_stage_id").references(() => dealStages.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    actions: jsonb("actions").notNull().$type<DealAutomationAction[]>(),
    position: integer("position").default(0).notNull(),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: varchar("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    stageEnabledIdx: index("deal_automation_rules_stage_enabled_idx").on(
      t.stageId,
      t.enabled,
    ),
    pipelineIdx: index("deal_automation_rules_pipeline_idx").on(t.pipelineId),
  }),
);

export const dealStageEvents = pgTable(
  "deal_stage_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** 1:1 with the deal_stage_history row (the exactly-once key). */
    stageHistoryId: varchar("stage_history_id")
      .references(() => dealStageHistory.id, { onDelete: "cascade" })
      .notNull(),
    dealId: varchar("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    pipelineId: varchar("pipeline_id")
      .references(() => dealPipelines.id)
      .notNull(),
    /** null = the deal-creation entry (mirrors deal_stage_history). */
    fromStageId: varchar("from_stage_id").references(() => dealStages.id),
    toStageId: varchar("to_stage_id")
      .references(() => dealStages.id)
      .notNull(),
    movedByUserId: varchar("moved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 12 })
      .default("pending")
      .notNull()
      .$type<DealStageEventStatus>(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    stageHistoryUq: uniqueIndex("deal_stage_events_stage_history_uq").on(
      t.stageHistoryId,
    ),
    statusCreatedIdx: index("deal_stage_events_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    dealIdx: index("deal_stage_events_deal_id_idx").on(t.dealId),
  }),
);

export const dealAutomationRuns = pgTable(
  "deal_automation_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    ruleId: varchar("rule_id")
      .references(() => dealAutomationRules.id, { onDelete: "cascade" })
      .notNull(),
    eventId: varchar("event_id")
      .references(() => dealStageEvents.id, { onDelete: "cascade" })
      .notNull(),
    dealId: varchar("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    /** Display snapshots — history stays readable after renames. */
    ruleName: text("rule_name").notNull(),
    dealName: text("deal_name").notNull(),
    status: varchar("status", { length: 12 })
      .notNull()
      .$type<DealAutomationRunStatus>(),
    /** Set when status = skipped (currently only "killswitch"). */
    skipReason: varchar("skip_reason", { length: 40 }),
    actionResults: jsonb("action_results")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<DealAutomationActionResult[]>(),
    error: text("error"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    ruleEventUq: uniqueIndex("deal_automation_runs_rule_event_uq").on(
      t.ruleId,
      t.eventId,
    ),
    ruleStartedIdx: index("deal_automation_runs_rule_started_idx").on(
      t.ruleId,
      t.startedAt,
    ),
    dealIdx: index("deal_automation_runs_deal_id_idx").on(t.dealId),
    startedIdx: index("deal_automation_runs_started_idx").on(t.startedAt),
  }),
);

// ── Row types ────────────────────────────────────────────────────────────────

export type DealAutomationRule = typeof dealAutomationRules.$inferSelect;
export type InsertDealAutomationRule = typeof dealAutomationRules.$inferInsert;
export type DealStageEvent = typeof dealStageEvents.$inferSelect;
export type DealAutomationRun = typeof dealAutomationRuns.$inferSelect;

// ── Request-body schemas (persistence-write boundary) ───────────────────────
// Routes parse bodies through these focused schemas (unknown keys stripped,
// 400 { error: issues }). pipelineId is server-derived from the trigger
// stage; audit columns (createdBy/updatedBy) are server-stamped.

export const createDealAutomationRuleBodySchema = z.object({
  stageId: z.string().min(1),
  fromStageId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  actions: dealAutomationActionsSchema,
});
export type CreateDealAutomationRuleBody = z.infer<
  typeof createDealAutomationRuleBodySchema
>;

export const updateDealAutomationRuleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    fromStageId: z.string().min(1).nullable(),
    enabled: z.boolean(),
    actions: dealAutomationActionsSchema,
    position: z.number().int().min(0),
  })
  .partial();
export type UpdateDealAutomationRuleBody = z.infer<
  typeof updateDealAutomationRuleBodySchema
>;
