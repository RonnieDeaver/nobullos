/* test-registration
{
  "name": "TwelveLabs webhook completion + bounded fallback polling (Task #3972)",
  "regression": true,
  "smoke": true,
  "smokeReason": "DB-free, network-free route+unit suite (in-memory job store, stubbed vendor client) guarding the new public webhook receiver: TL-Signature HMAC + replay-window auth, fail-closed unconfigured 503, idempotent terminal apply, and the webhook-mode fallback poll plan and early-exit.",
  "tier": "small"
}
test-registration */
/**
 * Task #3972 — TwelveLabs webhook callbacks (audit B-011).
 *
 * Proves, hermetically (no DB writes, no network beyond 127.0.0.1):
 *  1. Header parsing: order-insensitive t/v1 extraction; malformed → null.
 *  2. Replay window: inclusive 5-minute boundary on the HMAC-bound
 *     timestamp, deterministic via the injectable now parameter; malformed
 *     timestamps rejected.
 *  3. Signature verification: HMAC-SHA256 over `${t}.${rawBody}`;
 *     wrong-secret and length-mismatch rejected; missing secret → false.
 *  4. Poll plans: webhook-configured mode is the coarse bounded FALLBACK
 *     (60s x 60) vs primary (10s x 360); both span the same 1h cap.
 *  5. Route behavior on the real registered route (raw-body hook identical
 *     to server/boot/httpApp.ts): unconfigured → 503 fail-closed in every
 *     environment; missing/malformed/invalid signature and stale timestamp
 *     → 401; non-index event types → ignored 200; missing data.id → 400;
 *     unknown task → acknowledged no-op 200.
 *  6. Completion semantics via stubbed vendor client: ready retrieves the
 *     video id and marks the job ready (temp file KEPT for frame
 *     extraction); replayed delivery → already_terminal with no second
 *     retrieve and unchanged completedAt (idempotent); failed marks failed
 *     and cleans the temp file without any retrieve; retrieve errors leave
 *     the job untouched for the fallback poller; a non-terminal retrieve
 *     result refuses to mark ready.
 *  7. Fallback poller: lands terminal state with completionSource "poll";
 *     exits without ANY vendor call when a webhook already landed terminal
 *     state; bounded attempts end in the existing timeout semantics.
 *
 * TWELVELABS_WEBHOOK_SECRET is pinned and restored in finally; seeded jobs
 * are deleted and the client stub cleared in finally.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import type { TwelvelabsApiClient } from "twelvelabs-js";

const RUN_ID = `t3972_${process.pid}_${Date.now().toString(36)}`;
const TEST_SECRET = `tl_webhook_secret_${RUN_ID}`;
const WEBHOOK_PATH = "/api/integrations/twelvelabs/webhook";

const PREV_SECRET = process.env.TWELVELABS_WEBHOOK_SECRET;

function restoreEnv(): void {
  if (PREV_SECRET === undefined) delete process.env.TWELVELABS_WEBHOOK_SECRET;
  else process.env.TWELVELABS_WEBHOOK_SECRET = PREV_SECRET;
}

/** Build a `TL-Signature` header exactly as the vendor does: v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). */
function signTl(rawBody: string, secret: string, tSeconds: number): string {
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${tSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${tSeconds},v1=${v1}`;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postWebhook(
  baseUrl: string,
  rawBody: string,
  signature?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Connection: "close",
  };
  if (signature !== undefined) headers["TL-Signature"] = signature;
  const r = await fetch(`${baseUrl}${WEBHOOK_PATH}`, { method: "POST", headers, body: rawBody });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
}

/** Poll until the file is gone (async fs.unlink in cleanupTempFile) or time out. */
async function waitForUnlink(filePath: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !fs.existsSync(filePath);
}

async function main(): Promise<void> {
  const {
    parseTlSignatureHeader,
    isTwelveLabsTimestampWithinWindow,
    verifyTwelveLabsWebhookSignature,
    isTwelveLabsWebhookConfigured,
    TWELVELABS_WEBHOOK_REPLAY_WINDOW_MS,
    getPollPlan,
    getJobStatus,
    __test_setTwelveLabsClient,
    __test_seedJob,
    __test_deleteJob,
    __test_pollTaskCompletion,
  } = await import("../server/services/videoAnalysis");
  type VideoJob = import("../server/services/videoAnalysis").VideoJob;
  const { registerVideoAnalysisRoutes } = await import("../server/routes/videoAnalysis");

  const app = express();
  // Same raw-body capture as server/boot/httpApp.ts — the signature is
  // computed over these exact bytes.
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  registerVideoAnalysisRoutes(app);
  const { server, baseUrl } = await listen(app);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-webhook-test-"));
  const seededTaskIds: string[] = [];
  const OWNER = `user_${RUN_ID}`;

  const seedJob = (suffix: string, status: VideoJob["status"] = "indexing"): VideoJob => {
    const filePath = path.join(tmpDir, `${suffix}.mp4`);
    fs.writeFileSync(filePath, "fake video bytes");
    const job: VideoJob = {
      taskId: `task_${RUN_ID}_${suffix}`,
      indexId: `idx_${RUN_ID}`,
      ownerUserId: OWNER,
      status,
      filePath,
      createdAt: new Date(),
    };
    __test_seedJob(job);
    seededTaskIds.push(job.taskId);
    return job;
  };

  /** Stub vendor client: scripted tasks.retrieve + call counter. */
  let retrieveCalls = 0;
  let retrieveImpl: (taskId: string) => Promise<{ status?: string; videoId?: string }> = async () => {
    throw new Error("retrieve not scripted");
  };
  const stubClient = {
    tasks: {
      retrieve: async (taskId: string) => {
        retrieveCalls++;
        return retrieveImpl(taskId);
      },
    },
  } as unknown as TwelvelabsApiClient;

  const nowSec = () => Math.floor(Date.now() / 1000);
  let passed = 0;

  try {
    process.env.TWELVELABS_WEBHOOK_SECRET = TEST_SECRET;
    __test_setTwelveLabsClient(stubClient);

    // ---- Group 1: TL-Signature header parsing -----------------------------
    {
      assert.deepEqual(parseTlSignatureHeader("t=123,v1=abc"), { t: "123", v1: "abc" });
      assert.deepEqual(
        parseTlSignatureHeader(" v1=abc , t=123 "),
        { t: "123", v1: "abc" },
        "order-insensitive with whitespace",
      );
      assert.equal(parseTlSignatureHeader("t=123"), null, "missing v1 → null");
      assert.equal(parseTlSignatureHeader("v1=abc"), null, "missing t → null");
      assert.equal(parseTlSignatureHeader("t=,v1=abc"), null, "empty t → null");
      assert.equal(parseTlSignatureHeader("garbage"), null);
      assert.equal(parseTlSignatureHeader(""), null);
      assert.equal(parseTlSignatureHeader(undefined), null);
      passed++;
    }

    // ---- Group 2: replay window (deterministic clock) ---------------------
    {
      const NOW_MS = 1_800_000_000_000; // exact multiple of 1000
      const windowSec = TWELVELABS_WEBHOOK_REPLAY_WINDOW_MS / 1000;
      const atPastBoundary = String(NOW_MS / 1000 - windowSec);
      const beyondPast = String(NOW_MS / 1000 - windowSec - 1);
      const atFutureBoundary = String(NOW_MS / 1000 + windowSec);
      const beyondFuture = String(NOW_MS / 1000 + windowSec + 1);
      assert.equal(isTwelveLabsTimestampWithinWindow(atPastBoundary, NOW_MS), true, "inclusive past boundary");
      assert.equal(isTwelveLabsTimestampWithinWindow(beyondPast, NOW_MS), false, "1s beyond past rejected");
      assert.equal(isTwelveLabsTimestampWithinWindow(atFutureBoundary, NOW_MS), true, "inclusive future boundary");
      assert.equal(isTwelveLabsTimestampWithinWindow(beyondFuture, NOW_MS), false, "1s beyond future rejected");
      assert.equal(isTwelveLabsTimestampWithinWindow(String(NOW_MS / 1000), NOW_MS), true, "exact now accepted");
      for (const bad of ["abc", "12.5", "-5", "", "1e9"]) {
        assert.equal(isTwelveLabsTimestampWithinWindow(bad, NOW_MS), false, `malformed "${bad}" rejected`);
      }
      passed++;
    }

    // ---- Group 3: signature verification ----------------------------------
    {
      const raw = JSON.stringify({ hello: "world" });
      const t = String(nowSec());
      const good = crypto.createHmac("sha256", TEST_SECRET).update(`${t}.${raw}`).digest("hex");
      assert.equal(verifyTwelveLabsWebhookSignature(raw, t, good), true, "valid signature accepted");
      assert.equal(verifyTwelveLabsWebhookSignature(Buffer.from(raw), t, good), true, "Buffer body accepted");
      const wrong = crypto.createHmac("sha256", "other-secret").update(`${t}.${raw}`).digest("hex");
      assert.equal(verifyTwelveLabsWebhookSignature(raw, t, wrong), false, "wrong secret rejected");
      assert.equal(verifyTwelveLabsWebhookSignature(raw, t, good.slice(0, 10)), false, "length mismatch rejected");
      assert.equal(verifyTwelveLabsWebhookSignature(raw, String(nowSec() + 1), good), false, "tampered t rejected");
      delete process.env.TWELVELABS_WEBHOOK_SECRET;
      assert.equal(isTwelveLabsWebhookConfigured(), false, "missing secret → not configured");
      assert.equal(verifyTwelveLabsWebhookSignature(raw, t, good), false, "missing secret → verify false");
      process.env.TWELVELABS_WEBHOOK_SECRET = "   ";
      assert.equal(isTwelveLabsWebhookConfigured(), false, "blank secret → not configured");
      process.env.TWELVELABS_WEBHOOK_SECRET = TEST_SECRET;
      assert.equal(isTwelveLabsWebhookConfigured(), true, "set → configured");
      passed++;
    }

    // ---- Group 4: poll plans ----------------------------------------------
    {
      assert.deepEqual(getPollPlan(false), { intervalMs: 10_000, maxAttempts: 360 }, "primary plan unchanged");
      assert.deepEqual(getPollPlan(true), { intervalMs: 60_000, maxAttempts: 60 }, "fallback plan is coarse");
      const primary = getPollPlan(false);
      const fallback = getPollPlan(true);
      assert.equal(
        primary.intervalMs * primary.maxAttempts,
        fallback.intervalMs * fallback.maxAttempts,
        "both plans span the same bounded 1h window",
      );
      assert.ok(fallback.maxAttempts * fallback.intervalMs <= 3_600_000, "fallback bounded ≤ 1h");
      passed++;
    }

    // ---- Group 5: route auth gates ----------------------------------------
    {
      // Unconfigured → 503 fail-closed (any environment).
      delete process.env.TWELVELABS_WEBHOOK_SECRET;
      const raw503 = JSON.stringify({ type: "index.task.ready", data: { id: "task_x" } });
      const r503 = await postWebhook(baseUrl, raw503, signTl(raw503, "whatever", nowSec()));
      assert.equal(r503.status, 503, `unconfigured → 503 (got ${r503.status})`);
      process.env.TWELVELABS_WEBHOOK_SECRET = TEST_SECRET;

      const raw = JSON.stringify({ type: "index.task.ready", data: { id: "task_x" } });
      // Missing header → 401.
      assert.equal((await postWebhook(baseUrl, raw)).status, 401, "missing header → 401");
      // Malformed header → 401.
      assert.equal((await postWebhook(baseUrl, raw, "nonsense")).status, 401, "malformed header → 401");
      // Bad signature → 401.
      assert.equal(
        (await postWebhook(baseUrl, raw, signTl(raw, "wrong-secret", nowSec()))).status,
        401,
        "invalid signature → 401",
      );
      // Correctly signed but stale timestamp (6 min old) → 401.
      const staleT = nowSec() - 6 * 60;
      assert.equal(
        (await postWebhook(baseUrl, raw, signTl(raw, TEST_SECRET, staleT))).status,
        401,
        "stale signed timestamp → 401",
      );
      // Signed body ≠ delivered body → 401 (raw-body binding).
      const otherRaw = JSON.stringify({ type: "index.task.ready", data: { id: "task_y" } });
      assert.equal(
        (await postWebhook(baseUrl, otherRaw, signTl(raw, TEST_SECRET, nowSec()))).status,
        401,
        "signature over different body → 401",
      );
      passed++;
    }

    // ---- Group 6: event routing (signed) -----------------------------------
    {
      // Non-index event family → acknowledged but ignored.
      const rawIgnored = JSON.stringify({ type: "analyze.task.ready", data: { id: "task_z" } });
      const rIgnored = await postWebhook(baseUrl, rawIgnored, signTl(rawIgnored, TEST_SECRET, nowSec()));
      assert.equal(rIgnored.status, 200);
      assert.equal(rIgnored.json?.status, "ignored", "analyze.* events ignored");
      // Missing data.id → 400.
      const rawNoId = JSON.stringify({ type: "index.task.ready", data: {} });
      const rNoId = await postWebhook(baseUrl, rawNoId, signTl(rawNoId, TEST_SECRET, nowSec()));
      assert.equal(rNoId.status, 400, "missing data.id → 400");
      // Unknown task → benign acknowledged no-op.
      const rawUnknown = JSON.stringify({
        type: "index.task.ready",
        data: { id: `task_${RUN_ID}_never_seeded` },
      });
      const rUnknown = await postWebhook(baseUrl, rawUnknown, signTl(rawUnknown, TEST_SECRET, nowSec()));
      assert.equal(rUnknown.status, 200);
      assert.equal(rUnknown.json?.outcome, "unknown_task", "unknown task acknowledged");
      assert.equal(retrieveCalls, 0, "no vendor call for unknown task");
      passed++;
    }

    // ---- Group 7: ready completion + idempotent replay ---------------------
    {
      const job = seedJob("ready");
      const videoId = `vid_${RUN_ID}`;
      retrieveImpl = async (taskId) => {
        assert.equal(taskId, job.taskId, "retrieve called with the webhook task id");
        return { status: "ready", videoId };
      };
      const raw = JSON.stringify({ type: "index.task.ready", data: { id: job.taskId } });
      const sig = signTl(raw, TEST_SECRET, nowSec());

      const first = await postWebhook(baseUrl, raw, sig);
      assert.equal(first.status, 200);
      assert.equal(first.json?.outcome, "completed");
      assert.equal(first.json?.status, "ready");
      const after = getJobStatus(job.taskId, OWNER);
      assert.equal(after?.status, "ready", "job marked ready");
      assert.equal(after?.videoId, videoId, "videoId fetched via retrieve");
      assert.equal(after?.completionSource, "webhook", "completion attributed to webhook");
      assert.ok(after?.completedAt instanceof Date, "completedAt stamped");
      assert.equal(retrieveCalls, 1, "exactly one retrieve for the ready path");
      assert.ok(fs.existsSync(job.filePath), "ready path keeps temp file for frame extraction");

      // Idempotent replay of the same delivery: no second retrieve, no
      // mutation of the terminal state.
      const completedAtBefore = after!.completedAt!.getTime();
      const replay = await postWebhook(baseUrl, raw, sig);
      assert.equal(replay.status, 200);
      assert.equal(replay.json?.outcome, "already_terminal", "replay → already_terminal");
      assert.equal(retrieveCalls, 1, "replay performs no vendor call");
      const afterReplay = getJobStatus(job.taskId, OWNER);
      assert.equal(afterReplay?.completedAt?.getTime(), completedAtBefore, "completedAt unchanged");
      assert.equal(afterReplay?.videoId, videoId, "videoId unchanged");
      passed++;
    }

    // ---- Group 8: failed completion cleans temp file -----------------------
    {
      const job = seedJob("failed");
      const callsBefore = retrieveCalls;
      const raw = JSON.stringify({ type: "index.task.failed", data: { id: job.taskId } });
      const r = await postWebhook(baseUrl, raw, signTl(raw, TEST_SECRET, nowSec()));
      assert.equal(r.status, 200);
      assert.equal(r.json?.outcome, "completed");
      assert.equal(r.json?.status, "failed");
      const after = getJobStatus(job.taskId, OWNER);
      assert.equal(after?.status, "failed");
      assert.equal(after?.error, "Indexing failed", "error message matches poll-path semantics");
      assert.equal(after?.completionSource, "webhook");
      assert.equal(retrieveCalls, callsBefore, "failed path needs no vendor call");
      assert.ok(await waitForUnlink(job.filePath), "failed path cleans the temp file");
      passed++;
    }

    // ---- Group 9: retrieve failure / non-terminal retrieve leave job to fallback ----
    {
      const job = seedJob("retrievefail");
      retrieveImpl = async () => {
        throw new Error("vendor 500");
      };
      const raw = JSON.stringify({ type: "index.task.ready", data: { id: job.taskId } });
      const r = await postWebhook(baseUrl, raw, signTl(raw, TEST_SECRET, nowSec()));
      assert.equal(r.status, 200, "retrieve failure still 2xx (fallback poller owns recovery)");
      assert.equal(r.json?.outcome, "retrieve_failed");
      const after = getJobStatus(job.taskId, OWNER);
      assert.equal(after?.status, "indexing", "job left non-terminal for the fallback poller");
      assert.equal(after?.completionSource, undefined, "no completion attribution");

      // Event says ready but the API does not agree → refuse to mark ready.
      retrieveImpl = async () => ({ status: "indexing" });
      const r2 = await postWebhook(baseUrl, raw, signTl(raw, TEST_SECRET, nowSec()));
      assert.equal(r2.status, 200);
      assert.equal(r2.json?.outcome, "not_terminal_on_retrieve");
      assert.equal(getJobStatus(job.taskId, OWNER)?.status, "indexing", "still non-terminal");
      passed++;
    }

    // ---- Group 10: fallback poller lands completion -------------------------
    {
      const job = seedJob("pollready", "pending");
      const videoId = `vid_poll_${RUN_ID}`;
      retrieveImpl = async () => ({ status: "ready", videoId });
      await __test_pollTaskCompletion(job.taskId, { intervalMs: 10, maxAttempts: 5 });
      const after = getJobStatus(job.taskId, OWNER);
      assert.equal(after?.status, "ready", "fallback poll marks ready");
      assert.equal(after?.videoId, videoId);
      assert.equal(after?.completionSource, "poll", "completion attributed to poll");
      passed++;
    }

    // ---- Group 11: poller exits without vendor calls once webhook won -------
    {
      const job = seedJob("pollskip", "ready"); // webhook already landed terminal state
      const callsBefore = retrieveCalls;
      retrieveImpl = async () => {
        throw new Error("poller must not call the vendor for a terminal job");
      };
      await __test_pollTaskCompletion(job.taskId, { intervalMs: 10, maxAttempts: 3 });
      assert.equal(retrieveCalls, callsBefore, "no vendor call for an already-terminal job");
      assert.equal(getJobStatus(job.taskId, OWNER)?.status, "ready", "terminal state untouched");
      passed++;
    }

    // ---- Group 12: bounded poller ends in timeout semantics ------------------
    {
      const job = seedJob("polltimeout", "pending");
      retrieveImpl = async () => ({ status: "indexing" });
      await __test_pollTaskCompletion(job.taskId, { intervalMs: 5, maxAttempts: 2 });
      const after = getJobStatus(job.taskId, OWNER);
      assert.equal(after?.status, "timeout", "bounded attempts end in timeout");
      assert.ok(await waitForUnlink(job.filePath), "timeout cleans the temp file");
      passed++;
    }

    console.log(`twelvelabs-webhook: ${passed} groups passed`);
  } finally {
    restoreEnv();
    __test_setTwelveLabsClient(null);
    for (const taskId of seededTaskIds) __test_deleteJob(taskId);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  restoreEnv();
  console.error("FATAL:", err);
  process.exitCode = 1;
});
