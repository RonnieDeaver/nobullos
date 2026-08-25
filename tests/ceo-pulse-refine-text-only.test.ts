/* test-registration
{
  "name": "CEO Pulse refine text-only narrative + numbers (Task #2144)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2144 — end-to-end coverage for the text-only (graphs-DISABLED)
 * branch of the CEO Pulse "Refine This Visual" endpoint.
 *
 *   POST /api/ceo-pulses/:id/refine   (server/routes/reports.ts)
 *
 * When a pulse is configured with include_graphs = false, the refine
 * handler takes a separate branch (the `!graphsEnabled` block around lines
 * 890-906): it forces `charts` to `[]`, preserves/expands the richer
 * narrative fields `contextNarrative` (array of paragraphs) and
 * `byTheNumbers` (array of {label, value, source}), and ignores any chart
 * the AI returns. None of that text-only glue had end-to-end coverage, so
 * a regression could silently drop the narrative paragraphs or the numbers
 * list, or quietly start persisting charts on a text-only pulse.
 *
 * This test drives the REAL route with:
 *   - the OpenAI client mocked by overriding the shared singleton's
 *     `chat.completions.create` (the same `openai` object instance that
 *     `reports.ts` imports from `./middleware`), and
 *   - the chart-image generator stubbed out via a resolve-hook redirect
 *     (`ceoPulseChartImageSetup.mjs`) — text-only never generates chart
 *     images, but the stub keeps the harness identical to the other refine
 *     e2e tests and guards against an accidental image write.
 *
 * Coverage:
 *   (1) narrative expansion -> the AI's new contextNarrative paragraphs and
 *       byTheNumbers list are persisted — with contextNarrative capped at
 *       CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS (Task #4804: the report version
 *       is a brief, not a letter; over-cap AI output is truncated on write);
 *       no charts; clean success message
 *   (2) preservation on omission -> the AI returns NEITHER contextNarrative
 *       NOR byTheNumbers; the route falls back to the pulse's existing
 *       values so neither is dropped — and the preserved narrative is capped
 *       at CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS, so a legacy letter-length
 *       brief converges to the short form on any refine write (Task #4804)
 *   (3) chart request ignored -> even when the AI (wrongly) returns a chart
 *       on a text-only pulse, no chart is persisted, the narrative + numbers
 *       survive, and the message does not falsely claim a chart was added
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
import { CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS } from "../shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-text-only-ceo";
const TAG = "task-2144";

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

type Numbered = { label: string; value: string; source?: string };

function narrative(...paras: string[]): string[] {
  return paras;
}

function numbers(...rows: Numbered[]): Numbered[] {
  return rows;
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

      // Seed one graphs-DISABLED CEO Pulse the refine route can load.
      async function seedPulse(monthKey: string): Promise<string> {
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses (month_key, title, raw_content, include_graphs, created_by)
          VALUES (${monthKey}, ${"Pulse " + monthKey}, ${"Leads up 40% YoY (source: GA4). Revenue $1.2M (source: QuickBooks)."}, false, ${CEO_ID})
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

      // Read the persisted aiAnalysis straight from the DB so we assert on
      // what was actually saved, not just what the response echoed.
      async function readSaved(pulseId: string): Promise<any> {
        const res: any = await isoDb.execute(sql`
          SELECT ai_analysis FROM ceo_pulses WHERE id = ${pulseId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return rows[0]?.ai_analysis ?? {};
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) narrative expansion is persisted ────────────────────────
        {
          const pulseId = await seedPulse("2026-01");
          const current = {
            headline: "Original headline",
            keyTakeaways: [{ highlight: "Leads up", detail: "40% YoY" }],
            strategicImplications: [{ highlight: "Reallocate", detail: "shift spend" }],
            contextNarrative: narrative("Old paragraph one.", "Old paragraph two."),
            byTheNumbers: numbers({ label: "Leads", value: "+40%", source: "GA4" }),
          };
          const expandedNarrative = narrative(
            "Expanded paragraph one with mechanics and a source-cited stat and the revenue consequence spelled out for the CEO.",
            "Expanded paragraph two that deepens the context further with concrete numbers and the case-acquisition impact.",
            "Expanded paragraph three closing the loop on what to do next and why it matters to the bottom line.",
          );
          // Task #4804 — the report version is a brief, not a letter: the AI
          // deliberately returns MORE paragraphs than the cap here, and the
          // route must persist only the first CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS.
          const cappedNarrative = expandedNarrative.slice(0, CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS);
          assert.ok(
            expandedNarrative.length > CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS,
            "fixture stays over-cap so the truncation branch is actually exercised",
          );
          const expandedNumbers = numbers(
            { label: "Leads", value: "+40%", source: "GA4" },
            { label: "Revenue", value: "$1.2M", source: "QuickBooks" },
          );
          nextAIResponse = {
            analysis: {
              headline: "Expanded headline",
              keyTakeaways: current.keyTakeaways,
              strategicImplications: current.strategicImplications,
              contextNarrative: expandedNarrative,
              byTheNumbers: expandedNumbers,
            },
            message: "Expanded the narrative with more depth.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Expand the narrative with more detail and supporting context",
            currentAnalysis: current,
          });
          assert.equal(r.status, 200, "narrative-expansion refine → 200");

          // Response carries the expanded narrative + numbers, no charts.
          assert.deepEqual(
            r.body.analysis.contextNarrative,
            cappedNarrative,
            "response: expanded contextNarrative returned capped at the short-brief maximum",
          );
          assert.deepEqual(
            r.body.analysis.byTheNumbers,
            expandedNumbers,
            "response: expanded byTheNumbers returned",
          );
          assert.deepEqual(r.body.analysis.charts, [], "response: no charts on a text-only pulse");
          assert.equal(
            r.body.message,
            "Expanded the narrative with more depth.",
            `narrative expansion should return the clean AI message; got: ${r.body.message}`,
          );

          // Persisted state matches the response.
          const saved = await readSaved(pulseId);
          assert.deepEqual(
            saved.contextNarrative,
            cappedNarrative,
            "persisted: expanded contextNarrative capped at the short-brief maximum",
          );
          assert.deepEqual(
            saved.byTheNumbers,
            expandedNumbers,
            "persisted: expanded byTheNumbers",
          );
          assert.deepEqual(saved.charts, [], "persisted: no charts");
          console.log("  ok  (1) narrative expansion → contextNarrative capped at the short-brief max + byTheNumbers persisted, no charts");
        }

        // ── (2) preservation when the AI omits the rich fields ──────────
        {
          const pulseId = await seedPulse("2026-02");
          const current = {
            headline: "Headline to tweak",
            keyTakeaways: [{ highlight: "Leads up", detail: "40% YoY" }],
            strategicImplications: [{ highlight: "Reallocate", detail: "shift spend" }],
            // Legacy letter-length brief: 4 stored paragraphs, the same shape
            // as the live 2026-08 company-update brief this spec change targets.
            contextNarrative: narrative(
              "Existing paragraph one that must survive an unrelated edit.",
              "Existing paragraph two that must survive an unrelated edit.",
              "Legacy paragraph three that predates the short-brief spec.",
              "Legacy paragraph four that predates the short-brief spec.",
            ),
            byTheNumbers: numbers(
              { label: "Leads", value: "+40%", source: "GA4" },
              { label: "Revenue", value: "$1.2M", source: "QuickBooks" },
            ),
          };
          const preservedCapped = current.contextNarrative.slice(0, CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS);
          assert.ok(
            current.contextNarrative.length > CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS,
            "fixture stays over-cap so the fallback truncation branch is actually exercised",
          );
          // The AI returns ONLY the headline change and omits both rich
          // fields entirely — the route must fall back to the stored values,
          // with the narrative capped so legacy briefs converge on write.
          nextAIResponse = {
            analysis: {
              headline: "Sharper headline",
              keyTakeaways: current.keyTakeaways,
              strategicImplications: current.strategicImplications,
            },
            message: "Tightened the headline.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make the headline punchier",
            currentAnalysis: current,
          });
          assert.equal(r.status, 200, "headline-only refine → 200");

          assert.equal(r.body.analysis.headline, "Sharper headline", "headline updated");
          assert.deepEqual(
            r.body.analysis.contextNarrative,
            preservedCapped,
            "response: contextNarrative preserved capped at the short-brief maximum when AI omits it",
          );
          assert.deepEqual(
            r.body.analysis.byTheNumbers,
            current.byTheNumbers,
            "response: byTheNumbers preserved when AI omits it",
          );
          assert.deepEqual(r.body.analysis.charts, [], "response: still no charts");

          const saved = await readSaved(pulseId);
          assert.deepEqual(
            saved.contextNarrative,
            preservedCapped,
            "persisted: legacy 4-paragraph narrative converges to the capped form on an unrelated refine",
          );
          assert.deepEqual(
            saved.byTheNumbers,
            current.byTheNumbers,
            "persisted: byTheNumbers preserved (not dropped)",
          );
          assert.equal(saved.headline, "Sharper headline", "persisted: headline updated");
          console.log("  ok  (2) AI omits rich fields → stored narrative preserved capped at the short-brief max, byTheNumbers preserved");
        }

        // ── (3) chart request is ignored on a text-only pulse ───────────
        {
          const pulseId = await seedPulse("2026-03");
          const current = {
            headline: "Text-only headline",
            keyTakeaways: [{ highlight: "Leads up", detail: "40% YoY" }],
            strategicImplications: [{ highlight: "Reallocate", detail: "shift spend" }],
            contextNarrative: narrative(
              "Narrative paragraph that must not be lost when a chart is requested.",
            ),
            byTheNumbers: numbers({ label: "Revenue", value: "$1.2M", source: "QuickBooks" }),
          };
          // The AI ignores the text-only instruction and returns a chart.
          // The route must NOT persist it and must NOT relay a false success.
          nextAIResponse = {
            analysis: {
              headline: "Text-only headline",
              keyTakeaways: current.keyTakeaways,
              strategicImplications: current.strategicImplications,
              contextNarrative: current.contextNarrative,
              byTheNumbers: current.byTheNumbers,
              charts: [
                {
                  type: "bar",
                  title: "Lead Sources",
                  valueSuffix: "",
                  data: [
                    { label: "Google", value: 120 },
                    { label: "Bing", value: 30 },
                  ],
                },
              ],
            },
            message: "Added the lead sources chart!",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Add a bar chart of lead sources",
            currentAnalysis: current,
          });
          assert.equal(r.status, 200, "chart-request refine → 200");

          // No chart was persisted despite the AI returning one.
          assert.deepEqual(r.body.analysis.charts, [], "response: chart was NOT added to a text-only pulse");
          // The rich fields survived the chart request.
          assert.deepEqual(
            r.body.analysis.contextNarrative,
            current.contextNarrative,
            "response: contextNarrative survived the chart request",
          );
          assert.deepEqual(
            r.body.analysis.byTheNumbers,
            current.byTheNumbers,
            "response: byTheNumbers survived the chart request",
          );
          // The message must not relay the AI's false "chart added" claim.
          assert.doesNotMatch(
            r.body.message,
            /Added the lead sources chart!/,
            "must NOT relay the AI's false success message",
          );
          assert.ok(
            typeof r.body.message === "string" && r.body.message.length > 0,
            "a non-empty, sensible message is returned",
          );
          // The message explains charts are OFF for this brief — not the
          // misleading "values must be numeric" wording (Task #2164).
          assert.match(
            r.body.message,
            // "brief" since the NoBull Brief rename (was "pulse").
            /Charts are turned off for this brief, so nothing was added\./,
            "message explains charts are disabled for this brief",
          );
          assert.doesNotMatch(
            r.body.message,
            /values must be numeric/,
            "must NOT claim the numbers were the problem",
          );

          const saved = await readSaved(pulseId);
          assert.deepEqual(saved.charts, [], "persisted: no chart saved on a text-only pulse");
          assert.deepEqual(
            saved.contextNarrative,
            current.contextNarrative,
            "persisted: contextNarrative intact",
          );
          assert.deepEqual(
            saved.byTheNumbers,
            current.byTheNumbers,
            "persisted: byTheNumbers intact",
          );
          console.log("  ok  (3) chart request ignored → no chart persisted, narrative + numbers intact, honest message");
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
    console.log("ceo-pulse-refine-text-only: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-refine-text-only: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
