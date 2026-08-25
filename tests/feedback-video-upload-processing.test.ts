/* test-registration
{
  "name": "Feedback image/video upload + auto-analysis (Task #2415)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/feedbackVideoSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2415 — regression coverage for the feedback image/video upload +
 * auto-analysis feature (Task #2409).
 *
 * Pinned behavior (TwelveLabs + Object Storage stubbed via the resolve hook
 * in `tests/helpers/feedbackVideoSetup.mjs`):
 *
 *   1. Classification — `summarizeAttachments` keeps both image and video
 *      paths in a single attachment list (the `screenshots` array): a mixed
 *      list reports both counts and surfaces the video paths separately, and
 *      `isVideoAttachmentPath` recognizes video extensions while rejecting
 *      images. This is the contract that lets uploaded video paths land on
 *      the same `screenshots` array as images.
 *   2. `processFeedbackVideos` persists a TERMINAL `video_analysis` jsonb:
 *        - ready run → status "ready", one entry per video (images ignored),
 *          transcript joined from the analysis segments, deduped key-moment +
 *          scene frames, a completedAt stamp.
 *        - failed indexing → terminal status "failed" with a per-video error.
 *        - no video attachments → the column is never written (stays NULL).
 *   3. `GET /api/feedback/:id/attachment` requires admin — the route's
 *      `isAuthenticated` + `requireTeamLead` chain rejects anonymous (401)
 *      and non-team-lead (403) callers and only admits a team_lead. The
 *      attachment route is declared inline inside the monolithic
 *      `registerRoutes`, so rather than boot the whole app (which would start
 *      workers/schedulers) we mount the SAME middleware chain the route uses
 *      on a minimal Express app with a sentinel handler and assert the gate.
 *
 * TwelveLabs submit/poll/fetch and the Object Storage download are stubbed —
 * the real API is never called.
 */
import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  summarizeAttachments,
  isVideoAttachmentPath,
  FEEDBACK_ATTACHMENT_PREFIX,
} from "@shared/attachments";
import { processFeedbackVideos } from "../server/services/feedbackVideoProcessing";
import {
  isAuthenticated,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { requireTeamLead } from "../server/routes/middleware";
import {
  __setScenario,
  __reset as __resetVideoStub,
} from "./helpers/feedbackVideoStub.mjs";
import { SYNTHETIC_FEEDBACK_TEST_MARKER } from "../server/services/feedbackSlackRetry";

const TAG = `task-2415-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

let failures = 0;
const insertedFeedbackIds: number[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ── Feedback row helpers (the table is created by registerRoutes at startup,
//    via raw SQL rather than a migration; ensure it + the video_analysis
//    column exist so this test stands alone). ─────────────────────────────
async function ensureFeedbackTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL,
      user_name varchar NOT NULL,
      topic varchar NOT NULL DEFAULT 'OTHER',
      feedback_text text NOT NULL,
      current_page varchar,
      screenshots text DEFAULT '[]',
      status varchar NOT NULL DEFAULT 'pending',
      slack_status varchar NOT NULL DEFAULT 'pending',
      slack_reason text,
      slack_updated_at timestamp,
      slack_attempts integer NOT NULL DEFAULT 0,
      created_at timestamp DEFAULT now()
    )
  `);
  await db.execute(
    sql`ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS video_analysis jsonb`,
  );
}

// Task #2783 — seed rows with a TERMINAL slack_status at insert time. The
// live feedback→Slack retry scheduler on the always-on dev server treats
// any row with a non-terminal slack_status as a real, undelivered
// candidate and will post it to the real Slack channel; these rows only
// exist to exercise video processing, not the Slack relay, so they must
// never be a candidate even for the brief window before `cleanup()` runs
// (or not at all, if the process is SIGKILL'd on a timeout). `undeliverable`
// is one of the two terminal statuses the retry scheduler already excludes.
const SYNTHETIC_SLACK_REASON = `${SYNTHETIC_FEEDBACK_TEST_MARKER} (${TAG}) — never send to Slack`;

