/* test-registration
{
  "name": "Twilio outbound route idempotency (Task #3896)",
  "regression": true,
  "sweepOnlyReason": "DB-backed HTTP idempotency matrix for the four outbound send/call routes; runs in the full suite and the nightly --regression sweep alongside the other Task #3896 dispatch-reliability suites, not the routine TEST_SMOKE gate.",
  "timeoutMs": 420000,
  "notes": "Sequential DB-backed HTTP checks; the generous timeout mirrors tests/twilio-call-status-route.test.ts so ambient full-sweep load can't SIGTERM the suite spuriously.",
  "tier": "small"
}
test-registration */
// Task #3896 (audit B-003) — end-to-end duplicate-POST protection for the
// four outbound Twilio routes. The service-level claim state machine is
// covered by tests/twilio-outbound-idempotency-{sms,call}.test.ts; THIS suite
// proves the production caller path: a client-supplied `clientOperationId`
// flows through route validation → `deriveOutboundOperationId` → the durable
// claim, so a duplicate HTTP POST (double-submit, replayed request,
// response-lost retry) can never create a second Twilio resource.
//
// Coverage:
//   1. deriveOutboundOperationId unit contract (stability, isolation, shape)
//   2. POST /api/twilio/send-sms — repeat + concurrent duplicates, distinct
//      keys, legacy no-key mode, invalid key → 400
//   3. POST /api/twilio/initiate-call — repeat + concurrent duplicates
//   4. POST /api/twilio/conversations/:id/messages — repeat + concurrent
//   5. POST /api/twilio/conversations — repeat duplicate (direct thread) and
//      group partial-failure retry (succeeded recipient is NOT re-sent,
//      failed recipient IS re-dispatched)
//
// Hermetic: the Twilio client is replaced via __setTwilioClientFactoryForTests
// (no live sends), everything runs inside runInTxSandbox, and the seeded user
// is marked reconciled so the ambient auth upsert never lock-waits.

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";
import { eq, and } from "drizzle-orm";

import { registerTwilioRoutes } from "../server/routes/twilio";
import {
  __setTwilioClientFactoryForTests,
  deriveOutboundOperationId,
} from "../server/services/twilioService";
import { __test_markUserReconciled } from "../server/middlewares/requireAuth";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  systemSettings,
  users,
  twilioConversations,
  twilioMessages,
  twilioCalls,
} from "@shared/schema";

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
// Fake Twilio client — records every create; per-recipient scripted failures.
// ---------------------------------------------------------------------------

type CreateRecord = { kind: "message" | "call"; to: string };
let createRecords: CreateRecord[] = [];
let sidSeq = 0;
// to → how many times messages.create should throw for that recipient.
const failMessageCreateForTo = new Map<string, { status: number; code: number; times: number }>();

function createsFor(kind: "message" | "call", to?: string): number {
  return createRecords.filter((r) => r.kind === kind && (to === undefined || r.to === to)).length;
}

function installFakeTwilioClient(): void {
  __setTwilioClientFactoryForTests(() => ({
    messages: {
      create: async (params: Record<string, unknown>) => {
        const to = String(params.to);
        const script = failMessageCreateForTo.get(to);
        if (script && script.times > 0) {
          script.times--;
          const err = new Error(`scripted failure for ${to}`) as Error & {
            status?: number;
            code?: number;
          };
          err.status = script.status;
          err.code = script.code;
          throw err;
        }
        createRecords.push({ kind: "message", to });
        return { sid: `SM_route_${++sidSeq}`, status: "queued" };
      },
    },
    calls: {
      create: async (params: Record<string, unknown>) => {
        createRecords.push({ kind: "call", to: String(params.to) });
        return { sid: `CA_route_${++sidSeq}`, status: "queued" };
      },
    },
  }) as never);
}

// ---------------------------------------------------------------------------
// Express harness with an injected authenticated session (app-level fake
// session — same pattern as tests/twilio-call-status-route.test.ts).
// ---------------------------------------------------------------------------

