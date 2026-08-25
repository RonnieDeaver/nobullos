/* test-registration
{
  "name": "Re-judge stale client judgments prod action — stale detection by promptRevision, unjudgeable exclusion, drain convergence, second run not-needed (Task #4048)",
  "regression": true,
  "sweepOnlyReason": "Task #4048: DB-heavy prod-action drain e2e (seeds clients/judgments/comms, runs the real background drain with the real generation flow under a stubbed model, ~30s); the pure prompt core gates via tests/daily-judgment-honest-prompt-pure.test.ts",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
/**
 * Task #4048 — convergence semantics of the `rejudge_stale_client_judgments`
 * prod action, against the real database, drain kit, and generation flow
 * (only the OpenAI call + fact extractor are stubbed):
 *
 *  1. Stale detection: an active client whose LATEST judgment lacks the
 *     current dataSourcesSummary.promptRevision is pending; a client whose
 *     latest judgment carries the current revision is NOT; archived clients
 *     never count; clients with no judgments at all never count (cron owns
 *     first-time generation).
 *  2. Unjudgeable exclusion: a stale client with NO usable data source is
 *     excluded from the pending (regenerable) count — it cannot be re-judged
 *     — and reported separately, so the action converges instead of pending
 *     forever.
 *  3. Drain: one press force-regenerates today's judgment for the stale
 *     regenerable client (fresh AI call, current promptRevision stamped),
 *     per-key tallies record both the regeneration and the exclusion.
 *  4. Convergence: after the drain, the pending count is 0 and a second
 *     press returns nothing-to-do; the registry action reports not-needed.
 *  5. Task #4812 — re-score progress + cross-instance visibility: the
 *     getRejudgeRescoreProgress() aggregate (board banner + admin surfaces)
 *     splits the judged universe into fresh/stale against the current
 *     revision, and reports running=true when the drain's advisory lock is
 *     held by ANOTHER session (autoscale: the drain's in-memory state lives
 *     on one instance only). The action card's status() likewise reports the
 *     working "another instance" detail instead of a plain pending.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import { storage } from "../server/storage";
import {
  clients,
  rawCommunicationRecords,
  clientDailyJudgments,
  clientRelationshipSignals,
  clientSavePlays,
  clientConcernIntel,
  users,
} from "@shared/schema";
import { FRESH_SLATE_DESTRUCTIVE_CONFIRMATION } from "@shared/clientRating";
import {
  FINGERPRINT_REVISION,
  __test_setJudgmentChatCreate,
  __test_setJudgmentFactExtractor,
} from "../server/services/dailyJudgment";
import { TIER_GATE_VERSION } from "../server/services/judgmentTierGate";
import {
  REJUDGE_STALE_JUDGMENTS_ACTION_ID,
  listStaleJudgmentClients,
  countRejudgePending,
  getRejudgeRescoreProgress,
  evaluateRatingPortfolioRows,
  verifyRepairedRatingPortfolio,
  verifyActiveRatingFreshSlate,
  getFreshSlateReadiness,
  startRejudgeStaleJudgmentsDrain,
  startActiveRatingFreshSlateDrain,
  formatRejudgeDrainSummary,
  formatFreshSlateDrainSummary,
  __test_setRejudgeSleep,
  __test_setFreshSlateCleanup,
  __test_setFreshSlateCleanupLockHook,
} from "../server/services/rejudgeStaleJudgments";
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

let aiCallCount = 0;

function cannedAiResponse(): Record<string, unknown> {
  return {
    overallStatus: "Watch",
    relationshipStatus: "Stable",
    confidenceLevel: "High",
    summary: "Fresh honest summary from the fixed prompt.",
    sentimentSummary: "Stubbed sentiment.",
    whatChanged: [],
    concerns: [],
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

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function isoDaysAgo(n: number): string {
  return daysAgo(n).toISOString().split("T")[0];
}

async function seedJudgment(
  clientId: string,
  judgmentDate: string,
  promptRevision: string | null,
  contractState: "current" | "missing" | "incomplete" | "carried-old" =
    promptRevision === FINGERPRINT_REVISION ? "current" : "missing",
): Promise<void> {
  const summary: Record<string, unknown> = {
    version: 2,
    tier: "full",
    generatedAt: new Date().toISOString(),
    inputsFingerprint: "f".repeat(64),
    basedOn: ["5 comms (30d)"],
    missing: [],
    silenceDays: 0,
    sources: { comms: { count24h: 0, count7d: 1, count30d: 5, lastCommAt: null } },
  };
  if (promptRevision !== null) summary.promptRevision = promptRevision;
  const currentAudit = {
    version: TIER_GATE_VERSION,
    judgmentDate,
    proposedStatus: "Watch",
    finalStatus: "Watch",
    proposedRelationshipStatus: "Stable",
    finalRelationshipStatus: "Stable",
    cap: "Watch",
    overridden: false,
    healthyForced: false,
    proposedOverallRisk: 25,
    finalOverallRisk: 25,
    riskDrivers: [],
    capReasons: ["genuinely_uncertain_or_incomplete_basis"],
    silenceExceeded: false,
    deliveryStability: "unknown",
    deliveryStabilitySource: "none",
    evidence: { validCount: 0, rejectedCount: 0, reclassifiedCount: 0, items: [] },
  };
  if (contractState !== "missing") {
    summary.tierGateVersion = TIER_GATE_VERSION;
  }
  if (contractState === "current") {
    summary.tierGate = currentAudit;
  } else if (contractState === "incomplete") {
    const { riskDrivers: _missingRiskDrivers, ...incompleteAudit } = currentAudit;
    summary.tierGate = incompleteAudit;
  } else if (contractState === "carried-old") {
    summary.carriedForward = {
      fromDate: judgmentDate,
      fromJudgmentId: "fixture-carry",
      rootDate: judgmentDate,
      rootJudgmentId: "fixture-root",
      rootTierGate: { ...currentAudit, version: TIER_GATE_VERSION - 1 },
    };
  }
  await db.insert(clientDailyJudgments).values({
    clientId,
    judgmentDate,
    status: "Watch",
    relationshipHealth: "Stable",
    riskScore: 25,
    headline: `Old narrative ${RUN}`,
    communicationsAnalyzed: 5,
    dataSourcesSummary: summary,
  });
}

async function waitForDrainEnd(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = getDrainState(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
    if (s && s.finishedAt !== null) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("drain did not finish within the timeout");
}

async function main(): Promise<void> {
  __test_setJudgmentChatCreate(async () => {
    aiCallCount++;
    return { choices: [{ message: { content: JSON.stringify(cannedAiResponse()) } }] } as any;
  });
  __test_setJudgmentFactExtractor(async () => 0);
  __test_setRejudgeSleep(async () => {});

  const createdClients: string[] = [];
  const operatorUserId = `rj4048-operator-${RUN}`;
  const seedClient = async (label: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const [c] = await db
      .insert(clients)
      .values({ firmName: `RJ4048 ${label} ${RUN}`, ...extra } as any)
      .returning({ id: clients.id });
    createdClients.push(c.id);
    return c.id;
  };

  try {
    await db.insert(users).values({
      id: operatorUserId,
      email: `${operatorUserId}@example.test`,
      firstName: "Fresh",
      lastName: "Slate",
      role: "ceo",
      authorityLevel: "ceo",
    });
    // A: stale (old revision) + has comms → regenerable.
    const clientA = await seedClient("stale-regenerable");
    await seedJudgment(clientA, isoDaysAgo(1), "3697.1");
    await db.insert(rawCommunicationRecords).values([
      {
        clientId: clientA,
        sourceType: "email",
        title: `RJ4048 comm A ${RUN}`,
        timestamp: daysAgo(2),
        contentText: "Client checking in about campaign performance.",
        matchStatus: "matched",
      },
    ]);

    // B: stale (NO promptRevision at all — pre-#4048 row) + zero data
    // sources → unjudgeable, excluded from the pending count.
    const clientB = await seedClient("stale-unjudgeable");
    await seedJudgment(clientB, isoDaysAgo(3), null);

    // C: latest judgment already at the current revision → not stale.
    const clientC = await seedClient("current-revision");
    await seedJudgment(clientC, isoDaysAgo(1), FINGERPRINT_REVISION);

    // D: archived client with a stale judgment → never counted.
    const clientD = await seedClient("archived-stale", { isArchived: true });
    await seedJudgment(clientD, isoDaysAgo(1), "3697.1");

    // E: active client with NO judgments at all → not stale (cron owns it).
    const clientE = await seedClient("no-judgments");

    // F: prompt revision matches but the repaired decision contract is absent.
    // This is still stale and must be selected by the existing bounded action.
    const clientF = await seedClient("current-prompt-incomplete-gate");
    await seedJudgment(clientF, isoDaysAgo(1), FINGERPRINT_REVISION, "incomplete");
    await db.insert(rawCommunicationRecords).values({
      clientId: clientF,
      sourceType: "email",
      title: `RJ4048 comm F ${RUN}`,
      timestamp: daysAgo(2),
      contentText: "Client checking in about reporting.",
      matchStatus: "matched",
    });

    // H: carried root claims v5 and has every scalar, but one required JSON
    // object is absent. SQL NULL must classify this as stale, not disappear it.
    const clientH = await seedClient("current-prompt-incomplete-carried-root");
    await seedJudgment(clientH, isoDaysAgo(1), FINGERPRINT_REVISION, "current");
    await db.execute(sql`
      UPDATE client_daily_judgments
      SET data_sources_summary =
        (data_sources_summary - 'tierGate')
        || jsonb_build_object(
          'carriedForward',
          jsonb_build_object(
            'fromDate', judgment_date,
            'fromJudgmentId', 'fixture-carry',
            'rootDate', judgment_date,
            'rootJudgmentId', 'fixture-root',
            'rootTierGate',
            (data_sources_summary->'tierGate')
              || jsonb_build_object('evidence', '{}'::jsonb)
          )
        )
      WHERE client_id = ${clientH}
    `);
    await db.insert(rawCommunicationRecords).values({
      clientId: clientH,
      sourceType: "email",
      title: `RJ4048 comm H ${RUN}`,
      timestamp: daysAgo(2),
      contentText: "Client checking in about current work.",
      matchStatus: "matched",
    });

    // I: every structural field exists, but an advisory proposal has the
    // wrong JSON type. A version marker cannot bless a malformed audit.
    const clientI = await seedClient("current-prompt-malformed-proposal");
    await seedJudgment(clientI, isoDaysAgo(1), FINGERPRINT_REVISION, "current");
    await db.execute(sql`
      UPDATE client_daily_judgments
      SET data_sources_summary = jsonb_set(
        data_sources_summary,
        '{tierGate,proposedOverallRisk}',
        '"bad"'::jsonb
      )
      WHERE client_id = ${clientI}
    `);
    await db.insert(rawCommunicationRecords).values({
      clientId: clientI,
      sourceType: "email",
      title: `RJ4048 comm I ${RUN}`,
      timestamp: daysAgo(2),
      contentText: "Client checking in about campaign status.",
      matchStatus: "matched",
    });

    // G: carried row advertises the current top-level marker but its root
    // audit is still from the prior gate contract.
    const clientG = await seedClient("current-prompt-old-carried-root");
    await seedJudgment(clientG, isoDaysAgo(1), FINGERPRINT_REVISION, "carried-old");
    await db.insert(rawCommunicationRecords).values({
      clientId: clientG,
      sourceType: "email",
      title: `RJ4048 comm G ${RUN}`,
      timestamp: daysAgo(2),
      contentText: "Client checking in about delivery status.",
      matchStatus: "matched",
    });

    console.log("\nStale detection:");
    const stale = await listStaleJudgmentClients();
    const staleIds = stale.map((s) => s.clientId);
    const mine = staleIds.filter((id) => createdClients.includes(id));
    check("stale list contains A (old revision)", mine.includes(clientA), JSON.stringify(mine));
    check("stale list contains B (missing promptRevision)", mine.includes(clientB));
    check("stale list contains F (current prompt but incomplete repaired gate)", mine.includes(clientF));
    check("stale list contains G (current marker but old carried root audit)", mine.includes(clientG));
    check("stale list contains H (current carried root missing required audit object)", mine.includes(clientH));
    check("stale list contains I (current audit with malformed proposal type)", mine.includes(clientI));
    check("stale list EXCLUDES C (current revision)", !mine.includes(clientC));
    check("stale list EXCLUDES archived D", !mine.includes(clientD));
    check("stale list only ever contains judged clients", mine.length === 6, JSON.stringify(mine));

    console.log("\nPending counts (fixture-scoped by construction of the hermetic DB):");
    const before = await countRejudgePending();
    // The hermetic per-run DB starts empty, so OUR fixtures are the only rows.
    check("stale = 6 (A + B + F + G + H + I)", before.stale === 6, JSON.stringify(before));
    check("regenerable = 5 (A + F + G + H + I)", before.regenerable === 5, JSON.stringify(before));
    check("unjudgeable = 1 (B excluded, reported separately)", before.unjudgeable === 1, JSON.stringify(before));

    console.log("\nRegistry action status (pre-drain):");
    const action = PROD_ACTIONS.find((a) => a.id === REJUDGE_STALE_JUDGMENTS_ACTION_ID);
    check("action registered", !!action);
    const statusBefore = await action!.status();
    check("fresh-slate action is a manual lever", action!.manualLever === true);
    check("fresh-slate action is never self-healed", action!.selfHeal === undefined);
    check(
      "fresh-slate action exposes the exact destructive phrase",
      action!.destructiveConfirmation?.phrase === FRESH_SLATE_DESTRUCTIVE_CONFIRMATION,
    );
    check("manual-lever status stays out of Apply-all attention state", statusBefore.state === "not-needed", statusBefore.detail);
    check("status blocks before any deletion when an active client has no rating", statusBefore.detail.includes("no rating"), statusBefore.detail);
    const deniedWithoutConfirmation = await action!.apply(null, {});
    check(
      "server blocks a direct apply without destructive confirmation",
      deniedWithoutConfirmation.state === "blocked" &&
        deniedWithoutConfirmation.detail.includes(FRESH_SLATE_DESTRUCTIVE_CONFIRMATION),
      deniedWithoutConfirmation.detail,
    );
    const blockedReadiness = await getFreshSlateReadiness();
    check(
      "fresh-slate preflight is blocked before replacement portfolio is complete",
      blockedReadiness.state === "blocked" &&
        blockedReadiness.detail.includes("no rating"),
      blockedReadiness.state === "blocked" ? blockedReadiness.detail : JSON.stringify(blockedReadiness),
    );

    console.log("\nRe-score progress (Task #4812, pre-drain):");
    const progressBefore = await getRejudgeRescoreProgress();
    check("progress: not running before the press", progressBefore.running === false && progressBefore.runningSource === null, JSON.stringify(progressBefore));
    check("progress: totalJudged = 7 (A, B, C, F, G, H, I; archived D and judgment-less E excluded)", progressBefore.totalJudged === 7, JSON.stringify(progressBefore));
    check("progress: fresh = 1 (C), stale = 6 (A + B + F + G + H + I)", progressBefore.fresh === 1 && progressBefore.stale === 6, JSON.stringify(progressBefore));
    check("progress: reports the current revision", progressBefore.currentRevision === FINGERPRINT_REVISION, progressBefore.currentRevision);
    check("progress: lastFreshGeneratedAt from C's summary", typeof progressBefore.lastFreshGeneratedAt === "string" && !Number.isNaN(Date.parse(progressBefore.lastFreshGeneratedAt!)), JSON.stringify(progressBefore.lastFreshGeneratedAt));

    console.log("\nRead-only portfolio verifier (pre-drain):");
    const portfolioBefore = await verifyRepairedRatingPortfolio();
    check("portfolio verifier includes every active customer fixture", portfolioBefore.activeAccounts === 8, JSON.stringify(portfolioBefore));
    check("portfolio verifier reports the judgment-less account", portfolioBefore.violations.some(v => v.clientId === createdClients[4] && v.codes.includes("missing_judgment")), JSON.stringify(portfolioBefore.violations));
    check("portfolio verifier reports stale/incomplete rating contracts", portfolioBefore.violations.some(v => v.clientId === clientA && v.codes.includes("revision_mismatch")), JSON.stringify(portfolioBefore.violations));
    check("portfolio verifier cannot pass during incomplete convergence", portfolioBefore.passed === false);

    const cleanAudit = {
      version: TIER_GATE_VERSION,
      judgmentDate: "2026-08-20",
      proposedStatus: "Healthy",
      finalStatus: "Healthy",
      proposedRelationshipStatus: "Strong",
      finalRelationshipStatus: "Strong",
      cap: "Healthy",
      overridden: false,
      healthyForced: false,
      proposedOverallRisk: 0,
      finalOverallRisk: 0,
      riskDrivers: [],
      capReasons: ["stable_delivery_in_baseline_no_negative_evidence"],
      silenceExceeded: false,
      deliveryStability: "stable",
      deliveryStabilitySource: "entered_reports",
      evidence: { validCount: 0, rejectedCount: 0, reclassifiedCount: 0, items: [] },
    };
    const cleanInventory = {
      version: 2,
      tier: "full",
      generatedAt: "2026-08-20T12:00:00.000Z",
      inputsFingerprint: "f".repeat(64),
      promptRevision: FINGERPRINT_REVISION,
      tierGateVersion: TIER_GATE_VERSION,
      tierGate: cleanAudit,
      basedOn: ["Account delivery metrics"],
      missing: [],
      silenceDays: 0,
      sources: {},
    };
    const cleanPortfolio = evaluateRatingPortfolioRows([{
      clientId: "clean",
      firmName: "Clean Account",
      judgmentId: "clean-judgment",
      judgmentDate: "2026-08-20",
      status: "Healthy",
      relationship: "Strong",
      riskScore: 0,
      dataSourcesSummary: cleanInventory,
    }]);
    check("portfolio verifier passes a fully repaired account", cleanPortfolio.passed === true, JSON.stringify(cleanPortfolio));

    const malformedAndRelationshipFailures = evaluateRatingPortfolioRows([
      {
        clientId: "malformed-audit",
        firmName: "Malformed Audit",
        judgmentId: "malformed-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: 0,
        dataSourcesSummary: {
          ...cleanInventory,
          tierGate: {
            ...cleanAudit,
            riskDrivers: {},
          },
        },
      },
      {
        clientId: "null-relationship",
        firmName: "Null Relationship",
        judgmentId: "null-relationship-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: null,
        riskScore: 0,
        dataSourcesSummary: cleanInventory,
      },
      {
        clientId: "invalid-relationship",
        firmName: "Invalid Relationship",
        judgmentId: "invalid-relationship-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Unknown",
        riskScore: 0,
        dataSourcesSummary: cleanInventory,
      },
      {
        clientId: "generated-risk-mismatch",
        firmName: "Generated Risk Mismatch",
        judgmentId: "generated-risk-mismatch-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: 1,
        dataSourcesSummary: cleanInventory,
      },
      {
        clientId: "null-stored-risk",
        firmName: "Null Stored Risk",
        judgmentId: "null-stored-risk-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: null,
        dataSourcesSummary: cleanInventory,
      },
      {
        clientId: "blank-stored-risk",
        firmName: "Blank Stored Risk",
        judgmentId: "blank-stored-risk-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: "  ",
        dataSourcesSummary: cleanInventory,
      },
    ]);
    const malformedAuditViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "malformed-audit");
    const nullRelationshipViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "null-relationship");
    const invalidRelationshipViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "invalid-relationship");
    const generatedRiskViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "generated-risk-mismatch");
    const nullRiskViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "null-stored-risk");
    const blankRiskViolation = malformedAndRelationshipFailures.violations.find(v => v.clientId === "blank-stored-risk");
    check("portfolio verifier rejects malformed current-revision audit fields", malformedAuditViolation?.codes.includes("contract_incomplete") === true, JSON.stringify(malformedAuditViolation));
    check("portfolio verifier rejects a missing stored relationship read", nullRelationshipViolation?.codes.includes("contract_incomplete") === true && nullRelationshipViolation.codes.includes("relationship_mismatch"), JSON.stringify(nullRelationshipViolation));
    check("portfolio verifier rejects an invalid stored relationship read", invalidRelationshipViolation?.codes.includes("contract_incomplete") === true && invalidRelationshipViolation.codes.includes("relationship_mismatch"), JSON.stringify(invalidRelationshipViolation));
    check("portfolio verifier rejects generated rows whose stored and audited risks diverge within one band", generatedRiskViolation?.codes.includes("stored_risk_mismatch") === true && !generatedRiskViolation.codes.includes("risk_outside_status_band"), JSON.stringify(generatedRiskViolation));
    check("portfolio verifier does not coerce a null stored risk to zero", nullRiskViolation?.codes.includes("contract_incomplete") === true && nullRiskViolation.codes.includes("stored_risk_mismatch"), JSON.stringify(nullRiskViolation));
    check("portfolio verifier does not coerce a blank stored risk to zero", blankRiskViolation?.codes.includes("contract_incomplete") === true && blankRiskViolation.codes.includes("stored_risk_mismatch"), JSON.stringify(blankRiskViolation));

    const criticalWithoutFirstParty = evaluateRatingPortfolioRows([{
      clientId: "critical-no-first-party",
      firmName: "Critical Without First Party",
      judgmentId: "critical-judgment",
      judgmentDate: "2026-08-20",
      status: "Critical",
      relationship: "Stable",
      riskScore: 75,
      dataSourcesSummary: {
        ...cleanInventory,
        tierGate: {
          ...cleanAudit,
          proposedStatus: "Critical",
          finalStatus: "Critical",
          finalRelationshipStatus: "Stable",
          cap: "Critical",
          finalOverallRisk: 75,
          riskDrivers: [],
          capReasons: ["critical_evidence_validated"],
        },
      },
    }]);
    check("portfolio verifier rejects Critical without qualifying first-party evidence", criticalWithoutFirstParty.violations[0]?.codes.includes("critical_without_first_party_evidence") === true, JSON.stringify(criticalWithoutFirstParty));

    const acceptedAtRiskEvidence = {
      category: "expressed_dissatisfaction",
      effectiveCategory: "expressed_dissatisfaction",
      provenance: "client_authored",
      date: "2026-08-19",
      quote: "[redacted]",
      valid: true,
      reason: "Accepted direct dissatisfaction",
      matchedFragment: {
        id: "fixture-evidence",
        independenceKey: "fixture-evidence",
        sourceType: "email",
        occurredAt: "2026-08-19T12:00:00.000Z",
      },
    };
    const invariantFailures = evaluateRatingPortfolioRows([
      {
        clientId: "healthy-with-risk",
        firmName: "Healthy With Risk",
        judgmentId: "healthy-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: 50,
        dataSourcesSummary: {
          ...cleanInventory,
          tierGate: {
            ...cleanAudit,
            evidence: {
              validCount: 1,
              rejectedCount: 0,
              reclassifiedCount: 0,
              items: [acceptedAtRiskEvidence],
            },
          },
        },
      },
      {
        clientId: "carry-missing-lineage",
        firmName: "Carry Missing Lineage",
        judgmentId: "carry-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: 0,
        dataSourcesSummary: {
          ...cleanInventory,
          tierGate: undefined,
          carriedForward: {
            fromDate: "2026-08-19",
            rootTierGate: cleanAudit,
          },
        },
      },
      {
        clientId: "carry-risk-mismatch",
        firmName: "Carry Risk Mismatch",
        judgmentId: "carry-risk-judgment",
        judgmentDate: "2026-08-20",
        status: "Healthy",
        relationship: "Strong",
        riskScore: 1,
        dataSourcesSummary: {
          ...cleanInventory,
          tierGate: undefined,
          carriedForward: {
            fromDate: "2026-08-19",
            fromJudgmentId: "carry-parent",
            rootDate: "2026-08-18",
            rootJudgmentId: "carry-root",
            rootTierGate: cleanAudit,
          },
        },
      },
    ]);
    const healthyViolation = invariantFailures.violations.find(v => v.clientId === "healthy-with-risk");
    const missingLineageViolation = invariantFailures.violations.find(v => v.clientId === "carry-missing-lineage");
    const carryRiskViolation = invariantFailures.violations.find(v => v.clientId === "carry-risk-mismatch");
    check("portfolio verifier rejects risk scores outside the stored status band", healthyViolation?.codes.includes("risk_outside_status_band") === true, JSON.stringify(healthyViolation));
    check("portfolio verifier rejects Healthy with validated At-Risk evidence", healthyViolation?.codes.includes("healthy_with_validated_risk") === true, JSON.stringify(healthyViolation));
    check("portfolio verifier rejects unexplained carry-forward lineage", missingLineageViolation?.codes.includes("carry_forward_missing_lineage") === true, JSON.stringify(missingLineageViolation));
    check("portfolio verifier rejects carry-forward risk that diverges from its root", carryRiskViolation?.codes.includes("carry_forward_risk_mismatch") === true, JSON.stringify(carryRiskViolation));

    console.log("\nCross-instance lock visibility (Task #4812 — simulated other instance):");
    // Hold the drain's advisory lock directly, exactly as a drain running on
    // a DIFFERENT autoscale instance would. Local drain state stays empty,
    // so any running=true must come from the pg_locks probe.
    const foreignLock = await acquireProdActionDrainLock(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
    check("simulated foreign drain acquired the lock", foreignLock !== null);
    try {
      check("lock probe sees the held lock", (await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID)) === true);
      check("local drain state is still empty (running signal is NOT local)", isDrainRunning(REJUDGE_STALE_JUDGMENTS_ACTION_ID) === false);
      const progressLocked = await getRejudgeRescoreProgress();
      check("progress: running=true via cross-instance source", progressLocked.running === true && progressLocked.runningSource === "cross-instance", JSON.stringify({ running: progressLocked.running, runningSource: progressLocked.runningSource }));
      const statusLocked = await action!.status();
      check("manual-lever status remains outside Apply-all while another instance drains", statusLocked.state === "not-needed", JSON.stringify(statusLocked));
      check(
        "status names the other instance and promises terminal audit totals",
        statusLocked.detail.includes("another instance") &&
          statusLocked.detail.includes("terminal generation, deletion, and portfolio-verification totals"),
        statusLocked.detail,
      );
    } finally {
      await foreignLock?.release();
    }
    check("lock probe clears after release", (await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID)) === false);

    console.log("\nDrain run:");
    const aiBefore = aiCallCount;
    const out = await startRejudgeStaleJudgmentsDrain(null);
    check("drain started", out.state === "started", JSON.stringify(out));
    await waitForDrainEnd();
    const drainState = getDrainState(REJUDGE_STALE_JUDGMENTS_ACTION_ID)!;
    // processed counts DISPOSITIONS: 5 regenerated + 1 newly-recorded
    // unjudgeable exclusion (the trailing exclusion must count as chunk
    // progress or the drain kit would drop its tally with the final 0-chunk).
    check("drain dispositioned all stale clients", drainState.processed === 6, JSON.stringify(drainState));
    check("per-key tallies: regenerated 5", drainState.perKey.regenerated === 5, JSON.stringify(drainState.perKey));
    check("per-key tallies: unjudgeable exclusion survives into final state", drainState.perKey.no_usable_data_left_to_cron === 1, JSON.stringify(drainState.perKey));
    check("exactly five fresh AI calls", aiCallCount === aiBefore + 5, String(aiCallCount - aiBefore));
    check("drain finished clean", drainState.error === null, String(drainState.error));
    const summaryLine = formatRejudgeDrainSummary(drainState);
    check("summary renders dispositions, not a lying ratio", summaryLine.includes("re-judged 5 of 5 stale client(s)") && summaryLine.includes("1 unjudgeable"), summaryLine);

    const todaysRows = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientA));
    const latestA = todaysRows.sort((a, b) => (a.judgmentDate < b.judgmentDate ? 1 : -1))[0];
    check("A got a NEW judgment row (not an edit of the stale one)", todaysRows.length === 2, String(todaysRows.length));
    check("A's latest judgment stamps the current promptRevision", (latestA?.dataSourcesSummary as any)?.promptRevision === FINGERPRINT_REVISION, JSON.stringify((latestA?.dataSourcesSummary as any)?.promptRevision));
    check("A's latest judgment is a fresh generation, not carried forward", !(latestA?.dataSourcesSummary as any)?.carriedForward, undefined);

    console.log("\nConvergence:");
    const after = await countRejudgePending();
    check("regenerable converged to 0", after.regenerable === 0, JSON.stringify(after));
    check("B remains stale-but-excluded (honest residue, no perpetual pending)", after.stale === 1 && after.unjudgeable === 1, JSON.stringify(after));

    __resetDrainsForTest();
    const secondPress = await startRejudgeStaleJudgmentsDrain(null);
    check("second run → nothing-to-do", secondPress.state === "nothing-to-do", JSON.stringify(secondPress));

    const statusAfter = await action!.status();
    check("manual-lever status stays not-needed after generation convergence", statusAfter.state === "not-needed", statusAfter.detail);
    check("fresh-slate status remains blocked while unrepaired active clients remain", statusAfter.detail.includes("Blocked before deletion"), statusAfter.detail);

    console.log("\nRe-score progress (Task #4812, post-drain):");
    const progressAfter = await getRejudgeRescoreProgress();
    check("progress: idle again after the drain", progressAfter.running === false && progressAfter.runningSource === null, JSON.stringify(progressAfter));
    check("progress: A, F, G, H, and I re-scored fresh (fresh = 6: A + C + F + G + H + I)", progressAfter.fresh === 6, JSON.stringify(progressAfter));
    check("progress: unjudgeable B is the honest stale residue (stale = 1)", progressAfter.stale === 1 && progressAfter.totalJudged === 7, JSON.stringify(progressAfter));
    const portfolioAfter = await verifyRepairedRatingPortfolio();
    check("portfolio verifier shows six repaired rows after the drain", portfolioAfter.repairedRevisionRows === 6, JSON.stringify(portfolioAfter));
    check("portfolio verifier leaves only the unjudgeable and judgment-less residues", portfolioAfter.violations.length === 2 && portfolioAfter.violations.some(v => v.clientId === clientB) && portfolioAfter.violations.some(v => v.clientId === createdClients[4]), JSON.stringify(portfolioAfter.violations));

    console.log("\nIrreversible active-rating fresh slate:");
    // The two unrepaired accounts deliberately proved the block above. Move
    // them out of the active-customer scope; inactive history must survive.
    await db
      .update(clients)
      .set({ isArchived: true })
      .where(inArray(clients.id, [clientB, clientE]));

    // C's latest row is a completely valid carry-forward. The repaired
    // portfolio verifier accepts it, but fresh-slate cleanup cannot retain it
    // because its root is the older row that will be deleted. The operation
    // must force-generate a self-contained replacement before cleanup.
    const [rootC] = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientC));
    const rootCInventory = rootC.dataSourcesSummary as any;
    await db.insert(clientDailyJudgments).values({
      clientId: clientC,
      judgmentDate: isoDaysAgo(0),
      status: rootC.status,
      relationshipHealth: rootC.relationshipHealth,
      riskScore: rootC.riskScore,
      headline: `Valid carried rating ${RUN}`,
      communicationsAnalyzed: rootC.communicationsAnalyzed,
      dataSourcesSummary: {
        ...rootCInventory,
        generatedAt: new Date().toISOString(),
        tierGate: undefined,
        carriedForward: {
          fromDate: rootC.judgmentDate,
          fromJudgmentId: rootC.id,
          rootDate: rootC.judgmentDate,
          rootJudgmentId: rootC.id,
          rootTierGate: rootCInventory.tierGate,
        },
      },
    });
    await db.insert(rawCommunicationRecords).values({
      clientId: clientC,
      sourceType: "email",
      title: `RJ4048 comm C lineage ${RUN}`,
      timestamp: daysAgo(2),
      contentText: "Client checking in about the current portfolio review.",
      matchStatus: "matched",
    });

    const rowsBeforeCleanup = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientA));
    const retainedA = rowsBeforeCleanup
      .slice()
      .sort((a, b) =>
        a.judgmentDate === b.judgmentDate
          ? (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
          : a.judgmentDate < b.judgmentDate
            ? 1
            : -1
      )[0]!;
    const supersededA = rowsBeforeCleanup.find(row => row.id !== retainedA.id)!;
    check("A has a verified replacement before cleanup", rowsBeforeCleanup.length === 2);
    check(
      "retained replacement is self-contained (not carried)",
      !(retainedA.dataSourcesSummary as any)?.carriedForward,
      JSON.stringify(retainedA.dataSourcesSummary),
    );

    const [oldSignal] = await db.insert(clientRelationshipSignals).values({
      clientId: clientA,
      signalDate: `old-${RUN}`,
      judgmentId: supersededA.id,
      communicationCount: 1,
    }).returning({ id: clientRelationshipSignals.id });
    const [savePlay] = await db.insert(clientSavePlays).values({
      clientId: clientA,
      title: `Fresh slate dependency ${RUN}`,
      sourceJudgmentId: supersededA.id,
      assignedToUserId: operatorUserId,
      dueDate: isoDaysAgo(-7),
      status: "active",
      createdByUserId: operatorUserId,
    }).returning({ id: clientSavePlays.id });
    const [concernIntel] = await db.insert(clientConcernIntel).values({
      clientId: clientA,
      judgmentId: supersededA.id,
      concernText: `Historical concern ${RUN}`,
      intelType: "context",
      note: "Preserve this operator context after judgment cleanup.",
      createdBy: operatorUserId,
    }).returning({ id: clientConcernIntel.id });

    const ready = await getFreshSlateReadiness();
    check(
      "fresh-slate preflight is ready only after replacements verify",
      ready.state === "ready" &&
        ready.replacementClients === 1 &&
        ready.cleanupClients === 6,
      JSON.stringify(ready),
    );
    const competingLock = await acquireProdActionDrainLock(
      REJUDGE_STALE_JUDGMENTS_ACTION_ID,
    );
    check("competing instance acquired the real fresh-slate drain lock", competingLock !== null);
    try {
      const crossInstanceDuplicate = await startActiveRatingFreshSlateDrain(null);
      check(
        "cross-instance duplicate start is a safe no-op",
        crossInstanceDuplicate.state === "already-running",
        JSON.stringify(crossInstanceDuplicate),
      );
    } finally {
      await competingLock?.release();
    }

    // A cleanup exception must roll the client transaction back and surface
    // as a failed drain rather than silently claiming settlement.
    __test_setFreshSlateCleanup(async () => {
      throw new Error("fixture cleanup failure");
    });
    __resetDrainsForTest();
    const failedStart = await startActiveRatingFreshSlateDrain(null);
    check("confirmed cleanup failure run starts", failedStart.state === "started", JSON.stringify(failedStart));
    await waitForDrainEnd();
    const failedState = getDrainState(REJUDGE_STALE_JUDGMENTS_ACTION_ID)!;
    check(
      "valid carried latest is regenerated before any cleanup attempt",
      failedState.perKey.regenerated === 1,
      JSON.stringify(failedState.perKey),
    );
    check(
      "cleanup failure is a terminal failed outcome",
      failedState.error?.includes("fixture cleanup failure") === true,
      String(failedState.error),
    );
    const rowsAfterFailure = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientA));
    check("failed cleanup deletes no rating history", rowsAfterFailure.length === 2, String(rowsAfterFailure.length));

    __test_setFreshSlateCleanup(null);
    __resetDrainsForTest();
    let concurrentWriterSettled = false;
    let concurrentWriter: Promise<unknown> | null = null;
    let concurrentDependentSettled = false;
    let concurrentDependentRejected = false;
    let concurrentDependent: Promise<unknown> | null = null;
    __test_setFreshSlateCleanupLockHook(async () => {
      concurrentWriter = storage.upsertClientDailyJudgment({
        clientId: clientD,
        judgmentDate: isoDaysAgo(2),
        status: "Watch",
        overallStatus: "Watch",
        relationshipHealth: "Stable",
        relationshipStatus: "Stable",
        riskScore: 25,
        headline: `Concurrent archived rating ${RUN}`,
        communicationsAnalyzed: 0,
        dataSourcesSummary: rootCInventory,
      }).then(result => {
        concurrentWriterSettled = true;
        return result;
      });
      concurrentDependent = db.insert(clientRelationshipSignals).values({
        clientId: clientA,
        signalDate: `concurrent-old-${RUN}`,
        judgmentId: supersededA.id,
        communicationCount: 1,
      }).then(result => {
        concurrentDependentSettled = true;
        return result;
      }).catch(error => {
        concurrentDependentSettled = true;
        concurrentDependentRejected = true;
        return error;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      check(
        "concurrent normal judgment writer is blocked during atomic cleanup",
        concurrentWriterSettled === false,
      );
      check(
        "concurrent dependent writer is blocked while exact dispositions are counted",
        concurrentDependentSettled === false,
      );
    });
    const started = await action!.apply(null, {
      confirmation: FRESH_SLATE_DESTRUCTIVE_CONFIRMATION,
    });
    check("typed destructive confirmation starts the fresh-slate drain", started.state === "applied", started.detail);
    const duplicate = await startActiveRatingFreshSlateDrain(null);
    check("duplicate start is a safe no-op", duplicate.state === "already-running", JSON.stringify(duplicate));
    await waitForDrainEnd();
    await concurrentWriter;
    await concurrentDependent;
    __test_setFreshSlateCleanupLockHook(null);
    check(
      "blocked normal judgment writer resumes after atomic cleanup commits",
      concurrentWriterSettled,
    );
    check(
      "dependent write against deleted history resumes and fails after cleanup",
      concurrentDependentSettled && concurrentDependentRejected,
    );
    const freshSlateState = getDrainState(REJUDGE_STALE_JUDGMENTS_ACTION_ID)!;
    check("fresh-slate drain finishes without error", freshSlateState.error === null, String(freshSlateState.error));
    check("six active client histories cleaned", freshSlateState.perKey.clients_cleaned === 6, JSON.stringify(freshSlateState.perKey));
    check("six superseded judgments permanently deleted", freshSlateState.perKey.judgments_deleted === 6, JSON.stringify(freshSlateState.perKey));
    check("post-run portfolio verifier recorded", freshSlateState.perKey.portfolio_verified === 1, JSON.stringify(freshSlateState.perKey));
    const finalSummary = formatFreshSlateDrainSummary(freshSlateState);
    check(
      "audit summary distinguishes irreversible cleanup and actual distribution",
      finalSummary.includes("permanently deleted 6 superseded judgment(s)") &&
        finalSummary.includes("post-run verified 6 active client(s)"),
      finalSummary,
    );

    const finalVerification = await verifyActiveRatingFreshSlate();
    check("post-run fresh-slate verifier passes", finalVerification.passed, JSON.stringify(finalVerification));
    check(
      "every active client has exactly one retained rating",
      finalVerification.historyRows === finalVerification.portfolio.activeAccounts &&
        finalVerification.activeAccountsWithExactlyOne === finalVerification.portfolio.activeAccounts &&
        finalVerification.activeAccountsWithMultiple === 0,
      JSON.stringify(finalVerification),
    );
    check("no retained rating depends on carried lineage", finalVerification.carriedForwardLatestRows === 0, JSON.stringify(finalVerification));

    check(
      "relationship signal tied to deleted judgment cascades",
      (await db.select().from(clientRelationshipSignals).where(eq(clientRelationshipSignals.id, oldSignal.id))).length === 0,
    );
    const savedPlayRows = await db
      .select()
      .from(clientSavePlays)
      .where(eq(clientSavePlays.id, savePlay.id));
    check(
      "save play survives with deleted judgment link cleared",
      savedPlayRows.length === 1 && savedPlayRows[0].sourceJudgmentId === null,
      JSON.stringify(savedPlayRows),
    );
    const concernRows = await db
      .select()
      .from(clientConcernIntel)
      .where(eq(clientConcernIntel.id, concernIntel.id));
    check(
      "concern intelligence and historical judgment reference are preserved",
      concernRows.length === 1 && concernRows[0].judgmentId === supersededA.id,
      JSON.stringify(concernRows),
    );
    const inactiveBHistory = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientB));
    check("inactive-client history is untouched", inactiveBHistory.length === 1, String(inactiveBHistory.length));
    const archivedDHistory = await db
      .select()
      .from(clientDailyJudgments)
      .where(eq(clientDailyJudgments.clientId, clientD));
    check(
      "concurrent inactive-client rating is never swept as active history",
      archivedDHistory.length === 2,
      String(archivedDHistory.length),
    );
    const settledStatus = await action!.status();
    check(
      "operator status reports settled distribution",
      settledStatus.state === "not-needed" &&
        settledStatus.detail.includes("Settled and verified") &&
        settledStatus.detail.includes("Distribution:"),
      settledStatus.detail,
    );
  } finally {
    try {
      if (createdClients.length > 0) {
        await db.delete(rawCommunicationRecords).where(inArray(rawCommunicationRecords.clientId, createdClients));
        await db.delete(clients).where(inArray(clients.id, createdClients)); // cascades judgments
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failed++;
    }
    __resetDrainsForTest();
    __test_setJudgmentChatCreate(null);
    __test_setJudgmentFactExtractor(null);
    __test_setRejudgeSleep(null);
    __test_setFreshSlateCleanup(null);
    __test_setFreshSlateCleanupLockHook(null);
    try {
      await db.delete(users).where(eq(users.id, operatorUserId));
    } catch { /* client cleanup above should have released user references */ }
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
