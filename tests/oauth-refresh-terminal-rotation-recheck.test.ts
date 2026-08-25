/* test-registration
{
  "name": "Oauth refresh terminal rotation recheck (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2435 — bounded wait-and-re-read before a terminal OAuth refresh is
 * declared a true death (`withSingleFlightOAuthRefresh` /
 * `terminalRotationRecheck` in `server/services/oauthRefresh.ts`).
 *
 * Defect 2: the cross-process lease serializes refreshers, but a loser can
 * still re-read the stored refresh token in the instant BEFORE the winning
 * sibling persists the freshly-rotated one. The plain single immediate
 * re-read then sees a still-consumed token, can't fire its retry, and
 * surfaces a false permanent death (which trips Front's auth-dead breaker
 * and records a permanent-looking death). `terminalRotationRecheck` polls
 * the stored token a bounded number of extra times so the winner's persist
 * lands and the retry picks up the rotated token.
 *
 * Locks the following behavior in place:
 *   1. A rotation that lands AFTER the first re-read (mid-poll) is picked
 *      up and the retry succeeds — no terminal, no `onTerminalAfterRetry`.
 *   2. A true revocation (the token NEVER rotates) still exhausts the
 *      bounded window and is declared terminal exactly once — the fix must
 *      not mask a real outage.
 *   3. Without `terminalRotationRecheck`, behavior is unchanged: exactly
 *      one immediate re-read (no extra polling, default for other
 *      integrations).
 *
 * Pure unit test — no DB, no Front HTTP. `refreshOnce` / `readRefreshToken`
 * are in-memory stubs and `sleep` is a no-op so the poll never really waits.
 */
import assert from "node:assert/strict";

import {
  withSingleFlightOAuthRefresh,
  OAuthRefreshError,
  __resetOAuthRefreshSingleFlightForTest,
} from "../server/services/oauthRefresh";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  }
}

const noopSleep = async (_ms: number): Promise<void> => {};

async function main(): Promise<void> {
  console.log("OAuth refresh terminal rotation recheck (Task #2435)");

  await step(
    "a rotation that lands mid-poll is picked up and the retry succeeds",
    async () => {
      const CAPTURED = "rt-captured-consumed";
      const ROTATED = "rt-rotated-by-sibling";
      // The sibling persists the rotated token only on the 3rd stored read:
      // capture (read #1), first re-read still stale (read #2), still stale
      // (read #3) ... then rotated. So a single immediate re-read would miss
      // it; the bounded poll catches it.
      let storedReads = 0;
      const readRefreshToken = async (): Promise<string> => {
        storedReads++;
        return storedReads >= 4 ? ROTATED : CAPTURED;
      };

      let terminalCalls = 0;
      const refreshOnce = async (ctx: { refreshToken: string; attempt: 1 | 2 }) => {
        if (ctx.refreshToken === CAPTURED) {
          throw new OAuthRefreshError("front", "terminal", "invalid_grant", { status: 400 });
        }
        return `access-token-from-${ctx.refreshToken}`;
      };

      const value = await withSingleFlightOAuthRefresh<string>({
        integration: "front",
        purpose: "historical_recovery",
        readRefreshToken,
        refreshOnce,
        terminalRotationRecheck: { attempts: 3, delayMs: 1 },
        sleep: noopSleep,
        onTerminalAfterRetry: async () => {
          terminalCalls++;
        },
      });

      assert.equal(value, `access-token-from-${ROTATED}`, "retry should return the rotated token's access token");
      assert.equal(terminalCalls, 0, "a recovered race must NOT call onTerminalAfterRetry");
    },
  );

  await step(
    "a true revocation (token never rotates) is still declared terminal once",
    async () => {
      const CAPTURED = "rt-revoked";
      const readRefreshToken = async (): Promise<string> => CAPTURED; // never rotates

      let terminalCalls = 0;
      const refreshOnce = async (_ctx: { refreshToken: string }) => {
        throw new OAuthRefreshError("front", "terminal", "invalid_grant: revoked", { status: 400 });
      };

      let threw: unknown = null;
      try {
        await withSingleFlightOAuthRefresh<string>({
          integration: "front",
          purpose: "historical_recovery",
          readRefreshToken,
          refreshOnce,
          terminalRotationRecheck: { attempts: 3, delayMs: 1 },
          sleep: noopSleep,
          onTerminalAfterRetry: async () => {
            terminalCalls++;
          },
        });
      } catch (err) {
        threw = err;
      }

      assert.ok(threw instanceof OAuthRefreshError, "a true revocation must still throw");
      assert.equal((threw as OAuthRefreshError).outcome, "terminal", "and stay terminal");
      assert.equal(terminalCalls, 1, "onTerminalAfterRetry must fire exactly once for a true death");
    },
  );

  await step(
    "without terminalRotationRecheck, exactly one immediate re-read is done",
    async () => {
      const CAPTURED = "rt-captured";
      let reads = 0;
      const readRefreshToken = async (): Promise<string> => {
        reads++;
        return CAPTURED; // never rotates
      };
      const refreshOnce = async (_ctx: { refreshToken: string }) => {
        throw new OAuthRefreshError("front", "terminal", "invalid_grant", { status: 400 });
      };

      try {
        await withSingleFlightOAuthRefresh<string>({
          integration: "zoom",
          readRefreshToken,
          refreshOnce,
          // no terminalRotationRecheck
        });
      } catch {
        // expected terminal
      }

      // 1 capture + 1 immediate re-read = 2 reads, no extra polling.
      assert.equal(reads, 2, "default path must read the token exactly twice (capture + one re-read)");
    },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
