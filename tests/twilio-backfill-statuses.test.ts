/* test-registration
{
  "name": "Twilio delivery-status backfill (Task #881)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4110: the old ~90s runtime was three 30s statement_timeout stalls (reconcileUserRow's ambient upsert blocking on a sandbox-uncommitted users row), fixed by committed user seeding; now ~2s, cheap enough to guard the CEO-gated bulk status-backfill contract on every merge.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #881: backfill twilio_messages.status / errorCode / errorMessage
// for rows sent before Task #875's status-callback webhook shipped.
//
// We assert the helper + endpoint contract end-to-end:
//   - fetchMessageStatus() round-trips through Twilio's REST API and
//     translates 404 / code 20404 into a soft-miss `null`.
//   - POST /api/twilio/admin/backfill-statuses (CEO-gated):
//       - canonical path matches the Task #881 spec
//       - happy path updates rows whose status drifted
//       - unchanged rows are not written
//       - missing remote rows are counted, loop continues
//       - dryRun=true performs no writes
//       - rows without a twilio_sid (or `direction='inbound'`) are skipped
//       - non-CEO users get 403
//
// Usage: tsx tests/twilio-backfill-statuses.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import {
  fetchMessageStatus,
  __setTwilioClientFactoryForTests,
} from "../server/services/twilioService";
import * as twilioStorage from "../server/storage/twilioStorage";
import { registerTwilioRoutes } from "../server/routes/twilio";
import { systemSettings, twilioConversations, twilioMessages, users } from "@shared/schema";
import { runInTxSandbox } from "./db-sandbox";
import { db, getDb } from "../server/db";
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

async function seedOutboundMessage(twilioSid: string | null, conversationId: string, status = "sent") {
  return twilioStorage.createTwilioMessage({
    conversationId,
    twilioSid,
    direction: "outbound",
    fromNumber: "+15551110000",
    toNumber: "+15552220000",
    body: "Test backfill fixture",
    status,
  });
}

async function seedInboundMessage(twilioSid: string, conversationId: string) {
  return twilioStorage.createTwilioMessage({
    conversationId,
    twilioSid,
    direction: "inbound",
    fromNumber: "+15552220000",
    toNumber: "+15551110000",
    body: "Inbound fixture — must NOT be touched by backfill",
    status: "received",
  });
}

async function getRow(twilioSid: string) {
  const [row] = await getDb()
    .select()
    .from(twilioMessages)
    .where(eq(twilioMessages.twilioSid, twilioSid));
  return row;
}

async function seedTwilioCredentials(): Promise<void> {
  const dbi = getDb();
  const rows = [
    { key: "twilio_account_sid", value: "ACtest_881_account_sid" },
    { key: "twilio_auth_token", value: "test_881_auth_token" },
    { key: "twilio_phone_numbers", value: JSON.stringify(["+15551110000"]) },
  ];
  for (const row of rows) {
    await dbi
      .insert(systemSettings)
      .values(row)
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: row.value } });
  }
}

interface RemoteFixture {
  status: string;
  errorCode?: string | number | null;
  errorMessage?: string | null;
}

interface FetchError extends Error {
  status?: number;
  code?: number;
}

function withStubbedTwilioMessages(
  remoteBySid: Record<string, RemoteFixture | "throw_404" | "throw_500">,
): () => void {
  __setTwilioClientFactoryForTests(() => ({
    messages: (sid: string) => ({
      fetch: async () => {
        const remote = remoteBySid[sid];
        if (!remote) {
          const err = new Error(`Test stub: no remote fixture for ${sid}`) as FetchError;
          err.status = 404;
          err.code = 20404;
          throw err;
        }
        if (remote === "throw_404") {
          const err = new Error("Twilio: not found") as FetchError;
          err.status = 404;
          err.code = 20404;
          throw err;
        }
        if (remote === "throw_500") {
          const err = new Error("Twilio: server error") as FetchError;
          err.status = 500;
          err.code = 20500;
          throw err;
        }
        return remote;
      },
    }),
  }));
  return () => __setTwilioClientFactoryForTests(undefined);
}

// ---------------------------------------------------------------------------
// (1) fetchMessageStatus — happy path + 404 soft miss + other error rethrows
// ---------------------------------------------------------------------------
async function testFetchMessageStatus(): Promise<void> {
  console.log("\n— 1. fetchMessageStatus translates Twilio responses —");

  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const restore = withStubbedTwilioMessages({
      SMok: { status: "delivered", errorCode: null, errorMessage: null },
      SMfail: { status: "failed", errorCode: 30003, errorMessage: "Unreachable destination handset" },
      SMmissing: "throw_404",
      SMboom: "throw_500",
    });
    try {
      const ok = await fetchMessageStatus("SMok");
      check("happy path returns status='delivered'", ok?.status === "delivered", String(ok?.status));
      check("happy path leaves errorCode null", ok?.errorCode === null, String(ok?.errorCode));

      const fail = await fetchMessageStatus("SMfail");
      check("failure path returns status='failed'", fail?.status === "failed", String(fail?.status));
      check("numeric errorCode coerced to string", fail?.errorCode === "30003", String(fail?.errorCode));
      check(
        "errorMessage preserved verbatim",
        fail?.errorMessage === "Unreachable destination handset",
        String(fail?.errorMessage),
      );

      const missing = await fetchMessageStatus("SMmissing");
      check("404 / 20404 → null soft miss", missing === null, String(missing));

      let threw = false;
      try {
        await fetchMessageStatus("SMboom");
      } catch (e) {
        threw = true;
        check(
          "non-404 errors re-throw with describeTwilioError",
          e instanceof Error && /Twilio/i.test(e.message),
          e instanceof Error ? e.message : String(e),
        );
      }
      check("non-404 path actually threw", threw, threw ? "ok" : "did not throw");
    } finally {
      restore();
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP harness for the route-level tests.
// ---------------------------------------------------------------------------
async function withHarness(
  isCeo: boolean,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  // Seed a real user row so the `requireCeo` middleware (which loads the
  // user from storage and checks `user.role`) returns the right answer.
  //
  // Task #4110: seed COMMITTED via the bare `db` import (which sidesteps the
  // tx-sandbox override) instead of inside the sandbox. isAuthenticated's
  // reconcileUserRow (Task #2129) reads the users row through the AMBIENT
  // pool; a sandbox-only (uncommitted) row is invisible there, so it tried to
  // re-upsert the same id and blocked on the sandbox's row lock until the 30s
  // statement_timeout — one 30s stall per harness, ~90s of pure wait. The
  // committed row is deleted in the finally below.
  const [u] = await db
    .insert(users)
    .values({
      email: `task881-${isCeo ? "ceo" : "am"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      role: isCeo ? "ceo" : "account_manager",
    })
    .returning();

  const app = express();
  app.use(express.json());
  // Clerk test seam (server/middlewares/requireAuth.ts): setting
  // req.__test_clerkUserId to a string authenticates as that user id.
  // requireAuth then loads the committed DB row we just seeded, so the
  // downstream requireCeo role-gate reads the real role.
  app.use((req, _res, next) => {
    (req as unknown as { __test_clerkUserId: string }).__test_clerkUserId = u.id;
    next();
  });
  await registerTwilioRoutes(app);

  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    // Remove the committed seed row (see the seeding comment above).
    await db.delete(users).where(eq(users.id, u.id));
  }
}

// ---------------------------------------------------------------------------
// (2) POST /api/twilio/admin/backfill-statuses — happy path:
//     - candidates pulled, drift updated, unchanged not written, missing
//       counted, dryRun=false
// ---------------------------------------------------------------------------
async function testEndpointHappyPath(): Promise<void> {
  console.log("\n— 2. POST /api/twilio/admin/backfill-statuses applies drift —");

  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const conv = await seedConversation();

    const SID_DRIFT = `SMdrift${Date.now().toString(36)}`;
    const SID_SAME = `SMsame${Date.now().toString(36)}`;
    const SID_GONE = `SMgone${Date.now().toString(36)}`;
    const SID_INBOUND = `SMin${Date.now().toString(36)}`;

    await seedOutboundMessage(SID_DRIFT, conv.id, "sent");
    await seedOutboundMessage(SID_SAME, conv.id, "delivered");
    await seedOutboundMessage(SID_GONE, conv.id, "sent");
    await seedInboundMessage(SID_INBOUND, conv.id);
    // Outbound row that never got a SID — must be skipped silently.
    await seedOutboundMessage(null, conv.id, "failed");

    const restore = withStubbedTwilioMessages({
      [SID_DRIFT]: { status: "delivered", errorCode: null, errorMessage: null },
      [SID_SAME]: { status: "delivered", errorCode: null, errorMessage: null },
      [SID_GONE]: "throw_404",
      // SID_INBOUND intentionally absent — would 404 if hit; we assert it's never queried.
    });

    try {
      await withHarness(true, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/twilio/admin/backfill-statuses?days=30`, {
          method: "POST",
        });
        check("returns HTTP 200", res.status === 200, String(res.status));
        const body = (await res.json()) as {
          dryRun: boolean;
          candidates: number;
          updated: number;
          unchanged: number;
          missing: number;
          failed: number;
        };

        check("dryRun=false echoed", body.dryRun === false, String(body.dryRun));
        check(
          "only outbound rows with a SID are candidates (3, not 4 or 5)",
          body.candidates === 3,
          `candidates=${body.candidates}`,
        );
        check("updated=1 (SID_DRIFT moved sent→delivered)", body.updated === 1, `updated=${body.updated}`);
        check("unchanged=1 (SID_SAME already delivered)", body.unchanged === 1, `unchanged=${body.unchanged}`);
        check("missing=1 (SID_GONE returned 404)", body.missing === 1, `missing=${body.missing}`);
        check("failed=0 (no unexpected errors)", body.failed === 0, `failed=${body.failed}`);

        // DB-level assertions: drift row was written, others were not.
        const driftRow = await getRow(SID_DRIFT);
        check(
          "drift row's status was written through to DB",
          driftRow?.status === "delivered",
          String(driftRow?.status),
        );
        const sameRow = await getRow(SID_SAME);
        check("unchanged row stays at 'delivered'", sameRow?.status === "delivered", String(sameRow?.status));
        const goneRow = await getRow(SID_GONE);
        check("missing row left untouched at 'sent'", goneRow?.status === "sent", String(goneRow?.status));
        const inboundRow = await getRow(SID_INBOUND);
        check(
          "inbound row left untouched at 'received'",
          inboundRow?.status === "received",
          String(inboundRow?.status),
        );
      });
    } finally {
      restore();
    }
  });
}

// ---------------------------------------------------------------------------
// (3) dryRun=true must perform NO writes even when drift is detected.
// ---------------------------------------------------------------------------
async function testEndpointDryRun(): Promise<void> {
  console.log("\n— 3. dryRun=true reports drift but writes nothing —");

  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    const conv = await seedConversation();
    const SID = `SMdry${Date.now().toString(36)}`;
    await seedOutboundMessage(SID, conv.id, "sent");

    const restore = withStubbedTwilioMessages({
      [SID]: { status: "delivered", errorCode: null, errorMessage: null },
    });

    try {
      await withHarness(true, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/twilio/admin/backfill-statuses?dryRun=true`, {
          method: "POST",
        });
        const body = (await res.json()) as { dryRun: boolean; updated: number };
        check("dryRun=true echoed", body.dryRun === true, String(body.dryRun));
        check("updated still counted under dryRun", body.updated === 1, `updated=${body.updated}`);

        const row = await getRow(SID);
        check("DB row was NOT written under dryRun", row?.status === "sent", String(row?.status));
      });
    } finally {
      restore();
    }
  });
}

// ---------------------------------------------------------------------------
// (4) Non-CEO users must get 403 — admin gating is non-negotiable since
//     this endpoint mutates message-history rows in bulk.
// ---------------------------------------------------------------------------
async function testEndpointRequiresCeo(): Promise<void> {
  console.log("\n— 4. non-CEO callers get 403 —");

  await runInTxSandbox(async () => {
    await seedTwilioCredentials();
    await withHarness(false, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/twilio/admin/backfill-statuses`, { method: "POST" });
      check(
        "non-CEO POST returns 403 (or 401)",
        res.status === 403 || res.status === 401,
        String(res.status),
      );
    });
  });
}

async function main(): Promise<void> {
  console.log("Task #881 — Twilio delivery-status backfill");

  await testFetchMessageStatus();
  await testEndpointHappyPath();
  await testEndpointDryRun();
  await testEndpointRequiresCeo();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
