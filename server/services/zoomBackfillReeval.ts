import { randomUUID } from "crypto";
import { storage } from "../storage";
import { db } from "../db";
import { bindArrayParam } from "../utils/sqlArray";
import { sql, and, eq, gte, isNotNull } from "drizzle-orm";
import {
  rawCommunicationRecords,
  agentMatchDecisions,
  communicationClientLinks,
  type RawCommunicationRecord,
} from "@shared/schema";

const REEVAL_WORKER_NAME = "zoom_backfill_reeval";

const DEFAULT_WINDOW_DAYS = 90;
const BACKFILL_REASON = "backfill_412g";
const JAKE_NAME_PATTERN = /\bjake\s+davis\b/i;
const JAKE_TARGET_DATE = "2026-04-15";
export const JAKE_RAHLITA_RECORD_ID = "f8e77741-4172-4596-a4aa-54612af90a9c";

export type BackfillOutcome = "still_auto_claim" | "move_to_review" | "become_unmatched";

export interface BackfillItem {
  recordId: string;
  externalSourceId: string | null;
  title: string;
  timestamp: string;
  currentClientId: string | null;
  currentClientName: string | null;
  currentMatchMethod: string | null;
  outcome: BackfillOutcome;
  newTopClientId: string | null;
  newTopClientName: string | null;
  newTopScore: number | null;
  newTopStatus: string | null;
  newTopExplanation: string | null;
  shortlist: Array<{
    clientId: string;
    clientName: string | null;
    confidenceScore: number;
    status: string;
    explanationSummary: string;
    evidenceType: string;
  }>;
  reviewReason: string | null;
  isJakeApr15: boolean;
  alreadyBackfilled: boolean;
}

export interface BackfillReport {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  targetRecordIds: string[] | null;
  totals: {
    matchedZoomInWindow: number;
    eligibleAutoClaims: number;
    excludedNonAutoClaim: number;
    candidatesScanned: number;
    stillAutoClaim: number;
    moveToReview: number;
    becomeUnmatched: number;
    skippedAlreadyBackfilled: number;
    errors: number;
  };
  excludedSamples: Array<{ recordId: string; reason: string; matchMethod: string | null }>;
  jakeApr15: BackfillItem | null;
  changedItems: BackfillItem[];
  errors: Array<{ recordId: string; message: string }>;
}

export interface BackfillApplyResult {
  report: BackfillReport;
  applied: {
    decisionsCreated: number;
    decisionsUpdated: number;
    rawRecordsUpdated: number;
    linksRemoved: number;
    skippedNoChange: number;
  };
}

interface RunOpts {
  windowDays?: number;
  recordLimit?: number;
  /**
   * If set, restrict the scan to a specific raw_communication_records.id
   * (or a list of ids) regardless of the time window. Used for targeted
   * verification / repair of a known-bad record (e.g. Jake → Rahlita).
   * Records still must be source=zoom, but the auto-claim and human-finalized
   * filters are bypassed so a known-bad record can always be re-evaluated.
   */
  targetRecordId?: string | string[];
}

export interface BackfillRecordVerification {
  recordId: string;
  exists: boolean;
  clientId: string | null;
  matchStatus: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  activeClientLinks: Array<{ clientId: string; status: string }>;
  rejectedClientLinks: Array<{ clientId: string; status: string }>;
  backfillDecisionRows: Array<{
    id: string;
    status: string;
    clientId: string | null;
    priorClientId: string | null;
    explanationSummary: string | null;
  }>;
  isClean: boolean;
  cleanReasons: string[];
}

export async function runZoomBackfillDryRun(opts: RunOpts = {}): Promise<BackfillReport> {
  const scan = await scanCandidates(opts);
  return buildReport(scan, scan.errors);
}

