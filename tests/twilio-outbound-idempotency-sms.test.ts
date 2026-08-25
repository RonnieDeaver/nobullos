/* test-registration
{
  "name": "Twilio outbound SMS idempotency + dispatch claims (audit B-003, Task #3896)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy tx-sandbox suite: exercises the twilio_messages dispatch-claim state machine (insert / in-progress rejection / stale reclaim / ownership-checked finalize + fail) end-to-end through sendSms with a stubbed Twilio SDK. Runs in the full suite and the nightly --regression sweep; too DB-bound for the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3896 (audit B-003): outbound Twilio SMS creates must be idempotent
// per logical operation. The durable operation identity is the
// `twilio_messages` row id, claimed BEFORE `client.messages.create` runs:
//
//   - the same operationId can never produce two Twilio creates — not via
//     repeat-after-success (stored-SID short-circuit), not via concurrent
//     invocation (fresh-claim rejection), not via crash recovery (stale
//     claims are re-claimable only after TWILIO_DISPATCH_STALE_CLAIM_MS);
//   - distinct operations to the same recipient stay independently sendable;
//   - a repeated invocation never resets an advanced delivery status;
//   - failures record an explicit, investigable `failed` state (errorCode +
//     errorMessage) and release the claim so only a HUMAN retry re-dispatches;
//   - dispatch log lines carry operation id + outcome + numeric error
//     classification and NEVER phone numbers, message bodies, or credentials.
//
// Everything runs hermetically: `__setTwilioClientFactoryForTests` replaces
// the SDK client (no HTTP), `runInTxSandbox` rolls back all rows.
//
// Usage: npm test -- --file=tests/twilio-outbound-idempotency-sms.test.ts

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  sendSms,
  __setTwilioClientFactoryForTests,
  TwilioOutboundOperationError,
  TWILIO_DISPATCH_STALE_CLAIM_MS,
} from "../server/services/twilioService";
import {
  claimOutboundSmsOperation,
  finalizeClaimedSmsOperation,
  failClaimedSmsOperation,
  getTwilioMessage,
} from "../server/storage/twilioStorage";
import { systemSettings, twilioConversations, twilioMessages, users } from "@shared/schema";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHONE = "+15550100001";
const DEST = "+15550100002";
const AUTH_TOKEN = "test_auth_token_task3896_sms";
const BODY = "task3896 secret idempotency payload";

async function seedTwilioCredentials(): Promise<void> {
  const dbi = getDb();
  const rows = [
    { key: "twilio_account_sid", value: "ACtest_task3896_sms_idempotency" },
    { key: "twilio_auth_token", value: AUTH_TOKEN },
    { key: "twilio_phone_numbers", value: JSON.stringify([PHONE]) },
  ];
  for (const row of rows) {
    await dbi
      .insert(systemSettings)
      .values(row)
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: row.value } });
  }
}

async function seedTestUser(): Promise<string> {
  const [u] = await getDb()
    .insert(users)
    .values({ email: `task3896-sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, role: "account_manager" })
    .returning();
  return u.id;
}

async function seedConversation(): Promise<string> {
  const [conv] = await getDb()
    .insert(twilioConversations)
    .values({ contactPhone: DEST, twilioPhoneNumber: PHONE, status: "active" })
    .returning();
  return conv.id;
}

type StubStep =
  | { kind: "ok"; sid?: string; status?: string }
  | { kind: "throw"; err: unknown };

/**
 * Installs a scripted `messages.create` stub. Each call consumes the next
 * step; running past the script throws (catches accidental extra creates).
 */
function installSmsStub(script: StubStep[]): Array<Record<string, unknown>> {
  const createCalls: Array<Record<string, unknown>> = [];
  __setTwilioClientFactoryForTests(() => ({
    messages: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params);
        const step = script.shift();
        if (!step) throw new Error("test stub: messages.create called more times than scripted");
        if (step.kind === "throw") throw step.err;
        return {
          sid: step.sid ?? `SMtask3896${Math.random().toString(36).slice(2, 10)}`,
          status: step.status ?? "queued",
        };
      },
    },
  }));
  return createCalls;
}

