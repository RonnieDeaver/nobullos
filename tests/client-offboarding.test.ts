/* test-registration
{
  "name": "Client offboarding — initiate/reschedule/cancel routes (gating, validation, one-active invariant, payloads) + auto-archive sweep (due/overdue archived w/ comms side effect, future/cancelled untouched, re-run no-op) (Task #3711)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3711: client offboarding with auto-archive on the final service day. Route-level gate/validation/one-active-record coverage over real HTTP plus the daily sweep's step pipeline: due+overdue clients archived via the shared archive helper (comms side effect included), future and cancelled records untouched, completion audit is system-actor, the dispatcher notification fires once per client, and a re-run is a no-op. Guards an operator-facing scheduled promise (a client's final day of service) end to end; isolated schema, no external network.",
  "tier": "small"
}
test-registration */
/**
 * Task #3711 — Client offboarding with auto-archive on the final service day.
 *
 * Route coverage (real HTTP against registerClientRoutes in an isolated
 * schema, pinGetDbForCrossAsync so Express handlers hit the clones):
 *   (A) Role gating: unauthenticated → 401; sales → 403 on POST and DELETE;
 *       account_manager and team_lead pass (same gate as the archive action).
 *   (B) Validation: bad format / impossible calendar date / past date /
 *       already-archived client → 400; unknown client → 404.
 *   (C) Initiate → 201 + audit row; reschedule → 200, SAME record moved
 *       (one-scheduled-row invariant holds); cancel → 200 + audit row,
 *       repeat cancel → 404; re-initiate after cancel makes a NEW record.
 *   (D) Payload surfacing: GET /api/clients rows carry `offboarding`
 *       ({id, finalServiceDate, status} | null) in plain and paginated
 *       shapes; GET /api/clients/:id/summary carries `offboarding`.
 *
 * Sweep coverage (runClientOffboardingSweep called directly):
 *   (E) Due-today and overdue offboardings archive their clients with the
 *       comms-channel side effect (shared helper), record step_state,
 *       mark the record completed, write a system-actor (user_id NULL)
 *       client_offboarding_completed audit row, and fire the completion
 *       notification (captured via the test notifier seam).
 *   (F) Future-dated offboardings and cancelled records are untouched.
 *   (G) Claim races (via the before-claim test hook, which fires in
 *       exactly the window between the sweep's list read and its atomic
 *       claim): a cancel landing in that window means the client is NOT
 *       archived and the record stays cancelled; a reschedule-to-future
 *       landing there means the claim's due-date guard defeats it and the
 *       client is NOT archived.
 *   (H) While a record is claimed (`processing`), initiate/reschedule and
 *       cancel both 409; a crash-orphaned `processing` row that is still
 *       due is re-claimed and resumed by the next sweep.
 *   (I) Re-running the sweep is a no-op (atomic claims + idempotent step
 *       tracking + claim-guarded completion): zero due, no new
 *       audit/notification.
 *   (J) Archived clients drop out of the default GET /api/clients list.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql, eq, and, inArray } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerClientRoutes } from "../server/routes/clients";
import { clients, clientOffboardings, commsChannels } from "@shared/schema";
import {
  runClientOffboardingSweep,
  todayInNewYork,
  __test_setBeforeClaimHook,
  __test_setOffboardCompletedNotifier,
} from "../server/services/clientOffboardingSweep";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const LEAD_ID = `test-3711-lead-${RUN}`;
const AM_ID = `test-3711-am-${RUN}`;
const SALES_ID = `test-3711-sales-${RUN}`;

const TABLES = [
  "users",
  "clients",
  "client_offboardings",
  "user_activity_logs",
  "comms_channels",
] as const;

// The auth middleware reads this closure variable so each request can
// present a different actor without re-registering routes.
let activeUserId: string | null = LEAD_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerClientRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://${"127.0.0.1"}:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

function dayOffsetNY(days: number): string {
  return todayInNewYork(new Date(Date.now() + days * 86_400_000));
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed actors ──────────────────────────────────────────────────
      for (const [id, role, name] of [
        [LEAD_ID, "team_lead", "Lead 3711"],
        [AM_ID, "account_manager", "AM 3711"],
        [SALES_ID, "sales", "Sales 3711"],
      ] as const) {
        await db.execute(sql`
          INSERT INTO users (id, role, first_name)
          VALUES (${id}, ${role}, ${name})
          ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        `);
        // Users are seeded only in the isolated sandbox schema; pre-register
        // them with requireAuth's registry so admission uses the profile
        // directly instead of missing the public lookup and JIT-provisioning
        // a stray public row. The route re-reads role via storage.getUser
        // under the pinned isolated schema.
        __test_markUserReconciled(id, { id, role });
      }

      // ── Seed clients ─────────────────────────────────────────────────
      const mkClient = async (label: string, extra: Partial<typeof clients.$inferInsert> = {}) => {
        const [row] = await db
          .insert(clients)
          .values({ firmName: `Offboard ${label} ${RUN}`, ...extra })
          .returning();
        return row;
      };
      const clientA = await mkClient("A-due-today");
      const clientB = await mkClient("B-overdue");
      const clientC = await mkClient("C-future");
      const clientD = await mkClient("D-cancelled");
      const clientE = await mkClient("E-control");
      const clientArchived = await mkClient("X-archived", { isArchived: true });
      const clientF = await mkClient("F-cancel-race");
      const clientG = await mkClient("G-reschedule-race");
      const clientH = await mkClient("H-crash-resume");

      // Comms channels for the two clients the sweep will archive — proves
      // the shared helper's comms side effect runs from the sweep path.
      await db.insert(commsChannels).values({
        clientId: clientA.id,
        name: `off-a-${RUN}`,
        slug: `off-a-${RUN}`,
      });
      await db.insert(commsChannels).values({
        clientId: clientB.id,
        name: `off-b-${RUN}`,
        slug: `off-b-${RUN}`,
      });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      const today = todayInNewYork();
      const future = dayOffsetNY(30);
      const future2 = dayOffsetNY(45);
      try {
        // ── (A) Role gating ──────────────────────────────────────────
        activeUserId = null;
        let r = await call(baseUrl, "POST", `/api/clients/${clientC.id}/offboarding`, { finalServiceDate: future });
        assert.equal(r.status, 401, `unauthenticated POST expected 401, got ${r.status}`);

        activeUserId = SALES_ID;
        r = await call(baseUrl, "POST", `/api/clients/${clientC.id}/offboarding`, { finalServiceDate: future });
        assert.equal(r.status, 403, `sales POST expected 403, got ${r.status}`);
        r = await call(baseUrl, "DELETE", `/api/clients/${clientC.id}/offboarding`);
        assert.equal(r.status, 403, `sales DELETE expected 403, got ${r.status}`);

        // ── (B) Validation ───────────────────────────────────────────
        activeUserId = LEAD_ID;
        r = await call(baseUrl, "POST", `/api/clients/${clientE.id}/offboarding`, { finalServiceDate: "07/15/2026" });
        assert.equal(r.status, 400, "bad format expected 400");
        r = await call(baseUrl, "POST", `/api/clients/${clientE.id}/offboarding`, { finalServiceDate: "2026-02-30" });
        assert.equal(r.status, 400, "impossible calendar date expected 400");
        r = await call(baseUrl, "POST", `/api/clients/${clientE.id}/offboarding`, { finalServiceDate: "2020-01-01" });
        assert.equal(r.status, 400, "past date expected 400");
        r = await call(baseUrl, "POST", `/api/clients/${clientArchived.id}/offboarding`, { finalServiceDate: future });
        assert.equal(r.status, 400, "already-archived client expected 400");
        r = await call(baseUrl, "POST", `/api/clients/nonexistent-${RUN}/offboarding`, { finalServiceDate: future });
        assert.equal(r.status, 404, "unknown client expected 404");

        // ── (C) Initiate / reschedule / cancel lifecycle ─────────────
        // account_manager passes the gate (same as the archive action).
        activeUserId = AM_ID;
        r = await call(baseUrl, "POST", `/api/clients/${clientC.id}/offboarding`, { finalServiceDate: future });
        assert.equal(r.status, 201, `AM initiate expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.action, "initiated");
        assert.equal(r.body.offboarding.finalServiceDate, future);
        assert.equal(r.body.offboarding.status, "scheduled");
        assert.equal(r.body.offboarding.initiatedByUserId, AM_ID);
        const cOffboardingId = r.body.offboarding.id as string;

        // Reschedule moves the SAME record.
        activeUserId = LEAD_ID;
        r = await call(baseUrl, "POST", `/api/clients/${clientC.id}/offboarding`, { finalServiceDate: future2 });
        assert.equal(r.status, 200, `reschedule expected 200, got ${r.status}`);
        assert.equal(r.body.action, "rescheduled");
        assert.equal(r.body.offboarding.id, cOffboardingId, "reschedule created a new record instead of moving the existing one");
        assert.equal(r.body.offboarding.finalServiceDate, future2);

        const cScheduledRows = await db
          .select()
          .from(clientOffboardings)
          .where(and(eq(clientOffboardings.clientId, clientC.id), eq(clientOffboardings.status, "scheduled")));
        assert.equal(cScheduledRows.length, 1, "one-scheduled-record invariant violated for clientC");

        // Audit rows for initiate + reschedule.
        const cAudit = await db.execute(sql`
          SELECT user_id, action_type, metadata FROM user_activity_logs
          WHERE action_type IN ('client_offboarding_scheduled', 'client_offboarding_rescheduled')
            AND metadata->>'clientId' = ${clientC.id}
          ORDER BY timestamp
        `);
        assert.equal(cAudit.rows.length, 2, `expected 2 audit rows for clientC, got ${cAudit.rows.length}`);
        assert.equal(cAudit.rows[0].action_type, "client_offboarding_scheduled");
        assert.equal(cAudit.rows[0].user_id, AM_ID);
        assert.equal(cAudit.rows[1].action_type, "client_offboarding_rescheduled");
        assert.equal((cAudit.rows[1].metadata as any).previousFinalServiceDate, future);

        // Cancel with nothing scheduled → 404.
        r = await call(baseUrl, "DELETE", `/api/clients/${clientE.id}/offboarding`);
        assert.equal(r.status, 404, "cancel with nothing scheduled expected 404");

        // Schedule + cancel clientD; repeat cancel → 404.
        r = await call(baseUrl, "POST", `/api/clients/${clientD.id}/offboarding`, { finalServiceDate: today });
        assert.equal(r.status, 201);
        const dFirstId = r.body.offboarding.id as string;
        r = await call(baseUrl, "DELETE", `/api/clients/${clientD.id}/offboarding`);
        assert.equal(r.status, 200, `cancel expected 200, got ${r.status}`);
        assert.equal(r.body.offboarding.status, "cancelled");
        assert.equal(r.body.offboarding.cancelledByUserId, LEAD_ID);
        r = await call(baseUrl, "DELETE", `/api/clients/${clientD.id}/offboarding`);
        assert.equal(r.status, 404, "repeat cancel expected 404");

        const dCancelAudit = await db.execute(sql`
          SELECT user_id FROM user_activity_logs
          WHERE action_type = 'client_offboarding_cancelled' AND metadata->>'clientId' = ${clientD.id}
        `);
        assert.equal(dCancelAudit.rows.length, 1, "expected 1 cancel audit row for clientD");

        // Re-initiate after cancel → NEW record; cancel it again so clientD
        // holds only cancelled records for the sweep section.
        r = await call(baseUrl, "POST", `/api/clients/${clientD.id}/offboarding`, { finalServiceDate: today });
        assert.equal(r.status, 201, "re-initiate after cancel expected 201 (fresh record)");
        assert.equal(r.body.action, "initiated");
        assert.notEqual(r.body.offboarding.id, dFirstId, "re-initiate reused the cancelled record");
        r = await call(baseUrl, "DELETE", `/api/clients/${clientD.id}/offboarding`);
        assert.equal(r.status, 200);

        // Schedule clientA for today via the route (due immediately).
        r = await call(baseUrl, "POST", `/api/clients/${clientA.id}/offboarding`, { finalServiceDate: today });
        assert.equal(r.status, 201, `clientA initiate expected 201, got ${r.status}`);

        // clientB overdue: direct insert (the route rejects past dates by
        // design — overdue rows exist when the app was down past the date).
        await db.insert(clientOffboardings).values({
          clientId: clientB.id,
          finalServiceDate: dayOffsetNY(-3),
          initiatedByUserId: LEAD_ID,
        });

        // F + G due today via the route — the sweep race section (G) cancels/
        // reschedules them in the before-claim window.
        r = await call(baseUrl, "POST", `/api/clients/${clientF.id}/offboarding`, { finalServiceDate: today });
        assert.equal(r.status, 201, `clientF initiate expected 201, got ${r.status}`);
        r = await call(baseUrl, "POST", `/api/clients/${clientG.id}/offboarding`, { finalServiceDate: today });
        assert.equal(r.status, 201, `clientG initiate expected 201, got ${r.status}`);
        const gRescheduleDate = dayOffsetNY(21);

        // ── (D) Payload surfacing ────────────────────────────────────
        r = await call(baseUrl, "GET", "/api/clients");
        assert.equal(r.status, 200);
        const listA = r.body.find((c: any) => c.id === clientA.id);
        const listE = r.body.find((c: any) => c.id === clientE.id);
        assert.ok(listA, "clientA missing from list");
        assert.equal(listA.offboarding?.finalServiceDate, today, "list payload missing clientA offboarding");
        assert.equal(listA.offboarding?.status, "scheduled");
        assert.ok(listE, "clientE missing from list");
        assert.equal(listE.offboarding, null, "clientE expected offboarding: null");

        r = await call(baseUrl, "GET", "/api/clients?limit=100&page=1");
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.body.data), "paginated shape expected { data }");
        const pagA = r.body.data.find((c: any) => c.id === clientA.id);
        assert.equal(pagA?.offboarding?.finalServiceDate, today, "paginated payload missing offboarding");

        r = await call(baseUrl, "GET", `/api/clients/${clientC.id}/summary`);
        assert.equal(r.status, 200);
        assert.equal(r.body.offboarding?.id, cOffboardingId, "summary payload missing offboarding");
        assert.equal(r.body.offboarding?.finalServiceDate, future2);
        r = await call(baseUrl, "GET", `/api/clients/${clientE.id}/summary`);
        assert.equal(r.status, 200);
        assert.equal(r.body.offboarding, null, "summary for clientE expected offboarding: null");

        // ── (E)–(G) Sweep ────────────────────────────────────────────
        const notified: { clientId: string; offboardingId: string; finalServiceDate: string }[] = [];
        __test_setOffboardCompletedNotifier(async (client, offboarding) => {
          notified.push({
            clientId: client.id,
            offboardingId: offboarding.id,
            finalServiceDate: offboarding.finalServiceDate,
          });
        });
        try {
          // (G) Race hook: cancel F and reschedule G through the REAL routes
          // in the window between the sweep's list read and its atomic claim
          // — exactly the race the claim guard exists for.
          activeUserId = LEAD_ID;
          __test_setBeforeClaimHook(async (offboarding) => {
            if (offboarding.clientId === clientF.id) {
              const rr = await call(baseUrl, "DELETE", `/api/clients/${clientF.id}/offboarding`);
              assert.equal(rr.status, 200, `mid-sweep cancel expected 200, got ${rr.status}`);
            } else if (offboarding.clientId === clientG.id) {
              const rr = await call(baseUrl, "POST", `/api/clients/${clientG.id}/offboarding`, {
                finalServiceDate: gRescheduleDate,
              });
              assert.equal(rr.status, 200, `mid-sweep reschedule expected 200, got ${rr.status}`);
            }
          });
          const run1 = await runClientOffboardingSweep();
          __test_setBeforeClaimHook(null);
          assert.equal(run1.due, 4, `sweep expected 4 due (A today, B overdue, F, G), got ${run1.due}`);
          assert.equal(run1.completed, 2, `sweep expected 2 completed, got ${run1.completed} (errors=${run1.errors})`);
          assert.equal(run1.errors, 0);
          assert.equal(run1.skipped, 2, `expected F+G claims defeated (skipped=2), got ${run1.skipped}`);

          // Clients A + B archived; C, D, E and the raced F, G untouched.
          const after = await db
            .select({ id: clients.id, isArchived: clients.isArchived })
            .from(clients)
            .where(inArray(clients.id, [clientA.id, clientB.id, clientC.id, clientD.id, clientE.id, clientF.id, clientG.id]));
          const archivedById = new Map(after.map((c) => [c.id, c.isArchived]));
          assert.equal(archivedById.get(clientA.id), true, "clientA (due today) not archived");
          assert.equal(archivedById.get(clientB.id), true, "clientB (overdue) not archived");
          assert.equal(archivedById.get(clientC.id), false, "clientC (future) wrongly archived");
          assert.equal(archivedById.get(clientD.id), false, "clientD (cancelled) wrongly archived");
          assert.equal(archivedById.get(clientE.id), false, "clientE (control) wrongly archived");
          assert.equal(archivedById.get(clientF.id), false, "clientF (cancelled mid-sweep) wrongly archived");
          assert.equal(archivedById.get(clientG.id), false, "clientG (rescheduled mid-sweep) wrongly archived");

          // Offboarding records completed with idempotent step tracking.
          const doneRows = await db
            .select()
            .from(clientOffboardings)
            .where(inArray(clientOffboardings.clientId, [clientA.id, clientB.id]));
          for (const row of doneRows) {
            assert.equal(row.status, "completed", `offboarding ${row.id} expected completed, got ${row.status}`);
            assert.ok(row.completedAt, "completedAt not set");
            const stepState = row.stepState as Record<string, { completedAt: string }>;
            assert.ok(stepState.archive_client?.completedAt, "step_state missing archive_client completion");
          }

          // clientC's record is still scheduled.
          const cAfter = await db
            .select()
            .from(clientOffboardings)
            .where(and(eq(clientOffboardings.clientId, clientC.id), eq(clientOffboardings.status, "scheduled")));
          assert.equal(cAfter.length, 1, "clientC scheduled record disappeared");

          // Race outcomes: F's record ended cancelled, G's is still scheduled
          // at the moved date — and neither ran any pipeline step.
          const [fRow] = await db
            .select()
            .from(clientOffboardings)
            .where(eq(clientOffboardings.clientId, clientF.id));
          assert.equal(fRow.status, "cancelled", `clientF record expected cancelled, got ${fRow.status}`);
          assert.deepEqual(fRow.stepState, {}, "clientF stepState expected empty (no step ran)");
          const [gRow] = await db
            .select()
            .from(clientOffboardings)
            .where(eq(clientOffboardings.clientId, clientG.id));
          assert.equal(gRow.status, "scheduled", `clientG record expected scheduled, got ${gRow.status}`);
          assert.equal(gRow.finalServiceDate, gRescheduleDate, "clientG final day not moved by mid-sweep reschedule");
          assert.deepEqual(gRow.stepState, {}, "clientG stepState expected empty (no step ran)");

          // Comms side effect via the shared helper: both channels archived.
          const chans = await db
            .select()
            .from(commsChannels)
            .where(inArray(commsChannels.clientId, [clientA.id, clientB.id]));
          assert.equal(chans.length, 2);
          for (const ch of chans) {
            assert.ok(ch.archivedAt, `comms channel ${ch.id} (client ${ch.clientId}) not archived by sweep`);
          }

          // System-actor completion audit rows (user_id NULL).
          const completedAudit = await db.execute(sql`
            SELECT user_id, metadata FROM user_activity_logs
            WHERE action_type = 'client_offboarding_completed'
              AND metadata->>'clientId' IN (${clientA.id}, ${clientB.id})
          `);
          assert.equal(completedAudit.rows.length, 2, `expected 2 completion audit rows, got ${completedAudit.rows.length}`);
          for (const row of completedAudit.rows) {
            assert.equal(row.user_id, null, "completion audit row expected system actor (user_id NULL)");
          }

          // Completion notifications fired once per client.
          assert.equal(notified.length, 2, `expected 2 notifications, got ${notified.length}`);
          assert.deepEqual(
            new Set(notified.map((n) => n.clientId)),
            new Set([clientA.id, clientB.id]),
            "notification clients mismatch",
          );

          // (J) Archived clients drop out of the default list.
          activeUserId = LEAD_ID;
          const listAfter = await call(baseUrl, "GET", "/api/clients");
          assert.equal(listAfter.status, 200);
          const idsAfter = new Set(listAfter.body.map((c: any) => c.id));
          assert.ok(!idsAfter.has(clientA.id), "archived clientA still in default list");
          assert.ok(!idsAfter.has(clientB.id), "archived clientB still in default list");
          assert.ok(idsAfter.has(clientE.id), "clientE missing from default list");

          // (H) A claimed (`processing`) record blocks reschedule AND cancel
          // with 409 — the operator can't yank a record mid-pipeline…
          const [hRow] = await db
            .insert(clientOffboardings)
            .values({
              clientId: clientH.id,
              finalServiceDate: today,
              initiatedByUserId: LEAD_ID,
              status: "processing", // simulates a sweep crash mid-pipeline
            })
            .returning();
          r = await call(baseUrl, "POST", `/api/clients/${clientH.id}/offboarding`, { finalServiceDate: future });
          assert.equal(r.status, 409, `reschedule of a processing record expected 409, got ${r.status}`);
          r = await call(baseUrl, "DELETE", `/api/clients/${clientH.id}/offboarding`);
          assert.equal(r.status, 409, `cancel of a processing record expected 409, got ${r.status}`);

          // …and a crash-orphaned claim that is still due is re-claimed and
          // resumed by the next sweep rather than stuck forever.
          const run2 = await runClientOffboardingSweep();
          assert.equal(run2.due, 1, `run2 expected only clientH due, got ${run2.due}`);
          assert.equal(run2.completed, 1, `crash-orphaned processing record not resumed (errors=${run2.errors})`);
          const [hAfter] = await db
            .select()
            .from(clientOffboardings)
            .where(eq(clientOffboardings.id, hRow.id));
          assert.equal(hAfter.status, "completed", `clientH record expected completed after resume, got ${hAfter.status}`);
          const [hClient] = await db
            .select({ isArchived: clients.isArchived })
            .from(clients)
            .where(eq(clients.id, clientH.id));
          assert.equal(hClient.isArchived, true, "clientH not archived by the resumed sweep");
          assert.equal(notified.length, 3, `clientH completion notification missing (got ${notified.length})`);

          // (I) Re-run is a no-op.
          const run3 = await runClientOffboardingSweep();
          assert.equal(run3.due, 0, `re-run expected 0 due, got ${run3.due}`);
          assert.equal(run3.completed, 0);
          assert.equal(notified.length, 3, "re-run fired extra notifications");
          const auditRecount = await db.execute(sql`
            SELECT count(*)::int AS n FROM user_activity_logs
            WHERE action_type = 'client_offboarding_completed'
              AND metadata->>'clientId' IN (${clientA.id}, ${clientB.id}, ${clientH.id})
          `);
          assert.equal((auditRecount.rows[0] as any).n, 3, "re-run wrote extra completion audit rows");
        } finally {
          __test_setOffboardCompletedNotifier(null);
          __test_setBeforeClaimHook(null);
        }
      } finally {
        __test_resetReconciledUsers();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );
}

main()
  .then(async () => {
    console.log("client-offboarding.test.ts: ALL PASSED");
    await getGlobalDispatcher().close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("client-offboarding.test.ts FAILED:", err);
    await getGlobalDispatcher().close();
    process.exit(1);
  });
