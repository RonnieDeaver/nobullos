import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

// Task #4268 — "The NoBull Brief" edition tag. Single source for the value
// set and its display labels: the DB column is a plain nullable varchar
// (NULL = legacy untagged brief, rendered with no tag) and the value set is
// enforced here at the API layer, not by a DB constraint.
export const CEO_PULSE_EDITIONS = ["company_update", "market_shift"] as const;
export type CeoPulseEdition = (typeof CEO_PULSE_EDITIONS)[number];
export const CEO_PULSE_EDITION_LABELS: Record<CeoPulseEdition, string> = {
  company_update: "Company Update",
  market_shift: "Market Shift",
};
export function ceoPulseEditionLabel(edition: string | null | undefined): string | null {
  return edition && Object.prototype.hasOwnProperty.call(CEO_PULSE_EDITION_LABELS, edition)
    ? CEO_PULSE_EDITION_LABELS[edition as CeoPulseEdition]
    : null;
}

// Task #4293 — supporting images for update briefs. Single source for the
// caps and allowed formats shared by the upload endpoint, the Studio UI, and
// the tests. `ext` is always derived server-side from magic-byte sniffing.
export const CEO_PULSE_IMAGE_EXTS = ["jpg", "png", "webp"] as const;
export type CeoPulseImageExt = (typeof CEO_PULSE_IMAGE_EXTS)[number];
export const CEO_PULSE_IMAGE_MAX_COUNT = 6;
export const CEO_PULSE_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const CEO_PULSE_IMAGE_CAPTION_MAX = 300;

// Task #4804 — the report visual is a brief, not a letter. Single source for
// the text-only "The Mechanics Behind It" narrative cap, shared by the
// analyze/refine prompts + stored-array caps (server/routes/reports.ts), the
// CeoPulseVisual render cap (so legacy briefs with long stored narratives
// render short on every surface without re-analysis), and the tests.
// Long-form depth belongs to the full-letter page, not the report visual.
export const CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS = 2;

// Task #4813 — company-update briefs are announcements ("here is what we're
// building because of what we've learned"), not market analysis. When that
// edition renders text-only (include_graphs=false), generation switches to
// announcement shape: initiative cards (name + one-liner) and short
// commitment statements. Single source for the announcement-mode caps shared
// by the analyze/refine prompts + stored-array caps (server/routes/reports.ts)
// and the tests. Market-shift and legacy untagged briefs — and charts-mode
// company updates — keep the existing spec untouched.
export const CEO_PULSE_UPDATE_MAX_INITIATIVES = 6;
export const CEO_PULSE_UPDATE_MAX_COMMITMENTS = 5;
// Optional per-initiative status chip ("Live now", "In beta", "Shipping Q4").
// Additive optional field inside the free-form aiAnalysis JSONB — legacy rows
// simply lack it and every renderer degrades gracefully when it's absent. The
// server DROPS a status past this cap rather than truncating mid-word (the
// chip is decorative, never load-bearing).
export const CEO_PULSE_UPDATE_STATUS_MAX_CHARS = 32;

// Task #4834 — the company-update brief reads like an executive product-
// roadmap briefing. Freshly analyzed text-only company updates carry
// additive OPTIONAL fields inside the free-form aiAnalysis JSONB (legacy rows
// simply lack them and every renderer falls back to the Task #4813
// announcement layout): a one-sentence supporting line under the headline, a
// per-takeaway `category` area label (snapshot cards), a skimmable
// Why-This-Matters bullet list, and a one-sentence pull quote. (Task #4984
// retired the Before/After comparison and the Now/Next/Soon timeline; Why
// This Matters absorbed their job as bullets. Legacy rows that still store
// beforeAfter/timeline keep the roadmap layout but those bands never render,
// and any AI edit drops the stored keys on save.)
// Single source for the roadmap-template caps shared by the analyze/refine
// prompts + write-site normalization (server/routes/reports.ts), the client
// derivation (client/src/components/ceoPulseRoadmap.ts), and the tests.
// Same discipline as the status chip: over-cap values are DROPPED whole,
// never truncated mid-word — these fields are presentation, not load-bearing.
export const CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS = 200;
export const CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS = 24;
// Task #4984 — Why-This-Matters renders as ONE short lead paragraph
// (contextNarrative[0]) plus 3-5 short bullets (`whyBullets`, additive
// optional). Over-length bullets are DROPPED whole, never truncated.
export const CEO_PULSE_UPDATE_WHY_MAX_BULLETS = 5;
export const CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS = 120;
// Why-This-Matters reuses contextNarrative; the roadmap template allows one
// more short paragraph than the market-shift brief (see
// CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS above — that cap still governs every
// non-announcement edition). Since Task #4984 fresh analyses store a single
// lead paragraph + whyBullets; this cap governs the legacy paragraph-only
// fallback render.
export const CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS = 3;
export const CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS = 160;

