/* test-registration
{
  "name": "ATS JSONB route boundaries — echo contracts, legacy shapes, malformed-row degradation, auth (Task #4150 / F4)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: seeds ats jobs/candidates/final decisions with valid, legacy and malformed JSONB rows and exercises the candidate portal (GET/submit/complete-screening), the final-decision echo and the admin auth gate over real HTTP. Too DB-heavy for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep like its sibling tests/ats-admin-cursor-pagination.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * Task #4150 (F4, audit R-03) — ATS JSONB boundaries over real HTTP.
 *
 * The typed accessors in server/services/atsJsonb.ts changed HOW handlers
 * read jsonb columns; this suite pins what must NOT have changed (valid-row
 * response contracts, raw portal echo, tenant/auth gates) and the one thing
 * that deliberately did: a malformed historical row now degrades to the
 * boundary's documented fallback (with an operational log line) instead of
 * crashing the endpoint into an uncontrolled 500.
 *
 * Covers:
 *   - portal GET: byte-for-byte echo of VALID and MALFORMED stored
 *     assessment/screening/video containers (raw passthrough contract — the
 *     route deliberately does NOT decode what it only echoes), and 404 on an
 *     unknown token;
 *   - portal submit: legacy `is_timed` assessment items still drive timing
 *     metadata (known-legacy-shape preservation, end to end); a job whose
 *     assessment_json carries a non-array `items` now yields a 200
 *     submission plus a logged [ATS JSONB] warning (previously `.find` on a
 *     string crashed the handler into the generic 500 envelope);
 *   - portal complete-screening: malformed video_tasks + assessment_json
 *     still return 200 and persist the stage transition;
 *   - final-decision GET: legacy decision_json rows (missing modern fields,
 *     carrying unknown extras) echo verbatim; candidates without a decision
 *     get a `null` body;
 *   - admin auth unchanged: unauthenticated GET /api/ats/jobs stays a 401.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerAtsRoutes } from "../server/routes/ats";

const TAG = "task-4150-ats-jsonb";
const USER_ID = `${TAG}-tl`;
const JOB_VALID = `${TAG}-job-valid`;
const JOB_MALFORMED = `${TAG}-job-malformed`;
const CAND_VALID = `${TAG}-cand-valid`;
const CAND_MALFORMED = `${TAG}-cand-malformed`;
const CAND_NO_DECISION = `${TAG}-cand-nodecision`;
const TOKEN_VALID = `${TAG}-token-valid`;
const TOKEN_MALFORMED = `${TAG}-token-malformed`;
const DECISION_ID = `${TAG}-decision-1`;

/** Valid stored assessment container (portal GET must echo it verbatim). */
const VALID_ASSESSMENT = {
  items: [
    {
      id: "q1",
      prompt: "Walk through a recent deadline you hit.",
      type: "timed_text",
      layer: "role_skill",
      ordering_index: 0,
      required: true,
      time_limit_sec: 60,
      no_redo: true,
    },
    {
      // Legacy row shape: pre-`timed_text` items carried an is_timed flag
      // (AtsStoredAssessmentItem); submit must still honor it.
      id: "q2",
      prompt: "Describe your ideal week.",
      type: "text",
      layer: "role_behavior",
      ordering_index: 1,
      required: true,
      is_timed: true,
      time_limit_sec: 30,
    },
  ],
  meta: { total_items: 2, layer_counts: { role_skill: 1, role_behavior: 1 } },
};
const VALID_SCREENING = [{ id: "sq1", prompt: "Why this role?", inputType: "text" }];
const VALID_VIDEO_TASKS = [{ id: "vt1", prompt: "Introduce yourself", durationSec: 45 }];

/** Malformed historical containers (non-array items / object list / numeric column). */
const MALFORMED_ASSESSMENT = { items: "junk", meta: {} };
const MALFORMED_SCREENING = { weird: "shape" };
const MALFORMED_VIDEO_TASKS = 12345;

/** Legacy final decision: missing modern fields, carrying an unknown extra. */
const LEGACY_DECISION = {
  finalRecommendation: "Yes",
  confidenceLevel: 7,
  topReasonsToHire: ["Fast learner"],
  legacy_extra_field: "must survive the read",
};

