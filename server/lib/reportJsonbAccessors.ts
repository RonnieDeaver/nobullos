/**
 * Typed JSONB accessors for the REPORTS data boundaries (program task F5,
 * audit finding R-03).
 *
 * The reports subsystem stores flexible JSONB and historically read it back
 * through bare casts (`as any`, `as Record<string, any>`) at ~40 call sites.
 * This module is the ONE place where a raw `report_sections.data` /
 * `ceo_pulses.ai_analysis` value is narrowed from `unknown` into a named
 * domain type. Route/service code must consume these readers instead of
 * casting.
 *
 * ── Boundary inventory (F5 step 1) ─────────────────────────────────────────
 *
 * 1. report_sections.data — jsonb NOT NULL (shared/models/reports.ts)
 *    Writers: webhook PDF import + manual reimport (parser output, shaped by
 *      ParsedReportData → section-write transform in server/routes/reports.ts),
 *      section PUT (zod-validated warn-only, so extra keys persist),
 *      persistSectionWarning (broken-source warning upsert),
 *      lazy local-dominance upgrade (mutates served marketing data in place,
 *      then re-upserts), duplicate-report flow (copies rows verbatim).
 *    Readers (all routed here): client summary route, reimport merge
 *      (existing marketing/intake/sales), broken-source warning computation
 *      (server/services/reportImportWarnings.ts), report-response trend +
 *      lifetime loops (main and demo endpoints), public sanitizer,
 *      webhook/PUT stamp preservation, trend-entry builders
 *      (server/lib/reportTrendEntries.ts), legacy-key normalizers.
 *    Shapes: canonical write shapes are intakeSectionSchema /
 *      salesSectionSchema / marketingSectionSchema / nextActionsSectionSchema
 *      (shared/models/reports.ts) — but stored rows are a SUPERSET across
 *      eras. Known legacy/extra shapes preserved by these types:
 *        • marketing.gbpLocations (legacy array) vs marketing.gbp.locations
 *        • marketing.webinars (legacy key; normalizeSections renames in
 *          place to webinar at serve time)
 *        • reviewGeneration.list.count (zod canonical) vs .list.reviews
 *          (webhook-written) — same for .webinar.count/.reviews
 *        • intake/sales qualityScore, missedCallRate, avgTimeToAnswer,
 *          revenue, commonIssues — written by imports, absent from some zod
 *          schemas
 *        • noDataFlags — key presence is the entry-tracking era marker;
 *          absent on legacy rows (never invent it)
 *        • operational stamps: brokenSourceImportWarning,
 *          gbpUnresolvedImports, common-issues reformat / June-lead-reparse
 *          stamp keys — preserved via index signatures
 *    Consuming responses: GET /api/clients/:id/reports summary, report
 *      response builder (trendData, lifetime value, sanitized public
 *      sections), demo report endpoint, reimport merge response.
 *    Tests: tests/report-jsonb-accessors.test.ts (this boundary's matrix),
 *      tests/report-metric-presence.test.ts (trend/noDataFlags semantics),
 *      report section audit-trail / history suites (persistence unchanged).
 *
 * 2. report_section_history.previous_data / new_data — jsonb, nullable
 *    Writers: server/storage/reportStorage.ts (upsertReportSection history
 *      row: previousData = existing?.data ?? null, newData = data.data) and
 *      the duplicate-report flow (direct insert in a tx).
 *    Readers: history GET serves rows OPAQUELY (plus editor-user
 *      enrichment); webhook overwrite check reads only non-JSONB columns.
 *      There is deliberately NO decoding boundary — values pass through as
 *      stored section-data snapshots. Named alias: StoredSectionHistoryData.
 *
 * 3. ceo_pulses.ai_analysis — jsonb, nullable
 *    Writer: the analyze/refine pipeline (free-form blob it owns).
 *    Readers at this boundary access ONLY `.charts` (regenerate-charts
 *      guard + chart image generation, share GET, report/demo responses’
 *      chart count). readCeoPulseAiAnalysis narrows exactly that much and
 *      passes everything else through untouched.
 *
 * 4. industry_trends.ai_analysis — RETIRED (Task #4181, 2026-08-10). The
 *      table had ZERO live readers/writers — the practice-area trends
 *      endpoint in server/routes/settings.ts computes its aiAnalysis fresh
 *      per request and returns it in the HTTP response only, nothing ever
 *      persisted. Dropped via 20260810012532_drop_industry_trends.sql;
 *      evidence in audits/industry-trends-drop-2026-08-10.md.
 *
 * 5. ceo_pulses.supporting_images — jsonb, nullable (Task #4293)
 *    Writers: ONLY the dedicated image endpoints (upload/caption-reorder/
 *      delete in server/routes/reports.ts via reportStorage's atomic
 *      writers) — the column is omitted from insert/updateCeoPulseSchema.
 *    Readers: image serving GET (builds the object-storage key from
 *      slot+ext), share GET (payload list + {{image-N}} resolution),
 *      report/demo responses (letter resolution), Studio list passthrough.
 *    Shape: ordered CeoPulseSupportingImage[] (shared/models/reports.ts).
 *    NOTE — deviation from the same-reference contract below: because
 *      slot/ext feed OBJECT-STORAGE PATH construction, this reader validates
 *      per-entry and SKIPS invalid entries (warn + drop) instead of passing
 *      them through. No call site mutates through the returned array.
 *
 * ── Contracts ──────────────────────────────────────────────────────────────
 *
 * • Readers accept `unknown` and return the SAME object reference (no clone,
 *   no coercion, no key stripping). Several call sites mutate through the
 *   returned reference on purpose (lazy dominance upgrade, sanitizer copies,
 *   legacy webinars→webinar rename) and re-persist — cloning here would
 *   silently break persistence semantics.
 * • Null/missing: `readXxx` returns a safe empty object ({} satisfies the
 *   all-optional read types) matching the historical `(… as any) || {}`
 *   pattern; `readOptionalXxx` preserves undefined so "section does not
 *   exist" branches (e.g. reimport merge, warning persistence) keep their
 *   exact semantics. readCeoPulseAiAnalysis preserves null (nullable column).
 * • Malformed (non-object JSONB — string/number/boolean/array): return the
 *   documented safe fallback ({} / null) and console.warn. Previously such
 *   rows flowed raw out of the cast and could e.g. spread a string
 *   char-by-char into a persisted section; an explicit fallback is the F5
 *   malformed-data policy (no crash, no silent nonsense write).
 * • Field optionality mirrors what READERS may find across eras, EXCEPT
 *   StoredGbpLocation’s scalar counters + FullLeadQualityCounts, which stay
 *   REQUIRED to match the long-standing local interfaces they replace
 *   (ExistingLocData) and the parser’s canonical shapes those values flow
 *   into at the reimport-merge passthrough. Historical/manual rows can omit
 *   them at runtime — every reader keeps its `|| 0` / `?.` defenses, and
 *   values pass through missing keys unchanged (no defaulting on write).
 * • The `value as T` casts INSIDE this module (after the plain-object guard)
 *   are the single sanctioned narrowing point for these columns. Do not add
 *   new `as any` reads of these columns at call sites.
 * • Scope guard: this is a reports-domain module, not a generic JSONB
 *   framework — do not generalize it to other subsystems (ATS is F4,
 *   integrations F6, registry F7).
 */

