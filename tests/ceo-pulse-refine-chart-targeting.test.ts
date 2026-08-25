/* test-registration
{
  "name": "CEO Pulse refine chart-targeting guard e2e (Task #2116)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2116 — end-to-end coverage for the chart-targeting guard in the
 * CEO Pulse "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * Task #2114 added fast unit coverage for the deterministic targeting
 * guard by testing the extracted helpers in
 * `server/services/chartTargeting.ts` directly. That intentionally
 * bypasses the HTTP route and the OpenAI call, so it does NOT verify the
 * glue inside the refine handler: how the AI response is parsed,
 * validated through `validateCeoPulseChart`, fed into
 * `evaluateChartTargeting`, persisted via `storage.updateCeoPulse`, and
 * turned into the user-facing `message` via `buildTargetingMessage`.
 *
 * This test drives the REAL route with:
 *   - the OpenAI client mocked by overriding the shared singleton's
 *     `chat.completions.create` (the same `openai` object instance that
 *     `reports.ts` imports from `./middleware`), and
 *   - the chart-image generator stubbed out via a resolve-hook redirect
 *     (`ceoPulseChartImageSetup.mjs`) so the persist path never writes to
 *     object storage.
 *
 * Coverage (the same three cases the helper unit test asserts, but end to
 * end through the route + storage):
 *   (1) correct Chart 3 edit -> `Updated Chart 3 ("…")` confirmation;
 *       the edit to the 3rd chart IS persisted, the others untouched
 *   (2) wrong-chart refusal  -> user names Chart 3 but the AI changed a
 *       neighbor; route refuses, reverts to the original charts, and the
 *       message says the edit didn't land on Chart 3
 *   (3) count-drift refusal  -> user names Chart 3 on an in-place edit but
 *       the AI returns a different chart count; route refuses, reverts,
 *       and the message says the edit didn't land on Chart 3
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
const TAG = "task-2116";

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
// numbers), so an unchanged chart round-trips through validation and the
// targeting guard's positional diff sees it as unchanged.
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

// Three distinct charts so "Chart 3" maps unambiguously to index 2.
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
          VALUES (${monthKey}, ${"Pulse " + monthKey}, ${"Leads: Google 120, Bing 30. Revenue up."}, true, ${CEO_ID})
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
        // ── (1) correct Chart 3 edit ────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-01");
          const input = threeCharts();
          // The AI returns all three charts, changing ONLY chart 3 (index 2)
          // by adding a subtitle — exactly what "edit chart 3" should do.
          const edited = threeCharts();
          edited[2].subtitle = "Quarter-over-quarter funnel";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: edited,
            },
            message: "Added a caption.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Change the subtitle of chart 3",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "correct-target refine → 200");
          assert.match(
            r.body.message,
            /Updated Chart 3 \("Conversion Funnel"\)/,
            `correct target should confirm Chart 3 by number + title; got: ${r.body.message}`,
          );
          // Response echoes the edit landing on chart 3.
          assert.equal(r.body.analysis.charts.length, 3, "all three charts preserved");
          assert.equal(
            r.body.analysis.charts[2].subtitle,
            "Quarter-over-quarter funnel",
            "the edit landed on chart 3 (response)",
          );
          // Persisted state matches the response.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: all three charts");
          assert.equal(
            saved[2].subtitle,
            "Quarter-over-quarter funnel",
            "persisted: the edit landed on chart 3",
          );
          assert.equal(saved[0].subtitle, undefined, "persisted: chart 1 untouched");
          assert.equal(saved[1].subtitle, undefined, "persisted: chart 2 untouched");
          console.log("  ok  (1) correct Chart 3 edit → confirmed by number+title, persisted on chart 3 only");
        }

        // ── (2) wrong-chart refusal ─────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-02");
          const input = threeCharts();
          // User asks for chart 3, but the AI (the bug) edits chart 1
          // (index 0) and leaves chart 3 byte-for-byte unchanged.
          const edited = threeCharts();
          edited[0].subtitle = "Edited the WRONG chart";
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: edited,
            },
            message: "Updated Chart 3 as requested.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Change the subtitle of chart 3",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "wrong-chart refine → 200");
          assert.match(
            r.body.message,
            /didn't land on Chart 3/i,
            `wrong-chart message should say the edit didn't land on Chart 3; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /Updated Chart 3 as requested\./,
            "must NOT relay the AI's false success message",
          );
          // Response reverted to the original charts — no subtitle anywhere.
          assert.equal(r.body.analysis.charts.length, 3, "charts count unchanged");
          assert.ok(
            r.body.analysis.charts.every((c: any) => c.subtitle === undefined),
            "mis-targeted edit was discarded (response)",
          );
          // Persisted state is the original, unmodified charts.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: charts count unchanged");
          assert.ok(
            saved.every((c: any) => c.subtitle === undefined),
            "persisted: mis-targeted edit was NOT saved",
          );
          console.log("  ok  (2) wrong-chart refusal → honest message, original charts preserved");
        }

        // ── (3) count-drift refusal ─────────────────────────────────────
        {
          const pulseId = await seedPulse("2026-03");
          const input = threeCharts();
          // User asks to edit chart 3 in place (non-structural), but the AI
          // returns only two charts — the count drifted, so positional
          // targeting can no longer be trusted.
          const edited = [barChart("Lead Sources", 120), barChart("Revenue by Month", 50)];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: edited,
            },
            message: "Updated Chart 3.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Change the subtitle of chart 3",
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "count-drift refine → 200");
          assert.match(
            r.body.message,
            /didn't land on Chart 3/i,
            `count-drift message should say the edit didn't land on Chart 3; got: ${r.body.message}`,
          );
          assert.doesNotMatch(
            r.body.message,
            /^Updated Chart 3\.$/,
            "must NOT relay the AI's false success message",
          );
          // Response reverted to the original three charts (count restored).
          assert.equal(r.body.analysis.charts.length, 3, "count restored to original");
          const titles = r.body.analysis.charts.map((c: any) => c.title);
          assert.deepEqual(
            titles,
            ["Lead Sources", "Revenue by Month", "Conversion Funnel"],
            "original chart set restored (response)",
          );
          // Persisted state keeps all three original charts.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: count restored to original");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Lead Sources", "Revenue by Month", "Conversion Funnel"],
            "persisted: original chart set restored",
          );
          console.log("  ok  (3) count-drift refusal → honest message, original charts preserved");
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
    console.log("ceo-pulse-refine-chart-targeting: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-chart-targeting: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
