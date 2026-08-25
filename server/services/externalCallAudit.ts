// @cross-instance-safe: flushes this instance's own in-memory audit buffer; each instance inserts only events it witnessed (no cross-instance duplication).
/**
 * Task #1728 (Pool epic Phase 1.5.1) — External-integration call audit.
 *
 * Lightweight wrapper that records every outbound integration call into
 * `external_call_audits`. Strict rules enforced here:
 *
 *   * Never logs Authorization headers, OAuth tokens, request bodies, or
 *     raw response bodies. Only sha-256 hashes / sizes / status codes /
 *     timing are persisted.
 *   * Write-gated by the Phase 0 `external_call_audit_enabled` switch.
 *     When the switch is off the wrapper is a no-op around the fn — no
 *     hashing, no buffering, no inserts.
 *   * Inserts go through `workerDb` via a periodic flusher so we never
 *     consume API-pool capacity from a hot request path.
 *   * Buffer is bounded so a sudden burst can't grow memory unbounded —
 *     surplus is dropped (with a counter) once the cap is reached.
 */

import { createHash } from "node:crypto";
import { workerDb, dbRetry, withDbAttribution, getCurrentDbHoldLabel } from "../db";
import { externalCallAudits, type InsertExternalCallAudit } from "@shared/schema";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

export type IntegrationName =
  | "semrush"
  | "front"
  | "ghl"
  | "zoom"
  | "slack"
  | "openai"
  | "twilio"
  | "google_calendar"
  | "google_drive"
  | "google_ads"
  | "stripe"
  | "replit_auth"
  | "google_maps"
  | "fcc_census"
  | "us_census"
  | "nominatim"
  | "statcan"
  | "object_storage"
  | "clickup";

export interface AuditCallContext {
  integration: IntegrationName;
  endpoint: string;
  method?: string;
  /** Query-param object whose keys+values participate in the dedupe hash. */
  dedupeParams?: Record<string, unknown>;
  /** Optional explicit caller label (defaults to the current DB hold label). */
  callerLabel?: string;
  /** True if the result was served by an in-process cache instead of fetched. */
  cacheHit?: boolean;
}

export interface AuditCallResult<T> {
  value: T;
  statusCode?: number;
  /** Size of the serialized response, used for the rollup `total_response_bytes`. */
  responseSizeBytes?: number;
  /** Pre-computed body hash — used to detect identical repeated responses. */
  responseHash?: string;
}

const BUFFER_CAP = 5_000;
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_BATCH_MAX = 500;

const buffer: InsertExternalCallAudit[] = [];
let droppedSinceLastFlush = 0;
let lastDropWarnAt = 0;

// Per-dedupe-key memory of the previous response hash so we can flag
// `same_response_as_previous` without an extra DB round-trip. Bounded
// LRU-ish: trim oldest entries when the map grows past the cap.
const PREV_HASH_CAP = 2_000;
const previousResponseHashes = new Map<string, string>();

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function dedupeKey(ctx: AuditCallContext): string {
  // Hash the integration + canonical method + endpoint + sorted params so
  // we can detect "this exact same outbound call was made N times today".
  // Endpoint is treated as-is (callers should already strip ids/secrets
  // before passing it through). We never hash auth tokens.
  const parts: string[] = [ctx.integration, (ctx.method ?? "GET").toUpperCase(), ctx.endpoint];
  if (ctx.dedupeParams) {
    const keys = Object.keys(ctx.dedupeParams).sort();
    for (const k of keys) {
      const v = ctx.dedupeParams[k];
      if (v === undefined || v === null) continue;
      parts.push(`${k}=${String(v)}`);
    }
  }
  return sha256Hex(parts.join("\u0001")).slice(0, 64);
}

function sanitizeEndpoint(endpoint: string): string {
  // Defensive — strip query string and trim to fit the column. The dedupe
  // hash already captures the params separately.
  const q = endpoint.indexOf("?");
  const base = q >= 0 ? endpoint.slice(0, q) : endpoint;
  return base.slice(0, 256);
}

function resolveCallerLabel(explicit?: string): string {
  if (explicit) return explicit.slice(0, 128);
  try {
    const label = getCurrentDbHoldLabel();
    if (label && label !== "unknown") return label.slice(0, 128);
  } catch {
    // ignore
  }
  return "unknown";
}

