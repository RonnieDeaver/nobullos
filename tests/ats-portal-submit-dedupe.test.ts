/* test-registration
{
  "name": "ATS portal per-answer submit stays single-row under concurrent retry duplicates (Task #4705)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and fires concurrent HTTP submits at the candidate portal to pin the (candidate_id, question_id) unique-index upsert contract. Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-portal-complete-idempotency.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4705 — POST /api/ats/portal/:token/submit used SELECT-then-INSERT:
 * two concurrent duplicates (a timeout retry racing the original request)
 * could both see "no existing row" and INSERT two ats_submissions rows for
 * the same candidate+question, double-counting in auto-scoring inputs. The
 * unique index ats_submissions_candidate_question_unique_idx + the route's
 * ON CONFLICT DO UPDATE upsert make the write atomic.
 *
 * Pins:
 *   - a burst of concurrent submits for the same question all return 200 and
 *     leave EXACTLY one ats_submissions row for (candidate, question);
 *   - a later sequential re-submit updates that same row in place (same id,
 *     new responseText) — still exactly one row;
 *   - a different questionId still creates its own row (the uniqueness is per
 *     candidate+question, not per candidate).
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = "task-4705-dedupe";
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job`;
const CAND_ID = `${TAG}-cand`;
const TOKEN = `${TAG}-token`;
const Q1 = `${TAG}-q1`;
const Q2 = `${TAG}-q2`;

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
  // rubric / screening_questions / assessment stay NULL → nothing downstream
  // fires; the submit handler tolerates questions absent from the assessment.
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

async function submit(baseUrl: string, questionId: string, responseText: string): Promise<globalThis.Response> {
  return await fetch(`${baseUrl}/api/ats/portal/${TOKEN}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionId, questionType: "text", responseText }),
  });
}

async function rowsFor(questionId: string): Promise<any[]> {
  const r = await db.execute(sql`
    SELECT id, response_text FROM ats_submissions
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
  return r.rows as any[];
}

async function run(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1 FROM ats_submissions LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-portal-submit-dedupe] ats tables missing — skipping");
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

  await cleanup(); // prune litter from a previous aborted run before seeding
  await seed();
  const { server, baseUrl } = await startServer(buildApp());
  try {
    // ── concurrent duplicate burst → exactly one row ──────────────────────
    {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => submit(baseUrl, Q1, `concurrent answer ${i}`)),
      );
      for (const res of responses) {
        assert.equal(res.status, 200, "every concurrent duplicate submit returns 200");
      }
      const rows = await rowsFor(Q1);
      assert.equal(rows.length, 1, "concurrent duplicate submits leave EXACTLY one row");
    }

    // ── later sequential re-submit updates the same row in place ─────────
    {
      const before = await rowsFor(Q1);
      const res = await submit(baseUrl, Q1, "revised answer");
      assert.equal(res.status, 200, "sequential re-submit returns 200");
      const after = await rowsFor(Q1);
      assert.equal(after.length, 1, "re-submit still leaves exactly one row");
      assert.equal(after[0].id, before[0].id, "re-submit updates the SAME row (id stable)");
      assert.equal(after[0].response_text, "revised answer", "re-submit persisted the new answer");
    }

    // ── a different question still gets its own row ───────────────────────
    {
      const res = await submit(baseUrl, Q2, "second question answer");
      assert.equal(res.status, 200, "different-question submit returns 200");
      assert.equal((await rowsFor(Q2)).length, 1, "second question has its own single row");
      assert.equal((await rowsFor(Q1)).length, 1, "first question row untouched");
    }

    console.log("[ats-portal-submit-dedupe] all assertions passed");
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
