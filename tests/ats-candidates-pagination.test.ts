/* test-registration
{
  "name": "ATS candidates cursor pagination (Task #4005)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and walks continuation cursors over HTTP page by page; too DB-heavy for the routine TEST_SMOKE gate. Runs in the full suite and the nightly --regression sweep, like tests/ats-admin-cursor-pagination.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4005 — GET /api/ats/jobs/:jobId/candidates joined the Task #3962
 * cursor envelope ({ candidates, nextCursor, limit }) so the kanban can load
 * beyond the first page. Covers, over real HTTP:
 *
 *   - envelope shape: default limit 100, over-max clamps to 500, garbage /
 *     non-positive limit is a 400
 *   - the retired Task #1810 `offset` param is an explicit 400 (a stale
 *     caller must not silently loop on page 1)
 *   - continuation walk at limit=2 reconstructs the exact seeded sequence in
 *     (created_at DESC, id DESC) order — no duplicates, no skips, id
 *     tie-break inside an equal-created_at cluster split across a boundary
 *   - cursor scope safety: a cursor minted for job A is a 400 on job B; a
 *     tampered/garbage cursor is a 400; job B's walk returns only B's rows
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = "task-4005-ats-cand-cursor";
const USER_ID = `${TAG}-tl`;
const JOB_A = `${TAG}-job-a`;
const JOB_B = `${TAG}-job-b`;

/** Seeded candidate ids for job A, in expected DESC (created_at, id) order. */
const CAND_IDS_DESC = [
  `${TAG}-c-07`, // 00:00:04.000
  `${TAG}-c-06`, // 00:00:03.000 ┐
  `${TAG}-c-05`, // 00:00:03.000 │ equal-created_at cluster → id DESC tie-break
  `${TAG}-c-04`, // 00:00:03.000 ┘
  `${TAG}-c-03`, // 00:00:02.000
  `${TAG}-c-02`, // 00:00:01.000
  `${TAG}-c-01`, // 00:00:00.000
];
const CAND_B_IDS = [`${TAG}-cb-2`, `${TAG}-cb-1`]; // DESC order

