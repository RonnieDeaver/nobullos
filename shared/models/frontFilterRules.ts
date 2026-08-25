import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const frontFilterRuleTypes = ["block", "dismiss", "never_match"] as const;
export type FrontFilterRuleType = typeof frontFilterRuleTypes[number];

export const frontFilterRuleScopes = ["sender_email", "domain", "channel"] as const;
export type FrontFilterRuleScope = typeof frontFilterRuleScopes[number];

export const FRONT_FILTER_RULE_PRECEDENCE: Record<FrontFilterRuleType, number> = {
  block: 3,
  dismiss: 2,
  never_match: 1,
};

export const frontFilterRules = pgTable(
  "front_filter_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    type: varchar("type").notNull(),
    scope: varchar("scope").notNull(),
    value: text("value").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    notes: text("notes"),
    createdBy: varchar("created_by").references(() => users.id),
    lastAppliedAt: timestamp("last_applied_at"),
    affectedCount: integer("affected_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqTypeScopeValue: unique("front_filter_rules_type_scope_value_uniq").on(
      table.type,
      table.scope,
      table.value,
    ),
    enabledIdx: index("front_filter_rules_enabled_idx").on(table.enabled),
    scopeIdx: index("front_filter_rules_scope_idx").on(table.scope),
    typeIdx: index("front_filter_rules_type_idx").on(table.type),
  }),
);

export const insertFrontFilterRuleSchema = createInsertSchema(frontFilterRules, {
  type: z.enum(frontFilterRuleTypes),
  scope: z.enum(frontFilterRuleScopes),
  value: z.string().trim().min(1).max(512),
  notes: z.string().max(2000).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastAppliedAt: true,
  affectedCount: true,
});

export type InsertFrontFilterRule = z.infer<typeof insertFrontFilterRuleSchema>;
export type FrontFilterRule = typeof frontFilterRules.$inferSelect;

// Task #1270: per-rule recent-hit log. The aggregate counter on
// `front_filter_rules` shows "is this rule alive?" at a glance; this table
// powers the "show recent hits" drill-down so operators can see exactly which
// conversations a rule is catching (and notice a stale rule silently
// swallowing real client mail). Append-only; periodic per-rule trimming is
// handled in application code (`server/services/frontFilterRules.ts`).
export const frontFilterRuleHits = pgTable(
  "front_filter_rule_hits",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    ruleId: varchar("rule_id")
      .notNull()
      .references(() => frontFilterRules.id, { onDelete: "cascade" }),
    source: varchar("source").notNull(),
    syncEmailId: varchar("sync_email_id"),
    conversationId: text("conversation_id"),
    senderEmail: text("sender_email"),
    subject: text("subject"),
    ruleType: varchar("rule_type"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    ruleCreatedIdx: index("front_filter_rule_hits_rule_created_idx").on(
      table.ruleId,
      table.createdAt,
    ),
    createdIdx: index("front_filter_rule_hits_created_idx").on(table.createdAt),
  }),
);

export type FrontFilterRuleHit = typeof frontFilterRuleHits.$inferSelect;
