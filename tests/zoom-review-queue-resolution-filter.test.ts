/* test-registration
{
  "name": "Zoom review-queue resolution-type filter (Task #734 / #1204)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Integration test for `/api/admin/zoom/review-queue?reviewResolution=...`
 * (Task #734, locked-in by Task #1204).
 *
 * Pins the four-way resolution-type queue filter:
 *
 *   1. ?reviewResolution=approved     → only reviewResolution='approved'
 *   2. ?reviewResolution=reassigned   → only reviewResolution='reassigned'
 *   3. ?reviewResolution=dismissed    → only reviewResolution='dismissed'
 *   4. ?reviewResolution=reopened     → only rows with reopenCount > 0 (and
 *      reviewResolution IS NULL — re-opening clears the resolution)
 *
 * Also pins two subtle implications:
 *
 *   - Setting reviewResolution=approved implies includeResolved (resolved
 *     rows come back even when the includeResolved switch is off).
 *   - The "reopened" branch matches reopenCount > 0 even though
 *     reviewResolution is NULL (it does NOT use the reviewResolution column).
 */

import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "node:net";
import { sql, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { agentMatchDecisions, clients } from "@shared/schema";
import { registerAgentRoutes } from "../server/routes/agents";

// Ensure the Clerk per-request test seam is honored (requireAuth reads
// __test_clerkUserId only when NODE_ENV === "test") for bare repros.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

let failed = 0;
let passed = 0;
let server: import("node:http").Server | null = null;
let baseUrl = "";
let testUserId = "";
const createdClientIds: string[] = [];

const TAG = `zrq-resfilter-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
  const [c] = await db.insert(clients).values({ firmName: `RQ ResFilter ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  return c.id;
}

interface SeedRow {
  clientId: string;
  commSuffix: string;
  reviewResolution: "approved" | "reassigned" | "dismissed" | null;
  reopenCount?: number;
  dismissReason?: string | null;
}

async function seedDecision(row: SeedRow): Promise<void> {
  await db.insert(agentMatchDecisions).values({
    communicationId: `${COMM_PREFIX}${row.commSuffix}`,
    communicationType: "zoom_call",
    sourceType: "zoom",
    clientId: row.clientId,
    confidenceScore: 0.5,
    status: "review_required",
    evidenceType: "structured",
    reviewResolution: row.reviewResolution,
    dismissReason: row.dismissReason ?? null,
    reviewedAt: row.reviewResolution ? new Date() : null,
    reviewedByHuman: !!row.reviewResolution,
    reopenCount: row.reopenCount ?? 0,
  });
}

