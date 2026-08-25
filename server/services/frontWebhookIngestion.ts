import crypto from "crypto";
import { workerDb, withDbHoldLabel } from "../db";
import { PERF } from "../perfConfig";
import { storage } from "../storage";
import { ingestEvent, markNormalized, markReadyToApply, reconcileSource } from "./pipelineProcessor";
import { pipelineLog } from "./pipelineLogger";
import { workResultLog, sourceEventLog } from "@shared/models/durablePipeline";
import { eq, and, sql, desc } from "drizzle-orm";
import { enqueueJob } from "./workScheduler";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { recordFront429Hit } from "./frontWarpSettings";
import { extractFrontConvMessageVersion } from "./frontConvMessageVersion";
import {
  mirrorWebhookToFrontSyncEmail,
  markFrontSyncEmailMirrorApplied,
} from "./frontSyncEmailMirror";
import { toSafeDate, type DateLike } from "../../shared/utils/safeDate";

const SETTINGS_KEY_RECONCILIATION_CURSOR = "front_reconciliation_cursor";
const SETTINGS_KEY_ACCESS = "front_access_token";

const FRONT_API_BASE = "https://api2.frontapp.com";
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Audit A-003 — single shared predicate for "is the Front webhook secret
 * configured?". Used by the webhook route (fail-closed gate) and the
 * integration-health loader (admin visibility). A blank/whitespace-only
 * value counts as NOT configured. Never returns any secret-derived material.
 */
export function isFrontWebhookSecretConfigured(): boolean {
  const secret = process.env.FRONT_WEBHOOK_SECRET;
  return typeof secret === "string" && secret.trim().length > 0;
}

/**
 * Task #3992 — bounded replay window for Front application webhooks.
 * Front's `x-front-request-timestamp` header (Unix MILLISECONDS) is
 * HMAC-bound inside the signed message (`${timestamp}:${rawBody}`), so once
 * the signature checks out the timestamp is cryptographically trustworthy.
 * Deliveries whose signed timestamp drifts more than this many milliseconds
 * into the past OR the future are rejected. Five minutes is OUR house replay
 * policy (same inclusive-boundary convention as the Zoom and TwelveLabs
 * receivers, and the Stripe SDK's default), consistent with Front's security
 * guidance to validate timestamp freshness.
 */
export const FRONT_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Deterministic boundary semantics (mirrors
 * `isZoomWebhookTimestampWithinWindow`): a timestamp whose absolute drift
 * from `nowMs` is EXACTLY `FRONT_WEBHOOK_REPLAY_WINDOW_MS` is still accepted
 * (inclusive window); one millisecond beyond is rejected. Missing,
 * non-numeric, or malformed timestamps are rejected. NOTE: unlike Zoom
 * (seconds), Front's header is already in milliseconds — no scaling.
 */
export function isFrontWebhookTimestampWithinWindow(
  timestamp: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp.trim())) {
    return false;
  }
  const tsMs = Number(timestamp.trim());
  if (!Number.isFinite(tsMs)) return false;
  return Math.abs(nowMs - tsMs) <= FRONT_WEBHOOK_REPLAY_WINDOW_MS;
}

/**
 * Task #3992 — Front application-webhook signature scheme. Front signs
 * `base64(HMAC-SHA256("{x-front-request-timestamp}:" + rawBody, key))`
 * where `key` is the Front APPLICATION SIGNING KEY (NOT the OAuth client
 * secret and NOT an API token). `FRONT_WEBHOOK_SECRET` must hold exactly
 * that signing key. `rawBody` must be the exact request bytes captured
 * before JSON parsing (see `req.rawBody` in httpApp.ts) — never a
 * reserialized `JSON.stringify(req.body)`, whose bytes can differ.
 */
export function verifyFrontWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  if (typeof timestamp !== "string" || timestamp.length === 0) return false;
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(Buffer.from(`${timestamp}:`, "utf8"));
    hmac.update(rawBody);
    const computed = hmac.digest("base64");
    const computedBuf = Buffer.from(computed, "utf8");
    const signatureBuf = Buffer.from(signature, "utf8");
    if (computedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(computedBuf, signatureBuf);
  } catch {
    return false;
  }
}

export interface FrontWebhookPayload {
  id?: string;
  type: string;
  payload: {
    id?: string;
    _links?: Record<string, { href: string }>;
    conversation?: {
      id: string;
      subject?: string;
      status?: string;
      _links?: Record<string, { href: string }>;
      recipient?: { handle?: string; name?: string; role?: string };
      last_message?: { id?: string; created_at?: number };
      created_at?: number;
    };
    message?: {
      id: string;
      body?: string;
      created_at?: number;
      is_inbound?: boolean;
      author?: { email?: string; username?: string; first_name?: string; last_name?: string };
      recipients?: Array<{ handle?: string; name?: string; role?: string }>;
      subject?: string;
    };
    target?: {
      data?: any;
      _meta?: { type?: string };
    };
    [key: string]: any;
  };
  emitted_at?: number;
}

export type NormalizedFrontResult = {
  conversationId: string;
  messageId: string | null;
  subject: string;
  direction: "inbound" | "outbound" | "internal";
  participants: Array<{ name?: string; email?: string; role?: string }>;
  contentPreview: string;
  contentText: string;
  timestamp: Date;
  externalUrl: string | null;
  rawEventType: string;
  sourceObjectId: string;
};

function buildDedupeKey(payload: FrontWebhookPayload): string {
  const convId = payload.payload?.conversation?.id || payload.payload?.id || "unknown";
  const msgId = payload.payload?.message?.id || "";
  const eventType = payload.type || "unknown";
  if (msgId) {
    return `front:webhook:${convId}:${msgId}:${eventType}`;
  }
  return `front:webhook:${convId}:${eventType}:${payload.emitted_at || ""}`;
}

function buildSourceObjectId(payload: FrontWebhookPayload): string {
  return payload.payload?.conversation?.id || payload.payload?.id || payload.id || "unknown";
}

function mapEventType(type: string): string {
  const mapping: Record<string, string> = {
    "inbound": "message.received",
    "outbound": "message.sent",
    "message": "message.received",
    "out_reply": "message.sent",
    "comment": "comment.created",
    "conversation_assigned": "conversation.assigned",
    "conversation_unassigned": "conversation.unassigned",
    "conversation_archived": "conversation.archived",
    "conversation_reopened": "conversation.reopened",
    "conversation_trashed": "conversation.trashed",
    "conversation_restored": "conversation.restored",
    "conversation_tagged": "conversation.tagged",
    "conversation_untagged": "conversation.untagged",
  };
  return mapping[type] || type;
}

