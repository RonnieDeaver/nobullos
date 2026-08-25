import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  jsonb,
  timestamp,
  boolean,
  integer,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients, clientLocations } from "./clients";

// ─── Task #2367 — Revenue Integrity System (RIS) QA Layer (V1) ─────────
//
// RIS is a granular, per-client / per-product / per-location QA checklist
// ledger owned by the Reporting role. It is *additive depth* over the
// Monthly Review (the Command Panel "reviewed this month" freshness
// check) — it must not re-check anything that already covers.
//
// V1 is fully manual: every check is usable by hand. Each catalog row
// optionally carries an `autoSource` tag that a later BigQuery auto-pull
// task will populate; until then auto checks simply sit at "Needs
// Review". This module defines only the QA layer — Performance and
// Engagement layers are separate future tasks.

// The layer this catalog row belongs to. V1 ships only `qa`; the column
// exists so the Performance / Engagement layers can share the table.
export const risLayers = ["qa", "performance", "engagement"] as const;
export type RisLayer = (typeof risLayers)[number];

// Product the check applies to. `universal` checks apply to every client
// regardless of product mix; the rest are gated on the client's
// effective product list (see resolveEffectiveProducts).
export const risProducts = [
  "universal",
  "gbp",
  "google_ads",
  "lsa",
  "webinar",
] as const;
export type RisProduct = (typeof risProducts)[number];

export const risCategories = [
  "access",
  "tracking",
  "fulfillment",
  "automation",
  "reporting",
  "spend_delivery",
  // Task #2371 — Performance Layer categories. `spend_delivery` is shared
  // with QA; the rest group marketing-output metrics on the health cards.
  "leads",
  "visibility",
  "reviews",
  "efficiency",
  // Engagement layer (Task #2388). `client_engagement` = is the client
  // cooperating; `nobull_cadence` = are WE communicating enough.
  "client_engagement",
  "nobull_cadence",
] as const;
export type RisCategory = (typeof risCategories)[number];

// Cadence. Weekly checks recur within the calendar month; monthly checks
// appear once per month; launch-only checks surface when a
// client/product/location is newly added or changed (V1 heuristic: they
// stay "due" until resolved once).
export const risFrequencies = ["weekly", "monthly", "launch_only"] as const;
export type RisFrequency = (typeof risFrequencies)[number];

export const risSeverities = ["low", "medium", "high", "critical"] as const;
export type RisSeverity = (typeof risSeverities)[number];

export const risStatuses = [
  "pass",
  "fail",
  "na",
  "blocked",
  "needs_review",
] as const;
export type RisStatus = (typeof risStatuses)[number];

// ─── Task #2371 — Performance Layer statuses + metric model ────────────
//
// The Performance Layer answers "are NoBull's marketing campaigns
// producing the expected output?" with a color-coded health view rather
// than the QA layer's Pass/Fail ledger. Its result rows live in the same
// `ris_check_results` table but use a different status vocabulary derived
// from period-over-period change vs admin-tunable thresholds.
export const risPerformanceStatuses = [
  "green",
  "yellow",
  "red",
  "gray",
  "na",
] as const;
export type RisPerformanceStatus = (typeof risPerformanceStatuses)[number];

// Every valid result status across all layers. `na` is shared. The result
// ledger column is layer-agnostic; the route validates that a saved status
// is appropriate for the check's layer (see isStatusValidForLayer).
export const risAllStatuses = [
  "pass",
  "fail",
  "na",
  "blocked",
  "needs_review",
  "green",
  "yellow",
  "red",
  "gray",
] as const;
export type RisAnyStatus = (typeof risAllStatuses)[number];

/** Which status set a given layer accepts. QA uses pass/fail/etc.;
 *  Performance uses green/yellow/red/gray/na. Used by the result-save
 *  route so a layer can't be written with a foreign status. */
export function isStatusValidForLayer(layer: string, status: string): boolean {
  if (layer === "performance") {
    return (risPerformanceStatuses as readonly string[]).includes(status);
  }
  // qa (and any not-yet-built layer) keeps the original QA vocabulary.
  return (risStatuses as readonly string[]).includes(status);
}

// The kind of metric a Performance check measures. Drives how its
// period-over-period change is scored against the threshold bands:
//   volume — higher is better (leads, registrants, clicks)
//   cost   — lower is better (CPL, CPC, cost per consult)
//   rate   — higher is better, tighter bands (CTR, attendance rate)
//   budget — pacing ratio vs 100% of expected spend (single value)
export const risMetricTypes = ["volume", "cost", "rate", "budget"] as const;
export type RisMetricType = (typeof risMetricTypes)[number];

