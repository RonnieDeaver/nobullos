/* test-registration
{
  "name": "Comms draft-attachment cleanup sweep (Task #3520)",
  "regression": true,
  "sweepOnlyReason": "Task #3520 — draft-attachment retention sweep: seeds real users/comms_channels/comms_drafts rows + writes shared system_settings (seed+cleanup). Real shared-DB writes, not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * Task #3520 — guard the comms draft-attachment retention sweep
 * (`commsDraftAttachmentCleanup.runDraftAttachmentCleanupTick`). Draft
 * pre-uploads leave orphaned originals under `comms-draft-attachments/`
 * and thumbnails under `comms-draft-attachments/thumb/` after promotion
 * or abandonment; the sweep deletes them once they are past the retention
 * window and no live draft references them. Branches under guard:
 *
 *   1. Gating no-ops (never list or delete, write a reason):
 *        - master switch OFF (default)
 *        - KILL_SWITCH_NON_CRITICAL_SWEEPS=true
 *   2. Candidate selection:
 *        - a key referenced by a live draft is NEVER deleted, regardless
 *          of age (originals AND thumbnailKeys)
 *        - a key younger than the retention window is never deleted
 *        - a key with NO readable creation time is treated as young
 *          (never deleted blind)
 *        - old + unreferenced keys (originals and thumbs) are deleted
 *   3. Bounding: deletes stop at the per-tick budget and the summary
 *      reports budgetExhausted so the next tick finishes the job.
 *   4. Resilience: a per-object delete failure is counted as an error,
 *      never thrown, and the rest of the pass continues.
 *   5. The referenced-key collector parses real comms_drafts metadata
 *      (attachments[].objectKey/.thumbnailKey) and ignores malformed rows.
 *
 * Object storage is injected via the deps seam (no real bucket calls);
 * the referenced-key collector case writes real `comms_drafts` rows under
 * a synthetic user/channel and cleans them up.
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
  runDraftAttachmentCleanupTick,
  collectReferencedDraftKeys,
  SETTING_ENABLED,
  SETTING_RETENTION_DAYS,
  SETTING_MAX_DELETES_PER_TICK,
  SETTING_LAST_RUN,
} from "../server/services/commsDraftAttachmentCleanup";
import type { PrivatePrefixObject } from "../server/replit_integrations/object_storage/objectStorage";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - 45 * 24 * 60 * 60_000); // 45 days old
const FRESH = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000); // 2 days old

function obj(objectKey: string, timeCreated: Date | null): PrivatePrefixObject {
  return { objectKey, timeCreated, sizeBytes: 1234 };
}

// Route-test collision guard (memory): suffix all synthetic ids per run.
const RUN = randomUUID().slice(0, 8);

// Pin + restore every shared system_settings key this suite reads or
// writes (memory: pin globals a suite READS, not just ones it mutates).
const PINNED_KEYS = [
  SETTING_ENABLED,
  SETTING_RETENTION_DAYS,
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
  console.log("comms-draft-attachment-cleanup.test.ts");
  await pinSettings();
  const priorKillSwitch = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;

  const testUserId = `test-draft-cleanup-user-${RUN}`;
  const testChannelId = `test-draft-cleanup-chan-${RUN}`;

  try {
    await step("disabled by default → no-op with reason, nothing listed", async () => {
      let listed = false;
      const result = await runDraftAttachmentCleanupTick({
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
        const result = await runDraftAttachmentCleanupTick({
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
      "deletes old unreferenced originals + thumbs; protects referenced, young, and unknown-age objects",
      async () => {
        const deleted: string[] = [];
        const result = await runDraftAttachmentCleanupTick({
          listObjects: async () => [
            obj("comms-draft-attachments/old-orphan.png", OLD),
            obj("comms-draft-attachments/thumb/old-orphan.webp", OLD),
            obj("comms-draft-attachments/old-referenced.png", OLD),
            obj("comms-draft-attachments/thumb/old-referenced.webp", OLD),
            obj("comms-draft-attachments/fresh.png", FRESH),
            obj("comms-draft-attachments/no-time.png", null),
          ],
          deleteObject: async (key) => {
            deleted.push(key);
            return true;
          },
          loadReferencedKeys: async () =>
            new Set([
              "comms-draft-attachments/old-referenced.png",
              "comms-draft-attachments/thumb/old-referenced.webp",
            ]),
          now: NOW,
        });
        assert.deepEqual(deleted.sort(), [
          "comms-draft-attachments/old-orphan.png",
          "comms-draft-attachments/thumb/old-orphan.webp",
        ]);
        assert.equal(result.listed, 6);
        assert.equal(result.deleted, 2);
        assert.equal(result.referenced, 2);
        assert.equal(result.tooYoung, 2); // fresh + null-time
        assert.equal(result.errors, 0);
        assert.equal(result.budgetExhausted, false);
        // Last-run readout persisted.
        const lastRun = JSON.parse(
          (await getSystemSetting(SETTING_LAST_RUN))?.value ?? "{}",
        );
        assert.equal(lastRun.deleted, 2);
      },
    );

    await step("per-tick delete budget bounds the pass and flags budgetExhausted", async () => {
      await setSystemSetting(SETTING_MAX_DELETES_PER_TICK, "2");
      try {
        const deleted: string[] = [];
        const result = await runDraftAttachmentCleanupTick({
          listObjects: async () => [
            obj("comms-draft-attachments/a.png", OLD),
            obj("comms-draft-attachments/b.png", OLD),
            obj("comms-draft-attachments/c.png", OLD),
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

    await step("a per-object delete failure is counted, not thrown, and the pass continues", async () => {
      const deleted: string[] = [];
      const result = await runDraftAttachmentCleanupTick({
        listObjects: async () => [
          obj("comms-draft-attachments/boom.png", OLD),
          obj("comms-draft-attachments/ok.png", OLD),
        ],
        deleteObject: async (key) => {
          if (key.includes("boom")) throw new Error("storage blip");
          deleted.push(key);
          return true;
        },
        loadReferencedKeys: async () => new Set(),
        now: NOW,
      });
      assert.equal(result.errors, 1);
      assert.equal(result.deleted, 1);
      assert.deepEqual(deleted, ["comms-draft-attachments/ok.png"]);
    });

    await step(
      "collectReferencedDraftKeys reads real drafts metadata (objectKey + thumbnailKey) and skips malformed rows",
      async () => {
        // Seed prerequisite user + channel (FKs), then two drafts: one with
        // attachments, one with malformed metadata.
        await db.execute(sql`
          INSERT INTO users (id, email) VALUES (${testUserId}, ${`draft-cleanup-${RUN}@test.local`})
          ON CONFLICT (id) DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO comms_channels (id, name, type, created_by)
          VALUES (${testChannelId}, ${`test-draft-cleanup-${RUN}`}, 'channel', ${testUserId})
          ON CONFLICT (id) DO NOTHING
        `);
        const goodMeta = JSON.stringify({
          attachments: [
            {
              objectKey: `comms-draft-attachments/ref-${RUN}.png`,
              thumbnailKey: `comms-draft-attachments/thumb/ref-${RUN}.webp`,
            },
            // Non-draft-prefix key must be ignored.
            { objectKey: "comms-attachments/promoted.png" },
          ],
        });
        await db.execute(sql`
          INSERT INTO comms_drafts (user_id, channel_id, content, metadata)
          VALUES (${testUserId}, ${testChannelId}, 'draft with attachments', ${goodMeta}::jsonb)
        `);
        await db.execute(sql`
          INSERT INTO comms_drafts (user_id, channel_id, parent_id, content, metadata)
          VALUES (${testUserId}, ${testChannelId}, 'thread-parent', 'malformed', '{"attachments": "not-an-array"}'::jsonb)
        `);

        const keys = await collectReferencedDraftKeys();
        assert.ok(keys.has(`comms-draft-attachments/ref-${RUN}.png`));
        assert.ok(keys.has(`comms-draft-attachments/thumb/ref-${RUN}.webp`));
        assert.ok(!keys.has("comms-attachments/promoted.png"));
      },
    );

    console.log(`\nAll ${passed} steps passed.`);
  } finally {
    await db.execute(sql`DELETE FROM comms_drafts WHERE user_id = ${testUserId}`);
    await db.execute(sql`DELETE FROM comms_channels WHERE id = ${testChannelId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${testUserId}`);
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
