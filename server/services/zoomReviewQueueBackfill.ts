// @db-pool-intent: ambient
// (Task #4050) Shared backfill/estimate helpers: invoked from worker-context
// review-queue backfills, API-context prod-action presses, and tests — every
// getDb() call inherits the caller's pool via AsyncLocalStorage.
import { randomUUID } from "crypto";
import { db, getDb, withDbAttribution } from "../db";
import { and, desc, eq, inArray, isNull, or, sql, like } from "drizzle-orm";
import {
  rawCommunicationRecords,
  agentMatchDecisions,
  communicationClientLinks,
  type RawCommunicationRecord,
} from "@shared/schema";
import { recordZoomReviewDecision, NO_CANDIDATE_REVIEW_REASON } from "./zoomReviewQueue";

const REVIEW_QUEUE_BACKFILL_WORKER_NAME = "zoom_review_queue_backfill";
const NO_CANDIDATE_BACKFILL_WORKER_NAME = "zoom_no_candidate_review_queue_backfill";

/**
 * Task #1199: small wrapper that auto-mutes manual-reserve alerts for the
 * duration of a Zoom review-queue backfill apply run. Mirrors the SEMrush
 * backfill wiring (Task #726): generates a fresh jobId, installs the mute,
 * runs the backfill, and clears the mute in `finally`. Skipped on dry-runs
 * (read-only). Manual operator mutes take precedence and are not overwritten.
 */
async function withManualReserveAutoMute<T>(
  workerName: string,
  dryRun: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (dryRun) {
    return fn();
  }
  const jobId = randomUUID();
  try {
    const { setManualReserveMuteForBackfillJob } = await import(
      "./manualReserveAlerts"
    );
    const outcome = await setManualReserveMuteForBackfillJob({
      jobId,
      jobLabel: workerName,
      durationMs: 4 * 60 * 60_000,
      reason: `Auto-muted for ${workerName} backfill (job ${jobId})`,
    });
    if (!outcome.applied) {
      console.log(
        `[${workerName}] Backfill: skipped auto-mute (operator manual mute is active)`,
      );
    }
  } catch (e: any) {
    console.warn(
      `[${workerName}] Backfill: failed to auto-mute manual-reserve alerts (non-fatal): ${e?.message || e}`,
    );
  }
  try {
    return await fn();
  } finally {
    try {
      const { clearManualReserveMuteForBackfillJob } = await import(
        "./manualReserveAlerts"
      );
      await clearManualReserveMuteForBackfillJob(jobId);
    } catch (e: any) {
      console.warn(
        `[${workerName}] Backfill: failed to release auto-mute (non-fatal, will expire on its own): ${e?.message || e}`,
      );
    }
  }
}

/**
 * Stable prefix stamped on `explanationSummary` for every review-queue row
 * created by the historical backfill (task #451). Used by `listZoomReviewQueue`
 * and the admin UI to distinguish backfilled rows from live reprocess rows.
 *
 * Migration 0023 (task #552) rewrote any pre-existing legacy summaries
 * ("Backfill: historical Zoom reprocess ...") to use this prefix, so callers
 * only need to match the single tag.
 */
export const BACKFILL_EXPLANATION_PREFIX = "[backfill]";

export function isBackfillExplanationSummary(summary: string | null | undefined): boolean {
  if (!summary) return false;
  return summary.startsWith(BACKFILL_EXPLANATION_PREFIX);
}

export type BackfillSkipReason =
  | "no_prior_client"
  | "already_has_decision"
  | "unparseable_match_method";

export type ClientSource = "raw_record" | "communication_client_link" | "rerun_content_match" | "rerun_participant_match";

export interface BackfillItemResult {
  recordId: string;
  matchMethod: string;
  reviewReason: string | null;
  matchedOn: string | null;
  suggestedClientId: string | null;
  clientSource?: ClientSource;
  action: "would_record" | "recorded" | "skipped";
  skipReason?: BackfillSkipReason;
  decisionId?: string;
}

export interface BackfillReport {
  scanned: number;
  recorded: number;
  wouldRecord: number;
  skippedAlreadyHasDecision: number;
  skippedNoPriorClient: number;
  skippedUnparseable: number;
  recoveredFromLink: number;
  recoveredFromRerunContent: number;
  recoveredFromRerunParticipants: number;
  errors: Array<{ recordId: string; message: string }>;
  items: BackfillItemResult[];
}

