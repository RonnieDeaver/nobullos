// @db-pool-intent: ambient
//
// Task #4289 — curated dataset + scan/apply helpers for the public demo
// report (`/demo-report`). The demo report is the product's public
// showcase: prospects see it with zero context, so its STORED data must be
// exemplary — plausible monotonic funnel, internally consistent totals,
// clean canonical formatting, and realistic Next-30 actions in BOTH
// columns so the Task #4227 serve-time fallback never has to fire.
//
// What the stored data looked like before curation (pinned from the prod
// replica on 2026-08-10, report c719aeeb… "The Deaver Firm" 2026-02):
//   - marketing: implausibly uniform round numbers (three platforms at
//     exactly 100 leads each, both ad platforms at exactly $3,000 / $30
//     CPL), per-location GBP lead quality all zeros while the rollup held
//     150/30/10/10, `blogPostUrl: "test.com"`, legacy `webinars` key.
//   - intake/sales: `recommendedActions` prefixed with stray "2)" list
//     numbering; intake commonIssues carried duplicated issue-name lines
//     ("2) Incomplete Information Gathering" above the 🔴 block) and
//     trailing-space soup; sales had no pipelineMomentumScore (the BETA
//     card rendered "No data").
//   - nextActions: ONE action per column with drifting casing/tone — thin
//     for the deck's climax slide.
//   - the demo client also carried draft report rows with ZERO section
//     content (10 in prod, spanning 2023-09..2026-12); every month before
//     the demo month plots as a zero-line year on the marketing
//     "Leads by Source (Monthly)" trend chart, reading as a broken axis.
//
// The curated dataset below fixes all of that with one deterministic,
// idempotent application. Design rules:
//   - MERGE, never blind-replace: environment-specific fields
//     (`heatmapImageUrl` object refs differ between dev and prod) and any
//     unknown/future keys are preserved.
//   - Internal consistency: every leadQuality bucket sums to its
//     platform's uniqueLeads; the rollups equal the per-platform sums; the
//     stored totalLeads equals what the public deck computes
//     (GBP 202 + Ads 73 + LSA 41 + Other 18 = 334, + ceil(19 HT × 1.6) =
//     31 webinar lead-equivalents → 365).
//   - Monotonic funnel: 365 leads → 212 consults (58.1%, "watch" vs the
//     65% free-consult benchmark — an honest improvement story) → 71
//     cases (33.5%, healthy vs the 30% benchmark). Loss-audit upside:
//     ~8 missed cases ≈ $44K/mo — the product's pitch, visibly working.
//   - Canonical commonIssues structure: blocks separated by blank-lined
//     `---` dividers, no trailing divider, no trailing spaces — a fixed
//     point of `normalizeCommonIssuesStructure`.
//   - nextActions copy is Deaver-specific (Dallas / Fort Worth) and
//     deliberately DIFFERENT from the serve-time DEMO_NEXT_ACTIONS
//     constants, so a capture of the served deck proves the stored data
//     (not the fallback) is what renders.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  reports,
  reportSections,
  reportSectionHistory,
} from "@shared/schema";
import { upsertReportSection } from "../storage/reportStorage";
import { getSystemSettingFresh } from "../storage/settingsStorage";

type Db = ReturnType<typeof import("../db").getDb>;

/** system_settings key holding the configured demo report id. */
export const DEMO_REPORT_ID_SETTING_KEY = "demoReportId";

/**
 * One-time versioned stamp: presence = this curation generation has been
 * applied in this environment. Status and apply are BOTH gated on it, so
 * later intentional operator edits to the demo report never re-arm the
 * action (a live-diff status would invite a re-press that reverts them).
 * A future re-curation bumps the version suffix.
 */
export const DEMO_CURATION_STAMP_KEY = "demo_report_curation_v1";

/** Attribution for every audited section write this module makes. */
export const DEMO_CURATION_EDITOR = "system:demo_report_curation";

// ─── Curated section payloads ───────────────────────────────────────

interface LeadQualityCounts {
  good: number;
  notQuotable: number;
  missedCalls: number;
  noData: number;
}

const q = (
  good: number,
  notQuotable: number,
  missedCalls: number,
  noData: number,
): LeadQualityCounts => ({ good, notQuotable, missedCalls, noData });

/**
 * GBP locations by stable id (identical in dev and prod — both descend
 * from the same original import). `heatmapImageUrl` is deliberately NOT
 * part of the curated payload: each environment keeps its own object ref.
 */
