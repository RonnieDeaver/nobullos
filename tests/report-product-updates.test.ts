/* test-registration
{
  "name": "Report payloads — CEO Pulse 'Product updates' block: public-projection hygiene (exact public field set, internalNotes/draft/company-board never serialized), current+previous-quarter selection wiring, pulse-gated presence, share + demo routes (Task #4216)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4216: /api/share and /api/demo-report are unauthenticated client-facing surfaces that now embed roadmap data assembled live at fetch time. This is the ONE test proving the report path can never leak internal notes, unpublished drafts, or company-board items (exact key-set pinning on every embedded item + secret-note absence over the WHOLE payload), that the quarter-window selection is wired end-to-end (upcoming + completed, old completions excluded), and that pulse-less reports keep productUpdates=null. Real routes + per-run suffixed rows with finally cleanup; a handful of local fetches, seconds.",
  "tier": "small"
}
test-registration */
/**
 * Task #4216 — Report "Product updates" block: payload hygiene + wiring.
 *
 * The CEO Pulse slide of client reports now embeds current-quarter product
 * roadmap items, assembled at fetch time by buildReportResponse (share +
 * preview) and the demo builder via ONE helper chain:
 *   server/lib/publicRoadmap.ts (published-only public projection)
 *     → shared/roadmapProgress.ts selectReportProductUpdates (window rules).
 *
 * What this suite pins (the sibling of tests/roadmap-public-routes.test.ts,
 * which owns the same hygiene contract on /api/public/roadmap — deliberately
 * a separate file so that suite's import closure stays off reports.ts):
 *
 *   1. HYGIENE — every item embedded in a report payload has EXACTLY the
 *      public field set, and internal-note text, draft rows, and
 *      company-board rows appear nowhere in the ENTIRE response body.
 *   2. SELECTION WIRING — upcoming = current-quarter product items not yet
 *      shipped (kanban order); completed = shipped with a completion stamp
 *      in the current or previous quarter (newest first); older completions,
 *      null/future quarters excluded. Window boundary math itself is
 *      unit-tested with injected instants in tests/roadmap-progress.test.ts;
 *      here the windows derive from the real clock on both sides (seed +
 *      route), with a one-shot reseed if the wall clock crosses a quarter
 *      boundary between seeding and fetching (a sub-second window that
 *      exists four instants a year).
 *   3. PULSE GATE — a report that resolves no CEO Pulse carries
 *      productUpdates: null (the block belongs to that slide only).
 *   4. DEMO PARITY — /api/demo-report (its own inline builder) embeds the
 *      same block through the same helper.
 *
 * The preview route shares buildReportResponse with the share route, so the
 * share assertions cover it.
 *
 * DB: rows are per-run suffixed and deleted in `finally`; assertions on list
 * contents are SCOPED to this run's ids (never totals) so leftover rows from
 * a SIGKILL'd sibling suite cannot flip a verdict (memory:
 * shared-db-ambient-alert-scoping). The demoReportId system setting is
 * backed up and restored. undici's dispatcher is closed at exit; pool drain
 * is test-mode automatic in server/db.ts.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import { storage } from "../server/storage";
import {
  currentQuarterKey,
  previousQuarterKey,
  addQuarters,
  quarterBoundsUtc,
  quarterLabel,
} from "../shared/roadmapProgress";

const TAG = `task-4216-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const REPORT2_ID = `${TAG}-report2`;
const SHARE_TOKEN = `${TAG}-share`;
const SHARE_TOKEN2 = `${TAG}-share2`;
const PULSE_ID = `${TAG}-pulse`;
const DEPT_ID = `${TAG}-dept`;
const TYPE_ID = `${TAG}-type`;
const SECRET_NOTE = `internal-secret-${TAG}`;

const UP1 = `${TAG}-up1`;
const UP2 = `${TAG}-up2`;
const DONE_CUR = `${TAG}-done-cur`;
const DONE_PREV = `${TAG}-done-prev`;
const DONE_OLD = `${TAG}-done-old`;
const DRAFT_UP = `${TAG}-draft-up`;
const COMPANY_UP = `${TAG}-company-up`;
const COMPANY_DONE = `${TAG}-company-done`;
const LATER = `${TAG}-later`;
const FUTURE = `${TAG}-future`;
const ALL_INITIATIVES = [
  UP1, UP2, DONE_CUR, DONE_PREV, DONE_OLD, DRAFT_UP, COMPANY_UP, COMPANY_DONE, LATER, FUTURE,
];
const EXCLUDED = [DONE_OLD, DRAFT_UP, COMPANY_UP, COMPANY_DONE, LATER, FUTURE];

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM roadmap_initiatives WHERE id LIKE ${TAG + "%"}`).catch(() => 0);
  await db.execute(sql`DELETE FROM roadmap_types WHERE id = ${TYPE_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM roadmap_departments WHERE id = ${DEPT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM reports WHERE id LIKE ${TAG + "%"}`).catch(() => 0);
  await db.execute(sql`DELETE FROM ceo_pulses WHERE id = ${PULSE_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`).catch(() => 0);
}

async function seedBase(): Promise<void> {
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name)
    VALUES (${CLIENT_ID}, ${"Task4216 Firm " + TAG}, 'Task4216')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ceo_pulses (id, month_key, raw_content, ai_analysis, include_graphs, is_published)
    VALUES (
      ${PULSE_ID}, ${TAG + "-pulse-month"}, 'task-4216 pulse body',
      ${JSON.stringify({ headline: "Task 4216 headline", keyTakeaways: [], strategicImplications: [], charts: [] })}::jsonb,
      false, false
    )
    ON CONFLICT (id) DO NOTHING
  `);
  // Report 1 links the pulse; report 2 has no pulse (and its garbage month
  // key can never match a real pulse month), so its payload must carry
  // productUpdates: null.
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token, ceo_pulse_id)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${TAG + "-m1"}, 'final', ${SHARE_TOKEN}, ${PULSE_ID})
    ON CONFLICT (id) DO UPDATE SET status = 'final', ceo_pulse_id = EXCLUDED.ceo_pulse_id
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token, ceo_pulse_id)
    VALUES (${REPORT2_ID}, ${CLIENT_ID}, ${TAG + "-m2"}, 'final', ${SHARE_TOKEN2}, NULL)
    ON CONFLICT (id) DO UPDATE SET status = 'final', ceo_pulse_id = NULL
  `);
  await db.execute(sql`
    INSERT INTO roadmap_departments (id, name, slug, display_order)
    VALUES (${DEPT_ID}, ${"Task4216 Dept " + TAG}, ${TAG + "-dept"}, 0)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO roadmap_types (id, name, slug, display_order)
    VALUES (${TYPE_ID}, ${"Task4216 Type " + TAG}, ${TAG + "-type"}, 0)
    ON CONFLICT (id) DO NOTHING
  `);
}

/**
 * (Re)seed the quarter-sensitive initiative rows for the given current
 * quarter key. Upserts so the boundary-crossing reseed path can re-point
 * quarters/timestamps in place.
 */