interface RunOpts {
  dryRun?: boolean;
  limit?: number;
}

/**
 * Parse a `review_required:<reviewReason>:<matchedOn...>` matchMethod sentinel
 * written by the manual Zoom reprocess endpoints prior to task #431.
 *
 * Known shapes (see server/routes/communications.ts):
 *   review_required:solo_internal_participants:<previousMatchMethod>
 *   review_required:weak_signal_only:content:<matchedOn>
 *   review_required:weak_signal_only:<emailMatchedOn>
 *   review_required:contact_name_only_weak:content:<matchedOn>
 *   review_required:contact_name_only_weak:<emailMatchedOn>
 */
export function parseReviewRequiredMatchMethod(
  matchMethod: string,
): { reviewReason: string; matchedOn: string } | null {
  if (!matchMethod.startsWith("review_required:")) return null;
  const rest = matchMethod.slice("review_required:".length);
  const idx = rest.indexOf(":");
  if (idx === -1) {
    if (!rest) return null;
    return { reviewReason: rest, matchedOn: "unknown" };
  }
  const reviewReason = rest.slice(0, idx);
  const matchedOn = rest.slice(idx + 1) || "unknown";
  if (!reviewReason) return null;
  return { reviewReason, matchedOn };
}

/**
 * Try to recover a suggested clientId for a Zoom record whose `clientId` was
 * never persisted (the unmatched-reprocess demote path didn't set it). We
 * look at communication_client_links first (cheap), then re-run the same
 * deterministic matcher that was originally used (parsed from the matchedOn
 * suffix of the sentinel).
 */
async function recoverSuggestedClient(
  record: RawCommunicationRecord,
  matchedOn: string,
): Promise<{ clientId: string; source: ClientSource } | null> {
  // 1) Existing client links (any status — even rejected links record the
  // client the system originally suggested).
  const links = await db
    .select()
    .from(communicationClientLinks)
    .where(eq(communicationClientLinks.rawCommunicationRecordId, record.id));
  if (links.length > 0) {
    const primary = links.find((l) => l.isPrimary) || links[0];
    if (primary.clientId) {
      return { clientId: primary.clientId, source: "communication_client_link" };
    }
  }

  const participants = Array.isArray(record.participantsJson)
    ? (record.participantsJson as Array<{ email?: string; name?: string }>)
    : [];
  const emails = participants.map((p) => p.email).filter(Boolean) as string[];
  const names = participants.map((p) => p.name).filter(Boolean) as string[];

  // 2) Re-run the deterministic participant matcher. Task #2637: the
  // content/transcript fuzzy rerun was removed; recovery now relies solely on
  // deterministic participant matching.
  if (emails.length > 0 || names.length > 0) {
    try {
      const { matchClientByParticipants } = await import("./zoomIntegration");
      const m = await matchClientByParticipants(emails, names, { source: "zoom" });
      if (m) {
        return { clientId: m.clientId, source: "rerun_participant_match" };
      }
    } catch (err) {
      console.error("[ZoomReviewQueueBackfill] participant rerun failed:", err);
    }
  }

  return null;
}

async function findExistingZoomDecisionForRecord(recordId: string) {
  const rows = await db
    .select({ id: agentMatchDecisions.id })
    .from(agentMatchDecisions)
    .where(
      and(
        eq(agentMatchDecisions.communicationId, recordId),
        eq(agentMatchDecisions.sourceType, "zoom"),
      ),
    )
    .limit(1);
  return rows[0] || null;
}

export async function runZoomReviewQueueBackfill(opts: RunOpts = {}): Promise<BackfillReport> {
  const dryRun = opts.dryRun ?? true;
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
  return withManualReserveAutoMute(
    REVIEW_QUEUE_BACKFILL_WORKER_NAME,
    dryRun,
    () => runZoomReviewQueueBackfillInternal(dryRun, limit),
  );
}

