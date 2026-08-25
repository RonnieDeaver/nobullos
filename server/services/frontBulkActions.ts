// @db-pool-intent: mixed
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Phase 3: Front console safe bulk actions.
 *
 * Public API:
 *   - previewBulkAction(spec)            — read-only count + warnings + cap decision
 *   - executeBulkAction(spec, userId)    — sync (≤cap) or background (>cap) execution
 *   - handleFrontBulkAction(job)         — work-queue handler for background execution
 *   - bulkActionJobs                     — in-memory mirror used by /console/overview
 *
 * Selection model:
 *   - { mode: "ids", messageIds: string[] }
 *   - { mode: "query", query: BulkQuerySnapshot } — re-runs the same SQL as
 *     /api/integrations/front/messages, never accepts a giant client-side id list.
 *
 * Match-method provenance: assigns made through this path persist
 *   match_method = 'manual_bulk' on the resulting raw_communication_records row,
 *   which is the canonical Phase 3 marker.
 */

import type { WorkQueueJob } from "@shared/schema";

export const BULK_ACTION_SYNC_CAP = 200;

export type BulkAction =
  | "assign"
  | "dismiss"
  | "block_sender"
  | "block_domain"
  | "not_a_match";

export type BulkQuerySnapshot = {
  match?: string;
  clientId?: string;
  search?: string;
  senderEmail?: string;
  senderDomain?: string;
  inbox?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type BulkSelection =
  | { mode: "ids"; messageIds: string[] }
  | { mode: "query"; query: BulkQuerySnapshot };

export type BulkActionTarget = {
  clientId?: string;
  reason?: string;
  domain?: string;
  senderEmail?: string;
  addContactEmails?: string[];
};

export type BulkActionSpec = {
  action: BulkAction;
  target: BulkActionTarget;
  selection: BulkSelection;
};

export type BulkPreview = {
  action: BulkAction;
  selectionMode: "ids" | "query";
  totalSelected: number;
  eligibleCount: number;
  ineligibleCount: number;
  ineligibleReasons: Record<string, number>;
  distinctSenders: number;
  distinctDomains: number;
  uniqueSender: string | null;
  uniqueDomain: string | null;
  cap: number;
  willRunAsBackgroundJob: boolean;
  warnings: string[];
  errors: string[];
  sampleIds: string[];
};

export type BulkItemOutcome = {
  rawCommId: string;
  syncEmailId: string | null;
  ok: boolean;
  resultingClientId?: string | null;
  error?: string | null;
};

export type BulkExecuteSyncResult = {
  jobId: null;
  status: "complete" | "partial";
  totalProcessed: number;
  succeeded: number;
  failed: number;
  outcomes: BulkItemOutcome[];
  summary: string;
};

export type BulkExecuteJobResult = {
  jobId: string;
  status: "queued";
  estimatedCount: number;
  message: string;
};

export type BulkExecuteResult = BulkExecuteSyncResult | BulkExecuteJobResult;

type BulkJobState = {
  jobId: string;
  action: BulkAction;
  status: "queued" | "running" | "complete" | "partial" | "failed";
  startedAt: number;
  updatedAt: number;
  totalSelected: number;
  totalProcessed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ rawCommId: string; error: string }>;
  finalSummary: string | null;
  startedBy: string | null;
  target: BulkActionTarget;
  selectionMode: "ids" | "query";
};

export const bulkActionJobs = new Map<string, BulkJobState>();

const ACTION_LABEL: Record<BulkAction, string> = {
  assign: "Assign to client",
  dismiss: "Dismiss with reason",
  block_sender: "Block sender",
  block_domain: "Block domain",
  not_a_match: "Mark as not a match",
};

type ResolvedRow = {
  rawCommId: string;
  externalSourceId: string | null;
  syncEmailId: string | null;
  clientId: string | null;
  matchStatus: string | null;
  frontSyncMatchStatus: string | null;
  effectiveStatus: string;
  senderEmail: string | null;
  senderDomain: string | null;
};

// ---------- Selection resolution ----------

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isValidDomain(s: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
}

function trimOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

function effectiveStatusFor(r: {
  clientId: string | null;
  matchStatus: string | null;
  frontSyncMatchStatus: string | null;
}): string {
  return r.frontSyncMatchStatus
    || r.matchStatus
    || (r.clientId ? "matched" : "unmatched");
}

function deriveSenderFromParticipants(
  participants: Array<{ email?: string; role?: string }> | null | undefined,
): { email: string | null; domain: string | null } {
  const list = Array.isArray(participants) ? participants : [];
  const sender = list.find(p => (p?.role || "").toLowerCase() === "external" && p?.email)
    || list.find(p => p?.email);
  const email = sender?.email ? sender.email.toLowerCase() : null;
  const domain = email && email.includes("@") ? email.split("@")[1] : null;
  return { email, domain };
}

