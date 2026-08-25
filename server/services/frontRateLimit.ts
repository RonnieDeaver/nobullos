/**
 * Task #2721 — Front live rate-limit header pacing.
 *
 * Front returns its standard per-company rate-limit budget on EVERY response
 * (verified against the public docs at https://dev.frontapp.com/docs/rate-limiting
 * on 2026-06-30):
 *
 *   - `x-ratelimit-limit`     — max requests allowed in the current window (int)
 *   - `x-ratelimit-remaining` — requests left in the current window (int)
 *   - `x-ratelimit-reset`     — when the window resets, as EPOCH SECONDS (int)
 *   - `Retry-After`           — RELATIVE seconds to wait, only on a 429
 *
 * The 429 / `Retry-After` retry path is the reactive safety net. This module is
 * the *proactive* one: by reading `x-ratelimit-remaining` after every page the
 * backfill (enumeration / search paging) can slow itself down BEFORE it hits a
 * 429, so an operator who sets an aggressive per-tick budget (Task #2714) can't
 * accidentally starve other Front API consumers in the same company.
 *
 * The helpers here are pure (no I/O) so the pacing math is unit-testable without
 * a network or a clock. They live in their own module — not in
 * `frontAnalyticsClient.ts` — so both that client AND `frontIntegration.ts` can
 * import them without creating an import cycle (the analytics client already
 * imports the OAuth token helper FROM the integration module).
 */

export interface FrontRateLimitSnapshot {
  /** `x-ratelimit-limit` — total requests allowed in the window, or null. */
  limit: number | null;
  /** `x-ratelimit-remaining` — requests left in the window, or null. */
  remaining: number | null;
  /** `x-ratelimit-reset` — window-reset time as EPOCH SECONDS, or null. */
  resetEpochSec: number | null;
}

/**
 * Begin self-pacing once the remaining budget drops to this fraction of the
 * advertised limit. Above it we run at full speed (no inter-page sleep); the
 * 429 path stays the only brake nobody can disable.
 */
export const RATE_LIMIT_PACING_THRESHOLD_FRACTION = 0.2;

/**
 * Absolute remaining-request floor used when `x-ratelimit-limit` is absent (so
 * we can't compute a fraction). Front's partner-OAuth budget is ~120 rpm, so a
 * floor of 20 leaves a comfortable safety margin before an actual 429.
 */
export const RATE_LIMIT_PACING_ABSOLUTE_FLOOR = 20;

/**
 * Hard cap on any single self-pace sleep so a bogus / far-future `reset` value
 * (or `remaining: 0` with no usable reset) can never wedge a worker tick. Keep
 * it aligned with the existing `POLL_MAX_DELAY_MS` brake (10s).
 */
export const RATE_LIMIT_PACING_MAX_DELAY_MS = 10_000;

/**
 * Gentle fixed delay used when the budget is low but we lack a usable
 * `x-ratelimit-reset` to spread the remaining requests over. Big enough to ease
 * pressure, small enough not to stall a healthy walk.
 */
export const RATE_LIMIT_PACING_FALLBACK_DELAY_MS = 1_000;

function parseHeaderInt(
  headers: Headers,
  name: string,
): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the standard Front rate-limit headers off a `Response`. Header names are
 * case-insensitive per the Fetch spec, so callers can pass either casing. Any
 * missing / non-numeric header becomes `null` (treated as "unknown" downstream,
 * which means "don't pace on it").
 */
export function parseFrontRateLimitHeaders(res: {
  headers: Headers;
}): FrontRateLimitSnapshot {
  return {
    limit: parseHeaderInt(res.headers, "x-ratelimit-limit"),
    remaining: parseHeaderInt(res.headers, "x-ratelimit-remaining"),
    resetEpochSec: parseHeaderInt(res.headers, "x-ratelimit-reset"),
  };
}

/**
 * Given the rate-limit snapshot observed on the LAST page and the current wall
 * clock, return how many milliseconds to sleep BEFORE the next page so the
 * backfill self-paces ahead of a 429.
 *
 * Behavior:
 *   - Unknown / missing `remaining`            → 0 (no headers ⇒ no change).
 *   - `remaining` above the low threshold      → 0 (plenty of budget, full speed).
 *   - `remaining === 0`                        → wait until the window resets
 *                                                (capped), or the cap if reset is
 *                                                unknown.
 *   - low `remaining` with a usable reset      → spread the remaining requests
 *                                                evenly across the time left in
 *                                                the window (`timeLeft/remaining`).
 *                                                As `remaining` shrinks the
 *                                                per-request delay GROWS — the
 *                                                auto-pace.
 *   - low `remaining` without a usable reset   → a small fixed fallback delay.
 *
 * Every branch is capped by `RATE_LIMIT_PACING_MAX_DELAY_MS`.
 */
export function computeRateLimitPaceMs(
  snapshot: FrontRateLimitSnapshot | null,
  nowMs: number,
): number {
  if (!snapshot) return 0;
  const { limit, remaining, resetEpochSec } = snapshot;
  if (remaining == null || !Number.isFinite(remaining) || remaining < 0) {
    return 0;
  }

  const threshold =
    limit != null && limit > 0
      ? Math.max(1, Math.floor(limit * RATE_LIMIT_PACING_THRESHOLD_FRACTION))
      : RATE_LIMIT_PACING_ABSOLUTE_FLOOR;

  // Plenty of budget left → run at full speed.
  if (remaining > threshold) return 0;

  const timeUntilResetMs =
    resetEpochSec != null && resetEpochSec > 0
      ? resetEpochSec * 1000 - nowMs
      : null;

  // Out of budget: wait for the window to reset (capped). If we have no usable
  // reset, fall back to the hard cap so we still yield meaningfully.
  if (remaining === 0) {
    const wait =
      timeUntilResetMs != null && timeUntilResetMs > 0
        ? timeUntilResetMs
        : RATE_LIMIT_PACING_MAX_DELAY_MS;
    return Math.min(wait, RATE_LIMIT_PACING_MAX_DELAY_MS);
  }

  // Low budget but the window is resetting now / unknown → a gentle nudge.
  if (timeUntilResetMs == null || timeUntilResetMs <= 0) {
    return Math.min(
      RATE_LIMIT_PACING_FALLBACK_DELAY_MS,
      RATE_LIMIT_PACING_MAX_DELAY_MS,
    );
  }

  // Spread the remaining requests evenly across the time left in the window so
  // the next request lands just as a slot frees up. Shrinking `remaining`
  // automatically grows the delay.
  const spreadMs = Math.ceil(timeUntilResetMs / remaining);
  return Math.min(spreadMs, RATE_LIMIT_PACING_MAX_DELAY_MS);
}
