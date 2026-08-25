/* test-registration
{
  "name": "ATS portal complete-screening / complete-video idempotency under retry double-submit (Task #4684)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and exercises the candidate portal completion endpoints over real HTTP to pin the CAS idempotency contract. Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-jsonb-route-boundaries.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4684 — the candidate portal's retry affordances (Task #4663) re-POST
 * complete-screening / complete-video when the first response was lost. If the
 * first request actually landed server-side (timeout after the write), the
 * retry must be a safe no-op that returns the current row — never re-stamp
 * completion timestamps, regress pipeline stage, or re-fire auto-scoring.
 *
 * Pins:
 *   - first complete-screening POST: 200, stage invited→screening,
 *     screening_completed_at stamped;
 *   - repeated complete-screening POST: 200, identical screeningCompletedAt
 *     and updatedAt (byte-equal — no re-write happened), stage unchanged;
 *   - repeat after the pipeline advanced the stage (scored): stage is NOT
 *     regressed and timestamps stay untouched;
 *   - same contract for complete-video (which previously force-reset
 *     stage to "video" on every call).
 *
 * The seeded job keeps rubric/screening_questions NULL so the background
 * auto-score exits at its existing "artifacts missing" guard — this suite
 * must not reach the scoring pipeline.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = "task-4684-idem";
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job`;
const CAND_ID = `${TAG}-cand`;
const TOKEN = `${TAG}-token`;

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
  // rubric / screening_questions stay NULL → auto-score exits early.
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status)
    VALUES (${JOB_ID}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ats_candidates (id, job_id, name, email, access_token, stage)
    VALUES (${CAND_ID}, ${JOB_ID}, ${`${TAG}-cand`}, ${`${CAND_ID}@test.example`}, ${TOKEN}, 'invited')
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

async function run(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1 FROM ats_candidates LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-portal-complete-idempotency] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  await cleanup(); // prune litter from a previous aborted run before seeding
  await seed();
  const { server, baseUrl } = await startServer(buildApp());
  try {
    // ── complete-screening: first POST performs the transition ───────────
    let firstScreening: any;
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-screening`, { method: "POST" });
      assert.equal(res.status, 200, "first complete-screening returns 200");
      firstScreening = await res.json();
      assert.equal(firstScreening.stage, "screening", "stage advances invited→screening");
      assert.ok(firstScreening.screeningCompletedAt, "screeningCompletedAt is stamped");
    }

    // ── complete-screening: repeat is a no-op returning the original ─────
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-screening`, { method: "POST" });
      assert.equal(res.status, 200, "repeated complete-screening still returns 200");
      const body = (await res.json()) as any;
      assert.equal(body.screeningCompletedAt, firstScreening.screeningCompletedAt, "screeningCompletedAt is NOT re-stamped on retry");
      assert.equal(body.updatedAt, firstScreening.updatedAt, "updatedAt unchanged — no write happened on retry");
      assert.equal(body.stage, "screening", "stage unchanged on retry");
    }

    // ── complete-video: first POST performs the transition ───────────────
    let firstVideo: any;
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-video`, { method: "POST" });
      assert.equal(res.status, 200, "first complete-video returns 200");
      firstVideo = await res.json();
      assert.equal(firstVideo.stage, "video", "stage moves to video");
      assert.ok(firstVideo.videoCompletedAt, "videoCompletedAt is stamped");
    }

    // ── complete-video: repeat is a no-op ─────────────────────────────────
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-video`, { method: "POST" });
      assert.equal(res.status, 200, "repeated complete-video still returns 200");
      const body = (await res.json()) as any;
      assert.equal(body.videoCompletedAt, firstVideo.videoCompletedAt, "videoCompletedAt is NOT re-stamped on retry");
      assert.equal(body.updatedAt, firstVideo.updatedAt, "updatedAt unchanged on video retry");
      assert.equal(body.stage, "video", "stage unchanged on video retry");
    }

    // ── retries never regress a stage the pipeline advanced past ─────────
    {
      await db.execute(sql`UPDATE ats_candidates SET stage = 'scored' WHERE id = ${CAND_ID}`);
      const res1 = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-video`, { method: "POST" });
      assert.equal(res1.status, 200, "late complete-video retry returns 200");
      assert.equal(((await res1.json()) as any).stage, "scored", "late video retry does NOT force stage back to 'video'");
      const res2 = await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/complete-screening`, { method: "POST" });
      assert.equal(res2.status, 200, "late complete-screening retry returns 200");
      assert.equal(((await res2.json()) as any).stage, "scored", "late screening retry does NOT touch the advanced stage");
      const dbRow = await db.execute(sql`SELECT stage FROM ats_candidates WHERE id = ${CAND_ID}`);
      assert.equal((dbRow.rows[0] as any).stage, "scored", "DB row confirms retries wrote nothing");
    }

    console.log("[ats-portal-complete-idempotency] all assertions passed");
  } finally {
    server.close();
    await cleanup();
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