async function runZoomReviewQueueBackfillInternal(
  dryRun: boolean,
  limit: number,
): Promise<BackfillReport> {
  // Anti-join against agent_match_decisions so `limit` applies only to records
  // that still need a decision row. Without this, repeated runs would keep
  // re-scanning the same oldest already-backfilled rows and never progress
  // through a backlog larger than `limit`.
  const candidates: RawCommunicationRecord[] = await db
    .select()
    .from(rawCommunicationRecords)
    .where(
      and(
        eq(rawCommunicationRecords.sourceType, "zoom"),
        like(rawCommunicationRecords.matchMethod, "review_required:%"),
        // Task #965: skip orphaned rows — their parent client is gone, so
        // there is nothing to enqueue for review.
        sql`(${rawCommunicationRecords.matchStatus} IS NULL OR ${rawCommunicationRecords.matchStatus} <> 'orphaned')`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${agentMatchDecisions}
          WHERE ${agentMatchDecisions.communicationId} = ${rawCommunicationRecords.id}
            AND ${agentMatchDecisions.sourceType} = 'zoom'
        )`,
      ),
    )
    .orderBy(rawCommunicationRecords.timestamp)
    .limit(limit);

  const report: BackfillReport = {
    scanned: candidates.length,
    recorded: 0,
    wouldRecord: 0,
    skippedAlreadyHasDecision: 0,
    skippedNoPriorClient: 0,
    skippedUnparseable: 0,
    recoveredFromLink: 0,
    recoveredFromRerunContent: 0,
    recoveredFromRerunParticipants: 0,
    errors: [],
    items: [],
  };

  for (const record of candidates) {
    const matchMethod = record.matchMethod || "";
    const parsed = parseReviewRequiredMatchMethod(matchMethod);
    if (!parsed) {
      report.skippedUnparseable++;
      report.items.push({
        recordId: record.id,
        matchMethod,
        reviewReason: null,
        matchedOn: null,
        suggestedClientId: record.clientId,
        action: "skipped",
        skipReason: "unparseable_match_method",
      });
      continue;
    }

    let suggestedClientId: string | null = record.clientId;
    let clientSource: ClientSource = "raw_record";
    if (!suggestedClientId) {
      const recovered = await recoverSuggestedClient(record, parsed.matchedOn);
      if (recovered) {
        suggestedClientId = recovered.clientId;
        clientSource = recovered.source;
        if (recovered.source === "communication_client_link") report.recoveredFromLink++;
        else if (recovered.source === "rerun_content_match") report.recoveredFromRerunContent++;
        else if (recovered.source === "rerun_participant_match") report.recoveredFromRerunParticipants++;
      }
    }
    if (!suggestedClientId) {
      report.skippedNoPriorClient++;
      report.items.push({
        recordId: record.id,
        matchMethod,
        reviewReason: parsed.reviewReason,
        matchedOn: parsed.matchedOn,
        suggestedClientId: null,
        action: "skipped",
        skipReason: "no_prior_client",
      });
      continue;
    }

    try {
      const existing = await findExistingZoomDecisionForRecord(record.id);
      if (existing) {
        report.skippedAlreadyHasDecision++;
        report.items.push({
          recordId: record.id,
          matchMethod,
          reviewReason: parsed.reviewReason,
          matchedOn: parsed.matchedOn,
          suggestedClientId,
          action: "skipped",
          skipReason: "already_has_decision",
          decisionId: existing.id,
        });
        continue;
      }

      if (dryRun) {
        report.wouldRecord++;
        report.items.push({
          recordId: record.id,
          matchMethod,
          reviewReason: parsed.reviewReason,
          matchedOn: parsed.matchedOn,
          suggestedClientId,
          clientSource,
          action: "would_record",
        });
        continue;
      }

      const decision = await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId,
        confidenceScore: typeof record.matchConfidence === "number" ? record.matchConfidence : 0.5,
        explanationSummary: `${BACKFILL_EXPLANATION_PREFIX} historical Zoom reprocess demoted this record to review (${parsed.matchedOn})`,
        reviewReason: parsed.reviewReason,
        candidateShortlist: [
          {
            clientId: suggestedClientId,
            confidenceScore: typeof record.matchConfidence === "number" ? record.matchConfidence : 0.5,
            matchedOn: parsed.matchedOn,
          },
        ],
        priorClientId: suggestedClientId,
      });

      report.recorded++;
      report.items.push({
        recordId: record.id,
        matchMethod,
        reviewReason: parsed.reviewReason,
        matchedOn: parsed.matchedOn,
        suggestedClientId,
        clientSource,
        action: "recorded",
        decisionId: decision?.id,
      });
    } catch (err: any) {
      report.errors.push({
        recordId: record.id,
        message: err?.message || String(err),
      });
    }
  }

  return report;
}

/**
 * Stable prefix stamped on `explanationSummary` for every no-candidate
 * review-queue row created by the task #1001 backfill. Distinguishes these
 * historical rows from the live no-candidate rows enqueued by MeetingApply,
 * TranscriptApply, and the Zoom Reprocess endpoints (task #995).
 *
 * IMPORTANT: this string starts with `BACKFILL_EXPLANATION_PREFIX` ("[backfill]")
 * so the existing source filter in `listZoomReviewQueue` and
 * `getZoomReviewSourceCounts` (which key off the `[backfill]%` LIKE pattern)
 * correctly classifies these as "backfill" rather than "live".
 */
export const NO_CANDIDATE_BACKFILL_EXPLANATION_PREFIX =
  `${BACKFILL_EXPLANATION_PREFIX} no_candidate:`;

export interface NoCandidateBackfillItemResult {
  recordId: string;
  title: string;
  timestamp: string | null;
  action: "would_record" | "recorded" | "skipped";
  skipReason?: "already_has_review_decision" | "already_has_no_candidate_row";
  decisionId?: string;
}

export interface NoCandidateBackfillReport {
  scanned: number;
  recorded: number;
  wouldRecord: number;
  skippedAlreadyHasReviewDecision: number;
  skippedAlreadyHasNoCandidateRow: number;
  errors: Array<{ recordId: string; message: string }>;
  items: NoCandidateBackfillItemResult[];
}

/**
 * Task #1001: backfill no-candidate Review Queue rows for older Zoom recordings
 * that pre-date task #995. Walks `raw_communication_records` with
 * sourceType='zoom' and matchStatus='unmatched' (the canonical value the live
 * ingestion paths set; NULL matchStatus is intentionally excluded since those
 * rows haven't completed initial processing yet) and inserts a
 * `review_required` decision row with `clientId = NULL` and
 * `reviewReason = 'no_deterministic_booking_match'` so they surface in the
 * Review Queue alongside live no-candidate ingestions.
 *
 * Idempotent: anti-joins against any existing zoom `review_required` row for
 * the same communication; the partial unique index from migration 0046
 * (`agent_match_decisions_no_candidate_review_unique`) is the final guard
 * against duplicates if two passes race.
 */
export async function runZoomNoCandidateReviewQueueBackfill(
  opts: RunOpts = {},
): Promise<NoCandidateBackfillReport> {
  const dryRun = opts.dryRun ?? true;
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
  return withManualReserveAutoMute(
    NO_CANDIDATE_BACKFILL_WORKER_NAME,
    dryRun,
    () => runZoomNoCandidateReviewQueueBackfillInternal(dryRun, limit),
  );
}

async function runZoomNoCandidateReviewQueueBackfillInternal(
  dryRun: boolean,
  limit: number,
): Promise<NoCandidateBackfillReport> {
  // Anti-join against agent_match_decisions so `limit` only applies to
  // records that still need a no-candidate review row. Otherwise repeated
  // runs would keep re-scanning the same already-backfilled records and
  // never progress through a backlog larger than `limit`.
  const candidates: RawCommunicationRecord[] = await db
    .select()
    .from(rawCommunicationRecords)
    .where(
      and(
        eq(rawCommunicationRecords.sourceType, "zoom"),
        // matchStatus='unmatched' already excludes orphans (which carry
        // matchStatus='orphaned'), but we keep the condition explicit alongside
        // Task #965's hide-orphans audit so the intent is obvious to readers.
        eq(rawCommunicationRecords.matchStatus, "unmatched"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${agentMatchDecisions}
          WHERE ${agentMatchDecisions.communicationId} = ${rawCommunicationRecords.id}
            AND ${agentMatchDecisions.sourceType} = 'zoom'
            AND ${agentMatchDecisions.status} = 'review_required'
        )`,
      ),
    )
    .orderBy(rawCommunicationRecords.timestamp)
    .limit(limit);

  const report: NoCandidateBackfillReport = {
    scanned: candidates.length,
    recorded: 0,
    wouldRecord: 0,
    skippedAlreadyHasReviewDecision: 0,
    skippedAlreadyHasNoCandidateRow: 0,
    errors: [],
    items: [],
  };

  for (const record of candidates) {
    const title = record.title || record.id;
    const timestamp = record.timestamp ? new Date(record.timestamp).toISOString() : null;

    try {
      // Defensive re-check: between the candidate scan and now, another
      // concurrent backfill or a live ingestion path may have inserted a
      // review_required row. The partial unique index would also catch this
      // but skipping early avoids a wasted insert attempt.
      const existing = await db
        .select({ id: agentMatchDecisions.id, clientId: agentMatchDecisions.clientId })
        .from(agentMatchDecisions)
        .where(
          and(
            eq(agentMatchDecisions.communicationId, record.id),
            eq(agentMatchDecisions.sourceType, "zoom"),
            eq(agentMatchDecisions.status, "review_required"),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const wasNoCandidate = existing[0].clientId == null;
        if (wasNoCandidate) report.skippedAlreadyHasNoCandidateRow++;
        else report.skippedAlreadyHasReviewDecision++;
        report.items.push({
          recordId: record.id,
          title,
          timestamp,
          action: "skipped",
          skipReason: wasNoCandidate ? "already_has_no_candidate_row" : "already_has_review_decision",
          decisionId: existing[0].id,
        });
        continue;
      }

      if (dryRun) {
        report.wouldRecord++;
        report.items.push({
          recordId: record.id,
          title,
          timestamp,
          action: "would_record",
        });
        continue;
      }

      const decision = await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId: null,
        confidenceScore: 0,
        explanationSummary: `${NO_CANDIDATE_BACKFILL_EXPLANATION_PREFIX} historical Zoom recording with no deterministic booking, participant, or content match for "${title}"`,
        reviewReason: NO_CANDIDATE_REVIEW_REASON,
        candidateShortlist: [],
        evidenceType: "structured",
        priorClientId: record.clientId ?? null,
      });

      report.recorded++;
      report.items.push({
        recordId: record.id,
        title,
        timestamp,
        action: "recorded",
        decisionId: decision?.id,
      });
    } catch (err: any) {
      report.errors.push({
        recordId: record.id,
        message: err?.message || String(err),
      });
    }
  }

  return report;
}

