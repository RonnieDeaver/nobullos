import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, unique, index, uniqueIndex, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const productOptions = ["gbp", "google_ads", "lsa", "webinar"] as const;
export type ProductOption = typeof productOptions[number];

/**
 * Task #4330 — account lifecycle stages (HubSpot-style, forward-only
 * automatic advancement). `clients.lifecycle_stage` defaults to 'customer'
 * so every pre-existing row (and every row created through the normal
 * client-creation surfaces) is a paying client — the default IS the
 * backfill. Prospect rows (`lifecycle_stage <> 'customer'`) are created
 * only by the lead-intake paths (website inquiries, bookings) and are
 * gated OUT of the operational client accessors so reports, judgments,
 * churn, service desk, etc. never see them. Order matters: rank drives
 * the forward-only advance in leadLifecycleStorage.
 */
export const clientLifecycleStages = ["lead", "session_booked", "opportunity", "customer"] as const;
export type ClientLifecycleStage = typeof clientLifecycleStages[number];

export const clientLifecycleStageRank: Record<ClientLifecycleStage, number> = {
  lead: 0,
  session_booked: 1,
  opportunity: 2,
  customer: 3,
};

export const clientLifecycleStageLabels: Record<ClientLifecycleStage, string> = {
  lead: "Lead",
  session_booked: "Session booked",
  opportunity: "Opportunity",
  customer: "Customer",
};

/** What caused a lifecycle transition (client_lifecycle_history.source). */
export const clientLifecycleChangeSources = [
  "website_inquiry",
  "booking",
  "deal_created",
  "deal_won",
  "automation",
  "manual",
] as const;
export type ClientLifecycleChangeSource = typeof clientLifecycleChangeSources[number];

/** Where a lead record originally came from (clients.lead_source). */
export const leadSources = ["website_inquiry", "booking", "manual"] as const;
export type LeadSource = typeof leadSources[number];