function buildReport(
  scan: Awaited<ReturnType<typeof scanCandidates>>,
  errors: Array<{ recordId: string; message: string }>,
): BackfillReport {
  const summary = summarize(scan.items, errors.length);
  const jake = scan.items.find((i) => i.isJakeApr15) ?? null;
  const changedItems = scan.items.filter((i) => i.outcome !== "still_auto_claim");

  return {
    windowDays: scan.windowDays,
    windowStart: scan.windowStart.toISOString(),
    windowEnd: scan.windowEnd.toISOString(),
    targetRecordIds: scan.targetRecordIds,
    totals: {
      matchedZoomInWindow: scan.matchedZoomInWindow,
      eligibleAutoClaims: scan.items.length,
      excludedNonAutoClaim: scan.excludedNonAutoClaim,
      candidatesScanned: scan.items.length,
      ...summary,
    },
    excludedSamples: scan.excludedSamples,
    jakeApr15: jake,
    changedItems,
    errors,
  };
}

export async function runZoomBackfillApply(opts: RunOpts = {}): Promise<BackfillApplyResult> {
  // Task #1199: auto-mute manual-reserve alerts for the duration of this
  // saturating apply run, mirroring the SEMrush backfill wiring (Task #726).
  // Manual operator mutes take precedence and are not overwritten; the 4h
  // window is hard-capped to MAX_MUTE_DURATION_MS=7d in the helper so a
  // crashed worker still naturally expires the mute.
  const muteJobId = randomUUID();
  try {
    const { setManualReserveMuteForBackfillJob } = await import(
      "./manualReserveAlerts"
    );
    const outcome = await setManualReserveMuteForBackfillJob({
      jobId: muteJobId,
      jobLabel: REEVAL_WORKER_NAME,
      durationMs: 4 * 60 * 60_000,
      reason: `Auto-muted for ${REEVAL_WORKER_NAME} backfill (job ${muteJobId})`,
    });
    if (!outcome.applied) {
      console.log(
        `[${REEVAL_WORKER_NAME}] Backfill: skipped auto-mute (operator manual mute is active)`,
      );
    }
  } catch (e: any) {
    console.warn(
      `[${REEVAL_WORKER_NAME}] Backfill: failed to auto-mute manual-reserve alerts (non-fatal): ${e?.message || e}`,
    );
  }
  try {
    return await runZoomBackfillApplyInternal(opts);
  } finally {
    try {
      const { clearManualReserveMuteForBackfillJob } = await import(
        "./manualReserveAlerts"
      );
      await clearManualReserveMuteForBackfillJob(muteJobId);
    } catch (e: any) {
      console.warn(
        `[${REEVAL_WORKER_NAME}] Backfill: failed to release auto-mute (non-fatal, will expire on its own): ${e?.message || e}`,
      );
    }
  }
}

async function runZoomBackfillApplyInternal(opts: RunOpts): Promise<BackfillApplyResult> {
  const scan = await scanCandidates(opts);
  const { items, errors } = scan;

  let decisionsCreated = 0;
  let decisionsUpdated = 0;
  let rawRecordsUpdated = 0;
  let linksRemoved = 0;
  let skippedNoChange = 0;

  for (const item of items) {
    if (item.outcome === "still_auto_claim") {
      skippedNoChange++;
      continue;
    }
    if (item.alreadyBackfilled) {
      skippedNoChange++;
      continue;
    }

    try {
      const result = await applyOne(item);
      decisionsCreated += result.decisionsCreated;
      decisionsUpdated += result.decisionsUpdated;
      rawRecordsUpdated += result.rawRecordUpdated ? 1 : 0;
      linksRemoved += result.linksRemoved;
    } catch (err: any) {
      errors.push({
        recordId: item.recordId,
        message: `apply failed: ${err?.message || String(err)}`,
      });
    }
  }

  return {
    report: buildReport(scan, errors),
    applied: {
      decisionsCreated,
      decisionsUpdated,
      rawRecordsUpdated,
      linksRemoved,
      skippedNoChange,
    },
  };
}

function summarize(items: BackfillItem[], errorCount: number) {
  let stillAutoClaim = 0;
  let moveToReview = 0;
  let becomeUnmatched = 0;
  let skippedAlreadyBackfilled = 0;
  for (const i of items) {
    if (i.alreadyBackfilled) skippedAlreadyBackfilled++;
    if (i.outcome === "still_auto_claim") stillAutoClaim++;
    else if (i.outcome === "move_to_review") moveToReview++;
    else if (i.outcome === "become_unmatched") becomeUnmatched++;
  }
  return {
    stillAutoClaim,
    moveToReview,
    becomeUnmatched,
    skippedAlreadyBackfilled,
    errors: errorCount,
  };
}