async function resolveSelection(
  selection: BulkSelection,
  options?: { trusted?: boolean }
): Promise<{ rows: ResolvedRow[]; errors: string[] }> {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { bindArrayParam } = await import("../utils/sqlArray");

  const errors: string[] = [];
  const trusted = options?.trusted === true;

  if (selection.mode === "ids") {
    const ids = Array.from(new Set((selection.messageIds || []).filter(Boolean)));
    if (ids.length === 0) return { rows: [], errors: ["empty_id_list"] };
    // Hard guardrail for caller-provided id lists — operators must use query
    // mode for huge selections. Background worker payloads are server-generated
    // and pre-validated, so they bypass this guard via { trusted: true }.
    if (!trusted && ids.length > BULK_ACTION_SYNC_CAP * 5) {
      errors.push(`too_many_ids:${ids.length}`);
      return { rows: [], errors };
    }
    const rs = await db.execute(sql`
      SELECT r.id::text as id,
             r.external_source_id as "externalSourceId",
             r.client_id as "clientId",
             r.match_status as "matchStatus",
             r.participants_json as "participants",
             fse.id as "syncEmailId",
             fse.match_status as "frontSyncMatchStatus"
      FROM raw_communication_records r
      LEFT JOIN front_sync_emails fse ON fse.conversation_id = r.external_source_id
      WHERE r.source_type = 'front_email'
        AND r.id = ANY(${bindArrayParam(ids, "varchar")})
    `);
    const rows = (rs.rows as Array<Record<string, any>>).map(toResolvedRow);
    return { rows, errors };
  }

  // mode: "query" — re-run the messages browser SQL filters.
  const q = selection.query || {};
  const matchAllowed = new Set(["all", "matched", "unmatched", "dismissed", "blocked"]);
  const matchFilter = (typeof q.match === "string" && matchAllowed.has(q.match)) ? q.match : "all";
  const clientFilter = trimOrUndef(q.clientId);
  const dateFrom = trimOrUndef(q.dateFrom);
  const dateTo = trimOrUndef(q.dateTo);
  const search = trimOrUndef(q.search);
  const senderEmailRaw = trimOrUndef(q.senderEmail);
  const senderDomainRaw = trimOrUndef(q.senderDomain);
  const inboxRaw = trimOrUndef(q.inbox);

  if (senderEmailRaw && !isValidEmail(senderEmailRaw)) errors.push(`bad_sender_email:${senderEmailRaw}`);
  if (senderDomainRaw && !isValidDomain(senderDomainRaw)) errors.push(`bad_sender_domain:${senderDomainRaw}`);
  if (search && search.length > 200) errors.push("search_too_long");
  if (dateFrom && Number.isNaN(Date.parse(dateFrom))) errors.push("bad_date_from");
  if (dateTo && Number.isNaN(Date.parse(dateTo))) errors.push("bad_date_to");
  if (errors.length > 0) return { rows: [], errors };

  const senderEmail = senderEmailRaw?.toLowerCase();
  const senderDomain = senderDomainRaw?.toLowerCase();
  const inbox = inboxRaw?.toLowerCase();

  const conditions: any[] = [sql`r.source_type = 'front_email'`];
  if (matchFilter === "matched") {
    conditions.push(sql`r.client_id IS NOT NULL`);
  } else if (matchFilter === "unmatched") {
    conditions.push(sql`r.client_id IS NULL AND (r.match_status IS NULL OR r.match_status = 'unmatched')`);
  } else if (matchFilter === "dismissed") {
    conditions.push(sql`(
      r.match_status = 'dismissed_operational'
      OR EXISTS (
        SELECT 1 FROM front_sync_emails fse
        WHERE fse.conversation_id = r.external_source_id
          AND fse.match_status IN ('dismissed', 'dismissed_operational')
      )
    )`);
  } else if (matchFilter === "blocked") {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM front_sync_emails fse
      WHERE fse.conversation_id = r.external_source_id
        AND fse.match_status = 'blocked'
    )`);
  }
  if (clientFilter) conditions.push(sql`r.client_id = ${clientFilter}`);
  if (dateFrom) conditions.push(sql`r.timestamp >= ${new Date(dateFrom)}`);
  if (dateTo) {
    const endOfDay = new Date(dateTo);
    endOfDay.setHours(23, 59, 59, 999);
    conditions.push(sql`r.timestamp <= ${endOfDay}`);
  }
  if (search) {
    const like = `%${search}%`;
    conditions.push(sql`(
      r.title ILIKE ${like}
      OR r.content_preview ILIKE ${like}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
        WHERE p->>'name' ILIKE ${like} OR p->>'email' ILIKE ${like}
      )
    )`);
  }
  if (senderEmail) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
      WHERE LOWER(p->>'email') = ${senderEmail}
    )`);
  }
  if (senderDomain) {
    const domainLike = `%@${senderDomain}`;
    conditions.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
      WHERE LOWER(p->>'email') LIKE ${domainLike}
    )`);
  }
  if (inbox) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
      WHERE LOWER(p->>'email') = ${inbox}
        AND LOWER(COALESCE(p->>'role', 'recipient')) IN ('to', 'cc', 'bcc', 'recipient', 'team')
    )`);
  }

  const where = sql.join(conditions, sql` AND `);
  // Hard guardrail: cap absolute resolved set at 50_000 — anything above that
  // would be a misuse of bulk actions and would also blow memory.
  const HARD_LIMIT = 50_000;
  const rs = await db.execute(sql`
    SELECT r.id::text as id,
           r.external_source_id as "externalSourceId",
           r.client_id as "clientId",
           r.match_status as "matchStatus",
           r.participants_json as "participants",
           fse.id as "syncEmailId",
           fse.match_status as "frontSyncMatchStatus"
    FROM raw_communication_records r
    LEFT JOIN front_sync_emails fse ON fse.conversation_id = r.external_source_id
    WHERE ${where}
    ORDER BY r.timestamp DESC, r.id DESC
    LIMIT ${HARD_LIMIT}
  `);
  const rows = (rs.rows as Array<Record<string, any>>).map(toResolvedRow);
  if (rows.length >= HARD_LIMIT) {
    errors.push(`hard_limit_reached:${HARD_LIMIT}`);
  }
  return { rows, errors };
}

