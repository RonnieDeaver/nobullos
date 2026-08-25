/* test-registration
{
  "name": "ATS admin list cursor pagination (Task #3962)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates/submissions/interviews and walks continuation cursors over HTTP page by page; too DB-heavy for the routine TEST_SMOKE gate. Runs in the full suite and the nightly --regression sweep, like its sibling tests/ats-candidates-pagination.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #3962 — cursor pagination for the ATS admin lists (audit C-U2/C-U3).
 *
 * Covers, over real HTTP against the registered routes:
 *   - GET /api/ats/candidates/:id/submissions — full continuation walk with a
 *     small limit reconstructs the exact seeded sequence: no duplicates, no
 *     skips, deterministic (created_at, id) order. Includes a 4-row
 *     equal-created_at cluster split across page boundaries (id tie-break)
 *     and a microsecond-differing pair that shares a millisecond (the cursor
 *     carries ms precision, so ordering and the keyset predicate must both
 *     truncate to ms or the second row is skipped).
 *   - limit semantics: default 100, clamp to 500, 400 on garbage/non-positive.
 *   - cursor safety: a cursor minted for one candidate is a 400 on another
 *     candidate and on another list type; tampered/garbage cursors are 400;
 *     a well-formed cursor scoped to candidate B returns only B's rows.
 *   - rows deleted between pages do not derail the walk (value-based keyset).
 *   - GET /api/ats/candidates/:id/interviews — same walk semantics.
 *   - GET /api/ats/jobs — bounded envelope, DESC order with id tie-break
 *     among tagged fixture rows, no duplicate ids across the whole walk.
 *   - GET /api/ats/email-templates — bounded (limit applied, garbage 400).
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = "task-3962-ats-cursor";
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job-main`;
const CAND_A = `${TAG}-cand-a`;
const CAND_B = `${TAG}-cand-b`;

/** Seeded submission ids for candidate A, in expected ASC (created_at, id) order. */
const SUB_IDS = [
  `${TAG}-sub-01`, // 00:00:01.000
  `${TAG}-sub-02`, // 00:00:02.000
  `${TAG}-sub-03`, // 00:00:03.000 ┐
  `${TAG}-sub-04`, // 00:00:03.000 │ equal-created_at cluster → id tie-break
  `${TAG}-sub-05`, // 00:00:03.000 │
  `${TAG}-sub-06`, // 00:00:03.000 ┘
  `${TAG}-sub-07`, // 00:00:04.000
  `${TAG}-sub-08`, // 00:00:05.000900 ┐ same millisecond, different microseconds →
  `${TAG}-sub-09`, // 00:00:05.000100 ┘ ms-truncated key ties, id breaks the tie
];
const SUB_B_IDS = [`${TAG}-sub-b1`, `${TAG}-sub-b2`];
const INT_IDS = [
  `${TAG}-int-01`, // 00:00:01.000
  `${TAG}-int-02`, // 00:00:02.000 ┐ equal pair split across the page boundary
  `${TAG}-int-03`, // 00:00:02.000 ┘
  `${TAG}-int-04`, // 00:00:03.000
  `${TAG}-int-05`, // 00:00:04.000
];
/** Walk-fixture jobs; expected DESC order is c (newest), then b, a (equal ts → id DESC). */
const WJOB_A = `${TAG}-wjob-a`;
const WJOB_B = `${TAG}-wjob-b`;
const WJOB_C = `${TAG}-wjob-c`;
const TPL_IDS = [`${TAG}-tpl-1`, `${TAG}-tpl-2`];

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