// 412G is explicitly scoped to *prior auto-claims*. Manual confirmations,
// human-resolved review-queue picks, and other non-auto attributions must
// not be re-evaluated by this pass.
//
// Auto-claim matchMethods we accept (prefixes / exact values produced by the
// Zoom ingestion + agent paths):
//   - "agent:..." / "agent_match" / "agent_retroactive"
//   - "content:..." / "content_match"
//   - "contact_email:..." / "contact_name:..." / "owner:..."
//
// Excluded matchMethods (non-auto or out-of-scope finalizations):
//   - "manual_review"   (human resolved a review-queue item)
//   - "manual"          (admin-created link)
//   - "released"        (memory reset workflow)
//   - "operational_filter" (matchStatus already dismissed_operational anyway)
//   - null / empty      (no recorded auto-attribution path)
const AUTO_CLAIM_METHOD_PREFIXES = [
  "agent:",
  "agent_match",
  "agent_retroactive",
  "content:",
  "content_match",
  "contact_email:",
  "contact_name:",
  "owner:",
];

function isAutoClaimMatchMethod(m: string | null): boolean {
  if (!m) return false;
  const lower = m.toLowerCase();
  if (lower === "manual_review" || lower.startsWith("manual_review:") || lower === "manual" || lower === "released" || lower === "operational_filter") {
    return false;
  }
  // Records previously touched by this same backfill pass are not re-eligible.
  if (lower.startsWith("backfill_412g")) return false;
  // Records previously demoted to review_required by guards are not auto-claims.
  if (lower.startsWith("review_required:")) return false;
  return AUTO_CLAIM_METHOD_PREFIXES.some((p) => lower.startsWith(p));
}

function buildCommIdVariants(record: { id: string; externalSourceId: string | null }): string[] {
  // Different ingestion/reprocess paths have used different `communicationId`
  // shapes when writing to `agent_match_decisions`. Cover the common ones so
  // human-finalized exclusion and idempotency checks don't miss legacy rows.
  const variants = new Set<string>();
  variants.add(`zoom_record_${record.id}`);
  if (record.externalSourceId) {
    const meetingUuid = record.externalSourceId.replace(/^zoom_meeting_/, "");
    variants.add(`zoom_${meetingUuid}`);
    variants.add(record.externalSourceId);
    variants.add(`zoom_meeting_${meetingUuid}`);
    variants.add(`zoom_reprocess_${record.id}`);
    variants.add(`zoom_reprocess_matched_${record.id}`);
  }
  return [...variants];
}

async function isHumanFinalized(commIds: string[]): Promise<boolean> {
  if (commIds.length === 0) return false;
  const rows = await db
    .select({
      reviewedByHuman: agentMatchDecisions.reviewedByHuman,
      correctedByHuman: agentMatchDecisions.correctedByHuman,
    })
    .from(agentMatchDecisions)
    .where(sql`${agentMatchDecisions.communicationId} = ANY(${bindArrayParam(commIds, "text")})`);
  return rows.some((r) => r.reviewedByHuman === true || r.correctedByHuman === true);
}

