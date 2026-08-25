/* test-registration
{
  "name": "Alert resend canonical path (Task #794)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #794 — Regression coverage for the canonical alert resend path.
 *
 * Every threshold-alert resend trigger (per-row retry, bulk retry, and the
 * background auto-retry pass) flows through `retryNotificationById`. This
 * test pins the contract that path provides:
 *
 *   1. Per-row retry stamps `attemptNumber = max(chain) + 1` and sets
 *      `parentNotificationId` to the chain root. The retry is also
 *      attributed to the supplied trigger (`source` / `actorId`).
 *   2. The maxAttempts cap blocks any further attempts in the same chain
 *      and does NOT insert a new history row.
 *   3. Bulk retry only picks up failed rows whose filters match.
 *   4. Auto-retry skips a chain when:
 *      a) the latest attempt has already succeeded;
 *      b) the latest attempt's number is >= configured `maxAttempts`;
 *      c) the latest attempt happened less than `minIntervalMinutes` ago.
 *
 * The test uses `channel="email"` rows so the resend path goes through
 * `sendEmail` → `isMailerConfigured()` (false in this environment, since
 * SENDGRID_API_KEY is not set) and exits via the "skipped" branch. That
 * still records a fully-shaped history row — which is what we're
 * verifying — without any external network calls or dispatcher
 * side-effects.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureRateLimitAlertNotificationsTable,
  insertRateLimitAlertNotification,
  getMaxAttemptForChain,
  listFailedNotificationsForRetry,
} from "../server/storage/rateLimitAlertNotificationsStorage";
import {
  retryNotificationById,
  bulkRetryFailedNotifications,
  runAutoRetryPass,
  setAutoRetryConfig,
  loadAutoRetryConfig,
  type TriggerSource,
} from "../server/services/rateLimitAlertNotifier";
import { storage } from "../server/storage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `arc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TAG_OTHER = `${TAG}-other`;
const DEST = `qa+${TAG}@example.invalid`;
const DEST_OTHER = `qa+${TAG}-other@example.invalid`;

// Guarantee the email path takes the "skipped: not configured" branch.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_FROM_EMAIL;
delete process.env.ALERT_FROM_EMAIL;

function rowsFromExec<T extends Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: unknown[] }).rows)) {
    return (res as { rows: T[] }).rows;
  }
  return [];
}

interface ChainRowSql {
  id: string;
  parent_notification_id: string | null;
  attempt_number: number | string;
  status: string;
  trigger_source: string;
  trigger_actor_id: string | null;
}

interface ChainRow {
  id: string;
  parent: string | null;
  attempt: number;
  status: string;
  triggerSource: string;
  triggerActorId: string | null;
}

async function clearTagged(): Promise<void> {
  await db.execute(
    sql`DELETE FROM rate_limit_alert_notifications WHERE category IN (${TAG}, ${TAG_OTHER})`,
  );
}

async function countByCategoryAndDest(category: string, destination: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM rate_limit_alert_notifications
    WHERE category = ${category} AND destination = ${destination}
  `);
  return Number(rowsFromExec<{ c: number | string }>(res)[0]?.c ?? 0);
}

async function rowsByCategoryAndDest(
  category: string,
  destination: string,
): Promise<ChainRow[]> {
  const res = await db.execute(sql`
    SELECT id, parent_notification_id, attempt_number, status, trigger_source, trigger_actor_id
    FROM rate_limit_alert_notifications
    WHERE category = ${category} AND destination = ${destination}
    ORDER BY attempt_number ASC, attempted_at ASC
  `);
  return rowsFromExec<ChainRowSql>(res).map((r) => ({
    id: String(r.id),
    parent: r.parent_notification_id ? String(r.parent_notification_id) : null,
    attempt: Number(r.attempt_number),
    status: String(r.status),
    triggerSource: String(r.trigger_source),
    triggerActorId: r.trigger_actor_id ? String(r.trigger_actor_id) : null,
  }));
}

async function seedRow(opts: {
  category: string;
  destination: string;
  status: "failed" | "sent";
  attemptNumber?: number;
  parentNotificationId?: string | null;
  attemptedAt?: number;
  triggerSource?: TriggerSource;
}): Promise<string> {
  const attemptedAt = opts.attemptedAt ?? Date.now();
  const row = await insertRateLimitAlertNotification({
    channel: "email",
    destination: opts.destination,
    status: opts.status,
    errorMessage: opts.status === "failed" ? "seeded failure" : null,
    userId: `${TAG}-user`,
    userLabel: `${TAG} user`,
    category: opts.category,
    count: 100,
    maxRequests: 100,
    warningPercent: 80,
    windowMs: 60_000,
    windowStart: attemptedAt - 60_000,
    triggeredAt: attemptedAt,
    attemptedAt,
    alert: {
      userId: `${TAG}-user`,
      category: opts.category,
      count: 100,
      max: 100,
      warningPercent: 80,
      windowStart: attemptedAt - 60_000,
      windowMs: 60_000,
      triggeredAt: attemptedAt,
    },
    triggerSource: opts.triggerSource ?? "scheduled",
    triggerActorId: null,
    attemptNumber: opts.attemptNumber ?? 1,
    parentNotificationId: opts.parentNotificationId ?? null,
  });
  return row.id;
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await clearTagged();

  // Snapshot & temporarily override the auto-retry config so the test is
  // hermetic regardless of what's persisted in `system_settings`.
  const previousAutoRetry = await storage.getSystemSetting("rate_limit_alert_auto_retry");
  await setAutoRetryConfig(
    { enabled: true, maxAttempts: 3, minIntervalMinutes: 5, lookbackHours: 24 },
    "system",
  );
  // Confirm the override took effect (also primes the in-process cache).
  const cfg = await loadAutoRetryConfig(true);
  assert(cfg.maxAttempts === 3, `auto-retry maxAttempts override failed: ${cfg.maxAttempts}`);
  assert(cfg.minIntervalMinutes === 5, "minIntervalMinutes override failed");

  try {
    // ── (1) Per-row retry stamps the chain correctly ────────────────────
    const rootId = await seedRow({
      category: TAG,
      destination: DEST,
      status: "failed",
      attemptNumber: 1,
      parentNotificationId: null,
      // 30 minutes ago — well outside `minIntervalMinutes`.
      attemptedAt: Date.now() - 30 * 60_000,
    });

    const out1 = await retryNotificationById(
      rootId,
      { source: "manual", actorId: "test-admin" },
      { maxAttempts: 3 },
    );
    assert(out1.rootId === rootId, `rootId should equal seed id, got ${out1.rootId}`);
    assert(out1.attemptNumber === 2, `attemptNumber should be 2, got ${out1.attemptNumber}`);
    // sendEmail goes through the "no SENDGRID config" branch, so the
    // outcome is `skipped`. Either way a row is recorded — that's what
    // the canonical resend path guarantees.
    assert(
      out1.status === "skipped" || out1.status === "failed",
      `expected skipped/failed without mailer config, got ${out1.status}`,
    );

    let chainRows = await rowsByCategoryAndDest(TAG, DEST);
    assert(chainRows.length === 2, `should have seed + 1 retry row, got ${chainRows.length}`);
    const retryRow = chainRows.find((r) => r.attempt === 2);
    assert(retryRow, "retry row with attempt=2 missing");
    assert(retryRow!.parent === rootId, `parent should be rootId, got ${retryRow!.parent}`);
    assert(
      retryRow!.triggerSource === "manual",
      `trigger_source should propagate, got ${retryRow!.triggerSource}`,
    );
    assert(
      retryRow!.triggerActorId === "test-admin",
      `actor id should propagate, got ${retryRow!.triggerActorId}`,
    );
    const chainMax = await getMaxAttemptForChain(rootId, DEST);
    assert(chainMax === 2, `getMaxAttemptForChain should be 2, got ${chainMax}`);

    // A second per-row retry with the chain already at attempt 2 and
    // cap=3 lands attempt 3.
    const out2 = await retryNotificationById(
      rootId,
      { source: "retry", actorId: null },
      { maxAttempts: 3 },
    );
    assert(out2.attemptNumber === 3, `second retry should be attempt 3, got ${out2.attemptNumber}`);
    assert((await getMaxAttemptForChain(rootId, DEST)) === 3, "chain max should now be 3");

    // ── (2) maxAttempts cap blocks further retries (no new row) ─────────
    const beforeCount = await countByCategoryAndDest(TAG, DEST);
    const blocked = await retryNotificationById(
      rootId,
      { source: "retry", actorId: null },
      { maxAttempts: 3 },
    );
    assert(blocked.status === "blocked", `cap should block, got ${blocked.status}`);
    assert(
      blocked.reason === "max_attempts",
      `block reason should be max_attempts, got ${blocked.reason}`,
    );
    const afterCount = await countByCategoryAndDest(TAG, DEST);
    assert(
      afterCount === beforeCount,
      `blocked retry should NOT insert a new row (before=${beforeCount}, after=${afterCount})`,
    );

    // ── (3) Bulk retry only picks up failed rows that match filters ─────
    // Reset chain state for a focused bulk-retry assertion: drop the
    // existing TAG rows and seed two roots — one matching the filter,
    // one not.
    await clearTagged();
    const matchRoot = await seedRow({
      category: TAG,
      destination: DEST,
      status: "failed",
      attemptedAt: Date.now() - 30 * 60_000,
    });
    const otherRoot = await seedRow({
      category: TAG_OTHER,
      destination: DEST_OTHER,
      status: "failed",
      attemptedAt: Date.now() - 30 * 60_000,
    });
    // Also seed a `sent` row in the matching category to confirm bulk
    // retry filters by status as well.
    await seedRow({
      category: TAG,
      destination: DEST,
      status: "sent",
      attemptNumber: 2,
      parentNotificationId: matchRoot,
      attemptedAt: Date.now() - 25 * 60_000,
    });

    // Sanity: storage helper should hand us only the failed root for TAG.
    const failedForTag = await listFailedNotificationsForRetry({ category: TAG }, 50);
    const tagOnly = failedForTag.filter((r) => r.category === TAG);
    assert(tagOnly.length === 1, `expected 1 failed TAG candidate, got ${tagOnly.length}`);
    assert(tagOnly[0].id === matchRoot, "failed candidate id mismatch");

    const bulk = await bulkRetryFailedNotifications(
      { category: TAG },
      { source: "manual", actorId: "bulk-admin" },
    );
    assert(
      bulk.attempted === 1,
      `bulk should only attempt the matching row, got ${bulk.attempted}`,
    );
    assert(bulk.outcomes[0].rootId === matchRoot, "bulk should resend the matching root");
    // TAG_OTHER chain must remain untouched.
    const otherRows = await rowsByCategoryAndDest(TAG_OTHER, DEST_OTHER);
    assert(otherRows.length === 1, `TAG_OTHER chain should be untouched, got ${otherRows.length}`);

    // ── (4) Auto-retry dedupe paths ─────────────────────────────────────
    await clearTagged();

    // (4a) latest attempt already succeeded → skip.
    const sentRoot = await seedRow({
      category: TAG,
      destination: DEST,
      status: "failed",
      attemptedAt: Date.now() - 60 * 60_000,
    });
    await seedRow({
      category: TAG,
      destination: DEST,
      status: "sent",
      attemptNumber: 2,
      parentNotificationId: sentRoot,
      attemptedAt: Date.now() - 30 * 60_000,
    });

    // (4b) latest attempt at cap → skip.
    const capRoot = await seedRow({
      category: TAG,
      destination: DEST_OTHER,
      status: "failed",
      attemptedAt: Date.now() - 60 * 60_000,
    });
    await seedRow({
      category: TAG,
      destination: DEST_OTHER,
      status: "failed",
      attemptNumber: 3, // == configured cap
      parentNotificationId: capRoot,
      attemptedAt: Date.now() - 30 * 60_000,
    });

    // (4c) latest attempt within minInterval → skip. minInterval is 5
    // min; seed a brand-new failed row whose `attempted_at` is within
    // that window. listFailedRetryCandidates uses `attempted_at <= now -
    // minAge` to prefilter, so we instead seed an OLD root + a recent
    // failed retry child to trigger the in-service min-interval skip.
    const recentRoot = await seedRow({
      category: TAG_OTHER,
      destination: DEST,
      status: "failed",
      // Outside minInterval so the candidate is included…
      attemptedAt: Date.now() - 60 * 60_000,
    });
    await seedRow({
      category: TAG_OTHER,
      destination: DEST,
      status: "failed",
      // …but the latest-by-chain row is < minInterval, so the in-service
      // check skips it.
      attemptNumber: 2,
      parentNotificationId: recentRoot,
      attemptedAt: Date.now() - 60_000,
    });

    const beforePass = {
      sentRoot: await countByCategoryAndDest(TAG, DEST),
      capRoot: await countByCategoryAndDest(TAG, DEST_OTHER),
      recentRoot: await countByCategoryAndDest(TAG_OTHER, DEST),
    };
    const pass = await runAutoRetryPass(null);

    // The pass may scan rows beyond our test fixtures (the table is
    // shared). What we're pinning is: none of OUR three chains gets a
    // new attempt row written.
    const afterPass = {
      sentRoot: await countByCategoryAndDest(TAG, DEST),
      capRoot: await countByCategoryAndDest(TAG, DEST_OTHER),
      recentRoot: await countByCategoryAndDest(TAG_OTHER, DEST),
    };
    assert(
      afterPass.sentRoot === beforePass.sentRoot,
      `auto-retry should skip already-sent chain (before=${beforePass.sentRoot}, after=${afterPass.sentRoot})`,
    );
    assert(
      afterPass.capRoot === beforePass.capRoot,
      `auto-retry should skip at-cap chain (before=${beforePass.capRoot}, after=${afterPass.capRoot})`,
    );
    assert(
      afterPass.recentRoot === beforePass.recentRoot,
      `auto-retry should skip recently-attempted chain (before=${beforePass.recentRoot}, after=${afterPass.recentRoot})`,
    );
    // And the pass must have observed those skips.
    assert(
      pass.skipped >= 3,
      `auto-retry pass should report >=3 skips for our fixtures, got ${pass.skipped}`,
    );

    // (4d) Eligible chain → auto-retry inserts an attempt with
    // trigger_source="auto_retry" and parent set to the root.
    const eligibleRoot = await seedRow({
      category: TAG,
      destination: `${DEST}.eligible`,
      status: "failed",
      // Far enough in the past to clear minInterval.
      attemptedAt: Date.now() - 60 * 60_000,
    });
    const passEligible = await runAutoRetryPass(null);
    assert(passEligible.retried >= 1, `eligible chain should be retried, got ${passEligible.retried}`);
    const eligibleRows = await rowsByCategoryAndDest(TAG, `${DEST}.eligible`);
    const autoRow = eligibleRows.find((r) => r.attempt === 2);
    assert(autoRow, "auto-retry row with attempt=2 should exist");
    assert(
      autoRow!.parent === eligibleRoot,
      `auto-retry row parent should be root, got ${autoRow!.parent}`,
    );
    assert(
      autoRow!.triggerSource === "auto_retry",
      `auto-retry row trigger_source should be 'auto_retry', got ${autoRow!.triggerSource}`,
    );

    console.log("alert-resend-canonical-path: PASSED");
  } finally {
    await clearTagged().catch(() => undefined);
    // Restore the previous auto-retry setting so this test doesn't
    // leak config state to whoever runs after it.
    if (previousAutoRetry?.value) {
      await storage
        .setSystemSetting("rate_limit_alert_auto_retry", previousAutoRetry.value, "test")
        .catch(() => undefined);
    } else {
      await storage
        .setSystemSetting("rate_limit_alert_auto_retry", "", "test")
        .catch(() => undefined);
    }
    // Force the in-process cache to reload from the restored row.
    await loadAutoRetryConfig(true).catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch(async (err) => {
    console.error("alert-resend-canonical-path: FAILED", err);
    await clearTagged().catch(() => undefined);
    process.exitCode = 1;
  });
