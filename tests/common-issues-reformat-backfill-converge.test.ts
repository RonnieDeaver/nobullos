/* test-registration
{
  "name": "Common Issues reformat backfill convergence (Task #2446)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3770: reformat backfill convergence — candidate selection (incl. the stamped-but-malformed single-line revival arm), placeholder exclusion, no-AI deterministic structure repair, stamp writing, and the zero-candidates-on-second-pass convergence the CEO reformat action's 'not needed' state relies on. Isolated schema, mocked OpenAI; a drift here makes the reformat button skip poisoned rows forever or re-arm perpetually.",
  "tier": "small"
}
test-registration */
// Task #2446 — convergence + candidate-selection regression for the
// "reformat Common Issues on ALL reports" backfill core (Task #2390,
// `server/services/commonIssuesReformatBackfill.ts`). The shared core is
// driven by both the dry-run CLI (`scripts/backfill-common-issues-reformat.ts`)
// and the `reformat_common_issues_all_reports` CEO prod-action, so this locks
// in the contract neither caller can re-state cheaply:
//
//   1. `findReformatCandidateSections` returns ONLY Intake/Sales sections that
//      have a non-empty, non-placeholder `data.commonIssues` AND no current
//      stamp. Empty bodies, "missing data source" placeholders, non-target
//      section keys, and already-stamped rows are all excluded.
//   2. `processReformatSection` (apply=true) stamps + writes the formatted
//      content for real rows, SKIPS a placeholder without writing, and never
//      destroys content — even when the AI degrades, a non-empty result is
//      persisted and the stamp is set so the row converges.
//   3. A full drain pass converges: after processing every candidate once, a
//      second `findReformatCandidateSections` finds ZERO candidates.
//   4. Task #3770 — targeted revival of stamped-but-malformed rows: a section
//      stored as a single-line wall of text (canonical 🔴/↳/➡️ markers, no
//      line breaks — the July 2026 Ackah poison, stamped at import by Task
//      #3533) becomes a candidate flagged `structureRepairOnly`, is repaired
//      via the deterministic structure normalizer with ZERO AI calls, keeps
//      its stamp, and drops out on the next pass (self-extinguishing).
//      Stamped healthy rows, stamped normalizer-no-op single-line rows, and
//      stamped single-line placeholder rows are all NOT revived.
//
// Runs in an isolated Postgres schema (committed cross-connection writes, no
// race with the live `Start application` workers; the schema is dropped on
// exit). NOTE (Task #3770 repair of pre-existing rot): Task #2460 made
// `findReformatCandidateSections` inner-join `reports` (and left-join
// `clients`) for tone context, but this suite only cloned `report_sections` —
// the join fell through to public.reports where the seeded reportIds don't
// exist, so EVERY pass found zero candidates and the suite failed from its
// first assertion (it never ran in the gate: regression-flagged but
// baseline-listed, see memory "The gate is SMOKE_FILES, not the regression
// flag"). Fixed by cloning `reports` + `clients` too and seeding a matching
// report row per section (the LIKE clone drops FKs, so no client rows are
// required). The OpenAI client is mocked by overriding the shared `openai`
// singleton's `chat.completions.create` — the same object instance the
// formatter imports from `../routes/middleware` (ESM named-import bindings are
// read-only but the OBJECT is mutable; see memory "Mocking OpenAI in route
// tests"). No network, no live OpenAI billing.
//
// Usage: tsx tests/common-issues-reformat-backfill-converge.test.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import { reportSections, reports } from "@shared/schema";
import {
  findReformatCandidateSections,
  processReformatSection,
  COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
  REFORMAT_STAMP_KEY,
  type ReformatCandidate,
} from "../server/services/commonIssuesReformatBackfill";
import { normalizeCommonIssuesStructure } from "../server/services/commonIssuesFormatter";
import { openai } from "../server/routes/middleware";

// ── OpenAI mock ─────────────────────────────────────────────────────────
// The formatter calls `openai.chat.completions.create(...)`. We replace the
// singleton's `create` so each test controls what the "model" returns (or
// throws) and so the AI is NEVER actually called over the network.
type AiBehavior =
  | { kind: "content"; content: string }
  | { kind: "throw"; error: Error };

let aiBehavior: AiBehavior = { kind: "content", content: "AI FORMATTED" };
let aiCallCount = 0;
const originalCreate = openai.chat.completions.create.bind(
  openai.chat.completions,
);
(openai.chat.completions as any).create = async () => {
  aiCallCount += 1;
  if (aiBehavior.kind === "throw") throw aiBehavior.error;
  return { choices: [{ message: { content: aiBehavior.content } }] };
};

