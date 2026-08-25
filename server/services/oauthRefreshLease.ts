/**
 * Task #2289 — Cross-process OAuth refresh lease.
 *
 * `withSingleFlightOAuthRefresh` (oauthRefresh.ts) collapses concurrent
 * refreshers WITHIN one Node process onto a single POST. That is not
 * enough in the deployed runtime: autoscale runs N instances, and each is
 * an independent process with its own in-memory single-flight map. When
 * two instances refresh the same integration at nearly the same moment
 * AND the request lands inside Front's last-24h refresh-token rotation
 * window (per dev.frontapp.com/docs/oauth: Front returns the SAME refresh
 * token during the 6-month validity and only rotates a NEW one in the
 * final 24h), the winner consumes the old token and the loser's POST
 * comes back `invalid_grant` (HTTP 400). Front's own docs recommend a
 * distributed lock so only one process refreshes at a time and the others
 * wait + re-read the persisted token.
 *
 * This module implements that distributed lock as a TTL'd lease row in
 * `system_settings` keyed `oauth_refresh_lease:<integration>`. We use a
 * lease row rather than a Postgres advisory lock on purpose: an advisory
 * lock is SESSION-scoped, so it must be held on one pooled connection for
 * the full duration of the refresh — including the external Front token
 * POST. The architecture's DB-hold rules forbid holding a pooled
 * connection across an external HTTP call. A lease row touches the DB only
 * for the short CAS acquire / release statements and never spans the POST.
 *
 * Self-healing: the lease carries an `expiresAt`; a crashed holder's lease
 * is reclaimable once it expires, so a dead instance can never wedge every
 * other instance out of refreshing forever. `acquire` blocks (polls) up to
 * a bounded timeout, then degrades to `null` (proceed in-process-only)
 * rather than blocking a token refresh indefinitely on lock contention.
 */
// @db-pool-intent: ambient — shared OAuth-refresh helper; the lease CAS
// runs on whichever pool the refresh caller already established (api for an
// on-demand request path, worker for a background sweep). It never opens its
// own scope, so it inherits the caller's attribution + pool context.
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";

/** How long a freshly-acquired lease is considered held before it is
 * reclaimable by another process. The Front token POST is fast (sub-second
 * to a few seconds); 30s comfortably covers a slow round-trip while still
 * letting a crashed holder's lease expire quickly. */
const LEASE_TTL_MS = 30_000;
/** Upper bound on how long a loser waits for the holder to release before
 * giving up and proceeding without the lease (in-process protection only).
 * Kept under LEASE_TTL so a stale lease left by a crashed holder is still
 * observed as expired within one acquire window. */
const ACQUIRE_TIMEOUT_MS = 25_000;
const POLL_MIN_MS = 200;
const POLL_MAX_MS = 500;

function leaseKey(integration: string): string {
  return `oauth_refresh_lease:${integration}`;
}

