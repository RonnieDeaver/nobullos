/**
 * Task #1975 — Shared single-flight OAuth refresh helper.
 *
 * Background: every integration that holds an OAuth2 refresh token
 * (Front, Zoom, Google Ads, SEMrush, Google Drive, Google Calendar)
 * has historically rolled its own refresh path. When a second caller
 * tries to refresh while a first refresh is in flight — common during
 * a startup burst or any time the access token expires while multiple
 * worker queues are draining — both callers POST to the token endpoint
 * with the SAME captured refresh token. Providers that rotate refresh
 * tokens on every refresh (Front, Zoom, Google) consume the captured
 * token on the winner's POST; the loser's POST then comes back 4xx
 * with `invalid_grant` / `invalid_request`. The loser previously
 * misclassified that as a permanent failure, sometimes WIPING stored
 * tokens (SEMrush) and flipping the Integrations Hub badge to
 * "Disconnected" even though the connection was healthy.
 *
 * This helper extracts the same per-process single-flight + re-read-
 * and-retry pattern Front established (Task #1869) so every integration
 * gets the same protection by construction. The single-flight key is
 * the integration name; concurrent callers for the same integration
 * collapse onto one in-flight POST. When the first refresh attempt
 * fails with a terminal classification, we re-read the stored refresh
 * token; if it has rotated (i.e. another process won the race), we
 * retry ONCE with the freshly-stored value before declaring the
 * connection dead.
 *
 * Contract for callers:
 *
 *   - `refreshOnce(ctx)` MUST throw `OAuthRefreshError` to communicate
 *     classification. Any other thrown value is treated as `transient`.
 *   - `readRefreshToken()` is called twice per refresh in the worst
 *     case (initial capture + post-failure re-read). It must read from
 *     authoritative storage (system_settings, encrypted credentials,
 *     etc.) NOT a memoized in-memory value, or the re-read-and-retry
 *     loses its meaning.
 *   - `onTerminalAfterRetry` is invoked only after the re-read-retry
 *     path either was not available (no token rotation observed) or
 *     also failed with a terminal classification. This is the correct
 *     place to wipe stored credentials — never wipe inside `refreshOnce`,
 *     or a cross-process race will wipe a connection another instance
 *     just rotated successfully.
 */

export type OAuthRefreshOutcome = "terminal" | "transient";

/**
 * Task #2267 (generalizes SEMrush Task #2265) — refresh "purposes" whose
 * terminal outcome must NEVER commit a durable disconnect (wipe stored
 * tokens, write `status: "disconnected"`, or engage a self-heal auth
 * gate). A background health-check probe or a pre-expiry proactive
 * top-up is observational: when it loses a refresh-token rotation race it
 * 4xx's on a captured-but-already-consumed token. That must surface to
 * the caller as `unauthorized` / `probe_failed` WITHOUT poisoning a
 * connection another instance may have just rotated to a healthy token.
 *
 * Only an authoritative, on-demand refresh (default purpose — a real API
 * call needs a token, or a 401 recovery) that re-read the freshest stored
 * refresh token inside the single-flight helper and STILL failed
 * terminally is allowed to commit the disconnect.
 *
 * The predicate treats an unset purpose as authoritative (the safe
 * default for the many real call sites that never pass one) and treats
 * any purpose naming a `probe` or `proactive` refresh as
 * non-authoritative — so integration-specific names like `front_probe`
 * or `zoom_probe` are covered without each caller re-deriving the set.
 */
export const NON_AUTHORITATIVE_REFRESH_PURPOSES: ReadonlySet<string> =
  new Set<string>(["probe", "proactive"]);

export function isAuthoritativeRefreshPurpose(purpose?: string): boolean {
  if (!purpose) return true;
  if (NON_AUTHORITATIVE_REFRESH_PURPOSES.has(purpose)) return false;
  return !/(?:^|[_-])(?:probe|proactive)(?:$|[_-])/i.test(purpose);
}

/**
 * Typed error that `refreshOnce` callbacks throw to classify a refresh
 * failure. The helper only honors classification carried on this class —
 * other thrown errors are treated as `transient` by default.
 */
