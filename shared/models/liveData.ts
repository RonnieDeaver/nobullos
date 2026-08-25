// Task #2686 — Live Data snapshot model.
//
// Per-client BigQuery metric snapshots pulled hourly and surfaced in the
// Command Center "Live Data" tab. Uses the same BigQuery client and
// performance-layer auto-source mappings as RIS so the two can't drift.

import { sql } from "drizzle-orm";
import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients } from "./clients";

// ─── Metric status vocab ──────────────────────────────────────────────
export const liveDataMetricStatuses = [
  "ok",
  "not-configured",
  "no-data",
  "error",
] as const;
export type LiveDataMetricStatus = (typeof liveDataMetricStatuses)[number];

export const liveDataOverallStatuses = [
  "ok",
  "partial",
  "not-configured",
  "error",
] as const;
export type LiveDataOverallStatus = (typeof liveDataOverallStatuses)[number];

/** Zod schema for one metric entry (used to type the JSONB column). */
export const liveDataMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  unitLabel: z.string().nullable(),
  status: z.enum(liveDataMetricStatuses),
  reason: z.string().nullable(),
});

/** One metric entry inside the `metrics` JSONB column. */
export type LiveDataMetric = z.infer<typeof liveDataMetricSchema>;

// ─── Table ────────────────────────────────────────────────────────────
export const liveDataSnapshots = pgTable(
  "live_data_snapshots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    period: varchar("period", { length: 7 }).notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    overallStatus: varchar("overall_status", { length: 32 })
      .notNull()
      .default("ok"),
    metrics: jsonb("metrics").notNull().default([]),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    clientPeriodIdx: index("live_data_snapshots_client_period_idx").on(
      table.clientId,
      table.period,
    ),
    clientFetchedIdx: index("live_data_snapshots_client_fetched_idx").on(
      table.clientId,
      table.fetchedAt,
    ),
  }),
);

export const insertLiveDataSnapshotSchema = createInsertSchema(
  liveDataSnapshots,
  {
    period: z.string().regex(/^\d{4}-\d{2}$/),
    overallStatus: z.enum(liveDataOverallStatuses).default("ok"),
    metrics: z.array(liveDataMetricSchema).default([]),
  },
).omit({ id: true, createdAt: true });

export type InsertLiveDataSnapshot = z.infer<
  typeof insertLiveDataSnapshotSchema
>;
export type LiveDataSnapshot = typeof liveDataSnapshots.$inferSelect;
