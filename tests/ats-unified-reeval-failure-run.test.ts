/* test-registration
{
  "name": "ATS unified re-eval failure path writes a diagnosable ats_ai_runs row (Task #4228)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the only diagnosable record a failed unified re-scoring run leaves behind. F10 (Task #4156) fixed the catch block in server/services/atsUnifiedScoring.ts so a non-Error throw can no longer persist an empty error_message; nothing else covers this failure branch, so a regression would silently make failed scoring runs undiagnosable again. Hermetic per-run DB, all OpenAI traffic stubbed via a resolve-hook redirect of the canonical adapter — fast and deterministic.",
  "extraEnv": { "NODE_ENV": "test" },
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/atsUnifiedOpenAiSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4228 — reEvaluateDimensions (server/services/atsUnifiedScoring.ts)
 * failure path:
 *
 *   1. An Error throw from the AI call persists an ats_ai_runs row with
 *      stageName "unified_dimension_reeval", success=false, and a non-empty
 *      string errorMessage (the Error's message), and the ORIGINAL Error
 *      object still propagates to the caller (rethrow intact — same
 *      reference, stack and all).
 *   2. A non-Error throw (a bare string here — the F10 / Task #4156 fix
 *      target: `error.message` is undefined, so before the fix the row
 *      stored NULL/undefined) persists a row whose errorMessage is the
 *      String()-normalized value — still a non-empty string — and the
 *      original thrown value propagates unchanged.
 *
 * The OpenAI adapter is swapped by tests/helpers/atsUnifiedOpenAiLoader.mjs
 * (registered via extraNodeArgs --import) BEFORE atsUnifiedScoring evaluates
 * its module-local `const openai = createDefaultOpenAiClient()`, so the
 * test scripts exactly what the AI call throws. No network traffic.
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

  const suffix = randomUUID().slice(0, 8);
  const cleanupCandidateIds: string[] = [];
  let jobId: string | undefined;

  try {
    // ── Fixture: job + candidate with assessment scores + submission +
    //    analyzed phone interview — everything the pre-try guards require,
    //    so control reaches the AI call inside the try block. ─────────────
    const [job] = await db.insert(atsJobs).values({
      title: `Failure-path fixture job ${suffix}`,
      description: "Task #4228 fixture — unified re-eval failure path",
      status: "active",
    }).returning();
    jobId = job.id;

    async function seedCandidate(label: string): Promise<string> {
      const [candidate] = await db.insert(atsCandidates).values({
        jobId: job.id,
        name: `Failure-path fixture candidate ${label} ${suffix}`,
        email: `ats-4228-${label}-${suffix}@example.test`,
        stage: "interviewing",
        accessToken: `ats-4228-${label}-${suffix}-${randomUUID()}`,
        // v2 ScoringResult era shape — readAtsAiScore must decode it or the
        // pre-try "no assessment scores" guard throws before the try block.
        aiScoreJson: {
          role_skill_score: 70, role_behavior_score: 65, reality_based_score: 60,
          personality_alignment_score: 55, communication_clarity_score: 75,
          base_total: 66.75, low_effort_multiplier: 1, stress_multiplier: 1,
          final_score: 66.75, hard_fail_triggered: false,
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

      await db.insert(atsInterviews).values({
        candidateId: candidate.id,
        jobId: job.id,
        interviewType: "phone",
        analysisStatus: "analyzed",
        analysisJson: {
          summary: "Strong call",
          professionalismSignal: "high",
          recommendedOutcome: "advance",
        },
      });
      return candidate.id;
    }

    async function failedRunsFor(candidateId: string) {
      return db.select().from(atsAiRuns).where(and(
        eq(atsAiRuns.candidateId, candidateId),
        eq(atsAiRuns.stageName, "unified_dimension_reeval"),
      ));
    }

    // ── Case 1: Error throw ──────────────────────────────────────────────
    {
      const candidateId = await seedCandidate("err");
      const thrown = new Error(`vendor exploded ${suffix}`);
      __setChatCompletionsCreate(async () => {
        throw thrown;
      });

      let caught: unknown;
      try {
        await reEvaluateDimensions(candidateId, "phone");
        assert.fail("reEvaluateDimensions must rethrow the AI-call failure");
      } catch (e) {
        caught = e;
      }
      assert.ok(Object.is(caught, thrown), "Error case: the ORIGINAL Error object propagates (rethrow intact)");

      const runs = await failedRunsFor(candidateId);
      assert.equal(runs.length, 1, "Error case: exactly one unified_dimension_reeval run row is written");
      const run = runs[0];
      assert.equal(run.stageName, "unified_dimension_reeval");
      assert.equal(run.success, false, "Error case: run row records success=false");
      assert.equal(typeof run.errorMessage, "string", "Error case: errorMessage is a string");
      assert.ok(run.errorMessage!.length > 0, "Error case: errorMessage is non-empty");
      assert.equal(run.errorMessage, `vendor exploded ${suffix}`, "Error case: errorMessage carries the Error's message");
      assert.equal(run.jobId, job.id, "Error case: run row is attributed to the job");
      assert.equal(run.outputJson, null, "Error case: failed run has no outputJson");
    }

    // ── Case 2: non-Error throw (the F10 / Task #4156 regression target) ─
    {
      const candidateId = await seedCandidate("str");
      const thrown = `bare string failure ${suffix}`;
      __setChatCompletionsCreate(async () => {
        // A non-Error throw: error.message is undefined, so only the F10
        // String(error) normalization produces a non-empty errorMessage.
        throw thrown;
      });

      let caught: unknown;
      try {
        await reEvaluateDimensions(candidateId, "phone");
        assert.fail("reEvaluateDimensions must rethrow the non-Error failure");
      } catch (e) {
        caught = e;
      }
      assert.ok(Object.is(caught, thrown), "non-Error case: the ORIGINAL thrown value propagates unchanged");

      const runs = await failedRunsFor(candidateId);
      assert.equal(runs.length, 1, "non-Error case: exactly one unified_dimension_reeval run row is written");
      const run = runs[0];
      assert.equal(run.success, false, "non-Error case: run row records success=false");
      assert.equal(typeof run.errorMessage, "string", "non-Error case: errorMessage is a string, never NULL/undefined");
      assert.ok(run.errorMessage!.length > 0, "non-Error case: errorMessage is non-empty");
      assert.equal(
        run.errorMessage,
        `bare string failure ${suffix}`,
        "non-Error case: errorMessage is the String()-normalized thrown value",
      );
    }

    console.log("[ats-unified-reeval-failure-run] PASS");
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
  console.error("[ats-unified-reeval-failure-run] FAIL:", err);
  process.exitCode = 1;
});