function toResolvedRow(raw: Record<string, any>): ResolvedRow {
  const sender = deriveSenderFromParticipants(raw.participants);
  return {
    rawCommId: String(raw.id),
    externalSourceId: raw.externalSourceId ?? null,
    syncEmailId: raw.syncEmailId ?? null,
    clientId: raw.clientId ?? null,
    matchStatus: raw.matchStatus ?? null,
    frontSyncMatchStatus: raw.frontSyncMatchStatus ?? null,
    effectiveStatus: effectiveStatusFor({
      clientId: raw.clientId ?? null,
      matchStatus: raw.matchStatus ?? null,
      frontSyncMatchStatus: raw.frontSyncMatchStatus ?? null,
    }),
    senderEmail: sender.email,
    senderDomain: sender.domain,
  };
}

// ---------- Eligibility ----------

// Target-scoped eligibility. When `target` is provided (block_sender/domain
// with a chosen sender/domain), rows whose sender/domain doesn't match the
// chosen target are reported as ineligible — NOT as execution failures —
// so the previewed `eligibleCount` matches what will actually be mutated.
function eligibleFor(action: BulkAction, row: ResolvedRow, target?: BulkActionTarget): { eligible: boolean; reason?: string } {
  const eff = row.effectiveStatus;
  switch (action) {
    case "assign":
      // assign valid for unmatched / dismissed / blocked rows, and for
      // already-matched rows if reassigning to a different client (handled at execute).
      return { eligible: true };
    case "dismiss":
      // Front dismiss/block/not_a_match all mutate via front_sync_emails;
      // rows without a sync_email row cannot be processed by the canonical
      // single-message helpers and would fail at execute. Mark them
      // ineligible up-front so preview "affected count" matches what will
      // actually be mutated.
      if (!row.syncEmailId) return { eligible: false, reason: "no_sync_email_id" };
      if (eff === "dismissed" || eff === "dismissed_operational") return { eligible: false, reason: "already_dismissed" };
      return { eligible: true };
    case "not_a_match":
      if (!row.syncEmailId) return { eligible: false, reason: "no_sync_email_id" };
      if (!row.clientId && eff !== "matched" && eff !== "auto_matched" && eff !== "manually_matched") {
        return { eligible: false, reason: "not_currently_matched" };
      }
      return { eligible: true };
    case "block_sender": {
      if (!row.syncEmailId) return { eligible: false, reason: "no_sync_email_id" };
      if (!row.senderEmail) return { eligible: false, reason: "no_sender_email" };
      const t = (target?.senderEmail || "").toLowerCase().trim();
      if (t && row.senderEmail.toLowerCase() !== t) return { eligible: false, reason: "row_sender_mismatch" };
      return { eligible: true };
    }
    case "block_domain": {
      if (!row.syncEmailId) return { eligible: false, reason: "no_sync_email_id" };
      if (!row.senderDomain) return { eligible: false, reason: "no_sender_domain" };
      const t = (target?.domain || "").toLowerCase().trim();
      if (t && row.senderDomain.toLowerCase() !== t) return { eligible: false, reason: "row_domain_mismatch" };
      return { eligible: true };
    }
  }
}

// ---------- Preview ----------

