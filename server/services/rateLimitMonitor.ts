// @cross-instance-safe: idempotent prune DELETE of blocked rate-limit events by cutoff; converges across instances.
import type { Request, Response, NextFunction } from "express";
import type { Options } from "express-rate-limit";

export interface RateLimitEvent {
  ip: string;
  userId: string | null;
  path: string;
  method: string;
  category: string;
  timestamp: number;
}

export interface CategoryMetrics {
  totalBlocked: number;
  windowMs: number;
  maxRequests: number;
  recentEvents: RateLimitEvent[];
  uniqueIPs: number;
  topIPs: { ip: string; count: number }[];
  uniqueUsers: number;
  topUsers: { userId: string; count: number }[];
  alertThreshold: number;
  alertLevel: "none" | "warning" | "critical";
  exempt: boolean;
  tunerReadOnly: boolean;
  note?: string;
}

export interface UserRateLimitMetrics {
  userId: string;
  totalBlocked: number;
  categories: Record<string, number>;
  recentEvents: RateLimitEvent[];
  firstSeen: number;
  lastSeen: number;
}

const MAX_EVENTS_PER_CATEGORY = 200;
const TOP_IPS_LIMIT = 10;
const TOP_USERS_LIMIT = 10;

const DEFAULT_WARNING_THRESHOLD = 50;
const CRITICAL_MULTIPLIER = 3;

const events: Map<string, RateLimitEvent[]> = new Map();

const limiterConfigs: Map<string, { windowMs: number; max: number; roleAware: boolean; exempt: boolean; tunerReadOnly: boolean; note?: string }> = new Map();

const requestCounts: Map<string, { total: number; firstSeen: number }> = new Map();

const alertThresholds: Map<string, number> = new Map();

export async function setAlertThreshold(category: string, threshold: number): Promise<void> {
  try {
    const { upsertRateLimitThreshold } = await import("../storage/rateLimitThresholdsStorage");
    await upsertRateLimitThreshold({ category, threshold });
  } catch (err: any) {
    console.error(`[RateLimitThresholds] Failed to persist threshold for ${category}:`, err.message);
    throw err;
  }
  alertThresholds.set(category, threshold);
}

export async function resetAlertThreshold(category: string): Promise<void> {
  try {
    const { deleteRateLimitThreshold } = await import("../storage/rateLimitThresholdsStorage");
    await deleteRateLimitThreshold(category);
  } catch (err: any) {
    console.error(`[RateLimitThresholds] Failed to reset threshold for ${category}:`, err.message);
    throw err;
  }
  alertThresholds.delete(category);
}

export async function resetAllAlertThresholds(): Promise<string[]> {
  const cleared = Array.from(alertThresholds.keys());
  try {
    const { deleteAllRateLimitThresholds } = await import("../storage/rateLimitThresholdsStorage");
    await deleteAllRateLimitThresholds();
  } catch (err: any) {
    console.error(`[RateLimitThresholds] Failed to reset all thresholds:`, err.message);
    throw err;
  }
  alertThresholds.clear();
  return cleared;
}

let thresholdsLoadPromise: Promise<void> | null = null;

export async function loadAlertThresholdsFromDB(): Promise<void> {
  if (!thresholdsLoadPromise) {
    thresholdsLoadPromise = (async () => {
      try {
        const { ensureRateLimitThresholdsTable, listRateLimitThresholds } = await import(
          "../storage/rateLimitThresholdsStorage"
        );
        await ensureRateLimitThresholdsTable();
        const rows = await listRateLimitThresholds();
        for (const row of rows) {
          alertThresholds.set(row.category, row.threshold);
        }
        console.info(`[RateLimitThresholds] Loaded ${rows.length} alert threshold(s) from database`);
      } catch (err: any) {
        console.error("[RateLimitThresholds] Failed to load alert thresholds from DB:", err.message);
      }
    })();
  }
  return thresholdsLoadPromise;
}

export function getAlertThresholds(): Record<string, number> {
  const result: Record<string, number> = {};
  const allCategories = new Set([...events.keys(), ...limiterConfigs.keys(), ...alertThresholds.keys()]);
  for (const cat of allCategories) {
    result[cat] = alertThresholds.get(cat) ?? DEFAULT_WARNING_THRESHOLD;
  }
  return result;
}

function computeAlertLevel(totalBlocked: number, threshold: number): "none" | "warning" | "critical" {
  if (totalBlocked >= threshold * CRITICAL_MULTIPLIER) return "critical";
  if (totalBlocked >= threshold) return "warning";
  return "none";
}

export function registerLimiterConfig(
  category: string,
  windowMs: number,
  max: number,
  roleAware: boolean = true,
  options?: { exempt?: boolean; tunerReadOnly?: boolean; note?: string },
): void {
  limiterConfigs.set(category, {
    windowMs,
    max,
    roleAware,
    exempt: options?.exempt ?? false,
    // Task #2883: a real (enforcing) limiter the auto-tuner must never
    // suggest for or mutate — e.g. background_polling, a non-interactive
    // safety-net bucket whose steady polling traffic would mislead the
    // interactive tuning heuristics. Unlike `exempt`, the limit itself
    // still applies to requests.
    tunerReadOnly: options?.tunerReadOnly ?? false,
    note: options?.note,
  });
}

export function updateLimiterConfig(category: string, max: number): void {
  const existing = limiterConfigs.get(category);
  if (existing) {
    limiterConfigs.set(category, { ...existing, max });
  }
}

export function getDynamicMax(category: string): number {
  const config = limiterConfigs.get(category);
  return config?.max ?? 0;
}

export function getLimiterConfigs(): Map<string, { windowMs: number; max: number; roleAware: boolean; exempt: boolean; tunerReadOnly: boolean; note?: string }> {
  return limiterConfigs;
}

