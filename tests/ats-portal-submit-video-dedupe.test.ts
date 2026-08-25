/* test-registration
{
  "name": "ATS portal video submit stays single-row under concurrent retry duplicates and still kicks transcription (Task #4722)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and fires concurrent HTTP submit-video POSTs at the candidate portal to pin the (candidate_id, question_id) unique-index upsert contract on the VIDEO path (object-storage verification prototype-stubbed, transcription audio seam + Rev.ai fetch stubbed). Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-portal-submit-dedupe.test.ts.",
  "extraEnv": { "NODE_ENV": "test" },
  "tier": "small"
}
test-registration */
/**
 * Task #4722 (follow-up to #4705) — POST /api/ats/portal/:token/submit-video
 * shares the SELECT-then-INSERT → ON CONFLICT DO UPDATE conversion with the
 * text submit path, but was untested: a timeout retry racing the original
 * request could previously either error on the unique index or (pre-index)
 * mint a duplicate ats_submissions row for the same candidate+question. The
 * video path additionally re-verifies the stored bytes and kicks background
 * transcription, so this suite stubs:
 *
 *   - ObjectStorageService.prototype (ACL read → unclaimed, content
 *     verification → ok, rejected-upload delete → no-op) so no real object
 *     storage is touched;
 *   - the transcription audio-preparation seam
 *     (__setAtsAudioPreparerForTest) so no download/ffmpeg runs;
 *   - Rev.ai traffic at global.fetch (submit → job id, status → transcribed,
 *     transcript → text) so the fire-and-forget transcription kick completes
 *     inline through the optimistic poll instead of erroring.
 *
 * Pins:
 *   - a burst of concurrent duplicate submit-video POSTs all return 200 and
 *     leave EXACTLY one ats_submissions row for (candidate, question);
 *   - transcription kicked without error: Rev.ai submit was called and the
 *     row finalizes 'completed' with the stubbed transcript (and the route's
 *     "[ATS] Background transcription failed" error path never fired);
 *   - a later sequential re-submit updates that same row in place (same id);
 *   - a different questionId still creates its own row.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const PREV_REV_TOKEN = process.env.REV_AI_API_TOKEN;
process.env.REV_AI_API_TOKEN = `revai_test_${process.pid}`;
// No callback secret needed — submission without one is supported (the
// route logs a warning and relies on poll/sweeper; our stub completes the
// job inline through the optimistic poll's first check).

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { __setAtsAudioPreparerForTest } from "../server/services/atsTranscription";
import { isUpstashRedisUrl, makeUpstashPassthroughResponse } from "./helpers/upstashFetchStub";

const TAG = `t4722-${process.pid}-${Date.now().toString(36)}`;
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job`;
const CAND_ID = `${TAG}-cand`;
const TOKEN = `${TAG}-token`;
const Q1 = `${TAG}-q1`;
const Q2 = `${TAG}-q2`;
// Must satisfy isAtsCandidateVideoObjectPath: /objects/ats-<candidateId>/<tail>
const objectPathFor = (n: number) => `/objects/ats-${CAND_ID}/video-${n}.webm`;

// ─── Object storage stub (prototype patch — no real storage calls) ─────────
const osProto = ObjectStorageService.prototype as any;
const origAcl = osProto.getObjectEntityAclPolicy;
const origVerify = osProto.verifyObjectEntityContent;
const origDelete = osProto.deleteRejectedUploadObject;
function installObjectStorageStubs(): void {
  osProto.getObjectEntityAclPolicy = async () => null; // unclaimed
  osProto.verifyObjectEntityContent = async () => ({
    ok: true,
    sniffed: { mime: "video/webm", kind: "video" },
  });
  osProto.deleteRejectedUploadObject = async () => true;
}
function restoreObjectStorageStubs(): void {
  osProto.getObjectEntityAclPolicy = origAcl;
  osProto.verifyObjectEntityContent = origVerify;
  osProto.deleteRejectedUploadObject = origDelete;
}

// ─── Rev.ai fetch stub — every submitted job completes immediately ─────────
const realFetch = global.fetch;
let revSubmitCount = 0;
const STUB_TRANSCRIPT = "task 4722 stub transcript";
function installFetchStub(): void {
  global.fetch = (async (input: any, init?: any) => {
    if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("https://api.rev.ai/")) {
      const m = url.match(/\/jobs\/([^/]+?)(\/transcript)?$/);
      if (!m && url.endsWith("/jobs")) {
        revSubmitCount++;
        return new Response(
          JSON.stringify({ id: `rj-${TAG}-${revSubmitCount}`, status: "in_progress" }),
          { status: 200 },
        );
      }
      if (m && m[2]) return new Response(STUB_TRANSCRIPT, { status: 200 });
      if (m) {
        return new Response(JSON.stringify({ id: m[1], status: "transcribed" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: `unexpected rev.ai call: ${url}` }), {
        status: 500,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// Capture the route's fire-and-forget failure log so "transcription kicked
// without error" is a positive assertion, not an absence of visible crash.
const backgroundErrors: string[] = [];
const realConsoleError = console.error;
function installErrorCapture(): void {
  console.error = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[ATS] Background transcription failed")) {
      backgroundErrors.push(args.map(String).join(" "));
    }
    realConsoleError(...args);
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam — the portal routes are token-authed, but keep the seam
    // consistent with sibling ATS suites.
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerAtsRoutes(app as any);
  return app;
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${USER_ID}, 'team_lead', 'core', ${`${TAG}-USER`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
  `);
  // assessment_json stays NULL → no assessment item lookup fires; the
  // submit-video handler tolerates questions absent from the assessment.
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status)
    VALUES (${JOB_ID}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ats_candidates (id, job_id, name, email, access_token, stage)
    VALUES (${CAND_ID}, ${JOB_ID}, ${`${TAG}-cand`}, ${`${CAND_ID}@test.example`}, ${TOKEN}, 'screening')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  const tries: Array<() => Promise<unknown>> = [
    () => db.execute(sql`DELETE FROM ats_submissions WHERE candidate_id = ${CAND_ID}`),
    () => db.execute(sql`DELETE FROM ats_candidates WHERE id = ${CAND_ID}`),
    () => db.execute(sql`DELETE FROM ats_jobs WHERE id = ${JOB_ID}`),
    () => db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`),
  ];
  for (const t of tries) {
    try {
      await t();
    } catch {}
  }
}

async function startServer(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function submitVideo(
  baseUrl: string,
  questionId: string,
  objectPath: string,
): Promise<globalThis.Response> {
  return await realFetch(`${baseUrl}/api/ats/portal/${TOKEN}/submit-video`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionId, objectPath, durationSec: 12 }),
  });
}

async function rowsFor(questionId: string): Promise<any[]> {
  const r = await db.execute(sql`
    SELECT id, question_type, video_object_key, transcription_status, transcript_text
    FROM ats_submissions
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
  return r.rows as any[];
}

/** Poll until the fire-and-forget transcription kicks settle the row. */
async function waitForTranscription(questionId: string, timeoutMs = 20_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const rows = await rowsFor(questionId);
    assert.equal(rows.length, 1, "row count stays 1 while transcription settles");
    const row = rows[0];
    if (row.transcription_status === "completed") return row;
    assert.notEqual(
      row.transcription_status,
      "failed",
      `transcription must not fail (got failed for ${questionId})`,
    );
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `transcription did not complete within ${timeoutMs}ms (status=${row.transcription_status})`,
      );
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
}

