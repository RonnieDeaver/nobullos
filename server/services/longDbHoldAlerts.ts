/**
 * Task #1731 (Pool epic Phase 4, spec 4.3) — DB hold duration runtime guard.
 *
 * Two-tier guard on top of the existing `InstrumentedPool.logHoldDuration`
 * (`server/db.ts`). The existing path already warns when a hold exceeds
 * `PERF.DB_HOLD_WARN_MS` (default 1s) — Phase 4 layers two stricter tiers
 * on top of that:
 *
 *   - `WARN_THRESHOLD_MS`  (default 10s) → structured warn-level log with
 *     `{pool, label, durationMs, callerLabel, requestId}` so the noisy 1s
 *     warning stays an operational signal and the 10s+ band is the one we
 *     point at when triaging long holds.
 *   - `CRITICAL_THRESHOLD_MS` (default 30s) → high-severity Slack signal
 *     (notification id `infra.database.hold_duration_critical`, routed
 *     through the existing `notifyByType` dispatcher / queue-health
 *     channel) plus a ring-buffer entry surfaced on
 *     `/admin/db-attribution/trends` "Active alerts" panel.
 *
 * Exception allowlist (`EXCEPTION_PREFIXES`) explicitly documents holds
 * that are EXPECTED to run long and therefore must NOT trip the guard.
 * Adding a new exception requires the per-entry justification block right
 * next to the prefix — see the inline comments. Anything not listed here
 * counts as an unexpected long hold.
 *
 * All signals are best-effort and never throw. The hot path
 * (`InstrumentedPool.logHoldDuration` → `recordDbHoldDuration`) does
 * synchronous bookkeeping only; Slack dispatch is fire-and-forget on the
 * next microtask so the pool-release path stays unblocked.
 */
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

export const NOTIFICATION_ID = "infra.database.hold_duration_critical";

export const WARN_THRESHOLD_MS = 10_000;
export const CRITICAL_THRESHOLD_MS = 30_000;

/**
 * Per-(pool,label) cooldown for the Slack critical signal. Without this a
 * single stuck connection can fan out into hundreds of pages while the
 * underlying issue is being investigated.
 */
const SLACK_COOLDOWN_MS = 5 * 60_000;

/**
 * Ring buffer of recent ≥10s holds surfaced on the admin trends panel.
 * Keeps both `warn` and `critical` tiers so operators can see the warning
 * stream that preceded any critical page.
 */
const RECENT_BUFFER_CAP = 200;

/**
 * Exception allowlist — labels matching one of these prefixes (`label`
 * starts with prefix) are EXPECTED to run long and skip both the warn and
 * critical tiers. Every entry must document:
 *   1. Why this hold legitimately runs ≥10s.
 *   2. Expected upper bound.
 *   3. Owner / re-review date.
 *
 * Anything not listed here is treated as an unexpected long hold.
 */
export interface LongHoldException {
  /** `label` is matched via `label === prefix || label.startsWith(prefix + ":")`. */
  prefix: string;
  reason: string;
  expectedMaxMs: number;
  owner: string;
  reviewDate: string;
}

export const EXCEPTION_PREFIXES: LongHoldException[] = [
  {
    // The probe pool's intentional latency measurement: `healthProbe.ts`
    // times the SELECT-1 wall-clock to detect Neon cold starts. When the
    // wire latency itself spikes we WANT the metric to record it — the
    // probe is the canary, not the offender.
    prefix: "probe",
    reason: "Probe pool intentionally measures wire-level acquire latency.",
    expectedMaxMs: 60_000,
    owner: "platform",
    reviewDate: "2026-11-01",
  },
  {
    // Phase 1.5 audit/rollup flusher. The rollup query aggregates 24h of
    // pool samples into the daily rollup table with a single CTE; on a
    // catch-up tick after a deploy it can scan a few hundred thousand
    // rows. Bounded by the per-tick row cap inside `poolAuditRollups.ts`.
    prefix: "maintenance:pool-audit-rollup",
    reason: "Daily rollup CTE over up to 24h of pool/audit samples.",
    expectedMaxMs: 60_000,
    owner: "platform",
    reviewDate: "2026-11-01",
  },
];

export function isLongHoldException(label: string): LongHoldException | null {
  for (const ex of EXCEPTION_PREFIXES) {
    if (label === ex.prefix || label.startsWith(`${ex.prefix}:`)) return ex;
  }
  return null;
}

export type LongHoldTier = "warn" | "critical";

export interface LongHoldEvent {
  pool: string;
  label: string;
  durationMs: number;
  tier: LongHoldTier;
  observedAt: number;
  callerLabel: string | null;
  requestId: string | null;
}

const recentEvents: LongHoldEvent[] = [];
const lastCriticalAt = new Map<string, number>();

const counters = {
  warn: 0,
  critical: 0,
  exceptionSuppressed: 0,
  slackDispatched: 0,
  slackSuppressedCooldown: 0,
  slackSuppressedDisabled: 0,
  slackFailed: 0,
};

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let exceptionOverride: LongHoldException[] | null = null;
let killSwitchOverride: (() => boolean) | null = null;

function lookupException(label: string): LongHoldException | null {
  const list = exceptionOverride ?? EXCEPTION_PREFIXES;
  for (const ex of list) {
    if (label === ex.prefix || label.startsWith(`${ex.prefix}:`)) return ex;
  }
  return null;
}