export function computeEffectiveLimits(
  multipliers: Record<string, number>
): {
  roles: string[];
  multipliers: Record<string, number>;
  categories: Record<string, { base: number; windowMs: number; roleAware: boolean; perRole: Record<string, number>; exempt: boolean; tunerReadOnly: boolean; note?: string }>;
} {
  const roles = Object.keys(multipliers);
  const categories: Record<string, { base: number; windowMs: number; roleAware: boolean; perRole: Record<string, number>; exempt: boolean; tunerReadOnly: boolean; note?: string }> = {};
  for (const [category, config] of limiterConfigs.entries()) {
    const perRole: Record<string, number> = {};
    perRole.default = config.max;
    if (config.roleAware) {
      for (const role of roles) {
        const m = multipliers[role] ?? 1;
        perRole[role] = Math.ceil(config.max * m);
      }
    } else {
      for (const role of roles) {
        perRole[role] = config.max;
      }
    }
    categories[category] = {
      base: config.max,
      windowMs: config.windowMs,
      roleAware: config.roleAware,
      perRole,
      exempt: config.exempt,
      tunerReadOnly: config.tunerReadOnly,
      note: config.note,
    };
  }
  return { roles, multipliers, categories };
}

export function trackRequest(category: string): void {
  const existing = requestCounts.get(category);
  if (existing) {
    existing.total++;
  } else {
    requestCounts.set(category, { total: 1, firstSeen: Date.now() });
  }
}

export function getRequestCounts(): Map<string, { total: number; firstSeen: number }> {
  return requestCounts;
}

export function getEventsForCategory(category: string): RateLimitEvent[] {
  return events.get(category) || [];
}

export function createRateLimitHandler(category: string) {
  return (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    // Task #4789 — Clerk-first identity resolution: clerkMiddleware runs before
    // limiters so getAuth() works here; requireAuth (which populates req.user)
    // runs AFTER limiters, so reading req.user caused empty attribution after
    // the 2026-08-13 Clerk cutover. Mirror the same resolution order used by
    // userKeyGenerator and resolveUserRole in server/routes/middleware.ts.
    let userId: string | null = null;
    try {
      const { getAuth } = require("@clerk/express") as typeof import("@clerk/express");
      const auth = getAuth(req);
      userId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId || null;
    } catch {
      // getAuth throws when clerkMiddleware is not mounted (isolated route tests).
    }
    // Legacy fallback: populated by requireAuth for downstream handlers and in
    // route-test harnesses that call requireAuth before a limiter check.
    if (!userId) {
      userId = (req as any).user?.claims?.sub || null;
    }

    const event: RateLimitEvent = {
      ip,
      userId,
      path: req.originalUrl || req.path,
      method: req.method,
      category,
      timestamp: Date.now(),
    };

    const userLabel = userId ? `userId=${userId}` : "anonymous";
    console.warn(
      `[RateLimit] BLOCKED — category=${category} ip=${ip} ${userLabel} method=${event.method} path=${event.path}`
    );

    let categoryEvents = events.get(category);
    if (!categoryEvents) {
      categoryEvents = [];
      events.set(category, categoryEvents);
    }

    categoryEvents.push(event);
    if (categoryEvents.length > MAX_EVENTS_PER_CATEGORY) {
      events.set(category, categoryEvents.slice(-MAX_EVENTS_PER_CATEGORY));
    }

    persistBlockedEvent(event).catch((err: any) => {
      console.error(`[RateLimit] Failed to persist blocked event for ${category}:`, err.message);
    });

    // Task #944B: for the two Twilio voice webhooks the called party
    // actually hears, a JSON 429 response causes Twilio to play its
    // built-in "an application error has occurred" prompt. Override the
    // default rejection body with HTTP 200 + valid fallback TwiML so the
    // recipient hears a clean spoken sentence and a hangup instead. The
    // event is still recorded above, so 944C diagnostics can detect any
    // sustained rate-limit pressure on these endpoints.
    // Task #944B: Use req.originalUrl (full path including any mount
    // prefix Express stripped from req.path) so this fallback matches
    // regardless of whether the limiter is mounted at "/api",
    // "/api/twilio/webhooks", or anywhere else. We compare against the
    // path portion only, ignoring the query string.
    const fullUrl = req.originalUrl || req.url || "";
    const pathOnly = fullUrl.split("?", 1)[0];
    if (
      pathOnly === "/api/twilio/webhooks/voice-twiml-browser" ||
      pathOnly === "/api/twilio/webhooks/voice-whisper"
    ) {
      console.warn(
        `[RateLimit] Twilio voice route rate-limited — returning 200 + fallback TwiML to avoid Twilio default error voice (path=${pathOnly})`,
      );
      res
        .status(200)
        .type("text/xml")
        .send(
          `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>The call could not be connected. Please try again.</Say>\n  <Hangup/>\n</Response>`,
        );
      return;
    }

    res.status(options.statusCode).json(options.message);
  };
}

async function persistBlockedEvent(event: RateLimitEvent): Promise<void> {
  const { insertBlockedRateLimitEvent } = await import("../storage/blockedRateLimitEventsStorage");
  await insertBlockedRateLimitEvent({
    timestamp: event.timestamp,
    category: event.category,
    method: event.method,
    path: event.path,
    ip: event.ip,
    userId: event.userId,
  });
}

const BLOCKED_EVENTS_RETENTION_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const BLOCKED_EVENTS_RETENTION_MIN_MS = 24 * 60 * 60 * 1000; // 1 day
export const BLOCKED_EVENTS_RETENTION_MAX_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const BLOCKED_EVENTS_RETENTION_SETTING_KEY = "rate_limit_blocked_events_retention_ms";
const BLOCKED_EVENTS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BLOCKED_EVENTS_WARMUP_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
const BLOCKED_EVENTS_WARMUP_MAX = 5000;

let blockedEventsRetentionMs: number = BLOCKED_EVENTS_RETENTION_DEFAULT_MS;
let blockedEventsRetentionLoaded = false;
let blockedEventsLoadPromise: Promise<void> | null = null;
let blockedEventsPruneTimer: NodeJS.Timeout | null = null;

export interface BlockedEventsPruneSweep {
  timestamp: number;
  cutoffTimestamp: number;
  retentionMs: number;
  rowsPruned: number;
  durationMs: number;
  trigger: "startup" | "periodic";
  error?: string;
}

const BLOCKED_EVENTS_PRUNE_SWEEPS_MAX = 10;
const blockedEventsPruneSweeps: BlockedEventsPruneSweep[] = [];

