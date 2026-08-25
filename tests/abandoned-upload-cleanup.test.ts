/* test-registration
{
  "name": "Abandoned presigned-upload cleanup sweep (Task #3983)",
  "regression": true,
  "sweepOnlyReason": "Task #3983 — abandoned-upload retention sweep: seeds real user_feedback/ats_jobs/ats_candidates/ats_submissions/clients/reports/report_sections rows + writes shared system_settings (seed+cleanup). Real shared-DB writes, not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * Task #3983 — guard the abandoned presigned-upload retention sweep
 * (`abandonedUploadCleanup.runAbandonedUploadCleanupTick`). Presigned PUTs
 * land objects under `uploads/`, `feedback-uploads/` and `ats-<candidateId>/`
 * BEFORE any claim runs; abandoned flows leave unclaimed, unreferenced
 * objects behind. Branches under guard:
 *
 *   1. Gating no-ops (never list or delete, write a reason):
 *        - master switch OFF (default)
 *        - KILL_SWITCH_NON_CRITICAL_SWEEPS=true
 *   2. Candidate selection:
 *        - an object WITH an ACL owner is NEVER deleted, regardless of age
 *        - a key referenced by a DB record is NEVER deleted
 *        - a key younger than the grace window is never deleted
 *        - a key with NO readable creation time is treated as young
 *        - old + unclaimed + unreferenced keys across all three prefixes
 *          are deleted
 *   3. Bounding: deletes stop at the per-tick budget (budgetExhausted).
 *   4. Resilience: a delete failure/race-skip (false return AND throw) is
 *      counted as an error, never thrown, and the pass continues.
 *   5. The referenced-key collector reads real DB rows: feedback
 *      screenshots JSON, ats_submissions video_url/video_object_key, and
 *      report_sections marketing heatmapImageUrl (both location shapes),
 *      ignoring malformed rows.
 *
 * Object storage is injected via the deps seam (no real bucket calls);
 * the collector case writes real rows under synthetic ids and cleans up.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { PERF } from "../server/perfConfig";
import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  runAbandonedUploadCleanupTick,
  collectReferencedUploadKeys,
  SETTING_ENABLED,
  SETTING_GRACE_HOURS,
  SETTING_MAX_DELETES_PER_TICK,
  SETTING_LAST_RUN,
} from "../server/services/abandonedUploadCleanup";
import type { PrivatePrefixObject } from "../server/replit_integrations/object_storage/objectStorage";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - 5 * 24 * 60 * 60_000); // 5 days old
const FRESH = new Date(NOW.getTime() - 6 * 60 * 60_000); // 6h old (< 48h grace)

function obj(
  objectKey: string,
  timeCreated: Date | null,
  aclOwner: string | null = null,
): PrivatePrefixObject {
  return { objectKey, timeCreated, sizeBytes: 1234, aclOwner };
}

// Route-test collision guard (memory): suffix all synthetic ids per run.
const RUN = randomUUID().slice(0, 8);

// Pin + restore every shared system_settings key this suite reads or
// writes (memory: pin globals a suite READS, not just ones it mutates).
const PINNED_KEYS = [
  SETTING_ENABLED,
  SETTING_GRACE_HOURS,
  SETTING_MAX_DELETES_PER_TICK,
  SETTING_LAST_RUN,
];
const priorValues = new Map<string, string | null>();

async function pinSettings(): Promise<void> {
  for (const key of PINNED_KEYS) {
    const row = await getSystemSetting(key).catch(() => null);
    priorValues.set(key, row?.value ?? null);
    await deleteSystemSetting(key).catch(() => {});
  }
}

async function restoreSettings(): Promise<void> {
  for (const key of PINNED_KEYS) {
    const prior = priorValues.get(key);
    if (prior == null) {
      await deleteSystemSetting(key).catch(() => {});
    } else {
      await setSystemSetting(key, prior);
    }
  }
}

let passed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function main(): Promise<void> {
  console.log("abandoned-upload-cleanup.test.ts");
  await pinSettings();
  const priorKillSwitch = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;

  const feedbackUserId = `test-abandoned-cleanup-${RUN}`;
  const atsJobId = randomUUID();
  const atsCandidateId = randomUUID();
  const atsSubmissionId = randomUUID();
  const clientId = randomUUID();
  const reportId = randomUUID();

  try {
    await step("disabled by default → no-op with reason, nothing listed", async () => {
      let listed = false;
      const result = await runAbandonedUploadCleanupTick({
        listObjects: async () => {
          listed = true;
          return [];
        },
        deleteObject: async () => true,
        loadReferencedKeys: async () => new Set(),
        now: NOW,
      });
      assert.equal(result.enabled, false);
      assert.match(result.reason ?? "", /disabled/);
      assert.equal(listed, false);
      assert.equal(result.deleted, 0);
    });

    await setSystemSetting(SETTING_ENABLED, "true");

    await step("KILL_SWITCH_NON_CRITICAL_SWEEPS gates the sweep", async () => {
      (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
      try {
        let listed = false;
        const result = await runAbandonedUploadCleanupTick({
          listObjects: async () => {
            listed = true;
            return [];
          },
          deleteObject: async () => true,
          loadReferencedKeys: async () => new Set(),
          now: NOW,
        });
        assert.match(result.reason ?? "", /KILL_SWITCH_NON_CRITICAL_SWEEPS/);
        assert.equal(listed, false);
      } finally {
        (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = priorKillSwitch;
      }
    });

    await step(
      "deletes old unclaimed+unreferenced objects across prefixes; protects owned, referenced, young, unknown-age",
      async () => {
        const deleted: string[] = [];
        const result = await runAbandonedUploadCleanupTick({
          listObjects: async () => [
            // Old + unclaimed + unreferenced → deleted (all three namespaces).
            obj("uploads/old-orphan.png", OLD),
            obj("feedback-uploads/old-orphan.mp4", OLD),
            obj(`ats-${atsCandidateId}/old-orphan.webm`, OLD),
            // Old but CLAIMED (ACL owner) → never touched.
            obj("uploads/old-owned.png", OLD, "some-user"),
            // Old but DB-referenced → never touched.
            obj("feedback-uploads/old-referenced.png", OLD),
            // Recent unclaimed → kept (grace window).
            obj("uploads/fresh.png", FRESH),
            // Unknown creation time → treated as young, never deleted blind.
            obj("uploads/no-time.png", null),
          ],
          deleteObject: async (key) => {
            deleted.push(key);
            return true;
          },
          loadReferencedKeys: async () =>
            new Set(["feedback-uploads/old-referenced.png"]),
          now: NOW,
        });
        assert.deepEqual(deleted.sort(), [
          `ats-${atsCandidateId}/old-orphan.webm`,
          "feedback-uploads/old-orphan.mp4",
          "uploads/old-orphan.png",
        ]);
        assert.equal(result.listed, 7);
        assert.equal(result.deleted, 3);
        assert.equal(result.owned, 1);
        assert.equal(result.referenced, 1);
        assert.equal(result.tooYoung, 2); // fresh + null-time
        assert.equal(result.errors, 0);
        assert.equal(result.budgetExhausted, false);
        // Last-run readout persisted for the operator surface.
        const lastRun = JSON.parse(
          (await getSystemSetting(SETTING_LAST_RUN))?.value ?? "{}",
        );
        assert.equal(lastRun.deleted, 3);
        assert.equal(lastRun.owned, 1);
      },
    );

    await step("per-tick delete budget bounds the pass and flags budgetExhausted", async () => {
      await setSystemSetting(SETTING_MAX_DELETES_PER_TICK, "2");
      try {
        const deleted: string[] = [];
        const result = await runAbandonedUploadCleanupTick({
          listObjects: async () => [
            obj("uploads/a.png", OLD),
            obj("uploads/b.png", OLD),
            obj("uploads/c.png", OLD),
          ],
          deleteObject: async (key) => {
            deleted.push(key);
            return true;
          },
          loadReferencedKeys: async () => new Set(),
          now: NOW,
        });
        assert.equal(deleted.length, 2);
        assert.equal(result.deleted, 2);
        assert.equal(result.budgetExhausted, true);
      } finally {
        await deleteSystemSetting(SETTING_MAX_DELETES_PER_TICK).catch(() => {});
      }
    });

    await step("delete failures (throw AND race-skip false) are counted, not thrown; pass continues", async () => {
      const deleted: string[] = [];
      const result = await runAbandonedUploadCleanupTick({
        listObjects: async () => [
          obj("uploads/boom.png", OLD),
          obj("uploads/race-claimed.png", OLD),
          obj("uploads/ok.png", OLD),
        ],
        deleteObject: async (key) => {
          if (key.includes("boom")) throw new Error("storage blip");
          // Race-safe delete returns false when a claim landed mid-sweep.
          if (key.includes("race-claimed")) return false;
          deleted.push(key);
          return true;
        },
        loadReferencedKeys: async () => new Set(),
        now: NOW,
      });
      assert.equal(result.errors, 2);
      assert.equal(result.deleted, 1);
      assert.deepEqual(deleted, ["uploads/ok.png"]);
    });

    await step(
      "collectReferencedUploadKeys reads real feedback/ATS/report rows and skips malformed data",
      async () => {
        // Feedback row with two attachment paths + one malformed row.
        await db.execute(sql`
          INSERT INTO user_feedback (user_id, user_name, feedback_text, screenshots)
          VALUES (${feedbackUserId}, 'Abandoned Cleanup Test', 'test row',
                  ${JSON.stringify([
                    `/objects/feedback-uploads/ref-${RUN}.png`,
                    `/objects/feedback-uploads/ref-${RUN}.mp4`,
                  ])})
        `);
        await db.execute(sql`
          INSERT INTO user_feedback (user_id, user_name, feedback_text, screenshots)
          VALUES (${feedbackUserId}, 'Abandoned Cleanup Test', 'malformed row', 'not-json')
        `);
        // ATS chain: job → candidate → submission with video refs.
        await db.execute(sql`
          INSERT INTO ats_jobs (id, title, description)
          VALUES (${atsJobId}, ${`test-job-${RUN}`}, 'test')
        `);
        await db.execute(sql`
          INSERT INTO ats_candidates (id, job_id, name, email, access_token)
          VALUES (${atsCandidateId}, ${atsJobId}, 'Test Candidate',
                  ${`abandoned-${RUN}@test.local`}, ${`tok-${RUN}`})
        `);
        await db.execute(sql`
          INSERT INTO ats_submissions (id, candidate_id, job_id, question_id, question_type, video_url, video_object_key)
          VALUES (${atsSubmissionId}, ${atsCandidateId}, ${atsJobId}, 'q1', 'video',
                  ${`/objects/ats-${atsCandidateId}/ref-${RUN}.webm`},
                  ${`ats-${atsCandidateId}/ref-key-${RUN}.webm`})
        `);
        // Report marketing section referencing heatmap images (both shapes).
        await db.execute(sql`
          INSERT INTO clients (id, firm_name) VALUES (${clientId}, ${`test-client-${RUN}`})
        `);
        await db.execute(sql`
          INSERT INTO reports (id, client_id, report_month)
          VALUES (${reportId}, ${clientId}, '2026-08')
        `);
        const marketingData = JSON.stringify({
          gbpLocations: [
            { heatmapImageUrl: `/objects/uploads/heatmap-${RUN}.png` },
          ],
          gbp: {
            locations: [
              { heatmapImageUrl: `/objects/uploads/heatmap-nested-${RUN}.png` },
              { heatmapImageUrl: "not-an-objects-path" },
            ],
          },
        });
        await db.execute(sql`
          INSERT INTO report_sections (report_id, section_key, data)
          VALUES (${reportId}, 'marketing', ${marketingData}::jsonb)
        `);

        const keys = await collectReferencedUploadKeys();
        assert.ok(keys.has(`feedback-uploads/ref-${RUN}.png`));
        assert.ok(keys.has(`feedback-uploads/ref-${RUN}.mp4`));
        assert.ok(keys.has(`ats-${atsCandidateId}/ref-${RUN}.webm`));
        assert.ok(keys.has(`ats-${atsCandidateId}/ref-key-${RUN}.webm`));
        assert.ok(keys.has(`uploads/heatmap-${RUN}.png`));
        assert.ok(keys.has(`uploads/heatmap-nested-${RUN}.png`));
        assert.ok(!keys.has("not-an-objects-path"));
      },
    );

    console.log(`\nAll ${passed} steps passed.`);
  } finally {
    await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${reportId}`);
    await db.execute(sql`DELETE FROM reports WHERE id = ${reportId}`);
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
    await db.execute(sql`DELETE FROM ats_submissions WHERE id = ${atsSubmissionId}`);
    await db.execute(sql`DELETE FROM ats_candidates WHERE id = ${atsCandidateId}`);
    await db.execute(sql`DELETE FROM ats_jobs WHERE id = ${atsJobId}`);
    await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${feedbackUserId}`);
    await restoreSettings();
    (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = priorKillSwitch;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