export const clients = pgTable("clients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientCode: varchar("client_code", { length: 10 }).unique(),
  firmName: text("firm_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  consultType: varchar("consult_type").default("free"),
  practiceAreas: text("practice_areas").array(),
  products: text("products").array().default(sql`ARRAY['gbp']::text[]`),
  averageCaseValue: real("average_case_value"),
  // Task #2596 — per-client monthly review target (reviews/month). The Review
  // Generation velocity band (Task #2579) falls back to this when a report has
  // no per-report `reviewGeneration.monthlyTarget`, so the goal is entered once
  // and applies to every month (historical reports included). A per-report value
  // still overrides. Null / <= 0 means "no target" (neutral band, never silent
  // green/red).
  monthlyReviewTarget: integer("monthly_review_target"),
  // Task #867: per-client trusted email domains used by the Front hard
  // matcher. A participant whose email domain is in this list (and that
  // domain is not company/public) auto-claims that client. Domains are
  // stored normalised (lowercase, leading `@` stripped).
  emailDomains: text("email_domains").array().default(sql`ARRAY[]::text[]`),
  initialLeads: integer("initial_leads").default(0),
  initialReviews: integer("initial_reviews").default(0),
  initialCases: integer("initial_cases").default(0),
  isDemo: boolean("is_demo").default(false),
  isArchived: boolean("is_archived").default(false),
  terminology: jsonb("terminology"),
  clientStartDate: timestamp("client_start_date"),
  hasPostConsultReviewAccess: boolean("has_post_consult_review_access").default(false),
  hasPostCaseClosedReviewAccess: boolean("has_post_case_closed_review_access").default(false),
  // Task #2667 — per-client, team-controlled toggle. When true, the client's
  // public report suppresses the "Other" lead bucket (social / direct call /
  // referral / residual / inactive-product leads) everywhere it would
  // otherwise be folded in: total leads, the lead-source pie + legend +
  // percentages, lead-quality denominators, and downstream figures derived
  // from total leads. Default false → reports are byte-for-byte unchanged.
  // The underlying "Other" data is still imported and stored unchanged; this
  // only suppresses it from the rendered report.
  hideOtherLeads: boolean("hide_other_leads").default(false),
  stripeCustomerId: varchar("stripe_customer_id"),
  // Task #2485: per-client BigQuery binding key. Passed into the RIS
  // auto-pull / Performance BigQuery queries as the `@clientKey` STRING
  // named param so a client's rows can be selected by a tenant key that is
  // not its internal `id`. Null until a manager sets it in RIS Setup; a
  // resolved query template that references `@clientKey` while this is unset
  // degrades that check to Needs Review (never a silent Pass).
  bigQueryClientKey: text("big_query_client_key"),
  ownerId: varchar("owner_id").references(() => users.id),
  // Task #1785: SEMrush demand-driven cadence — bumped when a user
  // views the heatmap, GBP/local-dominance page, or renders a report
  // for this client. Read by the SEMrush cadence gate to decide
  // whether the client is "active enough" to refresh.
  lastViewedAt: timestamp("last_viewed_at"),
  // Task #4330 — lifecycle stage (see clientLifecycleStages above). Server-
  // owned: omitted from insert/update schemas; changes flow ONLY through
  // leadLifecycleStorage (forward-only auto-advance + audited manual set).
  lifecycleStage: varchar("lifecycle_stage").notNull().default("customer").$type<ClientLifecycleStage>(),
  // Task #4330 — intake provenance for lead-stage rows (null for clients
  // created through the normal operator surfaces).
  leadSource: varchar("lead_source"),
  // Task #4330 — last intake/lifecycle activity (inquiry received, session
  // booked, stage advanced). Drives the Leads view "last activity" column.
  leadLastActivityAt: timestamp("lead_last_activity_at"),
  // Task #4337 — immutable first-touch attribution, stamped ONCE when the
  // row is minted by an intake path (website inquiry / public booking) and
  // never re-derived or overwritten. NULL for operator-created and
  // pre-feature rows (renders as "Unknown"); a captured touch with no UTM/
  // referrer stamps "direct" — never blank. Campaign stamp is the normalized
  // utm_campaign key (joins marketing_campaigns by string, not FK).
  firstTouchSource: varchar("first_touch_source", { length: 80 }),
  firstTouchCampaign: varchar("first_touch_campaign", { length: 120 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  ownerIdx: index("clients_owner_id_idx").on(table.ownerId),
  lastViewedAtIdx: index("clients_last_viewed_at_idx").on(table.lastViewedAt),
  // Task #4330 — prospects are a tiny minority of rows; the partial index
  // keeps Leads-view scans indexed without bloating customer-only filters.
  lifecycleProspectIdx: index("clients_lifecycle_prospect_idx")
    .on(table.lifecycleStage)
    .where(sql`lifecycle_stage <> 'customer'`),
  // Task #4337 — campaign detail pages look up attributed leads by key;
  // stamped rows are a minority, so the index is partial.
  firstTouchCampaignIdx: index("clients_first_touch_campaign_idx")
    .on(table.firstTouchCampaign)
    .where(sql`first_touch_campaign IS NOT NULL`),
}));

export const terminologyKeys = [
  "consults",
  "cases",
  "leads",
  "noShowRate",
  "missedCallRate",
  "averageCaseValue",
  "followUps",
] as const;
export type TerminologyKey = typeof terminologyKeys[number];

export const terminologyDefaults: Record<TerminologyKey, string> = {
  consults: "Consults",
  cases: "Cases",
  leads: "Leads",
  noShowRate: "No-Show Rate",
  missedCallRate: "Missed Call Rate",
  averageCaseValue: "Average Case Value",
  followUps: "Follow-Ups",
};

export const terminologySchema = z.object({
  consults: z.string().optional(),
  cases: z.string().optional(),
  leads: z.string().optional(),
  noShowRate: z.string().optional(),
  missedCallRate: z.string().optional(),
  averageCaseValue: z.string().optional(),
  followUps: z.string().optional(),
}).nullable();

export type ClientTerminology = z.infer<typeof terminologySchema>;

export function getTermLabel(terminology: ClientTerminology | undefined | null, key: TerminologyKey): string {
  if (!terminology) return terminologyDefaults[key];
  return terminology[key]?.trim() || terminologyDefaults[key];
}

export const insertClientSchema = createInsertSchema(clients, {
  // Task #867: normalise domains on the way in (lowercase, leading `@` stripped,
  // de-duplicated). Empty array is the default.
  emailDomains: z
    .array(z.string())
    .transform((domains) => normalizeClientEmailDomains(domains))
    .optional(),
}).omit({
  id: true,
  clientCode: true,
  createdAt: true,
  updatedAt: true,
  // Task #4330 — lifecycle fields are server-owned (write-boundary): a
  // request body can never smuggle a stage; transitions go through the
  // audited leadLifecycleStorage helpers only.
  lifecycleStage: true,
  leadSource: true,
  leadLastActivityAt: true,
  // Task #4337 — first-touch attribution is server-owned (write-once at
  // intake): request bodies can never stamp or overwrite it.
  firstTouchSource: true,
  firstTouchCampaign: true,
});

export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;

// Task #4380 (F8 storage-boundary closure): focused update schema for
// clientStorage.updateClient. Row identity (id), the generated clientCode,
// and server timestamps are already omitted from the insert schema; unknown
// keys strip (repo zod convention). ownerId stays editable — the PATCH route
// permission-gates ownership changes before the parse.
export const updateClientSchema = insertClientSchema.partial();
export type UpdateClient = z.infer<typeof updateClientSchema>;

/**
 * Task #867: normalise a list of client trusted-email domains. Lowercases,
 * strips a leading `@`, drops obvious garbage and duplicates. Validation
 * against the public-domain denylist is done server-side at write time —
 * this helper is purely string normalisation so it can run on both client
 * and server.
 */
export function normalizeClientEmailDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
    if (!trimmed) continue;
    // Reject anything that is clearly not a domain (no dot, contains space,
    // contains `@` after stripping).
    if (trimmed.includes("@") || trimmed.includes(" ") || !trimmed.includes(".")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Task #4330 — append-only lifecycle audit trail, mirroring
 * deal_stage_history. One row per transition; `changedByUserId` null means
 * the system moved it (intake hook / deal hook), non-null is the operator
 * who made a manual correction. `fromStage` null = the record's creation
 * entry. Existing clients backfilled as 'customer' via the column default
 * have NO history rows — absence of history means "pre-feature customer".
 */
export const clientLifecycleHistory = pgTable("client_lifecycle_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  /** null = the record-creation entry (no prior stage). */
  fromStage: varchar("from_stage").$type<ClientLifecycleStage | null>(),
  toStage: varchar("to_stage").notNull().$type<ClientLifecycleStage>(),
  /** null = system-initiated (intake/deal hooks); set = manual correction. */
  changedByUserId: varchar("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  source: varchar("source", { length: 32 }).notNull().$type<ClientLifecycleChangeSource>(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  clientCreatedIdx: index("client_lifecycle_history_client_created_idx").on(t.clientId, t.createdAt),
}));

export type ClientLifecycleHistoryEntry = typeof clientLifecycleHistory.$inferSelect;

/** Task #4330 — body for POST /api/leads/:id/lifecycle (manual correction).
 *  The ONLY client-supplied lifecycle write; everything else moves through
 *  server-side hooks. Actor/audit fields are derived server-side. */
export const setClientLifecycleBodySchema = z.object({
  stage: z.enum(clientLifecycleStages),
  reason: z.string().trim().max(500).optional(),
});
export type SetClientLifecycleBody = z.infer<typeof setClientLifecycleBodySchema>;

/** Task #4424 — body for POST /api/leads/:id/merge (fold the :id lead into
 *  `targetClientId`). AM+ only; the server re-validates that the source is
 *  a prospect and both records exist. */
export const mergeLeadBodySchema = z.object({
  targetClientId: z.string().trim().min(1),
  reason: z.string().trim().max(500).optional(),
});
export type MergeLeadBody = z.infer<typeof mergeLeadBodySchema>;

export const dataAccessCategories = [
  "consult_bookings",
  "sales_conversions",
  "sales_transcripts",
  "no_show_rate",
  "follow_up_touches",
] as const;
export type DataAccessCategory = typeof dataAccessCategories[number];

export const dataAccessStatuses = ["available", "pending", "refused", "unknown"] as const;
export type DataAccessStatus = typeof dataAccessStatuses[number];

/**
 * Task #2418 — single source of truth for the five Data Access categories.
 * Both the Command Panel "Data Access" card and the report's missing-data
 * section consume this so labels + "what this unlocks" descriptions never
 * diverge again (previously the Command Panel showed "Follow-Up Touches"
 * while the report showed "Pipeline Momentum Data" for the same id).
 *
 * The category `id`s must stay stable — stored `client_data_access.category`
 * rows and the PUT route key off them.
 */
export interface DataAccessCategoryDef {
  id: DataAccessCategory;
  /** Account-team-facing name, identical everywhere it is shown. */
  label: string;
  /**
   * Task #4463 — compact variant of `label` for tight surfaces (e.g. the CEO
   * Insights gaps-table column headers). Derived from `label`, never a
   * different name for the category.
   */
  shortLabel: string;
  /** Short "what this unlocks for reporting" line. */
  unlocks: string;
}

export const dataAccessCategoryDefs: readonly DataAccessCategoryDef[] = [
  { id: "consult_bookings", label: "Consult Booking Data", shortLabel: "Consult Bookings", unlocks: "# of consults and Lead→consult rates" },
  { id: "sales_conversions", label: "New Client Hires Data", shortLabel: "New Client Hires", unlocks: "# of hires and Consult→hire rates" },
  { id: "no_show_rate", label: "No Show Data", shortLabel: "No Shows", unlocks: "no-show rate" },
  { id: "follow_up_touches", label: "CRM Follow-Up Data", shortLabel: "CRM Follow-Ups", unlocks: "Pipeline Momentum Index" },
  { id: "sales_transcripts", label: "Sales Transcripts", shortLabel: "Sales Transcripts", unlocks: "Consult Execution Score" },
] as const;

export const dataAccessCategoryDefById: Record<DataAccessCategory, DataAccessCategoryDef> =
  Object.fromEntries(dataAccessCategoryDefs.map((d) => [d.id, d])) as Record<
    DataAccessCategory,
    DataAccessCategoryDef
  >;

/**
 * Task #2418 — advisory per-client data-presence signal. Detection reads
 * only already-ingested local tables (no new external calls) and never
 * flips a flag; it just lets the report nudge "looks like you already have
 * this — mark it Available?" instead of flatly warning the data is missing.
 *   - `present`  → rows for this category are demonstrably flowing in.
 *   - `absent`   → we checked and found none.
 *   - `unknown`  → we cannot cheaply tell (fall back to manual behaviour).
 */
export const dataAccessPresenceValues = ["present", "absent", "unknown"] as const;
export type DataAccessPresence = typeof dataAccessPresenceValues[number];

export type DataAccessDetectionMap = Record<DataAccessCategory, DataAccessPresence>;

export interface MissingDataCategoryView {
  id: DataAccessCategory;
  label: string;
  status: string | undefined;
  /** Detection says data is flowing despite the flag not being "available". */
  detected: boolean;
}

/**
 * Task #2418 — pure classification shared by the report's missing-data
 * section. A category that isn't "available" goes into one of two buckets:
 *   - `detected`  → detection === "present" → soft "mark Available?" prompt.
 *   - `critical`  → detection absent/unknown (or no detection) → the red
 *                   critical warning (the current manual behaviour).
 * Never mutates state — purely derives the two view lists.
 */
export function classifyDataAccessForReport(
  statusByCategory: Partial<Record<string, string>>,
  detection?: Partial<Record<string, DataAccessPresence>> | null,
): { detected: MissingDataCategoryView[]; critical: MissingDataCategoryView[] } {
  const rows: MissingDataCategoryView[] = [];
  for (const def of dataAccessCategoryDefs) {
    const status = statusByCategory[def.id];
    if (!status || status === "available") continue;
    rows.push({
      id: def.id,
      label: def.label,
      status,
      detected: detection?.[def.id] === "present",
    });
  }
  return {
    detected: rows.filter((r) => r.detected),
    critical: rows.filter((r) => !r.detected),
  };
}

export const clientDataAccess = pgTable("client_data_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  category: varchar("category").notNull(),
  status: varchar("status").default("unknown"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqueClientCategory: unique().on(table.clientId, table.category),
}));