/**
 * One supporting-image entry in ceo_pulses.supporting_images. Array order is
 * display order; `slot` is the stable per-brief identity used by
 * `{{image-<slot>}}` letter placeholders and the object-storage key
 * `ceo-pulse/<monthKey>/image-<slot>.<ext>` — it never changes on reorder.
 */
export type CeoPulseSupportingImage = {
  slot: number;
  ext: CeoPulseImageExt;
  caption?: string | null;
};

// PATCH /api/ceo-pulses/:id/images — caption edits + reorder in one call.
// The client sends the FULL desired list in display order; the route verifies
// it is an exact permutation of the stored slots (no additions/removals) and
// re-derives `ext` from stored metadata, so extensions are never
// client-writable. `.strict()` on both levels: unknown keys are a 400, not a
// silent drop, because this body is the sole writer of caption/order state.
export const updateCeoPulseImagesSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            slot: z.number().int().positive(),
            caption: z.string().max(CEO_PULSE_IMAGE_CAPTION_MAX).nullable().optional(),
          })
          .strict(),
      )
      .max(CEO_PULSE_IMAGE_MAX_COUNT),
  })
  .strict();

export type UpdateCeoPulseImages = z.infer<typeof updateCeoPulseImagesSchema>;

export const ceoPulses = pgTable("ceo_pulses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  monthKey: varchar("month_key").notNull().unique(),
  title: text("title"),
  rawContent: text("raw_content").notNull(),
  aiAnalysis: jsonb("ai_analysis"),
  fullLetterHtml: text("full_letter_html"),
  includeGraphs: boolean("include_graphs").notNull().default(true),
  isPublished: boolean("is_published").default(false),
  shareToken: varchar("share_token").unique(),
  createdBy: varchar("created_by").references(() => users.id),
  // Nullable for rows created before Task #4268; new briefs always carry one.
  edition: varchar("edition", { enum: CEO_PULSE_EDITIONS }),
  // Task #4293 — ordered CeoPulseSupportingImage[] (see type above). NULL =
  // no uploaded images (all rows predating the feature). Managed ONLY by the
  // dedicated image endpoints — excluded from insert/update schemas below.
  supportingImages: jsonb("supporting_images"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCeoPulseSchema = createInsertSchema(ceoPulses)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    // Task #4293: supporting images are managed exclusively by the dedicated
    // upload/caption-reorder/delete endpoints (which keep object-storage
    // bytes and metadata in sync) — never writable via generic POST/PATCH.
    supportingImages: true,
  })
  .extend({
    // Required at create: every new brief declares its edition ("Company
    // Update" | "Market Shift"). The column stays nullable only for legacy
    // rows created before the edition tag existed.
    edition: z.enum(CEO_PULSE_EDITIONS),
  });

export type InsertCeoPulse = z.infer<typeof insertCeoPulseSchema>;
export type CeoPulse = typeof ceoPulses.$inferSelect;

// PATCH /api/ceo-pulses/:id — the CEO-editable subset (audit D-PATCH: this
// route previously spread raw req.body into the update). Server-owned fields
// are excluded: id/createdAt/updatedAt are already omitted from the insert
// schema (updatedAt is stamped by storage on every update), monthKey is the
// pulse's natural key fixed at create, shareToken is managed by
// POST /api/ceo-pulses/:id/share, and createdBy records the creating CEO.
// Unknown keys are stripped by Zod; aiAnalysis remains a free-form JSON blob
// owned by the analyze/refine pipeline and round-trips unchanged. `edition`
// is editable (switch between the two editions) but not clearable — .partial()
// makes it optional while the z.enum still rejects null.
export const updateCeoPulseSchema = insertCeoPulseSchema
  .omit({ monthKey: true, shareToken: true, createdBy: true })
  .partial();

export type UpdateCeoPulse = z.infer<typeof updateCeoPulseSchema>;

