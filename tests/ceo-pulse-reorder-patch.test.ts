/* test-registration
{
  "name": "CEO Pulse editor reorder PATCH persists pure permutation (Task #2262)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2262 — guard the CEO Pulse chart REORDER flow (Task #2259).
 *
 * CEOs can drag a chart or use the up/down arrows in the CEO Pulse editor to
 * reorder the charts in `ceo_pulses.ai_analysis.charts`. The editor does this
 * by splicing the chart out of its old slot and into the new one
 * (`reorderCharts` in client/src/pages/admin/CeoPulseAdmin.tsx) and then
 * persisting the whole analysis via the existing
 *
 *   PATCH /api/ceo-pulses/:id   (server/routes/reports.ts)
 *
 * path before regenerating the position-keyed chart images so the
 * `{{chart-N}}` letter placeholders stay aligned with the new order.
 *
 * The danger this test guards: a reorder must be a PURE PERMUTATION — only a
 * chart's position may change, never its contents. A future refactor of the
 * splice logic or the PATCH path could silently drop the wrong chart, mutate
 * a chart's data, or fail to persist the new order. We pin all three:
 *
 *   (1) The reorder move (move-up arrow / move-down arrow / drag-to-index)
 *       produces the expected new order, and `isPureChartPermutation`
 *       (server/services/chartTargeting.ts) confirms it is a pure permutation
 *       of the original — same charts, byte-for-byte contents, new sequence.
 *   (2) The PATCH path persists the reordered array unchanged: reading the
 *       stored aiAnalysis back from the DB yields exactly the new order with
 *       every chart's contents intact, and a pure permutation of the original.
 *
 * The HTTP section drives the REAL PATCH route against a per-test schema via
 * `runInIsolatedSchema(...)` so its `ceo_pulses` writes can't be observed by
 * the live `Start application` workers. The PATCH path only touches the DB
 * (chart-image regeneration is a separate endpoint), so no OpenAI or
 * object-storage stubbing is required here.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { isPureChartPermutation } from "../server/services/chartTargeting";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-reorder-patch-ceo";
const TAG = "task-2262";

// The exact array move the editor performs: pull the chart out of slot `from`
// and splice it back in at slot `to`. Kept byte-identical to `reorderCharts`
// in client/src/pages/admin/CeoPulseAdmin.tsx so this test guards the real
// editor algorithm, not a paraphrase of it.
function reorderMove<T>(charts: T[], from: number, to: number): T[] {
  const reordered = [...charts];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered;
}

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

async function patch(
  baseUrl: string,
  p: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// A simple, already-numeric bar chart so the contents round-trip unchanged.
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

// Three distinct charts so each slot is unambiguously identifiable by title.
function threeCharts(): any[] {
  return [
    barChart("Lead Sources", 120),
    barChart("Revenue by Month", 50),
    barChart("Conversion Funnel", 30),
  ];
}

const titles = (cs: any[]): string[] => cs.map((c) => c.title);

// ── Section 1: the editor's reorder move is a pure permutation ─────────────
function testReorderMoveIsPurePermutation(): void {
  // Move-DOWN arrow on slot 0 ("Lead Sources" ↓): index 0 → 1.
  {
    const original = threeCharts();
    const moved = reorderMove(original, 0, 1);
    assert.deepEqual(
      titles(moved),
      ["Revenue by Month", "Lead Sources", "Conversion Funnel"],
      "move-down: slot 0 swaps below slot 1",
    );
    assert.ok(
      isPureChartPermutation(original, moved),
      "move-down: result is a pure permutation (contents unchanged, order moved)",
    );
    console.log("  ok  (1a) move-down arrow → expected order, pure permutation");
  }

  // Move-UP arrow on slot 2 ("Conversion Funnel" ↑): index 2 → 1.
  {
    const original = threeCharts();
    const moved = reorderMove(original, 2, 1);
    assert.deepEqual(
      titles(moved),
      ["Lead Sources", "Conversion Funnel", "Revenue by Month"],
      "move-up: slot 2 rises above slot 1",
    );
    assert.ok(
      isPureChartPermutation(original, moved),
      "move-up: result is a pure permutation",
    );
    console.log("  ok  (1b) move-up arrow → expected order, pure permutation");
  }

  // Drag the first chart to the last slot: index 0 → 2.
  {
    const original = threeCharts();
    const moved = reorderMove(original, 0, 2);
    assert.deepEqual(
      titles(moved),
      ["Revenue by Month", "Conversion Funnel", "Lead Sources"],
      "drag: slot 0 lands in slot 2",
    );
    assert.ok(
      isPureChartPermutation(original, moved),
      "drag: result is a pure permutation",
    );
    // Every chart object's full contents must survive the move untouched.
    for (const orig of original) {
      const match = moved.find((c) => c.title === orig.title);
      assert.deepEqual(match, orig, `drag: "${orig.title}" contents byte-for-byte unchanged`);
    }
    console.log("  ok  (1c) drag-to-index → expected order, contents intact");
  }
}

async function main(): Promise<void> {
  testReorderMoveIsPurePermutation();

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

      async function seedPulse(monthKey: string, charts: any[]): Promise<string> {
        const analysis = {
          headline: "Original",
          keyTakeaways: [],
          strategicImplications: [],
          charts,
        };
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses (month_key, title, raw_content, include_graphs, created_by, ai_analysis)
          VALUES (
            ${monthKey},
            ${"Pulse " + monthKey},
            ${"Leads: Google 120, Bing 30. Revenue up. Closed 45 cases this month."},
            true,
            ${CEO_ID},
            ${JSON.stringify(analysis)}::jsonb
          )
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

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
        // ── (2) PATCH persists the reordered array unchanged ───────────────
        const original = threeCharts();
        const pulseId = await seedPulse("2026-12", original);

        // The editor drags slot 0 to slot 2, then PATCHes the full analysis
        // with the reordered charts (exactly what `reorderCharts` sends).
        const reordered = reorderMove(original, 0, 2);
        const r = await patch(baseUrl, `/api/ceo-pulses/${pulseId}`, {
          aiAnalysis: {
            headline: "Original",
            keyTakeaways: [],
            strategicImplications: [],
            charts: reordered,
          },
        });
        assert.equal(r.status, 200, "reorder PATCH → 200");

        const saved = await readSavedCharts(pulseId);
        assert.equal(saved.length, 3, "persisted: count preserved (3)");
        assert.deepEqual(
          titles(saved),
          ["Revenue by Month", "Conversion Funnel", "Lead Sources"],
          "persisted: charts saved in the new order",
        );
        // The stored array must equal the reordered array byte-for-byte — the
        // PATCH path must not mutate, drop, or re-shape any chart.
        assert.deepEqual(
          saved,
          reordered,
          "persisted: reordered array stored unchanged",
        );
        // And the persisted set must be a pure permutation of what was seeded:
        // only positions moved, no chart's contents changed.
        assert.ok(
          isPureChartPermutation(original, saved),
          "persisted: a pure permutation of the original (contents intact, order changed)",
        );
        console.log("  ok  (2) PATCH persists the reordered array unchanged (pure permutation)");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["ceo_pulses", "users"],
    },
  );
}

main().then(
  () => {
    console.log("ceo-pulse-reorder-patch: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("ceo-pulse-reorder-patch: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