export function formatZoomNoCandidateReviewQueueBackfillReport(
  report: NoCandidateBackfillReport,
): string {
  const lines: string[] = [];
  lines.push(`Zoom No-Candidate Review-Queue Backfill (task #1001)`);
  lines.push("");
  lines.push(`Candidates scanned (unmatched Zoom records w/o review row): ${report.scanned}`);
  lines.push(`  recorded:                              ${report.recorded}`);
  lines.push(`  would record (dry-run):                ${report.wouldRecord}`);
  lines.push(`  skipped — already has no-candidate row:${report.skippedAlreadyHasNoCandidateRow}`);
  lines.push(`  skipped — already has review decision: ${report.skippedAlreadyHasReviewDecision}`);
  lines.push(`  errors:                                ${report.errors.length}`);
  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors.slice(0, 25)) {
      lines.push(`  - ${e.recordId}: ${e.message}`);
    }
  }
  return lines.join("\n");
}

export function formatZoomReviewQueueBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push(`Zoom Review-Queue Backfill (task #451)`);
  lines.push("");
  lines.push(`Candidates scanned (review_required Zoom records): ${report.scanned}`);
  lines.push(`  recorded:                       ${report.recorded}`);
  lines.push(`  would record (dry-run):         ${report.wouldRecord}`);
  lines.push(`  skipped — already has decision: ${report.skippedAlreadyHasDecision}`);
  lines.push(`  skipped — no prior clientId:    ${report.skippedNoPriorClient}`);
  lines.push(`  skipped — unparseable method:   ${report.skippedUnparseable}`);
  lines.push(`  errors:                         ${report.errors.length}`);
  lines.push("");
  lines.push(`Suggested-client recovery (when raw record had no clientId):`);
  lines.push(`  recovered from communication_client_links: ${report.recoveredFromLink}`);
  lines.push(`  recovered by re-running content matcher:   ${report.recoveredFromRerunContent}`);
  lines.push(`  recovered by re-running participants:      ${report.recoveredFromRerunParticipants}`);
  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors.slice(0, 25)) {
      lines.push(`  - ${e.recordId}: ${e.message}`);
    }
  }
  return lines.join("\n");
}