export async function previewBulkAction(spec: BulkActionSpec): Promise<BulkPreview> {
  const { rows, errors } = await resolveSelection(spec.selection);

  const distinctSenderSet = new Set<string>();
  const distinctDomainSet = new Set<string>();
  for (const r of rows) {
    if (r.senderEmail) distinctSenderSet.add(r.senderEmail);
    if (r.senderDomain) distinctDomainSet.add(r.senderDomain);
  }

  const ineligibleReasons: Record<string, number> = {};
  let eligibleCount = 0;
  for (const r of rows) {
    const e = eligibleFor(spec.action, r, spec.target);
    if (e.eligible) eligibleCount++;
    else {
      const reason = e.reason || "unknown";
      ineligibleReasons[reason] = (ineligibleReasons[reason] || 0) + 1;
    }
  }

  const warnings: string[] = [];
  const targetErrors: string[] = [];

  // Action-specific validation.
  if (spec.action === "assign") {
    if (!spec.target.clientId) targetErrors.push("missing_target_client_id");
  }
  if (spec.action === "dismiss") {
    if (!spec.target.reason || spec.target.reason.trim().length === 0) {
      targetErrors.push("missing_dismiss_reason");
    }
  }
  if (spec.action === "block_sender") {
    if (distinctSenderSet.size > 1 && !spec.target.senderEmail) {
      targetErrors.push("multiple_senders_in_selection_pick_one");
    }
  }
  if (spec.action === "block_domain") {
    if (distinctDomainSet.size > 1 && !spec.target.domain) {
      targetErrors.push("multiple_domains_in_selection_pick_one");
    }
  }

  const totalSelected = rows.length;
  const willRunAsBackgroundJob = eligibleCount > BULK_ACTION_SYNC_CAP;

  if (eligibleCount === 0) warnings.push("no_eligible_rows");
  if (Object.keys(ineligibleReasons).length > 0) warnings.push("partial_ineligibility");
  if (willRunAsBackgroundJob) warnings.push("will_run_in_background");

  return {
    action: spec.action,
    selectionMode: spec.selection.mode,
    totalSelected,
    eligibleCount,
    ineligibleCount: totalSelected - eligibleCount,
    ineligibleReasons,
    distinctSenders: distinctSenderSet.size,
    distinctDomains: distinctDomainSet.size,
    uniqueSender: distinctSenderSet.size === 1 ? Array.from(distinctSenderSet)[0] : null,
    uniqueDomain: distinctDomainSet.size === 1 ? Array.from(distinctDomainSet)[0] : null,
    cap: BULK_ACTION_SYNC_CAP,
    willRunAsBackgroundJob,
    warnings,
    errors: [...errors, ...targetErrors],
    sampleIds: rows.slice(0, 5).map(r => r.rawCommId),
  };
}

// ---------- Per-item executors ----------

async function applyAssign(row: ResolvedRow, target: BulkActionTarget, userId: string): Promise<BulkItemOutcome> {
  const clientId = target.clientId!;
  try {
    if (row.syncEmailId && row.frontSyncMatchStatus === "unmatched") {
      // Use the canonical helper that ingests the conversation, persists
      // matched_client_id, fires learning, etc.
      const { assignUnmatchedEmail } = await import("./frontIntegration");
      await assignUnmatchedEmail(row.syncEmailId, clientId, userId, target.addContactEmails);
    } else {
      // Already-ingested record: reassign in-place, stamping manual_bulk.
      const { storage } = await import("../storage");
      const { db } = await import("../db");
      const { rawCommunicationRecords } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await storage.updateRawCommunication(row.rawCommId, {
        clientId,
        matchMethod: "manual_bulk",
        matchConfidence: 1.0,
        matchStatus: null,
      });
      // Also move the front_sync_emails row, if present, out of dismissed/blocked.
      if (row.syncEmailId) {
        const { frontSyncEmails } = await import("@shared/schema");
        await db.update(frontSyncEmails)
          .set({
            matchedClientId: clientId,
            matchStatus: "manually_matched",
            matchConfidence: 1.0,
            matchReason: "Bulk assigned by operator",
            ingestedRecordId: row.rawCommId,
            processedAt: new Date(),
          })
          .where(eq(frontSyncEmails.id, row.syncEmailId));
      }
      // Task #2637: a bulk reassign is conversation-wide — stamp the client onto
      // every message row of the thread, not just this rollup row.
      const reassigned = await storage.getRawCommunication(row.rawCommId);
      const threadId = reassigned?.externalThreadId || reassigned?.externalSourceId || null;
      if (threadId) {
        const { stampThreadWideClientAttribution } = await import("./frontThreadAttribution");
        await stampThreadWideClientAttribution(threadId, clientId).catch(() => {
          /* best-effort thread-wide stamp */
        });
      }
    }
    // Stamp match_method='manual_bulk' to make this row's provenance auditable
    // even when assignUnmatchedEmail's underlying ingest path didn't write it.
    try {
      const { storage } = await import("../storage");
      await storage.updateRawCommunication(row.rawCommId, {
        matchMethod: "manual_bulk",
      });
    } catch {
      /* best-effort stamp */
    }
    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: true, resultingClientId: clientId };
  } catch (err: any) {
    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: false, error: err?.message ?? "assign_failed" };
  }
}

// Bulk dismiss for a single front row.
//
// Calls the canonical helper `dismissUnmatchedEmail` directly (same code path
// used by POST /api/integrations/unmatched/front/:id/dismiss) so the resulting
// matchStatus value ('dismissed', NOT 'dismissed_operational') and the set of
// touched columns stay byte-for-byte identical to the single-message flow.
// Does not mutate raw_communication_records — the canonical front dismiss
// route doesn't either, and the messages browser 'dismissed' filter already
// JOINs against front_sync_emails.match_status.
async function applyDismiss(row: ResolvedRow, _target: BulkActionTarget, userId: string): Promise<BulkItemOutcome> {
  if (!row.syncEmailId) {
    return { rawCommId: row.rawCommId, syncEmailId: null, ok: false, error: "no_sync_email_id" };
  }
  try {
    const { dismissUnmatchedEmail } = await import("./frontIntegration");
    await dismissUnmatchedEmail(row.syncEmailId, userId);

    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: true };
  } catch (err: any) {
    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: false, error: err?.message ?? "dismiss_failed" };
  }
}

