/* test-registration
{
  "name": "CEO Pulse refine mis-targeted chart guard (Task #2117)",
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
 * Task #2117 — automated coverage for the chart-targeting guard in the
 * CEO Pulse "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * When the user names a chart by its canonical 1-based number/ordinal
 * ("Chart 2" / "{{chart-2}}") but the AI's edit lands on a DIFFERENT
 * chart — or drifts the chart count on what was an in-place edit — the
 * route refuses to save the mis-targeted result, reverts charts to the
 * input, and returns an honest "I didn't change anything because the
 * edit didn't land on Chart N" message instead of silently overwriting
 * the wrong chart. The deterministic guard lives in
 * `server/services/chartTargeting.ts` (evaluateChartTargeting /
 * buildTargetingMessage / parseChartOrdinal / stableStringify) and is
 * wired into the refine route. It previously had no automated coverage,
 * so a refactor of the route could silently reintroduce mis-targeted
 * saves.
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
 *   (1) wrong-chart  -> user references "Chart 2" but the AI edits Chart 1;
 *       response refuses, names Chart 2, saves nothing (charts == input)
 *   (2) count-drift  -> in-place edit (no add/remove/merge keyword) where
 *       the AI returns a different chart count; refusal, charts unchanged
 *   (3) correct      -> user references "Chart 2" and the AI edits Chart 2;
 *       success message names Chart 2 and its title; the edit is saved
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

const CEO_ID = "test-ceo-pulse-targeting-ceo";
const TAG = "task-2117";

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

// A valid numeric bar chart. `validateCeoPulseChart` leaves numeric charts
// byte-identical, so an unchanged chart returned by the AI compares equal
// to its stored input under the targeting guard's stableStringify check.
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
        // ── (1) wrong-chart: user names Chart 2, AI edits Chart 1 ────────
        {
          const pulseId = await seedPulse("2026-04");
          const chart1 = validBarChart("Lead Sources", "Google", 120);
          const chart2 = validBarChart("Revenue by Month", "Jan", 50);
          // The AI changes Chart 1 (recolor) but leaves Chart 2 identical —
          // i.e. it edited the WRONG chart relative to the user's request.
          const modifiedChart1 = validBarChart("Lead Sources", "Google", 120);
          modifiedChart1.data[0].color = "#1E3A5F";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [modifiedChart1, validBarChart("Revenue by Month", "Jan", 50)],
            },
            message: "Made Chart 2 navy.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            // No structural keyword (add/remove/merge), so the positional
            // in-place targeting guard is allowed to run.
            message: "Make Chart 2 navy",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chart1, chart2],
            },
          });
          assert.equal(r.status, 200, "wrong-chart refine → 200");
          assert.match(
            r.body.message,
            /didn't (change anything|land on Chart 2)/i,
            `wrong-chart message should say nothing was saved / reference Chart 2; got: ${r.body.message}`,
          );
          assert.match(
            r.body.message,
            /Chart 2/,
            `wrong-chart message should reference Chart 2; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /Made Chart 2 navy\./,
            "must NOT relay the AI's (mis-targeted) success message",
          );
          // Saved charts equal the unchanged input — nothing was overwritten.
          assert.equal(r.body.analysis.charts.length, 2, "wrong-chart: charts unchanged (count)");
          assert.deepEqual(
            r.body.analysis.charts,
            [chart1, chart2],
            "wrong-chart: saved charts equal the unchanged input",
          );
          console.log("  ok  (1) wrong-chart → refusal names Chart 2, charts unchanged");
        }

        // ── (2) count-drift on an in-place edit ─────────────────────────
        {
          const pulseId = await seedPulse("2026-05");
          const chart1 = validBarChart("Lead Sources", "Google", 120);
          const chart2 = validBarChart("Revenue by Month", "Jan", 50);
          // In-place edit (no add/remove/merge keyword), but the AI returns a
          // DIFFERENT chart count — positional targeting can no longer be
          // trusted, so the guard must refuse to save.
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [validBarChart("Lead Sources", "Google", 120)],
            },
            message: "Recolored Chart 2.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make Chart 2 use a navy color scheme",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chart1, chart2],
            },
          });
          assert.equal(r.status, 200, "count-drift refine → 200");
          assert.match(
            r.body.message,
            /didn't (change anything|land on Chart 2)/i,
            `count-drift message should say nothing was saved / reference Chart 2; got: ${r.body.message}`,
          );
          assert.match(
            r.body.message,
            /Chart 2/,
            `count-drift message should reference Chart 2; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /Recolored Chart 2\./,
            "must NOT relay the AI's (mis-targeted) success message",
          );
          // Charts unchanged: the count-drift was rejected.
          assert.equal(r.body.analysis.charts.length, 2, "count-drift: charts unchanged (count)");
          assert.deepEqual(
            r.body.analysis.charts,
            [chart1, chart2],
            "count-drift: saved charts equal the unchanged input",
          );
          console.log("  ok  (2) count-drift → refusal names Chart 2, charts unchanged");
        }

        // ── (3) correct: user names Chart 2, AI edits Chart 2 ───────────
        {
          const pulseId = await seedPulse("2026-06");
          const chart1 = validBarChart("Lead Sources", "Google", 120);
          const chart2 = validBarChart("Revenue by Month", "Jan", 50);
          // The AI leaves Chart 1 identical and edits ONLY Chart 2.
          const modifiedChart2 = validBarChart("Revenue by Month", "Jan", 50);
          modifiedChart2.data[0].color = "#1E3A5F";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [validBarChart("Lead Sources", "Google", 120), modifiedChart2],
            },
            message: "Recolored a chart.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make Chart 2 navy",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chart1, chart2],
            },
          });
          assert.equal(r.status, 200, "correct-target refine → 200");
          assert.match(
            r.body.message,
            /Updated Chart 2/,
            `correct-target message should name Chart 2; got: ${r.body.message}`,
          );
          assert.match(
            r.body.message,
            /Revenue by Month/,
            `correct-target message should name the targeted chart's title; got: ${r.body.message}`,
          );
          // The edit was saved: Chart 1 unchanged, Chart 2 carries the new color.
          assert.equal(r.body.analysis.charts.length, 2, "correct-target: charts saved (count)");
          assert.deepEqual(
            r.body.analysis.charts[0],
            chart1,
            "correct-target: Chart 1 left unchanged",
          );
          assert.equal(
            r.body.analysis.charts[1].data[0].color,
            "#1E3A5F",
            "correct-target: Chart 2 edit was saved",
          );
          console.log("  ok  (3) correct-target → success names Chart 2 and its title, edit saved");
        }

        // ── (4) wrong-chart via PLAIN-ENGLISH phrasing ("the second chart") ──
        // The route's only other end-to-end case names the chart numerically
        // ("Chart 2"). parseChartOrdinal also resolves ordinal words, so this
        // drives the SAME guard through a non-numeric phrasing to prove the
        // wiring still maps "second chart" → Chart 2 end to end. A refine-route
        // change could silently stop the guard firing for non-numeric phrasings
        // without any route-level test noticing.
        {
          const pulseId = await seedPulse("2026-07");
          const chart1 = validBarChart("Lead Sources", "Google", 120);
          const chart2 = validBarChart("Revenue by Month", "Jan", 50);
          // The AI changes Chart 1 (recolor) but leaves Chart 2 identical —
          // i.e. it edited the WRONG chart relative to "the second chart".
          const modifiedChart1 = validBarChart("Lead Sources", "Google", 120);
          modifiedChart1.data[0].color = "#1E3A5F";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [modifiedChart1, validBarChart("Revenue by Month", "Jan", 50)],
            },
            message: "Made the second chart navy.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            // Plain-English ordinal, no "Chart N" / "{{chart-N}}" and no
            // structural keyword — the positional in-place guard must run and
            // resolve "the second chart" to Chart 2.
            message: "Make the second chart navy",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: [chart1, chart2],
            },
          });
          assert.equal(r.status, 200, "plain-english wrong-chart refine → 200");
          assert.match(
            r.body.message,
            /didn't (change anything|land on Chart 2)/i,
            `plain-english message should say nothing was saved / reference Chart 2; got: ${r.body.message}`,
          );
          assert.match(
            r.body.message,
            /Chart 2/,
            `plain-english message should reference Chart 2; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /Made the second chart navy\./,
            "must NOT relay the AI's (mis-targeted) success message",
          );
          // Saved charts equal the unchanged input — nothing was overwritten.
          assert.equal(r.body.analysis.charts.length, 2, "plain-english: charts unchanged (count)");
          assert.deepEqual(
            r.body.analysis.charts,
            [chart1, chart2],
            "plain-english: saved charts equal the unchanged input",
          );
          console.log('  ok  (4) plain-english "second chart" → guard fires for Chart 2, charts unchanged');
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
    console.log("ceo-pulse-refine-mis-targeted-chart: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-mis-targeted-chart: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