// ─── Task #4050: unmatched Zoom re-match backfill ────────────────────────────

export const UNMATCHED_REMATCH_WORKER_NAME = "zoom_unmatched_rematch_backfill";

export interface ZoomUnmatchedRematchReport {
  dryRun: boolean;
  windowDays: number;
  scanned: number;
  autoMatched: number;
  reviewSuggested: number;
  noCandidate: number;
  noCandidateRowsCreated: number;
  unchangedSentinels: number;
  supersededDecisions: number;
  byTier: Record<string, number>;
  errors: Array<{ recordId: string; message: string }>;
}

/**
 * Task #4050: count how many unmatched Zoom records the re-match backfill
 * would re-evaluate (prod-action status estimate — cheap COUNT, no resolver).
 */
export async function countZoomUnmatchedRematchCandidates(
  windowDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [row] = await withDbAttribution("zoomRematch:count-candidates", () =>
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(rawCommunicationRecords)
      .where(unmatchedRematchCandidateWhere(cutoff)),
  );
  return row?.count ?? 0;
}

/**
 * Shared candidate predicate. Mirrors the no-candidate backfill's canonical
 * conventions: matchStatus='unmatched' only (NULL = still mid-initial-
 * processing — the live apply path, which now runs the same resolver, will
 * handle those; 'orphaned'/'dismissed_operational' are deliberate verdicts).
 * Operator dismissals (matchMethod 'dismissed…') are explicitly excluded so
 * a re-match never resurrects a call a human already threw out.
 */