let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Inject Clerk test seam: requireAuth reads __test_clerkUserId and
    // uses the pre-provisioned profile (from __test_markUserReconciled)
    // directly, avoiding a DB SELECT/INSERT on the tx-sandbox row.
    req.__test_clerkUserId = currentUserId || null;
    next();
  });
  registerTwilioRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedUser(): Promise<string> {
  const id = `u_t3896r_${Math.random().toString(36).slice(2, 10)}`;
  await getDb().insert(users).values({
    id,
    email: `${id}@test.local`,
    firstName: "Task3896",
    lastName: "RouteIdem",
    role: "team_lead",
    callMode: "forward",
    callRoutingPhone: "+15551112222",
  });
  // Sandbox-seeded row is invisible to the live-pool; pre-provision so
  // requireAuth uses this profile directly instead of SELECT/INSERT-waiting.
  __test_markUserReconciled(id, {
    id,
    email: `${id}@test.local`,
    firstName: "Task3896",
    lastName: "RouteIdem",
    role: "team_lead",
  });
  return id;
}

async function seedSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

async function seedAccountConfig(): Promise<void> {
  await seedSetting("twilio_account_sid", "ACtestaccountsid000000000000000000");
  await seedSetting("twilio_auth_token", "test_auth_token_for_route_idem");
  await seedSetting("twilio_phone_numbers", JSON.stringify(["+15551110000"]));
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function randomKey(): string {
  // Valid RFC-4122-shaped UUID for the zod .uuid() gate.
  return crypto.randomUUID();
}

function resetFakes(): void {
  createRecords = [];
  failMessageCreateForTo.clear();
}

// ---------------------------------------------------------------------------
// (1) deriveOutboundOperationId unit contract
// ---------------------------------------------------------------------------

function testDerivationContract(): void {
  console.log("\n— 1. deriveOutboundOperationId contract —");
  const base = {
    userId: "user-a",
    routeTag: "send-sms" as const,
    clientKey: "11111111-1111-4111-8111-111111111111",
    recipient: "+15550001111",
  };
  const id1 = deriveOutboundOperationId(base);
  const id2 = deriveOutboundOperationId({ ...base });
  check("same inputs → same id", id1 === id2, id1);
  check(
    "canonical UUID shape with version nibble 8",
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id1),
    id1,
  );
  const variants: Array<[string, string]> = [
    ["userId", deriveOutboundOperationId({ ...base, userId: "user-b" })],
    ["routeTag", deriveOutboundOperationId({ ...base, routeTag: "initiate-call" })],
    ["clientKey", deriveOutboundOperationId({ ...base, clientKey: "22222222-2222-4222-8222-222222222222" })],
    ["recipient", deriveOutboundOperationId({ ...base, recipient: "+15550002222" })],
    ["scopeId", deriveOutboundOperationId({ ...base, scopeId: "conv-1" })],
  ];
  for (const [field, variant] of variants) {
    check(`different ${field} → different id`, variant !== id1);
  }
  check(
    "id is not the raw client key (no injection surface)",
    id1 !== base.clientKey,
  );
}

// ---------------------------------------------------------------------------
// (2) POST /api/twilio/send-sms
// ---------------------------------------------------------------------------