// Optional per-check override of the default threshold bands, stored as
// JSONB on the catalog row so an admin can tune a single metric without a
// deploy. All fields optional; absent fields fall back to the metric-type
// defaults in risThresholds.ts.
export const risThresholdOverrideSchema = z
  .object({
    // volume/rate: percent DROP boundaries (positive numbers).
    // cost: percent RISE boundaries (positive numbers).
    yellow: z.number().optional(),
    red: z.number().optional(),
    // budget pacing: acceptable / modest bands as percent of expected (100 = on pace).
    greenLow: z.number().optional(),
    greenHigh: z.number().optional(),
    yellowLow: z.number().optional(),
    yellowHigh: z.number().optional(),
    // minimum prior-period volume below which a volume metric is Gray.
    minVolume: z.number().optional(),
  })
  .strict();
export type RisThresholdOverride = z.infer<typeof risThresholdOverrideSchema>;

export const risResultSources = ["manual", "auto"] as const;
export type RisResultSource = (typeof risResultSources)[number];

// Task #2368 — comparator a mapping uses to turn an observed numeric value
// into a suggested status. `none` means "record the observed value but let
// a human decide the status" → the auto-pull leaves it at needs_review.
export const risAutoComparators = [
  "gte",
  "lte",
  "gt",
  "lt",
  "eq",
  "ne",
  "none",
] as const;
export type RisAutoComparator = (typeof risAutoComparators)[number];

// ─── Catalog: the data-driven checklist definition ────────────────────
export const risChecks = pgTable(
  "ris_checks",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stable machine key — the seed and any auto-pull join on this, and
    // it is the conflict target that keeps re-seeding from clobbering
    // admin edits.
    key: varchar("key").notNull().unique(),
    label: text("label").notNull(),
    description: text("description"),
    layer: varchar("layer").notNull().default("qa"),
    product: varchar("product").notNull(),
    category: varchar("category").notNull(),
    frequency: varchar("frequency").notNull(),
    // When true the check is evaluated once per active location, so the
    // drill-down renders one row per location.
    locationSpecific: boolean("location_specific").notNull().default(false),
    defaultSeverity: varchar("default_severity").notNull().default("medium"),
    // The user FUNCTION responsible by default (e.g. gbp_expert). Used to
    // route the escalation flag. Nullable → falls back to reporting_expert.
    defaultOwnerFunction: varchar("default_owner_function"),
    // The BigQuery field this check will later auto-pull from. NULL means
    // the check is inherently manual. Dormant in V1.
    autoSource: varchar("auto_source"),
    // Task #2371 — Performance Layer only. The metric kind (volume / cost /
    // rate / budget) that drives how period-over-period change is scored.
    // NULL for QA checks.
    metricType: varchar("metric_type"),
    // Task #2371 — optional per-check JSONB override of the default
    // threshold bands (see risThresholdOverrideSchema). NULL → metric-type
    // defaults apply.
    thresholds: jsonb("thresholds"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    // Marks rows planted by the V1 seed so the UI can warn before delete.
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    layerProductIdx: index("ris_checks_layer_product_idx").on(
      table.layer,
      table.product,
    ),
    activeIdx: index("ris_checks_active_idx").on(table.active),
  }),
);

