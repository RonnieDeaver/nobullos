/* test-registration
{
  "name": "Prod action: purge AI-authored slide verdicts (Task #4902)",
  "regression": true,
  "sweepOnlyReason": "Task #4902 — DB-heavy attribution + drain suite (runInIsolatedSchema: reports/report_sections/report_section_history/prod_action_runs, background-drain convergence polling). The client-facing invariants (finalize never drafts, retired lifetimeValue stripped from serves) already gate in SMOKE via report-slide-verdicts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4902 — one-press purge of AI-authored slide verdicts from existing
 * reports (owner mandate: no AI-invented advice on client-facing reports).
 *
 *   1. Pure attribution walk (`attributeSlideVerdicts`): the introducing
 *      write decides the author — whole-map editor autosaves that merely
 *      CARRY an AI value through unchanged are never the introducing write;
 *      retired/non-string keys → clear_retired; no introducing write →
 *      keep_unattributed.
 *   2. Storage writer (`storage.purgeSlideVerdictKeys`): per-key value-CAS —
 *      a stale expectedValue (operator edited since attribution) conflicts,
 *      clears nothing, appends NO history row; effective clears append one
 *      audited history row with the purge identity and the FULL previous
 *      data (recoverability).
 *   3. The registered action end-to-end in an isolated schema: status
 *      pending → apply (background drain) → poll to convergence →
 *      AI-introduced keys cleared, operator keys kept (including an
 *      operator save recorded with editSource "ai_format"), retired
 *      lifetimeValue cleared regardless of author, history-less values
 *      conservatively KEPT and reported; second status/apply → not-needed.
 *
 * Seeds section + history rows via raw SQL (pre-#4902 rows carrying
 * lifetimeValue cannot be produced by any live write path anymore).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { runInIsolatedSchema } from "./db-sandbox";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { storage } from "../server/storage";
import {
  SLIDE_VERDICT_PURGE_EDITOR,
  attributeSlideVerdicts,
} from "../server/services/slideVerdictPurge";
import { SLIDE_VERDICTS_AI_EDITOR } from "../server/services/slideVerdicts";

const TAG = `task4902-${Date.now()}`;
const CLIENT_ID = `${TAG}-client`;
const OPERATOR = `${TAG}-operator`;

const AI_ENGINE = "AI engine-health sentence that must be purged.";
const AI_SALES = "AI sales sentence that must be purged.";
const OP_INTAKE = "Operator intake line that must survive the purge.";
const OP_MARKETING = "Operator marketing line saved via Draft-with-AI apply.";
const OP_SALES_2 = "Operator rewrote the sales line — the rewrite stays.";
const LV_OPERATOR =
  "Average case nets $12,500 now — increase client value through defined upsell or retention offers.";
const MYSTERY = "No history row explains this line — conservatively kept.";

function action(id: string) {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  assert(a, `action ${id} must be registered`);
  return a!;
}

// ------------------------------------------------- 1. pure attribution walk
function attributionUnitTests(): void {
  const ai = (prev: unknown, next: unknown) => ({
    editedBy: SLIDE_VERDICTS_AI_EDITOR,
    previousData: prev,
    newData: next,
  });
  const op = (prev: unknown, next: unknown) => ({
    editedBy: OPERATOR,
    previousData: prev,
    newData: next,
  });
  const v = (verdicts: Record<string, unknown>) => ({ verdicts });

  // AI introduced sales; a LATER whole-map operator autosave carried the AI
  // value through unchanged (prev === new for that key) while adding intake.
  // Newest first: [operator autosave, AI fill]. sales must still attribute
  // to the AI (the autosave is not the introducing write), intake to the
  // operator.
  const decisions = attributeSlideVerdicts({ sales: AI_SALES, intake: OP_INTAKE }, [
    op(v({ sales: AI_SALES }), v({ sales: AI_SALES, intake: OP_INTAKE })),
    ai(v({}), v({ sales: AI_SALES })),
  ]);
  assert.deepEqual(
    decisions.find((d) => d.key === "sales"),
    { key: "sales", decision: "clear_ai", expectedValue: AI_SALES },
    "carry-through autosave never re-attributes an AI value to the operator",
  );
  assert.deepEqual(
    decisions.find((d) => d.key === "intake"),
    { key: "intake", decision: "keep_operator" },
    "the autosave IS the introducing write for the key it actually added",
  );

  // Operator OVERWROTE an AI value: the newest introducing write for the
  // CURRENT value is the operator's → kept.
  const overwrote = attributeSlideVerdicts({ sales: OP_SALES_2 }, [
    op(v({ sales: AI_SALES }), v({ sales: OP_SALES_2 })),
    ai(v({}), v({ sales: AI_SALES })),
  ]);
  assert.deepEqual(
    overwrote,
    [{ key: "sales", decision: "keep_operator" }],
    "operator rewrite of an AI line is kept",
  );

  // Retired key (any author) + non-string junk under a live key + no
  // introducing write.
  const misc = attributeSlideVerdicts(
    {
      lifetimeValue: LV_OPERATOR,
      next30Days: { nested: "junk" },
      marketContext: MYSTERY,
    },
    [op(v({}), v({ lifetimeValue: LV_OPERATOR }))],
  );
  assert.deepEqual(
    misc.find((d) => d.key === "lifetimeValue"),
    { key: "lifetimeValue", decision: "clear_retired" },
    "retired lifetimeValue clears regardless of author",
  );
  assert.deepEqual(
    misc.find((d) => d.key === "next30Days"),
    { key: "next30Days", decision: "clear_retired" },
    "non-string junk under a live key clears unconditionally",
  );
  assert.deepEqual(
    misc.find((d) => d.key === "marketContext"),
    { key: "marketContext", decision: "keep_unattributed" },
    "no introducing write → conservatively kept",
  );

  console.log("unit: attributeSlideVerdicts PASSED");
}

// --------------------------------------------------------------- DB harness
async function main(): Promise<void> {
  attributionUnitTests();

  await runInIsolatedSchema(
    async ({ db }) => {
      const one = async (q: any): Promise<any> =>
        (((await db.execute(q)) as any).rows ?? [])[0];

      const readVerdicts = async (reportId: string): Promise<Record<string, unknown> | null> => {
        const row = await one(sql`
          SELECT data FROM report_sections
          WHERE report_id = ${reportId} AND section_key = 'slideVerdicts' LIMIT 1
        `);
        return row?.data?.verdicts ?? null;
      };
      const historyCount = async (reportId: string): Promise<number> => {
        const row = await one(sql`
          SELECT count(*)::int AS n FROM report_section_history
          WHERE report_id = ${reportId} AND section_key = 'slideVerdicts'
        `);
        return Number(row?.n ?? 0);
      };

      // ── Seed ────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, products)
        VALUES (${CLIENT_ID}, ${`${TAG} Firm`}, ARRAY['gbp']::text[])
      `);
      // R1 pure-AI • R2 mixed AI+operator • R3 operator via ai_format •
      // R4 retired LV (operator-authored) + non-string junk • R5 operator
      // overwrote AI • R6 no history • R7 CAS-conflict lane (direct storage
      // call, excluded from the action run by clearing it first).
      const reportIds = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((s) => `${TAG}-${s}`);
      for (const [i, id] of reportIds.entries()) {
        await db.execute(sql`
          INSERT INTO reports (id, client_id, report_month, status)
          VALUES (${id}, ${CLIENT_ID}, ${`2026-0${i + 1}`}, 'final')
        `);
      }
      const seedSection = async (reportId: string, verdicts: Record<string, unknown>) => {
        await db.execute(sql`
          INSERT INTO report_sections (id, report_id, section_key, data)
          VALUES (${`${reportId}-sv`}, ${reportId}, 'slideVerdicts',
                  ${JSON.stringify({ verdicts, generatedAt: "2026-07-01T00:00:00.000Z" })}::jsonb)
        `);
      };
      const seedHistory = async (
        reportId: string,
        editedBy: string,
        editSource: string,
        previousData: unknown,
        newData: unknown,
        createdAt: string,
      ) => {
        await db.execute(sql`
          INSERT INTO report_section_history
            (report_id, section_key, previous_data, new_data, data_changed,
             edited_by, edit_source, created_at)
          VALUES (${reportId}, 'slideVerdicts',
                  ${previousData === null ? null : JSON.stringify(previousData)}::jsonb,
                  ${JSON.stringify(newData)}::jsonb, true,
                  ${editedBy}, ${editSource}, ${createdAt}::timestamptz)
        `);
      };
      const v = (verdicts: Record<string, unknown>) => ({ verdicts });

      // R1: finalize AI drafted both keys.
      await seedSection(reportIds[0], { engineHealth: AI_ENGINE, revenueLeak: AI_SALES });
      await seedHistory(
        reportIds[0], SLIDE_VERDICTS_AI_EDITOR, "system",
        null, v({ engineHealth: AI_ENGINE, revenueLeak: AI_SALES }), "2026-07-01T00:00:10Z",
      );

      // R2: operator wrote intake, then the AI fill added sales.
      await seedSection(reportIds[1], { intake: OP_INTAKE, sales: AI_SALES });
      await seedHistory(
        reportIds[1], OPERATOR, "ui_edit",
        v({}), v({ intake: OP_INTAKE }), "2026-07-01T00:00:05Z",
      );
      await seedHistory(
        reportIds[1], SLIDE_VERDICTS_AI_EDITOR, "system",
        v({ intake: OP_INTAKE }), v({ intake: OP_INTAKE, sales: AI_SALES }), "2026-07-01T00:00:20Z",
      );

      // R3: operator applied a Draft-with-AI sentence — saved under the
      // OPERATOR's id with editSource ai_format. Must be kept.
      await seedSection(reportIds[2], { marketing: OP_MARKETING });
      await seedHistory(
        reportIds[2], OPERATOR, "ai_format",
        v({}), v({ marketing: OP_MARKETING }), "2026-07-02T00:00:00Z",
      );

      // R4: OPERATOR-authored lifetimeValue (retired → cleared anyway) +
      // non-string junk under a live key + a healthy operator line.
      await seedSection(reportIds[3], {
        lifetimeValue: LV_OPERATOR,
        next30Days: { nested: "junk" },
        intake: OP_INTAKE,
      });
      await seedHistory(
        reportIds[3], OPERATOR, "ui_edit",
        v({}), v({ lifetimeValue: LV_OPERATOR, intake: OP_INTAKE }), "2026-07-03T00:00:00Z",
      );

      // R5: AI introduced sales, operator overwrote it later — rewrite stays.
      await seedSection(reportIds[4], { sales: OP_SALES_2 });
      await seedHistory(
        reportIds[4], SLIDE_VERDICTS_AI_EDITOR, "system",
        v({}), v({ sales: AI_SALES }), "2026-07-04T00:00:00Z",
      );
      await seedHistory(
        reportIds[4], OPERATOR, "ui_edit",
        v({ sales: AI_SALES }), v({ sales: OP_SALES_2 }), "2026-07-04T00:10:00Z",
      );

      // R6: stored value with NO history at all → kept + reported.
      await seedSection(reportIds[5], { marketContext: MYSTERY });

      // R7: CAS-conflict lane (direct storage-writer test, before the action
      // run so the drain never touches it with a live clear).
      await seedSection(reportIds[6], { engineHealth: "operator edited this since the scan" });

      // ── 2. storage writer CAS ───────────────────────────────────────
      const conflict = await storage.purgeSlideVerdictKeys(
        reportIds[6],
        "slideVerdicts",
        [{ key: "engineHealth", expectedValue: "stale attributed value" }],
        { editor: SLIDE_VERDICT_PURGE_EDITOR, source: "system" },
      );
      assert.deepEqual(
        conflict,
        { clearedKeys: [], conflictKeys: ["engineHealth"], changed: false },
        "stale expectedValue → conflict, nothing cleared",
      );
      assert.deepEqual(
        await readVerdicts(reportIds[6]),
        { engineHealth: "operator edited this since the scan" },
        "conflicted row is untouched",
      );
      assert.equal(
        await historyCount(reportIds[6]),
        0,
        "a no-op purge write appends NO history row",
      );
      // Clear R7 legitimately so the action's scan has nothing to do there
      // (its value has no history → would otherwise be kept + reported).
      const r7Fix = await storage.purgeSlideVerdictKeys(
        reportIds[6],
        "slideVerdicts",
        [{ key: "engineHealth", expectedValue: "operator edited this since the scan" }],
        { editor: SLIDE_VERDICT_PURGE_EDITOR, source: "system" },
      );
      assert.deepEqual(
        r7Fix,
        { clearedKeys: ["engineHealth"], conflictKeys: [], changed: true },
        "matching expectedValue clears",
      );
      assert.equal(await historyCount(reportIds[6]), 1, "effective clear appends ONE history row");
      const r7Hist = await one(sql`
        SELECT edited_by, edit_source, previous_data, new_data, data_changed
        FROM report_section_history
        WHERE report_id = ${reportIds[6]} AND section_key = 'slideVerdicts'
        ORDER BY created_at DESC LIMIT 1
      `);
      assert.equal(r7Hist.edited_by, SLIDE_VERDICT_PURGE_EDITOR, "history row carries purge identity");
      assert.equal(r7Hist.edit_source, "system", "history row carries system source");
      assert.equal(
        r7Hist.previous_data?.verdicts?.engineHealth,
        "operator edited this since the scan",
        "cleared copy stays recoverable verbatim from previousData",
      );
      assert.deepEqual(r7Hist.new_data?.verdicts, {}, "newData shows the cleared map");

      // ── 3. the registered action end-to-end ─────────────────────────
      const purge = action("purge_ai_authored_slide_verdicts");
      let st = await purge.status();
      assert.equal(st.state, "pending", `pre-run status pending, got ${st.state}: ${st.detail}`);
      // R1 (2 keys), R2 (1), R4 (2) carry clearable keys; R3/R5 keep-only,
      // R6 unattributed-only, R7 already emptied by the storage lane above.
      assert.ok(
        st.detail.includes("3 report(s) carry 5 AI-authored or retired-slot verdict key(s)"),
        `status names the exact candidate volume: ${st.detail}`,
      );

      const out = await purge.apply(null);
      assert.equal(out.state, "applied", `apply starts the drain, got ${out.state}: ${out.detail}`);

      // Poll the SIDE-EFFECT to convergence (drain runs in the background).
      const deadline = Date.now() + 20_000;
      for (;;) {
        st = await purge.status();
        if (st.state === "not-needed") break;
        assert.ok(Date.now() < deadline, `drain did not converge in time; last status: ${st.detail}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(
        st.detail.includes("conservatively kept"),
        `converged status reports the unattributed keeper: ${st.detail}`,
      );

      // Final stored state per report.
      assert.deepEqual(await readVerdicts(reportIds[0]), {}, "R1: both AI keys cleared");
      assert.deepEqual(
        await readVerdicts(reportIds[1]),
        { intake: OP_INTAKE },
        "R2: AI sales cleared, operator intake kept",
      );
      assert.deepEqual(
        await readVerdicts(reportIds[2]),
        { marketing: OP_MARKETING },
        "R3: operator ai_format save kept",
      );
      assert.deepEqual(
        await readVerdicts(reportIds[3]),
        { intake: OP_INTAKE },
        "R4: retired lifetimeValue + non-string junk cleared, operator line kept",
      );
      assert.deepEqual(
        await readVerdicts(reportIds[4]),
        { sales: OP_SALES_2 },
        "R5: operator rewrite of the AI line kept",
      );
      assert.deepEqual(
        await readVerdicts(reportIds[5]),
        { marketContext: MYSTERY },
        "R6: unattributable value conservatively kept",
      );

      // History: purge writes are journaled on exactly the changed rows.
      for (const [id, expected] of [
        [reportIds[0], 2], // AI seed row + purge row
        [reportIds[1], 3],
        [reportIds[3], 2],
      ] as const) {
        assert.equal(await historyCount(id), expected, `${id}: purge appended one history row`);
        const newest = await one(sql`
          SELECT edited_by FROM report_section_history
          WHERE report_id = ${id} AND section_key = 'slideVerdicts'
          ORDER BY created_at DESC LIMIT 1
        `);
        assert.equal(newest.edited_by, SLIDE_VERDICT_PURGE_EDITOR, `${id}: newest row is the purge`);
      }
      // Untouched rows got NO purge history.
      assert.equal(await historyCount(reportIds[2]), 1, "R3 untouched: no purge history row");
      assert.equal(await historyCount(reportIds[4]), 2, "R5 untouched: no purge history row");
      assert.equal(await historyCount(reportIds[5]), 0, "R6 untouched: no purge history row");

      // Second press: converged → nothing-to-do maps to not-needed.
      const again = await purge.apply(null);
      assert.equal(again.state, "not-needed", `second press not-needed, got ${again.state}`);

      console.log("prod-action-purge-ai-slide-verdicts: all assertions passed");
    },
    {
      tables: [
        "clients",
        "reports",
        "report_sections",
        "report_section_history",
        "prod_action_runs",
      ],
      pinGetDbForCrossAsync: true,
    },
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("prod-action-purge-ai-slide-verdicts: FAILED", err);
    process.exit(1);
  });
