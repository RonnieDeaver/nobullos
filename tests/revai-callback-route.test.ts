/* test-registration
{
  "name": "Rev.ai callback route auth + idempotency (task #3963, audit B-012)",
  "smoke": true,
  "smokeReason": "Task #3963 / audit B-012 — vendor webhook that finalizes ATS transcriptions: pins fail-closed 503 when REV_AI_CALLBACK_SECRET is unset (every environment), timing-safe bearer auth (401), malformed-payload 400, unknown-job 404 (keeps Rev.ai redelivering across the persist race), authoritative re-fetch completion, idempotent redelivery (no second Rev.ai call), typed vendor-failure persistence, and 500 on transient vendor errors. Hermetic per-run DB; all Rev.ai traffic stubbed at global.fetch.",
  "extraEnv": { "NODE_ENV": "test" },
  "tier": "small"
}
test-registration */
/**
 * Task #3963 (audit B-012) — POST /api/webhooks/rev-ai contract:
 *
 *   1. REV_AI_CALLBACK_PATH constant stays in lockstep with the route literal.
 *   2. Secret unconfigured → 503 fail-closed (no processing, row untouched).
 *   3. Missing/wrong Authorization → 401 (row untouched).
 *   4. Malformed body (no job.id) → 400.
 *   5. Unknown job id → 404 (Rev.ai keeps redelivering — persist-race cover).
 *   6. Known job, Rev.ai says transcribed → transcript fetched → row
 *      'completed' with failure fields cleared → 200 {outcome:"completed"}.
 *   7. Redelivery of the finalized job → 200 "already_terminal" WITHOUT
 *      another Rev.ai status call (idempotent).
 *   8. Rev.ai says failed → typed rev_job_failed + vendor detail persisted.
 *   9. Transient Rev.ai 5xx during processing → HTTP 500 (redelivery), row
 *      still 'processing' with no failure code.
 */
import assert from "node:assert/strict";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