// A real (non-placeholder) Common Issues blob the formatter will process.
const RAW_INTAKE =
  "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Add a same-day callback rule.";
const RAW_SALES =
  "Issue 1: No discovery questions. Impact: Weak case assessment. Strategic Fix: Standardize the intake form.";
// Already-looks-formatted, but UNSTAMPED → still a candidate (the CEO decision
// is to re-run even formatted sections; only the stamp stops re-billing).
const ALREADY_FORMATTED =
  "🔴 **Issue:** Reps are slow.\n↳ **Impact:** Leads churn.\n> ➡️ **Strategic Fix:** Respond same day.";
// Literal "missing data source" placeholder — must be left untouched.
const PLACEHOLDER =
  "Missing data source - There is no data source associated with this component. See details";

const ACKAH_SINGLE_LINE = `🔴 **Issue:** Weak or absent "Strong Ask to Book Now" and limited emotional urgency across calls ↳ **Impact:** The largest drivers of lost bookings > ➡️ **Strategic Fix:** Mandate an assumptive closing script that ties booking to concrete case urgency and lawyer availability, supported by weekly coached role-plays and conversion KPIs. --- 🔴 **Issue:** Unclear next steps, inconsistent appointment confirmations, and lack of immediate reminders ↳ **Impact:** Scheduling friction and high no-show risk > ➡️ **Strategic Fix:** Implement a standardized end-of-call checklist plus automated SMS/email calendar invites and a lawyer-intro message before hang-up, with tracking for reminder delivery and attendance. --- 🔴 **Issue:** Poor data capture, language-switching friction, talk-to-listen imbalances, and premature fee conversations ↳ **Impact:** Weakened rapport and increased abandonment > ➡️ **Strategic Fix:** Enforce a structured intake template and language-routing protocol, train active-listening/empathetic probes, and delay fee discussions until value is established, monitored via QA and talk-listen metrics. --- 🔴 **Issue:** Weak or absent "Strong Ask to Book Now" ↳ **Impact:** Routine drop-off and missed revenue > ➡️ **Strategic Fix:** Institute a mandatory, scripted`;
async function seedSection(
  db: any,
  opts: {
    reportId: string;
    sectionKey: string;
    commonIssues?: string;
    stamped?: boolean;
    extraData?: Record<string, unknown>;
  },
): Promise<string> {
  const data: Record<string, unknown> = { ...(opts.extraData ?? {}) };
  if (opts.commonIssues !== undefined) data.commonIssues = opts.commonIssues;
  if (opts.stamped) {
    data[REFORMAT_STAMP_KEY] = COMMON_ISSUES_REFORMAT_BACKFILL_VERSION;
  }
  const [row] = await db
    .insert(reportSections)
    .values({ reportId: opts.reportId, sectionKey: opts.sectionKey, data })
    .returning({ id: reportSections.id });
  return row.id;
}

