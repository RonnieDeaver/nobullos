/* test-registration
{
  "name": "Feedback video restart-resume sweep (Task #2414)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/feedbackVideoProcessingSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2414 — guard the feedback video restart-resume sweep
 * (`feedbackVideoResume.runFeedbackVideoResumeTick`). Uploaded feedback
 * videos are auto-analyzed in the background through TwelveLabs, but the
 * in-flight indexing job lives only in process memory (`videoAnalysis.ts`),
 * so a server restart mid-analysis leaves the `user_feedback` row stuck with
 * `video_analysis.status === "processing"` forever. The sweep finds those
 * orphaned rows and re-drives them, giving up after a bounded number of
 * attempts. The tick has several branches that are easy to regress:
 *
 *   1. Gating no-ops (never select or re-drive any row, write a reason):
 *        - master switch OFF (default)
 *        - queue paused via queue_drain_state
 *        - KILL_SWITCH_NON_CRITICAL_SWEEPS=true
 *   2. Candidate selection:
 *        - only rows stuck `processing` PAST the stuck-minutes threshold are
 *          selected (a freshly-started in-flight row is skipped)
 *        - ordered oldest-first (startedAt ASC)
 *        - bounded by max_per_tick
 *   3. Terminal branches (no external re-drive needed):
 *        - a stuck row with no video attachments → marked terminally failed
 *        - a row past the max-attempts give-up threshold → marked failed
 *   4. Re-drive: an eligible row is re-driven through the SHARED processor
 *      (`processFeedbackVideos`) with the bumped `resumeAttempt` threaded in,
 *      and the resulting terminal status is reported.
 *   5. The resume-attempt counter survives a re-drive, so a row that keeps
 *      coming back `processing` is eventually given up.
 *
 * The real processor downloads the attachment + submits to TwelveLabs + polls
 * for ~1h, so it is replaced by a stub (`feedbackVideoProcessingStub.mjs`,
 * registered via `--import feedbackVideoProcessingSetup.mjs`) that the test
 * drives deterministically. Everything else — the candidate SELECT, the
 * give-up / no-video terminal UPDATEs, the summary — exercises the REAL
 * service. Feedback rows are written to the live `user_feedback` table under a
 * unique test user id and cleaned up at the end.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { PERF } from "../server/perfConfig";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  setQueuePause,
  isQueuePaused,
  ensureQueueDrainStateLoaded,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import {
  runFeedbackVideoResumeTick,
  QUEUE_NAME,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  SETTING_STUCK_MINUTES,
  SETTING_MAX_ATTEMPTS,
  SETTING_LAST_RUN,
} from "../server/services/feedbackVideoResume";
import {
  __setProcessImpl,
  __getProcessCalls,
  __resetProcessStub,
} from "./helpers/feedbackVideoProcessingStub.mjs";
import { SYNTHETIC_FEEDBACK_TEST_MARKER } from "../server/services/feedbackSlackRetry";

const TEST_USER_ID = "task-2414-feedback-video-resume-test";
const VIDEO_PATH = "/objects/.private/feedback/task-2414/clip.mp4";
const IMAGE_PATH = "/objects/.private/feedback/task-2414/shot.png";

// Task #2783 — seed rows with a TERMINAL slack_status at insert time so the
// live feedback→Slack retry scheduler on the always-on dev server never
// treats these rows as real, undelivered candidates (this suite exercises
// video restart-resume, not the Slack relay). `undeliverable` is one of the
// two terminal statuses the retry scheduler already excludes.
const SYNTHETIC_SLACK_REASON = `${SYNTHETIC_FEEDBACK_TEST_MARKER} (task-2414) — never send to Slack`;

/**
 * Seed one feedback row whose `video_analysis` is `processing` with
 * `startedAt` set `startedMinutesAgo` in the past. `screenshots` carries the
 * given attachment paths (default: a single video). `resumeAttempts` seeds the
 * counter the give-up branch reads.
 */
async function seedRow(opts: {
  startedMinutesAgo: number;
  screenshots?: string[];
  resumeAttempts?: number;
  status?: string;
}): Promise<number> {
  const screenshots = opts.screenshots ?? [VIDEO_PATH];
  const va: Record<string, unknown> = {
    status: opts.status ?? "processing",
    startedAt: new Date(
      Date.now() - opts.startedMinutesAgo * 60_000,
    ).toISOString(),
    videos: [],
  };
  if (opts.resumeAttempts != null) va.resumeAttempts = opts.resumeAttempts;
  const r = await db.execute(sql`
    INSERT INTO user_feedback
      (user_id, user_name, topic, feedback_text, current_page, screenshots,
       video_analysis, created_at, slack_status, slack_reason)
    VALUES
      (${TEST_USER_ID}, 'Tester', 'BUG_REPORT', 'Video is broken',
       '/some/page', ${JSON.stringify(screenshots)},
       ${JSON.stringify(va)}::jsonb, now(), 'undeliverable', ${SYNTHETIC_SLACK_REASON})
    RETURNING id
  `);
  const id = (r.rows?.[0] as any)?.id;
  assert.ok(id != null, "insert should return a feedback row id");
  return Number(id);
}

