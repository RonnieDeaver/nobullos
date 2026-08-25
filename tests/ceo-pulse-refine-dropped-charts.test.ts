/* test-registration
{
  "name": "CEO Pulse refine honest chart-drop feedback (Task #2107)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2107 — automated coverage for honest chart-drop feedback in the
 * CEO Pulse "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * Task #2106 made this route tell the truth when a requested chart can't
 * be added because its data is non-numeric/empty: instead of relaying the
 * AI's (false) "chart added" message, the route runs every returned chart
 * through `validateCeoPulseChart`, drops the ones with no numeric data,
 * and rewrites the confirmation message to name the dropped chart and
 * explain that numbers are required. That behavior had no automated
 * coverage, so a future refactor could silently reintroduce the
 * false-success bug confirmed in prod.
 *
 * This test exercises the real route with:
 *   - the OpenAI client mocked by overriding the shared singleton's
 *     `chat.completions.create` (the same `openai` object instance that
 *     `reports.ts` imports from `./middleware`), and
 *   - the chart-image generator stubbed out via a resolve-hook redirect
 *     (`ceoPulseChartImageSetup.mjs`) so the success path never writes to
 *     object storage.
 *
 * Coverage:
 *   (1) all-charts-dropped  -> "values must be numeric" corrective
 *       message; saved charts unchanged from the request's currentAnalysis
 *   (2) partial-drop (2 valid + 1 invalid) -> message names the dropped
 *       chart's title; only the 2 valid charts survive
 *   (3) all-valid           -> normal success message; no spurious
 *       drop / "couldn't be added" / "numeric" warning
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

const CEO_ID = "test-ceo-pulse-refine-ceo";
const TAG = "task-2107";

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

function validBarChart(title: string, label: string, value: number): any {
  return {
    type: "bar",
    title,
    valueSuffix: "",
    data: [
      { label, value },
      { label: `${label} (prior)`, value: value + 10 },
    ],
  };
}

// A chart whose data points have non-numeric values — `validateCeoPulseChart`
// parses them to NaN, filters them all out, and returns null (dropped).
function nonNumericChart(title: string): any {
  return {
    type: "bar",
    title,
    data: [
      { label: "Awareness", value: "high" },
      { label: "Consideration", value: "medium" },
    ],
  };
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
          VALUES (${monthKey}, ${"Pulse " + monthKey}, ${"Leads: Google 120, Bing 30. Revenue up."}, true, ${CEO_ID})
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) all-charts-dropped ──────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-01");
          const existing = validBarChart("Lead Sources", "Google", 120);
          // The AI claims success but returns a single non-numeric chart.
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [nonNumericChart("The Client Journey")],
            },
            message: "Added the client journey chart!",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Visualize the client journey as a chart",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [existing],
            },
          });
          assert.equal(r.status, 200, "all-dropped refine → 200");
          assert.match(
            r.body.message,
            /values must be numeric/i,
            `all-dropped message should mention numeric values; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /Added the client journey chart!/,
            "must NOT relay the AI's false success message",
          );
          // Charts unchanged: the one pre-existing chart survives, the
          // dropped chart was not saved.
          assert.equal(r.body.analysis.charts.length, 1, "charts unchanged (count)");
          assert.equal(
            r.body.analysis.charts[0].title,
            "Lead Sources",
            "charts unchanged (original survives)",
          );
          console.log("  ok  (1) all-charts-dropped → numeric-values corrective message, charts unchanged");
        }

        // ── (2) partial-drop ────────────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-02");
          const chartA = validBarChart("Lead Sources", "Google", 120);
          const chartB = validBarChart("Revenue by Month", "Jan", 50);
          // AI returns the two valid charts plus one invalid one.
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chartA, chartB, nonNumericChart("Market Sentiment")],
            },
            message: "Added the market sentiment chart!",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Add a chart for market sentiment",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chartA, chartB],
            },
          });
          assert.equal(r.status, 200, "partial-drop refine → 200");
          assert.match(
            r.body.message,
            /Market Sentiment/,
            `partial-drop message should name the dropped chart; got: ${r.body.message}`,
          );
          assert.match(
            r.body.message,
            /couldn't be added/i,
            `partial-drop message should explain the chart couldn't be added; got: ${r.body.message}`,
          );
          // Only the two valid charts survive.
          assert.equal(r.body.analysis.charts.length, 2, "only the 2 valid charts survive");
          const titles = r.body.analysis.charts.map((c: any) => c.title).sort();
          assert.deepEqual(
            titles,
            ["Lead Sources", "Revenue by Month"],
            "surviving charts are exactly the two valid ones",
          );
          console.log("  ok  (2) partial-drop → message names dropped chart, only valid charts survive");
        }

        // ── (3) all-valid ───────────────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-03");
          const existing = validBarChart("Lead Sources", "Google", 120);
          const recolored = validBarChart("Lead Sources", "Google", 120);
          recolored.data[0].color = "#1E3A5F";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [recolored],
            },
            message: "Recolored the Google bar to navy.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make the Google bar navy",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [existing],
            },
          });
          assert.equal(r.status, 200, "all-valid refine → 200");
          assert.equal(
            r.body.message,
            "Recolored the Google bar to navy.",
            `all-valid should return the normal success message; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /couldn't be added|values must be numeric|may not have applied/i,
            "all-valid must NOT carry a spurious drop warning",
          );
          assert.equal(r.body.analysis.charts.length, 1, "the valid chart was saved");
          console.log("  ok  (3) all-valid → normal success message, no spurious drop warning");
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
    console.log("ceo-pulse-refine-dropped-charts: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-dropped-charts: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