export const CURATED_GBP_LOCATIONS = [
  {
    id: "415f34aa-fdf1-48cf-afd7-f34cbcc2610c",
    name: "Dallas",
    uniqueLeads: 118,
    leadQuality: q(74, 24, 9, 11), // sums to 118
    postsQaCount: 12,
    reviewsGenerated: 24,
    reviewsRespondedTo: 24,
  },
  {
    id: "3e81c09b-5c00-4bb4-8619-4e992acdfb93",
    name: "Fort Worth",
    uniqueLeads: 84,
    leadQuality: q(52, 17, 7, 8), // sums to 84
    postsQaCount: 10,
    reviewsGenerated: 17,
    reviewsRespondedTo: 16,
  },
] as const;

/**
 * Marketing: every bucket sums to its platform total; rollups equal the
 * per-platform sums; reviewGeneration channels (27+8+6=41) equal the GBP
 * location review sum (24+17=41), and totalReviews pins the same 41 so
 * the trend builder and the lifetime accumulator agree.
 */
export const CURATED_MARKETING = {
  totalLeads: 365, // 202 GBP + 73 Ads + 41 LSA + 18 Other + 31 webinar-equiv
  posture: "scaling",
  leadQuality: q(204, 73, 26, 31), // non-webinar rollup; sums to 334
  gbpLeadQuality: q(126, 41, 16, 19), // Dallas+Fort Worth; sums to 202
  googleAdsEnabled: true,
  lsaEnabled: true,
  googleAds: {
    uniqueLeads: 73,
    adSpend: 5840,
    costPerLead: 80, // 5840 / 73
    leadQuality: q(41, 19, 6, 7), // sums to 73
  },
  lsa: {
    uniqueLeads: 41,
    adSpend: 2665,
    costPerLead: 65, // 2665 / 41
    leadQuality: q(26, 9, 3, 3), // sums to 41
  },
  // Canonical singular key; the legacy `webinars` spelling is removed by
  // the merge. No leadQuality block: the deck's Hot-Transfer lead-
  // equivalency mode (HT × 1.6, footnoted) is the intended display.
  webinar: {
    registrants: 96,
    attendees: 54,
    showRate: 56, // 54/96 = 56.25
    hotTransfers: 19,
    hotTransferRate: 35, // 19/54 = 35.19
  },
  otherLeads: {
    count: 18,
    description: "Referrals and organic website inquiries",
    leadQuality: q(11, 4, 1, 2), // sums to 18
  },
  reviewGeneration: {
    totalReviews: 41,
    list: { contacted: 180, reviews: 27, activationRate: 15 },
    webinar: { reviews: 8, activationRate: 15 },
    other: { count: 6 },
  },
} as const;

export const CURATED_INTAKE = {
  totalConsults: 212,
  leadToConsultRate: 58.1, // 212 / 365 — "watch" vs the 65% benchmark
  missedCallRate: 7.1, // 26 displayed missed calls / 365 displayed leads
  avgTimeToAnswer: 14, // seconds
  qualityScore: 85,
  recommendedActions: "How can we answer every call within three rings?",
  commonIssues:
    "Intake quality is strong at 85 — the gap to the 65% lead-to-consult benchmark is concentrated in a few fixable habits.\n\n" +
    "🔴 **Issue:** Speed to answer slips during peak hours\n" +
    "↳ **Impact:** Callers who wait past a few rings book elsewhere — most missed calls cluster at midday\n" +
    "> ➡️ **Strategic Fix:** Add a midday overflow ring group so every call is answered within three rings\n\n" +
    "---\n\n" +
    "🔴 **Issue:** Inconsistent information gathering on first calls\n" +
    "↳ **Impact:** Consults start without key facts, so attorneys re-cover basics instead of building trust\n" +
    "> ➡️ **Strategic Fix:** Standardize the intake form and require it before any consult is booked\n\n" +
    "---\n\n" +
    "🔴 **Issue:** No same-day follow-up on unbooked qualified leads\n" +
    "↳ **Impact:** Warm leads cool off overnight and the lead-to-consult rate pays the price\n" +
    "> ➡️ **Strategic Fix:** Add a same-day callback pass for every qualified lead that didn't book",
  commonIssuesReformatBackfillVersion: 1,
  noDataFlags: {
    totalConsults: false,
    qualityScore: false,
    avgTimeToAnswer: false,
  },
} as const;

