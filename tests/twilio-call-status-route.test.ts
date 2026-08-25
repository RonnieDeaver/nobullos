/* test-registration
{
  "name": "Twilio call-status route (Task #1273)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 420000,
  "notes": "Task #3785: 40+ sequential DB-backed HTTP checks; under full-sweep ambient load individual steps can stall on 30s statement timeouts, overrunning the 180s default. Hermetic per-run test DBs (Task #3797) remove the contention; this override just keeps the sweep honest meanwhile.",
  "tier": "small"
}
test-registration */
// Task #1273 — integration tests for GET /api/twilio/calls/:id/status,
// the live call-status endpoint introduced by Task #851 to drive the
// in-page Active Call Bar for forward-mode calls.
//
// Coverage:
//   1. 404 not_found when the callId doesn't exist
//   2. 400 when the row has no twilioSid yet
//   3. 400 when Twilio account credentials aren't configured
//   4. 200 happy path — the response shape mirrors the Twilio Call
//      resource (status / duration / startTime / endTime) using a
//      mocked REST client injected via the __test_setTwilioCallStatusClientFactory
//      seam, exercised for ringing, in-progress, and completed states
//   5. 502 when the underlying twilio.calls(sid).fetch() throws —
//      describeTwilioError is consulted for the error message
//   6. 500 fallthrough on an unexpected internal failure
//
// All scenarios run inside runInTxSandbox so seeded users, system_settings,
// and twilio_calls rows are rolled back at the end.

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import {
  registerTwilioRoutes,
  __test_setTwilioCallStatusClientFactory,
} from "../server/routes/twilio";
import { __test_markUserReconciled } from "../server/middlewares/requireAuth";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { systemSettings, users, twilioCalls } from "@shared/schema";

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

let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
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

async function seedUser(): Promise<string> {
  const id = `u_t1273_${Math.random().toString(36).slice(2, 10)}`;
  await getDb()
    .insert(users)
    .values({
      id,
      email: `${id}@test.local`,
      firstName: "Task1273",
      lastName: "User",
      role: "team_lead",
      callMode: "forward",
      callRoutingPhone: "+15551112222",
    });
  // Sandbox-seeded row is invisible to the live-pool; pre-provision so
  // requireAuth uses this profile directly instead of SELECT/INSERT-waiting.
  __test_markUserReconciled(id, {
    id,
    email: `${id}@test.local`,
    firstName: "Task1273",
    lastName: "User",
    role: "team_lead",
    callMode: "forward",
    callRoutingPhone: "+15551112222",
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
  await seedSetting("twilio_auth_token", "test_auth_token_for_status_route");
  await seedSetting("twilio_phone_numbers", JSON.stringify(["+15551110000"]));
}

async function seedCall(opts: {
  twilioSid: string | null;
  status?: string;
}): Promise<string> {
  const [row] = await getDb()
    .insert(twilioCalls)
    .values({
      twilioSid: opts.twilioSid,
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15551112222",
      status: opts.status ?? "initiated",
    })
    .returning();
  return row.id;
}

// --------------------------------------------------------------------------
// (1) 404 — call not found
// --------------------------------------------------------------------------
async function test404NotFound(): Promise<void> {
  console.log("\n— 1. 404 when callId doesn't exist —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/calls/does-not-exist/status`);
      check("status === 404", r.status === 404, `got ${r.status}`);
      const body = (await r.json()) as { error?: string };
      check(
        "error message indicates not found",
        typeof body.error === "string" && /not found/i.test(body.error),
        body.error,
      );
    });
    currentUserId = null;
  });
}

