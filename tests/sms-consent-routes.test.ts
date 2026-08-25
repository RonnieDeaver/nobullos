/* test-registration
{
  "name": "SMS consent routes: authz + ledger/settings round-trips (Task #4336)",
  "regression": true,
  "sweepOnlyReason": "Task #4336 — isolated-schema HTTP round-trips: clones 5 tables + express auth shim per run, heavier than the smoke budget warrants; the smoke gate already covers the consent runtime seams (classifier, inbound webhook recording, send gate).",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
// Task #4336 — HTTP coverage for registerSmsConsentRoutes:
//   - authz: unauthenticated → 401; account_manager can read status but
//     gets 403 on every /api/admin/sms-consent/* route; team_lead passes
//   - manual state set writes the ledger + event and validates input
//     (short note, bad timezone → 400)
//   - status lookups match across phone formatting variants (match-key
//     fallback) and the batch endpoint keys results by the caller's
//     original strings
//   - ledger list/filter/counts and the settings GET/PUT round-trip
//
// Per the db-sandbox contract, HTTP-endpoint tests use runInIsolatedSchema
// with pinGetDbForCrossAsync (request handlers run outside the sandbox
// ALS scope; a tx sandbox would deadlock on uncommitted seeds).
//
// Usage: tsx tests/sms-consent-routes.test.ts

// FIRST import so NODE_ENV=test beats hoisted server imports (pool config).
import "./helpers/forceTestEnv";

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

import { registerSmsConsentRoutes } from "../server/routes/smsConsent";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";

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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const TEAM_LEAD_ID = `sms-routes-tl-${RUN}`;
const AM_ID = `sms-routes-am-${RUN}`;

// Auth shim — Clerk route-test seam: requireAuth (NODE_ENV=test) reads the
// per-request `__test_clerkUserId` (string → authed as that user, null →
// 401); roles still resolve genuinely from the seeded users rows.
let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.__test_clerkUserId = currentUserId;
    next();
  });
  registerSmsConsentRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function freshPhone(): string {
  const suffix = String(Math.floor(1000000 + Math.random() * 8999999));
  return `+1215${suffix}`;
}

async function main(): Promise<void> {
  console.log("SMS consent routes (Task #4336)");

  await runInIsolatedSchema(
    async () => {
      await getDb().insert(users).values([
        { id: TEAM_LEAD_ID, email: `tl-${RUN}@example.test`, role: "team_lead" },
        { id: AM_ID, email: `am-${RUN}@example.test`, role: "account_manager" },
      ]);

      // requireAuth's admission lookup uses the ambient public-schema db, so
      // pre-register both identities on the test-provisioned registry; the
      // role gates (requireTeamLead / requireTwilioAccess) still resolve
      // roles genuinely from the seeded sandbox rows via pinned getDb().
      __test_markUserReconciled(TEAM_LEAD_ID, {
        id: TEAM_LEAD_ID,
        email: `tl-${RUN}@example.test`,
        role: "team_lead",
      });
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        email: `am-${RUN}@example.test`,
        role: "account_manager",
      });

      await withApp(async (base) => {
        const p1 = freshPhone(); // E.164 form
        const p1Pretty = `(${p1.slice(2, 5)}) ${p1.slice(5, 8)}-${p1.slice(8)}`;
        const p1Dashes = `${p1.slice(2, 5)}-${p1.slice(5, 8)}-${p1.slice(8)}`;

        console.log("\n— 1. Authz —");
        currentUserId = null;
        const anon = await req(base, "GET", `/api/sms-consent/status?phone=${encodeURIComponent(p1)}`);
        check("unauthenticated status lookup → 401", anon.status === 401, String(anon.status));
        const anonAdmin = await req(base, "GET", "/api/admin/sms-consent/ledger");
        check("unauthenticated admin ledger → 401", anonAdmin.status === 401);

        currentUserId = AM_ID;
        const amStatus = await req(base, "GET", `/api/sms-consent/status?phone=${encodeURIComponent(p1)}`);
        check(
          "account_manager reads status (unknown, exists:false)",
          amStatus.status === 200 && amStatus.json?.state === "unknown" && amStatus.json?.exists === false,
        );
        for (const path of [
          "/api/admin/sms-consent/ledger",
          "/api/admin/sms-consent/events",
          "/api/admin/sms-consent/gate-audit",
          "/api/admin/sms-consent/settings",
        ]) {
          const r = await req(base, "GET", path);
          check(`account_manager ${path} → 403`, r.status === 403, String(r.status));
        }
        const amManual = await req(base, "POST", "/api/admin/sms-consent/manual", {
          phone: p1,
          state: "opted_out",
          note: "should be rejected",
        });
        check("account_manager manual set → 403", amManual.status === 403);

        console.log("\n— 2. Manual set + validation —");
        currentUserId = TEAM_LEAD_ID;
        const shortNote = await req(base, "POST", "/api/admin/sms-consent/manual", {
          phone: p1,
          state: "opted_out",
          note: "no",
        });
        check("note under 3 chars → 400", shortNote.status === 400);
        const badTz = await req(base, "POST", "/api/admin/sms-consent/manual", {
          phone: p1,
          state: "opted_in",
          note: "with a bad timezone",
          timezone: "Mars/Olympus_Mons",
        });
        check("unknown IANA timezone → 400", badTz.status === 400);
        const badState = await req(base, "POST", "/api/admin/sms-consent/manual", {
          phone: p1,
          state: "banana",
          note: "invalid state",
        });
        check("invalid state enum → 400", badState.status === 400);

        const manual = await req(base, "POST", "/api/admin/sms-consent/manual", {
          phone: p1Pretty, // formatted input must normalize
          state: "opted_out",
          note: `Client emailed asking to stop texts (${RUN})`,
          timezone: "America/Chicago",
        });
        check("valid manual set → 200 changed:true", manual.status === 200 && manual.json?.changed === true);

        console.log("\n— 3. Status lookups across formats —");
        const statusDashes = await req(
          base,
          "GET",
          `/api/sms-consent/status?phone=${encodeURIComponent(p1Dashes)}`,
        );
        check(
          "differently-formatted lookup finds the same row",
          statusDashes.status === 200 &&
            statusDashes.json?.state === "opted_out" &&
            statusDashes.json?.exists === true &&
            statusDashes.json?.timezone === "America/Chicago",
        );
        const unknownP = freshPhone();
        currentUserId = AM_ID;
        const batch = await req(base, "POST", "/api/sms-consent/status-batch", {
          phones: [p1Dashes, unknownP],
        });
        check(
          "batch keys results by the caller's ORIGINAL strings",
          batch.status === 200 &&
            batch.json?.statuses?.[p1Dashes]?.state === "opted_out" &&
            batch.json?.statuses?.[unknownP]?.state === "unknown",
        );
        const emptyBatch = await req(base, "POST", "/api/sms-consent/status-batch", { phones: [] });
        check("empty batch → 400", emptyBatch.status === 400);

        console.log("\n— 4. Admin ledger/events/gate-audit —");
        currentUserId = TEAM_LEAD_ID;
        const ledger = await req(base, "GET", "/api/admin/sms-consent/ledger?state=opted_out");
        check(
          "ledger filter returns the manual row with counts",
          ledger.status === 200 &&
            Array.isArray(ledger.json?.rows) &&
            ledger.json.rows.some((r: any) => r.phoneNormalized === p1) &&
            (ledger.json?.countsByState?.opted_out ?? 0) >= 1 &&
            ledger.json?.total >= 1,
        );
        const searched = await req(
          base,
          "GET",
          `/api/admin/sms-consent/ledger?search=${p1.slice(5, 11)}`,
        );
        check(
          "digit search matches",
          searched.status === 200 && searched.json?.rows?.some((r: any) => r.phoneNormalized === p1),
        );
        const events = await req(base, "GET", `/api/admin/sms-consent/events?phone=${encodeURIComponent(p1)}`);
        check(
          "events list shows the manual_set with attribution note",
          events.status === 200 &&
            events.json?.rows?.some(
              (e: any) => e.eventType === "manual_set" && String(e.detail ?? "").includes(RUN),
            ),
        );
        const audit = await req(base, "GET", "/api/admin/sms-consent/gate-audit");
        check("gate-audit responds with a rows array", audit.status === 200 && Array.isArray(audit.json?.rows));
        const badQuery = await req(base, "GET", "/api/admin/sms-consent/gate-audit?outcome=nonsense");
        check("invalid outcome filter → 400", badQuery.status === 400);

        console.log("\n— 5. Settings round-trip —");
        const before = await req(base, "GET", "/api/admin/sms-consent/settings");
        check(
          "settings GET returns gate + storm blocks",
          before.status === 200 &&
            typeof before.json?.gate?.automatedSendsEnabled === "boolean" &&
            typeof before.json?.storm?.threshold === "number",
        );
        // Write the shipped defaults back (values unchanged ⇒ no cross-suite
        // settings-cache pollution) — this still exercises the full PUT path.
        const put = await req(base, "PUT", "/api/admin/sms-consent/settings", {
          gate: {
            automatedSendsEnabled: false,
            sendWindowStartHourLocal: 8,
            sendWindowEndHourLocal: 21,
          },
          storm: before.json.storm,
        });
        check(
          "settings PUT round-trips the stored values",
          put.status === 200 &&
            put.json?.gate?.automatedSendsEnabled === false &&
            put.json?.gate?.sendWindowStartHourLocal === 8,
        );
        const emptyPut = await req(base, "PUT", "/api/admin/sms-consent/settings", {});
        check("empty settings PUT → 400", emptyPut.status === 400);
        const badPut = await req(base, "PUT", "/api/admin/sms-consent/settings", {
          gate: { automatedSendsEnabled: true, sendWindowStartHourLocal: 25, sendWindowEndHourLocal: 21 },
        });
        check("out-of-range window hour → 400", badPut.status === 400);
      });
    },
    {
      tables: [
        "users",
        "sms_consent_ledger",
        "sms_consent_events",
        "sms_send_gate_audit",
        "system_settings",
      ],
      pinGetDbForCrossAsync: true,
    },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Batched runner children share a process — never leak provisioned ids.
    __test_resetReconciledUsers();
  });
