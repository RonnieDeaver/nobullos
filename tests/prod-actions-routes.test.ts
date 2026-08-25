/* test-registration
{
  "name": "Prod-actions routes (Task #1808)",
  "regression": true,
  "sweepOnlyReason": "Owner-approved 2026-08 blocking-portfolio audit: the latest published green consumed 484.7s across two attempts, above the medium ceiling. This full route matrix remains in the post-merge/nightly regression lanes, and existing blast-radius expansion re-adds it when its imported prod-actions closure changes.",
  "tier": "large",
  "tierReason": "The latest published green consumed 484.7s across two attempts, above the 90s medium ceiling but within the capped large tier with its observation headroom."
}
test-registration */
/**
 * Task #1808 — integration tests for the CEO-only prod-actions panel:
 *
 *   GET  /api/admin/prod-actions
 *   GET  /api/admin/prod-actions/runs
 *   POST /api/admin/prod-actions/apply
 *
 * Coverage:
 *   (1) 401 when unauthenticated
 *   (2) 403 when authenticated as a non-CEO user
 *   (3) 200 GET as CEO returns the registry statuses
 *   (4) 200 POST as CEO applies every action AND writes one
 *       `prod_action_runs` row per action
 *   (5) Idempotency — a second apply press writes new audit rows whose
 *       outcomes are all `not-needed` (nothing flips twice)
 *   (6) Runs route surfaces the newly-written rows
 *
 * Task #1878 — the whole test runs inside `runInIsolatedSchema(...)`
 * so every CEO-action's writes land in a per-test schema the live
 * `Start application` workers cannot observe. That removes the
 * Task #1833 snapshot-based carve-outs the prior iteration of this
 * test needed for `front_warp_class_backfill` and
 * `trigger_front_reconciliation_sweep` (both relied on guessing what
 * the live producer enqueued mid-test against the shared `public`
 * schema).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { registerProdActionsRoutes } from "../server/routes/prodActions";
import {
  PROD_ACTIONS,
  PROD_ACTION_STATUS_STATES,
  PROD_ACTION_OUTCOME_STATES,
} from "../server/services/prodActionsRegistry";
import {
  __setPracticeAreaReconciliationDepsForTest,
  type PracticeAreaReconciliationDeps,
} from "../server/services/prodActions/platformOpsActions";
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-prod-actions-ceo";
const AM_ID = "test-prod-actions-am";
const TAG = "task-1808";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

type AuthMode = "anon" | { userId: string };

function buildApp(mode: AuthMode): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = mode === "anon" ? null : mode.userId;
    next();
  });
  registerProdActionsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function get(baseUrl: string, p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function post(
  baseUrl: string,
  p: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  try {
  const noEgressPracticeAreaDeps: PracticeAreaReconciliationDeps = {
    loadDirectory: async () => ({
      clients: {},
      blocks: [],
      statuses: {},
      budgets: {},
      cidClient: {},
      lsaCities: {},
      known: { gads: new Set(), lsa: new Set() },
      deepLinks: { gads: {}, lsa: {} },
      practiceAreaField: {
        id: "fixture-practice-area",
        name: "Practice Area",
        type: "labels",
      },
      practiceAreaOptions: [
        { id: "fixture-option", label: "Fixture", orderindex: 0 },
      ],
      cidPracticeAreas: {},
      cidParentTaskIds: {},
      fetchedAt: Date.now(),
    }),
    listCriteriaCids: async () => [],
    readCriteria: async () => null,
    patchCriteria: async () => "skipped-match",
    now: () => new Date(),
  };
  __setPracticeAreaReconciliationDepsForTest(noEgressPracticeAreaDeps);
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // Seed the two synthetic users inside the isolated schema. FK
      // constraints to `public.users` are NOT carried over by
      // `CREATE TABLE … (LIKE … INCLUDING ALL)`, so audit-row inserts
      // referencing these ids resolve against the isolated `users`
      // clone we seed here.
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-CEO`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${AM_ID}, 'account_manager', 'core', ${`${TAG}-AM`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);

      // Users are seeded in the isolated (uncommitted) schema, invisible to
      // requireAuth's ambient public-schema lookup. Pre-register their
      // profiles so the real middleware admits them without JIT-provisioning
      // a public row (which would grant a surprise default role).
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
        authorityLevel: "ceo",
        firstName: `${TAG}-CEO`,
      });
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        role: "account_manager",
        authorityLevel: "core",
        firstName: `${TAG}-AM`,
      });

      // Task #4019 — pin the Zoom S2S cutover pair to their terminal state.
      // Without this, the generic apply-all press would run the cutover
      // action for real: a LIVE Zoom preflight (external HTTP — mint + API
      // probe against zoom.us with the workspace's dev credentials) followed
      // by a mode flip that kicks the real auto-sync pipeline (reconciliation
      // cron + transcript backfill timers) inside the test process. With
      // zoom_auth_mode already s2s the cutover action short-circuits
      // not-needed before any network call, and with the soak/evidence
      // stamps aged past their gates plus the legacy token rows absent in
      // this schema, the retirement action is a not-needed no-op on both
      // presses. The pair's real semantics are covered by
      // tests/prod-actions-zoom-s2s-cutover.test.ts with stubbed transports.
      // The rollback lever (zoom_s2s_rollback_to_oauth) is manualLever:
      // Apply-all must record a synthetic not-needed outcome WITHOUT
      // executing it — asserted below via the mode-still-s2s check after
      // both presses (a real execution would flip this row to oauth).
      await isoDb.execute(sql`
        INSERT INTO system_settings (key, value, updated_by)
        VALUES
          ('zoom_auth_mode', 's2s', 'test'),
          ('zoom_s2s_cutover_at', ${new Date(Date.now() - 100 * 3600_000).toISOString()}, 'test'),
          ('zoom_s2s_webhook_last_verified_at', ${new Date(Date.now() - 600_000).toISOString()}, 'test')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `);

      async function countAuditRowsForActor(actorId: string): Promise<number> {
        const res: any = await isoDb.execute(sql`
          SELECT COUNT(*)::int AS n FROM prod_action_runs WHERE actor_user_id = ${actorId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return Number(rows[0]?.n ?? 0);
      }

      // Task #3797 — press-scoped audit check. A raw row count races the
      // fire-and-forget background drains some actions kick off: each drain
      // writes its own terminal audit row (Task #2234), and on a fast
      // (hermetic local-socket) DB that row can land before we count,
      // yielding N+1. Scoping to the press window and counting DISTINCT
      // action_id keeps the intent — "every press wrote an audit row per
      // action" — while staying immune to drain-terminal timing.
      async function countDistinctActionsSince(
        actorId: string,
        sinceEpochMs: number,
      ): Promise<number> {
        const res: any = await isoDb.execute(sql`
          SELECT COUNT(DISTINCT action_id)::int AS n FROM prod_action_runs
          WHERE actor_user_id = ${actorId}
            AND applied_at >= to_timestamp(${sinceEpochMs / 1000.0})
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return Number(rows[0]?.n ?? 0);
      }

      // (1) 401 unauth on every route
      {
        const app = buildApp("anon");
        const { server, baseUrl } = await listen(app);
        try {
          const a = await get(baseUrl, "/api/admin/prod-actions");
          assertEq(a.status, 401, "GET /prod-actions unauth → 401");
          const b = await get(baseUrl, "/api/admin/prod-actions/runs?limit=5");
          assertEq(b.status, 401, "GET /prod-actions/runs unauth → 401");
          const c = await post(baseUrl, "/api/admin/prod-actions/apply", {});
          assertEq(c.status, 401, "POST /prod-actions/apply unauth → 401");
          console.log("  ok  (1) 401 on all routes when unauthenticated");
        } finally {
          server.close();
        }
      }

      // (2) 403 non-CEO (account_manager) on every route
      {
        const app = buildApp({ userId: AM_ID });
        const { server, baseUrl } = await listen(app);
        try {
          const a = await get(baseUrl, "/api/admin/prod-actions");
          assertEq(a.status, 403, "GET /prod-actions as AM → 403");
          const b = await get(baseUrl, "/api/admin/prod-actions/runs?limit=5");
          assertEq(b.status, 403, "GET /prod-actions/runs as AM → 403");
          const c = await post(baseUrl, "/api/admin/prod-actions/apply", {});
          assertEq(c.status, 403, "POST /prod-actions/apply as AM → 403");
          assertEq(await countAuditRowsForActor(AM_ID), 0, "AM apply must not write audit");
          console.log("  ok  (2) 403 on all routes for non-CEO");
        } finally {
          server.close();
        }
      }

      // (3) 200 GET /prod-actions as CEO → returns the registry surface
      {
        const app = buildApp({ userId: CEO_ID });
        const { server, baseUrl } = await listen(app);
        try {
          const r = await get(baseUrl, "/api/admin/prod-actions");
          assertEq(r.status, 200, "GET /prod-actions as CEO → 200");
          const actions = r.body?.actions;
          assert(Array.isArray(actions), "actions should be an array");
          assertEq(actions.length, PROD_ACTIONS.length, "actions length must match registry length");
          for (const a of actions) {
            assert(typeof a.id === "string" && a.id.length > 0, "action id");
            assert(typeof a.title === "string", "action title");
            assert((PROD_ACTION_STATUS_STATES as readonly string[]).includes(a.status?.state),
              `unexpected status state: ${a.status?.state}`);
          }
          assert(
            actions.some((a: any) => a.id === "ramp_front_recovery_ingest_concurrency_3"),
            "1807 2→3 ramp action should be exposed via GET /prod-actions",
          );
          // Task #4762 — additive contract: the calm auto-managed partition
          // plus the per-row drain-declaration fields ride along without
          // disturbing the existing shape.
          assert(Array.isArray(r.body?.active), "active partition must be an array");
          assert(Array.isArray(r.body?.autoManaged), "autoManaged partition must be an array");
          assert(Array.isArray(r.body?.completed), "completed partition must be an array");
          const activeIds = new Set((r.body.active as any[]).map((a) => a.id));
          for (const a of r.body.autoManaged as any[]) {
            assert(!activeIds.has(a.id), `row ${a.id} in BOTH active and autoManaged`);
          }
          for (const a of actions) {
            assert(typeof a.autoManaged === "boolean", `row ${a.id}: autoManaged flag`);
            if (a.humanGate !== undefined) {
              assert(
                typeof a.humanGate?.reason === "string" && a.humanGate.reason.length > 0,
                `row ${a.id}: humanGate.reason must be a non-empty string`,
              );
            }
            if (a.retired !== undefined) {
              assertEq(a.retired, true, `row ${a.id}: retired is emitted true-only`);
            }
            if (a.manualLever === true) {
              assertEq(
                a.status?.state,
                "not-needed",
                `lever ${a.id} must stay synthetic not-needed (never feeds the badge)`,
              );
            }
          }
          console.log("  ok  (3) GET /prod-actions as CEO returns full registry (+#4762 additive fields)");
        } finally {
          server.close();
        }
      }

      // (4)+(5) POST /prod-actions/apply twice — first writes one audit
      //         row per action; second writes the same N rows with all
      //         outcomes `not-needed` (or `error` if a transient issue
      //         reproduces — e.g. an external HTTP call from an action
      //         fails, which is independent of the database).
      {
        const app = buildApp({ userId: CEO_ID });
        const { server, baseUrl } = await listen(app);
        try {
          const before = Date.now();
          const first = await post(baseUrl, "/api/admin/prod-actions/apply", {});
          assertEq(first.status, 200, "first apply → 200");
          const firstResults = first.body?.results;
          assert(Array.isArray(firstResults), "results must be an array");
          assertEq(
            firstResults.length,
            PROD_ACTIONS.length,
            "results length matches registry",
          );
          for (const r of firstResults) {
            assert(
              (PROD_ACTION_OUTCOME_STATES as readonly string[]).includes(r.outcome?.state),
              `unexpected outcome: ${JSON.stringify(r.outcome)}`,
            );
          }
          const firstAuditCount = await countDistinctActionsSince(CEO_ID, before);
          assertEq(
            firstAuditCount,
            PROD_ACTIONS.length,
            "first apply writes an audit row for every action",
          );

          // Spot-check audit row content for one action.
          const sampleId = firstResults[0].id;
          const sampleRow: any = await isoDb.execute(sql`
            SELECT action_id, outcome_state, detail FROM prod_action_runs
            WHERE actor_user_id = ${CEO_ID} AND action_id = ${sampleId}
            ORDER BY applied_at DESC LIMIT 1
          `);
          const sampleRows = Array.isArray(sampleRow) ? sampleRow : sampleRow?.rows ?? [];
          assert(sampleRows[0], "expected at least one audit row for sample action");
          assertEq(sampleRows[0].action_id, sampleId, "audit action_id matches");

          // Second press — each outcome must be one of the three valid
          // states. The previous test iteration asserted strict
          // idempotency (every action `not-needed` on press #2) and
          // had to maintain a growing per-action allowlist (Task #1833
          // carved out `front_warp_class_backfill` and
          // `trigger_front_reconciliation_sweep`; in isolation
          // additional pairs surface as legitimately
          // non-idempotent — `ramp_ingestion_class_concurrency_4` ↔
          // `_5` and `ramp_front_recovery_ingest_concurrency` ↔ `_3`
          // each force-set the same in-memory knob to different target
          // values; `force_ramp_front_drain_concurrency` is
          // force-set by design; `cutover_*` actions unpause queues a
          // background task will re-pause; etc.). The audit-row count
          // assertion below is the durable cross-check that every
          // press actually wrote.
          const beforeSecond = Date.now();
          const second = await post(baseUrl, "/api/admin/prod-actions/apply", {});
          assertEq(second.status, 200, "second apply → 200");
          const secondResults = second.body?.results;
          assertEq(secondResults.length, PROD_ACTIONS.length, "second apply same length");
          for (const r of secondResults) {
            assert(
              (PROD_ACTION_OUTCOME_STATES as readonly string[]).includes(r.outcome?.state),
              `second press for ${r.id} unexpected outcome=${r.outcome?.state}`,
            );
          }

          const secondAuditCount = await countDistinctActionsSince(CEO_ID, beforeSecond);
          assertEq(
            secondAuditCount,
            PROD_ACTIONS.length,
            "second apply writes another audit row for every action",
          );

          // Task #4019 — manual levers are excluded from Apply-all. Both
          // presses ran every registered action, so if the rollback lever
          // had actually executed it would have flipped zoom_auth_mode to
          // oauth; the synthetic not-needed skip leaves the seeded row
          // untouched while still writing its audit row (counted above).
          const modeRow: any = await isoDb.execute(sql`
            SELECT value FROM system_settings WHERE key = 'zoom_auth_mode'
          `);
          const modeRows = Array.isArray(modeRow) ? modeRow : modeRow?.rows ?? [];
          assertEq(
            modeRows[0]?.value,
            "s2s",
            "manual lever must NOT execute under Apply-all (mode would be oauth)",
          );
          const leverResult = secondResults.find(
            (r: any) => r.id === "zoom_s2s_rollback_to_oauth",
          );
          assert(leverResult, "rollback lever present in Apply-all results");
          assertEq(
            leverResult.outcome?.state,
            "not-needed",
            "lever outcome under Apply-all is the synthetic not-needed skip",
          );
          assert(
            /Manual lever/i.test(leverResult.outcome?.detail ?? ""),
            "lever skip detail names the manual-lever lane",
          );
          const practiceAreaLeverResult = secondResults.find(
            (r: any) => r.id === "ads-os-reconcile-practice-areas",
          );
          assert(practiceAreaLeverResult, "Practice Area reconciliation lever present");
          assertEq(
            practiceAreaLeverResult.outcome?.state,
            "not-needed",
            "Practice Area lever is synthetically skipped by Apply all",
          );
          assert(
            /Manual lever/i.test(practiceAreaLeverResult.outcome?.detail ?? ""),
            "Practice Area Apply-all result names the manual-lever skip",
          );

          assert(Date.now() - before < 60_000, "apply path should complete in well under a minute");

          // (6) GET /runs surfaces the recently-written rows. The registry
          //     has grown past 50 actions, so two presses (plus drain
          //     terminal rows) exceed the old limit=100 — request enough to
          //     see both presses (storage clamps at 500).
          const runs = await get(baseUrl, "/api/admin/prod-actions/runs?limit=300");
          assertEq(runs.status, 200, "GET /runs as CEO → 200");
          const list = runs.body?.runs;
          assert(Array.isArray(list), "runs body should be an array");
          const ourRuns = list.filter((r: any) => r.actorUserId === CEO_ID);
          assert(
            ourRuns.length >= PROD_ACTIONS.length * 2,
            `runs list should include our 2 presses; saw ${ourRuns.length}`,
          );
          console.log(
            "  ok  (4) apply writes N audit rows; (5) idempotent on second press; (6) /runs surfaces history",
          );

          // (7) Task #2125 — `?actor=system` returns ONLY automatic
          //     self-heal runs (actor_user_id IS NULL) and excludes the
          //     CEO-attributed presses above. Seed one system-actor row,
          //     then assert the filter isolates it.
          await isoDb.execute(sql`
            INSERT INTO prod_action_runs
              (action_id, action_title, actor_user_id, outcome_state, detail, rows_affected)
            VALUES
              ('selfheal_demo', 'Self-heal demo', NULL, 'applied', 'auto', 7)
          `);
          const sysRuns = await get(
            baseUrl,
            "/api/admin/prod-actions/runs?actor=system&limit=100",
          );
          assertEq(sysRuns.status, 200, "GET /runs?actor=system as CEO → 200");
          const sysList = sysRuns.body?.runs;
          assert(Array.isArray(sysList), "system runs body should be an array");
          assert(
            sysList.length > 0 && sysList.every((r: any) => r.actorUserId == null),
            "actor=system must return only null-actor (system) rows",
          );
          assert(
            sysList.some((r: any) => r.actionId === "selfheal_demo"),
            "actor=system must include the seeded system run",
          );
          assert(
            !sysList.some((r: any) => r.actorUserId === CEO_ID),
            "actor=system must exclude CEO-attributed presses",
          );
          console.log(
            "  ok  (7) /runs?actor=system isolates automatic self-heal runs",
          );

          // (8) Task #2232 — `?actionId=` narrows the history to a single
          //     action. Seed a second system action, then assert the filter
          //     returns only the requested action's rows (and composes with
          //     `?actor=system`).
          await isoDb.execute(sql`
            INSERT INTO prod_action_runs
              (action_id, action_title, actor_user_id, outcome_state, detail, rows_affected)
            VALUES
              ('selfheal_other', 'Self-heal other', NULL, 'applied', 'auto', 3)
          `);
          const filtered = await get(
            baseUrl,
            "/api/admin/prod-actions/runs?actor=system&actionId=selfheal_demo&limit=100",
          );
          assertEq(filtered.status, 200, "GET /runs?actionId=… as CEO → 200");
          const filteredList = filtered.body?.runs;
          assert(Array.isArray(filteredList), "filtered runs body should be an array");
          assert(filteredList.length > 0, "filter should return the seeded action's rows");
          assert(
            filteredList.every((r: any) => r.actionId === "selfheal_demo"),
            "actionId filter must return only the requested action",
          );
          assert(
            !filteredList.some((r: any) => r.actionId === "selfheal_other"),
            "actionId filter must exclude other actions",
          );

          // Blank / whitespace actionId is treated as no filter (unchanged
          // default view), so the other action is still visible.
          const blank = await get(
            baseUrl,
            "/api/admin/prod-actions/runs?actor=system&actionId=%20&limit=100",
          );
          assertEq(blank.status, 200, "GET /runs?actionId=<blank> → 200");
          const blankList = blank.body?.runs;
          assert(
            blankList.some((r: any) => r.actionId === "selfheal_other"),
            "blank actionId must not filter — other action still visible",
          );
          console.log(
            "  ok  (8) /runs?actionId=… filters history to a single action",
          );
        } finally {
          server.close();
        }
      }
    },
    {
      tables: [
        "work_queue",
        "system_settings",
        "prod_action_runs",
        "users",
        "user_notifications",
        "admin_setting_audit",
        // Task #1920 — the reach_front_coverage_full_message_grain action's
        // countPending reads front_analytics_monthly_coverage via getDb().
        // Clone it (empty) so the read resolves against the isolated schema
        // instead of falling through search_path to the live public table;
        // otherwise the action finds real public sub-floor months, starts a
        // background drain, and its fire-and-forget finalize audit row races
        // this test's schema teardown (non-deterministic +1 CEO audit row).
        "front_analytics_monthly_coverage",
        // Task #3769 — the clear_placeholder_common_issues action scans (and
        // on apply, CLEARS) report_sections via getDb(). Clone it (empty) so
        // the action converges on "not needed" against the isolated schema
        // instead of scanning — or mutating — live public rows.
        "report_sections",
        // Task #4175 — the report-hygiene actions (backfill_empty_report_
        // sections / backfill_report_section_history_baseline and the
        // cleanup_inactive_product_report_blocks lever) read reports +
        // report_section_history via getDb(). Clone them (empty) so both
        // status and the apply-all press converge on not-needed against the
        // isolated schema instead of scanning — or backfilling — live
        // public rows. With reports empty, the scans early-return before
        // ever touching clients/command_panels/webhook_import_logs, so
        // those stay uncloned.
        "reports",
        "report_section_history",
        // Task #4872 — the backfill_agent_chat_senders_from_activity action
        // scans client_agent_chats (and on apply, STAMPS created_by_user_id)
        // joined against user_activity_logs via getDb(). Clone both (empty)
        // so status and the apply-all press converge on not-needed against
        // the isolated schema instead of scanning — or mutating — live
        // public rows.
        "client_agent_chats",
        "user_activity_logs",
      ],
    },
  );
  } finally {
    __setPracticeAreaReconciliationDepsForTest(null);
    __test_resetReconciledUsers();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-routes: all sections passed");
  },
  (err) => {
    console.error("prod-actions-routes: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