async function readAnalysis(
  id: number,
): Promise<{ status: string | null; resumeAttempts: number | null; resumeError: string | null }> {
  const r = await db.execute(sql`
    SELECT video_analysis->>'status' AS status,
           video_analysis->>'resumeAttempts' AS resume_attempts,
           video_analysis->>'resumeError' AS resume_error
    FROM user_feedback WHERE id = ${id}
  `);
  const row = r.rows?.[0] as any;
  assert.ok(row, `feedback row ${id} should exist`);
  return {
    status: row.status ?? null,
    resumeAttempts:
      row.resume_attempts == null ? null : Number(row.resume_attempts),
    resumeError: row.resume_error ?? null,
  };
}

async function cleanupRows(): Promise<void> {
  await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${TEST_USER_ID}`);
}

// Task #2783 — belt-and-suspenders startup prune. `TEST_USER_ID` here is a
// fixed (non-timestamped) id already re-cleaned by `cleanupRows()` before and
// after every step, so a SIGKILL'd run can't normally leave rows behind: the
// very next run's first step clears them before seeding. Still, prune any
// stray `task-2414-%` rows at startup for defense in depth — rows seeded by
// this suite are already terminal (`slack_status='undeliverable'`) so this
// is table hygiene, not a Slack-safety requirement.
async function pruneLeftoverSyntheticRows(): Promise<void> {
  await db
    .execute(sql`DELETE FROM user_feedback WHERE user_id LIKE 'task-2414-%'`)
    .catch(() => {});
}

async function resetSettings(): Promise<void> {
  // Pin the master switch to a known default-OFF each step so a value leaked
  // by a SIGKILL'd sibling can't make these deterministic cases flaky.
  await setSystemSetting(SETTING_ENABLED, "false");
  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_STUCK_MINUTES).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_ATTEMPTS).catch(() => {});
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  // Persist an explicit unpause for our queue, not just an in-memory reset.
  // `_resetQueueDrainStateForTests()` deliberately leaves the persisted
  // `queue_drain_state` row intact, so the pause set by the "queue paused"
  // step would otherwise leak: a later step's first `isQueuePaused` call kicks
  // off an async cache reload that re-reads the persisted pause and silently
  // short-circuits a mid-sequence tick. Writing the unpause through first
  // clears the row before we drop the in-memory cache.
  await setQueuePause(QUEUE_NAME, false, "task-2414-test").catch(() => {});
  _resetQueueDrainStateForTests();
  // Warm the cache from the now-clean persisted row so the first synchronous
  // `isQueuePaused` in the step reflects the unpaused state deterministically.
  await ensureQueueDrainStateLoaded();
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetProcessStub();
  await resetSettings();
  await cleanupRows();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetProcessStub();
    await resetSettings();
    await cleanupRows();
  }
}

async function main(): Promise<void> {
  console.log("Feedback video restart-resume sweep (Task #2414)");
  await pruneLeftoverSyntheticRows();

  // ── (1a) disabled by default → no-op, row untouched ──────────────────
  await step("disabled by default: no-op with reason, no re-drive", async () => {
    await setSystemSetting(SETTING_ENABLED, "false");
    const id = await seedRow({ startedMinutesAgo: 999 });
    const r = await runFeedbackVideoResumeTick();
    assert.equal(r.enabled, false, "tick reports disabled");
    assert.equal(r.candidates, 0, "no candidates while disabled");
    assert.equal(r.attempted.length, 0, "nothing re-driven while disabled");
    assert.match(r.reason ?? "", /disabled/i);
    assert.equal(__getProcessCalls().length, 0, "processor never called");
    const a = await readAnalysis(id);
    assert.equal(a.status, "processing", "row left untouched");
  });

  // ── (1b) queue paused → no-op ────────────────────────────────────────
  await step("queue paused: no-op with reason", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setQueuePause(QUEUE_NAME, true, "task-2414-test");
    const id = await seedRow({ startedMinutesAgo: 999 });
    const r = await runFeedbackVideoResumeTick();
    assert.equal(r.paused, true, "tick reports paused");
    assert.equal(r.candidates, 0, "no candidates while paused");
    assert.match(r.reason ?? "", /paused/i);
    assert.equal(__getProcessCalls().length, 0, "processor never called");
    const a = await readAnalysis(id);
    assert.equal(a.status, "processing", "row left untouched");
  });

  // ── (1c) KILL_SWITCH_NON_CRITICAL_SWEEPS → no-op ─────────────────────
  await step("kill switch: no-op with reason", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    const id = await seedRow({ startedMinutesAgo: 999 });
    const prior = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
    (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
    try {
      const r = await runFeedbackVideoResumeTick();
      assert.equal(r.candidates, 0, "no candidates while killed");
      assert.match(r.reason ?? "", /KILL_SWITCH_NON_CRITICAL_SWEEPS/);
      assert.equal(__getProcessCalls().length, 0, "processor never called");
      const a = await readAnalysis(id);
      assert.equal(a.status, "processing", "row left untouched");
    } finally {
      (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = prior;
    }
  });

  // ── (2a) threshold: a fresh in-flight row is NOT a candidate ─────────
  await step("threshold: fresh processing row is not selected, stale one is", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "120");
    // Mark the stub a no-op success so the eligible row's re-drive is benign.
    __setProcessImpl(async (fid) => {
      await db.execute(sql`
        UPDATE user_feedback
        SET video_analysis = jsonb_set(video_analysis, '{status}', '"ready"'::jsonb, true)
        WHERE id = ${fid}
      `);
    });
    // 30 min old → inside the 120-min window → a healthy in-flight job → skip.
    const fresh = await seedRow({ startedMinutesAgo: 30 });
    // 300 min old → past the window → orphaned → selected.
    const stale = await seedRow({ startedMinutesAgo: 300 });

    const r = await runFeedbackVideoResumeTick();
    const ids = r.attempted.map((a) => a.feedbackId);
    assert.ok(!ids.includes(fresh), "fresh in-flight row skipped");
    assert.ok(ids.includes(stale), "stale orphaned row selected");
    const freshA = await readAnalysis(fresh);
    assert.equal(freshA.status, "processing", "fresh row untouched");
  });

  // ── (2b) ordering: oldest startedAt first ────────────────────────────
  await step("ordering: candidates processed oldest-first", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    __setProcessImpl(async (fid) => {
      await db.execute(sql`
        UPDATE user_feedback
        SET video_analysis = jsonb_set(video_analysis, '{status}', '"ready"'::jsonb, true)
        WHERE id = ${fid}
      `);
    });
    const newest = await seedRow({ startedMinutesAgo: 120 });
    const middle = await seedRow({ startedMinutesAgo: 240 });
    const oldest = await seedRow({ startedMinutesAgo: 480 });

    const r = await runFeedbackVideoResumeTick();
    const mineInOrder = r.attempted
      .map((a) => a.feedbackId)
      .filter((id) => [newest, middle, oldest].includes(id));
    assert.deepEqual(
      mineInOrder,
      [oldest, middle, newest],
      "oldest startedAt first",
    );
  });

  // ── (2c) per-tick budget cap ─────────────────────────────────────────
  await step("budget: max_per_tick caps candidates", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    await setSystemSetting(SETTING_MAX_PER_TICK, "2");
    __setProcessImpl(async (fid) => {
      await db.execute(sql`
        UPDATE user_feedback
        SET video_analysis = jsonb_set(video_analysis, '{status}', '"ready"'::jsonb, true)
        WHERE id = ${fid}
      `);
    });
    await seedRow({ startedMinutesAgo: 120 });
    await seedRow({ startedMinutesAgo: 180 });
    await seedRow({ startedMinutesAgo: 240 });

    const r = await runFeedbackVideoResumeTick();
    assert.equal(r.maxPerTick, 2, "tick reports the configured cap");
    assert.equal(r.candidates, 2, "candidate scan bounded by max_per_tick");
    assert.equal(r.attempted.length, 2, "at most max_per_tick rows handled");
  });

  // ── (3a) no video attachments → marked terminally failed ─────────────
  await step("no videos: stuck row with no video attachment → terminal failed", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    const id = await seedRow({ startedMinutesAgo: 300, screenshots: [IMAGE_PATH] });

    const r = await runFeedbackVideoResumeTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "row was handled");
    assert.equal(mine!.outcome, "no_videos", "classified no_videos");
    assert.equal(r.noVideos, 1, "noVideos counter incremented");
    assert.equal(__getProcessCalls().length, 0, "processor never called");
    const a = await readAnalysis(id);
    assert.equal(a.status, "failed", "row marked terminally failed");
    assert.match(a.resumeError ?? "", /no video/i);
  });

  // ── (3b) give up past max attempts → marked failed, no re-drive ──────
  await step("give up: past max attempts → terminal failed, no re-drive", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "3");
    // Already re-driven 3 times → at the cap → give up rather than re-drive.
    const id = await seedRow({ startedMinutesAgo: 300, resumeAttempts: 3 });

    const r = await runFeedbackVideoResumeTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "row was handled");
    assert.equal(mine!.outcome, "gave_up", "classified gave_up");
    assert.equal(r.gaveUp, 1, "gaveUp counter incremented");
    assert.equal(r.maxAttempts, 3, "tick reports the configured attempt cap");
    assert.equal(__getProcessCalls().length, 0, "processor never called");
    const a = await readAnalysis(id);
    assert.equal(a.status, "failed", "row marked terminally failed");
    assert.match(a.resumeError ?? "", /gave up/i);
  });

  // ── (4) re-drive: eligible row re-driven, bumped attempt threaded ────
  await step("re-drive: eligible row re-driven through processor with bumped attempt", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "5");
    // Simulate the processor completing: mark ready and persist the threaded
    // resumeAttempt (mirroring the real processor's stamping).
    __setProcessImpl(async (fid, _paths, _uid, o) => {
      await db.execute(sql`
        UPDATE user_feedback
        SET video_analysis = jsonb_set(
          jsonb_set(video_analysis, '{status}', '"ready"'::jsonb, true),
          '{resumeAttempts}', to_jsonb(${o?.resumeAttempt ?? null}::int), true
        )
        WHERE id = ${fid}
      `);
    });
    // One prior attempt → this re-drive must thread resumeAttempt = 2.
    const id = await seedRow({ startedMinutesAgo: 300, resumeAttempts: 1 });

    const r = await runFeedbackVideoResumeTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "row was handled");
    assert.equal(mine!.outcome, "resumed", "classified resumed");
    assert.equal(mine!.attempt, 2, "bumped attempt threaded (1 → 2)");
    assert.equal(mine!.finalStatus, "ready", "terminal status reported");
    assert.equal(r.resumed, 1, "resumed counter incremented");

    const calls = __getProcessCalls();
    assert.equal(calls.length, 1, "processor called exactly once");
    assert.equal(
      calls[0].opts?.resumeAttempt,
      2,
      "processor received resumeAttempt = 2",
    );
    assert.deepEqual(
      calls[0].attachmentPaths,
      [VIDEO_PATH],
      "processor received only the video path",
    );
    const a = await readAnalysis(id);
    assert.equal(a.status, "ready", "row landed ready");
    assert.equal(a.resumeAttempts, 2, "counter persisted for next time");
  });

  // ── (5) counter survives re-drives → eventually gives up ─────────────
  await step("counter survives re-drives: repeatedly-orphaned row eventually gives up", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_STUCK_MINUTES, "60");
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "2");
    // The processor "starts" but the server keeps restarting: it leaves the
    // row processing with the threaded resumeAttempt persisted and startedAt
    // pushed back into the past so the next tick still sees it as stale.
    __setProcessImpl(async (fid, _paths, _uid, o) => {
      await db.execute(sql`
        UPDATE user_feedback
        SET video_analysis = jsonb_set(
          jsonb_set(
            jsonb_set(video_analysis, '{status}', '"processing"'::jsonb, true),
            '{resumeAttempts}', to_jsonb(${o?.resumeAttempt ?? null}::int), true
          ),
          '{startedAt}', to_jsonb(${new Date(Date.now() - 300 * 60_000).toISOString()}::text), true
        )
        WHERE id = ${fid}
      `);
    });
    const id = await seedRow({ startedMinutesAgo: 300, resumeAttempts: 0 });

    // Tick 1: attempts 0 < 2 → re-drive (→ attempt 1), still processing.
    const r1 = await runFeedbackVideoResumeTick();
    assert.equal(r1.attempted[0]?.outcome, "resumed", "tick1 re-drives");
    assert.equal((await readAnalysis(id)).resumeAttempts, 1, "counter → 1");

    // Tick 2: attempts 1 < 2 → re-drive (→ attempt 2), still processing.
    const r2 = await runFeedbackVideoResumeTick();
    assert.equal(r2.attempted[0]?.outcome, "resumed", "tick2 re-drives");
    assert.equal((await readAnalysis(id)).resumeAttempts, 2, "counter → 2");

    // Tick 3: attempts 2 >= 2 → give up (no further re-drive).
    const before = __getProcessCalls().length;
    const r3 = await runFeedbackVideoResumeTick();
    assert.equal(r3.attempted[0]?.outcome, "gave_up", "tick3 gives up");
    assert.equal(
      __getProcessCalls().length,
      before,
      "no further processor call after give-up",
    );
    const a = await readAnalysis(id);
    assert.equal(a.status, "failed", "row terminally failed after give-up");
  });

  if (failures > 0) {
    console.error(`\nFeedback video resume sweep: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nFeedback video resume sweep: all passed");
}

await main();
