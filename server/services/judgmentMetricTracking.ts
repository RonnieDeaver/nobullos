// @db-pool-intent: worker
//
// Task #4846 — client-level intake/sales metric-tracking classifier + the
// fabricated-zero-claim predicate. Single source for three consumers:
//
//   1. Daily-judgment source assembly (dailyJudgment.ts) — renders a
//      "not tracked for this client" line for metric families the client
//      has NEVER entered in any report month, distinct from a month-scoped
//      entry lapse ("not entered this month").
//   2. The knowledge extraction guard (agentKnowledgeService.ts) — blocks
//      judgment-output texts that assert unmeasured intake/sales outcomes
//      from being persisted as agent_knowledge_base facts, so the
//      self-reinforcing memory loop cannot re-form (the knowledge upsert
//      RESURRECTS deactivated rows on text match, so filtering before
//      persistence is what makes the hygiene drain durable).
//   3. The "deactivate fabricated zero-metric facts" prod action
//      (judgmentMemoryHygiene.ts) — deactivates existing poisoned facts for
//      clients whose report history shows the asserted metric family is
//      structurally not measured.
//
// Metric families (mirrors buildLatestReportSection's presence gates):
//   consults — intake.totalConsults OR intake.leadToConsultRate (both gated
//              on the intake section's totalConsults No-Data flag) OR
//              sales.totalConsults (gated on the sales totalConsults flag).
//   cases    — sales.totalCases OR sales.consultToCaseRate (both gated on
//              the sales totalCases flag).
//
// "Entered" is shared/reportMetrics.isMetricEntered as-is: a positive,
// un-flagged number. A stored 0 NEVER counts as entered — in the flag era a
// deliberate 0 entry is out of scope here (these count/rate fields treat 0
// as not-entered on every display surface), and legacy sections coerced
// blanks to 0 on save. This module must not move the entered-vs-blank
// boundary; it only aggregates it across a client's whole report history.
//
// Predicate calibration: the regexes below were calibrated two-sided
// against the production corpus (3,506 prefiltered active daily_judgment
// facts across 69 clients, read from the prod replica 2026-08-17) — every
// poisoned shape matches, pinned healthy control strings do not.
import { workerDb as db } from "../db";
import { sql } from "drizzle-orm";
import { reports, reportSections } from "@shared/schema";
import { isMetricEntered } from "@shared/reportMetrics";

export type MetricFamily = "consults" | "cases";

/**
 * never_entered — no report month in the client's entire history carries an
 * entered value for the family (structurally not tracked).
 * entered_before — at least one month ever had an entered value; an absent
 * value today is a month-scoped entry lapse, not a structural gap.
 */
export type MetricTrackingState = "never_entered" | "entered_before";

export interface ClientMetricTracking {
  consults: MetricTrackingState;
  cases: MetricTrackingState;
  /** Distinct report months inspected (0 = client has no intake/sales sections at all). */
  monthsInspected: number;
}

export interface MetricSectionRow {
  /** Report month the section belongs to (used only for monthsInspected). */
  month?: string | null;
  sectionKey: string;
  data: unknown;
}

/**
 * Pure per-client classifier over every intake/sales report section the
 * client has. Empty input (client never had a report, or reports without
 * intake/sales sections) classifies both families never_entered — for a
 * client with no report history there is no basis to claim a zero outcome.
 */
