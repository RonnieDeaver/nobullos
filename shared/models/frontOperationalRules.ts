import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const frontOperationalRuleCategories = [
  "automated_sender_pattern",
  "operational_domain",
  "operational_subject_pattern",
  "content_spam_signal",
  "internal_domain",
  "internal_exact_email",
] as const;
export type FrontOperationalRuleCategory =
  typeof frontOperationalRuleCategories[number];

export const FRONT_OPERATIONAL_RULE_CATEGORY_LABELS: Record<
  FrontOperationalRuleCategory,
  string
> = {
  automated_sender_pattern: "Automated sender patterns",
  operational_domain: "Operational sender domains",
  operational_subject_pattern: "Operational subject patterns",
  content_spam_signal: "Content spam signals",
  internal_domain: "Internal company domains",
  internal_exact_email: "Internal exact emails",
};

export const frontOperationalRules = pgTable(
  "front_operational_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    category: varchar("category").notNull(),
    value: text("value").notNull(),
    weight: numeric("weight", { precision: 6, scale: 3 }),
    label: varchar("label", { length: 128 }),
    enabled: boolean("enabled").default(true).notNull(),
    notes: text("notes"),
    createdBy: varchar("created_by").references(() => users.id),
    lastAppliedAt: timestamp("last_applied_at"),
    affectedCount: integer("affected_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqCategoryValue: unique("front_operational_rules_category_value_uniq").on(
      table.category,
      table.value,
    ),
    categoryEnabledIdx: index(
      "front_operational_rules_category_enabled_idx",
    ).on(table.category, table.enabled),
    enabledIdx: index("front_operational_rules_enabled_idx").on(table.enabled),
  }),
);

export const insertFrontOperationalRuleSchema = createInsertSchema(
  frontOperationalRules,
  {
    category: z.enum(frontOperationalRuleCategories),
    value: z.string().trim().min(1).max(2000),
    weight: z.union([z.string(), z.number()]).nullable().optional(),
    label: z.string().max(128).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastAppliedAt: true,
  affectedCount: true,
});

export type InsertFrontOperationalRule = z.infer<
  typeof insertFrontOperationalRuleSchema
>;
export type FrontOperationalRule = typeof frontOperationalRules.$inferSelect;

export const frontOperationalRuleHits = pgTable(
  "front_operational_rule_hits",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    ruleId: varchar("rule_id")
      .notNull()
      .references(() => frontOperationalRules.id, { onDelete: "cascade" }),
    category: varchar("category"),
    source: varchar("source").notNull(),
    syncEmailId: varchar("sync_email_id"),
    conversationId: text("conversation_id"),
    senderEmail: text("sender_email"),
    subject: text("subject"),
    prevReason: text("prev_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    ruleCreatedIdx: index(
      "front_operational_rule_hits_rule_created_idx",
    ).on(table.ruleId, table.createdAt),
    createdIdx: index("front_operational_rule_hits_created_idx").on(
      table.createdAt,
    ),
  }),
);

export type FrontOperationalRuleHit =
  typeof frontOperationalRuleHits.$inferSelect;

// Task #1948 — Durable recent-deletions audit so the Front Console
// "Just created" banner can render the "Removed by <user>" marker even
// after a server restart inside the 5-minute banner window. The list
// endpoint reads rows where deleted_at is within the last ~10 minutes;
// older rows stay in the table as a small audit trail.
export const frontOperationalRuleDeletions = pgTable(
  "front_operational_rule_deletions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    ruleId: varchar("rule_id").notNull(),
    category: varchar("category").notNull(),
    value: text("value").notNull(),
    label: varchar("label", { length: 128 }),
    ruleCreatedAt: timestamp("rule_created_at").notNull(),
    deletedAt: timestamp("deleted_at").defaultNow().notNull(),
    deletedById: varchar("deleted_by_id").references(() => users.id),
    deletedByName: text("deleted_by_name"),
  },
  (table) => ({
    deletedAtIdx: index(
      "front_operational_rule_deletions_deleted_at_idx",
    ).on(table.deletedAt),
  }),
);

export type FrontOperationalRuleDeletion =
  typeof frontOperationalRuleDeletions.$inferSelect;

export const FRONT_OPERATIONAL_THRESHOLD_KEYS = {
  operationalConfidence: "front_operational_confidence_threshold",
  memoryConfidence: "front_operational_memory_confidence_threshold",
  spamScore: "front_operational_spam_score_threshold",
} as const;

export const FRONT_OPERATIONAL_THRESHOLD_DEFAULTS = {
  operationalConfidence: 0.7,
  memoryConfidence: 0.65,
  spamScore: 3.0,
} as const;

export type FrontOperationalThresholds = {
  operationalConfidence: number;
  memoryConfidence: number;
  spamScore: number;
};
