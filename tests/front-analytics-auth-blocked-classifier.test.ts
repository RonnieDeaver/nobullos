/* test-registration
{
  "name": "Front Analytics auth_blocked recoverable classifier + re-eval (Task #1920)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1920 Step 1 — auth_blocked recoverable classifier + re-eval gate.
 *
 * Before this task a transient 401 during a bad-token window (the May
 * 26–27 incident) stamped `unrecoverable=true` and the worker skipped the
 * month on every subsequent tick even after Front auth was restored —
 * permanently freezing the coverage row. The fix reclassifies a 401 as a
 * recoverable `auth_blocked` state UNLESS the Front auth breaker is open
 * (genuine revoked token), and adds `shouldReEvaluateAuthBlocked` so a row
 * frozen on a real 401 un-sticks itself once auth is healthy again.
 *
 * These are pure-function assertions over the breaker state; no Front HTTP
 * calls and no coverage-row writes happen.
 */
import assert from "node:assert/strict";
import {
  classifyProbeFailure,
  shouldReEvaluateAuthBlocked,
  isFrontAuthHealthy,
  isMessageGrainDenominator,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "../server/services/frontAnalyticsCoverage";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import type { FrontAnalyticsMonthlyCoverage } from "../shared/models/frontAnalyticsCoverage";

function row(
  over: Partial<FrontAnalyticsMonthlyCoverage>,
): FrontAnalyticsMonthlyCoverage {
  return {
    unrecoverable: false,
    frontAnalyticsError: null,
    ...over,
  } as FrontAnalyticsMonthlyCoverage;
}

try {
  // ───────────────────────────────────────────────────────────────────
  // Breaker closed (auth healthy) — a 401 is RECOVERABLE auth_blocked.
  // ───────────────────────────────────────────────────────────────────
  __resetFrontAuthBreakerForTest();
  assert.equal(isFrontAuthHealthy(), true, "closed breaker = auth healthy");

  const closed401 = classifyProbeFailure("front_analytics_auth_failed", 401);
  assert.equal(
    closed401.unrecoverable,
    false,
    "401 with closed breaker is NOT terminal",
  );
  assert.equal(closed401.authBlocked, true, "401 with closed breaker = authBlocked");

  // ───────────────────────────────────────────────────────────────────
  // A non-plan-limit 403 (missing scope / forbidden) is TERMINAL even when
  // auth is healthy — retrying never heals it, so it never becomes auth_blocked.
  // ───────────────────────────────────────────────────────────────────
  const closed403 = classifyProbeFailure("front_analytics_auth_failed", 403);
  assert.equal(
    closed403.unrecoverable,
    true,
    "non-plan-limit 403 is terminal even with healthy auth",
  );
  assert.equal(closed403.authBlocked, false, "403 is never authBlocked");

  // ───────────────────────────────────────────────────────────────────
  // Breaker open (genuine revoked token) — a 401 is TERMINAL.
  // ───────────────────────────────────────────────────────────────────
  tripFrontAuthBreaker("front_refresh_failed_permanent");
  assert.equal(isFrontAuthHealthy(), false, "open breaker = auth NOT healthy");

  const open401 = classifyProbeFailure("front_analytics_auth_failed", 401);
  assert.equal(
    open401.unrecoverable,
    true,
    "401 with open breaker is terminal (operator must reconnect)",
  );
  assert.equal(open401.authBlocked, false, "open-breaker 401 is not authBlocked");

  // Non-auth codes never get the authBlocked treatment regardless of breaker.
  const nonAuth = classifyProbeFailure("front_analytics_plan_limited", 403);
  assert.equal(nonAuth.authBlocked, false, "non-401 code is never authBlocked");

  // ───────────────────────────────────────────────────────────────────
  // shouldReEvaluateAuthBlocked — un-stick a genuine-401 frozen row once
  // auth is healthy; keep skipping while the breaker is open.
  // ───────────────────────────────────────────────────────────────────
  const frozen = row({
    unrecoverable: true,
    frontAnalyticsError:
      "front_analytics_auth_failed: Front search auth failed (401): Unauthorized",
  });

  // Breaker still open → keep backing off.
  assert.equal(
    shouldReEvaluateAuthBlocked(frozen),
    false,
    "frozen 401 stays skipped while breaker open",
  );

  // Breaker reset (auth healthy) → re-evaluate.
  __resetFrontAuthBreakerForTest();
  assert.equal(
    shouldReEvaluateAuthBlocked(frozen),
    true,
    "frozen 401 re-evaluates once auth healthy",
  );

  // A recoverable row (unrecoverable=false) is not in scope for this gate.
  assert.equal(
    shouldReEvaluateAuthBlocked(row({ unrecoverable: false })),
    false,
    "recoverable row is not a re-eval candidate",
  );

  // A genuine 403 (missing scope / forbidden) is terminal and must NEVER
  // re-probe on the auth-blocked path, even when Front auth is healthy —
  // otherwise the worker would re-hit the same 403 every tick.
  assert.equal(
    shouldReEvaluateAuthBlocked(
      row({
        unrecoverable: true,
        frontAnalyticsError:
          "front_analytics_auth_failed: Front search auth failed (403): Forbidden",
      }),
    ),
    false,
    "genuine 403 stays frozen — never re-probed on the auth-blocked path",
  );

  // A plan-limit misclassification is handled by the dedicated path, not here.
  assert.equal(
    shouldReEvaluateAuthBlocked(
      row({
        unrecoverable: true,
        frontAnalyticsError:
          "front_analytics_auth_failed: 403 Your plan does not give you access to analytics",
      }),
    ),
    false,
    "plan-limit-snippet 401 is left to the misclassification path",
  );

  // A non-auth terminal error is not an auth re-eval candidate.
  assert.equal(
    shouldReEvaluateAuthBlocked(
      row({ unrecoverable: true, frontAnalyticsError: "some_other_error" }),
    ),
    false,
    "non-auth terminal error is not an auth re-eval candidate",
  );

  // ───────────────────────────────────────────────────────────────────
  // isMessageGrainDenominator — the single predicate every write path
  // (recompute sweeps + both failure-persistence branches) uses to keep a
  // messages_all row's numerator at message grain. Task #1920 — a failed
  // re-probe must NOT downgrade a messages_all row to conversation grain.
  // ───────────────────────────────────────────────────────────────────
  assert.equal(
    isMessageGrainDenominator(DENOMINATOR_UNIT_MESSAGES_ALL),
    true,
    "messages_all denominator => message-grain numerator on (re)write",
  );
  assert.equal(
    isMessageGrainDenominator("conversations_all"),
    false,
    "conversations_all denominator stays conversation-grain",
  );
  assert.equal(
    isMessageGrainDenominator(null),
    false,
    "null denominator (never measured) stays conversation-grain",
  );
  assert.equal(
    isMessageGrainDenominator(undefined),
    false,
    "missing denominator (no existing row) stays conversation-grain",
  );

  console.log(
    "✓ Front Analytics auth_blocked classifier + re-eval gate (Task #1920) passed",
  );
} finally {
  __resetFrontAuthBreakerForTest();
}
