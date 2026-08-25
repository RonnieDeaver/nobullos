/* test-registration
{
  "name": "Report presented/delivered mark — server-side stamping, matrix exposure, share exclusion (Task #4537)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4537: the presented/delivered mark is an operator-only delivery audit stamp. PATCH /api/reports/:id must stamp actor+timestamp SERVER-side (client-supplied presentedAt/presentedBy are stripped by the boundary schemas — a drift lets operators forge delivery audit trails), repeated true must not re-stamp, false must clear both columns, and the anonymous share payload must never carry any presented key — a leak ships internal delivery bookkeeping to paying clients.",
  "tier": "small"
}
test-registration */
/**
 * Task #4537 — "Presented / Delivered" per-month report mark.
 *
 * Covers the full contract of the new presented-tracking columns:
 *
 *   1. PATCH /api/reports/:id with `presented: true` stamps presentedAt (now)
 *      and presentedBy (the AUTHENTICATED actor) server-side; client-supplied
 *      presentedAt/presentedBy request fields are silently stripped by
 *      insertReportSchema/updateReportSchema (both omit the columns).
 *   2. Repeated `presented: true` is a no-op — the original stamp survives.
 *   3. A PATCH without the `presented` field leaves the mark untouched
 *      (normal autosaves must not clear delivery state).
 *   4. `presented: false` clears both columns (mistakes happen).
 *   5. Non-boolean `presented` → 400 via reportPresentedUpdateSchema.
 *   6. GET /api/reports/:id exposes presentedAt/presentedBy + the
 *      presentedByUser enrichment for the editor caption.
 *   7. GET /api/reports/matrix exposes presentedAt on month cells.
 *   8. The anonymous share payload (/api/share/:token) contains NO presented
 *      key anywhere — buildReportResponse allowlists report fields.
 *
 * Harness mirrors tests/report-public-internal-keys-sanitize.test.ts
 * (express + registerReportRoutes + runInIsolatedSchema) plus the Clerk-era
 * auth seam: a mutable per-request `__test_clerkUserId` and
 * `__test_markUserReconciled` so requireAuth resolves the operator without
 * JIT-provisioning public-schema rows.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { db, closeDbPools } from "../server/db";
import { runInIsolatedSchema, sql } from "./db-sandbox";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-4537-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OPERATOR_ID = `${TAG}-operator`;
const OPERATOR_EMAIL = `${OPERATOR_ID}@example.com`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_A_ID = `${TAG}-report-a`; // draft, exercised via PATCH
const REPORT_B_ID = `${TAG}-report-b`; // final + share token + pre-stamped mark
const SHARE_TOKEN = `${TAG}-share-token`;

// null = anonymous request (requireAuth 401s); string = that user.
let currentUserId: string | null = OPERATOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = currentUserId;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OPERATOR_ID}, 'ceo', ${OPERATOR_EMAIL}, 'Marker', 'Operator')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Delivery Mark Law (test)"}, ARRAY['gbp']::text[], ${OPERATOR_ID}, false)
    ON CONFLICT (id) DO NOTHING
  `);
  // Authoritative Active-Products source for the share lane (an absent/empty
  // command-panel row would strip blocks before the allowlist under test).
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, product_types, last_reviewed_at)
    VALUES (${CLIENT_ID}, ARRAY['gbp']::text[], now())
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${REPORT_A_ID}, ${CLIENT_ID}, '2026-06', 'draft')
  `);
  // Report B is what a presented final report looks like in prod: final,
  // shared, columns stamped — the share payload must still never leak them.
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${REPORT_B_ID}, ${CLIENT_ID}, '2026-05', 'final')
  `);
  await isoDb.execute(sql`
    UPDATE reports
    SET share_token = ${SHARE_TOKEN}, presented_at = now(), presented_by = ${OPERATOR_ID}
    WHERE id = ${REPORT_B_ID}
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${REPORT_B_ID}-marketing`}, ${REPORT_B_ID}, 'marketing',
            ${JSON.stringify({ totalLeads: 5 })}::jsonb)
  `);
}

function ts(v: unknown, label: string): number {
  assert.ok(typeof v === "string" && v.length > 0, `${label}: expected timestamp string, got ${JSON.stringify(v)}`);
  const t = new Date(v as string).getTime();
  assert.ok(Number.isFinite(t), `${label}: unparseable timestamp ${JSON.stringify(v)}`);
  return t;
}

async function patchReport(baseUrl: string, id: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/reports/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        __test_markUserReconciled(OPERATOR_ID, {
          id: OPERATOR_ID,
          email: OPERATOR_EMAIL,
          firstName: "Marker",
          lastName: "Operator",
          role: "ceo",
        });
        const { server, baseUrl } = await listen(buildApp());
        try {
          // 1. Fresh report: unpresented, enrichment null.
          const fresh = await fetch(`${baseUrl}/api/reports/${REPORT_A_ID}`);
          assert.equal(fresh.status, 200, "GET fresh report");
          const freshBody: any = await fresh.json();
          assert.equal(freshBody.presentedAt, null, "fresh report: presentedAt null");
          assert.equal(freshBody.presentedBy, null, "fresh report: presentedBy null");
          assert.equal(freshBody.presentedByUser, null, "fresh report: presentedByUser null");

          // 2. Mark presented — forged client-side stamp fields must be ignored.
          const before = Date.now();
          const mark = await patchReport(baseUrl, REPORT_A_ID, {
            presented: true,
            presentedAt: "1999-01-01T00:00:00.000Z",
            presentedBy: "evil-actor",
          });
          assert.equal(mark.status, 200, "PATCH presented:true");
          const marked: any = await mark.json();
          const stamp1 = ts(marked.presentedAt, "mark response presentedAt");
          assert.ok(
            stamp1 >= before - 5 * 60_000 && stamp1 <= Date.now() + 5 * 60_000,
            `presentedAt is stamped server-side with NOW (got ${marked.presentedAt}) — the forged 1999 value must never land`,
          );
          assert.equal(
            marked.presentedBy,
            OPERATOR_ID,
            "presentedBy is the authenticated actor, not the forged request field",
          );

          // 3. Repeated true: no re-stamp.
          await new Promise((r) => setTimeout(r, 25));
          const again = await patchReport(baseUrl, REPORT_A_ID, { presented: true });
          assert.equal(again.status, 200, "PATCH repeated presented:true");
          const againBody: any = await again.json();
          assert.equal(
            ts(againBody.presentedAt, "repeat response presentedAt"),
            stamp1,
            "repeated presented:true keeps the ORIGINAL stamp (no re-stamp)",
          );
          assert.equal(againBody.presentedBy, OPERATOR_ID, "repeat keeps original actor");

          // 4. PATCH without the field: mark untouched (autosaves must not clear it).
          const unrelated = await patchReport(baseUrl, REPORT_A_ID, { status: "draft" });
          assert.equal(unrelated.status, 200, "PATCH without presented field");
          const unrelatedBody: any = await unrelated.json();
          assert.equal(
            ts(unrelatedBody.presentedAt, "unrelated-save presentedAt"),
            stamp1,
            "a save without the presented field leaves the mark untouched",
          );

          // 5. Detail exposure: enrichment for the editor caption.
          const detail = await fetch(`${baseUrl}/api/reports/${REPORT_A_ID}`);
          assert.equal(detail.status, 200, "GET marked report");
          const detailBody: any = await detail.json();
          assert.equal(ts(detailBody.presentedAt, "detail presentedAt"), stamp1, "detail exposes presentedAt");
          assert.equal(detailBody.presentedBy, OPERATOR_ID, "detail exposes presentedBy");
          assert.deepEqual(
            detailBody.presentedByUser,
            { id: OPERATOR_ID, firstName: "Marker", lastName: "Operator", email: OPERATOR_EMAIL },
            "detail exposes the presentedByUser enrichment",
          );

          // (Matrix exposure is asserted in the public-schema phase below:
          // GET /api/reports/matrix queries through the raw ambient `db`
          // handle — not getDb() — so the isolated-schema pin never covers
          // that route's reads.)

          // 6. Clear: both columns null again.
          const clear = await patchReport(baseUrl, REPORT_A_ID, { presented: false });
          assert.equal(clear.status, 200, "PATCH presented:false");
          const cleared: any = await clear.json();
          assert.equal(cleared.presentedAt, null, "clear nulls presentedAt");
          assert.equal(cleared.presentedBy, null, "clear nulls presentedBy");
          const afterClear: any = await (await fetch(`${baseUrl}/api/reports/${REPORT_A_ID}`)).json();
          assert.equal(afterClear.presentedAt, null, "detail after clear: presentedAt null");
          assert.equal(afterClear.presentedByUser, null, "detail after clear: presentedByUser null");

          // 7. Boundary schema: non-boolean rejected.
          const bad = await patchReport(baseUrl, REPORT_A_ID, { presented: "yes" });
          assert.equal(bad.status, 400, "non-boolean presented → 400");

          console.log("authed presented-mark lifecycle PASSED");

          // 8. Anonymous: PATCH is authed-only; share payload never leaks the mark.
          currentUserId = null;
          const anonPatch = await patchReport(baseUrl, REPORT_A_ID, { presented: true });
          assert.equal(anonPatch.status, 401, "anonymous PATCH → 401");

          const share = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
          assert.equal(share.status, 200, "anonymous share fetch");
          const shareBody: any = await share.json();
          assert.equal(shareBody.report?.id, REPORT_B_ID, "share serves the presented final report");
          assert.ok(!("presentedAt" in shareBody.report), "share report block: no presentedAt key");
          assert.ok(!("presentedBy" in shareBody.report), "share report block: no presentedBy key");
          const shareText = JSON.stringify(shareBody);
          assert.ok(
            !shareText.toLowerCase().includes("presented"),
            "share payload contains NO presented key/value anywhere",
          );

          console.log("anonymous share exclusion PASSED");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "client_data_access",
          "reports",
          "report_sections",
          "report_section_history",
          "user_notifications",
          "system_settings",
          "ceo_pulses",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    // ── Phase 2: matrix exposure (public schema) ────────────────────────
    // The matrix route reads through the raw ambient `db` handle, which the
    // isolated-schema pin does not cover — so this phase seeds run-token-
    // suffixed PUBLIC rows and deletes them in finally (same pattern as
    // tests/hide-demo-accounts-contract.test.ts).
    const MTX_OPERATOR_ID = `${TAG}-mtx-operator`;
    const MTX_CLIENT_ID = `${TAG}-mtx-client`;
    const MTX_PRESENTED_ID = `${TAG}-mtx-presented`;
    const MTX_UNPRESENTED_ID = `${TAG}-mtx-unpresented`;
    try {
      await db.execute(sql`
        INSERT INTO users (id, role, email, first_name, last_name)
        VALUES (${MTX_OPERATOR_ID}, 'ceo', ${`${MTX_OPERATOR_ID}@example.com`}, 'Matrix', 'Operator')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
        VALUES (${MTX_CLIENT_ID}, ${`Matrix Coverage Law ${TAG}`}, ARRAY['gbp']::text[], ${MTX_OPERATOR_ID}, false)
      `);
      // One final+marked month and one final-but-unmarked month: the matrix
      // must expose presentedAt (non-null vs null) so cells can distinguish
      // delivery coverage at a glance.
      await db.execute(sql`
        INSERT INTO reports (id, client_id, report_month, status, presented_at, presented_by)
        VALUES (${MTX_PRESENTED_ID}, ${MTX_CLIENT_ID}, '2026-06', 'final', now(), ${MTX_OPERATOR_ID})
      `);
      await db.execute(sql`
        INSERT INTO reports (id, client_id, report_month, status)
        VALUES (${MTX_UNPRESENTED_ID}, ${MTX_CLIENT_ID}, '2026-05', 'final')
      `);
      __test_markUserReconciled(MTX_OPERATOR_ID, {
        id: MTX_OPERATOR_ID,
        email: `${MTX_OPERATOR_ID}@example.com`,
        firstName: "Matrix",
        lastName: "Operator",
        role: "ceo",
      });
      currentUserId = MTX_OPERATOR_ID;
      const { server, baseUrl } = await listen(buildApp());
      try {
        const matrix = await fetch(`${baseUrl}/api/reports/matrix`);
        assert.equal(matrix.status, 200, "GET matrix");
        const rows: any[] = await matrix.json();
        const row = rows.find((r) => r.clientId === MTX_CLIENT_ID);
        assert.ok(row, "matrix includes the seeded client row");
        const presentedCell = row.reports["2026-06"];
        assert.ok(presentedCell, "matrix cell for the presented month exists");
        assert.equal(presentedCell.id, MTX_PRESENTED_ID, "presented cell is the seeded report");
        ts(presentedCell.presentedAt, "matrix presented-cell presentedAt");
        const unpresentedCell = row.reports["2026-05"];
        assert.ok(unpresentedCell, "matrix cell for the unpresented month exists");
        assert.equal(
          unpresentedCell.presentedAt,
          null,
          "final-but-unpresented cell carries presentedAt: null (distinguishable at a glance)",
        );
        console.log("matrix exposure (public schema) PASSED");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      // Child rows first (reports FK → clients/users).
      await db.execute(sql`DELETE FROM reports WHERE client_id = ${MTX_CLIENT_ID}`).catch(() => undefined);
      await db.execute(sql`DELETE FROM clients WHERE id = ${MTX_CLIENT_ID}`).catch(() => undefined);
      await db.execute(sql`DELETE FROM users WHERE id = ${MTX_OPERATOR_ID}`).catch(() => undefined);
    }

    console.log("report-presented-tracking: PASSED");
  } finally {
    __test_resetReconciledUsers();
    await closeDbPools().catch(() => undefined);
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-presented-tracking: FAILED", err);
    process.exitCode = 1;
  });
