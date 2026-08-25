/* test-registration
{
  "name": "Front sync-metadata live heartbeat re-source (Task #2413)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2413 — the dashboards' "Last successful sync" must reflect a LIVE
 * heartbeat, not the frozen `front_last_sync_success` system setting.
 *
 * The old on-demand sync loop stamped `front_last_sync_success` on every run.
 * That loop was removed at the 2026-04-14 webhook cutover, so the setting has
 * been frozen ever since and nothing writes it — a healthy webhook-driven
 * Front integration looked permanently stale. `getSyncMetadata()` now derives
 * `lastSuccess` from the most-recent Front webhook landed in
 * `source_event_log` (`source_system = 'front'`).
 *
 * Coverage:
 *   (a) `getLastFrontWebhookActivityAt()` returns the MAX(received_at) of the
 *       `front` rows in `source_event_log` (not some other source system).
 *   (b) `getSyncMetadata().lastSuccess` tracks that live heartbeat and is
 *       NOT the frozen `front_last_sync_success` setting value — proving the
 *       dead setting read was actually removed.
 *
 * Uses real `db` (the api pool in test mode, matching `getDb()` inside the
 * service). Cleanup is via DELETE on the generated source_object_ids, and the
 * `front_last_sync_success` setting is pinned + restored.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { sourceEventLog } from "@shared/models/durablePipeline";
import {
  getSyncMetadata,
  getLastFrontWebhookActivityAt,
} from "../server/services/frontIntegration";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `front2413-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// A clearly-future heartbeat so MAX(received_at) for source_system='front' is
// guaranteed to be our row even on a shared dev DB with real Front traffic.
const HEARTBEAT_AT = new Date("2099-06-09T12:34:56.000Z");
const FRONT_OBJ = `${TAG}-front`;
const ZOOM_OBJ = `${TAG}-zoom`;
const allObjs = [FRONT_OBJ, ZOOM_OBJ];

// The frozen legacy setting, deliberately set to a value DIFFERENT from the
// live heartbeat so we can prove the code no longer returns it.
const FROZEN_SENTINEL = "2026-04-14T00:00:00.000Z";

async function cleanup(): Promise<void> {
  await db
    .delete(sourceEventLog)
    .where(inArray(sourceEventLog.sourceObjectId, allObjs));
}

async function run(): Promise<void> {
  await cleanup();

  // Pin + restore the legacy setting (shared-setting pinning guard).
  const priorFrozen = await storage
    .getSystemSetting("front_last_sync_success")
    .catch(() => null);
  await storage.setSystemSetting(
    "front_last_sync_success",
    FROZEN_SENTINEL,
    "system",
  );

  try {
    // Seed a future Front webhook landing + a (later, but different-system)
    // Zoom row to prove the source_system filter is honored.
    await db.insert(sourceEventLog).values([
      {
        sourceSystem: "front",
        sourceEventType: "test_message",
        sourceObjectId: FRONT_OBJ,
        dedupeKey: `${FRONT_OBJ}-dk`,
        payloadJson: { tag: TAG },
        receivedAt: HEARTBEAT_AT,
      },
      {
        sourceSystem: "zoom",
        sourceEventType: "test_recording",
        sourceObjectId: ZOOM_OBJ,
        dedupeKey: `${ZOOM_OBJ}-dk`,
        payloadJson: { tag: TAG },
        // Even later than the Front row — must NOT be picked up.
        receivedAt: new Date("2099-12-31T23:59:59.000Z"),
      },
    ]);

    // (a) heartbeat reads the Front row, ignoring the later Zoom row.
    const lastActivity = await getLastFrontWebhookActivityAt();
    assert(lastActivity !== null, "getLastFrontWebhookActivityAt returned null");
    assert(
      lastActivity!.getTime() === HEARTBEAT_AT.getTime(),
      `heartbeat should equal the Front row's received_at (got ${lastActivity?.toISOString()})`,
    );

    // (b) getSyncMetadata surfaces the live heartbeat, NOT the frozen setting.
    const meta = await getSyncMetadata();
    assert(
      meta.lastSuccess === HEARTBEAT_AT.toISOString(),
      `lastSuccess should be the live heartbeat ISO (got ${meta.lastSuccess})`,
    );
    assert(
      meta.lastSuccess !== FROZEN_SENTINEL,
      "lastSuccess must NOT be the frozen front_last_sync_success setting value",
    );
  } finally {
    await cleanup();
    if (priorFrozen) {
      await storage.setSystemSetting(
        "front_last_sync_success",
        priorFrozen.value ?? "",
        "system",
      );
    } else {
      await storage.deleteSystemSetting("front_last_sync_success");
    }
  }

  console.log(
    "[front-sync-metadata-heartbeat.test] PASS — 2 cases, 4 assertions",
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
run()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
