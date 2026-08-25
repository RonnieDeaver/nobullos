/* test-registration
{
  "name": "Feedback \u2192 Slack auto-resend operator routes (Task #2128)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2128 — cover the feedback → Slack auto-resend operator endpoints
 * (Task #2075) with automated tests:
 *
 *   GET  /api/feedback/slack-retry/status   (isAuthenticated + requireTeamLead)
 *   POST /api/feedback/slack-retry/run      (isAuthenticated + requireTeamLead)
 *
 * The sibling Task #2074 test (`feedback-slack-retry.test.ts`) already
 * exercises the tick service itself (gating no-ops, candidate selection,
 * relay outcomes). This file pins the HTTP surface operators press:
 *
 *   1. Auth: both routes reject non-team-lead callers
 *      (401 anon, 403 account_manager) and never run a tick / post to
 *      Slack when rejected.
 *   2. Status: GET returns { config, lastRun } where `config` exactly
 *      matches `getFeedbackSlackRetryConfig()` (enabled + bounding knobs)
 *      and `lastRun` surfaces the persisted last-run summary once a tick
 *      has run.
 *   3. Run-now honors the gates without posting to Slack:
 *        - disabled (default OFF) → { ok, result } where result is a
 *          no-op tick with a /disabled/ reason and zero Slack posts.
 *        - KILL_SWITCH_NON_CRITICAL_SWEEPS on (even with the master
 *          switch enabled) → a no-op tick with the kill-switch reason and
 *          zero Slack posts.
 *
 * Slack is mocked at `global.fetch` and a post counter proves the no-op
 * paths never reach `chat.postMessage`. The route registration under test
 * is the REAL `registerFeedbackSlackRetryRoutes` mounted on a bare
 * Express app, with the REAL `isAuthenticated` + `requireTeamLead`
 * middleware — only auth identity is injected per request.
 */
// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { __resetSlackAuthBreakerForTest } from "../server/services/slackIntegration";
import { registerFeedbackSlackRetryRoutes } from "../server/routes/feedbackSlackRetry";
import {
  getFeedbackSlackRetryConfig,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  SETTING_BACKOFF_MINUTES,
  SETTING_LAST_RUN,
} from "../server/services/feedbackSlackRetry";

const TAG = "task-2128";
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;
const SLACK_TOKEN_KEY = "slack_bot_token";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── Slack fetch mock with a post counter ─────────────────────────────
const originalFetch: typeof fetch = global.fetch;
let originalSlackBotToken: string | null | undefined;
let postMessageCalls = 0;
// When true, the mocked `auth.test` probe reports an unauthorized Slack so
// a tick that reaches the connectivity gate no-ops with a "not connected"
// reason (without ever fanning out to candidate rows or posting).
let slackDown = false;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input))
    return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api/chat.postMessage")) {
    postMessageCalls += 1;
    return jsonResponse({ ok: true });
  }
  if (url.includes("slack.com/api/auth.test"))
    return slackDown
      ? jsonResponse({ ok: false, error: "invalid_auth" })
      : jsonResponse({ ok: true, team: "Acme", user: "U1", team_id: "T1" });
  if (url.includes("slack.com/api")) return jsonResponse({ ok: true });
  return originalFetch(input as any, init);
}) as any;

// ── Synthetic users (real requireTeamLead reads storage.getUser) ─────
async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${`${TAG} TL`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${`${TAG} AM`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

async function resetSettings(): Promise<void> {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_BACKOFF_MINUTES).catch(() => {});
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  _resetQueueDrainStateForTests();
}

// ── Bare Express app with the REAL routes; auth identity injected per
//    request via the x-test-actor header (anon when absent). ──────────
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): actor id string
    // authenticates as that user (real requireTeamLead reads the committed
    // users seed); absent header → null → anonymous 401.
    const actor = String(req.headers["x-test-actor"] ?? "");
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerFeedbackSlackRetryRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  actor: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  postMessageCalls = 0;
  slackDown = false;
  __resetSlackAuthBreakerForTest();
  await resetSettings();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    slackDown = false;
    __resetSlackAuthBreakerForTest();
    await resetSettings();
  }
}