function recordPruneSweep(sweep: BlockedEventsPruneSweep): void {
  blockedEventsPruneSweeps.push(sweep);
  if (blockedEventsPruneSweeps.length > BLOCKED_EVENTS_PRUNE_SWEEPS_MAX) {
    blockedEventsPruneSweeps.splice(
      0,
      blockedEventsPruneSweeps.length - BLOCKED_EVENTS_PRUNE_SWEEPS_MAX,
    );
  }
}

export function getRecentBlockedEventsPruneSweeps(): BlockedEventsPruneSweep[] {
  return blockedEventsPruneSweeps.slice().reverse();
}

export function getBlockedEventsRetentionMs(): number {
  return blockedEventsRetentionMs;
}

export function getBlockedEventsRetentionDefaultMs(): number {
  return BLOCKED_EVENTS_RETENTION_DEFAULT_MS;
}

export async function loadBlockedEventsRetentionFromDB(): Promise<void> {
  if (blockedEventsRetentionLoaded) return;
  try {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    const row = await getSystemSetting(BLOCKED_EVENTS_RETENTION_SETTING_KEY);
    if (row?.value) {
      const n = Number(row.value);
      if (
        Number.isFinite(n) &&
        n >= BLOCKED_EVENTS_RETENTION_MIN_MS &&
        n <= BLOCKED_EVENTS_RETENTION_MAX_MS
      ) {
        blockedEventsRetentionMs = n;
      }
    }
    blockedEventsRetentionLoaded = true;
    console.info(
      `[RateLimit] Blocked-events retention loaded: ${blockedEventsRetentionMs}ms`,
    );
  } catch (err: any) {
    console.error("[RateLimit] Failed to load blocked-events retention:", err.message);
  }
}

export async function setBlockedEventsRetentionMs(
  value: number,
  updatedBy?: string,
): Promise<number> {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("retentionMs must be an integer number of milliseconds");
  }
  if (value < BLOCKED_EVENTS_RETENTION_MIN_MS) {
    throw new Error(
      `retentionMs must be at least ${BLOCKED_EVENTS_RETENTION_MIN_MS} (1 day)`,
    );
  }
  if (value > BLOCKED_EVENTS_RETENTION_MAX_MS) {
    throw new Error(
      `retentionMs cannot exceed ${BLOCKED_EVENTS_RETENTION_MAX_MS} (1 year)`,
    );
  }
  try {
    const { setSystemSetting } = await import("../storage/settingsStorage");
    await setSystemSetting(BLOCKED_EVENTS_RETENTION_SETTING_KEY, String(value), updatedBy);
  } catch (err: any) {
    console.error("[RateLimit] Failed to persist blocked-events retention:", err.message);
    throw err;
  }
  blockedEventsRetentionMs = value;
  blockedEventsRetentionLoaded = true;
  return blockedEventsRetentionMs;
}

export async function loadBlockedRateLimitEventsFromDB(): Promise<void> {
  if (!blockedEventsLoadPromise) {
    blockedEventsLoadPromise = (async () => {
      try {
        const {
          ensureBlockedRateLimitEventsTable,
          loadRecentBlockedRateLimitEvents,
          pruneBlockedRateLimitEventsOlderThan,
        } = await import("../storage/blockedRateLimitEventsStorage");
        await ensureBlockedRateLimitEventsTable();

        const now = Date.now();
        const cutoff = now - blockedEventsRetentionMs;
        const startedAt = Date.now();
        let pruned = 0;
        try {
          pruned = await pruneBlockedRateLimitEventsOlderThan(cutoff);
          recordPruneSweep({
            timestamp: startedAt,
            cutoffTimestamp: cutoff,
            retentionMs: blockedEventsRetentionMs,
            rowsPruned: pruned,
            durationMs: Date.now() - startedAt,
            trigger: "startup",
          });
        } catch (err: any) {
          recordPruneSweep({
            timestamp: startedAt,
            cutoffTimestamp: cutoff,
            retentionMs: blockedEventsRetentionMs,
            rowsPruned: 0,
            durationMs: Date.now() - startedAt,
            trigger: "startup",
            error: err?.message || String(err),
          });
          throw err;
        }
        if (pruned > 0) {
          console.info(`[RateLimit] Pruned ${pruned} blocked event(s) older than retention window`);
        }

        const rows = await loadRecentBlockedRateLimitEvents(
          now - BLOCKED_EVENTS_WARMUP_LOOKBACK_MS,
          BLOCKED_EVENTS_WARMUP_MAX,
        );
        for (const row of rows) {
          const ev: RateLimitEvent = {
            ip: row.ip,
            userId: row.userId,
            path: row.path,
            method: row.method,
            category: row.category,
            timestamp: row.timestamp,
          };
          let categoryEvents = events.get(row.category);
          if (!categoryEvents) {
            categoryEvents = [];
            events.set(row.category, categoryEvents);
          }
          categoryEvents.push(ev);
        }
        for (const [category, list] of events.entries()) {
          if (list.length > MAX_EVENTS_PER_CATEGORY) {
            events.set(category, list.slice(-MAX_EVENTS_PER_CATEGORY));
          }
        }
        console.info(
          `[RateLimit] Warmed in-memory blocked-event buffer with ${rows.length} recent event(s) from DB`,
        );
      } catch (err: any) {
        console.error("[RateLimit] Failed to load blocked events from DB:", err.message);
      }
    })();
  }
  return blockedEventsLoadPromise;
}

/**
 * Run the blocked-events prune sweep immediately. Shares the exact code path
 * used by the periodic timer in `startBlockedRateLimitEventsPruneTimer` —
 * computes the cutoff from the current retention window and invokes the
 * storage helper. Returns the number of rows deleted and the wall-clock
 * duration so admin UI surfaces can confirm the destructive action ran.
 *
 * Used by `POST /api/health/rate-limits/blocked-events-retention/prune`
 * (Task #1129) so admins who just shortened the retention window can run the
 * sweep on demand without waiting for the next scheduled fire.
 */
