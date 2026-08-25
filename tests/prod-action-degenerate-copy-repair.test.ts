/* test-registration
{
  "name": "Degenerate Common Issues repair backfill (Task #4543)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4543: pre-gate FINAL reports still serve degenerate stored AI copy ('Issue: Being Bad') to client share links. This locks the repair backfill's contract: candidate selection (final + pre-gate + detector-failing + unstamped only), surgical per-line repair that keeps every healthy line byte-identical and must pass the finalize-gate detector, deterministic drop of marker-only truncation residue, unrepairable rows stamped-but-untouched, mid-run operator edits winning, and one-pass convergence. A drift here either rewrites post-gate operator-confirmed reports or leaves the degenerate copy live forever.",
  "tier": "small"
}
test-registration */
// Task #4543 — repair degenerate Common Issues copy stored inside reports
// finalized BEFORE the Task #4227 finalize-time quality gate shipped.
//
// Part A — pure repair semantics (`repairDegenerateCommonIssuesText`, AI stub):
//   thin **Issue:** body replaced via the injected rewriter, healthy lines
//   byte-identical, result passes findDegenerateCommonIssues; marker-only
//   trailing residue dropped with ZERO rewriter calls; rewriter failure /
//   still-thin rewrite / unmarked thin prose => unrepaired with the input
//   text returned unchanged.
// Part B — DB selection + processing (hermetic per-run DB, public schema,
//   random UUIDs, finally-cleanup): only final + pre-gate + failing +
//   unstamped sections are candidates; processing writes the repaired text +
//   stamp; unrepairable rows get the stamp only; a mid-run operator edit is
//   skipped without stamping; a second selection pass finds zero candidates
//   (convergence).
// Part C — registry membership: the action is registered, converging.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../server/db";
import { clients, reports, reportSections } from "@shared/schema";
import {
  findDegenerateFinalReportSections,
  processDegenerateRepairSection,
  repairDegenerateCommonIssuesText,
  DEGENERATE_COPY_REPAIR_VERSION,
  DEGENERATE_REPAIR_STAMP_KEY,
  QUALITY_GATE_SHIPPED_AT,
  type ThinBodyRewriter,
} from "../server/services/degenerateCommonIssuesRepair";
import { findDegenerateCommonIssues } from "../server/services/commonIssuesFormatter";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const HEALTHY_BLOCK = [
  "🔴 **Issue:** Not answering the phone during posted business hours",
  "↳ **Impact:** Missed opportunities for potential clients to engage with the firm.",
  "> ➡️ **Strategic Fix:** Implement a call management system to ensure all incoming calls are answered promptly.",
].join("\n");

const THIN_BLOCK = [
  "🔴 **Issue:** Being Bad",
  "↳ **Impact:** Deterioration of client trust and potential loss of business.",
  "> ➡️ **Strategic Fix:** Conduct training sessions to improve staff performance and client interaction skills.",
].join("\n");

const JAN_FIXTURE = `${HEALTHY_BLOCK}\n\n---\n\n${THIN_BLOCK}`;

const GOOD_SENTENCE =
  "Staff performance and client interaction skills fall short of professional standards.";

