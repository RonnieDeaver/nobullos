/* test-registration
{
  "name": "Deactivate fabricated zero-metric facts prod action — pending detection, tracked-client false-positive guard, drain convergence, e2e clean regeneration (Task #4846)",
  "regression": true,
  "sweepOnlyReason": "Task #4846: DB-heavy prod-action drain e2e (seeds clients/reports/knowledge rows, runs the real background drain, then a real judgment generation under a stubbed model to prove the regenerated prompt renders not-tracked + provenance and memory stays clean); the pure predicate/classifier core gates via tests/judgment-metric-tracking-pure.test.ts",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
/**
 * Task #4846 — convergence semantics of the
 * `deactivate_fabricated_zero_metric_facts` prod action, against the real
 * database, drain kit, and knowledge tables:
 *
 *  1. Pending detection: active daily_judgment facts matching the
 *     fabricated-zero predicate count ONLY for clients whose report history
 *     never entered the asserted families; a tracked client's zero claims
 *     never count (false-positive guard), nor do healthy facts, manual
 *     intel, or already-inactive rows.
 *  2. Registry wiring: converging + humanGate (no selfHeal/manualLever),
 *     one-press drain language, cross-instance lock visibility.
 *  3. Drain: per-client atomic deactivation with audited per-key tallies;
 *     converges to 0 pending; second press → nothing-to-do; status →
 *     not-needed.
 *  4. E2E (the task's Done-looks-like): after the drain, a REAL judgment
 *     generation for the never-tracked client (only the OpenAI call is
 *     stubbed) renders "not tracked" + the hard rule in the prompt, labels
 *     memory provenance, stamps sources.metricTracking + the bumped
 *     revision, and the extraction guard keeps the model's re-asserted zero
 *     narrative OUT of memory — deactivated rows stay dead.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import {
  clients,
  reports,
  reportSections,
  agentKnowledgeBase,
  rawCommunicationRecords,
  clientDailyJudgments,
} from "@shared/schema";
import {
  FABRICATED_ZERO_FACTS_ACTION_ID,
  countFabricatedZeroFactsPending,
  startFabricatedZeroFactsDrain,
  formatFabricatedZeroDrainSummary,
} from "../server/services/judgmentMemoryHygiene";
import {
  acquireProdActionDrainLock,
  isProdActionDrainLockHeld,
} from "../server/services/crossInstanceLock";
import {
  getDrainState,
  isDrainRunning,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  FINGERPRINT_REVISION,
  generateDailyJudgment,
  __test_setJudgmentChatCreate,
} from "../server/services/dailyJudgment";

const RUN = randomBytes(4).toString("hex");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FLAGGED_INTAKE = { totalConsults: 0, leadToConsultRate: 0, noDataFlags: { totalConsults: true } };
const FLAGGED_SALES = {
  totalConsults: 0,
  totalCases: 0,
  consultToCaseRate: 0,
  noDataFlags: { totalConsults: true, totalCases: true },
};
const ENTERED_SALES = { totalConsults: 5, totalCases: 2, consultToCaseRate: 40, noDataFlags: {} };

// Exact poisoned shapes from the prod replica (2026-08-17) — unicode
// preserved (U+2011 in "non‑defensive", U+201C/1D curly quotes).
const POISONED_A1 = `Unresolved: Likely unresolved: Clear, non\u2011defensive explanation of how 98 May leads produced 0 intakes (${RUN})`;
const POISONED_A2 = `We still have no recorded intake, consult, or case data for July (all marked \u201Cno data\u201D in the report) (${RUN})`;
const POISONED_A3 = `the zero-consult/poor-conversion outcome repeated again in July (${RUN})`;
const POISONED_C1 = `we still lack visibility into the conversion problem (${RUN})`;
const HEALTHY_A = `Owner asked for a revised GBP review-campaign plan and has not received it (${RUN})`;
const KEPT_B = `Unresolved: Intake system improvements appear still open — reported 0 consults and 0 cases will persist (${RUN})`;

async function seedClient(label: string): Promise<string> {
  const [c] = await db
    .insert(clients)
    .values({ firmName: `FZD4846 ${label} ${RUN}` } as any)
    .returning({ id: clients.id });
  return c.id;
}

async function seedReportMonth(
  clientId: string,
  month: string,
  intake: Record<string, unknown>,
  sales: Record<string, unknown>,
): Promise<void> {
  const [r] = await db
    .insert(reports)
    .values({ clientId, reportMonth: month, status: "final" } as any)
    .returning({ id: reports.id });
  await db.insert(reportSections).values([
    { reportId: r.id, sectionKey: "intake", data: intake },
    { reportId: r.id, sectionKey: "sales", data: sales },
  ] as any);
}

async function seedFact(
  clientId: string,
  factText: string,
  opts: { sourceAgent?: string; isActive?: boolean; category?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(agentKnowledgeBase)
    .values({
      clientId,
      factCategory: opts.category ?? "recurring_concern",
      factText,
      confidence: 0.8,
      sourceAgent: opts.sourceAgent ?? "daily_judgment",
      isActive: opts.isActive ?? true,
    } as any)
    .returning({ id: agentKnowledgeBase.id });
  return row.id;
}

async function activeFacts(clientId: string): Promise<Array<{ text: string; sourceAgent: string }>> {
  const rows = await db
    .select({ text: agentKnowledgeBase.factText, sourceAgent: agentKnowledgeBase.sourceAgent })
    .from(agentKnowledgeBase)
    .where(and(eq(agentKnowledgeBase.clientId, clientId), eq(agentKnowledgeBase.isActive, true)));
  return rows;
}

async function waitForDrainEnd(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = getDrainState(FABRICATED_ZERO_FACTS_ACTION_ID);
    if (s && s.finishedAt !== null) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("drain did not finish within the timeout");
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function cannedAiResponse(): Record<string, unknown> {
  return {
    overallStatus: "Watch",
    relationshipStatus: "Stable",
    confidenceLevel: "High",
    summary: "Fresh summary from the regenerated prompt.",
    // The model re-asserts the legacy zero narrative — the extraction guard
    // must keep it out of memory even when the model disobeys the prompt.
    sentimentSummary: `Client continues the zero\u2011intake month pattern with no consults recorded (${RUN})`,
    whatChanged: [],
    concerns: [POISONED_A1, HEALTHY_A],
    unresolvedAsks: [],
    wins: [],
    recommendedActions: [],
    scores: {
      relationshipHealth: 70,
      sentiment: 42,
      complaint: 10,
      trust: 65,
      responsivenessRisk: 20,
      executionRisk: 15,
      leadVolumeConcern: null,
      unresolvedTaskRisk: 5,
      overallRisk: 25,
    },
    openAskUpdates: [],
    newAsks: [],
  };
}

async function main(): Promise<void> {
  const createdClients: string[] = [];
  const capturedPrompts: string[] = [];

  __test_setJudgmentChatCreate(async (params: any) => {
    const text = (params?.messages ?? [])
      .map((m: any) => (typeof m?.content === "string" ? m.content : ""))
      .join("\n\n");
    capturedPrompts.push(text);
    return { choices: [{ message: { content: JSON.stringify(cannedAiResponse()) } }] } as any;
  });

  try {
    // A: never-tracked (all months flagged) with 3 poisoned + 1 healthy fact
    // + comms (judgeable, extraction runs).
    const clientA = await seedClient("never-tracked");
    createdClients.push(clientA);
    await seedReportMonth(clientA, "2026-06", FLAGGED_INTAKE, FLAGGED_SALES);
    await seedReportMonth(clientA, "2026-07", FLAGGED_INTAKE, FLAGGED_SALES);
    await seedFact(clientA, POISONED_A1);
    await seedFact(clientA, POISONED_A2);
    await seedFact(clientA, POISONED_A3);
    await seedFact(clientA, HEALTHY_A);
    await seedFact(clientA, `Owner said August is their slow season (${RUN})`, {
      sourceAgent: "manual",
      category: "operator_intel",
    });
    await db.insert(rawCommunicationRecords).values([
      {
        clientId: clientA,
        sourceType: "email",
        title: `FZD4846 comm A ${RUN}`,
        timestamp: daysAgo(2),
        contentText: "Client checking in about campaign performance.",
        matchStatus: "matched",
      },
    ] as any);

    // B: TRACKED client (entered sales before) with a kept-matched zero
    // claim — the false-positive guard must leave it alone.
    const clientB = await seedClient("tracked-kept");
    createdClients.push(clientB);
    await seedReportMonth(clientB, "2026-05", FLAGGED_INTAKE, ENTERED_SALES);
    const keptBId = await seedFact(clientB, KEPT_B);

    // C: second never-tracked client, 1 poisoned + 1 already-inactive.
    const clientC = await seedClient("never-tracked-2");
    createdClients.push(clientC);
    await seedReportMonth(clientC, "2026-07", FLAGGED_INTAKE, FLAGGED_SALES);
    await seedFact(clientC, POISONED_C1);
    const inactiveCId = await seedFact(clientC, `confirmed zero\u2011intake month for June (${RUN})`, {
      isActive: false,
    });

    console.log("\nPending detection:");
    const before = await countFabricatedZeroFactsPending();
    check("pending facts = 4 (3×A + 1×C)", before.facts === 4, JSON.stringify(before));
    check("pending clients = 2 (A + C; tracked B excluded)", before.clients === 2, JSON.stringify(before));

    console.log("\nRegistry wiring:");
    const action = PROD_ACTIONS.find((a) => a.id === FABRICATED_ZERO_FACTS_ACTION_ID);
    check("action registered in PROD_ACTIONS", !!action);
    check("convergence taxonomy: converging", (action as any)?.convergence?.kind === "converging");
    check(
      "humanGate declared with a reason (no selfHeal/manualLever)",
      typeof (action as any)?.humanGate?.reason === "string" &&
        (action as any).humanGate.reason.length > 0 &&
        !(action as any).selfHeal &&
        (action as any).manualLever !== true,
    );
    check("description sells ONE press", action!.description.includes("One press starts a"), action!.description.slice(0, 120));

    const statusBefore = await action!.status();
    check("status pending before drain", statusBefore.state === "pending", statusBefore.detail);
    check(
      "status counts facts + clients",
      statusBefore.detail.includes("4 active poisoned memory fact(s)") && statusBefore.detail.includes("2 client(s)"),
      statusBefore.detail,
    );
    check("status points at the re-judge follow-up", statusBefore.detail.includes("Re-judge stale client judgments"), statusBefore.detail);

    console.log("\nCross-instance lock visibility:");
    const foreignLock = await acquireProdActionDrainLock(FABRICATED_ZERO_FACTS_ACTION_ID);
    check("simulated foreign drain acquired the lock", foreignLock !== null);
    try {
      check("lock probe sees the held lock", (await isProdActionDrainLockHeld(FABRICATED_ZERO_FACTS_ACTION_ID)) === true);
      check("local drain state stays empty", isDrainRunning(FABRICATED_ZERO_FACTS_ACTION_ID) === false);
      const statusLocked = await action!.status();
      check(
        "status: pending + working via another instance",
        statusLocked.state === "pending" && statusLocked.working === true && statusLocked.detail.includes("another instance"),
        JSON.stringify(statusLocked),
      );
    } finally {
      await foreignLock?.release();
    }

    console.log("\nDrain run:");
    const out = await startFabricatedZeroFactsDrain(null);
    check("drain started", out.state === "started", JSON.stringify(out));
    await waitForDrainEnd();
    const drainState = getDrainState(FABRICATED_ZERO_FACTS_ACTION_ID)!;
    check("drain finished clean", drainState.error === null, String(drainState.error));
    check("processed = 4 deactivations", drainState.processed === 4, JSON.stringify(drainState));
    check("per-key: deactivated_facts = 4", drainState.perKey.deactivated_facts === 4, JSON.stringify(drainState.perKey));
    check("per-key: clients_drained = 2", drainState.perKey.clients_drained === 2, JSON.stringify(drainState.perKey));
    const summary = formatFabricatedZeroDrainSummary(drainState);
    check("summary reads as audited counts", summary.includes("deactivated 4 of 4") && summary.includes("2 client(s)"), summary);

    console.log("\nPost-drain row states:");
    const aActive = await activeFacts(clientA);
    check(
      "A: poisoned rows inactive, healthy + manual intel survive",
      !aActive.some((f) => f.text.startsWith("Unresolved: Likely unresolved")) &&
        !aActive.some((f) => f.text.includes("no recorded intake")) &&
        !aActive.some((f) => f.text.includes("zero-consult/poor-conversion")) &&
        aActive.some((f) => f.text === HEALTHY_A) &&
        aActive.some((f) => f.sourceAgent === "manual"),
      JSON.stringify(aActive),
    );
    const [keptBRow] = await db
      .select({ isActive: agentKnowledgeBase.isActive })
      .from(agentKnowledgeBase)
      .where(eq(agentKnowledgeBase.id, keptBId));
    check("B (tracked): kept-matched zero claim still ACTIVE", keptBRow.isActive === true);
    const [inactiveCRow] = await db
      .select({ updatedAt: agentKnowledgeBase.updatedAt, isActive: agentKnowledgeBase.isActive })
      .from(agentKnowledgeBase)
      .where(eq(agentKnowledgeBase.id, inactiveCId));
    check("C: pre-inactive row untouched (still inactive)", inactiveCRow.isActive === false);

    console.log("\nConvergence:");
    const after = await countFabricatedZeroFactsPending();
    check("pending converged to 0", after.facts === 0 && after.clients === 0, JSON.stringify(after));
    __resetDrainsForTest();
    const secondPress = await startFabricatedZeroFactsDrain(null);
    check("second press → nothing-to-do", secondPress.state === "nothing-to-do", JSON.stringify(secondPress));
    const statusAfter = await action!.status();
    check("registry status not-needed after convergence", statusAfter.state === "not-needed", statusAfter.detail);

    console.log("\nE2E — regenerated judgment for the never-tracked client:");
    const judgment = await generateDailyJudgment(clientA);
    check("judgment generated", !!judgment?.id);
    check(
      "current promptRevision stamped (post-#4846 bump)",
      (judgment.dataSourcesSummary as any)?.promptRevision === FINGERPRINT_REVISION,
      JSON.stringify((judgment.dataSourcesSummary as any)?.promptRevision),
    );
    const mt = (judgment.dataSourcesSummary as any)?.sources?.metricTracking;
    check(
      "sources.metricTracking = never_entered both (fingerprint input)",
      mt?.consults === "never_entered" && mt?.cases === "never_entered",
      JSON.stringify(mt),
    );

    const prompt = capturedPrompts.join("\n\n");
    check("prompt: hard-rule banner names untracked families", prompt.includes("Metric-tracking status (hard rule)"));
    check("prompt: not-tracked line (never a concern)", prompt.includes("not tracked for this client (never entered in any report month)"));
    check("prompt: system Untracked-metric rules present", prompt.includes("Untracked-metric rules (hard rules)"));
    check("prompt: never renders consults/cases as 0", !/consults booked: 0|cases signed: 0/.test(prompt));
    check("prompt: memory facts labeled AI-inferred", prompt.includes(`- [AI-inferred] ${HEALTHY_A}`), prompt.includes("[AI-inferred]") ? "label present but not on healthy fact" : "no label at all");
    check("prompt: operator intel labeled human-filed", prompt.includes("- [human-filed] Owner said August is their slow season"));
    check("prompt: provenance caution (not operator intel)", prompt.includes("NOT operator intel"));
    check(
      "prompt: deactivated poisoned facts do NOT re-enter memory section",
      !prompt.includes(POISONED_A2),
    );

    console.log("\nE2E — memory stays clean after regeneration:");
    const aAfterGen = await activeFacts(clientA);
    check(
      "model's re-asserted zero narrative NOT persisted (guard)",
      !aAfterGen.some((f) => f.text === POISONED_A1) && !aAfterGen.some((f) => f.text.includes("zero\u2011intake month pattern")),
      JSON.stringify(aAfterGen.map((f) => f.text)),
    );
    check("healthy concern from the new judgment persisted", aAfterGen.filter((f) => f.text === HEALTHY_A).length > 0);
    const stillPending = await countFabricatedZeroFactsPending();
    check("pending remains 0 after regeneration (loop cannot re-form)", stillPending.facts === 0, JSON.stringify(stillPending));
  } finally {
    try {
      if (createdClients.length > 0) {
        await db.delete(agentKnowledgeBase).where(inArray(agentKnowledgeBase.clientId, createdClients));
        await db.delete(rawCommunicationRecords).where(inArray(rawCommunicationRecords.clientId, createdClients));
        const rs = await db
          .select({ id: reports.id })
          .from(reports)
          .where(inArray(reports.clientId, createdClients));
        if (rs.length > 0) {
          await db.delete(reportSections).where(inArray(reportSections.reportId, rs.map((r) => r.id)));
          await db.delete(reports).where(inArray(reports.id, rs.map((r) => r.id)));
        }
        await db.delete(clients).where(inArray(clients.id, createdClients)); // cascades judgments
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failed++;
    }
    __resetDrainsForTest();
    __test_setJudgmentChatCreate(null);
    await closeDbPools();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  try { await closeDbPools(); } catch { /* best-effort */ }
  process.exitCode = 1;
});