export const insertClientDataAccessSchema = createInsertSchema(clientDataAccess).omit({
  id: true,
  updatedAt: true,
});

export type InsertClientDataAccess = z.infer<typeof insertClientDataAccessSchema>;
export type ClientDataAccess = typeof clientDataAccess.$inferSelect;

export const clientLocations = pgTable("client_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  lat: real("lat"),
  lng: real("lng"),
  radiusCore: real("radius_core"),
  radiusExtended: real("radius_extended"),
  radiusFringe: real("radius_fringe"),
  competitorsInR2: integer("competitors_in_r2"),
  radiusMarket: real("radius_market"),
  r2AlgoVersion: varchar("r2_algo_version"),
  stateFips: varchar("state_fips"),
  countyFips: varchar("county_fips"),
  isActive: boolean("is_active").default(true),
  geocodedAt: timestamp("geocoded_at"),
  radiusComputedAt: timestamp("radius_computed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_locations_client_id_idx").on(table.clientId),
}));

export const insertClientLocationSchema = createInsertSchema(clientLocations).omit({
  id: true,
  createdAt: true,
});

export type InsertClientLocation = z.infer<typeof insertClientLocationSchema>;
export type ClientLocation = typeof clientLocations.$inferSelect;

// Task #4380: focused update schema for clientStorage.updateClientLocation.
// Ownership (clientId) is fixed at create and stays out of the patch.
export const updateClientLocationSchema = insertClientLocationSchema
  .omit({ clientId: true })
  .partial();