// --------------------------------------------------------------------------
// (2) 400 — call row exists but has no Twilio SID yet
// --------------------------------------------------------------------------
async function test400MissingSid(): Promise<void> {
  console.log("\n— 2. 400 when the row has no twilioSid —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    await seedAccountConfig();
    const callId = await seedCall({ twilioSid: null });
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/calls/${callId}/status`);
      check("status === 400", r.status === 400, `got ${r.status}`);
      const body = (await r.json()) as { error?: string };
      check(
        "error mentions Twilio SID",
        typeof body.error === "string" && /SID/i.test(body.error),
        body.error,
      );
    });
    currentUserId = null;
  });
}

// --------------------------------------------------------------------------
// (3) 400 — Twilio not configured
// --------------------------------------------------------------------------
async function test400NotConfigured(): Promise<void> {
  console.log("\n— 3. 400 when twilio_account_sid / auth_token aren't configured —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    // Intentionally skip seedAccountConfig().
    const callId = await seedCall({ twilioSid: "CAtestsid0000000000000000000000000" });
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/twilio/calls/${callId}/status`);
      check("status === 400", r.status === 400, `got ${r.status}`);
      const body = (await r.json()) as { error?: string };
      check(
        "error mentions Twilio not configured",
        typeof body.error === "string" && /not configured/i.test(body.error),
        body.error,
      );
    });
    currentUserId = null;
  });
}

// --------------------------------------------------------------------------
// (4) 200 happy path — mocked REST client returns the three lifecycle
//     states the Active Call Bar cares about: ringing → in-progress → completed
// --------------------------------------------------------------------------
async function test200HappyPath(): Promise<void> {
  console.log("\n— 4. 200 happy path: response shape mirrors the Twilio Call resource —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    await seedAccountConfig();
    const twilioSid = "CAtestsidhappy00000000000000000000";
    const callId = await seedCall({ twilioSid });

    const cases: Array<{
      label: string;
      remote: {
        status: string;
        duration: string | number | null;
        startTime: Date | null;
        endTime: Date | null;
      };
      expected: {
        status: string;
        duration: number | null;
        startTime: string | null;
        endTime: string | null;
      };
    }> = [
      {
        label: "ringing",
        remote: { status: "ringing", duration: null, startTime: null, endTime: null },
        expected: { status: "ringing", duration: null, startTime: null, endTime: null },
      },
      {
        label: "in-progress",
        remote: {
          status: "in-progress",
          duration: null,
          startTime: new Date("2026-05-16T12:00:00.000Z"),
          endTime: null,
        },
        expected: {
          status: "in-progress",
          duration: null,
          startTime: "2026-05-16T12:00:00.000Z",
          endTime: null,
        },
      },
      {
        label: "completed",
        remote: {
          status: "completed",
          duration: "42",
          startTime: new Date("2026-05-16T12:00:00.000Z"),
          endTime: new Date("2026-05-16T12:00:42.000Z"),
        },
        expected: {
          status: "completed",
          duration: 42,
          startTime: "2026-05-16T12:00:00.000Z",
          endTime: "2026-05-16T12:00:42.000Z",
        },
      },
    ];

    try {
      for (const c of cases) {
        let observedSid: string | null = null;
        let observedAccountSid: string | null = null;
        let observedAuthToken: string | null = null;
        __test_setTwilioCallStatusClientFactory((accountSid, authToken) => {
          observedAccountSid = accountSid;
          observedAuthToken = authToken;
          return {
            calls(sid: string) {
              observedSid = sid;
              return { fetch: async () => c.remote };
            },
          };
        });

        await withApp(async (baseUrl) => {
          const r = await fetch(`${baseUrl}/api/twilio/calls/${callId}/status`);
          check(`[${c.label}] status === 200`, r.status === 200, `got ${r.status}`);
          const body = (await r.json()) as {
            callId?: string;
            twilioSid?: string;
            status?: string;
            duration?: number | null;
            startTime?: string | null;
            endTime?: string | null;
          };
          check(`[${c.label}] callId echoed`, body.callId === callId, body.callId);
          check(
            `[${c.label}] twilioSid echoed`,
            body.twilioSid === twilioSid,
            body.twilioSid,
          );
          check(`[${c.label}] status === "${c.expected.status}"`, body.status === c.expected.status, body.status);
          check(
            `[${c.label}] duration mapped`,
            body.duration === c.expected.duration,
            String(body.duration),
          );
          check(
            `[${c.label}] startTime mapped to ISO`,
            (body.startTime ?? null) === c.expected.startTime,
            String(body.startTime),
          );
          check(
            `[${c.label}] endTime mapped to ISO`,
            (body.endTime ?? null) === c.expected.endTime,
            String(body.endTime),
          );
        });

        check(
          `[${c.label}] factory received seeded accountSid`,
          observedAccountSid === "ACtestaccountsid000000000000000000",
          String(observedAccountSid),
        );
        check(
          `[${c.label}] factory received seeded authToken`,
          observedAuthToken === "test_auth_token_for_status_route",
          String(observedAuthToken),
        );
        check(
          `[${c.label}] twilio.calls() queried the seeded SID`,
          observedSid === twilioSid,
          String(observedSid),
        );
      }
    } finally {
      __test_setTwilioCallStatusClientFactory(null);
    }
    currentUserId = null;
  });
}