import { CEO_PULSE_IMAGE_EXTS, type CeoPulseSupportingImage } from "@shared/schema";

/** Lead-quality bucket counts as stored (all fields may be absent on old rows). */
export interface StoredLeadQualityCounts {
  good?: number;
  notQuotable?: number;
  missedCalls?: number;
  noData?: number;
}

/**
 * The canonical "complete" lead-quality shape (parser/webhook always write
 * all four buckets). Kept required so stored GBP-location counts remain
 * assignable to ParsedReportData’s location shape at the reimport merge —
 * exactly the claim the replaced inline ExistingLocData interface made.
 */
export interface FullLeadQualityCounts {
  good: number;
  notQuotable: number;
  missedCalls: number;
  noData: number;
}

/**
 * Per-keyword local-dominance payload attached lazily to GBP locations.
 * No index signature: the lazy-upgrade path assigns the dominance service's
 * LocationLocalDominanceData (an interface) into this slot, and interfaces
 * are not assignable to index-signature types. Unknown stored keys still
 * ride along at runtime (same reference).
 */
export interface StoredGbpLocalDominance {
  keywordSnapshots?: unknown[];
}

/**
 * One GBP location as stored under marketing.gbp.locations (current) or
 * marketing.gbpLocations (legacy). Scalar counters are typed required to
 * mirror the parser’s canonical output and the pre-F5 inline interface;
 * PUT-era rows may omit the optional review counters at runtime.
 */
export interface StoredGbpLocation {
  id?: string;
  name: string;
  uniqueLeads: number;
  reviewsGenerated: number;
  reviewsRespondedTo: number;
  postsQaCount: number;
  leadQuality?: FullLeadQualityCounts;
  heatmapImageUrl?: string;
  heatmapSnapshotId?: string;
  heatmapSnapshotIds?: string[];
  localDominance?: StoredGbpLocalDominance;
  [key: string]: unknown;
}