export const reports = pgTable("reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  reportMonth: varchar("report_month").notNull(),
  status: varchar("status").default("draft"),
  ceoPulseId: varchar("ceo_pulse_id").references(() => ceoPulses.id),
  shareToken: varchar("share_token").unique(),
  privacyMode: boolean("privacy_mode").default(false),
  hideLeadQuality: boolean("hide_lead_quality").default(false),
  webhookImportLogId: varchar("webhook_import_log_id"),
  // Task #2652 — object-storage key of a private copy of the source PDF saved
  // at import/reimport time so "Re-parse from Source" keeps working after the
  // original (temporary Zapier S3) link expires. Null for reports imported
  // before this change — those fall back to the original-link re-fetch and, if
  // that link is dead, a clear "upload manually" message.
  sourcePdfStorageKey: text("source_pdf_storage_key"),
  // Task #4537 — operator-set "Presented / Delivered" mark: records that the
  // monthly report (RER) was actually presented or delivered to the client,
  // distinct from status="final" (finalized internally). Stamped server-side
  // by PATCH /api/reports/:id via storage.setReportPresented (the ONLY
  // writer — both columns are omitted from the insert/update schemas below);
  // both NULL = never presented.
  presentedAt: timestamp("presented_at"),
  presentedBy: varchar("presented_by").references(() => users.id),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqueClientMonth: unique().on(table.clientId, table.reportMonth),
  clientIdx: index("reports_client_id_idx").on(table.clientId),
}));

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Task #4537 — server-stamped delivery audit columns: never client-settable
  // at create (POST /api/reports parses req.body through this schema) nor via
  // PATCH (updateReportSchema derives from this). The only writer is
  // storage.setReportPresented, driven by reportPresentedUpdateSchema below.
  presentedAt: true,
  presentedBy: true,
});

export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;

// F8 (Task #4153) — boundary schema for PATCH /api/reports/:id. Derived from
// insertReportSchema, so any NEW report column becomes client-editable through
// that route by default: add it to the omit list below if it is server-managed
// (ownership, import machinery, share credentials, audit stamps).
export const updateReportSchema = insertReportSchema
  .omit({
    clientId: true, // tenant ownership — set at create, never via PATCH
    createdBy: true, // audit metadata
    shareToken: true, // server-generated share credential
    webhookImportLogId: true, // import machinery linkage
    sourcePdfStorageKey: true, // import machinery (private object key)
    ceoPulseId: true, // server-managed pulse linkage
  })
  .partial();

export type UpdateReport = z.infer<typeof updateReportSchema>;

// Task #4537 — focused boundary schema for the "Presented / Delivered" mark.
// PATCH /api/reports/:id accepts ONLY this boolean request field (destructured
// out of the body before the generic parse above); the server derives the
// stamp: true on an unpresented report → { presentedAt: now, presentedBy:
// actor }, false → both NULL, repeated true → no-op (the original stamp
// survives later saves). Client-supplied presentedAt/presentedBy are stripped
// by the insert/update schemas and never trusted.
export const reportPresentedUpdateSchema = z.object({
  presented: z.boolean(),
});
export type ReportPresentedUpdate = z.infer<typeof reportPresentedUpdateSchema>;

export const REPORT_SECTION_EDIT_SOURCES = [
  "pdf_webhook",
  "manual_pdf_upload",
  "ui_edit",
  "ai_format",
  // Task #4254 — operator explicitly replaced thin Common Issues copy with
  // curated blocks from the copy library.
  "curated_library",
  "api",
  "system",
  "migration_seed",
  "unknown",
] as const;
export type ReportSectionEditSource = typeof REPORT_SECTION_EDIT_SOURCES[number];

export const reportSections = pgTable("report_sections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportId: varchar("report_id").references(() => reports.id).notNull(),
  sectionKey: varchar("section_key").notNull(),
  data: jsonb("data").notNull(),
  lastEditedBy: varchar("last_edited_by"),
  lastEditSource: varchar("last_edit_source"),
  lastEditAt: timestamp("last_edit_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqueReportSection: unique().on(table.reportId, table.sectionKey),
}));

export const insertReportSectionSchema = createInsertSchema(reportSections).omit({
  id: true,
  updatedAt: true,
  lastEditedBy: true,
  lastEditSource: true,
  lastEditAt: true,
});

export type InsertReportSection = z.infer<typeof insertReportSectionSchema>;
export type ReportSection = typeof reportSections.$inferSelect;