export const CURATED_SALES = {
  totalConsults: 212, // mirrors intake
  totalCases: 71,
  consultToCaseRate: 33.5, // 71 / 212 — healthy vs the 30% benchmark
  averageCaseValue: 5500, // matches the client's configured avg case value
  noShowRate: 9.4,
  avgFollowUps: 3.6,
  qualityScore: 81,
  pipelineMomentumScore: 74,
  recommendedActions: "How can we push average follow-ups from 3.6 toward five?",
  commonIssues:
    "Consult-to-case is beating the 30% benchmark — the signing engine is healthy.\n\n" +
    "🔴 **Issue:** Follow-up cadence stalls after the second touch\n" +
    "↳ **Impact:** Undecided consults go quiet instead of signing — average follow-ups sit at 3.6\n" +
    "> ➡️ **Strategic Fix:** Extend the cadence to five touches over two weeks, alternating call and text\n\n" +
    "---\n\n" +
    "🔴 **Issue:** No-shows cluster on Monday morning consults\n" +
    "↳ **Impact:** A 9.4% no-show rate leaves winnable cases on the table\n" +
    "> ➡️ **Strategic Fix:** Send a day-before text confirmation with an easy reschedule link",
  commonIssuesReformatBackfillVersion: 1,
  noDataFlags: {
    totalCases: false,
    qualityScore: false,
    noShowRate: false,
    avgFollowUps: false,
    averageCaseValue: false,
    pipelineMomentumScore: false,
  },
} as const;

/**
 * Three realistic actions per column, consistent sentence casing, no
 * trailing periods (matching the existing copy convention). Deliberately
 * NOT the serve-time DEMO_NEXT_ACTIONS constants — Dallas / Fort Worth
 * specificity both reads better and makes stored-vs-fallback provenance
 * verifiable from a capture.
 */
export const CURATED_NEXT_ACTIONS = {
  ours: [
    {
      action: "Launch a review-generation push across Dallas and Fort Worth",
      why: "Review velocity is the strongest map-pack ranking lever in both metros right now",
    },
    {
      action: "Publish weekly GBP posts and fresh photos for both offices",
      why: "Active profiles convert far more searchers into calls than dormant ones",
    },
    {
      action: "Shift budget toward the campaigns with the lowest cost per signed case",
      why: "Concentrating spend where cases are cheapest compounds return month over month",
    },
  ],
  theirs: [
    {
      action: "Answer every inbound call within three rings during business hours",
      why: "Speed to answer is the single biggest driver of lead-to-consult rate",
    },
    {
      action: "Send the signed-case list for the month by the 5th",
      why: "Accurate case data keeps the ROI math in these reports honest",
    },
    {
      action: "Ask five recently closed clients for a Google review",
      why: "Fresh reviews from real clients outperform any ad campaign",
    },
  ],
} as const;

// ─── Merge (curated ⟶ stored) ───────────────────────────────────────

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asObject = (v: unknown): JsonObject => (isObject(v) ? { ...v } : {});

/**
 * Merge the curated GBP block onto the stored one. Locations are matched
 * by id (fallback: case-insensitive name) so each environment keeps its
 * own `heatmapImageUrl` and any other per-location extras; a location
 * missing entirely is inserted from the curated constant (minus the
 * env-specific fields it cannot invent).
 */
function mergeGbpBlock(stored: unknown): JsonObject {
  const storedGbp = asObject(stored);
  const storedLocations: unknown[] = Array.isArray(storedGbp.locations)
    ? (storedGbp.locations as unknown[])
    : [];
  const locations = CURATED_GBP_LOCATIONS.map((curated) => {
    const match = storedLocations.find((loc) => {
      if (!isObject(loc)) return false;
      if (typeof loc.id === "string" && loc.id === curated.id) return true;
      return (
        typeof loc.name === "string" &&
        loc.name.trim().toLowerCase() === curated.name.toLowerCase()
      );
    });
    return { ...asObject(match), ...curated };
  });

  const shared = asObject(storedGbp.shared);
  // "test.com" placeholder must never render as a live link on the
  // public showcase; no curated replacement exists, so drop the key.
  delete shared.blogPostUrl;

  const merged: JsonObject = { ...storedGbp, locations };
  if (Object.keys(shared).length > 0) {
    merged.shared = shared;
  } else {
    delete merged.shared;
  }
  return merged;
}

/** Build the curated marketing payload on top of the stored one. */
export function buildCuratedMarketing(stored: unknown): JsonObject {
  const base = asObject(stored);
  const merged: JsonObject = {
    ...base,
    ...CURATED_MARKETING,
    gbp: mergeGbpBlock(base.gbp),
  };
  // Canonical key only — normalizeSections aliases `webinars` → `webinar`
  // at read time, so a lingering legacy key is pure drift.
  delete merged.webinars;
  return merged;
}

