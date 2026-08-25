/* test-registration
{
  "name": "Prod action: seasonal-trend AI commentary backfill (Task #4252)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~3s) and deterministic under the hermetic per-run test DB (isolated schema, fake injected AI client — no vendor call), guarding the prod-action registration + candidate predicate + drain convergence for the Task #4252 backfill.",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
/**
 * Task #4252 — coverage for `backfill_seasonal_trend_ai_commentary`, the
 * prod action that generates the cached `seasonalTrendsAi` report section
 * (Task #4240 finalize-path cache) for reports finalized + shared BEFORE
 * that change existed.
 *
 * Scenarios (everything inside ONE runInIsolatedSchema so no writes touch
 * public and the live workflow's workers can't race the drain):
 *
 *   (1) Candidate predicate — exactly the report that is status='final'
 *       AND has a share_token AND whose client has practice areas AND is
 *       missing the section qualifies; four negative controls (draft,
 *       unshared, no-practice-areas, already-has-section) do not.
 *   (2) status() reads pending naming the count; apply() drains with a
 *       FAKE injected chat client (no vendor call); after the drain the
 *       candidate report has a stored section whose data round-trips
 *       through readStoredSeasonalTrendAiAnalysis, attributed to
 *       SEASONAL_TRENDS_AI_EDITOR / source 'system' with a history row.
 *   (3) Convergence on failure — with a client whose completion call
 *       throws (vendor outage), the drain still terminates (failed row counted as
 *       a `skipped` unit, nothing written) and the audit row records the
 *       tally; re-status stays pending (a later press retries).
 *   (4) Idempotency — once the section exists, status() is not-needed and
 *       a re-press reports not-needed (nothing-to-do drain, no audit row
 *       double-write).
 *
 * The fake client is injected via
 * `__setSeasonalTrendAiBackfillClientOverrideForTest` (module-seam
 * mutation — ESM live-binding patching doesn't work under tsx) and always
 * restored in a finally.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import {
  findSeasonalTrendAiBackfillCandidates,
  __setSeasonalTrendAiBackfillClientOverrideForTest,
} from "../server/services/seasonalTrendAiBackfill";
import {
  SEASONAL_TRENDS_AI_SECTION_KEY,
  SEASONAL_TRENDS_AI_EDITOR,
  readStoredSeasonalTrendAiAnalysis,
  type TrendAnalysisChatClient,
} from "../server/services/practiceAreaTrendAnalysis";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "backfill_seasonal_trend_ai_commentary";
const TAG = `t4252-${Math.random().toString(36).slice(2, 8)}`;

// Every table the drain path touches: candidates query (reports ⋈ clients,
// NOT EXISTS report_sections), deterministic trend computation
// (practice_area_settings), audited section upsert (report_sections +
// report_section_history), and the drain's audit row (prod_action_runs).
const TABLES = [
  "clients",
  "reports",
  "report_sections",
  "report_section_history",
  "practice_area_settings",
  "prod_action_runs",
] as const;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function getAction() {
  const a = PROD_ACTIONS.find((x) => x.id === ACTION_ID);
  assert(a, `registry must contain ${ACTION_ID}`);
  return a!;
}

async function awaitDrain(timeoutMs = 30_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(ACTION_ID);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drain did not finish within ${timeoutMs}ms: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fake chat client returning a well-formed analysis for the given areas. */
function fakeClient(areas: string[]): TrendAnalysisChatClient {
  const body: Record<string, unknown> = {};
  for (const area of [...areas, "Combined Average"]) {
    body[area] = {
      currentPosition: [`Position: ${area} demand index sits at 90 of 100.`],
      demandShapeAhead: [`Slope: next 3 months hold within 5 points of 90.`],
    };
  }
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
      },
    },
  };
}

/** Fake client whose completion call throws → generation returns null. */
const brokenClient: TrendAnalysisChatClient = {
  chat: {
    completions: {
      create: async () => {
        throw new Error("simulated vendor outage (test)");
      },
    },
  },
};

