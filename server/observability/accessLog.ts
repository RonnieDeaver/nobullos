/**
 * Task #3816 — App-wide request spine, part 2: structured access log.
 *
 * One structured, greppable log line per API request:
 *
 *   9:15:32 AM [api] GET /api/clients/abc123 200 in 42ms rid=1f2e3d4c5b6a7988 route=GET /api/clients/:id role=ceo
 *
 * Design constraints:
 *  - CHEAP: string concat + one console.log on response finish; no DB reads,
 *    no async work. Role comes from the rate-limiter's per-request role cache
 *    (`_rateLimitRole`) when it already resolved — never a lookup of our own.
 *  - Greppable: the head keeps the long-standing `METHOD path status in Nms`
 *    shape; the tail is `k=v` fields (rid/route/role/uid).
 *  - Noisy internal routes (health polls, bell/activity polling, SSE, session
 *    probes) are ELIDED: successes log 1-in-N with a `sampled=` marker; 4xx+
 *    and slow requests on those routes always log.
 *
 * Pure decision/format helpers are exported for tests; the only side effects
 * live in `recordAccess` (metrics + log emit).
 */
import type { Request, Response } from "express";
import { normalizeApiPathForLabel } from "../apiLabel";
import { recordRequestSample } from "../services/requestMetrics";

/** Successful (<400) fast responses on elided routes log 1 in N. */
export const ELIDED_SAMPLE_EVERY_N = 20;
/** Requests at/above this duration always log, elided or not. */
export const SLOW_ALWAYS_LOG_MS = 1500;
/** Route-pattern field cap so a pathological URL can't bloat the line. */
const MAX_ROUTE_LEN = 160;

/**
 * High-frequency internal routes whose steady-state 2xx traffic would drown
 * the log (dashboard health polls every 30–60s × many panels, bell +
 * activity polling on every open tab, SSE reconnects, session probes).
 * Matched against the query-stripped path. `prefix` entries also elide
 * subpaths.
 */
const ELIDED_ROUTES: ReadonlyArray<{ id: string; path: string; prefix?: boolean }> = [
  { id: "health", path: "/api/health", prefix: true },
  { id: "notifications", path: "/api/notifications" }, // bell list poll (exact)
  { id: "unread-count", path: "/api/notifications/unread-count" },
  { id: "sse", path: "/api/notifications/events" },
  { id: "activity", path: "/api/activity" }, // batched telemetry flush + feed poll
  { id: "auth-user", path: "/api/auth/user" }, // session probe on every page load
  { id: "db-metrics", path: "/api/_internal/db-metrics" },
];

/** Returns the elision-rule id for a path, or null when never elided. */
export function elisionRuleFor(path: string): string | null {
  for (const rule of ELIDED_ROUTES) {
    if (rule.prefix ? path === rule.path || path.startsWith(rule.path + "/") : path === rule.path) {
      return rule.id;
    }
  }
  return null;
}

// One counter per elision RULE (bounded by the rule list, not by URL
// cardinality). Deterministic modulo — no RNG so tests are exact.
const sampleCounters = new Map<string, number>();

export interface AccessDecision {
  log: boolean;
  /** Set when this line is a 1-in-N sample of an elided route. */
  sampledNote?: string;
}

export function decideAccessLog(input: {
  path: string;
  status: number;
  durationMs: number;
}): AccessDecision {
  const { path, status, durationMs } = input;
  // Errors and slow requests always log — elision only hides steady-state
  // success noise, never evidence.
  if (status >= 400 || durationMs >= SLOW_ALWAYS_LOG_MS) return { log: true };
  if (process.env.ACCESS_LOG_VERBOSE === "1") return { log: true };
  const rule = elisionRuleFor(path);
  if (!rule) return { log: true };
  const n = (sampleCounters.get(rule) ?? 0) + 1;
  sampleCounters.set(rule, n);
  if (n % ELIDED_SAMPLE_EVERY_N === 1) {
    return { log: true, sampledNote: `sampled=1/${ELIDED_SAMPLE_EVERY_N}` };
  }
  return { log: false };
}

/**
 * Route pattern for metrics/log labels: the matched Express route when
 * available (`/api/clients/:id`), else the id-normalized URL (UUIDs and
 * numeric segments already collapsed to `:id` — bounded cardinality).
 */
export function buildRouteKey(req: Request): string {
  const route = (req as any).route?.path as string | undefined;
  const pattern = route
    ? (req.baseUrl || "") + route
    : normalizeApiPathForLabel(req.originalUrl || req.url || req.path);
  return pattern.slice(0, MAX_ROUTE_LEN);
}

export interface AccessLogFields {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  route: string;
  role: string;
  userId?: string | null;
  aborted?: boolean;
  sampledNote?: string;
}

export function formatAccessLine(f: AccessLogFields): string {
  let line =
    `${f.method} ${f.path} ${f.status} in ${f.durationMs}ms ` +
    `rid=${f.requestId} route=${f.method} ${f.route} role=${f.role}`;
  if (f.userId) line += ` uid=${f.userId}`;
  if (f.aborted) line += ` aborted=1`;
  if (f.sampledNote) line += ` ${f.sampledNote}`;
  return line;
}

// ── emit + test seam ─────────────────────────────────────────────────────────

type AccessSink = (line: string) => void;
let sinkOverride: AccessSink | null = null;

function emit(line: string): void {
  if (sinkOverride) {
    sinkOverride(line);
    return;
  }
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [api] ${line}`);
}

/**
 * Cheap synchronous role read: the rate limiters' `roleAwareMax` caches the
 * resolved role on the request; we never do our own lookup on the log path.
 */
function roleOf(req: Request): string {
  const cached = (req as any)._rateLimitRole;
  if (typeof cached === "string" && cached) return cached;
  return (req as any).user?.claims?.sub ? "user" : "-";
}

/**
 * Response-finish hook body: record the sample into the rolling per-route
 * aggregator (always), then emit the access line (subject to elision).
 * Only /api paths are logged/aggregated; static + SPA traffic is skipped.
 */
export function recordAccess(req: Request, res: Response, startedAt: number, aborted = false): void {
  try {
    const path = (req.originalUrl || req.url || "").split("?")[0];
    if (!path.startsWith("/api")) return;
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode;
    const route = buildRouteKey(req);
    recordRequestSample({ method: req.method, route, status, durationMs });
    const decision = decideAccessLog({ path, status, durationMs });
    if (!decision.log) return;
    emit(
      formatAccessLine({
        method: req.method,
        path,
        status,
        durationMs,
        requestId: (req as any).requestId ?? "-",
        route,
        role: roleOf(req),
        userId: (req as any).user?.claims?.sub ?? null,
        aborted,
        sampledNote: decision.sampledNote,
      }),
    );
  } catch {
    // The access log must never break a request.
  }
}

export const __testHelpers = {
  setSinkForTests(fn: AccessSink | null): void {
    sinkOverride = fn;
  },
  resetSampleCountersForTests(): void {
    sampleCounters.clear();
  },
};
