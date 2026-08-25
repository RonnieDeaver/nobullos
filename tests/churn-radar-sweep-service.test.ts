/* test-registration
{
  "name": "Churn Risk Radar sweep service — parsing, error isolation, insufficient pre-gate, resume skip, synthesis ranking, requester notification (Task #3692)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: seeds public.* clients/judgments via worker pool, real sweep execution — too slow/stateful for the DB-free smoke gate",
  "tier": "small"
}
test-registration */
/**
 * Task #3692 — Churn Risk Radar sweep service test (stubbed model).
 *
 * Covers, against the real dev DB via the worker pool (workerDb bypasses
 * any tx sandbox — everything is seeded in public.* with per-run random
 * suffixes and deleted in finally, per TASK_PREFLIGHT § 4 rule 3):
 *
 *   (1) Structured parsing — parseChurnInterviewResponse unit checks:
 *       unparseable JSON throws; likelihood clamping + band derivation;
 *       out-of-vocabulary severity/theme coercion; confidence clamping;
 *       >5 reasons sliced after sorting by provided rank; insufficient
 *       verdict respected.
 *   (2) Per-client error isolation — client B's model call throws; the
 *       sweep records an `error` result row for B and still completes,
 *       analyzing client A.
 *   (3) Insufficient-data pre-gate — client C (no judgments, no comms,
 *       no insights) is marked insufficient_data WITHOUT a model call.
 *   (4) Idempotent resume — client D has a pre-inserted result row for
 *       the run; the orchestrator skips it (no model call) and counts it
 *       from the existing rows.
 *   (5) Synthesis ranking — persisted synthesisJson themes are ordered by
 *       impactScore (Σ severityWeight + 2×clientCount) with deterministic
 *       tie-breaks; plus a pure buildChurnRadarThemes multi-client check
 *       that a 2-client theme outranks a 1-client theme with more high
 *       findings, and highRiskClientCount counts only high/critical bands.
 *   (6) Completion notification — the requester gets a user_notifications
 *       row keyed churn_radar_complete_<runId>.
 *   (7) Re-running a completed run returns early without new model calls.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const { workerDb } = await import("../server/db");
const {
  churnRadarOpenAI,
  executeChurnRadarSweep,
  parseChurnInterviewResponse,
  buildChurnRadarThemes,
} = await import("../server/services/churnRiskRadar");
const {
  churnRadarRuns,
  churnRadarClientResults,
  churnRadarFindings,
  clients,
  clientDailyJudgments,
  users,
  userNotifications,
} = await import("@shared/schema");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const USER_ID = `test-3692-director-${RUN}`;
const FIRM_A = `Test 3692 Alpha ${RUN}`;
const FIRM_B = `Test 3692 Bravo ${RUN}`;
const FIRM_C = `Test 3692 Charlie ${RUN}`;
const FIRM_D = `Test 3692 Delta ${RUN}`;

// ── (1) Structured parsing unit checks (no DB) ──────────────────────────────

function testParsing(): void {
  assert.throws(() => parseChurnInterviewResponse("not json at all"), /unparseable JSON/);
  assert.throws(() => parseChurnInterviewResponse("[1,2]"), /non-object/);

  // Band derived from likelihood when the model omits/goofs it.
  for (const [likelihood, band] of [
    [10, "low"],
    [30, "moderate"],
    [55, "high"],
    [80, "critical"],
  ] as const) {
    const p = parseChurnInterviewResponse(
      JSON.stringify({ churnLikelihood: likelihood, likelihoodBand: "bogus", reasons: [] }),
    );
    assert.equal(p.likelihoodBand, band, `likelihood ${likelihood} → band ${band}`);
  }

  // Likelihood clamped into 0..100.
  assert.equal(parseChurnInterviewResponse(JSON.stringify({ churnLikelihood: 250 })).churnLikelihood, 100);
  assert.equal(parseChurnInterviewResponse(JSON.stringify({ churnLikelihood: -5 })).churnLikelihood, 0);

  // >5 reasons: sorted by provided rank, sliced to 5, re-ranked 1..5;
  // enums coerced; confidence clamped; non-string evidence dropped.
  const p = parseChurnInterviewResponse(
    JSON.stringify({
      dataSufficiency: "sufficient",
      churnLikelihood: 60,
      reasons: [
        { rank: 3, reason: "third", severity: "low", confidence: 1.7, evidence: ["e3", 42] },
        { rank: 1, reason: "first", severity: "catastrophic", confidence: -2, evidence: "not-array" },
        { rank: 2, reason: "second", severity: "high", themeCategory: "pricing" },
        { rank: 6, reason: "sixth" },
        { rank: 4, reason: "fourth", themeCategory: "responsiveness" },
        { rank: 5, reason: "fifth" },
        { reason: "" }, // empty reason dropped entirely
      ],
    }),
  );
  assert.equal(p.reasons.length, 5, "sliced to top 5");
  assert.deepEqual(
    p.reasons.map((r) => [r.rank, r.reason]),
    [[1, "first"], [2, "second"], [3, "third"], [4, "fourth"], [5, "fifth"]],
    "sorted by provided rank then re-ranked sequentially",
  );
  assert.equal(p.reasons[0].severity, "medium", "unknown severity → medium");
  assert.equal(p.reasons[0].confidence, 0, "confidence clamped to 0");
  assert.equal(p.reasons[1].themeCategory, "other", "unknown theme → other");
  assert.equal(p.reasons[3].themeCategory, "responsiveness", "valid theme kept");
  assert.equal(p.reasons[2].confidence, 1, "confidence clamped to 1");
  assert.deepEqual(p.reasons[2].evidence, ["e3"], "non-string evidence entries dropped");
  assert.deepEqual(p.reasons[0].evidence, [], "non-array evidence → []");

  const insuff = parseChurnInterviewResponse(
    JSON.stringify({ dataSufficiency: "insufficient", insufficiencyReason: "too thin" }),
  );
  assert.equal(insuff.dataSufficiency, "insufficient");
  assert.equal(insuff.insufficiencyReason, "too thin");
  console.log("  ✓ 1: structured parsing — throws, clamps, coerces, slices, re-ranks");
}

// ── (5b) Pure synthesis weighting (no DB) ───────────────────────────────────

function testSynthesisWeighting(): void {
  const results = [
    { clientId: "c1", firmName: "Firm One", churnLikelihood: 80, likelihoodBand: "high", status: "analyzed" },
    { clientId: "c2", firmName: "Firm Two", churnLikelihood: 30, likelihoodBand: "moderate", status: "analyzed" },
    { clientId: "c3", firmName: "Firm Three", churnLikelihood: 90, likelihoodBand: "critical", status: "analyzed" },
  ];
  const findings = [
    // responsiveness: 2 clients (high + medium) → Σweight 5 + 2×2 = 9
    { clientId: "c1", reason: "slow on asks", severity: "high", confidence: 0.9, themeCategory: "responsiveness" },
    { clientId: "c2", reason: "asks linger", severity: "medium", confidence: 0.6, themeCategory: "responsiveness" },
    // trust_relationship: 1 client, two HIGH findings → Σweight 6 + 2×1 = 8
    { clientId: "c3", reason: "trust broken", severity: "high", confidence: 0.95, themeCategory: "trust_relationship" },
    { clientId: "c3", reason: "openly shopping", severity: "high", confidence: 0.9, themeCategory: "trust_relationship" },
  ];
  const themes = buildChurnRadarThemes(results as any, findings as any);
  assert.equal(themes.length, 2);
  assert.equal(themes[0].category, "responsiveness", "2-client theme outranks 1-client theme with more high findings");
  assert.equal(themes[0].impactScore, 9);
  assert.equal(themes[1].category, "trust_relationship");
  assert.equal(themes[1].impactScore, 8);
  assert.equal(themes[0].clientCount, 2);
  assert.equal(themes[0].highRiskClientCount, 1, "only c1 (band=high) counts as high-risk; c2 moderate does not");
  assert.equal(themes[1].highRiskClientCount, 1, "c3 critical counts");
  assert.deepEqual(
    themes[0].affectedClients.map((c) => c.clientId),
    ["c1", "c2"],
    "affected clients ordered by churn likelihood desc",
  );
  assert.deepEqual(themes[0].severityCounts, { high: 1, medium: 1, low: 0 });
  assert.equal(themes[1].affectedClients[0].worstSeverity, "high");
  console.log("  ✓ 5b: pure synthesis — impactScore = Σseverity + 2×clients, deterministic order, band-gated high-risk count");
}

// ── Sweep e2e with stubbed model ────────────────────────────────────────────

async function main(): Promise<void> {
  testParsing();
  testSynthesisWeighting();

  const db = workerDb;
  const calledFirms: string[] = [];

  // Stub the exported OpenAI client (object property is mutable even though
  // the ESM binding is read-only — same seam as the CEO-pulse tests).
  (churnRadarOpenAI.chat.completions as any).create = async (args: any) => {
    const userMsg: string = args.messages?.find((m: any) => m.role === "user")?.content ?? "";
    if (userMsg.includes(FIRM_A)) calledFirms.push("A");
    else if (userMsg.includes(FIRM_B)) calledFirms.push("B");
    else if (userMsg.includes(FIRM_C)) calledFirms.push("C");
    else if (userMsg.includes(FIRM_D)) calledFirms.push("D");
    else calledFirms.push("?");

    if (userMsg.includes(FIRM_B)) throw new Error(`model boom ${RUN}`);
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              dataSufficiency: "sufficient",
              churnLikelihood: 82,
              // likelihoodBand omitted → derived "critical" from 82
              summary: "Relationship strained; results questioned.",
              reasons: [
                { rank: 1, reason: "Asks sit unanswered for weeks", severity: "high", confidence: 0.9, evidence: ["judgment 2026-08-01: unresolved asks"], themeCategory: "responsiveness" },
                { rank: 2, reason: "Lead quality complaints unaddressed", severity: "high", confidence: 0.85, evidence: ["insight: complaints about junk leads"], themeCategory: "results_performance" },
                { rank: 3, reason: "Threatened to review the contract", severity: "catastrophic", confidence: 0.8, evidence: ["call note"], themeCategory: "pricing" },
                { rank: 4, reason: "Lead volume dipped last month", severity: "low", confidence: 0.5, evidence: [], themeCategory: "lead_volume" },
                { rank: 5, reason: "Monthly check-ins keep slipping", severity: "medium", confidence: 0.6, evidence: ["missed 2 of 3 syncs"], themeCategory: "communication_cadence" },
                { rank: 6, reason: "Padding reason that must be sliced off", severity: "low", confidence: 0.2, evidence: [], themeCategory: "other" },
              ],
            }),
          },
        },
      ],
    };
  };

  let runId: string | null = null;
  const clientIds: string[] = [];

  try {
    // ── Seed (public.*, per-run suffixes) ────────────────────────────────
    await db.insert(users).values({ id: USER_ID, firstName: `Test3692-${RUN}` } as any);
    const seeded = await db
      .insert(clients)
      .values([
        { firmName: FIRM_A, isDemo: false, isArchived: false },
        { firmName: FIRM_B, isDemo: false, isArchived: false },
        { firmName: FIRM_C, isDemo: false, isArchived: false },
        { firmName: FIRM_D, isDemo: false, isArchived: false },
      ] as any)
      .returning({ id: clients.id, firmName: clients.firmName });
    const byFirm = new Map(seeded.map((c) => [c.firmName, c.id]));
    const [idA, idB, idC, idD] = [FIRM_A, FIRM_B, FIRM_C, FIRM_D].map((f) => byFirm.get(f)!);
    clientIds.push(idA, idB, idC, idD);

    // A and B have a judgment (passes the insufficient pre-gate); C has
    // nothing at all; D never gets interviewed (pre-inserted result row).
    await db.insert(clientDailyJudgments).values([
      { clientId: idA, judgmentDate: "2026-08-01", status: "At Risk", riskScore: 72, summaryText: `unresolved asks piling up ${RUN}` },
      { clientId: idB, judgmentDate: "2026-08-01", status: "Watch", riskScore: 55 },
    ] as any);

    const [runRow] = await db
      .insert(churnRadarRuns)
      .values({ status: "running", requestedBy: USER_ID, modelVersion: "test-stub" })
      .returning();
    runId = runRow.id;

    // (4) Idempotent resume: D already has an outcome row for this run.
    await db.insert(churnRadarClientResults).values({
      runId: runRow.id,
      clientId: idD,
      firmName: FIRM_D,
      status: "analyzed",
      churnLikelihood: 40,
      likelihoodBand: "moderate",
      summary: "pre-seeded from a previous holder",
    });

    // ── Execute ──────────────────────────────────────────────────────────
    const sweepClients = [
      { id: idA, firmName: FIRM_A },
      { id: idB, firmName: FIRM_B },
      { id: idC, firmName: FIRM_C },
      { id: idD, firmName: FIRM_D },
    ];
    const completed = await executeChurnRadarSweep(runRow.id, { clients: sweepClients, concurrency: 2 });

    assert.equal(completed.status, "completed", `run must complete (got ${completed.status}: ${completed.errorSummary})`);
    assert.equal(completed.totalClients, 4);
    assert.equal(completed.processedClients, 4);
    assert.equal(completed.analyzedClients, 2, "A analyzed + pre-seeded D counted from existing rows");
    assert.equal(completed.insufficientClients, 1, "C pre-gated insufficient");
    assert.equal(completed.errorClients, 1, "B errored in isolation");
    assert.deepEqual(calledFirms.sort(), ["A", "B"], "model called ONLY for A and B — C pre-gated, D resume-skipped");
    console.log("  ✓ 2/3/4: error isolation (B), insufficient pre-gate without model call (C), resume skip (D)");

    // ── Client result rows ──────────────────────────────────────────────
    const resultRows = await db
      .select()
      .from(churnRadarClientResults)
      .where(eq(churnRadarClientResults.runId, runRow.id));
    assert.equal(resultRows.length, 4);
    const rowByClient = new Map(resultRows.map((r) => [r.clientId, r]));
    const rowA = rowByClient.get(idA)!;
    assert.equal(rowA.status, "analyzed");
    assert.equal(rowA.churnLikelihood, 82);
    assert.equal(rowA.likelihoodBand, "critical", "band derived from likelihood 82");
    const rowB = rowByClient.get(idB)!;
    assert.equal(rowB.status, "error");
    assert.match(rowB.errorMessage ?? "", new RegExp(`model boom ${RUN}`));
    const rowC = rowByClient.get(idC)!;
    assert.equal(rowC.status, "insufficient_data");
    assert.match(rowC.insufficiencyReason ?? "", /No daily judgments/);
    assert.equal(rowByClient.get(idD)!.churnLikelihood, 40, "pre-seeded D row untouched");

    // ── Findings for A: sliced to 5, coerced enums ──────────────────────
    const findingRows = await db
      .select()
      .from(churnRadarFindings)
      .where(eq(churnRadarFindings.runId, runRow.id));
    assert.equal(findingRows.length, 5, "only A produced findings, sliced to 5");
    assert.ok(findingRows.every((f) => f.clientId === idA));
    assert.deepEqual(
      findingRows.map((f) => f.rank).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
    const f3 = findingRows.find((f) => f.rank === 3)!;
    assert.equal(f3.severity, "medium", "'catastrophic' coerced to medium");
    assert.equal(f3.themeCategory, "other", "'pricing' coerced to other");
    const f1 = findingRows.find((f) => f.rank === 1)!;
    assert.equal(f1.themeCategory, "responsiveness");
    assert.deepEqual(f1.evidenceJson, ["judgment 2026-08-01: unresolved asks"]);

    // ── (5) Persisted synthesis ranking ─────────────────────────────────
    const synthesis = completed.synthesisJson as any;
    assert.ok(synthesis && Array.isArray(synthesis.themes), "synthesisJson persisted on the run");
    // Impact: responsiveness 3+2=5, results_performance 3+2=5,
    // communication_cadence 2+2=4, other 2+2=4, lead_volume 1+2=3.
    // Ties break by clientCount (equal) then label A→Z.
    assert.deepEqual(
      synthesis.themes.map((t: any) => t.category),
      ["responsiveness", "results_performance", "communication_cadence", "other", "lead_volume"],
      "themes ordered by impactScore with deterministic tie-breaks",
    );
    assert.equal(synthesis.themes[0].impactScore, 5);
    assert.equal(synthesis.themes[0].highRiskClientCount, 1, "A is critical-band");
    assert.equal(synthesis.themes[0].affectedClients[0].firmName, FIRM_A);
    console.log("  ✓ 5: persisted synthesis — impact-ranked themes with evidence-bearing clients");

    // ── (6) Requester notification ──────────────────────────────────────
    const notifs = await db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.dedupeKey, `churn_radar_complete_${runRow.id}`));
    assert.equal(notifs.length, 1, "requester notified exactly once");
    assert.equal(notifs[0].userId, USER_ID);
    assert.match(notifs[0].body ?? "", /2 of 4 clients analyzed/, "counts A + pre-seeded D as analyzed");
    console.log("  ✓ 6: completion notification for the requester (deduped per run)");

    // ── (7) Re-execute on a completed run: early return, no new calls ───
    const callsBefore = calledFirms.length;
    const again = await executeChurnRadarSweep(runRow.id, { clients: sweepClients, concurrency: 2 });
    assert.equal(again.status, "completed");
    assert.equal(calledFirms.length, callsBefore, "no model calls on re-execute of a completed run");
    console.log("  ✓ 7: re-executing a completed run is a no-op");
  } finally {
    // Cleanup (public.*): notification rows, run (cascades results +
    // findings), judgments via client cascade, clients, user.
    try {
      await db.delete(userNotifications).where(eq(userNotifications.userId, USER_ID));
      if (runId) await db.delete(churnRadarRuns).where(eq(churnRadarRuns.id, runId));
      if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
      await db.delete(users).where(eq(users.id, USER_ID));
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }

  console.log("churn-radar-sweep-service: all sections passed (Task #3692).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("churn-radar-sweep-service: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
