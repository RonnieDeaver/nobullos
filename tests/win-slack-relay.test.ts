/* test-registration
{
  "name": "Win Progress \u2192 Slack #general relay (Task #4985)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4985: guards the new cross-module wire (intel-feed create route \u2192 fire-and-forget win relay \u2192 chat.postMessage) end to end with Slack fully fetch-stubbed and the hermetic per-run test DB; deterministic via the relay's drain seam (no settle timers) and seconds-scale like the sibling feedback-slack-relay smoke slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #4985 — logging a "Win Progress" entry announces to Slack #general.
 *
 * Exercises the REAL creation route (`POST /api/clients/:id/intelligence-feed`,
 * auth gates included) plus the REAL relay (`winSlackRelay.ts` +
 * `slackIntegration.ts`) with `global.fetch` monkey-patched for slack.com —
 * mirroring the Task #2065 feedback-relay suite. Covers:
 *
 *   1. A win on an active client posts EXACTLY once to the resolved
 *      #general channel with title + firm name + author + body excerpt;
 *      the channel id is cached across wins (one conversations.list).
 *      Resolution is exact-name match — a "general-announcements" decoy
 *      listed first must not win.
 *   2. Other entry types post nothing; demo and archived clients post
 *      nothing (Win Feed / weekly win-tracker semantics) — yet all still 201.
 *   3. Slack failing (post error or dead auth) never fails creation: the
 *      route still returns 201 and exactly ONE best-effort attempt is made
 *      (no retry).
 *   4. channel_not_found on post clears the cached id so the next win
 *      re-resolves; a listing without #general maps to the plain-English
 *      channel_not_found reason.
 *   5. Unit: message building (excerpt truncation) + author-name fallbacks
 *      + kick gating for retracted-on-create entries and missing clients.
 *
 * Background completion is awaited via the relay's drain seam
 * (`__test_drainPendingWinRelays`) — no settle timers. Rows are seeded in
 * the hermetic per-run test DB under random-suffix ids and cleaned up.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __resetSlackAuthBreakerForTest,
  plainEnglishSlackReason,
} from "../server/services/slackIntegration";
import {
  relayWinToSlack,
  kickWinProgressSlackRelay,
  buildWinSlackMessage,
  formatWinAuthorName,
  __resetWinSlackStateForTest,
  __test_drainPendingWinRelays,
  WIN_BODY_EXCERPT_MAX,
} from "../server/services/winSlackRelay";
import { registerCommandCenterRoutes } from "../server/routes/commandCenter";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = randomUUID().slice(0, 8);
const AM_ID = `test-4985-am-${RUN}`;
const C_ACTIVE = `test-4985-client-active-${RUN}`;
const C_DEMO = `test-4985-client-demo-${RUN}`;
const C_ARCHIVED = `test-4985-client-archived-${RUN}`;
const FIRM_ACTIVE = `Firm Winners ${RUN}`;
const SLACK_TOKEN_KEY = "slack_bot_token";

const originalFetch: typeof fetch = global.fetch;
let originalSlackBotToken: string | null | undefined;

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

// Per-endpoint Slack handlers, overridable per test case. Defaults model
// the happy path. The decoy channel is listed FIRST to prove exact-name
// resolution (substring/find-first would grab it).
type SlackHandler = () => Response | Promise<Response>;
interface SlackRoutes {
  authTest: SlackHandler;
  conversationsList: SlackHandler;
  postMessage: SlackHandler;
}

const DEFAULT_ROUTES: SlackRoutes = {
  authTest: () => jsonResponse({ ok: true, team: "Acme", user: "U1", team_id: "T1" }),
  conversationsList: () =>
    jsonResponse({
      ok: true,
      channels: [
        { id: "C_DECOY", name: "general-announcements", is_member: true },
        { id: "C_GENERAL", name: "general", is_member: true },
      ],
    }),
  postMessage: () => jsonResponse({ ok: true }),
};

let routes: SlackRoutes = { ...DEFAULT_ROUTES };
// Every chat.postMessage attempt (parsed JSON body), captured BEFORE the
// stubbed response — failed attempts count too (single-attempt asserts).
let postedMessages: Array<{ channel?: string; text?: string }> = [];
let listCalls = 0;

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api/auth.test")) return routes.authTest();
  if (url.includes("slack.com/api/conversations.list")) {
    listCalls += 1;
    return routes.conversationsList();
  }
  if (url.includes("slack.com/api/chat.postMessage")) {
    try {
      postedMessages.push(JSON.parse(String(init?.body ?? "{}")));
    } catch {
      postedMessages.push({});
    }
    return routes.postMessage();
  }
  if (url.includes("slack.com/api")) return jsonResponse({ ok: true });
  return originalFetch(input as any, init);
}) as any;

// ── HTTP harness (real command-center routes, Clerk test seam) ──────────────

function buildApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerCommandCenterRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postEntry(
  baseUrl: string,
  clientId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/clients/${clientId}/intelligence-feed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

// ── Seeding / cleanup (hermetic per-run DB, public schema) ──────────────────

async function seedRows(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name, last_name, email)
    VALUES (${AM_ID}, 'account_manager', 'core', 'Alice', 'Alpha', ${`alice-4985-${RUN}@test.local`})
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_ACTIVE}, ${FIRM_ACTIVE}, ${AM_ID}, false, false),
      (${C_DEMO}, ${`Firm Demo ${RUN}`}, ${AM_ID}, false, true),
      (${C_ARCHIVED}, ${`Firm Archived ${RUN}`}, ${AM_ID}, true, false)
  `);
}

async function cleanupRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM intelligence_feed_entries
    WHERE client_id IN (${C_ACTIVE}, ${C_DEMO}, ${C_ARCHIVED})
  `);
  await db.execute(sql`
    DELETE FROM clients WHERE id IN (${C_ACTIVE}, ${C_DEMO}, ${C_ARCHIVED})
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ${AM_ID}`);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  // Fresh breaker + relay channel cache + default handlers + captures per case.
  __resetSlackAuthBreakerForTest();
  __resetWinSlackStateForTest();
  routes = { ...DEFAULT_ROUTES };
  postedMessages = [];
  listCalls = 0;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetSlackAuthBreakerForTest();
    __resetWinSlackStateForTest();
    routes = { ...DEFAULT_ROUTES };
  }
}

const RELAY_ARGS = {
  title: "Direct relay win",
  body: "Body for direct relay",
  firmName: "Direct Firm",
  authorName: "Direct Author",
};

async function main(): Promise<void> {
  console.log("Win Progress → Slack #general relay (Task #4985)");

  const prior = await storage.getSystemSetting(SLACK_TOKEN_KEY).catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;
  // A non-empty token so probeConnection actually probes (auth.test)
  // instead of short-circuiting to no_token_stored.
  await storage.setSystemSetting(SLACK_TOKEN_KEY, "xoxb-task-4985-fake", "system");

  await cleanupRows();
  await seedRows();
  __test_markUserReconciled(AM_ID, {
    id: AM_ID,
    firstName: "Alice",
    lastName: "Alpha",
    role: "account_manager",
  });

  const { server, baseUrl } = await listen(buildApp(AM_ID));
  try {
    // ── (1) win on active client → exactly one post, cached channel ─────
    await step("win on active client posts exactly once (title/firm/author/excerpt)", async () => {
      const title = `Big win ${RUN}`;
      const body = "Client signed the annual retainer — kickoff booked.";
      const r = await postEntry(baseUrl, C_ACTIVE, {
        entryType: "win_progress",
        title,
        body,
      });
      assert.equal(r.status, 201, `create should 201 (got ${r.status}: ${JSON.stringify(r.body)})`);
      assert.ok(r.body?.id, "created entry should carry an id");
      await __test_drainPendingWinRelays();

      assert.equal(postedMessages.length, 1, "exactly one chat.postMessage attempt");
      const msg = postedMessages[0];
      assert.equal(msg.channel, "C_GENERAL", "posted to the exact-name #general id, not the decoy");
      assert.ok(msg.text?.includes(title), "message carries the win title");
      assert.ok(msg.text?.includes(FIRM_ACTIVE), "message carries the client firm name");
      assert.ok(msg.text?.includes("Alice Alpha"), "message names who logged the win");
      assert.ok(msg.text?.includes(body), "message carries the body excerpt");
      assert.equal(listCalls, 1, "channel resolved via conversations.list");

      // Second win reuses the cached channel id — no second listing.
      const r2 = await postEntry(baseUrl, C_ACTIVE, {
        entryType: "win_progress",
        title: `Second win ${RUN}`,
      });
      assert.equal(r2.status, 201);
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 2, "second win posts too");
      assert.equal(listCalls, 1, "channel id cached — conversations.list not re-hit");
    });

    // ── (2a) other entry types post nothing ─────────────────────────────
    await step("non-win entry type creates fine and posts nothing", async () => {
      const r = await postEntry(baseUrl, C_ACTIVE, {
        entryType: "strategy_insight",
        title: `Insight ${RUN}`,
        body: "Not a win.",
      });
      assert.equal(r.status, 201, "strategy_insight still creates");
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 0, "no Slack post for non-win types");
      assert.equal(listCalls, 0, "no channel lookup either");
    });

    // ── (2b) demo client wins post nothing ──────────────────────────────
    await step("demo-client win creates fine and posts nothing", async () => {
      const r = await postEntry(baseUrl, C_DEMO, {
        entryType: "win_progress",
        title: `Demo win ${RUN}`,
      });
      assert.equal(r.status, 201, "demo-client win still creates");
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 0, "no Slack post for demo clients");
    });

    // ── (2c) archived client wins post nothing ──────────────────────────
    await step("archived-client win creates fine and posts nothing", async () => {
      const r = await postEntry(baseUrl, C_ARCHIVED, {
        entryType: "win_progress",
        title: `Archived win ${RUN}`,
      });
      assert.equal(r.status, 201, "archived-client win still creates");
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 0, "no Slack post for archived clients");
    });

    // ── (3a) Slack post failure never fails creation, single attempt ────
    await step("chat.postMessage failure → still 201, exactly one attempt", async () => {
      routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
      const r = await postEntry(baseUrl, C_ACTIVE, {
        entryType: "win_progress",
        title: `Unlucky win ${RUN}`,
        body: "Slack will reject this.",
      });
      assert.equal(r.status, 201, "creation succeeds even when Slack rejects the post");
      assert.ok(r.body?.id, "entry still saved");
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 1, "single best-effort attempt — no retry");
    });

    // ── (3b) dead Slack auth → no attempt, still 201 ────────────────────
    await step("auth.test invalid_auth → still 201, no post attempted", async () => {
      routes.authTest = () => jsonResponse({ ok: false, error: "invalid_auth" });
      const r = await postEntry(baseUrl, C_ACTIVE, {
        entryType: "win_progress",
        title: `Disconnected win ${RUN}`,
      });
      assert.equal(r.status, 201, "creation succeeds while Slack is disconnected");
      await __test_drainPendingWinRelays();
      assert.equal(postedMessages.length, 0, "no chat.postMessage when the probe fails auth");
    });

    // ── (4a) channel_not_found clears the cache → next win re-resolves ──
    await step("channel_not_found on post clears cache; next relay re-resolves", async () => {
      routes.postMessage = () => jsonResponse({ ok: false, error: "channel_not_found" });
      const first = await relayWinToSlack(RELAY_ARGS);
      assert.equal(first.status, "failed");
      assert.equal(first.reason, plainEnglishSlackReason("channel_not_found"));
      assert.equal(listCalls, 1, "first relay resolved the channel once");

      routes.postMessage = DEFAULT_ROUTES.postMessage;
      const second = await relayWinToSlack(RELAY_ARGS);
      assert.equal(second.status, "delivered", "after cache clear the next win delivers");
      assert.equal(listCalls, 2, "cache was cleared — channel re-resolved");
      assert.equal(postedMessages.at(-1)?.channel, "C_GENERAL");
    });

    // ── (4b) listing without #general → plain-English channel_not_found ─
    await step("no #general in the workspace → failed with mapped reason", async () => {
      routes.conversationsList = () =>
        jsonResponse({
          ok: true,
          channels: [{ id: "C_DECOY", name: "general-announcements", is_member: true }],
        });
      const result = await relayWinToSlack(RELAY_ARGS);
      assert.equal(result.status, "failed");
      assert.equal(result.reason, plainEnglishSlackReason("channel_not_found"));
      assert.equal(postedMessages.length, 0, "nothing posted without a resolved channel");
    });

    // ── (5a) message building: excerpt truncation + shape ───────────────
    await step("buildWinSlackMessage truncates long bodies; omits empty ones", async () => {
      const longBody = "x".repeat(WIN_BODY_EXCERPT_MAX + 50);
      const msg = buildWinSlackMessage({
        title: "T",
        body: longBody,
        firmName: "F",
        authorName: "A",
      });
      assert.ok(msg.includes(`>${"x".repeat(WIN_BODY_EXCERPT_MAX)}...`), "long body truncated with ellipsis");
      assert.ok(!msg.includes("x".repeat(WIN_BODY_EXCERPT_MAX + 1)), "no more than the cap survives");
      const noBody = buildWinSlackMessage({ title: "T", body: "  ", firmName: "F", authorName: "A" });
      assert.ok(!noBody.includes(">"), "blank body → no blockquote line");
      assert.ok(noBody.includes("*Win logged:* T") && noBody.includes("*F*"), "title + firm always present");
    });

    // ── (5b) author-name fallbacks ───────────────────────────────────────
    await step("formatWinAuthorName falls back name → email → generic", async () => {
      assert.equal(formatWinAuthorName({ firstName: "Alice", lastName: "Alpha" }), "Alice Alpha");
      assert.equal(formatWinAuthorName({ firstName: null, lastName: null, email: "a@b.co" }), "a@b.co");
      assert.equal(formatWinAuthorName({}), "A team member");
      assert.equal(formatWinAuthorName(null), "A team member");
    });

    // ── (5c) kick gating: retracted entry / missing client / non-win ────
    await step("kick skips retracted entries, missing clients, non-wins", async () => {
      const retracted = await kickWinProgressSlackRelay({
        entry: { entryType: "win_progress", status: "archived", title: "Retracted" },
        client: { firmName: "F", isDemo: false, isArchived: false },
        author: null,
      });
      assert.deepEqual(retracted, { status: "skipped", reason: "entry_archived" });

      const noClient = await kickWinProgressSlackRelay({
        entry: { entryType: "win_progress", status: "approved", title: "Orphan" },
        client: null,
        author: null,
      });
      assert.deepEqual(noClient, { status: "skipped", reason: "client_missing" });

      const nonWin = await kickWinProgressSlackRelay({
        entry: { entryType: "strategy_insight", status: "approved", title: "Insight" },
        client: { firmName: "F" },
        author: null,
      });
      assert.deepEqual(nonWin, { status: "skipped", reason: "not_win_progress" });

      assert.equal(postedMessages.length, 0, "gated kicks never touch Slack");
      assert.equal(listCalls, 0, "gated kicks never resolve the channel");
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll Win → Slack #general relay tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    global.fetch = originalFetch;
    __test_resetReconciledUsers();
    try {
      await cleanupRows();
    } catch {}
    try {
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting(SLACK_TOKEN_KEY);
      } else {
        await storage.setSystemSetting(SLACK_TOKEN_KEY, originalSlackBotToken ?? "", "system");
      }
    } catch {}
    process.exitCode = exitCode;
  });
