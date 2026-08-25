/* test-registration
{
  "name": "Table retention pruner: per-unit eligibility + batched deletes + cascade (Task #3814)",
  "smoke": true,
  "smokeReason": "Guards the retention layer for shared operational tables: a predicate/cutoff regression would either mass-delete live queue rows or silently stop pruning (unbounded growth returns).",
  "tier": "small"
}
test-registration */
/**
 * Task #3814 — scheduled retention pruner for the high-churn operational
 * tables (tableMaintenancePolicy PRUNE_UNITS).
 *
 * Asserts, per unit:
 *  - eligible rows (terminal status + older than the retention cutoff) are
 *    deleted by `deleteOneBatch`;
 *  - survivors are kept: non-terminal statuses AND terminal-but-recent rows;
 *  - deleting a terminal `source_event_log` row CASCADEs to its
 *    `work_result_log` + `apply_state` children (that cascade is those
 *    tables' declared retention path);
 *  - `countEligible` sees seeded eligible rows;
 *  - `pruneTick` is a no-op while `table_retention_pruner_enabled` is false.
 *
 * Isolation strategy: the pruner runs on `workerDb` (public schema — the tx
 * sandbox cannot pin it), so the test seeds PUBLIC tables with ancient
 * timestamps (1960) and passes a huge injected retention window (20,000
 * days → cutoff ≈ 1971). Real dev rows all have modern timestamps, so the
 * only rows eligible under that cutoff are the seeds — batch deletes cannot
 * touch shared data. The one exception is `mcu_cache_expired` (inherent
 * `expires_at < NOW()` predicate): deleting other suites' already-expired
 * cache rows is the unit's exact production job and harmless. All seeded
 * ids carry a per-run random tag; cleanup runs in finally.
 */