function twilioRestError(status: number, code: number, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    code,
    moreInfo: `https://www.twilio.com/docs/errors/${code}`,
  });
}

// ---------------------------------------------------------------------------
// A1. Single dispatch: exactly one create; row finalized with SID; claim
//     released; comm record linked.
// ---------------------------------------------------------------------------
async function testSingleDispatchCreatesOnce(): Promise<void> {
  console.log("\n— A1. single dispatch creates exactly one Twilio message —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const opId = randomUUID();
    const createCalls = installSmsStub([{ kind: "ok", sid: "SMtask3896single01" }]);
    try {
      const res = await sendSms({ to: DEST, body: BODY, userId, operationId: opId });
      check("messages.create called exactly once", createCalls.length === 1, String(createCalls.length));
      check("returned messageId IS the operation id", res.messageId === opId, res.messageId);
      check("returned twilioSid matches stub", res.twilioSid === "SMtask3896single01", res.twilioSid);
      const row = await getTwilioMessage(opId);
      check("row persisted with the Twilio SID", row?.twilioSid === "SMtask3896single01", String(row?.twilioSid));
      check("row status = initial Twilio status", row?.status === "queued", String(row?.status));
      check("claim token released after finalize", row?.dispatchClaimToken === null, String(row?.dispatchClaimToken));
      check("claim timestamp released after finalize", row?.dispatchClaimedAt === null, String(row?.dispatchClaimedAt));
      check("raw communication record linked by SID", !!row?.rawCommunicationRecordId, String(row?.rawCommunicationRecordId));
      check("conversation auto-created before create", !!res.conversationId, res.conversationId);
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// A2. Repeat-after-success short-circuits on the stored SID and never
//     regresses an advanced delivery status.
// ---------------------------------------------------------------------------
async function testRepeatAfterSuccessShortCircuits(): Promise<void> {
  console.log("\n— A2. repeat-after-success returns stored SID, preserves advanced status —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const convId = await seedConversation();
    const opId = randomUUID();
    const createCalls = installSmsStub([{ kind: "ok", sid: "SMtask3896repeat01" }]);
    try {
      const first = await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId });
      const second = await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId });
      check("second invocation returns the SAME twilioSid", second.twilioSid === first.twilioSid, second.twilioSid);
      check("second invocation returns the SAME messageId", second.messageId === opId, second.messageId);
      check("no second Twilio create happened", createCalls.length === 1, String(createCalls.length));

      // Simulate the status callback advancing delivery, then repeat again:
      // the idempotent replay must surface the ADVANCED status untouched.
      await getDb().update(twilioMessages).set({ status: "delivered" }).where(eq(twilioMessages.id, opId));
      const third = await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId });
      check("replay reports the advanced status", third.status === "delivered", third.status);
      const row = await getTwilioMessage(opId);
      check("row status NOT regressed by the replay", row?.status === "delivered", String(row?.status));
      check("still exactly one Twilio create", createCalls.length === 1, String(createCalls.length));
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// A3. Concurrent invocations of the SAME operation: at most one create; the
//     loser is rejected with an explicit in-progress error (or returns the
//     winner's result if it settled first).
// ---------------------------------------------------------------------------
async function testConcurrentSameOperation(): Promise<void> {
  console.log("\n— A3. concurrent same-operation invocations create at most one message —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const convId = await seedConversation();
    const opId = randomUUID();
    const createCalls = installSmsStub([
      { kind: "ok", sid: "SMtask3896conc01" },
      { kind: "ok", sid: "SMtask3896conc02" },
    ]);
    try {
      const settled = await Promise.allSettled([
        sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId }),
        sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId }),
      ]);
      check("at most one Twilio create across both invocations", createCalls.length === 1, String(createCalls.length));
      const fulfilled = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ twilioSid: string }>[];
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      check("at least one invocation succeeded", fulfilled.length >= 1, `fulfilled=${fulfilled.length}`);
      if (fulfilled.length === 2) {
        check("both fulfilled → identical SID (no duplicate)", fulfilled[0].value.twilioSid === fulfilled[1].value.twilioSid);
      } else {
        const err = rejected[0]?.reason;
        check(
          "loser rejected with explicit in-progress operation error",
          err instanceof TwilioOutboundOperationError && err.operationState === "in_progress" && err.operationRowId === opId,
          err instanceof Error ? err.message : String(err),
        );
      }
      const row = await getTwilioMessage(opId);
      check("row carries the single created SID", row?.twilioSid === "SMtask3896conc01", String(row?.twilioSid));
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// A4. Distinct operations stay independent — same recipient, two operation
//     ids → two creates, two rows.
// ---------------------------------------------------------------------------
async function testDistinctOperationsIndependent(): Promise<void> {
  console.log("\n— A4. distinct operations to the same recipient both send —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const convId = await seedConversation();
    const opA = randomUUID();
    const opB = randomUUID();
    const createCalls = installSmsStub([
      { kind: "ok", sid: "SMtask3896distA" },
      { kind: "ok", sid: "SMtask3896distB" },
    ]);
    try {
      const a = await sendSms({ to: DEST, body: `${BODY} A`, userId, conversationId: convId, operationId: opA });
      const b = await sendSms({ to: DEST, body: `${BODY} B`, userId, conversationId: convId, operationId: opB });
      check("two creates for two logical operations", createCalls.length === 2, String(createCalls.length));
      check("distinct SIDs", a.twilioSid !== b.twilioSid, `${a.twilioSid} vs ${b.twilioSid}`);
      const rowA = await getTwilioMessage(opA);
      const rowB = await getTwilioMessage(opB);
      check("both rows persisted independently", rowA?.twilioSid === "SMtask3896distA" && rowB?.twilioSid === "SMtask3896distB");
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// A5. Definitive failure → explicit investigable failed state; only a fresh
//     (human) retry of the same operation re-dispatches; exactly one create
//     per invocation (no hidden service-level retry loop).
// ---------------------------------------------------------------------------
async function testFailureStateAndHumanRetry(): Promise<void> {
  console.log("\n— A5. failure records investigable state; human retry re-dispatches —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const convId = await seedConversation();
    const opId = randomUUID();
    const createCalls = installSmsStub([
      { kind: "throw", err: twilioRestError(400, 21211, `The 'To' number ${DEST} is not a valid phone number.`) },
      { kind: "ok", sid: "SMtask3896retry01" },
    ]);
    try {
      let thrown: unknown;
      try {
        await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId });
      } catch (err) {
        thrown = err;
      }
      check("failed dispatch throws TwilioOutboundOperationError", thrown instanceof TwilioOutboundOperationError);
      const opErr = thrown as TwilioOutboundOperationError;
      check(
        "error message preserves describeTwilioError wire format",
        opErr.message.startsWith("[HTTP 400 / Twilio code 21211]"),
        opErr.message,
      );
      check("error carries operation row id + table + state", opErr.operationRowId === opId && opErr.operationTable === "twilio_messages" && opErr.operationState === "failed");
      const rowAfterFail = await getTwilioMessage(opId);
      check("row status = failed (explicit, investigable)", rowAfterFail?.status === "failed", String(rowAfterFail?.status));
      check("row errorCode persisted", rowAfterFail?.errorCode === "21211", String(rowAfterFail?.errorCode));
      check("row errorMessage persisted", !!rowAfterFail?.errorMessage?.includes("HTTP 400"), String(rowAfterFail?.errorMessage));
      check("row has NO SID after failure", rowAfterFail?.twilioSid === null, String(rowAfterFail?.twilioSid));
      check("claim released after failure (re-claimable by human retry)", rowAfterFail?.dispatchClaimToken === null);
      check("exactly one create so far — no automatic re-dispatch of ANY failure class", createCalls.length === 1, String(createCalls.length));

      // Human retry: a fresh invocation with the SAME operation id reclaims
      // the failed row and re-dispatches.
      const retry = await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opId });
      check("human retry re-dispatches the same operation", retry.twilioSid === "SMtask3896retry01", retry.twilioSid);
      check("one create per invocation (2 invocations → 2 creates)", createCalls.length === 2, String(createCalls.length));
      const rowAfterRetry = await getTwilioMessage(opId);
      check("retry cleared the previous error fields", rowAfterRetry?.errorCode === null && rowAfterRetry?.errorMessage === null);
      check("retry persisted the SID on the SAME row", rowAfterRetry?.twilioSid === "SMtask3896retry01");
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// D. Claim/recovery state machine, storage-level: fresh claims are not
//    stealable, stale claims are re-claimable, dead tokens cannot finalize,
//    legacy (pre-#3896) rows keep working.
// ---------------------------------------------------------------------------
async function testClaimStateMachineDirect(): Promise<void> {
  console.log("\n— D. dispatch-claim state machine (storage level) —");
  await runInTxSandbox(async () => {
    const convId = await seedConversation();
    const data = { conversationId: convId, fromNumber: PHONE, toNumber: DEST, body: BODY };
    const opId = randomUUID();

    const first = await claimOutboundSmsOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("first claim inserts the operation row", first.kind === "claimed" && first.mode === "inserted");
    const firstToken = first.kind === "claimed" ? first.claimToken : "";
    check("claim token is an opaque UUID (no phone/body material)", UUID_RE.test(firstToken), firstToken);
    check("operation id is an opaque UUID (no phone/body material)", UUID_RE.test(opId));

    const second = await claimOutboundSmsOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("fresh claim is NOT stealable → in_progress", second.kind === "in_progress");

    // Backdate the claim past the stale horizon (crashed-owner recovery).
    await getDb()
      .update(twilioMessages)
      .set({ dispatchClaimedAt: new Date(Date.now() - TWILIO_DISPATCH_STALE_CLAIM_MS - 1_000) })
      .where(eq(twilioMessages.id, opId));
    const third = await claimOutboundSmsOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("stale claim IS re-claimable", third.kind === "claimed" && third.mode === "reclaimed");
    const thirdToken = third.kind === "claimed" ? third.claimToken : "";
    check("reclaim mints a NEW token", thirdToken !== firstToken);

    const deadFinalize = await finalizeClaimedSmsOperation(opId, firstToken, { twilioSid: "SMtask3896dead", status: "queued" });
    check("dead token cannot finalize (lost ownership)", deadFinalize === undefined);
    const midRow = await getTwilioMessage(opId);
    check("row untouched by the dead finalize", midRow?.twilioSid === null, String(midRow?.twilioSid));
    const deadFail = await failClaimedSmsOperation(opId, firstToken, { errorMessage: "should not land" });
    check("dead token cannot record failure either", deadFail === undefined);

    const goodFinalize = await finalizeClaimedSmsOperation(opId, thirdToken, { twilioSid: "SMtask3896owner", status: "queued" });
    check("live token finalizes", goodFinalize?.twilioSid === "SMtask3896owner");
    const fourth = await claimOutboundSmsOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("post-SID claim short-circuits to already_sent", fourth.kind === "already_sent" && fourth.row.twilioSid === "SMtask3896owner");

    // Legacy pre-#3896 rows (NULL claim columns) keep working.
    const legacySent = randomUUID();
    await getDb().insert(twilioMessages).values({
      id: legacySent,
      conversationId: convId,
      twilioSid: "SMtask3896legacy",
      direction: "outbound",
      fromNumber: PHONE,
      toNumber: DEST,
      body: BODY,
      status: "delivered",
    });
    const legacyClaim = await claimOutboundSmsOperation({ operationId: legacySent, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("legacy row WITH SID → already_sent", legacyClaim.kind === "already_sent" && legacyClaim.row.status === "delivered");

    const legacyUnsent = randomUUID();
    await getDb().insert(twilioMessages).values({
      id: legacyUnsent,
      conversationId: convId,
      twilioSid: null,
      direction: "outbound",
      fromNumber: PHONE,
      toNumber: DEST,
      body: BODY,
      status: "failed",
    });
    const legacyReclaim = await claimOutboundSmsOperation({ operationId: legacyUnsent, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("legacy SID-less row (NULL claim) is claimable", legacyReclaim.kind === "claimed" && legacyReclaim.mode === "reclaimed");
  });
}

// ---------------------------------------------------------------------------
// E. Dispatch log privacy: every `[Twilio][dispatch]` line carries op id +
//    outcome (+ numeric error class) and NEVER phone digits, body text, or
//    credentials.
// ---------------------------------------------------------------------------
async function testDispatchLogPrivacy(): Promise<void> {
  console.log("\n— E. dispatch log privacy —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const convId = await seedConversation();
    const opFail = randomUUID();
    const opOk = randomUUID();
    const createCalls = installSmsStub([
      { kind: "throw", err: twilioRestError(400, 21211, `The 'To' number ${DEST} is not a valid phone number.`) },
      { kind: "ok", sid: "SMtask3896logok" },
    ]);

    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const capture = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      fn(...args);
    };
    console.log = capture(orig.log);
    console.warn = capture(orig.warn);
    console.error = capture(orig.error);
    try {
      await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opFail }).catch(() => undefined);
      await sendSms({ to: DEST, body: BODY, userId, conversationId: convId, operationId: opOk });
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      __setTwilioClientFactoryForTests(undefined);
    }
    check("stub consumed both scripted steps", createCalls.length === 2, String(createCalls.length));

    const dispatchLines = captured.filter((l) => l.startsWith("[Twilio][dispatch]"));
    check("dispatch lines were emitted", dispatchLines.length >= 4, String(dispatchLines.length));
    check("claimed outcome logged with op id", dispatchLines.some((l) => l.includes(`op=${opFail}`) && l.includes("outcome=claimed")));
    check(
      "create_failed logged with NUMERIC classification only",
      dispatchLines.some((l) => l.includes(`op=${opFail}`) && l.includes("outcome=create_failed") && l.includes("err=http_400_code_21211")),
    );
    check("finalized outcome logged for the success", dispatchLines.some((l) => l.includes(`op=${opOk}`) && l.includes("outcome=finalized")));

    const leakyPhone = dispatchLines.filter((l) => l.includes("5550100"));
    check("NO dispatch line contains phone digits", leakyPhone.length === 0, leakyPhone[0]);
    const leakyBody = dispatchLines.filter((l) => l.includes("secret idempotency"));
    check("NO dispatch line contains the message body", leakyBody.length === 0, leakyBody[0]);
    const leakyToken = dispatchLines.filter((l) => l.includes(AUTH_TOKEN));
    check("NO dispatch line contains the auth token", leakyToken.length === 0, leakyToken[0]);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio outbound SMS idempotency tests (audit B-003, Task #3896)");

  await testSingleDispatchCreatesOnce();
  await testRepeatAfterSuccessShortCircuits();
  await testConcurrentSameOperation();
  await testDistinctOperationsIndependent();
  await testFailureStateAndHumanRetry();
  await testClaimStateMachineDirect();
  await testDispatchLogPrivacy();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Natural drain: the shared test teardown in server/db.ts disables the
// pg-pool idle reaper in test mode, so the loop empties once main() settles
// (Task #2084 convention — no manual process.exit()).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
