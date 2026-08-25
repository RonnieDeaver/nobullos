/* test-registration
{
  "name": "Twilio API compliance (Task #859)",
  "scanPaths": [
    "server/routes/twilio.ts"
  ],
  "tier": "medium"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #859: focused tests for the audit-driven behavior changes plus
// real integration coverage for the webhook signature middleware and
// the canonical TwiML responders.
//
// Usage: tsx tests/twilio-api-compliance.test.ts

import express from "express";
import type { AddressInfo } from "net";
import twilio from "twilio";
import { z } from "zod";

import { describeTwilioError } from "../server/services/twilioErrors";
import { validateTwilioWebhook } from "../server/routes/twilio";
import { handleInboundSms, handleCallStatus } from "../server/services/twilioService";
import * as twilioStorage from "../server/storage/twilioStorage";
import { systemSettings, twilioMessages, twilioCalls, rawCommunicationRecords } from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { eq } from "drizzle-orm";

// Twilio's namespace exposes both `validateRequest` and the matching
// signature generator. See node_modules/twilio/lib/index.d.ts:66-67.
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

// ---------------------------------------------------------------------------
// (1) describeTwilioError surfaces Twilio diagnostics
// ---------------------------------------------------------------------------
function testDescribeTwilioError(): void {
  console.log("\n— 1. describeTwilioError —");

  const restEx = Object.assign(new Error("Invalid 'To' Phone Number"), {
    status: 400,
    code: 21211,
    moreInfo: "https://www.twilio.com/docs/errors/21211",
  });
  const out = describeTwilioError(restEx);
  check("includes HTTP status", out.includes("HTTP 400"), out);
  check("includes Twilio code", out.includes("Twilio code 21211"), out);
  check("includes original message", out.includes("Invalid 'To' Phone Number"), out);
  check("includes moreInfo URL", out.includes("https://www.twilio.com/docs/errors/21211"), out);

  const plainOut = describeTwilioError(new Error("ECONNRESET"));
  check("plain Error has no [HTTP …] tag", !plainOut.includes("HTTP") && plainOut.includes("ECONNRESET"), plainOut);
  check("bare string returned as-is", describeTwilioError("oops") === "oops");
  check("null → 'Unknown error'", describeTwilioError(null) === "Unknown error");
  check("undefined → 'Unknown error'", describeTwilioError(undefined) === "Unknown error");
  check("number → 'Unknown error'", describeTwilioError(42) === "Unknown error");

  const noCodeOut = describeTwilioError(Object.assign(new Error("Server error"), { status: 500 }));
  check("status-only error still tagged", noCodeOut.includes("[HTTP 500]") && noCodeOut.includes("Server error"), noCodeOut);
  check("empty object → fallback string", describeTwilioError({} as unknown) === "Twilio request failed");
}

// ---------------------------------------------------------------------------
// (2) E.164 phone validation in PUT /api/twilio/config
// ---------------------------------------------------------------------------
function testE164PhoneValidation(): void {
  console.log("\n— 2. E.164 validation on PUT /api/twilio/config —");

  // Mirror the schema used in server/routes/twilio.ts so we test the
  // exact regex + zod chain.
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  const phoneNumbersSchema = z.array(
    z.string().trim().regex(e164Regex, "Phone numbers must be E.164 (e.g. +15551234567)"),
  );

  for (const p of ["+15551234567", "+442012345678", "+61291234567"]) {
    check(`accepts E.164 ${p}`, phoneNumbersSchema.safeParse([p]).success);
  }
  check("accepts empty array", phoneNumbersSchema.safeParse([]).success);
  check("rejects bare 10-digit (no leading +)", !phoneNumbersSchema.safeParse(["5551234567"]).success);
  check("rejects hyphenated number", !phoneNumbersSchema.safeParse(["+1-555-123-4567"]).success);
  check("rejects alphabetic input", !phoneNumbersSchema.safeParse(["+1555ABCDEFG"]).success);
  check("rejects leading-zero number", !phoneNumbersSchema.safeParse(["+0123456789"]).success);
  check("rejects >15-digit number", !phoneNumbersSchema.safeParse(["+1234567890123456"]).success);

  const padded = phoneNumbersSchema.safeParse(["  +15551234567  "]);
  check("trims whitespace before validation", padded.success && padded.data?.[0] === "+15551234567");

  check(
    "rejects array if any element is invalid",
    !phoneNumbersSchema.safeParse(["+15551234567", "invalid"]).success,
  );
}

// ---------------------------------------------------------------------------
// (3) validateTwilioWebhook — REAL integration test against the middleware
// ---------------------------------------------------------------------------
//
// Spins up a tiny Express app, mounts the actual middleware, and exercises
// every branch with real HTTP requests. Token storage runs inside a
// transactional sandbox so nothing leaks into system_settings.
//
// Twilio docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
async function withTestApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post(
    "/webhook",
    validateTwilioWebhook,
    (_req, res) => res.status(200).type("text/xml").send("<Response/>"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function formEncode(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function testWebhookSignatureMiddleware(): Promise<void> {
  console.log("\n— 3. validateTwilioWebhook (live middleware) —");

  const TOKEN = "test_auth_token_for_sig";
  const PARAMS = { From: "+15551112222", To: "+15553334444", Body: "Hello", MessageSid: "SM1234" };

  await runInTxSandbox(async () => {
    // Seed the token inside the sandbox so the rollback wipes it.
    await getDb()
      .insert(systemSettings)
      .values({ key: "twilio_auth_token", value: TOKEN })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: TOKEN } });

    // Sanity: middleware must read this row via getDb().
    const [row] = await getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "twilio_auth_token"));
    check("token row visible inside sandbox", row?.value === TOKEN);

    await withTestApp(async (baseUrl) => {
      const url = `${baseUrl}/webhook`;
      // Middleware defaults x-forwarded-proto to "https" when absent —
      // and uses the Host header (`127.0.0.1:<port>`) — so the canonical
      // URL it hashes is `https://127.0.0.1:<port>/webhook`, NOT the
      // `http://...` URL we hit at the socket layer. Compute against the
      // reconstructed URL.
      const hostUrl = url.replace(/^http:/, "https:");
      const body = formEncode(PARAMS);

      // (a) Missing X-Twilio-Signature header → 403
      {
        const r = await rawHttpPost(url, body, {});
        check("missing X-Twilio-Signature → 403", r.status === 403, `got ${r.status}`);
        check("403 body is empty TwiML", r.body.trim().includes("<Response>"), "TwiML envelope expected");
      }

      // (b) Valid signature → 200, downstream handler reached
      {
        const sig = getExpectedTwilioSignature(TOKEN, hostUrl, PARAMS);
        const r = await rawHttpPost(url, body, { "x-twilio-signature": sig });
        check("valid signature → 200", r.status === 200, `got ${r.status}`);
      }

      // (c) Tampered body → 403 (signature was over original PARAMS, body is different)
      {
        const sig = getExpectedTwilioSignature(TOKEN, hostUrl, PARAMS);
        const tampered = formEncode({ ...PARAMS, Body: "EVIL injected text" });
        const r = await rawHttpPost(url, tampered, { "x-twilio-signature": sig });
        check("tampered body → 403", r.status === 403, `got ${r.status}`);
      }

      // (d) Wrong signature → 403
      {
        const r = await rawHttpPost(url, body, { "x-twilio-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
        check("invalid signature → 403", r.status === 403, `got ${r.status}`);
      }

      // (e) Proxy URL reconstruction: x-forwarded-proto=https, Host=public.example.com.
      // The middleware must hash `https://public.example.com/webhook`, NOT the local
      // 127.0.0.1:<port> URL — so a signature computed against the public URL must
      // verify, even though the request hit a different local socket. We use raw
      // Node http here because undici/fetch refuses custom Host headers.
      {
        const publicUrl = "https://public.example.com/webhook";
        const sig = getExpectedTwilioSignature(TOKEN, publicUrl, PARAMS);
        const r = await rawHttpPost(url, body, {
          "x-twilio-signature": sig,
          "x-forwarded-proto": "https",
          host: "public.example.com",
        });
        check("proxy URL reconstruction (x-forwarded-proto + host) → 200", r.status === 200, `got ${r.status}`);
      }
    });
  });
}

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
        // Bypass Node 18's "host header lock" by passing it via setHeader.
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
      // own; setHeader after request creation is the documented escape
      // hatch.
      req.setHeader("host", extraHeaders.host);
    }
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// (4) Token-missing branch — dev/test passes through, prod fails closed
// ---------------------------------------------------------------------------
//
// We exercise the no-token case OUTSIDE the sandbox by ensuring no
// row exists, then flip NODE_ENV to assert the env-gating decision.
async function testNoTokenEnvGating(): Promise<void> {
  console.log("\n— 4. validateTwilioWebhook — no token (env-gated) —");

  // Only run if there's genuinely no token row in the live DB. The
  // test must not destroy a real prod token, so we read first and bail
  // (with a passthrough check on the env-decision logic) if one exists.
  const [existing] = await getDb()
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "twilio_auth_token"));

  if (existing?.value) {
    console.log("  ⓘ skipping live no-token case — twilio_auth_token already set in this DB");
    return;
  }

  await withTestApp(async (baseUrl) => {
    const url = `${baseUrl}/webhook`;
    const body = formEncode({ From: "+15551112222", To: "+15553334444", Body: "x" });

    // (a) NODE_ENV=test → passthrough with warning
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      check("no token + NODE_ENV=test → 200 passthrough", r.status === 200, `got ${r.status}`);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // (b) NODE_ENV=production → fail closed (503)
    process.env.NODE_ENV = "production";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      check("no token + NODE_ENV=production → 503 fail-closed", r.status === 503, `got ${r.status}`);
      const txt = await r.text();
      check("503 body is empty TwiML", txt.includes("<Response>"), txt);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
}

// ---------------------------------------------------------------------------
// (5) TwiML responders — static-shape compliance check
// ---------------------------------------------------------------------------
//
// Reads the route file and asserts every TwiML emission obeys the
// documented contract: <Response> envelope, no misspelled status enums,
// all dynamic interpolation passes through escapeXml(), inbound voice
// uses <Gather> for IVR DTMF.
async function testTwimlResponderShape(): Promise<void> {
  console.log("\n— 5. TwiML responder static-shape check —");

  const fs = await import("fs/promises");
  const rawFile = await fs.readFile("server/routes/twilio.ts", "utf-8");

  // Strip JS comments — they sometimes mention `<Response>` / `<Say>` in
  // prose without a matching close tag, which makes the raw text count
  // look unbalanced even though every runtime emission is well-formed.
  let file = rawFile
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // Also strip the specific `.replace("<Response>", `<Response>\n…`)`
  // pattern used to inject the disclosure <Say> into the IVR template.
  // The runtime result is balanced (the closing </Response> comes from
  // the `ivr` variable on the LHS of the replace), but the source-text
  // count picks up 2 extra opening tags (needle + replacement template)
  // with no matching closes in the same string.
  file = file.replace(
    /\.replace\(\s*"<Response>"\s*,\s*`<Response>[^`]*`\s*\)/g,
    ".replace(/* twiml-insert */)",
  );

  // Every <Response>…</Response> block must be balanced (rough check —
  // count opening tags vs closing+self-closing).
  const openCount = (file.match(/<Response>/g) || []).length;
  const closeCount = (file.match(/<\/Response>/g) || []).length;
  const selfCloseCount = (file.match(/<Response\s*\/>/g) || []).length;
  check(
    "every <Response> has a matching </Response> or self-close",
    openCount === closeCount,
    `open=${openCount} close=${closeCount} selfClose=${selfCloseCount}`,
  );
  check("at least one TwiML envelope is emitted", openCount + selfCloseCount > 0);

  // <Say> verbs must be properly closed.
  const sayOpen = (file.match(/<Say[> ]/g) || []).length;
  const sayClose = (file.match(/<\/Say>/g) || []).length;
  check("every <Say> has a matching </Say>", sayOpen === sayClose, `open=${sayOpen} close=${sayClose}`);

  // <Gather> wraps the inbound IVR menu.
  check("inbound IVR uses <Gather>", file.includes("<Gather "), "expected <Gather …> in voice TwiML");
  check("inbound IVR <Gather> uses action attr", /<Gather[^>]*\baction=/.test(file), "expected action= on <Gather>");
  check(
    "inbound IVR <Gather> uses numDigits attr",
    /<Gather[^>]*\bnumDigits=/.test(file),
    "expected numDigits= on <Gather>",
  );

  // <Dial>/<Number> for routed calls.
  // <Dial> verbs in this file always carry attributes (callerId, recording
  // attrs, action URL, etc.), so allow `<Dial …>` before `<Number`.
  check(
    "outbound bridge uses <Dial><Number>…</Number></Dial>",
    /<Dial(\s[^>]*)?>\s*<Number[^>]*>/.test(file),
  );

  // No misspelled Twilio status enums should appear in our responses.
  // Twilio canonical voice statuses: queued, ringing, in-progress, completed,
  // busy, failed, no-answer, canceled. Common typos: noanswer, cancelled, complete.
  //
  // Task #4648: the internal outbound-operation state union in
  // server/services/twilioService.ts also spells its in-progress member in
  // snake_case. The scanned routes file must consult the service-layer
  // predicate isInProgressOutboundOperationError() instead of spelling that
  // literal — resolve any future collision the same way; never exempt a
  // token from this scan.
  // Task #4651: scan all three quote styles — double, single, AND backtick.
  // Prettier keeps this codebase on double quotes, but template literals are
  // common in log/error strings and would otherwise evade the guard.
  const STATUS_TYPOS = ["cancelled", "noanswer", "answeredby", "in_progress"];
  const QUOTE_STYLES = ['"', "'", "`"];
  const findStatusTypos = (text: string): string[] =>
    STATUS_TYPOS.filter((typo) =>
      QUOTE_STYLES.some((q) => text.includes(`${q}${typo}${q}`)),
    );
  const foundTypos = findStatusTypos(file);
  for (const typo of STATUS_TYPOS) {
    check(`no '${typo}' typo in Twilio status handling`, !foundTypos.includes(typo), `found '${typo}'`);
  }

  // Guard self-test: the scan itself must keep biting on a genuine
  // snake_case status literal — a change that blanket-allows the token in
  // the scanned surface fails here.
  check(
    "guard self-test: scan flags a snake_case status literal",
    findStatusTypos('const s = "in_progress";').includes("in_progress"),
  );
  check(
    "guard self-test: canonical hyphenated status passes the scan",
    findStatusTypos('const s = "in-progress";').length === 0,
  );
  // Task #4651: the scan must bite regardless of quote style.
  check(
    "guard self-test: scan flags a single-quoted typo",
    findStatusTypos("const s = 'in_progress';").includes("in_progress"),
  );
  check(
    "guard self-test: scan flags a backtick-quoted typo",
    findStatusTypos("const s = `in_progress`;").includes("in_progress"),
  );
  check(
    "guard self-test: single-quoted canonical status passes the scan",
    findStatusTypos("const s = 'in-progress';").length === 0,
  );
  check(
    "guard self-test: backtick-quoted canonical status passes the scan",
    findStatusTypos("const s = `in-progress`;").length === 0,
  );

  // All dynamic interpolation that produces TwiML should pass through
  // escapeXml. Heuristic: every `${...}` inside a <Say> / <Number> tag
  // should be wrapped in escapeXml(...).
  const sayInterp = file.match(/<Say>[^<]*\$\{[^}]+\}[^<]*<\/Say>/g) || [];
  for (const m of sayInterp) {
    check(`<Say> interpolation uses escapeXml: ${m.slice(0, 60)}…`, m.includes("escapeXml("));
  }

  // Content-Type for every TwiML response: text/xml.
  const xmlSends = (file.match(/\.type\("text\/xml"\)/g) || []).length;
  check("at least one .type(\"text/xml\") on TwiML responses", xmlSends >= 5, `count=${xmlSends}`);
}

