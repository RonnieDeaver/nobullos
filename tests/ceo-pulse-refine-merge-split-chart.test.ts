/* test-registration
{
  "name": "CEO Pulse refine merge/split chart (Task #2162)",
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
 * Task #2162 — end-to-end coverage for the MERGE and SPLIT structural
 * chart-change paths in the CEO Pulse "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * The chart-targeting guard in `server/services/chartTargeting.ts` is
 * deliberately SKIPPED for "structural" requests. Its
 * `structuralChartRequest` regex exempts not only add/remove but also
 * merge / merging / combine / combining / consolidate / consolidating /
 * split / splitting. For those requests the chart COUNT is supposed to
 * change, so the in-place positional guard (which refuses a count drift or
 * a neighbor edit) must NOT run.
 *
 * The sibling test `tests/ceo-pulse-refine-structural-chart.test.ts`
 * already covers the "add a chart" / "remove chart 2" structural paths
 * (Task #2143). This test covers the complementary MERGE and SPLIT paths
 * that the same regex exempts but that previously had no end-to-end
 * coverage, so a regression that (a) started falsely refusing a valid
 * "merge chart 1 and chart 2" / "split chart 3" request with a "didn't
 * land on Chart N" message, or (b) silently mis-handled the resulting
 * chart set, would be caught.
 *
 * It drives the REAL route with the same harness the sibling test uses:
 *   - the OpenAI client mocked by overriding the shared singleton's
 *     `chat.completions.create` (the same `openai` object instance that
 *     `reports.ts` imports from `./middleware`), and
 *   - the chart-image generator stubbed out via a resolve-hook redirect
 *     (`ceoPulseChartImageSetup.mjs`) so the persist path never writes to
 *     object storage.
 *
 * Coverage:
 *   (1) "merge chart 1 and chart 2" — the AI legitimately SHRINKS the
 *       count from 3 -> 2 by combining the first two charts into one,
 *       even though the message names "chart 1". The count-drift guard
 *       would normally refuse this, but it must be skipped because the
 *       request is structural ("merge"). The route must NOT refuse it
 *       (no "didn't land on Chart N"), and the persisted chart set must be
 *       the merged chart followed by the untouched 3rd chart.
 *   (2) "split chart 3 into two" — the AI legitimately GROWS the count
 *       from 3 -> 4 by splitting the 3rd chart into two, even though the
 *       message names "chart 3". The route must NOT refuse it, and the
 *       persisted chart set must be charts 1 and 2 followed by the two
 *       split halves in order.
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

const CEO_ID = "test-ceo-pulse-merge-split-ceo";
const TAG = "task-2162";

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

// Three distinct charts so "chart 1" / "chart 3" map unambiguously.
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
        // ── (1) "merge chart 1 and chart 2" → count shrinks 3 → 2 ───────
        {
          const pulseId = await seedPulse("2026-06");
          const input = threeCharts();
          // The AI combines charts 1 and 2 into a single merged chart and
          // keeps chart 3. The message names "chart 1", so the in-place
          // count-drift guard would normally refuse this — but it must be
          // skipped because the request is structural ("merge").
          const merged = [barChart("Lead Sources & Revenue", 170), barChart("Conversion Funnel", 30)];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: merged,
            },
            message: "Merged Chart 1 and Chart 2 into a single combined chart.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Merge chart 1 and chart 2 into one chart",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "merge refine → 200");
          // The targeting guard must NOT fire on a structural request even
          // though the user named a chart number and the count drifted.
          assert.doesNotMatch(
            r.body.message,
            /didn't land on Chart/i,
            `structural "merge" must not be refused by the targeting guard; got: ${r.body.message}`,
          );
          // Response reflects the merged chart set.
          assert.equal(r.body.analysis.charts.length, 2, "response: charts merged (count 2)");
          assert.deepEqual(
            r.body.analysis.charts.map((c: any) => c.title),
            ["Lead Sources & Revenue", "Conversion Funnel"],
            "response: charts 1+2 merged, chart 3 kept in order",
          );
          // Persisted state matches.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 2, "persisted: charts merged (count 2)");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Lead Sources & Revenue", "Conversion Funnel"],
            "persisted: charts 1+2 merged, chart 3 kept in order",
          );
          console.log('  ok  (1) "merge chart 1 and chart 2" → count shrank to 2, persisted, not refused');
        }

        // ── (2) "split chart 3 into two" → count grows 3 → 4 ────────────
        {
          const pulseId = await seedPulse("2026-07");
          const input = threeCharts();
          // The AI splits chart 3 (Conversion Funnel) into two charts and
          // keeps charts 1 and 2. The message names "chart 3", so the
          // in-place count-drift guard would normally refuse this — but it
          // must be skipped because the request is structural ("split").
          const splitSet = [
            barChart("Lead Sources", 120),
            barChart("Revenue by Month", 50),
            barChart("Conversion Funnel (Top)", 18),
            barChart("Conversion Funnel (Bottom)", 12),
          ];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: splitSet,
            },
            message: "Split Chart 3 (Conversion Funnel) into two charts.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Split chart 3 into two charts",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "split refine → 200");
          // The targeting guard must NOT fire on a structural request even
          // though the user named a chart number and the count drifted.
          assert.doesNotMatch(
            r.body.message,
            /didn't land on Chart/i,
            `structural "split" must not be refused by the targeting guard; got: ${r.body.message}`,
          );
          // Response reflects the grown chart set.
          assert.equal(r.body.analysis.charts.length, 4, "response: chart split (count 4)");
          assert.deepEqual(
            r.body.analysis.charts.map((c: any) => c.title),
            ["Lead Sources", "Revenue by Month", "Conversion Funnel (Top)", "Conversion Funnel (Bottom)"],
            "response: charts 1+2 kept, chart 3 split into two in order",
          );
          // Persisted state matches.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 4, "persisted: chart split (count 4)");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Lead Sources", "Revenue by Month", "Conversion Funnel (Top)", "Conversion Funnel (Bottom)"],
            "persisted: charts 1+2 kept, chart 3 split into two in order",
          );
          console.log('  ok  (2) "split chart 3 into two" → count grew to 4, persisted, not refused');
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

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("ceo-pulse-refine-merge-split-chart: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-merge-split-chart: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
