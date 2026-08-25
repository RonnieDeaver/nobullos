// @db-pool-intent: ambient
/**
 * Task #3769 — shared core for clearing placeholder-only Common Issues
 * values across ALL reports.
 *
 * Background:
 *   Task #830 stopped the PDF parser from storing the literal "Missing data
 *   source …" placeholder; Task #831/#1267 cleared historical rows via
 *   `scripts/clear-placeholder-common-issues.ts`. Task #3769 found a third
 *   escape: the raw Looker artifact with a trailing source-name tail
 *   ("Missing data source … See details Name_Clean (1): Ackah Law") evaded
 *   the placeholder gate, so the AI formatter rewrote it into a fake red
 *   "Issue" that reached a shared client report. The detection gap is fixed
 *   in `pdfImportParser.ts`; this module is the repeatable cleanup for rows
 *   poisoned BEFORE that fix, consumed by two callers that must stay in
 *   lockstep:
 *     - `scripts/clear-placeholder-common-issues.ts` (CLI, dry-run by
 *       default) — dev inspection of candidate counts.
 *     - the `clear_placeholder_common_issues` CEO prod-action in
 *       `prodActionsRegistry.ts` — one-press cleanup against the deployed
 *       database (dev can only read prod).
 *
 * Eligibility (a row is cleared when its ENTIRE commonIssues value is):
 *   - the literal placeholder family, now including "Name_Clean (N): <client>"
 *     tails (`isMissingDataSourcePlaceholder`), or
 *   - a blank/dashes-only/artifact-only body (`isEmptySectionBody`), or
 *   - an AI-rewritten placeholder finding
 *     (`classifyAiRewrittenMissingDataSourceFinding`) — Task #3901: both the
 *     placeholder-only class and the junk-fabricated multi-block class
 *     (leading missing-data-source 🔴 block + siblings hallucinated from
 *     swallowed dashboard junk, e.g. Wanta Thome 2026-07's 11 fake blocks),
 *     including mid-text "Name_Clean (N)" remediation variants, or
 *   - the junk-tailed raw literal (`isJunkTailedLiteralPlaceholder`): the
 *     literal placeholder followed only by swallowed dashboard junk.
 *   Rows mixing real findings with placeholder text are left untouched
 *   (business-generic hallucinations indistinguishable from real operator
 *   prose deliberately stay visible — false negatives are the safe
 *   direction).
 *
 * Convergence: clearing sets `data.commonIssues = ""` (other keys
 * preserved), so a second scan finds nothing and the prod action settles to
 * "not needed".
 */

import { inArray, eq } from "drizzle-orm";
import { reportSections } from "@shared/schema";
import {
  isEmptySectionBody,
  isMissingDataSourcePlaceholder,
  classifyAiRewrittenMissingDataSourceFinding,
  isJunkTailedLiteralPlaceholder,
} from "./pdfImportParser";

export type CleanupDb = ReturnType<typeof import("../db")["getDb"]>;

export const CLEANUP_TARGET_SECTION_KEYS = ["intake", "sales"] as const;

export type PlaceholderCleanupKind =
  | "literal_placeholder"
  | "blank_body"
  | "ai_rewritten_placeholder"
  // Task #3901 — junk-fed classes: the AI-fabricated multi-block shape
  // (leading missing-data-source 🔴 block + siblings hallucinated from
  // swallowed dashboard junk) and the raw literal placeholder with a
  // swallowed-junk tail (no 🔴 blocks at all).
  | "junk_fabricated_placeholder"
  | "junk_tailed_literal";

export interface PlaceholderCleanupCandidate {
  id: string;
  reportId: string;
  sectionKey: string;
  data: Record<string, unknown>;
  current: string;
  kind: PlaceholderCleanupKind;
}

export interface PlaceholderCleanupScan {
  scanned: number;
  alreadyEmpty: number;
  skippedRealContent: number;
  countsByKind: Record<PlaceholderCleanupKind, number>;
  candidates: PlaceholderCleanupCandidate[];
}

/**
 * Classify one stored commonIssues value. Returns null for real content
 * (including mixed placeholder + real findings) and for already-empty
 * values — both must be left untouched.
 */
export function classifyPlaceholderCommonIssues(
  current: string,
): PlaceholderCleanupKind | null {
  if (current === "") return null;
  if (isMissingDataSourcePlaceholder(current)) return "literal_placeholder";
  if (isEmptySectionBody(current)) return "blank_body";
  if (isJunkTailedLiteralPlaceholder(current)) return "junk_tailed_literal";
  const aiClass = classifyAiRewrittenMissingDataSourceFinding(current);
  if (aiClass === "placeholder_only") return "ai_rewritten_placeholder";
  if (aiClass === "junk_fabricated") return "junk_fabricated_placeholder";
  return null;
}

/**
 * Scan every intake/sales section row with a non-empty commonIssues string
 * and classify it. Read-only.
 */
export async function scanPlaceholderCommonIssues(
  db: CleanupDb,
): Promise<PlaceholderCleanupScan> {
  const rows = await db
    .select({
      id: reportSections.id,
      reportId: reportSections.reportId,
      sectionKey: reportSections.sectionKey,
      data: reportSections.data,
    })
    .from(reportSections)
    .where(inArray(reportSections.sectionKey, [...CLEANUP_TARGET_SECTION_KEYS]));

  const scan: PlaceholderCleanupScan = {
    scanned: 0,
    alreadyEmpty: 0,
    skippedRealContent: 0,
    countsByKind: {
      literal_placeholder: 0,
      blank_body: 0,
      ai_rewritten_placeholder: 0,
      junk_fabricated_placeholder: 0,
      junk_tailed_literal: 0,
    },
    candidates: [],
  };

  for (const row of rows) {
    scan.scanned++;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const current =
      typeof data.commonIssues === "string" ? (data.commonIssues as string) : "";
    if (current === "") {
      scan.alreadyEmpty++;
      continue;
    }
    const kind = classifyPlaceholderCommonIssues(current);
    if (kind === null) {
      scan.skippedRealContent++;
      continue;
    }
    scan.countsByKind[kind]++;
    scan.candidates.push({
      id: row.id,
      reportId: row.reportId,
      sectionKey: row.sectionKey,
      data,
      current,
      kind,
    });
  }

  return scan;
}

/**
 * Clear the given candidates' commonIssues (sets "" while preserving every
 * other key in data). Returns the number of rows updated. Idempotent — a
 * candidate whose value changed since the scan is re-checked before write
 * so real content saved in the interim is never destroyed.
 */
export async function clearPlaceholderCommonIssuesCandidates(
  db: CleanupDb,
  candidates: PlaceholderCleanupCandidate[],
): Promise<number> {
  let updated = 0;
  for (const c of candidates) {
    // Re-read the row so a save that landed between scan and clear (e.g. an
    // operator typing real findings) is never overwritten.
    const [fresh] = await db
      .select({ id: reportSections.id, data: reportSections.data })
      .from(reportSections)
      .where(eq(reportSections.id, c.id))
      .limit(1);
    if (!fresh) continue;
    const freshData = (fresh.data ?? {}) as Record<string, unknown>;
    const freshCurrent =
      typeof freshData.commonIssues === "string"
        ? (freshData.commonIssues as string)
        : "";
    if (freshCurrent === "" || classifyPlaceholderCommonIssues(freshCurrent) === null) {
      continue;
    }
    const nextData = { ...freshData, commonIssues: "" };
    await db
      .update(reportSections)
      .set({ data: nextData })
      .where(eq(reportSections.id, c.id));
    updated++;
  }
  return updated;
}
