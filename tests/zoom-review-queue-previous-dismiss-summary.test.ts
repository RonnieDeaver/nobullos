/* test-registration
{
  "name": "Zoom review-queue previous dismiss summary (Task #728)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Integration test for `/api/admin/zoom/review-queue` (Task #728).
 *
 * Pins the `previousDismissSummary` wiring added alongside
 * `getZoomDismissReasonSummaryForRange` (Task #613):
 *
 *   1. With `?windowDays=N`, the route returns `previousDismissSummary` from
 *      the equal-length window immediately preceding the current window —
 *      i.e. [now - 2N, now - N) — using `reviewedAt` as the boundary field.
 *   2. Rows reviewed inside the *current* window must NOT contribute to
 *      `previousDismissSummary` (they belong to `dismissSummary` instead).
 *   3. With no `windowDays` query param, `previousDismissSummary` is `null`.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "node:net";
import { sql, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { agentMatchDecisions, clients, users } from "@shared/schema";
import { registerAgentRoutes } from "../server/routes/agents";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let failed = 0;
let passed = 0;
let server: import("node:http").Server | null = null;
let baseUrl = "";
let testUserId = "";
const createdClientIds: string[] = [];

const TAG = `zrq-prev-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const COMM_PREFIX = `comm-${TAG}-`;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function http(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const txt = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  return { status: res.status, body: parsed };
}

async function seedClient(): Promise<string> {
  const [c] = await db.insert(clients).values({ firmName: `RQ Prev ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  return c.id;
}

interface SeedRow {
  clientId: string;
  dismissReason: string | null;
  reviewedAt: Date;
  commSuffix: string;
}

async function seedDismissed(row: SeedRow): Promise<void> {
  await db.insert(agentMatchDecisions).values({
    communicationId: `${COMM_PREFIX}${row.commSuffix}`,
    communicationType: "zoom_call",
    sourceType: "zoom",
    clientId: row.clientId,
    confidenceScore: 0.5,
    status: "review_required",
    evidenceType: "structured",
    reviewResolution: "dismissed",
    dismissReason: row.dismissReason,
    reviewedAt: row.reviewedAt,
    reviewedByHuman: true,
  });
}

async function setup(): Promise<void> {
  testUserId = `__probe_zrq_prev_${Date.now()}`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (
      ${testUserId},
      ${`probe-zrq-prev-${Date.now()}@example.invalid`},
      'Probe', 'ZRQPrev', 'account_manager'
    )
  `);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = testUserId;
    next();
  });
  registerAgentRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function cleanup(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await db.execute(sql`DELETE FROM agent_match_decisions WHERE communication_id LIKE ${`${COMM_PREFIX}%`}`);
  if (createdClientIds.length) {
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
  if (testUserId) {
    await db.execute(sql`DELETE FROM users WHERE id = ${testUserId}`);
  }
}

async function main(): Promise<void> {
  await cleanup();
  await setup();

  try {
    const clientId = await seedClient();

    const HOUR_MS = 60 * 60 * 1000;
    const WINDOW_DAYS = 1; // current = [-24h, now); previous = [-48h, -24h)
    const now = Date.now();

    // PREVIOUS window rows ([-48h, -24h)) — these should appear in
    // previousDismissSummary.
    await seedDismissed({ clientId, dismissReason: "not_relevant", reviewedAt: new Date(now - 36 * HOUR_MS), commSuffix: "prev1" });
    await seedDismissed({ clientId, dismissReason: "not_relevant", reviewedAt: new Date(now - 30 * HOUR_MS), commSuffix: "prev2" });
    await seedDismissed({ clientId, dismissReason: null,           reviewedAt: new Date(now - 40 * HOUR_MS), commSuffix: "prev3-null" });

    // CURRENT window rows ([-24h, now)) — should NOT contribute to
    // previousDismissSummary.
    await seedDismissed({ clientId, dismissReason: "low_quality",  reviewedAt: new Date(now - 6 * HOUR_MS),  commSuffix: "cur1" });

    // Far past (before previous window) — must be ignored entirely.
    await seedDismissed({ clientId, dismissReason: "ancient",       reviewedAt: new Date(now - 96 * HOUR_MS), commSuffix: "ancient" });

    // (1) windowDays=1 → previousDismissSummary populated from [-48h, -24h).
    const r1 = await http(`/api/admin/zoom/review-queue?windowDays=${WINDOW_DAYS}&includeResolved=true`);
    assert(r1.status === 200, `windowed request returns 200 (got ${r1.status})`);
    const prev = r1.body?.previousDismissSummary;
    assert(prev && typeof prev === "object", "previousDismissSummary present when windowDays is set");
    if (prev) {
      assert((prev.byReason?.not_relevant ?? 0) >= 2,
        `previous window includes both prev1+prev2 not_relevant rows (got ${prev.byReason?.not_relevant})`);
      assert((prev.byReason?.unspecified ?? 0) >= 1,
        `NULL reason in previous window rolls into 'unspecified' (got ${prev.byReason?.unspecified})`);
      assert(!("low_quality" in (prev.byReason || {})) || (prev.byReason.low_quality ?? 0) === 0
        || prev.byReason.low_quality === undefined,
        // We didn't seed any low_quality in the previous window, so this
        // bucket — if present at all from other test data — must not include
        // our current-window row. Safer: explicitly guard against the
        // current-window row leaking by checking the row's distinctive reason
        // is excluded below.
        "no current-window leak via low_quality bucket");
      // Distinctive guard: 'ancient' reason from the far-past row must be
      // excluded from the previous window.
      assert(!("ancient" in (prev.byReason || {})),
        `far-past row outside previous window must not appear (got: ${JSON.stringify(prev.byReason)})`);
      // total must equal sum of byReason buckets exactly.
      const sum = Object.values(prev.byReason || {}).reduce((s: number, n: any) => s + Number(n), 0);
      assert(prev.total === sum,
        `previousDismissSummary.total (${prev.total}) equals sum of byReason buckets (${sum})`);
    }

    // (2) Without windowDays → previousDismissSummary is null.
    const r2 = await http(`/api/admin/zoom/review-queue?includeResolved=true`);
    assert(r2.status === 200, `unwindowed request returns 200 (got ${r2.status})`);
    assert(r2.body?.previousDismissSummary === null,
      `previousDismissSummary is null when windowDays is omitted (got ${JSON.stringify(r2.body?.previousDismissSummary)})`);
    assert(r2.body?.windowDays === null,
      `windowDays in response is null when omitted (got ${JSON.stringify(r2.body?.windowDays)})`);

    console.log(`\nzoom-review-queue-previous-dismiss-summary: ${passed} passed, ${failed} failed`);
    if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  } finally {
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("zoom-review-queue-previous-dismiss-summary: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