function b64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${USER_ID}, 'team_lead', 'core', ${`${TAG}-USER`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
  `);
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status, created_at)
    VALUES (${JOB_ID}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'open', '2026-01-01T00:00:00.000Z'::timestamp)
    ON CONFLICT (id) DO NOTHING
  `);
  for (const [cid, name] of [[CAND_A, "Cand A"], [CAND_B, "Cand B"]] as const) {
    await db.execute(sql`
      INSERT INTO ats_candidates (id, job_id, name, email, access_token)
      VALUES (${cid}, ${JOB_ID}, ${name}, ${`${cid}@test.example`}, ${randomUUID()})
      ON CONFLICT (id) DO NOTHING
    `);
  }

  const subTimestamps: Record<string, string> = {
    [`${TAG}-sub-01`]: "2026-01-01T00:00:01.000Z",
    [`${TAG}-sub-02`]: "2026-01-01T00:00:02.000Z",
    [`${TAG}-sub-03`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-sub-04`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-sub-05`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-sub-06`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-sub-07`]: "2026-01-01T00:00:04.000Z",
    // Microsecond-differing pair inside one millisecond. Note -08 is LATER
    // by microseconds than -09: the endpoint must order them by id (ms
    // truncation), so [-08, -09] is the expected sequence — this asserts the
    // ORDER BY and the cursor predicate share the ms-truncated key.
    [`${TAG}-sub-08`]: "2026-01-01 00:00:05.000900",
    [`${TAG}-sub-09`]: "2026-01-01 00:00:05.000100",
  };
  for (const [id, ts] of Object.entries(subTimestamps)) {
    await db.execute(sql`
      INSERT INTO ats_submissions (id, candidate_id, job_id, question_id, question_type, created_at)
      VALUES (${id}, ${CAND_A}, ${JOB_ID}, ${`q-${id}`}, 'text', ${ts}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }
  for (const [i, id] of SUB_B_IDS.entries()) {
    await db.execute(sql`
      INSERT INTO ats_submissions (id, candidate_id, job_id, question_id, question_type, created_at)
      VALUES (${id}, ${CAND_B}, ${JOB_ID}, ${`q-${id}`}, 'text', ${`2026-01-01T00:00:0${i + 1}.000Z`}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  const intTimestamps: Record<string, string> = {
    [`${TAG}-int-01`]: "2026-01-01T00:00:01.000Z",
    [`${TAG}-int-02`]: "2026-01-01T00:00:02.000Z",
    [`${TAG}-int-03`]: "2026-01-01T00:00:02.000Z",
    [`${TAG}-int-04`]: "2026-01-01T00:00:03.000Z",
    [`${TAG}-int-05`]: "2026-01-01T00:00:04.000Z",
  };
  for (const [id, ts] of Object.entries(intTimestamps)) {
    await db.execute(sql`
      INSERT INTO ats_interviews (id, candidate_id, job_id, interview_type, created_at)
      VALUES (${id}, ${CAND_A}, ${JOB_ID}, 'phone', ${ts}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  const wjobTimestamps: Array<[string, string]> = [
    [WJOB_A, "2026-01-02T10:00:00.000Z"],
    [WJOB_B, "2026-01-02T10:00:00.000Z"],
    [WJOB_C, "2026-01-02T10:00:01.000Z"],
  ];
  for (const [id, ts] of wjobTimestamps) {
    await db.execute(sql`
      INSERT INTO ats_jobs (id, title, description, created_by, status, created_at)
      VALUES (${id}, ${`${TAG}-wjob`}, 'desc', ${USER_ID}, 'draft', ${ts}::timestamp)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  for (const id of TPL_IDS) {
    await db.execute(sql`
      INSERT INTO ats_email_templates (id, name, subject, body, template_type, is_global)
      VALUES (${id}, ${`${TAG}-tpl`}, 'subj', 'body', 'custom', true)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function cleanup(): Promise<void> {
  const tries: Array<() => Promise<unknown>> = [
    () => db.execute(sql`DELETE FROM ats_submissions WHERE candidate_id IN (${CAND_A}, ${CAND_B})`),
    () => db.execute(sql`DELETE FROM ats_interviews WHERE candidate_id IN (${CAND_A}, ${CAND_B})`),
    () => db.execute(sql`DELETE FROM ats_candidates WHERE job_id = ${JOB_ID}`),
    () => db.execute(sql`DELETE FROM ats_jobs WHERE id IN (${JOB_ID}, ${WJOB_A}, ${WJOB_B}, ${WJOB_C})`),
    () => db.execute(sql`DELETE FROM ats_email_templates WHERE id IN (${TPL_IDS[0]}, ${TPL_IDS[1]})`),
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

interface WalkResult {
  ids: string[];
  pages: string[][];
  firstCursor: string | null;
}

/**
 * Walk a cursor-paginated list to exhaustion, asserting the envelope
 * invariants on every page: 200 status, echoed limit, items array under
 * `itemsKey` no longer than the limit, and a string-or-null nextCursor that
 * is null exactly on the final page.
 */
async function walkList(
  baseUrl: string,
  path: string,
  itemsKey: string,
  limit: number,
  maxPages: number,
): Promise<WalkResult> {
  const ids: string[] = [];
  const pages: string[][] = [];
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  for (let pageNo = 0; ; pageNo++) {
    assert.ok(pageNo < maxPages, `${path}: walk exceeded ${maxPages} pages — runaway continuation`);
    const sep = path.includes("?") ? "&" : "?";
    const url = cursor
      ? `${baseUrl}${path}${sep}limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${baseUrl}${path}${sep}limit=${limit}`;
    const res = await fetch(url);
    assert.equal(res.status, 200, `${path} page ${pageNo} returns 200`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body[itemsKey]), `${path} page ${pageNo} has ${itemsKey} array`);
    assert.equal(body.limit, limit, `${path} page ${pageNo} echoes limit`);
    assert.ok(body[itemsKey].length <= limit, `${path} page ${pageNo} respects limit`);
    assert.ok(
      body.nextCursor === null || typeof body.nextCursor === "string",
      `${path} page ${pageNo} nextCursor is string or null`,
    );
    const pageIds = (body[itemsKey] as Array<{ id: string }>).map((r) => r.id);
    pages.push(pageIds);
    ids.push(...pageIds);
    if (pageNo === 0) firstCursor = body.nextCursor;
    cursor = body.nextCursor;
    if (cursor === null) return { ids, pages, firstCursor };
  }
}

async function run(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1 FROM ats_submissions LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-admin-cursor-pagination] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  await seed();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  try {
    const subsPath = `/api/ats/candidates/${CAND_A}/submissions`;
    const subsBPath = `/api/ats/candidates/${CAND_B}/submissions`;
    const intsPath = `/api/ats/candidates/${CAND_A}/interviews`;

    // ── Limit semantics (submissions) ────────────────────────────────────
    {
      const res = await fetch(`${baseUrl}${subsPath}`);
      assert.equal(res.status, 200, "default page returns 200");
      const body = (await res.json()) as any;
      assert.equal(body.limit, 100, "default limit is 100");
      assert.equal(body.nextCursor, null, "single page → null nextCursor");
      assert.deepEqual(
        body.submissions.map((s: any) => s.id),
        SUB_IDS,
        "default page returns the full seeded sequence in (created_at, id) order",
      );
    }
    {
      const res = await fetch(`${baseUrl}${subsPath}?limit=10000`);
      assert.equal(res.status, 200, "over-max limit is accepted");
      const body = (await res.json()) as any;
      assert.equal(body.limit, 500, "over-max limit clamps to 500");
    }
    for (const bad of ["0", "-3", "foo"]) {
      const res = await fetch(`${baseUrl}${subsPath}?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} is rejected with 400`);
    }

    // ── Continuation walk with tie-breaks across page boundaries ────────
    {
      const walk = await walkList(baseUrl, subsPath, "submissions", 2, 10);
      assert.deepEqual(
        walk.ids,
        SUB_IDS,
        "limit=2 walk reconstructs the exact sequence — no dup, no skip, id tie-break inside the equal-created_at cluster and the shared-millisecond pair",
      );
      assert.equal(walk.pages.length, 5, "9 rows at limit=2 → 5 pages");
    }

    // ── Cursor scope and tamper rejection ────────────────────────────────
    {
      const page1 = await fetch(`${baseUrl}${subsPath}?limit=2`);
      const cursorA = ((await page1.json()) as any).nextCursor as string;
      assert.ok(cursorA, "page 1 yields a continuation cursor");

      const crossCandidate = await fetch(`${baseUrl}${subsBPath}?limit=2&cursor=${encodeURIComponent(cursorA)}`);
      assert.equal(crossCandidate.status, 400, "candidate A's cursor is rejected on candidate B's list");

      const crossList = await fetch(`${baseUrl}${intsPath}?limit=2&cursor=${encodeURIComponent(cursorA)}`);
      assert.equal(crossList.status, 400, "a submissions cursor is rejected on the interviews list");

      const garbage = await fetch(`${baseUrl}${subsPath}?cursor=@@not-a-cursor@@`);
      assert.equal(garbage.status, 400, "garbage cursor is rejected");

      const wrongVersion = b64url({ v: 2, s: `submissions:${CAND_A}`, ts: "2026-01-01T00:00:00.000Z", id: "x" });
      const badVersion = await fetch(`${baseUrl}${subsPath}?cursor=${encodeURIComponent(wrongVersion)}`);
      assert.equal(badVersion.status, 400, "unknown cursor version is rejected");

      // Positive control: a well-formed cursor scoped to B pages B's list —
      // and only B's rows come back (tenant isolation of the continuation).
      const bCursor = b64url({ v: 1, s: `submissions:${CAND_B}`, ts: "1970-01-01T00:00:00.000Z", id: "" });
      const bRes = await fetch(`${baseUrl}${subsBPath}?cursor=${encodeURIComponent(bCursor)}`);
      assert.equal(bRes.status, 200, "B-scoped cursor works on B's list");
      const bBody = (await bRes.json()) as any;
      assert.deepEqual(
        bBody.submissions.map((s: any) => s.id),
        SUB_B_IDS,
        "B's walk returns exactly B's rows — never candidate A's",
      );
    }

    // ── Interviews walk (same keyset semantics) ──────────────────────────
    {
      const walk = await walkList(baseUrl, intsPath, "interviews", 2, 10);
      assert.deepEqual(
        walk.ids,
        INT_IDS,
        "interviews walk reconstructs the exact sequence with the equal-created_at pair split across a boundary",
      );
    }

    // ── Jobs list: bounded envelope, DESC order, id tie-break ────────────
    {
      const walk = await walkList(baseUrl, "/api/ats/jobs", "jobs", 2, 100);
      assert.equal(new Set(walk.ids).size, walk.ids.length, "jobs walk yields no duplicate ids overall");
      const mine = walk.ids.filter((id) => id.startsWith(`${TAG}-wjob-`));
      assert.deepEqual(
        mine,
        [WJOB_C, WJOB_B, WJOB_A],
        "tagged jobs appear newest-first with id DESC breaking the equal-created_at tie, each exactly once",
      );
      const badLimit = await fetch(`${baseUrl}/api/ats/jobs?limit=nope`);
      assert.equal(badLimit.status, 400, "jobs list rejects garbage limit");
      const clamped = await fetch(`${baseUrl}/api/ats/jobs?limit=99999`);
      assert.equal(((await clamped.json()) as any).limit, 500, "jobs list clamps over-max limit");
    }

    // ── Email templates: bounded ─────────────────────────────────────────
    {
      const res = await fetch(`${baseUrl}/api/ats/email-templates?limit=1`);
      assert.equal(res.status, 200, "templates list accepts a limit");
      const body = (await res.json()) as any;
      assert.ok(Array.isArray(body), "templates list keeps the bare-array shape");
      assert.equal(body.length, 1, "templates list applies the limit bound");
      const bad = await fetch(`${baseUrl}/api/ats/email-templates?limit=foo`);
      assert.equal(bad.status, 400, "templates list rejects garbage limit");
    }

    // ── Deletion between pages does not derail the walk ──────────────────
    // (Destructive on the submissions fixture — runs last.)
    {
      const page1 = await fetch(`${baseUrl}${subsPath}?limit=3`);
      const p1Body = (await page1.json()) as any;
      assert.deepEqual(
        p1Body.submissions.map((s: any) => s.id),
        SUB_IDS.slice(0, 3),
        "pre-deletion page 1 is the first three rows",
      );
      await db.execute(sql`DELETE FROM ats_submissions WHERE id = ${`${TAG}-sub-04`}`);
      let cursor = p1Body.nextCursor as string;
      const rest: string[] = [];
      for (let i = 0; cursor && i < 10; i++) {
        const res = await fetch(`${baseUrl}${subsPath}?limit=3&cursor=${encodeURIComponent(cursor)}`);
        assert.equal(res.status, 200, "post-deletion continuation returns 200");
        const body = (await res.json()) as any;
        rest.push(...body.submissions.map((s: any) => s.id));
        cursor = body.nextCursor;
      }
      assert.deepEqual(
        rest,
        SUB_IDS.slice(3).filter((id) => id !== `${TAG}-sub-04`),
        "continuation after a mid-walk deletion returns the remaining rows in order — no dup, no skip",
      );
    }

    console.log("[ats-admin-cursor-pagination] PASS");
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
    console.error("[ats-admin-cursor-pagination] FAIL:", err);
    process.exitCode = 1;
  },
);