export const reportSectionHistory = pgTable("report_section_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportSectionId: varchar("report_section_id"),
  reportId: varchar("report_id").notNull(),
  sectionKey: varchar("section_key").notNull(),
  previousData: jsonb("previous_data"),
  newData: jsonb("new_data").notNull(),
  dataChanged: boolean("data_changed").notNull().default(true),
  editedBy: varchar("edited_by").notNull(),
  editSource: varchar("edit_source").notNull(),
  webhookImportLogId: varchar("webhook_import_log_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  reportIdx: index("report_section_history_report_id_idx").on(table.reportId),
  reportSectionIdx: index("report_section_history_section_idx").on(table.reportId, table.sectionKey),
}));

export type ReportSectionHistory = typeof reportSectionHistory.$inferSelect;

// Legacy `notifications` table dropped in migration
// `0069_drop_legacy_notifications.sql` (Task #1716, Notifications
// Stage G). The per-user inbox lives in `user_notifications` and is
// written exclusively through `notifyUser()` — see NOTIFICATIONS.md.

// Legacy `industry_trends` table dropped in migration
// `20260810012532_drop_industry_trends.sql` (Task #4181, F5 audit finding
// R-03, 2026-08-10). It never had live readers or writers — the
// practice-area trends endpoint in server/routes/settings.ts computes its
// aiAnalysis fresh per request from Google Trends + OpenAI and returns it
// in the HTTP response only. Evidence + the single stale stored row are in
// audits/industry-trends-drop-2026-08-10.md.

export const funnelAnnotationSchema = z.object({
  afterStage: z.number(),
  text: z.string(),
});

export const funnelGroupSchema = z.object({
  label: z.string(),
  colorScheme: z.enum(["light", "dark"]).optional(),
  stages: z.array(z.object({
    label: z.string(),
    value: z.number(),
    color: z.string().optional(),
  })),
});

