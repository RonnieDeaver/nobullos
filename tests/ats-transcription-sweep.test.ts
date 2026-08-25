/* test-registration
{
  "name": "ATS transcription fallback sweeper (task #3963, audit B-012)",
  "smoke": true,
  "smokeReason": "Task #3963 / audit B-012 — the sweeper is the correctness backstop when the Rev.ai completion callback never arrives: pins recovery of transcribed jobs, typed terminal failures (rev_job_failed / job_not_found / job_timeout / submit_lost), min-age exclusion, bounded oldest-first batching, kill-switch skip, and transient-error retry semantics. Fixture-scoped via restrictToSubmissionIds so shared-DB neighbors are never touched; all Rev.ai traffic stubbed; hermetic per-run DB.",
  "extraEnv": { "NODE_ENV": "test" },
  "tier": "small"
}
test-registration */
/**
 * Task #3963 (audit B-012) — sweepAtsTranscriptions:
 *
 *   1. Bounded oldest-first batch (limit=3 finalizes the 3 stalest rows).
 *   2. transcribed → completed; vendor failed → rev_job_failed; status 404 →
 *      job_not_found; in_progress past give-up → job_timeout; no rev_job_id
 *      past the submit-lost window → submit_lost.
 *   3. Fresh rows (younger than minAge) are never scanned; younger-than-window
 *      rows are left 'processing'.
 *   4. Transient Rev.ai errors count as errors and leave the row untouched.
 *   5. Kill switch short-circuits the sweep entirely.
 *   6. Empty restrict list is a no-op.
 */
import assert from "node:assert/strict";

const PREV_TOKEN = process.env.REV_AI_API_TOKEN;
process.env.REV_AI_API_TOKEN = `revai_test_${process.pid}`;

const MIN = 60_000;
const HOUR = 3_600_000;

