/**
 * Task #1643 — Front Analytics Reports API client.
 *
 * Thin wrapper that pulls Front's *authoritative* monthly message count
 * for use as the denominator in the all-time coverage dashboard.
 *
 * Flow:
 *   1. POST /analytics/reports with { start, end, type, metrics }
 *   2. Receive job id (and `_links.self` URL) in the response body
 *   3. Poll GET <self> until status === "done" (or "failed" / timeout)
 *   4. Extract the single numeric metric value and return it
 *
 * Auth: uses the existing `getValidFrontAccessToken` helper, including
 * its 401-driven forced-refresh path.
 *
 * Errors are typed via `FrontAnalyticsError` so callers can route them
 * deterministically. We never log OAuth tokens, raw report bodies, or
 * message contents.
 *
 * MEASUREMENT-ONLY: this client only READS from Front. It never writes
 * back into `front_sync_emails` or `raw_communication_records`.
 */
import { getValidFrontAccessToken, FrontAuthError } from "./frontIntegration";
import {
  computeRateLimitPaceMs,
  parseFrontRateLimitHeaders,
} from "./frontRateLimit";

const FRONT_API_BASE = "https://api2.frontapp.com";

/**
 * Front Analytics metric used as the authoritative monthly denominator.
 *
 * Front exposes several adjacent metrics on the reports endpoint
 * (`num_messages_received`, `num_messages`, etc). The default counts
 * inbound messages received during the report window — closest to
 * "how many emails Front says hit our inboxes". Operators can override
 * via the `FRONT_ANALYTICS_METRIC` env var without a deploy.
 *
 * If you change this, also update `FRONT_ANALYTICS_COVERAGE.md`
 * ("counting alignment") and re-baseline the cache (drop rows from
 * `front_analytics_monthly_coverage` for the affected months — the
 * worker will re-pull them).
 */
export const FRONT_ANALYTICS_METRIC =
  process.env.FRONT_ANALYTICS_METRIC || "num_messages_received";

export const POLL_INITIAL_DELAY_MS = 1_000;
export const POLL_MAX_DELAY_MS = 10_000;
export const POLL_TIMEOUT_MS = 5 * 60_000;
export const FETCH_TIMEOUT_MS = 30_000;

export type FrontAnalyticsErrorCode =
  | "front_analytics_auth_failed"
  | "front_analytics_plan_limited"
  | "front_analytics_rate_limited"
  | "front_analytics_report_timeout"
  | "front_analytics_report_failed"
  | "front_analytics_partial_result"
  | "front_analytics_unexpected_shape"
  | "front_analytics_search_failed"
  // Task #2743 — a transient transport-level fetch rejection (abort /
  // timeout / ECONNRESET) during the search fallback or per-message
  // enumeration GET, AFTER a bounded retry budget with backoff is
  // exhausted. Distinct from `front_analytics_search_failed` (a genuine
  // query-shape / terminal 4xx failure) so the reachability classifier can
  // keep the month RETRIABLE instead of bucketing it as "needs a Front plan
  // upgrade". Treated like `front_analytics_rate_limited`: not unrecoverable,
  // re-tried next tick.
  | "front_analytics_transport_failed";

export class FrontAnalyticsError extends Error {
  readonly code: FrontAnalyticsErrorCode;
  readonly status?: number;
  constructor(code: FrontAnalyticsErrorCode, message: string, status?: number) {
    super(message);
    this.name = "FrontAnalyticsError";
    this.code = code;
    this.status = status;
  }
}

export interface MonthlyMetricResult {
  /** Front-side report id (for diagnostic logging / cache). */
  reportId: string;
  /** The single numeric value Front returned for the configured metric. */
  value: number;
  /** "done" | "partial" — partial still returned a numeric value. */
  status: "done" | "partial";
  /** Echoed back so callers can persist what they actually used. */
  metric: string;
}