function unmatchedRematchCandidateWhere(cutoff: Date) {
  return and(
    eq(rawCommunicationRecords.sourceType, "zoom"),
    isNull(rawCommunicationRecords.clientId),
    eq(rawCommunicationRecords.matchStatus, "unmatched"),
    sql`${rawCommunicationRecords.timestamp} >= ${cutoff}`,
    or(
      isNull(rawCommunicationRecords.matchMethod),
      sql`${rawCommunicationRecords.matchMethod} NOT LIKE 'dismissed%'`,
    ),
  );
}

/**
 * Task #4050: re-run deterministic client matching (booked/participant tier +
 * the trusted-domain and topic↔firm-name tiers) over recent unmatched Zoom
 * records so the backlog that accumulated before those tiers existed gets a
 * second chance.
 *
 * Dispositions per record:
 *  - auto      → stamp the raw record + client link, supersede any open
 *                review decision (status='superseded_auto_match' — every
 *                queue/bucket consumer filters status='review_required', so
 *                the item drops out), and enqueue the standard
 *                `analyze_communication` job (durable work queue, deduped on
 *                `analyze_<recordId>` — bulk-safe, unlike a setImmediate
 *                fan-out of OpenAI calls).
 *  - review    → refresh the `review_required:<reason>:<matchedOn>` sentinel
 *                (skipped when unchanged) and upsert the review decision with
 *                the suggested client + shortlist for one-click confirmation.
 *  - none      → ensure a no-candidate review row exists ONLY when the record
 *                has no open decision at all (never stack a second queue item
 *                on top of an existing suggestion).
 *
 * Convergent and idempotent: auto-matched rows leave the candidate set;
 * review rows re-resolve to the same sentinel (counted as unchanged); a
 * second run right after the first reports autoMatched=0. Safe to re-run
 * after editing client email domains or firm names — that is the point.
 */
export async function runZoomUnmatchedRematchBackfill(
  opts: { windowDays?: number; limit?: number; dryRun?: boolean } = {},
): Promise<ZoomUnmatchedRematchReport> {
  const windowDays = Math.max(1, Math.min(365, opts.windowDays ?? 90));
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 2000));
  const dryRun = opts.dryRun ?? true;
  return withManualReserveAutoMute(UNMATCHED_REMATCH_WORKER_NAME, dryRun, () =>
    runZoomUnmatchedRematchBackfillInternal(dryRun, windowDays, limit),
  );
}

