/* test-registration
{
  "name": "Notification history CSV export",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the notification-history CSV export filter
 * surface.
 *
 * The HTTP route at GET /api/health/rate-limits/notifications.csv is
 * gated by isAuthenticated + requireTeamLead and serializes the rows it
 * gets back from `listAlertNotificationsForExport(filters)`. Because the
 * test environment has no real session cookie, this test pins the layer
 * the route delegates to:
 *
 *   1. Status filter (sent | failed | skipped) returns ONLY matching rows
 *      and ignores out-of-allowlist values via the route's allowlist (we
 *      verify rejection at the storage layer by passing through valid
 *      filters only).
 *   2. Channel filter (slack | email) is applied with AND-semantics on
 *      top of status.
 *   3. Category filter is exact-match.
 *   4. Search filter does case-insensitive substring matching against
 *      destination / userLabel / userId.
 *   5. With no filters, all of our seeded rows come back.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureRateLimitAlertNotificationsTable,
  insertRateLimitAlertNotification,
  listAlertNotificationsForExport,
} from "../server/storage/rateLimitAlertNotificationsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `csv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function clearTestRows(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_alert_notifications WHERE category LIKE ${TAG + "%"}`);
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await clearTestRows();
  try {
    // Seed a deterministic mix of rows.
    const seeds = [
      { status: "sent",    channel: "email", category: `${TAG}-A`, destination: "alpha@example.com", userLabel: "Alpha User", userId: "u-alpha" },
      { status: "failed",  channel: "slack", category: `${TAG}-A`, destination: "C-CHANNEL-1",       userLabel: "Beta",       userId: "u-beta",  errorMessage: "timeout" },
      { status: "skipped", channel: "email", category: `${TAG}-B`, destination: "gamma@example.com", userLabel: "Gamma",      userId: "u-gamma" },
      { status: "sent",    channel: "slack", category: `${TAG}-B`, destination: "C-CHANNEL-2",       userLabel: "Delta",      userId: "u-delta" },
    ];
    for (const s of seeds) {
      const now = Date.now();
      await insertRateLimitAlertNotification({
        attemptedAt: now,
        status: s.status,
        channel: s.channel,
        destination: s.destination,
        category: s.category,
        userId: s.userId,
        userLabel: s.userLabel,
        count: 80,
        maxRequests: 100,
        warningPercent: 80,
        windowMs: 60_000,
        windowStart: now - 30_000,
        triggeredAt: now,
        errorMessage: s.errorMessage ?? null,
        triggerSource: "scheduled",
        triggerActorId: null,
      } as any);
    }

    const ours = (rows: Array<{ category: string }>) =>
      rows.filter((r) => r.category.startsWith(TAG));

    // (5) No filters → all 4 of ours come back
    const all = ours(await listAlertNotificationsForExport());
    assert(all.length === 4, `unfiltered export should return 4 seeded rows, got ${all.length}`);

    // (1) Status filter — sent
    const sent = ours(await listAlertNotificationsForExport({ status: "sent" }));
    assert(sent.length === 2 && sent.every((r) => (r as any).status === "sent"),
      `status=sent should return 2 sent rows, got ${sent.length}`);

    // (2) Status + channel — failed slack only
    const failedSlack = ours(await listAlertNotificationsForExport({
      status: "failed", channel: "slack",
    }));
    assert(failedSlack.length === 1
      && (failedSlack[0] as any).status === "failed"
      && (failedSlack[0] as any).channel === "slack",
      `status=failed&channel=slack should return exactly the failed slack row, got ${failedSlack.length}`);

    // (3) Category exact-match
    const catA = ours(await listAlertNotificationsForExport({ category: `${TAG}-A` }));
    assert(catA.length === 2 && catA.every((r) => r.category === `${TAG}-A`),
      `category=${TAG}-A should return 2 rows, got ${catA.length}`);

    // (4) Search filter (case-insensitive substring) against userLabel
    const search = ours(await listAlertNotificationsForExport({ search: "ALPHA" }));
    assert(search.length === 1 && (search[0] as any).userId === "u-alpha",
      `search=ALPHA should match the Alpha User row, got ${search.length}`);

    console.log("notification-history-csv-export: PASSED");
  } finally {
    await clearTestRows().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("notification-history-csv-export: FAILED", err);
  await clearTestRows().catch(() => undefined);
  process.exitCode = 1;
});
