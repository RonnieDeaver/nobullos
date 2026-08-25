/* test-registration
{
  "name": "ATS transcription callback flow (task #3963, audit B-012)",
  "smoke": true,
  "smokeReason": "Task #3963 / audit B-012 — pins the headline regression this task fixes: a Rev.ai job outliving the optimistic poll window stays 'processing' (never falsely 'failed'), submission registers notification_config (public URL + Bearer secret) inside the documented multipart options part, the callback then finalizes completion, quick jobs still complete inline, and terminal failures persist typed codes (submit_failed) with detail. Kill switch parks un-submitted rows. Audio pipeline stubbed via the service test seam; all Rev.ai traffic stubbed at global.fetch; hermetic per-run DB.",
  "extraEnv": { "NODE_ENV": "test" },
  "tier": "small"
}
test-registration */
/**
 * Task #3963 (audit B-012) — transcribeVideoSubmission end-to-end (service
 * level, Rev.ai + audio pipeline stubbed):
 *
 *   A. Submission registers `notification_config` in the `options` multipart
 *      part; poll-window expiry leaves the row 'processing' with revJobId
 *      persisted and prior failure fields cleared — NOT 'failed'.
 *   B. The completion callback (processRevAiCallback) then finalizes the row.
 *   C. Quick jobs still complete inline through the optimistic poll.
 *   D. Empty transcript → 'empty'.
 *   E. Rev.ai submit 5xx → typed 'submit_failed' + detail.
 *   F. ats_revai_transcription kill switch → row parked un-submitted.
 *   G. Without REV_AI_CALLBACK_SECRET, submission omits notification_config
 *      entirely (sweeper-only completion) and still proceeds.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";

const PREV_TOKEN = process.env.REV_AI_API_TOKEN;
const PREV_CB_SECRET = process.env.REV_AI_CALLBACK_SECRET;
process.env.REV_AI_API_TOKEN = `revai_test_${process.pid}`;
const CB_SECRET = `cbsec_${process.pid}_${Date.now().toString(36)}`;
process.env.REV_AI_CALLBACK_SECRET = CB_SECRET;

async function main(): Promise<void> {
  const { isUpstashRedisUrl, makeUpstashPassthroughResponse } = await import(
    "./helpers/upstashFetchStub"
  );
  const { db } = await import("../server/db");
  const { atsJobs, atsCandidates, atsSubmissions } = await import("../shared/schema");
  const { eq, inArray, sql } = await import("drizzle-orm");
  const {
    transcribeVideoSubmission,
    processRevAiCallback,
    REV_AI_CALLBACK_PATH,
    __setAtsAudioPreparerForTest,
  } = await import("../server/services/atsTranscription");
  const { setKillSwitch } = await import("../server/services/killSwitches");

  // ── Audio pipeline seam: skip object storage + ffmpeg entirely ─────────
  __setAtsAudioPreparerForTest(async (_submission, _videoPath, audioPath) => {
    await fs.promises.writeFile(audioPath, "fake-wav-bytes");
    return audioPath;
  });

  // ── Rev.ai fetch stub ───────────────────────────────────────────────────
  const realFetch = global.fetch;
  let submitCount = 0;
  let lastOptions: any = null;
  let lastMediaPresent = false;
  let submitBehavior: () => Response = () =>
    new Response(JSON.stringify({ error: "no submit behavior set" }), { status: 500 });
  const statusByJob = new Map<string, () => Response>();
  const transcriptByJob = new Map<string, () => Response>();
  global.fetch = (async (input: any, init?: any) => {
    if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("https://api.rev.ai/")) {
      const m = url.match(/\/jobs\/([^/]+?)(\/transcript)?$/);
      if (!m && url.endsWith("/jobs")) {
        submitCount++;
        const fd = init?.body as FormData;
        const optionsRaw = fd?.get?.("options");
        lastOptions = typeof optionsRaw === "string" ? JSON.parse(optionsRaw) : null;
        lastMediaPresent = Boolean(fd?.get?.("media"));
        return submitBehavior();
      }
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

  // ── Fixtures ────────────────────────────────────────────────────────────
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const jobId = `t3963fl-job-${suffix}`;
  const candId = `t3963fl-cand-${suffix}`;
  const subIds: string[] = [];
  const mkSub = async (
    id: string,
    fields: Partial<typeof atsSubmissions.$inferInsert> = {},
  ) => {
    subIds.push(id);
    await db.insert(atsSubmissions).values({
      id,
      candidateId: candId,
      jobId,
      // Task #4705 — (candidate_id, question_id) is unique now; derive the
      // question id from the submission id so multi-submission fixtures for
      // one candidate don't collide.
      questionId: `q-${id}`,
      questionType: "video",
      videoObjectKey: `/objects/${id}.webm`,
      transcriptionStatus: "pending",
      ...fields,
    });
  };
  const loadRow = async (id: string) => {
    const [row] = await db.select().from(atsSubmissions).where(eq(atsSubmissions.id, id));
    return row;
  };

  // Kill-switch snapshot (restore in finally; delete row if it was absent).
  const ksKey = "kill_switch_ats_revai_transcription";
  const pre = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${ksKey}`);
  const hadKsRow = (pre.rows?.length ?? 0) > 0;
  const prevKsValue = hadKsRow ? String((pre.rows[0] as any).value) : null;

  let passed = 0;
  try {
    await db.insert(atsJobs).values({
      id: jobId,
      title: "t3963 fixture role",
      description: "task #3963 flow-test fixture",
    });
    await db.insert(atsCandidates).values({
      id: candId,
      jobId,
      name: "T3963 Flow Fixture",
      email: `t3963fl-${suffix}@example.test`,
      accessToken: `t3963fltok-${suffix}`,
    });

    // Group A: long job — poll expiry is NOT failure (the B-012 regression).
    {
      const subLong = `t3963fl-long-${suffix}`;
      const rjLong = `rj-long-${suffix}`;
      // Seed as a previously-failed row: the fresh claim must clear the
      // stale typed failure fields.
      await mkSub(subLong, {
        transcriptionStatus: "failed",
        transcriptionFailureCode: "unknown",
        transcriptionFailureDetail: "stale detail from a prior attempt",
      });
      submitBehavior = () =>
        new Response(JSON.stringify({ id: rjLong, status: "in_progress" }), { status: 200 });
      statusByJob.set(rjLong, () =>
        new Response(JSON.stringify({ id: rjLong, status: "in_progress" }), { status: 200 }),
      );
      await transcribeVideoSubmission(subLong, { optimisticPollMs: 1 });

      assert.equal(lastMediaPresent, true, "media part submitted");
      assert.equal(
        lastOptions?.metadata,
        "ATS video submission transcription",
        "metadata rides inside the options part",
      );
      const nc = lastOptions?.notification_config;
      assert.ok(nc, "notification_config registered at submission");
      assert.ok(
        typeof nc.url === "string" &&
          nc.url.startsWith("http") &&
          nc.url.endsWith(REV_AI_CALLBACK_PATH),
        `callback URL is public base + ${REV_AI_CALLBACK_PATH} (got ${nc?.url})`,
      );
      assert.equal(
        nc.auth_headers?.Authorization,
        `Bearer ${CB_SECRET}`,
        "callback auth header carries the shared secret",
      );

      const row = await loadRow(subLong);
      assert.equal(
        row?.transcriptionStatus,
        "processing",
        "poll-window expiry leaves the row 'processing' — NOT failed (B-012)",
      );
      assert.equal(row?.revJobId, rjLong, "rev job id persisted for correlation");
      assert.equal(row?.transcriptionFailureCode, null, "claim cleared stale failure code");
      assert.equal(row?.transcriptionFailureDetail, null, "claim cleared stale failure detail");
      assert.ok(row?.transcriptionUpdatedAt, "progress timestamp stamped");

      // Group B: the callback finalizes the same row.
      statusByJob.set(rjLong, () =>
        new Response(JSON.stringify({ id: rjLong, status: "transcribed" }), { status: 200 }),
      );
      transcriptByJob.set(rjLong, () =>
        new Response("a long answer that outlived the poll window", { status: 200 }),
      );
      const cb = await processRevAiCallback({ job: { id: rjLong, status: "transcribed" } });
      assert.equal(cb.outcome, "completed", "callback completes the long job");
      const done = await loadRow(subLong);
      assert.equal(done?.transcriptionStatus, "completed");
      assert.equal(done?.transcriptText, "a long answer that outlived the poll window");
      passed++;
    }

    // Group C: quick job still completes inline via the optimistic poll.
    {
      const subQuick = `t3963fl-quick-${suffix}`;
      const rjQuick = `rj-quick-${suffix}`;
      await mkSub(subQuick);
      submitBehavior = () =>
        new Response(JSON.stringify({ id: rjQuick, status: "in_progress" }), { status: 200 });
      statusByJob.set(rjQuick, () =>
        new Response(JSON.stringify({ id: rjQuick, status: "transcribed" }), { status: 200 }),
      );
      transcriptByJob.set(rjQuick, () => new Response("quick answer", { status: 200 }));
      await transcribeVideoSubmission(subQuick, { optimisticPollMs: 10_000 });
      const row = await loadRow(subQuick);
      assert.equal(row?.transcriptionStatus, "completed", "quick job completed inline");
      assert.equal(row?.transcriptText, "quick answer");
      passed++;
    }

    // Group D: empty transcript → 'empty'.
    {
      const subEmpty = `t3963fl-empty-${suffix}`;
      const rjEmpty = `rj-empty-${suffix}`;
      await mkSub(subEmpty);
      submitBehavior = () =>
        new Response(JSON.stringify({ id: rjEmpty, status: "in_progress" }), { status: 200 });
      statusByJob.set(rjEmpty, () =>
        new Response(JSON.stringify({ id: rjEmpty, status: "transcribed" }), { status: 200 }),
      );
      transcriptByJob.set(rjEmpty, () => new Response("", { status: 200 }));
      await transcribeVideoSubmission(subEmpty, { optimisticPollMs: 10_000 });
      const row = await loadRow(subEmpty);
      assert.equal(row?.transcriptionStatus, "empty", "empty transcript → 'empty'");
      assert.equal(row?.transcriptText, null);
      passed++;
    }

    // Group E: Rev.ai submit failure → typed submit_failed.
    {
      const subFail = `t3963fl-submitfail-${suffix}`;
      await mkSub(subFail);
      submitBehavior = () => new Response("boom", { status: 500 });
      await transcribeVideoSubmission(subFail, { optimisticPollMs: 1 });
      const row = await loadRow(subFail);
      assert.equal(row?.transcriptionStatus, "failed");
      assert.equal(row?.transcriptionFailureCode, "submit_failed", "typed code persisted");
      assert.ok(
        (row?.transcriptionFailureDetail ?? "").includes("500"),
        "detail carries the HTTP status",
      );
      passed++;
    }

    // Group F: kill switch parks the row un-submitted.
    {
      const subParked = `t3963fl-parked-${suffix}`;
      await mkSub(subParked);
      await setKillSwitch("ats_revai_transcription", true, "test");
      const submitsBefore = submitCount;
      await transcribeVideoSubmission(subParked, { optimisticPollMs: 1 });
      await setKillSwitch("ats_revai_transcription", false, "test");
      const row = await loadRow(subParked);
      assert.equal(row?.transcriptionStatus, "pending", "row parked as 'pending'");
      assert.equal(row?.revJobId, null, "nothing submitted to Rev.ai");
      assert.equal(submitCount, submitsBefore, "no Rev.ai submit call while parked");
      passed++;
    }

    // Group G: no callback secret → notification_config omitted entirely.
    {
      const subNoCb = `t3963fl-nocb-${suffix}`;
      const rjNoCb = `rj-nocb-${suffix}`;
      await mkSub(subNoCb);
      delete process.env.REV_AI_CALLBACK_SECRET;
      submitBehavior = () =>
        new Response(JSON.stringify({ id: rjNoCb, status: "in_progress" }), { status: 200 });
      statusByJob.set(rjNoCb, () =>
        new Response(JSON.stringify({ id: rjNoCb, status: "in_progress" }), { status: 200 }),
      );
      await transcribeVideoSubmission(subNoCb, { optimisticPollMs: 1 });
      process.env.REV_AI_CALLBACK_SECRET = CB_SECRET;
      assert.ok(lastOptions, "options part still submitted");
      assert.ok(
        !("notification_config" in lastOptions),
        "notification_config omitted when no secret configured",
      );
      const row = await loadRow(subNoCb);
      assert.equal(row?.transcriptionStatus, "processing", "job proceeds — sweeper will finalize");
      assert.equal(row?.revJobId, rjNoCb);
      passed++;
    }

    console.log(`ats-transcription-callback-flow: ${passed} groups passed`);
  } finally {
    global.fetch = realFetch;
    __setAtsAudioPreparerForTest(null);
    if (PREV_TOKEN === undefined) delete process.env.REV_AI_API_TOKEN;
    else process.env.REV_AI_API_TOKEN = PREV_TOKEN;
    if (PREV_CB_SECRET === undefined) delete process.env.REV_AI_CALLBACK_SECRET;
    else process.env.REV_AI_CALLBACK_SECRET = PREV_CB_SECRET;
    try {
      // Restore kill-switch state (in-memory + persisted row).
      await setKillSwitch("ats_revai_transcription", prevKsValue === "true", "test");
      if (!hadKsRow) {
        await db.execute(sql`DELETE FROM system_settings WHERE key = ${ksKey}`);
      }
      if (subIds.length > 0) {
        await db.delete(atsSubmissions).where(inArray(atsSubmissions.id, subIds));
      }
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