async function insertFeedbackRow(screenshots: string[]): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, screenshots, slack_status, slack_reason)
    VALUES (${TL_ID}, ${`${TAG} user`}, 'OTHER', ${`${TAG} feedback`}, ${JSON.stringify(screenshots)}, 'undeliverable', ${SYNTHETIC_SLACK_REASON})
    RETURNING id
  `);
  const id = Number((rows as any).rows[0].id);
  insertedFeedbackIds.push(id);
  return id;
}

async function readVideoAnalysis(id: number): Promise<any> {
  const rows = await db.execute(
    sql`SELECT video_analysis FROM user_feedback WHERE id = ${id}`,
  );
  return (rows as any).rows[0]?.video_analysis ?? null;
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${`${TAG} TL`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${`${TAG} AM`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

// Task #2783 — this suite's tag is timestamp-suffixed (`task-2415-<ts>-<rand>`)
// so `cleanup()`'s exact-id delete can't reach rows left behind by a prior
// run that was SIGKILL'd on a timeout (its `finally` never ran). Prune any
// leftover synthetic rows from earlier runs at startup, following the same
// prune-to-baseline-at-startup pattern used by the admin-audit count tests.
async function pruneLeftoverSyntheticRows(): Promise<void> {
  await db
    .execute(sql`DELETE FROM user_feedback WHERE user_id LIKE 'task-2415-%'`)
    .catch(() => {});
  await db
    .execute(sql`DELETE FROM users WHERE id LIKE 'task-2415-%'`)
    .catch(() => {});
}

async function cleanup(): Promise<void> {
  try {
    if (insertedFeedbackIds.length > 0) {
      await db.execute(
        sql`DELETE FROM user_feedback WHERE id = ANY(${insertedFeedbackIds})`,
      );
    }
  } catch {}
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

// ── Minimal Express app mounting the REAL isAuthenticated + requireTeamLead
//    chain that the attachment route declares, with auth identity injected
//    per request (anon when the x-test-actor header is absent). ────────────
function buildApp(): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const actor = String(req.headers["x-test-actor"] ?? "");
    // Inject Clerk test seam: authenticated when actor header is present,
    // unauthenticated (null) otherwise. requireAuth reads __test_clerkUserId
    // and short-circuits Clerk session resolution.
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  app.get(
    "/api/feedback/:id/attachment",
    isAuthenticated,
    requireTeamLead,
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true, served: true });
    },
  );
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  path: string,
  actor: string | null,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}${path}`, { method: "GET", headers });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

function videoPath(): string {
  return `${FEEDBACK_ATTACHMENT_PREFIX}${randomUUID()}.mp4`;
}
function imagePath(): string {
  return `${FEEDBACK_ATTACHMENT_PREFIX}${randomUUID()}.png`;
}

