/**
 * SEMrush upstream circuit breaker (Task #953 / #945B).
 *
 * Wraps SEMrush API calls with a rolling-window failure tracker so that a
 * collapsed upstream (timeouts, repeated 5xx, exhausted 429 retries) stops
 * driving continuous refresh / enrichment pressure into the `ingestion`
 * workload class. Manual operator-triggered refreshes always go through
 * (treated as recovery probes); background scheduled work is short-circuited
 * with a clear "deferred due to upstream collapse" log line.
 *
 * State machine:
 *   closed      → normal operation; record every outcome.
 *   open        → upstream considered down; background calls are skipped
 *                 with `allowed=false`. Cooldown grows with each consecutive
 *                 failed probe up to a bounded ceiling.
 *   half_open   → cooldown elapsed; the *next* request is admitted as a
 *                 probe (manual or background). On success → closed; on
 *                 failure → back to open with extended cooldown.
 *
 * The breaker is intentionally process-local and in-memory: it is a
 * pressure regulator, not a system-of-record. Each replica makes its own
 * decision based on what it observed.
 */

import { PERF } from "../perfConfig";

type Outcome = "success" | "rate_limit" | "timeout" | "auth" | "other";
type State = "closed" | "open" | "half_open";

interface Sample {
  ts: number;
  outcome: Outcome;
}

const samples: Sample[] = [];
let state: State = "closed";
let openedAt = 0;
let cooldownMs = 0;
let consecutiveOpenCycles = 0;
let lastTransitionLogAt = 0;

// Task #953 (review fix): bounded recovery probes. When the breaker is
// half_open, we admit at most `MAX_HALF_OPEN_PROBES` request(s) before
// the first outcome lands. Without this guard, a queue of refresh jobs
// or a full enrichment sweep could fan out the moment cooldown elapsed
// and re-saturate the ingestion class — defeating the purpose of the
// breaker.
const MAX_HALF_OPEN_PROBES = 1;
let halfOpenProbesRemaining = 0;
let halfOpenedAt = 0;
// Safety: if a probe never produces an outcome (e.g. a hung handler
// that exits without recording), force the breaker back to open after
// this much time so we don't get stuck admitting nothing.
const HALF_OPEN_PROBE_DEADLINE_MS = 90_000;

// Per-campaign backoff: a campaign that just failed should not be
// immediately retried by the next background sweep. Manual triggers
// bypass this map.
// Task #2897 (Reserved VM memory audit) — keyed by SEMrush campaign id
// and entries were only deleted on success, so a deleted/abandoned
// campaign's entry lived until restart. Expired entries are now pruned on
// every write (their absence is behavior-identical: an expired backoff
// admits the campaign either way).
const campaignBackoffUntil = new Map<string, number>();

function setCampaignBackoff(campaignId: string, until: number): void {
  const now = nowMs();
  for (const [id, ts] of campaignBackoffUntil) {
    if (ts <= now) campaignBackoffUntil.delete(id);
  }
  campaignBackoffUntil.set(campaignId, until);
}

function nowMs(): number {
  return Date.now();
}

function pruneSamples(now: number): void {
  const windowMs = PERF.SEMRUSH_BREAKER_WINDOW_MS;
  const cutoff = now - windowMs;
  while (samples.length > 0 && samples[0].ts < cutoff) {
    samples.shift();
  }
}

function logTransition(next: State, reason: string, extra: Record<string, unknown> = {}): void {
  const now = nowMs();
  // Coalesce identical transitions within 5s to keep logs readable; always
  // log when the state actually changes.
  if (state === next && now - lastTransitionLogAt < 5_000) return;
  lastTransitionLogAt = now;
  console.warn(
    `[Semrush][CircuitBreaker] state=${next} reason=${reason} ${Object.entries(extra)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ")}`,
  );
}

function transitionToOpen(reason: string, extra: Record<string, unknown> = {}): void {
  consecutiveOpenCycles += 1;
  const baseCooldown = PERF.SEMRUSH_BREAKER_COOLDOWN_MS;
  const maxCooldown = PERF.SEMRUSH_BREAKER_MAX_COOLDOWN_MS;
  cooldownMs = Math.min(baseCooldown * Math.pow(2, consecutiveOpenCycles - 1), maxCooldown);
  openedAt = nowMs();
  state = "open";
  logTransition("open", reason, { cooldownMs, consecutiveOpenCycles, ...extra });
}

function transitionToClosed(reason: string): void {
  state = "closed";
  cooldownMs = 0;
  consecutiveOpenCycles = 0;
  openedAt = 0;
  // Drop accumulated failure samples so a freshly-recovered upstream
  // isn't immediately re-tripped by stale history.
  samples.length = 0;
  logTransition("closed", reason);
}

function transitionToHalfOpen(reason: string): void {
  state = "half_open";
  halfOpenProbesRemaining = MAX_HALF_OPEN_PROBES;
  halfOpenedAt = nowMs();
  logTransition("half_open", reason, { probeBudget: MAX_HALF_OPEN_PROBES });
}

function evaluateOpenIfNeeded(): void {
  if (state !== "closed") return;
  const now = nowMs();
  pruneSamples(now);
  const minSamples = PERF.SEMRUSH_BREAKER_MIN_SAMPLES;
  if (samples.length < minSamples) return;
  const failures = samples.filter((s) => s.outcome !== "success").length;
  const failureRate = failures / samples.length;
  const threshold = PERF.SEMRUSH_BREAKER_FAILURE_THRESHOLD;
  if (failureRate >= threshold) {
    transitionToOpen("failure_rate_collapsed", {
      failureRate: Number(failureRate.toFixed(2)),
      samples: samples.length,
      threshold,
    });
  }
}