export async function pruneBlockedRateLimitEventsNow(): Promise<{
  deleted: number;
  durationMs: number;
  cutoff: number;
}> {
  const startedAt = Date.now();
  const cutoff = startedAt - blockedEventsRetentionMs;
  const { pruneBlockedRateLimitEventsOlderThan } = await import(
    "../storage/blockedRateLimitEventsStorage"
  );
  const deleted = await pruneBlockedRateLimitEventsOlderThan(cutoff);
  const durationMs = Date.now() - startedAt;
  if (deleted > 0) {
    console.info(
      `[RateLimit] On-demand prune deleted ${deleted} blocked event(s) older than retention window (${durationMs}ms)`,
    );
  } else {
    console.info(
      `[RateLimit] On-demand prune completed with 0 rows deleted (${durationMs}ms)`,
    );
  }
  return { deleted, durationMs, cutoff };
}

export function startBlockedRateLimitEventsPruneTimer(): void {
  if (blockedEventsPruneTimer) return;
  blockedEventsPruneTimer = setInterval(() => {
    void withDbAttribution("maintenance:rate-limit-blocked-events-prune", async () => {
      const cutoff = Date.now() - blockedEventsRetentionMs;
      const startedAt = Date.now();
      try {
        // Route the periodic prune through the shared on-demand helper so the
        // timer and `POST .../prune` exercise one literal code path (Task
        // #1129), and record the sweep result so the retention dashboard's
        // recent-sweeps panel (Task #1128) reflects every periodic run.
        const { deleted, durationMs, cutoff: usedCutoff } =
          await pruneBlockedRateLimitEventsNow();
        recordPruneSweep({
          timestamp: startedAt,
          cutoffTimestamp: usedCutoff,
          retentionMs: blockedEventsRetentionMs,
          rowsPruned: deleted,
          durationMs,
          trigger: "periodic",
        });
      } catch (err: any) {
        recordPruneSweep({
          timestamp: startedAt,
          cutoffTimestamp: cutoff,
          retentionMs: blockedEventsRetentionMs,
          rowsPruned: 0,
          durationMs: Date.now() - startedAt,
          trigger: "periodic",
          error: err?.message || String(err),
        });
        console.error("[RateLimit] Periodic blocked-event prune failed:", err.message);
      }
    });
  }, BLOCKED_EVENTS_PRUNE_INTERVAL_MS);
  if (typeof blockedEventsPruneTimer.unref === "function") {
    blockedEventsPruneTimer.unref();
  }
}

function getCategoryMetrics(category: string): CategoryMetrics {
  const categoryEvents = events.get(category) || [];
  const config = limiterConfigs.get(category);

  const ipCounts = new Map<string, number>();
  const userCounts = new Map<string, number>();
  for (const ev of categoryEvents) {
    ipCounts.set(ev.ip, (ipCounts.get(ev.ip) || 0) + 1);
    if (ev.userId) {
      userCounts.set(ev.userId, (userCounts.get(ev.userId) || 0) + 1);
    }
  }

  const topIPs = Array.from(ipCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_IPS_LIMIT)
    .map(([ip, count]) => ({ ip, count }));

  const topUsers = Array.from(userCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_USERS_LIMIT)
    .map(([userId, count]) => ({ userId, count }));

  const recentEvents = categoryEvents.slice(-20);

  const threshold = alertThresholds.get(category) ?? DEFAULT_WARNING_THRESHOLD;
  const totalBlocked = categoryEvents.length;

  return {
    totalBlocked,
    windowMs: config?.windowMs ?? 0,
    maxRequests: config?.max ?? 0,
    recentEvents,
    uniqueIPs: ipCounts.size,
    topIPs,
    uniqueUsers: userCounts.size,
    topUsers,
    alertThreshold: threshold,
    alertLevel: computeAlertLevel(totalBlocked, threshold),
    exempt: config?.exempt ?? false,
    tunerReadOnly: config?.tunerReadOnly ?? false,
    note: config?.note,
  };
}

export function getRateLimitSummary() {
  const categories: Record<string, CategoryMetrics> = {};
  let totalBlocked = 0;
  let alertCount = 0;

  const allCategories = new Set([...events.keys(), ...limiterConfigs.keys()]);
  for (const category of allCategories) {
    const metrics = getCategoryMetrics(category);
    categories[category] = metrics;
    totalBlocked += metrics.totalBlocked;
    if (metrics.alertLevel !== "none") alertCount++;
  }

  return {
    totalBlocked,
    categories,
    collectedSince: getOldestEventTimestamp(),
    alertCount,
  };
}

export function getRateLimitSummaryCompact() {
  const categories: Record<string, { totalBlocked: number; uniqueIPs: number; topIP: string | null }> = {};
  let totalBlocked = 0;

  const allCategories = new Set([...events.keys(), ...limiterConfigs.keys()]);
  for (const category of allCategories) {
    const metrics = getCategoryMetrics(category);
    totalBlocked += metrics.totalBlocked;
    categories[category] = {
      totalBlocked: metrics.totalBlocked,
      uniqueIPs: metrics.uniqueIPs,
      topIP: metrics.topIPs[0]?.ip ?? null,
    };
  }

  return { totalBlocked, categories };
}

export function getUserRateLimitBreakdown(): UserRateLimitMetrics[] {
  const userMap = new Map<string, { categories: Map<string, number>; events: RateLimitEvent[] }>();

  for (const [_category, categoryEvents] of events.entries()) {
    for (const ev of categoryEvents) {
      if (!ev.userId) continue;
      let entry = userMap.get(ev.userId);
      if (!entry) {
        entry = { categories: new Map(), events: [] };
        userMap.set(ev.userId, entry);
      }
      entry.categories.set(ev.category, (entry.categories.get(ev.category) || 0) + 1);
      entry.events.push(ev);
    }
  }

  const results: UserRateLimitMetrics[] = [];
  for (const [userId, data] of userMap.entries()) {
    const sortedEvents = data.events.sort((a, b) => a.timestamp - b.timestamp);
    results.push({
      userId,
      totalBlocked: data.events.length,
      categories: Object.fromEntries(data.categories),
      recentEvents: sortedEvents.slice(-10),
      firstSeen: sortedEvents[0].timestamp,
      lastSeen: sortedEvents[sortedEvents.length - 1].timestamp,
    });
  }

  return results.sort((a, b) => b.totalBlocked - a.totalBlocked);
}