function recordAudit(record: InsertExternalCallAudit): void {
  if (buffer.length >= BUFFER_CAP) {
    droppedSinceLastFlush++;
    const now = Date.now();
    if (now - lastDropWarnAt > 60_000) {
      lastDropWarnAt = now;
      console.warn(
        `[ExternalCallAudit] buffer cap (${BUFFER_CAP}) reached — dropped ${droppedSinceLastFlush} record(s) since last warn`,
      );
    }
    return;
  }
  buffer.push(record);
}

function rememberHash(dedupe: string, hash: string): boolean {
  const prev = previousResponseHashes.get(dedupe);
  previousResponseHashes.set(dedupe, hash);
  if (previousResponseHashes.size > PREV_HASH_CAP) {
    // Drop the oldest entries — Map iteration order is insertion order.
    const trimTo = Math.floor(PREV_HASH_CAP * 0.8);
    const overflow = previousResponseHashes.size - trimTo;
    let dropped = 0;
    for (const key of previousResponseHashes.keys()) {
      previousResponseHashes.delete(key);
      dropped++;
      if (dropped >= overflow) break;
    }
  }
  return prev !== undefined && prev === hash;
}

export function isAuditEnabled(): boolean {
  return isPoolEpicSwitchEnabled("external_call_audit_enabled");
}

/**
 * Wrap an outbound call. When the kill switch is off the fn is invoked
 * directly with zero overhead. When on, success and failure are both
 * recorded — never blocking the caller on the insert.
 */
export async function auditOutboundCall<T>(
  ctx: AuditCallContext,
  fn: () => Promise<AuditCallResult<T> | T>,
): Promise<T> {
  if (!isAuditEnabled()) {
    const r = await fn();
    return isAuditResult(r) ? r.value : r;
  }

  const startedAt = Date.now();
  const dedupe = dedupeKey(ctx);
  const callerLabel = resolveCallerLabel(ctx.callerLabel);
  let statusCode: number | undefined;
  let responseSizeBytes: number | undefined;
  let responseHash: string | undefined;
  let errorClass: string | undefined;
  let value: T;

  try {
    const r = await fn();
    if (isAuditResult(r)) {
      value = r.value;
      statusCode = r.statusCode;
      responseSizeBytes = r.responseSizeBytes;
      responseHash = r.responseHash;
    } else {
      value = r;
    }
  } catch (err: any) {
    errorClass = classifyError(err);
    statusCode = typeof err?.statusCode === "number" ? err.statusCode : statusCode;
    safeBuffer({
      integration: ctx.integration,
      endpoint: sanitizeEndpoint(ctx.endpoint),
      method: (ctx.method ?? "GET").toUpperCase().slice(0, 16),
      calledAt: startedAt,
      durationMs: Date.now() - startedAt,
      statusCode: statusCode ?? null,
      responseSizeBytes: responseSizeBytes ?? null,
      responseCacheHit: !!ctx.cacheHit,
      sameResponseAsPrevious: false,
      callerLabel,
      requestDedupeKey: dedupe,
      responseHash: null,
      errorClass: errorClass.slice(0, 64),
    });
    throw err;
  }

  const sameResponse = responseHash ? rememberHash(dedupe, responseHash) : false;
  safeBuffer({
    integration: ctx.integration,
    endpoint: sanitizeEndpoint(ctx.endpoint),
    method: (ctx.method ?? "GET").toUpperCase().slice(0, 16),
    calledAt: startedAt,
    durationMs: Date.now() - startedAt,
    statusCode: statusCode ?? null,
    responseSizeBytes: responseSizeBytes ?? null,
    responseCacheHit: !!ctx.cacheHit,
    sameResponseAsPrevious: sameResponse,
    callerLabel,
    requestDedupeKey: dedupe,
    responseHash: responseHash ?? null,
    errorClass: null,
  });
  return value;
}

function isAuditResult<T>(v: unknown): v is AuditCallResult<T> {
  return (
    !!v &&
    typeof v === "object" &&
    "value" in (v as Record<string, unknown>) &&
    // Heuristic: presence of any audit-meta field. This lets callers
    // wrap plain values (e.g. SDK return) as `{ value }` without
    // accidentally being treated as raw.
    ("statusCode" in (v as any) ||
      "responseSizeBytes" in (v as any) ||
      "responseHash" in (v as any))
  );
}