export function classifyMetricTrackingFromSections(rows: MetricSectionRow[]): ClientMetricTracking {
  let consultsEntered = false;
  let casesEntered = false;
  const months = new Set<string>();

  for (const row of rows) {
    if (row.month) months.add(row.month);
    const data = (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>;
    const flags = (data.noDataFlags && typeof data.noDataFlags === "object" ? data.noDataFlags : {}) as Record<
      string,
      boolean | undefined
    >;
    if (row.sectionKey === "intake") {
      // The intake section's totalConsults flag gates BOTH consult fields —
      // same pairing as buildLatestReportSection and hasGenuineConsultBookingData.
      if (
        isMetricEntered(data.totalConsults, flags.totalConsults) ||
        isMetricEntered(data.leadToConsultRate, flags.totalConsults)
      ) {
        consultsEntered = true;
      }
    } else if (row.sectionKey === "sales") {
      if (isMetricEntered(data.totalConsults, flags.totalConsults)) consultsEntered = true;
      if (
        isMetricEntered(data.totalCases, flags.totalCases) ||
        isMetricEntered(data.consultToCaseRate, flags.totalCases)
      ) {
        casesEntered = true;
      }
    }
  }

  return {
    consults: consultsEntered ? "entered_before" : "never_entered",
    cases: casesEntered ? "entered_before" : "never_entered",
    monthsInspected: months.size > 0 ? months.size : rows.length > 0 ? 1 : 0,
  };
}

/**
 * DB wrapper: fetch ALL intake/sales sections across the client's report
 * history (the judgment's existing reportHistory query only reads marketing
 * sections, LIMIT 6 — insufficient to prove "never entered"). A client has
 * ~2 sections per report month, so this stays a few dozen rows.
 */
export async function getClientMetricTracking(clientId: string): Promise<ClientMetricTracking> {
  const result = await db.execute(sql`
    SELECT r.report_month AS month, rs.section_key AS section_key, rs.data AS data
    FROM ${reports} r
    JOIN ${reportSections} rs ON rs.report_id = r.id AND rs.section_key IN ('intake', 'sales')
    WHERE r.client_id = ${clientId}
  `);
  const rows = (((result as any).rows ?? []) as any[]).map((r) => ({
    month: r.month ? String(r.month) : null,
    sectionKey: String(r.section_key),
    data: r.data,
  }));
  return classifyMetricTrackingFromSections(rows);
}

// ---------------------------------------------------------------------------
// Fabricated-zero-claim predicate
// ---------------------------------------------------------------------------

/**
 * Judgment prose uses unicode punctuation heavily (1,207 of the 3,506
 * prod-corpus candidates contain U+2010..U+2015 dashes — "zero‑intake" with
 * a non-breaking hyphen is the CANONICAL poisoned spelling in production).
 * Normalize before matching so the ASCII patterns below see one spelling.
 */
function normalizeForMatching(text: string): string {
  return text
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, " ");
}

/** Metric-noun vocabulary. consult/intake → consults family; case/sale → cases. */
const CONSULT_NOUN = "consult(?:ation)?s?|intakes?";
const CASE_NOUN = "cases?|sales?";
const METRIC_NOUN = `(?:${CONSULT_NOUN}|${CASE_NOUN})`;
/** Slash/comma/conjunction-joined noun chains ("intake/sales", "intake, consult, or case"). */
const METRIC_NOUN_CHAIN = `${METRIC_NOUN}(?:\\s*(?:[\\/,&+]|or|and)\\s*${METRIC_NOUN})*`;
const QUALIFIER = "(?:recorded|reported|new|confirmed|booked|signed|logged|measurable|actual)\\s+";

/**
 * Each pattern targets a poisoned shape observed verbatim in the production
 * corpus. Kept as a list so calibration tests can pin per-shape coverage.
 */