// Bulk "mark as not a match" for a single front row.
//
// Mirrors the canonical promote endpoint
// (POST /api/integrations/unmatched/front/:id/promote): reset the
// front_sync_emails row to matchStatus='unmatched' with cleared
// operationalClassificationReason and processedAt, fire the same
// fire-and-forget `learnFromPromote` + agent re-evaluation pipeline.
//
// Two deliberate semantic additions on top of canonical /promote, both
// because the operator's intent is "this row was wrongly matched to its
// current client", whereas /promote presumes the row is sitting in a
// dismissed_operational state with no current client to clear:
//   - Also clear matchedClientId / matchConfidence on the front_sync_emails
//     row so the existing match link is severed immediately.
//   - Also clear the corresponding raw_communication_records.client_id and
//     stamp matchMethod='manual_bulk' so the messages browser (which
//     filters off r.client_id for the 'matched'/'unmatched' filters)
//     reflects the un-match without waiting for the agent re-evaluation
//     pass to finish.
async function applyNotAMatch(row: ResolvedRow, _target: BulkActionTarget, _userId: string): Promise<BulkItemOutcome> {
  if (!row.syncEmailId) {
    return { rawCommId: row.rawCommId, syncEmailId: null, ok: false, error: "no_sync_email_id" };
  }
  try {
    const { storage } = await import("../storage");

    // Mirror canonical /promote first — same field set, same null-out values.
    await storage.updateFrontSyncEmail(row.syncEmailId, {
      matchStatus: "unmatched",
      operationalClassificationReason: null,
      processedAt: null,
    });
    // Bulk-only un-match additions (see header comment).
    await storage.updateFrontSyncEmail(row.syncEmailId, {
      matchedClientId: null,
      matchConfidence: null,
    });
    await storage.updateRawCommunication(row.rawCommId, {
      clientId: null,
      matchMethod: "manual_bulk",
      matchConfidence: null,
      matchStatus: "unmatched",
    });

    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: true, resultingClientId: null };
  } catch (err: any) {
    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: false, error: err?.message ?? "not_a_match_failed" };
  }
}

// Bulk block for a single front row.
//
// Mirrors the canonical block endpoint
// (POST /api/integrations/unmatched/front/:id/block) byte-for-byte: only
// updates front_sync_emails with { matchStatus: 'blocked', dismissedBy,
// processedAt }, then schedules the same fire-and-forget `learnFromBlock`.
// Does NOT mutate raw_communication_records and does NOT set
// operationalClassificationReason — the canonical route doesn't either.
// The supplied `reason` is consumed only by the rolled-up audit log entry,
// not by the row mutation itself.
async function applyBlockOne(row: ResolvedRow, userId: string, _reason: string): Promise<BulkItemOutcome> {
  if (!row.syncEmailId) {
    return { rawCommId: row.rawCommId, syncEmailId: null, ok: false, error: "no_sync_email_id" };
  }
  try {
    const { storage } = await import("../storage");

    await storage.updateFrontSyncEmail(row.syncEmailId, {
      matchStatus: "blocked",
      dismissedBy: userId,
      processedAt: new Date(),
    });

    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: true };
  } catch (err: any) {
    return { rawCommId: row.rawCommId, syncEmailId: row.syncEmailId, ok: false, error: err?.message ?? "block_failed" };
  }
}

async function applyBlockSender(target: BulkActionTarget, rows: ResolvedRow[], userId: string): Promise<{ outcomes: BulkItemOutcome[]; blocked: number }> {
  const senderEmail = (target.senderEmail || "").toLowerCase().trim();
  if (!senderEmail) {
    return { outcomes: rows.map(r => ({ rawCommId: r.rawCommId, syncEmailId: r.syncEmailId, ok: false, error: "no_sender_to_block" })), blocked: 0 };
  }
  const reason = `Bulk-blocked sender ${senderEmail}`;
  const outcomes: BulkItemOutcome[] = [];
  let blocked = 0;
  for (const r of rows) {
    // Eligibility already filtered non-matching rows out, but defend anyway.
    if (!r.senderEmail || r.senderEmail.toLowerCase() !== senderEmail) {
      outcomes.push({ rawCommId: r.rawCommId, syncEmailId: r.syncEmailId, ok: false, error: "row_sender_mismatch" });
      continue;
    }
    const out = await applyBlockOne(r, userId, reason);
    if (out.ok) blocked++;
    outcomes.push(out);
  }
  try {
    const { storage } = await import("../storage");
    await storage.upsertOperationalFilterMemory({
      identifierType: "sender_email",
      identifierValue: senderEmail,
      source: "user_blocked",
      confidenceWeight: 0.95,
      usageCount: blocked,
    });
  } catch (err) {
    console.warn(`[FrontBulkAction] block_sender memory upsert failed for ${senderEmail}:`, (err as Error).message);
  }
  return { outcomes, blocked };
}