import { sql } from "drizzle-orm";
import {
  workQueue,
  sourceEventLog,
  workResultLog,
  applyState,
  callAnalysisJobs,
  mcuCache,
  tableSizeSamples,
  commsLinkPreviews,
  semrushLocationSyncAttempts,
  semrushLocationSyncState,
  bookingClientTokens,
  bookingPages,
  clients,
  clientLocations,
  users,
  userActivityLogs,
  clientFiles,
  clientFileShareLinks,
} from "@shared/schema";
import { getDb } from "../server/db";
import { storage } from "../server/storage";
import {
  PRUNE_UNITS,
  RETENTION_SETTING_KEYS,
  TABLE_RETENTION_PRUNER_ENABLED_KEY,
} from "../server/services/tableMaintenancePolicy";
import {
  countEligible,
  deleteOneBatch,
  pruneUnit,
  readUnitRetentionDays,
  __test,
} from "../server/services/tableRetentionPruner";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `trp${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const ANCIENT = new Date("1960-06-01T00:00:00Z");
const HUGE_RETENTION_DAYS = 20_000; // cutoff ≈ 1971 — only 1960 seeds qualify

function unit(key: string) {
  const u = PRUNE_UNITS.find((u) => u.key === key);
  assert(u, `prune unit ${key} declared in policy`);
  return u!;
}

async function countByIds(table: string, pk: string, ids: string[]): Promise<number> {
  const list = ids.map((id) => `'${id}'`).join(",");
  const res = await getDb().execute<any>(
    sql.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${pk} IN (${list})`),
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const db = getDb();

  const wqEligible = [`wq-${TAG}-done`, `wq-${TAG}-cancelled`];
  const wqSurvivors = [`wq-${TAG}-recent-done`, `wq-${TAG}-pending-old`];
  const wqFailedEligible = [`wq-${TAG}-failed`, `wq-${TAG}-dead`];
  const selId = `sel-${TAG}`;
  const selSurvivorId = `sel-${TAG}-received`;
  const wrlId = `wrl-${TAG}`;
  const asId = `as-${TAG}`;
  const cajEligible = `caj-${TAG}-complete`;
  const cajSurvivor = `caj-${TAG}-queued-old`;

  try {
    // ── Seed work_queue: 2 eligible terminal + 2 survivors ──
    await db.insert(workQueue).values([
      ...wqEligible.map((id, i) => ({
        id,
        queueName: `q-${TAG}`,
        jobType: `job-${TAG}`,
        workloadClass: "maintenance",
        status: i === 0 ? "completed" : "cancelled",
        payload: {},
        createdAt: ANCIENT,
        updatedAt: ANCIENT,
      })),
      {
        // terminal but RECENT → must survive the cutoff
        id: wqSurvivors[0],
        queueName: `q-${TAG}`,
        jobType: `job-${TAG}`,
        workloadClass: "maintenance",
        status: "completed",
        payload: {},
        createdAt: ANCIENT,
        updatedAt: new Date(),
      },
      {
        // ancient but NON-terminal → must survive (never touch in-flight work)
        id: wqSurvivors[1],
        queueName: `q-${TAG}`,
        jobType: `job-${TAG}`,
        workloadClass: "maintenance",
        status: "pending",
        payload: {},
        createdAt: ANCIENT,
        updatedAt: ANCIENT,
      },
      ...wqFailedEligible.map((id, i) => ({
        id,
        queueName: `q-${TAG}`,
        jobType: `job-${TAG}`,
        workloadClass: "maintenance",
        status: i === 0 ? "failed" : "dead_letter",
        payload: {},
        createdAt: ANCIENT,
        updatedAt: ANCIENT,
      })),
    ] as any);

    // ── work_queue_terminal unit ──
    const wqUnit = unit("work_queue_terminal");
    const eligibleBefore = await countEligible(wqUnit, 10_000, {
      retentionDays: HUGE_RETENTION_DAYS,
    });
    assert(eligibleBefore >= 2, `countEligible sees the 2 seeded terminal rows (got ${eligibleBefore})`);
    const removed = await deleteOneBatch(wqUnit, {
      retentionDays: HUGE_RETENTION_DAYS,
      batchLimit: 10_000,
    });
    assert(removed >= 2, `work_queue_terminal deleted the seeds (removed ${removed})`);
    assert(
      (await countByIds("work_queue", "id", wqEligible)) === 0,
      "eligible completed/cancelled seeds are gone",
    );
    assert(
      (await countByIds("work_queue", "id", wqSurvivors)) === 2,
      "recent-terminal and ancient-pending survivors remain",
    );
    // failed/dead_letter rows are NOT the terminal unit's business
    assert(
      (await countByIds("work_queue", "id", wqFailedEligible)) === 2,
      "failed/dead_letter rows untouched by the terminal unit",
    );

    // ── work_queue_failed unit ──
    const wqFailedUnit = unit("work_queue_failed");
    await deleteOneBatch(wqFailedUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("work_queue", "id", wqFailedEligible)) === 0,
      "failed/dead_letter seeds deleted by the failed unit",
    );
    assert(
      (await countByIds("work_queue", "id", [wqSurvivors[1]])) === 1,
      "ancient pending row still survives the failed unit",
    );

    // ── source_event_log terminal + CASCADE to work_result_log/apply_state ──
    await db.insert(sourceEventLog).values([
      {
        id: selId,
        sourceSystem: "front",
        sourceEventType: `evt-${TAG}`,
        sourceObjectId: `obj-${TAG}`,
        dedupeKey: `dk-${TAG}`,
        payloadJson: {},
        status: "applied",
        receivedAt: ANCIENT,
      },
      {
        // ancient but NON-terminal (received) → must survive
        id: selSurvivorId,
        sourceSystem: "front",
        sourceEventType: `evt-${TAG}`,
        sourceObjectId: `obj2-${TAG}`,
        dedupeKey: `dk2-${TAG}`,
        payloadJson: {},
        status: "received",
        receivedAt: ANCIENT,
      },
    ] as any);
    await db.insert(workResultLog).values({
      id: wrlId,
      sourceEventId: selId,
      sourceSystem: "front",
      resultType: `rt-${TAG}`,
      resultJson: {},
      status: "applied",
    } as any);
    await db.insert(applyState).values({
      id: asId,
      workResultId: wrlId,
      sourceEventId: selId,
      sourceSystem: "front",
      applyTarget: `tgt-${TAG}`,
      outcome: "applied",
    } as any);

    const selUnit = unit("source_event_log_terminal");
    await deleteOneBatch(selUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert((await countByIds("source_event_log", "id", [selId])) === 0, "terminal source event deleted");
    assert(
      (await countByIds("work_result_log", "id", [wrlId])) === 0,
      "work_result_log child died via ON DELETE CASCADE",
    );
    assert(
      (await countByIds("apply_state", "id", [asId])) === 0,
      "apply_state child died via ON DELETE CASCADE",
    );
    assert(
      (await countByIds("source_event_log", "id", [selSurvivorId])) === 1,
      "non-terminal ancient source event survives",
    );

    // ── call_analysis_jobs terminal ──
    await db.insert(callAnalysisJobs).values([
      {
        analysisId: cajEligible,
        externalId: `ext-${TAG}`,
        idempotencyKey: `idem-${TAG}-1`,
        status: "complete",
        createdAt: ANCIENT,
      },
      {
        analysisId: cajSurvivor,
        externalId: `ext-${TAG}`,
        idempotencyKey: `idem-${TAG}-2`,
        status: "queued",
        createdAt: ANCIENT,
      },
    ] as any);
    const cajUnit = unit("call_analysis_jobs_terminal");
    await deleteOneBatch(cajUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("call_analysis_jobs", "analysis_id", [cajEligible])) === 0,
      "complete analysis job deleted",
    );
    assert(
      (await countByIds("call_analysis_jobs", "analysis_id", [cajSurvivor])) === 1,
      "queued (non-terminal) analysis job survives despite age",
    );

    // ── mcu_cache expired (inherent TTL predicate) ──
    const [expiredRow] = await db
      .insert(mcuCache)
      .values({
        cacheType: `t-${TAG}`,
        cacheKey: `k-${TAG}-expired`,
        data: {},
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      } as any)
      .returning({ id: mcuCache.id });
    const [liveRow] = await db
      .insert(mcuCache)
      .values({
        cacheType: `t-${TAG}`,
        cacheKey: `k-${TAG}-live`,
        data: {},
        expiresAt: new Date(Date.now() + 60 * 60_000),
      } as any)
      .returning({ id: mcuCache.id });
    const mcuUnit = unit("mcu_cache_expired");
    // Loop until exhausted: the predicate also matches other suites' expired
    // cache rows, so one batch may not reach the seed.
    const mcuResult = await pruneUnit(mcuUnit, { batchLimit: 5000, maxBatches: 50 });
    assert(mcuResult.exhausted, "mcu_cache expired prune ran to exhaustion");
    assert(
      (await countByIds("mcu_cache", "id", [expiredRow.id])) === 0,
      "expired mcu_cache row deleted",
    );
    assert(
      (await countByIds("mcu_cache", "id", [liveRow.id])) === 1,
      "unexpired mcu_cache row survives",
    );
    await db.execute(sql`DELETE FROM mcu_cache WHERE id = ${liveRow.id}`);

    // ── table_size_samples (epoch-ms cutoff kind) ──
    await db.insert(tableSizeSamples).values([
      { sampledAt: ANCIENT.getTime(), tableName: `t-${TAG}` },
      { sampledAt: Date.now(), tableName: `t-${TAG}` },
    ] as any);
    const tssUnit = unit("table_size_samples_old");
    await deleteOneBatch(tssUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    const tssLeft = await getDb().execute<any>(
      sql`SELECT sampled_at FROM table_size_samples WHERE table_name = ${`t-${TAG}`}`,
    );
    assert(tssLeft.rows.length === 1, "only the ancient size sample was pruned");
    assert(
      Number(tssLeft.rows[0].sampled_at) > 0,
      "the recent size sample survives",
    );

    // ── comms_link_previews stale (Task #4339) ──
    const [lpEligible] = await db
      .insert(commsLinkPreviews)
      .values({
        url: `https://example.test/${TAG}/stale`,
        fetchedAt: ANCIENT,
        cachedUntil: ANCIENT,
      } as any)
      .returning({ id: commsLinkPreviews.id });
    const [lpSurvivor] = await db
      .insert(commsLinkPreviews)
      .values({
        url: `https://example.test/${TAG}/live`,
        fetchedAt: new Date(),
        cachedUntil: new Date(Date.now() + 60 * 60_000),
      } as any)
      .returning({ id: commsLinkPreviews.id });
    const lpUnit = unit("comms_link_previews_stale");
    await deleteOneBatch(lpUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("comms_link_previews", "id", [lpEligible.id])) === 0,
      "stale link-preview row (cached_until ancient) deleted",
    );
    assert(
      (await countByIds("comms_link_previews", "id", [lpSurvivor.id])) === 1,
      "live link-preview row survives",
    );

    // ── Shared FK parents for the semrush + booking units (Task #4339) ──
    const [clientRow] = await db
      .insert(clients)
      .values({ firmName: `firm-${TAG}` } as any)
      .returning({ id: clients.id });
    const [locationRow] = await db
      .insert(clientLocations)
      .values({ clientId: clientRow.id, name: `loc-${TAG}` } as any)
      .returning({ id: clientLocations.id });

    // ── semrush_location_sync_attempts old (Task #4339) ──
    const [syncStateRow] = await db
      .insert(semrushLocationSyncState)
      .values({
        clientId: clientRow.id,
        locationId: locationRow.id,
        campaignId: `camp-${TAG}`,
      } as any)
      .returning({ id: semrushLocationSyncState.id });
    const attemptBase = {
      syncStateId: syncStateRow.id,
      clientId: clientRow.id,
      locationId: locationRow.id,
      campaignId: `camp-${TAG}`,
      runId: `run-${TAG}`,
      attemptNumber: 1,
      phase: "complete",
      status: "succeeded",
    };
    const [slaEligible] = await db
      .insert(semrushLocationSyncAttempts)
      .values({ ...attemptBase, createdAt: ANCIENT } as any)
      .returning({ id: semrushLocationSyncAttempts.id });
    const [slaSurvivor] = await db
      .insert(semrushLocationSyncAttempts)
      .values({ ...attemptBase, attemptNumber: 2, createdAt: new Date() } as any)
      .returning({ id: semrushLocationSyncAttempts.id });
    const slaUnit = unit("semrush_location_sync_attempts_old");
    await deleteOneBatch(slaUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("semrush_location_sync_attempts", "id", [slaEligible.id])) === 0,
      "ancient semrush sync attempt deleted",
    );
    assert(
      (await countByIds("semrush_location_sync_attempts", "id", [slaSurvivor.id])) === 1,
      "recent semrush sync attempt survives",
    );

    // ── booking_client_tokens expired (Task #4339) ──
    const [userRow] = await db
      .insert(users)
      .values({ email: `am-${TAG}@example.test` } as any)
      .returning({ id: users.id });
    const [pageRow] = await db
      .insert(bookingPages)
      .values({ accountManagerUserId: userRow.id, slug: `pg-${TAG}` } as any)
      .returning({ id: bookingPages.id });
    const tokenBase = {
      clientId: clientRow.id,
      accountManagerUserId: userRow.id,
      bookingPageId: pageRow.id,
    };
    const [tokExpired] = await db
      .insert(bookingClientTokens)
      .values({ ...tokenBase, tokenHash: `th-${TAG}-old`, expiresAt: ANCIENT } as any)
      .returning({ id: bookingClientTokens.id });
    const [tokUsedExpired] = await db
      .insert(bookingClientTokens)
      .values({
        ...tokenBase,
        tokenHash: `th-${TAG}-used`,
        expiresAt: ANCIENT,
        usedAt: ANCIENT,
      } as any)
      .returning({ id: bookingClientTokens.id });
    const [tokLive] = await db
      .insert(bookingClientTokens)
      .values({
        ...tokenBase,
        tokenHash: `th-${TAG}-live`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      } as any)
      .returning({ id: bookingClientTokens.id });
    const bctUnit = unit("booking_client_tokens_expired");
    await deleteOneBatch(bctUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("booking_client_tokens", "id", [tokExpired.id, tokUsedExpired.id])) === 0,
      "long-expired tokens (used and unused) deleted",
    );
    assert(
      (await countByIds("booking_client_tokens", "id", [tokLive.id])) === 1,
      "unexpired token survives",
    );

    // ── user_activity_logs old (Task #4392) ──
    const [ualEligible] = await db
      .insert(userActivityLogs)
      .values({ actionType: `act-${TAG}`, timestamp: ANCIENT } as any)
      .returning({ id: userActivityLogs.id });
    const [ualSurvivor] = await db
      .insert(userActivityLogs)
      .values({ actionType: `act-${TAG}`, timestamp: new Date() } as any)
      .returning({ id: userActivityLogs.id });
    const ualUnit = unit("user_activity_logs_old");
    await deleteOneBatch(ualUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("user_activity_logs", "id", [ualEligible.id])) === 0,
      "ancient activity-log row deleted",
    );
    assert(
      (await countByIds("user_activity_logs", "id", [ualSurvivor.id])) === 1,
      "recent activity-log row survives",
    );

    // ── client_file_share_links dead (Task #4392) ──
    const [fileRow] = await db
      .insert(clientFiles)
      .values({
        clientId: clientRow.id,
        name: `file-${TAG}`,
        objectKey: `client-files/${clientRow.id}/${TAG}`,
      } as any)
      .returning({ id: clientFiles.id });
    const shareBase = { clientId: clientRow.id, fileId: fileRow.id };
    const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    const [shlExpired] = await db
      .insert(clientFileShareLinks)
      .values({ ...shareBase, tokenHash: `sh-${TAG}-exp`, expiresAt: ANCIENT } as any)
      .returning({ id: clientFileShareLinks.id });
    const [shlRevokedEarly] = await db
      .insert(clientFileShareLinks)
      .values({
        // Revoked ancient but expiry far future → dead at revoked_at → eligible.
        ...shareBase,
        tokenHash: `sh-${TAG}-rev`,
        expiresAt: FUTURE,
        revokedAt: ANCIENT,
      } as any)
      .returning({ id: clientFileShareLinks.id });
    const [shlActive] = await db
      .insert(clientFileShareLinks)
      .values({ ...shareBase, tokenHash: `sh-${TAG}-live`, expiresAt: FUTURE } as any)
      .returning({ id: clientFileShareLinks.id });
    const [shlRecentlyDead] = await db
      .insert(clientFileShareLinks)
      .values({
        // Expired just now → dead but inside the retention window → survives.
        ...shareBase,
        tokenHash: `sh-${TAG}-fresh-dead`,
        expiresAt: new Date(Date.now() - 60_000),
      } as any)
      .returning({ id: clientFileShareLinks.id });
    const shlUnit = unit("client_file_share_links_dead");
    await deleteOneBatch(shlUnit, { retentionDays: HUGE_RETENTION_DAYS, batchLimit: 10_000 });
    assert(
      (await countByIds("client_file_share_links", "id", [shlExpired.id, shlRevokedEarly.id])) === 0,
      "long-dead share links (expired and early-revoked) deleted",
    );
    assert(
      (await countByIds("client_file_share_links", "id", [shlActive.id, shlRecentlyDead.id])) === 2,
      "active and recently-dead share links survive",
    );

    // ── settings plumbing ──
    // Default when the setting row is absent (key namespaced per-run would
    // never exist) → declared default.
    for (const u of PRUNE_UNITS) {
      if (u.retentionSettingKey === null) continue;
      const days = await readUnitRetentionDays(u);
      assert(
        typeof days === "number" && days! > 0,
        `readUnitRetentionDays(${u.key}) resolves a positive window`,
      );
    }
    assert(
      Object.values(RETENTION_SETTING_KEYS).length === 10,
      "ten tunable retention settings declared",
    );

    // ── gating: pruneTick is a no-op while disabled ──
    const prevEnabled = await storage.getSystemSetting(TABLE_RETENTION_PRUNER_ENABLED_KEY);
    try {
      await storage.setSystemSetting(TABLE_RETENTION_PRUNER_ENABLED_KEY, "false", "test");
      const tickResults = await __test.pruneTick();
      assert(tickResults.length === 0, "pruneTick returns [] while the enable setting is false");
    } finally {
      if (prevEnabled) {
        await storage.setSystemSetting(
          TABLE_RETENTION_PRUNER_ENABLED_KEY,
          prevEnabled.value,
          "test",
        );
      } else {
        const { deleteSystemSetting } = await import("../server/storage/settingsStorage");
        await deleteSystemSetting(TABLE_RETENTION_PRUNER_ENABLED_KEY);
      }
    }

    console.log("table-retention-pruner.test.ts: ALL PASSED");
  } finally {
    // Cleanup any leftovers regardless of assertion outcomes.
    await getDb().execute(sql`DELETE FROM work_queue WHERE queue_name = ${`q-${TAG}`}`);
    await getDb().execute(sql`DELETE FROM source_event_log WHERE dedupe_key IN (${`dk-${TAG}`}, ${`dk2-${TAG}`})`);
    await getDb().execute(sql`DELETE FROM call_analysis_jobs WHERE external_id = ${`ext-${TAG}`}`);
    await getDb().execute(sql`DELETE FROM mcu_cache WHERE cache_type = ${`t-${TAG}`}`);
    await getDb().execute(sql`DELETE FROM table_size_samples WHERE table_name = ${`t-${TAG}`}`);
    await getDb().execute(
      sql`DELETE FROM comms_link_previews WHERE url LIKE ${`https://example.test/${TAG}/%`}`,
    );
    // client_locations has a plain (non-cascading) FK to clients, so delete
    // locations first (cascades semrush sync state/attempts), then the
    // client (cascades booking_client_tokens), then the user (cascades
    // booking_pages).
    await getDb().execute(sql`DELETE FROM user_activity_logs WHERE action_type = ${`act-${TAG}`}`);
    await getDb().execute(
      sql`DELETE FROM client_locations WHERE client_id IN (SELECT id FROM clients WHERE firm_name = ${`firm-${TAG}`})`,
    );
    await getDb().execute(sql`DELETE FROM clients WHERE firm_name = ${`firm-${TAG}`}`);
    await getDb().execute(sql`DELETE FROM users WHERE email = ${`am-${TAG}@example.test`}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("table-retention-pruner.test.ts FAILED:", err);
    process.exit(1);
  });