function newOwnerId(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredPollDelay(): number {
  return POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
}

/**
 * Atomic compare-and-set acquire. Inserts the lease row if absent, or
 * takes it over only when the existing lease has expired. Returns true
 * iff this process now owns the lease.
 *
 * The only writer of this key is this module, so the stored value is
 * always our JSON shape — the `::jsonb` cast in the ON CONFLICT WHERE is
 * safe. A missing/empty value also wins (NULLIF guard).
 */
async function tryAcquireOnce(
  integration: string,
  owner: string,
  nowMs: number,
): Promise<boolean> {
  const key = leaseKey(integration);
  const value = JSON.stringify({
    owner,
    acquiredAt: nowMs,
    expiresAt: nowMs + LEASE_TTL_MS,
  });
  const rows = await withDbAttribution("oauth:refresh-lease-acquire", () =>
    getDb().execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (${key}, ${value}, now())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
        WHERE NULLIF(system_settings.value, '') IS NULL
           OR (system_settings.value::jsonb ->> 'expiresAt')::bigint <= ${nowMs}
      RETURNING key
    `),
  );
  const count = (rows as any)?.rowCount ?? (rows as any)?.rows?.length ?? 0;
  return count > 0;
}

/** Release the lease, but ONLY if we still own it (a later holder may have
 * legitimately taken over after our lease expired). Best-effort. */
async function releaseOwned(integration: string, owner: string): Promise<void> {
  const key = leaseKey(integration);
  await withDbAttribution("oauth:refresh-lease-release", () =>
    getDb().execute(sql`
      DELETE FROM system_settings
      WHERE key = ${key}
        AND NULLIF(value, '') IS NOT NULL
        AND value::jsonb ->> 'owner' = ${owner}
    `),
  );
}

export interface OAuthCrossProcessLease {
  /**
   * Block (poll) until this process holds the cross-process lease for
   * `integration`, then return a release function. Returns `null` if the
   * lease could not be acquired within the timeout OR the lease store is
   * unavailable — callers MUST degrade to in-process-only protection in
   * that case rather than skipping the refresh entirely.
   */
  acquire: (integration: string) => Promise<(() => Promise<void>) | null>;
}

/**
 * The default Postgres-backed lease. Uses `getDb()` so it honors the
 * caller's api/worker pool context (refreshes happen from both request
 * handlers and background workers).
 */
export const postgresOAuthRefreshLease: OAuthCrossProcessLease = {
  async acquire(integration: string): Promise<(() => Promise<void>) | null> {
    const owner = newOwnerId();
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    try {
      // Fast path + poll loop.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const won = await tryAcquireOnce(integration, owner, Date.now());
        if (won) {
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            await releaseOwned(integration, owner).catch((err: any) => {
              console.warn(
                `[OAuthRefreshLease] integration=${integration} release failed (lease will expire on TTL): ${err?.message ?? err}`,
              );
            });
          };
        }
        if (Date.now() >= deadline) {
          // Task #2643 — attribution: a lease degrade to in-process-only is the
          // exact window where two autoscale instances can race the rotating
          // refresh token (the false-disconnect signature). Log owner so the
          // degrade can be correlated with the instance that then trips/wipes.
          console.warn(
            `[OAuthRefreshLease] integration=${integration} owner=${owner} outcome=lease_skip reason=acquire_timeout after ${ACQUIRE_TIMEOUT_MS}ms — proceeding with in-process protection only`,
          );
          return null;
        }
        await sleep(jitteredPollDelay());
      }
    } catch (err: any) {
      // Lease store unavailable (DB error). Degrade — never block a token
      // refresh on lease infrastructure. Task #2643 — log owner for the same
      // rotation-race correlation as the timeout path above.
      console.warn(
        `[OAuthRefreshLease] integration=${integration} owner=${owner} outcome=lease_skip reason=acquire_error — proceeding with in-process protection only: ${err?.message ?? err}`,
      );
      return null;
    }
  },
};

/**
 * Resolve the cross-process lease a refresh call site should use. Returns
 * `undefined` (no lease — in-process protection only) under `NODE_ENV=test`
 * so the large existing OAuth/Front test suite never reaches the live
 * `system_settings` store. A test that wants to exercise the lease path
 * injects a stub via `__setOAuthRefreshLeaseForTest`.
 */
let testLeaseOverride: OAuthCrossProcessLease | null | undefined = undefined;

export function getDefaultOAuthRefreshLease(): OAuthCrossProcessLease | undefined {
  if (testLeaseOverride !== undefined) return testLeaseOverride ?? undefined;
  if (process.env.NODE_ENV === "test") return undefined;
  return postgresOAuthRefreshLease;
}

/** Test seam — force a specific lease (or `null` to disable) regardless of
 * NODE_ENV. Pass `undefined` to restore the default resolution. */
export function __setOAuthRefreshLeaseForTest(
  lease: OAuthCrossProcessLease | null | undefined,
): void {
  testLeaseOverride = lease;
}

/** Test seam — directly exercise the CAS primitives. */
export const __testHelpers = {
  tryAcquireOnce,
  releaseOwned,
  leaseKey,
  LEASE_TTL_MS,
  ACQUIRE_TIMEOUT_MS,
};
