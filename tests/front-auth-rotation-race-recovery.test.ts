/* test-registration
{
  "name": "Front OAuth rotation-race recovery e2e (Task #2438)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2438 — End-to-end Front OAuth refresh-token rotation-race recovery.
 *
 * Drives the REAL `getValidFrontAccessToken` → `acquireValidFrontAccessToken`
 * → `refreshAccessToken` → `withSingleFlightOAuthRefresh` →
 * `performTokenRefreshPost` + `storeTokens` chain in
 * `server/services/frontIntegration.ts` through a simulated rotation race and
 * locks in the Task #2435 / #2289 / #1975 / #2100 guarantees together:
 *
 *   (a) When a terminal refresh self-heals because a sibling rotated the
 *       stored refresh token mid-poll (the `terminalRotationRecheck` window),
 *       `getValidFrontAccessToken` resolves the freshly-rotated access token
 *       with NO `FrontAuthError` and writes NO new `front_auth_death` record
 *       — and the auth-dead breaker stays closed.
 *   (b) A previously-standing death gets `recoveredAt` stamped once the
 *       race-recovered `storeTokens` lands (fire-and-forget
 *       `markFrontAuthDeathRecovered`).
 *   (c) A genuinely revoked refresh token that NEVER rotates exhausts the
 *       recheck window, surfaces a terminal
 *       `FrontAuthError("front_refresh_failed_permanent")`, trips the breaker
 *       and STILL records a death — so the recheck never masks a real outage.
 *
 * Front OAuth facts this exercises (per dev.frontapp.com/docs/oauth):
 *   - Token endpoint is POST https://app.frontapp.com/oauth/token with HTTP
 *     Basic `client_id:client_secret` and `grant_type=refresh_token`.
 *   - Front returns the SAME refresh token during its 6-month validity and
 *     only rotates a NEW one in the final 24h, so a lost rotation race 4xx's
 *     `invalid_grant` (HTTP 400) on a captured-but-consumed token. That 400
 *     is terminal; a 5xx is transient.
 *
 * No production code changes — test-only. Mirrors the DB + upstash-stub
 * harness of `tests/front-auth-recovery-annotation.test.ts` and the
 * fetch-scripting style of `tests/front-historical-recovery-retry.test.ts`.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  getValidFrontAccessToken,
  FrontAuthError,
} from "../server/services/frontIntegration";
import {
  recordFrontAuthDeath,
  getLastFrontAuthDeath,
  __resetFrontAuthDeathDedupForTest,
  FRONT_AUTH_DEATH_LAST_KEY,
  FRONT_AUTH_DEATH_RECENT_KEY,
} from "../server/services/frontAuthDeathDiagnostics";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
  __whenFrontAuthBreakerPersistSettledForTest,
  frontAuthBreakerActive,
} from "../server/services/frontAuthBreaker";

const ACCESS_KEY = "front_access_token";
const REFRESH_KEY = "front_refresh_token";
const EXPIRES_KEY = "front_token_expires_at";
const FRONT_TOKEN_URL = "https://app.frontapp.com/oauth/token";

// `performTokenRefreshPost` bails early without these — set them so the real
// POST path runs and is intercepted by the fetch stub below.
process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "task-2438-client";
process.env.FRONT_CLIENT_SECRET = process.env.FRONT_CLIENT_SECRET || "task-2438-secret";

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

// Per-test scripted handler for the Front OAuth token POST. Receives the
// refresh_token carried in the form body; returns the Response to reply with.
type OAuthHandler = (refreshToken: string, postIndex: number) => Response | Promise<Response>;
let oauthHandler: OAuthHandler | null = null;
let postCount = 0;
let postedRefreshTokens: string[] = [];

function urlOf(input: any): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = urlOf(input);
  if (url.startsWith(FRONT_TOKEN_URL)) {
    const body = String(init?.body ?? "");
    const refreshToken = new URLSearchParams(body).get("refresh_token") ?? "";
    postCount++;
    postedRefreshTokens.push(refreshToken);
    if (!oauthHandler) {
      throw new Error("Front OAuth POST hit with no scripted handler installed");
    }
    return oauthHandler(refreshToken, postCount);
  }
  // Nothing else should touch the network in this chain; fail loud if it does.
  throw new Error(`Unexpected fetch in Task #2438 test: ${url}`);
}) as any;

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function seedConnected(refreshToken: string, expiresAtSec: number): Promise<void> {
  await storage.setSystemSetting(ACCESS_KEY, "access-seed", "system");
  await storage.setSystemSetting(REFRESH_KEY, refreshToken, "system");
  await storage.setSystemSetting(EXPIRES_KEY, String(expiresAtSec), "system");
}

async function clearTokenRows(): Promise<void> {
  await db.execute(
    sql`DELETE FROM system_settings WHERE key IN (${ACCESS_KEY}, ${REFRESH_KEY}, ${EXPIRES_KEY})`,
  );
}

async function clearDeathRows(): Promise<void> {
  __resetFrontAuthDeathDedupForTest();
  await db.execute(
    sql`DELETE FROM system_settings WHERE key IN (${FRONT_AUTH_DEATH_LAST_KEY}, ${FRONT_AUTH_DEATH_RECENT_KEY})`,
  );
}

async function resetState(): Promise<void> {
  __resetFrontAuthBreakerForTest();
  await __clearPersistedFrontAuthBreakerForTest().catch(() => {});
  __resetOAuthRefreshSingleFlightForTest();
  await clearDeathRows();
  await clearTokenRows();
  postCount = 0;
  postedRefreshTokens = [];
  oauthHandler = null;
}

async function pollFor<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  { tries = 60, delayMs = 50 }: { tries?: number; delayMs?: number } = {},
): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await read();
  }
  return last;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Install a handler that simulates a winning sibling: the FIRST POST (on the
 * captured token) 4xx's `invalid_grant`, and a sibling persists the rotated
 * `refresh-B` shortly AFTER — but not before the immediate re-read — so the
 * bounded `terminalRotationRecheck` poll (not the immediate re-read) is what
 * catches the rotation. The retry POST on `refresh-B` succeeds.
 */