async function scanCandidates(opts: RunOpts): Promise<{
  items: BackfillItem[];
  errors: Array<{ recordId: string; message: string }>;
  excludedSamples: Array<{ recordId: string; reason: string; matchMethod: string | null }>;
  matchedZoomInWindow: number;
  excludedNonAutoClaim: number;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
  targetRecordIds: string[] | null;
}> {
  const windowDays = Math.max(1, opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const targetIds = opts.targetRecordId
    ? (Array.isArray(opts.targetRecordId) ? opts.targetRecordId : [opts.targetRecordId])
    : null;

  const allMatched = targetIds
    ? await db
        .select()
        .from(rawCommunicationRecords)
        .where(
          and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            sql`${rawCommunicationRecords.id} = ANY(${bindArrayParam(targetIds, "text")})`,
          ),
        )
        .orderBy(rawCommunicationRecords.timestamp)
    : await db
        .select()
        .from(rawCommunicationRecords)
        .where(
          and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            eq(rawCommunicationRecords.matchStatus, "matched"),
            isNotNull(rawCommunicationRecords.clientId),
            gte(rawCommunicationRecords.timestamp, windowStart),
          ),
        )
        .orderBy(rawCommunicationRecords.timestamp);

  const matchedZoomInWindow = allMatched.length;
  const eligible: typeof allMatched = [];
  const excludedSamples: Array<{ recordId: string; reason: string; matchMethod: string | null }> = [];
  let excludedNonAutoClaim = 0;

  for (const r of allMatched) {
    if (targetIds) {
      // Targeted mode: bypass the auto-claim/human-finalized filters so a
      // known-bad record can always be re-evaluated and repaired.
      eligible.push(r);
      continue;
    }
    if (!isAutoClaimMatchMethod(r.matchMethod)) {
      excludedNonAutoClaim++;
      if (excludedSamples.length < 25) {
        excludedSamples.push({
          recordId: r.id,
          reason: r.matchMethod
            ? `non_auto_match_method:${r.matchMethod.toLowerCase().split(":")[0]}`
            : "no_match_method",
          matchMethod: r.matchMethod,
        });
      }
      continue;
    }
    if (await isHumanFinalized(buildCommIdVariants(r))) {
      excludedNonAutoClaim++;
      if (excludedSamples.length < 25) {
        excludedSamples.push({
          recordId: r.id,
          reason: "human_finalized_decision",
          matchMethod: r.matchMethod,
        });
      }
      continue;
    }
    eligible.push(r);
  }

  const limited = opts.recordLimit ? eligible.slice(0, opts.recordLimit) : eligible;

  const allClients = await storage.getClients();
  const clientNameById = new Map(allClients.map((c) => [c.id, c.firmName]));

  const items: BackfillItem[] = [];
  const errors: Array<{ recordId: string; message: string }> = [];

  for (const record of limited) {
    try {
      const item = await classifyRecord(record, clientNameById);
      items.push(item);
    } catch (err: any) {
      errors.push({
        recordId: record.id,
        message: err?.message || String(err),
      });
    }
  }

  return {
    items,
    errors,
    excludedSamples,
    matchedZoomInWindow,
    excludedNonAutoClaim,
    windowStart,
    windowEnd,
    windowDays,
    targetRecordIds: targetIds,
  };
}