// ---------------------------------------------------------------------------
// (6) End-to-end persistence: handleInboundSms writes raw_communication_records
//     and twilio_messages, with idempotent retry dedupe via the unique index.
// ---------------------------------------------------------------------------
async function testInboundSmsPersistence(): Promise<void> {
  console.log("\n— 6. handleInboundSms — live persistence + retry dedupe —");

  await runInTxSandbox(async () => {
    const FROM = "+15551110000";
    const TO = "+15552220000";
    const SID = `SMtest${Date.now().toString(36)}`;
    const BODY = "Hello from compliance test";

    // First delivery — full insert path runs.
    await handleInboundSms({ from: FROM, to: TO, body: BODY, messageSid: SID });

    // Confirm twilio_messages row exists with the canonical "received" status.
    const msgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.twilioSid, SID));
    check("inbound SMS → exactly 1 twilio_messages row", msgs.length === 1, `got ${msgs.length}`);
    if (msgs[0]) {
      check("twilio_messages.direction === 'inbound'", msgs[0].direction === "inbound");
      check("twilio_messages.status === 'received'", msgs[0].status === "received", msgs[0].status);
      check("twilio_messages.body preserved", msgs[0].body === BODY);
      check("twilio_messages.fromNumber preserved", msgs[0].fromNumber === FROM);
      check("twilio_messages.toNumber preserved", msgs[0].toNumber === TO);
    }

    // Confirm raw_communication_records row was created keyed by MessageSid.
    const raws = await getDb()
      .select()
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, SID));
    check("inbound SMS → exactly 1 raw_communication_records row", raws.length === 1, `got ${raws.length}`);
    if (raws[0]) {
      check("raw_communication_records.sourceType === 'twilio_sms'", raws[0].sourceType === "twilio_sms");
      check("raw_communication_records.direction === 'inbound'", raws[0].direction === "inbound");
      check("raw_communication_records.contentText preserved", raws[0].contentText === BODY);
    }

    // Twilio retry: same MessageSid, same body. Must be a clean no-op.
    await handleInboundSms({ from: FROM, to: TO, body: BODY, messageSid: SID });
    const msgsAfterRetry = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.twilioSid, SID));
    check("retry with same MessageSid → still 1 twilio_messages row", msgsAfterRetry.length === 1);

    const rawsAfterRetry = await getDb()
      .select()
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, SID));
    check("retry with same MessageSid → still 1 raw_communication_records row", rawsAfterRetry.length === 1);
  });
}

