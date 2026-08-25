// @db-pool-intent: worker
// @cross-instance-safe: prune sweep is idempotent — prunes expired recovery jobs + auto-continues via dedupe-keyed work_queue enqueue; safe to run on every instance.
//
// Task #1723 (Phase 2.3): the coverage report query in
// `generateCoverageReport()` and the periodic prune sweep produce
// heavy aggregate scans against `front_sync_emails`,
// `raw_communication_records`, and `source_event_log`. Routing them
// through the worker pool keeps them off the user-facing API pool.
// `runHistoricalRecovery` is invoked from admin routes
// (`server/routes/integrations.ts`); the background IIFE it spawns
// wraps its body in `runWithWorkerDb` so every nested `storage.*` /
// `getDb()` call inside the recovery loop lands on the worker pool,
// even though the route handler itself runs on the API pool.
// `runRecoveryPruneSweep` (the periodic maintenance tick) is
// likewise wrapped so its `storage.*` checkpoint/auto-continue
// writes never compete with user requests.
// @periodic-request-pool-exception: deliberate dual-pool design — db is aliased apiDb for lightweight interactive status reads (guarded by isApiPoolUnderPressure), while bulk recovery work runs on workerDb/runWithWorkerDb.
import { db as apiDb, workerDb, runWithWorkerDb, withDbAttribution, isApiPoolUnderPressure, getDb } from "../db";
import { frontSyncEmails } from "@shared/models/communications";
import { bindArrayParam } from "../utils/sqlArray";

// Within this module the bare `db` reference is the worker-pool
// Drizzle client. Direct callers (the coverage report SQL, the
// reconciliation aggregates) explicitly want to keep those scans off
// the API pool. Anything that needs the API pool must use `apiDb`.
const db = workerDb;
import { storage } from "../storage";
import { sql } from "drizzle-orm";
import { PERF } from "../perfConfig";
import { ingestEvent } from "./pipelineProcessor";
import { enqueueJob } from "./workScheduler";
import { normalizeReconciliationEvent, materializeFrontMessageRecord } from "./frontWebhookIngestion";
import { extractFrontConvMessageVersion } from "./frontConvMessageVersion";
import { isKillSwitchEnabled } from "./killSwitches";
import { FrontAuthError, getValidFrontAccessToken, listInboxes, getAllConversationMessages } from "./frontIntegration";
import { shouldLogFrontAuth } from "./frontAuthBreaker";
import {
  createApiPoolPressureHysteresis,
  evaluateApiPoolPressureWithHysteresis,
  getFrontRecoveryTuning,
} from "./frontRecoveryTuning";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { createHash } from "crypto";

// Task #1789 — Active-inbox filter cache. Front's `/inboxes` endpoint
// returns only inboxes visible to the API token; archived/disabled
// inboxes are omitted. Cached at module scope with a 1h TTL so we
// don't re-list per window inside the same recovery run. A failure
// loading the list degrades to "no filter" (logged once per window).
let activeInboxIdCache: { ids: Set<string>; loadedAt: number } | null = null;
const ACTIVE_INBOX_CACHE_TTL_MS = 60 * 60 * 1000;

async function getActiveFrontInboxIds(jobTag: string): Promise<Set<string> | null> {
  const now = Date.now();
  if (activeInboxIdCache && now - activeInboxIdCache.loadedAt < ACTIVE_INBOX_CACHE_TTL_MS) {
    return activeInboxIdCache.ids;
  }
  try {
    const inboxes = await listInboxes();
    const ids = new Set<string>();
    for (const ix of inboxes) {
      if (ix?.id) ids.add(String(ix.id));
    }
    activeInboxIdCache = { ids, loadedAt: now };
    console.log(
      `[FrontRecovery] ${jobTag}active_inbox_filter_loaded count=${ids.size} ttl_ms=${ACTIVE_INBOX_CACHE_TTL_MS}`,
    );
    return ids;
  } catch (err: any) {
    console.warn(
      `[FrontRecovery] ${jobTag}active_inbox_filter_load_failed msg=${err?.message ?? String(err)} — filter will no-op until cache refresh succeeds`,
    );
    return null;
  }
}

function extractConvInboxIds(conv: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (v == null) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "object" && v.id) out.push(String(v.id));
  };
  if (conv?.inbox_id) push(conv.inbox_id);
  if (conv?.metadata?.inbox_id) push(conv.metadata.inbox_id);
  if (Array.isArray(conv?.inboxes)) for (const ix of conv.inboxes) push(ix);
  // Some Front payloads embed inbox info under `_links.related.inboxes`
  // as a URL of the form `.../inboxes/inb_xxx`. Extract the trailing ID
  // when present so the filter still has a chance to act on payloads
  // where the inbox membership leaks into the listing.
  const link = conv?._links?.related?.inboxes;
  if (typeof link === "string") {
    const m = link.match(/\/inboxes\/([A-Za-z0-9_-]+)(?:\?|$)/);
    if (m) out.push(m[1]);
  }
  return out;
}

// Task #1887 `extractFrontConvMessageVersion` (the dedupe-key version-slot
// helper) moved verbatim to `./frontConvMessageVersion.ts` (Task #3945) so
// webhook ingestion no longer has to import this module for it — that
// back-edge was half of the recovery ↔ ingestion runtime import cycle.

function hashConversationsPage(conversations: any[]): string {
  const h = createHash("sha256");
  for (const c of conversations) {
    h.update(
      `${c?.id ?? ""}|${c?.last_message?.id ?? ""}|${c?.last_message?.created_at ?? ""}\n`,
    );
  }
  return h.digest("hex");
}

// Test-only seam to reset the cache between test cases.
export function __resetFrontRecoveryActiveInboxCacheForTest(): void {
  activeInboxIdCache = null;
}

const FRONT_API_BASE = "https://api2.frontapp.com";
const FETCH_TIMEOUT_MS = 30_000;

// Task #1015: bounded per-page retry behavior. Transient page failures
// (timeout / 502 / 503 / 504 / network reset) and 429s should retry the
// same page rather than collapsing the whole window. 401 gets exactly
// one forced refresh + retry; if the refreshed token still 401s we
// classify as a real auth failure.
const PAGE_FETCH_MAX_ATTEMPTS = 3;
const PAGE_FETCH_BACKOFF_MS = [1000, 2000, 4000];
const PAGE_FETCH_429_MAX_ATTEMPTS = 5;

/**
 * Internal typed error so callers can distinguish retry-exhausted
 * transient failures from real auth failures and from non-retryable
 * 4xx responses. The `reasonCode` matches one of the entries in
 * KNOWN_PARTIAL_REASON_MAP so the admin panel humanizes correctly.
 */
class FrontRecoveryFetchError extends Error {
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string | null;
  // Task #1016: counters from the in-flight page so the caller can roll
  // them into the window checkpoint even when the page ultimately failed.
  retriesByReason: Record<string, number>;
  tokenRefreshes: number;
  constructor(
    reasonCode: string,
    message: string,
    opts?: { retryable?: boolean; status?: number; requestId?: string | null },
  ) {
    super(message);
    this.name = "FrontRecoveryFetchError";
    this.reasonCode = reasonCode;
    this.retryable = opts?.retryable ?? false;
    this.status = opts?.status;
    this.requestId = opts?.requestId ?? null;
    this.retriesByReason = {};
    this.tokenRefreshes = 0;
  }
}

// Task #1016: stable keys for the per-window retry breakdown surfaced
// in the admin UI. Keep these short and machine-stable; the panel maps
// them to human labels on display.
export type FrontRecoveryRetryReason =
  | "timeout"
  | "network"
  | "front_502"
  | "front_503"
  | "front_504"
  | "front_5xx"
  | "front_429"
  | "auth_refresh_transient"
  // Task #1869: a persistent 401 was confirmed a refresh-race artifact by a
  // healthy /me probe, so the page is retried instead of marked terminal.
  | "auth_race_recovered";

function isAbortOrNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const msg = err.message || "";
    if (/aborted|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|network/i.test(msg)) {
      return true;
    }
  }
  return false;
}

interface RecoveryPageFetchArgs {
  pageUrl: string;
  windowLabel: string;
  pageNumber: number;
  signalTimeoutMs?: number;
  jobTag?: string;
}

interface RecoveryPageFetchResult {
  conversations: any[];
  nextPageUrl: string | null;
  refreshedDuringFetch: boolean;
  // Task #1016: counters surfaced for the per-window UI breakdown.
  // `retriesByReason` keys are the stable codes from
  // `FrontRecoveryRetryReason`; `tokenRefreshes` covers both
  // expiry-driven refreshes and the 401-forced refresh path.
  retriesByReason: Record<string, number>;
  tokenRefreshes: number;
}

/**
 * Bounded retry wrapper for a single Front recovery page request
 * (Task #1015). Refreshes the token before each attempt, retries on
 * transient failures with exponential backoff, force-refreshes once on
 * a mid-run 401, and surfaces typed errors so the caller can mark the
 * window with a stable reason code.
 */
export async function fetchFrontRecoveryPageWithRetry(
  args: RecoveryPageFetchArgs,
): Promise<RecoveryPageFetchResult> {
  const { pageUrl, windowLabel, pageNumber } = args;
  const jobTag = args.jobTag ?? "";
  const timeoutMs = args.signalTimeoutMs ?? FETCH_TIMEOUT_MS;
  const requestUrl = pageUrl.startsWith("http") ? pageUrl : `${FRONT_API_BASE}${pageUrl}`;

  let attempt = 0;
  let rateLimitAttempts = 0;
  let forceRefreshAlreadyTried = false;
  // Task #1869 Step 2 — One-shot soft-gate probe: if a 401 persists
  // even after the forced refresh we don't immediately classify the
  // window as `front_not_connected`. Instead we run one cheap `/me`
  // probe; if Front confirms the connection is healthy the 401 was a
  // transient race and we retry the page one more time.
  let softGateProbeTried = false;
  let refreshedDuringFetch = false;
  let lastTransientError: FrontRecoveryFetchError | null = null;
  // Task #1016: per-page counters rolled into the window checkpoint by
  // the caller. Both success and error paths must surface these so the
  // admin UI can show "this window retried N times for reason X" even
  // when the page ultimately failed.
  const retriesByReason: Record<string, number> = {};
  let tokenRefreshes = 0;
  const recordRetry = (reason: FrontRecoveryRetryReason) => {
    retriesByReason[reason] = (retriesByReason[reason] ?? 0) + 1;
  };
  const attachCounters = (err: FrontRecoveryFetchError) => {
    err.retriesByReason = { ...retriesByReason };
    err.tokenRefreshes = tokenRefreshes;
    return err;
  };

  while (attempt < PAGE_FETCH_MAX_ATTEMPTS) {
    attempt++;
    let token: string;
    try {
      // Per-page token fetch — when the cached token is still valid this
      // is essentially a single setting read, so the cost is bounded.
      // Track refreshes via onRefresh so expiry-driven refreshes (not
      // just 401-forced ones) appear in the recovery log.
      token = await getValidFrontAccessToken({
        purpose: "historical_recovery",
        onRefresh: ({ reason }) => {
          refreshedDuringFetch = true;
          tokenRefreshes++;
          console.log(
            `[FrontRecovery] ${jobTag}Token refreshed during recovery (${reason}): window=${windowLabel} page=${pageNumber}`,
          );
        },
      });
    } catch (err) {
      if (err instanceof FrontAuthError) {
        if (err.code === "front_refresh_failed_transient") {
          recordRetry("auth_refresh_transient");
          lastTransientError = attachCounters(
            new FrontRecoveryFetchError(
              "front_auth_refresh_transient",
              err.message,
              { retryable: true },
            ),
          );
          await delayWithBackoff(attempt);
          continue;
        }
        if (err.code === "front_not_connected" || err.code === "front_no_refresh_token") {
          throw attachCounters(
            new FrontRecoveryFetchError("front_not_connected", err.message),
          );
        }
        // permanent refresh failure
        throw attachCounters(
          new FrontRecoveryFetchError("front_auth_refresh_failed", err.message),
        );
      }
      throw err;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (isAbortOrNetworkError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const code = isTimeout ? "front_timeout" : "front_network_error";
        const exhaustedReason = isTimeout
          ? "front_timeout_retry_exhausted"
          : "front_network_retry_exhausted";
        recordRetry(isTimeout ? "timeout" : "network");
        lastTransientError = attachCounters(
          new FrontRecoveryFetchError(
            exhaustedReason,
            `Front API ${code} on window=${windowLabel} page=${pageNumber}`,
            { retryable: true },
          ),
        );
        if (attempt < PAGE_FETCH_MAX_ATTEMPTS) {
          const waitMs = await delayWithBackoff(attempt);
          console.warn(
            `[FrontRecovery] ${jobTag}Page retry: window=${windowLabel} page=${pageNumber} attempt=${attempt}/${PAGE_FETCH_MAX_ATTEMPTS} reason=${code} backoff=${waitMs}ms msg=${msg.slice(0, 200)}`,
          );
          continue;
        }
        console.warn(
          `[FrontRecovery] ${jobTag}Page retry: window=${windowLabel} page=${pageNumber} attempt=${attempt}/${PAGE_FETCH_MAX_ATTEMPTS} reason=${code} (final) msg=${msg.slice(0, 200)}`,
        );
        throw attachCounters(lastTransientError);
      }
      throw err;
    }
    clearTimeout(timeout);

    const requestId = res.headers.get("x-request-id") || res.headers.get("request-id") || null;

    if (res.ok) {
      const data = (await res.json()) as any;
      return {
        conversations: data._results || [],
        nextPageUrl: data._pagination?.next || null,
        refreshedDuringFetch,
        retriesByReason: { ...retriesByReason },
        tokenRefreshes,
      };
    }

    // Drain body for diagnostics. Always truncate.
    const text = await res.text().catch(() => "");
    const bodySnippet = text.length > 300 ? `${text.slice(0, 300)}…` : text;

    if (res.status === 401) {
      if (!forceRefreshAlreadyTried) {
        forceRefreshAlreadyTried = true;
        // Task #2100 — throttle. A revoked-token flood 401s on every
        // recovery page across every window; capping to one line per
        // breaker window stops the historical-recovery worker from
        // contributing thousands of identical warns.
        if (shouldLogFrontAuth("front_recovery_401_refresh")) {
          console.warn(
            `[FrontRecovery] ${jobTag}Forced token refresh after 401: window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""}`,
          );
        }
        try {
          await getValidFrontAccessToken({ forceRefresh: true, purpose: "historical_recovery" });
          refreshedDuringFetch = true;
          tokenRefreshes++;
          // Retry the same page immediately — do not consume a regular
          // attempt slot since this is the dedicated 401-recovery slot.
          attempt--;
          continue;
        } catch (err) {
          if (err instanceof FrontAuthError) {
            if (err.code === "front_refresh_failed_transient") {
              recordRetry("auth_refresh_transient");
              lastTransientError = attachCounters(
                new FrontRecoveryFetchError(
                  "front_auth_refresh_transient",
                  err.message,
                  { retryable: true },
                ),
              );
              await delayWithBackoff(attempt);
              continue;
            }
            // Any non-transient auth failure (true disconnect, missing
            // refresh token, or permanent refresh rejection like
            // invalid_grant / revoked) maps to the canonical
            // `front_not_connected` reason so the operator UX wording
            // is consistent regardless of which underlying error fired.
            throw attachCounters(
              new FrontRecoveryFetchError(
                "front_not_connected",
                "Front is not connected. Reconnect Front before continuing.",
              ),
            );
          }
          throw err;
        }
      }
      // Task #1869 Step 2 — Before classifying a persistent 401 as
      // terminal, run one cheap `/me` probe. If Front confirms the
      // connection is healthy, the 401 was a refresh-race artifact —
      // record `auth_race_recovered` and retry the page once more.
      if (!softGateProbeTried) {
        softGateProbeTried = true;
        try {
          const { probeConnection } = await import("./frontIntegration");
          const probe = await probeConnection();
          if (probe.outcome === "connected") {
            recordRetry("auth_race_recovered");
            console.warn(
              `[FrontRecovery] ${jobTag}front_recovery_auth_race_recovered window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""} — /me probe healthy after 2× 401; retrying page`,
            );
            // Don't consume an attempt slot — this is the dedicated
            // soft-gate retry. Reset force-refresh latch so a future
            // 401 in the same page can still trigger one more forced
            // refresh if needed.
            attempt--;
            forceRefreshAlreadyTried = false;
            continue;
          }
          console.warn(
            `[FrontRecovery] ${jobTag}front_recovery_auth_probe_unhealthy window=${windowLabel} page=${pageNumber} outcome=${probe.outcome} reason=${probe.reason ?? "n/a"}`,
          );
        } catch (probeErr: any) {
          console.warn(
            `[FrontRecovery] ${jobTag}front_recovery_auth_probe_error window=${windowLabel} page=${pageNumber}: ${probeErr?.message ?? String(probeErr)}`,
          );
        }
      }
      // Already tried a forced refresh AND the soft-gate probe failed —
      // this is a real auth failure.
      throw attachCounters(
        new FrontRecoveryFetchError(
          "front_auth_unauthorized_after_refresh",
          `Front API 401 after forced refresh: window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""}: ${bodySnippet || "<empty body>"}`,
          { status: 401, requestId },
        ),
      );
    }

    if (res.status === 429) {
      rateLimitAttempts++;
      recordRetry("front_429");
      if (rateLimitAttempts > PAGE_FETCH_429_MAX_ATTEMPTS) {
        throw attachCounters(
          new FrontRecoveryFetchError(
            "front_429_retry_exhausted",
            `Front API 429 retry exhausted: window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""}`,
            { status: 429, requestId },
          ),
        );
      }
      const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
      console.warn(
        `[FrontRecovery] ${jobTag}Rate limited: window=${windowLabel} page=${pageNumber} attempt=${rateLimitAttempts}/${PAGE_FETCH_429_MAX_ATTEMPTS} reason=front_429 wait=${retryAfter}s`,
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      // Don't consume a regular attempt slot for 429.
      attempt--;
      continue;
    }

    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const code = `front_${res.status}`;
      const reasonKey: FrontRecoveryRetryReason =
        res.status === 502 ? "front_502" : res.status === 503 ? "front_503" : "front_504";
      recordRetry(reasonKey);
      lastTransientError = attachCounters(
        new FrontRecoveryFetchError(
          "front_5xx_retry_exhausted",
          `Front API ${res.status}: window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""}: ${bodySnippet || "<empty body>"}`,
          { retryable: true, status: res.status, requestId },
        ),
      );
      if (attempt < PAGE_FETCH_MAX_ATTEMPTS) {
        const waitMs = await delayWithBackoff(attempt);
        console.warn(
          `[FrontRecovery] ${jobTag}Page retry: window=${windowLabel} page=${pageNumber} attempt=${attempt}/${PAGE_FETCH_MAX_ATTEMPTS} reason=${code} backoff=${waitMs}ms${requestId ? ` req=${requestId}` : ""}`,
        );
        continue;
      }
      console.warn(
        `[FrontRecovery] ${jobTag}Page retry: window=${windowLabel} page=${pageNumber} attempt=${attempt}/${PAGE_FETCH_MAX_ATTEMPTS} reason=${code} (final)${requestId ? ` req=${requestId}` : ""}`,
      );
      throw attachCounters(lastTransientError);
    }

    // Non-retryable error (400/403/404/etc). Surface as-is.
    throw attachCounters(
      new FrontRecoveryFetchError(
        `front_api_${res.status}`,
        `Front API ${res.status} on window=${windowLabel} page=${pageNumber}${requestId ? ` req=${requestId}` : ""}: ${bodySnippet || "<empty body>"}`,
        { status: res.status, requestId },
      ),
    );
  }

  // Loop exit without a return means we exhausted attempts.
  throw attachCounters(
    lastTransientError ??
      new FrontRecoveryFetchError(
        "front_5xx_retry_exhausted",
        `Front recovery page retry exhausted: window=${windowLabel} page=${pageNumber}`,
        { retryable: true },
      ),
  );
}