async function main(): Promise<void> {
  const AREAS = ["Personal Injury"];
  await runInIsolatedSchema(
    async ({ db }) => {
      __resetDrainsForTest();
      const rows = async (q: any): Promise<any[]> =>
        ((await db.execute(q)) as any).rows ?? [];

      // ── Seed ────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, practice_areas)
        VALUES (${`${TAG}-c-areas`}, ${`${TAG} Firm A`}, ARRAY['Personal Injury']::text[]),
               (${`${TAG}-c-none`}, ${`${TAG} Firm B`}, ARRAY[]::text[])
      `);
      await db.execute(sql`
        INSERT INTO reports (id, client_id, report_month, status, share_token)
        VALUES
          (${`${TAG}-r-cand`},   ${`${TAG}-c-areas`}, '2026-01', 'final', ${`${TAG}-tok-cand`}),
          (${`${TAG}-r-draft`},  ${`${TAG}-c-areas`}, '2026-02', 'draft', ${`${TAG}-tok-draft`}),
          (${`${TAG}-r-notok`},  ${`${TAG}-c-areas`}, '2026-03', 'final', NULL),
          (${`${TAG}-r-noarea`}, ${`${TAG}-c-none`},  '2026-01', 'final', ${`${TAG}-tok-noarea`}),
          (${`${TAG}-r-has`},    ${`${TAG}-c-areas`}, '2026-04', 'final', ${`${TAG}-tok-has`})
      `);
      await db.execute(sql`
        INSERT INTO report_sections (id, report_id, section_key, data)
        VALUES (${`${TAG}-s-has`}, ${`${TAG}-r-has`}, ${SEASONAL_TRENDS_AI_SECTION_KEY},
                ${JSON.stringify({ aiAnalysis: { "Personal Injury": { currentPosition: ["x 1"], demandShapeAhead: ["y 2"] } } })}::jsonb)
      `);

      // ── (1) Candidate predicate ────────────────────────────────────
      const cands = await findSeasonalTrendAiBackfillCandidates(db as any);
      const mine = cands.filter((c) => c.reportId.startsWith(TAG));
      assert.equal(mine.length, 1, `expected 1 candidate, got ${JSON.stringify(mine)}`);
      assert.equal(mine[0].reportId, `${TAG}-r-cand`);
      assert.deepEqual(mine[0].practiceAreas, AREAS);
      ok("candidate predicate: final+shared+areas+missing-section only");

      const action = getAction();
      assert.deepEqual(action.convergence, { kind: "converging" });

      // ── (3) Failure path first: broken AI ⇒ skipped, drain converges ─
      __setSeasonalTrendAiBackfillClientOverrideForTest(brokenClient);
      let st = await action.status();
      assert.equal(st.state, "pending", st.detail);
      assert(st.detail.includes("1 finalized shared report(s)"), st.detail);
      let out = await action.apply(null);
      assert.equal(out.state, "applied", JSON.stringify(out));
      let drain = await awaitDrain();
      assert.equal(drain.processed, 1);
      assert.equal(drain.perKey.skipped ?? 0, 1, JSON.stringify(drain.perKey));
      assert.equal(
        (await rows(sql`SELECT 1 FROM report_sections WHERE report_id = ${`${TAG}-r-cand`}`)).length,
        0,
        "failed generation must write nothing",
      );
      st = await action.status();
      assert.equal(st.state, "pending", "failed row stays pending for a later press");
      ok("AI failure: counted as skipped, drain terminates, nothing written, still pending");

      // ── (2) Success path ───────────────────────────────────────────
      __resetDrainsForTest();
      __setSeasonalTrendAiBackfillClientOverrideForTest(fakeClient(AREAS));
      out = await action.apply(null);
      assert.equal(out.state, "applied", JSON.stringify(out));
      drain = await awaitDrain();
      assert.equal(drain.processed, 1);
      assert.equal(drain.perKey.generated ?? 0, 1, JSON.stringify(drain.perKey));

      const [section] = await rows(sql`
        SELECT data, last_edited_by, last_edit_source
        FROM report_sections
        WHERE report_id = ${`${TAG}-r-cand`} AND section_key = ${SEASONAL_TRENDS_AI_SECTION_KEY}
      `);
      assert(section, "section row must exist after the drain");
      assert.equal(section.last_edited_by, SEASONAL_TRENDS_AI_EDITOR);
      assert.equal(section.last_edit_source, "system");
      const analysis = readStoredSeasonalTrendAiAnalysis(section.data);
      assert(analysis, "stored data must round-trip through the share-path reader");
      assert(analysis!["Personal Injury"], JSON.stringify(analysis));
      const [hist] = await rows(sql`
        SELECT edited_by FROM report_section_history
        WHERE report_id = ${`${TAG}-r-cand`} AND section_key = ${SEASONAL_TRENDS_AI_SECTION_KEY}
      `);
      assert(hist, "audited upsert must record a history row");
      const [audit] = await rows(sql`
        SELECT outcome_state, rows_affected FROM prod_action_runs
        WHERE action_id = ${ACTION_ID}
        ORDER BY applied_at DESC LIMIT 1
      `);
      assert(audit, "drain must write a prod_action_runs audit row");
      assert.equal(audit.outcome_state, "applied");
      ok("success: section generated+stored via audited upsert, share-path readable, audited");

      // ── (4) Idempotency / settled state ────────────────────────────
      st = await action.status();
      assert.equal(st.state, "not-needed", st.detail);
      __resetDrainsForTest();
      out = await action.apply(null);
      assert.equal(out.state, "not-needed", "re-press on settled state must be a no-op");
      ok("settled: status not-needed, re-press not-needed");
    },
    { tables: [...TABLES] },
  );
}

main()
  .then(() => {
    __setSeasonalTrendAiBackfillClientOverrideForTest(null);
    console.log(`\nPASS — ${passed} scenario(s)`);
    process.exit(0);
  })
  .catch((err) => {
    __setSeasonalTrendAiBackfillClientOverrideForTest(null);
    console.error("FAIL:", err);
    process.exit(1);
  });