export async function handleFrontWebhook(
  payload: FrontWebhookPayload,
): Promise<{ id: string; deduplicated: boolean; featureDisabled?: boolean }> {
  if (!PERF.FRONT_EVENT_INGEST_ENABLED || !PERF.FRONT_PIPELINE_FETCH_SPLIT_ENABLED) {
    return { id: "", deduplicated: false, featureDisabled: true };
  }

  const dedupeKey = buildDedupeKey(payload);
  const sourceObjectId = buildSourceObjectId(payload);
  const sourceEventType = mapEventType(payload.type);

  const result = await ingestEvent({
    sourceSystem: "front",
    sourceEventType,
    sourceObjectId,
    dedupeKey,
    payloadJson: payload as any,
    receivedAt: new Date(),
  });

  if (!result.deduplicated && result.id) {
    if (PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED) {
      try {
        await enqueueJob({
          queueName: "front_webhook_normalize",
          workloadClass: "front_ingestion",
          priority: 50,
          payload: { sourceEventId: result.id },
          dedupeKey: `normalize:${result.id}`,
        });
      } catch (enqueueErr) {
        console.error("[FrontWebhook] Failed to enqueue normalize job:", enqueueErr);
      }
    } else {
      try {
        const normalized = await normalizeFrontWebhookEvent(result.id);
        if (normalized) {
          console.log(`[FrontWebhook] Inline normalize completed for ${result.id}`);
        }
      } catch (inlineErr) {
        console.error("[FrontWebhook] Inline normalize failed:", inlineErr);
      }
    }
  }

  return result;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function normalizeFrontWebhookEvent(
  sourceEventId: string,
): Promise<NormalizedFrontResult | null> {
  const [event] = await workerDb
    .select()
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, sourceEventId))
    .limit(1);

  if (!event) {
    console.error(`[FrontWebhook] Source event not found: ${sourceEventId}`);
    return null;
  }

  if (event.status !== "received") {
    pipelineLog({
      event: "no_op",
      sourceSystem: "front",
      sourceEventType: event.sourceEventType,
      sourceEventId,
      outcome: `already_${event.status}`,
    });
    return null;
  }

  const payload = event.payloadJson as unknown as FrontWebhookPayload;
  const conv = payload.payload?.conversation;
  const msg = payload.payload?.message;

  const messageTypes = [
    "message.received", "message.sent", "inbound", "outbound",
    "message", "out_reply",
  ];
  const isMessageEvent = messageTypes.includes(payload.type) || !!msg;

  if (!isMessageEvent) {
    await workerDb
      .update(sourceEventLog)
      .set({ status: "ignored", updatedAt: new Date() })
      .where(eq(sourceEventLog.id, sourceEventId));

    pipelineLog({
      event: "no_op",
      sourceSystem: "front",
      sourceEventType: event.sourceEventType,
      sourceEventId,
      outcome: "non_message_event_ignored",
    });
    return null;
  }

  const conversationId = conv?.id || event.sourceObjectId;
  const messageId = msg?.id || null;
  const subject = msg?.subject || conv?.subject || "Untitled conversation";

  const participants: Array<{ name?: string; email?: string; role?: string }> = [];
  const seen = new Set<string>();

  if (msg?.author?.email && !seen.has(msg.author.email)) {
    seen.add(msg.author.email);
    const authorName = msg.author.first_name
      ? `${msg.author.first_name} ${msg.author.last_name || ""}`.trim()
      : msg.author.username;
    participants.push({
      name: authorName,
      email: msg.author.email,
      role: msg.is_inbound ? "external" : "team",
    });
  }

  if (msg?.recipients) {
    for (const r of msg.recipients) {
      const handle = r.handle;
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        participants.push({
          name: r.name || undefined,
          email: handle,
          role: r.role || "recipient",
        });
      }
    }
  }

  if (conv?.recipient?.handle && !seen.has(conv.recipient.handle)) {
    seen.add(conv.recipient.handle);
    participants.push({
      name: conv.recipient.name || undefined,
      email: conv.recipient.handle,
      role: conv.recipient.role || "recipient",
    });
  }

  const rawBody = msg?.body ? stripHtml(msg.body) : "";
  const contentPreview = rawBody.substring(0, 200);

  let direction: "inbound" | "outbound" | "internal" = "internal";
  if (msg?.is_inbound === true || payload.type === "inbound") {
    direction = "inbound";
  } else if (msg?.is_inbound === false || payload.type === "outbound" || payload.type === "out_reply") {
    direction = "outbound";
  }

  const timestamp = msg?.created_at
    ? new Date(msg.created_at * 1000)
    : conv?.last_message?.created_at
      ? new Date(conv.last_message.created_at * 1000)
      : new Date();

  const externalUrl = conv?.id
    ? `https://app.frontapp.com/open/${conv.id}`
    : null;

  const normalized: NormalizedFrontResult = {
    conversationId,
    messageId,
    subject,
    direction,
    participants,
    contentPreview,
    contentText: rawBody,
    timestamp,
    externalUrl,
    rawEventType: payload.type,
    sourceObjectId: event.sourceObjectId,
  };

  await markNormalized(sourceEventId, "front", event.sourceEventType, {
    conversationId,
    messageId,
    direction,
    participantEmails: participants.map(p => p.email).filter(Boolean),
  });

  // Task #1831 — mirror the normalized payload into `front_sync_emails`
  // so the table the downstream readers (frontPipelineMetrics,
  // frontAutoClosure, frontSyncEmailTriage, etc.) query stops being a
  // frozen 2026-04-14 snapshot. Non-fatal: mirror failures only warn,
  // they never block the apply enqueue.
  await mirrorWebhookToFrontSyncEmail({
    conversationId,
    subject,
    snippet: contentPreview,
    participants,
    lastMessageAt: timestamp,
    lastMessageId: messageId,
  });

  const [workResult] = await workerDb
    .insert(workResultLog)
    .values({
      sourceEventId,
      sourceSystem: "front",
      resultType: "communication_result",
      resultJson: normalized as any,
      status: "completed",
      correlationId: event.correlationId,
    })
    .returning({ id: workResultLog.id });

  await markReadyToApply(sourceEventId, "front", event.sourceEventType);

  try {
    await enqueueJob({
      queueName: "front_webhook_apply",
      workloadClass: "front_ingestion",
      priority: 50,
      payload: {
        sourceEventId,
        workResultId: workResult.id,
        conversationId,
      },
      dedupeKey: `apply:${sourceEventId}`,
    });
  } catch (enqueueErr) {
    console.error("[FrontWebhook] Failed to enqueue apply job:", enqueueErr);
  }

  return normalized;
}