export async function* iterateUserBlockedEvents(
  userId: string,
  rangeStart: number | null = null,
  rangeEnd: number | null = null,
): AsyncIterableIterator<RateLimitEvent> {
  const { iterateUserBlockedRateLimitEvents } = await import(
    "../storage/blockedRateLimitEventsStorage"
  );
  for await (const row of iterateUserBlockedRateLimitEvents(userId, rangeStart, rangeEnd)) {
    yield {
      ip: row.ip,
      userId: row.userId,
      path: row.path,
      method: row.method,
      category: row.category,
      timestamp: row.timestamp,
    };
  }
}

export interface UserTimeSeriesBucket {
  bucketStart: number;
  total: number;
  categories: Record<string, number>;
}

export interface UserTimeSeriesResponse {
  userId: string;
  intervalMs: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  categories: string[];
  buckets: UserTimeSeriesBucket[];
}

const ALLOWED_INTERVAL_MS = new Set<number>([
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]);
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TIMESERIES_BUCKETS = 2000;

export function isAllowedTimeSeriesInterval(intervalMs: number): boolean {
  return ALLOWED_INTERVAL_MS.has(intervalMs);
}

export function getAllowedTimeSeriesIntervals(): number[] {
  return Array.from(ALLOWED_INTERVAL_MS).sort((a, b) => a - b);
}

export function getUserTimeSeries(
  userId: string,
  intervalMs: number,
  rangeStartIn?: number | null,
  rangeEndIn?: number | null,
): UserTimeSeriesResponse {
  if (!Number.isFinite(intervalMs) || !ALLOWED_INTERVAL_MS.has(intervalMs)) {
    intervalMs = DEFAULT_INTERVAL_MS;
  }

  const hasRange =
    typeof rangeStartIn === "number" &&
    typeof rangeEndIn === "number" &&
    Number.isFinite(rangeStartIn) &&
    Number.isFinite(rangeEndIn) &&
    rangeEndIn > rangeStartIn;

  const userEvents: RateLimitEvent[] = [];
  for (const categoryEvents of events.values()) {
    for (const ev of categoryEvents) {
      if (ev.userId !== userId) continue;
      if (hasRange && (ev.timestamp < (rangeStartIn as number) || ev.timestamp > (rangeEndIn as number))) {
        continue;
      }
      userEvents.push(ev);
    }
  }

  if (userEvents.length === 0 && !hasRange) {
    return {
      userId,
      intervalMs,
      rangeStart: null,
      rangeEnd: null,
      categories: [],
      buckets: [],
    };
  }

  userEvents.sort((a, b) => a.timestamp - b.timestamp);
  const rangeStart = hasRange
    ? Math.floor((rangeStartIn as number) / intervalMs) * intervalMs
    : Math.floor(userEvents[0].timestamp / intervalMs) * intervalMs;
  const rangeEnd = hasRange
    ? Math.floor((rangeEndIn as number) / intervalMs) * intervalMs
    : Math.floor(userEvents[userEvents.length - 1].timestamp / intervalMs) * intervalMs;

  const categorySet = new Set<string>();
  const bucketMap = new Map<number, UserTimeSeriesBucket>();

  const projectedBuckets = Math.floor((rangeEnd - rangeStart) / intervalMs) + 1;
  if (projectedBuckets <= MAX_TIMESERIES_BUCKETS) {
    for (let t = rangeStart; t <= rangeEnd; t += intervalMs) {
      bucketMap.set(t, { bucketStart: t, total: 0, categories: {} });
    }
  }

  for (const ev of userEvents) {
    categorySet.add(ev.category);
    const bucketStart = Math.floor(ev.timestamp / intervalMs) * intervalMs;
    let bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      bucket = { bucketStart, total: 0, categories: {} };
      bucketMap.set(bucketStart, bucket);
    }
    bucket.total++;
    bucket.categories[ev.category] = (bucket.categories[ev.category] || 0) + 1;
  }

  const buckets = Array.from(bucketMap.values()).sort((a, b) => a.bucketStart - b.bucketStart);

  return {
    userId,
    intervalMs,
    rangeStart: userEvents.length === 0 && !hasRange ? null : rangeStart,
    rangeEnd: userEvents.length === 0 && !hasRange ? null : rangeEnd,
    categories: Array.from(categorySet).sort(),
    buckets,
  };
}

export interface IpTimeSeriesResponse {
  ip: string;
  intervalMs: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  categories: string[];
  buckets: UserTimeSeriesBucket[];
}

export function getIpTimeSeries(
  ip: string,
  intervalMs: number,
  rangeStartIn?: number | null,
  rangeEndIn?: number | null,
): IpTimeSeriesResponse {
  if (!Number.isFinite(intervalMs) || !ALLOWED_INTERVAL_MS.has(intervalMs)) {
    intervalMs = DEFAULT_INTERVAL_MS;
  }

  const hasRange =
    typeof rangeStartIn === "number" &&
    typeof rangeEndIn === "number" &&
    Number.isFinite(rangeStartIn) &&
    Number.isFinite(rangeEndIn) &&
    rangeEndIn > rangeStartIn;

  const ipEvents: RateLimitEvent[] = [];
  for (const categoryEvents of events.values()) {
    for (const ev of categoryEvents) {
      if (ev.userId || ev.ip !== ip) continue;
      if (hasRange && (ev.timestamp < (rangeStartIn as number) || ev.timestamp > (rangeEndIn as number))) {
        continue;
      }
      ipEvents.push(ev);
    }
  }

  if (ipEvents.length === 0 && !hasRange) {
    return {
      ip,
      intervalMs,
      rangeStart: null,
      rangeEnd: null,
      categories: [],
      buckets: [],
    };
  }

  ipEvents.sort((a, b) => a.timestamp - b.timestamp);
  const rangeStart = hasRange
    ? Math.floor((rangeStartIn as number) / intervalMs) * intervalMs
    : Math.floor(ipEvents[0].timestamp / intervalMs) * intervalMs;
  const rangeEnd = hasRange
    ? Math.floor((rangeEndIn as number) / intervalMs) * intervalMs
    : Math.floor(ipEvents[ipEvents.length - 1].timestamp / intervalMs) * intervalMs;

  const categorySet = new Set<string>();
  const bucketMap = new Map<number, UserTimeSeriesBucket>();

  const projectedBuckets = Math.floor((rangeEnd - rangeStart) / intervalMs) + 1;
  if (projectedBuckets <= MAX_TIMESERIES_BUCKETS) {
    for (let t = rangeStart; t <= rangeEnd; t += intervalMs) {
      bucketMap.set(t, { bucketStart: t, total: 0, categories: {} });
    }
  }

  for (const ev of ipEvents) {
    categorySet.add(ev.category);
    const bucketStart = Math.floor(ev.timestamp / intervalMs) * intervalMs;
    let bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      bucket = { bucketStart, total: 0, categories: {} };
      bucketMap.set(bucketStart, bucket);
    }
    bucket.total++;
    bucket.categories[ev.category] = (bucket.categories[ev.category] || 0) + 1;
  }

  const buckets = Array.from(bucketMap.values()).sort((a, b) => a.bucketStart - b.bucketStart);

  return {
    ip,
    intervalMs,
    rangeStart,
    rangeEnd,
    categories: Array.from(categorySet).sort(),
    buckets,
  };
}

