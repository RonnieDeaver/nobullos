/* test-registration
{
  "name": "Twilio browser-calling endpoints (Task #879)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 420000,
  "notes": "Task #3785: 40+ sequential DB-backed HTTP checks; under full-sweep ambient load individual steps can stall on 30s statement timeouts, overrunning the 180s default. Hermetic per-run test DBs (Task #3797) remove the contention; this override just keeps the sweep honest meanwhile.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #879: focused tests for the Twilio browser-calling endpoints.
//
// Coverage:
//   1. POST /api/twilio/voice-token mints a token when fully configured.
//   2. POST /api/twilio/voice-token returns 503 when account credentials
//      are missing (twilio_account_sid / twilio_auth_token).
//   3. POST /api/twilio/voice-token returns 503 when any of the three
//      browser-calling credentials are missing (api key SID, secret,
//      TwiML App SID).
//   4. POST /api/twilio/initiate-call returns 400 when the user's
//      callMode is "browser" — those calls must originate from the
//      Voice JS SDK in the browser, not this REST endpoint.
//   5. POST /api/twilio/initiate-call returns 400 when callMode is
//      "forward" but the user has no callRoutingPhone configured.
//   6. POST /api/twilio/webhooks/voice-twiml-browser returns valid
//      <Dial> TwiML and persists a twilio_calls row attributed to the
//      authenticated user encoded in the `From=client:<userId>` param.
//
// Each scenario runs inside `runInTxSandbox` so all seeded users /
// system_settings / twilio_calls rows are rolled back at the end.

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";
import twilio from "twilio";

import { registerTwilioRoutes } from "../server/routes/twilio";
import { __test_markUserReconciled } from "../server/middlewares/requireAuth";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { systemSettings, users, twilioCalls } from "@shared/schema";
import { eq } from "drizzle-orm";

const { getExpectedTwilioSignature } = twilio as unknown as {
  getExpectedTwilioSignature: (token: string, url: string, params: Record<string, string>) => string;
};
if (typeof getExpectedTwilioSignature !== "function") {
  throw new Error("twilio.getExpectedTwilioSignature not exported by SDK — cannot sign webhook fixtures");
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
// Test app setup: a fresh Express instance per test that mounts the real
// Twilio routes with a tiny shim that satisfies passport's
// `req.isAuthenticated()` + `req.user` contract so we can exercise the
// authenticated endpoints without bootstrapping OIDC. The shim only fires
// when a fixture sets `currentUserId`; webhook routes don't use it.
let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  // Inject Clerk test seam before registerTwilioRoutes.
  app.use((req: any, _res, next) => {
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

async function seedUser(opts: {
  id?: string;
  role?: string;
  callMode?: "browser" | "forward";
  callRoutingPhone?: string | null;
  callerIdName?: string | null;
}): Promise<string> {
  const id = opts.id || `u_test_${Math.random().toString(36).slice(2, 10)}`;
  await getDb()
    .insert(users)
    .values({
      id,
      email: `${id}@test.local`,
      firstName: "Test",
      lastName: "User",
      role: opts.role || "team_lead",
      callMode: opts.callMode || "browser",
      callRoutingPhone: opts.callRoutingPhone ?? null,
      callerIdName: opts.callerIdName ?? null,
    });
  // Sandbox-seeded row is invisible to the live-pool; pre-provision so
  // requireAuth uses this profile directly instead of SELECT/INSERT-waiting.
  __test_markUserReconciled(id, {
    id,
    email: `${id}@test.local`,
    firstName: "Test",
    lastName: "User",
    role: opts.role || "team_lead",
    callMode: opts.callMode || "browser",
    callRoutingPhone: opts.callRoutingPhone ?? null,
    callerIdName: opts.callerIdName ?? null,
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
  await seedSetting("twilio_auth_token", "test_auth_token_for_browser_calling");
  await seedSetting("twilio_phone_numbers", JSON.stringify(["+15551110000"]));
}

async function seedBrowserConfig(): Promise<void> {
  await seedSetting("twilio_api_key_sid", "SKtestapikeysid00000000000000000000");
  await seedSetting("twilio_api_key_secret", "test_api_key_secret_value");
  await seedSetting("twilio_twiml_app_sid", "APtesttwimlappsid0000000000000000");
}

// ---------------------------------------------------------------------------
// (1) voice-token happy path
// ---------------------------------------------------------------------------
async function testVoiceTokenSuccess(): Promise<void> {
  console.log("\n— 1. POST /api/twilio/voice-token mints a token when configured —");
  await runInTxSandbox(async () => {
    const userId = await seedUser({ role: "team_lead" });
    currentUserId = userId;
    await seedAccountConfig();
    await seedBrowserConfig();

    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/voice-token`, { method: "POST" });
      check("status === 200", r.status === 200, `got ${r.status}`);
      const body = (await r.json()) as { token?: string; identity?: string; ttl?: number };
      check("response has a JWT token", typeof body.token === "string" && body.token.split(".").length === 3, body.token?.slice(0, 20));
      check("identity matches authenticated user", body.identity === userId, body.identity);
      check("ttl is 3600 seconds", body.ttl === 3600, String(body.ttl));
    });
    currentUserId = null;
  });
}

// ---------------------------------------------------------------------------
// (2) voice-token 503 — account credentials missing
// ---------------------------------------------------------------------------
async function testVoiceTokenMissingAccount(): Promise<void> {
  console.log("\n— 2. voice-token returns 503 when twilio_account_sid / auth_token missing —");
  await runInTxSandbox(async () => {
    const userId = await seedUser({});
    currentUserId = userId;
    // Browser config seeded but account credentials are not.
    await seedBrowserConfig();

    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/voice-token`, { method: "POST" });
      check("status === 503", r.status === 503, `got ${r.status}`);
      const body = (await r.json()) as { error?: string; missing?: string[] };
      check(
        "missing array names accountSid + authToken",
        Array.isArray(body.missing) &&
          body.missing.includes("accountSid") &&
          body.missing.includes("authToken"),
        JSON.stringify(body.missing),
      );
      check(
        "error message mentions admin must set credentials",
        typeof body.error === "string" && /Account SID/i.test(body.error),
        body.error,
      );
    });
    currentUserId = null;
  });
}

// ---------------------------------------------------------------------------
// (3) voice-token 503 — each missing browser-calling field
// ---------------------------------------------------------------------------
async function testVoiceTokenMissingBrowserField(): Promise<void> {
  console.log("\n— 3. voice-token returns 503 when any browser-calling field is missing —");
  const fields: Array<{ key: string; label: string }> = [
    { key: "twilio_api_key_sid", label: "apiKeySid" },
    { key: "twilio_api_key_secret", label: "apiKeySecret" },
    { key: "twilio_twiml_app_sid", label: "twimlAppSid" },
  ];

  for (const omitted of fields) {
    await runInTxSandbox(async () => {
      const userId = await seedUser({});
      currentUserId = userId;
      await seedAccountConfig();
      // Seed all browser fields *except* the one under test.
      for (const f of fields) {
        if (f.key === omitted.key) continue;
        if (f.key === "twilio_api_key_sid") await seedSetting(f.key, "SKtest00000000000000000000000000");
        if (f.key === "twilio_api_key_secret") await seedSetting(f.key, "secretvalue");
        if (f.key === "twilio_twiml_app_sid") await seedSetting(f.key, "APtest0000000000000000000000000000");
      }

      await withApp(async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/twilio/voice-token`, { method: "POST" });
        check(
          `status === 503 when ${omitted.label} is missing`,
          r.status === 503,
          `got ${r.status}`,
        );
        const body = (await r.json()) as { missing?: string[] };
        check(
          `error payload lists the three browser-calling fields when ${omitted.label} is missing`,
          Array.isArray(body.missing) &&
            body.missing.includes("apiKeySid") &&
            body.missing.includes("apiKeySecret") &&
            body.missing.includes("twimlAppSid"),
          JSON.stringify(body.missing),
        );
      });
      currentUserId = null;
    });
  }
}

// ---------------------------------------------------------------------------
// (4) initiate-call rejects browser-mode users
// ---------------------------------------------------------------------------
async function testInitiateCallRejectsBrowserMode(): Promise<void> {
  console.log("\n— 4. /initiate-call returns 400 when callMode === 'browser' —");
  await runInTxSandbox(async () => {
    const userId = await seedUser({ callMode: "browser", callRoutingPhone: "+15559998888" });
    currentUserId = userId;
    await seedAccountConfig();

    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/initiate-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "+15552223333" }),
      });
      check("status === 400", r.status === 400, `got ${r.status}`);
      const body = (await r.json()) as { error?: string };
      check(
        "error explains browser mode must use the in-browser dialer",
        typeof body.error === "string" && /Browser audio/i.test(body.error),
        body.error,
      );

      // No twilio_calls row should have been written for this rejection.
      const rows = await getDb()
        .select()
        .from(twilioCalls)
        .where(eq(twilioCalls.initiatedByUserId, userId));
      check("no twilio_calls row was created on rejection", rows.length === 0, `rows=${rows.length}`);
    });
    currentUserId = null;
  });
}

// ---------------------------------------------------------------------------
// (5) initiate-call rejects forward mode without a routing phone
// ---------------------------------------------------------------------------
async function testInitiateCallRejectsForwardWithoutRoutingPhone(): Promise<void> {
  console.log("\n— 5. /initiate-call returns 400 when callMode === 'forward' + no callRoutingPhone —");
  await runInTxSandbox(async () => {
    const userId = await seedUser({ callMode: "forward", callRoutingPhone: null });
    currentUserId = userId;
    await seedAccountConfig();

    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/initiate-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "+15552223333" }),
      });
      check("status === 400", r.status === 400, `got ${r.status}`);
      const body = (await r.json()) as { error?: string };
      check(
        "error tells user to add a Call Routing Phone or switch modes",
        typeof body.error === "string" && /Call Routing Phone/i.test(body.error),
        body.error,
      );
    });
    currentUserId = null;
  });
}

// ---------------------------------------------------------------------------
// (6) voice-twiml-browser webhook end-to-end
// ---------------------------------------------------------------------------
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
      req.setHeader("host", extraHeaders.host);
    }
    req.on("error", reject);
    req.end(body);
  });
}

async function testVoiceTwimlBrowserWebhook(): Promise<void> {
  console.log("\n— 6. voice-twiml-browser returns Dial TwiML + writes user-attributed call row —");
  await runInTxSandbox(async () => {
    const userId = await seedUser({ callMode: "browser" });
    await seedAccountConfig();

    await withApp(async (baseUrl) => {
      const url = `${baseUrl}/api/twilio/webhooks/voice-twiml-browser`;
      const publicUrl = `https://127.0.0.1/api/twilio/webhooks/voice-twiml-browser`;
      const callSid = `CAtest${Date.now().toString(36)}`;
      const params: Record<string, string> = {
        To: "+15552223333",
        From: `client:${userId}`,
        CallSid: callSid,
      };
      const sig = getExpectedTwilioSignature(
        "test_auth_token_for_browser_calling",
        publicUrl,
        params,
      );
      const body = new URLSearchParams(params).toString();

      const r = await rawHttpPost(url, body, {
        "x-twilio-signature": sig,
        "x-forwarded-proto": "https",
        host: "127.0.0.1",
      });
      check("status === 200", r.status === 200, `got ${r.status}`);
      check("response is XML", r.body.trim().startsWith("<?xml"), r.body.slice(0, 60));
      check("response contains <Dial>", /<Dial[\s>]/.test(r.body), r.body.slice(0, 200));
      check(
        "Dial caller-id matches configured Twilio number",
        /callerId="\+15551110000"/.test(r.body),
        r.body.slice(0, 200),
      );
      check(
        "<Number> body is the normalized destination",
        />\+15552223333</.test(r.body),
        r.body.slice(0, 200),
      );

      // The handler best-effort persists a twilio_calls row keyed by the
      // CallSid, attributed to the user id encoded in `From=client:<id>`.
      const [row] = await getDb()
        .select()
        .from(twilioCalls)
        .where(eq(twilioCalls.twilioSid, callSid));
      check("twilio_calls row was created", !!row, row ? "ok" : "missing");
      check("row direction === 'outbound'", row?.direction === "outbound", String(row?.direction));
      check(
        "row initiatedByUserId === authenticated user",
        row?.initiatedByUserId === userId,
        String(row?.initiatedByUserId),
      );
      check("row toNumber matches normalized To", row?.toNumber === "+15552223333", String(row?.toNumber));
      check("row fromNumber matches configured Twilio phone", row?.fromNumber === "+15551110000", String(row?.fromNumber));
    });
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Twilio browser-calling endpoint tests (Task #879)");

  await testVoiceTokenSuccess();
  await testVoiceTokenMissingAccount();
  await testVoiceTokenMissingBrowserField();
  await testInitiateCallRejectsBrowserMode();
  await testInitiateCallRejectsForwardWithoutRoutingPhone();
  await testVoiceTwimlBrowserWebhook();

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