function maybeAdvanceFromOpen(): void {
  if (state === "open" && nowMs() - openedAt >= cooldownMs) {
    transitionToHalfOpen("cooldown_elapsed");
    return;
  }
  // Safety net: if a half_open probe never resolves and the deadline
  // elapses, force the breaker back to open so cooldown can elapse
  // again rather than admitting another probe burst.
  if (
    state === "half_open" &&
    halfOpenProbesRemaining < MAX_HALF_OPEN_PROBES &&
    nowMs() - halfOpenedAt >= HALF_OPEN_PROBE_DEADLINE_MS
  ) {
    transitionToOpen("probe_deadline_elapsed");
  }
}

export interface ShouldAllowOpts {
  /**
   * `true` when the request comes from an operator-initiated UI action.
   * Manual calls bypass the open-state skip and act as forced recovery
   * probes — but their outcome still feeds the breaker.
   */
  isManual?: boolean;
  /** Optional campaign id; used for per-campaign backoff. */
  campaignId?: string;
  /** Caller name for logs (e.g. "background_refresh", "report_refresh"). */
  caller?: string;
}

export interface AllowDecision {
  allowed: boolean;
  /** Reason a call was blocked. Undefined when allowed. */
  reason?: "circuit_open" | "campaign_backoff";
  state: State;
  retryAfterMs?: number;
}

export function shouldAllowRequest(opts: ShouldAllowOpts = {}): AllowDecision {
  maybeAdvanceFromOpen();

  if (opts.campaignId && !opts.isManual) {
    const until = campaignBackoffUntil.get(opts.campaignId);
    if (until && until > nowMs()) {
      return {
        allowed: false,
        reason: "campaign_backoff",
        state,
        retryAfterMs: until - nowMs(),
      };
    }
  }

  if (state === "open") {
    if (opts.isManual) {
      // Manual operator action — admit as a forced probe.
      transitionToHalfOpen("manual_probe");
      halfOpenProbesRemaining = Math.max(0, halfOpenProbesRemaining - 1);
      return { allowed: true, state };
    }
    return {
      allowed: false,
      reason: "circuit_open",
      state,
      retryAfterMs: Math.max(0, cooldownMs - (nowMs() - openedAt)),
    };
  }

  if (state === "half_open") {
    if (halfOpenProbesRemaining <= 0) {
      // Probe budget already consumed — block further admissions until
      // an outcome lands and we either close or re-open the breaker.
      return {
        allowed: false,
        reason: "circuit_open",
        state,
        retryAfterMs: Math.max(0, HALF_OPEN_PROBE_DEADLINE_MS - (nowMs() - halfOpenedAt)),
      };
    }
    halfOpenProbesRemaining -= 1;
    return { allowed: true, state };
  }

  // closed admits the request.
  return { allowed: true, state };
}

export function recordSuccess(opts: { campaignId?: string } = {}): void {
  const now = nowMs();
  samples.push({ ts: now, outcome: "success" });
  pruneSamples(now);
  if (opts.campaignId) campaignBackoffUntil.delete(opts.campaignId);

  if (state === "half_open") {
    transitionToClosed("probe_succeeded");
  }
}

export function recordFailure(outcome: Exclude<Outcome, "success">, opts: { campaignId?: string } = {}): void {
  const now = nowMs();
  samples.push({ ts: now, outcome });
  pruneSamples(now);

  if (opts.campaignId) {
    setCampaignBackoff(opts.campaignId, now + PERF.SEMRUSH_CAMPAIGN_BACKOFF_MS);
  }

  if (state === "half_open") {
    // Probe failed — re-open with extended cooldown.
    transitionToOpen("probe_failed", { outcome });
    return;
  }
  evaluateOpenIfNeeded();
}

/**
 * Tag a campaign for backoff WITHOUT pushing a new sample into the
 * breaker's rolling window. Use this in callers that catch an error
 * already recorded by a lower layer (e.g. `apiGet`) so we don't
 * double-count the same upstream failure and prematurely trip the
 * breaker.
 */
export function markCampaignBackoff(campaignId: string): void {
  if (!campaignId) return;
  setCampaignBackoff(campaignId, nowMs() + PERF.SEMRUSH_CAMPAIGN_BACKOFF_MS);
}

/** Classify a thrown error into a breaker outcome. */
export function classifyError(err: any): Exclude<Outcome, "success"> {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (name === "SemrushRateLimitError" || /\b429\b|rate.?limit/i.test(msg)) return "rate_limit";
  if (/timed out|timeout|ETIMEDOUT|ECONNRESET|connection terminated/i.test(msg)) return "timeout";
  if (/401|unauthor|token|re-?authorize/i.test(msg)) return "auth";
  return "other";
}

/** Diagnostics for logs / future health endpoints. */
export function getBreakerStatus(): {
  state: State;
  samples: number;
  failureRate: number;
  cooldownMs: number;
  openedAt: number;
  consecutiveOpenCycles: number;
  campaignBackoffCount: number;
} {
  pruneSamples(nowMs());
  const failures = samples.filter((s) => s.outcome !== "success").length;
  const failureRate = samples.length === 0 ? 0 : failures / samples.length;
  return {
    state,
    samples: samples.length,
    failureRate: Number(failureRate.toFixed(2)),
    cooldownMs,
    openedAt,
    consecutiveOpenCycles,
    campaignBackoffCount: campaignBackoffUntil.size,
  };
}

/** Test/debug helper — fully reset internal state. */
export function __resetBreakerForTests(): void {
  samples.length = 0;
  state = "closed";
  openedAt = 0;
  cooldownMs = 0;
  consecutiveOpenCycles = 0;
  lastTransitionLogAt = 0;
  halfOpenProbesRemaining = 0;
  halfOpenedAt = 0;
  campaignBackoffUntil.clear();
}