async function seedInitiatives(curQ: string): Promise<void> {
  const prevQ = previousQuarterKey(curQ);
  const oldQ = addQuarters(curQ, -2);
  const nowIso = new Date().toISOString();
  // Mid-quarter completion stamps (start + 36h) keep clear of boundary
  // parsing concerns.
  const prevIso = new Date(quarterBoundsUtc(prevQ).start.getTime() + 36 * 3600 * 1000).toISOString();
  const oldIso = new Date(quarterBoundsUtc(oldQ).start.getTime() + 36 * 3600 * 1000).toISOString();
  const nextQ = addQuarters(curQ, 1);

  type Row = {
    id: string;
    title: string;
    board: string;
    status: string;
    rq: string | null;
    completedAt: string | null;
    published: boolean;
    notes: string | null;
    order: number;
  };
  const rows: Row[] = [
    { id: UP1, title: `Upcoming One ${TAG}`, board: "product", status: "planned", rq: curQ, completedAt: null, published: true, notes: null, order: 10 },
    { id: UP2, title: `Upcoming Two ${TAG}`, board: "product", status: "in_progress", rq: curQ, completedAt: null, published: true, notes: null, order: 20 },
    { id: DONE_CUR, title: `Done Current ${TAG}`, board: "product", status: "shipped", rq: curQ, completedAt: nowIso, published: true, notes: null, order: 30 },
    { id: DONE_PREV, title: `Done Previous ${TAG}`, board: "product", status: "shipped", rq: prevQ, completedAt: prevIso, published: true, notes: null, order: 40 },
    { id: DONE_OLD, title: `Done Old ${TAG}`, board: "product", status: "shipped", rq: oldQ, completedAt: oldIso, published: true, notes: null, order: 50 },
    { id: DRAFT_UP, title: `Draft Upcoming ${TAG}`, board: "product", status: "planned", rq: curQ, completedAt: null, published: false, notes: SECRET_NOTE, order: 60 },
    { id: COMPANY_UP, title: `Company Upcoming ${TAG}`, board: "company", status: "in_progress", rq: curQ, completedAt: null, published: true, notes: SECRET_NOTE, order: 70 },
    { id: COMPANY_DONE, title: `Company Done ${TAG}`, board: "company", status: "shipped", rq: curQ, completedAt: nowIso, published: true, notes: SECRET_NOTE, order: 80 },
    { id: LATER, title: `Later Item ${TAG}`, board: "product", status: "planned", rq: null, completedAt: null, published: true, notes: null, order: 90 },
    { id: FUTURE, title: `Future Item ${TAG}`, board: "product", status: "planned", rq: nextQ, completedAt: null, published: true, notes: null, order: 100 },
  ];
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO roadmap_initiatives
        (id, title, public_description, internal_notes, department_id, type_id,
         status, board, release_quarter, completed_at, display_order, published)
      VALUES
        (${r.id}, ${r.title}, ${"Public description for " + r.id}, ${r.notes},
         ${DEPT_ID}, ${TYPE_ID}, ${r.status}, ${r.board}, ${r.rq},
         ${r.completedAt}, ${r.order}, ${r.published})
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        board = EXCLUDED.board,
        release_quarter = EXCLUDED.release_quarter,
        completed_at = EXCLUDED.completed_at,
        display_order = EXCLUDED.display_order,
        published = EXCLUDED.published,
        internal_notes = EXCLUDED.internal_notes
    `);
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Anonymous public consumer — no auth (share + demo routes are public).
    // Clerk test seam (server/middlewares/requireAuth.ts): null is
    // explicit-unauthenticated (any authed route would 401).
    (req as any).__test_clerkUserId = null;
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

const PUBLIC_KEYS = [
  "id",
  "title",
  "description",
  "status",
  "timeframe",
  "board",
  "releaseQuarter",
  "completedAt",
  "displayOrder",
  "departmentSlug",
  "departmentName",
  "typeSlug",
  "typeName",
].sort();

/** Ids from a payload list that belong to THIS run (ambient-litter-proof). */
const taggedIds = (items: Array<{ id: string }> | undefined): string[] =>
  (items ?? []).map((i) => i.id).filter((id) => typeof id === "string" && id.startsWith(TAG));

async function run(): Promise<void> {
  await cleanup();
  await seedBase();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  const priorDemoSetting = (await storage.getSystemSetting("demoReportId"))?.value ?? null;

  try {
    // Seed + fetch under a stable quarter: if the wall clock crossed a
    // quarter boundary between seeding and the request (possible for a
    // sub-second window four times a year), reseed once against the new
    // quarter and refetch so both sides agree on the window.
    let curQ = "";
    let body: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      curQ = currentQuarterKey(new Date());
      await seedInitiatives(curQ);
      const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
      ok(r.status === 200, `GET /api/share/:token → 200 (got ${r.status})`);
      body = await r.json();
      if (currentQuarterKey(new Date()) === curQ) break;
    }

    // ── 1. Block present + window metadata ─────────────────────────────────
    const pu = body?.productUpdates;
    ok(
      Object.prototype.hasOwnProperty.call(body ?? {}, "productUpdates"),
      "share payload carries the productUpdates key",
    );
    ok(pu && typeof pu === "object", "productUpdates is an object for a pulse-linked report");
    ok(pu?.quarterKey === curQ, `quarterKey is the current quarter (${curQ}, got ${pu?.quarterKey})`);
    ok(
      pu?.quarterLabel === quarterLabel(curQ),
      `quarterLabel matches (${quarterLabel(curQ)}, got ${pu?.quarterLabel})`,
    );

    // ── 2. Selection wiring (scoped to this run's rows) ────────────────────
    ok(
      JSON.stringify(taggedIds(pu?.upcoming)) === JSON.stringify([UP1, UP2]),
      `upcoming = current-quarter unshipped product items in kanban order (got ${JSON.stringify(taggedIds(pu?.upcoming))})`,
    );
    ok(
      JSON.stringify(taggedIds(pu?.completed)) === JSON.stringify([DONE_CUR, DONE_PREV]),
      `completed = this + previous quarter, newest first (got ${JSON.stringify(taggedIds(pu?.completed))})`,
    );
    {
      const puText = JSON.stringify(pu);
      const leakedExcluded = EXCLUDED.filter((id) => puText.includes(id));
      ok(
        leakedExcluded.length === 0,
        `old/draft/company/later/future rows never appear in the block (leaked: ${JSON.stringify(leakedExcluded)})`,
      );
    }

    // ── 3. Hygiene — exact public field set on EVERY embedded item ─────────
    {
      const allItems = [...(pu?.upcoming ?? []), ...(pu?.completed ?? [])];
      ok(allItems.length > 0, "hygiene check has items to inspect");
      const keyProblems = allItems
        .map((i: any) => JSON.stringify(Object.keys(i).sort()))
        .filter((k: string) => k !== JSON.stringify(PUBLIC_KEYS));
      ok(
        keyProblems.length === 0,
        `every embedded item has EXACTLY the public field set (first offender: ${keyProblems[0] ?? "none"})`,
      );
      const up1 = (pu?.upcoming ?? []).find((i: any) => i.id === UP1);
      ok(
        up1?.timeframe === quarterLabel(curQ),
        `timeframe is DERIVED from the quarter label (got ${JSON.stringify(up1?.timeframe)})`,
      );
      const doneCur = (pu?.completed ?? []).find((i: any) => i.id === DONE_CUR);
      ok(
        typeof doneCur?.completedAt === "string" && !Number.isNaN(Date.parse(doneCur.completedAt)),
        `completedAt serializes as a parseable ISO string (got ${JSON.stringify(doneCur?.completedAt)})`,
      );
    }
    ok(
      !JSON.stringify(body).includes(SECRET_NOTE),
      "internal-note text appears NOWHERE in the entire share payload",
    );

    // ── 4. Pulse gate — report without a CEO Pulse ─────────────────────────
    {
      const r2 = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN2}`);
      ok(r2.status === 200, `GET /api/share/:token (no pulse) → 200 (got ${r2.status})`);
      const body2: any = await r2.json();
      ok(body2?.ceoPulse === null || body2?.ceoPulse === undefined, "no-pulse report resolves no ceoPulse");
      ok(
        Object.prototype.hasOwnProperty.call(body2 ?? {}, "productUpdates") &&
          body2?.productUpdates === null,
        `no-pulse report carries productUpdates: null (got ${JSON.stringify(body2?.productUpdates)})`,
      );
      ok(
        !JSON.stringify(body2).includes(SECRET_NOTE),
        "no-pulse payload carries no internal-note text either",
      );
    }

    // ── 5. Demo route parity (same helper, separate inline builder) ────────
    {
      await storage.setSystemSetting("demoReportId", REPORT_ID, "test");
      const rd = await fetch(`${baseUrl}/api/demo-report`);
      ok(rd.status === 200, `GET /api/demo-report → 200 (got ${rd.status})`);
      const demoBody: any = await rd.json();
      const dpu = demoBody?.productUpdates;
      ok(dpu && typeof dpu === "object", "demo payload embeds the productUpdates block");
      ok(
        JSON.stringify(taggedIds(dpu?.upcoming)) === JSON.stringify([UP1, UP2]),
        `demo upcoming matches the share selection (got ${JSON.stringify(taggedIds(dpu?.upcoming))})`,
      );
      ok(
        JSON.stringify(taggedIds(dpu?.completed)) === JSON.stringify([DONE_CUR, DONE_PREV]),
        `demo completed matches the share selection (got ${JSON.stringify(taggedIds(dpu?.completed))})`,
      );
      ok(
        !JSON.stringify(demoBody).includes(SECRET_NOTE),
        "internal-note text appears NOWHERE in the demo payload",
      );
    }
  } finally {
    // Restore the demo pointer exactly as found (delete the row if absent).
    try {
      if (priorDemoSetting !== null) {
        await storage.setSystemSetting("demoReportId", priorDemoSetting, "test");
      } else {
        await storage.setSystemSetting("demoReportId", "", "test");
        await db.execute(sql`DELETE FROM system_settings WHERE key = 'demoReportId'`).catch(() => 0);
      }
    } catch {
      // best-effort restore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Route tests that fetch a local express server can hang on exit via
    // undici's keep-alive sockets — close the global dispatcher.
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {
      // best-effort
    }
    await cleanup();
  }

  console.log(`\nreport-product-updates: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