async function main(): Promise<void> {
  const { isUpstashRedisUrl, makeUpstashPassthroughResponse } = await import(
    "./helpers/upstashFetchStub"
  );
  const { db } = await import("../server/db");
  const { atsJobs, atsCandidates, atsSubmissions } = await import("../shared/schema");
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { sweepAtsTranscriptions } = await import("../server/services/atsTranscriptionSweep");
  const { setKillSwitch } = await import("../server/services/killSwitches");

  // ── Rev.ai fetch stub ───────────────────────────────────────────────────
  const realFetch = global.fetch;
  const statusByJob = new Map<string, () => Response>();
  const transcriptByJob = new Map<string, () => Response>();
  global.fetch = (async (input: any, init?: any) => {
    if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("https://api.rev.ai/")) {
      const m = url.match(/\/jobs\/([^/]+?)(\/transcript)?$/);
      if (m && m[2]) {
        const f = transcriptByJob.get(m[1]);
        return f ? f() : new Response("transcript not found", { status: 404 });
      }
      if (m) {
        const f = statusByJob.get(m[1]);
        return f
          ? f()
          : new Response(JSON.stringify({ error: "job not found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: `unexpected rev.ai call: ${url}` }), {
        status: 500,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // ── Fixtures (ages via transcription_updated_at) ────────────────────────
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const jobId = `t3963sw-job-${suffix}`;
  const candId = `t3963sw-cand-${suffix}`;
  const sub = (k: string) => `t3963sw-${k}-${suffix}`;
  const rj = (k: string) => `rj-${k}-${suffix}`;
  const S = {
    done: sub("done"),   // 40 min, transcribed → completed
    fail: sub("fail"),   // 35 min, vendor failed → rev_job_failed
    gone: sub("gone"),   // 30 min, status 404 → job_not_found
    old: sub("old"),     // 25 h, in_progress → job_timeout
    wait: sub("wait"),   // 10 min, in_progress → untouched
    lost: sub("lost"),   // 2 h, no rev job id → submit_lost
    young: sub("young"), // 10 min, no rev job id → untouched
    fresh: sub("fresh"), // 1 min → excluded by minAge
    err: sub("err"),     // 30 min, Rev.ai 503 → transient error, untouched
  } as const;
  const allIds = Object.values(S);

  const rows: Array<{ id: string; revJobId: string | null; ageMs: number }> = [
    { id: S.done, revJobId: rj("done"), ageMs: 40 * MIN },
    { id: S.fail, revJobId: rj("fail"), ageMs: 35 * MIN },
    { id: S.gone, revJobId: rj("gone"), ageMs: 30 * MIN },
    { id: S.old, revJobId: rj("old"), ageMs: 25 * HOUR },
    { id: S.wait, revJobId: rj("wait"), ageMs: 10 * MIN },
    { id: S.lost, revJobId: null, ageMs: 2 * HOUR },
    { id: S.young, revJobId: null, ageMs: 10 * MIN },
    { id: S.fresh, revJobId: rj("fresh"), ageMs: 1 * MIN },
    { id: S.err, revJobId: rj("err"), ageMs: 30 * MIN },
  ];

  statusByJob.set(rj("done"), () =>
    new Response(JSON.stringify({ id: rj("done"), status: "transcribed" }), { status: 200 }),
  );
  transcriptByJob.set(rj("done"), () => new Response("recovered text", { status: 200 }));
  statusByJob.set(rj("fail"), () =>
    new Response(
      JSON.stringify({
        id: rj("fail"),
        status: "failed",
        failure: "download_failure",
        failure_detail: "media url expired",
      }),
      { status: 200 },
    ),
  );
  // rj("gone"): no stub entry → 404 from the stub's default.
  for (const k of ["old", "wait", "fresh"] as const) {
    statusByJob.set(rj(k), () =>
      new Response(JSON.stringify({ id: rj(k), status: "in_progress" }), { status: 200 }),
    );
  }
  statusByJob.set(rj("err"), () => new Response("upstream oops", { status: 503 }));

  const loadRow = async (id: string) => {
    const [row] = await db.select().from(atsSubmissions).where(eq(atsSubmissions.id, id));
    return row;
  };

  // Kill-switch snapshot (restore in finally; delete row if absent before).
  const ksKey = "kill_switch_ats_revai_transcription";
  const pre = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${ksKey}`);
  const hadKsRow = (pre.rows?.length ?? 0) > 0;
  const prevKsValue = hadKsRow ? String((pre.rows[0] as any).value) : null;

  let passed = 0;
  try {
    await db.insert(atsJobs).values({
      id: jobId,
      title: "t3963 fixture role",
      description: "task #3963 sweep-test fixture",
    });
    await db.insert(atsCandidates).values({
      id: candId,
      jobId,
      name: "T3963 Sweep Fixture",
      email: `t3963sw-${suffix}@example.test`,
      accessToken: `t3963swtok-${suffix}`,
    });
    const now = Date.now();
    await db.insert(atsSubmissions).values(
      rows.map((r) => ({
        id: r.id,
        candidateId: candId,
        jobId,
        // Task #4705 — (candidate_id, question_id) is unique now; derive the
        // question id from the submission id so bulk fixtures don't collide.
        questionId: `q-${r.id}`,
        questionType: "video",
        videoObjectKey: `/objects/${r.id}.webm`,
        transcriptionStatus: "processing",
        revJobId: r.revJobId,
        transcriptionUpdatedAt: new Date(now - r.ageMs),
      })),
    );

    // Group 1: bounded oldest-first batch — limit 3 takes the 3 stalest
    // (old 25h → timeout, lost 2h → submit_lost, done 40min → completed).
    {
      const summary = await sweepAtsTranscriptions({
        limit: 3,
        restrictToSubmissionIds: [...allIds],
      });
      assert.equal(summary.skipped, null);
      assert.equal(summary.scanned, 3, "limit bounds the batch");
      assert.equal(summary.timedOut, 1, "25h in_progress → job_timeout");
      assert.equal(summary.submitLost, 1, "2h with no rev job id → submit_lost");
      assert.equal(summary.completed, 1, "transcribed job recovered");

      const oldRow = await loadRow(S.old);
      assert.equal(oldRow?.transcriptionStatus, "failed");
      assert.equal(oldRow?.transcriptionFailureCode, "job_timeout");
      const lostRow = await loadRow(S.lost);
      assert.equal(lostRow?.transcriptionStatus, "failed");
      assert.equal(lostRow?.transcriptionFailureCode, "submit_lost");
      assert.ok(
        (lostRow?.transcriptionFailureDetail ?? "").includes("retry"),
        "submit_lost detail points the operator at the retry path",
      );
      const doneRow = await loadRow(S.done);
      assert.equal(doneRow?.transcriptionStatus, "completed", "callback-less job recovered");
      assert.equal(doneRow?.transcriptText, "recovered text");
      assert.equal(doneRow?.transcriptionFailureCode, null);
      passed++;
    }

    // Group 2: remaining eligible rows — typed failures + untouched rows.
    {
      const summary = await sweepAtsTranscriptions({
        restrictToSubmissionIds: [...allIds],
      });
      assert.equal(summary.scanned, 5, "fail/gone/err/wait/young scanned (fresh under minAge)");
      assert.equal(summary.failed, 2, "vendor failure + vanished job are terminal");
      assert.equal(summary.errors, 1, "Rev.ai 503 counted as transient error");
      assert.equal(summary.inProgress, 2, "wait + young left in flight");

      const failRow = await loadRow(S.fail);
      assert.equal(failRow?.transcriptionStatus, "failed");
      assert.equal(failRow?.transcriptionFailureCode, "rev_job_failed");
      assert.ok(
        (failRow?.transcriptionFailureDetail ?? "").includes("download_failure"),
        "vendor failure + detail persisted",
      );
      const goneRow = await loadRow(S.gone);
      assert.equal(goneRow?.transcriptionStatus, "failed");
      assert.equal(goneRow?.transcriptionFailureCode, "job_not_found");
      const errRow = await loadRow(S.err);
      assert.equal(errRow?.transcriptionStatus, "processing", "transient error leaves the row");
      assert.equal(errRow?.transcriptionFailureCode, null);
      const freshRow = await loadRow(S.fresh);
      assert.equal(freshRow?.transcriptionStatus, "processing", "fresh row never scanned");
      passed++;
    }

    // Group 3: shrunken windows convert the in-flight rows.
    {
      const summary = await sweepAtsTranscriptions({
        giveUpMs: 5 * MIN,
        submitLostMs: 5 * MIN,
        restrictToSubmissionIds: [S.wait, S.young],
      });
      assert.equal(summary.scanned, 2);
      assert.equal(summary.timedOut, 1, "10min in_progress past 5min give-up → job_timeout");
      assert.equal(summary.submitLost, 1, "10min no-job row past 5min window → submit_lost");
      const waitRow = await loadRow(S.wait);
      assert.equal(waitRow?.transcriptionFailureCode, "job_timeout");
      const youngRow = await loadRow(S.young);
      assert.equal(youngRow?.transcriptionFailureCode, "submit_lost");
      passed++;
    }

    // Group 4: kill switch short-circuits the sweep.
    {
      await setKillSwitch("ats_revai_transcription", true, "test");
      const summary = await sweepAtsTranscriptions({ restrictToSubmissionIds: [...allIds] });
      await setKillSwitch("ats_revai_transcription", false, "test");
      assert.equal(summary.skipped, "kill_switch");
      assert.equal(summary.scanned, 0, "no rows touched while parked");
      passed++;
    }

    // Group 5: empty restrict list is a no-op (test-isolation seam).
    {
      const summary = await sweepAtsTranscriptions({ restrictToSubmissionIds: [] });
      assert.equal(summary.scanned, 0);
      passed++;
    }

    console.log(`ats-transcription-sweep: ${passed} groups passed`);
  } finally {
    global.fetch = realFetch;
    if (PREV_TOKEN === undefined) delete process.env.REV_AI_API_TOKEN;
    else process.env.REV_AI_API_TOKEN = PREV_TOKEN;
    try {
      await setKillSwitch("ats_revai_transcription", prevKsValue === "true", "test");
      if (!hadKsRow) {
        await db.execute(sql`DELETE FROM system_settings WHERE key = ${ksKey}`);
      }
      await db.delete(atsSubmissions).where(inArray(atsSubmissions.id, allIds));
      await db.delete(atsCandidates).where(eq(atsCandidates.id, candId));
      await db.delete(atsJobs).where(eq(atsJobs.id, jobId));
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