export type UpdateClientLocation = z.infer<typeof updateClientLocationSchema>;

/**
 * Shadow audit table for `client_locations`. Written by the storage layer
 * in the same transaction as every insert/update/delete (Task #999) so we
 * can render "Last edited by X · 2h ago" beside every location row and
 * answer "who took this location offline" without spelunking through
 * user_activity_logs. Mirrors the client_contacts_audit pattern (Task
 * #991, migration 0045). See migration 0048.
 */
export const clientLocationsAudit = pgTable("client_locations_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  locationId: varchar("location_id").notNull(),
  clientId: varchar("client_id").notNull(),
  action: varchar("action", { length: 16 }).notNull(),
  actorUserId: varchar("actor_user_id"),
  source: varchar("source", { length: 64 }),
  reason: text("reason"),
  oldName: text("old_name"),
  newName: text("new_name"),
  oldAddress: text("old_address"),
  newAddress: text("new_address"),
  oldCity: text("old_city"),
  newCity: text("new_city"),
  oldState: text("old_state"),
  newState: text("new_state"),
  oldLat: real("old_lat"),
  newLat: real("new_lat"),
  oldLng: real("old_lng"),
  newLng: real("new_lng"),
  oldIsActive: boolean("old_is_active"),
  newIsActive: boolean("new_is_active"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  locationIdx: index("client_locations_audit_location_id_idx").on(table.locationId, table.createdAt),
  clientIdx: index("client_locations_audit_client_id_idx").on(table.clientId, table.createdAt),
}));