export const insertRisCheckSchema = createInsertSchema(risChecks, {
  layer: z.enum(risLayers).default("qa"),
  product: z.enum(risProducts),
  category: z.enum(risCategories),
  frequency: z.enum(risFrequencies),
  defaultSeverity: z.enum(risSeverities).default("medium"),
  autoSource: z.string().min(1).nullable().optional(),
  defaultOwnerFunction: z.string().min(1).nullable().optional(),
  metricType: z.enum(risMetricTypes).nullable().optional(),
  thresholds: risThresholdOverrideSchema.nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Admin edit form — every field optional, key/layer locked after create.
export const updateRisCheckSchema = insertRisCheckSchema
  .omit({ key: true })
  .partial();

export type InsertRisCheck = z.infer<typeof insertRisCheckSchema>;
export type UpdateRisCheck = z.infer<typeof updateRisCheckSchema>;
export type RisCheck = typeof risChecks.$inferSelect;

// ─── Result ledger: one row per check × client × location × period ────
//
// `period` is the calendar month `YYYY-MM` for weekly/monthly checks and
// the literal `launch` for launch-only checks (which are not month
// scoped). `locationId` is NULL for non-location-specific checks; the
// uniqueness of (check, client, location, period) is enforced by a
// COALESCE unique index in the migration so a NULL location still
// collapses to a single row.
export const risCheckResults = pgTable(
  "ris_check_results",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    checkId: varchar("check_id")
      .references(() => risChecks.id, { onDelete: "cascade" })
      .notNull(),
    clientId: varchar("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    locationId: varchar("location_id").references(() => clientLocations.id, {
      onDelete: "cascade",
    }),
    period: varchar("period").notNull(),
    status: varchar("status").notNull(),
    observedValue: text("observed_value"),
    // Task #2371 — Performance Layer numeric provenance, stored as text so a
    // currency/ratio value keeps its exact rendered form. NULL for QA rows.
    currentValue: text("current_value"),
    previousValue: text("previous_value"),
    targetValue: text("target_value"),
    // Signed period-over-period percent change (e.g. "-18.4"). NULL when a
    // comparison could not be computed (insufficient/zero prior volume).
    changePct: text("change_pct"),
    notes: text("notes"),
    evidenceUrl: text("evidence_url"),
    failureReason: text("failure_reason"),
    correctiveAction: text("corrective_action"),
    severityOverride: varchar("severity_override"),
    source: varchar("source").notNull().default("manual"),
    // Task #2368 — when an auto (BigQuery) value is human-confirmed it
    // "sticks": confirmedAt/By are stamped and the auto-pull then skips the
    // row so a later refresh can't silently overwrite the confirmed value.
    // A manual override clears these (the row becomes source='manual').
    confirmedAt: timestamp("confirmed_at"),
    confirmedBy: varchar("confirmed_by").references(() => users.id),
    // Task #2368 — when an auto-pull can't produce a trustworthy value
    // (BigQuery unreachable, mapping unconfigured, query error, or no row)
    // the result is parked at needs_review and the plain-English reason is
    // stored here so the dashboard never shows a silent Pass.
    autoError: text("auto_error"),
    checkedBy: varchar("checked_by").references(() => users.id),
    checkedAt: timestamp("checked_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    clientPeriodIdx: index("ris_check_results_client_period_idx").on(
      table.clientId,
      table.period,
    ),
    checkIdx: index("ris_check_results_check_idx").on(table.checkId),
    statusIdx: index("ris_check_results_status_idx").on(table.status),
  }),
);

