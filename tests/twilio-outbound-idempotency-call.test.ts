/* test-registration
{
  "name": "Twilio outbound call idempotency + dispatch claims (audit B-003, Task #3896)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy tx-sandbox suite: exercises the twilio_calls dispatch-claim state machine end-to-end through initiateForwardCall with a stubbed Twilio SDK. Runs in the full suite and the nightly --regression sweep; too DB-bound for the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3896 (audit B-003): the calls twin of
// tests/twilio-outbound-idempotency-sms.test.ts. `initiateForwardCall` claims
// a durable `twilio_calls` operation row BEFORE `client.calls.create`, so the
// same logical call operation can never dial twice — repeat-after-success
// short-circuits on the stored SID, concurrent invocations lose the claim
// race, failed dispatches leave a terminal `failed` row that only a human
// retry re-claims. The call-status webhook keeps mapping by SID to the same
// row (`getTwilioCallByTwilioSid`).
//
// Usage: npm test -- --file=tests/twilio-outbound-idempotency-call.test.ts

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  initiateForwardCall,
  __setTwilioClientFactoryForTests,
  TwilioOutboundOperationError,
  TWILIO_DISPATCH_STALE_CLAIM_MS,
} from "../server/services/twilioService";
import {
  claimOutboundCallOperation,
  finalizeClaimedCallOperation,
  failClaimedCallOperation,
  getTwilioCall,
  getTwilioCallByTwilioSid,
} from "../server/storage/twilioStorage";
import { systemSettings, twilioCalls, users } from "@shared/schema";
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

const PHONE = "+15550100011";
const DEST = "+15550100012";
const ROUTING = "+15550100013";

async function seedTwilioCredentials(): Promise<void> {
  const dbi = getDb();
  const rows = [
    { key: "twilio_account_sid", value: "ACtest_task3896_call_idempotency" },
    { key: "twilio_auth_token", value: "test_auth_token_task3896_call" },
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
    .values({ email: `task3896-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, role: "account_manager" })
    .returning();
  return u.id;
}

type StubStep =
  | { kind: "ok"; sid?: string }
  | { kind: "throw"; err: unknown };

function installCallStub(script: StubStep[]): Array<Record<string, unknown>> {
  const createCalls: Array<Record<string, unknown>> = [];
  __setTwilioClientFactoryForTests(() => ({
    calls: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params);
        const step = script.shift();
        if (!step) throw new Error("test stub: calls.create called more times than scripted");
        if (step.kind === "throw") throw step.err;
        return { sid: step.sid ?? `CAtask3896${Math.random().toString(36).slice(2, 10)}` };
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
// B1. Single dispatch: one create; TwiML bridge params unchanged; row
//     finalized; webhook SID mapping intact.
// ---------------------------------------------------------------------------
async function testForwardCallSingleDispatch(): Promise<void> {
  console.log("\n— B1. single forward-call dispatch —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const opId = randomUUID();
    const createCalls = installCallStub([{ kind: "ok", sid: "CAtask3896single01" }]);
    try {
      const res = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opId });
      check("calls.create called exactly once", createCalls.length === 1, String(createCalls.length));
      check("returned callId IS the operation id", res.callId === opId, res.callId);
      check("returned twilioSid matches stub", res.twilioSid === "CAtask3896single01", res.twilioSid);

      // Existing call-flow contract preserved (Task #874): first leg dials
      // the routing phone; TwiML bridge URL carries the real destination.
      const params = createCalls[0] as { to?: string; from?: string; url?: string; statusCallback?: string };
      check("first leg dials the ROUTING phone", params.to === ROUTING, String(params.to));
      check("caller id is the Twilio number", params.from === PHONE, String(params.from));
      check("TwiML bridge URL + destination unchanged", !!params.url?.includes("/api/twilio/webhooks/voice-twiml-forward-bridge") && !!params.url?.includes(encodeURIComponent(DEST)), String(params.url));
      check("status callback unchanged", !!params.statusCallback?.includes("/api/twilio/webhooks/call-status"), String(params.statusCallback));

      const row = await getTwilioCall(opId);
      check("row persisted with the Twilio SID", row?.twilioSid === "CAtask3896single01", String(row?.twilioSid));
      check("row status = initiated", row?.status === "initiated", String(row?.status));
      check("row records the DESTINATION as toNumber (call-log attribution)", row?.toNumber === DEST, String(row?.toNumber));
      check("claim released after finalize", row?.dispatchClaimToken === null && row?.dispatchClaimedAt === null);
      check("raw communication record linked", !!row?.rawCommunicationRecordId, String(row?.rawCommunicationRecordId));

      // Status-callback mapping: the webhook looks rows up by SID — the
      // claimed row must be the one it finds.
      const bySid = await getTwilioCallByTwilioSid("CAtask3896single01");
      check("webhook SID lookup maps to the SAME operation row", bySid?.id === opId, String(bySid?.id));
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// B2. Repeat-after-success + concurrent invocation: never a second dial.
// ---------------------------------------------------------------------------
async function testForwardCallRepeatAndConcurrent(): Promise<void> {
  console.log("\n— B2. repeat + concurrent same-operation never dial twice —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();

    // Repeat-after-success.
    const opRepeat = randomUUID();
    let createCalls = installCallStub([{ kind: "ok", sid: "CAtask3896rep01" }]);
    try {
      const first = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opRepeat });
      const second = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opRepeat });
      check("repeat returns the stored SID", second.twilioSid === first.twilioSid, second.twilioSid);
      check("repeat did NOT re-dial", createCalls.length === 1, String(createCalls.length));
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }

    // Concurrent same-operation.
    const opConc = randomUUID();
    createCalls = installCallStub([
      { kind: "ok", sid: "CAtask3896conc01" },
      { kind: "ok", sid: "CAtask3896conc02" },
    ]);
    try {
      const settled = await Promise.allSettled([
        initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opConc }),
        initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opConc }),
      ]);
      check("concurrent same-op → at most one dial", createCalls.length === 1, String(createCalls.length));
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      if (rejected.length > 0) {
        const err = rejected[0].reason;
        check(
          "loser rejected with explicit in-progress error",
          err instanceof TwilioOutboundOperationError && err.operationState === "in_progress" && err.operationTable === "twilio_calls",
          err instanceof Error ? err.message : String(err),
        );
      } else {
        const values = settled.map((s) => (s as PromiseFulfilledResult<{ twilioSid: string }>).value.twilioSid);
        check("both fulfilled → identical SID", values[0] === values[1], values.join(","));
      }
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }

    // Distinct operations stay independent.
    const opA = randomUUID();
    const opB = randomUUID();
    createCalls = installCallStub([
      { kind: "ok", sid: "CAtask3896distA" },
      { kind: "ok", sid: "CAtask3896distB" },
    ]);
    try {
      const a = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opA });
      const b = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opB });
      check("distinct operations both dial", createCalls.length === 2 && a.twilioSid !== b.twilioSid);
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// B3. Failure → terminal failed row, claim released; human retry re-claims.
// ---------------------------------------------------------------------------
async function testForwardCallFailureAndRetry(): Promise<void> {
  console.log("\n— B3. failed dial records failed state; human retry re-dials —");
  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const userId = await seedTestUser();
    const opId = randomUUID();
    const createCalls = installCallStub([
      { kind: "throw", err: twilioRestError(429, 20429, "Too Many Requests") },
      { kind: "ok", sid: "CAtask3896retry01" },
    ]);
    try {
      let thrown: unknown;
      try {
        await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opId });
      } catch (err) {
        thrown = err;
      }
      check("failed dial throws TwilioOutboundOperationError", thrown instanceof TwilioOutboundOperationError);
      const opErr = thrown as TwilioOutboundOperationError;
      check(
        "429 exhaustion classification preserved in the error message",
        opErr.message.startsWith("[HTTP 429 / Twilio code 20429]"),
        opErr.message,
      );
      check("error carries table + state", opErr.operationTable === "twilio_calls" && opErr.operationState === "failed");
      const rowAfterFail = await getTwilioCall(opId);
      check("row status = failed, no SID, claim released", rowAfterFail?.status === "failed" && rowAfterFail?.twilioSid === null && rowAfterFail?.dispatchClaimToken === null);
      check("exactly one dial attempt at the service layer (no service-level retry loop)", createCalls.length === 1, String(createCalls.length));

      const retry = await initiateForwardCall({ to: DEST, routingPhone: ROUTING, userId, operationId: opId });
      check("human retry re-dials the same operation", retry.twilioSid === "CAtask3896retry01", retry.twilioSid);
      const rowAfterRetry = await getTwilioCall(opId);
      check("retry finalized the SAME row", rowAfterRetry?.twilioSid === "CAtask3896retry01" && rowAfterRetry?.status === "initiated");
    } finally {
      __setTwilioClientFactoryForTests(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// D-call. Claim state machine at the storage level (twin of the SMS suite).
// ---------------------------------------------------------------------------
async function testCallClaimStateMachineDirect(): Promise<void> {
  console.log("\n— D-call. dispatch-claim state machine (storage level) —");
  await runInTxSandbox(async () => {
    const data = { fromNumber: PHONE, toNumber: DEST };
    const opId = randomUUID();

    const first = await claimOutboundCallOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("first claim inserts the operation row", first.kind === "claimed" && first.mode === "inserted");
    const firstToken = first.kind === "claimed" ? first.claimToken : "";

    const second = await claimOutboundCallOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("fresh claim is NOT stealable → in_progress", second.kind === "in_progress");

    await getDb()
      .update(twilioCalls)
      .set({ dispatchClaimedAt: new Date(Date.now() - TWILIO_DISPATCH_STALE_CLAIM_MS - 1_000) })
      .where(eq(twilioCalls.id, opId));
    const third = await claimOutboundCallOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("stale claim IS re-claimable", third.kind === "claimed" && third.mode === "reclaimed");
    const thirdToken = third.kind === "claimed" ? third.claimToken : "";

    const deadFinalize = await finalizeClaimedCallOperation(opId, firstToken, { twilioSid: "CAtask3896dead", status: "initiated" });
    check("dead token cannot finalize", deadFinalize === undefined);
    const deadFail = await failClaimedCallOperation(opId, firstToken);
    check("dead token cannot record failure", deadFail === undefined);
    const midRow = await getTwilioCall(opId);
    check("row untouched by dead writers", midRow?.twilioSid === null && midRow?.status === "initiated");

    const goodFinalize = await finalizeClaimedCallOperation(opId, thirdToken, { twilioSid: "CAtask3896owner", status: "initiated" });
    check("live token finalizes", goodFinalize?.twilioSid === "CAtask3896owner");
    const fourth = await claimOutboundCallOperation({ operationId: opId, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("post-SID claim short-circuits to already_sent", fourth.kind === "already_sent");

    // Legacy pre-#3896 rows (NULL claim columns).
    const legacySent = randomUUID();
    await getDb().insert(twilioCalls).values({
      id: legacySent,
      twilioSid: "CAtask3896legacy",
      direction: "outbound",
      fromNumber: PHONE,
      toNumber: DEST,
      status: "completed",
    });
    const legacyClaim = await claimOutboundCallOperation({ operationId: legacySent, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("legacy row WITH SID → already_sent", legacyClaim.kind === "already_sent" && legacyClaim.row.status === "completed");

    const legacyUnsent = randomUUID();
    await getDb().insert(twilioCalls).values({
      id: legacyUnsent,
      twilioSid: null,
      direction: "outbound",
      fromNumber: PHONE,
      toNumber: DEST,
      status: "failed",
    });
    const legacyReclaim = await claimOutboundCallOperation({ operationId: legacyUnsent, staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS, data });
    check("legacy SID-less row (NULL claim) is claimable", legacyReclaim.kind === "claimed" && legacyReclaim.mode === "reclaimed");
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio outbound call idempotency tests (audit B-003, Task #3896)");

  await testForwardCallSingleDispatch();
  await testForwardCallRepeatAndConcurrent();
  await testForwardCallFailureAndRetry();
  await testCallClaimStateMachineDirect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Natural drain (Task #2084 convention — no manual process.exit()).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