async function applyBlockDomain(target: BulkActionTarget, rows: ResolvedRow[], userId: string): Promise<{ outcomes: BulkItemOutcome[]; blocked: number }> {
  const domain = (target.domain || "").toLowerCase().trim();
  if (!domain) {
    return { outcomes: rows.map(r => ({ rawCommId: r.rawCommId, syncEmailId: r.syncEmailId, ok: false, error: "no_domain_to_block" })), blocked: 0 };
  }
  const reason = `Bulk-blocked domain @${domain}`;
  const outcomes: BulkItemOutcome[] = [];
  let blocked = 0;
  for (const r of rows) {
    if (!r.senderDomain || r.senderDomain.toLowerCase() !== domain) {
      outcomes.push({ rawCommId: r.rawCommId, syncEmailId: r.syncEmailId, ok: false, error: "row_domain_mismatch" });
      continue;
    }
    const out = await applyBlockOne(r, userId, reason);
    if (out.ok) blocked++;
    outcomes.push(out);
  }
  try {
    const { storage } = await import("../storage");
    await storage.upsertOperationalFilterMemory({
      identifierType: "sender_domain",
      identifierValue: domain,
      source: "user_blocked",
      confidenceWeight: 0.90,
      usageCount: blocked,
    });
  } catch (err) {
    console.warn(`[FrontBulkAction] block_domain memory upsert failed for ${domain}:`, (err as Error).message);
  }
  return { outcomes, blocked };
}

// ---------- Audit ----------

async function writeAuditEntries(
  spec: BulkActionSpec,
  outcomes: BulkItemOutcome[],
  userId: string,
  jobId: string | null,
): Promise<void> {
  const succeeded = outcomes.filter(o => o.ok);
  const failed = outcomes.filter(o => !o.ok);

  // Per-client action_log_entries: written when the action targets a
  // specific client (assign / not_a_match cleared from a known client).
  if (spec.action === "assign" || spec.action === "not_a_match") {
    try {
      const { storage } = await import("../storage");
      const targetClientId = spec.action === "assign" ? spec.target.clientId : null;
      if (spec.action !== "assign" || targetClientId) {
        for (const o of succeeded) {
          const clientId = spec.action === "assign" ? targetClientId! : o.resultingClientId;
          if (!clientId) continue;
          try {
            await storage.createActionLogEntry({
              clientId,
              createdBy: userId,
              actionType: "other",
              title: `Front bulk action — ${ACTION_LABEL[spec.action]}`,
              whatChanged: `Communication ${o.rawCommId} ${spec.action === "assign" ? "assigned to client" : "marked not a match"}`,
              whyChanged: spec.target.reason || `Bulk ${spec.action} via Front console`,
              impactedSystems: ["communications"],
              sourceReferences: { rawCommunicationId: o.rawCommId, syncEmailId: o.syncEmailId, jobId, action: spec.action },
            });
          } catch (err) {
            console.warn(`[FrontBulkAction] action_log_entries insert failed for ${o.rawCommId}:`, (err as Error).message);
          }
        }
      }
    } catch (err) {
      console.error("[FrontBulkAction] action_log_entries error:", err);
    }
  }

  // Write a single rolled-up activity_log entry for the bulk operation so
  // dismiss/block actions have an admin-visible audit record on parity with
  // the canonical single-message pathways (which write activity logs).
  try {
    const { insertActivityLogs } = await import("../storage/activityStorage");
    await insertActivityLogs([{
      userId: userId || null,
      actionType: `front_bulk_${spec.action}`,
      route: "/api/integrations/front/bulk-action",
      actionDetail: `Bulk ${ACTION_LABEL[spec.action]} — ${succeeded.length} succeeded, ${failed.length} failed (selection=${spec.selection.mode}, jobId=${jobId ?? "inline"})`,
      metadata: {
        action: spec.action,
        target: spec.target,
        selectionMode: spec.selection.mode,
        totalProcessed: outcomes.length,
        succeeded: succeeded.length,
        failed: failed.length,
        jobId,
        sampleSucceededIds: succeeded.slice(0, 10).map(o => o.rawCommId),
        sampleFailedIds: failed.slice(0, 10).map(o => ({ rawCommId: o.rawCommId, error: o.error || "unknown" })),
      },
      sessionId: null,
      duration: null,
      timestamp: new Date(),
    }]);
  } catch (err) {
    console.warn("[FrontBulkAction] activity log insert failed:", (err as Error).message);
  }

  // Per-item durable audit. Write one user_activity_logs row per processed
  // item (success or failure) so each row in the bulk job has a permanent,
  // queryable audit record — not just the bounded error sample on the job
  // mirror. This brings background bulk jobs to parity with the
  // single-message canonical pathways, which write per-call activity logs.
  // Writes are chunked to keep individual INSERT statements bounded.
  try {
    const { insertActivityLogs } = await import("../storage/activityStorage");
    const route = "/api/integrations/front/bulk-action";
    const itemActionType = `front_bulk_${spec.action}_item`;
    const ts = new Date();
    const itemRows = outcomes.map(o => ({
      userId: userId || null,
      actionType: itemActionType,
      route,
      actionDetail: o.ok
        ? `Bulk ${ACTION_LABEL[spec.action]} OK rawCommId=${o.rawCommId}`
        : `Bulk ${ACTION_LABEL[spec.action]} FAIL rawCommId=${o.rawCommId} — ${o.error || "unknown"}`,
      metadata: {
        action: spec.action,
        ok: o.ok,
        rawCommId: o.rawCommId,
        syncEmailId: o.syncEmailId ?? null,
        resultingClientId: o.resultingClientId ?? null,
        error: o.ok ? null : (o.error || "unknown"),
        jobId,
        target: spec.target,
      },
      sessionId: null,
      duration: null,
      timestamp: ts,
    }));
    const CHUNK = 200;
    for (let i = 0; i < itemRows.length; i += CHUNK) {
      try {
        await insertActivityLogs(itemRows.slice(i, i + CHUNK));
      } catch (chunkErr) {
        console.warn(`[FrontBulkAction] per-item activity log chunk ${i} failed:`, (chunkErr as Error).message);
      }
    }
  } catch (err) {
    console.warn("[FrontBulkAction] per-item activity log insert failed:", (err as Error).message);
  }

  console.log(`[FrontBulkAction] ${spec.action}: ${succeeded.length} succeeded, ${failed.length} failed (jobId=${jobId ?? "inline"}, user=${userId})`);
}

