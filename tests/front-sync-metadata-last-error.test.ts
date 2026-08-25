/* test-registration
{
  "name": "Front sync-metadata live last-error derivation (Task #2417)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2417 — `getSyncMetadata().lastError` must surface a REAL, human-readable
 * reason when Front auth is dead, derived from the live auth-death diagnostics /
 * auth-breaker state, instead of the retired `front_last_sync_error` setting
 * (which was only ever written empty, so the Integrations-Hub Front card and the
 * Pipeline Health tab showed no reason when Front genuinely broke).
 *
 * Coverage:
 *   (a) Breaker OPEN with a death record → lastError is the plain-English reason
 *       plus the HTTP status and a reconnect hint (not an empty string, not the
 *       raw code).
 *   (b) Breaker closed but the most-recent auth event is still a trip with no
 *       later success (cooldown window lapsed) → lastError still surfaces, so a
 *       genuine outage isn't hidden between cooldown windows.
 *   (c) A later success than the last trip (reconnect / `/me` probe) → lastError
 *       is null (healthy).
 *   (d) Never tripped → lastError is null.
 *
 * Drives the in-memory breaker via the test-only seam (`__setFrontAuthStateForTest`)
 * and pins + restores the `front_auth_death:last` setting (shared-setting pinning).
 */
import assert from "node:assert/strict";

import { storage } from "../server/storage";
import { getSyncMetadata } from "../server/services/frontIntegration";
import { FRONT_AUTH_DEATH_LAST_KEY } from "../server/services/frontAuthDeathDiagnostics";
import {
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
  __setFrontAuthStateForTest,
} from "../server/services/frontAuthBreaker";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetFrontAuthBreakerForTest();
  await __clearPersistedFrontAuthBreakerForTest();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
  }
}

async function main(): Promise<void> {
  console.log("Front getSyncMetadata().lastError derivation (Task #2417)");

  // Pin + restore the death record the derivation reads.
  const priorDeath = await storage.getSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => null);

  try {
    await step("breaker open + death record → plain-English reason w/ HTTP status", async () => {
      const now = Date.now();
      __setFrontAuthStateForTest({
        breakerOpenUntilMs: now + 5 * 60_000,
        lastTrippedAtMs: now,
        lastTrippedCode: "front_refresh_failed_permanent",
        lastSuccessAtMs: null,
        tripCount: 2,
      });
      await storage.setSystemSetting(
        FRONT_AUTH_DEATH_LAST_KEY,
        JSON.stringify({
          code: "front_refresh_failed_permanent",
          httpStatus: 401,
          bodySnippet: "invalid_grant",
          environment: "development",
          lastSuccessAt: null,
          diedAt: new Date(now).toISOString(),
        }),
        "system",
      );

      const meta = await getSyncMetadata();
      assert.ok(meta.lastError, "lastError must not be null when Front auth is dead");
      assert.ok(
        meta.lastError!.includes("Front rejected the saved credentials"),
        `lastError should be the plain-English reason (got: ${meta.lastError})`,
      );
      assert.ok(
        meta.lastError!.includes("HTTP 401"),
        `lastError should carry the HTTP status from the death record (got: ${meta.lastError})`,
      );
      assert.ok(
        /reconnect/i.test(meta.lastError!),
        `lastError should tell the operator to reconnect (got: ${meta.lastError})`,
      );
      assert.ok(
        meta.lastError !== "" && meta.lastError !== "front_refresh_failed_permanent",
        "lastError must not be the empty string or the raw code",
      );
    });

    await step("cooldown lapsed but still dead → lastError still surfaces", async () => {
      const now = Date.now();
      // Breaker window already closed (breakerOpenUntilMs in the past), but the
      // most recent auth event is a trip with no later success.
      __setFrontAuthStateForTest({
        breakerOpenUntilMs: now - 60_000,
        lastTrippedAtMs: now - 30_000,
        lastTrippedCode: "front_no_refresh_token",
        lastSuccessAtMs: now - 10 * 60_000,
        tripCount: 1,
      });
      await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});

      const meta = await getSyncMetadata();
      assert.ok(meta.lastError, "lastError must surface even after the cooldown window lapses");
      assert.ok(
        meta.lastError!.includes("Front has no stored refresh token"),
        `lastError should fall back to the sticky trip code reason (got: ${meta.lastError})`,
      );
    });

    await step("later success than last trip → healthy → lastError null", async () => {
      const now = Date.now();
      __setFrontAuthStateForTest({
        breakerOpenUntilMs: 0,
        lastTrippedAtMs: now - 60_000,
        lastTrippedCode: "front_refresh_failed_permanent",
        lastSuccessAtMs: now, // success AFTER the trip → reconnected
        tripCount: 1,
      });

      const meta = await getSyncMetadata();
      assert.equal(meta.lastError, null, "lastError must be null once Front auth recovered");
    });

    await step("never tripped → lastError null", async () => {
      const meta = await getSyncMetadata();
      assert.equal(meta.lastError, null, "lastError must be null when Front never died");
    });
  } finally {
    if (priorDeath?.value) {
      await storage.setSystemSetting(FRONT_AUTH_DEATH_LAST_KEY, priorDeath.value, "system");
    } else {
      await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so
// the process exits on its own once work settles — no manual process.exit().
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