async function delayWithBackoff(attempt: number): Promise<number> {
  const idx = Math.min(attempt - 1, PAGE_FETCH_BACKOFF_MS.length - 1);
  const base = PAGE_FETCH_BACKOFF_MS[Math.max(0, idx)];
  // Small jitter to avoid synchronized retries (±20%).
  const ms = Math.round(base * (0.8 + Math.random() * 0.4));
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

export interface RecoveryWindow {
  label: string;
  afterTimestamp: number;
  beforeTimestamp: number;
}

export interface CoverageMonth {
  month: string;
  frontSyncCount: number;
  rawCommCount: number;
  pipelineEventCount: number;
  totalCoverage: number;
}

export interface CoverageReport {
  months: CoverageMonth[];
  gaps: RecoveryWindow[];
  totalFrontSync: number;
  totalRawComm: number;
  totalPipelineEvents: number;
  earliestRecord: string | null;
  latestRecord: string | null;
  generatedAt: string;
}

export type WindowStatus =
  | "pending"
  | "running"
  | "complete"
  | "empty_source"
  | "blocked"
  | "partial"
  | "failed";

export interface WindowCheckpoint {
  windowLabel: string;
  afterTimestamp: number;
  beforeTimestamp: number;
  status: WindowStatus;
  statusReason: string | null;
  scanned: number;
  ingested: number;
  skipped: number;
  errors: string[];
  pages: number;
  lastPageUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  // Task #1016: per-window resilience telemetry. Counters accumulate
  // across pages and survive resume/auto-continue via the persisted
  // checkpoint. Both fields are optional so older saved checkpoints
  // hydrate cleanly without migration.
  retriesByReason?: Record<string, number>;
  totalRetries?: number;
  tokenRefreshes?: number;
  // Task #1084: per-window retry-pressure alert history. Each entry
  // records one evaluation that crossed the threshold (whether it
  // actually dispatched or was suppressed downstream). Trivial skips
  // ("below threshold", "already alerted") are intentionally not
  // recorded here so the timeline only shows operator-actionable
  // events. Optional so older persisted checkpoints hydrate cleanly.
  retryPressureAlerts?: Array<{
    at: string;
    decision:
      | "alerted"
      | "skipped_disabled"
      | "skipped_send_failed"
      | "skipped_dispatcher_skipped"
      | "skipped_no_counters";
    totalRetries: number;
    threshold: number;
    skipReason?: string;
  }>;
}

export type RecoveryJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "partial"
  | "blocked"
  | "failed";

export interface RecoveryJobState {
  jobId: string;
  status: RecoveryJobStatus;
  statusReason: string | null;
  dryRun: boolean;
  coverageReport: CoverageReport | null;
  windows: WindowCheckpoint[];
  totals: { scanned: number; ingested: number; skipped: number; errors: number; pages: number };
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  requestedCustomWindows: RecoveryWindow[] | null;
  // Task #989: continuation lineage. All optional so older persisted jobs
  // hydrate cleanly without migration.
  continuesJobId?: string;
  continuationType?: "manual" | "auto";
  autoContinueAttempt?: number;
  autoContinueLineageRootJobId?: string;
  // Used by the auto-continue sweep to detect no-progress loops.
  lastProgressFingerprint?: string;
  lastGapMonthsSnapshot?: string[];
}

// Task #989: machine-readable classification of why a recovery job ended
// in `partial`. Drives both UI wording and auto-continue eligibility.
export type PartialReasonClassification =
  | "transient"
  | "non_transient"
  | "checkpoint_required"
  | "unknown";

export interface PartialReasonInfo {
  machineReason: string;
  humanReason: string;
  classification: PartialReasonClassification;
  hasResumableCheckpoint: boolean;
}

const KNOWN_PARTIAL_REASON_MAP: Array<{
  match: (raw: string) => boolean;
  human: string;
  classification: PartialReasonClassification;
}> = [
  {
    match: (r) => r.includes("safety_max_pages_reached_resume_available"),
    human: "Hit safety cap of 500 pages — more results are available.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("interrupted_by_server_restart"),
    human: "Interrupted by server restart.",
    classification: "transient",
  },
  // NOTE: order matters — most specific 5xx codes are checked before the
  // generic 5xx fallback so e.g. a 503 isn't humanized as a "502".
  {
    match: (r) => /front[_ ]?api[_ ]?504/i.test(r) || r.includes("gateway_timeout"),
    human: "Front API returned a temporary gateway timeout mid-run.",
    classification: "transient",
  },
  {
    match: (r) => /front[_ ]?api[_ ]?503/i.test(r) || r.includes("service_unavailable"),
    human: "Front API returned a temporary 503 error mid-run.",
    classification: "transient",
  },
  {
    match: (r) => /front[_ ]?api[_ ]?502/i.test(r) || r.includes("bad_gateway"),
    human: "Front API returned a temporary 502 error mid-run.",
    classification: "transient",
  },
  {
    // Generic 5xx fallback for any other Front 5xx surface, after the
    // explicit 502/503/504 matchers above. Excludes 401/403 deliberately.
    match: (r) => /front[_ ]?api[_ ]?5\d{2}/i.test(r),
    human: "Front API returned a temporary server error mid-run.",
    classification: "transient",
  },
  // Task #1015: stable internal codes emitted by the per-page retry
  // helper. Listed before the looser timeout / 5xx fallbacks so the
  // humanized message reflects the retry-exhaustion context.
  {
    match: (r) => r.includes("front_timeout_retry_exhausted"),
    human: "Front API kept timing out after multiple retries.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("front_5xx_retry_exhausted"),
    human: "Front API returned repeated temporary server errors after retries.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("front_network_retry_exhausted"),
    human: "Front API network errors recurred after retries.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("front_429_retry_exhausted"),
    human: "Front API rate limit retries were exhausted.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("front_auth_refresh_transient"),
    // After page-level retries are exhausted there are no further
    // automatic retries inside this run — the window is left in
    // `partial` so a subsequent scheduled run (or manual continue) can
    // resume from the preserved checkpoint. Wording reflects that.
    human: "Front token refresh failed temporarily — recovery paused; the next run will resume from this page.",
    classification: "transient",
  },
  // Task #1024: pg-pool saturation surfaces both as the canonical
  // `db_pool_saturated:` reason emitted by the recovery loop and as the
  // legacy `db_pool_contended:` prefix preserved alongside fatal errors.
  // Both must humanize to the same operator-facing wording so the admin
  // panel doesn't mislabel a recoverable pool stall as a generic timeout.
  // Listed before the generic `/timeout|aborted/` matcher because
  // pg-pool messages contain the substring "timeout".
  {
    match: (r) => r.includes("db_pool_saturated") || r.includes("db_pool_contended"),
    human: "Database connection pool was saturated mid-run — recovery paused; resume will continue from the same page.",
    classification: "transient",
  },
  {
    match: (r) => /timeout|timed out|aborted/i.test(r) && !/401|403/.test(r),
    human: "Front API request timed out.",
    classification: "transient",
  },
  {
    match: (r) => r.includes("front_not_connected"),
    human: "Front is not connected. Reconnect Front before continuing.",
    classification: "non_transient",
  },
  {
    match: (r) => r.includes("front_auth_refresh_failed"),
    human: "Front authorization failed. Reconnect Front before continuing.",
    classification: "non_transient",
  },
  {
    match: (r) => r.includes("front_auth_unauthorized_after_refresh"),
    human: "Front authorization failed. Reconnect Front before continuing.",
    classification: "non_transient",
  },
  {
    match: (r) => /front_api_40[13]/i.test(r) || /\b40[13]\b/.test(r),
    human: "Front authorization failed. Reconnect Front before continuing.",
    classification: "non_transient",
  },
  {
    match: (r) => r.includes("all_windows_failed") || r.includes("fatal_error"),
    human: "Recovery hit a fatal error mid-run.",
    classification: "unknown",
  },
];

export function hasResumableCheckpoint(job: RecoveryJobState): boolean {
  if (!Array.isArray(job.windows)) return false;
  return job.windows.some(
    (w) => typeof w.lastPageUrl === "string" && w.lastPageUrl.length > 0,
  );
}

function pickWindowReason(job: RecoveryJobState): string | null {
  if (!Array.isArray(job.windows) || job.windows.length === 0) return null;
  // Prefer the most informative reason: partial > failed > blocked > others.
  const order: WindowStatus[] = ["partial", "failed", "blocked", "empty_source", "running", "complete", "pending"];
  for (const status of order) {
    const match = job.windows.find((w) => w.status === status && w.statusReason);
    if (match?.statusReason) return match.statusReason;
  }
  // Fallback to first/last window error.
  const firstErr = job.windows.map((w) => w.errors?.[0]).find((e) => !!e);
  if (firstErr) return firstErr;
  return null;
}

export function derivePartialReason(job: RecoveryJobState): string {
  // Priority: explicit job-level statusReason if specific, then most
  // informative window-level reason, then first window error, then a
  // generic fallback.
  const jobReason = (job.statusReason ?? "").trim();
  const isGeneric =
    !jobReason ||
    jobReason === "queued_pending_coverage_scan" ||
    jobReason === "scanning_coverage" ||
    jobReason.startsWith("mixed_outcomes:");
  if (jobReason && !isGeneric) return jobReason;
  const winReason = pickWindowReason(job);
  if (winReason) return winReason;
  if (jobReason) return jobReason;
  return "partial_no_specific_reason";
}

export function classifyPartialReason(reason: string): PartialReasonClassification {
  const r = (reason ?? "").toLowerCase();
  for (const entry of KNOWN_PARTIAL_REASON_MAP) {
    if (entry.match(r)) return entry.classification;
  }
  return "unknown";
}

export function humanizePartialReason(
  reason: string,
  job?: RecoveryJobState,
): string {
  const r = (reason ?? "").trim();
  if (!r) {
    if (job && !hasResumableCheckpoint(job)) {
      return "Stopped before a resumable checkpoint was saved.";
    }
    return "Stopped partway through — see logs for details.";
  }
  for (const entry of KNOWN_PARTIAL_REASON_MAP) {
    if (entry.match(r.toLowerCase())) return entry.human;
  }
  if (job && !hasResumableCheckpoint(job)) {
    return "Stopped before a resumable checkpoint was saved.";
  }
  // Readable fallback. Keep raw machine reason short.
  const trimmed = r.length > 200 ? `${r.slice(0, 200)}…` : r;
  return `Recovery stopped before finishing (${trimmed}).`;
}

export interface RecoveryJobSummaryFields {
  partialReason?: string;
  humanPartialReason?: string;
  reasonClassification?: PartialReasonClassification;
  hasResumableCheckpoint: boolean;
  // Auto-continue eligibility: partial-ish + checkpoint + transient/checkpoint_required.
  canResume: boolean;
  // Manual resume eligibility: same as canResume, plus a non_transient
  // failure becomes resumable once the operator has reconnected Front.
  canManualResume: boolean;
  autoContinueMaxAttempts?: number;
}

export async function summarizeRecoveryJob(
  job: RecoveryJobState,
): Promise<RecoveryJobState & RecoveryJobSummaryFields> {
  const isPartialish = job.status === "partial" || job.status === "blocked" || job.status === "failed";
  const checkpoint = hasResumableCheckpoint(job);
  let partialReason: string | undefined;
  let humanPartialReason: string | undefined;
  let reasonClassification: PartialReasonClassification | undefined;
  if (isPartialish) {
    partialReason = derivePartialReason(job);
    reasonClassification = classifyPartialReason(partialReason);
    if (!checkpoint && reasonClassification !== "non_transient") {
      reasonClassification = "checkpoint_required";
    }
    humanPartialReason = humanizePartialReason(partialReason, job);
  }
  // canResume governs background auto-continue: never auto-resume a
  // non_transient failure (the operator must intervene first).
  const canResume =
    isPartialish &&
    checkpoint &&
    reasonClassification !== "non_transient";
  // canManualResume relaxes the non_transient block when the operator
  // has reconnected Front since the failure — manual resume from the
  // saved checkpoint is then safe and is the desired UX.
  let canManualResume = canResume;
  if (
    isPartialish &&
    checkpoint &&
    reasonClassification === "non_transient"
  ) {
    try {
      const { isConnected } = await import("./frontIntegration");
      if (await isConnected()) canManualResume = true;
    } catch {
      // If we can't determine connectivity, leave the non_transient
      // block in place (fail closed for manual resume).
    }
  }
  let max: number | undefined;
  try {
    max = await getRecoveryAutoContinueMaxAttempts();
  } catch {
    max = undefined;
  }
  // Enrich each window with a humanized reason so the per-window panel
  // matches job-level wording (acceptance criterion #989).
  const enrichedWindows = Array.isArray(job.windows)
    ? job.windows.map((w) => ({
        ...w,
        humanStatusReason: w.statusReason
          ? humanizePartialReason(w.statusReason)
          : undefined,
        statusReasonClassification: w.statusReason
          ? classifyPartialReason(w.statusReason)
          : undefined,
      }))
    : job.windows;
  return {
    ...job,
    windows: enrichedWindows as typeof job.windows,
    partialReason,
    humanPartialReason,
    reasonClassification,
    hasResumableCheckpoint: checkpoint,
    canResume,
    canManualResume,
    autoContinueMaxAttempts: max,
  };
}

const recoveryJobs = new Map<string, RecoveryJobState>();

// Warp-drain (2026-05-26): cap on concurrent historical-recovery jobs.
// Default 3 — modest parallelism that respects Front rate-limit guard
// (one concurrent job × ingest concurrency 2 = max ~6 simultaneous Front
// API readers across all jobs, well under Front's 50 req/sec ceiling).
// Operator override via `front_recovery_max_concurrent_jobs` system_setting.
export async function getMaxConcurrentRecoveryJobsForAutoClosure(): Promise<number> {
  return getMaxConcurrentRecoveryJobs();
}

// Typed error so callers (auto-closure catch, integrations route) can
// distinguish expected concurrency back-pressure from real engine failures.
// Treat as 409/in_flight, NOT as a self-error or 500. Carries the observed
// running count and cap so log/Slack panels can render the cause.
export class RecoveryConcurrencyCapError extends Error {
  readonly code = "RECOVERY_CAP_REACHED" as const;
  constructor(public readonly runningCount: number, public readonly cap: number) {
    super(
      `Recovery job cap reached (${runningCount}/${cap} running). Raise front_recovery_max_concurrent_jobs to allow more.`,
    );
    this.name = "RecoveryConcurrencyCapError";
  }
}

async function getMaxConcurrentRecoveryJobs(): Promise<number> {
  try {
    const row = await storage.getSystemSetting("front_recovery_max_concurrent_jobs");
    const n = row?.value ? Number(row.value) : NaN;
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  } catch {
    // fall through to default on any read failure
  }
  return 3;
}

const JOB_INDEX_KEY = "front_recovery_jobs_index";
const JOB_KEY_PREFIX = "front_recovery_job_";
const MAX_PERSISTED_JOBS = 20;

export const RECOVERY_MAX_AGE_DAYS_KEY = "front_recovery_max_age_days";
export const DEFAULT_RECOVERY_MAX_AGE_DAYS = 30;
export const MIN_RECOVERY_MAX_AGE_DAYS = 1;
export const MAX_RECOVERY_MAX_AGE_DAYS = 3650;

let cachedMaxAgeDays: { value: number; ts: number } | null = null;
const MAX_AGE_CACHE_TTL_MS = 30_000;

export async function getRecoveryMaxAgeDays(): Promise<number> {
  const now = Date.now();
  if (cachedMaxAgeDays && now - cachedMaxAgeDays.ts < MAX_AGE_CACHE_TTL_MS) {
    return cachedMaxAgeDays.value;
  }
  try {
    const setting = await storage.getSystemSetting(RECOVERY_MAX_AGE_DAYS_KEY);
    if (setting?.value) {
      const parsed = Number(setting.value);
      if (
        Number.isFinite(parsed) &&
        Number.isInteger(parsed) &&
        parsed >= MIN_RECOVERY_MAX_AGE_DAYS &&
        parsed <= MAX_RECOVERY_MAX_AGE_DAYS
      ) {
        cachedMaxAgeDays = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  cachedMaxAgeDays = { value: DEFAULT_RECOVERY_MAX_AGE_DAYS, ts: now };
  return DEFAULT_RECOVERY_MAX_AGE_DAYS;
}

export async function setRecoveryMaxAgeDays(
  days: number,
  updatedBy?: string,
): Promise<number> {
  if (
    !Number.isFinite(days) ||
    !Number.isInteger(days) ||
    days < MIN_RECOVERY_MAX_AGE_DAYS ||
    days > MAX_RECOVERY_MAX_AGE_DAYS
  ) {
    throw new Error(
      `max age must be an integer between ${MIN_RECOVERY_MAX_AGE_DAYS} and ${MAX_RECOVERY_MAX_AGE_DAYS} days`,
    );
  }
  await storage.setSystemSetting(RECOVERY_MAX_AGE_DAYS_KEY, String(days), updatedBy ?? "system");
  cachedMaxAgeDays = { value: days, ts: Date.now() };
  return days;
}

function jobReferenceTime(job: RecoveryJobState): number {
  const ref = job.completedAt ?? job.startedAt;
  const t = ref ? new Date(ref).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function isJobActive(job: RecoveryJobState): boolean {
  return job.status === "running" || job.status === "queued";
}

export async function pruneExpiredRecoveryJobs(): Promise<{ pruned: number; ids: string[] }> {
  await hydrateRecoveryJobs();
  const ids = await pruneExpiredJobs();
  if (ids.length > 0) await writeJobIndex();
  return { pruned: ids.length, ids };
}

export const RECOVERY_PRUNE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export const RECOVERY_PRUNE_INTERVAL_MINUTES_KEY = "front_recovery_prune_interval_minutes";
export const DEFAULT_RECOVERY_PRUNE_INTERVAL_MINUTES = 60;
export const MIN_RECOVERY_PRUNE_INTERVAL_MINUTES = 5;
export const MAX_RECOVERY_PRUNE_INTERVAL_MINUTES = 1440;

let cachedPruneIntervalMinutes: { value: number; ts: number } | null = null;
const PRUNE_INTERVAL_CACHE_TTL_MS = 30_000;

export async function getRecoveryPruneIntervalMinutes(): Promise<number> {
  const now = Date.now();
  if (cachedPruneIntervalMinutes && now - cachedPruneIntervalMinutes.ts < PRUNE_INTERVAL_CACHE_TTL_MS) {
    return cachedPruneIntervalMinutes.value;
  }
  try {
    const setting = await storage.getSystemSetting(RECOVERY_PRUNE_INTERVAL_MINUTES_KEY);
    if (setting?.value) {
      const parsed = Number(setting.value);
      if (
        Number.isFinite(parsed) &&
        Number.isInteger(parsed) &&
        parsed >= MIN_RECOVERY_PRUNE_INTERVAL_MINUTES &&
        parsed <= MAX_RECOVERY_PRUNE_INTERVAL_MINUTES
      ) {
        cachedPruneIntervalMinutes = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  cachedPruneIntervalMinutes = { value: DEFAULT_RECOVERY_PRUNE_INTERVAL_MINUTES, ts: now };
  return DEFAULT_RECOVERY_PRUNE_INTERVAL_MINUTES;
}

export async function setRecoveryPruneIntervalMinutes(
  minutes: number,
  updatedBy?: string,
): Promise<number> {
  if (
    !Number.isFinite(minutes) ||
    !Number.isInteger(minutes) ||
    minutes < MIN_RECOVERY_PRUNE_INTERVAL_MINUTES ||
    minutes > MAX_RECOVERY_PRUNE_INTERVAL_MINUTES
  ) {
    throw new Error(
      `prune interval must be an integer between ${MIN_RECOVERY_PRUNE_INTERVAL_MINUTES} and ${MAX_RECOVERY_PRUNE_INTERVAL_MINUTES} minutes`,
    );
  }
  await storage.setSystemSetting(
    RECOVERY_PRUNE_INTERVAL_MINUTES_KEY,
    String(minutes),
    updatedBy ?? "system",
  );
  cachedPruneIntervalMinutes = { value: minutes, ts: Date.now() };
  return minutes;
}

// Task #989: limit how many times the background sweep can chain
// auto-continuations within the same partial-recovery lineage. Operators
// can tune this in the admin UI; default 5, valid range 1–20.
export const RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY =
  "front_recovery_auto_continue_max_attempts";
export const DEFAULT_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS = 5;
export const MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS = 1;
export const MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS = 20;

let cachedAutoContinueMax: { value: number; ts: number } | null = null;
const AUTO_CONTINUE_CACHE_TTL_MS = 30_000;

export async function getRecoveryAutoContinueMaxAttempts(): Promise<number> {
  const now = Date.now();
  if (
    cachedAutoContinueMax &&
    now - cachedAutoContinueMax.ts < AUTO_CONTINUE_CACHE_TTL_MS
  ) {
    return cachedAutoContinueMax.value;
  }
  try {
    const setting = await storage.getSystemSetting(
      RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY,
    );
    if (setting?.value) {
      const parsed = Number(setting.value);
      if (
        Number.isFinite(parsed) &&
        Number.isInteger(parsed) &&
        parsed >= MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS &&
        parsed <= MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS
      ) {
        cachedAutoContinueMax = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  cachedAutoContinueMax = {
    value: DEFAULT_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
    ts: now,
  };
  return DEFAULT_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS;
}

export async function setRecoveryAutoContinueMaxAttempts(
  value: number,
  updatedBy?: string,
): Promise<number> {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS ||
    value > MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS
  ) {
    throw new Error(
      `auto-continue max attempts must be an integer between ${MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS} and ${MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS}`,
    );
  }
  await storage.setSystemSetting(
    RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY,
    String(value),
    updatedBy ?? "system",
  );
  cachedAutoContinueMax = { value, ts: Date.now() };
  return value;
}

let recoverySweepTimer: ReturnType<typeof setInterval> | null = null;
let recoverySweepIntervalMs: number = RECOVERY_PRUNE_SWEEP_INTERVAL_MS;
let recoverySweepInFlight = false;
let lastSweepAt: string | null = null;
let lastSweepPrunedCount = 0;
let lastSweepError: string | null = null;
let lastSweepAutoResumedCount = 0;
let lastSweepSkippedCount = 0;
let lastSweepContinuedJobIds: string[] = [];

async function runRecoveryPruneSweep(): Promise<void> {
  if (recoverySweepInFlight) return;
  // Task #836 Phase 2: this is a non-critical maintenance sweep — when
  // the operator engages the kill switch we skip the tick entirely.
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return;
  }
  recoverySweepInFlight = true;
  let pruned = 0;
  let autoResumed = 0;
  let skipped = 0;
  let continuedIds: string[] = [];
  try {
    const result = await pruneExpiredRecoveryJobs();
    pruned = result.pruned;
    if (pruned > 0) {
      console.log(
        `[FrontRecovery] Periodic sweep pruned ${pruned} expired job(s): ${result.ids.join(", ")}`,
      );
    }
    // Task #989: try to auto-continue partial jobs after pruning. Errors
    // here are logged and tracked, never propagated — the prune branch
    // already succeeded and we don't want sweep status to flip to error.
    try {
      const auto = await autoContinuePartialRecoveryJobs();
      autoResumed = auto.continuedJobIds.length;
      skipped = auto.skipped;
      continuedIds = auto.continuedJobIds;
    } catch (autoErr: any) {
      console.error("[FrontRecovery] Auto-continue branch failed:", autoErr);
    }
    lastSweepAt = new Date().toISOString();
    lastSweepPrunedCount = pruned;
    lastSweepAutoResumedCount = autoResumed;
    lastSweepSkippedCount = skipped;
    lastSweepContinuedJobIds = continuedIds;
    lastSweepError = null;
    // Always emit one summary line per tick (even all-zero outcomes) so
    // operators can confirm the sweep ran and see its decision.
    console.log(
      `[FrontRecovery] Periodic sweep complete: pruned=${pruned} autoResumed=${autoResumed} skipped=${skipped} continuedJobIds=[${continuedIds.join(",")}]`,
    );
  } catch (err: any) {
    lastSweepError = err?.message ?? String(err);
    console.error("[FrontRecovery] Periodic prune sweep failed:", err);
  } finally {
    recoverySweepInFlight = false;
  }
}

export function startRecoveryPruneSweep(
  intervalMs: number = RECOVERY_PRUNE_SWEEP_INTERVAL_MS,
  options?: { runImmediately?: boolean },
): void {
  if (recoverySweepTimer !== null) return;
  const ms = Math.max(60_000, intervalMs);
  recoverySweepIntervalMs = ms;
  console.log(
    `[FrontRecovery] Starting periodic prune sweep every ${Math.round(ms / 60_000)}min`,
  );
  recoverySweepTimer = setInterval(() => {
    // Task #1723 Phase 2.3: route the maintenance sweep's storage
    // calls (pruneExpiredRecoveryJobs, autoContinuePartialRecoveryJobs)
    // through the worker pool. `withDbAttribution` only labels;
    // `runWithWorkerDb` is what actually switches the ambient `getDb()`.
    void runWithWorkerDb(() =>
      withDbAttribution("maintenance:front-historical-recovery-prune", () =>
        runRecoveryPruneSweep(),
      ),
    );
  }, ms);
  if (typeof recoverySweepTimer.unref === "function") {
    recoverySweepTimer.unref();
  }
  if (options?.runImmediately !== false) {
    void runWithWorkerDb(() => runRecoveryPruneSweep());
  }
}

export async function startRecoveryPruneSweepFromSettings(
  options?: { runImmediately?: boolean },
): Promise<void> {
  const minutes = await getRecoveryPruneIntervalMinutes();
  startRecoveryPruneSweep(minutes * 60_000, options);
}

export async function restartRecoveryPruneSweepFromSettings(
  options?: { runImmediately?: boolean },
): Promise<void> {
  stopRecoveryPruneSweep();
  await startRecoveryPruneSweepFromSettings(options);
}

export function stopRecoveryPruneSweep(): void {
  if (recoverySweepTimer !== null) {
    clearInterval(recoverySweepTimer);
    recoverySweepTimer = null;
    console.log("[FrontRecovery] Periodic prune sweep stopped");
  }
}

export function isRecoveryPruneSweepRunning(): boolean {
  return recoverySweepTimer !== null;
}

export function isRecoveryPruneSweepInFlight(): boolean {
  return recoverySweepInFlight;
}

export interface ManualRecoveryPruneSweepResult {
  ran: boolean;
  alreadyInFlight: boolean;
  prunedCount: number;
  lastSweepAt: string | null;
  lastError: string | null;
}

export async function triggerRecoveryPruneSweepNow(): Promise<ManualRecoveryPruneSweepResult> {
  if (recoverySweepInFlight) {
    return {
      ran: false,
      alreadyInFlight: true,
      prunedCount: lastSweepPrunedCount,
      lastSweepAt,
      lastError: lastSweepError,
    };
  }
  await runRecoveryPruneSweep();
  return {
    ran: true,
    alreadyInFlight: false,
    prunedCount: lastSweepPrunedCount,
    lastSweepAt,
    lastError: lastSweepError,
  };
}

export interface RecoveryPruneSweepStatus {
  running: boolean;
  inFlight: boolean;
  intervalMs: number;
  lastSweepAt: string | null;
  lastPrunedCount: number;
  lastError: string | null;
  // Task #989: auto-continue branch metrics from the most recent sweep.
  lastAutoResumedCount: number;
  lastSkippedCount: number;
  lastContinuedJobIds: string[];
  // Task #1708: surface paused-by-operator signals so the always-visible
  // Auto-heal banner can show "paused" (amber) instead of misreporting
  // "healthy" while the sweep is effectively neutered by a kill switch
  // or queue-drain pause.
  paused: boolean;
  pauseReasons: string[];
}

export function getRecoveryPruneSweepStatus(): RecoveryPruneSweepStatus {
  const pauseReasons: string[] = [];
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    pauseReasons.push("kill_switch_non_critical_sweeps");
  }
  try {
    // Lazy import to avoid an ordering cycle at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isQueuePaused } = require("./queueDrainControl") as typeof import("./queueDrainControl");
    if (isQueuePaused("front_historical_recovery")) {
      pauseReasons.push("queue_drain_paused");
    }
  } catch {
    // queueDrainControl is optional in some unit-test contexts.
  }
  return {
    running: recoverySweepTimer !== null,
    inFlight: recoverySweepInFlight,
    intervalMs: recoverySweepIntervalMs,
    lastSweepAt,
    lastPrunedCount: lastSweepPrunedCount,
    lastError: lastSweepError,
    lastAutoResumedCount: lastSweepAutoResumedCount,
    lastSkippedCount: lastSweepSkippedCount,
    lastContinuedJobIds: [...lastSweepContinuedJobIds],
    paused: pauseReasons.length > 0,
    pauseReasons,
  };
}

async function pruneExpiredJobs(): Promise<string[]> {
  const maxAgeDays = await getRecoveryMaxAgeDays();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for (const [id, job] of recoveryJobs.entries()) {
    if (isJobActive(job)) continue;
    if (jobReferenceTime(job) < cutoff) {
      expired.push(id);
    }
  }
  for (const id of expired) {
    recoveryJobs.delete(id);
    try {
      await storage.deleteSystemSetting(jobKey(id));
    } catch (err) {
      console.error(`[FrontRecovery] Failed to delete expired job ${id}:`, err);
    }
  }
  return expired;
}

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

// Threshold for declaring a recovery-job step "DB-pool-contended". Anything
// over this bubbles up to the operator as `db_pool_contended:` so they can
// distinguish a job that is starved on DB connection acquires from a job
// that has truly stalled.
const DB_POOL_CONTENTION_THRESHOLD_MS = 5000;

// Task #1024: classifier for pg-pool saturation errors. These are *transient*
// and the recovery job should treat them as resumable `partial` (preserving
// `lastPageUrl`) rather than fatal `failed`. Matches the messages emitted by
// the `pg` driver when an acquire times out, when the API/worker pool is
// killed by the kill-switch, or when an in-flight client is forcibly
// terminated mid-statement. Intentionally narrow — Front HTTP timeouts have
// their own dedicated reason codes and must not collide with this one.
export function isDbPoolSaturationError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return (
    /timeout exceeded when trying to connect/i.test(msg) ||
    /connection terminated due to connection timeout/i.test(msg) ||
    /terminating connection due to administrator command/i.test(msg) ||
    /connection terminated unexpectedly/i.test(msg) ||
    /^Connection terminated$/i.test(msg) ||
    /pool acquire timeout/i.test(msg) ||
    /Cannot use a pool after calling end/i.test(msg) ||
    /remaining connection slots are reserved/i.test(msg) ||
    /sorry, too many clients already/i.test(msg)
  );
}

function logRecoveryEvent(
  jobId: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  const parts = data
    ? Object.entries(data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    : [];
  console.log(
    `[FrontRecovery] [job=${jobId}] ${event}${parts.length ? " " + parts.join(" ") : ""}`,
  );
}

interface DbContentionState {
  logged: boolean;
}

function maybeMarkDbContention(
  jobState: RecoveryJobState,
  contention: DbContentionState,
  label: string,
  elapsedMs: number,
): void {
  const reason = `db_pool_contended: ${label} took ${elapsedMs}ms`;
  // Overwrite intermediate / null reasons regardless of job status. The
  // restriction to running|queued was too narrow: slow terminal DB steps
  // (setSystemSetting, terminal persistJob) also need to surface
  // contention. We never overwrite a more-specific terminal reason —
  // only null, scanning placeholders, or an existing db_pool_contended:
  // value (which we update with the most recent timing).
  const overridable =
    jobState.statusReason === null ||
    jobState.statusReason.startsWith("db_pool_contended:") ||
    jobState.statusReason === "queued_pending_coverage_scan" ||
    jobState.statusReason === "scanning_coverage";
  if (overridable) {
    jobState.statusReason = reason;
  }
  if (!contention.logged) {
    contention.logged = true;
    console.warn(
      `[FrontRecovery] [job=${jobState.jobId}] ${reason} — DB pool contention detected (threshold ${DB_POOL_CONTENTION_THRESHOLD_MS}ms)`,
    );
  }
}

// Reset the working statusReason to a new value while preserving any
// existing db_pool_contended:* tag. Without this guard, the lifecycle
// transitions in the IIFE (e.g. clearing "scanning_coverage" after the
// coverage scan, or setting null at terminal complete) would silently
// erase the contention signal the operator needs to see.
function setStatusReasonPreservingContention(
  jobState: RecoveryJobState,
  newReason: string | null,
): void {
  if (jobState.statusReason?.startsWith("db_pool_contended:")) {
    return;
  }
  jobState.statusReason = newReason;
}

async function withDbTiming<T>(
  jobState: RecoveryJobState,
  contention: DbContentionState,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed > DB_POOL_CONTENTION_THRESHOLD_MS) {
      maybeMarkDbContention(jobState, contention, label, elapsed);
    }
  }
}

function safePersistJob(state: RecoveryJobState, label: string): void {
  // Fire-and-forget persistJob with its own catch so an unhandled rejection
  // can never kill the recovery run silently. Logs are tagged with the
  // jobId so the operator can tie them back to the run.
  persistJob(state).catch((err) => {
    console.error(
      `[FrontRecovery] [job=${state.jobId}] Background persistJob (${label}) failed: ${err?.message ?? String(err)}`,
    );
  });
}

let hydrationPromise: Promise<void> | null = null;

async function hydrateRecoveryJobs(): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    let succeeded = false;
    try {
      const indexSetting = await storage.getSystemSetting(JOB_INDEX_KEY);
      if (!indexSetting?.value) {
        succeeded = true;
        return;
      }
      let ids: string[];
      try {
        const parsed = JSON.parse(indexSetting.value);
        ids = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
      } catch {
        return;
      }
      for (const id of ids) {
        if (recoveryJobs.has(id)) continue;
        const setting = await storage.getSystemSetting(jobKey(id));
        if (!setting?.value) continue;
        try {
          const job = JSON.parse(setting.value) as RecoveryJobState;
          if (job.status === "running" || job.status === "queued") {
            // Server restarted mid-run; mark as partial so admins can see what
            // progress had been recorded before the restart.
            job.status = "partial";
            job.statusReason = "interrupted_by_server_restart";
            if (!job.completedAt) job.completedAt = new Date().toISOString();
          }
          recoveryJobs.set(id, job);
        } catch {
          // ignore unparseable entries
        }
      }
      try {
        const expired = await pruneExpiredJobs();
        if (expired.length > 0) {
          console.log(
            `[FrontRecovery] Hydration pruned ${expired.length} expired recovery job(s).`,
          );
          await writeJobIndex();
        }
      } catch (err) {
        console.error("[FrontRecovery] Failed to prune expired jobs during hydration:", err);
      }
      succeeded = true;
    } catch (err) {
      console.error("[FrontRecovery] Failed to hydrate recovery jobs:", err);
    } finally {
      // If hydration failed (e.g. transient DB error), clear the cached
      // promise so the next caller can retry instead of being stuck with
      // a permanently failed hydration result.
      if (!succeeded) hydrationPromise = null;
    }
  })();
  return hydrationPromise;
}

async function persistJob(state: RecoveryJobState): Promise<void> {
  try {
    await storage.setSystemSetting(jobKey(state.jobId), JSON.stringify(state), "system");

    try {
      await pruneExpiredJobs();
    } catch (err) {
      console.error("[FrontRecovery] Failed to prune expired jobs during persist:", err);
    }

    const ordered = Array.from(recoveryJobs.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    const keep = ordered.slice(0, MAX_PERSISTED_JOBS).map((j) => j.jobId);
    const drop = ordered.slice(MAX_PERSISTED_JOBS).map((j) => j.jobId);
    await storage.setSystemSetting(JOB_INDEX_KEY, JSON.stringify(keep), "system");
    for (const id of drop) {
      recoveryJobs.delete(id);
      try {
        await storage.deleteSystemSetting(jobKey(id));
      } catch (err) {
        console.error(`[FrontRecovery] Failed to prune persisted job ${id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[FrontRecovery] Failed to persist recovery job ${state.jobId}:`, err);
  }
}

async function writeJobIndex(): Promise<void> {
  const ordered = Array.from(recoveryJobs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const ids = ordered.slice(0, MAX_PERSISTED_JOBS).map((j) => j.jobId);
  await storage.setSystemSetting(JOB_INDEX_KEY, JSON.stringify(ids), "system");
}

export class RecoveryJobRunningError extends Error {
  readonly code = "JOB_RUNNING" as const;
  constructor(message = "Cannot delete a recovery job that is still running.") {
    super(message);
    this.name = "RecoveryJobRunningError";
  }
}

export async function deleteRecoveryJob(jobId: string): Promise<{ status?: string; startedAt?: string } | null> {
  await hydrateRecoveryJobs();
  const job = recoveryJobs.get(jobId);
  if (job && (job.status === "running" || job.status === "queued")) {
    throw new RecoveryJobRunningError();
  }
  const snapshot = job ? { status: job.status, startedAt: job.startedAt } : null;
  recoveryJobs.delete(jobId);
  try {
    await storage.deleteSystemSetting(jobKey(jobId));
  } catch (err) {
    console.error(`[FrontRecovery] Failed to delete persisted job ${jobId}:`, err);
  }
  await writeJobIndex();
  return snapshot;
}

export async function clearRecoveryJobs(): Promise<{ deleted: number; skipped: number; deletedIds: string[]; skippedIds: string[] }> {
  await hydrateRecoveryJobs();
  const deletedIds: string[] = [];
  const skippedIds: string[] = [];
  const ids = Array.from(recoveryJobs.keys());
  for (const id of ids) {
    const job = recoveryJobs.get(id);
    if (!job) continue;
    if (job.status === "running" || job.status === "queued") {
      skippedIds.push(id);
      continue;
    }
    recoveryJobs.delete(id);
    try {
      await storage.deleteSystemSetting(jobKey(id));
    } catch (err) {
      console.error(`[FrontRecovery] Failed to delete persisted job ${id}:`, err);
    }
    deletedIds.push(id);
  }
  await writeJobIndex();
  return { deleted: deletedIds.length, skipped: skippedIds.length, deletedIds, skippedIds };
}

export async function getRecoveryJob(jobId: string): Promise<RecoveryJobState | undefined> {
  await hydrateRecoveryJobs();
  return recoveryJobs.get(jobId);
}

/**
 * Task #1091 — clear the per-window retry-pressure alert history for a
 * single window so the panel stops showing the stale "alert fired"
 * indicator and a re-evaluation can fire a fresh alert if the
 * threshold is crossed again. Wipes both the persisted
 * `retryPressureAlerts` array on the window checkpoint and the
 * in-memory dedupe key in `frontRecoveryRetryAlerts`.
 *
 * Returns a small summary so the route can include it in the audit
 * log and the response.
 */
export interface ClearWindowRetryPressureAlertsResult {
  jobId: string;
  windowLabel: string;
  alertsCleared: number;
  singleWindowDedupeCleared: boolean;
  consecutivePatternsCleared: number;
}

export async function clearWindowRetryPressureAlerts(
  jobId: string,
  windowLabel: string,
): Promise<ClearWindowRetryPressureAlertsResult> {
  await hydrateRecoveryJobs();
  const job = recoveryJobs.get(jobId);
  if (!job) {
    throw new Error(`Recovery job not found: ${jobId}`);
  }
  const idx = job.windows.findIndex((w) => w.windowLabel === windowLabel);
  if (idx < 0) {
    throw new Error(
      `Window not found on job ${jobId}: ${windowLabel}`,
    );
  }
  const target = job.windows[idx];
  const alertsCleared = Array.isArray(target.retryPressureAlerts)
    ? target.retryPressureAlerts.length
    : 0;
  if (alertsCleared > 0) {
    target.retryPressureAlerts = [];
    job.windows[idx] = target;
    await persistJob(job);
  }
  const { clearRetryPressureAlertDedupe } = await import(
    "./frontRecoveryRetryAlerts"
  );
  const { singleWindowCleared, consecutivePatternsCleared } =
    clearRetryPressureAlertDedupe({ jobId, windowLabel });
  return {
    jobId,
    windowLabel,
    alertsCleared,
    singleWindowDedupeCleared: singleWindowCleared,
    consecutivePatternsCleared,
  };
}

export async function listRecoveryJobs(): Promise<RecoveryJobState[]> {
  await hydrateRecoveryJobs();
  return Array.from(recoveryJobs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export async function generateCoverageReport(): Promise<CoverageReport> {
  const frontSyncByMonth = await db.execute(sql`
    SELECT 
      to_char(last_message_at, 'YYYY-MM') as month,
      count(*)::int as count
    FROM front_sync_emails
    WHERE last_message_at IS NOT NULL
    GROUP BY to_char(last_message_at, 'YYYY-MM')
    ORDER BY month
  `);

  const rawCommByMonth = await db.execute(sql`
    SELECT 
      to_char(timestamp, 'YYYY-MM') as month,
      count(*)::int as count
    FROM raw_communication_records
    WHERE source_type = 'front_email' AND timestamp IS NOT NULL
    GROUP BY to_char(timestamp, 'YYYY-MM')
    ORDER BY month
  `);

  const pipelineEventsByMonth = await db.execute(sql`
    SELECT 
      to_char(received_at, 'YYYY-MM') as month,
      count(*)::int as count
    FROM source_event_log
    WHERE source_system = 'front'
    GROUP BY to_char(received_at, 'YYYY-MM')
    ORDER BY month
  `);

  const rangeRows = await db.execute(sql`
    SELECT 
      min(last_message_at) as earliest,
      max(last_message_at) as latest
    FROM front_sync_emails
    WHERE last_message_at IS NOT NULL
  `);
  const rangeResult = ((rangeRows as any).rows ?? rangeRows as unknown as any[])[0] ?? null;

  const frontSyncRows = ((frontSyncByMonth as any).rows ?? frontSyncByMonth) as any[];
  const rawCommRows = ((rawCommByMonth as any).rows ?? rawCommByMonth) as any[];
  const pipelineRows = ((pipelineEventsByMonth as any).rows ?? pipelineEventsByMonth) as any[];

  const frontSyncMap = new Map<string, number>();
  for (const row of frontSyncRows) {
    if (row.month) frontSyncMap.set(row.month, Number(row.count));
  }

  const rawCommMap = new Map<string, number>();
  for (const row of rawCommRows) {
    if (row.month) rawCommMap.set(row.month, Number(row.count));
  }

  const pipelineMap = new Map<string, number>();
  for (const row of pipelineRows) {
    if (row.month) pipelineMap.set(row.month, Number(row.count));
  }

  const allMonths = new Set<string>([
    ...frontSyncMap.keys(),
    ...rawCommMap.keys(),
    ...pipelineMap.keys(),
  ]);

  const earliest = rangeResult?.earliest ?? null;
  const latest = rangeResult?.latest ?? null;

  const horizonStart = new Date("2024-01-01T00:00:00Z");
  const horizonEnd = new Date();
  const cursor = new Date(horizonStart.getFullYear(), horizonStart.getMonth(), 1);
  while (cursor <= horizonEnd) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    allMonths.add(key);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const months: CoverageMonth[] = Array.from(allMonths)
    .sort()
    .map((month) => ({
      month,
      frontSyncCount: frontSyncMap.get(month) || 0,
      rawCommCount: rawCommMap.get(month) || 0,
      pipelineEventCount: pipelineMap.get(month) || 0,
      totalCoverage: (frontSyncMap.get(month) || 0) + (rawCommMap.get(month) || 0),
    }));

  const medianCoverage = months.length > 0
    ? [...months].sort((a, b) => a.totalCoverage - b.totalCoverage)[Math.floor(months.length / 2)].totalCoverage
    : 0;
  const gapThreshold = Math.max(5, medianCoverage * 0.2);

  const gaps: RecoveryWindow[] = [];
  for (const m of months) {
    if (m.totalCoverage < gapThreshold && m.month) {
      const [year, mon] = m.month.split("-").map(Number);
      const afterDate = new Date(year, mon - 1, 1);
      const beforeDate = new Date(year, mon, 1);
      gaps.push({
        label: m.month,
        afterTimestamp: Math.floor(afterDate.getTime() / 1000),
        beforeTimestamp: Math.floor(beforeDate.getTime() / 1000),
      });
    }
  }

  const consolidatedGaps = consolidateWindows(gaps);

  return {
    months,
    gaps: consolidatedGaps,
    totalFrontSync: months.reduce((s, m) => s + m.frontSyncCount, 0),
    totalRawComm: months.reduce((s, m) => s + m.rawCommCount, 0),
    totalPipelineEvents: months.reduce((s, m) => s + m.pipelineEventCount, 0),
    earliestRecord: earliest ? new Date(earliest).toISOString() : null,
    latestRecord: latest ? new Date(latest).toISOString() : null,
    generatedAt: new Date().toISOString(),
  };
}

function consolidateWindows(windows: RecoveryWindow[]): RecoveryWindow[] {
  if (windows.length <= 1) return windows;
  const sorted = [...windows].sort((a, b) => a.afterTimestamp - b.afterTimestamp);
  const result: RecoveryWindow[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].afterTimestamp <= current.beforeTimestamp) {
      current.beforeTimestamp = Math.max(current.beforeTimestamp, sorted[i].beforeTimestamp);
      current.label = `${current.label.split("–")[0]}–${sorted[i].label}`;
    } else {
      result.push(current);
      current = { ...sorted[i] };
    }
  }
  result.push(current);
  return result;
}

function checkpointKey(windowLabel: string): string {
  return `front_recovery_checkpoint_${windowLabel.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

async function saveCheckpoint(checkpoint: WindowCheckpoint): Promise<void> {
  await storage.setSystemSetting(
    checkpointKey(checkpoint.windowLabel),
    JSON.stringify(checkpoint),
    "system",
  );
}

// Task #1636: bounded best-effort shutdown flush. Track the active
// recovery job + current window checkpoint at module scope so signal
// handlers can persist the latest progress before the process exits.
let activeRecoveryJobState: RecoveryJobState | null = null;
let activeWindowCheckpoint: WindowCheckpoint | null = null;
let shutdownFlushRegistered = false;
const FRONT_RECOVERY_SHUTDOWN_FLUSH_TIMEOUT_MS = 2000;

function registerShutdownFlushOnce(): void {
  if (shutdownFlushRegistered) return;
  shutdownFlushRegistered = true;
  const handler = (signal: string) => {
    if (!activeRecoveryJobState && !activeWindowCheckpoint) return;
    const job = activeRecoveryJobState;
    const cp = activeWindowCheckpoint;
    const labels: string[] = [];
    const flushTasks: Array<Promise<unknown>> = [];
    if (job) {
      labels.push(`job=${job.jobId}`);
      flushTasks.push(persistJob(job));
    }
    if (cp) {
      labels.push(`window=${cp.windowLabel}`);
      flushTasks.push(saveCheckpoint(cp));
    }
    const TIMED_OUT = Symbol("front_recovery_flush_timed_out");
    const timeout = new Promise<typeof TIMED_OUT>((resolve) =>
      setTimeout(
        () => resolve(TIMED_OUT),
        FRONT_RECOVERY_SHUTDOWN_FLUSH_TIMEOUT_MS,
      ).unref?.(),
    );
    // allSettled never rejects, so we must explicitly inspect each
    // outcome and warn-log any rejected flush. The race with the
    // timeout bounds the wait — if the timeout wins, log that fact
    // instead of silently dropping the flush.
    Promise.race([Promise.allSettled(flushTasks), timeout])
      .then((outcome) => {
        if (outcome === TIMED_OUT) {
          console.warn(
            `[FrontRecovery] shutdown flush timed out after ${FRONT_RECOVERY_SHUTDOWN_FLUSH_TIMEOUT_MS}ms on ${signal} (${labels.join(", ")}) — persisted state may lag in-memory state by one page.`,
          );
          return;
        }
        const results = outcome as PromiseSettledResult<unknown>[];
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            const reason: any = r.reason;
            console.warn(
              `[FrontRecovery] shutdown flush failed (${labels[i] ?? `task_${i}`}) on ${signal}: ${reason?.message ?? String(reason)}`,
            );
          }
        });
      })
      .catch((err: any) => {
        // Defensive: Promise.race itself shouldn't reject here, but if
        // some downstream rethrows synchronously we still want a log
        // line rather than an unhandled rejection during shutdown.
        console.warn(
          `[FrontRecovery] shutdown flush handler error on ${signal}: ${err?.message ?? String(err)}`,
        );
      });
  };
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("beforeExit", () => handler("beforeExit"));
}

// Task #1636: single helper so the three call sites (normal page,
// page aborted, transient catch) emit a consistent heartbeat line.
// Never include conversation payloads, full Front API URLs (may
// carry auth-bearing query params), or tokens — only counters.
function logRecoveryPageHeartbeat(args: {
  jobId?: string;
  windowLabel: string;
  checkpoint: WindowCheckpoint;
  nextPage: "yes" | "no" | "preserved";
  dryRun?: boolean;
  context: "page_done" | "page_aborted" | "transient_error";
}): void {
  const verb =
    args.context === "page_done"
      ? "done"
      : args.context === "page_aborted"
        ? "aborted"
        : "interrupted";
  const jobTag = args.jobId ? `[job=${args.jobId}] ` : "";
  const cp = args.checkpoint;
  const dryRunTag = args.dryRun ? " (DRY RUN)" : "";
  console.log(
    `[FrontRecovery] ${jobTag}Window ${args.windowLabel}: page ${cp.pages} ${verb} — scanned=${cp.scanned} ingested=${cp.ingested} skipped=${cp.skipped} errors=${cp.errors.length} nextPage=${args.nextPage}${dryRunTag}`,
  );
}

async function loadCheckpoint(windowLabel: string): Promise<WindowCheckpoint | null> {
  const setting = await storage.getSystemSetting(checkpointKey(windowLabel));
  if (!setting?.value) return null;
  try {
    return JSON.parse(setting.value);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Task #1869 Step 3 — Auto-unblock pass for poisoned recovery checkpoints
// ───────────────────────────────────────────────────────────────────────
//
// Before the OAuth refresh-token race fix landed, concurrent refreshers
// could leave a recovery checkpoint with `status='blocked'` and reason
// `front_auth_unauthorized_after_refresh` / `front_not_connected` /
// `front_auth_refresh_failed` even though Front was perfectly connected.
// Once blocked, auto-closure stops enqueueing the window. This helper
// scans for poisoned checkpoints, runs ONE shared `/me` probe, and if
// Front confirms the connection is healthy rewrites those rows to
// `status='partial'` (preserving lastPageUrl / scanned / ingested /
// skipped / errors) so the existing auto-closure loop re-enqueues
// them. Idempotent: a successful pass leaves no `blocked` rows
// matching the auth-reason filter; a probe-unhealthy pass leaves the
// rows untouched so a real disconnect still surfaces. Behind kill
// switch `front_auto_unblock_enabled` (default ON).
const AUTO_UNBLOCK_AUTH_REASONS = new Set([
  "front_auth_unauthorized_after_refresh",
  "front_not_connected",
  "front_auth_refresh_failed",
]);
const AUTO_UNBLOCK_KILL_SWITCH = "front_auto_unblock_enabled";

interface AutoUnblockSummary {
  scanned: number;
  unblocked: number;
  skipped: number;
  probeOutcome: string | null;
  details: Array<{ key: string; windowLabel: string; reason: string; action: "unblocked" | "skipped"; note?: string }>;
}

export async function tryAutoUnblockPoisonedCheckpoints(opts?: {
  // When set, ignores the kill switch (used by the manual CEO action).
  force?: boolean;
  actorId?: string;
}): Promise<AutoUnblockSummary> {
  const summary: AutoUnblockSummary = {
    scanned: 0,
    unblocked: 0,
    skipped: 0,
    probeOutcome: null,
    details: [],
  };

  if (!opts?.force) {
    const switchSetting = await storage.getSystemSetting(AUTO_UNBLOCK_KILL_SWITCH);
    // Default ON: only treat the kill switch as OFF when an operator
    // has explicitly set it to "false".
    if (switchSetting?.value && switchSetting.value.toLowerCase() === "false") {
      summary.probeOutcome = "skipped_kill_switch_off";
      return summary;
    }
  }

  // SELECT every front_recovery_checkpoint_* system setting via the
  // worker-pool getDb() (this module declares @db-pool-intent: worker).
  const rows = await withDbAttribution(
    "front_recovery_auto_unblock:scan",
    async () => {
      const res = await getDb().execute(sql`
        SELECT key, value
        FROM system_settings
        WHERE key LIKE 'front_recovery_checkpoint_%'
      `);
      return res.rows as Array<{ key: string; value: string | null }>;
    },
  );

  const candidates: Array<{ key: string; checkpoint: WindowCheckpoint }> = [];
  for (const row of rows) {
    if (!row.value) continue;
    let cp: WindowCheckpoint;
    try {
      cp = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (cp.status !== "blocked") continue;
    const reason = (cp.statusReason ?? "").trim();
    if (!AUTO_UNBLOCK_AUTH_REASONS.has(reason)) continue;
    // Defensive: never auto-unblock the test-poison 2999_* windows;
    // they are cancelled by a separate operator action.
    if (typeof cp.windowLabel === "string" && /(^|[:_])2999[_-]/.test(cp.windowLabel)) {
      continue;
    }
    candidates.push({ key: row.key, checkpoint: cp });
  }

  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  // One probe shared across the whole pass — never N probes for N rows.
  const { probeConnection } = await import("./frontIntegration");
  const probe = await probeConnection();
  summary.probeOutcome = probe.outcome;
  if (probe.outcome !== "connected") {
    for (const c of candidates) {
      summary.details.push({
        key: c.key,
        windowLabel: c.checkpoint.windowLabel,
        reason: c.checkpoint.statusReason ?? "",
        action: "skipped",
        note: `probe_${probe.outcome}${probe.reason ? `:${probe.reason}` : ""}`,
      });
      summary.skipped++;
    }
    console.warn(
      `[FrontRecovery] auto_unblock_skipped probe_outcome=${probe.outcome} reason=${probe.reason ?? "n/a"} candidates=${candidates.length}`,
    );
    return summary;
  }

  for (const c of candidates) {
    const rewritten: WindowCheckpoint = {
      ...c.checkpoint,
      // partial preserves lastPageUrl so auto-closure resumes from the
      // same cursor; failed wouldn't (no resume), complete would lie.
      status: "partial",
      statusReason: `auto_unblocked_after_probe_ok_was:${c.checkpoint.statusReason ?? "unknown"}`,
      completedAt: new Date().toISOString(),
    };
    try {
      await storage.setSystemSetting(c.key, JSON.stringify(rewritten), opts?.actorId);
      summary.unblocked++;
      summary.details.push({
        key: c.key,
        windowLabel: c.checkpoint.windowLabel,
        reason: c.checkpoint.statusReason ?? "",
        action: "unblocked",
      });
    } catch (err: any) {
      summary.skipped++;
      summary.details.push({
        key: c.key,
        windowLabel: c.checkpoint.windowLabel,
        reason: c.checkpoint.statusReason ?? "",
        action: "skipped",
        note: `write_failed:${err?.message ?? String(err)}`,
      });
    }
  }

  console.log(
    `[FrontRecovery] auto_unblock_pass scanned=${summary.scanned} unblocked=${summary.unblocked} skipped=${summary.skipped} probe=connected`,
  );
  return summary;
}

// ───────────────────────────────────────────────────────────────────────
// Task #1869 Step 4 — Cancel test-poison `2999_*` checkpoint rows
// ───────────────────────────────────────────────────────────────────────
//
// Three checkpoints exist from a long-ago test run with far-future
// window labels (`auto_closure:2999-01/02/03`) — they sit blocked with
// `front_not_connected` forever and pollute the blocked-count alerting.
// This helper transitions them to `status='cancelled'` with a prefixed
// statusReason. Idempotent: already-cancelled rows are left alone.
const FRONT_2999_POISON_KEYS = [
  "front_recovery_checkpoint_auto_closure_2999_01",
  "front_recovery_checkpoint_auto_closure_2999_02",
  "front_recovery_checkpoint_auto_closure_2999_03",
];
const FRONT_2999_CANCEL_PREFIX = "[backlog-cleanup 2026-05] ";

export async function cancelFront2999PoisonCheckpoints(opts?: {
  actorId?: string;
}): Promise<{ cancelled: number; alreadyCancelled: number; missing: number; details: Array<{ key: string; action: string }> }> {
  const out = { cancelled: 0, alreadyCancelled: 0, missing: 0, details: [] as Array<{ key: string; action: string }> };
  for (const key of FRONT_2999_POISON_KEYS) {
    const setting = await storage.getSystemSetting(key);
    if (!setting?.value) {
      out.missing++;
      out.details.push({ key, action: "missing" });
      continue;
    }
    let cp: WindowCheckpoint;
    try {
      cp = JSON.parse(setting.value);
    } catch {
      out.details.push({ key, action: "unparseable" });
      continue;
    }
    if (cp.status === "cancelled" as any) {
      out.alreadyCancelled++;
      out.details.push({ key, action: "already_cancelled" });
      continue;
    }
    const cancelled: any = {
      ...cp,
      status: "cancelled",
      statusReason: `${FRONT_2999_CANCEL_PREFIX}${cp.statusReason ?? "test_poison_far_future_window"}`,
      completedAt: new Date().toISOString(),
    };
    await storage.setSystemSetting(key, JSON.stringify(cancelled), opts?.actorId);
    out.cancelled++;
    out.details.push({ key, action: "cancelled" });
  }
  console.log(
    `[FrontRecovery] cancel_2999_poison cancelled=${out.cancelled} already=${out.alreadyCancelled} missing=${out.missing}`,
  );
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Task #1963 — Reset checkpoints that exhausted the 500-page safety cap
// ───────────────────────────────────────────────────────────────────────
//
// The failure mode (see comment block above `buildInitialPath`): a
// window whose entire missing tail sits behind ~25k already-ingested
// bumped convs walks 500 pages of pure dedupe-skip on the legacy
// `/conversations?` enumeration, then stalls with
// `status='partial', statusReason='safety_max_pages_reached_resume_available',
// lastPageUrl='/conversations?…'`. Because the resume cursor is opaque,
// auto-closure keeps replaying that same wrong endpoint every tick.
//
// This helper finds those rows and clears `lastPageUrl` (plus the
// per-resume counters that would otherwise lie). The window bounds,
// cumulative `ingested`, and any non-stuck checkpoints are left
// untouched. On the next auto-closure tick the engine re-enters
// `buildInitialPath`, sees the bounded window, and (with the Task #1963
// gate lift above) picks the search endpoint.
//
// Idempotent: a checkpoint with empty `lastPageUrl` no longer matches
// the filter. Gated by `front_recovery_checkpoint_reset_enabled`
// (default ON). Safe to schedule periodically.
const SAFETY_CAP_RESET_PREFIX = "[backlog-drain 2026-05] ";

export interface ResetStuckCheckpointsSummary {
  scanned: number;
  reset: number;
  skipped: number;
  details: Array<{ key: string; windowLabel: string; action: "reset" | "skipped"; note?: string }>;
}

export async function resetStuckRecoveryCheckpoints(opts?: {
  // Bypasses the kill switch (used by the manual CEO action).
  force?: boolean;
  actorId?: string;
}): Promise<ResetStuckCheckpointsSummary> {
  const summary: ResetStuckCheckpointsSummary = {
    scanned: 0,
    reset: 0,
    skipped: 0,
    details: [],
  };

  if (!opts?.force) {
    if (!isPoolEpicSwitchEnabled("front_recovery_checkpoint_reset_enabled")) {
      summary.skipped++;
      summary.details.push({
        key: "<switch>",
        windowLabel: "",
        action: "skipped",
        note: "skipped_kill_switch_off",
      });
      return summary;
    }
  }

  const rows = await withDbAttribution(
    "front_recovery_reset_stuck_checkpoints:scan",
    async () => {
      const res = await getDb().execute(sql`
        SELECT key, value
        FROM system_settings
        WHERE key LIKE 'front_recovery_checkpoint_%'
      `);
      return res.rows as Array<{ key: string; value: string | null }>;
    },
  );

  for (const row of rows) {
    if (!row.value) continue;
    let cp: WindowCheckpoint;
    try {
      cp = JSON.parse(row.value);
    } catch {
      continue;
    }
    // Match: status='partial' AND statusReason matches the safety-cap
    // exhaustion AND lastPageUrl points at the legacy enumeration. We
    // deliberately scope to legacy `/conversations?` cursors only so
    // re-running this helper after the fix has flipped windows to the
    // search endpoint is a clean no-op.
    if (cp.status !== "partial") continue;
    const reason = String(cp.statusReason ?? "");
    if (!reason.includes("safety_max_pages_reached")) continue;
    const lastPageUrl = String((cp as any).lastPageUrl ?? "");
    if (!lastPageUrl) continue;
    if (!/\/conversations\?/.test(lastPageUrl)) continue;
    // Never reset the 2999_* test-poison windows (handled by the
    // dedicated cancel action).
    if (typeof cp.windowLabel === "string" && /(^|[:_])2999[_-]/.test(cp.windowLabel)) {
      continue;
    }
    summary.scanned++;

    const reset: WindowCheckpoint = {
      ...cp,
      lastPageUrl: null,
      pages: 0,
      scanned: 0,
      skipped: 0,
      // Preserve `ingested` (cumulative across resumes) and `errors`.
      statusReason: `${SAFETY_CAP_RESET_PREFIX}reset_for_search_endpoint_was:${reason}`,
      completedAt: new Date().toISOString(),
    } as WindowCheckpoint;
    try {
      await storage.setSystemSetting(row.key, JSON.stringify(reset), opts?.actorId);
      summary.reset++;
      summary.details.push({ key: row.key, windowLabel: cp.windowLabel, action: "reset" });
    } catch (err: any) {
      summary.skipped++;
      summary.details.push({
        key: row.key,
        windowLabel: cp.windowLabel,
        action: "skipped",
        note: `write_failed:${err?.message ?? String(err)}`,
      });
    }
  }

  console.log(
    `[FrontRecovery] reset_stuck_checkpoints scanned=${summary.scanned} reset=${summary.reset} skipped=${summary.skipped}`,
  );
  return summary;
}

// ───────────────────────────────────────────────────────────────────────
// Task #1869 Step 5 — Per-month cumulative recovery telemetry
// ───────────────────────────────────────────────────────────────────────
//
// Per-window checkpoints accumulate across resumes but reset whenever
// auto-closure starts a fresh window invocation, so operators can't
// see "is this month genuinely draining or are we re-walking the same
// 25k dedupe-hit conversations every tick?". This shared
// `front_recovery_cumulative` JSON row captures per-YYYY-MM totals
// that survive all resets, broken out by skip reason.
const FRONT_RECOVERY_CUMULATIVE_KEY = "front_recovery_cumulative";

type CumulativeMonth = {
  scanned: number;
  ingested: number;
  dedupe_skipped: number;
  same_response_skipped: number;
  inactive_inbox_skipped: number;
  pages_walked: number;
  last_advanced_at: string;
  last_observed_dedupe_pct: number;
};

type CumulativeStore = { months: Record<string, CumulativeMonth> };

function emptyMonth(): CumulativeMonth {
  return {
    scanned: 0,
    ingested: 0,
    dedupe_skipped: 0,
    same_response_skipped: 0,
    inactive_inbox_skipped: 0,
    pages_walked: 0,
    last_advanced_at: new Date(0).toISOString(),
    last_observed_dedupe_pct: 0,
  };
}

function extractYyyyMm(windowLabel: string, afterTimestamp: number): string | null {
  // Auto-closure labels look like "auto_closure:2026-05"; targeted-run
  // labels can also be plain YYYY-MM. Fall back to deriving from the
  // window's `afterTimestamp` (seconds since epoch).
  const m = windowLabel.match(/(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  if (afterTimestamp > 0) {
    const d = new Date(afterTimestamp * 1000);
    if (!isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    }
  }
  return null;
}

export async function getRecoveryCumulative(): Promise<CumulativeStore> {
  const setting = await storage.getSystemSetting(FRONT_RECOVERY_CUMULATIVE_KEY);
  if (!setting?.value) return { months: {} };
  try {
    const parsed = JSON.parse(setting.value) as CumulativeStore;
    if (parsed && typeof parsed === "object" && parsed.months && typeof parsed.months === "object") {
      return parsed;
    }
  } catch {
    /* fall through to empty */
  }
  return { months: {} };
}

async function updateRecoveryCumulative(args: {
  windowLabel: string;
  afterTimestamp: number;
  scannedDelta: number;
  ingestedDelta: number;
  dedupeSkippedDelta: number;
  sameResponseSkippedDelta: number;
  inactiveInboxSkippedDelta: number;
  pagesWalkedDelta: number;
  lastObservedDedupePct: number | null;
}): Promise<void> {
  const ym = extractYyyyMm(args.windowLabel, args.afterTimestamp);
  if (!ym) return;
  const store = await getRecoveryCumulative();
  const cur = store.months[ym] ?? emptyMonth();
  cur.scanned += args.scannedDelta;
  cur.ingested += args.ingestedDelta;
  cur.dedupe_skipped += args.dedupeSkippedDelta;
  cur.same_response_skipped += args.sameResponseSkippedDelta;
  cur.inactive_inbox_skipped += args.inactiveInboxSkippedDelta;
  cur.pages_walked += args.pagesWalkedDelta;
  if (
    args.scannedDelta > 0 ||
    args.ingestedDelta > 0 ||
    args.pagesWalkedDelta > 0
  ) {
    cur.last_advanced_at = new Date().toISOString();
  }
  if (args.lastObservedDedupePct != null && !isNaN(args.lastObservedDedupePct)) {
    cur.last_observed_dedupe_pct = args.lastObservedDedupePct;
  }
  store.months[ym] = cur;
  try {
    await storage.setSystemSetting(
      FRONT_RECOVERY_CUMULATIVE_KEY,
      JSON.stringify(store),
      "system",
    );
  } catch (err: any) {
    console.warn(
      `[FrontRecovery] cumulative telemetry write failed (${ym}): ${err?.message ?? String(err)}`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// Task #1869 Step 6 — Dedupe-vs-applied sample log
// ───────────────────────────────────────────────────────────────────────
//
// When dedupe-skipped dominates a page (>95%) we don't know whether
// recovery is wastefully re-walking pages because the apply layer
// already dropped these rows, OR whether the dedupe pattern is right
// and the coverage report's denominator is wrong. Sampling 10 of the
// dedupe-hit conv ids and looking them up in `front_sync_emails`
// answers that cleanly — `applied` rows mean the pipeline made it
// through, `discovered`/missing rows mean the apply layer is dropping
// them. Log-only.
async function sampleDedupeAppliedStatus(args: {
  jobTag: string;
  jobId: string | null;
  windowLabel: string;
  pageNumber: number;
  pageScanned: number;
  pageDedupeSkipped: number;
  dedupeConvIds: string[];
}): Promise<void> {
  if (args.pageScanned === 0) return;
  const pct = args.pageDedupeSkipped / args.pageScanned;
  if (pct <= 0.95) return;
  const sample = args.dedupeConvIds.slice(0, 10);
  if (sample.length === 0) return;
  try {
    const rows = await withDbAttribution(
      "front_recovery_dedupe_sample:lookup",
      async () => {
        const res = await getDb().execute(sql`
          SELECT conversation_id, pipeline_state, last_message_id
          FROM ${frontSyncEmails}
          WHERE conversation_id = ANY(${bindArrayParam(sample, "text")})
        `);
        return res.rows as Array<{ conversation_id: string; pipeline_state: string | null; last_message_id: string | null }>;
      },
    );
    const byConv = new Map(rows.map((r) => [r.conversation_id, r]));
    const applied = sample.filter((c) => byConv.get(c)?.pipeline_state === "applied").length;
    const discovered = sample.filter((c) => byConv.get(c)?.pipeline_state === "discovered").length;
    const missing = sample.filter((c) => !byConv.has(c)).length;
    const otherStates = sample.length - applied - discovered - missing;
    const verdict: "apply_layer_dropping" | "coverage_denominator_likely_wrong" | "mixed" =
      applied === sample.length
        ? "coverage_denominator_likely_wrong"
        : missing + discovered > applied
        ? "apply_layer_dropping"
        : "mixed";
    console.warn(
      `[FrontRecovery] ${args.jobTag}front_recovery_dedupe_sample window=${args.windowLabel} page=${args.pageNumber} dedupe_pct=${(pct * 100).toFixed(1)}% sample=${sample.length} applied=${applied} discovered=${discovered} missing=${missing} other=${otherStates} verdict=${verdict}`,
    );
    // Task #1872 — escalate repeated apply-layer drops + feed the
    // admin trends panel. Fire-and-forget; never throws.
    void (await import("./frontRecoveryDedupeDropAlerts")).recordDedupeSample({
      jobId: args.jobId,
      windowLabel: args.windowLabel,
      pageNumber: args.pageNumber,
      pageScanned: args.pageScanned,
      pageDedupeSkipped: args.pageDedupeSkipped,
      dedupePct: pct,
      sampleSize: sample.length,
      applied,
      discovered,
      missing,
      otherStates,
      verdict,
      observedAt: Date.now(),
    });
  } catch (err: any) {
    console.warn(
      `[FrontRecovery] dedupe_sample lookup failed window=${args.windowLabel} page=${args.pageNumber}: ${err?.message ?? String(err)}`,
    );
  }
}

export async function runTargetedWindowBackfill(
  window: RecoveryWindow,
  options?: {
    dryRun?: boolean;
    resume?: boolean;
    onProgress?: (checkpoint: WindowCheckpoint) => void;
    // Optional parent jobId for log correlation. When called from the
    // canonical runHistoricalRecovery IIFE this is always set so every
    // window log line carries the same [job=…] tag operators search for.
    jobId?: string;
  },
): Promise<WindowCheckpoint> {
  const dryRun = options?.dryRun ?? false;
  const resume = options?.resume ?? true;
  const jobTag = options?.jobId ? `[job=${options.jobId}] ` : "";

  let checkpoint: WindowCheckpoint = {
    windowLabel: window.label,
    afterTimestamp: window.afterTimestamp,
    beforeTimestamp: window.beforeTimestamp,
    status: "running",
    statusReason: null,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    errors: [],
    pages: 0,
    lastPageUrl: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    retriesByReason: {},
    totalRetries: 0,
    tokenRefreshes: 0,
  };

  if (resume) {
    const saved = await loadCheckpoint(window.label);
    if (saved && (saved.status === "running" || saved.status === "partial") && saved.lastPageUrl) {
      checkpoint = {
        ...saved,
        status: "running",
        statusReason: null,
        errors: [],
        // Task #1016: preserve cumulative resilience telemetry across
        // resume so the admin UI shows the full retry/refresh story for
        // the window, not just the latest run's slice.
        retriesByReason: { ...(saved.retriesByReason ?? {}) },
        totalRetries: saved.totalRetries ?? 0,
        tokenRefreshes: saved.tokenRefreshes ?? 0,
      };
      console.log(`[FrontRecovery] ${jobTag}Resuming window ${window.label} from page ${checkpoint.pages}`);
    }
  }

  // Task #1869 Step 5 — snapshot the counters as they were at the start
  // of this invocation so we can compute per-invocation deltas to fold
  // into `front_recovery_cumulative` (window checkpoint counters
  // accumulate across resumes; the cumulative store must only see new
  // progress, never re-counted progress).
  const priorScanned = checkpoint.scanned;
  const priorIngested = checkpoint.ingested;
  const priorSkipped = checkpoint.skipped;
  const priorPages = checkpoint.pages;
  const priorSameResponseSkipped =
    Number(checkpoint.retriesByReason?.["same_response_suppressed"] ?? 0);
  const priorInactiveInboxSkipped =
    Number(checkpoint.retriesByReason?.["inactive_inbox_skipped"] ?? 0);

  // Task #1016: helper to fold per-page counters from the page helper
  // (success or error path) into the window-level checkpoint counters.
  const mergeCounters = (
    src: { retriesByReason?: Record<string, number>; tokenRefreshes?: number } | null | undefined,
  ) => {
    if (!src) return;
    if (!checkpoint.retriesByReason) checkpoint.retriesByReason = {};
    if (typeof checkpoint.totalRetries !== "number") checkpoint.totalRetries = 0;
    if (typeof checkpoint.tokenRefreshes !== "number") checkpoint.tokenRefreshes = 0;
    for (const [k, v] of Object.entries(src.retriesByReason ?? {})) {
      const inc = Number(v) || 0;
      checkpoint.retriesByReason[k] = (checkpoint.retriesByReason[k] ?? 0) + inc;
      checkpoint.totalRetries += inc;
    }
    checkpoint.tokenRefreshes += Number(src.tokenRefreshes ?? 0) || 0;
  };

  // Task #1015: route every page request through the refresh-aware
  // accessor. We deliberately do NOT read SETTINGS_KEY_ACCESS directly
  // here — long recovery windows can outlive an access token, and
  // reading the raw setting would silently drift back into the
  // "transient expiry treated as a real disconnect" failure mode this
  // task fixed. Validate connection state up-front so a true disconnect
  // still produces the canonical `front_not_connected` blocked status
  // (preserves admin reconnect UX), then let the per-page helper handle
  // expiry / refresh / mid-run 401 internally.
  try {
    await getValidFrontAccessToken({ purpose: "historical_recovery" });
  } catch (err) {
    if (err instanceof FrontAuthError && (err.code === "front_not_connected" || err.code === "front_no_refresh_token")) {
      checkpoint.status = "blocked";
      checkpoint.statusReason = "front_not_connected";
      checkpoint.errors.push("Front is not connected. Reconnect Front before continuing.");
      checkpoint.completedAt = new Date().toISOString();
      return checkpoint;
    }
    // Permanent refresh failure (revoked / invalid_grant) — operator
    // must reconnect Front. Surface this with the canonical
    // `front_not_connected` reason so the admin UX wording matches a
    // true disconnect (Done-criteria parity).
    if (err instanceof FrontAuthError && err.code === "front_refresh_failed_permanent") {
      checkpoint.status = "blocked";
      checkpoint.statusReason = "front_not_connected";
      checkpoint.errors.push("Front is not connected. Reconnect Front before continuing.");
      checkpoint.completedAt = new Date().toISOString();
      return checkpoint;
    }
    // Transient — fall through and let the page helper's own retry
    // policy try again so we don't pre-fail a recoverable run.
  }

  const batchSize = PERF.FRONT_RECONCILIATION_BATCH_SIZE;
  const SAFETY_MAX_PAGES = 500;

  let path: string | null = checkpoint.lastPageUrl || buildInitialPath(window, batchSize);

  // Task #1789 — Stage 5/6 wiring. Read the two kill switches once at
  // window entry; flipping a switch OFF mid-window restores legacy
  // behavior on the *next* window invocation (no redeploy needed).
  const sameResponseSuppressionEnabled = isPoolEpicSwitchEnabled(
    "front_recovery_same_response_suppression_enabled",
  );
  const activeInboxFilterEnabled = isPoolEpicSwitchEnabled(
    "front_recovery_active_inbox_filter_enabled",
  );
  const activeInboxIds = activeInboxFilterEnabled
    ? await getActiveFrontInboxIds(jobTag)
    : null;
  let lastPageHash: string | null = null;
  const bumpSuppressionMetric = (reason: "same_response_suppressed" | "inactive_inbox_skipped", n = 1) => {
    if (!checkpoint.retriesByReason) checkpoint.retriesByReason = {};
    if (typeof checkpoint.totalRetries !== "number") checkpoint.totalRetries = 0;
    checkpoint.retriesByReason[reason] = (checkpoint.retriesByReason[reason] ?? 0) + n;
    // Don't bump totalRetries — these are not retries, they're skips.
    // Surfacing under retriesByReason gives the admin UI a single map
    // to render without inventing a new schema field.
  };

  // Task #1024: once we observe a pg-pool saturation event anywhere in
  // this window, every subsequent inter-page sleep uses the longer
  // "saturated" delay so the pool gets time to drain even after the
  // immediate pressure signal has cleared. Also drives the deterministic
  // "gentler next page" behaviour the reviewer asked for.
  //
  // Task #1730 (Phase 3.2): the sticky-for-the-whole-window flag was
  // too coarse — a single blip slowed an entire recovery window 10×.
  // We now track consecutive saturated pages and only apply the longer
  // delay once the count meets `dbSaturatedRequiredSignals` (live-tunable
  // via `front_recovery_db_saturated_required_signals`; legacy default
  // 1 = old sticky behaviour). A clean page resets the counter.
  let consecutiveSaturatedPages = 0;
  // Task #1730 (Phase 3.1): hysteresis state for the inter-page
  // API-pool-pressure check. Per-window so a sibling window does not
  // inherit a stale "pressured" flag.
  const apiPoolPressureState = createApiPoolPressureHysteresis();
  // Helper to bump the per-window retry telemetry so the admin UI's
  // resilience badge surfaces saturation events alongside other retry
  // reasons. Mirrors the keys of FrontRecoveryRetryReason but reuses
  // the same map intentionally (UI gets a label entry for it).
  const bumpDbSaturationRetry = (n: number = 1) => {
    if (!checkpoint.retriesByReason) checkpoint.retriesByReason = {};
    if (typeof checkpoint.totalRetries !== "number") checkpoint.totalRetries = 0;
    checkpoint.retriesByReason["db_pool_saturated"] =
      (checkpoint.retriesByReason["db_pool_saturated"] ?? 0) + n;
    checkpoint.totalRetries += n;
  };

  try {
    while (path && checkpoint.pages < SAFETY_MAX_PAGES) {
      if (dryRun && checkpoint.pages >= 3) {
        break;
      }

      let conversations: any[];
      let nextPageUrl: string | null = null;

      try {
        const result = await fetchFrontRecoveryPageWithRetry({
          pageUrl: path,
          windowLabel: window.label,
          pageNumber: checkpoint.pages + 1,
          signalTimeoutMs: FETCH_TIMEOUT_MS,
          jobTag,
        });
        conversations = result.conversations;
        nextPageUrl = result.nextPageUrl;
        // Task #1016: roll the page's retry / token-refresh counters
        // into the window checkpoint so the admin UI can show them.
        mergeCounters(result);
        // Refresh telemetry is logged inside the helper for both
        // expiry-driven and 401-forced refreshes — no extra log here.
      } catch (fetchErr: any) {
        if (fetchErr && typeof fetchErr === "object" && "reasonCode" in fetchErr) {
          // Task #1016: the page helper attaches counters to the typed
          // error so we can attribute retries even on the failing page.
          mergeCounters(fetchErr);
          const code = String((fetchErr as any).reasonCode);
          const requestId = (fetchErr as any).requestId ?? null;
          console.warn(
            `[FrontRecovery] ${jobTag}Page retry exhausted: window=${window.label} page=${checkpoint.pages + 1} reason=${code}${requestId ? ` req=${requestId}` : ""}`,
          );
          // Preserve checkpoint progress + lastPageUrl so manual /
          // auto-continue can resume from this exact page.
          checkpoint.lastPageUrl = path;
          checkpoint.statusReason = code;
          checkpoint.errors.push(
            (fetchErr as any).message ?? `Front recovery page failed: ${code}`,
          );
          // Task #1015: mid-run true disconnect / permanent auth failure
          // must surface the same `blocked` semantics as the upfront
          // preflight so admin reconnect UX is consistent. Transient
          // exhaustion stays `partial` (progress preserved, eligible
          // for auto-continue); persistent 401-after-refresh and
          // permanent refresh failures are non-transient.
          const isAuthDisconnect =
            code === "front_not_connected" ||
            code === "front_auth_refresh_failed" ||
            code === "front_auth_unauthorized_after_refresh";
          if (isAuthDisconnect) {
            checkpoint.status = "blocked";
          } else {
            checkpoint.status =
              checkpoint.lastPageUrl || checkpoint.scanned > 0 ? "partial" : "failed";
          }
          checkpoint.completedAt = new Date().toISOString();
          await saveCheckpoint(checkpoint);
          // Skip the post-loop status reclassification; we've already
          // assigned the most precise state.
          const firstError = checkpoint.errors[0];
          const errorTail =
            checkpoint.errors.length > 0 && firstError
              ? ` — first error: ${firstError.length > 300 ? firstError.slice(0, 300) + "…" : firstError}`
              : "";
          console.log(
            `[FrontRecovery] ${jobTag}Window ${window.label}: status=${checkpoint.status} ${checkpoint.pages} pages, ${checkpoint.scanned} scanned, ${checkpoint.ingested} ingested, ${checkpoint.skipped} skipped, ${checkpoint.errors.length} errors${dryRun ? " (DRY RUN)" : ""}${errorTail}`,
          );
          return checkpoint;
        }
        throw fetchErr;
      }

      checkpoint.pages++;

      // Task #1789 — Same-response suppression. Hash the page payload
      // (stable conv id + last_message id + last_message timestamp) and
      // compare to the immediately-preceding page's hash within this
      // window. A match means Front re-served identical results (cursor
      // pagination loop, cache regression, or a cursor we already
      // processed). Skip persistence and advance the cursor only. The
      // hash is per-window/in-memory so process restarts re-establish
      // the baseline naturally. Behavior-neutral when the switch is OFF.
      if (sameResponseSuppressionEnabled && conversations.length > 0) {
        const currentHash = hashConversationsPage(conversations);
        if (lastPageHash && currentHash === lastPageHash) {
          bumpSuppressionMetric("same_response_suppressed");
          console.warn(
            `[FrontRecovery] ${jobTag}front_recovery_same_response_suppressed window=${window.label} page=${checkpoint.pages} conv_count=${conversations.length} hash=${currentHash.slice(0, 12)} — skipping persistence, advancing cursor`,
          );
          // Mirror the inter-page cursor + checkpoint persist that the
          // normal page-done path would do, then continue the while
          // loop without running per-conv ingest. If Front returned a
          // short page, the same length-based break the regular path
          // uses still applies.
          checkpoint.lastPageUrl = nextPageUrl;
          await saveCheckpoint(checkpoint);
          activeWindowCheckpoint = checkpoint;
          options?.onProgress?.(checkpoint);
          logRecoveryPageHeartbeat({
            jobId: options?.jobId,
            windowLabel: window.label,
            checkpoint,
            nextPage: nextPageUrl ? "yes" : "no",
            dryRun,
            context: "page_done",
          });
          if (conversations.length < batchSize) break;
          path = nextPageUrl;
          // Keep `lastPageHash` set to the current hash so a subsequent
          // identical page is also suppressed (Front may serve the same
          // cached page multiple times in a row).
          lastPageHash = currentHash;
          continue;
        }
        lastPageHash = currentHash;
      }

      // Task #1789 — Active-inbox filter. Front omits archived/disabled
      // inboxes from `/inboxes`, so any inbox id we can extract from a
      // conv that isn't in `activeInboxIds` is treated as inactive and
      // skipped. Convs without any extractable inbox id pass through
      // (the filter is conservative — we never drop a conv just because
      // the payload was opaque). Counts surface as
      // `inactive_inbox_skipped` in `retriesByReason` so the trends
      // panel can render the filter activity alongside other per-window
      // skip reasons.
      let inactiveInboxSkippedThisPage = 0;
      if (activeInboxFilterEnabled && activeInboxIds && conversations.length > 0) {
        const kept: any[] = [];
        for (const conv of conversations) {
          const convInboxIds = extractConvInboxIds(conv);
          if (convInboxIds.length === 0) {
            kept.push(conv);
            continue;
          }
          const anyActive = convInboxIds.some((id) => activeInboxIds.has(id));
          if (anyActive) {
            kept.push(conv);
          } else {
            inactiveInboxSkippedThisPage++;
            checkpoint.skipped++;
          }
        }
        if (inactiveInboxSkippedThisPage > 0) {
          bumpSuppressionMetric("inactive_inbox_skipped", inactiveInboxSkippedThisPage);
          console.log(
            `[FrontRecovery] ${jobTag}front_recovery_inactive_inbox_skipped window=${window.label} page=${checkpoint.pages} skipped=${inactiveInboxSkippedThisPage} kept=${kept.length}`,
          );
        }
        conversations = kept;
      }

      // Task #1024: process the page in small parallel chunks bounded by
      // FRONT_RECOVERY_INGEST_CONCURRENCY (default 1 = serial). On a
      // pg-pool saturation hit we abort the rest of the page early and
      // resume from the same page URL on the next run (writes are
      // idempotent via the per-conv dedupe key).
      //
      // Task #1730 (Phase 3.4): concurrency is now live-tunable via
      // `front_recovery_ingest_concurrency`. The setting overrides the
      // PERF default so operators can ramp 1 → 2 → 3 with explicit
      // observation windows without a redeploy.
      const tuning = getFrontRecoveryTuning();
      const ingestConcurrency = tuning.ingestConcurrency;
      console.log(
        `[FrontRecovery] ${jobTag}Window ${window.label}: processing page ${checkpoint.pages} with concurrency=${ingestConcurrency} (convs=${conversations.length}, consecutive_saturated=${consecutiveSaturatedPages}/${tuning.dbSaturatedRequiredSignals})`,
      );
      let pageAborted = false;
      let pageSaturationMessage = "";
      let pageSaturationCount = 0;

      const processOne = async (
        conv: any,
      ): Promise<
        | { ok: true; deduplicated: boolean }
        | { ok: false; saturated: boolean; convId: string; message: string }
      > => {
        const convId = conv.id;
        const msgVersion = extractFrontConvMessageVersion(conv);
        const dedupeKey = PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED
          ? `front:recovery:${convId}:${msgVersion}`
          : `front:recovery:${convId}`;
        try {
          const ingestResult = await ingestEvent({
            sourceSystem: "front",
            sourceEventType: "historical_recovery",
            sourceObjectId: convId,
            dedupeKey,
            payloadJson: conv as any,
            receivedAt: new Date(),
          });
          if (ingestResult.deduplicated) {
            return { ok: true, deduplicated: true };
          }
          if (PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED) {
            try {
              await enqueueJob({
                queueName: "front_webhook_normalize",
                // Tagged `ingestion` to match the four reconciliation /
                // full-backfill enqueue sites in frontWebhookIngestion.ts —
                // see the rationale comments there. Historical recovery
                // would otherwise be the only path still feeding the 1-slot
                // `maintenance` class.
                workloadClass: "front_ingestion",
                priority: 200,
                payload: {
                  sourceEventId: ingestResult.id,
                  fromReconciliation: true,
                },
                dedupeKey: `normalize:${ingestResult.id}`,
              });
            } catch (enqueueErr: any) {
              if (isDbPoolSaturationError(enqueueErr)) {
                return {
                  ok: false,
                  saturated: true,
                  convId,
                  message: enqueueErr?.message ?? String(enqueueErr),
                };
              }
              console.error(`[FrontRecovery] ${jobTag}Enqueue normalize failed:`, enqueueErr);
            }
          } else {
            try {
              await normalizeReconciliationEvent(ingestResult.id);
            } catch (inlineErr: any) {
              if (isDbPoolSaturationError(inlineErr)) {
                return {
                  ok: false,
                  saturated: true,
                  convId,
                  message: inlineErr?.message ?? String(inlineErr),
                };
              }
              console.error(`[FrontRecovery] ${jobTag}Inline normalize failed:`, inlineErr);
            }
          }
          return { ok: true, deduplicated: false };
        } catch (err: any) {
          if (isDbPoolSaturationError(err)) {
            return {
              ok: false,
              saturated: true,
              convId,
              message: err?.message ?? String(err),
            };
          }
          return {
            ok: false,
            saturated: false,
            convId,
            message: err?.message ?? String(err),
          };
        }
      };

      // Task #1869 Step 6 — per-page dedupe tracking so we can sample
      // dedupe-hit conv ids when the page is >95% dedupe-skipped.
      let pageScanned = 0;
      let pageDedupeSkipped = 0;
      const pageDedupeConvIds: string[] = [];
      for (let i = 0; i < conversations.length && !pageAborted; i += ingestConcurrency) {
        const batch = conversations.slice(i, i + ingestConcurrency);
        if (dryRun) {
          checkpoint.scanned += batch.length;
          checkpoint.ingested += batch.length;
          pageScanned += batch.length;
          continue;
        }
        checkpoint.scanned += batch.length;
        pageScanned += batch.length;
        const results = await Promise.all(batch.map(processOne));
        for (let bi = 0; bi < results.length; bi++) {
          const r = results[bi];
          if (r.ok) {
            if (r.deduplicated) {
              checkpoint.skipped++;
              pageDedupeSkipped++;
              const convId = batch[bi]?.id;
              if (convId && pageDedupeConvIds.length < 10) {
                pageDedupeConvIds.push(convId);
              }
            } else {
              checkpoint.ingested++;
            }
          } else if (r.saturated) {
            pageAborted = true;
            pageSaturationMessage = r.message;
            pageSaturationCount++;
            console.warn(
              `[FrontRecovery] ${jobTag}Window ${window.label}: db_pool_saturated detected on conv=${r.convId} page=${checkpoint.pages} — ${r.message}`,
            );
            checkpoint.errors.push(`${r.convId}: db_pool_saturated: ${r.message}`);
          } else {
            checkpoint.errors.push(`${r.convId}: ${r.message}`);
          }
        }
      }

      // Step 6 emits a fire-and-forget sample lookup once per page when
      // dedupe dominance crosses 95%. Failures only log — never abort
      // the page.
      if (!pageAborted) {
        await sampleDedupeAppliedStatus({
          jobTag,
          jobId: options?.jobId ?? null,
          windowLabel: window.label,
          pageNumber: checkpoint.pages,
          pageScanned,
          pageDedupeSkipped,
          dedupeConvIds: pageDedupeConvIds,
        });
      }

      if (pageAborted) {
        // Task #1730 (Phase 3.2): a saturated page bumps the consecutive
        // counter; the inter-page sleep decision below uses it against
        // `dbSaturatedRequiredSignals` so a single blip no longer slows
        // the whole window. The counter still drives `partial` status
        // so resume semantics are unchanged.
        consecutiveSaturatedPages += 1;
        // Resume from the *current* page URL on the next run. Writes are
        // idempotent via the per-conv dedupe key so re-processing already
        // ingested conversations on this page is harmless.
        checkpoint.lastPageUrl = path;
        checkpoint.status = "partial";
        checkpoint.statusReason = `db_pool_saturated: ${pageSaturationMessage}`;
        // Task #1024: surface saturation events through the resilience
        // telemetry the admin UI already renders so the new badge appears
        // alongside other per-window retry breakdowns.
        bumpDbSaturationRetry(pageSaturationCount);
        checkpoint.completedAt = new Date().toISOString();
        await saveCheckpoint(checkpoint);
        activeWindowCheckpoint = checkpoint;
        options?.onProgress?.(checkpoint);
        logRecoveryPageHeartbeat({
          jobId: options?.jobId,
          windowLabel: window.label,
          checkpoint,
          nextPage: "preserved",
          dryRun,
          context: "page_aborted",
        });
        console.warn(
          `[FrontRecovery] ${jobTag}Window ${window.label}: aborting page ${checkpoint.pages} on db_pool_saturated — resume_url preserved (${pageSaturationMessage})`,
        );
        const firstError = checkpoint.errors[0];
        const errorTail =
          checkpoint.errors.length > 0 && firstError
            ? ` — first error: ${firstError.length > 300 ? firstError.slice(0, 300) + "…" : firstError}`
            : "";
        console.log(
          `[FrontRecovery] ${jobTag}Window ${window.label}: status=${checkpoint.status} ${checkpoint.pages} pages, ${checkpoint.scanned} scanned, ${checkpoint.ingested} ingested, ${checkpoint.skipped} skipped, ${checkpoint.errors.length} errors${dryRun ? " (DRY RUN)" : ""}${errorTail}`,
        );
        return checkpoint;
      }

      checkpoint.lastPageUrl = nextPageUrl;

      // Task #1636: persist after every completed page so a crash /
      // SIGTERM / pool saturation never loses the resume cursor or
      // bookkeeping counters from pages 1..N-1.
      await saveCheckpoint(checkpoint);
      activeWindowCheckpoint = checkpoint;
      options?.onProgress?.(checkpoint);
      logRecoveryPageHeartbeat({
        jobId: options?.jobId,
        windowLabel: window.label,
        checkpoint,
        nextPage: nextPageUrl ? "yes" : "no",
        dryRun,
        context: "page_done",
      });

      if (conversations.length < batchSize) {
        break;
      }

      path = nextPageUrl;

      if (path) {
        // Task #1024 / Task #1730 (Phase 3.1–3.3): adaptive inter-page
        // backoff with three live-tunable inputs:
        //   - Phase 3.1 hysteresis-aware API-pool-pressure check
        //     (`evaluateApiPoolPressureWithHysteresis`) so single
        //     transient bursts do not trigger repeated sleeps; pool
        //     must clear under `clearPercent` before pressure flips
        //     back off.
        //   - Phase 3.2 saturation-required-signals — only apply the
        //     longer "saturated" delay once the consecutive-saturation
        //     counter meets `dbSaturatedRequiredSignals`. A clean page
        //     resets the counter, so single blips no longer slow the
        //     whole window 10×.
        //   - Phase 3.3 base page delay — `front_recovery_page_delay_ms`
        //     overrides the PERF default; when the tuning kill switch
        //     is on the default drops from 500ms to 200ms.
        // Re-read tuning here so a settings flip during a long window
        // takes effect on the very next sleep.
        const pageTuning = getFrontRecoveryTuning();
        const pressureSnapshot = isApiPoolUnderPressure();
        const pressureDecision = evaluateApiPoolPressureWithHysteresis(
          apiPoolPressureState,
          {
            utilizationPct: pressureSnapshot.utilizationPct,
            waitingCount: pressureSnapshot.waitingCount,
          },
          pageTuning,
        );
        if (!pageAborted) {
          // Clean page — reset the consecutive-saturation counter so
          // the next saturation event starts a fresh streak.
          consecutiveSaturatedPages = 0;
        }
        const saturationGate =
          consecutiveSaturatedPages >= pageTuning.dbSaturatedRequiredSignals;
        const useLongerDelay = pressureDecision.pressured || saturationGate;
        const delayMs = useLongerDelay
          ? pageTuning.dbSaturatedPageDelayMs
          : pageTuning.pageDelayMs;
        if (useLongerDelay) {
          const reason = pressureDecision.pressured
            ? `pressure(${pressureDecision.reason})`
            : `consecutive_saturated=${consecutiveSaturatedPages}>=${pageTuning.dbSaturatedRequiredSignals}`;
          console.warn(
            `[FrontRecovery] ${jobTag}Window ${window.label}: adaptive backoff ${delayMs}ms before next page — ${reason}`,
          );
        } else if (pressureDecision.changed) {
          // Log the transition back to "clear" once, so operators can
          // confirm the pool genuinely recovered between pages.
          console.log(
            `[FrontRecovery] ${jobTag}Window ${window.label}: api pool pressure cleared — ${pressureDecision.reason}`,
          );
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (checkpoint.pages === 0) {
      checkpoint.status = "blocked";
      checkpoint.statusReason = "no_pages_fetched";
    } else if (checkpoint.errors.length > 0 && checkpoint.scanned === 0) {
      checkpoint.status = "failed";
      checkpoint.statusReason = "errors_with_no_progress";
    } else if (checkpoint.scanned === 0) {
      // Zero scanned without any independent completeness proof. Never claim
      // success — this could be insufficient token scope, fragile query
      // shape, or pagination pathology. Operator must inspect.
      checkpoint.status = "empty_source";
      checkpoint.statusReason =
        "zero_results_no_completeness_proof: pages=" + checkpoint.pages +
        " — possible causes: token scope insufficient, query unsupported, or window genuinely empty in Front";
    } else if (checkpoint.lastPageUrl && checkpoint.pages >= SAFETY_MAX_PAGES) {
      checkpoint.status = "partial";
      checkpoint.statusReason = "safety_max_pages_reached_resume_available";
    } else {
      checkpoint.status = "complete";
    }
  } catch (err: any) {
    // Task #1024: pg-pool saturation is transient and resumable. Always
    // mark partial (never failed) so the auto-continue sweep / manual
    // resume can pick up from the preserved checkpoint after the pool
    // has had time to drain. Front-side errors keep the original
    // partial/failed split based on whether any progress was recorded.
    if (isDbPoolSaturationError(err)) {
      // Preserve the page we were on so resume re-fetches it. Idempotent
      // dedupe key on ingestEvent makes re-processing safe.
      if (path) checkpoint.lastPageUrl = path;
      checkpoint.status = "partial";
      checkpoint.statusReason = `db_pool_saturated: ${err?.message ?? String(err)}`;
      // Task #1730 (Phase 3.2): mid-window saturation errors are
      // terminal for this window invocation — the consecutive-saturated
      // counter is bumped so the next call's first decision sees the
      // streak in the (rare) case the same window is re-entered without
      // a fresh counter reset.
      consecutiveSaturatedPages += 1;
      bumpDbSaturationRetry(1);
      console.warn(
        `[FrontRecovery] ${jobTag}Window ${window.label}: db_pool_saturated mid-window — marking partial, resume_url preserved (${err?.message ?? String(err)})`,
      );
    } else {
      checkpoint.status = checkpoint.lastPageUrl || checkpoint.scanned > 0 ? "partial" : "failed";
      checkpoint.statusReason = `error: ${err?.message ?? String(err)}`;
    }
    checkpoint.errors.push(err?.message ?? String(err));
    // Task #1636: ensure the transient-error path also propagates the
    // latest counters into the job-level state and emits a heartbeat,
    // so the last persisted state and last log line agree.
    options?.onProgress?.(checkpoint);
    logRecoveryPageHeartbeat({
      jobId: options?.jobId,
      windowLabel: window.label,
      checkpoint,
      nextPage: "preserved",
      dryRun,
      context: "transient_error",
    });
  }

  checkpoint.completedAt = new Date().toISOString();
  await saveCheckpoint(checkpoint);
  activeWindowCheckpoint = checkpoint;

  // Task #1869 Step 5 — fold this invocation's deltas into the
  // per-month cumulative store. Dry runs do not advance Front state
  // and must not pollute the cumulative.
  if (!dryRun) {
    const scannedDelta = Math.max(0, checkpoint.scanned - priorScanned);
    const ingestedDelta = Math.max(0, checkpoint.ingested - priorIngested);
    const dedupeSkippedDelta = Math.max(0, checkpoint.skipped - priorSkipped);
    const pagesDelta = Math.max(0, checkpoint.pages - priorPages);
    const curSameResponse = Number(
      checkpoint.retriesByReason?.["same_response_suppressed"] ?? 0,
    );
    const curInactiveInbox = Number(
      checkpoint.retriesByReason?.["inactive_inbox_skipped"] ?? 0,
    );
    const sameResponseDelta = Math.max(0, curSameResponse - priorSameResponseSkipped);
    // `inactive_inbox_skipped` is double-counted here vs. checkpoint.skipped
    // (skipped counts both dedupe and inactive-inbox); we still surface
    // inactive_inbox separately so trends can subtract it.
    const inactiveInboxDelta = Math.max(0, curInactiveInbox - priorInactiveInboxSkipped);
    const observedPct =
      scannedDelta > 0 ? dedupeSkippedDelta / scannedDelta : null;
    await updateRecoveryCumulative({
      windowLabel: window.label,
      afterTimestamp: window.afterTimestamp,
      scannedDelta,
      ingestedDelta,
      dedupeSkippedDelta,
      sameResponseSkippedDelta: sameResponseDelta,
      inactiveInboxSkippedDelta: inactiveInboxDelta,
      pagesWalkedDelta: pagesDelta,
      lastObservedDedupePct: observedPct,
    });
  }

  // Surface the first error in the per-window summary line so operators
  // never see "1 errors" with no indication what went wrong.
  const firstError = checkpoint.errors[0];
  const errorTail =
    checkpoint.errors.length > 0 && firstError
      ? ` — first error: ${firstError.length > 300 ? firstError.slice(0, 300) + "…" : firstError}`
      : "";
  console.log(
    `[FrontRecovery] ${jobTag}Window ${window.label}: status=${checkpoint.status} ${checkpoint.pages} pages, ${checkpoint.scanned} scanned, ${checkpoint.ingested} ingested, ${checkpoint.skipped} skipped, ${checkpoint.errors.length} errors${dryRun ? " (DRY RUN)" : ""}${errorTail}`,
  );

  return checkpoint;
}

// Task #1886 — Recovery windows historically used
// `/conversations?sort_by=date&q[after]&q[before]`, but that
// enumeration ranks results by *most recent activity*, so any older
// conv bumped by a new message lands at the head of the list. For
// months whose entire missing tail sits behind ~25k already-ingested
// bumped convs, the recovery loop hits the 500-page safety cap before
// ever paginating to the genuinely-new tail.
//
// The search endpoint (`/conversations/search/<query>` with
// `after:UNIX before:UNIX`) orders strictly within the window and does
// NOT resurface bumped-from-outside convs, so it surfaces the missing
// tail directly. Response shape is identical
// (`{ _results, _pagination: { next } }`), so the existing
// `fetchFrontRecoveryPageWithRetry` consumer works unchanged.
//
// Gated by the `front_recovery_sparse_month_search_strategy_enabled`
// kill switch (default ON). When OFF, the legacy enumeration is used
// for every window. The strategy is decided per window at *initial*
// path build only — windows resumed from a saved `lastPageUrl`
// continue with whatever strategy produced that cursor (cursor URLs
// are opaque to us and not portable across endpoints). Operators who
// want a partial window to flip strategies must clear its checkpoint
// first (see `resetStuckRecoveryCheckpoints` / the CEO action
// `reset_stuck_front_recovery_checkpoints`).
//
// Task #1963 — the previous ≤32-day "sparse single month" gate was
// removed. The search endpoint now applies to *every* bounded
// window (both `afterTimestamp` and `beforeTimestamp` set), not just
// short ones. The 32-day cap was an over-conservative guess from the
// initial rollout; the stuck-windows analysis showed long-range
// windows hit the exact same "bumped older conv resurfaces" failure
// mode as short ones. Open-ended catch-up (only `afterTimestamp`
// set) still falls back to the legacy enumeration because the
// search endpoint requires a bounded `before`.
const SEARCH_STRATEGY_PAGE_SIZE = 100; // Front search-endpoint max.

function isSearchStrategyEligible(window: RecoveryWindow): boolean {
  if (window.afterTimestamp <= 0 || window.beforeTimestamp <= 0) return false;
  const span = window.beforeTimestamp - window.afterTimestamp;
  if (span <= 0) return false;
  return true;
}

function buildInitialPath(window: RecoveryWindow, batchSize: number): string {
  if (
    isSearchStrategyEligible(window) &&
    isPoolEpicSwitchEnabled("front_recovery_sparse_month_search_strategy_enabled")
  ) {
    // `/conversations/search/<encoded-query>?limit=N` — paginated via
    // `_pagination.next` exactly like the listing endpoint. Page size
    // capped at 100 (Front's documented search-endpoint maximum).
    const query = `after:${window.afterTimestamp} before:${window.beforeTimestamp}`;
    const encoded = encodeURIComponent(query);
    const limit = Math.min(batchSize, SEARCH_STRATEGY_PAGE_SIZE);
    return `/conversations/search/${encoded}?limit=${limit}`;
  }
  let path = `/conversations?limit=${batchSize}&sort_by=date&sort_order=asc`;
  if (window.afterTimestamp > 0) {
    path += `&q[after]=${window.afterTimestamp}`;
  }
  if (window.beforeTimestamp > 0) {
    path += `&q[before]=${window.beforeTimestamp}`;
  }
  return path;
}

export async function runHistoricalRecovery(options?: {
  dryRun?: boolean;
  customWindows?: RecoveryWindow[];
  // Task #989 lineage / continuation hints. All optional.
  continuesJobId?: string;
  continuationType?: "manual" | "auto";
  autoContinueAttempt?: number;
  autoContinueLineageRootJobId?: string;
  // When "clear_checkpoints" we delete saved per-window checkpoints
  // before starting so the next run begins from page 1. When unset or
  // "preserve_checkpoints" the standard resume-from-cursor logic applies.
  resumeMode?: "preserve_checkpoints" | "clear_checkpoints";
  // Optional progress fingerprint snapshot inherited from the source
  // job. Used by the auto-continue sweep to detect no-progress chains.
  lastProgressFingerprint?: string;
  lastGapMonthsSnapshot?: string[];
}): Promise<string> {
  const dryRun = options?.dryRun ?? false;
  const jobId = `recovery-${Date.now()}`;

  await hydrateRecoveryJobs();
  // Warp-drain (2026-05-26): allow up to N concurrent recovery jobs so a
  // multi-month ingest gap can drain in parallel instead of serially. Cap
  // is read from `front_recovery_max_concurrent_jobs` (default 3, clamped
  // ≥1). Safe because each recovery job is a separate month window and
  // each is already throttled internally by `front_recovery_ingest_concurrency`
  // (default 2), the Front rate-limit guard, same-response suppression,
  // active-inbox filter, and pool-pressure backoff. Set cap=1 to restore
  // the legacy serialize-everything behavior.
  //
  // RACE-FREE REGISTRATION: pre-fetch the cap (async), then in a single
  // synchronous tick count {queued,running} jobs, compare to the cap, and
  // immediately register a placeholder `jobState` with status='queued'.
  // Because Node is single-threaded between awaits, no concurrent invocation
  // can pass the check between our count and our `recoveryJobs.set(...)`.
  // Subsequent calls in the same tick will see our 'queued' entry and back
  // off. The placeholder is the same object reference we mutate later, so
  // the existing `recoveryJobs.set(jobId, jobState)` further down is a
  // harmless no-op.
  const cap = await getMaxConcurrentRecoveryJobs();
  const activeCount = Array.from(recoveryJobs.values()).filter(
    (j) => j.status === "running" || j.status === "queued",
  ).length;
  if (activeCount >= cap) {
    throw new RecoveryConcurrencyCapError(activeCount, cap);
  }

  // Construct jobState and register it IMMEDIATELY — no await between the
  // cap check above and this `recoveryJobs.set(...)`. Any concurrent
  // runHistoricalRecovery() call awaiting `getMaxConcurrentRecoveryJobs()`
  // will, on resume, see our 'queued' entry in the active count and back
  // off with RecoveryConcurrencyCapError. The clear_checkpoints loop and
  // all later setup runs AFTER registration so the atomicity guarantee
  // holds even on the "Run again" path.
  const jobState: RecoveryJobState = {
    jobId,
    status: "queued",
    statusReason: "queued_pending_coverage_scan",
    dryRun,
    coverageReport: null,
    windows: [],
    totals: { scanned: 0, ingested: 0, skipped: 0, errors: 0, pages: 0 },
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    requestedCustomWindows: options?.customWindows?.length
      ? options.customWindows.map((w) => ({
          label: w.label,
          afterTimestamp: w.afterTimestamp,
          beforeTimestamp: w.beforeTimestamp,
        }))
      : null,
    continuesJobId: options?.continuesJobId,
    continuationType: options?.continuationType,
    autoContinueAttempt: options?.autoContinueAttempt,
    autoContinueLineageRootJobId:
      options?.autoContinueLineageRootJobId ?? options?.continuesJobId,
    lastProgressFingerprint: options?.lastProgressFingerprint,
    lastGapMonthsSnapshot: options?.lastGapMonthsSnapshot,
  };
  recoveryJobs.set(jobId, jobState);

  // Task #989: optionally clear saved per-window cursors so a "Run again"
  // truly restarts from page 1. Safe to run AFTER registration: the cap
  // check has already passed and we are committed to this jobId. The
  // earlier "must run AFTER the alreadyRunning guard" rule is still
  // satisfied (cap check is the modern equivalent), and now the awaits
  // here cannot reintroduce a check/register race.
  if (
    options?.resumeMode === "clear_checkpoints" &&
    Array.isArray(options.customWindows) &&
    options.customWindows.length > 0
  ) {
    for (const w of options.customWindows) {
      try {
        await storage.deleteSystemSetting(checkpointKey(w.label));
      } catch (clearErr: any) {
        console.error(
          `[FrontRecovery] Failed to clear checkpoint for window ${w.label}: ${clearErr?.message ?? String(clearErr)}`,
        );
      }
    }
    console.log(
      `[FrontRecovery] Cleared ${options.customWindows.length} per-window checkpoint(s) for run_again job ${jobId}`,
    );
  }
  // Task #1636: track this job for the shutdown flush + register the
  // signal handlers once. Cleared in the IIFE's finally block.
  activeRecoveryJobState = jobState;
  registerShutdownFlushOnce();
  logRecoveryEvent(jobId, "queued", {
    dryRun,
    customWindows: options?.customWindows?.length ?? 0,
    continuesJobId: options?.continuesJobId ?? "",
    continuationType: options?.continuationType ?? "",
    autoContinueAttempt: options?.autoContinueAttempt ?? 0,
    resumeMode: options?.resumeMode ?? "preserve_checkpoints",
  });
  await persistJob(jobState);

  (async () => {
    // Task #1723 Phase 2.3: the recovery loop is a heavy background job
    // (coverage scans, per-window page ingestion, checkpoint persists,
    // auto-continue bookkeeping). Wrap the entire body in
    // `runWithWorkerDb` so every nested `storage.*` / `getDb()` call
    // lands on the worker pool — even though `runHistoricalRecovery`
    // itself is invoked from API-pool route handlers.
    await runWithWorkerDb(async () => {
    // Tracks whether we've already emitted a contention warning so we don't
    // spam the log when many DB calls slow down in succession.
    const contention: DbContentionState = { logged: false };
    try {
      jobState.status = "running";
      jobState.statusReason = "scanning_coverage";
      logRecoveryEvent(jobId, "running");
      await withDbTiming(jobState, contention, "persistJob:running", () =>
        persistJob(jobState),
      );

      const coverageStart = Date.now();
      const report = await withDbTiming(
        jobState,
        contention,
        "generateCoverageReport",
        () => generateCoverageReport(),
      );
      const coverageElapsed = Date.now() - coverageStart;
      jobState.coverageReport = report;
      // Preserve any db_pool_contended:* tag set during the coverage scan
      // — clearing it here would erase the only operator-visible signal
      // that the job was starved on DB acquires.
      setStatusReasonPreservingContention(jobState, null);
      logRecoveryEvent(jobId, "coverage_scanned", {
        ms: coverageElapsed,
        gaps: report.gaps.length,
        months: report.months.length,
        totalFrontSync: report.totalFrontSync,
      });
      await withDbTiming(jobState, contention, "persistJob:coverage_scanned", () =>
        persistJob(jobState),
      );

      const windowSource: "custom" | "default" | "empty" = options?.customWindows?.length
        ? "custom"
        : "default";
      const windows = options?.customWindows?.length
        ? options.customWindows
        : buildDefaultRecoveryWindows(report);

      logRecoveryEvent(jobId, "windows_resolved", {
        count: windows.length,
        source: windows.length === 0 ? "empty" : windowSource,
        labels: windows.map((w) => w.label).join(",") || "<none>",
      });

      if (windows.length === 0) {
        jobState.status = "complete";
        // Preserve any db_pool_contended:* tag set during coverage scanning.
        // If contention was detected, the operator should still see it
        // even though the no-gaps terminal outcome itself is clean.
        setStatusReasonPreservingContention(jobState, "no_gaps_identified");
        jobState.completedAt = new Date().toISOString();
        await withDbTiming(jobState, contention, "persistJob:no_gaps", () =>
          persistJob(jobState),
        );
        logRecoveryEvent(jobId, "terminal", {
          status: "complete",
          reason: "no_gaps_identified",
          scanned: 0,
          ingested: 0,
          windows: 0,
        });
        return;
      }

      console.log(
        `[FrontRecovery] [job=${jobId}] Starting recovery with ${windows.length} windows${dryRun ? " (DRY RUN)" : ""}: ${windows.map((w) => w.label).join(", ")}`,
      );

      for (const window of windows) {
        logRecoveryEvent(jobId, "window_started", { label: window.label });
        const checkpoint = await runTargetedWindowBackfill(window, {
          dryRun,
          resume: true,
          jobId,
          onProgress: (cp) => {
            const idx = jobState.windows.findIndex((w) => w.windowLabel === cp.windowLabel);
            if (idx >= 0) {
              jobState.windows[idx] = cp;
            } else {
              jobState.windows.push(cp);
            }
            updateTotals(jobState);
            // Fire-and-forget but with its own catch so an unhandled
            // rejection cannot kill the recovery run silently.
            safePersistJob(jobState, "onProgress");
          },
        });

        const existingIdx = jobState.windows.findIndex((w) => w.windowLabel === checkpoint.windowLabel);
        if (existingIdx >= 0) {
          jobState.windows[existingIdx] = checkpoint;
        } else {
          jobState.windows.push(checkpoint);
        }
        updateTotals(jobState);
        await withDbTiming(jobState, contention, "persistJob:window_finished", () =>
          persistJob(jobState),
        );

        logRecoveryEvent(jobId, "window_finished", {
          label: window.label,
          status: checkpoint.status,
          reason: checkpoint.statusReason ?? "",
          pages: checkpoint.pages,
          scanned: checkpoint.scanned,
          ingested: checkpoint.ingested,
          skipped: checkpoint.skipped,
          errors: checkpoint.errors.length,
          firstError: checkpoint.errors[0]
            ? checkpoint.errors[0].length > 200
              ? checkpoint.errors[0].slice(0, 200) + "…"
              : checkpoint.errors[0]
            : "",
        });

        // Task #1023: warn admins when a window had to retry against
        // Front excessively. Fire-and-forget — never let an alert
        // failure derail the recovery loop. The watcher dedupes per
        // (jobId, windowLabel) so resume/auto-continue won't re-alert.
        void (async () => {
          try {
            const {
              evaluateWindowForRetryPressure,
              evaluateConsecutiveWindowsForFront5xxPressure,
              evaluateWindowForSuppressionDominance,
              evaluateEmptySuffixDedupeKeys,
            } = await import("./frontRecoveryRetryAlerts");
            const r = await evaluateWindowForRetryPressure({
              jobId,
              checkpoint,
            });
            // Task #1084: persist the alert event onto the window
            // checkpoint so the recovery panel timeline can render it
            // without needing a separate API. We only record events
            // that are operator-actionable — trivial skips
            // (`skipped_below_threshold`, `skipped_already_alerted`)
            // are not pushed onto the timeline.
            const recordable =
              r.decision !== "skipped_below_threshold" &&
              r.decision !== "skipped_already_alerted";
            if (recordable) {
              const idx = jobState.windows.findIndex(
                (w) => w.windowLabel === checkpoint.windowLabel,
              );
              const target = idx >= 0 ? jobState.windows[idx] : checkpoint;
              const list = Array.isArray(target.retryPressureAlerts)
                ? target.retryPressureAlerts.slice()
                : [];
              list.push({
                at: new Date().toISOString(),
                decision: r.decision as
                  | "alerted"
                  | "skipped_disabled"
                  | "skipped_send_failed"
                  | "skipped_dispatcher_skipped"
                  | "skipped_no_counters",
                totalRetries: r.totalRetries,
                threshold: r.threshold,
                skipReason: r.skipReason,
              });
              target.retryPressureAlerts = list;
              if (idx >= 0) {
                jobState.windows[idx] = target;
              }
              safePersistJob(jobState, "retry_pressure_alert");
            }
            if (r.alerted) {
              logRecoveryEvent(jobId, "retry_pressure_alert_sent", {
                label: window.label,
                totalRetries: r.totalRetries,
                threshold: r.threshold,
              });
            } else if (recordable) {
              logRecoveryEvent(jobId, "retry_pressure_alert_skipped", {
                label: window.label,
                decision: r.decision,
                reason: r.skipReason ?? "",
                totalRetries: r.totalRetries,
                threshold: r.threshold,
              });
            }

            // Task #1083 — second signal: trailing N completed windows
            // each bleeding ≥ floor front_5xx retries.
            const c = await evaluateConsecutiveWindowsForFront5xxPressure({
              jobId,
              windows: jobState.windows,
            });
            if (c.alerted) {
              logRecoveryEvent(jobId, "retry_pressure_consecutive_alert_sent", {
                lastWindowLabel: c.trailingWindow?.windowLabel ?? "",
                consecutiveWindowCount: c.consecutiveWindowCount,
                consecutive5xxFloor: c.consecutive5xxFloor,
                matchedWindows: (c.matchedWindowLabels ?? []).join(","),
              });
            } else if (
              c.decision !== "skipped_not_enough_windows" &&
              c.decision !== "skipped_chain_broken" &&
              c.decision !== "skipped_below_floor" &&
              c.decision !== "skipped_already_alerted"
            ) {
              logRecoveryEvent(
                jobId,
                "retry_pressure_consecutive_alert_skipped",
                {
                  label: window.label,
                  decision: c.decision,
                  reason: c.skipReason ?? "",
                  consecutiveWindowCount: c.consecutiveWindowCount,
                  consecutive5xxFloor: c.consecutive5xxFloor,
                },
              );
            }
            // Task #1903 — same-response suppression dominance + the
            // sibling empty-suffix dedupe-key probe. Both watchers
            // dedupe per (jobId, windowLabel) so a long-running job
            // does not re-alert on every completed window. Fire only
            // when the window itself actually exercised the
            // suppression path (otherwise we'd run the empty-suffix
            // probe on every window for no signal).
            const sup = await evaluateWindowForSuppressionDominance({
              jobId,
              checkpoint,
            });
            if (sup.alerted) {
              logRecoveryEvent(
                jobId,
                "suppression_dominance_alert_sent",
                {
                  label: window.label,
                  suppressedPages: sup.suppressedPages,
                  pages: sup.pages,
                  ratio: sup.ratio,
                  ratioThreshold: sup.ratioThreshold,
                  minPages: sup.minPages,
                },
              );
            } else if (
              sup.decision !== "skipped_below_ratio" &&
              sup.decision !== "skipped_below_min_pages" &&
              sup.decision !== "skipped_already_alerted"
            ) {
              logRecoveryEvent(
                jobId,
                "suppression_dominance_alert_skipped",
                {
                  label: window.label,
                  decision: sup.decision,
                  reason: sup.skipReason ?? "",
                  ratio: sup.ratio,
                  ratioThreshold: sup.ratioThreshold,
                },
              );
            }
            // Only probe `source_event_log` when this window observed
            // at least one same-response suppression skip — that's
            // the strongest in-process signal the dedupe slot may have
            // collapsed, and it keeps the probe off the hot path on
            // healthy windows.
            const suppressedThisWindow = Number(
              checkpoint.retriesByReason?.["same_response_suppressed"] ?? 0,
            );
            if (suppressedThisWindow > 0) {
              const es = await evaluateEmptySuffixDedupeKeys({
                jobId,
                windowLabel: checkpoint.windowLabel,
              });
              if (es.alerted) {
                logRecoveryEvent(
                  jobId,
                  "empty_suffix_dedupe_alert_sent",
                  {
                    label: window.label,
                    emptySuffixCount: es.emptySuffixCount,
                  },
                );
              } else if (
                es.decision !== "skipped_clean" &&
                es.decision !== "skipped_already_alerted"
              ) {
                logRecoveryEvent(
                  jobId,
                  "empty_suffix_dedupe_alert_skipped",
                  {
                    label: window.label,
                    decision: es.decision,
                    reason: es.skipReason ?? "",
                  },
                );
              }
            }
          } catch (err: any) {
            console.warn(
              `[FrontRecovery] [job=${jobId}] retry-pressure alert evaluation failed: ${err?.message ?? err}`,
            );
          }
        })();

        // Job-level early-stop on any non-transient auth failure.
        // Continuing to subsequent windows after a true disconnect or
        // permanent refresh failure just produces more identical
        // failures and noisier logs — abort the job and surface the
        // canonical reason so the admin can reconnect Front.
        const blockedAuthReasons = new Set([
          "front_not_connected",
          "front_auth_refresh_failed",
          "front_auth_unauthorized_after_refresh",
        ]);
        if (
          checkpoint.status === "blocked" &&
          typeof checkpoint.statusReason === "string" &&
          blockedAuthReasons.has(checkpoint.statusReason)
        ) {
          const reason = checkpoint.statusReason;
          const errorMsg =
            reason === "front_not_connected"
              ? "Front not connected"
              : reason === "front_auth_refresh_failed"
                ? "Front authorization failed — reconnect required"
                : "Front rejected refreshed token — reconnect required";
          jobState.status = "blocked";
          jobState.statusReason = reason;
          jobState.error = errorMsg;
          jobState.completedAt = new Date().toISOString();
          await withDbTiming(jobState, contention, "persistJob:blocked", () =>
            persistJob(jobState),
          );
          logRecoveryEvent(jobId, "terminal", {
            status: "blocked",
            reason,
            scanned: jobState.totals.scanned,
            ingested: jobState.totals.ingested,
            windows: jobState.windows.length,
          });
          return;
        }
      }

      const ws = jobState.windows;
      const counts = {
        complete: ws.filter((w) => w.status === "complete").length,
        empty: ws.filter((w) => w.status === "empty_source").length,
        partial: ws.filter((w) => w.status === "partial").length,
        blocked: ws.filter((w) => w.status === "blocked").length,
        failed: ws.filter((w) => w.status === "failed").length,
      };
      const progressed = ws.some((w) => w.scanned > 0 || w.ingested > 0);
      if (counts.failed === ws.length) {
        jobState.status = "failed";
        jobState.statusReason = "all_windows_failed";
        // Surface the first window error as the job-level error so the UI
        // doesn't show a blank `error` field when every window failed.
        const firstWinError = ws.map((w) => w.errors[0]).find((e) => !!e);
        if (firstWinError && !jobState.error) {
          jobState.error = firstWinError;
        }
      } else if (counts.blocked === ws.length && !progressed) {
        jobState.status = "blocked";
        jobState.statusReason = "all_windows_blocked";
      } else if (counts.empty === ws.length) {
        jobState.status = "blocked";
        jobState.statusReason =
          "all_windows_empty_first_page_no_completeness_proof: could be insufficient token scope, fragile query, or genuinely empty source. Inspect Front token scopes / inbox filters before re-running.";
      } else if (counts.partial > 0 || counts.failed > 0 || counts.blocked > 0 || counts.empty > 0) {
        // Any empty_source / partial / blocked / failed window prevents the
        // overall job from claiming complete — empty_source has no
        // independent completeness proof, so we mark partial with a clear
        // diagnostic so the operator can act on it.
        jobState.status = "partial";
        jobState.statusReason = `mixed_outcomes: complete=${counts.complete} empty_source=${counts.empty} partial=${counts.partial} blocked=${counts.blocked} failed=${counts.failed} — empty_source windows lack completeness proof and need operator review`;
        // Hoist a window-level error to the job-level error field so the
        // UI shows something actionable when there are partial/failed
        // windows but the job did not entirely fail.
        const firstWinError = ws.map((w) => w.errors[0]).find((e) => !!e);
        if (firstWinError && !jobState.error) {
          jobState.error = firstWinError;
        }
      } else {
        jobState.status = "complete";
        // Preserve db_pool_contended:* if set, otherwise clear. Operators
        // need the contention signal even on otherwise-clean completes.
        setStatusReasonPreservingContention(jobState, null);
      }
      jobState.completedAt = new Date().toISOString();

      const afterReport = dryRun
        ? null
        : await withDbTiming(
            jobState,
            contention,
            "generateCoverageReport:after",
            () => generateCoverageReport(),
          );
      if (afterReport) {
        await withDbTiming(jobState, contention, "setSystemSetting:after_report", () =>
          storage.setSystemSetting(
            "front_recovery_after_report",
            JSON.stringify(afterReport),
            "system",
          ),
        );
      }

      await withDbTiming(jobState, contention, "setSystemSetting:result", () =>
        storage.setSystemSetting(
          `front_recovery_result_${jobId}`,
          JSON.stringify({
            jobId,
            dryRun,
            windows: jobState.windows.map((w) => ({
              label: w.windowLabel,
              scanned: w.scanned,
              ingested: w.ingested,
              skipped: w.skipped,
              errors: w.errors.length,
            })),
            totals: jobState.totals,
            completedAt: jobState.completedAt,
          }),
          "system",
        ),
      );

      await withDbTiming(jobState, contention, "persistJob:terminal", () =>
        persistJob(jobState),
      );

      logRecoveryEvent(jobId, "terminal", {
        status: jobState.status,
        reason: jobState.statusReason ?? "",
        scanned: jobState.totals.scanned,
        ingested: jobState.totals.ingested,
        skipped: jobState.totals.skipped,
        errors: jobState.totals.errors,
        windows: jobState.windows.length,
        dryRun,
      });

      console.log(
        `[FrontRecovery] [job=${jobId}] Complete: status=${jobState.status} ${jobState.totals.scanned} scanned, ${jobState.totals.ingested} ingested, ${jobState.totals.skipped} skipped/duplicates${dryRun ? " (DRY RUN)" : ""}`,
      );
    } catch (err: any) {
      // Bulletproof terminal path: any throw from generateCoverageReport,
      // persistJob, setSystemSetting, the window loop, or anything else in
      // the IIFE body lands here. Always log a `Fatal error` line tagged
      // with the jobId + stack so the operator never sees the job
      // "disappear" mid-flight, and try to persist the failure even if
      // the persist itself can throw.
      const message = err?.message ?? String(err);
      // Task #1024: pg-pool saturation at the job level is transient. If
      // any window has a resumable checkpoint or recorded progress, mark
      // the job `partial` (with `db_pool_saturated:` reason) so the
      // auto-continue sweep can pick it up later instead of leaving it
      // permanently `failed`.
      const dbSaturated = isDbPoolSaturationError(err);
      const anyProgress =
        Array.isArray(jobState.windows) &&
        jobState.windows.some(
          (w) => (w.lastPageUrl && w.lastPageUrl.length > 0) || w.scanned > 0 || w.ingested > 0,
        );
      if (dbSaturated && anyProgress) {
        jobState.status = "partial";
        jobState.error = message;
        const contentionPrefix =
          typeof jobState.statusReason === "string" &&
          jobState.statusReason.startsWith("db_pool_contended:")
            ? `${jobState.statusReason} | `
            : "";
        jobState.statusReason = `${contentionPrefix}db_pool_saturated: ${message}`;
        jobState.completedAt = new Date().toISOString();
        console.warn(
          `[FrontRecovery] [job=${jobId}] db_pool_saturated at job level — marking partial (resumable). ${message}`,
        );
        try {
          await persistJob(jobState);
        } catch (persistErr: any) {
          console.error(
            `[FrontRecovery] [job=${jobId}] Failed to persist partial-state after db_pool_saturated: ${persistErr?.message ?? String(persistErr)}`,
          );
        }
        logRecoveryEvent(jobId, "terminal", {
          status: "partial",
          reason: jobState.statusReason ?? "",
          error: message,
        });
        return;
      }
      jobState.status = "failed";
      jobState.error = message;
      // Task #1024: even on the no-progress fatal-failure path, keep the
      // DB-flavored reason so downstream humanization (admin panel,
      // alerts) does not mislabel a pg-pool stall as a generic timeout.
      if (dbSaturated) {
        const contentionPrefix =
          typeof jobState.statusReason === "string" &&
          jobState.statusReason.startsWith("db_pool_contended:")
            ? `${jobState.statusReason} | `
            : "";
        jobState.statusReason = `${contentionPrefix}db_pool_saturated: ${message}`;
        jobState.completedAt = new Date().toISOString();
        console.error(
          `[FrontRecovery] [job=${jobId}] Fatal db_pool_saturated (no resumable progress): ${message}\n${err?.stack ?? ""}`,
        );
        try {
          await persistJob(jobState);
        } catch (persistErr: any) {
          console.error(
            `[FrontRecovery] [job=${jobId}] Failed to persist failed-state after db_pool_saturated: ${persistErr?.message ?? String(persistErr)}`,
          );
        }
        logRecoveryEvent(jobId, "terminal", {
          status: "failed",
          reason: jobState.statusReason ?? "",
          error: message,
        });
        return;
      }
      // The fatal error is the most specific signal we have for a failed
      // job — always replace any in-progress reason (e.g. "scanning_coverage")
      // so the operator never sees a stale "still working" reason on a job
      // that actually crashed. Carry forward db_pool_contended:* as a prefix
      // so the contention diagnostic is preserved alongside the fatal cause.
      const contentionPrefix =
        typeof jobState.statusReason === "string" &&
        jobState.statusReason.startsWith("db_pool_contended:")
          ? `${jobState.statusReason} | `
          : "";
      jobState.statusReason = `${contentionPrefix}fatal_error: ${message}`;
      jobState.completedAt = new Date().toISOString();
      console.error(
        `[FrontRecovery] [job=${jobId}] Fatal error: ${message}\n${err?.stack ?? ""}`,
      );
      try {
        await persistJob(jobState);
      } catch (persistErr: any) {
        console.error(
          `[FrontRecovery] [job=${jobId}] Failed to persist failed-state after fatal error: ${persistErr?.message ?? String(persistErr)}`,
        );
      }
      logRecoveryEvent(jobId, "terminal", {
        status: "failed",
        reason: jobState.statusReason ?? "",
        error: message,
      });
    } finally {
      // Task #1636: clear shutdown-flush tracking once this run has
      // reached a terminal state. A signal arriving after this point
      // has nothing to flush for this job.
      if (activeRecoveryJobState === jobState) {
        activeRecoveryJobState = null;
      }
      activeWindowCheckpoint = null;
    }
    });
  })().catch((err) => {
    // Final safety net: even if the IIFE's own try/catch somehow throws
    // synchronously while constructing the catch (extremely unlikely),
    // we still log it instead of letting it become an unhandled
    // rejection that silently kills the job.
    console.error(
      `[FrontRecovery] [job=${jobId}] Unhandled rejection from recovery IIFE: ${err?.message ?? String(err)}\n${err?.stack ?? ""}`,
    );
  });

  return jobId;
}

function updateTotals(job: RecoveryJobState): void {
  job.totals = {
    scanned: job.windows.reduce((s, w) => s + w.scanned, 0),
    ingested: job.windows.reduce((s, w) => s + w.ingested, 0),
    skipped: job.windows.reduce((s, w) => s + w.skipped, 0),
    errors: job.windows.reduce((s, w) => s + w.errors.length, 0),
    pages: job.windows.reduce((s, w) => s + w.pages, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Task #989: resume / run-again / auto-continue
// ─────────────────────────────────────────────────────────────────────────

export function buildProgressFingerprint(job: RecoveryJobState): string {
  // Task #1636: include per-window status, pages, and lastPageUrl so a
  // recovery that advances even a single page produces a different
  // fingerprint and the auto-continue sweep no longer mistakes real
  // progress for no_progress_since_last_attempt. Use literal "<none>"
  // as the cursor placeholder so null vs empty-string differences in
  // older persisted state can't perturb the fingerprint.
  const parts = (job.windows ?? [])
    .slice()
    .sort((a, b) => a.windowLabel.localeCompare(b.windowLabel))
    .map(
      (w) =>
        `${w.windowLabel}|${w.status}|${w.pages}|${w.scanned}|${w.ingested}|${
          w.lastPageUrl && w.lastPageUrl.length > 0 ? w.lastPageUrl : "<none>"
        }`,
    );
  return parts.join(";");
}

function reconstructWindowsFromJob(job: RecoveryJobState): RecoveryWindow[] {
  if (job.requestedCustomWindows && job.requestedCustomWindows.length > 0) {
    return job.requestedCustomWindows.map((w) => ({
      label: w.label,
      afterTimestamp: w.afterTimestamp,
      beforeTimestamp: w.beforeTimestamp,
    }));
  }
  if (Array.isArray(job.windows) && job.windows.length > 0) {
    return job.windows.map((w) => ({
      label: w.windowLabel,
      afterTimestamp: w.afterTimestamp,
      beforeTimestamp: w.beforeTimestamp,
    }));
  }
  return [];
}

export interface ResumeRecoveryJobResult {
  ok: true;
  jobId: string;
  sourceJobId: string;
  mode: "resume" | "run_again";
  continuesJobId: string;
  continuationType: "manual" | "auto";
  windows: number;
}

export async function resumeRecoveryJob(
  sourceJobId: string,
  mode: "resume" | "run_again",
  options?: {
    dryRun?: boolean;
    continuationType?: "manual" | "auto";
    lastGapMonthsSnapshot?: string[];
  },
): Promise<ResumeRecoveryJobResult> {
  const source = await getRecoveryJob(sourceJobId);
  if (!source) {
    throw new Error(`Source recovery job ${sourceJobId} not found`);
  }
  if (source.status === "running" || source.status === "queued") {
    throw new Error(`Source recovery job ${sourceJobId} is still active`);
  }
  const continuationType = options?.continuationType ?? "manual";
  if (mode === "resume") {
    const summary = await summarizeRecoveryJob(source);
    // Manual resume uses canManualResume (allows non_transient when
    // Front is reconnected); auto-continue uses canResume (strict).
    const eligible =
      continuationType === "manual" ? summary.canManualResume : summary.canResume;
    if (!eligible) {
      throw new Error(
        `Source recovery job ${sourceJobId} is not resumable (no checkpoint or non-transient failure)`,
      );
    }
  }
  const windows = reconstructWindowsFromJob(source);
  if (windows.length === 0) {
    throw new Error(
      `Source recovery job ${sourceJobId} has no reconstructable windows`,
    );
  }
  const lineageRoot =
    source.autoContinueLineageRootJobId ?? source.continuesJobId ?? source.jobId;
  const nextAttempt =
    continuationType === "auto"
      ? (source.autoContinueAttempt ?? 0) + 1
      : undefined;
  const newJobId = await runHistoricalRecovery({
    dryRun: options?.dryRun ?? !!source.dryRun,
    customWindows: windows,
    continuesJobId: sourceJobId,
    continuationType,
    autoContinueAttempt: nextAttempt,
    autoContinueLineageRootJobId: lineageRoot,
    resumeMode:
      mode === "resume" ? "preserve_checkpoints" : "clear_checkpoints",
    lastProgressFingerprint: buildProgressFingerprint(source),
    lastGapMonthsSnapshot: options?.lastGapMonthsSnapshot,
  });
  return {
    ok: true,
    jobId: newJobId,
    sourceJobId,
    mode,
    continuesJobId: sourceJobId,
    continuationType,
    windows: windows.length,
  };
}

export interface AutoContinueResult {
  considered: number;
  continuedJobIds: string[];
  skipped: number;
  skipReasons: Array<{ jobId: string; reason: string }>;
}

export async function autoContinuePartialRecoveryJobs(): Promise<AutoContinueResult> {
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    console.log(
      "[FrontRecovery] Auto-continue deferred this tick: kill switch 'non_critical_sweeps' is enabled",
    );
    return {
      considered: 0,
      continuedJobIds: [],
      skipped: 1,
      skipReasons: [{ jobId: "*", reason: "kill_switch_non_critical_sweeps" }],
    };
  }
  await hydrateRecoveryJobs();
  const activeJob = Array.from(recoveryJobs.values()).find(
    (j) => j.status === "running" || j.status === "queued",
  );
  if (activeJob) {
    console.log(
      `[FrontRecovery] Auto-continue deferred this tick: active recovery job ${activeJob.jobId} (${activeJob.status})`,
    );
    return {
      considered: 0,
      continuedJobIds: [],
      skipped: 1,
      skipReasons: [
        { jobId: activeJob.jobId, reason: `active_recovery_in_progress:${activeJob.status}` },
      ],
    };
  }
  const maxAttempts = await getRecoveryAutoContinueMaxAttempts();
  // Group by lineage root so we only consider the most recent partial
  // per lineage. Older partials in the same lineage have already been
  // superseded by their continuation job.
  const latestPerLineage = new Map<string, RecoveryJobState>();
  for (const job of recoveryJobs.values()) {
    if (job.status !== "partial" && job.status !== "failed") continue;
    const root =
      job.autoContinueLineageRootJobId ?? job.continuesJobId ?? job.jobId;
    const existing = latestPerLineage.get(root);
    if (
      !existing ||
      new Date(job.startedAt).getTime() > new Date(existing.startedAt).getTime()
    ) {
      latestPerLineage.set(root, job);
    }
  }
  const candidates = Array.from(latestPerLineage.values()).sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  const continuedJobIds: string[] = [];
  const skipReasons: Array<{ jobId: string; reason: string }> = [];
  let skipped = 0;

  // Pull a single live coverage report for this tick so we can verify that
  // each candidate's target months / windows still appear as gaps before
  // resuming. If the gap has already been closed by webhooks or another
  // recovery run we must not re-launch the same window.
  let liveGapMonths: Set<string> | null = null;
  let liveGapWindows: Array<{ afterTimestamp: number; beforeTimestamp: number }> | null = null;
  try {
    const report = await generateCoverageReport();
    liveGapMonths = new Set(
      (report.months ?? [])
        .filter((m) => m && m.month && m.totalCoverage < 10)
        .map((m) => m.month),
    );
    liveGapWindows = (report.gaps ?? []).map((g) => ({
      afterTimestamp: g.afterTimestamp,
      beforeTimestamp: g.beforeTimestamp,
    }));
  } catch (err: any) {
    console.warn(
      `[FrontRecovery] Auto-continue: live coverage report unavailable, skipping eligibility check this tick: ${err?.message ?? String(err)}`,
    );
  }

  function jobStillTargetsLiveGap(job: RecoveryJobState): boolean {
    if (!liveGapMonths && !liveGapWindows) return true; // best-effort if report failed
    // Prefer the snapshot we recorded at job start; fall back to the
    // job's window timestamps.
    const snapshot = Array.isArray(job.lastGapMonthsSnapshot) ? job.lastGapMonthsSnapshot : [];
    if (snapshot.length > 0 && liveGapMonths) {
      if (snapshot.some((m) => liveGapMonths!.has(m))) return true;
    }
    if (liveGapWindows && Array.isArray(job.windows)) {
      for (const w of job.windows) {
        if (w.status === "complete") continue;
        if (
          liveGapWindows.some(
            (g) => w.afterTimestamp < g.beforeTimestamp && w.beforeTimestamp > g.afterTimestamp,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  for (const job of candidates) {
    if (job.dryRun) {
      skipped++;
      skipReasons.push({ jobId: job.jobId, reason: "dry_run" });
      console.log(`[FrontRecovery] Auto-continue skip ${job.jobId}: dry_run`);
      continue;
    }
    const summary = await summarizeRecoveryJob(job);
    if (!summary.canResume) {
      skipped++;
      const reason = summary.reasonClassification ?? "not_resumable";
      skipReasons.push({ jobId: job.jobId, reason });
      console.log(`[FrontRecovery] Auto-continue skip ${job.jobId}: not_resumable (${reason})`);
      continue;
    }
    const attempt = job.autoContinueAttempt ?? 0;
    if (attempt >= maxAttempts) {
      skipped++;
      skipReasons.push({
        jobId: job.jobId,
        reason: `attempt_cap_reached:${attempt}/${maxAttempts}`,
      });
      console.log(
        `[FrontRecovery] Auto-continue skip ${job.jobId}: attempt cap reached (${attempt}/${maxAttempts})`,
      );
      continue;
    }
    const fingerprint = buildProgressFingerprint(job);
    if (
      job.lastProgressFingerprint &&
      job.lastProgressFingerprint === fingerprint
    ) {
      skipped++;
      skipReasons.push({
        jobId: job.jobId,
        reason: "no_progress_since_last_attempt",
      });
      console.log(
        `[FrontRecovery] Auto-continue skip ${job.jobId}: no progress since last attempt (fingerprint unchanged)`,
      );
      continue;
    }
    if (!jobStillTargetsLiveGap(job)) {
      skipped++;
      skipReasons.push({ jobId: job.jobId, reason: "gap_already_closed" });
      console.log(
        `[FrontRecovery] Auto-continue skip ${job.jobId}: target months/windows no longer appear as gaps in live coverage report`,
      );
      continue;
    }
    try {
      // Snapshot the live gap months at continuation creation so the
      // lineage carries diagnostic context for which gaps drove the
      // resume. Falls back to the parent's snapshot if the live report
      // was unavailable this tick.
      const snapshotForContinuation =
        liveGapMonths && liveGapMonths.size > 0
          ? Array.from(liveGapMonths).sort()
          : Array.isArray(job.lastGapMonthsSnapshot)
            ? job.lastGapMonthsSnapshot
            : undefined;
      const res = await resumeRecoveryJob(job.jobId, "resume", {
        dryRun: false,
        continuationType: "auto",
        lastGapMonthsSnapshot: snapshotForContinuation,
      });
      continuedJobIds.push(res.jobId);
      console.log(
        `[FrontRecovery] Auto-continued partial job ${job.jobId} → ${res.jobId} (attempt ${(job.autoContinueAttempt ?? 0) + 1}/${maxAttempts})`,
      );
      // Only auto-continue one lineage per sweep tick — keeps load
      // predictable and honours the "no two recoveries concurrently" rule.
      break;
    } catch (err: any) {
      skipped++;
      skipReasons.push({
        jobId: job.jobId,
        reason: `resume_threw:${err?.message ?? String(err)}`,
      });
      console.error(
        `[FrontRecovery] Auto-continue failed for ${job.jobId}: ${err?.message ?? String(err)}`,
      );
    }
  }

  return {
    considered: candidates.length,
    continuedJobIds,
    skipped,
    skipReasons,
  };
}

function buildDefaultRecoveryWindows(report: CoverageReport): RecoveryWindow[] {
  const windows: RecoveryWindow[] = [];

  const aug2025 = Math.floor(new Date("2025-08-01T00:00:00Z").getTime() / 1000);
  const feb2026 = Math.floor(new Date("2026-02-01T00:00:00Z").getTime() / 1000);

  const gapMonths = report.months.filter((m) => {
    if (!m.month) return false;
    return m.month >= "2025-08" && m.month <= "2026-01" && m.totalCoverage < 10;
  });

  if (gapMonths.length > 0) {
    windows.push({
      label: "2025-08–2026-01",
      afterTimestamp: aug2025,
      beforeTimestamp: feb2026,
    });
  }

  const preJulyMonths = report.months.filter((m) => {
    if (!m.month) return false;
    return m.month < "2025-07" && m.totalCoverage < 10;
  });

  if (preJulyMonths.length > 0) {
    const earliestGap = preJulyMonths[0].month;
    const [ey, em] = earliestGap.split("-").map(Number);
    const earliestTs = Math.floor(new Date(ey, em - 1, 1).getTime() / 1000);
    const jul2025 = Math.floor(new Date("2025-07-01T00:00:00Z").getTime() / 1000);

    windows.push({
      label: `${earliestGap}–2025-06`,
      afterTimestamp: earliestTs,
      beforeTimestamp: jul2025,
    });
  }

  for (const gap of report.gaps) {
    const alreadyCovered = windows.some(
      (w) => gap.afterTimestamp >= w.afterTimestamp && gap.beforeTimestamp <= w.beforeTimestamp,
    );
    if (!alreadyCovered) {
      windows.push(gap);
    }
  }

  return windows;
}

// ───────────────────────────────────────────────────────────────────────────
// Task #2716 — Known-conversation per-message backfill.
//
// Root cause this closes: the Task #2708 applied-conversation materializer
// (`materializeAppliedConvMessagesForMonthTick`) re-walks a month via Front's
// Conversations Search API and materializes the per-message rows of the
// conversations search returns. But `front_sync_emails` holds MORE
// conversations for a month than search `_total` reports (search is windowed /
// paginated / plan-capped, while front_sync_emails accumulates every
// conversation any recovery pass ever discovered with a `last_message_at` in
// the month — see audits/front-historical-retrievability-findings.md §4/§7,
// e.g. 2025-12: 8,551 tracked vs 4,416 search _total). Those extra
// conversations are *already known* — we do not need to re-discover them via
// search — but their individual messages were never written to
// raw_communication_records (per-message materialization shipped after the
// historical recovery completed). So search-based re-enumeration can never
// reach them and the month's ingest gap stalls.
//
// Fix: enumerate the conversations DIRECTLY from `front_sync_emails` for the
// month window, fetch each conversation's full message list via
// `GET /conversations/{id}/messages` (paginated), and write every missing
// per-message row through the shared `materializeFrontMessageRecord` helper —
// which dedupes on `external_source_id` (the Front message id), so repeated
// runs are idempotent. This is the "enumerate known conversations → fetch
// messages → dedupe → materialize" loop the task calls for.
//
// Bounded + resumable: one tick walks up to `conversationBudget` conversations
// ordered by `conversation_id` using a `> afterConversationId` cursor; the
// caller persists the returned checkpoint so a large month resumes across
// self-heal ticks. Gated on the same per-message materialization switch the
// recovery hydrate path uses (`front_recovery_per_message_materialization_enabled`)
// so it can't write per-message rows while that path is intentionally OFF.

/** Default conversations walked per tick — mirrors ENUM_CONVERSATIONS_PER_TICK_DEFAULT. */
export const KNOWN_CONV_BACKFILL_CONVERSATION_BUDGET_DEFAULT = 150;

/** Max message pages fetched per conversation (bounds a pathological thread). */
export const KNOWN_CONV_BACKFILL_MAX_MESSAGE_PAGES_PER_CONV = 20;

/** The per-message materialization switch this driver depends on. */
export const KNOWN_CONV_BACKFILL_REQUIRED_SWITCH =
  "front_recovery_per_message_materialization_enabled" as const;

/** Source label stamped into each backfilled row's rawPayloadJson.source. */
export const KNOWN_CONV_BACKFILL_SOURCE = "known_conv_message_backfill";

export interface KnownConvBackfillCheckpoint {
  /** Last `conversation_id` processed; the next tick resumes strictly after it. */
  afterConversationId: string | null;
}

export type KnownConvBackfillStatus =
  | "ok"
  | "disabled"
  | "blocked"
  | "error";

export interface KnownConvBackfillTickResult {
  /** Conversations walked this tick. */
  scanned: number;
  /** Conversations whose messages were fetched from Front this tick. */
  fetched: number;
  /** Per-message rows inserted into raw_communication_records this tick. */
  inserted: number;
  /** Per-message rows already present (deduped on external_source_id). */
  skipped: number;
  /** Conversations whose message fetch threw a non-auth error (skipped). */
  errors: number;
  /** True when the walk has exhausted every conversation for the window. */
  done: boolean;
  /** Checkpoint to pass to the next tick. */
  checkpoint: KnownConvBackfillCheckpoint;
  status: KnownConvBackfillStatus;
  statusReason?: string;
}

interface KnownConvRow {
  conversationId: string;
  subject: string | null;
  lastMessageAt: Date | null;
}

/**
 * Test seam — let unit/smoke tests inject a fake message fetcher + writer so the
 * walk can be exercised without a real Front connection or DB. Production never
 * sets these; they stay null at runtime.
 */
type FetchMessagesFn = typeof getAllConversationMessages;
type MaterializeFn = typeof materializeFrontMessageRecord;
type SelectFn = (
  window: { monthStart: Date; monthEnd: Date },
  afterConversationId: string | null,
  limit: number,
) => Promise<KnownConvRow[]>;
/** Validate Front auth before the walk; throws FrontAuthError on a real disconnect. */
type ValidateAuthFn = () => Promise<void>;
let _knownConvFetchMessagesOverride: FetchMessagesFn | null = null;
let _knownConvMaterializeOverride: MaterializeFn | null = null;
let _knownConvSelectOverride: SelectFn | null = null;
let _knownConvValidateAuthOverride: ValidateAuthFn | null = null;

export const __knownConvBackfillTestHelpers = {
  setFetchMessagesOverride: (fn: FetchMessagesFn | null): void => {
    _knownConvFetchMessagesOverride = fn;
  },
  setMaterializeOverride: (fn: MaterializeFn | null): void => {
    _knownConvMaterializeOverride = fn;
  },
  setSelectOverride: (fn: SelectFn | null): void => {
    _knownConvSelectOverride = fn;
  },
  setValidateAuthOverride: (fn: ValidateAuthFn | null): void => {
    _knownConvValidateAuthOverride = fn;
  },
};

/**
 * Read up to `limit` tracked conversations for the month window, strictly after
 * the cursor, ordered by `conversation_id` so the `> afterConversationId`
 * pagination is stable. Worker-pool read (this module's `db` is the worker
 * client). Filters on `last_message_at` (indexed) — the same month attribution
 * the coverage rows use.
 */
async function selectKnownConversationsForWindow(
  window: { monthStart: Date; monthEnd: Date },
  afterConversationId: string | null,
  limit: number,
): Promise<KnownConvRow[]> {
  if (_knownConvSelectOverride) {
    return _knownConvSelectOverride(window, afterConversationId, limit);
  }
  const after = afterConversationId ?? "";
  const rows = await db.execute(sql`
    SELECT conversation_id, subject, last_message_at
    FROM front_sync_emails
    WHERE last_message_at >= ${window.monthStart.toISOString()}
      AND last_message_at <  ${window.monthEnd.toISOString()}
      AND conversation_id > ${after}
    ORDER BY conversation_id ASC
    LIMIT ${limit}
  `);
  const list = ((rows as any).rows ?? (rows as unknown as any[])) as Array<{
    conversation_id: string;
    subject: string | null;
    last_message_at: Date | string | null;
  }>;
  return list.map((r) => ({
    conversationId: r.conversation_id,
    subject: r.subject,
    lastMessageAt:
      r.last_message_at == null
        ? null
        : r.last_message_at instanceof Date
          ? r.last_message_at
          : new Date(r.last_message_at),
  }));
}

/**
 * One bounded tick of the known-conversation per-message backfill for a month.
 *
 * Write-before-checkpoint: per-message rows are written BEFORE the advanced
 * checkpoint is returned, so an interruption re-walks the tick (idempotent via
 * the per-message dedupe) rather than skipping un-written messages.
 *
 * @param window     `{ label, monthStart, monthEnd }` — monthEnd exclusive.
 * @param checkpoint Resumption checkpoint from the previous tick, or null for a
 *                   fresh walk.
 * @param options    `conversationBudget` overrides the per-tick conversation count.
 */
export async function runKnownConversationMessageBackfill(
  window: { label: string; monthStart: Date; monthEnd: Date },
  checkpoint: KnownConvBackfillCheckpoint | null,
  options?: { conversationBudget?: number },
): Promise<KnownConvBackfillTickResult> {
  const afterConversationId = checkpoint?.afterConversationId ?? null;
  const base: KnownConvBackfillTickResult = {
    scanned: 0,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
    done: false,
    checkpoint: { afterConversationId },
    status: "ok",
  };

  // Gate on the per-message materialization switch — with it OFF the recovery
  // hydrate path deliberately writes only one last-message row per conversation,
  // so writing per-message rows here would diverge from that policy.
  if (!isPoolEpicSwitchEnabled(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH)) {
    return {
      ...base,
      done: true,
      status: "disabled",
      statusReason: `${KNOWN_CONV_BACKFILL_REQUIRED_SWITCH} is OFF`,
    };
  }

  // Validate Front auth up-front so a true disconnect surfaces as `blocked`
  // (non-terminal for the caller's convergence accounting) instead of throwing.
  try {
    if (_knownConvValidateAuthOverride) {
      await _knownConvValidateAuthOverride();
    } else {
      await getValidFrontAccessToken({ purpose: "historical_recovery" });
    }
  } catch (err) {
    if (
      err instanceof FrontAuthError &&
      (err.code === "front_not_connected" ||
        err.code === "front_no_refresh_token" ||
        err.code === "front_refresh_failed_permanent")
    ) {
      return {
        ...base,
        done: false,
        status: "blocked",
        statusReason: err.code,
      };
    }
    // Unknown auth error — surface as blocked (non-terminal) so the month is
    // not retired; the next tick retries from the same cursor.
    return {
      ...base,
      done: false,
      status: "blocked",
      statusReason: (err as any)?.message ?? String(err),
    };
  }

  const budget = Math.max(
    1,
    options?.conversationBudget ?? KNOWN_CONV_BACKFILL_CONVERSATION_BUDGET_DEFAULT,
  );
  const fetchMessages = _knownConvFetchMessagesOverride ?? getAllConversationMessages;
  const materialize = _knownConvMaterializeOverride ?? materializeFrontMessageRecord;

  const rows = await selectKnownConversationsForWindow(
    { monthStart: window.monthStart, monthEnd: window.monthEnd },
    afterConversationId,
    budget,
  );

  // No rows after the cursor → the window is fully walked.
  if (rows.length === 0) {
    return { ...base, done: true, status: "ok" };
  }

  let scanned = 0;
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let cursor = afterConversationId;

  for (const row of rows) {
    let messages: any[];
    try {
      messages = await fetchMessages(row.conversationId, {
        maxPages: KNOWN_CONV_BACKFILL_MAX_MESSAGE_PAGES_PER_CONV,
      });
    } catch (err) {
      // Auth death mid-walk — stop NOW without advancing past this conversation
      // so the next tick resumes here. Return blocked (non-terminal).
      if (err instanceof FrontAuthError) {
        return {
          scanned,
          fetched,
          inserted,
          skipped,
          errors,
          done: false,
          checkpoint: { afterConversationId: cursor },
          status: "blocked",
          statusReason: err.code,
        };
      }
      // Transient per-conversation error (rate-limit exhausted, network, 5xx).
      // Count it, advance the cursor past this conversation so the walk does not
      // wedge, and let a later full re-walk (fresh checkpoint once done) retry it.
      errors += 1;
      scanned += 1;
      cursor = row.conversationId;
      console.warn(
        `[KnownConvBackfill] ${window.label} conv=${row.conversationId} message fetch failed: ${
          (err as any)?.message ?? err
        }`,
      );
      continue;
    }

    fetched += 1;
    scanned += 1;
    const subject = row.subject || "(no subject)";
    const fallbackTimestamp = row.lastMessageAt ?? window.monthStart;
    for (const msg of messages) {
      try {
        const outcome = await materialize({
          msg,
          conversationId: row.conversationId,
          subject,
          fallbackTimestamp,
          source: KNOWN_CONV_BACKFILL_SOURCE,
        });
        if (outcome === "inserted") inserted += 1;
        else skipped += 1;
      } catch (perMsgErr) {
        skipped += 1;
        console.warn(
          `[KnownConvBackfill] ${window.label} conv=${row.conversationId} msg write failed: ${
            (perMsgErr as any)?.message ?? perMsgErr
          }`,
        );
      }
    }
    // Advance the cursor only after this conversation's messages are written
    // (write-before-checkpoint).
    cursor = row.conversationId;
  }

  // A short page (fewer rows than the budget) means we reached the end of the
  // window — the walk is done and the caller can clear the checkpoint.
  const done = rows.length < budget;

  return {
    scanned,
    fetched,
    inserted,
    skipped,
    errors,
    done,
    checkpoint: { afterConversationId: cursor },
    status: "ok",
  };
}