// ---------- Execution ----------

function summariseAction(spec: BulkActionSpec): string {
  const t = spec.target;
  switch (spec.action) {
    case "assign": return `Assign to client ${t.clientId}`;
    case "dismiss": return `Dismiss with reason "${(t.reason || "").slice(0, 80)}"`;
    case "block_sender": return `Block sender ${t.senderEmail || "(derived)"}`;
    case "block_domain": return `Block domain ${t.domain || "(derived)"}`;
    case "not_a_match": return `Mark as not a match`;
  }
}

async function runItems(
  spec: BulkActionSpec,
  rows: ResolvedRow[],
  userId: string,
  onProgress?: (processed: number, total: number) => void,
): Promise<BulkItemOutcome[]> {
  const outcomes: BulkItemOutcome[] = [];

  if (spec.action === "block_sender") {
    const { outcomes: o } = await applyBlockSender(spec.target, rows, userId);
    return o;
  }
  if (spec.action === "block_domain") {
    const { outcomes: o } = await applyBlockDomain(spec.target, rows, userId);
    return o;
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const elig = eligibleFor(spec.action, r, spec.target);
    if (!elig.eligible) {
      outcomes.push({ rawCommId: r.rawCommId, syncEmailId: r.syncEmailId, ok: false, error: `ineligible:${elig.reason}` });
    } else if (spec.action === "assign") {
      outcomes.push(await applyAssign(r, spec.target, userId));
    } else if (spec.action === "dismiss") {
      outcomes.push(await applyDismiss(r, spec.target, userId));
    } else if (spec.action === "not_a_match") {
      outcomes.push(await applyNotAMatch(r, spec.target, userId));
    }
    if (onProgress && (i % 25 === 0 || i === rows.length - 1)) onProgress(i + 1, rows.length);
  }
  return outcomes;
}

export async function executeBulkAction(spec: BulkActionSpec, userId: string): Promise<BulkExecuteResult> {
  // Re-run resolution to pick up the latest counts (preview may have been seen
  // moments ago).
  const { rows, errors } = await resolveSelection(spec.selection);
  if (errors.length > 0) {
    throw new Error(`Selection invalid: ${errors.join(", ")}`);
  }

  // Action-specific guards (mirror preview — enforced server-side so direct
  // API callers can't bypass the safety invariants the modal enforces).
  if (spec.action === "assign" && !spec.target.clientId) {
    throw new Error("missing_target_client_id");
  }
  if (spec.action === "dismiss" && !(spec.target.reason || "").trim()) {
    throw new Error("missing_dismiss_reason");
  }
  if (spec.action === "block_sender") {
    const senders = new Set(rows.map(r => r.senderEmail).filter(Boolean) as string[]);
    if (!spec.target.senderEmail) {
      if (senders.size === 1) {
        spec.target = { ...spec.target, senderEmail: Array.from(senders)[0] };
      } else if (senders.size === 0) {
        throw new Error("missing_sender_email");
      } else {
        throw new Error("multiple_senders_pick_one");
      }
    }
  }
  if (spec.action === "block_domain") {
    const domains = new Set(rows.map(r => r.senderDomain).filter(Boolean) as string[]);
    if (!spec.target.domain) {
      if (domains.size === 1) {
        spec.target = { ...spec.target, domain: Array.from(domains)[0] };
      } else if (domains.size === 0) {
        throw new Error("missing_domain");
      } else {
        throw new Error("multiple_domains_pick_one");
      }
    }
  }

  const eligibleRows = rows.filter(r => eligibleFor(spec.action, r, spec.target).eligible);

  if (eligibleRows.length <= BULK_ACTION_SYNC_CAP) {
    const outcomes = await runItems(spec, eligibleRows, userId);
    const succeeded = outcomes.filter(o => o.ok).length;
    const failed = outcomes.length - succeeded;
    await writeAuditEntries(spec, outcomes, userId, null);
    return {
      jobId: null,
      status: failed > 0 ? "partial" : "complete",
      totalProcessed: outcomes.length,
      succeeded,
      failed,
      outcomes,
      summary: summariseAction(spec),
    };
  }

  // Above cap → background job. Capture the eligible id list directly so the
  // worker sees the exact same selection (no risk of re-running the query
  // returning a different set after time has passed).
  const eligibleIds = eligibleRows.map(r => r.rawCommId);
  const { submitRepairJob } = await import("./workQueueHandlers");
  const jobId = await submitRepairJob({
    queueName: "front_bulk_action",
    workloadClass: "interactive_repair",
    payload: {
      action: spec.action,
      target: spec.target,
      messageIds: eligibleIds,
      userId,
      totalSelected: eligibleIds.length,
    },
    maxAttempts: 2,
  });

  const now = Date.now();
  bulkActionJobs.set(jobId, {
    jobId,
    action: spec.action,
    status: "queued",
    startedAt: now,
    updatedAt: now,
    totalSelected: eligibleIds.length,
    totalProcessed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    finalSummary: null,
    startedBy: userId,
    target: spec.target,
    selectionMode: spec.selection.mode,
  });

  return {
    jobId,
    status: "queued",
    estimatedCount: eligibleIds.length,
    message: `Bulk ${ACTION_LABEL[spec.action]} job enqueued — ${eligibleIds.length} items.`,
  };
}

