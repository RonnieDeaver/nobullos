/* test-registration
{
  "name": "Company-update NoBull Brief generation spec (Tasks #4813 + #4834 + #4984) — analyze + refine prompts switch to announcement shape for edition='company_update' text-only briefs (initiative names + one-liners capped at 16 words + optional status chip, short commitment statements) while market-shift text-only keeps the denser-brief spec verbatim; server-side normalization slices both routes to the shared initiative/commitment caps and sanitizes the additive per-item status field; roadmap-template fields (supportingLine, per-takeaway category, why-this-matters lead + whyBullets, pullQuote) are extracted only in announcement mode with drop-never-truncate sanitation, omitted honestly when the CEO's text doesn't support them, preserved through refine when the AI omits or corrupts them, and never copied into market-shift/legacy analyses; Task #4984 retires beforeAfter/timeline — prompts never spec them, analyze never stores them even when the model still emits them, and refine actively drops the keys from legacy stored analyses so edited old briefs converge on the simplified snapshot → why-this-matters → pull-quote shape",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4813: fast (~2s) and deterministic under the hermetic per-run test DB (isolated schema, OpenAI singleton stubbed); pins the ONLY guard on the edition-aware generation branch — a silent regression here reverts company-update briefs to the market-analysis 'denser brief' spec on the CEO's next Analyze press (the exact wall-of-text bug this task fixed), or lets uncapped/unsanitized announcement arrays reach the stored aiAnalysis, and no other suite inspects these prompts or the announcement normalizers.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/ceoPulseChartImageSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4813 — the analyze and refine endpoints are edition-aware for
 * text-only company updates:
 *
 *   POST /api/ceo-pulses/:id/analyze   (server/routes/reports.ts)
 *   POST /api/ceo-pulses/:id/refine    (server/routes/reports.ts)
 *
 * A brief with edition='company_update' AND include_graphs=false is an
 * ANNOUNCEMENT ("here is what we're building because of what we've learned"),
 * not market analysis. For that combination only, the generation spec
 * switches to announcement shape:
 *   - keyTakeaways: one initiative per item — highlight = the initiative's
 *     NAME, detail = ONE line of at most 16 words, plus an OPTIONAL additive
 *     "status" field (a short stage chip like "Live now");
 *   - strategicImplications: short commitment statements (max 8-word
 *     highlight + optional 12-word amplifier), not reallocation analysis;
 *   - the old text-only "denser brief" rule (5-6 takeaways REQUIRED,
 *     18-32-word details, revenue-mechanics framing) must NOT appear;
 *   - "make it longer / add depth" refines deepen WITHIN the caps (depth
 *     belongs to the full letter).
 * Market-shift and legacy NULL-edition briefs must keep the existing spec
 * and normalization byte-for-byte.
 *
 * Server-side caps stay in lockstep with the prompts: announcement-mode
 * normalization slices keyTakeaways to CEO_PULSE_UPDATE_MAX_INITIATIVES,
 * strategicImplications to CEO_PULSE_UPDATE_MAX_COMMITMENTS, and keeps the
 * additive per-item "status" only when it is a non-empty string within
 * CEO_PULSE_UPDATE_STATUS_MAX_CHARS (dropped otherwise — never truncated).
 *
 * Harness: same shape as ceo-pulse-refine-text-only.test.ts — the REAL
 * routes with the OpenAI singleton's `create` replaced (recording its call
 * arguments so the assembled prompts can be asserted on), the chart-image
 * generator stubbed by resolve-hook, and all writes inside
 * runInIsolatedSchema so live workers never observe them.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import {
  CEO_PULSE_UPDATE_MAX_INITIATIVES,
  CEO_PULSE_UPDATE_MAX_COMMITMENTS,
  CEO_PULSE_UPDATE_STATUS_MAX_CHARS,
  CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS,
  CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS,
  CEO_PULSE_UPDATE_WHY_MAX_BULLETS,
  CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS,
  CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS,
  CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS,
} from "../shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-company-update-ceo";
const TAG = "task-4813";

// ── OpenAI mock (records call args so prompts can be asserted on) ──────
// `reports.ts` calls `openai.chat.completions.create(...)` on the singleton
// object exported from `./middleware`; ESM named bindings are read-only but
// the object is mutable, so replacing the method here reaches the routes.
let nextAIResponse: unknown = null;
let lastCreateArgs: any = null;
const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);
(openai.chat.completions as any).create = async (args: any) => {
  lastCreateArgs = args;
  return {
    choices: [{ message: { content: JSON.stringify(nextAIResponse) } }],
  };
};

/** Full prompt text of the last OpenAI call (system + user joined). */
function lastPromptText(): string {
  const messages: Array<{ role: string; content: string }> = lastCreateArgs?.messages ?? [];
  return messages.map((m) => m.content).join("\n\n");
}

