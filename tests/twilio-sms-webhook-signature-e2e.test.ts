/* test-registration
{
  "name": "Twilio inbound SMS webhook signature e2e (Task #863)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #863: end-to-end test for the inbound SMS webhook signature flow.
//
// The existing twilio-api-compliance suite covers `validateTwilioWebhook`
// in isolation against a stub `/webhook` route. This test exercises the
// real `/api/twilio/webhooks/sms` route registered by `registerTwilioRoutes`
// so we lock in URL construction (scheme/host/path) and the
// signature-middleware → handler → DB write pipeline as a single unit.
//
// What's verified:
//   1. A correctly-signed POST returns 200 and persists the inbound row.
//   2. A POST with a tampered body returns 403 (and never touches the DB).
//   3. A POST with no `X-Twilio-Signature` header returns 403.
//
// Twilio webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// Usage: tsx tests/twilio-sms-webhook-signature-e2e.test.ts

import express from "express";
import type { AddressInfo } from "net";
import twilio from "twilio";

import { registerTwilioRoutes } from "../server/routes/twilio";
import {
  systemSettings,
  twilioMessages,
  rawCommunicationRecords,
} from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { eq } from "drizzle-orm";

const { getExpectedTwilioSignature } = twilio;
if (typeof getExpectedTwilioSignature !== "function") {
  throw new Error(
    "twilio.getExpectedTwilioSignature not exported by SDK — cannot generate signatures for tests",
  );
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

// Raw http POST so we can override the Host header (undici/fetch blocks
// arbitrary `Host` overrides). The signature middleware reconstructs the
// canonical URL from x-forwarded-proto + Host, so we need to control both
// to hash a stable URL that doesn't depend on the ephemeral local port.
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
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    if (extraHeaders.host) {
      // Node's http module strips a `host` from the headers map and uses
      // its own; setHeader after request creation is the documented
      // escape hatch.
      req.setHeader("host", extraHeaders.host);
    }
    req.on("error", reject);
    req.end(body);
  });
}

async function withTwilioApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  // Mirrors server/index.ts body-parsing for Twilio webhooks.
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

async function testInboundSmsWebhookSignatureE2E(): Promise<void> {
  console.log("\n— POST /api/twilio/webhooks/sms — signature flow (end-to-end) —");

  await runInTxSandbox(async () => {
    const TOKEN = "test_auth_token_for_inbound_sms_e2e";
    // Seed the auth token inside the sandbox so the rollback wipes it.
    await getDb()
      .insert(systemSettings)
      .values({ key: "twilio_auth_token", value: TOKEN })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: TOKEN },
      });

    // Sanity: middleware must read this row via getDb() inside the sandbox.
    const [row] = await getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "twilio_auth_token"));
    check("auth token visible inside tx sandbox", row?.value === TOKEN);

    await withTwilioApp(async (baseUrl) => {
      const url = `${baseUrl}/api/twilio/webhooks/sms`;
      // Stable public-style URL that the middleware will reconstruct
      // from x-forwarded-proto + host. Hashing against this URL — not
      // the ephemeral http://127.0.0.1:<port> URL — is what the
      // production Twilio request actually does.
      const publicUrl = "https://public.example.com/api/twilio/webhooks/sms";
      const proxyHeaders = {
        "x-forwarded-proto": "https",
        host: "public.example.com",
      };

      // (1) Correctly-signed POST → 200 and inbound row persisted.
      {
        const SID = `SMe2e${Date.now().toString(36)}`;
        const params: Record<string, string> = {
          From: "+15551112222",
          To: "+15553334444",
          Body: "Hello from signed e2e test",
          MessageSid: SID,
        };
        const sig = getExpectedTwilioSignature(TOKEN, publicUrl, params);
        const body = new URLSearchParams(params).toString();

        const r = await rawHttpPost(url, body, {
          "x-twilio-signature": sig,
          ...proxyHeaders,
        });
        check("signed POST → 200", r.status === 200, `got ${r.status}`);
        check(
          "signed POST → empty TwiML body",
          r.body.trim().includes("<Response>"),
          r.body,
        );

        // The handler must have persisted the inbound message + the raw
        // communication record under the canonical MessageSid.
        const msgs = await getDb()
          .select()
          .from(twilioMessages)
          .where(eq(twilioMessages.twilioSid, SID));
        check(
          "signed POST → exactly 1 twilio_messages row inserted",
          msgs.length === 1,
          `got ${msgs.length}`,
        );
        if (msgs[0]) {
          check(
            "inserted row direction === 'inbound'",
            msgs[0].direction === "inbound",
            String(msgs[0].direction),
          );
          check(
            "inserted row body preserved verbatim",
            msgs[0].body === params.Body,
            String(msgs[0].body),
          );
        }

        const raws = await getDb()
          .select()
          .from(rawCommunicationRecords)
          .where(eq(rawCommunicationRecords.externalSourceId, SID));
        check(
          "signed POST → raw_communication_records row created",
          raws.length === 1,
          `got ${raws.length}`,
        );
      }

      // (2) Tampered body → 403, and DB is NOT mutated for the tampered SID.
      {
        const SID = `SMtamper${Date.now().toString(36)}`;
        const original: Record<string, string> = {
          From: "+15551112222",
          To: "+15553334444",
          Body: "Hello from signed e2e test",
          MessageSid: SID,
        };
        const sig = getExpectedTwilioSignature(TOKEN, publicUrl, original);
        const tampered = new URLSearchParams({
          ...original,
          Body: "EVIL injected text",
        }).toString();

        const r = await rawHttpPost(url, tampered, {
          "x-twilio-signature": sig,
          ...proxyHeaders,
        });
        check("tampered body → 403", r.status === 403, `got ${r.status}`);
        check(
          "tampered body → TwiML envelope returned",
          r.body.trim().includes("<Response>"),
          r.body,
        );

        const msgs = await getDb()
          .select()
          .from(twilioMessages)
          .where(eq(twilioMessages.twilioSid, SID));
        check(
          "tampered body → no twilio_messages row written",
          msgs.length === 0,
          `got ${msgs.length}`,
        );
        const raws = await getDb()
          .select()
          .from(rawCommunicationRecords)
          .where(eq(rawCommunicationRecords.externalSourceId, SID));
        check(
          "tampered body → no raw_communication_records row written",
          raws.length === 0,
          `got ${raws.length}`,
        );
      }

      // (4) Audit A-004 — Twilio's documented signature scheme (URL + params,
      // no timestamp) cannot cryptographically support a replay window, so
      // NO timestamp check was added; the replayed-request defense is the
      // MessageSid dedupe in handleInboundSms. A replayed identical signed
      // request must still return 200 and leave exactly one row.
      {
        const SID = `SMreplay${Date.now().toString(36)}`;
        const params: Record<string, string> = {
          From: "+15551112222",
          To: "+15553334444",
          Body: "replayed delivery",
          MessageSid: SID,
        };
        const sig = getExpectedTwilioSignature(TOKEN, publicUrl, params);
        const body = new URLSearchParams(params).toString();
        const headers = { "x-twilio-signature": sig, ...proxyHeaders };

        const first = await rawHttpPost(url, body, headers);
        check("replay test: first signed POST → 200", first.status === 200, `got ${first.status}`);
        const replay = await rawHttpPost(url, body, headers);
        check(
          "replayed identical signed POST → still 200 (no timestamp check)",
          replay.status === 200,
          `got ${replay.status}`,
        );
        const msgs = await getDb()
          .select()
          .from(twilioMessages)
          .where(eq(twilioMessages.twilioSid, SID));
        check(
          "replayed delivery → still exactly 1 twilio_messages row (SID dedupe)",
          msgs.length === 1,
          `got ${msgs.length}`,
        );
      }

      // (3) Missing X-Twilio-Signature header → 403, no DB write.
      {
        const SID = `SMnosig${Date.now().toString(36)}`;
        const body = new URLSearchParams({
          From: "+15551112222",
          To: "+15553334444",
          Body: "no signature header",
          MessageSid: SID,
        }).toString();

        const r = await rawHttpPost(url, body, { ...proxyHeaders });
        check(
          "missing X-Twilio-Signature → 403",
          r.status === 403,
          `got ${r.status}`,
        );
        check(
          "missing-signature response → TwiML envelope",
          r.body.trim().includes("<Response>"),
          r.body,
        );

        const msgs = await getDb()
          .select()
          .from(twilioMessages)
          .where(eq(twilioMessages.twilioSid, SID));
        check(
          "missing-signature → no twilio_messages row written",
          msgs.length === 0,
          `got ${msgs.length}`,
        );
      }
    });
  });
}

async function main(): Promise<void> {
  console.log("Twilio inbound SMS webhook signature e2e (Task #863)");

  await testInboundSmsWebhookSignatureE2E();

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