async function testSendSmsRoute(): Promise<void> {
  console.log("\n— 2. /api/twilio/send-sms duplicate protection —");
  await runInTxSandbox(async () => {
    currentUserId = await seedUser();
    await seedAccountConfig();
    installFakeTwilioClient();
    resetFakes();
    try {
      await withApp(async (baseUrl) => {
        const to = "+15550003333";

        // (a) repeat POST with the same key → one create, same stored result
        const key = randomKey();
        const r1 = await postJson(baseUrl, "/api/twilio/send-sms", { to, body: "route idem a", clientOperationId: key });
        const r2 = await postJson(baseUrl, "/api/twilio/send-sms", { to, body: "route idem a", clientOperationId: key });
        check("repeat: both 200", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
        check("repeat: exactly one messages.create", createsFor("message", to) === 1, String(createsFor("message", to)));
        check("repeat: same messageId", !!r1.json.messageId && r1.json.messageId === r2.json.messageId);
        check("repeat: same twilioSid", !!r1.json.twilioSid && r1.json.twilioSid === r2.json.twilioSid, r1.json.twilioSid);
        const expectedId = deriveOutboundOperationId({
          userId: currentUserId!,
          routeTag: "send-sms",
          clientKey: key,
          recipient: to,
        });
        check("repeat: row id is the documented derivation", r1.json.messageId === expectedId, expectedId);
        const rows = await getDb()
          .select({ id: twilioMessages.id, sid: twilioMessages.twilioSid })
          .from(twilioMessages)
          .where(eq(twilioMessages.id, expectedId));
        check("repeat: exactly one durable row", rows.length === 1 && rows[0].sid === r1.json.twilioSid);

        // (b) CONCURRENT duplicate POSTs with one key → one create.
        // Seed the conversation first (throwaway distinct operation): two
        // truly-simultaneous first-contact sends would race the
        // conversation INSERT itself — production code catches the unique
        // violation and re-selects, but inside the tx sandbox that error
        // aborts the shared transaction and poisons every later query. The
        // dispatch-claim race under test is independent of thread creation.
        const cTo = "+15550004444";
        await postJson(baseUrl, "/api/twilio/send-sms", { to: cTo, body: "seed thread", clientOperationId: randomKey() });
        resetFakes();
        const cKey = randomKey();
        const [c1, c2] = await Promise.all([
          postJson(baseUrl, "/api/twilio/send-sms", { to: cTo, body: "route idem b", clientOperationId: cKey }),
          postJson(baseUrl, "/api/twilio/send-sms", { to: cTo, body: "route idem b", clientOperationId: cKey }),
        ]);
        check("concurrent: exactly one messages.create", createsFor("message", cTo) === 1, String(createsFor("message", cTo)));
        const statuses = [c1.status, c2.status].sort();
        check(
          "concurrent: winner 200; loser 200 (already_sent) or 409 (in-flight)",
          statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409),
          statuses.join("/"),
        );
        if (c1.status === 200 && c2.status === 200) {
          check("concurrent: both 200s carry the same sid", c1.json.twilioSid === c2.json.twilioSid);
        }

        // (c) distinct keys → independent operations
        resetFakes();
        const dTo = "+15550005555";
        await postJson(baseUrl, "/api/twilio/send-sms", { to: dTo, body: "op one", clientOperationId: randomKey() });
        await postJson(baseUrl, "/api/twilio/send-sms", { to: dTo, body: "op two", clientOperationId: randomKey() });
        check("distinct keys: two creates", createsFor("message", dTo) === 2, String(createsFor("message", dTo)));

        // (d) legacy no-key mode → fresh operation per call
        resetFakes();
        const lTo = "+15550006666";
        await postJson(baseUrl, "/api/twilio/send-sms", { to: lTo, body: "legacy one" });
        await postJson(baseUrl, "/api/twilio/send-sms", { to: lTo, body: "legacy one" });
        check("no key: two creates (legacy contract)", createsFor("message", lTo) === 2, String(createsFor("message", lTo)));

        // (e) malformed key → 400 before any Twilio call
        resetFakes();
        const bad = await postJson(baseUrl, "/api/twilio/send-sms", { to, body: "x", clientOperationId: "not-a-uuid" });
        check("invalid key: 400", bad.status === 400, String(bad.status));
        check("invalid key: zero creates", createRecords.length === 0, String(createRecords.length));
      });
    } finally {
      __setTwilioClientFactoryForTests(undefined);
      currentUserId = null;
    }
  });
}

// ---------------------------------------------------------------------------
// (3) POST /api/twilio/initiate-call
// ---------------------------------------------------------------------------

