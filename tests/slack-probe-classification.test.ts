/* test-registration
{
  "name": "Slack probe classification (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #1876 — Slack probe outcome classification.
 *
 * Mirrors the Front Task #1861 contract for the Slack probe so that
 * `/api/integrations/all-status` no longer flips the Integrations Hub
 * badge to "Not Connected" on a transient blip. Pins:
 *
 *   1. A confirmed missing token → `unauthorized` with `no_token_stored`.
 *   2. Each terminal Slack auth code from `auth.test` → `unauthorized`
 *      (badge legitimately flips, reason surfaced).
 *   3. Each transient failure (HTTP 5xx, network error, HTML body,
 *      `missing_scope`, `no_permission`, unknown ok:false) → `probe_failed`
 *      (badge preserves last-known-good).
 *   4. A successful `auth.test` while the breaker is open clears the
 *      breaker and returns `connected` immediately — no 5-minute wait.
 *
 * The integration-status cache's preserve/commit contract itself is
 * already covered by `tests/front-probe-classification.test.ts` — the
 * Slack loader uses the same shape, so we only test the Slack-side
 * classification here.
 *
 * `global.fetch` is monkey-patched so the suite never hits real Slack.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __resetSlackAuthBreakerForTest,
  __resetSlackTokenCacheForTest,
  __setSlackAuthStateForTest,
  getSlackAuthState,
  probeConnection,
} from "../server/services/slackIntegration";

const originalFetch: typeof fetch = global.fetch;
let originalSlackBotToken: string | null | undefined;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api")) {
    if (fetchHandler) return fetchHandler(url, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetSlackAuthBreakerForTest();
  fetchHandler = null;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetSlackAuthBreakerForTest();
    fetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Slack probe classification regression (Task #1876)");

  // Snapshot + seed slack_bot_token.
  const prior = await storage.getSystemSetting("slack_bot_token").catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;
  await storage.setSystemSetting("slack_bot_token", "xoxb-test-fake", "system");

  // ── Group 1 — confirmed missing token returns unauthorized ───────
  await step("Group 1 — missing token returns unauthorized/no_token_stored", async () => {
    await storage.setSystemSetting("slack_bot_token", "", "system");
    const r = await probeConnection();
    assert.equal(r.outcome, "unauthorized");
    assert.equal(r.reason, "no_token_stored");
    await storage.setSystemSetting("slack_bot_token", "xoxb-test-fake", "system");
  });

  // ── Group 2 — every terminal auth code → unauthorized ────────────
  const TERMINAL = ["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed", "invalid_token"];
  for (const code of TERMINAL) {
    await step(`Group 2 — terminal "${code}" returns unauthorized`, async () => {
      fetchHandler = async () => jsonResponse({ ok: false, error: code });
      const r = await probeConnection();
      assert.equal(r.outcome, "unauthorized", `outcome should be unauthorized for ${code}`);
      assert.equal(r.reason, code, `reason should carry ${code}`);
    });
  }

  // ── Group 3 — transient failures → probe_failed ──────────────────
  await step("Group 3 — HTTP 500 returns probe_failed (badge preserved)", async () => {
    fetchHandler = async () => new Response("internal", { status: 500 });
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed");
    assert.equal(getSlackAuthState().authBroken, false, "breaker must not trip on 5xx");
  });

  await step("Group 3 — network error returns probe_failed", async () => {
    fetchHandler = async () => { throw new Error("ECONNREFUSED simulated"); };
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed");
    assert.equal(getSlackAuthState().authBroken, false);
  });

  await step("Group 3 — HTML error body returns probe_failed", async () => {
    fetchHandler = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed");
  });

  await step("Group 3 — missing_scope is transient for the badge (not unauthorized)", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "missing_scope" });
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed", "missing_scope must not flip the badge to Not Connected");
  });

  await step("Group 3 — no_permission is transient for the badge", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "no_permission" });
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed");
  });

  await step("Group 3 — unknown ok:false with no error field is transient", async () => {
    fetchHandler = async () => jsonResponse({ ok: false });
    const r = await probeConnection();
    assert.equal(r.outcome, "probe_failed");
  });

  // ── Group 4 — successful auth.test recovers the breaker immediately
  await step("Group 4 — auth.test succeeds while breaker is open → connected, breaker clears", async () => {
    // Simulate an already-open breaker (no need to actually trip it).
    __setSlackAuthStateForTest({
      breakerOpenUntilMs: Date.now() + 5 * 60_000,
      lastTrippedCode: "invalid_auth",
      lastTrippedAtMs: Date.now() - 1000,
      tripCount: 1,
    });
    assert.equal(getSlackAuthState().breakerOpen, true, "precondition: breaker is open");

    fetchHandler = async () => jsonResponse({ ok: true, team: "TestTeam", user: "U1", team_id: "T1" });
    const r = await probeConnection();
    assert.equal(r.outcome, "connected", "probe must recover without waiting out the cooldown");
    assert.equal(r.team, "TestTeam");
    assert.equal(getSlackAuthState().breakerOpen, false, "successful auth.test must clear the breaker");
  });

  // ── Task #2115 — distinguish "confirmed no token" from "couldn't read
  // the token". A degraded-DB settings read that THROWS must never be
  // mis-resolved as `no_token_stored` (which flips the badge); it must
  // surface `probe_failed` (preserve) or recover from the in-process
  // last-good. Mirrors the Stripe/PandaDoc/Drive throw-path tests.
  await step("Task #2115 — read throws WITH last-good → connected (resilient)", async () => {
    __resetSlackTokenCacheForTest();
    // Prime the in-process last-good from a healthy probe.
    fetchHandler = async () => jsonResponse({ ok: true, team: "PrimedTeam" });
    const primed = await probeConnection();
    assert.equal(primed.outcome, "connected", "precondition: healthy probe primes last-good");
    // Now simulate the production settings read failing mid-probe.
    const origGet = (storage as any).getSystemSetting;
    (storage as any).getSystemSetting = async () => {
      throw new Error("Connection terminated unexpectedly");
    };
    try {
      const r = await probeConnection();
      assert.equal(
        r.outcome,
        "connected",
        `should fall back to last-good (got ${r.outcome}/${r.reason})`,
      );
    } finally {
      (storage as any).getSystemSetting = origGet;
    }
  });

  await step("Task #2115 — read throws WITHOUT last-good → probe_failed (not no_token_stored)", async () => {
    __resetSlackTokenCacheForTest();
    const origGet = (storage as any).getSystemSetting;
    (storage as any).getSystemSetting = async () => {
      throw new Error("DB latency exceeds critical threshold");
    };
    try {
      const r = await probeConnection();
      assert.equal(
        r.outcome,
        "probe_failed",
        `degraded-DB read must not flip to no_token_stored (got ${r.outcome}/${r.reason})`,
      );
      assert.ok(
        /token_lookup_failed/.test(r.reason ?? ""),
        `reason should mention token_lookup_failed (got: ${r.reason})`,
      );
    } finally {
      (storage as any).getSystemSetting = origGet;
    }
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll Slack probe classification tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    global.fetch = originalFetch;
    try {
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting("slack_bot_token");
      } else {
        await storage.setSystemSetting("slack_bot_token", originalSlackBotToken ?? "", "system");
      }
    } catch {}
    process.exitCode = exitCode;
  });