function stubRewriter(calls: unknown[], reply: string | Error): ThinBodyRewriter {
  return async (args) => {
    calls.push(args);
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

async function partA() {
  // A1 — surgical repair of the thin Issue body.
  {
    const calls: any[] = [];
    const res = await repairDegenerateCommonIssuesText(
      JAN_FIXTURE,
      "intake",
      stubRewriter(calls, GOOD_SENTENCE),
    );
    assert.equal(res.repaired, true, "fixture should repair");
    assert.equal(res.rewrittenLines, 1);
    assert.equal(calls.length, 1, "exactly one AI rewrite");
    assert.equal(calls[0].kind, "Issue");
    assert.equal(calls[0].thinBody, "Being Bad");
    // Healthy block byte-identical; thin block keeps its healthy lines.
    assert.ok(res.text.includes(HEALTHY_BLOCK), "healthy block untouched");
    assert.ok(
      res.text.includes("↳ **Impact:** Deterioration of client trust"),
      "thin block's healthy Impact line kept",
    );
    assert.ok(res.text.includes(`🔴 **Issue:** ${GOOD_SENTENCE}`));
    assert.ok(!res.text.includes("Being Bad"));
    assert.equal(findDegenerateCommonIssues(res.text).length, 0);
  }

  // A2 — marker-only truncation residue dropped deterministically (no AI).
  {
    const calls: any[] = [];
    const res = await repairDegenerateCommonIssuesText(
      `${HEALTHY_BLOCK}\n\n---\n\n🔴 **Issue:**`,
      "intake",
      stubRewriter(calls, GOOD_SENTENCE),
    );
    assert.equal(res.repaired, true);
    assert.equal(res.droppedBlocks, 1);
    assert.equal(calls.length, 0, "residue drop must not bill AI");
    assert.equal(res.text.trim(), HEALTHY_BLOCK);
  }

  // A3 — rewriter failure => unrepaired, content unchanged.
  {
    const res = await repairDegenerateCommonIssuesText(
      JAN_FIXTURE,
      "intake",
      stubRewriter([], new Error("ai down")),
    );
    assert.equal(res.repaired, false);
    assert.equal(res.text, JAN_FIXTURE, "input returned unchanged");
    assert.ok(res.unrepairedReasons.length > 0);
  }

  // A4 — a rewrite that is itself thin is refused.
  {
    const res = await repairDegenerateCommonIssuesText(
      JAN_FIXTURE,
      "intake",
      stubRewriter([], "Still bad"),
    );
    assert.equal(res.repaired, false);
    assert.equal(res.text, JAN_FIXTURE);
  }

  // A5 — unmarked thin prose has no context to restate: unrepaired, no AI.
  {
    const calls: any[] = [];
    const res = await repairDegenerateCommonIssuesText(
      "Too short.",
      "sales",
      stubRewriter(calls, GOOD_SENTENCE),
    );
    assert.equal(res.repaired, false);
    assert.equal(calls.length, 0);
    assert.equal(res.text, "Too short.");
  }
}

async function partB() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const cleanupSections: string[] = [];
  const cleanupReports: string[] = [];
  let clientId: string | null = null;

  const preGate = new Date(QUALITY_GATE_SHIPPED_AT.getTime() - 24 * 60 * 60_000);
  const postGate = new Date(QUALITY_GATE_SHIPPED_AT.getTime() + 60_000);

  const seedReport = async (opts: {
    month: string;
    status: string;
    createdAt: Date;
    ci: string;
    extraData?: Record<string, unknown>;
  }) => {
    const [rep] = await db
      .insert(reports)
      .values({
        clientId: clientId!,
        reportMonth: opts.month,
        status: opts.status,
        createdAt: opts.createdAt,
      })
      .returning({ id: reports.id });
    cleanupReports.push(rep.id);
    const [sec] = await db
      .insert(reportSections)
      .values({
        reportId: rep.id,
        sectionKey: "intake",
        data: { commonIssues: opts.ci, ...(opts.extraData ?? {}) },
      })
      .returning({ id: reportSections.id });
    cleanupSections.push(sec.id);
    return { reportId: rep.id, sectionId: sec.id };
  };

  try {
    const [cli] = await db
      .insert(clients)
      .values({ firmName: `Task4543 Fixture Firm ${suffix}` })
      .returning({ id: clients.id });
    clientId = cli.id;

    // Candidate: final, pre-gate, degenerate, unstamped.
    const cand = await seedReport({
      month: "2031-01",
      status: "final",
      createdAt: preGate,
      ci: JAN_FIXTURE,
    });
    // Excluded: post-gate final (operator-confirmed past the gate).
    await seedReport({
      month: "2031-02",
      status: "final",
      createdAt: postGate,
      ci: JAN_FIXTURE,
    });
    // Excluded: draft.
    await seedReport({
      month: "2031-03",
      status: "draft",
      createdAt: preGate,
      ci: JAN_FIXTURE,
    });
    // Excluded: healthy copy.
    await seedReport({
      month: "2031-04",
      status: "final",
      createdAt: preGate,
      ci: HEALTHY_BLOCK,
    });
    // Excluded: already stamped.
    await seedReport({
      month: "2031-05",
      status: "final",
      createdAt: preGate,
      ci: JAN_FIXTURE,
      extraData: { [DEGENERATE_REPAIR_STAMP_KEY]: DEGENERATE_COPY_REPAIR_VERSION },
    });
    // Candidate that will be unrepairable (unmarked thin prose).
    const unrep = await seedReport({
      month: "2031-06",
      status: "final",
      createdAt: preGate,
      ci: "Too short.",
    });
    // Candidate that will be edited mid-run (conflict skip).
    const confl = await seedReport({
      month: "2031-07",
      status: "final",
      createdAt: preGate,
      ci: JAN_FIXTURE,
    });

    // B1 — selection: exactly our three fixture candidates (scoped to the
    // fixture client's report ids; the shared DB may hold other rows).
    const mine = (list: Awaited<ReturnType<typeof findDegenerateFinalReportSections>>) =>
      list.filter((c) =>
        [cand.sectionId, unrep.sectionId, confl.sectionId].includes(c.id),
      );
    const all = await findDegenerateFinalReportSections(db);
    const selected = mine(all);
    assert.equal(selected.length, 3, "exactly the 3 fixture candidates");
    assert.ok(
      !all.some((c) => cleanupSections.includes(c.id) && !selected.includes(c)),
      "post-gate / draft / healthy / stamped fixture rows never selected",
    );

    const byId = new Map(selected.map((c) => [c.id, c]));

    // B2 — repairable candidate: text rewritten + stamped.
    const r1 = await processDegenerateRepairSection(
      db,
      byId.get(cand.sectionId)!,
      stubRewriter([], GOOD_SENTENCE),
    );
    assert.equal(r1.kind, "repaired");
    const [row1] = await db
      .select({ data: reportSections.data })
      .from(reportSections)
      .where(eq(reportSections.id, cand.sectionId));
    const d1 = row1.data as Record<string, unknown>;
    assert.ok(!String(d1.commonIssues).includes("Being Bad"));
    assert.equal(findDegenerateCommonIssues(d1.commonIssues).length, 0);
    assert.equal(d1[DEGENERATE_REPAIR_STAMP_KEY], DEGENERATE_COPY_REPAIR_VERSION);

    // B3 — unrepairable candidate: stamped, content untouched.
    const r2 = await processDegenerateRepairSection(
      db,
      byId.get(unrep.sectionId)!,
      stubRewriter([], GOOD_SENTENCE),
    );
    assert.equal(r2.kind, "unrepaired");
    const [row2] = await db
      .select({ data: reportSections.data })
      .from(reportSections)
      .where(eq(reportSections.id, unrep.sectionId));
    const d2 = row2.data as Record<string, unknown>;
    assert.equal(d2.commonIssues, "Too short.");
    assert.equal(d2[DEGENERATE_REPAIR_STAMP_KEY], DEGENERATE_COPY_REPAIR_VERSION);

    // B4 — mid-run operator edit wins even when the edit is ITSELF still
    // degenerate: the atomic CAS (keyed to the pre-selection text) matches
    // zero rows, so the operator's edit is never rewritten, never stamped —
    // it may only be re-selected on a LATER press.
    const stillDegenerateEdit = `🔴 **Issue:** Bad ${suffix}\n↳ **Impact:** Deterioration of client trust and potential loss of business.`;
    await db
      .update(reportSections)
      .set({ data: { commonIssues: stillDegenerateEdit } })
      .where(eq(reportSections.id, confl.sectionId));
    const r3 = await processDegenerateRepairSection(
      db,
      byId.get(confl.sectionId)!,
      stubRewriter([], GOOD_SENTENCE),
    );
    assert.equal(r3.kind, "skipped_conflict");
    const [row3] = await db
      .select({ data: reportSections.data })
      .from(reportSections)
      .where(eq(reportSections.id, confl.sectionId));
    const d3 = row3.data as Record<string, unknown>;
    assert.equal(d3.commonIssues, stillDegenerateEdit, "operator edit preserved verbatim");
    assert.equal(d3[DEGENERATE_REPAIR_STAMP_KEY], undefined, "conflict never stamps");

    // B4b — write race: the operator edit lands DURING the AI rewrite (after
    // selection, before the write). The CAS is the only write guard, so the
    // rewriter stub performs the edit itself and the outcome must still be a
    // conflict skip with the operator's text intact.
    const raceCand = mine(await findDegenerateFinalReportSections(db)).find(
      (c) => c.id === confl.sectionId,
    )!;
    assert.ok(raceCand, "still-degenerate edit re-enters selection on a later pass");
    const raceEdit = `🔴 **Issue:** Bad2 ${suffix}\n↳ **Impact:** Deterioration of client trust and potential loss of business.`;
    const racingRewriter: ThinBodyRewriter = async () => {
      await db
        .update(reportSections)
        .set({ data: { commonIssues: raceEdit } })
        .where(eq(reportSections.id, confl.sectionId));
      return GOOD_SENTENCE;
    };
    const r4 = await processDegenerateRepairSection(db, raceCand, racingRewriter);
    assert.equal(r4.kind, "skipped_conflict");
    const [row4] = await db
      .select({ data: reportSections.data })
      .from(reportSections)
      .where(eq(reportSections.id, confl.sectionId));
    const d4 = row4.data as Record<string, unknown>;
    assert.equal(d4.commonIssues, raceEdit, "racing operator edit preserved");
    assert.equal(d4[DEGENERATE_REPAIR_STAMP_KEY], undefined);

    // B5 — convergence: after processing, only the conflicted row (whose
    // operator edit is still degenerate and unstamped) remains selectable;
    // every processed row is stamped out of the candidate set.
    const second = mine(await findDegenerateFinalReportSections(db));
    assert.deepEqual(
      second.map((c) => c.id),
      [confl.sectionId],
      "processed rows converged; conflicted row deferred to a later press",
    );
  } finally {
    for (const id of cleanupSections) {
      await db.delete(reportSections).where(eq(reportSections.id, id));
    }
    for (const id of cleanupReports) {
      await db.delete(reports).where(eq(reports.id, id));
    }
    if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
  }
}

function partC() {
  const action = PROD_ACTIONS.find(
    (a) => a.id === "repair_degenerate_common_issues_final_reports",
  );
  assert.ok(action, "action registered in PROD_ACTIONS");
  assert.equal(action!.convergence.kind, "converging");
}

async function main() {
  await partA();
  await partB();
  partC();
  console.log("prod-action-degenerate-copy-repair: all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