// --------------------------------------------------------------------------
// (5) 502 — Twilio REST call throws
// --------------------------------------------------------------------------
async function test502TwilioFailure(): Promise<void> {
  console.log("\n— 5. 502 when twilio.calls(sid).fetch() throws —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    await seedAccountConfig();
    const callId = await seedCall({ twilioSid: "CAtestsiderr00000000000000000000000" });

    try {
      __test_setTwilioCallStatusClientFactory(() => ({
        calls: (_sid: string) => ({
          fetch: async () => {
            // Mirror a real Twilio REST error shape so describeTwilioError
            // pulls the code / status / moreInfo into the response.
            const err = new Error("The requested resource was not found") as any;
            err.code = 20404;
            err.status = 404;
            err.moreInfo = "https://www.twilio.com/docs/errors/20404";
            throw err;
          },
        }),
      }));
      await withApp(async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/twilio/calls/${callId}/status`);
        check("status === 502", r.status === 502, `got ${r.status}`);
        const body = (await r.json()) as { error?: string };
        check(
          "error string is non-empty",
          typeof body.error === "string" && body.error.length > 0,
          body.error,
        );
        check(
          "describeTwilioError surfaced the underlying message",
          typeof body.error === "string" && /not found|20404/i.test(body.error),
          body.error,
        );
      });
    } finally {
      __test_setTwilioCallStatusClientFactory(null);
    }
    currentUserId = null;
  });
}

// --------------------------------------------------------------------------
// (6) 500 fallthrough — unexpected error before the try/catch
// --------------------------------------------------------------------------
async function test500Internal(): Promise<void> {
  console.log("\n— 6. 500 when the handler hits an unexpected internal error —");
  await runInTxSandbox(async () => {
    const userId = await seedUser();
    currentUserId = userId;
    await seedAccountConfig();
    const callId = await seedCall({ twilioSid: "CAtestsidinternal00000000000000000" });

    try {
      // Factory itself throws synchronously: this happens *before* the
      // inner try/catch that produces 502 responses, so the outer catch
      // — which is the 500 path — fires.
      __test_setTwilioCallStatusClientFactory(() => {
        throw new Error("synthetic factory failure");
      });
      await withApp(async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/twilio/calls/${callId}/status`);
        check("status === 500", r.status === 500, `got ${r.status}`);
        const body = (await r.json()) as { error?: string };
        check(
          "error mentions the synthetic failure",
          typeof body.error === "string" && /synthetic factory failure/i.test(body.error),
          body.error,
        );
      });
    } finally {
      __test_setTwilioCallStatusClientFactory(null);
    }
    currentUserId = null;
  });
}

async function main(): Promise<void> {
  await test404NotFound();
  await test400MissingSid();
  await test400NotConfigured();
  await test200HappyPath();
  await test502TwilioFailure();
  await test500Internal();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