async function classifyRecord(
  record: RawCommunicationRecord,
  clientNameById: Map<string, string>,
): Promise<BackfillItem> {
  const participants = Array.isArray(record.participantsJson)
    ? (record.participantsJson as Array<{ email?: string; name?: string; role?: string }>)
    : [];

  // Task #2637: re-match deterministically via the participant matcher and
  // apply the Zoom auto-claim policy (strong signal + non-all-internal
  // participants). The agent evaluator is gone; no fuzzy/AI re-evaluation.
  const participantEmails = participants.map((p) => p.email).filter(Boolean) as string[];
  const participantNames = participants.map((p) => p.name).filter(Boolean) as string[];

  const { matchClientByParticipants } = await import("./zoomIntegration");
  const { hasOnlyInternalParticipants } = await import("./matchPolicy");
  const match = await matchClientByParticipants(participantEmails, participantNames, {
    source: "zoom",
  });

  const allInternal = hasOnlyInternalParticipants(participantEmails);
  const isStrongSignal = (matchedOn: string) => {
    const mo = matchedOn.toLowerCase();
    return !mo.startsWith("contact_name:") && !mo.startsWith("owner:");
  };
  const autoClaims = !!match && !allInternal && isStrongSignal(match.matchedOn);

  const newTopClientId = match?.clientId ?? null;
  const newTopStatus = match ? (autoClaims ? "claimed" : "review_required") : null;
  const newTopExplanation = match
    ? `Deterministic participant match: ${match.matchedOn}`
    : null;

  let outcome: BackfillOutcome;
  let reviewReason: string | null = null;

  if (match && autoClaims && match.clientId === record.clientId) {
    outcome = "still_auto_claim";
  } else if (match && autoClaims && match.clientId !== record.clientId) {
    // New rules pick a *different* client confidently. We move the prior
    // attribution to review so a human can confirm the swap rather than
    // silently flipping the client on the raw record.
    outcome = "move_to_review";
    reviewReason = "backfill_reattribution_candidate";
  } else if (match) {
    // A deterministic candidate exists but doesn't clear the auto-claim
    // policy (weak signal or all-internal participants) → route to review.
    outcome = "move_to_review";
    reviewReason = allInternal ? "backfill_solo_internal" : "backfill_weak_signal";
  } else {
    outcome = "become_unmatched";
    reviewReason = "backfill_no_qualifying_match";
  }

  const shortlist = match
    ? [
        {
          clientId: match.clientId,
          clientName: clientNameById.get(match.clientId) ?? null,
          confidenceScore: 0.5,
          status: newTopStatus ?? "review_required",
          explanationSummary: newTopExplanation ?? "",
          evidenceType: "structured",
        },
      ]
    : [];

  const idVariants = buildCommIdVariants(record);
  const existingBackfill = await db
    .select({ id: agentMatchDecisions.id })
    .from(agentMatchDecisions)
    .where(
      and(
        sql`${agentMatchDecisions.communicationId} = ANY(${bindArrayParam(idVariants, "text")})`,
        eq(agentMatchDecisions.reviewReason, BACKFILL_REASON),
      ),
    )
    .limit(1);
  const alreadyBackfilled = existingBackfill.length > 0;

  const isJakeApr15 = isJakeAprilFifteenth(record, participants);

  return {
    recordId: record.id,
    externalSourceId: record.externalSourceId,
    title: record.title,
    timestamp: record.timestamp.toISOString(),
    currentClientId: record.clientId,
    currentClientName: record.clientId ? clientNameById.get(record.clientId) ?? null : null,
    currentMatchMethod: record.matchMethod,
    outcome,
    newTopClientId,
    newTopClientName: newTopClientId ? clientNameById.get(newTopClientId) ?? null : null,
    newTopScore: match ? 0.5 : null,
    newTopStatus,
    newTopExplanation,
    shortlist,
    reviewReason,
    isJakeApr15,
    alreadyBackfilled,
  };
}

function isJakeAprilFifteenth(
  record: RawCommunicationRecord,
  participants: Array<{ email?: string; name?: string }>,
): boolean {
  // Timezone-tolerant: accept the day before/after the UTC target date so
  // calls stored at the UTC boundary still get the explicit callout.
  const target = new Date(`${JAKE_TARGET_DATE}T00:00:00Z`).getTime();
  const ts = record.timestamp.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (Math.abs(ts - target) > 2 * dayMs) return false;
  const haystack = [
    record.title || "",
    ...participants.map((p) => p.name || ""),
    ...participants.map((p) => p.email || ""),
  ].join(" ");
  return JAKE_NAME_PATTERN.test(haystack);
}