export async function applyFrontWebhookResult(
  sourceEventId: string,
  workResultId: string,
): Promise<{ applied: boolean; recordId?: string; reason?: string }> {
  if (!PERF.FRONT_PIPELINE_APPLY_ENABLED) {
    console.log(`[FrontWebhook] Apply stage disabled — skipping apply for event ${sourceEventId}`);
    return { applied: false, reason: "apply_stage_disabled" };
  }
  const { recordApplyOutcome } = await import("./pipelineProcessor");

  // ─────────────────────────────────────────────────────────────────────────
  // Task #1787 Stage 3B — split the apply path into three labelled phases:
  //   1. `front_webhook_apply:read`    — short DB window: load workResultLog
  //                                       row + dedupe probe.
  //   2. (no hold)                     — coerce timestamp, build channels,
  //                                       run filter-rule evaluation, decide
  //                                       block/dismiss/never_match/proceed.
  //   3. `front_webhook_apply:persist` — short DB window: createRawComm +
  //                                       recordApplyOutcome.
  // The outer caller no longer wraps the whole function in a single
  // `front_webhook_apply` hold (that label is retained at the handler
  // layer for back-compat; the new sub-labels live alongside).
  // ─────────────────────────────────────────────────────────────────────────

  // ── Phase 1: READ ────────────────────────────────────────────────────────
  type ReadPhase =
    | { kind: "missing_work_result" }
    | { kind: "already_exists"; existingId: string; conversationId: string }
    | { kind: "proceed"; normalized: NormalizedFrontResult };

  const readPhase: ReadPhase = await withDbHoldLabel(
    "front_webhook_apply:read",
    async () => {
      const [resultRow] = await workerDb
        .select()
        .from(workResultLog)
        .where(eq(workResultLog.id, workResultId))
        .limit(1);
      if (!resultRow) {
        return { kind: "missing_work_result" } as const;
      }
      const normalized = resultRow.resultJson as unknown as NormalizedFrontResult;
      const existing = await storage.findRawCommunicationByExternalSourceId(
        normalized.conversationId,
      );
      if (existing) {
        return {
          kind: "already_exists",
          existingId: existing.id,
          conversationId: normalized.conversationId,
        } as const;
      }
      return { kind: "proceed", normalized } as const;
    },
  );

  if (readPhase.kind === "missing_work_result") {
    await withDbHoldLabel("front_webhook_apply:persist", () =>
      recordApplyOutcome({
        sourceEventId,
        workResultId,
        sourceSystem: "front",
        sourceEventType: "communication_result",
        applyTarget: "raw_communication_records",
        outcome: "failed",
        errorMessage: "Work result not found",
      }),
    );
    return { applied: false, reason: "work_result_not_found" };
  }

  if (readPhase.kind === "already_exists") {
    await withDbHoldLabel("front_webhook_apply:persist", () =>
      recordApplyOutcome({
        sourceEventId,
        workResultId,
        sourceSystem: "front",
        sourceEventType: "communication_result",
        applyTarget: "raw_communication_records",
        outcome: "skipped",
        inputHash: `conv:${readPhase.conversationId}`,
      }),
    );
    // Task #1831 — the raw_communication_records row already exists, so
    // the mirror row should reflect `applied` too even though we didn't
    // create anything new on this pass.
    await markFrontSyncEmailMirrorApplied(readPhase.conversationId);
    return { applied: false, reason: "already_exists", recordId: readPhase.existingId };
  }

  const normalized = readPhase.normalized;

  // ── Phase 2: TRANSFORM (no DB hold) ──────────────────────────────────────
  // Task #1045 — `result.resultJson` is a `jsonb` column, so every
  // `Date` field on the normalized payload has been serialized to a
  // string by JSON.stringify. Drizzle's `timestamp` column blindly
  // calls `value.toISOString()` on whatever we pass, which crashes the
  // whole apply job (and dead-letters the row) when the value is a
  // string. Coerce timestamp fields back to real Dates here, at the
  // single boundary where we cross from jsonb → ORM.
  // Policy on malformed input: log + fall back to `now` rather than
  // dropping the record, so a single bad timestamp can't re-trigger
  // the dead-letter loop. The warning carries enough identity for
  // operators to find the offending payload in `work_result_log`.
  const coercedTimestamp = toSafeDate(normalized.timestamp as unknown as DateLike);
  if (coercedTimestamp === null) {
    console.warn(
      `[FrontWebhookApply] normalized.timestamp could not be coerced to a Date; falling back to now. ` +
        `sourceEventId=${sourceEventId} workResultId=${workResultId} conversationId=${normalized.conversationId} ` +
        `rawType=${typeof normalized.timestamp} rawValue=${JSON.stringify(normalized.timestamp)?.slice(0, 120) ?? "<unstringifiable>"}`,
    );
  }
  const safeTimestamp = coercedTimestamp ?? new Date();

  // Filter-rule gate (Task #811): canonical evaluator runs against every new
  // inbound webhook record. We mirror sync-email semantics:
  //   * block/dismiss => suppress ingestion entirely (no raw record created)
  //   * never_match  => ingest normally; the downstream matcher is the layer
  //                     that consumes never_match (so we don't drop the row).
  // Either way we bump the rule-hit accountant so the UI shows live activity.
  // Note: evaluateFilterRules has its own internal DB query, but is invoked
  // outside the read/persist holds so its acquire/release is independent and
  // doesn't extend either label's hold window.
  let webhookRuleResult: Awaited<ReturnType<typeof import("./frontFilterRules").evaluateFilterRules>> | null = null;
  let ruleSuppressionReason: string | null = null;
  try {
    const { evaluateFilterRules, recordRuleHit } = await import("./frontFilterRules");
    const channels: string[] = [];
    for (const p of normalized.participants ?? []) {
      const role = (p.role || "").toLowerCase();
      if (role === "recipient" && p.email) channels.push(p.email);
    }
    webhookRuleResult = await evaluateFilterRules({
      subject: normalized.subject,
      participants: normalized.participants,
      channels,
    });
    if (webhookRuleResult.matched) {
      // Task #1270: capture context for the per-rule drill-down so admins
      // can see exactly which webhook conversations a rule caught.
      const senderEmail = (normalized.participants ?? []).find((p) => {
        const r = (p?.role || "").toLowerCase();
        return r !== "recipient" && r !== "team" && (p?.email || "").length > 0;
      })?.email ?? null;
      recordRuleHit(webhookRuleResult.ruleId, {
        source: "webhook",
        conversationId: normalized.conversationId,
        senderEmail,
        subject: normalized.subject ?? null,
        ruleType: webhookRuleResult.type,
      });
      if (webhookRuleResult.type === "block" || webhookRuleResult.type === "dismiss") {
        ruleSuppressionReason = `filter_rule:${webhookRuleResult.type}:${webhookRuleResult.scope}=${webhookRuleResult.value} (rule ${webhookRuleResult.ruleId})`;
        console.log(
          `[FrontWebhook] Filter rule ${webhookRuleResult.type} (${webhookRuleResult.scope}=${webhookRuleResult.value}) suppressed conversation ${normalized.conversationId}`,
        );
      } else {
        // never_match: ingest the record but log the suppression intent.
        console.log(
          `[FrontWebhook] Filter rule never_match (${webhookRuleResult.scope}=${webhookRuleResult.value}) recorded for ${normalized.conversationId} — record ingested; downstream matcher will skip auto-match.`,
        );
      }
    }
  } catch (err) {
    // Fail-open: never let a filter-rule lookup error stop legitimate ingestion.
    console.warn(
      `[FrontWebhook] evaluateFilterRules failed for ${normalized.conversationId}:`,
      (err as Error).message,
    );
  }

  if (ruleSuppressionReason && webhookRuleResult) {
    await withDbHoldLabel("front_webhook_apply:persist", () =>
      recordApplyOutcome({
        sourceEventId,
        workResultId,
        sourceSystem: "front",
        sourceEventType: "communication_result",
        applyTarget: "raw_communication_records",
        outcome: "skipped",
        inputHash: `conv:${normalized.conversationId}`,
        errorMessage: ruleSuppressionReason,
      }),
    );
    return { applied: false, reason: `filter_rule_${webhookRuleResult.type}` };
  }

  // ── Phase 3: PERSIST ─────────────────────────────────────────────────────
  // Task #4054 — attribution at ingest. When the conversation is ALREADY
  // matched in front_sync_emails, the envelope row is born with its client
  // link instead of being born pending for the
  // `backfill_front_message_attribution` prod-action (71–211 rows re-pending
  // per press in prod). Unmatched conversations stay NULL and are stamped
  // thread-wide later by the normal matched-transition path
  // (stampThreadWideClientAttribution); the self-heal enrolled backfill
  // remains the mop-up for residual races. Resolution is best-effort and
  // never blocks the persist.
  const { resolveMatchedClientForConversation } = await import(
    "./frontThreadAttribution"
  );
  const ingestClientId = await resolveMatchedClientForConversation(
    normalized.conversationId,
  );
  const record = await withDbHoldLabel("front_webhook_apply:persist", async () => {
    const created = await storage.createRawCommunication({
      sourceType: "front_email",
      sourceSubtype: "email_thread",
      title: normalized.subject,
      timestamp: safeTimestamp,
      direction: normalized.direction,
      participantsJson: normalized.participants,
      ...(ingestClientId ? { clientId: ingestClientId } : {}),
      externalSourceId: normalized.conversationId,
      externalThreadId: normalized.conversationId,
      externalUrl: normalized.externalUrl || undefined,
      contentText: normalized.contentText,
      contentPreview: normalized.contentPreview,
      rawPayloadJson: {
        conversationId: normalized.conversationId,
        messageId: normalized.messageId,
        subject: normalized.subject,
        webhookEventType: normalized.rawEventType,
      },
      // Task #3533 — terminal at ingest. These thread-envelope rows have NO
      // consumer: nothing enqueues `analyze_communication` for them (they
      // carry no clientId, so analysis could not persist client knowledge
      // anyway), and the old classifier path was decommissioned (Task #1963).
      // Writing 'pending' here fed the `mark_legacy_front_email_pending_terminal`
      // prod-action a 100–450 row/day stream forever. Mirrors the materialized
      // per-message rows (materializeFrontMessage), which are also written
      // 'processed'. The opt-in study driver targets sourceSubtype
      // 'email_message' only, so these envelopes are unaffected.
      processingStatus: "processed",
      operationalClassificationReason:
        "webhook_thread_envelope_no_analysis_path",
      reviewStatus: "unreviewed",
    });
    await recordApplyOutcome({
      sourceEventId,
      workResultId,
      sourceSystem: "front",
      sourceEventType: "communication_result",
      applyTarget: "raw_communication_records",
      outcome: "success",
      inputHash: `conv:${normalized.conversationId}`,
      responseJson: { recordId: created.id },
    });
    return created;
  });

  // Task #1831 — transition the mirror row to `applied` so downstream
  // readers see the same pipeline progress they did pre-2026-04-14.
  // Lives outside the persist hold so it doesn't extend the labelled
  // window measured by Phase 4 hold-rollups.
  await markFrontSyncEmailMirrorApplied(normalized.conversationId);

  return { applied: true, recordId: record.id };
}