export const chartDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bar"),
    title: z.string(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    valueSuffix: z.string().optional(),
    legend: z.array(z.object({ label: z.string(), color: z.string() })).optional(),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
      previousValue: z.number().optional(),
      color: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal("comparison"),
    title: z.string(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    valueSuffix: z.string().optional(),
    legend: z.array(z.object({ label: z.string(), color: z.string() })).optional(),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
      previousValue: z.number().optional(),
      color: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal("line"),
    title: z.string(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    valueSuffix: z.string().optional(),
    legend: z.array(z.object({ label: z.string(), color: z.string() })).optional(),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
      previousValue: z.number().optional(),
      color: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal("stat"),
    title: z.string(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    valueSuffix: z.string().optional(),
    legend: z.array(z.object({ label: z.string(), color: z.string() })).optional(),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
      previousValue: z.number().optional(),
      color: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal("funnel"),
    title: z.string(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    groups: z.array(funnelGroupSchema),
    annotations: z.array(funnelAnnotationSchema).optional(),
  }),
]);

export const aiAnalysisSchema = z.object({
  headline: z.string(),
  keyTakeaways: z.array(z.string()),
  strategicImplications: z.array(z.string()),
  charts: z.array(chartDataSchema),
});

export type AIAnalysis = z.infer<typeof aiAnalysisSchema>;
export type ChartData = z.infer<typeof chartDataSchema>;

export const intakeSectionSchema = z.object({
  leadToConsultRate: z.number(),
  totalLeads: z.number(),
  totalConsults: z.number(),
  webinarLeads: z.number().optional(),
  webinarConsults: z.number().optional(),
  leadQuality: z.object({
    good: z.number(),
    notQuotable: z.number(),
    missedCalls: z.number().optional(),
    noData: z.number().optional(),
  }).optional(),
  intakeFunnel: z.object({
    totalInquiries: z.number(),
    contacted: z.number(),
    qualified: z.number(),
    scheduled: z.number(),
    completed: z.number(),
  }).optional(),
});

export const salesSectionSchema = z.object({
  consultToCaseRate: z.number(),
  totalConsults: z.number(),
  totalCases: z.number(),
  averageCaseValue: z.number(),
  signedByRep: z.record(z.number()).optional(),
  lossReasons: z.record(z.number()).optional(),
  noShowRate: z.number().optional(),
  avgFollowUps: z.number().optional(),
  qualityScore: z.number().optional(),
  dealTouchDensity: z.number().optional(),
  avgAgeOpenMatters: z.number().optional(),
  pipelineMomentumScore: z.number().optional(),
  commonIssues: z.string().optional(),
  noDataFlags: z.record(z.boolean()).optional(),
});

export const marketingSectionSchema = z.object({
  totalLeads: z.number().optional(),
  posture: z.string().optional(),
  leadQuality: z.object({
    good: z.number(),
    notQuotable: z.number(),
    missedCalls: z.number().optional(),
    noData: z.number().optional(),
  }).optional(),
  gbpLeadQuality: z.object({
    good: z.number(),
    notQuotable: z.number(),
    missedCalls: z.number().optional(),
    noData: z.number().optional(),
  }).optional(),
  googleAdsEnabled: z.boolean().optional(),
  lsaEnabled: z.boolean().optional(),
  gbp: z.object({
    locations: z.array(z.object({
      id: z.string(),
      name: z.string(),
      uniqueLeads: z.number(),
      reviewsGenerated: z.number().optional(),
      reviewsRespondedTo: z.number().optional(),
      postsQaCount: z.number().optional(),
      heatmapImageUrl: z.string().optional(),
      heatmapSnapshotId: z.string().optional(),
      heatmapSnapshotIds: z.array(z.string()).optional(),
      leadQuality: z.object({
        good: z.number(),
        notQuotable: z.number(),
        missedCalls: z.number().optional(),
        noData: z.number().optional(),
      }).optional(),
    })),
    shared: z.object({
      blogPostUrl: z.string().optional(),
    }).optional(),
  }),
  googleAds: z.object({
    uniqueLeads: z.number(),
    adSpend: z.number(),
    costPerLead: z.number(),
    leadQuality: z.object({
      good: z.number(),
      notQuotable: z.number(),
      missedCalls: z.number().optional(),
      noData: z.number().optional(),
    }),
  }),
  lsa: z.object({
    uniqueLeads: z.number(),
    adSpend: z.number(),
    costPerLead: z.number(),
    leadQuality: z.object({
      good: z.number(),
      notQuotable: z.number(),
      missedCalls: z.number().optional(),
      noData: z.number().optional(),
    }),
  }),
  webinar: z.object({
    registrants: z.number(),
    attendees: z.number(),
    showRate: z.number(),
    hotTransfers: z.number(),
    hotTransferRate: z.number(),
  }),
  reviewGeneration: z.object({
    list: z.object({ count: z.number(), activationRate: z.number() }),
    webinar: z.object({ count: z.number(), activationRate: z.number() }),
    other: z.object({ count: z.number() }),
    // Task #2579 — admin-set per-client monthly review target (reviews/month).
    // Drives the green/yellow/red goal band on the velocity headline + the
    // target reference line on the trend chart. Optional: absent = neutral.
    monthlyTarget: z.number().optional(),
  }),
});

// Task #4282 — accountability fields on Next 30 Days action items (§8.7-11):
// short owner initials ("JD") and a free-text due hint ("by Feb 14"). Caps
// shared by the form's maxLength attrs and the server-side write sanitizer.
export const NEXT_ACTION_OWNER_MAX_CHARS = 12;
export const NEXT_ACTION_DUE_MAX_CHARS = 40;

const nextActionItemSchema = z.object({
  action: z.string(),
  why: z.string(),
  // Task #4282 — optional; absent on every pre-existing row.
  owner: z.string().max(NEXT_ACTION_OWNER_MAX_CHARS).optional(),
  due: z.string().max(NEXT_ACTION_DUE_MAX_CHARS).optional(),
});

export type NextActionItem = z.infer<typeof nextActionItemSchema>;

export const nextActionsSectionSchema = z.object({
  ours: z.array(nextActionItemSchema),
  theirs: z.array(nextActionItemSchema),
  notes: z.string().optional().default(""),
  showNotes: z.boolean().optional().default(false),
  // Task #4282 — the "Question We're Always Asking" expansion band used to
  // be hardcoded on every report; it now renders ONLY when the operator
  // deliberately turns it on for a report where expansion is genuinely on
  // the table. Absent (every pre-#4282 row) = false = hidden.
  showExpansionQuestion: z.boolean().optional().default(false),
});

export type IntakeSectionData = z.infer<typeof intakeSectionSchema>;
export type SalesSectionData = z.infer<typeof salesSectionSchema>;
export type MarketingSectionData = z.infer<typeof marketingSectionSchema>;
export type NextActionsSectionData = z.infer<typeof nextActionsSectionSchema>;