function installRaceRecoveryHandler(siblingDelayMs: number): void {
  oauthHandler = (refreshToken, postIndex) => {
    if (postIndex === 1) {
      assert.equal(refreshToken, "refresh-A", "first POST must use the captured refresh-A");
      // A sibling rotates the stored token mid-poll. Scheduled AFTER we
      // return the 400 so the recheck's immediate (i=0) re-read still sees
      // refresh-A and only a later poll iteration observes refresh-B.
      setTimeout(() => {
        void storage.setSystemSetting(REFRESH_KEY, "refresh-B", "system");
      }, siblingDelayMs);
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    assert.equal(refreshToken, "refresh-B", "retry POST must use the re-read rotated refresh-B");
    return jsonResponse(
      { access_token: "access-after-race", refresh_token: "refresh-C", expires_at: nowSec() + 3600 },
      200,
    );
  };
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetState();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    // Let any fire-and-forget breaker persist land before the next reset so a
    // late write can't leak into the following case.
    await __whenFrontAuthBreakerPersistSettledForTest().catch(() => {});
    await resetState();
  }
}

async function main(): Promise<void> {
  console.log("Front OAuth rotation-race recovery e2e (Task #2438)");

  try {
    await step(
      "(a) self-healing rotation race resolves with no FrontAuthError and writes NO death",
      async () => {
        await seedConnected("refresh-A", nowSec() - 1000); // expired → forces refresh
        installRaceRecoveryHandler(50);

        const token = await getValidFrontAccessToken({ purpose: "front_sync", forceRefresh: true });

        assert.equal(token, "access-after-race", "must resolve the freshly-rotated access token");
        assert.equal(postCount, 2, "exactly two POSTs: the racing 400 + the rotated-token retry");
        assert.deepEqual(
          postedRefreshTokens,
          ["refresh-A", "refresh-B"],
          "first POST uses captured refresh-A, retry uses re-read refresh-B",
        );
        assert.equal(
          frontAuthBreakerActive(),
          false,
          "auth-dead breaker must stay closed on a self-healed race",
        );

        const death = await getLastFrontAuthDeath();
        assert.equal(death, null, "a self-healed race must NOT write a front_auth_death record");
      },
    );

    await step(
      "(b) a previously-standing death gets recoveredAt stamped after the race-recovered storeTokens",
      async () => {
        // A real death is already on record from an earlier outage.
        await recordFrontAuthDeath({
          code: "front_refresh_failed_permanent",
          httpStatus: 400,
          bodySnippet: "invalid_grant: earlier outage",
        });
        const before = await getLastFrontAuthDeath();
        assert.ok(before, "standing death must be persisted");
        assert.ok(!before!.recoveredAt, "standing death starts unrecovered");

        await seedConnected("refresh-A", nowSec() - 1000);
        installRaceRecoveryHandler(50);

        const token = await getValidFrontAccessToken({ purpose: "front_sync", forceRefresh: true });
        assert.equal(token, "access-after-race", "race must still recover the token");

        // `storeTokens` fires `markFrontAuthDeathRecovered` fire-and-forget;
        // poll the side effect rather than assuming it has landed.
        const after = await pollFor(
          () => getLastFrontAuthDeath(),
          (d) => !!d?.recoveredAt,
        );
        assert.ok(after?.recoveredAt, "standing death must be annotated recoveredAt after recovery");
        assert.equal(after!.code, before!.code, "death code must be preserved through recovery");
        assert.equal(after!.diedAt, before!.diedAt, "diedAt must be preserved through recovery");
      },
    );

    await step(
      "(c) a genuinely revoked token (never rotates) still surfaces terminal + records a death",
      async () => {
        await seedConnected("refresh-A", nowSec() - 1000);
        // Every POST 4xx's and the token NEVER rotates → recheck exhausts.
        oauthHandler = (refreshToken) => {
          assert.equal(refreshToken, "refresh-A", "revoked token never rotates — every POST uses refresh-A");
          return jsonResponse({ error: "invalid_grant" }, 400);
        };

        let thrown: unknown;
        try {
          await getValidFrontAccessToken({ purpose: "front_sync", forceRefresh: true });
        } catch (err) {
          thrown = err;
        }

        assert.ok(thrown instanceof FrontAuthError, "a true revocation must throw FrontAuthError");
        assert.equal(
          (thrown as FrontAuthError).code,
          "front_refresh_failed_permanent",
          "revocation must classify as front_refresh_failed_permanent",
        );
        assert.equal(postCount, 1, "non-rotating token never triggers a retry POST");
        assert.equal(
          frontAuthBreakerActive(),
          true,
          "an authoritative terminal refresh must trip the auth-dead breaker",
        );

        const death = await pollFor(
          () => getLastFrontAuthDeath(),
          (d) => !!d,
        );
        assert.ok(death, "a genuine revocation MUST record a front_auth_death record");
        assert.equal(death!.code, "front_refresh_failed_permanent", "death carries the terminal code");
        assert.equal(death!.httpStatus, 400, "death carries the HTTP 400 status");
        assert.ok(!death!.recoveredAt, "an unrecovered true death must stay unrecovered (no masking)");
      },
    );
  } finally {
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit(),
// so a leaked handle surfaces as a real hang instead of being masked.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
