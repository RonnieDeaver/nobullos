/**
 * Task #4902 — purge AI-authored slide verdicts from existing reports.
 *
 * Owner mandate: AI-invented advice must not appear on client-facing
 * reports. The finalize-time auto-drafting kick is removed in the same task;
 * this module cleans up what it already wrote. For every stored
 * `slideVerdicts` section row it attributes each key's CURRENT value via the
 * append-only report_section_history journal:
 *
 *   - introducing write = the newest history row whose `newData` carries the
 *     current value for that key while its `previousData` did not (whole-map
 *     editor autosaves that merely carried an AI value through unchanged are
 *     therefore never the introducing write);
 *   - introduced by the retired finalize AI identity
 *     (SLIDE_VERDICTS_AI_EDITOR) → AI-authored → cleared;
 *   - introduced by anyone else (operator PUTs — including operator-applied
 *     "Draft with AI" sentences, which save through the section PUT with the
 *     operator's own id) → kept;
 *   - keys no longer in SLIDE_VERDICT_KEYS (the Task #4902-retired
 *     `lifetimeValue`, or junk) → cleared unconditionally regardless of
 *     author (the slot no longer exists; serves already strip it);
 *   - unattributable (no introducing write found in history) → KEPT and
 *     counted — the conservative failure mode protects operator copy, and a
 *     missed AI line stays operator-clearable in the editor.
 *
 * Writes go through storage.purgeSlideVerdictKeys — a FOR UPDATE + per-key
 * value-CAS transaction that appends a history row — so operator edits
 * landing mid-run win, and everything cleared stays recoverable verbatim
 * from the journal's `previousData`.
 */
import { and, desc, eq } from "drizzle-orm";
import { reportSectionHistory, reportSections, reports } from "@shared/schema";
import { SLIDE_VERDICT_KEYS } from "../../shared/slideVerdicts";
import {
  SLIDE_VERDICTS_AI_EDITOR,
  SLIDE_VERDICTS_SECTION_KEY,
} from "./slideVerdicts";
import type { getDb } from "../db";
import { storage } from "../storage";
import type {
  SlideVerdictKeyClear,
  SlideVerdictPurgeWriteResult,
} from "../storage/reportStorage";

/** Attribution identity the purge stamps on its own history rows. */
export const SLIDE_VERDICT_PURGE_EDITOR = "system:slide-verdict-purge";

type DbHandle = ReturnType<typeof getDb>;

/** Minimal history-row slice the attribution walk needs (newest first). */
export interface VerdictHistoryRowLike {
  editedBy: string | null;
  previousData: unknown;
  newData: unknown;
}

export type SlideVerdictKeyDecision =
  | { key: string; decision: "clear_ai"; expectedValue: string }
  | { key: string; decision: "clear_retired" }
  | { key: string; decision: "keep_operator" }
  | { key: string; decision: "keep_unattributed" };

