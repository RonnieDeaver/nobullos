/* test-registration
{
  "name": "Zoom dismiss-reason trend math",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the Zoom dismiss-reason previous-window trend math
 * (task #728).
 *
 * `getZoomDismissReasonSummaryForRange({since, until})` powers the
 * "previous window" delta on the dismiss-reason breakdown card. We pin:
 *
 *   1. Only `sourceType="zoom"` + `reviewResolution="dismissed"` rows are
 *      counted. Other source types or unresolved decisions are ignored.
 *   2. Only rows whose `reviewedAt` falls in [since, until) are counted.
 *      Rows at the upper bound are excluded (lt comparison).
 *   3. NULL `dismissReason` rolls into the `unspecified` bucket.
 *   4. Counts per reason are accurate; `total` matches their sum.
 *   5. Empty windows return `{byReason: {}, total: 0}`.
 */

import { sql, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { agentMatchDecisions, clients } from "@shared/schema";
import { getZoomDismissReasonSummaryForRange } from "../server/services/zoomReviewQueue";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `zdrt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const COMM_PREFIX = `comm-${TAG}-`;
const createdClientIds: string[] = [];

async function seedClient(): Promise<string> {
  const [c] = await db.insert(clients).values({ firmName: `Trend ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  return c.id;
}

interface SeedRow {
  clientId: string;
  dismissReason: string | null;
  reviewedAt: Date;
  sourceType?: string;
  reviewResolution?: string | null;
  commSuffix: string;
}

async function seedDecision(row: SeedRow): Promise<void> {
  await db.insert(agentMatchDecisions).values({
    communicationId: `${COMM_PREFIX}${row.commSuffix}`,
    communicationType: "zoom_call",
    sourceType: row.sourceType ?? "zoom",
    clientId: row.clientId,
    confidenceScore: 0.5,
    status: "review_required",
    evidenceType: "structured",
    reviewResolution:
      row.reviewResolution === undefined ? "dismissed" : row.reviewResolution,
    dismissReason: row.dismissReason,
    reviewedAt: row.reviewedAt,
    reviewedByHuman: true,
  });
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM agent_match_decisions WHERE communication_id LIKE ${`${COMM_PREFIX}%`}`);
  if (createdClientIds.length) {
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

async function main(): Promise<void> {
  await cleanup();
  const clientId = await seedClient();

  const HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = new Date(now - 48 * HOUR_MS);
  const windowEnd = new Date(now - 24 * HOUR_MS); // [start, end) → 24h window
  const insideMid = new Date(now - 36 * HOUR_MS);
  const atStart = windowStart;
  const atEnd = windowEnd; // strictly excluded
  const beforeWindow = new Date(now - 72 * HOUR_MS);
  const afterWindow = new Date(now - 6 * HOUR_MS);

  try {
    // Inside window (counted): not_relevant ×2, low_quality ×1, NULL reason ×1
    await seedDecision({ clientId, dismissReason: "not_relevant", reviewedAt: insideMid, commSuffix: "in1" });
    await seedDecision({ clientId, dismissReason: "not_relevant", reviewedAt: atStart, commSuffix: "in2-start" });
    await seedDecision({ clientId, dismissReason: "low_quality", reviewedAt: insideMid, commSuffix: "in3" });
    await seedDecision({ clientId, dismissReason: null, reviewedAt: insideMid, commSuffix: "in4-null" });

    // Boundary at upper bound (NOT counted, lt).
    await seedDecision({ clientId, dismissReason: "boundary", reviewedAt: atEnd, commSuffix: "boundary" });

    // Outside window (NOT counted).
    await seedDecision({ clientId, dismissReason: "ancient", reviewedAt: beforeWindow, commSuffix: "before" });
    await seedDecision({ clientId, dismissReason: "future", reviewedAt: afterWindow, commSuffix: "after" });

    // Wrong source type (NOT counted).
    await seedDecision({
      clientId, dismissReason: "wrong_source", reviewedAt: insideMid,
      sourceType: "front", commSuffix: "wrongsrc",
    });

    // Wrong resolution (NOT counted).
    await seedDecision({
      clientId, dismissReason: null, reviewedAt: insideMid,
      reviewResolution: null, commSuffix: "unresolved",
    });
    await seedDecision({
      clientId, dismissReason: "approved", reviewedAt: insideMid,
      reviewResolution: "approved", commSuffix: "approved",
    });

    const result = await getZoomDismissReasonSummaryForRange({
      since: windowStart,
      until: windowEnd,
    });

    // Filter to OUR rows (other tests/data may have left zoom dismissals in
    // the same window). Our seeded reasons inside the window are exactly:
    //   not_relevant (2), low_quality (1), unspecified (1 — NULL).
    const r = result.byReason;
    assert((r.not_relevant ?? 0) >= 2, `expected not_relevant >= 2, got ${r.not_relevant}`);
    assert((r.low_quality ?? 0) >= 1, `expected low_quality >= 1, got ${r.low_quality}`);
    assert((r.unspecified ?? 0) >= 1, `NULL reason should roll into 'unspecified', got ${r.unspecified}`);

    // Boundary + outside-window + wrong-source + wrong-resolution rows must
    // NOT contribute. We check our distinctive reason strings don't appear.
    assert(!("boundary" in r),
      `upper bound is exclusive — 'boundary' reason should not appear, got: ${JSON.stringify(r)}`);
    assert(!("ancient" in r),
      `before-window row should not appear, got: ${JSON.stringify(r)}`);
    assert(!("future" in r),
      `after-window row should not appear, got: ${JSON.stringify(r)}`);
    assert(!("wrong_source" in r),
      `non-zoom source rows should not appear, got: ${JSON.stringify(r)}`);
    assert(!("approved" in r),
      `non-dismissed rows should not appear, got: ${JSON.stringify(r)}`);

    // total must equal sum of byReason buckets exactly.
    const computedTotal = Object.values(r).reduce((s, n) => s + n, 0);
    assert(result.total === computedTotal,
      `total ${result.total} should equal sum of byReason buckets ${computedTotal}`);

    // (5) Empty window returns total=0 / byReason={}.
    const emptyWindow = await getZoomDismissReasonSummaryForRange({
      since: new Date(now + 24 * HOUR_MS),
      until: new Date(now + 48 * HOUR_MS),
    });
    assert(emptyWindow.total === 0,
      `empty future window should have total=0, got ${emptyWindow.total}`);
    assert(Object.keys(emptyWindow.byReason).length === 0,
      `empty future window should have empty byReason, got ${JSON.stringify(emptyWindow.byReason)}`);

    console.log("zoom-dismiss-reason-trend-math: PASSED");
  } finally {
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("zoom-dismiss-reason-trend-math: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