export interface StoredWebinarBlock {
  registrants?: number;
  attendees?: number;
  leads?: number;
  showRate?: number;
  htScheduleRate?: number;
  hotTransferRate?: number;
  hotTransfers?: number;
  leadQuality?: StoredLeadQualityCounts;
  [key: string]: unknown;
}

/**
 * Review-generation block. `list.count`/`webinar.count` are the zod-canonical
 * fields; `list.reviews`/`list.contacted`/`webinar.reviews`/`totalReviews`
 * are the webhook-import era fields — readers fall back across both.
 */
export interface StoredReviewGenerationBlock {
  list?: { reviews?: number; contacted?: number; count?: number; activationRate?: number; [key: string]: unknown };
  webinar?: { reviews?: number; count?: number; activationRate?: number; [key: string]: unknown };
  other?: { count?: number; [key: string]: unknown };
  totalReviews?: number;
  monthlyTarget?: number;
  [key: string]: unknown;
}

export interface StoredAdsPlatformBlock {
  uniqueLeads?: number;
  adSpend?: number;
  costPerLead?: number;
  leadQuality?: StoredLeadQualityCounts;
  [key: string]: unknown;
}

/** Parser writes `total`/`description`; older readers look for `count`. */
export interface StoredOtherLeadsBlock {
  count?: number;
  total?: number;
  description?: string;
  [key: string]: unknown;
}

/**
 * Broken-source import warning as READ from a stored section. The write-side
 * type (BrokenSourceSectionWarning in server/services/reportImportWarnings.ts)
 * is stricter; reads keep missingMetrics `unknown` because historical rows
 * are only trusted after an Array.isArray guard.
 */
export interface StoredBrokenSourceWarningRead {
  missingMetrics?: unknown;
  rawPlaceholder?: string;
  priorReportMonth?: string;
  source?: string;
  detectedAt?: string;
  [key: string]: unknown;
}

/** Marketing section data as stored in report_sections.data. */
export interface MarketingSectionRead {
  totalLeads?: number;
  posture?: string;
  leadQuality?: StoredLeadQualityCounts;
  gbpLeadQuality?: StoredLeadQualityCounts;
  googleAdsEnabled?: boolean;
  lsaEnabled?: boolean;
  gbp?: { locations?: StoredGbpLocation[]; shared?: Record<string, unknown>; [key: string]: unknown };
  /** Legacy flat array predating the gbp.locations nesting. */
  gbpLocations?: StoredGbpLocation[];
  googleAds?: StoredAdsPlatformBlock;
  lsa?: StoredAdsPlatformBlock;
  webinar?: StoredWebinarBlock;
  /** Legacy key; normalizeSections renames webinars → webinar in place. */
  webinars?: StoredWebinarBlock;
  reviewGeneration?: StoredReviewGenerationBlock;
  otherLeads?: StoredOtherLeadsBlock;
  noDataFlags?: Record<string, boolean>;
  brokenSourceImportWarning?: StoredBrokenSourceWarningRead;
  [key: string]: unknown;
}

/** Intake section data as stored (superset of intakeSectionSchema eras). */
export interface IntakeSectionRead {
  leadToConsultRate?: number;
  totalLeads?: number;
  totalConsults?: number;
  webinarLeads?: number;
  webinarConsults?: number;
  leadQuality?: StoredLeadQualityCounts;
  intakeFunnel?: Record<string, unknown>;
  qualityScore?: number;
  missedCallRate?: number;
  avgTimeToAnswer?: number;
  commonIssues?: string;
  noDataFlags?: Record<string, boolean>;
  brokenSourceImportWarning?: StoredBrokenSourceWarningRead;
  [key: string]: unknown;
}

/** Sales section data as stored (superset of salesSectionSchema eras). */
export interface SalesSectionRead {
  consultToCaseRate?: number;
  totalConsults?: number;
  totalCases?: number;
  averageCaseValue?: number;
  revenue?: number;
  signedByRep?: Record<string, number>;
  lossReasons?: Record<string, number>;
  noShowRate?: number;
  avgFollowUps?: number;
  qualityScore?: number;
  dealTouchDensity?: number;
  avgAgeOpenMatters?: number;
  pipelineMomentumScore?: number;
  commonIssues?: string;
  noDataFlags?: Record<string, boolean>;
  brokenSourceImportWarning?: StoredBrokenSourceWarningRead;
  [key: string]: unknown;
}

