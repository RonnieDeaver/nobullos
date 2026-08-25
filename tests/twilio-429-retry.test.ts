/* test-registration
{
  "name": "Twilio HTTP 429 bounded retry matrix (audit B-004, Task #3896)",
  "regression": true,
  "sweepOnlyReason": "Mixed suite: DB-free twilio-node RequestClient retry matrix (scripted axios adapter + patched setTimeout) plus tx-sandbox assertions that the REAL getTwilioClient() construction carries autoRetry/maxRetries/maxRetryDelay. Runs in the full suite and the nightly --regression sweep; DB-backed parts keep it out of the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3896 (audit B-004): outbound Twilio REST calls get bounded
// exponential-backoff retry for HTTP 429 ONLY, via the SDK's official
// `autoRetry` mechanism (twilio-node 5.x, lib/base/RequestClient.js):
//
//   - retry happens ONLY when the HTTP response status is exactly 429;
//   - 400/401/403/404, generic 5xx → exactly ONE attempt (fail fast);
//   - network-level failures (timeout, connection reset) are promise
//     rejections that BYPASS the response interceptor → never retried
//     (ambiguous outcomes must not be re-driven — the create may have
//     landed at Twilio);
//   - attempts are capped at 1 + maxRetries (we configure maxRetries=3 →
//     max 4 HTTP attempts per logical operation, the documented maximum;
//     the service layer adds NO retry loop of its own, so there is exactly
//     ONE retry layer);
//   - per-retry delay is full-jitter: floor(min(maxRetryDelay, 100·2^n) ·
//     random()) → worst-case added latency 200+400+800 = 1400ms at the
//     default 3000ms cap.
//
// Everything is hermetic: the RequestClient's axios adapter is replaced with
// a scripted fake (no sockets), global setTimeout is patched to capture
// delays and fire immediately, and the DB-backed parts run in the tx sandbox.
//
// Usage: npm test -- --file=tests/twilio-429-retry.test.ts

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  sendSms,
  getTwilioClient,
  __setTwilioClientFactoryForTests,
  TwilioOutboundOperationError,
  TWILIO_HTTP_MAX_429_RETRIES,
  TWILIO_HTTP_MAX_RETRY_DELAY_MS,
} from "../server/services/twilioService";
import { getTwilioMessage } from "../server/storage/twilioStorage";
import { systemSettings, twilioConversations, users } from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Scripted RequestClient harness (DB-free).
// ---------------------------------------------------------------------------

type ScriptStep =
  | { status: number; data?: unknown }
  | { reject: true; err: Error };

interface ScriptedClient {
  request: (opts: Record<string, unknown>) => Promise<{ statusCode: number }>;
}

async function makeScriptedRequestClient(
  opts: Record<string, unknown>,
  script: ScriptStep[],
  attempts: Array<{ url?: string }>,
): Promise<ScriptedClient> {
  // twilio has no package-exports map, so the deep CJS path is importable.
  const mod: { default?: unknown } = await import("twilio/lib/base/RequestClient.js");
  const RequestClient = (mod.default ?? mod) as new (o: Record<string, unknown>) => ScriptedClient & {
    axios: { defaults: { adapter: unknown } };
  };
  const rc = new RequestClient(opts);
  rc.axios.defaults.adapter = async (config: { url?: string }) => {
    attempts.push({ url: config.url });
    const step = script.shift();
    if (!step) throw new Error("test script exhausted — more HTTP attempts than scripted");
    if ("reject" in step) throw step.err;
    return {
      status: step.status,
      statusText: String(step.status),
      data: step.data ?? { message: `scripted ${step.status}` },
      headers: {},
      config,
    };
  };
  return rc;
}

const REQ = {
  method: "GET",
  uri: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json",
  username: "ACtest",
  password: "authtoken_test",
};

/** Patches global setTimeout to capture requested delays and fire on the
 *  next tick; restores in finally. Only plausible backoff sleeps (≤ the
 *  3000ms maxRetryDelay cap) are intercepted — longer timers (DB pool
 *  watchdogs schedule 30s guards during lazy warmup) pass through REAL and
 *  unrecorded, because fast-firing those kills in-flight pool queries. The
 *  runner also warms the DB before the first capture window (see main()) so
 *  boot-time timers land outside these windows. */
