import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const workQueueStatuses = ["pending", "leased", "processing", "completed", "failed", "dead_letter", "cancelled"] as const;
export type WorkQueueStatus = typeof workQueueStatuses[number];

// Task #1829 — `front_ingestion` is a dedicated workload class for the
// three Front pipeline queues (`front_webhook_normalize`,
// `front_webhook_apply`, `front_reconciliation`). When the
// `front_warp_speed_enabled` kill switch is ON, new Front-queue
// enqueues route here (via `enqueueJob`) and a separate fast-poll
// scheduler timer multi-dispatches jobs from this class every
// `front_ingestion_poll_interval_ms` (default 500 ms) up to
// `front_ingestion_class_concurrency` (default 4). When the switch is
// OFF the class is dormant and Front rows stay on `ingestion`, so
// deploys are no-ops until the operator flips the master switch.
// `workload_class` is `varchar` in Postgres — adding a new value
// requires no migration.
export const workloadClasses = ["interactive", "interactive_repair", "ingestion", "front_ingestion", "repair", "maintenance"] as const;
export type WorkloadClass = typeof workloadClasses[number];

export const workQueuePriorities = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const REPAIR_QUEUE_CLASSES = ["interactive_repair", "repair", "maintenance"] as const;
export type RepairQueueClass = (typeof REPAIR_QUEUE_CLASSES)[number];

export const workQueue = pgTable("work_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  queueName: varchar("queue_name").notNull(),
  jobType: varchar("job_type").notNull(),
  workloadClass: varchar("workload_class").notNull(),
  priority: integer("priority").default(5).notNull(),
  status: varchar("status").default("pending").notNull(),
  payload: jsonb("payload"),
  payloadJson: jsonb("payload_json"),
  dedupeKey: varchar("dedupe_key"),
  cursor: text("cursor"),
  cursorJson: jsonb("cursor_json"),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  retryAt: timestamp("retry_at"),
  leasedAt: timestamp("leased_at"),
  leaseOwner: varchar("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  heartbeatAt: timestamp("heartbeat_at"),
  errorCode: varchar("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  statusWorkloadIdx: index("idx_work_queue_status_class").on(table.status, table.workloadClass),
  queueNameIdx: index("idx_work_queue_queue_name").on(table.queueName),
  retryAtIdx: index("idx_work_queue_retry_at").on(table.retryAt),
  priorityIdx: index("idx_work_queue_priority").on(table.priority),
  leaseExpiresIdx: index("idx_work_queue_lease_expires").on(table.leaseExpiresAt),
  statusRetryAtIdx: index("wq_status_retry_at_idx").on(table.status, table.retryAt),
  classPriorityIdx: index("wq_class_status_priority_created_idx").on(table.workloadClass, table.status, table.priority, table.createdAt),
  dedupeIdx: uniqueIndex("wq_dedupe_key_idx")
    .on(table.dedupeKey)
    .where(sql`dedupe_key IS NOT NULL AND status NOT IN ('completed', 'failed', 'dead_letter', 'cancelled')`),
}));

export const insertWorkQueueSchema = createInsertSchema(workQueue).omit({
  id: true,
  createdAt: true,
});

export type InsertWorkQueue = z.infer<typeof insertWorkQueueSchema>;

export const insertWorkQueueJobSchema = createInsertSchema(workQueue, {
  status: z.enum(workQueueStatuses).optional(),
  priority: z.number().int().min(0).max(9).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  attemptCount: true,
  leaseOwner: true,
  leaseExpiresAt: true,
  heartbeatAt: true,
  leasedAt: true,
  errorCode: true,
  errorMessage: true,
  retryAt: true,
});

export type InsertWorkQueueJob = z.infer<typeof insertWorkQueueJobSchema>;
export type WorkQueueJob = typeof workQueue.$inferSelect;