function killSwitchEnabled(): boolean {
  if (killSwitchOverride) return killSwitchOverride();
  // Reuse the existing Phase 0 rollup switch so operators can silence the
  // new Slack signal with the same flip that already disables the
  // observability surface it depends on (`db_hold_rollup_enabled`).
  return isPoolEpicSwitchEnabled("db_hold_rollup_enabled");
}

function pushRecent(ev: LongHoldEvent): void {
  recentEvents.push(ev);
  if (recentEvents.length > RECENT_BUFFER_CAP) {
    recentEvents.splice(0, recentEvents.length - RECENT_BUFFER_CAP);
  }
}

function buildSlackText(ev: LongHoldEvent): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const link = `${base.replace(/\/$/, "")}/admin/db-attribution/trends`;
  const seconds = (ev.durationMs / 1000).toFixed(1);
  const caller = ev.callerLabel ? `\n• Caller: \`${ev.callerLabel}\`` : "";
  const reqId = ev.requestId ? `\n• Request: \`${ev.requestId}\`` : "";
  return [
    `:rotating_light: *DB connection held ${seconds}s on \`${ev.pool}\`* — \`${ev.label}\``,
    `• Threshold: ${(CRITICAL_THRESHOLD_MS / 1000).toFixed(0)}s (critical)${caller}${reqId}`,
    `• Trends panel: ${link}`,
  ].join("\n");
}

async function dispatch(ev: LongHoldEvent): Promise<void> {
  if (!killSwitchEnabled()) {
    counters.slackSuppressedDisabled += 1;
    return;
  }
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const text = buildSlackText(ev);
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          pool: ev.pool,
          label: ev.label,
          durationMs: ev.durationMs,
          tier: ev.tier,
          callerLabel: ev.callerLabel,
          requestId: ev.requestId,
          observedAt: ev.observedAt,
        },
      },
    );
    if (r.delivered) counters.slackDispatched += 1;
    else counters.slackFailed += 1;
  } catch (err: any) {
    counters.slackFailed += 1;
    console.warn(
      `[LongDbHoldAlerts] dispatch failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Called from `InstrumentedPool.logHoldDuration` for every hold whose
 * elapsed duration exceeds the existing warn threshold. Returns a
 * description of the action taken (mostly for tests).
 */
export interface RecordResult {
  tier: LongHoldTier | null;
  suppressedReason?: "below_threshold" | "exception" | "cooldown" | "disabled";
  exception?: LongHoldException;
}

export function recordDbHoldDuration(args: {
  pool: string;
  label: string;
  durationMs: number;
  callerLabel?: string | null;
  requestId?: string | null;
  now?: number;
}): RecordResult {
  const { pool, label, durationMs } = args;
  const now = args.now ?? Date.now();
  if (durationMs < WARN_THRESHOLD_MS) {
    return { tier: null, suppressedReason: "below_threshold" };
  }

  const exception = lookupException(label);
  if (exception) {
    counters.exceptionSuppressed += 1;
    return { tier: null, suppressedReason: "exception", exception };
  }

  const tier: LongHoldTier =
    durationMs >= CRITICAL_THRESHOLD_MS ? "critical" : "warn";
  const ev: LongHoldEvent = {
    pool,
    label,
    durationMs,
    tier,
    observedAt: now,
    callerLabel: args.callerLabel ?? null,
    requestId: args.requestId ?? null,
  };
  pushRecent(ev);

  if (tier === "warn") {
    counters.warn += 1;
    console.warn(
      `[DB Pool] long_hold_warn ${JSON.stringify({
        pool,
        label,
        duration_ms: durationMs,
        caller: ev.callerLabel,
        request_id: ev.requestId,
        threshold_ms: WARN_THRESHOLD_MS,
      })}`,
    );
    return { tier };
  }

  counters.critical += 1;
  console.error(
    `[DB Pool] long_hold_critical ${JSON.stringify({
      pool,
      label,
      duration_ms: durationMs,
      caller: ev.callerLabel,
      request_id: ev.requestId,
      threshold_ms: CRITICAL_THRESHOLD_MS,
    })}`,
  );

  const cooldownKey = `${pool}|${label}`;
  const lastAt = lastCriticalAt.get(cooldownKey) ?? 0;
  if (now - lastAt < SLACK_COOLDOWN_MS) {
    counters.slackSuppressedCooldown += 1;
    return { tier, suppressedReason: "cooldown" };
  }
  lastCriticalAt.set(cooldownKey, now);
  // Fire-and-forget — never block the pool release path on Slack I/O.
  void dispatch(ev);
  return { tier };
}

export function getRecentLongHolds(limit = 50): LongHoldEvent[] {
  const out = recentEvents.slice(-limit).reverse();
  return out;
}

export function getActiveLongHoldAlerts(windowMs = 15 * 60_000): LongHoldEvent[] {
  const cutoff = Date.now() - windowMs;
  return recentEvents.filter((e) => e.observedAt >= cutoff && e.tier === "critical").reverse();
}

export function getLongHoldCounters(): typeof counters {
  return { ...counters };
}

export const __testHelpers = {
  resetState(): void {
    recentEvents.length = 0;
    lastCriticalAt.clear();
    for (const k of Object.keys(counters) as (keyof typeof counters)[]) {
      counters[k] = 0;
    }
    dispatcherOverride = null;
    exceptionOverride = null;
    killSwitchOverride = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setExceptionsForTests(list: LongHoldException[] | null): void {
    exceptionOverride = list;
  },
  setKillSwitchForTests(fn: (() => boolean) | null): void {
    killSwitchOverride = fn;
  },
  COOLDOWN_MS: SLACK_COOLDOWN_MS,
  BUFFER_CAP: RECENT_BUFFER_CAP,
};