async function applyOne(item: BackfillItem): Promise<{
  decisionsCreated: number;
  decisionsUpdated: number;
  rawRecordUpdated: boolean;
  linksRemoved: number;
}> {
  const meetingUuid = (item.externalSourceId || "").replace(/^zoom_meeting_/, "");
  const commId = meetingUuid ? `zoom_${meetingUuid}` : `zoom_record_${item.recordId}`;
  const idVariants = buildCommIdVariants({
    id: item.recordId,
    externalSourceId: item.externalSourceId,
  });

  let decisionsCreated = 0;
  let decisionsUpdated = 0;
  let linksRemoved = 0;
  let rawRecordUpdated = false;

  await db.transaction(async (tx) => {
    const dupe = await tx
      .select({ id: agentMatchDecisions.id })
      .from(agentMatchDecisions)
      .where(
        and(
          sql`${agentMatchDecisions.communicationId} = ANY(${bindArrayParam(idVariants, "text")})`,
          eq(agentMatchDecisions.reviewReason, BACKFILL_REASON),
        ),
      )
      .limit(1);
    if (dupe.length > 0) {
      return;
    }

    const priorClientId = item.currentClientId;

    // Demote any prior "claimed" decisions for this comm so the historical
    // record reflects that the auto-claim no longer holds. We do not delete
    // them — we annotate them. Cover all known communicationId variants
    // (different Zoom paths historically wrote different shapes).
    const priorDecisions = await tx
      .select()
      .from(agentMatchDecisions)
      .where(
        and(
          sql`${agentMatchDecisions.communicationId} = ANY(${bindArrayParam(idVariants, "text")})`,
          eq(agentMatchDecisions.status, "claimed"),
        ),
      );
    for (const pd of priorDecisions) {
      await tx
        .update(agentMatchDecisions)
        .set({
          status: "not_claimed",
          reviewReason: BACKFILL_REASON,
          explanationSummary: `[backfill-412g:demoted] Prior auto-claim demoted by re-evaluation. Was: ${pd.explanationSummary || ""}`.slice(
            0,
            4000,
          ),
        })
        .where(eq(agentMatchDecisions.id, pd.id));
      decisionsUpdated++;
    }

    // Write a new backfill decision row that carries the historical reference
    // and the new top-evaluation context.
    const newStatus =
      item.outcome === "move_to_review" ? "review_required" : "not_claimed";
    const targetClientId = item.newTopClientId || priorClientId;
    if (targetClientId) {
      const shortlistJson = item.shortlist.map((s) => ({
        clientId: s.clientId,
        clientName: s.clientName,
        confidenceScore: s.confidenceScore,
        status: s.status,
        explanationSummary: s.explanationSummary,
        evidenceType: s.evidenceType,
      }));
      await tx.insert(agentMatchDecisions).values({
        communicationId: commId,
        communicationType: "zoom",
        sourceType: "zoom",
        clientId: targetClientId,
        confidenceScore: item.newTopScore ?? 0,
        status: newStatus,
        explanationSummary: `[backfill-412g:${item.outcome}] ${item.newTopExplanation || "no qualifying match under new Zoom policy"}`.slice(
          0,
          4000,
        ),
        supportingSignalsJson: null,
        semanticReasoningSummary: null,
        evidenceType: "structured",
        candidateShortlistJson: shortlistJson.length > 0 ? shortlistJson : null,
        priorClientId,
        reviewReason: BACKFILL_REASON,
        reviewedByHuman: false,
        correctedByHuman: false,
      });
      decisionsCreated++;
    }

    // Remove (or rather, soft-rejected) any active client links that pointed
    // to the prior client so the live attribution is consistent with the new
    // decision. We leave rejected links in place as historical evidence.
    if (priorClientId) {
      const linkUpd = await tx
        .update(communicationClientLinks)
        .set({ status: "rejected" })
        .where(
          and(
            eq(communicationClientLinks.rawCommunicationRecordId, item.recordId),
            eq(communicationClientLinks.clientId, priorClientId),
          ),
        )
        .returning({ id: communicationClientLinks.id });
      linksRemoved += linkUpd.length;
    }

    // Update the raw record itself.
    const newMatchMethod = `backfill_412g:${item.outcome}:${item.currentMatchMethod || "unknown"}`.slice(
      0,
      255,
    );
    await tx
      .update(rawCommunicationRecords)
      .set({
        clientId: null,
        matchStatus: "unmatched",
        matchMethod: newMatchMethod,
        matchConfidence: null,
        processingStatus: "pending",
      })
      .where(eq(rawCommunicationRecords.id, item.recordId));
    rawRecordUpdated = true;
  });

  return { decisionsCreated, decisionsUpdated, rawRecordUpdated, linksRemoved };
}