export type ClientLocationsAuditRow = typeof clientLocationsAudit.$inferSelect;

export const clientContacts = pgTable("client_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  emails: text("emails").array().default([]),
  phones: text("phones").array().default([]),
  phonesNormalized: text("phones_normalized").array().default([]),
  roleTitle: text("role_title"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_contacts_client_id_idx").on(table.clientId),
  phonesNormalizedIdx: index("client_contacts_phones_normalized_idx").using("gin", table.phonesNormalized),
  // Task #1573 (Audit Track C): composite for AM/primary-contact lookups;
  // see migration 0064.
  clientPrimaryIdx: index("client_contacts_client_primary_idx").on(table.clientId, table.isPrimary),
}));

export const insertClientContactSchema = createInsertSchema(clientContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  phonesNormalized: true,
});

export type InsertClientContact = z.infer<typeof insertClientContactSchema>;
export type ClientContact = typeof clientContacts.$inferSelect;

// Task #4380: focused update schema for clientStorage.updateClientContact.
// Ownership (clientId) is fixed at create; phonesNormalized is derived
// server-side from `phones` inside the storage function and is already
// omitted from the insert schema.
export const updateClientContactSchema = insertClientContactSchema
  .omit({ clientId: true })
  .partial();
export type UpdateClientContact = z.infer<typeof updateClientContactSchema>;

/**
 * Shadow audit table for `client_contacts`. Written by the storage layer in
 * the same transaction as every insert/update/delete so we can answer
 * "where did this email come from / who removed it" without spelunking
 * through user_activity_logs. See migration 0045.
 */
export const clientContactsAudit = pgTable("client_contacts_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull(),
  clientId: varchar("client_id").notNull(),
  action: varchar("action", { length: 16 }).notNull(),
  actorUserId: varchar("actor_user_id"),
  source: varchar("source", { length: 64 }),
  reason: text("reason"),
  oldName: text("old_name"),
  newName: text("new_name"),
  oldRoleTitle: text("old_role_title"),
  newRoleTitle: text("new_role_title"),
  oldIsPrimary: boolean("old_is_primary"),
  newIsPrimary: boolean("new_is_primary"),
  oldEmails: text("old_emails").array(),
  newEmails: text("new_emails").array(),
  oldPhones: text("old_phones").array(),
  newPhones: text("new_phones").array(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  contactIdx: index("client_contacts_audit_contact_id_idx").on(table.contactId, table.createdAt),
  clientIdx: index("client_contacts_audit_client_id_idx").on(table.clientId, table.createdAt),
}));