async function runZoomUnmatchedRematchBackfillInternal(
  dryRun: boolean,
  windowDays: number,
  limit: number,
): Promise<ZoomUnmatchedRematchReport> {
  const { resolveZoomClientMatch, loadZoomMatchIndexes } = await import(
    "./zoomClientMatching"
  );
  const { matchClientByParticipants } = await import("./zoomIntegration");

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const candidates: RawCommunicationRecord[] = await withDbAttribution(
    "zoomRematch:candidate-scan",
    () =>
      getDb()
        .select()
        .from(rawCommunicationRecords)
        .where(unmatchedRematchCandidateWhere(cutoff))
        .orderBy(desc(rawCommunicationRecords.timestamp))
        .limit(limit),
  );

  // One index build for the whole run (the per-call loader would re-read all
  // clients + contacts for every record).
  const indexes = await loadZoomMatchIndexes();

  const report: ZoomUnmatchedRematchReport = {
    dryRun,
    windowDays,
    scanned: candidates.length,
    autoMatched: 0,
    reviewSuggested: 0,
    noCandidate: 0,
    noCandidateRowsCreated: 0,
    unchangedSentinels: 0,
    supersededDecisions: 0,
    byTier: {},
    errors: [],
  };

  for (const record of candidates) {
    try {
      const participants = Array.isArray(record.participantsJson)
        ? (record.participantsJson as Array<{ email?: string | null; name?: string | null }>)
        : [];
      const participantEmails = participants
        .map((p) => p?.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const participantNames = participants
        .map((p) => p?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);

      const resolution = await resolveZoomClientMatch(
        {
          participantEmails,
          participantNames,
          topic: record.title ?? null,
          source: "zoom",
        },
        { matchParticipants: matchClientByParticipants, indexes },
      );

      // Decisions may key communicationId by raw record id OR by
      // externalSourceId (legacy shape) — cover both.
      const decisionKeys = [
        record.id,
        ...(record.externalSourceId ? [record.externalSourceId] : []),
      ];

      if (resolution.kind === "auto") {
        report.autoMatched++;
        report.byTier[resolution.tier] = (report.byTier[resolution.tier] ?? 0) + 1;
        if (!dryRun) {
          await withDbAttribution("zoomRematch:apply-auto-match", () =>
            getDb().transaction(async (tx) => {
            await tx
              .update(rawCommunicationRecords)
              .set({
                clientId: resolution.clientId,
                matchMethod: resolution.matchedOn,
                matchStatus: "matched",
                processingStatus: "pending",
                operationalClassificationReason: null,
                updatedAt: new Date(),
              })
              .where(eq(rawCommunicationRecords.id, record.id));

            // Task #4083 (pattern from Task #4079): an auto-match stamp is
            // authoritative for the record — sweep EVERY other client's link.
            // No Zoom flow deliberately tags one record with multiple clients
            // (all writers upsert a single clientId), so any other-client
            // link here is stale residue from an earlier match and would
            // double-count the call in that client's comm history.
            await tx.delete(communicationClientLinks)
              .where(and(
                eq(communicationClientLinks.rawCommunicationRecordId, record.id),
                sql`${communicationClientLinks.clientId} <> ${resolution.clientId}`,
              ));

            await tx
              .insert(communicationClientLinks)
              .values({
                rawCommunicationRecordId: record.id,
                clientId: resolution.clientId,
                matchMethod: resolution.matchedOn,
                matchConfidence: 1.0,
                isPrimary: true,
                status: "detected",
              })
              .onConflictDoUpdate({
                target: [
                  communicationClientLinks.rawCommunicationRecordId,
                  communicationClientLinks.clientId,
                ],
                set: {
                  matchMethod: resolution.matchedOn,
                  matchConfidence: 1.0,
                  isPrimary: true,
                },
              });

            const superseded = await tx
              .update(agentMatchDecisions)
              .set({ status: "superseded_auto_match" })
              .where(
                and(
                  inArray(agentMatchDecisions.communicationId, decisionKeys),
                  eq(agentMatchDecisions.status, "review_required"),
                  isNull(agentMatchDecisions.reviewResolution),
                ),
              )
              .returning({ id: agentMatchDecisions.id });
            report.supersededDecisions += superseded.length;
            }),
          );

          // Standard durable analysis enqueue (same queue/dedupe as the live
          // Zoom apply paths) so the churn AI studies the call.
          try {
            const { enqueueJob } = await import("./workScheduler");
            await enqueueJob({
              queueName: "analyze_communication",
              workloadClass: "ingestion",
              priority: 200,
              payload: { recordId: record.id },
              dedupeKey: `analyze_${record.id}`,
            });
          } catch (err) {
            console.error(
              `[ZoomRematch] Failed to enqueue analysis for ${record.id}:`,
              err,
            );
          }
        }
        continue;
      }

      if (resolution.kind === "review") {
        report.reviewSuggested++;
        const sentinel = `review_required:${resolution.reviewReason}:${resolution.matchedOn}`;
        if (record.matchMethod === sentinel) {
          report.unchangedSentinels++;
        } else if (!dryRun) {
          await withDbAttribution("zoomRematch:sentinel-update", () =>
            getDb()
              .update(rawCommunicationRecords)
              .set({ matchMethod: sentinel, updatedAt: new Date() })
              .where(eq(rawCommunicationRecords.id, record.id)),
          );
        }
        if (!dryRun) {
          await recordZoomReviewDecision({
            communicationId: record.id,
            communicationType: "zoom",
            suggestedClientId: resolution.suggestedClientId,
            confidenceScore: resolution.suggestedClientId ? 0.5 : 0,
            explanationSummary: `${BACKFILL_EXPLANATION_PREFIX} re-match demoted this record to review (${resolution.matchedOn})`,
            reviewReason: resolution.reviewReason,
            candidateShortlist: resolution.candidates.map((c) => ({
              clientId: c.clientId,
              confidenceScore: 0.5,
              matchedOn: c.matchedOn,
            })),
            priorClientId: null,
          });
        }
        continue;
      }

      // kind === "none": ensure the record surfaces in review at all — but
      // never stack a second decision on top of an existing open one.
      report.noCandidate++;
      if (!dryRun) {
        const existingOpen = await withDbAttribution(
          "zoomRematch:open-decision-check",
          () =>
            getDb()
              .select({ id: agentMatchDecisions.id })
              .from(agentMatchDecisions)
              .where(
                and(
                  inArray(agentMatchDecisions.communicationId, decisionKeys),
                  eq(agentMatchDecisions.status, "review_required"),
                  isNull(agentMatchDecisions.reviewResolution),
                ),
              )
              .limit(1),
        );
        if (existingOpen.length === 0) {
          await recordZoomReviewDecision({
            communicationId: record.id,
            communicationType: "zoom",
            suggestedClientId: null,
            confidenceScore: 0,
            explanationSummary: `${BACKFILL_EXPLANATION_PREFIX} re-match found no deterministic candidate`,
            reviewReason: NO_CANDIDATE_REVIEW_REASON,
            candidateShortlist: [],
            priorClientId: null,
          });
          report.noCandidateRowsCreated++;
        }
      }
    } catch (err: any) {
      report.errors.push({
        recordId: record.id,
        message: err?.message || String(err),
      });
    }
  }

  return report;
}

export function formatZoomUnmatchedRematchReport(
  report: ZoomUnmatchedRematchReport,
): string {
  const lines: string[] = [];
  lines.push(
    `Zoom unmatched re-match${report.dryRun ? " (dry-run)" : ""} — last ${report.windowDays} days`,
  );
  lines.push(`Scanned: ${report.scanned}`);
  lines.push(
    `  auto-matched:        ${report.autoMatched}${
      Object.keys(report.byTier).length > 0
        ? ` (${Object.entries(report.byTier)
            .map(([tier, n]) => `${tier}: ${n}`)
            .join(", ")})`
        : ""
    }`,
  );
  lines.push(`  review w/ suggestion:${report.reviewSuggested} (${report.unchangedSentinels} unchanged)`);
  lines.push(`  no candidate:        ${report.noCandidate} (${report.noCandidateRowsCreated} new review rows)`);
  lines.push(`  superseded decisions:${report.supersededDecisions}`);
  lines.push(`  still unmatched:     ${report.scanned - report.autoMatched}`);
  lines.push(`  errors:              ${report.errors.length}`);
  if (report.errors.length > 0) {
    for (const e of report.errors.slice(0, 10)) {
      lines.push(`  - ${e.recordId}: ${e.message}`);
    }
  }
  return lines.join("\n");
}