export async function runFrontReconciliation(): Promise<{
  scanned: number;
  ingested: number;
  skipped: number;
  errors: string[];
}> {
  if (!PERF.FRONT_RECONCILIATION_ENABLED || !PERF.FRONT_PIPELINE_FETCH_SPLIT_ENABLED) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: [] };
  }

  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  if (!tokenSetting?.value) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: ["Front not connected"] };
  }

  const cursorSetting = await storage.getSystemSetting(SETTINGS_KEY_RECONCILIATION_CURSOR);
  const lastCursor = cursorSetting?.value ? Number(cursorSetting.value) : undefined;

  const batchSize = PERF.FRONT_RECONCILIATION_BATCH_SIZE;
  const MAX_PAGES = 100;

  const result = { scanned: 0, ingested: 0, skipped: 0, errors: [] as string[] };
  let maxTimestamp = lastCursor || 0;

  try {
    const token = tokenSetting.value;
    const afterSeconds = lastCursor ? Math.floor(lastCursor) : 0;
    let path: string | null = `/conversations?limit=${batchSize}`;
    if (afterSeconds > 0) {
      path += `&q[after]=${afterSeconds}`;
    }

    let pageCount = 0;

    while (path && pageCount < MAX_PAGES) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let conversations: any[];
      let nextPageUrl: string | null = null;

      try {
        const requestUrl = path.startsWith("http")
          ? path
          : `${FRONT_API_BASE}${path}`;

        const res = await fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Front API error: ${res.status} ${text}`);
        }

        const data = await res.json() as any;
        conversations = data._results || [];
        nextPageUrl = data._pagination?.next || null;
      } finally {
        clearTimeout(timeout);
      }

      pageCount++;

      for (const conv of conversations) {
        result.scanned++;
        const convId = conv.id;
        const msgVersion = extractFrontConvMessageVersion(conv);
        const convTimestamp = conv.last_message?.created_at || conv.created_at || 0;

        if (convTimestamp > maxTimestamp) {
          maxTimestamp = convTimestamp;
        }

        const dedupeKey = PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED
          ? `front:reconcile:${convId}:${msgVersion}`
          : `front:reconcile:${convId}`;

        try {
          const ingestResult = await ingestEvent({
            sourceSystem: "front",
            sourceEventType: "reconciliation_scan",
            sourceObjectId: convId,
            dedupeKey,
            payloadJson: conv as any,
            receivedAt: new Date(),
          });

          if (ingestResult.deduplicated) {
            result.skipped++;
          } else {
            result.ingested++;

            if (PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED) {
              try {
                await enqueueJob({
                  queueName: "front_webhook_normalize",
                  // Tagged `ingestion` (not `maintenance`) so reconciliation
                  // rows share the same class budget as live Front webhooks
                  // and don't get starved against the `maintenance` cap=1
                  // shared with semrush_background_refresh.
                  // Live webhooks still win because their priority is 50 vs
                  // 200 here; reconciliation only consumes leftover slots.
                  // See https://github.com/<repo>/... commit (Front backlog
                  // throughput fix) and replit.md Front Stabilization Epic.
                  workloadClass: "front_ingestion",
                  priority: 200,
                  payload: {
                    sourceEventId: ingestResult.id,
                    fromReconciliation: true,
                  },
                  dedupeKey: `normalize:${ingestResult.id}`,
                });
              } catch (enqueueErr) {
                console.error("[FrontReconciliation] Enqueue failed:", enqueueErr);
              }
            } else {
              try {
                await normalizeReconciliationEvent(ingestResult.id);
              } catch (inlineErr) {
                console.error("[FrontReconciliation] Inline normalize failed:", inlineErr);
              }
            }
          }
        } catch (err: any) {
          result.errors.push(`${convId}: ${err.message}`);
        }
      }

      if (conversations.length < batchSize) {
        break;
      }

      path = nextPageUrl;

      if (path) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err: any) {
    result.errors.push(err.message);
  }

  if (maxTimestamp > (lastCursor || 0)) {
    await storage.setSystemSetting(
      SETTINGS_KEY_RECONCILIATION_CURSOR,
      String(maxTimestamp),
      "system",
    );
  }

  await reconcileSource("front", result.scanned, result.ingested);

  console.log(
    `[FrontReconciliation] Scanned ${result.scanned}, ingested ${result.ingested}, skipped ${result.skipped}, errors ${result.errors.length}`,
  );

  return result;
}

const SETTINGS_KEY_BACKFILL_CHECKPOINT = "front_backfill_checkpoint";
const BACKFILL_BATCH_SIZE = 25;
const BACKFILL_MAX_PAGES_PER_RUN = 10;
const BACKFILL_RATE_LIMIT_MS = 1000;

export interface BackfillWindowParams {
  startDate: string;
  endDate: string;
  runId?: string;
}

export interface BackfillResult {
  runId: string;
  scanned: number;
  ingested: number;
  skipped: number;
  errors: string[];
  completed: boolean;
  checkpointTimestamp: number | null;
}

interface BackfillCheckpoint {
  runId: string;
  startDate: string;
  endDate: string;
  lastProcessedTimestamp: number;
  lastProcessedConversationId: string | null;
  nextPageUrl: string | null;
  totalScanned: number;
  totalIngested: number;
  totalSkipped: number;
  iterationCount: number;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function runFrontHistoricalBackfill(params: BackfillWindowParams): Promise<BackfillResult> {
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  if (!tokenSetting?.value) {
    return { runId: "", scanned: 0, ingested: 0, skipped: 0, errors: ["Front not connected"], completed: false, checkpointTimestamp: null };
  }

  const startEpoch = Math.floor(new Date(params.startDate).getTime() / 1000);
  const endEpoch = Math.floor(new Date(params.endDate).getTime() / 1000);

  if (isNaN(startEpoch) || isNaN(endEpoch) || startEpoch >= endEpoch) {
    return { runId: "", scanned: 0, ingested: 0, skipped: 0, errors: ["Invalid date window: startDate must be before endDate"], completed: false, checkpointTimestamp: null };
  }

  const runId = params.runId || `backfill_${startEpoch}_${endEpoch}`;
  const checkpointKey = `${SETTINGS_KEY_BACKFILL_CHECKPOINT}:${runId}`;

  let checkpoint: BackfillCheckpoint | null = null;
  const existingCheckpoint = await storage.getSystemSetting(checkpointKey);
  if (existingCheckpoint?.value) {
    try {
      checkpoint = JSON.parse(existingCheckpoint.value);
    } catch {
      checkpoint = null;
    }
  }

  if (checkpoint?.completed) {
    return {
      runId,
      scanned: checkpoint.totalScanned,
      ingested: checkpoint.totalIngested,
      skipped: checkpoint.totalSkipped,
      errors: [],
      completed: true,
      checkpointTimestamp: checkpoint.lastProcessedTimestamp,
    };
  }

  const resumeAfter = checkpoint?.lastProcessedTimestamp || startEpoch;
  const resumePageUrl = checkpoint?.nextPageUrl || null;

  const result: BackfillResult = {
    runId,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    errors: [],
    completed: false,
    checkpointTimestamp: resumeAfter,
  };

  const token = tokenSetting.value;
  let currentAfter = resumeAfter;
  let lastConversationId: string | null = checkpoint?.lastProcessedConversationId || null;
  let pageCount = 0;
  let nextPageUrl: string | null = resumePageUrl;
  const iterationCount = (checkpoint?.iterationCount || 0) + 1;

  try {
    while (pageCount < BACKFILL_MAX_PAGES_PER_RUN) {
      let requestUrl: string;
      if (nextPageUrl) {
        requestUrl = nextPageUrl;
      } else {
        requestUrl = `${FRONT_API_BASE}/conversations?limit=${BACKFILL_BATCH_SIZE}&q[after]=${currentAfter}&q[before]=${endEpoch}&sort_by=date&sort_order=asc`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let conversations: any[];
      let paginationNext: string | null = null;

      try {
        const res = await fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) {
            recordFront429Hit();
            const retryAfter = res.headers.get("retry-after");
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
            console.warn(`[FrontBackfill] Rate limited, waiting ${waitMs}ms`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`Front API error: ${res.status} ${text}`);
        }

        const data = await res.json() as any;
        conversations = data._results || [];
        paginationNext = data._pagination?.next || null;
      } finally {
        clearTimeout(timeout);
      }

      pageCount++;

      if (conversations.length === 0) {
        result.completed = true;
        break;
      }

      for (const conv of conversations) {
        result.scanned++;
        const convId = conv.id;
        const msgVersion = extractFrontConvMessageVersion(conv);
        const convTimestamp = conv.last_message?.created_at || conv.created_at || 0;

        if (convTimestamp > currentAfter) {
          currentAfter = convTimestamp;
        }
        lastConversationId = convId;

        const dedupeKey = `front:backfill:${convId}:${msgVersion}`;

        try {
          const ingestResult = await ingestEvent({
            sourceSystem: "front",
            sourceEventType: "historical_backfill",
            sourceObjectId: convId,
            dedupeKey,
            payloadJson: conv as any,
            receivedAt: new Date(),
          });

          if (ingestResult.deduplicated) {
            result.skipped++;
          } else {
            result.ingested++;

            try {
              await enqueueJob({
                queueName: "front_webhook_normalize",
                // See ingestion-class rationale comment on the priority-200
                // reconciliation enqueue above. Same reasoning here at
                // priority 300 (lower priority than live, still gets slack).
                workloadClass: "front_ingestion",
                priority: 300,
                payload: {
                  sourceEventId: ingestResult.id,
                  fromReconciliation: true,
                },
                dedupeKey: `normalize:${ingestResult.id}`,
              });
            } catch (enqueueErr) {
              console.error("[FrontBackfill] Enqueue normalize failed:", enqueueErr);
            }
          }
        } catch (err: any) {
          result.errors.push(`${convId}: ${err.message}`);
        }
      }

      result.checkpointTimestamp = currentAfter;

      if (currentAfter >= endEpoch) {
        result.completed = true;
        break;
      }

      if (conversations.length < BACKFILL_BATCH_SIZE && !paginationNext) {
        result.completed = true;
        break;
      }

      nextPageUrl = paginationNext || null;

      await new Promise(r => setTimeout(r, BACKFILL_RATE_LIMIT_MS));
    }
  } catch (err: any) {
    result.errors.push(err.message);
  }

  const now = new Date().toISOString();
  const updatedCheckpoint: BackfillCheckpoint = {
    runId,
    startDate: params.startDate,
    endDate: params.endDate,
    lastProcessedTimestamp: currentAfter,
    lastProcessedConversationId: lastConversationId,
    nextPageUrl: result.completed ? null : nextPageUrl,
    totalScanned: (checkpoint?.totalScanned || 0) + result.scanned,
    totalIngested: (checkpoint?.totalIngested || 0) + result.ingested,
    totalSkipped: (checkpoint?.totalSkipped || 0) + result.skipped,
    iterationCount,
    completed: result.completed,
    createdAt: checkpoint?.createdAt || now,
    updatedAt: now,
  };

  await storage.setSystemSetting(
    checkpointKey,
    JSON.stringify(updatedCheckpoint),
    "system",
  );

  console.log(
    `[FrontBackfill] Run ${runId}: scanned ${result.scanned}, ingested ${result.ingested}, skipped ${result.skipped}, errors ${result.errors.length}, completed ${result.completed}, checkpoint ${currentAfter}`,
  );

  return result;
}

export async function getFrontBackfillStatus(runId: string): Promise<BackfillCheckpoint | null> {
  const checkpointKey = `${SETTINGS_KEY_BACKFILL_CHECKPOINT}:${runId}`;
  const setting = await storage.getSystemSetting(checkpointKey);
  if (!setting?.value) return null;
  try {
    return JSON.parse(setting.value);
  } catch {
    return null;
  }
}

/**
 * Materialize ONE Front message into a `raw_communication_records` row,
 * deduping on `external_source_id` (the Front `msg_*` id) before writing.
 * Returns `"inserted"` when a new row was written, `"skipped"` when the
 * row already existed or the message had no usable id.
 *
 * Task #2713 — the write is idempotent at the DB level via
 * `createRawCommunicationOnConflictSkip` (ON CONFLICT (external_source_id)
 * DO NOTHING). Concurrent materializer ticks / autoscale instances can race
 * on the SAME message id; the loser of the race now resolves to a clean
 * `"skipped"` instead of throwing a duplicate-key error (which previously
 * produced the `[FrontAppliedConvMaterializer] ... msg write failed` log
 * storm). The pre-check below stays as a cheap fast-path that avoids the
 * thread-rollup lookup + row build for already-present messages; the
 * ON CONFLICT guard is what makes the race safe. Any NON-duplicate write
 * error still throws so the caller can surface it.
 *
 * Extracted from the historical-recovery per-message materialization
 * loop so the Task #2010 outbound-gap backfill can reuse the EXACT same
 * field-mapping / dedupe / `processingStatus:'processed'` write path
 * ("route the misses through the existing ingestion pipeline") without a
 * second Front hydrate. `source` is stamped into `rawPayloadJson.source`
 * so prod can tell the two callers apart.
 */
export async function materializeFrontMessageRecord(args: {
  msg: any;
  conversationId: string;
  subject: string;
  fallbackTimestamp: Date;
  source: string;
}): Promise<"inserted" | "skipped"> {
  const { msg, conversationId, subject, fallbackTimestamp, source } = args;
  const msgId = msg?.id;
  if (!msgId || typeof msgId !== "string") return "skipped";
  const existing = await storage.findRawCommunicationByExternalSourceId(msgId);
  if (existing) return "skipped";
  // Task #2637: a materialized per-message row inherits the conversation's
  // already-resolved attribution so the whole thread stays in lockstep. The
  // rollup row's client_id was validated at match time (internal senders are
  // never the resolved client); an unmatched thread yields null.
  // Task #4054 — fallback: when the rollup row is missing or unstamped but
  // the conversation is already matched in front_sync_emails, resolve the
  // client at insert time (same rule as the thread-wide stamp and the
  // backfill prod-action's phase-1 predicate) so the row is not born pending
  // for the backfill.
  const threadRollup = await storage.findRawCommunicationByExternalSourceId(conversationId);
  let threadClientId = threadRollup?.clientId ?? null;
  if (!threadClientId) {
    const { resolveMatchedClientForConversation } = await import(
      "./frontThreadAttribution"
    );
    threadClientId = await resolveMatchedClientForConversation(conversationId);
  }
  const msgBody = msg.body ? stripHtml(msg.body) : "";
  const msgTimestamp = msg.created_at
    ? new Date(msg.created_at * 1000)
    : fallbackTimestamp;
  const msgDirection: "inbound" | "outbound" | "internal" =
    msg.is_inbound === true
      ? "inbound"
      : msg.is_inbound === false
        ? "outbound"
        : "internal";
  const msgParticipants: Array<{ name?: string; email?: string; role?: string }> =
    [];
  if (msg?.author?.email) {
    msgParticipants.push({
      name: msg.author?.username || undefined,
      email: msg.author.email,
      role: "author",
    });
  }
  if (Array.isArray(msg.recipients)) {
    for (const r of msg.recipients) {
      if (r?.handle) {
        msgParticipants.push({
          name: r?.name || undefined,
          email: r.handle,
          role: r?.role || "recipient",
        });
      }
    }
  }
  const inserted = await storage.createRawCommunicationOnConflictSkip({
    sourceType: "front_email",
    sourceSubtype: "email_message",
    title: subject,
    timestamp: msgTimestamp,
    direction: msgDirection,
    participantsJson: msgParticipants,
    clientId: threadClientId,
    externalSourceId: msgId,
    externalThreadId: conversationId,
    externalUrl: `https://app.frontapp.com/open/${conversationId}`,
    contentText: msgBody,
    contentPreview: msgBody.substring(0, 200),
    rawPayloadJson: {
      conversationId,
      messageId: msgId,
      source,
    },
    // Terminal: historical evidence rows, not classifier inputs — marked
    // 'processed' so no worker has to advance them (see Task #1963).
    processingStatus: "processed",
    reviewStatus: "unreviewed",
  });
  // Task #2713 — a conflict (row already present, lost a concurrent race)
  // returns undefined and is a clean "skipped", not a thrown error.
  return inserted ? "inserted" : "skipped";
}

