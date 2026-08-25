/* test-registration
{
  "name": "Report-quality finalize gate + demo Next 30 Days fill (Task #4227)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4227: a real finalized Jan-2026 report shipped degenerate AI Common Issues copy ('Issue: Being Bad') to a paying client, and /demo-report rendered 'No actions defined' in both Next 30 Days columns. This suite defends the server-side finalize confirm gate (degenerate copy / empty action plan → 422 until confirmReportQualityFinalize), the formatter's degenerate-AI-output degrade lane, and the demo endpoint's curated action fill. A drift here re-ships embarrassing copy to clients.",
  "tier": "small"
}
test-registration */
/**
 * Task #4227 — three layers of protection against embarrassing finalized
 * reports:
 *
 *   1. Unit: `findDegenerateCommonIssues` flags thin marker bodies
 *      ("Being Bad" / "Poor behavior") and thin unmarked prose, and passes
 *      healthy copy + empty input.
 *   2. Formatter: a degenerate AI generation for substantial raw input
 *      degrades to the deterministic fallback (reason "ai_degenerate").
 *   3. Route: PATCH /api/reports/:id with `status: "final"` returns 422
 *      `report_quality_confirm_required` (naming the degenerate sections
 *      and the empty Next 30 Days columns) until the request carries
 *      `confirmReportQualityFinalize: true`; a healthy report finalizes
 *      plainly. GET /api/demo-report serves curated actions in any empty
 *      Next 30 Days column.
 *
 * Harness mirrors tests/webhook-broken-source-import-e2e.test.ts: express
 * app + registerReportRoutes with an injected fake session, OpenAI
 * singleton mocked (no network), runInIsolatedSchema with
 * pinGetDbForCrossAsync.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

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
import { openai } from "../server/routes/middleware";
import {
  findDegenerateCommonIssues,
  isDegenerateCommonIssues,
  formatCommonIssuesContent,
  normalizeCommonIssuesStructure,
  finalizeCommonIssuesForStorage,
} from "../server/services/commonIssuesFormatter";
// Task #4254 — curated copy library must remain a safe replacement for
// thin copy (passes the quality floor, canonical structure).
import {
  COMMON_ISSUES_COPY_LIBRARY,
  getCuratedIssueBlocks,
  renderCuratedIssueBlocks,
} from "../shared/commonIssuesCopyLibrary";
import { runInIsolatedSchema, sql } from "./db-sandbox";

const TAG = `task-4227-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const HEALTHY_REPORT_ID = `${TAG}-healthy-report`;

const DEGENERATE_COPY = `🔴 **Issue:** Being Bad
↳ **Impact:** Poor behavior
> ➡️ **Strategic Fix:** Be better`;

const HEALTHY_COPY = `🔴 **Issue:** Intake staff are not asking qualifying questions on inbound calls
↳ **Impact:** Unqualified leads consume consult slots and drag conversion down
> ➡️ **Strategic Fix:** Roll out the three-question qualification script this week`;

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiReturns(content: string): void {
  (openai.chat.completions as any).create = async () => ({
    choices: [{ finish_reason: "stop", message: { content } }],
  });
}

function restoreOpenAi(): void {
  (openai.chat.completions as any).create = ORIGINAL_CREATE;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = OWNER_ID;
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readReportStatus(isoDb: any, reportId: string): Promise<string | undefined> {
  const rows: any = await isoDb.execute(sql`
    SELECT status FROM reports WHERE id = ${reportId} LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.status;
}

function unitTests(): void {
  // Degenerate marker bodies ("Being Bad" = 2 words / 9 chars).
  const problems = findDegenerateCommonIssues(DEGENERATE_COPY);
  assert.ok(
    problems.some((p) => p.reason === "thin_issue" && p.snippet === "Being Bad"),
    `flags the thin Issue body, got ${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => p.reason === "thin_impact" && p.snippet === "Poor behavior"),
    "flags the thin Impact body",
  );

  // Healthy copy passes.
  assert.deepEqual(findDegenerateCommonIssues(HEALTHY_COPY), [], "healthy copy passes");

  // Thin unmarked prose is degenerate; substantial prose passes.
  assert.ok(isDegenerateCommonIssues("Bad calls."), "thin unmarked prose flagged");
  assert.equal(
    isDegenerateCommonIssues(
      "Intake staff routinely miss follow-up calls within the first hour, costing consults.",
    ),
    false,
    "substantial unmarked prose passes",
  );

  // Empty / non-string input is NOT degenerate (renders the neutral
  // "No issues identified" — nothing embarrassing).
  assert.equal(isDegenerateCommonIssues(""), false, "empty passes");
  assert.equal(isDegenerateCommonIssues(undefined), false, "undefined passes");
  assert.equal(isDegenerateCommonIssues(null), false, "null passes");

  console.log("unit: findDegenerateCommonIssues PASSED");
}

// Task #4254 — the curated Common Issues copy library must always be a safe
// one-click replacement for thin copy: every block (alone and combined per
// section) renders to canonical, well-formed markdown that passes the #4227
// quality floor and stores cleanly through the normal section save path.
function curatedCopyLibraryTests(): void {
  assert.ok(
    COMMON_ISSUES_COPY_LIBRARY.length >= 6,
    "library carries a meaningful set of curated blocks",
  );
  const ids = new Set(COMMON_ISSUES_COPY_LIBRARY.map((b) => b.id));
  assert.equal(ids.size, COMMON_ISSUES_COPY_LIBRARY.length, "block ids are unique");

  for (const section of ["intake", "sales"] as const) {
    const blocks = getCuratedIssueBlocks(section);
    assert.ok(blocks.length >= 3, `${section} has at least 3 curated blocks`);
    assert.ok(
      blocks.every((b) => b.section === section),
      `${section} filter returns only ${section} blocks`,
    );

    // Every block ALONE passes the quality floor…
    for (const block of blocks) {
      const rendered = renderCuratedIssueBlocks([block]);
      assert.deepEqual(
        findDegenerateCommonIssues(rendered),
        [],
        `curated block ${block.id} passes findDegenerateCommonIssues`,
      );
      // …and is already well-formed canonical structure (normalize = no-op,
      // storage finalizer stamps it clean).
      assert.equal(
        normalizeCommonIssuesStructure(rendered),
        rendered,
        `curated block ${block.id} is already canonically structured`,
      );
      const finalized = finalizeCommonIssuesForStorage(rendered);
      assert.equal(finalized.text, rendered, `${block.id} stores byte-identical`);
      assert.equal(finalized.stampable, true, `${block.id} is stampable`);
    }

    // …and the full section selection combined passes too (divider joins).
    const combined = renderCuratedIssueBlocks(blocks);
    assert.deepEqual(
      findDegenerateCommonIssues(combined),
      [],
      `combined ${section} selection passes the quality floor`,
    );
    assert.equal(
      normalizeCommonIssuesStructure(combined),
      combined,
      `combined ${section} selection is canonically structured`,
    );
    assert.ok(!combined.endsWith("---"), "no trailing divider");
  }

  console.log("unit: curated copy library PASSED");
}

async function formatterDegradeTest(): Promise<void> {
  const richRaw =
    "Issue 1: Intake staff are not asking qualifying questions on inbound calls. " +
    "Impact: Unqualified leads consume consult slots and drag conversion down. " +
    "Strategic Fix: Roll out the three-question qualification script this week.";

  // AI returns degenerate copy for substantial input → deterministic
  // fallback wins, flagged degraded with reason ai_degenerate.
  mockOpenAiReturns(DEGENERATE_COPY);
  try {
    const result = await formatCommonIssuesContent(richRaw, "intake");
    assert.equal(result.degraded, true, "degenerate AI output degrades");
    assert.equal(result.reason, "ai_degenerate", "degrade reason is ai_degenerate");
    assert.ok(
      result.formatted.includes("qualifying questions"),
      "fallback preserves the raw substance",
    );
    assert.equal(
      isDegenerateCommonIssues(result.formatted),
      false,
      "fallback output itself passes the floor",
    );

    // Healthy AI output is kept untouched.
    mockOpenAiReturns(HEALTHY_COPY);
    const healthy = await formatCommonIssuesContent(richRaw, "intake");
    assert.equal(healthy.degraded, false, "healthy AI output is not degraded");
    assert.equal(healthy.formatted, HEALTHY_COPY, "healthy AI output kept");
  } finally {
    restoreOpenAi();
  }
  console.log("formatter: ai_degenerate degrade PASSED");
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OWNER_ID}, 'ceo', ${`${OWNER_ID}@example.com`}, 'Quality', 'Gate')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Seeded in the isolated (uncommitted) schema, invisible to requireAuth's
  // ambient public-schema lookup. Pre-register so the real middleware admits
  // the owner without JIT-provisioning a public row (surprise default role).
  __test_markUserReconciled(OWNER_ID, {
    id: OWNER_ID,
    role: "ceo",
    email: `${OWNER_ID}@example.com`,
    firstName: "Quality",
    lastName: "Gate",
  });
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Quality Gate Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID}, true)
    ON CONFLICT (id) DO NOTHING
  `);
  // Command panel reviewed this month → the unrelated monthly-review gate
  // passes and this suite exercises ONLY the quality gate.
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, last_reviewed_at)
    VALUES (${CLIENT_ID}, now())
  `);

  // Poisoned report: degenerate intake Common Issues + empty next actions.
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-01', 'draft')
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-intake`}, ${REPORT_ID}, 'intake',
            ${JSON.stringify({ totalConsults: 10, commonIssues: DEGENERATE_COPY })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-sales`}, ${REPORT_ID}, 'sales',
            ${JSON.stringify({ totalCases: 3, commonIssues: "" })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-actions`}, ${REPORT_ID}, 'nextActions', ${JSON.stringify({})}::jsonb)
  `);

  // Healthy report: real copy + actions in both columns.
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${HEALTHY_REPORT_ID}, ${CLIENT_ID}, '2026-02', 'draft')
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-h-intake`}, ${HEALTHY_REPORT_ID}, 'intake',
            ${JSON.stringify({ totalConsults: 12, commonIssues: HEALTHY_COPY })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-h-actions`}, ${HEALTHY_REPORT_ID}, 'nextActions',
            ${JSON.stringify({
              ours: [{ action: "Launch review campaign across offices", why: "velocity" }],
              theirs: [{ action: "Send signed-case list by the 5th", why: "accuracy" }],
            })}::jsonb)
  `);
}

async function routeTests(isoDb: any, baseUrl: string): Promise<void> {
  // 1. Finalize WITHOUT the confirm flag → 422 naming both gaps.
  const fin1 = await fetch(`${baseUrl}/api/reports/${REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "final" }),
  });
  const fin1Body: any = await fin1.json().catch(() => ({}));
  assert.equal(
    fin1.status,
    422,
    `finalize without confirm: expected 422, got ${fin1.status} body=${JSON.stringify(fin1Body)}`,
  );
  assert.equal(fin1Body.error, "report_quality_confirm_required", "quality gate error code");
  assert.deepEqual(
    (fin1Body.degenerateCommonIssues ?? []).map((d: any) => d.section),
    ["intake"],
    "names the degenerate intake copy (empty sales copy is NOT flagged)",
  );
  assert.ok(
    fin1Body.degenerateCommonIssues[0].problems.some((p: any) => p.snippet === "Being Bad"),
    "carries the offending snippet for the operator dialog",
  );
  assert.deepEqual(
    (fin1Body.emptyNextActionsColumns ?? []).slice().sort(),
    ["ours", "theirs"],
    "names both empty Next 30 Days columns",
  );
  assert.equal(await readReportStatus(isoDb, REPORT_ID), "draft", "blocked finalize stays draft");

  // 2. Explicit confirmation → finalizes; the flag is request-only, never
  //    persisted (updateReportSchema strips it — a 400 here would mean it
  //    leaked into validation).
  const fin2 = await fetch(`${baseUrl}/api/reports/${REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "final", confirmReportQualityFinalize: true }),
  });
  const fin2Body: any = await fin2.json().catch(() => ({}));
  assert.equal(
    fin2.status,
    200,
    `confirmed finalize: expected 200, got ${fin2.status} body=${JSON.stringify(fin2Body)}`,
  );
  assert.equal(await readReportStatus(isoDb, REPORT_ID), "final", "confirmed finalize lands");

  // 3. Healthy report finalizes plainly — no confirm needed.
  const fin3 = await fetch(`${baseUrl}/api/reports/${HEALTHY_REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "final" }),
  });
  const fin3Body: any = await fin3.json().catch(() => ({}));
  assert.equal(
    fin3.status,
    200,
    `healthy finalize: expected 200, got ${fin3.status} body=${JSON.stringify(fin3Body)}`,
  );

  // 4. Non-final PATCHes never hit the gate (draft saves stay friction-free).
  const draftPatch = await fetch(`${baseUrl}/api/reports/${REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hideLeadQuality: true }),
  });
  assert.equal(draftPatch.status, 200, "non-final PATCH bypasses the gate");

  console.log("route: finalize quality gate PASSED");
}

async function demoReportTest(baseUrl: string): Promise<void> {
  // The seeded client is is_demo=true; its poisoned report (2026-01, empty
  // nextActions) is older than the healthy one, so pin it explicitly as the
  // configured demo report via the system setting the endpoint reads first.
  // Instead of touching shared settings (cache pinning hazards), rely on the
  // fallback lane: it picks the NEWEST demo-client report (2026-02, healthy
  // actions). So to exercise the fill we blank the healthy report's actions
  // via the payload check on the POISONED report id being served is not
  // guaranteed — assert the invariant that matters: BOTH columns of the
  // served nextActions section are non-empty with real action strings.
  const res = await fetch(`${baseUrl}/api/demo-report`);
  const body: any = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `demo-report: expected 200, got ${res.status}`);
  const actions = (body.sections ?? []).find((s: any) => s.sectionKey === "nextActions");
  assert.ok(actions, "demo report serves a nextActions section");
  for (const col of ["ours", "theirs"] as const) {
    const list = actions.data?.[col];
    assert.ok(Array.isArray(list) && list.length > 0, `demo ${col} column is non-empty`);
    for (const item of list) {
      assert.ok(
        typeof item.action === "string" && item.action.trim().length > 0 &&
          typeof item.why === "string" && item.why.trim().length > 0,
        `demo ${col} entries carry realistic action + why`,
      );
    }
  }
  console.log("route: demo-report Next 30 Days fill PASSED");
}

async function run(): Promise<void> {
  try {
    unitTests();
    curatedCopyLibraryTests();
    await formatterDegradeTest();

    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        const app = buildApp();
        const { server, baseUrl } = await listen(app);
        try {
          await routeTests(isoDb, baseUrl);

          // Blank the healthy report's actions so the demo endpoint's
          // newest-report fallback serves a report with EMPTY stored columns
          // — the exact "No actions defined" state prospects used to see.
          await isoDb.execute(sql`
            UPDATE report_sections SET data = '{}'::jsonb
            WHERE report_id = ${HEALTHY_REPORT_ID} AND section_key = 'nextActions'
          `);
          await demoReportTest(baseUrl);
        } finally {
          await closeServer(server);
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

    console.log("report-finalize-quality-gate: PASSED");
  } finally {
    __test_resetReconciledUsers();
    restoreOpenAi();
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-finalize-quality-gate: FAILED", err);
    process.exitCode = 1;
  });