const PREV_TOKEN = process.env.REV_AI_API_TOKEN;
const PREV_CB_SECRET = process.env.REV_AI_CALLBACK_SECRET;
process.env.REV_AI_API_TOKEN = `revai_test_${process.pid}`;
const CB_SECRET = `cbsec_${process.pid}_${Date.now().toString(36)}`;

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main(): Promise<void> {
  const { isUpstashRedisUrl, makeUpstashPassthroughResponse } = await import(
    "./helpers/upstashFetchStub"
  );
  const { db } = await import("../server/db");
  const { atsJobs, atsCandidates, atsSubmissions } = await import("../shared/schema");
  const { eq, inArray } = await import("drizzle-orm");
  const { registerRevAiWebhookRoutes } = await import("../server/routes/revAiWebhook");
  const { REV_AI_CALLBACK_PATH } = await import("../server/services/atsTranscription");

  // ── Rev.ai fetch stub (host-filtered; Upstash passthrough; rest real) ──
  const realFetch = global.fetch;
  let revStatusHits = 0;
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
        revStatusHits++;
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

  // ── Fixtures (random-suffixed; committed; finally-deleted) ─────────────
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const jobId = `t3963cb-job-${suffix}`;
  const candId = `t3963cb-cand-${suffix}`;
  const subA = `t3963cb-subA-${suffix}`; // completes via callback
  const subB = `t3963cb-subB-${suffix}`; // vendor-reported failure
  const subC = `t3963cb-subC-${suffix}`; // transient 5xx from Rev.ai
  const rjA = `rjA-${suffix}`;
  const rjB = `rjB-${suffix}`;
  const rjC = `rjC-${suffix}`;

  const app = express();
  app.use(express.json());
  registerRevAiWebhookRoutes(app);
  const { server, baseUrl } = await listen(app);

  const post = async (body: unknown, auth?: string) => {
    const r = await realFetch(`${baseUrl}/api/webhooks/rev-ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      /* non-JSON */
    }
    return { status: r.status, json };
  };

  let passed = 0;
  try {
    await db.insert(atsJobs).values({
      id: jobId,
      title: "t3963 fixture role",
      description: "task #3963 route-test fixture",
    });
    await db.insert(atsCandidates).values({
      id: candId,
      jobId,
      name: "T3963 Fixture",
      email: `t3963-${suffix}@example.test`,
      accessToken: `t3963tok-${suffix}`,
    });
    await db.insert(atsSubmissions).values(
      [
        { id: subA, revJobId: rjA },
        { id: subB, revJobId: rjB },
        { id: subC, revJobId: rjC },
      ].map((s) => ({
        id: s.id,
        candidateId: candId,
        jobId,
        // Task #4705 — (candidate_id, question_id) is unique now; derive the
        // question id from the submission id so bulk fixtures don't collide.
        questionId: `q-${s.id}`,
        questionType: "video",
        videoObjectKey: `/objects/${s.id}.webm`,
        transcriptionStatus: "processing",
        revJobId: s.revJobId,
      })),
    );

    const loadRow = async (id: string) => {
      const [row] = await db.select().from(atsSubmissions).where(eq(atsSubmissions.id, id));
      return row;
    };

    // Group 1: constant ↔ literal lockstep.
    {
      assert.equal(
        REV_AI_CALLBACK_PATH,
        "/api/webhooks/rev-ai",
        "REV_AI_CALLBACK_PATH must match the route literal in revAiWebhook.ts",
      );
      passed++;
    }

    // Group 2: fail closed when the secret is unconfigured — every env.
    {
      delete process.env.REV_AI_CALLBACK_SECRET;
      const r = await post({ job: { id: rjA, status: "transcribed" } }, "Bearer anything");
      assert.equal(r.status, 503, "no secret → 503 fail-closed");
      const row = await loadRow(subA);
      assert.equal(row?.transcriptionStatus, "processing", "row untouched on 503");
      passed++;
    }

    // Group 3: bad / missing auth → 401.
    {
      process.env.REV_AI_CALLBACK_SECRET = CB_SECRET;
      const wrong = await post({ job: { id: rjA, status: "transcribed" } }, "Bearer nope");
      assert.equal(wrong.status, 401, "wrong bearer → 401");
      const missing = await post({ job: { id: rjA, status: "transcribed" } });
      assert.equal(missing.status, 401, "missing Authorization → 401");
      const row = await loadRow(subA);
      assert.equal(row?.transcriptionStatus, "processing", "row untouched on 401");
      passed++;
    }

    // Group 4: malformed payloads → 400.
    {
      const empty = await post({}, `Bearer ${CB_SECRET}`);
      assert.equal(empty.status, 400, "{} → 400");
      const noId = await post({ job: { status: "transcribed" } }, `Bearer ${CB_SECRET}`);
      assert.equal(noId.status, 400, "job without id → 400");
      passed++;
    }

    // Group 5: unknown job id → 404 so Rev.ai keeps redelivering.
    {
      const r = await post(
        { job: { id: `rj-unknown-${suffix}`, status: "transcribed" } },
        `Bearer ${CB_SECRET}`,
      );
      assert.equal(r.status, 404, "unknown job → 404");
      passed++;
    }

    // Group 6: transcribed callback → authoritative re-fetch → completed.
    {
      statusByJob.set(rjA, () =>
        new Response(JSON.stringify({ id: rjA, status: "transcribed" }), { status: 200 }),
      );
      transcriptByJob.set(rjA, () => new Response("hello from rev", { status: 200 }));
      const r = await post({ job: { id: rjA, status: "transcribed" } }, `Bearer ${CB_SECRET}`);
      assert.equal(r.status, 200, "transcribed callback → 200");
      assert.equal(r.json?.outcome, "completed", "outcome completed");
      const row = await loadRow(subA);
      assert.equal(row?.transcriptionStatus, "completed");
      assert.equal(row?.transcriptText, "hello from rev");
      assert.equal(row?.transcriptionFailureCode, null, "failure code cleared");
      assert.ok(row?.transcriptionUpdatedAt, "progress timestamp stamped");
      passed++;
    }

    // Group 7: redelivery is idempotent — no second Rev.ai status call.
    {
      const hitsBefore = revStatusHits;
      const r = await post({ job: { id: rjA, status: "transcribed" } }, `Bearer ${CB_SECRET}`);
      assert.equal(r.status, 200, "redelivery → 200 (unsubscribes Rev.ai retries)");
      assert.equal(r.json?.outcome, "already_terminal", "redelivery outcome");
      assert.equal(revStatusHits, hitsBefore, "no extra Rev.ai call on redelivery");
      passed++;
    }

    // Group 8: vendor-reported failure → typed rev_job_failed + detail.
    {
      statusByJob.set(rjB, () =>
        new Response(
          JSON.stringify({
            id: rjB,
            status: "failed",
            failure: "download_failure",
            failure_detail: "could not download media",
          }),
          { status: 200 },
        ),
      );
      const r = await post({ job: { id: rjB, status: "failed" } }, `Bearer ${CB_SECRET}`);
      assert.equal(r.status, 200, "failed callback → 200");
      assert.equal(r.json?.outcome, "failed");
      const row = await loadRow(subB);
      assert.equal(row?.transcriptionStatus, "failed");
      assert.equal(row?.transcriptionFailureCode, "rev_job_failed", "typed code persisted");
      assert.ok(
        row?.transcriptionFailureDetail?.includes("download_failure"),
        "vendor failure surfaced in detail",
      );
      assert.ok(row?.transcriptionUpdatedAt, "progress timestamp stamped");
      passed++;
    }

    // Group 9: transient Rev.ai 5xx → 500 (Rev.ai redelivers), row untouched.
    {
      statusByJob.set(rjC, () => new Response("upstream oops", { status: 503 }));
      const r = await post({ job: { id: rjC, status: "transcribed" } }, `Bearer ${CB_SECRET}`);
      assert.equal(r.status, 500, "transient vendor error → 500 for redelivery");
      const row = await loadRow(subC);
      assert.equal(row?.transcriptionStatus, "processing", "row stays processing");
      assert.equal(row?.transcriptionFailureCode, null, "no terminal code written");
      passed++;
    }

    console.log(`revai-callback-route: ${passed} groups passed`);
  } finally {
    server.close();
    global.fetch = realFetch;
    if (PREV_TOKEN === undefined) delete process.env.REV_AI_API_TOKEN;
    else process.env.REV_AI_API_TOKEN = PREV_TOKEN;
    if (PREV_CB_SECRET === undefined) delete process.env.REV_AI_CALLBACK_SECRET;
    else process.env.REV_AI_CALLBACK_SECRET = PREV_CB_SECRET;
    try {
      await db.delete(atsSubmissions).where(inArray(atsSubmissions.id, [subA, subB, subC]));
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
