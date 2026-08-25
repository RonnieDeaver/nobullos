/* test-registration
{
  "name": "ATS unified re-eval success path computes scores and records a success ats_ai_runs row (Task #4251)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the SUCCESS branch of the unified re-scoring run in server/services/atsUnifiedScoring.ts: weighted base-total math, multiplier/hard-fail handling of the assessment base score, stage-count confidence, the dimension-history entry, and the success=true ats_ai_runs audit row whose insert is .catch-swallowed by design — a regression would silently corrupt candidate scores or drop the audit record with no other coverage. Hermetic per-run DB, all OpenAI traffic stubbed via the existing resolve-hook trio — fast and deterministic.",
  "extraEnv": { "NODE_ENV": "test" },
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/atsUnifiedOpenAiSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4251 — reEvaluateDimensions (server/services/atsUnifiedScoring.ts)
 * success path:
 *
 *   1. A stubbed OpenAI response with valid JSON matching
 *      UnifiedDimensionScoresSchema returns a ReEvaluationResult whose
 *      newBaseTotal applies the DIMENSION_WEIGHTS (0.50/0.35/0.15, the two
 *      zero-weight dimensions excluded), whose newAssessmentBaseScore applies
 *      the candidate's low-effort and stress multipliers, whose confidence
 *      follows CONFIDENCE_BY_STAGE_COUNT for the completed evidence stages
 *      (assessment + analyzed interviews), and whose dimensionHistoryEntry
 *      carries the trigger stage, new scores, base total, and trigger label.
 *   2. A success=true ats_ai_runs row is written with stageName
 *      "unified_dimension_reeval", populated outputJson (the validated AI
 *      output), inputRefs carrying trigger/evidence-stage/previous-dimension
 *      context, and no errorMessage. The insert is .catch-swallowed by
 *      design, but it is awaited, so it must exist by the time the function
 *      returns.
 *   3. hard_fail_triggered=true on the candidate's stored assessment score
 *      zeroes newAssessmentBaseScore while newBaseTotal is still computed.
 *
 * The OpenAI adapter is swapped by tests/helpers/atsUnifiedOpenAiLoader.mjs
 * (registered via extraNodeArgs --import) BEFORE atsUnifiedScoring evaluates
 * its module-local `const openai = createDefaultOpenAiClient()`. No network
 * traffic. Same fixture-seeding pattern as
 * tests/ats-unified-reeval-failure-run.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  const { __setChatCompletionsCreate, __resetChatCompletionsCreate } = await import(
    "./helpers/atsUnifiedOpenAiStub.mjs"
  );
  const { db } = await import("../server/db");
  const { atsJobs, atsCandidates, atsSubmissions, atsInterviews, atsAiRuns } =
    await import("../shared/schema");
  const { eq, and, inArray } = await import("drizzle-orm");
  const { reEvaluateDimensions } = await import("../server/services/atsUnifiedScoring");
  const { CANONICAL_SCORING_DIMENSIONS } = await import("../server/services/atsTypes");

  const suffix = randomUUID().slice(0, 8);
  const cleanupCandidateIds: string[] = [];
  let jobId: string | undefined;

  // The exact dimension scores the stubbed AI returns.
  const AI_SCORES = {
    role_skill: 82,
    role_behavior: 74,
    reality_based_mindset: 66,
    personality_alignment: 91,
    communication_clarity: 58,
  } as const;

  function buildAiPayload() {
    return {
      ...AI_SCORES,
      dimension_reasoning: CANONICAL_SCORING_DIMENSIONS.map((dimension: string) => ({
        dimension,
        score: AI_SCORES[dimension as keyof typeof AI_SCORES],
        assessment_signal: `assessment signal for ${dimension}`,
        interview_signal: `interview signal for ${dimension}`,
        net_change_reason: `net change reason for ${dimension}`,
      })),
      confidence_note: `stubbed confidence note ${suffix}`,
      overall_evidence_quality: "strong",
    };
  }

  function stubValidResponse() {
    __setChatCompletionsCreate(async () => ({
      choices: [{ message: { content: JSON.stringify(buildAiPayload()) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  }

  try {
    const [job] = await db.insert(atsJobs).values({
      title: `Success-path fixture job ${suffix}`,
      description: "Task #4251 fixture — unified re-eval success path",
      status: "active",
    }).returning();
    jobId = job.id;

    async function seedCandidate(
      label: string,
      opts: {
        lowEffortMultiplier: number;
        stressMultiplier: number;
        hardFailTriggered: boolean;
        interviewTypes: string[];
      },
    ): Promise<string> {
      const [candidate] = await db.insert(atsCandidates).values({
        jobId: job.id,
        name: `Success-path fixture candidate ${label} ${suffix}`,
        email: `ats-4251-${label}-${suffix}@example.test`,
        stage: "interviewing",
        accessToken: `ats-4251-${label}-${suffix}-${randomUUID()}`,
        // v2 ScoringResult era shape — readAtsAiScore must decode it or the
        // pre-try "no assessment scores" guard throws before the try block.
        aiScoreJson: {
          role_skill_score: 70, role_behavior_score: 65, reality_based_score: 60,
          personality_alignment_score: 55, communication_clarity_score: 75,
          base_total: 66.75,
          low_effort_multiplier: opts.lowEffortMultiplier,
          stress_multiplier: opts.stressMultiplier,
          final_score: 66.75,
          hard_fail_triggered: opts.hardFailTriggered,
        },
      }).returning();
      cleanupCandidateIds.push(candidate.id);

      await db.insert(atsSubmissions).values({
        candidateId: candidate.id,
        jobId: job.id,
        questionId: `q-${label}-${suffix}`,
        questionType: "text",
        questionLayer: "role_skill",
        responseText: "I built the reporting pipeline end to end.",
      });

      for (const interviewType of opts.interviewTypes) {
        await db.insert(atsInterviews).values({
          candidateId: candidate.id,
          jobId: job.id,
          interviewType,
          analysisStatus: "analyzed",
          analysisJson: {
            summary: `Strong ${interviewType} interview`,
          },
        });
      }
      return candidate.id;
    }

    async function runsFor(candidateId: string) {
      return db.select().from(atsAiRuns).where(and(
        eq(atsAiRuns.candidateId, candidateId),
        eq(atsAiRuns.stageName, "unified_dimension_reeval"),
      ));
    }

    // Expected weighted base total from the stubbed AI scores:
    // 82*0.50 + 74*0.35 + 66*0.15 = 41 + 25.9 + 9.9 = 76.8
    // (personality_alignment and communication_clarity carry zero weight).
    const EXPECTED_BASE_TOTAL = 76.8;

    // ── Case 1: normal success — multipliers applied, 3 evidence stages ──
    {
      const candidateId = await seedCandidate("ok", {
        lowEffortMultiplier: 0.9,
        stressMultiplier: 0.85,
        hardFailTriggered: false,
        interviewTypes: ["phone", "story"],
      });
      stubValidResponse();

      const result = await reEvaluateDimensions(candidateId, "story");

      assert.equal(result.newBaseTotal, EXPECTED_BASE_TOTAL,
        "newBaseTotal applies DIMENSION_WEIGHTS 0.50/0.35/0.15 to the AI scores");
      // 76.8 * 0.9 * 0.85 = 58.752 → rounded to 58.75
      assert.equal(result.newAssessmentBaseScore, 58.75,
        "newAssessmentBaseScore applies the stored low-effort and stress multipliers, rounded to 2dp");

      // Evidence stages: assessment + phone + story = 3 → confidence 0.70.
      assert.equal(result.evidenceStageCount, 3, "assessment + 2 analyzed interviews = 3 evidence stages");
      assert.equal(result.confidence, 0.70, "confidence follows CONFIDENCE_BY_STAGE_COUNT for 3 stages");

      // Returned dimension scores are the validated AI output.
      for (const dim of Object.keys(AI_SCORES) as (keyof typeof AI_SCORES)[]) {
        assert.equal(result.newDimensionScores[dim], AI_SCORES[dim],
          `newDimensionScores.${dim} carries the AI-returned score`);
      }
      assert.equal(result.newDimensionScores.confidence_note, `stubbed confidence note ${suffix}`);
      assert.equal(result.newDimensionScores.overall_evidence_quality, "strong");
      assert.equal(result.newDimensionScores.dimension_reasoning.length, 5);

      // Dimension-history entry shape.
      const entry = result.dimensionHistoryEntry;
      assert.equal(entry.stage, "story", "history entry stage is the trigger interview type");
      assert.equal(entry.trigger, "after_story_interview", "history entry trigger label");
      assert.equal(entry.base_total, EXPECTED_BASE_TOTAL, "history entry carries the new base total");
      assert.deepEqual(entry.scores, { ...AI_SCORES }, "history entry carries the new dimension scores");
      assert.ok(
        typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)),
        "history entry timestamp is a parseable ISO string",
      );

      // Success audit row — the insert is .catch-swallowed but awaited, so
      // it must already exist.
      const runs = await runsFor(candidateId);
      assert.equal(runs.length, 1, "exactly one unified_dimension_reeval run row is written");
      const run = runs[0];
      assert.equal(run.success, true, "run row records success=true");
      assert.equal(run.jobId, job.id, "run row is attributed to the job");
      assert.ok(run.outputJson, "success run has populated outputJson");
      const output = run.outputJson as Record<string, unknown>;
      assert.equal(output.role_skill, AI_SCORES.role_skill, "outputJson stores the validated AI output");
      assert.equal(output.confidence_note, `stubbed confidence note ${suffix}`);
      const inputRefs = run.inputRefs as Record<string, unknown>;
      assert.equal(inputRefs.triggerInterviewType, "story", "inputRefs records the trigger interview type");
      assert.deepEqual(inputRefs.evidenceStages, ["assessment", "phone", "story"],
        "inputRefs records the completed evidence stages");
      assert.deepEqual(inputRefs.previousDimensions, {
        role_skill: 70, role_behavior: 65, reality_based_mindset: 60,
        personality_alignment: 55, communication_clarity: 75,
      }, "inputRefs records the pre-re-eval dimension scores");
      assert.equal(run.errorMessage, null, "success run has no errorMessage");
      assert.ok(run.startedAt instanceof Date && run.finishedAt instanceof Date,
        "run row has startedAt and finishedAt stamps");
    }

    // ── Case 2: hard-fail zeroing — base total still computed ────────────
    {
      const candidateId = await seedCandidate("hf", {
        lowEffortMultiplier: 0.9,
        stressMultiplier: 0.85,
        hardFailTriggered: true,
        interviewTypes: ["phone"],
      });
      stubValidResponse();

      const result = await reEvaluateDimensions(candidateId, "phone");

      assert.equal(result.newBaseTotal, EXPECTED_BASE_TOTAL,
        "hard-fail case: newBaseTotal is still the weighted total");
      assert.equal(result.newAssessmentBaseScore, 0,
        "hard-fail case: hard_fail_triggered zeroes newAssessmentBaseScore regardless of multipliers");
      assert.equal(result.evidenceStageCount, 2, "assessment + phone = 2 evidence stages");
      assert.equal(result.confidence, 0.55, "confidence follows CONFIDENCE_BY_STAGE_COUNT for 2 stages");
      assert.equal(result.dimensionHistoryEntry.stage, "phone");
      assert.equal(result.dimensionHistoryEntry.trigger, "after_phone_interview");

      const runs = await runsFor(candidateId);
      assert.equal(runs.length, 1, "hard-fail case: exactly one run row is written");
      assert.equal(runs[0].success, true, "hard-fail case: the run itself is still a success");
      assert.ok(runs[0].outputJson, "hard-fail case: outputJson populated");
    }

    console.log("[ats-unified-reeval-success-run] PASS");
  } finally {
    __resetChatCompletionsCreate();
    try {
      if (cleanupCandidateIds.length > 0) {
        await db.delete(atsAiRuns).where(inArray(atsAiRuns.candidateId, cleanupCandidateIds));
        await db.delete(atsInterviews).where(inArray(atsInterviews.candidateId, cleanupCandidateIds));
        await db.delete(atsSubmissions).where(inArray(atsSubmissions.candidateId, cleanupCandidateIds));
        await db.delete(atsCandidates).where(inArray(atsCandidates.id, cleanupCandidateIds));
      }
      if (jobId) await db.delete(atsJobs).where(eq(atsJobs.id, jobId));
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }
}

main().catch((err) => {
  console.error("[ats-unified-reeval-success-run] FAIL:", err);
  process.exitCode = 1;
});