function lastSystemText(): string {
  const messages: Array<{ role: string; content: string }> = lastCreateArgs?.messages ?? [];
  return messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
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

// Over-cap announcement fixture: ONE more takeaway than the initiative cap
// and ONE more implication than the commitment cap, with every status-field
// disposition represented. (The real August 2026 prod draft is 6/5 — exactly
// at the caps — so a cap regression would silently pass with an at-cap
// fixture; this one actually exercises the slice.)
const overlongStatus = "S".repeat(CEO_PULSE_UPDATE_STATUS_MAX_CHARS + 1);
function overCapTakeaways(): any[] {
  const items: any[] = [
    { highlight: "Review Velocity System", detail: "Automates the ask cadence for every closed matter.", status: "  In beta  " },
    { highlight: "Team Powered Ask System", detail: "Turns every staff touchpoint into a review ask.", status: overlongStatus },
    { highlight: "Company Roadmap visibility", detail: "Publishes what ships next so clients can follow along.", status: 42 },
    "Book relaunch alignment as a plain legacy string item",
    { highlight: "Client feedback as an input", detail: "Feeds client asks straight into the build queue." },
    { highlight: "Review-driven first impressions", detail: "Makes the first search result match the work." },
  ];
  while (items.length < CEO_PULSE_UPDATE_MAX_INITIATIVES + 1) {
    items.push({ highlight: `Overflow initiative ${items.length}`, detail: "Should be sliced away." });
  }
  return items;
}
function overCapImplications(): any[] {
  const items: any[] = [];
  while (items.length < CEO_PULSE_UPDATE_MAX_COMMITMENTS + 1) {
    items.push({ highlight: `Commitment ${items.length + 1}`, detail: "Short amplifier." });
  }
  return items;
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
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
      });

      // Seed a graphs-DISABLED pulse with an explicit edition (NULL for the
      // legacy control). raw_content is >50 chars and URL-free so analyze
      // never fetches anything.
      async function seedPulse(monthKey: string, edition: string | null): Promise<string> {
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses (month_key, title, raw_content, include_graphs, edition, created_by)
          VALUES (
            ${monthKey},
            ${"Pulse " + monthKey},
            ${"We are building the Review Velocity System, the Team Powered Ask System, and an open company roadmap so clients can follow along weekly."},
            false,
            ${edition},
            ${CEO_ID}
          )
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

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
        // ── (1) analyze prompt — announcement spec for company_update ────
        {
          const pulseId = await seedPulse("2026-04", "company_update");
          nextAIResponse = {
            headline: "Building around reviews",
            keyTakeaways: [{ highlight: "Review Velocity System", detail: "Automates the ask cadence." }],
            strategicImplications: [{ highlight: "You get more reviews", detail: "with less chasing." }],
            contextNarrative: ["We keep hearing the same lesson from client feedback."],
            byTheNumbers: [],
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, `announcement analyze → 200 (got ${r.status}: ${JSON.stringify(r.body)})`);

          const prompt = lastPromptText();
          // Announcement extraction spec present…
          assert.ok(
            prompt.includes(`KEY TAKEAWAYS — WHAT WE'RE BUILDING (3-${CEO_PULSE_UPDATE_MAX_INITIATIVES} items, one per initiative)`),
            "analyze prompt: initiative-shaped takeaway section (cap in lockstep with the shared constant)",
          );
          assert.ok(prompt.includes("AT MOST 16 words"), "analyze prompt: one-liner detail cap");
          assert.ok(
            prompt.includes(`STRATEGIC IMPLICATIONS — WHAT THIS MEANS FOR YOU (3-${CEO_PULSE_UPDATE_MAX_COMMITMENTS} items)`),
            "analyze prompt: commitment-shaped implication section",
          );
          assert.ok(
            prompt.includes("TEXT-ONLY COMPANY UPDATE (announcement, not analysis)"),
            "analyze prompt: announcement variant of the text-only section",
          );
          assert.ok(
            prompt.includes('"status": "optional stage like Live now'),
            "analyze prompt: OUTPUT FORMAT documents the additive optional status field",
          );
          assert.ok(
            prompt.includes("What we're building, What it does for the reader, Why we're building it now"),
            "analyze prompt: announcement master constraint",
          );
          // …and the market-analysis "denser brief" spec absent.
          assert.ok(!prompt.includes("5-6 items REQUIRED"), "analyze prompt: no denser-brief takeaway rule");
          assert.ok(!prompt.includes("Produce a fuller, denser brief"), "analyze prompt: no denser-brief section");
          assert.ok(!prompt.includes("18-32 words"), "analyze prompt: no market-brief detail length rule");
          assert.ok(!prompt.includes("Where money is made"), "analyze prompt: no market master constraint");

          const system = lastSystemText();
          assert.ok(system.includes("company update announcement"), "system message: announcement extraction role");
          assert.ok(!system.includes("capital allocation"), "system message: no revenue-mechanics/capital-allocation forcing");
          console.log("  ok  (1) analyze prompt: announcement spec for text-only company updates (denser-brief spec absent)");
        }

        // ── (2) analyze prompt — market_shift text-only keeps the old spec ─
        {
          const pulseId = await seedPulse("2026-05", "market_shift");
          nextAIResponse = {
            headline: "Search is consolidating",
            keyTakeaways: [{ highlight: "AI referrals", detail: "grew 2x per GA4, shifting where demand originates." }],
            strategicImplications: [{ highlight: "Reallocate", detail: "spend toward retrieval-friendly content." }],
            contextNarrative: ["Paragraph."],
            byTheNumbers: [],
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, "market-shift analyze → 200");

          const prompt = lastPromptText();
          assert.ok(prompt.includes("5-6 items REQUIRED"), "market-shift keeps the denser-brief takeaway rule");
          assert.ok(prompt.includes("Produce a fuller, denser brief"), "market-shift keeps the denser-brief section");
          assert.ok(prompt.includes("Where money is made"), "market-shift keeps the market master constraint");
          assert.ok(!prompt.includes("WHAT WE'RE BUILDING"), "market-shift never sees the announcement takeaway section");
          assert.ok(!prompt.includes('"status": "optional stage'), "market-shift OUTPUT FORMAT has no status field");
          assert.ok(lastSystemText().includes("capital allocation"), "market-shift keeps the revenue-mechanics system message");
          console.log("  ok  (2) analyze prompt: market-shift text-only spec unchanged");
        }

        // ── (3) analyze normalization — caps + status sanitation ─────────
        {
          const pulseId = await seedPulse("2026-06", "company_update");
          nextAIResponse = {
            headline: "Building the next version",
            keyTakeaways: overCapTakeaways(),
            strategicImplications: overCapImplications(),
            contextNarrative: ["Why we're building this."],
            byTheNumbers: [],
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, "over-cap analyze → 200");

          const takeaways = r.body.analysis.keyTakeaways;
          assert.equal(
            takeaways.length,
            CEO_PULSE_UPDATE_MAX_INITIATIVES,
            `keyTakeaways sliced to the initiative cap (got ${takeaways.length})`,
          );
          assert.equal(
            r.body.analysis.strategicImplications.length,
            CEO_PULSE_UPDATE_MAX_COMMITMENTS,
            "strategicImplications sliced to the commitment cap",
          );
          // Status dispositions: valid → kept trimmed; over-cap length →
          // dropped (never truncated); non-string → dropped; absent → absent.
          assert.equal(takeaways[0].status, "In beta", "valid status kept, trimmed");
          assert.ok(!("status" in takeaways[1]), `status longer than ${CEO_PULSE_UPDATE_STATUS_MAX_CHARS} chars dropped whole`);
          assert.ok(!("status" in takeaways[2]), "non-string status dropped");
          assert.equal(takeaways[3], "Book relaunch alignment as a plain legacy string item", "string-form items pass through untouched");
          assert.ok(!("status" in takeaways[4]), "items without a status stay status-free");
          assert.equal(takeaways[1].highlight, "Team Powered Ask System", "sanitation strips ONLY the status field");
          assert.equal(takeaways[1].detail, "Turns every staff touchpoint into a review ask.", "detail untouched by sanitation");

          const saved = await readSaved(pulseId);
          assert.deepEqual(saved.keyTakeaways, takeaways, "persisted takeaways match the response");
          assert.equal(saved.strategicImplications.length, CEO_PULSE_UPDATE_MAX_COMMITMENTS, "persisted implications capped");
          assert.deepEqual(saved.charts, [], "text-only: no charts persisted");
          console.log("  ok  (3) analyze normalization: 7→6 / 6→5 slices + status sanitation persisted");
        }

        // ── (4) analyze normalization control — market_shift NOT capped ──
        {
          const pulseId = await seedPulse("2026-07", "market_shift");
          nextAIResponse = {
            headline: "Control",
            keyTakeaways: overCapTakeaways(),
            strategicImplications: overCapImplications(),
            contextNarrative: ["Paragraph."],
            byTheNumbers: [],
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, "market-shift over-cap analyze → 200");
          assert.equal(
            r.body.analysis.keyTakeaways.length,
            CEO_PULSE_UPDATE_MAX_INITIATIVES + 1,
            "market-shift takeaways NOT sliced by the announcement cap",
          );
          assert.equal(
            r.body.analysis.strategicImplications.length,
            CEO_PULSE_UPDATE_MAX_COMMITMENTS + 1,
            "market-shift implications NOT sliced",
          );
          assert.equal(
            r.body.analysis.keyTakeaways[0].status,
            "  In beta  ",
            "market-shift status field passes through EXACTLY as returned (no sanitation)",
          );
          console.log("  ok  (4) market-shift normalization unchanged (no caps, no status sanitation)");
        }

        // ── (5) refine — announcement FORMAT RULES + depth rule + caps ───
        {
          const pulseId = await seedPulse("2026-09", "company_update");
          // Stored/current analysis is OVER the caps with sanitizable
          // statuses — the AI omits both arrays, so the route falls back to
          // currentAnalysis and the announcement normalizer must still cap +
          // sanitize the preserved arrays.
          const current = {
            headline: "Building the next version",
            keyTakeaways: overCapTakeaways(),
            strategicImplications: overCapImplications(),
            contextNarrative: ["Why paragraph one.", "Why paragraph two."],
            byTheNumbers: [],
          };
          nextAIResponse = {
            analysis: { headline: "Sharper announcement headline" },
            message: "Tightened the headline.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make it longer with more depth and context",
            currentAnalysis: current,
          });
          assert.equal(r.status, 200, `announcement refine → 200 (got ${r.status}: ${JSON.stringify(r.body)})`);

          const prompt = lastPromptText();
          assert.ok(prompt.includes("COMPANY UPDATE (ANNOUNCEMENT) MODE"), "refine prompt: announcement mode section");
          assert.ok(prompt.includes("AT MOST 16 words"), "refine prompt: one-liner cap survives edits");
          assert.ok(
            prompt.includes("deepen WITHIN these caps"),
            "refine prompt: 'make it longer' deepens within caps (depth belongs to the letter)",
          );
          assert.ok(
            prompt.includes(`3-${CEO_PULSE_UPDATE_MAX_INITIATIVES} items — one per initiative`),
            "refine prompt: takeaway FORMAT RULE in lockstep with the initiative cap",
          );
          assert.ok(
            prompt.includes('"status" (at most 3 words'),
            "refine prompt: optional status clause",
          );
          assert.ok(
            !prompt.includes("text-only mode requires a denser brief"),
            "refine prompt: denser-brief rule absent in announcement mode",
          );

          // Fallback arrays (AI omitted them) are capped + sanitized.
          const takeaways = r.body.analysis.keyTakeaways;
          assert.equal(r.body.analysis.headline, "Sharper announcement headline", "headline updated");
          assert.equal(takeaways.length, CEO_PULSE_UPDATE_MAX_INITIATIVES, "preserved takeaways capped on refine write");
          assert.equal(
            r.body.analysis.strategicImplications.length,
            CEO_PULSE_UPDATE_MAX_COMMITMENTS,
            "preserved implications capped on refine write",
          );
          assert.equal(takeaways[0].status, "In beta", "valid status survives the refine fallback, trimmed");
          assert.ok(!("status" in takeaways[1]), "over-long status dropped on refine too");
          assert.deepEqual(r.body.analysis.charts, [], "text-only: still no charts");

          const saved = await readSaved(pulseId);
          assert.deepEqual(saved.keyTakeaways, takeaways, "persisted refine takeaways match response");
          assert.equal(saved.strategicImplications.length, CEO_PULSE_UPDATE_MAX_COMMITMENTS, "persisted refine implications capped");
          console.log("  ok  (5) refine: announcement FORMAT RULES + depth-within-caps + fallback arrays capped/sanitized");
        }

        // ── (6) refine control — market_shift keeps the denser-brief rules ─
        {
          const pulseId = await seedPulse("2026-10", "market_shift");
          const current = {
            headline: "Market headline",
            keyTakeaways: overCapTakeaways(),
            strategicImplications: overCapImplications(),
            contextNarrative: ["Paragraph."],
            byTheNumbers: [],
          };
          nextAIResponse = {
            analysis: { headline: "Sharper market headline" },
            message: "Tightened.",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Make the headline punchier",
            currentAnalysis: current,
          });
          assert.equal(r.status, 200, "market-shift refine → 200");

          const prompt = lastPromptText();
          assert.ok(
            prompt.includes("text-only mode requires a denser brief"),
            "market-shift refine keeps the denser-brief FORMAT RULE",
          );
          assert.ok(!prompt.includes("ANNOUNCEMENT"), "market-shift refine never sees announcement mode");
          assert.equal(
            r.body.analysis.keyTakeaways.length,
            CEO_PULSE_UPDATE_MAX_INITIATIVES + 1,
            "market-shift refine fallback NOT capped",
          );
          assert.equal(
            r.body.analysis.keyTakeaways[0].status,
            "  In beta  ",
            "market-shift refine leaves status fields untouched",
          );
          console.log("  ok  (6) refine: market-shift text-only spec + normalization unchanged");
        }

        // ── (7) Task #4834/#4984 — analyze extracts + sanitizes the roadmap fields ─
        // Messy fixture exercises every sanitizer branch: whitespace trims,
        // over-cap drops (never truncates), non-string drops, one extra
        // why-bullet past the count cap — plus retired beforeAfter/timeline
        // values a stale model might still emit, which must never be stored
        // (Task #4984 removed those sections outright).
        {
          const pulseId = await seedPulse("2026-11", "company_update");
          nextAIResponse = {
            headline: "Reviews now drive the build queue",
            keyTakeaways: [
              { highlight: "Review Velocity System", detail: "Automates the ask cadence.", category: "  System  " },
              { highlight: "Team Powered Ask System", detail: "Turns touchpoints into asks.", category: "C".repeat(CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS + 1) },
              { highlight: "Company Roadmap visibility", detail: "Publishes what ships next.", category: 42 },
              { highlight: "Client feedback input", detail: "Feeds asks into the queue." },
            ],
            strategicImplications: [{ highlight: "You get more reviews", detail: "with less chasing." }],
            contextNarrative: ["Problem paragraph.", "Address paragraph.", "Expect paragraph.", "Fourth paragraph beyond the why cap."],
            byTheNumbers: [],
            supportingLine: "  Because reviews decide who gets the first call.  ",
            whyBullets: [
              "  Manual review chasing used to eat hours; the cadence now runs itself.  ",
              "",
              "B".repeat(CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS + 1),
              42,
              "Every closed matter gets an ask with a clear owner.",
              "Team asks launch next, then the public roadmap page.",
              "Reviews decide who gets the first call.",
              "First impressions start at the first search result.",
              "Sixth valid bullet past the count cap.",
            ],
            // Retired fields (Task #4984) — perfectly valid-shaped on purpose:
            // the write site must ignore them entirely, not sanitize them.
            beforeAfter: {
              before: ["Manual review chasing", "Ad-hoc asks"],
              after: ["Automated cadence", "Clear ownership"],
            },
            timeline: [{ phase: "now", title: "Velocity system beta" }],
            pullQuote: "  Reviews are the new first impression.  ",
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, `roadmap analyze → 200 (got ${r.status}: ${JSON.stringify(r.body)})`);

          // Prompt carries the roadmap extraction spec (announcement arm only).
          const prompt = lastPromptText();
          assert.ok(prompt.includes("5. ROADMAP SECTIONS"), "analyze prompt: roadmap sections block present");
          assert.ok(
            prompt.includes("6-10 words — a short, outcome-focused statement"),
            "analyze prompt: announcement headline spec (6-10 word outcome statement)",
          );
          assert.ok(prompt.includes("WHY THIS MATTERS lead"), "analyze prompt: contextNarrative respec'd as the single short lead");
          assert.ok(prompt.includes("EXACTLY ONE short paragraph"), "analyze prompt: lead is one short paragraph (Task #4984 brevity)");
          assert.ok(!prompt.includes("150-200 words TOTAL"), "analyze prompt: old multi-paragraph word budget retired");
          assert.ok(prompt.includes('"whyBullets"'), "analyze prompt: whyBullets spec present");
          assert.ok(
            prompt.includes("old-friction-to-improvement contrast"),
            "analyze prompt: bullets may absorb the retired contrast/what's-ahead content (only when supported)",
          );
          assert.ok(prompt.includes('OPTIONAL field "category"'), "analyze prompt: per-takeaway category clause");
          assert.ok(prompt.includes('category="System"'), "analyze prompt: GOOD example carries a category");
          assert.ok(
            prompt.includes("NEVER invent content to fill a section"),
            "analyze prompt: omission-honesty instruction",
          );
          assert.ok(prompt.includes('"supportingLine"'), "analyze prompt: OUTPUT FORMAT documents supportingLine");
          assert.ok(prompt.includes('"pullQuote"'), "analyze prompt: OUTPUT FORMAT documents pullQuote");
          // Task #4984 — the retired sections vanish from the spec entirely
          // (analyze prompts embed only raw content, so bare-word checks are
          // safe here, unlike the refine prompt which embeds stored JSON).
          assert.ok(!prompt.includes("beforeAfter"), "analyze prompt: no beforeAfter spec or output line");
          assert.ok(!prompt.includes('"timeline"'), "analyze prompt: no timeline output line");
          assert.ok(!prompt.includes('"now" | "next" | "soon"'), "analyze prompt: no timeline phase spec");

          const analysis = r.body.analysis;
          assert.equal(analysis.supportingLine, "Because reviews decide who gets the first call.", "supportingLine trimmed + kept");
          assert.equal(analysis.pullQuote, "Reviews are the new first impression.", "pullQuote trimmed + kept");
          assert.deepEqual(
            analysis.whyBullets,
            [
              "Manual review chasing used to eat hours; the cadence now runs itself.",
              "Every closed matter gets an ask with a clear owner.",
              "Team asks launch next, then the public roadmap page.",
              "Reviews decide who gets the first call.",
              "First impressions start at the first search result.",
            ],
            `whyBullets: trimmed, empty/non-string dropped, over-${CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS}-char bullet dropped WHOLE (never truncated), sliced to ${CEO_PULSE_UPDATE_WHY_MAX_BULLETS}`,
          );
          assert.ok(!("beforeAfter" in analysis), "retired beforeAfter never stored even when the AI returns it");
          assert.ok(!("timeline" in analysis), "retired timeline never stored even when the AI returns it");
          const takeaways = analysis.keyTakeaways;
          assert.equal(takeaways[0].category, "System", "valid category kept, trimmed");
          assert.ok(!("category" in takeaways[1]), `category longer than ${CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS} chars dropped whole`);
          assert.ok(!("category" in takeaways[2]), "non-string category dropped");
          assert.ok(!("category" in takeaways[3]), "items without a category stay category-free");
          assert.equal(
            analysis.contextNarrative.length,
            CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS,
            "announcement contextNarrative sliced to the legacy why-paragraph cap (prompt now asks for ONE lead)",
          );

          const saved = await readSaved(pulseId);
          assert.equal(saved.supportingLine, analysis.supportingLine, "persisted supportingLine matches response");
          assert.deepEqual(saved.whyBullets, analysis.whyBullets, "persisted whyBullets match response");
          assert.ok(!("beforeAfter" in saved) && !("timeline" in saved), "persisted analysis carries neither retired key");
          assert.equal(saved.pullQuote, analysis.pullQuote, "persisted pullQuote matches response");
          assert.deepEqual(saved.keyTakeaways, takeaways, "persisted takeaways (with categories) match response");
          console.log("  ok  (7) analyze: roadmap fields extracted + sanitized (whyBullets capped), retired fields never stored");
        }

        // ── (8) Task #4834/#4984 — omission honesty + market-shift control ──────
        {
          // Company update whose AI response omits or corrupts every roadmap
          // field: nothing is stored — sections the text doesn't support stay
          // ABSENT (renderers fall back to the announcement layout), never
          // empty shells. The retired beforeAfter/timeline stay out even when
          // the AI emits perfectly valid-shaped values for them.
          const pulseId = await seedPulse("2026-12", "company_update");
          nextAIResponse = {
            headline: "Small update",
            keyTakeaways: [{ highlight: "One initiative", detail: "One line." }],
            strategicImplications: [{ highlight: "One commitment", detail: "Short." }],
            contextNarrative: ["Only paragraph."],
            byTheNumbers: [],
            supportingLine: "   ",
            whyBullets: ["", "W".repeat(CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS + 1), 42],
            beforeAfter: { before: ["Old state"], after: ["New state"] },
            timeline: [{ phase: "now", title: "A real-looking milestone" }],
            pullQuote: "Q".repeat(CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS + 1),
          };
          const r = await post(baseUrl, `/api/ceo-pulses/${pulseId}/analyze`, {});
          assert.equal(r.status, 200, "omission analyze → 200");
          for (const key of ["supportingLine", "whyBullets", "beforeAfter", "timeline", "pullQuote"]) {
            assert.ok(!(key in r.body.analysis), `invalid/blank/retired ${key} never stored (over-cap lines and bullets drop whole; retired keys drop always)`);
          }
          const saved = await readSaved(pulseId);
          for (const key of ["supportingLine", "whyBullets", "beforeAfter", "timeline", "pullQuote"]) {
            assert.ok(!(key in saved), `persisted analysis has no ${key} key`);
          }

          // Market-shift control: prompt never mentions the roadmap spec, and
          // roadmap fields returned by the AI are NOT copied into the stored
          // analysis (the market arm rebuilds it with explicit keys only).
          const marketId = await seedPulse("2027-03", "market_shift");
          nextAIResponse = {
            headline: "Market control headline",
            keyTakeaways: [{ highlight: "AI referrals", detail: "grew 2x per GA4.", category: "  Raw  " }],
            strategicImplications: [{ highlight: "Reallocate", detail: "spend now." }],
            contextNarrative: ["Paragraph."],
            byTheNumbers: [],
            supportingLine: "Should never be stored for market briefs.",
            whyBullets: ["Should never be stored for market briefs either."],
            beforeAfter: { before: ["Old"], after: ["New"] },
            timeline: [{ phase: "now", title: "Milestone" }],
            pullQuote: "Should never be stored either.",
          };
          const m = await post(baseUrl, `/api/ceo-pulses/${marketId}/analyze`, {});
          assert.equal(m.status, 200, "market control analyze → 200");
          const marketPrompt = lastPromptText();
          assert.ok(!marketPrompt.includes("5. ROADMAP SECTIONS"), "market prompt: no roadmap sections block");
          assert.ok(!marketPrompt.includes("6-10 words"), "market prompt: keeps the 10-18 word headline spec");
          assert.ok(!marketPrompt.includes('"supportingLine"'), "market prompt: OUTPUT FORMAT has no supportingLine");
          assert.ok(!marketPrompt.includes('"whyBullets"'), "market prompt: OUTPUT FORMAT has no whyBullets");
          assert.ok(!marketPrompt.includes('OPTIONAL field "category"'), "market prompt: no category clause");
          for (const key of ["supportingLine", "whyBullets", "beforeAfter", "timeline", "pullQuote"]) {
            assert.ok(!(key in m.body.analysis), `market analysis never carries ${key}`);
          }
          assert.equal(
            m.body.analysis.keyTakeaways[0].category,
            "  Raw  ",
            "market takeaway fields pass through EXACTLY as returned (no category sanitation)",
          );
          console.log("  ok  (8) omission honesty: unsupported roadmap fields stay absent; market-shift untouched");
        }

        // ── (9) Task #4834/#4984 — refine preserves the live roadmap fields
        //        and DROPS the retired ones (legacy rows converge on edit) ──
        {
          const pulseId = await seedPulse("2027-01", "company_update");
          // Legacy-shaped stored analysis: still carries beforeAfter/timeline
          // from before Task #4984, alongside current-shape whyBullets.
          const current = {
            headline: "Building the next version",
            keyTakeaways: [{ highlight: "Review Velocity System", detail: "Automates the ask cadence.", category: "System" }],
            strategicImplications: [{ highlight: "You get more reviews", detail: "with less chasing." }],
            contextNarrative: ["Why paragraph."],
            byTheNumbers: [],
            supportingLine: "Because reviews decide who gets the first call.",
            whyBullets: ["Reviews decide who gets the first call.", "The cadence now runs itself."],
            beforeAfter: { before: ["Manual chasing"], after: ["Automated cadence"] },
            timeline: [{ phase: "now", title: "Velocity beta", description: "Rolling out." }],
            pullQuote: "Reviews are the new first impression.",
          };

          // (9a) AI omits every roadmap key → live values preserved verbatim
          // (same convention as contextNarrative preservation) while the
          // retired keys are dropped from the write even though the stored
          // analysis still carries them — the Task #4984 convergence: any AI
          // edit of an old brief sheds beforeAfter/timeline.
          nextAIResponse = {
            analysis: { headline: "Sharper roadmap headline" },
            message: "Tightened the headline.",
          };
          const rA = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Punch up the headline",
            currentAnalysis: current,
          });
          assert.equal(rA.status, 200, `roadmap refine → 200 (got ${rA.status}: ${JSON.stringify(rA.body)})`);

          const promptA = lastPromptText();
          assert.ok(
            promptA.includes('ROADMAP FIELDS: PRESERVE the stored "supportingLine" and "pullQuote"'),
            "refine prompt: roadmap preservation clause (supportingLine + pullQuote only)",
          );
          assert.ok(
            promptA.includes('RETIRED FIELDS: "beforeAfter" and "timeline" no longer exist'),
            "refine prompt: names the retired fields and forbids returning them",
          );
          assert.ok(
            promptA.includes('PRESERVE the stored "whyBullets"'),
            "refine prompt: whyBullets preservation clause",
          );
          assert.ok(
            promptA.includes("CONVERT as part of this edit"),
            "refine prompt: paragraph-only legacy Why This Matters converts to lead + bullets on any edit",
          );
          assert.ok(promptA.includes('and an OPTIONAL "category"'), "refine prompt: category FORMAT RULE clause");
          assert.ok(
            promptA.includes('"supportingLine": "one sentence (omit when the material doesn\'t support it)"'),
            "refine prompt: OUTPUT FORMAT documents the roadmap keys",
          );
          assert.ok(promptA.includes('"whyBullets"'), "refine prompt: OUTPUT FORMAT documents whyBullets");
          // The refine prompt embeds the stored CURRENT ANALYSIS JSON (which
          // legitimately still contains the legacy keys) and the RETIRED
          // FIELDS clause names them — so assert the SPEC lines are gone
          // rather than the bare words.
          assert.ok(!promptA.includes('"beforeAfter": {"before"'), "refine prompt: beforeAfter output-shape line removed");
          assert.ok(!promptA.includes('"timeline": [{"phase"'), "refine prompt: timeline output-shape line removed");
          assert.equal(rA.body.analysis.headline, "Sharper roadmap headline", "headline updated");
          assert.equal(rA.body.analysis.supportingLine, current.supportingLine, "omitted supportingLine preserved from stored");
          assert.deepEqual(rA.body.analysis.whyBullets, current.whyBullets, "omitted whyBullets preserved from stored");
          assert.equal(rA.body.analysis.pullQuote, current.pullQuote, "omitted pullQuote preserved");
          assert.ok(!("beforeAfter" in rA.body.analysis), "retired beforeAfter dropped from the refined analysis");
          assert.ok(!("timeline" in rA.body.analysis), "retired timeline dropped from the refined analysis");
          const savedA = await readSaved(pulseId);
          assert.equal(savedA.supportingLine, current.supportingLine, "persisted supportingLine preserved");
          assert.deepEqual(savedA.whyBullets, current.whyBullets, "persisted whyBullets preserved");
          assert.ok(
            !("beforeAfter" in savedA) && !("timeline" in savedA),
            "persisted refine analysis sheds the retired keys — edited legacy rows converge",
          );

          // (9b) valid incoming values replace; INVALID incoming values fall
          // back to stored (drop-never-truncate + preserve-when-corrupt).
          nextAIResponse = {
            analysis: {
              headline: "Sharper roadmap headline",
              supportingLine: "A sharper reason, straight from client feedback.",
              whyBullets: ["Sharper bullet one.", "Sharper bullet two.", "Sharper bullet three."],
              pullQuote: "P".repeat(CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS + 1),
            },
            message: "Reworked the roadmap fields.",
          };
          const rB = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Rework the supporting line and the why bullets",
            currentAnalysis: current,
          });
          assert.equal(rB.status, 200, "roadmap refine (replace) → 200");
          assert.equal(
            rB.body.analysis.supportingLine,
            "A sharper reason, straight from client feedback.",
            "valid incoming supportingLine replaces the stored one",
          );
          assert.deepEqual(
            rB.body.analysis.whyBullets,
            ["Sharper bullet one.", "Sharper bullet two.", "Sharper bullet three."],
            "valid incoming whyBullets replace the stored ones",
          );
          assert.equal(
            rB.body.analysis.pullQuote,
            current.pullQuote,
            "over-cap incoming pullQuote is invalid → stored value preserved",
          );
          assert.ok(
            !("beforeAfter" in rB.body.analysis) && !("timeline" in rB.body.analysis),
            "retired keys stay dropped on replace-style refines too",
          );

          // (9b′) ALL-invalid incoming whyBullets → stored bullets preserved
          // (preserve-when-corrupt, same convention as the line fields).
          nextAIResponse = {
            analysis: {
              headline: "Sharper roadmap headline",
              whyBullets: ["", "W".repeat(CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS + 1)],
            },
            message: "Bullets went bad.",
          };
          const rB2 = await post(baseUrl, `/api/ceo-pulses/${pulseId}/refine`, {
            message: "Try the bullets again",
            currentAnalysis: current,
          });
          assert.equal(rB2.status, 200, "roadmap refine (corrupt bullets) → 200");
          assert.deepEqual(
            rB2.body.analysis.whyBullets,
            current.whyBullets,
            "all-invalid incoming whyBullets → stored bullets preserved",
          );

          // (9c) market-shift refine control: roadmap fields in CURRENT
          // ANALYSIS are NOT copied into the rebuilt market analysis.
          const marketId = await seedPulse("2027-02", "market_shift");
          nextAIResponse = {
            analysis: { headline: "Sharper market headline" },
            message: "Tightened.",
          };
          const rC = await post(baseUrl, `/api/ceo-pulses/${marketId}/refine`, {
            message: "Punch up the headline",
            currentAnalysis: { ...current, headline: "Market headline" },
          });
          assert.equal(rC.status, 200, "market refine control → 200");
          for (const key of ["supportingLine", "whyBullets", "beforeAfter", "timeline", "pullQuote"]) {
            assert.ok(!(key in rC.body.analysis), `market refine never copies ${key} from currentAnalysis`);
          }
          assert.ok(
            !lastPromptText().includes("ROADMAP FIELDS"),
            "market refine prompt: no roadmap preservation clause",
          );
          console.log("  ok  (9) refine: live fields preserved/replaced/corrupt-fallback, retired keys dropped (convergence); market untouched");
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

// Teardown in server/db.ts drains pg pools in test mode; no process.exit()
// so leaked handles surface as real hangs (same convention as the refine suite).
main().then(
  () => {
    console.log("ceo-pulse-company-update-generation: all sections passed");
  },
  (err) => {
    console.error("ceo-pulse-company-update-generation: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