export function formatBackfillReportText(report: BackfillReport): string {
  const t = report.totals;
  const lines: string[] = [];
  const isTargeted = !!report.targetRecordIds && report.targetRecordIds.length > 0;
  if (isTargeted) {
    lines.push(`Zoom Auto-Claim Backfill (412G) — TARGETED scan (${report.targetRecordIds!.length} record id(s))`);
    lines.push(`Targeted record ids: ${report.targetRecordIds!.join(", ")}`);
    lines.push(`(window/auto-claim/human-finalized filters are bypassed in targeted mode)`);
  } else {
    lines.push(`Zoom Auto-Claim Backfill (412G) — window: ${report.windowDays}d`);
    lines.push(`Window: ${report.windowStart} → ${report.windowEnd}`);
  }
  lines.push("");
  if (isTargeted) {
    lines.push(`Targeted Zoom records found:                 ${t.matchedZoomInWindow}`);
    lines.push(`  scanned (filters bypassed):                ${t.eligibleAutoClaims}`);
  } else {
    lines.push(`Matched Zoom records in window: ${t.matchedZoomInWindow}`);
    lines.push(`  excluded (non-auto-claim / human-finalized): ${t.excludedNonAutoClaim}`);
    lines.push(`  eligible auto-claims scanned:                ${t.eligibleAutoClaims}`);
  }
  lines.push("");
  lines.push(`Outcomes (eligible auto-claims):`);
  lines.push(`  still auto-claim: ${t.stillAutoClaim}`);
  lines.push(`  move to review:   ${t.moveToReview}`);
  lines.push(`  become unmatched: ${t.becomeUnmatched}`);
  lines.push(`  already backfilled (skip): ${t.skippedAlreadyBackfilled}`);
  lines.push(`  errors: ${t.errors}`);
  if (report.excludedSamples.length > 0) {
    lines.push("");
    lines.push(`Excluded sample (first ${report.excludedSamples.length}):`);
    for (const e of report.excludedSamples) {
      lines.push(`  - ${e.recordId}: ${e.reason} (matchMethod=${e.matchMethod || "null"})`);
    }
  }
  lines.push("");
  if (report.jakeApr15) {
    const j = report.jakeApr15;
    lines.push(`★ Jake Davis April 15 call (${j.timestamp}):`);
    lines.push(
      `  current: ${j.currentClientName || j.currentClientId || "(none)"} via ${j.currentMatchMethod || "?"}`,
    );
    lines.push(
      `  outcome: ${j.outcome}; new top: ${j.newTopClientName || j.newTopClientId || "(none)"} status=${j.newTopStatus} score=${j.newTopScore?.toFixed(2) || "n/a"}`,
    );
    if (j.shortlist.length > 0) {
      lines.push(`  shortlist:`);
      for (const s of j.shortlist) {
        lines.push(
          `    - ${s.clientName || s.clientId} (${s.status}, ${s.confidenceScore.toFixed(2)})`,
        );
      }
    }
  } else {
    lines.push(`★ Jake Davis April 15 call: not found in window.`);
  }
  if (report.changedItems.length > 0) {
    lines.push("");
    lines.push(`Changed items (${report.changedItems.length}):`);
    for (const c of report.changedItems.slice(0, 50)) {
      lines.push(
        `  [${c.outcome}] ${c.timestamp} "${c.title}" — was ${c.currentClientName || c.currentClientId} → ${c.newTopClientName || c.newTopClientId || "(none)"} (${c.reviewReason})`,
      );
    }
    if (report.changedItems.length > 50) {
      lines.push(`  ...and ${report.changedItems.length - 50} more`);
    }
  }
  return lines.join("\n");
}

/**
 * Verify the post-backfill state of a single Zoom raw_communication_records row.
 * Used to confirm a known-bad record (e.g. Jake → Rahlita,
 * `f8e77741-4172-4596-a4aa-54612af90a9c`) has been demoted out of its prior
 * mis-attribution: the raw row no longer carries the old clientId, no
 * communication_client_links row is still active for the prior client, and
 * a `backfill_412g` decision row exists carrying the prior candidate.
 */