interface FetchOpts {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

async function frontFetch(path: string, opts: FetchOpts = {}): Promise<Response> {
  const token = await getValidFrontAccessToken({
    purpose: "front_analytics_coverage",
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  try {
    const url = path.startsWith("http") ? path : `${FRONT_API_BASE}${path}`;
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface SubmitResponse {
  id?: string;
  status?: string;
  _links?: { self?: string };
}

/**
 * Task #1675 — Front's `POST /analytics/reports` response carries the
 * report id ONLY in `_links.self` (a URL of the form
 * `https://api2.frontapp.com/analytics/reports/<id>`). Older Front
 * responses sometimes included a top-level `id` too, but the current
 * production response does not — treating its absence as
 * `unexpected_shape` is how every refresh tick was failing for recent
 * months. Extract the trailing path segment so we can populate both
 * the report id (for diagnostic logging) and the poll URL.
 */
export function extractReportIdFromSelf(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/analytics\/reports\/([^/?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Parse the body of a successful `POST /analytics/reports` response.
 * Throws `front_analytics_unexpected_shape` only when neither a
 * top-level `id` nor a parseable `_links.self` URL is present.
 */
export function parseSubmitResponse(
  data: SubmitResponse,
): { reportId: string; pollUrl: string } {
  const pollUrl = data?._links?.self;
  if (!pollUrl) {
    throw new FrontAnalyticsError(
      "front_analytics_unexpected_shape",
      "Front analytics submit missing _links.self",
    );
  }
  const reportId = data.id ?? extractReportIdFromSelf(pollUrl);
  if (!reportId) {
    throw new FrontAnalyticsError(
      "front_analytics_unexpected_shape",
      "Front analytics submit missing id and could not parse report id from _links.self",
    );
  }
  return { reportId, pollUrl };
}

/**
 * Task #1681 — Front's plan-retention 403 carries a stable English
 * phrase ("plan does not give you access to that time period").
 * Matching on that phrase is intentionally narrow: a generic 403
 * (missing scope, revoked token) must NOT trip the search fallback
 * because search has different auth requirements and would just
 * fail with the same auth error.
 *
 * Task #1709 — Front sometimes wraps that message inside a JSON
 * envelope such as `{"_error":{"status":403,"title":"Forbidden",
 * "message":"Your plan does not give you access to that time
 * period."}}`. The literal phrase still appears in the lowercased
 * text regardless of envelope; we only need to make sure callers pass
 * the whole body (not a 200-char truncation that may cut the
 * `message` field off). See `safeReadBodySnippet` for the truncation
 * bump that pairs with this matcher. Match stays narrow on the
 * literal phrase so generic auth failures still classify as
 * `front_analytics_auth_failed`.
 */
export function isPlanLimitSnippet(snippet: string | null | undefined): boolean {
  if (!snippet) return false;
  const lower = snippet.toLowerCase();
  // Task #1709 — literal phrase match (broadest, fastest).
  if (
    lower.includes("plan does not give you access") ||
    lower.includes("plan doesn't give you access")
  ) {
    return true;
  }
  // Task #1974 — structural match on the `_error` envelope. The
  // earlier substring matcher missed Front responses where the JSON
  // body wraps the plan-history message in `_error.title` /
  // `_error.message` *and* the surrounding JSON formatting (escapes,
  // unicode whitespace, key reordering) prevents the phrase from
  // appearing as a contiguous substring in the trimmed snippet. We
  // try to parse JSON best-effort and inspect the structured fields
  // directly, then re-match lowercase against the same phrase set so
  // we never widen what counts as plan-limit (generic 403s must
  // still classify as auth_failed).
  if (snippet.includes("_error") && (snippet.includes("{") || snippet.includes("\""))) {
    try {
      // The snippet may be truncated; attempt to locate a `_error`
      // object and parse a minimal slice around it.
      const start = snippet.indexOf("{");
      if (start >= 0) {
        const candidate = snippet.slice(start);
        // Drop the trailing ellipsis we add during truncation.
        const cleaned = candidate.replace(/…$/, "");
        const parsed = JSON.parse(cleaned) as { _error?: unknown };
        const err = (parsed?._error ?? null) as
          | { title?: unknown; message?: unknown; status?: unknown }
          | null;
        if (err && typeof err === "object") {
          const title =
            typeof err.title === "string" ? err.title.toLowerCase() : "";
          const message =
            typeof err.message === "string" ? err.message.toLowerCase() : "";
          if (
            title.includes("plan does not give you access") ||
            title.includes("plan doesn't give you access") ||
            message.includes("plan does not give you access") ||
            message.includes("plan doesn't give you access") ||
            // Front has also been observed to phrase this as "Your
            // plan doesn't include analytics for this period" — accept
            // either historical phrasing.
            title.includes("plan doesn't include analytics") ||
            message.includes("plan doesn't include analytics")
          ) {
            return true;
          }
        }
      }
    } catch {
      // Truncation or non-JSON tail — fall through; the literal
      // substring matcher above already handled the easy case.
    }
  }
  return false;
}

/**
 * Task #1974 — plain-English mapping for the Front analytics error
 * codes the coverage row surfaces. The admin panel uses this to
 * render an operator-readable message + a "Reconnect Front" button
 * on rows where reconnection is the fix.
 */
export interface FrontAnalyticsErrorExplanation {
  /** Plain-English copy for the operator. */
  message: string;
  /** True when the fix is "click Reconnect Front" (auth-side). */
  needsReconnect: boolean;
  /** True when the row will self-heal on the next tick. */
  transient: boolean;
}

export function explainFrontAnalyticsError(
  rawError: string | null | undefined,
): FrontAnalyticsErrorExplanation | null {
  if (!rawError) return null;
  const code = rawError.split(":")[0]?.trim() ?? "";
  const rest = rawError.includes(":")
    ? rawError.slice(rawError.indexOf(":") + 1).trim()
    : rawError;
  // Plan-history 403s wrapped as auth_failed (legacy classification)
  // should heal automatically once the broadened detector re-evaluates
  // the row, but we still surface a helpful operator message in the
  // window before the next tick.
  if (code === "front_analytics_auth_failed") {
    if (isPlanLimitSnippet(rawError)) {
      return {
        message:
          "Front plan does not include analytics for this month — using per-message fallback.",
        needsReconnect: false,
        transient: true,
      };
    }
    if (/analytics:read/i.test(rest) || /missing.*scope/i.test(rest)) {
      return {
        message:
          "Front token is missing the `analytics:read` scope — reconnect Front with this scope.",
        needsReconnect: true,
        transient: false,
      };
    }
    return {
      message: "Front token expired or revoked — reconnect to fix.",
      needsReconnect: true,
      transient: false,
    };
  }
  if (code === "front_analytics_plan_limited") {
    return {
      message:
        "Front plan does not include analytics for this month — using per-message fallback.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_rate_limited") {
    return {
      message: "Front rate-limited the request — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_report_timeout") {
    return {
      message: "Front report took too long — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_search_failed") {
    return {
      message: "Front search call failed — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_transport_failed") {
    return {
      message:
        "Front connection dropped mid-request — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_partial_result") {
    return {
      message: "Front returned a partial report — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  if (code === "front_analytics_unexpected_shape") {
    return {
      message:
        "Front returned an unexpected response shape — escalate if this persists across retries.",
      needsReconnect: false,
      transient: false,
    };
  }
  if (code === "front_analytics_report_failed") {
    return {
      message: "Front rejected the report request — will retry on next tick.",
      needsReconnect: false,
      transient: true,
    };
  }
  return null;
}

/**
 * Task #1709 — Front's 403 body for plan-limited months can be wrapped
 * in an `{"_error":{...,"message":"..."}}` envelope where the
 * plan-history phrase lives several hundred bytes into the JSON. The
 * earlier 200-char cap truncated the message in some responses, so
 * `isPlanLimitSnippet` missed the match and the row was permanently
 * stamped `front_analytics_auth_failed` + `unrecoverable=true`. Bump
 * the cap to 1 KB so the literal phrase survives the truncation
 * regardless of envelope shape. Still bounded so we never log
 * unbounded response bodies.
 */
const BODY_SNIPPET_MAX_CHARS = 1024;

async function safeReadBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    const trimmed =
      text.length > BODY_SNIPPET_MAX_CHARS
        ? `${text.slice(0, BODY_SNIPPET_MAX_CHARS)}…`
        : text;
    return trimmed.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Submit an analytics report job. Returns the job's polling URL and id.
 *
 * Body shape matches Front's V1 analytics reports API:
 *   POST /analytics/reports
 *   { start, end, type, metrics: [...] }
 *
 * `start` and `end` are unix-seconds timestamps in UTC.
 */
async function submitReport(opts: {
  startUnixSec: number;
  endUnixSec: number;
  metric: string;
}): Promise<{ reportId: string; pollUrl: string }> {
  const body = {
    start: opts.startUnixSec,
    end: opts.endUnixSec,
    type: "team",
    metrics: [opts.metric],
  };
  let res: Response;
  try {
    res = await frontFetch("/analytics/reports", { method: "POST", body });
  } catch (err) {
    throw new FrontAnalyticsError(
      "front_analytics_report_failed",
      `Front analytics submit transport error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    // Task #1675 — log the Front response body so operators can
    // distinguish a missing-scope error (e.g. `analytics:read`) from a
    // team-scoped token issue or an out-of-retention window. The body
    // comes from Front and contains no OAuth credentials of ours.
    const snippet = await safeReadBodySnippet(res);
    // Task #1681 — Front returns 403 with a plan-retention message for
    // months outside the workspace's analytics window (e.g. older than
    // 6 months on the team plan). We must distinguish that case from a
    // real auth failure (missing `analytics:read` scope, expired
    // token) so the coverage worker can fall back to the search API
    // rather than marking the month permanently unrecoverable. The
    // match is intentionally narrow: 403 + literal plan-limit phrase.
    if (res.status === 403 && isPlanLimitSnippet(snippet)) {
      throw new FrontAnalyticsError(
        "front_analytics_plan_limited",
        `Front analytics submit plan-limited (403): ${snippet}`,
        403,
      );
    }
    throw new FrontAnalyticsError(
      "front_analytics_auth_failed",
      `Front analytics submit auth failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
      res.status,
    );
  }
  if (res.status === 429) {
    throw new FrontAnalyticsError(
      "front_analytics_rate_limited",
      `Front analytics submit rate limited (429)`,
      429,
    );
  }
  if (!res.ok) {
    const snippet = await safeReadBodySnippet(res);
    throw new FrontAnalyticsError(
      "front_analytics_report_failed",
      `Front analytics submit failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
      res.status,
    );
  }
  let data: SubmitResponse;
  try {
    data = (await res.json()) as SubmitResponse;
  } catch {
    throw new FrontAnalyticsError(
      "front_analytics_unexpected_shape",
      "Front analytics submit returned non-JSON body",
    );
  }
  return parseSubmitResponse(data);
}

interface PollResponse {
  status?: string;
  progress?: number;
  metrics?: Array<{ type?: string; value?: number | string; t?: string }>;
}

function extractMetricValue(
  payload: PollResponse,
  metric: string,
): number | null {
  if (!Array.isArray(payload.metrics)) return null;
  // Prefer an exact-type match; fall back to the first metric if Front
  // doesn't echo the type (some report shapes only return value+name).
  let candidate: { value?: number | string } | undefined;
  for (const m of payload.metrics) {
    if ((m as any)?.type === metric || (m as any)?.name === metric) {
      candidate = m;
      break;
    }
  }
  if (!candidate) candidate = payload.metrics[0];
  if (!candidate) return null;
  const raw = candidate.value;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Fully synchronous (from the caller's POV) helper: submit, poll until
 * done, return the numeric metric.
 *
 * `monthStart` / `monthEnd` are JS Date objects in UTC. The caller is
 * responsible for passing correct UTC month boundaries.
 *
 * Throws `FrontAnalyticsError` on every failure path. The caller is
 * expected to persist the error code on the cache row (so an operator
 * can see *why* a month failed) and retry on the next tick.
 */
export async function pullMonthlyMessageCount(opts: {
  monthStart: Date;
  monthEnd: Date;
  metric?: string;
  /** Tests pass a fake clock here to avoid sleeping in CI. */
  now?: () => number;
  /** Tests pass a no-op sleep here. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<MonthlyMetricResult> {
  const metric = opts.metric ?? FRONT_ANALYTICS_METRIC;
  const startUnixSec = Math.floor(opts.monthStart.getTime() / 1000);
  const endUnixSec = Math.floor(opts.monthEnd.getTime() / 1000);
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const { reportId, pollUrl } = await submitReport({
    startUnixSec,
    endUnixSec,
    metric,
  });

  const deadline = now() + POLL_TIMEOUT_MS;
  let delay = POLL_INITIAL_DELAY_MS;
  let lastStatus = "submitted";

  while (now() < deadline) {
    await sleep(delay);
    delay = Math.min(POLL_MAX_DELAY_MS, Math.round(delay * 1.5));

    let res: Response;
    try {
      res = await frontFetch(pollUrl);
    } catch (err) {
      throw new FrontAnalyticsError(
        "front_analytics_report_failed",
        `Front analytics poll transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new FrontAnalyticsError(
        "front_analytics_auth_failed",
        `Front analytics poll auth failed (${res.status})`,
        res.status,
      );
    }
    if (res.status === 429) {
      // Honor rate-limit by extending the poll delay instead of bailing.
      const retryAfter = Number(res.headers.get("retry-after") || 5);
      await sleep(Math.min(retryAfter * 1000, POLL_MAX_DELAY_MS));
      continue;
    }
    if (!res.ok) {
      throw new FrontAnalyticsError(
        "front_analytics_report_failed",
        `Front analytics poll failed (${res.status})`,
        res.status,
      );
    }

    let payload: PollResponse;
    try {
      payload = (await res.json()) as PollResponse;
    } catch {
      throw new FrontAnalyticsError(
        "front_analytics_unexpected_shape",
        "Front analytics poll returned non-JSON body",
      );
    }

    lastStatus = payload.status ?? lastStatus;
    if (payload.status === "done" || payload.status === "partial") {
      const value = extractMetricValue(payload, metric);
      if (value === null) {
        if (payload.status === "partial") {
          throw new FrontAnalyticsError(
            "front_analytics_partial_result",
            "Front analytics report returned partial without a usable metric value",
          );
        }
        throw new FrontAnalyticsError(
          "front_analytics_unexpected_shape",
          `Front analytics report missing metric '${metric}'`,
        );
      }
      return {
        reportId,
        value,
        status: payload.status,
        metric,
      };
    }
    if (payload.status === "failed" || payload.status === "error") {
      throw new FrontAnalyticsError(
        "front_analytics_report_failed",
        `Front analytics report reported status=${payload.status}`,
      );
    }
    // status in {"submitted", "running", undefined} — keep polling.
  }

  throw new FrontAnalyticsError(
    "front_analytics_report_timeout",
    `Front analytics report did not complete within ${Math.round(
      POLL_TIMEOUT_MS / 1000,
    )}s (last status=${lastStatus})`,
  );
}

/**
 * Task #1974 — per-direction monthly message counts via Analytics Reports.
 *
 * Submits two reports (`num_messages_received` for inbound and
 * `num_messages_sent` for outbound), polls each to completion, and
 * returns both numeric values. Each side maps to a distinct Front
 * Analytics metric so a plan-history 403 on either side surfaces
 * with that side's error code; callers route the whole month to the
 * per-message-enumeration fallback when either side is plan-limited
 * (don't keep one side and zero the other — that produces misleading
 * 100% / 0% rows).
 *
 * Both sides reuse the same submit / poll / extract code paths
 * (`pullMonthlyMessageCount`) so token-refresh single-flight,
 * rate-limit handling, and timeout semantics are unchanged.
 */
export interface MonthlyMessagesByDirection {
  inbound: MonthlyMetricResult;
  outbound: MonthlyMetricResult;
}

export async function pullMonthlyMessagesByDirection(opts: {
  monthStart: Date;
  monthEnd: Date;
}): Promise<MonthlyMessagesByDirection> {
  // Submit both sides serially: Front's analytics endpoint is the
  // tightest rate-limit surface we touch in this worker, and
  // serializing keeps a single per-month tick from doubling the
  // burst against the company's 40% proportional cap. The poll
  // phase is already bounded by POLL_TIMEOUT_MS per side.
  const inbound = await pullMonthlyMessageCountResolved({
    monthStart: opts.monthStart,
    monthEnd: opts.monthEnd,
    metric: "num_messages_received",
  });
  const outbound = await pullMonthlyMessageCountResolved({
    monthStart: opts.monthStart,
    monthEnd: opts.monthEnd,
    metric: "num_messages_sent",
  });
  return { inbound, outbound };
}

// ──────────────── Search-API fallback (Task #1681) ────────────────

/**
 * Hard cap on pagination so a runaway month can never burn unlimited
 * Front API rate-limit budget. At Front's default page size of 100
 * conversations this gives us 20 000 inbound conversations per month
 * before we bail with `front_analytics_search_failed`. The known
 * stuck months (Jul–Oct 2025) are well under this.
 */
export const SEARCH_FALLBACK_MAX_PAGES = 200;
export const SEARCH_FALLBACK_PAGE_SIZE = 100;
// Task #1681 — hard cap on consecutive 429s for a single search page
// so a Front-side rate-limit storm can't stall a worker tick. Once
// exceeded the call surfaces `front_analytics_rate_limited` and the
// coverage row stays retriable (re-tries next tick).
export const SEARCH_FALLBACK_MAX_429_RETRIES = 5;
// Task #1767 — bounded 5xx retry budget for a single search page. Front
// surfaces transient overload as 5xx (often without a clean 429) and
// the proportional 40% Search-API rate-limit cap means manual retries
// across multiple months can briefly trip it. Treating those as
// terminal poisons the coverage row until an operator clicks Retry
// again. With a per-page retry budget (separate from the 429 budget)
// and exponential backoff with jitter we ride through transient
// failures while keeping terminal failures terminal. The budget is
// reset on every successful page parse so a long but well-behaved
// pagination still completes.
export const SEARCH_FALLBACK_MAX_5XX_RETRIES = 4;
const SEARCH_FALLBACK_5XX_BACKOFF_BASE_MS = 500;
const SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS = 8_000;
// Task #2743 — bounded transport-abort retry budget for a single page/GET.
// A transport-level `fetch` rejection (abort / timeout / ECONNRESET) is
// transient — the same class of blip Front surfaces as a 5xx — so it gets its
// own retry budget with the same exponential backoff + jitter, kept SEPARATE
// from the 429/5xx budgets and reset on every successful page parse. Once the
// budget is exhausted the call surfaces `front_analytics_transport_failed`
// (retriable, NOT terminal) so the coverage row is re-tried next tick instead
// of being latched into a permanent false plan-limit. Before this, the first
// aborted request threw terminal `front_analytics_search_failed` with zero
// retries and permanently mis-bucketed a reachable month as "needs a plan
// upgrade".
export const SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES = 4;

// Task #2743 — Node/undici surface a transport-level network failure either as
// an `AbortError`/`TimeoutError` (our own AbortController timeout), a `TypeError`
// ("fetch failed") whose `.cause` carries the low-level code, or an error with a
// system `code`. These are the ONLY throws from `doFetch` that are transient and
// safe to retry.
const TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Task #2743 — POSITIVE allow-list for retriable transport failures. A throw
 * from `doFetch` is bounded-retriable ONLY when it is a genuine fetch-level
 * network reject (abort / timeout / reset / DNS / connection refused). Any
 * OTHER throw — most importantly a terminal `FrontAuthError`
 * (`front_not_connected`) or a `FrontAnalyticsError` raised before the HTTP
 * round-trip — must propagate untouched so terminal failures stay terminal and
 * are NEVER re-classified as the retriable/reachable
 * `front_analytics_transport_failed`.
 */
export function isTransportLevelFetchError(err: unknown): boolean {
  // Typed non-transport errors (auth, token, shape) are never transport-retriable.
  if (err instanceof FrontAuthError || err instanceof FrontAnalyticsError) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) return true;
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  // undici wraps low-level socket failures as a bare `TypeError: fetch failed`.
  // Only treat a TypeError as transport-level when it actually carries that
  // network signal — an unrelated programming TypeError from the fetcher path
  // must NOT be reclassified as retriable transport noise.
  if (err instanceof TypeError && msg.includes("fetch failed")) return true;
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("aborted") ||
    msg.includes("socket hang up") ||
    msg.includes("terminated") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout")
  );
}

export type SearchFallbackSource = "search_conversations";
/**
 * Task #1837 — the search fallback already counts every conversation in
 * the `[afterUnix, beforeUnix)` window regardless of direction (Task
 * #1709 dropped the unsupported `is:inbound` modifier). Relabel the
 * unit so the coverage table can compare numerator and denominator
 * in the same unit. The legacy `"inbound_conversations"` value still
 * exists in old rows; the coverage service treats both as equivalent
 * to `"conversations_all"` for unit-comparability checks.
 */
export type SearchFallbackUnit = "conversations_all";

export interface SearchFallbackResult {
  count: number;
  source: SearchFallbackSource;
  unit: SearchFallbackUnit;
  pagesFetched: number;
  /** Total advertised by Front when present (best-effort, not relied on). */
  frontTotalHint: number | null;
  truncated: boolean;
}

interface SearchPage {
  _results?: Array<unknown>;
  _pagination?: { next?: string | null };
  _total?: number | null;
}

/**
 * Pull a monthly inbound-conversation count via Front's search API.
 *
 * Used by `frontAnalyticsCoverage.refreshMonth` as a fallback when
 * Analytics returns `front_analytics_plan_limited` for a month
 * outside the workspace plan's analytics retention window.
 *
 * IMPORTANT: this counts *conversations*, not messages. The caller is
 * responsible for persisting `denominator_source` and
 * `denominator_unit` so the dashboard can pill the unit difference
 * and alerts code can avoid mixing units in threshold compares.
 *
 * MEASUREMENT-ONLY: never writes back to `front_sync_emails` or
 * `raw_communication_records`.
 */
export async function pullMonthlyMessageCountViaSearchFallback(opts: {
  monthStart: Date;
  monthEnd: Date;
  /**
   * Test seam — lets the bounded-429 regression simulate Front
   * responses without standing up an HTTP server or mocking the OAuth
   * token flow. Production callers leave this undefined and the real
   * `frontFetch` is used.
   */
  fetcher?: (path: string) => Promise<Response>;
  /**
   * Task #1767 — test seam for the bounded 5xx retry path so the
   * regression test doesn't spend real wall-clock time waiting for
   * exponential backoff. Production callers leave this undefined and
   * the real `setTimeout`-based sleep is used.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Task #2721 — test seam for the rate-limit self-pacing clock. Production
   * callers leave this undefined and the real `Date.now` is used; tests pin it
   * so the `x-ratelimit-reset` (epoch-seconds) math is deterministic.
   */
  now?: () => number;
}): Promise<SearchFallbackResult> {
  const doFetch = opts.fetcher ?? frontFetch;
  const doSleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const afterUnix = Math.floor(opts.monthStart.getTime() / 1000);
  // Front's `before:` is exclusive of the timestamp itself, so passing
  // the next month's start is the correct half-open interval.
  const beforeUnix = Math.floor(opts.monthEnd.getTime() / 1000);
  // Task #1709 — Front's `/conversations/search` endpoint does not
  // accept `is:inbound` as a modifier; it returns
  // `400 Unsupported search modifier provided` and the row keeps
  // failing on every Retry. Front's documented `is:` modifiers are
  // status-only (`open`, `closed`, `unassigned`, `assigned`,
  // `snoozed`, `unreplied`, `deleted`, `archived`) — there is no
  // direction modifier on the search API. Drop `is:inbound` and
  // count every conversation in the half-open `[afterUnix, beforeUnix)`
  // window instead. The denominator unit stays
  // `inbound_conversations` for the existing pill / dashboard label,
  // but is now an upper bound: a small number of outbound-only
  // conversations may also be counted. The unit caveat is already
  // documented in FRONT_ANALYTICS_COVERAGE.md and rendered by the
  // dashboard.
  const query = `after:${afterUnix} before:${beforeUnix}`;
  const encoded = encodeURIComponent(query);
  let url: string | null =
    `/conversations/search/${encoded}?limit=${SEARCH_FALLBACK_PAGE_SIZE}`;

  let count = 0;
  let pages = 0;
  let frontTotalHint: number | null = null;
  let truncated = false;
  // Task #1681 — bounded 429 retry budget. Reset on every successful
  // page parse so a long but well-behaved pagination still completes;
  // only consecutive 429s on the *same* page exhaust the budget.
  let consecutive429s = 0;
  // Task #1767 — bounded 5xx retry budget, kept *separate* from the
  // 429 budget so a single page that flaps between 503 and 429
  // doesn't exhaust both at once. Reset on every successful page
  // parse for the same long-pagination reason.
  let consecutive5xx = 0;
  // Task #2743 — bounded transport-abort retry budget, kept *separate*
  // from the 429/5xx budgets. Reset on every successful page parse.
  let consecutiveTransport = 0;

  while (url && pages < SEARCH_FALLBACK_MAX_PAGES) {
    let res: Response;
    try {
      res = await doFetch(url);
    } catch (err) {
      // Task #2743 — a transport-level fetch rejection (abort / timeout /
      // ECONNRESET) is transient. Give it a bounded retry budget with the
      // same exponential backoff + jitter as the 5xx path instead of
      // failing terminally on the first blip. Only after the budget is
      // exhausted do we surface `front_analytics_transport_failed` — a
      // RETRIABLE code (not `front_analytics_search_failed`) so the row is
      // re-tried next tick rather than latched as a false plan-limit.
      //
      // CRITICAL: only genuine fetch-level network rejects are retriable. A
      // terminal `FrontAuthError` (`front_not_connected`) thrown by the token
      // accessor BEFORE the HTTP round-trip, or any other non-transport throw,
      // must propagate untouched — never wrapped as the retriable/reachable
      // transport code, which would turn a dead auth into a false plan-limit.
      if (!isTransportLevelFetchError(err)) {
        throw err;
      }
      consecutiveTransport += 1;
      if (consecutiveTransport > SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES) {
        throw new FrontAnalyticsError(
          "front_analytics_transport_failed",
          `Front search transport error after ${SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES} retries on page ${pages + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const exp = Math.min(
        SEARCH_FALLBACK_5XX_BACKOFF_BASE_MS *
          Math.pow(2, consecutiveTransport - 1),
        SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
      );
      const backoffMs = exp + Math.floor(Math.random() * Math.min(250, exp / 4));
      await doSleep(backoffMs);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const snippet = await safeReadBodySnippet(res);
      throw new FrontAnalyticsError(
        "front_analytics_auth_failed",
        `Front search auth failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    if (res.status === 429) {
      consecutive429s += 1;
      if (consecutive429s > SEARCH_FALLBACK_MAX_429_RETRIES) {
        // Prevent an unbounded retry loop from stalling the worker
        // tick when Front rate-limits us hard. The coverage row will
        // be re-tried next tick (front_analytics_rate_limited is not
        // marked unrecoverable).
        throw new FrontAnalyticsError(
          "front_analytics_rate_limited",
          `Front search rate limited: exceeded ${SEARCH_FALLBACK_MAX_429_RETRIES} consecutive 429 retries on page ${pages + 1}`,
          429,
        );
      }
      const retryAfter = Number(res.headers.get("retry-after") || 5);
      await doSleep(Math.min(retryAfter * 1000, POLL_MAX_DELAY_MS));
      continue;
    }
    // Task #1767 — bounded 5xx retry with exponential backoff + jitter.
    // Front's Search API surfaces transient overload as 5xx (often not
    // a clean 429), and proportional rate limiting at 40% of the
    // company's cap means manual bursts across multiple plan-limited
    // months can briefly trip it. Treating one 5xx as terminal poisons
    // the row until an operator clicks Retry again. The budget is
    // per-page and resets on successful parse, so long paginations
    // still complete. Terminal 4xx (other than 401/403/429) keep the
    // existing "fail fast" semantics: those are query/request-shape
    // problems that retry will not heal.
    if (res.status >= 500 && res.status <= 599) {
      consecutive5xx += 1;
      if (consecutive5xx > SEARCH_FALLBACK_MAX_5XX_RETRIES) {
        const snippet = await safeReadBodySnippet(res);
        throw new FrontAnalyticsError(
          "front_analytics_search_failed",
          `Front search failed after ${SEARCH_FALLBACK_MAX_5XX_RETRIES} 5xx retries (status ${res.status}) on page ${pages + 1}${snippet ? `: ${snippet}` : ""}`,
          res.status,
        );
      }
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      let backoffMs: number;
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        backoffMs = Math.min(
          retryAfterSec * 1000,
          SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
        );
      } else {
        const exp = Math.min(
          SEARCH_FALLBACK_5XX_BACKOFF_BASE_MS *
            Math.pow(2, consecutive5xx - 1),
          SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
        );
        // Jitter up to ~25% of the computed delay so concurrent retries
        // across months don't lock-step into the same Front-side window.
        backoffMs = exp + Math.floor(Math.random() * Math.min(250, exp / 4));
      }
      await doSleep(backoffMs);
      continue;
    }
    if (!res.ok) {
      // Terminal 4xx (other than the auth/rate-limit cases handled
      // above). The query was rejected or the request shape is
      // invalid; retrying will not heal it. Persist a useful snippet
      // so the operator can see status + body in the admin UI.
      const snippet = await safeReadBodySnippet(res);
      throw new FrontAnalyticsError(
        "front_analytics_search_failed",
        `Front search failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    let page: SearchPage;
    try {
      page = (await res.json()) as SearchPage;
    } catch {
      throw new FrontAnalyticsError(
        "front_analytics_unexpected_shape",
        "Front search returned non-JSON body",
      );
    }
    // Successful page → reset ALL retry budgets so well-behaved long
    // paginations can still complete after one transient blip.
    consecutive429s = 0;
    consecutive5xx = 0;
    consecutiveTransport = 0;
    const results = Array.isArray(page._results) ? page._results : [];
    count += results.length;
    if (
      frontTotalHint === null &&
      typeof page._total === "number" &&
      Number.isFinite(page._total) &&
      page._total >= 0
    ) {
      frontTotalHint = page._total;
    }
    pages += 1;
    const next = page._pagination?.next;
    url = typeof next === "string" && next.length > 0 ? next : null;

    // Task #2721 — proactive self-pacing. Read Front's live rate-limit
    // budget off THIS page's headers and, if it is running low, sleep
    // before fetching the next page so we slow down ahead of an actual
    // 429 instead of waiting to hit one. No-op when there is no next page
    // or when the budget is healthy / headers are absent.
    if (url) {
      const paceMs = computeRateLimitPaceMs(
        parseFrontRateLimitHeaders(res),
        now(),
      );
      if (paceMs > 0) await doSleep(paceMs);
    }
  }

  if (url !== null) {
    // We hit the page cap before exhausting pagination. Surface as
    // truncated so the caller can pill the row appropriately rather
    // than silently under-reporting.
    truncated = true;
  }

  return {
    count,
    source: "search_conversations",
    unit: "conversations_all",
    pagesFetched: pages,
    frontTotalHint,
    truncated,
  };
}

// ──────────── Per-message enumeration fallback (Task #1983) ────────────

/**
 * Task #1983 — per-message enumeration fallback for plan-limited months.
 *
 * When Front's Analytics Reports API 403s on a month (the month is
 * outside the workspace plan's analytics-retention window) the
 * per-direction denominators (`num_messages_received` /
 * `num_messages_sent`) are unavailable, so the coverage panel shows
 * "not yet measured" for inbound / outbound. This walks Conversations
 * Search → Messages and counts messages per direction at MESSAGE grain
 * so a real denominator can be shown instead.
 *
 * Front API surfaces used — verified against the current public docs at
 * dev.frontapp.com on 2026-05-29:
 *   - GET /conversations/search/:query  (paginated via `_pagination.next`,
 *     `limit` ≤ 100). Returns CONVERSATIONS in the `[after, before)`
 *     window — there is no message-grain search, so we must walk each
 *     conversation's messages.
 *   - GET /conversations/{id}/messages  (paginated via `_pagination.next`,
 *     `limit` ≤ 100, `sort_by` only supports `created_at`). Each message
 *     carries `is_inbound` (boolean: true = received from an external
 *     sender, false = sent by a teammate) and `created_at` (Unix epoch
 *     FLOAT, seconds). Requires the `messages:read` scope.
 *
 * We count only messages whose `created_at` lands inside the month
 * window so the totals stay comparable to Analytics
 * `num_messages_received` / `num_messages_sent` (a single conversation
 * can straddle the month boundary and hold messages on both sides).
 *
 * Resumable: a busy month is far too large for a single worker tick, so
 * each call processes at most `conversationBudget` conversations (and a
 * bounded number of message pages) and returns a checkpoint the caller
 * persists. The next tick resumes from the checkpoint. The walk is
 * conversation-atomic — a conversation is removed from
 * `pendingConversationIds` and its counts folded into the running totals
 * only after it is fully enumerated, and the caller only persists the
 * returned checkpoint on a clean tick. A crash mid-tick therefore
 * replays at most the in-flight conversation and never double-counts.
 *
 * Bounded: `ENUM_MAX_MESSAGE_PAGES_PER_CONVERSATION` caps one
 * conversation, `ENUM_MAX_CONVERSATIONS_PER_MONTH` caps the whole month
 * (surfaced as `truncated`), and the caller's `messagePageBudget` caps
 * Front calls per tick. 429 / 5xx reuse the search fallback's bounded
 * retry budgets.
 *
 * MEASUREMENT-ONLY: never writes `front_sync_emails` /
 * `raw_communication_records`.
 */
export const ENUM_CONVERSATIONS_PER_TICK_DEFAULT = 150;
export const ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT = 600;
export const ENUM_MAX_MESSAGE_PAGES_PER_CONVERSATION = 50;
export const ENUM_MAX_CONVERSATIONS_PER_MONTH = 50_000;
export const ENUM_MESSAGES_PAGE_SIZE = 100;

export interface EnumerationCheckpoint {
  /**
   * Next Conversations Search page URL to fetch. `null` once search
   * pagination is exhausted. Before the first search page is requested
   * this is also `null`; `searchStarted` disambiguates the two states.
   */
  searchNextUrl: string | null;
  searchStarted: boolean;
  /** Conversation IDs discovered by search but not yet enumerated. */
  pendingConversationIds: string[];
  inboundCount: number;
  outboundCount: number;
  /** Conversations fully counted so far (diagnostic + month cap). */
  processedConversationCount: number;
  /** Set once the per-month cap is hit so the caller can pill the row. */
  truncated: boolean;
  /**
   * Task #1920 — canonical conversation ids reached by following a 301
   * merge during this month's walk. `GET /conversations/{id}/messages`
   * 301-redirects when a conversation was merged into another; this set
   * lets the walk dedup so a merged conversation's messages are never
   * counted under BOTH the merged-away source and the canonical
   * conversation (a double-count would inflate the message-grain
   * denominator and stop a month from honestly converging to 100%).
   * Bounded by the number of merges (rare) — not the conversation count —
   * so it does not bloat the persisted checkpoint.
   */
  mergedAwayCanonicalIds: string[];
}

export interface EnumerationTickResult {
  checkpoint: EnumerationCheckpoint;
  done: boolean;
  conversationsProcessedThisTick: number;
  searchPagesFetchedThisTick: number;
  messagePagesFetchedThisTick: number;
  /**
   * Task #2010 — in-window OUTBOUND messages captured THIS TICK when the
   * caller passes `collectOutboundMessages: true`. Empty / undefined when
   * collection is off (the measurement-only #1983 contract). Bounded per
   * tick by the conversation / message-page budgets; the caller is
   * expected to dedupe + persist these and then discard them.
   */
  outboundMessagesThisTick?: CollectedOutboundMessage[];
  /**
   * Task #2708 — in-window ALL messages (inbound + outbound) captured THIS
   * TICK when the caller passes `collectAllMessages: true`. Empty / undefined
   * when collection is off. Bounded by the conversation / message-page budgets.
   * Supersedes `outboundMessagesThisTick` for callers that need both directions.
   */
  allMessagesThisTick?: CollectedOutboundMessage[];
}

interface FrontPaginatedPage<T> {
  _results?: T[];
  _pagination?: { next?: string | null };
}

type ConversationSearchPage = FrontPaginatedPage<{
  id?: string;
  subject?: string;
}>;

/**
 * A raw Front message object as returned by `/conversations/:id/messages`.
 * The measurement walk only reads `is_inbound` / `created_at`; the
 * opt-in close-gap collection (Task #2010) also needs the id + body +
 * author + recipients to materialize a `raw_communication_records` row
 * through the shared ingestion helper, so this type stays loose.
 */
export interface FrontRawMessage {
  id?: string;
  is_inbound?: boolean;
  created_at?: number;
  subject?: string;
  body?: string;
  author?: { username?: string; email?: string } | null;
  recipients?: Array<{ name?: string; handle?: string; role?: string }>;
  [k: string]: unknown;
}
type ConversationMessagesPage = FrontPaginatedPage<FrontRawMessage>;

/**
 * One in-window OUTBOUND message captured by the walk when
 * `collectOutboundMessages` is on (Task #2010). Carries the parent
 * conversation id + best-known subject so the caller can write a
 * `raw_communication_records` row without a second Front fetch.
 */
export interface CollectedOutboundMessage {
  conversationId: string;
  conversationSubject?: string;
  message: FrontRawMessage;
}

/**
 * Shared bounded-retry GET → JSON used by the enumeration walk. Mirrors
 * the search fallback's classification: 401/403 terminal (auth), 429
 * and 5xx bounded with backoff, other non-2xx terminal, non-JSON →
 * unexpected_shape. Retry budgets are per-call (one URL).
 */
async function frontGetJsonWithRetries<T>(
  url: string,
  doFetch: (path: string) => Promise<Response>,
  doSleep: (ms: number) => Promise<void>,
  ctx: string,
  now: () => number = Date.now,
): Promise<{ data: T; finalUrl: string }> {
  let consecutive429s = 0;
  let consecutive5xx = 0;
  // Task #2743 — bounded transport-abort retry budget (see the search
  // fallback for rationale). Kept separate from the 429/5xx budgets.
  let consecutiveTransport = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res: Response;
    try {
      res = await doFetch(url);
    } catch (err) {
      // Task #2743 — retry a transient transport-level fetch rejection
      // (abort / timeout / ECONNRESET) with bounded backoff instead of
      // failing terminally on the first blip. On exhaustion surface the
      // RETRIABLE `front_analytics_transport_failed` (not
      // `front_analytics_search_failed`) so the caller can resume next tick.
      //
      // CRITICAL: only genuine fetch-level network rejects are retriable —
      // a terminal `FrontAuthError` or other non-transport throw propagates
      // untouched so terminal auth failures are never wrapped as retriable.
      if (!isTransportLevelFetchError(err)) {
        throw err;
      }
      consecutiveTransport += 1;
      if (consecutiveTransport > SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES) {
        throw new FrontAnalyticsError(
          "front_analytics_transport_failed",
          `Front ${ctx} transport error after ${SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES} retries: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const exp = Math.min(
        SEARCH_FALLBACK_5XX_BACKOFF_BASE_MS *
          Math.pow(2, consecutiveTransport - 1),
        SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
      );
      const backoffMs = exp + Math.floor(Math.random() * Math.min(250, exp / 4));
      await doSleep(backoffMs);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const snippet = await safeReadBodySnippet(res);
      throw new FrontAnalyticsError(
        "front_analytics_auth_failed",
        `Front ${ctx} auth failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    if (res.status === 429) {
      consecutive429s += 1;
      if (consecutive429s > SEARCH_FALLBACK_MAX_429_RETRIES) {
        throw new FrontAnalyticsError(
          "front_analytics_rate_limited",
          `Front ${ctx} rate limited: exceeded ${SEARCH_FALLBACK_MAX_429_RETRIES} consecutive 429 retries`,
          429,
        );
      }
      const retryAfter = Number(res.headers.get("retry-after") || 5);
      await doSleep(Math.min(retryAfter * 1000, POLL_MAX_DELAY_MS));
      continue;
    }
    if (res.status >= 500 && res.status <= 599) {
      consecutive5xx += 1;
      if (consecutive5xx > SEARCH_FALLBACK_MAX_5XX_RETRIES) {
        const snippet = await safeReadBodySnippet(res);
        throw new FrontAnalyticsError(
          "front_analytics_search_failed",
          `Front ${ctx} failed after ${SEARCH_FALLBACK_MAX_5XX_RETRIES} 5xx retries (status ${res.status})${snippet ? `: ${snippet}` : ""}`,
          res.status,
        );
      }
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      let backoffMs: number;
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        backoffMs = Math.min(
          retryAfterSec * 1000,
          SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
        );
      } else {
        const exp = Math.min(
          SEARCH_FALLBACK_5XX_BACKOFF_BASE_MS * Math.pow(2, consecutive5xx - 1),
          SEARCH_FALLBACK_5XX_BACKOFF_MAX_MS,
        );
        backoffMs = exp + Math.floor(Math.random() * Math.min(250, exp / 4));
      }
      await doSleep(backoffMs);
      continue;
    }
    if (!res.ok) {
      const snippet = await safeReadBodySnippet(res);
      throw new FrontAnalyticsError(
        "front_analytics_search_failed",
        `Front ${ctx} failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    try {
      const data = (await res.json()) as T;
      // Task #2721 — proactive self-pacing. Read Front's live rate-limit
      // budget off this successful page's headers and, if it is running
      // low, sleep before returning so the caller's NEXT page fetch is
      // throttled ahead of an actual 429. No-op when the budget is
      // healthy or the headers are absent (e.g. test fakes).
      const paceMs = computeRateLimitPaceMs(
        parseFrontRateLimitHeaders(res),
        now(),
      );
      if (paceMs > 0) await doSleep(paceMs);
      return { data, finalUrl: res.url };
    } catch (err) {
      if (err instanceof FrontAnalyticsError) throw err;
      throw new FrontAnalyticsError(
        "front_analytics_unexpected_shape",
        `Front ${ctx} returned non-JSON body`,
      );
    }
  }
}

function normalizeEnumCheckpoint(
  cp: EnumerationCheckpoint | null | undefined,
): EnumerationCheckpoint {
  if (!cp) {
    return {
      searchNextUrl: null,
      searchStarted: false,
      pendingConversationIds: [],
      inboundCount: 0,
      outboundCount: 0,
      processedConversationCount: 0,
      truncated: false,
      mergedAwayCanonicalIds: [],
    };
  }
  return {
    searchNextUrl: cp.searchNextUrl ?? null,
    searchStarted: cp.searchStarted ?? false,
    pendingConversationIds: Array.isArray(cp.pendingConversationIds)
      ? [...cp.pendingConversationIds]
      : [],
    inboundCount: Number.isFinite(cp.inboundCount) ? cp.inboundCount : 0,
    outboundCount: Number.isFinite(cp.outboundCount) ? cp.outboundCount : 0,
    processedConversationCount: Number.isFinite(cp.processedConversationCount)
      ? cp.processedConversationCount
      : 0,
    truncated: cp.truncated ?? false,
    mergedAwayCanonicalIds: Array.isArray(cp.mergedAwayCanonicalIds)
      ? [...cp.mergedAwayCanonicalIds]
      : [],
  };
}

/**
 * Extract the conversation id from a `/conversations/{id}/messages` URL.
 * Used to resolve the canonical conversation after a 301 merge redirect
 * (Task #1920): native fetch follows the redirect, so the response's
 * `finalUrl` carries the merged-into conversation id. Returns null when the
 * URL is empty or does not match (e.g. test fakes built with `new Response()`
 * whose `.url` is empty), in which case the caller treats the conversation as
 * un-merged and counts it normally.
 */
function extractConversationIdFromMessagesUrl(u: string): string | null {
  if (!u) return null;
  const m = /\/conversations\/([^/]+)\/messages/.exec(u);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Run ONE bounded, resumable tick of the per-message enumeration walk.
 * See the block comment above for the full contract.
 */
export async function enumerateMonthlyMessagesByDirectionTick(opts: {
  monthStart: Date;
  monthEnd: Date;
  checkpoint?: EnumerationCheckpoint | null;
  conversationBudget?: number;
  messagePageBudget?: number;
  fetcher?: (path: string) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Task #2721 — test seam for the rate-limit self-pacing clock. Production
   * callers leave this undefined and the real `Date.now` is used; tests pin it
   * so the `x-ratelimit-reset` (epoch-seconds) math is deterministic.
   */
  now?: () => number;
  /**
   * Task #2010 — opt-in. When true the walk ALSO captures the in-window
   * OUTBOUND message objects it sees and returns them in
   * `outboundMessagesThisTick`. Default false keeps the measurement-only
   * #1983 contract (counts only, no extra memory).
   */
  collectOutboundMessages?: boolean;
  /**
   * Task #2708 — opt-in. When true the walk captures ALL in-window messages
   * (inbound AND outbound) in `allMessagesThisTick`. Used by the applied-
   * conversation materializer to fill raw_communication_records for months
   * where conversations are already `applied` in front_sync_emails but their
   * messages were never written. Default false.
   */
  collectAllMessages?: boolean;
}): Promise<EnumerationTickResult> {
  const doFetch = opts.fetcher ?? frontFetch;
  const collect = opts.collectOutboundMessages === true;
  const collectAll = opts.collectAllMessages === true;
  const collectedOutbound: CollectedOutboundMessage[] = [];
  const collectedAll: CollectedOutboundMessage[] = [];
  // Best-known conversation subject, populated from search pages fetched
  // THIS call. Conversations carried over from a prior tick's pending
  // queue have no subject here → the caller falls back to a generic title.
  const subjectById = new Map<string, string>();
  const doSleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const convBudget = Math.max(
    1,
    opts.conversationBudget ?? ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
  );
  const msgPageBudget = Math.max(
    1,
    opts.messagePageBudget ?? ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
  );

  // Front search and message windows are Unix SECONDS; the per-message
  // membership test uses milliseconds for parity with the rest of the
  // coverage service.
  const afterUnix = Math.floor(opts.monthStart.getTime() / 1000);
  const beforeUnix = Math.floor(opts.monthEnd.getTime() / 1000);
  const startMs = opts.monthStart.getTime();
  const endMs = opts.monthEnd.getTime();

  const cp = normalizeEnumCheckpoint(opts.checkpoint);

  let conversationsThisTick = 0;
  let searchPagesThisTick = 0;
  let messagePagesThisTick = 0;
  let done = false;

  while (conversationsThisTick < convBudget) {
    // Refill the pending queue from the next search page when empty.
    if (cp.pendingConversationIds.length === 0) {
      if (!cp.searchStarted) {
        const query = `after:${afterUnix} before:${beforeUnix}`;
        cp.searchNextUrl = `/conversations/search/${encodeURIComponent(
          query,
        )}?limit=${SEARCH_FALLBACK_PAGE_SIZE}`;
        cp.searchStarted = true;
      }
      if (cp.searchNextUrl === null) {
        // Search exhausted AND nothing pending → the month is complete.
        done = true;
        break;
      }
      if (cp.processedConversationCount >= ENUM_MAX_CONVERSATIONS_PER_MONTH) {
        cp.truncated = true;
        done = true;
        break;
      }
      const { data: page } =
        await frontGetJsonWithRetries<ConversationSearchPage>(
          cp.searchNextUrl,
          doFetch,
          doSleep,
          "conversation search",
          now,
        );
      searchPagesThisTick += 1;
      const results = Array.isArray(page._results) ? page._results : [];
      for (const c of results) {
        if (c && typeof c.id === "string" && c.id.length > 0) {
          cp.pendingConversationIds.push(c.id);
          if ((collect || collectAll) && typeof c.subject === "string" && c.subject.length > 0) {
            subjectById.set(c.id, c.subject);
          }
        }
      }
      const next = page._pagination?.next;
      cp.searchNextUrl =
        typeof next === "string" && next.length > 0 ? next : null;
      continue;
    }

    // Per-month hard cap guard before walking another conversation.
    if (cp.processedConversationCount >= ENUM_MAX_CONVERSATIONS_PER_MONTH) {
      cp.truncated = true;
      done = true;
      break;
    }

    // Per-tick Front-call budget. Checked only at a conversation
    // boundary so the walk stays conversation-atomic.
    if (messagePagesThisTick >= msgPageBudget) {
      break;
    }

    // Enumerate the next pending conversation fully.
    const convId = cp.pendingConversationIds[0];
    let url: string | null = `/conversations/${encodeURIComponent(
      convId,
    )}/messages?limit=${ENUM_MESSAGES_PAGE_SIZE}`;
    let pagesForConv = 0;
    let inboundForConv = 0;
    let outboundForConv = 0;
    // Conversation-atomic collection buffer (Task #2010): only flushed to
    // the tick-level array once the conversation has been fully walked,
    // mirroring how the inbound/outbound counts are folded.
    const outboundForConvMsgs: FrontRawMessage[] = [];
    // Task #1920 — set true when this conversation resolves (via a 301 merge)
    // to a canonical conversation whose messages were already counted, so its
    // folded counts are skipped to avoid a double count.
    let mergeDuplicate = false;
    // Task #2708 — per-conversation buffer for the all-messages collector.
    const allForConvMsgs: FrontRawMessage[] = [];
    while (url && pagesForConv < ENUM_MAX_MESSAGE_PAGES_PER_CONVERSATION) {
      const fetched: {
        data: ConversationMessagesPage;
        finalUrl: string;
      } = await frontGetJsonWithRetries<ConversationMessagesPage>(
        url,
        doFetch,
        doSleep,
        "conversation messages",
        now,
      );
      const page = fetched.data;
      const finalUrl = fetched.finalUrl;
      messagePagesThisTick += 1;
      pagesForConv += 1;
      // Follow 301 merges (Task #1920). When a conversation was merged into
      // another, `GET /conversations/{convId}/messages` 301-redirects to the
      // canonical conversation; native fetch follows it, so `finalUrl` carries
      // the canonical id. Dedup so a merged conversation's messages are never
      // counted under both the merged-away source and the canonical
      // conversation — a double-count would inflate the message-grain
      // denominator and stop a month from honestly converging to 100%.
      if (pagesForConv === 1) {
        const canonicalId = extractConversationIdFromMessagesUrl(finalUrl);
        if (canonicalId && canonicalId !== convId) {
          if (cp.mergedAwayCanonicalIds.includes(canonicalId)) {
            mergeDuplicate = true;
          } else {
            cp.mergedAwayCanonicalIds.push(canonicalId);
          }
        } else if (cp.mergedAwayCanonicalIds.includes(convId)) {
          // This conversation was already counted as another conversation's
          // merge target → skip the direct walk to avoid a double count.
          mergeDuplicate = true;
        }
        if (mergeDuplicate) {
          url = null;
          break;
        }
      }
      const msgs = Array.isArray(page._results) ? page._results : [];
      for (const m of msgs) {
        if (!m || typeof m.created_at !== "number") continue;
        const tsMs = m.created_at * 1000;
        if (tsMs < startMs || tsMs >= endMs) continue;
        if (m.is_inbound === true) {
          inboundForConv += 1;
          if (collectAll && typeof m.id === "string" && m.id.length > 0) {
            allForConvMsgs.push(m);
          }
        } else if (m.is_inbound === false) {
          outboundForConv += 1;
          if (typeof m.id === "string" && m.id.length > 0) {
            if (collect) outboundForConvMsgs.push(m);
            if (collectAll) allForConvMsgs.push(m);
          }
        }
      }
      const next = page._pagination?.next;
      url = typeof next === "string" && next.length > 0 ? next : null;
    }

    // If the inner loop stopped because we hit the per-conversation page
    // cap (URL still pending), this conversation was NOT fully walked —
    // its folded counts are an undercount. Flag the whole month as
    // truncated so the caller refuses to publish a partial denominator.
    if (url !== null) {
      cp.truncated = true;
    }

    // Conversation-atomic commit: fold counts and advance the checkpoint
    // only after the conversation has been fully walked.
    cp.inboundCount += inboundForConv;
    cp.outboundCount += outboundForConv;
    cp.processedConversationCount += 1;
    cp.pendingConversationIds.shift();
    conversationsThisTick += 1;
    if (collect && outboundForConvMsgs.length > 0) {
      const conversationSubject = subjectById.get(convId);
      for (const message of outboundForConvMsgs) {
        collectedOutbound.push({
          conversationId: convId,
          conversationSubject,
          message,
        });
      }
    }
    if (collectAll && allForConvMsgs.length > 0) {
      const conversationSubject = subjectById.get(convId);
      for (const message of allForConvMsgs) {
        collectedAll.push({
          conversationId: convId,
          conversationSubject,
          message,
        });
      }
    }
  }

  // Completed iff search is exhausted and the pending queue is drained.
  if (
    !done &&
    cp.searchStarted &&
    cp.searchNextUrl === null &&
    cp.pendingConversationIds.length === 0
  ) {
    done = true;
  }

  return {
    checkpoint: cp,
    done,
    conversationsProcessedThisTick: conversationsThisTick,
    searchPagesFetchedThisTick: searchPagesThisTick,
    messagePagesFetchedThisTick: messagePagesThisTick,
    ...(collect ? { outboundMessagesThisTick: collectedOutbound } : {}),
    ...(collectAll ? { allMessagesThisTick: collectedAll } : {}),
  };
}

// ──────────────── Test helpers ────────────────
// The coverage worker tests stub out the whole pull so they never
// touch Front. This override is consulted FIRST by
// `pullMonthlyMessageCountForTests` so tests can inject canned values.

type PullFn = typeof pullMonthlyMessageCount;
let pullOverride: PullFn | null = null;
type SearchFallbackFn = typeof pullMonthlyMessageCountViaSearchFallback;
let searchFallbackOverride: SearchFallbackFn | null = null;
type EnumerationFn = typeof enumerateMonthlyMessagesByDirectionTick;
let enumerationOverride: EnumerationFn | null = null;
type DirectionPullFn = typeof pullMonthlyMessagesByDirection;
let directionPullOverride: DirectionPullFn | null = null;

export const __frontAnalyticsClientTestHelpers = {
  setPullOverride(fn: PullFn | null): void {
    pullOverride = fn;
  },
  getPullOverride(): PullFn | null {
    return pullOverride;
  },
  setDirectionPullOverride(fn: DirectionPullFn | null): void {
    directionPullOverride = fn;
  },
  getDirectionPullOverride(): DirectionPullFn | null {
    return directionPullOverride;
  },
  setSearchFallbackOverride(fn: SearchFallbackFn | null): void {
    searchFallbackOverride = fn;
  },
  getSearchFallbackOverride(): SearchFallbackFn | null {
    return searchFallbackOverride;
  },
  setEnumerationOverride(fn: EnumerationFn | null): void {
    enumerationOverride = fn;
  },
  getEnumerationOverride(): EnumerationFn | null {
    return enumerationOverride;
  },
  /**
   * Task #1709 — exposed so tests can pin the truncation contract:
   * the snippet must be large enough that an envelope-wrapped 403
   * body still contains the literal plan-history phrase, otherwise
   * `isPlanLimitSnippet` won't match downstream and rows get
   * misclassified as `front_analytics_auth_failed`.
   */
  bodySnippetMaxChars: BODY_SNIPPET_MAX_CHARS,
  safeReadBodySnippet,
};

/**
 * Wrapper the coverage worker should call. Honors the test override
 * before going to the network.
 */
export async function pullMonthlyMessageCountResolved(opts: {
  monthStart: Date;
  monthEnd: Date;
  metric?: string;
}): Promise<MonthlyMetricResult> {
  const fn = pullOverride ?? pullMonthlyMessageCount;
  return fn(opts);
}

/**
 * Task #2290 — per-direction Analytics wrapper that honors the test
 * override the same way `pullMonthlyMessageCountResolved` does, so the
 * coverage worker's in-plan message-grain headline path is testable
 * without touching Front.
 */
export async function pullMonthlyMessagesByDirectionResolved(opts: {
  monthStart: Date;
  monthEnd: Date;
}): Promise<MonthlyMessagesByDirection> {
  const fn = directionPullOverride ?? pullMonthlyMessagesByDirection;
  return fn(opts);
}

/**
 * Task #1681 — search-fallback wrapper that honors the test override
 * the same way `pullMonthlyMessageCountResolved` does for Analytics.
 */
export async function pullMonthlyMessageCountViaSearchFallbackResolved(opts: {
  monthStart: Date;
  monthEnd: Date;
}): Promise<SearchFallbackResult> {
  const fn = searchFallbackOverride ?? pullMonthlyMessageCountViaSearchFallback;
  return fn(opts);
}

/**
 * Task #1983 — per-message enumeration wrapper that honors the test
 * override the same way the Analytics / search resolvers do.
 */
export async function enumerateMonthlyMessagesByDirectionTickResolved(opts: {
  monthStart: Date;
  monthEnd: Date;
  checkpoint?: EnumerationCheckpoint | null;
  conversationBudget?: number;
  messagePageBudget?: number;
  fetcher?: (path: string) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  collectOutboundMessages?: boolean;
  collectAllMessages?: boolean;
}): Promise<EnumerationTickResult> {
  const fn = enumerationOverride ?? enumerateMonthlyMessagesByDirectionTick;
  return fn(opts);
}