/** Next-actions section data as stored. */
export interface NextActionsSectionRead {
  ours?: unknown;
  theirs?: unknown;
  notes?: string;
  showNotes?: boolean;
  /** CEO-only working notes — stripped by the public sanitizer. */
  internalNotes?: unknown;
  [key: string]: unknown;
}

/**
 * Generic section-data record for section-kind-agnostic flows (public
 * sanitizer copy, webhook/PUT stamp preservation) that only touch keys.
 */
export type ReportSectionDataObject = Record<string, unknown>;

/**
 * History snapshots (report_section_history.previous_data/new_data) are
 * opaque copies of whatever report_sections.data held — served verbatim,
 * never decoded. Named here so the pass-through is a documented decision.
 */
export type StoredSectionHistoryData = unknown;

/**
 * One stored CEO-pulse chart. Required type/title mirror the write-side
 * validator (validateCeoPulseChart drops entries without them) and keep the
 * array assignable to the chart-image generator’s input without casts.
 * Deliberately NO index signature: extra stored keys still pass through at
 * runtime (same reference), but adding one would break that assignability.
 */
export interface StoredCeoPulseChart {
  type: string;
  title: string;
  description?: string;
  subtitle?: string;
  valueSuffix?: string;
  data?: Array<{ label: string; value: number; previousValue?: number; color?: string }>;
  legend?: Array<{ label: string; color: string }>;
  groups?: Array<{ label: string; colorScheme?: "light" | "dark"; stages: Array<{ label: string; value: number; color?: string }> }>;
  annotations?: Array<{ afterStage: number; text: string }>;
}

/**
 * ceo_pulses.ai_analysis as read at the reports boundaries. The blob is
 * owned by the analyze/refine pipeline; these boundaries only ever consume
 * `.charts`, so only that key is modeled — the rest rides along untouched.
 */
export interface CeoPulseAiAnalysisRead {
  headline?: unknown;
  keyTakeaways?: unknown;
  strategicImplications?: unknown;
  charts?: StoredCeoPulseChart[];
  [key: string]: unknown;
}

/**
 * Optional row-identifying context a call site may attach to a read so the
 * corruption alert (Task #4197) can name a sample row. IDs only — never
 * stored values.
 */
export interface ReportJsonbContext {
  reportId?: string;
  sectionId?: string;
  clientId?: string;
  ceoPulseId?: string;
}

export interface ReportJsonbMalformedEvent {
  /** table.column boundary name, e.g. "report_sections.data[marketing]". */
  boundary: string;
  /** Human description of the expected shape. */
  expected: string;
  context?: ReportJsonbContext;
}

type ReportJsonbMalformedListener = (event: ReportJsonbMalformedEvent) => void;

/**
 * Malformed-event seam (Task #4197). This module stays a leaf (no service
 * imports); server/services/reportJsonbCorruptionAlerts.ts installs the
 * handler at its own module load. Listener errors are swallowed: alerting
 * must never change accessor fallback behavior.
 */