export function getAnonymousRateLimitBreakdown() {
  const ipMap = new Map<string, { categories: Map<string, number>; count: number; lastSeen: number }>();

  for (const categoryEvents of events.values()) {
    for (const ev of categoryEvents) {
      if (ev.userId) continue;
      let entry = ipMap.get(ev.ip);
      if (!entry) {
        entry = { categories: new Map(), count: 0, lastSeen: 0 };
        ipMap.set(ev.ip, entry);
      }
      entry.categories.set(ev.category, (entry.categories.get(ev.category) || 0) + 1);
      entry.count++;
      if (ev.timestamp > entry.lastSeen) entry.lastSeen = ev.timestamp;
    }
  }

  return Array.from(ipMap.entries())
    .map(([ip, data]) => ({
      ip,
      totalBlocked: data.count,
      categories: Object.fromEntries(data.categories),
      lastSeen: data.lastSeen,
    }))
    .sort((a, b) => b.totalBlocked - a.totalBlocked);
}

function getOldestEventTimestamp(): number | null {
  let oldest: number | null = null;
  for (const categoryEvents of events.values()) {
    if (categoryEvents.length > 0) {
      const first = categoryEvents[0].timestamp;
      if (oldest === null || first < oldest) {
        oldest = first;
      }
    }
  }
  return oldest;
}

export function clearRateLimitMetrics(): void {
  events.clear();
  requestCounts.clear();
  userUsage.clear();
  activeAlerts.clear();
}

const DEFAULT_WARNING_PERCENT = 80;
const MIN_WARNING_PERCENT = 1;
const MAX_WARNING_PERCENT = 100;

interface UserUsageEntry {
  count: number;
  windowStart: number;
  alertedAt: number | null;
}

export interface UsageAlert {
  userId: string;
  category: string;
  count: number;
  max: number;
  warningPercent: number;
  windowStart: number;
  windowMs: number;
  triggeredAt: number;
}

const userUsage: Map<string, UserUsageEntry> = new Map();
const warningPercents: Map<string, number> = new Map();
const activeAlerts: Map<string, UsageAlert> = new Map();

function userUsageKey(category: string, userId: string): string {
  return `${category}:${userId}`;
}

export function setWarningPercent(category: string, percent: number): void {
  if (!Number.isFinite(percent) || percent < MIN_WARNING_PERCENT || percent > MAX_WARNING_PERCENT) {
    throw new Error(`warningPercent must be between ${MIN_WARNING_PERCENT} and ${MAX_WARNING_PERCENT}`);
  }
  warningPercents.set(category, percent);
}

export function getWarningPercents(): Record<string, number> {
  const result: Record<string, number> = {};
  const allCategories = new Set([...events.keys(), ...limiterConfigs.keys(), ...warningPercents.keys()]);
  for (const cat of allCategories) {
    result[cat] = warningPercents.get(cat) ?? DEFAULT_WARNING_PERCENT;
  }
  return result;
}

export function trackUserUsage(category: string, userId: string | null, roleMultiplier: number = 1): void {
  if (!userId) return;
  const config = limiterConfigs.get(category);
  if (!config || config.max <= 0) return;

  const effectiveMax = config.roleAware
    ? Math.max(1, Math.ceil(config.max * (roleMultiplier > 0 ? roleMultiplier : 1)))
    : config.max;

  const key = userUsageKey(category, userId);
  const now = Date.now();
  let entry = userUsage.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    entry = { count: 0, windowStart: now, alertedAt: null };
    userUsage.set(key, entry);
    activeAlerts.delete(key);
  }

  entry.count++;

  const percent = warningPercents.get(category) ?? DEFAULT_WARNING_PERCENT;
  const threshold = Math.max(1, Math.ceil((effectiveMax * percent) / 100));

  if (entry.count >= threshold && entry.alertedAt === null) {
    entry.alertedAt = now;
    const alert: UsageAlert = {
      userId,
      category,
      count: entry.count,
      max: effectiveMax,
      warningPercent: percent,
      windowStart: entry.windowStart,
      windowMs: config.windowMs,
      triggeredAt: now,
    };
    activeAlerts.set(key, alert);
    console.warn(
      `[RateLimit] WARNING — userId=${userId} category=${category} count=${entry.count}/${effectiveMax} (>=${percent}% threshold)`
    );
    import("./rateLimitAlertNotifier")
      .then(({ notifyRateLimitAlert }) => notifyRateLimitAlert(alert))
      .catch((err) => console.error("[RateLimit] Notifier dispatch failed:", err.message));
  } else if (entry.alertedAt !== null) {
    const existing = activeAlerts.get(key);
    if (existing) {
      existing.count = entry.count;
      existing.max = effectiveMax;
    }
  }
}

function pruneExpiredAlerts(): void {
  const now = Date.now();
  for (const [key, alert] of activeAlerts.entries()) {
    if (now - alert.windowStart >= alert.windowMs) {
      activeAlerts.delete(key);
      userUsage.delete(key);
    }
  }
}

export function getActiveUsageAlerts(): UsageAlert[] {
  pruneExpiredAlerts();
  return Array.from(activeAlerts.values()).sort((a, b) => b.triggeredAt - a.triggeredAt);
}