async function main(): Promise<void> {
  console.log("Feedback image/video upload + auto-analysis (Task #2415)");

  await ensureFeedbackTable();
  await pruneLeftoverSyntheticRows();
  await ensureUsers();

  // ── (1) Classification: images + videos share one attachment list ──────
  await step(
    "classification: summarizeAttachments keeps images + videos in one list",
    async () => {
      const img1 = imagePath();
      const img2 = `${FEEDBACK_ATTACHMENT_PREFIX}${randomUUID()}`; // legacy, no ext → image
      const vid1 = videoPath();
      const vid2 = `${FEEDBACK_ATTACHMENT_PREFIX}${randomUUID()}.mov`;
      const summary = summarizeAttachments([img1, vid1, img2, vid2]);

      assert.equal(summary.total, 4, "total counts every attachment");
      assert.equal(summary.imageCount, 2, "two images (incl. the extensionless legacy one)");
      assert.equal(summary.videoCount, 2, "two videos");
      assert.deepEqual(
        summary.videoPaths,
        [vid1, vid2],
        "videoPaths surfaces exactly the video entries, in order",
      );

      assert.equal(isVideoAttachmentPath(vid1), true, ".mp4 is a video");
      assert.equal(isVideoAttachmentPath(vid2), true, ".mov is a video");
      assert.equal(isVideoAttachmentPath(img1), false, ".png is not a video");
      assert.equal(isVideoAttachmentPath(img2), false, "extensionless path is not a video");
    },
  );

  // ── (2a) processFeedbackVideos: ready run → terminal ready analysis ────
  await step(
    "processFeedbackVideos: ready run persists transcript + deduped frames; images ignored",
    async () => {
      __resetVideoStub();
      __setScenario({
        jobStatus: "ready",
        fullAnalysis: {
          status: "ready",
          summary: "A short demo of the bug.",
          transcript: [
            { start: 0, end: 1, value: "Hello" },
            { start: 1, end: 2, value: "world" },
            { start: 2, end: 3, value: "" }, // blank segments dropped
          ],
          scenes: [
            {
              timestamp: "00:05",
              description: "Opens the dashboard",
              frameUrl: "/api/video-analysis/frames/idx/5.png",
            },
          ],
          keyMoments: [
            {
              timestamp: "00:10",
              description: "Error toast appears",
              frameUrl: "/api/video-analysis/frames/idx/10.png",
            },
            {
              // duplicate frameUrl → must be deduped
              timestamp: "00:11",
              description: "Same frame again",
              frameUrl: "/api/video-analysis/frames/idx/10.png",
            },
          ],
        },
      });

      const vid = videoPath();
      const img = imagePath();
      const id = await insertFeedbackRow([img, vid]);

      await processFeedbackVideos(id, [img, vid], TL_ID);

      const analysis = await readVideoAnalysis(id);
      assert.ok(analysis, "video_analysis is persisted");
      assert.equal(analysis.status, "ready", "terminal status is ready");
      assert.ok(
        typeof analysis.completedAt === "string" && analysis.completedAt.length > 0,
        "completedAt stamp is present (terminal)",
      );
      assert.ok(Array.isArray(analysis.videos), "videos is an array");
      assert.equal(
        analysis.videos.length,
        1,
        "only the video attachment is processed (the image is ignored)",
      );

      const v = analysis.videos[0];
      assert.equal(v.sourcePath, vid, "the processed entry points at the video path");
      assert.equal(v.status, "ready", "the video entry is ready");
      assert.equal(v.transcript, "Hello world", "transcript joins non-blank segments");
      assert.equal(v.summary, "A short demo of the bug.", "summary carried through");
      assert.equal(v.frames.length, 2, "scene + key-moment frames, deduped by url");
      assert.deepEqual(
        v.frames.map((f: any) => f.url),
        ["/api/video-analysis/frames/idx/5.png", "/api/video-analysis/frames/idx/10.png"],
        "frame urls are the unique scene + key-moment urls in order",
      );
    },
  );

  // ── (2b) processFeedbackVideos: failed indexing → terminal failed ──────
  await step(
    "processFeedbackVideos: failed indexing persists a terminal failed analysis",
    async () => {
      __resetVideoStub();
      __setScenario({ jobStatus: "failed", fullAnalysis: null });

      const vid = videoPath();
      const id = await insertFeedbackRow([vid]);

      await processFeedbackVideos(id, [vid], TL_ID);

      const analysis = await readVideoAnalysis(id);
      assert.ok(analysis, "video_analysis is persisted on failure");
      assert.equal(analysis.status, "failed", "terminal status is failed");
      assert.ok(analysis.completedAt, "completedAt stamp is present (terminal)");
      assert.equal(analysis.videos.length, 1, "one video entry recorded");
      assert.equal(analysis.videos[0].status, "failed", "the video entry is failed");
      assert.equal(analysis.videos[0].transcript, null, "no transcript on failure");
      assert.ok(
        typeof analysis.videos[0].error === "string" && analysis.videos[0].error.length > 0,
        "a per-video error message is recorded",
      );
    },
  );

  // ── (2c) processFeedbackVideos: no video attachments → never writes ────
  await step(
    "processFeedbackVideos: image-only submission never writes video_analysis",
    async () => {
      __resetVideoStub();
      // Scenario set but should never be consulted (no video paths).
      __setScenario({ jobStatus: "ready", fullAnalysis: null });

      const img = imagePath();
      const id = await insertFeedbackRow([img]);

      await processFeedbackVideos(id, [img], TL_ID);

      const analysis = await readVideoAnalysis(id);
      assert.equal(analysis, null, "video_analysis stays NULL with no video attachments");
    },
  );

  // ── (3) Admin gate on GET /api/feedback/:id/attachment ─────────────────
  const app = buildApp();
  const { server, baseUrl } = await listen(app);
  try {
    await step(
      "attachment route: 401 anon, 403 account_manager, 200 team_lead",
      async () => {
        __test_resetReconciledUsers();

        const anon = await call(baseUrl, "/api/feedback/123/attachment", null);
        assert.equal(anon.status, 401, "anonymous caller → 401");

        const am = await call(baseUrl, "/api/feedback/123/attachment", AM_ID);
        assert.equal(am.status, 403, "account_manager → 403 (team_lead required)");

        const tl = await call(baseUrl, "/api/feedback/123/attachment", TL_ID);
        assert.equal(tl.status, 200, "team_lead → 200 (reaches the handler)");
        assert.equal(tl.body?.served, true, "team_lead request reaches the sentinel handler");
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll feedback video upload + auto-analysis tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit(),
// so a leaked handle surfaces as a real hang instead of being masked.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    __resetVideoStub();
    try {
      await cleanup();
    } catch {}
    try {
      const { closeGlobalDispatcher } = await import("undici");
      await closeGlobalDispatcher();
    } catch {}
    process.exitCode = exitCode;
  });