export async function verifyZoomBackfillRecord(
  recordId: string,
): Promise<BackfillRecordVerification> {
  const rows = await db
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, recordId))
    .limit(1);

  if (rows.length === 0) {
    return {
      recordId,
      exists: false,
      clientId: null,
      matchStatus: null,
      matchMethod: null,
      matchConfidence: null,
      activeClientLinks: [],
      rejectedClientLinks: [],
      backfillDecisionRows: [],
      isClean: false,
      cleanReasons: ["record_not_found"],
    };
  }

  const r = rows[0];

  const links = await db
    .select({
      id: communicationClientLinks.id,
      clientId: communicationClientLinks.clientId,
      status: communicationClientLinks.status,
    })
    .from(communicationClientLinks)
    .where(eq(communicationClientLinks.rawCommunicationRecordId, recordId));

  const activeClientLinks = links
    .filter((l) => l.status !== "rejected")
    .map((l) => ({ clientId: l.clientId, status: l.status }));
  const rejectedClientLinks = links
    .filter((l) => l.status === "rejected")
    .map((l) => ({ clientId: l.clientId, status: l.status }));

  const idVariants = buildCommIdVariants({
    id: r.id,
    externalSourceId: r.externalSourceId,
  });
  const decisionRows = await db
    .select({
      id: agentMatchDecisions.id,
      status: agentMatchDecisions.status,
      clientId: agentMatchDecisions.clientId,
      priorClientId: agentMatchDecisions.priorClientId,
      explanationSummary: agentMatchDecisions.explanationSummary,
      reviewReason: agentMatchDecisions.reviewReason,
    })
    .from(agentMatchDecisions)
    .where(
      and(
        sql`${agentMatchDecisions.communicationId} = ANY(${bindArrayParam(idVariants, "text")})`,
        eq(agentMatchDecisions.reviewReason, BACKFILL_REASON),
      ),
    );

  const reasons: string[] = [];
  const matchMethodLower = (r.matchMethod || "").toLowerCase();
  const isUnmatched = r.matchStatus === "unmatched" && r.clientId === null;
  const carriesBackfillStamp = matchMethodLower.startsWith("backfill_412g");
  const hasBackfillDecision = decisionRows.length > 0;
  const noActiveLinks = activeClientLinks.length === 0;

  if (!isUnmatched) reasons.push(`raw_record_still_matched(clientId=${r.clientId},matchStatus=${r.matchStatus})`);
  if (!carriesBackfillStamp) reasons.push(`match_method_missing_backfill_stamp(matchMethod=${r.matchMethod ?? "null"})`);
  if (!hasBackfillDecision) reasons.push("no_backfill_412g_decision_row");
  if (!noActiveLinks) reasons.push(`active_client_links_remain(${activeClientLinks.map(l => l.clientId).join(",")})`);

  const isClean = isUnmatched && carriesBackfillStamp && hasBackfillDecision && noActiveLinks;
  if (isClean) reasons.push("clean");

  return {
    recordId,
    exists: true,
    clientId: r.clientId,
    matchStatus: r.matchStatus,
    matchMethod: r.matchMethod,
    matchConfidence: r.matchConfidence,
    activeClientLinks,
    rejectedClientLinks,
    backfillDecisionRows: decisionRows.map((d) => ({
      id: d.id,
      status: d.status,
      clientId: d.clientId,
      priorClientId: d.priorClientId,
      explanationSummary: d.explanationSummary,
    })),
    isClean,
    cleanReasons: reasons,
  };
}

export function formatVerificationText(v: BackfillRecordVerification): string {
  const lines: string[] = [];
  lines.push(`Zoom backfill verification — record ${v.recordId}`);
  if (!v.exists) {
    lines.push(`  exists: NO (record not found)`);
    return lines.join("\n");
  }
  lines.push(`  clientId:        ${v.clientId ?? "(null)"}`);
  lines.push(`  matchStatus:     ${v.matchStatus ?? "(null)"}`);
  lines.push(`  matchMethod:     ${v.matchMethod ?? "(null)"}`);
  lines.push(`  matchConfidence: ${v.matchConfidence ?? "(null)"}`);
  lines.push(`  active client links:   ${v.activeClientLinks.length === 0 ? "(none)" : v.activeClientLinks.map(l => `${l.clientId}[${l.status}]`).join(", ")}`);
  lines.push(`  rejected client links: ${v.rejectedClientLinks.length === 0 ? "(none)" : v.rejectedClientLinks.map(l => l.clientId).join(", ")}`);
  lines.push(`  backfill_412g decision rows: ${v.backfillDecisionRows.length}`);
  for (const d of v.backfillDecisionRows) {
    lines.push(`    - status=${d.status} clientId=${d.clientId ?? "(null)"} priorClientId=${d.priorClientId ?? "(null)"}`);
    if (d.explanationSummary) {
      lines.push(`      ${d.explanationSummary.slice(0, 200)}`);
    }
  }
  lines.push("");
  lines.push(`  CLEAN: ${v.isClean ? "YES" : "NO"}`);
  for (const reason of v.cleanReasons) {
    lines.push(`    - ${reason}`);
  }
  return lines.join("\n");
}
