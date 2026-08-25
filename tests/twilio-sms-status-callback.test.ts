/* test-registration
{
  "name": "Twilio SMS status-callback (Task #875)",
  "tier": "medium"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #875: focused test for Twilio's SMS delivery-status callback.
//
// Twilio POSTs to /api/twilio/webhooks/sms-status with MessageSid +
// MessageStatus (queued|sent|delivered|failed|undelivered, etc.) and
// — on failure paths — ErrorCode/ErrorMessage. We exercise the
// service handler directly (handleSmsStatus) in a tx sandbox so we
// can assert the row mutation without spinning up Express, signature
// verification, etc. — those are covered by twilio-api-compliance.
//
// We also exercise the unknown-SID branch (a callback for a row we
// never inserted, which can happen for races or replays after a row
// was deleted) and the recovery path where a row that briefly carried
// an error code later transitions back to a clean state.
//
// Usage: tsx tests/twilio-sms-status-callback.test.ts

import express from "express";
import type { AddressInfo } from "net";
import twilio from "twilio";

import { handleSmsStatus } from "../server/services/twilioService";
import * as twilioStorage from "../server/storage/twilioStorage";
import { registerTwilioRoutes } from "../server/routes/twilio";
import { systemSettings, twilioConversations, twilioMessages } from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { eq } from "drizzle-orm";

// Twilio's namespace exposes the matching signature generator. See
// node_modules/twilio/lib/index.d.ts.
const { getExpectedTwilioSignature } = twilio;
if (typeof getExpectedTwilioSignature !== "function") {
  throw new Error("twilio.getExpectedTwilioSignature not exported by SDK — cannot generate signatures for tests");
}

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

async function seedConversation() {
  const [conv] = await getDb()
    .insert(twilioConversations)
    .values({
      contactPhone: "+15552220000",
      twilioPhoneNumber: "+15551110000",
    })
    .returning();
  return conv;
}

async function seedOutboundMessage(twilioSid: string, conversationId: string) {
  // Mirrors what sendSms() persists: an outbound row in the initial
  // "queued" state with no error fields set.
  return twilioStorage.createTwilioMessage({
    conversationId,
    twilioSid,
    direction: "outbound",
    fromNumber: "+15551110000",
    toNumber: "+15552220000",
    body: "Test message body for status-callback fixture",
    status: "queued",
  });
}

async function getRow(twilioSid: string) {
  const [row] = await getDb()
    .select()
    .from(twilioMessages)
    .where(eq(twilioMessages.twilioSid, twilioSid));
  return row;
}

// ---------------------------------------------------------------------------
// (1) Happy path: queued → sent → delivered
// ---------------------------------------------------------------------------
async function testStatusProgression(): Promise<void> {
  console.log("\n— 1. status progression queued → sent → delivered —");

  await runInTxSandbox(async () => {
    const SID = `SMprog${Date.now().toString(36)}`;
    const conv = await seedConversation(); await seedOutboundMessage(SID, conv.id);

    const seeded = await getRow(SID);
    check("seeded status === 'queued'", seeded?.status === "queued", String(seeded?.status));
    check("seeded errorCode is null", seeded?.errorCode === null, String(seeded?.errorCode));

    // Twilio fires `sent` once it hands off to the carrier.
    await handleSmsStatus({ messageSid: SID, messageStatus: "sent" });
    let row = await getRow(SID);
    check("after 'sent' → status === 'sent'", row?.status === "sent", String(row?.status));
    check("after 'sent' → errorCode still null", row?.errorCode === null, String(row?.errorCode));

    // …then `delivered` once the handset ACKs.
    await handleSmsStatus({ messageSid: SID, messageStatus: "delivered" });
    row = await getRow(SID);
    check("after 'delivered' → status === 'delivered'", row?.status === "delivered", String(row?.status));
    check("after 'delivered' → errorCode still null", row?.errorCode === null, String(row?.errorCode));
    check("after 'delivered' → errorMessage still null", row?.errorMessage === null, String(row?.errorMessage));
  });
}

// ---------------------------------------------------------------------------
// (2) Failure path: queued → failed with ErrorCode/ErrorMessage
// ---------------------------------------------------------------------------
async function testFailureWithErrorCode(): Promise<void> {
  console.log("\n— 2. failure path persists ErrorCode + ErrorMessage —");

  await runInTxSandbox(async () => {
    const SID = `SMfail${Date.now().toString(36)}`;
    const conv = await seedConversation(); await seedOutboundMessage(SID, conv.id);

    // Twilio error 30003 = "Unreachable destination handset".
    // Docs: https://www.twilio.com/docs/api/errors/30003
    await handleSmsStatus({
      messageSid: SID,
      messageStatus: "failed",
      errorCode: "30003",
      errorMessage: "Unreachable destination handset",
    });

    const row = await getRow(SID);
    check("status === 'failed'", row?.status === "failed", String(row?.status));
    check("errorCode === '30003'", row?.errorCode === "30003", String(row?.errorCode));
    check(
      "errorMessage preserved verbatim",
      row?.errorMessage === "Unreachable destination handset",
      String(row?.errorMessage),
    );
  });
}

// ---------------------------------------------------------------------------
// (3) Failure path: undelivered with no ErrorMessage (Twilio sometimes omits it)
// ---------------------------------------------------------------------------
async function testUndeliveredWithoutErrorMessage(): Promise<void> {
  console.log("\n— 3. undelivered with ErrorCode but no ErrorMessage —");

  await runInTxSandbox(async () => {
    const SID = `SMund${Date.now().toString(36)}`;
    const conv = await seedConversation(); await seedOutboundMessage(SID, conv.id);

    await handleSmsStatus({
      messageSid: SID,
      messageStatus: "undelivered",
      errorCode: "30005",
      // errorMessage intentionally undefined.
    });

    const row = await getRow(SID);
    check("status === 'undelivered'", row?.status === "undelivered", String(row?.status));
    check("errorCode === '30005'", row?.errorCode === "30005", String(row?.errorCode));
    check("errorMessage stays null when omitted", row?.errorMessage === null, String(row?.errorMessage));
  });
}

// ---------------------------------------------------------------------------
// (4) Unknown SID — a callback for a row we never inserted is a clean no-op.
//     This covers replay / race-after-delete scenarios.
// ---------------------------------------------------------------------------
async function testUnknownSidIsNoop(): Promise<void> {
  console.log("\n— 4. unknown MessageSid is a clean no-op —");

  await runInTxSandbox(async () => {
    const ghostSid = `SMghost${Date.now().toString(36)}`;
    // Should not throw, and should not insert a phantom row.
    await handleSmsStatus({
      messageSid: ghostSid,
      messageStatus: "delivered",
    });
    const row = await getRow(ghostSid);
    check("no row created for unknown SID", row === undefined, row ? "row was created" : "ok");
  });
}

// ---------------------------------------------------------------------------
// (5) Empty MessageSid is rejected at the service layer (defense in depth —
//     the route also 400s on this).
// ---------------------------------------------------------------------------
async function testEmptySidIsRejected(): Promise<void> {
  console.log("\n— 5. empty MessageSid is rejected (no DB write) —");

  await runInTxSandbox(async () => {
    // Seed one row so we can prove no other rows were touched.
    const SID = `SMguard${Date.now().toString(36)}`;
    const conv = await seedConversation(); await seedOutboundMessage(SID, conv.id);

    await handleSmsStatus({ messageSid: "", messageStatus: "delivered" });

    const row = await getRow(SID);
    check("seeded row's status is unchanged", row?.status === "queued", String(row?.status));
  });
}

// ---------------------------------------------------------------------------
// (6) Recovery — if a row briefly carried an error code, a later non-error
//     status callback clears the error fields back to null.
// ---------------------------------------------------------------------------
async function testRecoveryClearsErrorFields(): Promise<void> {
  console.log("\n— 6. later non-error status clears prior error fields —");

  await runInTxSandbox(async () => {
    const SID = `SMrecov${Date.now().toString(36)}`;
    const conv = await seedConversation(); await seedOutboundMessage(SID, conv.id);

    // First: a transient failure with diagnostic info.
    await handleSmsStatus({
      messageSid: SID,
      messageStatus: "failed",
      errorCode: "30003",
      errorMessage: "Unreachable destination handset",
    });
    let row = await getRow(SID);
    check("intermediate state has errorCode", row?.errorCode === "30003", String(row?.errorCode));

    // Then: a later callback indicating recovery (rare but legal — e.g.
    // operator retries on a sub-account). New state must overwrite the
    // error fields, not leave stale diagnostics behind.
    await handleSmsStatus({ messageSid: SID, messageStatus: "delivered" });
    row = await getRow(SID);
    check("recovered status === 'delivered'", row?.status === "delivered", String(row?.status));
    check("recovered errorCode cleared to null", row?.errorCode === null, String(row?.errorCode));
    check("recovered errorMessage cleared to null", row?.errorMessage === null, String(row?.errorMessage));
  });
}

// ---------------------------------------------------------------------------
// (6b) Task #883 — webhook backfills `messaging_service_sid` on a row that
//      didn't know its transport (e.g. inserted before the column existed).
//      Also asserts an absent `MessagingServiceSid` on a later callback
//      does NOT wipe a value that was already populated on insert.
// ---------------------------------------------------------------------------
async function testStatusCallbackBackfillsMessagingServiceSid(): Promise<void> {
  console.log("\n— 6b. status callback backfills messaging_service_sid (Task #883) —");

  await runInTxSandbox(async () => {
    // (a) Pre-#883 row: persisted with no transport recorded. A status
    // callback that carries MessagingServiceSid must populate it.
    const SID_A = `SMbf${Date.now().toString(36)}a`;
    const convA = await seedConversation();
    await seedOutboundMessage(SID_A, convA.id);
    let rowA = await getRow(SID_A);
    check("pre-backfill: messagingServiceSid is null", rowA?.messagingServiceSid === null, String(rowA?.messagingServiceSid));

    const MGSID = "MG2a1e5dbe111766170ecb0bb151e87b8a";
    await handleSmsStatus({
      messageSid: SID_A,
      messageStatus: "delivered",
      messagingServiceSid: MGSID,
    });
    rowA = await getRow(SID_A);
    check(
      "after callback with MessagingServiceSid: column populated",
      rowA?.messagingServiceSid === MGSID,
      String(rowA?.messagingServiceSid),
    );
    check("status also progressed to delivered", rowA?.status === "delivered", String(rowA?.status));

    // (b) Row already has a transport. A later callback that omits
    // MessagingServiceSid must NOT wipe it.
    const SID_B = `SMbf${Date.now().toString(36)}b`;
    const convB = await seedConversation();
    await twilioStorage.createTwilioMessage({
      conversationId: convB.id,
      twilioSid: SID_B,
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15552220000",
      body: "row that already knows its transport",
      status: "queued",
      messagingServiceSid: MGSID,
    });
    await handleSmsStatus({
      messageSid: SID_B,
      messageStatus: "delivered",
      // messagingServiceSid intentionally omitted.
    });
    const rowB = await getRow(SID_B);
    check(
      "absent MessagingServiceSid does NOT wipe an existing value",
      rowB?.messagingServiceSid === MGSID,
      String(rowB?.messagingServiceSid),
    );
  });
}

// ---------------------------------------------------------------------------
// (7) Endpoint-level integration: real HTTP POST to
//     /api/twilio/webhooks/sms-status with a valid Twilio signature
//     mutates the row and returns empty TwiML.
// ---------------------------------------------------------------------------
//
// Spins up a tiny Express app with the real registerTwilioRoutes() so
// we exercise the full pipeline: signature middleware → withDbHoldLabel
// → handleSmsStatus → storage update. Auth token is seeded inside the
// sandbox so the rollback wipes it.
// Raw http POST so we can override the Host header (undici/fetch blocks it).
async function rawHttpPost(
  urlStr: string,
  body: string,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const http = await import("http");
  const u = new URL(urlStr);
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      ...extraHeaders,
    };
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    if (extraHeaders.host) {
      // Node http strips a `host` from the headers map and uses its
      // own; setHeader after request creation is the documented escape.
      req.setHeader("host", extraHeaders.host);
    }
    req.on("error", reject);
    req.end(body);
  });
}

async function withTwilioApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  // Mirrors server/index.ts body-parsing for Twilio webhooks (form-encoded).
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
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

async function testEndpointSignedWebhookMutation(): Promise<void> {
  console.log("\n— 7. POST /api/twilio/webhooks/sms-status (signed, end-to-end) —");

  await runInTxSandbox(async () => {
    const TOKEN = "test_auth_token_for_status_callback";
    // Seed auth token so validateTwilioWebhook accepts our signature.
    await getDb()
      .insert(systemSettings)
      .values({ key: "twilio_auth_token", value: TOKEN })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: TOKEN } });

    // Seed the message row that the callback will mutate.
    const SID = `SMendpt${Date.now().toString(36)}`;
    const conv = await seedConversation();
    await seedOutboundMessage(SID, conv.id);

    await withTwilioApp(async (baseUrl) => {
      const url = `${baseUrl}/api/twilio/webhooks/sms-status`;
      // The signature middleware reconstructs the URL from
      // x-forwarded-proto + Host. We hash the public-style URL and
      // pass matching headers so verification succeeds against the
      // local socket.
      const publicUrl = `https://127.0.0.1/api/twilio/webhooks/sms-status`;
      const params: Record<string, string> = {
        MessageSid: SID,
        MessageStatus: "failed",
        ErrorCode: "30007",
        ErrorMessage: "Carrier violation",
      };
      const sig = getExpectedTwilioSignature(TOKEN, publicUrl, params);
      const body = new URLSearchParams(params).toString();

      const r = await rawHttpPost(url, body, {
        "x-twilio-signature": sig,
        "x-forwarded-proto": "https",
        host: "127.0.0.1",
      });
      check("signed POST returns 200", r.status === 200, `got ${r.status}`);
      check("response body is empty TwiML envelope", r.body.trim().includes("<Response>"), r.body);

      // Confirm DB row was mutated.
      const row = await getRow(SID);
      check("status === 'failed' after webhook", row?.status === "failed", String(row?.status));
      check("errorCode === '30007' after webhook", row?.errorCode === "30007", String(row?.errorCode));
      check(
        "errorMessage === 'Carrier violation' after webhook",
        row?.errorMessage === "Carrier violation",
        String(row?.errorMessage),
      );
    });

    // Tampered-body case — signature was over the original payload, so
    // a different body must be rejected at the middleware before
    // touching the DB. We seed a SECOND row to prove non-mutation.
    const SID2 = `SMendpt2${Date.now().toString(36)}`;
    await seedOutboundMessage(SID2, conv.id);
    await withTwilioApp(async (baseUrl) => {
      const url = `${baseUrl}/api/twilio/webhooks/sms-status`;
      const publicUrl = `https://127.0.0.1/api/twilio/webhooks/sms-status`;
      const original: Record<string, string> = { MessageSid: SID2, MessageStatus: "delivered" };
      const sig = getExpectedTwilioSignature(TOKEN, publicUrl, original);
      const tampered = new URLSearchParams({ MessageSid: SID2, MessageStatus: "failed" }).toString();

      const r = await rawHttpPost(url, tampered, {
        "x-twilio-signature": sig,
        "x-forwarded-proto": "https",
        host: "127.0.0.1",
      });
      check("tampered body → 403 (middleware fail-closed)", r.status === 403, `got ${r.status}`);

      const row = await getRow(SID2);
      check(
        "row untouched after rejected tampered request",
        row?.status === "queued",
        String(row?.status),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// (8) Incremental fetch (`?updatedSince=…`) sees status mutations even
//     when nothing was inserted. This is the core of Task #875's UI
//     story: the thread polls every 5s and the server must surface
//     queued → sent → delivered transitions on existing rows.
// ---------------------------------------------------------------------------
async function testListMessagesUpdatedSinceWatermark(): Promise<void> {
  console.log("\n— 8. listTwilioMessages({updatedSince}) sees in-place status mutations —");

  await runInTxSandbox(async () => {
    const SID = `SMupd${Date.now().toString(36)}`;
    const conv = await seedConversation();
    const seeded = await seedOutboundMessage(SID, conv.id);

    // Snapshot the watermark the client would use after its initial
    // load: the row's current updatedAt (== createdAt at this point).
    const initialUpdatedAt = seeded?.updatedAt ?? seeded?.createdAt ?? null;
    check(
      "seeded row carries an updatedAt watermark",
      initialUpdatedAt !== null,
      String(initialUpdatedAt),
    );
    if (!initialUpdatedAt) return;

    // Poll #1: nothing has changed since the marker — server should
    // return zero rows. This is the no-op fast path.
    let polled = await twilioStorage.listTwilioMessages(conv.id, 100, {
      afterId: seeded?.id,
      updatedSince: new Date(initialUpdatedAt as unknown as string),
    });
    check(
      "no-op poll returns zero rows when nothing changed",
      polled.length === 0,
      `got ${polled.length}`,
    );

    // Twilio fires a status callback. createdAt does NOT change but
    // updatedAt MUST advance.
    // Tiny sleep so the new updatedAt is strictly greater than the
    // marker even on fast machines (Postgres timestamp resolution is
    // microseconds, but we're being defensive).
    await new Promise((r) => setTimeout(r, 5));
    await handleSmsStatus({ messageSid: SID, messageStatus: "delivered" });

    // Poll #2: same marker, but now the row's updatedAt has advanced,
    // so the server returns it. The client merger overwrites the row
    // in place (same id) and the user sees "delivered".
    polled = await twilioStorage.listTwilioMessages(conv.id, 100, {
      afterId: seeded?.id,
      updatedSince: new Date(initialUpdatedAt as unknown as string),
    });
    check(
      "in-place status update is returned by updatedSince poll",
      polled.length === 1 && polled[0].twilioSid === SID,
      `len=${polled.length} sid=${polled[0]?.twilioSid}`,
    );
    check(
      "returned row reflects the new status",
      polled[0]?.status === "delivered",
      String(polled[0]?.status),
    );
    check(
      "returned row's updatedAt advanced past the marker",
      polled[0]?.updatedAt != null &&
        new Date(polled[0].updatedAt as unknown as string).getTime() >
          new Date(initialUpdatedAt as unknown as string).getTime(),
      `marker=${initialUpdatedAt} new=${polled[0]?.updatedAt}`,
    );

    // Poll #3: caller advances its watermark to the new updatedAt;
    // server should once again return zero rows.
    const newWatermark = polled[0].updatedAt as unknown as string;
    polled = await twilioStorage.listTwilioMessages(conv.id, 100, {
      afterId: seeded?.id,
      updatedSince: new Date(newWatermark),
    });
    check(
      "advanced watermark stops returning the same row",
      polled.length === 0,
      `got ${polled.length}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio SMS status-callback tests (Task #875)");

  await testStatusProgression();
  await testFailureWithErrorCode();
  await testUndeliveredWithoutErrorMessage();
  await testUnknownSidIsNoop();
  await testEmptySidIsRejected();
  await testRecoveryClearsErrorFields();
  await testStatusCallbackBackfillsMessagingServiceSid();
  await testEndpointSignedWebhookMutation();
  await testListMessagesUpdatedSinceWatermark();

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