// ---------------------------------------------------------------------------
// (7) End-to-end: handleCallStatus mutates twilio_calls.status with the
//     canonical Twilio enum, and the missed-call audit-trail rule holds.
// ---------------------------------------------------------------------------
async function testCallStatusPersistence(): Promise<void> {
  console.log("\n— 7. handleCallStatus — live persistence + status enum —");

  await runInTxSandbox(async () => {
    // Seed a fresh inbound call directly via the storage layer.
    const SID = `CAtest${Date.now().toString(36)}`;
    const FROM = "+15551112222";
    const TO = "+15553334444";
    const created = await twilioStorage.createTwilioCall({
      clientId: null,
      clientContactId: null,
      twilioSid: SID,
      direction: "inbound",
      fromNumber: FROM,
      toNumber: TO,
      status: "ringing",
      rawCommunicationRecordId: null,
    });
    check("seeded twilio_calls row with status='ringing'", created.status === "ringing");

    // Twilio fires status transitions: ringing → in-progress → completed.
    for (const status of ["in-progress", "completed"] as const) {
      await handleCallStatus({
        callSid: SID,
        callStatus: status,
        callDuration: status === "completed" ? 42 : undefined,
        from: FROM,
        to: TO,
        direction: "inbound",
      });
      const [row] = await getDb().select().from(twilioCalls).where(eq(twilioCalls.twilioSid, SID));
      check(`twilio_calls.status now === '${status}'`, row?.status === status, `got '${row?.status}'`);
      if (status === "completed") {
        check("twilio_calls.duration recorded as 42", row?.duration === 42, `got ${row?.duration}`);
      }
    }

    // Audit trail rule: an inbound call that already settled into a "missed"
    // status (no-answer / busy / failed / canceled) must NOT be silently
    // overwritten back to "completed" by a late status callback — duration
    // updates only.
    const SID2 = `CAtest2${Date.now().toString(36)}`;
    await twilioStorage.createTwilioCall({
      clientId: null,
      clientContactId: null,
      twilioSid: SID2,
      direction: "inbound",
      fromNumber: FROM,
      toNumber: TO,
      status: "no-answer",
      rawCommunicationRecordId: null,
    });
    await handleCallStatus({
      callSid: SID2,
      callStatus: "completed",
      callDuration: 7,
      from: FROM,
      to: TO,
      direction: "inbound",
    });
    const [row2] = await getDb().select().from(twilioCalls).where(eq(twilioCalls.twilioSid, SID2));
    check(
      "missed inbound call NOT overwritten by late 'completed' status",
      row2?.status === "no-answer",
      `got '${row2?.status}'`,
    );
    check("missed-call duration is still recorded for billing", row2?.duration === 7, `got ${row2?.duration}`);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio API compliance tests (Task #859)");

  testDescribeTwilioError();
  testE164PhoneValidation();
  await testWebhookSignatureMiddleware();
  await testNoTokenEnvGating();
  await testTwimlResponderShape();
  await testInboundSmsPersistence();
  await testCallStatusPersistence();

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
