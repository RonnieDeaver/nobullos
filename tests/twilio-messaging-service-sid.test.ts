/* test-registration
{
  "name": "Twilio messaging service sid (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #876: Send Conversation Hub messages via Twilio Messaging Service
// (RCS-ready).
//
// When `system_settings.twilio_messaging_service_sid` is set, every
// outbound SMS must be sent through `messagingServiceSid: <MG…>` so
// Twilio's channel selection can pick RCS for capable handsets and SMS
// otherwise. When it's empty/unset, behavior must fall back to the
// legacy `from: <phoneNumber>` path so installations that haven't
// completed RCS setup keep working unchanged.
//
// We assert this in two layers:
//   1. `buildOutboundSmsCreateParams` — pure function, easiest to
//      assert exact param shape under both branches.
//   2. `sendSms` end-to-end inside `runInTxSandbox`, with the Twilio
//      SDK module patched so we can capture the EXACT object the
//      service hands to `client.messages.create` without a real HTTP
//      call. This proves the wiring (config → client.messages.create)
//      is correct, not just the helper.
//
// Usage: tsx tests/twilio-messaging-service-sid.test.ts

import {
  buildOutboundSmsCreateParams,
  sendSms,
  __setTwilioClientFactoryForTests,
} from "../server/services/twilioService";
import { systemSettings, twilioConversations, twilioMessages, users } from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { eq } from "drizzle-orm";

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
// (1) Pure helper: with messagingServiceSid set, params include
//     `messagingServiceSid` and NOT `from`. Without it, the inverse.
// ---------------------------------------------------------------------------
function testBuilderRoutesViaMessagingService(): void {
  console.log("\n— 1. buildOutboundSmsCreateParams branches —");

  const baseUrl = "https://example.test";
  const fromNumber = "+15551110000";
  const to = "+15552220000";
  const body = "hello";
  const SID = "MG2a1e5dbe111766170ecb0bb151e87b8a";

  // Branch A: SID set → messagingServiceSid wins, no `from`.
  const withSid = buildOutboundSmsCreateParams({
    to,
    body,
    fromNumber,
    messagingServiceSid: SID,
    baseUrl,
  });
  check(
    "with SID: includes messagingServiceSid",
    withSid.messagingServiceSid === SID,
    String(withSid.messagingServiceSid),
  );
  check(
    "with SID: omits `from` so Twilio picks from the Sender Pool",
    !("from" in withSid),
    `from=${withSid.from}`,
  );
  check(
    "with SID: still passes statusCallback (Task #875 preserved)",
    withSid.statusCallback === `${baseUrl}/api/twilio/webhooks/sms-status`,
    String(withSid.statusCallback),
  );
  check(
    "with SID: still passes statusCallbackEvent (Task #875 preserved)",
    Array.isArray(withSid.statusCallbackEvent) &&
      (withSid.statusCallbackEvent as string[]).includes("delivered"),
    JSON.stringify(withSid.statusCallbackEvent),
  );
  check(
    "with SID: body + to are preserved",
    withSid.body === body && withSid.to === to,
    `body=${withSid.body} to=${withSid.to}`,
  );

  // Branch B: SID empty → from wins, no messagingServiceSid.
  const withoutSid = buildOutboundSmsCreateParams({
    to,
    body,
    fromNumber,
    messagingServiceSid: undefined,
    baseUrl,
  });
  check(
    "without SID: includes `from`",
    withoutSid.from === fromNumber,
    String(withoutSid.from),
  );
  check(
    "without SID: omits messagingServiceSid",
    !("messagingServiceSid" in withoutSid),
    `messagingServiceSid=${withoutSid.messagingServiceSid}`,
  );
  check(
    "without SID: still passes statusCallback (Task #875 preserved)",
    withoutSid.statusCallback === `${baseUrl}/api/twilio/webhooks/sms-status`,
    String(withoutSid.statusCallback),
  );

  // Branch C: SID provided as empty string → fall back to `from`.
  const emptyString = buildOutboundSmsCreateParams({
    to,
    body,
    fromNumber,
    messagingServiceSid: "",
    baseUrl,
  });
  check(
    "empty-string SID falls back to `from`",
    emptyString.from === fromNumber && !("messagingServiceSid" in emptyString),
    JSON.stringify(emptyString),
  );

  // Branch D: whitespace-only SID → fall back to `from` (defensive).
  const whitespace = buildOutboundSmsCreateParams({
    to,
    body,
    fromNumber,
    messagingServiceSid: "   ",
    baseUrl,
  });
  check(
    "whitespace-only SID falls back to `from`",
    whitespace.from === fromNumber && !("messagingServiceSid" in whitespace),
    JSON.stringify(whitespace),
  );

  // Branch E: SID with surrounding whitespace is trimmed.
  const padded = buildOutboundSmsCreateParams({
    to,
    body,
    fromNumber,
    messagingServiceSid: `  ${SID}  `,
    baseUrl,
  });
  check(
    "padded SID is trimmed before being passed to Twilio",
    padded.messagingServiceSid === SID && !("from" in padded),
    String(padded.messagingServiceSid),
  );
}

// ---------------------------------------------------------------------------
// Twilio SDK patching helpers.
//
// `getTwilioClient` does `(await import("twilio")).default(sid, token)`. We
// override that default export with a constructor that returns a stub
// client whose `messages.create` records every call, so tests can assert
// the EXACT shape of the object handed to Twilio without a real HTTP send.
// We restore the original constructor in a `finally` block so other tests
// in the same process see a clean module.
// ---------------------------------------------------------------------------
type CapturedCall = Record<string, unknown>;

async function withStubbedTwilioSdk<T>(
  fn: (recordedCalls: CapturedCall[]) => Promise<T>,
): Promise<T> {
  const recordedCalls: CapturedCall[] = [];
  __setTwilioClientFactoryForTests(() => ({
    messages: {
      create: async (params: CapturedCall) => {
        recordedCalls.push(params);
        // Twilio's create returns a Message resource — only `sid` +
        // `status` are read by `sendSms`.
        return {
          sid: `SMtest${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          status: "queued",
        };
      },
    },
  }));
  try {
    return await fn(recordedCalls);
  } finally {
    __setTwilioClientFactoryForTests(undefined);
  }
}

async function seedTwilioCredentials(opts: {
  accountSid?: string;
  authToken?: string;
  phoneNumber: string;
  messagingServiceSid?: string | null;
}): Promise<void> {
  const dbi = getDb();
  const rows = [
    { key: "twilio_account_sid", value: opts.accountSid ?? "ACtest_account_sid_for_msg_service_test" },
    { key: "twilio_auth_token", value: opts.authToken ?? "test_auth_token_for_msg_service_test" },
    { key: "twilio_phone_numbers", value: JSON.stringify([opts.phoneNumber]) },
  ];
  if (opts.messagingServiceSid !== undefined && opts.messagingServiceSid !== null) {
    rows.push({ key: "twilio_messaging_service_sid", value: opts.messagingServiceSid });
  }
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
    .values({ email: `task876-test-${Date.now()}@example.test`, role: "account_manager" })
    .returning();
  return u.id;
}

async function seedUserlessConversation(contactPhone: string, twilioPhone: string): Promise<string> {
  // sendSms creates a conversation if one doesn't exist for (to,from). We
  // pre-create one so the test asserts only the Twilio call shape, not
  // conversation-creation side effects.
  const [conv] = await getDb()
    .insert(twilioConversations)
    .values({
      contactPhone,
      twilioPhoneNumber: twilioPhone,
      status: "active",
    })
    .returning();
  return conv.id;
}

// ---------------------------------------------------------------------------
// (2) Integration: SID configured → sendSms calls messages.create with
//     `messagingServiceSid` and NO `from`.
// ---------------------------------------------------------------------------
async function testSendSmsWithMessagingServiceSid(): Promise<void> {
  console.log("\n— 2. sendSms() with Messaging Service SID configured —");

  await runInTxSandbox(async () => {
    const PHONE = "+15551110011";
    const SID = "MG2a1e5dbe111766170ecb0bb151e87b8a";
    await seedTwilioCredentials({ phoneNumber: PHONE, messagingServiceSid: SID });
    const userId = await seedTestUser();
    const convId = await seedUserlessConversation("+15552220011", PHONE);

    await withStubbedTwilioSdk(async (calls) => {
      const result = await sendSms({
        to: "+15552220011",
        body: "test via messaging service",
        userId,
        conversationId: convId,
      });

      check("sendSms returned a twilioSid", typeof result.twilioSid === "string" && result.twilioSid.startsWith("SMtest"), result.twilioSid);
      check("messages.create was called exactly once", calls.length === 1, `count=${calls.length}`);

      const params = calls[0];
      check(
        "create() called with messagingServiceSid: <MG…>",
        params.messagingServiceSid === SID,
        String(params.messagingServiceSid),
      );
      check(
        "create() did NOT include `from`",
        !("from" in params),
        `from=${params.from}`,
      );
      check(
        "create() body and to preserved",
        params.body === "test via messaging service" && params.to === "+15552220011",
        `body=${params.body} to=${params.to}`,
      );
      check(
        "create() still passes statusCallback (Task #875 preserved)",
        typeof params.statusCallback === "string" &&
          (params.statusCallback as string).endsWith("/api/twilio/webhooks/sms-status"),
        String(params.statusCallback),
      );

      // The stored row's fromNumber records our configured Twilio
      // phone (used for conversation thread matching) regardless of
      // whether the actual transport was RCS or SMS.
      const [row] = await getDb()
        .select()
        .from(twilioMessages)
        .where(eq(twilioMessages.twilioSid, result.twilioSid));
      check("persisted row fromNumber is the configured phone", row?.fromNumber === PHONE, String(row?.fromNumber));
      // Task #883: the row also records that this send actually went
      // out via the Messaging Service so the thread badge can show
      // "via Messaging Service MG…" instead of the configured phone.
      check(
        "persisted row records messagingServiceSid as the actual transport",
        row?.messagingServiceSid === SID,
        String(row?.messagingServiceSid),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// (3) Integration: SID empty/unset → sendSms calls messages.create with
//     `from` and NO `messagingServiceSid` (legacy behavior preserved).
// ---------------------------------------------------------------------------
async function testSendSmsWithoutMessagingServiceSid(): Promise<void> {
  console.log("\n— 3. sendSms() with NO Messaging Service SID configured —");

  await runInTxSandbox(async () => {
    const PHONE = "+15551110022";
    // Note: messagingServiceSid intentionally omitted from seed.
    await seedTwilioCredentials({ phoneNumber: PHONE });
    const userId = await seedTestUser();
    const convId = await seedUserlessConversation("+15552220022", PHONE);

    await withStubbedTwilioSdk(async (calls) => {
      await sendSms({
        to: "+15552220022",
        body: "legacy sms send",
        userId,
        conversationId: convId,
      });

      check("messages.create was called exactly once", calls.length === 1, `count=${calls.length}`);

      const params = calls[0];
      check(
        "create() called with `from`: <phoneNumber>",
        params.from === PHONE,
        String(params.from),
      );
      check(
        "create() did NOT include messagingServiceSid",
        !("messagingServiceSid" in params),
        `messagingServiceSid=${params.messagingServiceSid}`,
      );
      check(
        "create() still passes statusCallback (Task #875 preserved)",
        typeof params.statusCallback === "string" &&
          (params.statusCallback as string).endsWith("/api/twilio/webhooks/sms-status"),
        String(params.statusCallback),
      );
      // Task #883: the row's messagingServiceSid is null when the
      // legacy single-`from` path is used, so the thread badge can
      // render "via +1…" instead of "via Messaging Service".
      const [row] = await getDb()
        .select()
        .from(twilioMessages)
        .where(eq(twilioMessages.fromNumber, PHONE));
      check(
        "persisted row leaves messagingServiceSid NULL on legacy `from` path",
        row?.messagingServiceSid === null,
        String(row?.messagingServiceSid),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// (4) Integration: SID stored as empty string → still falls back to `from`.
//     Mirrors what the PUT route writes when an admin clears the field.
// ---------------------------------------------------------------------------
async function testSendSmsWithEmptyStringSid(): Promise<void> {
  console.log("\n— 4. sendSms() with empty-string SID falls back to `from` —");

  await runInTxSandbox(async () => {
    const PHONE = "+15551110033";
    await seedTwilioCredentials({ phoneNumber: PHONE, messagingServiceSid: "" });
    const userId = await seedTestUser();
    const convId = await seedUserlessConversation("+15552220033", PHONE);

    await withStubbedTwilioSdk(async (calls) => {
      await sendSms({
        to: "+15552220033",
        body: "cleared SID",
        userId,
        conversationId: convId,
      });

      const params = calls[0];
      check(
        "create() falls back to `from` when SID stored as ''",
        params.from === PHONE && !("messagingServiceSid" in params),
        JSON.stringify({ from: params.from, ms: params.messagingServiceSid }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio Messaging Service SID tests (Task #876)");

  testBuilderRoutesViaMessagingService();
  await testSendSmsWithMessagingServiceSid();
  await testSendSmsWithoutMessagingServiceSid();
  await testSendSmsWithEmptyStringSid();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