export function getUsageAlertForUser(category: string, userId: string): UsageAlert | null {
  pruneExpiredAlerts();
  return activeAlerts.get(userUsageKey(category, userId)) ?? null;
}

export function clearUsageAlerts(): void {
  activeAlerts.clear();
}

export interface BlockedIPEntry {
  ip: string;
  blockedAt: number;
  reason?: string;
  expiresAt?: number;
}

const blockedIPs: Map<string, BlockedIPEntry> = new Map();

import {
  listBlockedIps,
  insertBlockedIp,
  deleteBlockedIp,
  deleteExpiredBlockedIps,
  ensureBlockedIpsTable,
  updateBlockedIpExpiry,
} from "../storage/blockedIpsStorage";
import { dbRetry, withDbAttribution } from "../db";

let loadPromise: Promise<void> | null = null;

const MAX_BLOCK_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;
let expirySweepTimer: NodeJS.Timeout | null = null;

const DEFAULT_BLOCK_DURATION_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BLOCK_DURATION_SETTING_KEY = "rate_limit_default_block_duration_ms";
let defaultBlockDurationMs: number | null = DEFAULT_BLOCK_DURATION_FALLBACK_MS;
let defaultBlockDurationLoaded = false;

export function getDefaultBlockDurationMs(): number | null {
  return defaultBlockDurationMs;
}

export function getDefaultBlockDurationFallbackMs(): number {
  return DEFAULT_BLOCK_DURATION_FALLBACK_MS;
}

export async function loadDefaultBlockDurationFromDB(): Promise<void> {
  if (defaultBlockDurationLoaded) return;
  try {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    const row = await getSystemSetting(DEFAULT_BLOCK_DURATION_SETTING_KEY);
    if (row) {
      const raw = (row.value ?? "").trim();
      if (raw === "" || raw.toLowerCase() === "permanent" || raw.toLowerCase() === "null") {
        defaultBlockDurationMs = null;
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= MAX_BLOCK_DURATION_MS) {
          defaultBlockDurationMs = n;
        }
      }
    }
    defaultBlockDurationLoaded = true;
    console.info(
      `[IPBlock] Default block duration loaded: ${
        defaultBlockDurationMs == null ? "permanent" : `${defaultBlockDurationMs}ms`
      }`
    );
  } catch (err: any) {
    console.error("[IPBlock] Failed to load default block duration:", err.message);
  }
}

export async function setDefaultBlockDurationMs(
  value: number | null,
  updatedBy?: string
): Promise<number | null> {
  if (value !== null) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("durationMs must be a positive number or null for permanent");
    }
    if (value > MAX_BLOCK_DURATION_MS) {
      throw new Error(`durationMs cannot exceed ${MAX_BLOCK_DURATION_MS} (1 year)`);
    }
  }
  try {
    const { setSystemSetting } = await import("../storage/settingsStorage");
    await setSystemSetting(DEFAULT_BLOCK_DURATION_SETTING_KEY, value == null ? "" : String(value), updatedBy);
  } catch (err: any) {
    console.error("[IPBlock] Failed to persist default block duration:", err.message);
    throw err;
  }
  defaultBlockDurationMs = value;
  defaultBlockDurationLoaded = true;
  return defaultBlockDurationMs;
}

export async function loadBlockedIPsFromDB(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        await ensureBlockedIpsTable();
        const now = Date.now();
        try {
          // Task #813: wrap with dbRetry so a transient Neon recycle on
          // startup is absorbed instead of leaving stale rows behind.
          const purged = await dbRetry(
            () => deleteExpiredBlockedIps(now),
            "ipBlock.startupPurge",
          );
          if (purged.length > 0) {
            console.info(`[IPBlock] Purged ${purged.length} expired block(s) on startup`);
          }
        } catch (err: any) {
          console.error("[IPBlock] Startup expiry purge failed:", err.message);
        }
        const rows = await listBlockedIps();
        blockedIPs.clear();
        for (const row of rows) {
          if (row.expiresAt != null && row.expiresAt <= now) continue;
          blockedIPs.set(row.ip, {
            ip: row.ip,
            blockedAt: row.blockedAt,
            reason: row.reason ?? undefined,
            expiresAt: row.expiresAt ?? undefined,
          });
        }
        console.info(`[IPBlock] Loaded ${blockedIPs.size} active blocked IP(s) from database`);
        startBlockedIPExpirySweep();
      } catch (err: any) {
        console.error("[IPBlock] Failed to load blocked IPs from DB:", err.message);
      }
    })();
  }
  return loadPromise;
}

export function startBlockedIPExpirySweep(): void {
  if (expirySweepTimer) return;
  expirySweepTimer = setInterval(() => {
    void withDbAttribution("maintenance:rate-limit-blocked-ip-expiry", () =>
      sweepExpiredBlockedIPs().catch((err) => {
        console.error("[IPBlock] Expiry sweep failed:", err.message);
      }),
    );
  }, EXPIRY_SWEEP_INTERVAL_MS);
  if (typeof expirySweepTimer.unref === "function") expirySweepTimer.unref();
}

export function stopBlockedIPExpirySweep(): void {
  if (expirySweepTimer) {
    clearInterval(expirySweepTimer);
    expirySweepTimer = null;
  }
}

async function sweepExpiredBlockedIPs(): Promise<void> {
  const now = Date.now();
  const expiredInMemory: string[] = [];
  for (const [ip, entry] of blockedIPs.entries()) {
    if (entry.expiresAt != null && entry.expiresAt <= now) {
      expiredInMemory.push(ip);
    }
  }
  for (const ip of expiredInMemory) {
    blockedIPs.delete(ip);
  }
  try {
    // Task #813: wrap periodic sweep delete with dbRetry so transient
    // Neon connection recycles are absorbed and counted as recoveries
    // instead of incrementing dbFailures.
    const purged = await dbRetry(
      () => deleteExpiredBlockedIps(now),
      "ipBlock.sweep",
    );
    if (purged.length > 0 || expiredInMemory.length > 0) {
      console.info(`[IPBlock] Sweep removed ${purged.length} DB row(s), ${expiredInMemory.length} in-memory entry(ies)`);
    }
  } catch (err: any) {
    console.error("[IPBlock] DB expiry purge failed:", err.message);
  }
}

