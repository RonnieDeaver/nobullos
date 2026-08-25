import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  jsonb,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const sourceEventStatuses = [
  "received",
  "normalized",
  "ready_to_apply",
  "applied",
  "failed",
  "dead_lettered",
  "ignored",
] as const;
export type SourceEventStatus = (typeof sourceEventStatuses)[number];

export const sourceSystems = ["front", "zoom", "semrush"] as const;
export type SourceSystem = (typeof sourceSystems)[number];

export const sourceEventLog = pgTable(
  "source_event_log",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sourceSystem: varchar("source_system").notNull(),
    sourceEventType: varchar("source_event_type").notNull(),
    sourceObjectId: varchar("source_object_id").notNull(),
    dedupeKey: varchar("dedupe_key").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    normalizedIdentityKeysJson: jsonb("normalized_identity_keys_json"),
    rulesetVersion: varchar("ruleset_version"),
    status: varchar("status").default("received").notNull(),
    replayable: boolean("replayable").default(true).notNull(),
    correlationId: varchar("correlation_id"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    errorCode: varchar("error_code"),
    errorMessage: text("error_message"),
    expectedResultCount: integer("expected_result_count"),
    resultsFinalizedAt: timestamp("results_finalized_at"),
    retryAt: timestamp("retry_at"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    normalizedAt: timestamp("normalized_at"),
    appliedAt: timestamp("applied_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("sel_dedupe_key_idx").on(table.dedupeKey),
    statusIdx: index("sel_status_idx").on(table.status),
    statusRetryIdx: index("sel_status_retry_at_idx").on(
      table.status,
      table.retryAt,
    ),
    sourceSystemIdx: index("sel_source_system_idx").on(table.sourceSystem),
    sourceSystemTypeIdx: index("sel_source_system_type_idx").on(
      table.sourceSystem,
      table.sourceEventType,
    ),
    correlationIdx: index("sel_correlation_id_idx").on(table.correlationId),
    receivedAtIdx: index("sel_received_at_idx").on(table.receivedAt),
  }),
);

export const insertSourceEventLogSchema = createInsertSchema(sourceEventLog, {
  status: z.enum(sourceEventStatuses).optional(),
  sourceSystem: z.enum(sourceSystems),
}).omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });
export type InsertSourceEventLog = z.infer<typeof insertSourceEventLogSchema>;
export type SourceEventLogRow = typeof sourceEventLog.$inferSelect;

export const workResultStatuses = [
  "pending",
  "completed",
  "failed",
  "dead_lettered",
] as const;
export type WorkResultStatus = (typeof workResultStatuses)[number];

export const workResultLog = pgTable(
  "work_result_log",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sourceEventId: varchar("source_event_id")
      .notNull()
      .references(() => sourceEventLog.id, { onDelete: "cascade" }),
    sourceSystem: varchar("source_system").notNull(),
    resultType: varchar("result_type").notNull(),
    resultJson: jsonb("result_json").notNull(),
    status: varchar("status").default("pending").notNull(),
    rulesetVersion: varchar("ruleset_version"),
    correlationId: varchar("correlation_id"),
    errorCode: varchar("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    sourceEventIdx: index("wrl_source_event_id_idx").on(table.sourceEventId),
    statusIdx: index("wrl_status_idx").on(table.status),
    sourceSystemIdx: index("wrl_source_system_idx").on(table.sourceSystem),
    correlationIdx: index("wrl_correlation_id_idx").on(table.correlationId),
    resultTypeIdx: index("wrl_result_type_idx").on(table.resultType),
  }),
);

export const insertWorkResultLogSchema = createInsertSchema(workResultLog, {
  status: z.enum(workResultStatuses).optional(),
  sourceSystem: z.enum(sourceSystems),
}).omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });
export type InsertWorkResultLog = z.infer<typeof insertWorkResultLogSchema>;
export type WorkResultLogRow = typeof workResultLog.$inferSelect;

export const applyOutcomes = [
  "pending",
  "success",
  "partial",
  "conflict",
  "failed",
  "skipped",
] as const;
export type ApplyOutcome = (typeof applyOutcomes)[number];

export const applyState = pgTable(
  "apply_state",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workResultId: varchar("work_result_id")
      .notNull()
      .references(() => workResultLog.id, { onDelete: "cascade" }),
    sourceEventId: varchar("source_event_id")
      .notNull()
      .references(() => sourceEventLog.id, { onDelete: "cascade" }),
    sourceSystem: varchar("source_system").notNull(),
    applyTarget: varchar("apply_target").notNull(),
    outcome: varchar("outcome").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    rulesetVersion: varchar("ruleset_version"),
    appliedVersion: varchar("applied_version"),
    inputHash: varchar("input_hash"),
    responseJson: jsonb("response_json"),
    errorCode: varchar("error_code"),
    errorMessage: text("error_message"),
    retryAt: timestamp("retry_at"),
    attemptedAt: timestamp("attempted_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    workResultTargetIdx: uniqueIndex("as_work_result_target_idx").on(
      table.workResultId,
      table.applyTarget,
    ),
    workResultIdx: index("as_work_result_id_idx").on(table.workResultId),
    sourceEventIdx: index("as_source_event_id_idx").on(table.sourceEventId),
    outcomeIdx: index("as_outcome_idx").on(table.outcome),
    outcomeRetryIdx: index("as_outcome_retry_at_idx").on(
      table.outcome,
      table.retryAt,
    ),
    sourceSystemIdx: index("as_source_system_idx").on(table.sourceSystem),
    applyTargetIdx: index("as_apply_target_idx").on(table.applyTarget),
  }),
);

export const insertApplyStateSchema = createInsertSchema(applyState, {
  outcome: z.enum(applyOutcomes).optional(),
  sourceSystem: z.enum(sourceSystems),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertApplyState = z.infer<typeof insertApplyStateSchema>;
export type ApplyStateRow = typeof applyState.$inferSelect;