async function testInitiateCallRoute(): Promise<void> {
  console.log("\n— 3. /api/twilio/initiate-call duplicate protection —");
  await runInTxSandbox(async () => {
    currentUserId = await seedUser();
    await seedAccountConfig();
    installFakeTwilioClient();
    resetFakes();
    try {
      await withApp(async (baseUrl) => {
        const to = "+15550007777";

        // (a) repeat POST with one key → one calls.create, same stored result
        const key = randomKey();
        const r1 = await postJson(baseUrl, "/api/twilio/initiate-call", { to, clientOperationId: key });
        const r2 = await postJson(baseUrl, "/api/twilio/initiate-call", { to, clientOperationId: key });
        check("repeat: both 200", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
        check("repeat: exactly one calls.create", createsFor("call") === 1, String(createsFor("call")));
        check("repeat: same callId", !!r1.json.callId && r1.json.callId === r2.json.callId);
        check("repeat: same twilioSid", !!r1.json.twilioSid && r1.json.twilioSid === r2.json.twilioSid, r1.json.twilioSid);
        const rows = await getDb()
          .select({ id: twilioCalls.id })
          .from(twilioCalls)
          .where(and(eq(twilioCalls.id, r1.json.callId), eq(twilioCalls.twilioSid, r1.json.twilioSid)));
        check("repeat: exactly one durable row", rows.length === 1);

        // (b) concurrent duplicate dials with one key → one create
        resetFakes();
        const cKey = randomKey();
        const [c1, c2] = await Promise.all([
          postJson(baseUrl, "/api/twilio/initiate-call", { to, clientOperationId: cKey }),
          postJson(baseUrl, "/api/twilio/initiate-call", { to, clientOperationId: cKey }),
        ]);
        check("concurrent: exactly one calls.create", createsFor("call") === 1, String(createsFor("call")));
        const statuses = [c1.status, c2.status].sort();
        check(
          "concurrent: winner 200; loser 200 or 409",
          statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409),
          statuses.join("/"),
        );

        // (c) malformed key → 400, no dial
        resetFakes();
        const bad = await postJson(baseUrl, "/api/twilio/initiate-call", { to, clientOperationId: "nope" });
        check("invalid key: 400", bad.status === 400, String(bad.status));
        check("invalid key: zero creates", createRecords.length === 0, String(createRecords.length));
      });
    } finally {
      __setTwilioClientFactoryForTests(undefined);
      currentUserId = null;
    }
  });
}

// ---------------------------------------------------------------------------
// (4) POST /api/twilio/conversations/:id/messages
// ---------------------------------------------------------------------------

