/* test-registration
{
  "name": "CEO Pulse refine reorder chart (Task #2224)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2224 — end-to-end coverage for REORDERING charts in the CEO Pulse
 * "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * The chart-targeting guard in `server/services/chartTargeting.ts` is
 * supposed to ACCEPT a pure reorder — a request that returns the SAME chart
 * objects (same count, each chart's contents byte-for-byte unchanged) in a
 * new order. Before this task, "reorder" / "move chart 2 above chart 1" was
 * not a recognised structural keyword, so a same-count request that shifted
 * chart positions changed multiple slots and the positional guard refused it
 * with a "didn't land on Chart N" message even though the user asked for
 * exactly that. `evaluateChartTargeting` now detects a pure permutation of
 * the input charts (when the user actually asked to reorder/move them) and
 * allows it.
 *
 * The sibling tests cover the complementary paths:
 *   - tests/ceo-pulse-refine-structural-chart.test.ts — add / remove (count
 *     changes), guard skipped.
 *   - tests/ceo-pulse-refine-rename-chart.test.ts — same-count in-place edit,
 *     guard runs and enforces the named chart.
 *
 * It drives the REAL route with the same harness the sibling tests use:
 *   - the OpenAI client mocked by overriding the shared singleton's
 *     `chat.completions.create` (the same `openai` object instance that
 *     `reports.ts` imports from `./middleware`), and
 *   - the chart-image generator stubbed out via a resolve-hook redirect
 *     (`ceoPulseChartImageSetup.mjs`) so the persist path never writes to
 *     object storage.
 *
 * Coverage:
 *   (1) "move chart 2 above chart 1" — the AI returns the same 3 charts in a
 *       new order ([2,1,3]). The guard must ACCEPT it (no "didn't land on
 *       Chart N"), and the persisted chart set must be in the new order with
 *       every chart's contents intact.
 *   (2) mis-targeted edit under a reorder-shaped message — the user says
 *       "move chart 2 above chart 1" but the AI actually EDITS a chart's
 *       contents (so it is NOT a pure permutation). The guard must still
 *       REFUSE the mis-targeted edit and REVERT, proving reorder support is
 *       not a blanket bypass.
 *
 * The whole test runs inside `runInIsolatedSchema(...)` so its
 * `ceo_pulses` writes land in a per-test schema the live
 * `Start application` workers cannot observe.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-reorder-ceo";
const TAG = "task-2224";

// ── OpenAI mock ───────────────────────────────────────────────────────
// `reports.ts` calls `openai.chat.completions.create(...)`. `openai` is a
// singleton object instance exported from `./middleware`; we import the
// SAME instance here and replace its `create` method. ESM named-import
// bindings are read-only, but the OBJECT they reference is mutable, so the
// route picks up this stub at call time. Each test sets `nextAIResponse`
// to the JSON the model should "return".
let nextAIResponse: unknown = null;
const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);
(openai.chat.completions as any).create = async () => {
  return {
    choices: [{ message: { content: JSON.stringify(nextAIResponse) } }],
  };
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. The acting CEO is pre-registered via
    // __test_markUserReconciled after seeding (isolated-schema seed is not
    // visible to requireAuth's ambient public-schema db lookup).
    (req as any).__test_clerkUserId = CEO_ID;
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

// A simple, already-numeric bar chart. `validateCeoPulseChart` leaves a
// chart shaped like this byte-for-byte equal (its data values are already
// numbers), so a chart round-trips through validation unchanged.
function barChart(title: string, value: number): any {
  return {
    type: "bar",
    title,
    valueSuffix: "",
    data: [
      { label: "Google", value },
      { label: "Bing", value: value + 10 },
    ],
  };
}

// Three distinct charts so "chart 2" maps unambiguously to index 1.
function threeCharts(): any[] {
  return [
    barChart("Lead Sources", 120),
    barChart("Revenue by Month", 50),
    barChart("Conversion Funnel", 30),
  ];
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-CEO`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);

      // Isolated-schema seed is uncommitted & invisible to requireAuth's
      // ambient public-schema db lookup — pre-register the CEO profile so the
      // middleware uses it directly (role gating stays real).
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
      });

      // Seed one graphs-enabled CEO Pulse the refine route can load.
      async function seedPulse(monthKey: string): Promise<string> {
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses (month_key, title, raw_content, include_graphs, created_by)
          VALUES (${monthKey}, ${"Pulse " + monthKey}, ${"Leads: Google 120, Bing 30. Revenue up. Closed 45 cases this month."}, true, ${CEO_ID})
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

      // Read the persisted aiAnalysis straight from the DB so we assert on
      // what was actually saved, not just what the response echoed.
      async function readSavedCharts(pulseId: string): Promise<any[]> {
        const res: any = await isoDb.execute(sql`
          SELECT ai_analysis FROM ceo_pulses WHERE id = ${pulseId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        const analysis = rows[0]?.ai_analysis ?? {};
        return Array.isArray(analysis.charts) ? analysis.charts : [];
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) "move chart 2 above chart 1" → pure reorder accepted ─────
        {
          const pulseId = await seedPulse("2026-10");
          const input = threeCharts();
          // The AI returns the SAME three charts in a new order [2,1,3].
          // Same count, every chart's contents unchanged — a pure
          // permutation that must be accepted, not refused.
          const reordered = [
            barChart("Revenue by Month", 50),
            barChart("Lead Sources", 120),
            barChart("Conversion Funnel", 30),
          ];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: reordered,
            },
            message: "Moved Chart 2 above Chart 1.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Move chart 2 above chart 1",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "reorder refine → 200");
          // The targeting guard must NOT refuse a pure reorder even though the
          // user named a chart number and multiple slots changed position.
          assert.doesNotMatch(
            r.body.message,
            /didn't land on Chart/i,
            `pure reorder must not be refused by the targeting guard; got: ${r.body.message}`,
          );
          // Response reflects the new order with the count preserved.
          assert.equal(r.body.analysis.charts.length, 3, "response: count preserved (3)");
          assert.deepEqual(
            r.body.analysis.charts.map((c: any) => c.title),
            ["Revenue by Month", "Lead Sources", "Conversion Funnel"],
            "response: charts in the new order",
          );
          // Persisted state matches the new order.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: count preserved (3)");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Revenue by Month", "Lead Sources", "Conversion Funnel"],
            "persisted: charts saved in the new order",
          );
          // Every chart's full contents must be intact (only the order moved).
          assert.deepEqual(
            saved,
            reordered,
            "persisted: chart contents byte-for-byte unchanged, only order moved",
          );
          console.log('  ok  (1) "move chart 2 above chart 1" → reordered, persisted, accepted');
        }

        // ── (2) reorder-shaped message but a real in-place edit → refused ─
        {
          const pulseId = await seedPulse("2026-11");
          const input = threeCharts();
          // The message looks like a reorder ("move chart 2 above chart 1"),
          // but the AI actually EDITS chart 1's title and keeps the order.
          // That is NOT a pure permutation, so the positional guard must run
          // and refuse it (the user named chart 2 but chart 1 changed),
          // proving reorder support did not become a blanket bypass.
          const misTargeted = [
            barChart("Lead Sources (renamed)", 120),
            barChart("Revenue by Month", 50),
            barChart("Conversion Funnel", 30),
          ];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: misTargeted,
            },
            message: "Renamed a chart.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Move chart 2 above chart 1",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "mis-targeted reorder refine → 200");
          // The guard must refuse the mis-targeted edit (chart 1 changed, not
          // a pure permutation).
          assert.match(
            r.body.message,
            /didn't land on Chart 2/i,
            `a non-permutation edit under a reorder message must still be refused; got: ${r.body.message}`,
          );
          // Response reverts to the original chart set (nothing changed).
          assert.equal(r.body.analysis.charts.length, 3, "response: count preserved (3)");
          assert.deepEqual(
            r.body.analysis.charts.map((c: any) => c.title),
            ["Lead Sources", "Revenue by Month", "Conversion Funnel"],
            "response: reverted to original titles (mis-targeted edit dropped)",
          );
          // Persisted state is the untouched original.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: count preserved (3)");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Lead Sources", "Revenue by Month", "Conversion Funnel"],
            "persisted: original charts unchanged (mis-targeted edit not saved)",
          );
          console.log('  ok  (2) reorder-shaped message + real edit → refused, reverted');
        }
      } finally {
        server.close();
        __test_resetReconciledUsers();
        (openai.chat.completions as any).create = originalCreate;
      }
    },
    {
      tables: ["ceo_pulses", "users"],
    },
  );
}

main().then(
  () => {
    console.log("ceo-pulse-refine-reorder-chart: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("ceo-pulse-refine-reorder-chart: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