function b64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticates as the
    // committed public-schema users row seeded above.
    (req as any).__test_clerkUserId = USER_ID;
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
  for (const jobId of [JOB_A, JOB_B]) {
    await db.execute(sql`
      INSERT INTO ats_jobs (id, title, description, created_by, status)
      VALUES (${jobId}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'open')
      ON CONFLICT (id) DO NOTHING
    `);
  }
  const timestamps: Record<string, string> = {
    [`${TAG}-c-01`]: "2026-01-01T00:00:00.000Z",
    [`${TAG}-c-02`]: "2026-01-01T00:00:01.000Z",
    [`${TAG}-c-03`]: "2026-01-01T00:00:02.000Z",
    [`${TAG}-c-04`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-c-05`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-c-06`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-c-07`]: "2026-01-01T00:00:04.000Z",
  };
  for (const [id, ts] of Object.entries(timestamps)) {
    await db.execute(sql`
      INSERT INTO ats_candidates (id, job_id, name, email, access_token, created_at)
      VALUES (${id}, ${JOB_A}, ${id}, ${`${id}@test.example`}, ${randomUUID()}, ${ts}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }
  for (const [i, id] of [...CAND_B_IDS].reverse().entries()) {
    await db.execute(sql`
      INSERT INTO ats_candidates (id, job_id, name, email, access_token, created_at)
      VALUES (${id}, ${JOB_B}, ${id}, ${`${id}@test.example`}, ${randomUUID()}, ${`2026-01-01T00:00:0${i}.000Z`}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function cleanup(): Promise<void> {
  const tries: Array<() => Promise<unknown>> = [
    () => db.execute(sql`DELETE FROM ats_candidates WHERE job_id IN (${JOB_A}, ${JOB_B})`),
    () => db.execute(sql`DELETE FROM ats_jobs WHERE id IN (${JOB_A}, ${JOB_B})`),
    () => db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`),
  ];
  for (const t of tries) {
    try { await t(); } catch {}
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
      console.log("[ats-candidates-pagination] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  await seed();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  const pathA = `/api/ats/jobs/${JOB_A}/candidates`;
  const pathB = `/api/ats/jobs/${JOB_B}/candidates`;
  try {
    // ── Envelope shape + default limit ──────────────────────────────────
    {
      const res = await fetch(`${baseUrl}${pathA}`);
      assert.equal(res.status, 200, "default page returns 200");
      const body = await res.json() as any;
      assert.ok(Array.isArray(body.candidates), "candidates array present");
      assert.equal(body.limit, 100, "default limit is 100");
      assert.equal(body.nextCursor, null, "single page → null nextCursor");
      assert.deepEqual(
        body.candidates.map((c: any) => c.id),
        CAND_IDS_DESC,
        "default page returns the full seeded sequence in (created_at DESC, id DESC) order",
      );
    }
    // Over-max clamps; garbage / non-positive limit → 400.
    {
      const res = await fetch(`${baseUrl}${pathA}?limit=10000`);
      assert.equal(res.status, 200, "over-max limit is accepted");
      assert.equal(((await res.json()) as any).limit, 500, "over-max limit clamps to 500");
    }
    for (const bad of ["0", "-3", "foo"]) {
      const res = await fetch(`${baseUrl}${pathA}?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} is rejected with 400`);
    }
    // Retired offset param is an explicit 400, not silently ignored.
    {
      const res = await fetch(`${baseUrl}${pathA}?offset=100`);
      assert.equal(res.status, 400, "offset param is rejected with 400");
    }

    // ── Continuation walk at limit=2 (tie-break across boundary) ────────
    {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        assert.ok(page < 10, "walk exceeded 10 pages — runaway continuation");
        const url = cursor
          ? `${baseUrl}${pathA}?limit=2&cursor=${encodeURIComponent(cursor)}`
          : `${baseUrl}${pathA}?limit=2`;
        const res = await fetch(url);
        assert.equal(res.status, 200, `walk page ${page} returns 200`);
        const body = await res.json() as any;
        assert.equal(body.limit, 2, "walk page echoes limit");
        assert.ok(body.candidates.length <= 2, "walk page respects limit");
        ids.push(...body.candidates.map((c: any) => c.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      assert.deepEqual(
        ids,
        CAND_IDS_DESC,
        "limit=2 walk reconstructs the exact sequence — no dup, no skip, id tie-break in the equal-created_at cluster",
      );
    }

    // ── Cursor scope safety ──────────────────────────────────────────────
    {
      const page1 = await fetch(`${baseUrl}${pathA}?limit=2`);
      const cursorA = ((await page1.json()) as any).nextCursor as string;
      assert.ok(cursorA, "page 1 yields a continuation cursor");

      const crossJob = await fetch(`${baseUrl}${pathB}?limit=2&cursor=${encodeURIComponent(cursorA)}`);
      assert.equal(crossJob.status, 400, "job A's cursor is rejected on job B's list");

      const garbage = await fetch(`${baseUrl}${pathA}?cursor=@@not-a-cursor@@`);
      assert.equal(garbage.status, 400, "garbage cursor is rejected");

      const wrongVersion = b64url({ v: 2, s: `candidates:${JOB_A}`, ts: "2026-01-01T00:00:00.000Z", id: "x" });
      const badVersion = await fetch(`${baseUrl}${pathA}?cursor=${encodeURIComponent(wrongVersion)}`);
      assert.equal(badVersion.status, 400, "unknown cursor version is rejected");

      // Positive control: a B-scoped epoch-floor cursor pages B's list and
      // returns only B's rows (the path scope is always re-applied).
      const bCursor = b64url({ v: 1, s: `candidates:${JOB_B}`, ts: "2099-01-01T00:00:00.000Z", id: "\uffff" });
      const bRes = await fetch(`${baseUrl}${pathB}?cursor=${encodeURIComponent(bCursor)}`);
      assert.equal(bRes.status, 200, "B-scoped cursor works on B's list");
      const bBody = await bRes.json() as any;
      assert.deepEqual(
        bBody.candidates.map((c: any) => c.id),
        CAND_B_IDS,
        "B's walk returns exactly B's rows — never job A's",
      );
    }

    console.log("[ats-candidates-pagination] PASS");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error("[ats-candidates-pagination] FAIL:", err);
    process.exitCode = 1;
  },
);