async function testConversationMessagesRoute(): Promise<void> {
  console.log("\n— 4. /api/twilio/conversations/:id/messages duplicate protection —");
  await runInTxSandbox(async () => {
    currentUserId = await seedUser();
    await seedAccountConfig();
    installFakeTwilioClient();
    resetFakes();
    try {
      const to = "+15550008888";
      const [conv] = await getDb()
        .insert(twilioConversations)
        .values({
          contactPhone: to,
          contactName: "Route Idem",
          twilioPhoneNumber: "+15551110000",
          status: "active",
          conversationType: "direct",
          participants: [{ phone: to }],
        })
        .returning();

      await withApp(async (baseUrl) => {
        // (a) repeat POST with one key → one create, one message row
        const key = randomKey();
        const path = `/api/twilio/conversations/${conv.id}/messages`;
        const r1 = await postJson(baseUrl, path, { body: "thread idem", clientOperationId: key });
        const r2 = await postJson(baseUrl, path, { body: "thread idem", clientOperationId: key });
        check("repeat: both 200", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
        check("repeat: exactly one messages.create", createsFor("message", to) === 1, String(createsFor("message", to)));
        const sid1 = r1.json.results?.[0]?.twilioSid ?? r1.json.twilioSid;
        const sid2 = r2.json.results?.[0]?.twilioSid ?? r2.json.twilioSid;
        check("repeat: same twilioSid in both responses", !!sid1 && sid1 === sid2, String(sid1));
        const rows = await getDb()
          .select({ id: twilioMessages.id })
          .from(twilioMessages)
          .where(and(eq(twilioMessages.conversationId, conv.id), eq(twilioMessages.direction, "outbound")));
        check("repeat: exactly one outbound row in the thread", rows.length === 1, String(rows.length));

        // (b) concurrent duplicates → one create
        resetFakes();
        const cKey = randomKey();
        const [c1, c2] = await Promise.all([
          postJson(baseUrl, path, { body: "thread idem c", clientOperationId: cKey }),
          postJson(baseUrl, path, { body: "thread idem c", clientOperationId: cKey }),
        ]);
        check("concurrent: exactly one messages.create", createsFor("message", to) === 1, String(createsFor("message", to)));
        check("concurrent: both HTTP 200 (per-recipient results)", c1.status === 200 && c2.status === 200, `${c1.status}/${c2.status}`);
      });
    } finally {
      __setTwilioClientFactoryForTests(undefined);
      currentUserId = null;
    }
  });
}

// ---------------------------------------------------------------------------
// (5) POST /api/twilio/conversations — direct repeat + group partial retry
// ---------------------------------------------------------------------------

async function testConversationsCreateRoute(): Promise<void> {
  console.log("\n— 5. /api/twilio/conversations duplicate + partial-failure retry —");
  await runInTxSandbox(async () => {
    currentUserId = await seedUser();
    await seedAccountConfig();
    installFakeTwilioClient();
    resetFakes();
    try {
      await withApp(async (baseUrl) => {
        // (a) direct thread: repeat POST with one key → same conversation,
        //     one create, one message row
        const to = "+15550009999";
        const key = randomKey();
        const payload = {
          clientId: null,
          contacts: [{ phone: to, name: "Direct Idem" }],
          body: "new-conv idem",
          clientOperationId: key,
        };
        const r1 = await postJson(baseUrl, "/api/twilio/conversations", payload);
        const r2 = await postJson(baseUrl, "/api/twilio/conversations", payload);
        check("direct repeat: both 200", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
        check("direct repeat: one messages.create", createsFor("message", to) === 1, String(createsFor("message", to)));
        check(
          "direct repeat: same conversation id",
          !!r1.json.conversationId && r1.json.conversationId === r2.json.conversationId,
        );
        const sid1 = r1.json.results?.[0]?.twilioSid;
        const sid2 = r2.json.results?.[0]?.twilioSid;
        check("direct repeat: same twilioSid", !!sid1 && sid1 === sid2, String(sid1));

        // (b) group partial failure → retry with the SAME key re-dispatches
        //     ONLY the failed recipient; the delivered one is not re-sent.
        resetFakes();
        const gKey = randomKey();
        const okTo = "+15551230001";
        const failTo = "+15551230002";
        failMessageCreateForTo.set(failTo, { status: 500, code: 20500, times: 1 });
        const gPayload = {
          clientId: null,
          contacts: [
            { phone: okTo, name: "Group A" },
            { phone: failTo, name: "Group B" },
          ],
          body: "group idem",
          clientOperationId: gKey,
        };
        const g1 = await postJson(baseUrl, "/api/twilio/conversations", gPayload);
        check("group 1st POST: 200 with per-recipient results", g1.status === 200 && Array.isArray(g1.json.results));
        const g1Ok = g1.json.results?.find((r: any) => r.phone === okTo);
        const g1Fail = g1.json.results?.find((r: any) => r.phone === failTo);
        check("group 1st POST: recipient A delivered", !!g1Ok?.twilioSid, String(g1Ok?.twilioSid));
        check("group 1st POST: recipient B failed", g1Fail?.status === "failed" && !!g1Fail?.error);
        check("group 1st POST: one create (A only)", createsFor("message", okTo) === 1 && createsFor("message", failTo) === 0);

        const g2 = await postJson(baseUrl, "/api/twilio/conversations", gPayload);
        check("group retry: 200", g2.status === 200, String(g2.status));
        const g2Ok = g2.json.results?.find((r: any) => r.phone === okTo);
        const g2Fail = g2.json.results?.find((r: any) => r.phone === failTo);
        check(
          "group retry: recipient A NOT re-sent (same sid returned)",
          createsFor("message", okTo) === 1 && g2Ok?.twilioSid === g1Ok?.twilioSid,
          `creates=${createsFor("message", okTo)}`,
        );
        check(
          "group retry: recipient B re-dispatched exactly once",
          createsFor("message", failTo) === 1 && !!g2Fail?.twilioSid,
          `creates=${createsFor("message", failTo)}`,
        );
        check(
          "group retry: same group conversation reused",
          !!g1.json.conversationId && g2.json.conversationId === g1.json.conversationId,
        );
      });
    } finally {
      __setTwilioClientFactoryForTests(undefined);
      currentUserId = null;
    }
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Twilio outbound route idempotency (Task #3896)");

  testDerivationContract();
  await testSendSmsRoute();
  await testInitiateCallRoute();
  await testConversationMessagesRoute();
  await testConversationsCreateRoute();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("Suite crashed:", err);
    process.exit(1);
  },
);
