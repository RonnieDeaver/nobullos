/* test-registration
{
  "name": "ATS portal submit never overwrites a locked answer under a racing retry (Task #4730)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates and fires HTTP submits at the candidate portal, injecting a deterministic 'racing lock' between the route's pre-read and its write (via db.update/db.insert interception) to pin the write-time NOT-locked guard. Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-portal-submit-dedupe.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4730 — POST /api/ats/portal/:token/submit checked the noRedo/lockedAt
 * guard only on a pre-read SELECT; a submit racing the request that locks the
 * row could pass the pre-read (no row / not yet locked) and overwrite a
 * now-locked submission via the UPDATE branch or the ON CONFLICT DO UPDATE
 * branch. The fix rides the guard ON the write itself
 * (WHERE NOT (COALESCE(no_redo,false) AND locked_at IS NOT NULL) + setWhere)
 * and answers 409 when the guarded write applied no row.
 *
 * Pins (each race injected deterministically by locking the row AFTER the
 * route's pre-read but BEFORE its write, via db.update/db.insert wrappers):
 *   - control: a no_redo question locks on first submit; a later submit gets
 *     the pre-read 409 and the answer is unchanged;
 *   - UPDATE-branch race: pre-read saw an unlocked row, row locks before the
 *     UPDATE → 409, locked answer preserved;
 *   - INSERT/ON CONFLICT race: pre-read saw no row, a locked row lands before
 *     the INSERT → 409, the racer's locked answer preserved.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { atsSubmissions } from "@shared/schema";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = `t4730-${process.pid}-${Date.now().toString(36)}`;
const USER_ID = `${TAG}-tl`;
const JOB_ID = `${TAG}-job`;
const CAND_ID = `${TAG}-cand`;
const TOKEN = `${TAG}-token`;
const Q_NOREDO = `${TAG}-q-noredo`; // no_redo assessment item → locks on submit
const Q_UPDATE = `${TAG}-q-upd`; // plain question — UPDATE-branch race target
const Q_INSERT = `${TAG}-q-ins`; // plain question — INSERT-branch race target

// ─── Deterministic race injection ───────────────────────────────────────────
// The route's write happens strictly after its pre-read SELECT. Wrapping
// db.update/db.insert so an armed injection runs when the returned builder is
// AWAITED (not when it is built) places the "racing lock" exactly inside the
// pre-read → write window, deterministically.
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
  // assessment_json carries ONE no_redo item so the route stamps
  // noRedo/lockedAt itself for Q_NOREDO; the other questions are absent from
  // the assessment (tolerated) and stay unlocked until the test locks them.
  const assessment = JSON.stringify({
    items: [{ id: Q_NOREDO, type: "text", no_redo: true }],
  });
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status, assessment_json)
    VALUES (${JOB_ID}, ${`${TAG}-job`}, 'desc', ${USER_ID}, 'active', ${assessment}::jsonb)
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
    SELECT id, response_text, no_redo, locked_at FROM ats_submissions
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
  return r.rows as any[];
}

async function lockRow(questionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ats_submissions SET no_redo = true, locked_at = NOW()
    WHERE candidate_id = ${CAND_ID} AND question_id = ${questionId}
  `);
}

async function run(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1 FROM ats_submissions LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-portal-submit-lock-race] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  await cleanup(); // prune litter from a previous aborted run before seeding
  await seed();
  installWriteInterceptors();
  const { server, baseUrl } = await startServer(buildApp());
  try {
    // ── control: no_redo question locks on first submit, pre-read 409 after ─
    {
      const first = await submit(baseUrl, Q_NOREDO, "the locked answer");
      assert.equal(first.status, 200, "first no_redo submit returns 200");
      const rows = await rowsFor(Q_NOREDO);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].no_redo, true, "no_redo stamped from the assessment item");
      assert.ok(rows[0].locked_at, "first submit locked the row");

      const second = await submit(baseUrl, Q_NOREDO, "overwrite attempt");
      assert.equal(second.status, 409, "pre-read guard answers 409 on a locked row");
      const after = await rowsFor(Q_NOREDO);
      assert.equal(after[0].response_text, "the locked answer", "locked answer unchanged");
    }

    // ── UPDATE-branch race: row locks between pre-read and UPDATE ──────────
    {
      const first = await submit(baseUrl, Q_UPDATE, "original answer");
      assert.equal(first.status, 200, "seeding submit returns 200");

      pendingInjection = () => lockRow(Q_UPDATE); // fires inside the write window
      const raced = await submit(baseUrl, Q_UPDATE, "racing overwrite");
      assert.equal(pendingInjection, null, "injection actually fired (UPDATE branch reached)");
      assert.equal(raced.status, 409, "guarded UPDATE that applied no row answers 409");
      const rows = await rowsFor(Q_UPDATE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].response_text, "original answer", "locked answer NOT overwritten");
      assert.ok(rows[0].locked_at, "row is locked (the racer won)");
    }

    // ── INSERT/ON CONFLICT race: locked row lands between pre-read and INSERT ─
    {
      pendingInjection = async () => {
        await db.execute(sql`
          INSERT INTO ats_submissions (candidate_id, job_id, question_id, question_type, response_text, no_redo, locked_at)
          VALUES (${CAND_ID}, ${JOB_ID}, ${Q_INSERT}, 'text', 'racer locked answer', true, NOW())
        `);
      };
      const raced = await submit(baseUrl, Q_INSERT, "racing overwrite");
      assert.equal(pendingInjection, null, "injection actually fired (INSERT branch reached)");
      assert.equal(raced.status, 409, "guarded ON CONFLICT that applied no row answers 409");
      const rows = await rowsFor(Q_INSERT);
      assert.equal(rows.length, 1, "still exactly one row");
      assert.equal(rows[0].response_text, "racer locked answer", "racer's locked answer preserved");
    }

    console.log("[ats-portal-submit-lock-race] all assertions passed");
  } finally {
    server.close();
    restoreWriteInterceptors();
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