async function readData(db: any, id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ data: reportSections.data })
    .from(reportSections)
    .where(eq(reportSections.id, id));
  return (row?.data ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // ── (1) candidate selection + (2) processing, in one isolated schema ──
  await runInIsolatedSchema(
    async ({ db }) => {
      for (const r of ["rep-1", "rep-2", "rep-3", "rep-4"]) {
        await seedReport(db, r);
      }
      // A real intake row that needs a pass.
      const idIntakeRaw = await seedSection(db, {
        reportId: "rep-1",
        sectionKey: "intake",
        commonIssues: RAW_INTAKE,
        extraData: { keepMe: "preserve-other-keys" },
      });
      // A real sales row that needs a pass.
      const idSalesRaw = await seedSection(db, {
        reportId: "rep-1",
        sectionKey: "sales",
        commonIssues: RAW_SALES,
      });
      // Already-formatted but UNSTAMPED → still a candidate.
      const idFormatted = await seedSection(db, {
        reportId: "rep-2",
        sectionKey: "intake",
        commonIssues: ALREADY_FORMATTED,
      });
      // Empty body → excluded by the SQL prefilter.
      const idEmpty = await seedSection(db, {
        reportId: "rep-2",
        sectionKey: "sales",
        commonIssues: "",
      });
      // Placeholder body → passes the SQL prefilter but excluded in code.
      const idPlaceholder = await seedSection(db, {
        reportId: "rep-3",
        sectionKey: "intake",
        commonIssues: PLACEHOLDER,
      });
      // Non-target section key → never a candidate.
      const idMarketing = await seedSection(db, {
        reportId: "rep-3",
        sectionKey: "marketing",
        commonIssues: RAW_INTAKE,
      });
      // Already STAMPED with the current version → excluded (convergence).
      const idStamped = await seedSection(db, {
        reportId: "rep-4",
        sectionKey: "intake",
        commonIssues: RAW_INTAKE,
        stamped: true,
      });

      const candidates = await findReformatCandidateSections(db);
      const ids = new Set(candidates.map((c) => c.id));

      assert.equal(ids.has(idIntakeRaw), true, "raw intake row is a candidate");
      assert.equal(ids.has(idSalesRaw), true, "raw sales row is a candidate");
      assert.equal(
        ids.has(idFormatted),
        true,
        "already-formatted UNSTAMPED row is still a candidate (re-run)",
      );
      assert.equal(ids.has(idEmpty), false, "empty body is excluded");
      assert.equal(
        ids.has(idPlaceholder),
        false,
        "'missing data source' placeholder is excluded",
      );
      assert.equal(
        ids.has(idMarketing),
        false,
        "non-target section key is excluded",
      );
      assert.equal(
        ids.has(idStamped),
        false,
        "already-stamped row is excluded (convergence)",
      );
      assert.equal(candidates.length, 3, "exactly the 3 real unstamped rows");

      // Every returned candidate carries the right shape.
      const cIntake = candidates.find((c) => c.id === idIntakeRaw)!;
      assert.equal(cIntake.sectionKey, "intake", "sectionKey normalized");
      assert.equal(cIntake.commonIssues, RAW_INTAKE, "raw body carried through");

      // ── (2a) processing a real row: AI success → stamp + formatted write,
      //         preserving every other key in `data`. ──
      aiCallCount = 0;
      aiBehavior = { kind: "content", content: "AI FORMATTED INTAKE" };
      const rIntake = await processReformatSection({ db, apply: true }, cIntake);
      assert.equal(rIntake.kind, "done", "real row processes to done");
      if (rIntake.kind === "done") {
        assert.equal(rIntake.wroteFormatted, true, "wrote a formatted result");
        assert.equal(rIntake.degraded, false, "AI success → not degraded");
        assert.equal(rIntake.changed, true, "formatted text differs from raw");
      }
      assert.equal(aiCallCount, 1, "AI called exactly once for the real row");
      const dIntake = await readData(db, idIntakeRaw);
      assert.equal(
        dIntake.commonIssues,
        "AI FORMATTED INTAKE",
        "formatted AI output is persisted",
      );
      assert.equal(
        dIntake[REFORMAT_STAMP_KEY],
        COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
        "stamp is written",
      );
      assert.equal(
        dIntake.keepMe,
        "preserve-other-keys",
        "other data keys are preserved",
      );

      // ── (2b) AI degrades (throws) → deterministic fallback is still a
      //         NON-EMPTY write + stamp; content is never destroyed. ──
      const cSales = candidates.find((c) => c.id === idSalesRaw)!;
      aiCallCount = 0;
      aiBehavior = { kind: "throw", error: new Error("openai 500") };
      const rSales = await processReformatSection({ db, apply: true }, cSales);
      assert.equal(rSales.kind, "done", "degraded row still processes to done");
      if (rSales.kind === "done") {
        assert.equal(rSales.degraded, true, "AI throw → degraded");
        assert.equal(
          rSales.wroteFormatted,
          true,
          "deterministic fallback still produced content",
        );
      }
      const dSales = await readData(db, idSalesRaw);
      assert.equal(
        typeof dSales.commonIssues === "string" &&
          (dSales.commonIssues as string).trim().length > 0,
        true,
        "content is NOT destroyed when the AI degrades",
      );
      assert.equal(
        dSales[REFORMAT_STAMP_KEY],
        COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
        "degraded row is still stamped (so it converges)",
      );

      // ── (2c) defensive placeholder skip: even if a placeholder candidate is
      //         handed directly to processReformatSection, it is NOT written. ──
      const placeholderCandidate: ReformatCandidate = {
        id: idPlaceholder,
        reportId: "rep-3",
        sectionKey: "intake",
        commonIssues: PLACEHOLDER,
        data: { commonIssues: PLACEHOLDER },
      };
      aiCallCount = 0;
      const rPlaceholder = await processReformatSection(
        { db, apply: true },
        placeholderCandidate,
      );
      assert.equal(
        rPlaceholder.kind,
        "skipped_placeholder",
        "placeholder is skipped",
      );
      assert.equal(aiCallCount, 0, "no AI call for a placeholder");
      const dPlaceholder = await readData(db, idPlaceholder);
      assert.equal(
        dPlaceholder.commonIssues,
        PLACEHOLDER,
        "placeholder body is left untouched",
      );
      assert.equal(
        dPlaceholder[REFORMAT_STAMP_KEY],
        undefined,
        "placeholder is NOT stamped",
      );
    },
    { tables: ["report_sections", "reports", "clients"] },
  );

  // ── (3) full drain pass converges to zero candidates ────────────────────
  await runInIsolatedSchema(
    async ({ db }) => {
      for (const r of ["d-1", "d-2", "d-3"]) {
        await seedReport(db, r);
      }
      // Mix of real rows + a placeholder + an empty body.
      await seedSection(db, {
        reportId: "d-1",
        sectionKey: "intake",
        commonIssues: RAW_INTAKE,
      });
      await seedSection(db, {
        reportId: "d-1",
        sectionKey: "sales",
        commonIssues: RAW_SALES,
      });
      await seedSection(db, {
        reportId: "d-2",
        sectionKey: "intake",
        commonIssues: ALREADY_FORMATTED,
      });
      await seedSection(db, {
        reportId: "d-2",
        sectionKey: "sales",
        commonIssues: PLACEHOLDER,
      });
      await seedSection(db, {
        reportId: "d-3",
        sectionKey: "intake",
        commonIssues: "",
      });

      aiBehavior = { kind: "content", content: "AI FORMATTED" };

      const firstPass = await findReformatCandidateSections(db);
      assert.equal(
        firstPass.length,
        3,
        "first pass finds the 3 real, unstamped rows",
      );
      for (const cand of firstPass) {
        const res = await processReformatSection({ db, apply: true }, cand);
        assert.notEqual(
          res.kind,
          "skipped_placeholder",
          "no real candidate is a placeholder",
        );
      }

      const secondPass = await findReformatCandidateSections(db);
      assert.equal(
        secondPass.length,
        0,
        "after one full drain pass the action converges to zero candidates",
      );
    },
    { tables: ["report_sections", "reports", "clients"] },
  );

  // ── (4) Task #3770 — revival + deterministic repair of stamped malformed
  //        single-line rows ─────────────────────────────────────────────────
  await runInIsolatedSchema(
    async ({ db }) => {
      for (const r of ["rv-1", "rv-2", "rv-3"]) {
        await seedReport(db, r);
      }
      // STAMPED malformed single-line row (the prod Ackah poison shape) —
      // must be revived despite the current stamp.
      const idPoisoned = await seedSection(db, {
        reportId: "rv-1",
        sectionKey: "intake",
        commonIssues: ACKAH_SINGLE_LINE,
        stamped: true,
        extraData: { keepMe: "preserve-other-keys" },
      });
      // UNSTAMPED malformed single-line row — candidate via the stale-stamp
      // arm, but still repaired deterministically (repair path is keyed on
      // shape, not stamp state).
      const idPoisonedUnstamped = await seedSection(db, {
        reportId: "rv-1",
        sectionKey: "sales",
        commonIssues: ACKAH_SINGLE_LINE,
      });
      // STAMPED healthy multi-line row — must NOT be revived.
      const idHealthyStamped = await seedSection(db, {
        reportId: "rv-2",
        sectionKey: "intake",
        commonIssues: ALREADY_FORMATTED,
        stamped: true,
      });
      // STAMPED single-line row the normalizer would not change — must NOT
      // be revived (would otherwise re-arm the action forever).
      const idNoopStamped = await seedSection(db, {
        reportId: "rv-2",
        sectionKey: "sales",
        commonIssues: SHORT_SINGLE_LINE_NOOP,
        stamped: true,
      });
      // STAMPED single-line AI-rewritten placeholder (the prod Ackah Sales
      // row) — excluded by the placeholder guard, NOT "repaired" into a
      // nicely formatted fake finding (Task #3769 owns clearing it).
      const idPlaceholderStamped = await seedSection(db, {
        reportId: "rv-3",
        sectionKey: "sales",
        commonIssues: SINGLE_LINE_PLACEHOLDER,
        stamped: true,
      });

      const firstPass = await findReformatCandidateSections(db);
      const ids = new Set(firstPass.map((c) => c.id));
      assert.equal(
        ids.has(idPoisoned),
        true,
        "STAMPED malformed single-line row is revived as a candidate",
      );
      assert.equal(
        ids.has(idPoisonedUnstamped),
        true,
        "unstamped malformed single-line row is a candidate too",
      );
      assert.equal(
        ids.has(idHealthyStamped),
        false,
        "stamped healthy multi-line row is NOT revived",
      );
      assert.equal(
        ids.has(idNoopStamped),
        false,
        "stamped normalizer-no-op single-line row is NOT revived (convergence)",
      );
      assert.equal(
        ids.has(idPlaceholderStamped),
        false,
        "stamped single-line placeholder row is NOT revived (Task #3769 owns it)",
      );
      assert.equal(firstPass.length, 2, "exactly the two malformed rows");
      for (const cand of firstPass) {
        assert.equal(
          cand.structureRepairOnly,
          true,
          "malformed rows are flagged structureRepairOnly",
        );
      }

      // Repair both — with ZERO AI calls.
      aiCallCount = 0;
      aiBehavior = {
        kind: "throw",
        error: new Error("AI must not be called for structure repair"),
      };
      for (const cand of firstPass) {
        const res = await processReformatSection({ db, apply: true }, cand);
        assert.equal(res.kind, "done", "repair processes to done");
        if (res.kind === "done") {
          assert.equal(res.structureRepaired, true, "repaired via normalizer");
          assert.equal(res.degraded, false, "structure repair is not a degrade");
          assert.equal(res.changed, true, "repair changed the stored text");
          assert.equal(res.wroteFormatted, true, "repair wrote content");
        }
      }
      assert.equal(aiCallCount, 0, "structure repair makes ZERO AI calls");

      // Persisted: normalized text, stamp still current, other keys intact.
      const expected = normalizeCommonIssuesStructure(ACKAH_SINGLE_LINE);
      assert.equal(
        expected.includes("\n\n---\n\n"),
        true,
        "sanity: normalized fixture has real divider lines",
      );
      const dPoisoned = await readData(db, idPoisoned);
      assert.equal(
        dPoisoned.commonIssues,
        expected,
        "repaired text is the normalizer output",
      );
      assert.equal(
        dPoisoned[REFORMAT_STAMP_KEY],
        COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
        "stamp stays current after repair",
      );
      assert.equal(
        dPoisoned.keepMe,
        "preserve-other-keys",
        "other data keys are preserved by the repair write",
      );
      const dUnstamped = await readData(db, idPoisonedUnstamped);
      assert.equal(
        dUnstamped.commonIssues,
        expected,
        "unstamped malformed row got the same deterministic repair",
      );
      assert.equal(
        dUnstamped[REFORMAT_STAMP_KEY],
        COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
        "unstamped malformed row is stamped by the repair",
      );

      // Placeholder row untouched.
      const dPlaceholder = await readData(db, idPlaceholderStamped);
      assert.equal(
        dPlaceholder.commonIssues,
        SINGLE_LINE_PLACEHOLDER,
        "single-line placeholder body is left byte-identical",
      );

      // Self-extinguishing: the next pass finds nothing.
      const secondPass = await findReformatCandidateSections(db);
      assert.equal(
        secondPass.length,
        0,
        "repaired rows drop out on the next pass (revival self-extinguishes)",
      );
    },
    { tables: ["report_sections", "reports", "clients"] },
  );

  console.log(
    "Task #2446 / #3770 Common Issues reformat backfill convergence: all assertions passed",
  );
}

// Restore the real OpenAI client no matter how the run ends so nothing else in
// the process is affected. Test teardown in server/db.ts drains the pg pools in
// test mode, so the process exits on its own once work settles.
main().then(
  () => {
    (openai.chat.completions as any).create = originalCreate;
  },
  (err) => {
    (openai.chat.completions as any).create = originalCreate;
    console.error(err);
    process.exitCode = 1;
  },
);

async function seedReport(db: any, reportId: string): Promise<void> {
  await db.insert(reports).values({
    id: reportId,
    clientId: `client-${reportId}`,
    reportMonth: "2026-07",
  });
}

const SHORT_SINGLE_LINE_NOOP = "🔴 **Issue:** Short note.";

const SINGLE_LINE_PLACEHOLDER =
  "🔴 **Issue:** Missing data source ↳ **Impact:** There is no data source associated with this component > ➡️ **Strategic Fix:** See details Name_Clean (1): Ackah Law";