/** Build the curated intake payload on top of the stored one. */
export function buildCuratedIntake(stored: unknown): JsonObject {
  return { ...asObject(stored), ...CURATED_INTAKE };
}

/** Build the curated sales payload on top of the stored one. */
export function buildCuratedSales(stored: unknown): JsonObject {
  return { ...asObject(stored), ...CURATED_SALES };
}

/** Build the curated nextActions payload on top of the stored one. */
export function buildCuratedNextActions(stored: unknown): JsonObject {
  return {
    ...asObject(stored),
    ours: CURATED_NEXT_ACTIONS.ours.map((a) => ({ ...a })),
    theirs: CURATED_NEXT_ACTIONS.theirs.map((a) => ({ ...a })),
  };
}

export const CURATED_SECTION_BUILDERS: Record<
  string,
  (stored: unknown) => JsonObject
> = {
  intake: buildCuratedIntake,
  sales: buildCuratedSales,
  marketing: buildCuratedMarketing,
  nextActions: buildCuratedNextActions,
};

export const CURATED_SECTION_KEYS = [
  "intake",
  "sales",
  "marketing",
  "nextActions",
] as const;

// ─── Scan / apply ────────────────────────────────────────────────────

export interface DemoCurationScan {
  /** demoReportId setting value, when set. */
  demoReportId: string | null;
  /** True when the setting points at a real report row. */
  reportExists: boolean;
  /** True when the one-time stamp is present in this environment. */
  stamped: boolean;
  /** Section keys whose stored data differs from the curated build. */
  sectionsNeedingCuration: string[];
  /** Demo-client draft reports holding zero non-empty sections. */
  emptyDraftReportIds: string[];
}

const stableStringify = (v: unknown): string => {
  const sortKeys = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (isObject(x)) {
      const out: JsonObject = {};
      for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sortKeys(v));
};

/**
 * Empty draft reports for a client: status='draft' AND no section row
 * with actual content. These are the rows that stretch the demo trend
 * axis with zero-months; they hold nothing worth keeping.
 */
