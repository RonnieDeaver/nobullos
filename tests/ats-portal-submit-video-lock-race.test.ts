/* test-registration
{
  "name": "ATS portal submit-video never overwrites a locked answer under a racing retry (Task #4730)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and fires HTTP submit-video POSTs at the candidate portal (object-storage verification prototype-stubbed, transcription audio seam + Rev.ai fetch stubbed), injecting a deterministic 'racing lock' between the route's pre-read and its write (via db.update/db.insert interception) to pin the write-time NOT-locked guard. Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-portal-submit-video-dedupe.test.ts.",
  "extraEnv": { "NODE_ENV": "test" },
  "tier": "small"
}
test-registration */
/**
 * Task #4730 — POST /api/ats/portal/:token/submit-video checked the
 * noRedo/lockedAt guard only on a pre-read SELECT; a submit racing the
 * request that locks the row could pass the pre-read and overwrite a
 * now-locked submission via the UPDATE branch or the ON CONFLICT DO UPDATE
 * branch. The fix rides the guard ON the write itself
 * (WHERE NOT (COALESCE(no_redo,false) AND locked_at IS NOT NULL) + setWhere)
 * and answers 409 when the guarded write applied no row — without kicking
 * background transcription for a write that never landed.
 *
 * Pins (races injected deterministically by locking the row AFTER the
 * route's pre-read but BEFORE its write, via db.update/db.insert wrappers):
 *   - pre-read guard: a directly-seeded locked row answers 409, unchanged;
 *   - UPDATE-branch race: pre-read saw an unlocked row, row locks before the
 *     UPDATE → 409, locked object key preserved, NO transcription kick;
 *   - INSERT/ON CONFLICT race: pre-read saw no row, a locked row lands before
 *     the INSERT → 409, the racer's row preserved, NO transcription kick;
 *   - control: an unlocked question still submits 200 and transcribes;
 *   - Task #4736: a no_redo assessment item stamps noRedo+lockedAt on the
 *     first submit-video, so the second answers 409 and the first recording
 *     (and transcript) survive.
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
import { atsSubmissions } from "@shared/schema";
import { registerAtsRoutes } from "../server/routes/ats";
import { ObjectStorageService } from "../server/replit_integrations/object_storage/objectStorage";
import { __setAtsAudioPreparerForTest } from "../server/services/atsTranscription";
import { isUpstashRedisUrl, makeUpstashPassthroughResponse } from "./helpers/upstashFetchStub";

const TAG = `t4730v-${process.pid}-${Date.now().toString(36)}`;
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job`;
const CAND_ID = `${TAG}-cand`;
const TOKEN = `${TAG}-token`;
const Q_PRELOCKED = `${TAG}-q-pre`; // locked row seeded directly → pre-read 409
const Q_UPDATE = `${TAG}-q-upd`; // UPDATE-branch race target
const Q_INSERT = `${TAG}-q-ins`; // INSERT-branch race target
const Q_CONTROL = `${TAG}-q-ok`; // untouched happy path
const Q_NOREDO = `${TAG}-q-noredo`; // Task #4736: no_redo assessment item — first submit locks
// Must satisfy isAtsCandidateVideoObjectPath: /objects/ats-<candidateId>/<tail>
const objectPathFor = (n: number | string) => `/objects/ats-${CAND_ID}/video-${n}.webm`;

// ─── Deterministic race injection (mirrors ats-portal-submit-lock-race) ─────
let pendingInjection: (() => Promise<void>) | null = null;

function wrapExec(builder: any, inject: () => Promise<void>): any {
  return new Proxy(builder, {
    get(t, p) {
      if (p === "then") {
        return (onF: any, onR: any) => inject().then(() => t).then(onF, onR);
      }
      const v = t[p];
      if (typeof v === "function") {
        return (...args: any[]) => {
          const r = v.apply(t, args);
          return r && typeof r === "object" ? wrapExec(r, inject) : r;
        };
      }
      return v;
    },
  });
}

const origUpdate = (db as any).update.bind(db);
const origInsert = (db as any).insert.bind(db);
function installWriteInterceptors(): void {
  const maybeWrap = (builder: any, table: any) => {
    if (!pendingInjection || table !== atsSubmissions) return builder;
    const inject = pendingInjection;
    pendingInjection = null; // one-shot
    let done: Promise<void> | null = null;
    return wrapExec(builder, () => (done ??= inject()));
  };
  (db as any).update = (table: any) => maybeWrap(origUpdate(table), table);
  (db as any).insert = (table: any) => maybeWrap(origInsert(table), table);
}
function restoreWriteInterceptors(): void {
  (db as any).update = origUpdate;
  (db as any).insert = origInsert;
}

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
const STUB_TRANSCRIPT = "task 4730 stub transcript";
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

// Capture the route's fire-and-forget failure log so "no transcription kick
// on 409" and "control kick succeeded" are positive assertions.
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
  // assessment_json carries exactly one no_redo item (Task #4736); the
  // race-target questions stay absent from it — the submit-video handler
  // tolerates questions missing from the assessment.
  const assessmentJson = JSON.stringify({
    items: [{ id: Q_NOREDO, type: "video", no_redo: true }],
  });
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status, assessment_json)
    VALUES (${JOB_ID}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'active', ${assessmentJson}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ats_candidates (id, job_id, name, email, access_token, stage)
    VALUES (${CAND_ID}, ${JOB_ID}, ${`${TAG}-cand`}, ${`${CAND_ID}@test.example`}, ${TOKEN}, 'screening')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedLockedRow(questionId: string, objectKey: string): Promise<void> {
  // transcription_status 'completed' keeps sweepers/pollers away from the row.
  await db.execute(sql`
    INSERT INTO ats_submissions (candidate_id, job_id, question_id, question_type, video_object_key, response_text, transcription_status, no_redo, locked_at)
    VALUES (${CAND_ID}, ${JOB_ID}, ${questionId}, 'video', ${objectKey}, '[locked video]', 'completed', true, NOW())
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
    SELECT id, question_type, video_object_key, transcription_status, transcript_text, no_redo, locked_at
    FROM ats_submissions
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
  return r.rows as any[];
}

async function lockRow(questionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ats_submissions SET no_redo = true, locked_at = NOW(), transcription_status = 'completed'
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
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
      console.log("[ats-portal-submit-video-lock-race] ats tables missing — skipping");
      return;
    }
    throw err;
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
  installWriteInterceptors();
  const { server, baseUrl } = await startServer(buildApp());
  try {
    // ── pre-read guard: directly-seeded locked row answers 409, unchanged ──
    {
      await seedLockedRow(Q_PRELOCKED, objectPathFor("pre-orig"));
      const res = await submitVideo(baseUrl, Q_PRELOCKED, objectPathFor("pre-new"));
      assert.equal(res.status, 409, "pre-read guard answers 409 on a locked row");
      const rows = await rowsFor(Q_PRELOCKED);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].video_object_key, objectPathFor("pre-orig"), "locked video unchanged");
    }

    // ── UPDATE-branch race: row locks between pre-read and UPDATE ──────────
    {
      const first = await submitVideo(baseUrl, Q_UPDATE, objectPathFor("upd-orig"));
      assert.equal(first.status, 200, "seeding submit-video returns 200");
      await waitForTranscription(Q_UPDATE); // settle the seeding kick

      const kicksBefore = revSubmitCount;
      pendingInjection = () => lockRow(Q_UPDATE); // fires inside the write window
      const raced = await submitVideo(baseUrl, Q_UPDATE, objectPathFor("upd-race"));
      assert.equal(pendingInjection, null, "injection actually fired (UPDATE branch reached)");
      assert.equal(raced.status, 409, "guarded UPDATE that applied no row answers 409");
      const rows = await rowsFor(Q_UPDATE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].video_object_key, objectPathFor("upd-orig"), "locked video NOT overwritten");
      assert.equal(revSubmitCount, kicksBefore, "409 path kicked NO transcription");
    }

    // ── INSERT/ON CONFLICT race: locked row lands between pre-read and INSERT ─
    {
      const kicksBefore = revSubmitCount;
      pendingInjection = () => seedLockedRow(Q_INSERT, objectPathFor("ins-racer"));
      const raced = await submitVideo(baseUrl, Q_INSERT, objectPathFor("ins-race"));
      assert.equal(pendingInjection, null, "injection actually fired (INSERT branch reached)");
      assert.equal(raced.status, 409, "guarded ON CONFLICT that applied no row answers 409");
      const rows = await rowsFor(Q_INSERT);
      assert.equal(rows.length, 1, "still exactly one row");
      assert.equal(rows[0].video_object_key, objectPathFor("ins-racer"), "racer's locked row preserved");
      assert.equal(revSubmitCount, kicksBefore, "409 path kicked NO transcription");
    }

    // ── Task #4736: no_redo item — first submit-video stamps the lock, the
    // second is rejected and the first recording survives ──────────────────
    {
      const first = await submitVideo(baseUrl, Q_NOREDO, objectPathFor("noredo-orig"));
      assert.equal(first.status, 200, "first submit-video for a no_redo question returns 200");
      const settled = await waitForTranscription(Q_NOREDO);
      assert.equal(settled.no_redo, true, "no_redo stamped from the assessment item");
      assert.ok(settled.locked_at, "lockedAt stamped on the first write");

      const kicksBefore = revSubmitCount;
      const second = await submitVideo(baseUrl, Q_NOREDO, objectPathFor("noredo-retry"));
      assert.equal(second.status, 409, "second submit-video for a no_redo question answers 409");
      const rows = await rowsFor(Q_NOREDO);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].video_object_key, objectPathFor("noredo-orig"), "first recording kept");
      assert.equal(rows[0].transcript_text, STUB_TRANSCRIPT, "first transcript kept");
      assert.equal(revSubmitCount, kicksBefore, "locked retry kicked NO transcription");
    }

    // ── control: unlocked question still submits and transcribes ───────────
    {
      const res = await submitVideo(baseUrl, Q_CONTROL, objectPathFor("ok"));
      assert.equal(res.status, 200, "unlocked submit-video still returns 200");
      const row = await waitForTranscription(Q_CONTROL);
      assert.equal(row.transcript_text, STUB_TRANSCRIPT, "stubbed transcript persisted");
    }

    assert.deepEqual(backgroundErrors, [], "no background transcription errors");
    console.log("[ats-portal-submit-video-lock-race] all assertions passed");
  } finally {
    server.close();
    restoreWriteInterceptors();
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