async function setup(): Promise<void> {
  testUserId = `__probe_zrq_resfilter_${Date.now()}`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (
      ${testUserId},
      ${`probe-zrq-resfilter-${Date.now()}@example.invalid`},
      'Probe', 'ZRQResFilter', 'account_manager', 'core'
    )
  `);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    // (The pre-Clerk passport-shape injection stopped working when auth
    // migrated — requireAuth ignores req.user/req.isAuthenticated.)
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

function commIdsOfOurs(items: any[]): string[] {
  return (items || [])
    .map((it) => it?.decision?.communicationId)
    .filter((cid: string) => typeof cid === "string" && cid.startsWith(COMM_PREFIX));
}

async function main(): Promise<void> {
  await cleanup();
  await setup();

  try {
    const clientId = await seedClient();

    // Seed one row per resolution branch + a baseline unresolved row.
    await seedDecision({ clientId, commSuffix: "approved",   reviewResolution: "approved" });
    await seedDecision({ clientId, commSuffix: "reassigned", reviewResolution: "reassigned" });
    await seedDecision({ clientId, commSuffix: "dismissed",  reviewResolution: "dismissed", dismissReason: "not_relevant" });
    // Re-opened: reviewResolution cleared back to NULL, reopenCount > 0.
    await seedDecision({ clientId, commSuffix: "reopened",   reviewResolution: null, reopenCount: 1 });
    // Plain unresolved (never resolved, never reopened) — must not appear in
    // any of the four resolution-filtered responses.
    await seedDecision({ clientId, commSuffix: "unresolved", reviewResolution: null, reopenCount: 0 });

    const expectFor = {
      approved:   `${COMM_PREFIX}approved`,
      reassigned: `${COMM_PREFIX}reassigned`,
      dismissed:  `${COMM_PREFIX}dismissed`,
      reopened:   `${COMM_PREFIX}reopened`,
    } as const;

    // Bump limit so our seeded rows aren't pushed off the page by unrelated
    // production-shaped fixture data already in the dev DB.
    const LIMIT = 500;

    // ----- (1a) approved -----
    const rApproved = await http(`/api/admin/zoom/review-queue?reviewResolution=approved&limit=${LIMIT}`);
    assert(rApproved.status === 200, `approved request returns 200 (got ${rApproved.status})`);
    const approvedIds = commIdsOfOurs(rApproved.body?.items || []);
    assert(approvedIds.includes(expectFor.approved),
      `approved filter includes our approved row (${expectFor.approved})`);
    assert(!approvedIds.includes(expectFor.reassigned)
        && !approvedIds.includes(expectFor.dismissed)
        && !approvedIds.includes(expectFor.reopened)
        && !approvedIds.includes(`${COMM_PREFIX}unresolved`),
      `approved filter excludes reassigned/dismissed/reopened/unresolved rows (got ${JSON.stringify(approvedIds)})`);
    // Implies includeResolved: this request did NOT pass includeResolved=true,
    // yet the resolved approved row still came back.
    assert(approvedIds.includes(expectFor.approved),
      `?reviewResolution=approved implies includeResolved (resolved row returned without the flag)`);

    // ----- (1b) reassigned -----
    const rReassigned = await http(`/api/admin/zoom/review-queue?reviewResolution=reassigned&limit=${LIMIT}`);
    assert(rReassigned.status === 200, `reassigned request returns 200 (got ${rReassigned.status})`);
    const reassignedIds = commIdsOfOurs(rReassigned.body?.items || []);
    assert(reassignedIds.includes(expectFor.reassigned),
      `reassigned filter includes our reassigned row (${expectFor.reassigned})`);
    assert(!reassignedIds.includes(expectFor.approved)
        && !reassignedIds.includes(expectFor.dismissed)
        && !reassignedIds.includes(expectFor.reopened)
        && !reassignedIds.includes(`${COMM_PREFIX}unresolved`),
      `reassigned filter excludes the other branches (got ${JSON.stringify(reassignedIds)})`);

    // ----- (1c) dismissed -----
    const rDismissed = await http(`/api/admin/zoom/review-queue?reviewResolution=dismissed&limit=${LIMIT}`);
    assert(rDismissed.status === 200, `dismissed request returns 200 (got ${rDismissed.status})`);
    const dismissedIds = commIdsOfOurs(rDismissed.body?.items || []);
    assert(dismissedIds.includes(expectFor.dismissed),
      `dismissed filter includes our dismissed row (${expectFor.dismissed})`);
    assert(!dismissedIds.includes(expectFor.approved)
        && !dismissedIds.includes(expectFor.reassigned)
        && !dismissedIds.includes(expectFor.reopened)
        && !dismissedIds.includes(`${COMM_PREFIX}unresolved`),
      `dismissed filter excludes the other branches (got ${JSON.stringify(dismissedIds)})`);

    // ----- (1d) reopened -----
    // The reopened row has reviewResolution=NULL but reopenCount=1; the filter
    // must still surface it via the reopenCount > 0 branch.
    const rReopened = await http(`/api/admin/zoom/review-queue?reviewResolution=reopened&limit=${LIMIT}`);
    assert(rReopened.status === 200, `reopened request returns 200 (got ${rReopened.status})`);
    const reopenedIds = commIdsOfOurs(rReopened.body?.items || []);
    assert(reopenedIds.includes(expectFor.reopened),
      `reopened filter includes our reopened row (${expectFor.reopened}) even though its reviewResolution is NULL`);
    assert(!reopenedIds.includes(expectFor.approved)
        && !reopenedIds.includes(expectFor.reassigned)
        && !reopenedIds.includes(expectFor.dismissed)
        && !reopenedIds.includes(`${COMM_PREFIX}unresolved`),
      `reopened filter excludes resolved rows and plain unresolved rows (got ${JSON.stringify(reopenedIds)})`);
    // Pin that the matched reopened row really does have reviewResolution=NULL
    // and reopenCount > 0 (i.e. the filter is keying off reopenCount, not the
    // reviewResolution column).
    const reopenedItem = (rReopened.body?.items || []).find(
      (it: any) => it?.decision?.communicationId === expectFor.reopened,
    );
    assert(reopenedItem && reopenedItem.decision.reviewResolution == null,
      `reopened row's reviewResolution is NULL (got ${JSON.stringify(reopenedItem?.decision?.reviewResolution)})`);
    assert(reopenedItem && Number(reopenedItem.decision.reopenCount) > 0,
      `reopened row's reopenCount > 0 (got ${JSON.stringify(reopenedItem?.decision?.reopenCount)})`);

    console.log(`\nzoom-review-queue-resolution-filter: ${passed} passed, ${failed} failed`);
    if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  } finally {
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("zoom-review-queue-resolution-filter: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