async function findEmptyDraftReportIds(
  db: Db,
  clientId: string,
): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT r.id
    FROM reports r
    WHERE r.client_id = ${clientId}
      AND r.status = 'draft'
      AND NOT EXISTS (
        SELECT 1 FROM report_sections rs
        WHERE rs.report_id = r.id
          AND rs.data::text NOT IN ('{}', 'null')
      )
    ORDER BY r.report_month
  `);
  return (rows.rows as Array<{ id: string }>).map((r) => r.id);
}

export async function scanDemoReportCuration(db: Db): Promise<DemoCurationScan> {
  // Fresh read: the stamp gates status, and a ≤300s-stale cached miss
  // right after apply would flap the panel badge.
  const [setting, stamp] = await Promise.all([
    getSystemSettingFresh(DEMO_REPORT_ID_SETTING_KEY),
    getSystemSettingFresh(DEMO_CURATION_STAMP_KEY),
  ]);
  const scan: DemoCurationScan = {
    demoReportId: setting?.value || null,
    reportExists: false,
    stamped: Boolean(stamp?.value),
    sectionsNeedingCuration: [],
    emptyDraftReportIds: [],
  };
  if (!scan.demoReportId) return scan;

  const [report] = await db
    .select({ id: reports.id, clientId: reports.clientId })
    .from(reports)
    .where(eq(reports.id, scan.demoReportId));
  if (!report) return scan;
  scan.reportExists = true;

  const sections = await db
    .select({
      sectionKey: reportSections.sectionKey,
      data: reportSections.data,
    })
    .from(reportSections)
    .where(eq(reportSections.reportId, report.id));
  const byKey = new Map(sections.map((s) => [s.sectionKey, s.data]));
  for (const key of CURATED_SECTION_KEYS) {
    const stored = byKey.get(key);
    const curated = CURATED_SECTION_BUILDERS[key](stored);
    if (stableStringify(stored ?? {}) !== stableStringify(curated)) {
      scan.sectionsNeedingCuration.push(key);
    }
  }

  scan.emptyDraftReportIds = await findEmptyDraftReportIds(db, report.clientId);
  return scan;
}

export interface DemoCurationApplyResult {
  outcome: "applied" | "not-needed";
  detail: string;
  sectionsCurated: string[];
  emptyDraftsDeleted: number;
}

/**
 * One-shot apply: curate the four sections through the audited section
 * writer (history rows + attribution for free), delete the demo client's
 * empty draft reports, and stamp the environment. Gated on the stamp —
 * a second press is a no-op, and post-curation operator edits are never
 * reverted.
 */
export async function applyDemoReportCuration(
  db: Db,
  actorId?: string | null,
): Promise<DemoCurationApplyResult> {
  const scan = await scanDemoReportCuration(db);
  if (scan.stamped) {
    return {
      outcome: "not-needed",
      detail:
        "Demo report curation already applied in this environment " +
        `(${DEMO_CURATION_STAMP_KEY}). Later edits to the demo report are ` +
        "deliberate operator changes and are respected.",
      sectionsCurated: [],
      emptyDraftsDeleted: 0,
    };
  }
  if (!scan.demoReportId) {
    return {
      outcome: "not-needed",
      detail:
        `No demo report configured (system setting ${DEMO_REPORT_ID_SETTING_KEY} ` +
        "is unset) — nothing to curate in this environment.",
      sectionsCurated: [],
      emptyDraftsDeleted: 0,
    };
  }
  if (!scan.reportExists) {
    return {
      outcome: "not-needed",
      detail:
        `${DEMO_REPORT_ID_SETTING_KEY} points at report ${scan.demoReportId}, ` +
        "which does not exist in this environment — nothing to curate.",
      sectionsCurated: [],
      emptyDraftsDeleted: 0,
    };
  }

  const [report] = await db
    .select({ id: reports.id, clientId: reports.clientId })
    .from(reports)
    .where(eq(reports.id, scan.demoReportId));

  // Write every curated section unconditionally (write-through): the
  // upsert is deterministic and history-preserving, so converged rows
  // simply record a no-change edit… except upsertReportSection already
  // skips history noise via its dataChanged flag, so this stays clean.
  const sectionsCurated: string[] = [];
  for (const key of CURATED_SECTION_KEYS) {
    const [existing] = await db
      .select({ data: reportSections.data })
      .from(reportSections)
      .where(
        and(
          eq(reportSections.reportId, report.id),
          eq(reportSections.sectionKey, key),
        ),
      );
    const curated = CURATED_SECTION_BUILDERS[key](existing?.data);
    if (
      !existing ||
      stableStringify(existing.data ?? {}) !== stableStringify(curated)
    ) {
      sectionsCurated.push(key);
    }
    await upsertReportSection(
      { reportId: report.id, sectionKey: key, data: curated },
      {
        editor: actorId ? `${DEMO_CURATION_EDITOR}:${actorId}` : DEMO_CURATION_EDITOR,
        source: "system",
      },
    );
  }

  // Delete the demo client's empty draft reports. The emptiness predicate
  // is re-evaluated here (not trusted from the scan) so a draft that
  // gained real content between scan and apply survives.
  const emptyDraftIds = await findEmptyDraftReportIds(db, report.clientId);
  let emptyDraftsDeleted = 0;
  if (emptyDraftIds.length > 0) {
    // Empty `{}` section rows and their history first (history has no FK
    // and would otherwise orphan), then the report rows.
    await db
      .delete(reportSectionHistory)
      .where(inArray(reportSectionHistory.reportId, emptyDraftIds));
    await db
      .delete(reportSections)
      .where(inArray(reportSections.reportId, emptyDraftIds));
    const deleted = await db
      .delete(reports)
      .where(inArray(reports.id, emptyDraftIds))
      .returning({ id: reports.id });
    emptyDraftsDeleted = deleted.length;
  }

  // NOTE: system_settings.updated_by is FK-constrained to users.id, so
  // only a real pressing-user id (or nothing → NULL) may be recorded —
  // never a synthetic editor string.
  const { setSystemSetting } = await import("../storage/settingsStorage");
  await setSystemSetting(
    DEMO_CURATION_STAMP_KEY,
    new Date().toISOString(),
    actorId ?? undefined,
  );

  return {
    outcome: "applied",
    detail:
      `Curated ${sectionsCurated.length} section(s) of demo report ` +
      `${report.id} (${sectionsCurated.join(", ") || "all already converged"}) ` +
      `and deleted ${emptyDraftsDeleted} empty draft report(s) for the demo ` +
      "client. Every section write is in report_section_history " +
      `(editor ${DEMO_CURATION_EDITOR}).`,
    sectionsCurated,
    emptyDraftsDeleted,
  };
}