export async function blockIP(ip: string, reason?: string, durationMs?: number): Promise<boolean> {
  const existing = blockedIPs.get(ip);
  if (existing) {
    const now = Date.now();
    if (!evictIfExpired(ip, existing, now)) return false;
  }
  const blockedAt = Date.now();
  let expiresAt: number | null = null;
  if (durationMs != null) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("durationMs must be a positive number");
    }
    if (durationMs > MAX_BLOCK_DURATION_MS) {
      throw new Error(`durationMs cannot exceed ${MAX_BLOCK_DURATION_MS} (1 year)`);
    }
    expiresAt = blockedAt + durationMs;
  }
  const entry: BlockedIPEntry = {
    ip,
    blockedAt,
    reason,
    expiresAt: expiresAt ?? undefined,
  };
  try {
    await insertBlockedIp({ ip, blockedAt, reason: reason ?? null, expiresAt });
  } catch (err: any) {
    console.error(`[IPBlock] Failed to persist blocked IP ${ip}:`, err.message);
    throw err;
  }
  blockedIPs.set(ip, entry);
  const expiryNote = expiresAt ? ` expiresAt=${new Date(expiresAt).toISOString()}` : " (permanent)";
  console.warn(`[IPBlock] BLOCKED IP: ${ip} reason="${reason || "manual"}"${expiryNote}`);
  return true;
}

export type UpdateBlockExpiryResult = "updated" | "not_found";

export async function updateBlockExpiry(ip: string, durationMs: number | null): Promise<UpdateBlockExpiryResult> {
  const entry = blockedIPs.get(ip);
  if (!entry) return "not_found";
  const now = Date.now();
  if (entry.expiresAt != null && entry.expiresAt <= now) {
    evictIfExpired(ip, entry, now);
    return "not_found";
  }
  let expiresAt: number | null = null;
  if (durationMs != null) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("durationMs must be a positive number");
    }
    if (durationMs > MAX_BLOCK_DURATION_MS) {
      throw new Error(`durationMs cannot exceed ${MAX_BLOCK_DURATION_MS} (1 year)`);
    }
    expiresAt = now + durationMs;
  }
  try {
    const updated = await updateBlockedIpExpiry(ip, expiresAt);
    if (!updated) return "not_found";
  } catch (err: any) {
    console.error(`[IPBlock] Failed to update expiry for ${ip}:`, err.message);
    throw err;
  }
  entry.expiresAt = expiresAt ?? undefined;
  blockedIPs.set(ip, entry);
  const expiryNote = expiresAt ? ` expiresAt=${new Date(expiresAt).toISOString()}` : " (permanent)";
  console.info(`[IPBlock] UPDATED expiry for ${ip}${expiryNote}`);
  return "updated";
}

export async function unblockIP(ip: string): Promise<boolean> {
  if (!blockedIPs.has(ip)) return false;
  try {
    await deleteBlockedIp(ip);
  } catch (err: any) {
    console.error(`[IPBlock] Failed to remove blocked IP ${ip} from DB:`, err.message);
    throw err;
  }
  blockedIPs.delete(ip);
  console.info(`[IPBlock] UNBLOCKED IP: ${ip}`);
  return true;
}

function normalizeIPv4(ip: string): string | null {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  return null;
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipLong = ipv4ToLong(ip);
  const rangeLong = ipv4ToLong(range);
  if (ipLong === null || rangeLong === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (rangeLong & mask);
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip || typeof ip !== "string") return null;
  let addr = ip;
  // Handle embedded IPv4 (e.g. ::ffff:192.0.2.1 or 2001:db8::192.0.2.1)
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4 = addr.slice(lastColon + 1);
    const v4Long = ipv4ToLong(v4);
    if (v4Long === null) return null;
    const hi = (v4Long >>> 16) & 0xffff;
    const lo = v4Long & 0xffff;
    addr = addr.slice(0, lastColon + 1) + hi.toString(16) + ":" + lo.toString(16);
  }
  const doubleColonCount = (addr.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;
  let groups: string[];
  if (doubleColonCount === 1) {
    const [head, tail] = addr.split("::");
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return null;
    groups = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    groups = addr.split(":");
  }
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const ipBig = ipv6ToBigInt(ip);
  const rangeBig = ipv6ToBigInt(range);
  if (ipBig === null || rangeBig === null) return false;
  if (bits === 0) return true;
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (ipBig & mask) === (rangeBig & mask);
}

function isEntryActive(entry: BlockedIPEntry, now: number): boolean {
  return entry.expiresAt == null || entry.expiresAt > now;
}

function evictIfExpired(ip: string, entry: BlockedIPEntry, now: number): boolean {
  if (isEntryActive(entry, now)) return false;
  blockedIPs.delete(ip);
  deleteBlockedIp(ip).catch((err: any) => {
    console.error(`[IPBlock] Lazy expiry DB delete failed for ${ip}:`, err.message);
  });
  console.info(`[IPBlock] Lazily expired block: ${ip}`);
  return true;
}

export function isIPBlocked(ip: string): boolean {
  const now = Date.now();
  const direct = blockedIPs.get(ip);
  if (direct) {
    if (!evictIfExpired(ip, direct, now)) return true;
  }
  const ipv4 = normalizeIPv4(ip);
  for (const [key, entry] of blockedIPs.entries()) {
    if (!key.includes("/")) continue;
    if (evictIfExpired(key, entry, now)) continue;
    const slash = key.indexOf("/");
    const addr = key.slice(0, slash);
    if (addr.includes(":")) {
      if (ipv6InCidr(ip, key)) return true;
    } else if (ipv4) {
      if (ipv4InCidr(ipv4, key)) return true;
    }
  }
  return false;
}

export function getBlockedIPs(): BlockedIPEntry[] {
  const now = Date.now();
  for (const [ip, entry] of Array.from(blockedIPs.entries())) {
    evictIfExpired(ip, entry, now);
  }
  return Array.from(blockedIPs.values()).sort((a, b) => b.blockedAt - a.blockedAt);
}