export const insertRisCheckResultSchema = createInsertSchema(risCheckResults, {
  // Layer-agnostic at the schema level (a perf row stores green/yellow/…,
  // a QA row stores pass/fail/…). The save route enforces the right set per
  // the check's layer via isStatusValidForLayer.
  status: z.enum(risAllStatuses),
  severityOverride: z.enum(risSeverities).nullable().optional(),
  source: z.enum(risResultSources).default("manual"),
  evidenceUrl: z.string().url().nullable().optional().or(z.literal("")),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRisCheckResult = z.infer<typeof insertRisCheckResultSchema>;
export type RisCheckResult = typeof risCheckResults.$inferSelect;

// ─── Task #2368 — BigQuery auto-pull mapping registry ─────────────────
//
// The RIS catalog tags some checks with an `autoSource` string. This
// table is the RUNTIME-CONFIGURABLE bridge from that tag to the BigQuery
// query that produces its observed value. It is deliberately decoupled
// from the catalog because the BigQuery dataset/tables/columns are owned
// by a separate (future) BigQuery migration and are NOT assumed here:
// every mapping ships disabled with a blank SQL template, and an operator
// fills in the real `sqlTemplate` + threshold once BigQuery is ready.
//
// Until a mapping is `enabled` AND has a non-blank `sqlTemplate`, the
// auto-pull parks the matching checks at needs_review (never a silent
// Pass) — that is the default-OFF degrade-gracefully posture the task
// requires.
//
// The `sqlTemplate` is a parameterized BigQuery Standard SQL query that
// MUST select a single row exposing the `valueColumn`. Four named
// parameters are always bound by the runner (the author references the
// ones they need): @clientId (text), @locationId (text or NULL for
// non-location checks), @periodStart ('YYYY-MM-DD', inclusive) and
// @periodEnd ('YYYY-MM-DD', exclusive — first day of the next month).
export const risAutoSourceMappings = pgTable(
  "ris_auto_source_mappings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Joins to ris_checks.auto_source. One mapping per distinct tag.
    autoSource: varchar("auto_source").notNull().unique(),
    // Human label + notes for the admin editor.
    label: text("label").notNull(),
    description: text("description"),
    // Master per-mapping switch. Default OFF so a freshly seeded mapping
    // never starts pulling before an operator has vetted its SQL.
    enabled: boolean("enabled").notNull().default(false),
    // Parameterized BigQuery Standard SQL. Blank until configured.
    sqlTemplate: text("sql_template").notNull().default(""),
    // The column in the query's single result row that carries the value.
    valueColumn: varchar("value_column").notNull().default("value"),
    // How the observed numeric value becomes a suggested status. `none`
    // records the value but leaves the status at needs_review.
    comparator: varchar("comparator").notNull().default("none"),
    // Numeric threshold the comparator compares the observed value against.
    threshold: text("threshold"),
    // Display unit appended to the observed value (e.g. "posts", "$").
    unitLabel: varchar("unit_label"),
    // Optional BigQuery job location (e.g. "US", "EU"). Falls back to the
    // BIGQUERY_LOCATION env / library default when null.
    bqLocation: varchar("bq_location"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    enabledIdx: index("ris_auto_source_mappings_enabled_idx").on(table.enabled),
  }),
);

export const upsertRisAutoSourceMappingSchema = createInsertSchema(
  risAutoSourceMappings,
  {
    autoSource: z.string().min(1),
    label: z.string().min(1),
    comparator: z.enum(risAutoComparators).default("none"),
    threshold: z.string().nullable().optional(),
    unitLabel: z.string().nullable().optional(),
    bqLocation: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Admin edit form — every field except the immutable autoSource key is
// optional so a PATCH can touch just the SQL or just the toggle.
export const updateRisAutoSourceMappingSchema = upsertRisAutoSourceMappingSchema
  .omit({ autoSource: true })
  .partial();

export type UpsertRisAutoSourceMapping = z.infer<
  typeof upsertRisAutoSourceMappingSchema
>;
export type UpdateRisAutoSourceMapping = z.infer<
  typeof updateRisAutoSourceMappingSchema
>;
export type RisAutoSourceMapping = typeof risAutoSourceMappings.$inferSelect;

// ─── Task #2485 — Per-client auto-source rule overrides ───────────────
//
// A per-client override of the global `ris_auto_source_mappings` row for a
// single `auto_source`. Every field is nullable and means "inherit the
// global mapping's value" when null; a non-null value wins. The resolver
// (server/services/ris/risRuleResolution.ts) layers the override over the
// global mapping so BOTH the QA auto-pull and the Performance pull resolve
// the effective rule through one shared path. There is no per-override
// `enabled` flag: the global mapping's `enabled` toggle still governs
// whether a check pulls at all.
export const risClientAutoSourceOverrides = pgTable(
  "ris_client_auto_source_overrides",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    // Joins to ris_checks.auto_source / ris_auto_source_mappings.auto_source.
    autoSource: varchar("auto_source").notNull(),
    // Each mirrors the same-named global mapping field; null = inherit.
    sqlTemplate: text("sql_template"),
    valueColumn: varchar("value_column"),
    comparator: varchar("comparator"),
    threshold: text("threshold"),
    bqLocation: varchar("bq_location"),
    // Extra per-client filter value bound into the query as `@filterValue`
    // (STRING). Lets one client's template narrow to a sub-account / tag.
    filterValue: text("filter_value"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    clientSourceUnique: unique("ris_client_auto_source_overrides_client_source_unique").on(
      table.clientId,
      table.autoSource,
    ),
    clientIdx: index("ris_client_auto_source_overrides_client_idx").on(
      table.clientId,
    ),
  }),
);

export const upsertRisClientAutoSourceOverrideSchema = createInsertSchema(
  risClientAutoSourceOverrides,
  {
    clientId: z.string().min(1),
    autoSource: z.string().min(1),
    sqlTemplate: z.string().nullable().optional(),
    valueColumn: z.string().nullable().optional(),
    comparator: z.enum(risAutoComparators).nullable().optional(),
    threshold: z.string().nullable().optional(),
    bqLocation: z.string().nullable().optional(),
    filterValue: z.string().nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// PATCH form — override fields only (the keying client+autoSource come from
// the route params, not the body).
export const updateRisClientAutoSourceOverrideSchema =
  upsertRisClientAutoSourceOverrideSchema
    .omit({ clientId: true, autoSource: true })
    .partial();

export type UpsertRisClientAutoSourceOverride = z.infer<
  typeof upsertRisClientAutoSourceOverrideSchema
>;
export type UpdateRisClientAutoSourceOverride = z.infer<
  typeof updateRisClientAutoSourceOverrideSchema
>;
export type RisClientAutoSourceOverride =
  typeof risClientAutoSourceOverrides.$inferSelect;
