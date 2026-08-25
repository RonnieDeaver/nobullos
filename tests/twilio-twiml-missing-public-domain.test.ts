/* test-registration
{
  "name": "Twilio TwiML missing-public-domain (Task #1292)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1292: integration test for the strict-public-domain behavior on
// the five Twilio TwiML route handlers. Before this task, those routes
// called `getPublicBaseUrl({ allowLocalhostFallback: true })` and would
// happily emit TwiML pointing Twilio at `https://localhost:5000` when
// neither REPLIT_DOMAINS nor REPLIT_DEV_DOMAIN was set — Twilio cannot
// reach localhost, so the called party would hear the generic
// "an application error has occurred" prompt.
//
// Now they call the strict resolver via `resolvePublicBaseUrlOrFallback`,
// which on failure emits the FALLBACK_TWIML_BODY ("The call could not be
// connected. Please try again.") via `sendFallbackTwiml` and never
// references localhost in the response.

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import { registerTwilioRoutes } from "../server/routes/twilio";

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

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
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

interface SavedEnv {
  NODE_ENV: string | undefined;
  REPLIT_DOMAINS: string | undefined;
  REPLIT_DEV_DOMAIN: string | undefined;
  REPL_SLUG: string | undefined;
  REPL_OWNER: string | undefined;
}

function snapshotEnv(): SavedEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
    REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
    REPL_SLUG: process.env.REPL_SLUG,
    REPL_OWNER: process.env.REPL_OWNER,
  };
}

function restoreEnv(saved: SavedEnv): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearPublicHostnameEnv(): void {
  // NODE_ENV must be non-"test" so the helper actually throws instead of
  // returning the test-only localhost fallback.
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DOMAINS;
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.REPL_SLUG;
  delete process.env.REPL_OWNER;
}

async function postForm(url: string, params: Record<string, string>): Promise<{ status: number; body: string }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, body: await r.text() };
}

function assertFallback(label: string, body: string): void {
  check(
    `${label}: response is the friendly fallback TwiML`,
    /The call could not be connected/.test(body),
    body.slice(0, 200),
  );
  check(
    `${label}: response never references localhost`,
    !/localhost/i.test(body),
    body.slice(0, 200),
  );
}

// (1) voice-twiml-outbound — handler-style route (no own try/catch around
// the resolver), uses the helper directly.
async function testVoiceTwimlOutboundNoPublicDomain(): Promise<void> {
  console.log("\n— voice-twiml-outbound returns fallback TwiML when no public domain is set —");
  const saved = snapshotEnv();
  clearPublicHostnameEnv();
  try {
    await withApp(async (baseUrl) => {
      const { status, body } = await postForm(
        `${baseUrl}/api/twilio/webhooks/voice-twiml-outbound?to=%2B15552223333&callerId=%2B15551110000`,
        { CallSid: "CAtest_outbound" },
      );
      check("status === 200 (Twilio requires 2xx)", status === 200, `got ${status}`);
      assertFallback("voice-twiml-outbound", body);
    });
  } finally {
    restoreEnv(saved);
  }
}

// (2) voice-twiml-forward-bridge — same handler shape as outbound.
async function testVoiceTwimlForwardBridgeNoPublicDomain(): Promise<void> {
  console.log("\n— voice-twiml-forward-bridge returns fallback TwiML when no public domain is set —");
  const saved = snapshotEnv();
  clearPublicHostnameEnv();
  try {
    await withApp(async (baseUrl) => {
      const { status, body } = await postForm(
        `${baseUrl}/api/twilio/webhooks/voice-twiml-forward-bridge?to=%2B15552223333&callerId=%2B15551110000`,
        { CallSid: "CAtest_forward" },
      );
      check("status === 200 (Twilio requires 2xx)", status === 200, `got ${status}`);
      assertFallback("voice-twiml-forward-bridge", body);
    });
  } finally {
    restoreEnv(saved);
  }
}

// (3) Sanity check: when REPLIT_DOMAINS is set, the routes still emit
// the normal Dial TwiML pointing at the configured public hostname (not
// localhost). Guards against accidentally regressing the happy path.
async function testVoiceTwimlOutboundHappyPath(): Promise<void> {
  console.log("\n— voice-twiml-outbound emits Dial TwiML pointing at REPLIT_DOMAINS hostname —");
  const saved = snapshotEnv();
  process.env.NODE_ENV = "development";
  process.env.REPLIT_DOMAINS = "example.replit.app";
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.REPL_SLUG;
  delete process.env.REPL_OWNER;
  try {
    await withApp(async (baseUrl) => {
      const { status, body } = await postForm(
        `${baseUrl}/api/twilio/webhooks/voice-twiml-outbound?to=%2B15552223333&callerId=%2B15551110000`,
        { CallSid: "CAtest_outbound_ok" },
      );
      check("status === 200", status === 200, `got ${status}`);
      check(
        "response contains a <Dial>",
        /<Dial[\s>]/.test(body),
        body.slice(0, 200),
      );
      check(
        "response references the configured public hostname",
        /https:\/\/example\.replit\.app\//.test(body),
        body.slice(0, 200),
      );
      check(
        "response never references localhost",
        !/localhost/i.test(body),
        body.slice(0, 200),
      );
    });
  } finally {
    restoreEnv(saved);
  }
}

async function main(): Promise<void> {
  console.log("Twilio TwiML missing-public-domain regression tests (Task #1292)");

  await testVoiceTwimlOutboundNoPublicDomain();
  await testVoiceTwimlForwardBridgeNoPublicDomain();
  await testVoiceTwimlOutboundHappyPath();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
