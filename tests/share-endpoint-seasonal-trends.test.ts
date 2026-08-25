/* test-registration
{
  "name": "Share endpoint embeds real seasonal trends + cached AI commentary (Tasks #4210/#4240)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4210: anonymous share-token viewers used to get a 401 from the authenticated POST /api/trends/practice-areas and silently saw hardcoded fallback numbers. The public share payload now embeds the REAL deterministic seasonal-trend data. Task #4240: the AI trend commentary is generated+stored at finalize time (fake OpenAI client here) and the share payload serves that stored copy — never computing on the anonymous path — while the internal cache section stays out of the served sections list. The rendered PublicReport tests stub the /api/share payload, so only this route-level test catches the server dropping or mis-computing the embedded field. Real route + dev DB, fast (a few fetches).",
  "tier": "small"
}
test-registration */
/**
 * Task #4210 — Regression: GET /api/share/:token (capability-token public,
 * allow-listed) must embed `seasonalTrends` built by the canonical
 * deterministic computation (server/services/practiceAreaTrendData.ts):
 *   1. A client practice area matching a hardcoded 5-year-average pattern
 *      ("Estate Planning") serves that REAL pattern (Feb peak = 100,
 *      searchTerm "estate planning attorney") — NOT the client-side fallback
 *      shape — and aiAnalysis is explicitly null (no OpenAI on the
 *      unauthenticated path; explicit product decision).
 *   2. A custom practice_area_settings row overrides the pattern for its
 *      area (DB settings take precedence over hardcoded patterns).
 *   3. POST /api/trends/practice-areas stays authenticated — an anonymous
 *      request must NOT get trend data from it (no new unauth exposure).
 *
 * Task #4240 — the AI "Current Position"/"Demand Shape Ahead" commentary is
 * generated ONCE at report-finalize time (via
 * generateAndStoreSeasonalTrendAiAnalysis with a fake OpenAI client here),
 * stored in report_sections under the internal seasonalTrendsAi key, and:
 *   4. Before any stored copy exists, the anonymous embed serves
 *      aiAnalysis: null (deterministic fallback renders).
 *   5. After storing, GET /api/share/:token serves the EXACT stored
 *      aiAnalysis and the internal cache section never appears in the served
 *      `sections` list.
 *   6. A failing AI client stores nothing (returns null) and never clobbers
 *      a previously stored good copy.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import { registerSettingsRoutes } from "../server/routes/settings";
import {
  SEASONAL_TRENDS_AI_SECTION_KEY,
  generateAndStoreSeasonalTrendAiAnalysis,
  type TrendAnalysisChatClient,
} from "../server/services/practiceAreaTrendAnalysis";

const TAG = `task-4210-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const SHARE_TOKEN = `${TAG}-share-token`;
const CUSTOM_AREA = `${TAG}-custom-area`;
const CUSTOM_MONTHLY = [11, 22, 33, 44, 55, 66, 77, 88, 99, 100, 90, 80];

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM report_section_history WHERE report_id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM reports WHERE id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM practice_area_settings WHERE practice_area = ${CUSTOM_AREA}`).catch(() => 0);
}

async function seed(practiceAreas: string[]): Promise<void> {
  const areasArray = sql`ARRAY[${sql.join(practiceAreas.map((a) => sql`${a}`), sql`, `)}]::text[]`;
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name, practice_areas)
    VALUES (${CLIENT_ID}, ${"Task4210 Firm " + TAG}, 'Task4210', ${areasArray})
    ON CONFLICT (id) DO UPDATE SET practice_areas = EXCLUDED.practice_areas
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${TAG + "-month"}, 'final', ${SHARE_TOKEN})
    ON CONFLICT (id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      status = 'final',
      share_token = EXCLUDED.share_token
  `);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Anonymous public-share consumer — no auth (Clerk test seam:
    // null = explicit-unauthenticated).
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerReportRoutes(app);
  registerSettingsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function run(): Promise<void> {
  await cleanup();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // 1. Hardcoded-pattern area: real Estate Planning seasonal data embedded.
    {
      await seed(["Estate Planning"]);
      const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
      ok(r.status === 200, `GET /api/share/:token → 200 (got ${r.status})`);
      const body: any = await r.json();
      const st = body?.seasonalTrends;
      ok(st && typeof st === "object", "payload carries seasonalTrends object");
      const area = st?.practiceAreas?.[0];
      ok(area?.practiceArea === "Estate Planning", "first trend is Estate Planning");
      ok(area?.searchTerm === "estate planning attorney near me", "real DEFAULT_SEARCH_TERMS searchTerm served (not the generic '<area> lawyer near me' fallback)");
      ok(Array.isArray(area?.data) && area.data.length === 12, "12 monthly data points");
      // Real Estate Planning pattern: Jan 95, Feb 100 (peak). The client-side
      // fallback pattern starts 90, 88 — so these pin REAL data, not fallback.
      ok(area?.data?.[0]?.value === 95 && area?.data?.[1]?.value === 100, `real Feb-peak pattern served (got ${area?.data?.[0]?.value}, ${area?.data?.[1]?.value})`);
      ok(typeof area?.data?.[0]?.phase === "string" && area.data[0].phase.length > 0, "phases classified");
      ok(st?.aiAnalysis === null, "aiAnalysis is explicitly null on the unauthenticated embed (no OpenAI)");
      ok(typeof st?.currentMonthIndex === "number", "currentMonthIndex present");
      ok(st?.combined === null, "single area → combined is null");
    }

    // 2. Custom practice_area_settings row takes precedence.
    {
      await db.execute(sql`
        INSERT INTO practice_area_settings (practice_area, search_term, monthly_data)
        VALUES (${CUSTOM_AREA}, ${"custom search " + TAG}, ${JSON.stringify(CUSTOM_MONTHLY)}::jsonb)
        ON CONFLICT (practice_area) DO UPDATE SET
          search_term = EXCLUDED.search_term,
          monthly_data = EXCLUDED.monthly_data
      `);
      await seed([CUSTOM_AREA, "Estate Planning"]);
      const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
      ok(r.status === 200, "share fetch with custom area → 200");
      const body: any = await r.json();
      const st = body?.seasonalTrends;
      const custom = st?.practiceAreas?.find((p: any) => p.practiceArea === CUSTOM_AREA);
      ok(!!custom, "custom DB practice area present in embed");
      ok(custom?.searchTerm === `custom search ${TAG}`, "custom searchTerm served from DB settings");
      ok(custom?.data?.map((d: any) => d.value).join(",") === CUSTOM_MONTHLY.join(","), "custom monthlyData served from DB settings");
      ok(st?.combined?.practiceArea === "Combined Average", "two areas → combined average present");
    }

    // 4-6. Task #4240 — finalize-time cached AI commentary.
    {
      await seed(["Estate Planning"]);

      // 4. No stored copy yet → anonymous embed serves aiAnalysis: null.
      {
        const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
        const body: any = await r.json();
        ok(body?.seasonalTrends?.aiAnalysis === null, "no stored copy → aiAnalysis null on the anonymous embed");
      }

      const storedAnalysis = {
        "Estate Planning": {
          currentPosition: [`Position: task-4240 line one ${TAG}.`, "Amplitude: task-4240 line two."],
          demandShapeAhead: ["Slope: task-4240 line three.", "Transition: task-4240 line four."],
        },
      };
      let aiCalls = 0;
      const fakeOpenAi: TrendAnalysisChatClient = {
        chat: {
          completions: {
            create: async () => {
              aiCalls++;
              return { choices: [{ message: { content: JSON.stringify(storedAnalysis) } }] };
            },
          },
        },
      };

      // Finalize-time generation path (fake client — no real OpenAI).
      const generated = await generateAndStoreSeasonalTrendAiAnalysis({
        reportId: REPORT_ID,
        practiceAreas: ["Estate Planning"],
        openaiClient: fakeOpenAi,
      });
      ok(aiCalls === 1, "generation invoked the (fake) AI client exactly once");
      ok(JSON.stringify(generated) === JSON.stringify(storedAnalysis), "helper returns the parsed analysis");

      // 5. Share payload now serves the EXACT stored copy; the internal
      //    cache section never leaks into the served sections list.
      {
        const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
        ok(r.status === 200, "share fetch after AI cache store → 200");
        const body: any = await r.json();
        ok(
          JSON.stringify(body?.seasonalTrends?.aiAnalysis) === JSON.stringify(storedAnalysis),
          "anonymous share serves the exact stored AI commentary",
        );
        const leaked = (body?.sections ?? []).some(
          (s: any) => s?.sectionKey === SEASONAL_TRENDS_AI_SECTION_KEY,
        );
        ok(!leaked, "internal seasonalTrendsAi cache section is stripped from served sections");
        ok(aiCalls === 1, "anonymous share fetch triggered no additional AI calls");
      }

      // 6. Failing AI client → returns null, stores nothing, never
      //    clobbers the previously stored good copy.
      {
        const failing: TrendAnalysisChatClient = {
          chat: { completions: { create: async () => { throw new Error("task-4240 forced AI failure"); } } },
        };
        const out = await generateAndStoreSeasonalTrendAiAnalysis({
          reportId: REPORT_ID,
          practiceAreas: ["Estate Planning"],
          openaiClient: failing,
        });
        ok(out === null, "failed generation returns null");
        const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
        const body: any = await r.json();
        ok(
          JSON.stringify(body?.seasonalTrends?.aiAnalysis) === JSON.stringify(storedAnalysis),
          "failed regeneration never clobbers the stored good copy",
        );
      }
    }

    // 3. The authenticated trends route stays closed to anonymous callers.
    {
      const r = await fetch(`${baseUrl}/api/trends/practice-areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ practiceAreas: ["Estate Planning"] }),
      });
      ok(r.status === 401, `anonymous POST /api/trends/practice-areas stays 401 (got ${r.status})`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }

  console.log(`\nTask #4210 share seasonal trends: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exitCode = 1;
});