let malformedListener: ReportJsonbMalformedListener | null = null;
export function setReportJsonbMalformedListener(listener: ReportJsonbMalformedListener | null): void {
  malformedListener = listener;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeContext(context?: ReportJsonbContext): string {
  const parts: string[] = [];
  if (context?.clientId) parts.push(`client=${context.clientId}`);
  if (context?.reportId) parts.push(`report=${context.reportId}`);
  if (context?.sectionId) parts.push(`section=${context.sectionId}`);
  if (context?.ceoPulseId) parts.push(`ceoPulse=${context.ceoPulseId}`);
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

function warnMalformed(boundary: string, value: unknown, context?: ReportJsonbContext): void {
  // Operational logging per the F5 malformed-data policy: pathological
  // non-object rows are visible instead of silently flowing through casts.
  // The row IDs go in the log line AND to the alert listener; the alert body
  // carries IDs only (stored report data can contain client content).
  console.warn(
    `[reportJsonbAccessors] Malformed ${boundary} value (${describeValue(value)})${describeContext(context)} — substituting safe fallback`,
  );
  if (malformedListener) {
    try {
      malformedListener({ boundary, expected: "a plain JSON object", context });
    } catch {
      // Alerting must never alter the documented fallback.
    }
  }
}

interface SectionReader<T> {
  read: (value: unknown, context?: ReportJsonbContext) => T;
  readOptional: (value: unknown, context?: ReportJsonbContext) => T | undefined;
}

/**
 * Reports-domain reader factory (NOT a generic JSONB framework — see module
 * doc). `read` maps null/undefined AND malformed to {}; `readOptional`
 * preserves undefined for "row/section absent" semantics and maps malformed
 * to {} so downstream "existing data" branches behave like an empty section
 * instead of spreading a scalar.
 */
function makeSectionReader<T extends object>(boundary: string): SectionReader<T> {
  return {
    read(value: unknown, context?: ReportJsonbContext): T {
      if (value === null || value === undefined) return {} as T;
      if (isPlainObject(value)) return value as T;
      warnMalformed(boundary, value, context);
      return {} as T;
    },
    readOptional(value: unknown, context?: ReportJsonbContext): T | undefined {
      if (value === null || value === undefined) return undefined;
      if (isPlainObject(value)) return value as T;
      warnMalformed(boundary, value, context);
      return {} as T;
    },
  };
}

const intakeReader = makeSectionReader<IntakeSectionRead>("report_sections.data[intake]");
const salesReader = makeSectionReader<SalesSectionRead>("report_sections.data[sales]");
const marketingReader = makeSectionReader<MarketingSectionRead>("report_sections.data[marketing]");
const nextActionsReader = makeSectionReader<NextActionsSectionRead>("report_sections.data[nextActions]");
const sectionObjectReader = makeSectionReader<ReportSectionDataObject>("report_sections.data");

/** Intake section data; {} for missing/malformed (matches legacy `|| {}` reads). */
export const readIntakeSection = intakeReader.read;
/** Intake section data; undefined when the section/row is absent. */
export const readOptionalIntakeSection = intakeReader.readOptional;

/** Sales section data; {} for missing/malformed. */
export const readSalesSection = salesReader.read;
/** Sales section data; undefined when the section/row is absent. */
export const readOptionalSalesSection = salesReader.readOptional;

/** Marketing section data; {} for missing/malformed. */
export const readMarketingSection = marketingReader.read;
/** Marketing section data; undefined when the section/row is absent. */
export const readOptionalMarketingSection = marketingReader.readOptional;

/** Next-actions section data; {} for missing/malformed. */
export const readNextActionsSection = nextActionsReader.read;
/** Next-actions section data; undefined when the section/row is absent. */
export const readOptionalNextActionsSection = nextActionsReader.readOptional;

/** Section data as a generic key/value record; {} for missing/malformed. */
export const readSectionDataObject = sectionObjectReader.read;
/** Generic record variant preserving undefined for absent sections. */
export const readOptionalSectionDataObject = sectionObjectReader.readOptional;

/**
 * ceo_pulses.ai_analysis reader. Preserves null (nullable column, callers
 * branch on absence); malformed non-object values log and read as null,
 * which downstream treats exactly like "no analysis yet".
 */
export function readCeoPulseAiAnalysis(value: unknown, context?: ReportJsonbContext): CeoPulseAiAnalysisRead | null {
  if (value === null || value === undefined) return null;
  if (isPlainObject(value)) return value as CeoPulseAiAnalysisRead;
  warnMalformed("ceo_pulses.ai_analysis", value, context);
  return null;
}

/**
 * ceo_pulses.supporting_images reader (Task #4293, boundary #5 above).
 * NULL/undefined (no uploads — every pre-feature row) reads as []; a
 * malformed non-array column warns and reads as []. Entries are validated
 * PER ITEM because `slot` and `ext` feed object-storage path construction
 * downstream — an entry with a non-integer slot or an extension outside the
 * jpg|png|webp whitelist is dropped with a warning rather than ever reaching
 * a path builder. Valid entries pass through by reference, in stored order.
 */
export function readCeoPulseSupportingImages(
  value: unknown,
  context?: ReportJsonbContext,
): CeoPulseSupportingImage[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnMalformed("ceo_pulses.supporting_images", value, context);
    return [];
  }
  const valid: CeoPulseSupportingImage[] = [];
  for (const entry of value) {
    const candidate = entry as { slot?: unknown; ext?: unknown; caption?: unknown };
    if (
      isPlainObject(entry) &&
      typeof candidate.slot === "number" &&
      Number.isInteger(candidate.slot) &&
      candidate.slot > 0 &&
      typeof candidate.ext === "string" &&
      (CEO_PULSE_IMAGE_EXTS as readonly string[]).includes(candidate.ext) &&
      (candidate.caption === undefined || candidate.caption === null || typeof candidate.caption === "string")
    ) {
      valid.push(entry as CeoPulseSupportingImage);
    } else {
      warnMalformed("ceo_pulses.supporting_images[entry]", entry, context);
    }
  }
  return valid;
}