type ReconciliationHydrateFn = (
  conversationId: string,
  lastMessageId: string | null,
) => Promise<{ conversation?: any; messages: any[]; fromCache?: boolean }>;
export async function normalizeReconciliationEvent(
  sourceEventId: string,
): Promise<NormalizedFrontResult | null> {
  const [event] = await workerDb
    .select()
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, sourceEventId))
    .limit(1);

  if (!event) return null;

  if (event.status !== "received") {
    return null;
  }

  const convPayload = event.payloadJson as any;
  const conversationId = convPayload.id || event.sourceObjectId;
  const subject = convPayload.subject || "Untitled conversation";

  const participants: Array<{ name?: string; email?: string; role?: string }> = [];
  const seen = new Set<string>();

  if (convPayload.recipient?.handle && !seen.has(convPayload.recipient.handle)) {
    seen.add(convPayload.recipient.handle);
    participants.push({
      name: convPayload.recipient.name || undefined,
      email: convPayload.recipient.handle,
      role: convPayload.recipient.role || "recipient",
    });
  }

  // Task #3889 — Front's `GET /conversations` list API returns NO
  // `last_message` payload (only a `_links.related.last_message` URL), so
  // reconciliation envelopes historically fell through to
  // direction='internal' with the conversation's *created_at* as the
  // timestamp — which meant the live poller (the only Front feed still
  // running day-to-day) contributed ZERO inbound signal to Going Quiet /
  // daily judgment / coverage. Recorded decision: an envelope without a
  // message payload genuinely cannot know its direction, so instead of
  // guessing we hydrate the conversation's real messages (cached per
  // conversation version in front_hydrate_snapshots) and:
  //   1. stamp the envelope's direction/timestamp/messageId/preview from
  //      the real latest message, and
  //   2. materialize one dedupe-safe `email_message` row per message via
  //      the same write path the backfill drivers use (see block below).
  // Hydration is breaker-aware and best-effort: when Front auth is dead or
  // the fetch fails, the envelope keeps the legacy internal/created_at
  // shape (never a fabricated direction).
  let hydratedMsgs: any[] | null = null;
  if (
    event.sourceEventType === "reconciliation_scan" &&
    isPoolEpicSwitchEnabled("front_reconciliation_per_message_materialization_enabled")
  ) {
    try {
      const { frontAuthBreakerActive } = await import("./frontAuthBreaker");
      if (!frontAuthBreakerActive()) {
        const version = extractFrontConvMessageVersion(convPayload);
        const hydrate =
          _reconciliationHydrateOverrideForTest ??
          (await import("./frontIntegration")).hydrateConversationSnapshot;
        const hydrated = await hydrate(
          conversationId,
          version === "noversion" ? null : version,
        );
        const msgs = Array.isArray(hydrated?.messages) ? hydrated.messages : [];
        if (msgs.length > 0) hydratedMsgs = msgs;
      }
    } catch (hydrateErr: any) {
      console.warn(
        `[FrontReconciliation] hydration unavailable for conv=${conversationId} (envelope stays internal): ${hydrateErr?.message ?? hydrateErr}`,
      );
    }
  }
  const hydratedLatest =
    hydratedMsgs !== null
      ? hydratedMsgs.reduce((a, b) =>
          (Number(a?.created_at) || 0) >= (Number(b?.created_at) || 0) ? a : b,
        )
      : null;

  const lastMsg = hydratedLatest ?? convPayload.last_message;
  const messageId = lastMsg?.id || null;

  const rawBody = lastMsg?.body ? stripHtml(lastMsg.body) : "";
  const contentPreview = rawBody.substring(0, 200);

  const timestamp = lastMsg?.created_at
    ? new Date(lastMsg.created_at * 1000)
    : convPayload.created_at
      ? new Date(convPayload.created_at * 1000)
      : new Date();

  const direction: "inbound" | "outbound" | "internal" = lastMsg?.is_inbound === true
    ? "inbound"
    : lastMsg?.is_inbound === false
      ? "outbound"
      : "internal";

  const externalUrl = `https://app.frontapp.com/open/${conversationId}`;

  const normalized: NormalizedFrontResult = {
    conversationId,
    messageId,
    subject,
    direction,
    participants,
    contentPreview,
    contentText: rawBody,
    timestamp,
    externalUrl,
    rawEventType: "reconciliation_scan",
    sourceObjectId: event.sourceObjectId,
  };

  await markNormalized(sourceEventId, "front", event.sourceEventType, {
    conversationId,
    messageId,
    direction,
    participantEmails: participants.map(p => p.email).filter(Boolean),
  });

  // Task #1831 — same webhook→`front_sync_emails` mirror as the live
  // path. Reconciliation events legitimately cover gaps left by missed
  // webhooks, so they must populate the table that downstream readers
  // depend on.
  await mirrorWebhookToFrontSyncEmail({
    conversationId,
    subject,
    snippet: contentPreview,
    participants,
    lastMessageAt: timestamp,
    lastMessageId: messageId,
  });

  const [workResult] = await workerDb
    .insert(workResultLog)
    .values({
      sourceEventId,
      sourceSystem: "front",
      resultType: "communication_result",
      resultJson: normalized as any,
      status: "completed",
      correlationId: event.correlationId,
    })
    .returning({ id: workResultLog.id });

  await markReadyToApply(sourceEventId, "front", event.sourceEventType);

  // Task #1963 — per-message materialization for historical recovery.
  //
  // The Front list endpoint returns only `last_message`, so the apply
  // path writes a single `raw_communication_records` row per conversation
  // — fine for live webhooks (which fire per-message) but for the
  // historical-recovery path that single row hides 5–30 messages per
  // conversation and is why pre-2025-07 months have zero `front_email`
  // rows in `raw_communication_records` even though their conversation
  // envelopes were ingested.
  //
  // When the `front_recovery_per_message_materialization_enabled` switch
  // is ON (default OFF — opt-in after the reset step has refilled the
  // queue from the search endpoint), we hydrate the full message list
  // and insert one row per `msg_*` id. Idempotent: each insert is
  // preceded by a lookup on `external_source_id`. Best-effort: errors
  // are logged and swallowed because the conversation envelope has
  // already been queued for apply by this point.
  if (
    event.sourceEventType === "historical_recovery" &&
    isPoolEpicSwitchEnabled("front_recovery_per_message_materialization_enabled")
  ) {
    try {
      const { hydrateConversationSnapshot } = await import("./frontIntegration");
      const hydrated = await hydrateConversationSnapshot(conversationId, messageId);
      const msgs = Array.isArray(hydrated.messages) ? hydrated.messages : [];
      let inserted = 0;
      let skipped = 0;
      for (const msg of msgs) {
        const msgId = msg?.id;
        try {
          const outcome = await materializeFrontMessageRecord({
            msg,
            conversationId,
            subject,
            fallbackTimestamp: timestamp,
            source: "historical_recovery_per_message_materialization",
          });
          if (outcome === "inserted") inserted++;
          else skipped++;
        } catch (perMsgErr: any) {
          skipped++;
          console.warn(
            `[FrontRecovery] per-message materialization skipped conv=${conversationId} msg=${msgId}: ${perMsgErr?.message ?? perMsgErr}`,
          );
        }
      }
      if (inserted > 0 || skipped > 0) {
        console.log(
          `[FrontRecovery] per-message materialization conv=${conversationId} inserted=${inserted} skipped=${skipped} total=${msgs.length}`,
        );
      }
    } catch (matErr: any) {
      console.warn(
        `[FrontRecovery] per-message materialization failed (non-fatal) for conv=${conversationId}: ${matErr?.message ?? matErr}`,
      );
    }
  }

  // Task #3889 — per-message materialization for the LIVE reconciliation
  // poller, reusing the messages already hydrated above (no second Front
  // fetch). This is what keeps the rolling recent window message-grain
  // fresh between backfill-driver runs: each new conversation version the
  // poller sees lands its real inbound/outbound rows within minutes.
  // Best-effort like the historical block — the envelope is already queued
  // for apply; a failed insert only costs freshness, never correctness
  // (`materializeFrontMessageRecord` dedupes on external_source_id).
  if (hydratedMsgs !== null && hydratedMsgs.length > 0) {
    let inserted = 0;
    let skipped = 0;
    for (const msg of hydratedMsgs) {
      const msgId = msg?.id;
      try {
        const outcome = await materializeFrontMessageRecord({
          msg,
          conversationId,
          subject,
          fallbackTimestamp: timestamp,
          source: "reconciliation_per_message_materialization",
        });
        if (outcome === "inserted") inserted++;
        else skipped++;
      } catch (perMsgErr: any) {
        skipped++;
        console.warn(
          `[FrontReconciliation] per-message materialization skipped conv=${conversationId} msg=${msgId}: ${perMsgErr?.message ?? perMsgErr}`,
        );
      }
    }
    if (inserted > 0) {
      console.log(
        `[FrontReconciliation] per-message materialization conv=${conversationId} inserted=${inserted} skipped=${skipped} total=${hydratedMsgs.length}`,
      );
    }
  }

  try {
    await enqueueJob({
      queueName: "front_webhook_apply",
      // Tagged `ingestion` to match the live webhook apply path
      // (priority 50). Reconciliation apply at priority 200 still loses
      // to live work but is no longer starved by the maintenance cap=1.
      workloadClass: "front_ingestion",
      priority: 200,
      payload: {
        sourceEventId,
        workResultId: workResult.id,
        conversationId,
      },
      dedupeKey: `apply:${sourceEventId}`,
    });
  } catch (enqueueErr) {
    console.error("[FrontReconciliation] Apply enqueue failed:", enqueueErr);
  }

  return normalized;
}

