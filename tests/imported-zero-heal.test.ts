/* test-registration
{
  "name": "Imported fabricated-zero healer plan + prod-action driver (Task #3772)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3772 (extension): the retroactive heal for fabricated import zeros (`heal_imported_fabricated_zero_metrics` prod-action). Gates the safety rails (evidence-backed zeros and operator-edited fields are never touched), the fill-from-reparse path, and convergence (a second pass finds zero pending). Isolated schema — no shared-DB contention.",
  "tier": "small"
}
test-registration */
/**
 * Task #3772 (extension) — retroactive heal for fabricated unflagged zeros
 * on past webhook-imported reports (`server/services/importedZeroHealer.ts`,
 * exposed as the `heal_imported_fabricated_zero_metrics` prod-action).
 *
 * Part A pins the pure per-section plan computation (`computeSectionHealPlan`)
 * across the full safety-rail matrix:
 *   - fabricated signature detection (0/absent value, flag not true);
 *   - evidence-backed zeros (original import parsed the field) are NEVER
 *     touched — including the derived sales.averageCaseValue confidence;
 *   - operator-edited fields (value change, or any No-Data-flag transition
 *     through `true`, in a non-import history row) are NEVER touched;
 *   - the era-conversion save (flags absent → all-false, values unchanged)
 *     is clean — that IS the fabrication moment, not operator intent;
 *   - import-pipeline writes (pdf_webhook) and the healer's own writes are
 *     ignored when judging operator intent;
 *   - fills come from re-parsing the stored text with the CURRENT parser
 *     (the "Time to Human Answer" label), everything else gets flag=true;
 *   - flags are patched ONLY for healed keys — untouched fields keep their
 *     era (adding `false` would fabricate "entered zeros", the exact bug).
 *
 * Part B runs the real driver (`runImportedZeroHeal`) against an isolated
 * Postgres schema (getDb() pinned): modern + legacy cohorts, a dirty field,
 * an orphan log, fill-from-reparse, flags-only heal, history attribution
 * rows, and CONVERGENCE — after one apply, the pending count is 0 (memory:
 * prod-action convergence; skipped-dirty fields must not count as pending).
 *
 * Usage: npx tsx tests/imported-zero-heal.test.ts
 */
import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  reports,
  reportSections,
  reportSectionHistory,
  webhookImportLogs,
} from "@shared/schema";
import {
  computeSectionHealPlan,
  runImportedZeroHeal,
  IMPORT_ZERO_HEAL_EDITOR,
  type HealFieldDecision,
} from "../server/services/importedZeroHealer";
import { parseReportText } from "../server/services/pdfImportParser";

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => {
      console.error(`  FAIL ${name}`);
      throw e;
    });
}

function decisionFor(decisions: HealFieldDecision[], field: string): HealFieldDecision {
  const d = decisions.find((x) => x.field === field);
  assert.ok(d, `decision missing for field ${field}`);
  return d!;
}

// Real extracted-text shape (matches the production "REA Data Export" logs):
// letter-spaced header, "See details" noise, ONLY the answer-time metric.
// Long enough to clear the healer's 100-char minimum-text gate.
const REPARSE_TEXT =
  "R E A D a t a E x p o r t Acme Legal Report July 2026 Overview " +
  "See details See details Time to Human Answer 8.45 See details See details " +
  "end of export section padding without any other metric labels";

const CONF_ENTRY = { confidence: "high", source: "test" };