function classifyError(err: unknown): string {
  if (!err) return "unknown";
  const name = (err as any)?.name;
  if (typeof name === "string" && name) return name;
  const msg = String((err as any)?.message ?? err);
  if (/timeout/i.test(msg)) return "timeout";
  if (/abort/i.test(msg)) return "aborted";
  if (/network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "network";
  return "error";
}

function safeBuffer(record: InsertExternalCallAudit & {
  statusCode: number | null;
  responseSizeBytes: number | null;
  responseHash: string | null;
  errorClass: string | null;
}): void {
  // Drizzle column types accept null for nullable columns; the schema
  // uses optional fields, so coerce explicit nulls back to undefined to
  // keep the insert payload narrow.
  recordAudit({
    integration: record.integration,
    endpoint: record.endpoint,
    method: record.method,
    calledAt: record.calledAt,
    durationMs: record.durationMs,
    statusCode: record.statusCode ?? undefined,
    responseSizeBytes: record.responseSizeBytes ?? undefined,
    responseCacheHit: record.responseCacheHit,
    sameResponseAsPrevious: record.sameResponseAsPrevious,
    callerLabel: record.callerLabel,
    requestDedupeKey: record.requestDedupeKey,
    responseHash: record.responseHash ?? undefined,
    errorClass: record.errorClass ?? undefined,
  });
}

/**
 * Convenience helper for wrapping a `fetch(url, init)` invocation. Computes
 * the response hash + size by reading the body once, then returns a Response
 * clone so the caller can still consume it normally. URL parsing strips the
 * query string for the endpoint label; query params feed the dedupe hash.
 */
export async function auditedFetch(
  ctx: AuditCallContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // Pull params off the URL so we can dedupe on them. If the caller
  // already passed `dedupeParams`, they take precedence (no overwrite).
  let endpoint = ctx.endpoint;
  const params: Record<string, unknown> = { ...(ctx.dedupeParams ?? {}) };
  try {
    const parsed = new URL(url, "http://placeholder.local");
    if (!ctx.endpoint) endpoint = parsed.pathname;
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!(k in params)) params[k] = v;
    }
  } catch {
    // url may already be a path — leave endpoint as the caller specified
  }

  return auditOutboundCall<Response>(
    {
      ...ctx,
      endpoint,
      dedupeParams: params,
      method: (init?.method ?? "GET").toUpperCase(),
    },
    async () => {
      const res = await fetch(url, init);
      let bodyHash: string | undefined;
      let bodyBytes: number | undefined;
      // Clone so the caller can still read .json() / .text() themselves.
      try {
        const cloned = res.clone();
        const buf = Buffer.from(await cloned.arrayBuffer());
        bodyBytes = buf.byteLength;
        if (bodyBytes > 0) {
          bodyHash = sha256Hex(buf.toString("base64")).slice(0, 64);
        }
      } catch {
        // Body may already be consumed for streaming endpoints — that's
        // fine; we still get status + duration.
      }
      return {
        value: res,
        statusCode: res.status,
        responseSizeBytes: bodyBytes,
        responseHash: bodyHash,
      };
    },
  );
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flushOnce(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, Math.min(buffer.length, FLUSH_BATCH_MAX));
  try {
    await withDbAttribution("maintenance:external-call-audit-flush", () =>
      dbRetry(
        () =>
          workerDb
            .insert(externalCallAudits)
            .values(batch as (typeof externalCallAudits.$inferInsert)[]),
        "externalCallAudit.flush",
      ),
    );
  } catch (err: any) {
    // Re-buffer on failure (up to the cap) — never throw past the flusher.
    const room = BUFFER_CAP - buffer.length;
    if (room > 0) buffer.unshift(...batch.slice(0, room));
    console.warn(
      "[ExternalCallAudit] flush failed, retaining buffer:",
      err?.message ?? err,
    );
  }
}

export function startExternalCallAuditFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushOnce();
  }, FLUSH_INTERVAL_MS);
  // Allow the process to exit cleanly even if the timer is still pending.
  if (typeof (flushTimer as any).unref === "function") {
    (flushTimer as any).unref();
  }
  console.log(
    `[ExternalCallAudit] flusher started (interval ${FLUSH_INTERVAL_MS}ms, batch ≤ ${FLUSH_BATCH_MAX})`,
  );
}

export function stopExternalCallAuditFlusher(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export const __test = {
  flushOnce,
  dedupeKey,
  sha256Hex,
  bufferLength: () => buffer.length,
  resetBuffer: () => {
    buffer.length = 0;
    previousResponseHashes.clear();
    droppedSinceLastFlush = 0;
  },
};