const FABRICATED_ZERO_PATTERNS: RegExp[] = [
  // "zero consults", "zero-consult", "0 intake", "no cases", "no recorded
  // intake", "produced no intake/sales", "confirmed zero-intake month".
  new RegExp(`\\b(?:zero|no|0)[\\s-]+(?:${QUALIFIER})?${METRIC_NOUN_CHAIN}\\b`, "gi"),
  // "consults and cases remain at zero", "intake is still zero",
  // "intake is currently at zero", "consults sit at zero". The verb
  // requirement is deliberate: "with zero communication" or "delivered zero
  // visible insights" near a metric noun are REAL observations (prod
  // corpus) and must not match.
  new RegExp(
    `\\b${METRIC_NOUN}\\b[^.;\\n]{0,80}?\\b(?:are|is|was|were|remain(?:s|ed|ing)?|stay(?:s|ed)?|sit(?:s|ting)?|stuck|held|holds?|holding|flat|show(?:s|ed|ing)?|hit(?:s|ting)?|dropped|fell|land(?:s|ed|ing)?)\\s+(?:(?:still|currently|now|clearly|effectively|essentially|all|both|again|firmly|basically|literally)\\s+){0,2}(?:(?:at|to)\\s+)?zero\\b`,
    "gi",
  ),
  // "all intake and sales metrics are 'no data'" — asserting the no-data
  // state itself as a recurring outcome.
  new RegExp(`\\b${METRIC_NOUN}\\b[^.;\\n]{0,80}?\\bno[\\s-]data\\b`, "gi"),
  // "no recorded intake, consult, or case data", "no intake or sales data",
  // "no consult numbers".
  new RegExp(
    `\\bno\\s+(?:${QUALIFIER})?${METRIC_NOUN_CHAIN}[\\s-]+(?:data|numbers?|metrics?|figures?|entries|reporting|visibility)\\b`,
    "gi",
  ),
  // "no visibility into conversion", "lack visibility into the conversion
  // problem", "zero visibility into intake".
  new RegExp(
    `\\b(?:no|zero|lack(?:s|ed|ing)?(?:\\s+of)?|without|little)\\s+(?:any\\s+|real\\s+|clear\\s+|direct\\s+)?visibility\\s+into\\b[^.;\\n]{0,60}?\\b(?:conversion|${METRIC_NOUN})`,
    "gi",
  ),
  // "zero-consult/poor-conversion outcome", "zero conversions",
  // "360-leads/0-conversions incident".
  /\b(?:zero|poor|0)[\s-]conversions?\b/gi,
  // "prior lead conversion failure", "conversion breakdown". Deliberately
  // NOT "conversion issues" or "conversion can be fixed" — those appear in
  // healthy re-engagement framing in the production corpus.
  /\b(?:lead\s+)?conversion\s+(?:failure|breakdown|collapse)\b/gi,
];

export interface FabricatedZeroMatch {
  matched: boolean;
  /** Metric families the text asserts an unmeasured outcome for. */
  families: MetricFamily[];
}

/**
 * Detects judgment-authored texts that assert a zero or failed-conversion
 * OUTCOME for intake/sales metrics. Family attribution is noun-driven:
 * consult/intake tokens → consults; case/sale tokens → cases; generic
 * conversion/visibility claims span the whole lead→consult→case chain, so
 * they assert BOTH families (suppression then requires both to be
 * never-tracked — the conservative direction).
 */
export function matchFabricatedZeroClaim(text: string): FabricatedZeroMatch {
  const normalized = normalizeForMatching(text);
  const families = new Set<MetricFamily>();
  let matched = false;
  for (const pattern of FABRICATED_ZERO_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(normalized)) !== null) {
      matched = true;
      const span = m[0];
      const hasConsult = /consult|intake/i.test(span);
      const hasCase = /case|sale/i.test(span);
      if (hasConsult) families.add("consults");
      if (hasCase) families.add("cases");
      if (/conversion/i.test(span) || (!hasConsult && !hasCase)) {
        families.add("consults");
        families.add("cases");
      }
      if (pattern.lastIndex === m.index) pattern.lastIndex++;
    }
  }
  return { matched, families: Array.from(families) };
}

/**
 * A claim is suppressible (guard) / deactivatable (drain) only when EVERY
 * metric family it asserts is never_entered for the client. Mixed claims
 * touching any tracked family are kept — they may be grounded in real data.
 */
export function shouldSuppressFabricatedZeroClaim(
  text: string,
  tracking: ClientMetricTracking,
): boolean {
  const match = matchFabricatedZeroClaim(text);
  if (!match.matched || match.families.length === 0) return false;
  return match.families.every((family) => tracking[family] === "never_entered");
}

/**
 * Pure filter used by the extraction guard: partitions candidate facts into
 * kept vs suppressed against a client's tracking classification.
 */
export function filterFabricatedZeroFacts<T extends { text: string }>(
  facts: T[],
  tracking: ClientMetricTracking,
): { kept: T[]; suppressed: T[] } {
  const kept: T[] = [];
  const suppressed: T[] = [];
  for (const fact of facts) {
    if (shouldSuppressFabricatedZeroClaim(fact.text, tracking)) suppressed.push(fact);
    else kept.push(fact);
  }
  return { kept, suppressed };
}