async function main(): Promise<void> {
  console.log("Feedback → Slack auto-resend routes (Task #2128)");

  await ensureUsers();

  const prior = await storage.getSystemSetting(SLACK_TOKEN_KEY).catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;
  // A non-empty token so any probe that IS reached would actually probe
  // instead of short-circuiting to no_token_stored. The no-op paths under
  // test return before probing, so this only guards against accidental
  // short-circuits masking a regression.
  await storage.setSystemSetting(SLACK_TOKEN_KEY, "xoxb-task-2128-fake", "system");

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  const STATUS = "/api/feedback/slack-retry/status";
  const RUN = "/api/feedback/slack-retry/run";
  const CONFIG = "/api/feedback/slack-retry/config";

  try {
    // ── (1) Auth gates on both routes ────────────────────────────────
    await step("auth: 401 anon, 403 account_manager on both routes", async () => {
      const sAnon = await call(baseUrl, "GET", STATUS, null);
      assertEq(sAnon.status, 401, "GET status anon → 401");
      const rAnon = await call(baseUrl, "POST", RUN, null);
      assertEq(rAnon.status, 401, "POST run anon → 401");

      const sAm = await call(baseUrl, "GET", STATUS, AM_ID);
      assertEq(sAm.status, 403, "GET status account_manager → 403");
      const rAm = await call(baseUrl, "POST", RUN, AM_ID);
      assertEq(rAm.status, 403, "POST run account_manager → 403");

      assertEq(
        postMessageCalls,
        0,
        "a rejected caller must never run a tick / post to Slack",
      );
    });

    // ── (2) Status shape: config mirrors getFeedbackSlackRetryConfig() ─
    await step("status: returns { config, lastRun }; config matches the service", async () => {
      // Known, non-default config so we prove the readout reflects
      // system_settings rather than hard-coded defaults.
      await setSystemSetting(SETTING_ENABLED, "true", "test");
      await setSystemSetting(SETTING_MAX_PER_TICK, "7", "test");
      await setSystemSetting(SETTING_BACKOFF_MINUTES, "20", "test");

      const expected = await getFeedbackSlackRetryConfig();

      const r = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(r.status, 200, "GET status team_lead → 200");
      assert.ok(r.body && typeof r.body === "object", "body is an object");
      assert.ok("config" in r.body, "body has a config key");
      assert.ok("lastRun" in r.body, "body has a lastRun key");

      assert.deepEqual(
        r.body.config,
        expected,
        "status config matches getFeedbackSlackRetryConfig()",
      );
      assertEq(r.body.config.enabled, true, "config.enabled reflects the setting");
      assertEq(r.body.config.maxPerTick, 7, "config.maxPerTick reflects the setting");
      assertEq(
        r.body.config.backoffMinutes,
        20,
        "config.backoffMinutes reflects the setting",
      );
      assert.equal(
        typeof r.body.config.tickIntervalMinutes,
        "number",
        "config carries tickIntervalMinutes",
      );

      // No tick was run yet in this isolated step → lastRun is null and
      // the classify signal (Task #2198) reports never_run, not unreadable.
      assertEq(r.body.lastRun, null, "lastRun null before any tick has run");
      assertEq(
        r.body.lastRunStatus,
        "never_run",
        "lastRunStatus is never_run before any tick has run",
      );
      assert.ok(
        !("lastRunError" in r.body),
        "never_run must not carry a lastRunError",
      );
      assertEq(postMessageCalls, 0, "reading status never posts to Slack");
    });

    // ── (2b) Status classify: unreadable when the stored value is corrupt ─
    await step("status: corrupt last-run → lastRunStatus unreadable + error", async () => {
      // Persist a non-JSON value directly so the reader's parse fails.
      await setSystemSetting(SETTING_LAST_RUN, "{not json", "test");

      const r = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(r.status, 200, "GET status team_lead → 200");
      // Contract preserved: lastRun stays null on an unreadable value.
      assertEq(r.body.lastRun, null, "unreadable keeps lastRun null");
      assertEq(
        r.body.lastRunStatus,
        "unreadable",
        "lastRunStatus is unreadable when the stored value won't parse",
      );
      assert.ok(
        typeof r.body.lastRunError === "string" && r.body.lastRunError.length > 0,
        "unreadable carries a plain-English lastRunError",
      );
      assertEq(postMessageCalls, 0, "reading status never posts to Slack");
    });

    // ── (3) Run-now disabled (default OFF) → no-op, no Slack post ─────
    await step("run: disabled → { ok, result } no-op with /disabled/ reason; lastRun surfaced", async () => {
      // SETTING_ENABLED deleted by resetSettings → default OFF.
      const r = await call(baseUrl, "POST", RUN, TL_ID);
      assertEq(r.status, 200, "POST run team_lead → 200");
      assertEq(r.body?.ok, true, "response carries ok:true");
      const result = r.body?.result;
      assert.ok(result && typeof result === "object", "response carries a result");
      assertEq(result.enabled, false, "tick reports disabled");
      assertEq(result.candidates, 0, "no candidates while disabled");
      assert.ok(
        Array.isArray(result.attempted) && result.attempted.length === 0,
        "no rows attempted while disabled",
      );
      assert.match(result.reason ?? "", /disabled/i, "reason mentions disabled");
      assertEq(postMessageCalls, 0, "disabled run never posts to Slack");

      // The disabled tick persisted its summary → status now surfaces it.
      const s = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(s.status, 200, "GET status after run → 200");
      assert.ok(s.body?.lastRun, "lastRun is populated after a run");
      assertEq(
        s.body.lastRunStatus,
        "ok",
        "lastRunStatus is ok once a tick has persisted a readable summary",
      );
      assert.ok(
        !("lastRunError" in s.body),
        "an ok readout must not carry a lastRunError",
      );
      assertEq(
        s.body.lastRun.enabled,
        false,
        "lastRun reflects the disabled no-op tick",
      );
      assertEq(
        s.body.lastRun.ranAt,
        result.ranAt,
        "lastRun is the summary the run-now just produced",
      );
    });

    // ── (3b) Run-now queue-paused (master switch enabled) → no-op ────
    await step("run: queue paused → no-op with /paused/ reason, no Slack post", async () => {
      await setSystemSetting(SETTING_ENABLED, "true", "test");
      await setQueuePause("feedback_slack_retry", true, "task-2128-test");
      try {
        const r = await call(baseUrl, "POST", RUN, TL_ID);
        assertEq(r.status, 200, "POST run team_lead → 200");
        assertEq(r.body?.ok, true, "response carries ok:true");
        const result = r.body?.result;
        assertEq(result.paused, true, "tick reports paused");
        assertEq(result.candidates, 0, "no candidates while paused");
        assert.match(result.reason ?? "", /paused/i, "reason mentions paused");
        assertEq(postMessageCalls, 0, "paused run never posts to Slack");
      } finally {
        await setQueuePause("feedback_slack_retry", false, "task-2128-test").catch(
          () => {},
        );
        _resetQueueDrainStateForTests();
      }
    });

    // ── (3c) Run-now Slack down (probe unauthorized) → no-op ─────────
    await step("run: Slack down → no-op with /not connected/ reason, no Slack post", async () => {
      await setSystemSetting(SETTING_ENABLED, "true", "test");
      slackDown = true;
      const r = await call(baseUrl, "POST", RUN, TL_ID);
      assertEq(r.status, 200, "POST run team_lead → 200");
      assertEq(r.body?.ok, true, "response carries ok:true");
      const result = r.body?.result;
      assertEq(result.connected, false, "tick reports not connected");
      assertEq(result.candidates, 0, "no candidates while Slack down");
      assert.match(
        result.reason ?? "",
        /not connected/i,
        "reason mentions Slack not connected",
      );
      assertEq(postMessageCalls, 0, "a down-Slack run never posts a message");
    });

    // ── (4) Run-now kill-switch on (master switch enabled) → no-op ───
    await step("run: kill switch → no-op with kill-switch reason, no Slack post", async () => {
      await setSystemSetting(SETTING_ENABLED, "true", "test");
      const priorKill = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
      (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
      try {
        const r = await call(baseUrl, "POST", RUN, TL_ID);
        assertEq(r.status, 200, "POST run team_lead → 200");
        assertEq(r.body?.ok, true, "response carries ok:true");
        const result = r.body?.result;
        assertEq(result.candidates, 0, "no candidates while killed");
        assert.ok(
          Array.isArray(result.attempted) && result.attempted.length === 0,
          "no rows attempted while killed",
        );
        assert.match(
          result.reason ?? "",
          /KILL_SWITCH_NON_CRITICAL_SWEEPS/,
          "reason names the kill switch",
        );
        assertEq(postMessageCalls, 0, "killed run never posts to Slack");
      } finally {
        (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = priorKill;
      }
    });

    // ── (5) Config PUT — auth gates ──────────────────────────────────
    await step("config: 401 anon, 403 account_manager on PUT", async () => {
      const pAnon = await call(baseUrl, "PUT", CONFIG, null, {
        enabled: true,
      });
      assertEq(pAnon.status, 401, "PUT config anon → 401");
      const pAm = await call(baseUrl, "PUT", CONFIG, AM_ID, { enabled: true });
      assertEq(pAm.status, 403, "PUT config account_manager → 403");
      // Neither write should have flipped the master switch.
      const cfg = await getFeedbackSlackRetryConfig();
      assertEq(cfg.enabled, false, "rejected PUT never enabled the switch");
    });

    // ── (6) Config PUT — toggle persists + re-reads ──────────────────
    await step("config: PUT enabled persists and re-reads via the service", async () => {
      const r = await call(baseUrl, "PUT", CONFIG, TL_ID, { enabled: true });
      assertEq(r.status, 200, "PUT config team_lead → 200");
      assertEq(r.body?.ok, true, "response carries ok:true");
      assertEq(r.body?.config?.enabled, true, "returned config reflects enabled");
      const cfg = await getFeedbackSlackRetryConfig();
      assertEq(cfg.enabled, true, "service re-read confirms enabled persisted");

      const off = await call(baseUrl, "PUT", CONFIG, TL_ID, { enabled: false });
      assertEq(off.body?.config?.enabled, false, "PUT false disables again");
    });

    // ── (7) Config PUT — tuning knobs persist within caps ────────────
    await step("config: PUT maxPerTick + backoffMinutes persist within caps", async () => {
      const r = await call(baseUrl, "PUT", CONFIG, TL_ID, {
        maxPerTick: 42,
        backoffMinutes: 7,
      });
      assertEq(r.status, 200, "PUT config team_lead → 200");
      assertEq(r.body?.config?.maxPerTick, 42, "returned config has new maxPerTick");
      assertEq(
        r.body?.config?.backoffMinutes,
        7,
        "returned config has new backoffMinutes",
      );
      const cfg = await getFeedbackSlackRetryConfig();
      assertEq(cfg.maxPerTick, 42, "service re-read confirms maxPerTick");
      assertEq(cfg.backoffMinutes, 7, "service re-read confirms backoffMinutes");
    });

    // ── (8) Config PUT — validation rejects out-of-range + empty ─────
    await step("config: PUT rejects out-of-cap values and empty body (400)", async () => {
      const tooBig = await call(baseUrl, "PUT", CONFIG, TL_ID, {
        maxPerTick: 9999,
      });
      assertEq(tooBig.status, 400, "maxPerTick over cap → 400");
      const negative = await call(baseUrl, "PUT", CONFIG, TL_ID, {
        backoffMinutes: -1,
      });
      assertEq(negative.status, 400, "negative backoffMinutes → 400");
      const notBool = await call(baseUrl, "PUT", CONFIG, TL_ID, {
        enabled: "yes",
      });
      assertEq(notBool.status, 400, "non-boolean enabled → 400");
      const empty = await call(baseUrl, "PUT", CONFIG, TL_ID, {});
      assertEq(empty.status, 400, "empty body → 400");
      // A rejected PUT must not have mutated the defaults.
      const cfg = await getFeedbackSlackRetryConfig();
      assertEq(cfg.enabled, false, "rejected PUT left enabled at default");
    });

    if (failures > 0) throw new Error(`${failures} test(s) failed`);
    console.log("\nAll feedback → Slack auto-resend route tests passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
      await resetSettings();
    } catch {}
    try {
      await cleanupUsers();
    } catch {}
    try {
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting(SLACK_TOKEN_KEY);
      } else {
        await storage.setSystemSetting(
          SLACK_TOKEN_KEY,
          originalSlackBotToken ?? "",
          "system",
        );
      }
    } catch {}
    process.exitCode = exitCode;
  });