export class OAuthRefreshError extends Error {
  readonly integration: string;
  readonly outcome: OAuthRefreshOutcome;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    integration: string,
    outcome: OAuthRefreshOutcome,
    message: string,
    opts?: { status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "OAuthRefreshError";
    this.integration = integration;
    this.outcome = outcome;
    this.status = opts?.status;
    this.cause = opts?.cause;
  }
}

export interface OAuthRefreshContext {
  /** Refresh token captured for this attempt. */
  refreshToken: string;
  /** 1 = initial capture, 2 = re-read-and-retry. */
  attempt: 1 | 2;
}

export interface OAuthRefreshOptions<T> {
  /** Integration key — used as the log tag and the BASE of the
   * single-flight map key / cross-process lease key. */
  integration: string;
  /**
   * Optional per-subject key for PER-USER OAuth integrations (e.g. Google
   * Calendar, where each user holds their own rotating refresh token).
   * When set, the in-process single-flight slot AND the cross-process
   * lease are keyed by `<integration>:<subjectKey>` (lease key
   * `oauth_refresh_lease:<integration>:<subjectKey>`), so two refreshes
   * for DIFFERENT subjects run concurrently while two for the SAME subject
   * serialize. Absent (system-scoped integrations like Front/Zoom/Google
   * Ads/SEMrush) the key is just `integration`, preserving prior behavior.
   */
  subjectKey?: string;
  /** Optional purpose string for diagnostics (e.g. `"expiry"`, `"forced"`, `"401_retry"`). */
  purpose?: string;
  /** Read the currently-stored refresh token from authoritative storage. */
  readRefreshToken: () => Promise<string | null | undefined>;
  /** Perform the actual token POST + storage write. Throw `OAuthRefreshError` to classify failures. */
  refreshOnce: (ctx: OAuthRefreshContext) => Promise<T>;
  /**
   * Invoked exactly once after a terminal classification persists past
   * the re-read-and-retry path (or no token rotation was observed).
   * Use this to wipe stored credentials. NEVER wipe inside `refreshOnce`
   * — a cross-process race will wipe a connection another instance just
   * rotated successfully.
   */
  onTerminalAfterRetry?: (err: unknown) => Promise<void>;
  /**
   * Task #2289 — cross-process refresh lease. When provided, after this
   * process wins the in-process single-flight it ALSO acquires a
   * distributed lease (one holder at a time across every instance +
   * the workspace) before touching the network. This serializes the N
   * autoscale instances so a loser never POSTs a refresh token a sibling
   * just consumed during Front's last-24h rotation window. The lease is
   * released in `finally`. Acquire degrades to `null` (in-process-only)
   * on contention/DB error so a refresh is never blocked by lease infra.
   */
  crossProcessLease?: import("./oauthRefreshLease").OAuthCrossProcessLease;
  /**
   * Task #2289 — optional fast-path recheck run AFTER the cross-process
   * lease is held. If a sibling instance refreshed while we were waiting
   * for the lease, the freshly-stored access token is already valid and a
   * second POST is wasteful (and, mid-rotation, risky). Return the now-
   * valid value to short-circuit and skip the POST entirely; return
   * `null`/`undefined` to proceed with the refresh. Errors here are
   * swallowed (treated as "proceed").
   */
  onLeaseAcquiredRecheck?: () => Promise<T | null | undefined>;
  /**
   * Task #2435 — bounded wait-and-re-read before a terminal refresh
   * failure is declared a true death.
   *
   * The plain re-read-and-retry above only fires when the stored refresh
   * token has ALREADY rotated. But in the narrow window where this process
   * lost a cross-process rotation race and re-read the stored token BEFORE
   * the winning sibling persisted the freshly-rotated one, the first
   * re-read still equals the captured (now-consumed) token — so the retry
   * can't fire and we'd surface a permanent-looking death for a connection
   * that self-heals milliseconds later. When set, poll the stored token a
   * few more times with a short delay; if it rotates within the bounded
   * window, retry with the fresh token instead of declaring terminal.
   *
   * Absent (the default for every other integration), behavior is
   * unchanged: exactly one immediate re-read. A true revocation — where no
   * sibling ever persists a rotated token — still exhausts the window and
   * declares the death, so this never masks a real outage.
   */
  terminalRotationRecheck?: {
    /** Extra re-reads after the first immediate one. */
    attempts: number;
    /** Delay between re-reads, in milliseconds. */
    delayMs: number;
  };
  /**
   * Test seam — overrides the delay between recheck re-reads. Production
   * leaves this unset and uses a real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * The key used for BOTH the in-process single-flight slot and the
 * cross-process lease. For per-user integrations (subjectKey set) this is
 * `<integration>:<subjectKey>` so distinct subjects never collapse onto one
 * slot/lease; for system-scoped integrations it is just `integration`.
 */
function scopedKey<T>(opts: OAuthRefreshOptions<T>): string {
  return opts.subjectKey ? `${opts.integration}:${opts.subjectKey}` : opts.integration;
}

function tag(integration: string, purpose: string | undefined): string {
  return `[OAuthRefresh] integration=${integration} purpose=${purpose ?? "unknown"}`;
}

function classify(err: unknown): OAuthRefreshOutcome {
  if (err instanceof OAuthRefreshError) return err.outcome;
  return "transient";
}

async function safeOnTerminal<T>(
  opts: OAuthRefreshOptions<T>,
  err: unknown,
): Promise<void> {
  if (!opts.onTerminalAfterRetry) return;
  try {
    await opts.onTerminalAfterRetry(err);
  } catch (cleanupErr: any) {
    console.error(
      `${tag(opts.integration, opts.purpose)} onTerminalAfterRetry threw: ${cleanupErr?.message ?? cleanupErr}`,
    );
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Task #2435 — re-read the stored refresh token, optionally polling a
 * bounded number of extra times (with a short delay) to catch a sibling
 * that won the rotation race but hasn't persisted the rotated token yet.
 *
 * Returns the first re-read value that DIFFERS from `captured` (i.e. a
 * rotation was observed) or the last re-read value otherwise. Absent a
 * `terminalRotationRecheck` config this is exactly one immediate re-read,
 * preserving prior behavior for every integration that doesn't opt in.
 */
async function waitForRotatedRefreshToken<T>(
  opts: OAuthRefreshOptions<T>,
  captured: string,
): Promise<string | null | undefined> {
  const recheck = opts.terminalRotationRecheck;
  const extraAttempts = recheck ? Math.max(0, recheck.attempts) : 0;
  const sleep = opts.sleep ?? defaultSleep;
  let last: string | null | undefined = null;
  for (let i = 0; i <= extraAttempts; i++) {
    if (i > 0 && recheck) {
      await sleep(recheck.delayMs).catch(() => {});
    }
    last = await opts.readRefreshToken().catch(() => null);
    if (last && last !== captured) return last;
  }
  return last;
}

async function doRefresh<T>(opts: OAuthRefreshOptions<T>): Promise<T> {
  // Task #2289 — acquire the cross-process lease (if configured) AFTER
  // winning the in-process single-flight. This serializes the N autoscale
  // instances + workspace so only one process refreshes at a time. Acquire
  // degrades to `null` on contention/DB error; we then proceed with
  // in-process protection only rather than blocking the refresh forever.
  let releaseLease: (() => Promise<void>) | null = null;
  if (opts.crossProcessLease) {
    // Acquire on the SCOPED key so per-user integrations get one lease per
    // subject (`oauth_refresh_lease:<integration>:<subjectKey>`).
    releaseLease = await opts.crossProcessLease.acquire(scopedKey(opts));
  }
  try {
    // Once we hold the lease, a sibling may have refreshed while we waited.
    // The optional recheck returns the now-valid value so we can skip a
    // wasteful (and, mid-rotation, risky) second POST entirely. This lives
    // INSIDE the try so the lease is still released on the short-circuit
    // path (an early return here must not leak the lease).
    if (releaseLease && opts.onLeaseAcquiredRecheck) {
      try {
        const fresh = await opts.onLeaseAcquiredRecheck();
        if (fresh != null) {
          console.log(
            `${tag(opts.integration, opts.purpose)} refresh_outcome=lease_skip_fresh — sibling refreshed while awaiting lease; reused stored token`,
          );
          return fresh;
        }
      } catch {
        // Recheck is best-effort; fall through to a normal refresh.
      }
    }
    return await doRefreshInner(opts);
  } finally {
    if (releaseLease) await releaseLease().catch(() => {});
  }
}

async function doRefreshInner<T>(opts: OAuthRefreshOptions<T>): Promise<T> {
  // Read the refresh token AFTER the cross-process lease is held so a
  // loser picks up any rotated token a sibling just persisted (the whole
  // point of serializing — otherwise the loser would POST a consumed token).
  const captured = await opts.readRefreshToken();
  if (!captured) {
    const err = new OAuthRefreshError(
      opts.integration,
      "terminal",
      `${opts.integration} refresh token is missing — reconnect required`,
    );
    await safeOnTerminal(opts, err);
    throw err;
  }
  try {
    const value = await opts.refreshOnce({ refreshToken: captured, attempt: 1 });
    console.log(`${tag(opts.integration, opts.purpose)} refresh_outcome=ok`);
    return value;
  } catch (err) {
    if (classify(err) !== "terminal") {
      console.warn(
        `${tag(opts.integration, opts.purpose)} refresh_outcome=transient: ${(err as any)?.message ?? err}`,
      );
      throw err;
    }
    // Terminal — try the re-read-and-retry path. Another process may
    // have won the refresh race and rotated the stored token while we
    // were on the wire. Task #2435: poll a bounded number of times (when
    // configured) so a winning sibling that hasn't persisted the rotated
    // token yet still gets picked up instead of a false permanent death.
    const reRead = await waitForRotatedRefreshToken(opts, captured);
    if (reRead && reRead !== captured) {
      try {
        const value = await opts.refreshOnce({ refreshToken: reRead, attempt: 2 });
        console.log(
          `${tag(opts.integration, opts.purpose)} refresh_outcome=race_recovered — refresh_token rotated during attempt; retried with fresh token`,
        );
        return value;
      } catch (retryErr) {
        if (classify(retryErr) === "terminal") {
          console.warn(
            `${tag(opts.integration, opts.purpose)} refresh_outcome=terminal_after_reread: ${(retryErr as any)?.message ?? retryErr}`,
          );
          await safeOnTerminal(opts, retryErr);
        } else {
          console.warn(
            `${tag(opts.integration, opts.purpose)} refresh_outcome=transient_after_reread: ${(retryErr as any)?.message ?? retryErr}`,
          );
        }
        throw retryErr;
      }
    }
    console.warn(
      `${tag(opts.integration, opts.purpose)} refresh_outcome=terminal: ${(err as any)?.message ?? err}`,
    );
    await safeOnTerminal(opts, err);
    throw err;
  }
}

/**
 * Per-process single-flight wrapper around an OAuth refresh. Concurrent
 * callers for the same `integration` collapse onto one in-flight POST.
 * See module header for the full contract.
 */
export async function withSingleFlightOAuthRefresh<T>(
  opts: OAuthRefreshOptions<T>,
): Promise<T> {
  const key = scopedKey(opts);
  const existing = inFlight.get(key);
  if (existing) {
    console.log(
      `${tag(key, opts.purpose)} refresh_outcome=single_flight_wait — awaiting in-flight refresh`,
    );
    return existing as Promise<T>;
  }
  const p = doRefresh(opts);
  inFlight.set(key, p);
  // Schedule cleanup but DO NOT await it on the caller's path so the
  // caller sees the original resolution/rejection.
  p.finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }).catch(() => {
    // Swallow — the original `p` already propagates errors to the caller.
  });
  return p;
}

/** Test seam. */
export function __resetOAuthRefreshSingleFlightForTest(): void {
  inFlight.clear();
}

/** Test seam — observe how many integrations have an in-flight refresh. */
export function __getOAuthRefreshInFlightCountForTest(): number {
  return inFlight.size;
}

/** Test seam — observe the exact in-flight slot keys (e.g. to assert a
 * per-user integration scopes its slot to `<integration>:<subjectKey>`). */
export function __getOAuthRefreshInFlightKeysForTest(): string[] {
  return [...inFlight.keys()];
}