/** `data.verdicts[key]` when it is a string, else undefined. Never throws. */
function readVerdictValue(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const verdicts = (data as Record<string, unknown>).verdicts;
  if (!verdicts || typeof verdicts !== "object" || Array.isArray(verdicts)) return undefined;
  const value = (verdicts as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Pure attribution walk over one section row's stored verdict map and its
 * history rows (NEWEST FIRST — the order getReportSectionHistory returns).
 * Exported for direct unit coverage.
 */
export function attributeSlideVerdicts(
  storedVerdicts: Record<string, unknown>,
  historyNewestFirst: VerdictHistoryRowLike[],
): SlideVerdictKeyDecision[] {
  const decisions: SlideVerdictKeyDecision[] = [];
  for (const [key, raw] of Object.entries(storedVerdicts)) {
    if (!(SLIDE_VERDICT_KEYS as readonly string[]).includes(key)) {
      decisions.push({ key, decision: "clear_retired" });
      continue;
    }
    if (typeof raw !== "string") {
      // Non-string junk under a live key: no writer produces this shape and
      // serves already drop it via sanitize — retire it with the stale class.
      decisions.push({ key, decision: "clear_retired" });
      continue;
    }
    const current = raw;
    const introducing = historyNewestFirst.find(
      (row) =>
        readVerdictValue(row.newData, key) === current &&
        readVerdictValue(row.previousData, key) !== current,
    );
    if (!introducing) {
      decisions.push({ key, decision: "keep_unattributed" });
      continue;
    }
    if (introducing.editedBy === SLIDE_VERDICTS_AI_EDITOR) {
      decisions.push({ key, decision: "clear_ai", expectedValue: current });
    } else {
      decisions.push({ key, decision: "keep_operator" });
    }
  }
  return decisions;
}

export interface SlideVerdictPurgeCandidate {
  reportId: string;
  reportMonth: string | null;
  clears: SlideVerdictKeyClear[];
  keptOperatorKeys: string[];
  keptUnattributedKeys: string[];
}

export interface SlideVerdictPurgeScan {
  /** slideVerdicts rows inspected (with a non-empty stored map). */
  scanned: number;
  /** Rows with ≥1 clearable key. */
  candidates: SlideVerdictPurgeCandidate[];
  /** Total keys kept because no introducing write was found (all rows). */
  unattributedKeys: number;
}

/**
 * Scan every stored slideVerdicts section row and attribute each key.
 * Read-only; called by the action's status(), countPending, and each drain
 * chunk (processed rows stop matching, so the drain converges).
 */
export async function scanSlideVerdictPurgeCandidates(
  db: DbHandle,
): Promise<SlideVerdictPurgeScan> {
  const rows = await db
    .select({
      reportId: reportSections.reportId,
      data: reportSections.data,
      reportMonth: reports.reportMonth,
    })
    .from(reportSections)
    .leftJoin(reports, eq(reports.id, reportSections.reportId))
    .where(eq(reportSections.sectionKey, SLIDE_VERDICTS_SECTION_KEY));

  const scan: SlideVerdictPurgeScan = { scanned: 0, candidates: [], unattributedKeys: 0 };
  for (const row of rows) {
    const data =
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {};
    const verdicts =
      data.verdicts && typeof data.verdicts === "object" && !Array.isArray(data.verdicts)
        ? (data.verdicts as Record<string, unknown>)
        : {};
    if (Object.keys(verdicts).length === 0) continue;
    scan.scanned++;

    const history = await db
      .select({
        editedBy: reportSectionHistory.editedBy,
        previousData: reportSectionHistory.previousData,
        newData: reportSectionHistory.newData,
      })
      .from(reportSectionHistory)
      .where(
        and(
          eq(reportSectionHistory.reportId, row.reportId),
          eq(reportSectionHistory.sectionKey, SLIDE_VERDICTS_SECTION_KEY),
        ),
      )
      .orderBy(desc(reportSectionHistory.createdAt));

    const decisions = attributeSlideVerdicts(verdicts, history);
    const clears: SlideVerdictKeyClear[] = [];
    const keptOperatorKeys: string[] = [];
    const keptUnattributedKeys: string[] = [];
    for (const d of decisions) {
      if (d.decision === "clear_ai") clears.push({ key: d.key, expectedValue: d.expectedValue });
      else if (d.decision === "clear_retired") clears.push({ key: d.key, expectedValue: null });
      else if (d.decision === "keep_operator") keptOperatorKeys.push(d.key);
      else keptUnattributedKeys.push(d.key);
    }
    scan.unattributedKeys += keptUnattributedKeys.length;
    if (clears.length > 0) {
      scan.candidates.push({
        reportId: row.reportId,
        reportMonth: row.reportMonth ?? null,
        clears,
        keptOperatorKeys,
        keptUnattributedKeys,
      });
    }
  }
  return scan;
}

/**
 * Apply one candidate through the audited storage writer (FOR UPDATE +
 * per-key value-CAS + history row).
 */
export async function purgeSlideVerdictCandidate(
  candidate: SlideVerdictPurgeCandidate,
): Promise<SlideVerdictPurgeWriteResult> {
  return storage.purgeSlideVerdictKeys(
    candidate.reportId,
    SLIDE_VERDICTS_SECTION_KEY,
    candidate.clears,
    { editor: SLIDE_VERDICT_PURGE_EDITOR, source: "system" },
  );
}
