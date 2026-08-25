/* test-registration
{
  "name": "CEO Pulse refine rename/reorder chart (Task #2190)",
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
 * Task #2190 — end-to-end coverage for the IN-PLACE same-count edit path in
 * the CEO Pulse "Refine This Visual" endpoint, where the chart-targeting
 * guard DOES run.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * Task #2143 covered add/remove and Task #2162 covered merge/split — all
 * STRUCTURAL requests where the `structuralChartRequest` regex in
 * `server/services/chartTargeting.ts` intentionally SKIPS the positional
 * guard because the chart count is supposed to change.
 *
 * This test covers the complementary case: a request that keeps the same
 * count (e.g. "rename chart 2"). "rename" is NOT a structural keyword, so
 * the guard runs and enforces that the edit landed on the named chart and
 * nothing drifted. There was no end-to-end coverage proving that a
 * legitimate same-count rename of the named chart is ACCEPTED (no false
 * "didn't land on Chart N" refusal) while a real mis-targeted edit is still
 * REFUSED and reverted.
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
 *   (1) "rename chart 2" — the AI legitimately edits ONLY chart 2's title
 *       and keeps the count at 3. The guard must ACCEPT it (no "didn't land
 *       on Chart N"), the response message must confirm Chart 2 was updated,
 *       and the persisted chart set must show only chart 2's new title with
 *       charts 1 and 3 byte-for-byte unchanged.
 *   (2) mis-targeted rename — the user names "chart 2" but the AI edits a
 *       DIFFERENT chart (chart 1) and leaves chart 2 unchanged, keeping the
 *       count at 3. The guard must REFUSE it ("didn't land on Chart 2") and
 *       REVERT to the original charts so nothing is saved.
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

const CEO_ID = "test-ceo-pulse-rename-ceo";
const TAG = "task-2190";

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
        // ── (1) "rename chart 2" → same count, only chart 2 edited ──────
        {
          const pulseId = await seedPulse("2026-08");
          const input = threeCharts();
          // The AI keeps charts 1 and 3 byte-for-byte and renames chart 2.
          // Count stays at 3, so the in-place positional guard runs and must
          // ACCEPT this because the named chart (Chart 2) is the one that
          // changed.
          const renamed = [
            barChart("Lead Sources", 120),
            barChart("Monthly Revenue Trend", 50),
            barChart("Conversion Funnel", 30),
          ];
          nextAIResponse = {
            analysis: {
              headline: "Updated headline",
              keyTakeaways: [],
              strategicImplications: [],
              charts: renamed,
            },
            message: "Renamed Chart 2.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: 'Rename chart 2 to "Monthly Revenue Trend"',
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "rename-chart-2 refine → 200");
          // The targeting guard must NOT refuse a legitimate same-count edit
          // that landed on the named chart.
          assert.doesNotMatch(
            r.body.message,
            /didn't land on Chart/i,
            `legitimate rename of the named chart must not be refused; got: ${r.body.message}`,
          );
          // The guard confirms the targeted chart was updated.
          assert.match(
            r.body.message,
            /Updated Chart 2/i,
            `rename should confirm Chart 2 was updated; got: ${r.body.message}`,
          );
          // Response reflects the rename with the count preserved.
          assert.equal(r.body.analysis.charts.length, 3, "response: count preserved (3)");
          assert.deepEqual(
            r.body.analysis.charts.map((c: any) => c.title),
            ["Lead Sources", "Monthly Revenue Trend", "Conversion Funnel"],
            "response: only chart 2 renamed, 1 and 3 unchanged in order",
          );
          // Persisted state matches.
          const saved = await readSavedCharts(pulseId);
          assert.equal(saved.length, 3, "persisted: count preserved (3)");
          assert.deepEqual(
            saved.map((c: any) => c.title),
            ["Lead Sources", "Monthly Revenue Trend", "Conversion Funnel"],
            "persisted: only chart 2 renamed, 1 and 3 unchanged in order",
          );
          console.log('  ok  (1) "rename chart 2" → only chart 2 edited, persisted, accepted');
        }

        // ── (2) mis-targeted rename → guard refuses and reverts ─────────
        {
          const pulseId = await seedPulse("2026-09");
          const input = threeCharts();
          // The user names "chart 2" but the AI edits chart 1 instead and
          // leaves chart 2 unchanged. Count stays at 3, so the guard runs;
          // it must detect the wrong chart changed and REFUSE/revert.
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
            message: 'Rename chart 2 to "Monthly Revenue Trend"',
            currentAnalysis: {
              headline: "Original",
              keyTakeaways: [],
              strategicImplications: [],
              charts: input,
            },
          });
          assert.equal(r.status, 200, "mis-targeted rename refine → 200");
          // The guard must refuse the mis-targeted edit.
          assert.match(
            r.body.message,
            /didn't land on Chart 2/i,
            `mis-targeted rename must be refused with a Chart 2 message; got: ${r.body.message}`,
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
          console.log('  ok  (2) mis-targeted rename → refused with "didn\'t land on Chart 2", reverted');
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
    console.log("ceo-pulse-refine-rename-chart: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-rename-chart: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