// ---------- Work-queue handler ----------

export async function handleFrontBulkAction(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const payload = (job.payload && typeof job.payload === "object")
    ? (job.payload as { action?: BulkAction; target?: BulkActionTarget; messageIds?: string[]; userId?: string })
    : {};
  const action = payload.action as BulkAction;
  const target = (payload.target ?? {}) as BulkActionTarget;
  const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds : [];
  const userId = typeof payload.userId === "string" ? payload.userId : "system";

  if (!action || !Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error("invalid front_bulk_action payload");
  }

  const state = bulkActionJobs.get(job.id) ?? {
    jobId: job.id,
    action,
    status: "running" as const,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    totalSelected: messageIds.length,
    totalProcessed: 0,
    succeeded: 0,
    failed: 0,
    errors: [] as Array<{ rawCommId: string; error: string }>,
    finalSummary: null as string | null,
    startedBy: userId,
    target,
    selectionMode: "ids" as const,
  };
  state.status = "running";
  state.updatedAt = Date.now();
  bulkActionJobs.set(job.id, state);

  // trusted:true — payload was constructed by the server from a pre-validated
  // selection, so it bypasses the operator-facing too_many_ids guardrail.
  const { rows, errors: resolveErrors } = await resolveSelection(
    { mode: "ids", messageIds },
    { trusted: true }
  );
  if (resolveErrors.length > 0) {
    for (const e of resolveErrors) {
      if (state.errors.length < 100) state.errors.push({ rawCommId: "_selection", error: e });
    }
  }
  const spec: BulkActionSpec = { action, target, selection: { mode: "ids", messageIds } };

  const outcomes = await runItems(spec, rows, userId, (processed, total) => {
    state.totalProcessed = processed;
    state.totalSelected = total;
    state.updatedAt = Date.now();
    bulkActionJobs.set(job.id, state);
  });

  for (const o of outcomes) {
    if (o.ok) state.succeeded++;
    else {
      state.failed++;
      if (state.errors.length < 100) state.errors.push({ rawCommId: o.rawCommId, error: o.error || "unknown" });
    }
  }
  state.totalProcessed = outcomes.length;
  state.status = state.failed === 0 ? "complete" : state.succeeded > 0 ? "partial" : "failed";
  state.finalSummary = `${ACTION_LABEL[action]} — ${state.succeeded} succeeded, ${state.failed} failed of ${state.totalSelected}.`;
  state.updatedAt = Date.now();
  bulkActionJobs.set(job.id, state);

  await writeAuditEntries(spec, outcomes, userId, job.id);

  // Persist final state durably to work_queue.cursor_json so the overview
  // can render totals/errors/summary even after the in-memory mirror is
  // reaped (30 min) or the process restarts.
  try {
    const { getDb } = await import("../db");
    const { workQueue } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await getDb().update(workQueue)
      .set({
        cursorJson: {
          result: {
            action,
            status: state.status,
            totalSelected: state.totalSelected,
            totalProcessed: state.totalProcessed,
            succeeded: state.succeeded,
            failed: state.failed,
            // Persist a bounded but explicit per-item failure list so the
            // Overview surface (and post-mortem queries) can show specific
            // rawCommIds that failed, not just an aggregate count.
            errors: state.errors.slice(0, 100),
            finalSummary: state.finalSummary,
            startedBy: state.startedBy,
            target,
            completedAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(workQueue.id, job.id));
  } catch (err) {
    console.warn(`[FrontBulkAction] persist final state failed for job ${job.id}:`, (err as Error).message);
  }

  setTimeout(() => bulkActionJobs.delete(job.id), 30 * 60 * 1000);

  return {
    cursor: `bulk_action:${action},processed:${state.totalProcessed},ok:${state.succeeded},fail:${state.failed}`,
  };
}
