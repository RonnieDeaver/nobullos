/* test-registration
{
  "name": "CEO Pulse regenerate-charts after reorder regenerates in new order (Task #2271)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2271 — guard the CEO Pulse REGENERATE-CHARTS flow after a reorder.
 *
 *   POST /api/ceo-pulses/:id/regenerate-charts   (server/routes/reports.ts)
 *
 * When a CEO reorders charts in the CEO Pulse editor (Task #2259), the editor
 * persists the new order via PATCH (covered by tests/ceo-pulse-reorder-patch.ts,
 * Task #2262) and then calls this regenerate-charts endpoint so the
 * position-keyed `{{chart-N}}` letter images line up with the new order. The
 * real generator (`generateAndStoreChartImages` in
 * server/services/chartImageGenerator.ts) writes `chart-(i+1).png` for the
 * chart at index `i`, so the ORDER of the charts array it is handed IS the
 * position→image mapping the letter renders.
 *
 * The danger this test guards: if a future change regenerated images in the
 * wrong order (or skipped some), the letter would show the OLD image under a
 * moved chart even though the reordered data persisted correctly. We pin:
 *
 *   (1) After a real PATCH reorder, POST /regenerate-charts regenerates exactly
 *       one image per persisted chart, IN THE NEW ORDER — the generator is
 *       handed the reordered charts so chart-1.png maps to new slot 0, etc.
 *   (2) The endpoint's `generatedCount` equals the chart count, and the
 *       position→image mapping reflects the reordered titles.
 *
 * The chart-image generator is stubbed via the existing resolve-hook helper
 * (tests/helpers/ceoPulseChartImageSetup.mjs, registered in run-all.ts via
 * `--import`) so no object-storage writes happen; the stub records each call's
 * charts (and order) so we can assert on the position→image mapping.
 *
 * The whole HTTP section runs inside `runInIsolatedSchema(...)` so its
 * `ceo_pulses` writes can't be observed by the live `Start application`
 * workers. Both the PATCH and regenerate routes only touch the DB + the
 * stubbed generator, so no OpenAI stubbing is required.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
// Same module instance the route's `chartImageGenerator` import is redirected
// to by the resolve hook, so reading these recordings observes the route's
// real calls.
import {
  __chartImageCalls,
  __resetChartImageCalls,
} from "./helpers/ceoPulseChartImageStub.mjs";

const CEO_ID = "test-ceo-pulse-regenerate-reorder-ceo";
const TAG = "task-2271";

// The exact array move the editor performs: pull the chart out of slot `from`
// and splice it back in at slot `to`. Kept byte-identical to `reorderCharts`
// in client/src/pages/admin/CeoPulseAdmin.tsx.
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

async function request(
  baseUrl: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// A simple, already-numeric bar chart so contents round-trip unchanged.
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

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // Seed in the ORIGINAL order, then PATCH to the new order exactly as
        // the editor does — drag slot 0 ("Lead Sources") to slot 2.
        const original = threeCharts();
        const pulseId = await seedPulse("2026-12", original);
        const reordered = reorderMove(original, 0, 2);
        const expectedOrder = ["Revenue by Month", "Conversion Funnel", "Lead Sources"];

        const patchRes = await request(baseUrl, "PATCH", `/api/ceo-pulses/${pulseId}`, {
          aiAnalysis: {
            headline: "Original",
            keyTakeaways: [],
            strategicImplications: [],
            charts: reordered,
          },
        });
        assert.equal(patchRes.status, 200, "reorder PATCH → 200");

        // Only count generator calls made by the regenerate endpoint itself.
        __resetChartImageCalls();

        const r = await request(baseUrl, "POST", `/api/ceo-pulses/${pulseId}/regenerate-charts`);
        assert.equal(r.status, 200, "regenerate-charts → 200");

        // (1) The endpoint reports one image generated per chart.
        assert.equal(r.body.success, true, "regenerate: success true");
        assert.equal(
          r.body.generatedCount,
          reordered.length,
          `regenerate: generatedCount (${r.body.generatedCount}) matches chart count (${reordered.length})`,
        );

        // (2) The generator was invoked exactly once, with the persisted
        // (reordered) charts in the NEW order — so one image per chart, in
        // order, no skips and no duplicate passes.
        assert.equal(__chartImageCalls.length, 1, "regenerate: generator called exactly once");
        const call = __chartImageCalls[0];
        assert.equal(call.monthKey, "2026-12", "regenerate: generator got the pulse's monthKey");
        assert.equal(
          call.charts.length,
          reordered.length,
          "regenerate: generator handed one chart per persisted chart",
        );
        assert.deepEqual(
          titles(call.charts),
          expectedOrder,
          "regenerate: generator handed charts in the NEW (reordered) order",
        );

        // (3) Position→image mapping: the real generator writes chart-(i+1).png
        // for the chart at index i, so the i-th handed chart is the image the
        // letter's {{chart-(i+1)}} placeholder renders. Assert each slot maps
        // to the reordered title — proving moved charts get fresh images, not
        // the stale image from their old slot.
        const positionToImage = call.charts.map((c: any, i: number) => ({
          placeholder: `{{chart-${i + 1}}}`,
          imageFile: `chart-${i + 1}.png`,
          title: c.title,
        }));
        assert.deepEqual(
          positionToImage,
          [
            { placeholder: "{{chart-1}}", imageFile: "chart-1.png", title: "Revenue by Month" },
            { placeholder: "{{chart-2}}", imageFile: "chart-2.png", title: "Conversion Funnel" },
            { placeholder: "{{chart-3}}", imageFile: "chart-3.png", title: "Lead Sources" },
          ],
          "regenerate: each position-keyed image maps to the reordered chart in that slot",
        );

        console.log("  ok  regenerate-charts after reorder → one image per chart, in the new order");
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
    console.log("ceo-pulse-regenerate-charts-reorder: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("ceo-pulse-regenerate-charts-reorder: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