(async () => {
  console.log("Part A — computeSectionHealPlan safety-rail matrix");

  await run("modern fabricated section: fill from re-parse, flag the rest", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: {
        totalConsults: 0,
        avgTimeToAnswer: 0,
        qualityScore: 7,
        missedCallRate: 12,
        noDataFlags: { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
      },
      historyRows: [],
      loggedConfidence: { "intake.qualityScore": CONF_ENTRY },
      freshParse: parseReportText(REPARSE_TEXT),
    });
    assert.equal(plan.changed, true);
    const fill = decisionFor(plan.decisions, "avgTimeToAnswer");
    assert.equal(fill.action, "fill");
    assert.equal(fill.value, 8.45);
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "flag");
    // qualityScore is non-zero → not fabricated → untouched.
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "ok");
    const newData = plan.newData as Record<string, any>;
    assert.equal(newData.avgTimeToAnswer, 8.45);
    assert.equal(newData.noDataFlags.avgTimeToAnswer, false);
    assert.equal(newData.noDataFlags.totalConsults, true);
    assert.equal(newData.noDataFlags.qualityScore, false); // preserved as-is
    assert.equal(newData.missedCallRate, 12); // derived fields untouched
  });

  await run("legacy section (no flags object): patch ONLY healed keys", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: { totalConsults: 45, avgTimeToAnswer: 0, qualityScore: 0 },
      historyRows: [],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(plan.changed, true);
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "ok");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "flag");
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "flag");
    const flags = (plan.newData as Record<string, any>).noDataFlags;
    assert.deepEqual(flags, { avgTimeToAnswer: true, qualityScore: true });
    // totalConsults key ABSENT — its era is preserved, no fabricated
    // "entered" marker for a field the heal did not touch.
    assert.equal(Object.prototype.hasOwnProperty.call(flags, "totalConsults"), false);
  });

  await run("evidence-backed zero (original parse found it) is never touched", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
      historyRows: [],
      loggedConfidence: { "intake.totalConsults": CONF_ENTRY },
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "skip_evidence");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "flag");
  });

  await run("derived averageCaseValue confidence counts as evidence", () => {
    // The parser records sales.averageCaseValue (medium) when it derives
    // ACV from revenue/totalCases — that entry is parse evidence too.
    const plan = computeSectionHealPlan({
      sectionKey: "sales",
      sectionData: { totalCases: 0, averageCaseValue: 0 },
      historyRows: [],
      loggedConfidence: { "sales.averageCaseValue": { confidence: "medium", source: "Calculated" } },
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "averageCaseValue").action, "skip_evidence");
    assert.equal(decisionFor(plan.decisions, "totalCases").action, "flag");
  });

  await run("operator value change → skip_dirty", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      // Operator set it to 30, someone later zeroed it back — still theirs.
      sectionData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
      historyRows: [
        {
          editSource: "pdf_webhook",
          editedBy: "system:pdf-webhook",
          previousData: null,
          newData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
        },
        {
          editSource: "ui_edit",
          editedBy: "user-1",
          previousData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
          newData: { totalConsults: 30, avgTimeToAnswer: 0, qualityScore: 0 },
        },
        {
          editSource: "ui_edit",
          editedBy: "user-1",
          previousData: { totalConsults: 30, avgTimeToAnswer: 0, qualityScore: 0 },
          newData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
        },
      ],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "skip_dirty");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "flag");
  });

  await run("operator No-Data-flag transition through true → skip_dirty", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "sales",
      sectionData: { qualityScore: 0, totalCases: 0, noDataFlags: { qualityScore: false } },
      historyRows: [
        {
          editSource: "ui_edit",
          editedBy: "user-2",
          previousData: { qualityScore: 0, totalCases: 0, noDataFlags: { qualityScore: true } },
          newData: { qualityScore: 0, totalCases: 0, noDataFlags: { qualityScore: false } },
        },
      ],
      loggedConfidence: {},
      freshParse: null,
    });
    // The operator explicitly UN-flagged it — that zero is their decision.
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "skip_dirty");
    assert.equal(decisionFor(plan.decisions, "totalCases").action, "flag");
  });

  await run("era-conversion save (flags absent → all-false, values same) is clean", () => {
    const values = { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 };
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: {
        ...values,
        noDataFlags: { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
      },
      historyRows: [
        {
          editSource: "pdf_webhook",
          editedBy: "system:pdf-webhook",
          previousData: null,
          newData: values,
        },
        {
          editSource: "ui_edit",
          editedBy: "user-3",
          previousData: values,
          newData: {
            ...values,
            noDataFlags: { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
          },
        },
      ],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "flag");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "flag");
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "flag");
  });

  await run("healer's own prior writes are ignored when judging operator intent", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
      historyRows: [
        {
          editSource: "system",
          editedBy: IMPORT_ZERO_HEAL_EDITOR,
          previousData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
          newData: {
            totalConsults: 0,
            avgTimeToAnswer: 0,
            qualityScore: 0,
            noDataFlags: { totalConsults: true },
          },
        },
      ],
      loggedConfidence: {},
      freshParse: null,
    });
    // The flag transition above involved `true` but was OUR write → clean.
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "flag");
  });

  await run("already-flagged and non-zero fields are ok (untouched)", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: {
        totalConsults: 12,
        avgTimeToAnswer: 0,
        qualityScore: 0,
        noDataFlags: { avgTimeToAnswer: true },
      },
      historyRows: [],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "ok");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "ok");
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "flag");
  });

  await run("string values normalize: '' is absent, '12' is a real value", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: { totalConsults: "12", avgTimeToAnswer: "", qualityScore: "0" },
      historyRows: [],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(decisionFor(plan.decisions, "totalConsults").action, "ok");
    assert.equal(decisionFor(plan.decisions, "avgTimeToAnswer").action, "flag");
    assert.equal(decisionFor(plan.decisions, "qualityScore").action, "flag");
  });

  await run("no heal needed → changed=false, no newData", () => {
    const plan = computeSectionHealPlan({
      sectionKey: "intake",
      sectionData: {
        totalConsults: 5,
        avgTimeToAnswer: 8.2,
        qualityScore: 9,
        noDataFlags: { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
      },
      historyRows: [],
      loggedConfidence: {},
      freshParse: null,
    });
    assert.equal(plan.changed, false);
    assert.equal(plan.newData, undefined);
  });

  console.log("Part B — runImportedZeroHeal driver (isolated schema)");

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed R1: modern fabricated (Ackah-shaped), FINAL report ──
      const [r1] = await db
        .insert(reports)
        .values({ clientId: "c-heal-1", reportMonth: "2026-07", status: "final" })
        .returning({ id: reports.id });
      const [log1] = await db
        .insert(webhookImportLogs)
        .values({
          reportId: r1.id,
          clientName: "Acme Legal",
          reportMonth: "2026-07",
          status: "success",
          fieldConfidence: {
            "intake.qualityScore": CONF_ENTRY,
            "sales.totalCases": CONF_ENTRY,
          },
          pdfExtractedText: REPARSE_TEXT,
        })
        .returning({ id: webhookImportLogs.id });
      // An older success log for the same report — the healer must use the
      // LATEST (this one lacks text and would downgrade the fill to a flag).
      await db.insert(webhookImportLogs).values({
        reportId: r1.id,
        clientName: "Acme Legal",
        reportMonth: "2026-07",
        status: "success",
        fieldConfidence: {},
        pdfExtractedText: null,
        createdAt: new Date(Date.now() - 86_400_000),
      });

      const r1IntakeData = {
        totalConsults: 0,
        avgTimeToAnswer: 0,
        qualityScore: 7,
        missedCallRate: 12,
        noDataFlags: { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
      };
      const [r1Intake] = await db
        .insert(reportSections)
        .values({ reportId: r1.id, sectionKey: "intake", data: r1IntakeData })
        .returning({ id: reportSections.id });
      const r1SalesData = {
        totalCases: 3,
        averageCaseValue: 0,
        noShowRate: 0,
        avgFollowUps: 0,
        qualityScore: 0,
        dealTouchDensity: 0,
        avgAgeOpenMatters: 0,
        pipelineMomentumScore: 0,
        noDataFlags: {
          totalCases: false,
          averageCaseValue: false,
          noShowRate: false,
          avgFollowUps: false,
          qualityScore: false,
          dealTouchDensity: false,
          avgAgeOpenMatters: false,
          pipelineMomentumScore: false,
        },
      };
      const [r1Sales] = await db
        .insert(reportSections)
        .values({ reportId: r1.id, sectionKey: "sales", data: r1SalesData })
        .returning({ id: reportSections.id });
      // History: webhook wrote flagless values, then the era-conversion save.
      const r1FlaglessIntake = { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 7, missedCallRate: 12 };
      await db.insert(reportSectionHistory).values([
        {
          reportSectionId: r1Intake.id,
          reportId: r1.id,
          sectionKey: "intake",
          previousData: null,
          newData: r1FlaglessIntake,
          dataChanged: true,
          editedBy: "system:pdf-webhook",
          editSource: "pdf_webhook",
          webhookImportLogId: log1.id,
        },
        {
          reportSectionId: r1Intake.id,
          reportId: r1.id,
          sectionKey: "intake",
          previousData: r1FlaglessIntake,
          newData: r1IntakeData,
          dataChanged: true,
          editedBy: "user-op-1",
          editSource: "ui_edit",
        },
      ]);

      // ── Seed R2: legacy flagless + one dirty sales field, DRAFT report ──
      const [r2] = await db
        .insert(reports)
        .values({ clientId: "c-heal-2", reportMonth: "2026-06", status: "draft" })
        .returning({ id: reports.id });
      const [log2] = await db
        .insert(webhookImportLogs)
        .values({
          reportId: r2.id,
          clientName: "Blackstone Firm",
          reportMonth: "2026-06",
          status: "success",
          fieldConfidence: {},
          pdfExtractedText: null,
        })
        .returning({ id: webhookImportLogs.id });
      const r2IntakeData = { totalConsults: 45, avgTimeToAnswer: 0, qualityScore: 0 };
      const [r2Intake] = await db
        .insert(reportSections)
        .values({ reportId: r2.id, sectionKey: "intake", data: r2IntakeData })
        .returning({ id: reportSections.id });
      await db.insert(reportSectionHistory).values([
        {
          reportSectionId: r2Intake.id,
          reportId: r2.id,
          sectionKey: "intake",
          previousData: null,
          newData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
          dataChanged: true,
          editedBy: "system:pdf-webhook",
          editSource: "pdf_webhook",
          webhookImportLogId: log2.id,
        },
        {
          reportSectionId: r2Intake.id,
          reportId: r2.id,
          sectionKey: "intake",
          previousData: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0 },
          newData: r2IntakeData,
          dataChanged: true,
          editedBy: "user-op-2",
          editSource: "ui_edit",
        },
      ]);
      // Sales: operator un-flagged qualityScore (true → false) → dirty.
      const r2SalesData = {
        totalCases: 0,
        averageCaseValue: 0,
        noShowRate: 0,
        avgFollowUps: 0,
        qualityScore: 0,
        dealTouchDensity: 0,
        avgAgeOpenMatters: 0,
        pipelineMomentumScore: 0,
        noDataFlags: { qualityScore: false },
      };
      const [r2Sales] = await db
        .insert(reportSections)
        .values({ reportId: r2.id, sectionKey: "sales", data: r2SalesData })
        .returning({ id: reportSections.id });
      await db.insert(reportSectionHistory).values({
        reportSectionId: r2Sales.id,
        reportId: r2.id,
        sectionKey: "sales",
        previousData: { ...r2SalesData, noDataFlags: { qualityScore: true } },
        newData: r2SalesData,
        dataChanged: true,
        editedBy: "user-op-2",
        editSource: "ui_edit",
      });

      // ── Orphan log (report_id points nowhere) → excluded, no crash ──
      await db.insert(webhookImportLogs).values({
        reportId: "00000000-0000-0000-0000-000000000000",
        clientName: "Ghost",
        reportMonth: "2026-05",
        status: "success",
        fieldConfidence: {},
      });

      // ── Dry-run (status path, no reparse): counts, no writes ──
      const dry = await runImportedZeroHeal({ dryRun: true, reparse: false });
      assert.equal(dry.reportsScanned, 2, "orphan log excluded from cohort");
      assert.equal(dry.sectionsScanned, 4);
      // R1 intake: totalConsults+avgTimeToAnswer; R1 sales: 7 zeros
      // (totalCases=3 ok); R2 intake: avgTimeToAnswer+qualityScore
      // (totalConsults=45 ok); R2 sales: 7 (qualityScore dirty).
      assert.equal(dry.pendingFields, 18, "pending fields");
      assert.equal(dry.filled.length, 0, "no fills without reparse");
      assert.equal(dry.skippedDirty.length, 1);
      assert.equal(dry.skippedDirty[0]!.field, "qualityScore");
      assert.equal(dry.sectionsHealed, 0, "dry-run writes nothing");
      const [untouched] = await db
        .select({ data: reportSections.data })
        .from(reportSections)
        .where(eq(reportSections.id, r1Intake.id));
      assert.deepEqual(untouched!.data, r1IntakeData, "dry-run left data untouched");

      // ── Apply (with reparse): fills + flags + history attribution ──
      const applied = await runImportedZeroHeal({ dryRun: false, reparse: true });
      assert.equal(applied.pendingFields, 18);
      assert.equal(applied.sectionsHealed, 4);
      assert.equal(applied.filled.length, 1, "one fill from the stored text");
      assert.equal(applied.filled[0]!.field, "avgTimeToAnswer");
      assert.equal(applied.filled[0]!.value, 8.45);
      assert.equal(applied.filled[0]!.clientName, "Acme Legal");
      assert.equal(applied.flagged.length, 17);
      assert.equal(applied.skippedDirty.length, 1);

      const [r1IntakeAfter] = await db
        .select({ data: reportSections.data })
        .from(reportSections)
        .where(eq(reportSections.id, r1Intake.id));
      const d1 = r1IntakeAfter!.data as Record<string, any>;
      assert.equal(d1.avgTimeToAnswer, 8.45, "filled from re-parsed stored text");
      assert.equal(d1.noDataFlags.avgTimeToAnswer, false);
      assert.equal(d1.noDataFlags.totalConsults, true, "unparsed zero flagged No-Data");
      assert.equal(d1.qualityScore, 7, "real value untouched");
      assert.equal(d1.missedCallRate, 12, "derived field untouched");

      const [r2IntakeAfter] = await db
        .select({ data: reportSections.data })
        .from(reportSections)
        .where(eq(reportSections.id, r2Intake.id));
      const d2 = r2IntakeAfter!.data as Record<string, any>;
      assert.equal(d2.totalConsults, 45);
      assert.deepEqual(
        d2.noDataFlags,
        { avgTimeToAnswer: true, qualityScore: true },
        "legacy section: only healed keys get flags (era preserved for the rest)",
      );

      const [r2SalesAfter] = await db
        .select({ data: reportSections.data })
        .from(reportSections)
        .where(eq(reportSections.id, r2Sales.id));
      const d3 = r2SalesAfter!.data as Record<string, any>;
      assert.equal(d3.noDataFlags.qualityScore, false, "dirty field untouched");
      assert.equal(d3.noDataFlags.totalCases, true);
      assert.equal(d3.noDataFlags.avgFollowUps, true);

      // History attribution: latest row is the healer's, tied to the log.
      const historyRows = await db
        .select()
        .from(reportSectionHistory)
        .where(
          and(
            eq(reportSectionHistory.reportId, r1.id),
            eq(reportSectionHistory.sectionKey, "intake"),
          ),
        )
        .orderBy(asc(reportSectionHistory.createdAt), asc(reportSectionHistory.id));
      const healRow = historyRows[historyRows.length - 1]!;
      assert.equal(healRow.editedBy, IMPORT_ZERO_HEAL_EDITOR);
      assert.equal(healRow.editSource, "system");
      assert.equal(healRow.webhookImportLogId, log1.id);
      assert.equal(healRow.dataChanged, true);

      // ── Convergence: a second dry-run finds NOTHING pending ──
      const dry2 = await runImportedZeroHeal({ dryRun: true, reparse: false });
      assert.equal(dry2.pendingFields, 0, "converged — healed fields no longer match");
      assert.equal(dry2.skippedDirty.length, 1, "dirty field still reported, never pending");

      // Second apply is a no-op (registry maps pendingFields=0 → not-needed).
      const applied2 = await runImportedZeroHeal({ dryRun: false, reparse: true });
      assert.equal(applied2.pendingFields, 0);
      assert.equal(applied2.sectionsHealed, 0);
      console.log("  ok  driver: cohort, fills, flags, dirty-skip, attribution, convergence");
    },
    {
      tables: ["reports", "report_sections", "report_section_history", "webhook_import_logs"],
      pinGetDbForCrossAsync: true,
    },
  );

  console.log("\nAll imported-zero-heal tests passed.");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
