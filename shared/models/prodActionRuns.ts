import { pgTable, varchar, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// "blocked" (Task #2111) — an action that could not proceed because an
// integration login expired / is disconnected (operator must reconnect).
// It is NOT an error: `error_message` is left null for blocked runs.
export const prodActionOutcomeStates = ["applied", "not-needed", "error", "blocked"] as const;
export type ProdActionOutcomeState = (typeof prodActionOutcomeStates)[number];

export const prodActionRuns = pgTable(
  "prod_action_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    actionId: varchar("action_id", { length: 128 }).notNull(),
    actionTitle: varchar("action_title", { length: 256 }).notNull(),
    actorUserId: varchar("actor_user_id"),
    outcomeState: varchar("outcome_state", { length: 16 }).notNull(),
    detail: text("detail"),
    rowsAffected: integer("rows_affected"),
    errorMessage: text("error_message"),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
  },
  (table) => ({
    appliedAtIdx: index("idx_prod_action_runs_applied_at").on(table.appliedAt),
    actionStateTimeIdx: index("idx_prod_action_runs_action_state_time").on(
      table.actionId,
      table.outcomeState,
      table.appliedAt,
    ),
  }),
);

export const insertProdActionRunSchema = createInsertSchema(prodActionRuns).omit({
  id: true,
  appliedAt: true,
});
export type InsertProdActionRun = z.infer<typeof insertProdActionRunSchema>;
export type ProdActionRun = typeof prodActionRuns.$inferSelect;