function buildApp(authed: boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticated as the
    // committed public-schema users row seeded above, or null (anonymous → 401).
    (req as any).__test_clerkUserId = authed ? USER_ID : null;
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
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status, screening_questions, video_tasks, assessment_json)
    VALUES (${JOB_VALID}, ${`${TAG}-job-valid`}, 'desc', ${USER_ID}, 'active',
            ${JSON.stringify(VALID_SCREENING)}::jsonb,
            ${JSON.stringify(VALID_VIDEO_TASKS)}::jsonb,
            ${JSON.stringify(VALID_ASSESSMENT)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
  // rubric/screening stay NULL on the malformed job so the complete-screening
  // background auto-score exits at its existing "artifacts missing" guard —
  // this test must not reach the scoring pipeline.
  await db.execute(sql`
    INSERT INTO ats_jobs (id, title, description, created_by, status, screening_questions, video_tasks, assessment_json)
    VALUES (${JOB_MALFORMED}, ${`${TAG}-job-malformed`}, 'desc', ${USER_ID}, 'active',
            ${JSON.stringify(MALFORMED_SCREENING)}::jsonb,
            ${JSON.stringify(MALFORMED_VIDEO_TASKS)}::jsonb,
            ${JSON.stringify(MALFORMED_ASSESSMENT)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
  const cands: Array<[string, string, string]> = [
    [CAND_VALID, JOB_VALID, TOKEN_VALID],
    [CAND_MALFORMED, JOB_MALFORMED, TOKEN_MALFORMED],
    [CAND_NO_DECISION, JOB_VALID, `${TAG}-token-nodecision`],
  ];
  for (const [cid, jobId, token] of cands) {
    await db.execute(sql`
      INSERT INTO ats_candidates (id, job_id, name, email, access_token, stage)
      VALUES (${cid}, ${jobId}, ${`${TAG}-cand`}, ${`${cid}@test.example`}, ${token}, 'invited')
      ON CONFLICT (id) DO NOTHING
    `);
  }
  await db.execute(sql`
    INSERT INTO ats_final_decisions (id, candidate_id, job_id, decision_json, final_recommendation)
    VALUES (${DECISION_ID}, ${CAND_VALID}, ${JOB_VALID}, ${JSON.stringify(LEGACY_DECISION)}::jsonb, 'Yes')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  const tries: Array<() => Promise<unknown>> = [
    () => db.execute(sql`DELETE FROM ats_submissions WHERE candidate_id IN (${CAND_VALID}, ${CAND_MALFORMED}, ${CAND_NO_DECISION})`),
    () => db.execute(sql`DELETE FROM ats_final_decisions WHERE candidate_id IN (${CAND_VALID}, ${CAND_MALFORMED}, ${CAND_NO_DECISION})`),
    () => db.execute(sql`DELETE FROM ats_candidates WHERE job_id IN (${JOB_VALID}, ${JOB_MALFORMED})`),
    () => db.execute(sql`DELETE FROM ats_jobs WHERE id IN (${JOB_VALID}, ${JOB_MALFORMED})`),
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
    await db.execute(sql`SELECT 1 FROM ats_final_decisions LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[ats-jsonb-route-boundaries] ats tables missing — skipping");
      return;
    }
    throw err;
  }

  await cleanup(); // prune litter from a previous aborted run before seeding
  await seed();
  const app = buildApp(true);
  const { server, baseUrl } = await startServer(app);
  const unauthApp = buildApp(false);
  const unauth = await startServer(unauthApp);
  try {
    // ── Portal GET echoes a VALID stored container verbatim ──────────────
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN_VALID}`);
      assert.equal(res.status, 200, "valid portal token returns 200");
      const body = (await res.json()) as any;
      assert.deepEqual(body.job.assessmentJson, VALID_ASSESSMENT, "assessmentJson echoes the stored container byte-for-byte");
      assert.deepEqual(body.job.screeningQuestions, VALID_SCREENING, "screeningQuestions echo verbatim");
      assert.deepEqual(body.job.videoTasks, VALID_VIDEO_TASKS, "videoTasks echo verbatim");
      assert.deepEqual(
        body.candidate,
        { id: CAND_VALID, name: `${TAG}-cand`, stage: "invited" },
        "candidate summary keeps its existing contract",
      );
    }

    // ── Portal GET echoes MALFORMED containers verbatim (raw passthrough) ─
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN_MALFORMED}`);
      assert.equal(res.status, 200, "malformed-row portal GET still returns 200");
      const body = (await res.json()) as any;
      assert.deepEqual(body.job.assessmentJson, MALFORMED_ASSESSMENT, "malformed assessmentJson is echoed untouched — the echo site never decodes");
      assert.deepEqual(body.job.screeningQuestions, MALFORMED_SCREENING, "malformed screeningQuestions echo untouched");
      assert.equal(body.job.videoTasks, MALFORMED_VIDEO_TASKS, "numeric video_tasks column echoes untouched");
    }

    // ── Portal GET: unknown token stays the existing 404 envelope ────────
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TAG}-no-such-token`);
      assert.equal(res.status, 404, "unknown portal token is a 404");
      const body = (await res.json()) as any;
      assert.equal(body.error, "Invalid or expired link", "404 keeps its existing error envelope");
    }

    // ── Portal submit: legacy is_timed item still drives timing metadata ─
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN_VALID}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: "q2", questionType: "text", responseText: "legacy timed answer" }),
      });
      assert.equal(res.status, 200, "submit against the legacy is_timed item succeeds");
      const body = (await res.json()) as any;
      assert.equal(body.isTimed, true, "legacy is_timed flag still marks the submission timed");
      assert.equal(body.timeLimitSec, 30, "legacy item's time limit still propagates");
      assert.equal(body.questionLayer, "role_behavior", "item layer still propagates");
    }

    // ── Portal submit on a malformed assessment container: 200 + warning ─
    // (Previously `.find` on the non-array `items` threw and the handler
    // answered with its generic 500 — an uncontrolled crash on one bad row.)
    {
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      };
      let res: Response | globalThis.Response;
      try {
        res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN_MALFORMED}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: "mq1", questionType: "text", responseText: "still lands" }),
        });
      } finally {
        console.warn = origWarn;
      }
      assert.equal(res.status, 200, "submit degrades to a 200 instead of the old uncontrolled 500");
      const body = (await res.json()) as any;
      assert.equal(body.questionId, "mq1", "the submission row is persisted and returned");
      assert.ok(!body.isTimed, "no item metadata is invented for the unmatched question");
      assert.ok(
        warns.some((w) => w.includes("[ATS JSONB]") && w.includes("ats_jobs.assessment_json")),
        `the malformed boundary is operationally logged (got: ${JSON.stringify(warns)})`,
      );
    }

    // ── Complete-screening with malformed video/assessment containers ────
    {
      const res = await fetch(`${baseUrl}/api/ats/portal/${TOKEN_MALFORMED}/complete-screening`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 200, "complete-screening still succeeds on malformed containers");
      const body = (await res.json()) as any;
      assert.equal(body.stage, "screening", "stage transition is applied and returned");
      const check = await db.execute(sql`SELECT stage, screening_completed_at FROM ats_candidates WHERE id = ${CAND_MALFORMED}`);
      assert.equal((check.rows[0] as any).stage, "screening", "stage transition is persisted");
      assert.ok((check.rows[0] as any).screening_completed_at, "screening completion timestamp is persisted");
    }

    // ── Final decision GET: legacy decision_json echoes verbatim ─────────
    {
      const res = await fetch(`${baseUrl}/api/ats/candidates/${CAND_VALID}/final-decision`);
      assert.equal(res.status, 200, "final-decision GET returns 200");
      const body = (await res.json()) as any;
      assert.equal(body.id, DECISION_ID, "latest decision row is returned");
      assert.deepEqual(body.decisionJson, LEGACY_DECISION, "legacy decision_json (missing modern fields, unknown extras) echoes verbatim");
    }
    {
      const res = await fetch(`${baseUrl}/api/ats/candidates/${CAND_NO_DECISION}/final-decision`);
      assert.equal(res.status, 200, "no-decision candidate still returns 200");
      assert.equal(await res.text(), "null", "body is the existing `null` contract when no decision exists");
    }

    // ── Tenant/auth behavior unchanged: admin list without a session ─────
    {
      const res = await fetch(`${unauth.baseUrl}/api/ats/jobs`);
      assert.equal(res.status, 401, "unauthenticated admin route stays a 401");
    }

    console.log("[ats-jsonb-route-boundaries] PASS");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => unauth.server.close(() => r()));
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a real hang instead of being masked.
run().then(
  () => {},
  (err) => {
    console.error("[ats-jsonb-route-boundaries] FAIL:", err);
    process.exitCode = 1;
  },
);