async function withCapturedTimers<T>(delays: number[], fn: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  const patched = ((cb: (...cbArgs: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms !== "number" || ms <= TWILIO_HTTP_MAX_RETRY_DELAY_MS) {
      delays.push(ms ?? 0);
      return real(cb, 0, ...args);
    }
    return real(cb, ms, ...args);
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = patched;
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

// ---------------------------------------------------------------------------
// C1. 429 → 429 → success: retried within bounds, delays follow the
//     full-jitter exponential schedule.
// ---------------------------------------------------------------------------
async function testRetryThenSuccess(): Promise<void> {
  console.log("\n— C1. 429,429,success → 3 attempts, bounded jittered delays —");
  const attempts: Array<{ url?: string }> = [];
  const delays: number[] = [];
  const rc = await makeScriptedRequestClient(
    { autoRetry: true, maxRetries: TWILIO_HTTP_MAX_429_RETRIES, maxRetryDelay: TWILIO_HTTP_MAX_RETRY_DELAY_MS },
    [{ status: 429 }, { status: 429 }, { status: 201, data: { sid: "SMok" } }],
    attempts,
  );
  const res = await withCapturedTimers(delays, () => rc.request(REQ));
  check("final response is the success", res.statusCode === 201, String(res.statusCode));
  check("exactly 3 HTTP attempts", attempts.length === 3, String(attempts.length));
  check("2 backoff sleeps scheduled", delays.length === 2, JSON.stringify(delays));
  check("1st delay within full-jitter bound (≤ 100·2^1)", delays[0] >= 0 && delays[0] <= 200, String(delays[0]));
  check("2nd delay within full-jitter bound (≤ 100·2^2)", delays[1] >= 0 && delays[1] <= 400, String(delays[1]));
}

// ---------------------------------------------------------------------------
// C2. All-429 exhaustion: hard cap at 1 + maxRetries attempts; final result
//     is the 429 (which the SDK then surfaces as a RestException upstream).
// ---------------------------------------------------------------------------
async function testExhaustionCap(): Promise<void> {
  console.log("\n— C2. persistent 429 → capped at 1 + maxRetries attempts —");
  const attempts: Array<{ url?: string }> = [];
  const delays: number[] = [];
  const rc = await makeScriptedRequestClient(
    { autoRetry: true, maxRetries: TWILIO_HTTP_MAX_429_RETRIES, maxRetryDelay: TWILIO_HTTP_MAX_RETRY_DELAY_MS },
    Array.from({ length: 8 }, () => ({ status: 429 })),
    attempts,
  );
  const res = await withCapturedTimers(delays, () => rc.request(REQ));
  check("final response is still 429 after exhaustion", res.statusCode === 429, String(res.statusCode));
  check(
    `attempts hard-capped at ${1 + TWILIO_HTTP_MAX_429_RETRIES} (documented max per logical operation)`,
    attempts.length === 1 + TWILIO_HTTP_MAX_429_RETRIES,
    String(attempts.length),
  );
  check("one sleep per retry", delays.length === TWILIO_HTTP_MAX_429_RETRIES, JSON.stringify(delays));
  const bounds = [200, 400, 800];
  check(
    "every delay within its exponential full-jitter bound",
    delays.every((d, i) => d >= 0 && d <= Math.min(TWILIO_HTTP_MAX_RETRY_DELAY_MS, bounds[i])),
    JSON.stringify(delays),
  );
}

// ---------------------------------------------------------------------------
// C3. Non-retryable statuses: 400/401/403/404/500/503 → exactly one attempt.
// ---------------------------------------------------------------------------
async function testNonRetryableStatuses(): Promise<void> {
  console.log("\n— C3. 4xx / 5xx (≠429) are NEVER retried —");
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const attempts: Array<{ url?: string }> = [];
    const delays: number[] = [];
    const rc = await makeScriptedRequestClient(
      { autoRetry: true, maxRetries: TWILIO_HTTP_MAX_429_RETRIES, maxRetryDelay: TWILIO_HTTP_MAX_RETRY_DELAY_MS },
      // A success is scripted BEHIND the error — if the client retried, it
      // would consume it and the attempt count would betray it.
      [{ status }, { status: 201 }],
      attempts,
    );
    const res = await withCapturedTimers(delays, () => rc.request(REQ));
    check(`HTTP ${status}: exactly 1 attempt, status passed through`, attempts.length === 1 && res.statusCode === status && delays.length === 0, `attempts=${attempts.length} status=${res.statusCode}`);
  }
}

// ---------------------------------------------------------------------------
// C4. Network-level failures (timeout / connection reset) are promise
//     rejections that bypass the retry interceptor — never retried.
// ---------------------------------------------------------------------------
async function testNetworkErrorsNotRetried(): Promise<void> {
  console.log("\n— C4. timeouts / connection resets are NOT retried —");
  for (const [label, err] of [
    ["timeout (ECONNABORTED)", Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" })],
    ["connection reset (ECONNRESET)", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
  ] as const) {
    const attempts: Array<{ url?: string }> = [];
    const delays: number[] = [];
    const rc = await makeScriptedRequestClient(
      { autoRetry: true, maxRetries: TWILIO_HTTP_MAX_429_RETRIES, maxRetryDelay: TWILIO_HTTP_MAX_RETRY_DELAY_MS },
      [{ reject: true, err }, { status: 201 }],
      attempts,
    );
    let rejected: unknown;
    try {
      await withCapturedTimers(delays, () => rc.request(REQ));
    } catch (e) {
      rejected = e;
    }
    check(`${label}: request rejects (ambiguous outcome surfaces)`, rejected instanceof Error, String(rejected));
    check(`${label}: exactly 1 attempt, no sleeps`, attempts.length === 1 && delays.length === 0, `attempts=${attempts.length}`);
  }
}

// ---------------------------------------------------------------------------
// C5. autoRetry off (SDK default) → no retry even on 429; and the
//     maxRetryDelay cap is honored when configured lower.
// ---------------------------------------------------------------------------
async function testAutoRetryOffAndDelayCap(): Promise<void> {
  console.log("\n— C5. autoRetry off = no retries; maxRetryDelay caps the schedule —");
  const attemptsOff: Array<{ url?: string }> = [];
  const delaysOff: number[] = [];
  const rcOff = await makeScriptedRequestClient({}, [{ status: 429 }, { status: 201 }], attemptsOff);
  const resOff = await withCapturedTimers(delaysOff, () => rcOff.request(REQ));
  check("autoRetry off: single attempt, 429 passed through", attemptsOff.length === 1 && resOff.statusCode === 429 && delaysOff.length === 0, `attempts=${attemptsOff.length}`);

  const attemptsCap: Array<{ url?: string }> = [];
  const delaysCap: number[] = [];
  const rcCap = await makeScriptedRequestClient(
    { autoRetry: true, maxRetries: 3, maxRetryDelay: 100 },
    Array.from({ length: 5 }, () => ({ status: 429 })),
    attemptsCap,
  );
  await withCapturedTimers(delaysCap, () => rcCap.request(REQ));
  check("all delays ≤ configured maxRetryDelay cap", delaysCap.length === 3 && delaysCap.every((d) => d <= 100), JSON.stringify(delaysCap));
}

// ---------------------------------------------------------------------------
// C6. The REAL client construction carries the retry configuration — proves
//     production wiring without any HTTP (constructing a client is inert).
// ---------------------------------------------------------------------------
async function testRealClientCarriesRetryConfig(): Promise<void> {
  console.log("\n— C6. getTwilioClient() wires autoRetry into the real SDK client —");
  await runInTxSandbox(async () => {
    const dbi = getDb();
    for (const row of [
      { key: "twilio_account_sid", value: "ACtest_task3896_retry_config" },
      { key: "twilio_auth_token", value: "test_auth_token_task3896_retry" },
      { key: "twilio_phone_numbers", value: JSON.stringify(["+15550100021"]) },
    ]) {
      await dbi
        .insert(systemSettings)
        .values(row)
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: row.value } });
    }
    const { client } = await getTwilioClient();
    const c = client as unknown as { autoRetry?: boolean; maxRetries?: number; maxRetryDelay?: number };
    check("client.autoRetry === true", c.autoRetry === true, String(c.autoRetry));
    check(
      "client.maxRetries === TWILIO_HTTP_MAX_429_RETRIES (3)",
      c.maxRetries === TWILIO_HTTP_MAX_429_RETRIES && TWILIO_HTTP_MAX_429_RETRIES === 3,
      String(c.maxRetries),
    );
    check(
      "client.maxRetryDelay === TWILIO_HTTP_MAX_RETRY_DELAY_MS (3000)",
      c.maxRetryDelay === TWILIO_HTTP_MAX_RETRY_DELAY_MS && TWILIO_HTTP_MAX_RETRY_DELAY_MS === 3000,
      String(c.maxRetryDelay),
    );
  });
}

// ---------------------------------------------------------------------------
// C7. Single retry layer: when the SDK surfaces a final 429 RestException,
//     the service makes exactly ONE create call (no nested retry loop) and
//     preserves the Twilio error classification on the failed row.
// ---------------------------------------------------------------------------
async function testServiceAddsNoSecondRetryLayer(): Promise<void> {
  console.log("\n— C7. service layer adds NO second retry layer on 429 exhaustion —");
  await runInTxSandbox(async () => {
    const dbi = getDb();
    for (const row of [
      { key: "twilio_account_sid", value: "ACtest_task3896_single_layer" },
      { key: "twilio_auth_token", value: "test_auth_token_task3896_layer" },
      { key: "twilio_phone_numbers", value: JSON.stringify(["+15550100031"]) },
    ]) {
      await dbi
        .insert(systemSettings)
        .values(row)
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: row.value } });
    }
    const [user] = await dbi
      .insert(users)
      .values({ email: `task3896-layer-${Date.now()}@example.test`, role: "account_manager" })
      .returning();
    const [conv] = await dbi
      .insert(twilioConversations)
      .values({ contactPhone: "+15550100032", twilioPhoneNumber: "+15550100031", status: "active" })
      .returning();

    let createCalls = 0;
    __setTwilioClientFactoryForTests(() => ({
      messages: {
        create: async () => {
          createCalls++;
          // Shape of the SDK's RestException after autoRetry exhaustion.
          throw Object.assign(new Error("Too Many Requests"), {
            status: 429,
            code: 20429,
            moreInfo: "https://www.twilio.com/docs/errors/20429",
          });
        },
      },
    }));
    const opId = randomUUID();
    try {
      let thrown: unknown;
      try {
        await sendSms({ to: "+15550100032", body: "rate limit test", userId: user.id, conversationId: conv.id, operationId: opId });
      } catch (err) {
        thrown = err;
      }
      check("create called exactly once by the service (SDK owns the ONLY retry loop)", createCalls === 1, String(createCalls));
      check(
        "final error preserves Twilio 429 classification",
        thrown instanceof TwilioOutboundOperationError && thrown.message.startsWith("[HTTP 429 / Twilio code 20429]"),
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      const row = await getTwilioMessage(opId);
      check("failed row records errorCode 20429 (investigable, not silently retried)", row?.status === "failed" && row?.errorCode === "20429", `status=${row?.status} code=${row?.errorCode}`);
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio 429 bounded-retry matrix (audit B-004, Task #3896)");

  // Force the lazy DB pool warmup + kill-switch load to finish BEFORE any
  // setTimeout capture window opens, so their timers can't pollute the
  // captured backoff delays.
  await getDb().execute(sql`select 1`);

  await testRetryThenSuccess();
  await testExhaustionCap();
  await testNonRetryableStatuses();
  await testNetworkErrorsNotRetried();
  await testAutoRetryOffAndDelayCap();
  await testRealClientCarriesRetryConfig();
  await testServiceAddsNoSecondRetryLayer();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Natural drain (Task #2084 convention — no manual process.exit()).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