export async function runFrontFullBackfill(options?: {
  onProgress?: (progress: { scanned: number; ingested: number; skipped: number; pages: number }) => void;
}): Promise<{
  scanned: number;
  ingested: number;
  skipped: number;
  pages: number;
  errors: string[];
  blocked?: boolean;
  blockedReason?: string;
}> {
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  if (!tokenSetting?.value) {
    return { scanned: 0, ingested: 0, skipped: 0, pages: 0, errors: ["Front not connected"] };
  }

  const batchSize = PERF.FRONT_RECONCILIATION_BATCH_SIZE;
  const SAFETY_MAX_PAGES = 5000;
  const RATE_LIMIT_DELAY_MS = 500;
  const result: { scanned: number; ingested: number; skipped: number; pages: number; errors: string[]; blocked?: boolean; blockedReason?: string } = { scanned: 0, ingested: 0, skipped: 0, pages: 0, errors: [] as string[] };

  const token = tokenSetting.value;
  const endEpoch = Math.floor(Date.now() / 1000);
  let currentAfter = 1;
  let nextPageUrl: string | null = null;

  console.log(
    `[FrontFullBackfill] Starting: sweeping from epoch ${currentAfter} to ${endEpoch} (all time), batchSize=${batchSize}, maxPages=${SAFETY_MAX_PAGES}`,
  );

  try {
    while (result.pages < SAFETY_MAX_PAGES) {
      const requestUrl = nextPageUrl
        ? nextPageUrl
        : `${FRONT_API_BASE}/conversations?limit=${batchSize}&q[after]=${currentAfter}&q[before]=${endEpoch}&sort_by=date&sort_order=asc`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let conversations: any[];
      let paginationNext: string | null = null;

      try {
        const res = await fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) {
            recordFront429Hit();
            const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
            console.log(`[FrontFullBackfill] Rate limited, waiting ${retryAfter}s`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            continue;
          }
          throw new Error(`Front API error: ${res.status} ${text}`);
        }

        const data = await res.json() as any;
        conversations = data._results || [];
        paginationNext = data._pagination?.next || null;
      } finally {
        clearTimeout(timeout);
      }

      result.pages++;

      if (result.pages === 1) {
        console.log(
          `[FrontFullBackfill] First page returned ${conversations.length} conversations${conversations.length === 0 ? " — token scope issue or no data" : ""}`,
        );
      }

      if (conversations.length === 0) {
        break;
      }

      for (const conv of conversations) {
        result.scanned++;
        const convId = conv.id;
        const msgVersion = extractFrontConvMessageVersion(conv);
        const convTimestamp = conv.last_message?.created_at || conv.created_at || 0;

        if (convTimestamp > currentAfter) {
          currentAfter = convTimestamp;
        }

        const dedupeKey = PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED
          ? `front:backfill:${convId}:${msgVersion}`
          : `front:backfill:${convId}`;

        try {
          const ingestResult = await ingestEvent({
            sourceSystem: "front",
            sourceEventType: "full_backfill",
            sourceObjectId: convId,
            dedupeKey,
            payloadJson: conv as any,
            receivedAt: new Date(),
          });

          if (ingestResult.deduplicated) {
            result.skipped++;
          } else {
            result.ingested++;

            if (PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED) {
              try {
                await enqueueJob({
                  queueName: "front_webhook_normalize",
                  // See ingestion-class rationale comment on the
                  // reconciliation enqueue earlier in this file. Full
                  // backfill enqueues normalize at priority 200, still
                  // beneath live webhooks at priority 50.
                  workloadClass: "front_ingestion",
                  priority: 200,
                  payload: {
                    sourceEventId: ingestResult.id,
                    fromReconciliation: true,
                  },
                  dedupeKey: `normalize:${ingestResult.id}`,
                });
              } catch (enqueueErr) {
                console.error("[FrontFullBackfill] Enqueue failed:", enqueueErr);
              }
            } else {
              try {
                await normalizeReconciliationEvent(ingestResult.id);
              } catch (inlineErr) {
                console.error("[FrontFullBackfill] Inline normalize failed:", inlineErr);
              }
            }
          }
        } catch (err: any) {
          result.errors.push(`${convId}: ${err.message}`);
        }
      }

      if (options?.onProgress) {
        options.onProgress({
          scanned: result.scanned,
          ingested: result.ingested,
          skipped: result.skipped,
          pages: result.pages,
        });
      }

      if (currentAfter >= endEpoch) {
        break;
      }

      if (paginationNext) {
        nextPageUrl = paginationNext;
      } else if (conversations.length < batchSize) {
        break;
      } else {
        nextPageUrl = null;
      }

      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[FrontFullBackfill] Aborted on page ${result.pages + 1}: ${msg}`);
    if (err?.stack) console.error(`[FrontFullBackfill] Stack: ${err.stack}`);
    result.errors.push(msg);
  }

  console.log(
    `[FrontFullBackfill] Complete: ${result.pages} pages, ${result.scanned} scanned, ${result.ingested} ingested, ${result.skipped} skipped, ${result.errors.length} errors`,
  );

  if (result.pages === 0 && result.errors.length > 0) {
    throw new Error(`Full backfill aborted before any page was fetched: ${result.errors[0]}`);
  }

  if (result.pages <= 1 && result.scanned === 0 && result.errors.length === 0) {
    result.blocked = true;
    result.blockedReason =
      "first_page_returned_zero_results: token scope may be insufficient or the query returned empty";
  }

  return result;
}

export function __setReconciliationHydrationOverrideForTest(
  fn: ReconciliationHydrateFn | null,
): void {
  _reconciliationHydrateOverrideForTest = fn;
}

let _reconciliationHydrateOverrideForTest: ReconciliationHydrateFn | null = null;
