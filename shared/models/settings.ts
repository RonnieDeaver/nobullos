import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const practiceAreaSettings = pgTable("practice_area_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  practiceArea: text("practice_area").notNull().unique(),
  searchTerm: text("search_term").notNull(),
  monthlyData: jsonb("monthly_data"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPracticeAreaSettingSchema = createInsertSchema(practiceAreaSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPracticeAreaSetting = z.infer<typeof insertPracticeAreaSettingSchema>;
export type PracticeAreaSetting = typeof practiceAreaSettings.$inferSelect;

export const phaseSettingsPhases = ["Peak", "Hold", "Taper", "Soft", "Rebuild"] as const;
export type PhaseSettingsPhase = typeof phaseSettingsPhases[number];

export const phaseSettings = pgTable("phase_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phase: text("phase").notNull().unique(),
  actions: text("actions").array().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPhaseSettingSchema = createInsertSchema(phaseSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertPhaseSetting = z.infer<typeof insertPhaseSettingSchema>;
export type PhaseSetting = typeof phaseSettings.$inferSelect;

export const systemSettings = pgTable("system_settings", {
  key: varchar("key").primaryKey(),
  value: text("value"),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSystemSettingSchema = createInsertSchema(systemSettings).omit({
  updatedAt: true,
});

export type InsertSystemSetting = z.infer<typeof insertSystemSettingSchema>;
export type SystemSetting = typeof systemSettings.$inferSelect;

export const staleLeaseThresholdAudit = pgTable("stale_lease_threshold_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  changedBy: varchar("changed_by").references(() => users.id),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values").notNull(),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
});

export const insertStaleLeaseThresholdAuditSchema = createInsertSchema(staleLeaseThresholdAudit).omit({
  id: true,
  changedAt: true,
});

export type InsertStaleLeaseThresholdAudit = z.infer<typeof insertStaleLeaseThresholdAuditSchema>;
export type StaleLeaseThresholdAudit = typeof staleLeaseThresholdAudit.$inferSelect;

// Generic audit trail for admin-tunable settings (rate-limit thresholds,
// warning percents, multipliers, etc). One row per change. `settingKey`
// identifies the setting family; `scope` optionally narrows it (e.g. category
// name for per-category settings). `oldValues` is null on the first record.
export const adminSettingAudit = pgTable("admin_setting_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  settingKey: varchar("setting_key", { length: 128 }).notNull(),
  scope: varchar("scope", { length: 128 }),
  changedBy: varchar("changed_by").references(() => users.id),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values"),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  slackStatus: varchar("slack_status"),
  emailStatus: varchar("email_status"),
  slackFailureReason: text("slack_failure_reason"),
  emailFailureReason: text("email_failure_reason"),
  // Trigger metadata for the most recent operator-initiated resend of this
  // alert. Populated by the generic resend guard; null until a resend occurs.
  lastResendAt: timestamp("last_resend_at"),
  lastResendBy: varchar("last_resend_by").references(() => users.id),
  lastResendSource: varchar("last_resend_source"),
});

export const insertAdminSettingAuditSchema = createInsertSchema(adminSettingAudit).omit({
  id: true,
  changedAt: true,
});

export type InsertAdminSettingAudit = z.infer<typeof insertAdminSettingAuditSchema>;
export type AdminSettingAudit = typeof adminSettingAudit.$inferSelect;

export const queueTimingAudit = pgTable("queue_timing_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  changedBy: varchar("changed_by").references(() => users.id),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values").notNull(),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
});

export const insertQueueTimingAuditSchema = createInsertSchema(queueTimingAudit).omit({
  id: true,
  changedAt: true,
});

export type InsertQueueTimingAudit = z.infer<typeof insertQueueTimingAuditSchema>;
export type QueueTimingAudit = typeof queueTimingAudit.$inferSelect;