export type ClientContactsAuditRow = typeof clientContactsAudit.$inferSelect;

/**
 * Non-authoritative landing area for client-scoped entities discovered by
 * import / sync surfaces (Task #755). Rows here are NOT authoritative — an
 * operator must promote them via the Command Panel before they become real
 * client_contacts / client_locations / etc. Statuses: pending, dismissed,
 * promoted.
 */
export const importEntitySuggestions = pgTable("import_entity_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  // e.g. "client_contact", "client_location", "product"
  entityKind: varchar("entity_kind").notNull(),
  // e.g. "front_enrichment", "pdf_import", "semrush_inventory"
  surface: varchar("surface").notNull(),
  // Free-form discovered fields (email, name, phones, etc).
  candidate: jsonb("candidate").notNull(),
  // Useful provenance: conversation id, message id, report id, etc.
  sourceRef: jsonb("source_ref"),
  reason: text("reason"),
  status: varchar("status").default("pending").notNull(),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  promotedEntityId: varchar("promoted_entity_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("import_entity_suggestions_client_id_idx").on(table.clientId),
  statusIdx: index("import_entity_suggestions_status_idx").on(table.status),
}));

export const insertImportEntitySuggestionSchema = createInsertSchema(importEntitySuggestions).omit({
  id: true,
  reviewedByUserId: true,
  reviewedAt: true,
  promotedEntityId: true,
  createdAt: true,
});

export type InsertImportEntitySuggestion = z.infer<typeof insertImportEntitySuggestionSchema>;
export type ImportEntitySuggestion = typeof importEntitySuggestions.$inferSelect;

/**
 * Task #3711 — Client offboarding with auto-archive on the final service day.
 *
 * One row per offboarding lifecycle. An operator schedules the client's final
 * day of service; the daily offboarding sweep (clientOffboardingSweep.ts)
 * picks up `scheduled` rows whose `final_service_date` is today-or-earlier
 * (America/New_York) and runs the ordered step pipeline — step 1 archives the
 * client via the same shared helper as the manual archive action.
 *
 * - `status`: scheduled → processing (the sweep's atomic execution claim;
 *   cancel/reschedule act only on `scheduled` rows, so a claimed record can
 *   no longer be mutated mid-pipeline) → completed (all steps ran), or
 *   scheduled → cancelled (operator called it off before the final day).
 *   Step failure releases the claim back to `scheduled`; a crash leaves
 *   `processing`, which the next sweep re-claims and resumes.
 *   Completed/cancelled rows are kept as history; a partial unique index
 *   enforces at most ONE `scheduled` row per client at a time.
 * - `stepState`: per-step idempotent execution record keyed by the step's
 *   stable id, e.g. `{ "archive_client": { "completedAt": "…ISO…" } }`.
 *   A sweep crash between steps re-runs only the incomplete steps on the
 *   next pass. Future steps (ClickUp task creation, Slack sequences,
 *   T-minus reminders) plug into the same record without schema changes.
 */
export const clientOffboardings = pgTable("client_offboardings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  // Calendar date (YYYY-MM-DD) interpreted in America/New_York by the sweep.
  finalServiceDate: date("final_service_date").notNull(),
  status: varchar("status", { length: 16 }).default("scheduled").notNull(),
  initiatedByUserId: varchar("initiated_by_user_id").references(() => users.id),
  cancelledByUserId: varchar("cancelled_by_user_id").references(() => users.id),
  cancelledAt: timestamp("cancelled_at"),
  completedAt: timestamp("completed_at"),
  stepState: jsonb("step_state").default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_offboardings_client_id_idx").on(table.clientId),
  // Sweep lookup: active (scheduled/processing) rows due today or earlier.
  statusDateIdx: index("client_offboardings_status_date_idx").on(table.status, table.finalServiceDate),
  // At most one active (scheduled) offboarding per client.
  oneScheduledPerClient: uniqueIndex("client_offboardings_one_scheduled_idx")
    .on(table.clientId)
    .where(sql`status = 'scheduled'`),
}));

export type ClientOffboarding = typeof clientOffboardings.$inferSelect;
export type InsertClientOffboarding = typeof clientOffboardings.$inferInsert;
/** Shape of `client_offboardings.step_state` — keyed by OFFBOARDING_STEPS ids. */
export type ClientOffboardingStepState = Record<string, { completedAt: string }>;