async function run(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1 FROM ats_submissions LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-portal-submit-video-dedupe] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  // The dedupe contract this suite pins requires the unique index; a stale DB
  // without it would let the race pass/fail nondeterministically — fail loud.
  {
    const idx = await db.execute(sql`
      SELECT 1 FROM pg_indexes
      WHERE indexname = 'ats_submissions_candidate_question_unique_idx'
    `);
    assert.ok(
      idx.rows.length === 1,
      "ats_submissions_candidate_question_unique_idx must exist (run migrations)",
    );
  }

  installObjectStorageStubs();
  installFetchStub();
  installErrorCapture();
  // Audio pipeline seam: skip object storage download + ffmpeg entirely.
  __setAtsAudioPreparerForTest(async (_submission, _videoPath, audioPath) => {
    await fs.promises.writeFile(audioPath, "fake-wav-bytes");
    return audioPath;
  });

  await cleanup(); // prune litter from a previous aborted run before seeding
  await seed();
  const { server, baseUrl } = await startServer(buildApp());
  try {
    // ── concurrent duplicate burst → 200s, exactly one row, no upsert error ─
    {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => submitVideo(baseUrl, Q1, objectPathFor(i))),
      );
      for (const res of responses) {
        assert.equal(res.status, 200, "every concurrent duplicate submit-video returns 200");
      }
      const rows = await rowsFor(Q1);
      assert.equal(rows.length, 1, "concurrent duplicate submit-videos leave EXACTLY one row");
      assert.equal(rows[0].question_type, "video");
      assert.ok(
        rows[0].video_object_key?.startsWith(`/objects/ats-${CAND_ID}/`),
        "winning row stores a candidate-namespaced object key",
      );
    }

    // ── transcription kicked without error and finalizes 'completed' ──────
    {
      const row = await waitForTranscription(Q1);
      assert.ok(revSubmitCount >= 1, "at least one Rev.ai submit fired from the kicks");
      assert.equal(row.transcript_text, STUB_TRANSCRIPT, "stubbed transcript persisted");
      assert.deepEqual(
        backgroundErrors,
        [],
        "the route's background-transcription failure path never fired",
      );
    }

    // ── later sequential re-submit updates the same row in place ──────────
    {
      const before = await rowsFor(Q1);
      const res = await submitVideo(baseUrl, Q1, objectPathFor(99));
      assert.equal(res.status, 200, "sequential re-submit returns 200");
      const after = await rowsFor(Q1);
      assert.equal(after.length, 1, "re-submit still leaves exactly one row");
      assert.equal(after[0].id, before[0].id, "re-submit updates the SAME row (id stable)");
      assert.equal(
        after[0].video_object_key,
        objectPathFor(99),
        "re-submit persisted the new object key",
      );
      await waitForTranscription(Q1); // let the re-kick settle before cleanup
    }

    // ── a different question still gets its own row ────────────────────────
    {
      const res = await submitVideo(baseUrl, Q2, objectPathFor(2));
      assert.equal(res.status, 200, "different-question submit returns 200");
      assert.equal((await rowsFor(Q2)).length, 1, "second question has its own single row");
      assert.equal((await rowsFor(Q1)).length, 1, "first question row untouched");
      await waitForTranscription(Q2);
    }

    assert.deepEqual(backgroundErrors, [], "no background transcription errors at the end");
    console.log("[ats-portal-submit-video-dedupe] all assertions passed");
  } finally {
    server.close();
    await cleanup();
    __setAtsAudioPreparerForTest(null);
    global.fetch = realFetch;
    console.error = realConsoleError;
    restoreObjectStorageStubs();
    if (PREV_REV_TOKEN === undefined) delete process.env.REV_AI_API_TOKEN;
    else process.env.REV_AI_API_TOKEN = PREV_REV_TOKEN;
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
