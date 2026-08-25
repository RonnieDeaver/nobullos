/* test-registration
{
  "name": "Queue-timing throughput DB-side count",
  "scanPaths": [
    "server/routes/integrations/workQueue.ts"
  ],
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for Task #724: throughput numbers on the queue
 * timing-changes view come from a database-side COUNT, not from an
 * in-memory aggregation of every completed work_queue row.
 *
 * The previous implementation pulled all completed rows in the window
 * into Node, sorted them, and ran a binary search per audit entry. Under
 * heavy traffic this was both slow and incorrect (driver/page caps could
 * silently truncate the result set, producing wrong throughput numbers).
 *
 * This test pins the new contract:
 *
 *   1. Functional: seeded work_queue rows around two audit timestamps
 *      produce the expected before/after counts and the expected status
 *      ("ok" / "no_baseline"), and only `completed` rows are counted.
 *      Rows outside both windows are ignored.
 *
 *   2. Status pinning: when the after-window has not yet elapsed, status
 *      is "pending" and `after` is null (we don't lie about a partial
 *      window).
 *
 *   3. Source-shape pin: server/routes/integrations/workQueue.ts no longer contains
 *      the old in-memory aggregation markers (binary search over
 *      `completedTimes`, in-memory `countInRange`). Bringing them back
 *      means re-introducing the heavy-traffic correctness bug.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb, db } from "../server/db";
import { workQueue, queueTimingAudit, users } from "@shared/schema";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  computeThroughputForEntries,
  QUEUE_TIMING_THROUGHPUT_WINDOW_MS,
  QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS,
  resolveThroughputWindowMs,
} from "../server/services/queueTimingThroughput";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const TAG = `t724-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function main(): Promise<void> {
  await runInTxSandbox(async () => {
    const db = getDb();
    const W = QUEUE_TIMING_THROUGHPUT_WINDOW_MS;

    // Anchor "now" well in the past so the after-windows of our two seeded
    // entries have already elapsed (status should be "ok" or "no_baseline",
    // not "pending"). All test timestamps are derived from this anchor.
    const now = new Date(Date.now() - 60 * 60 * 1000);

    // Entry A: timestamp at `now - 30min`. After-window ends at now-20min,
    // which is before `now`, so the after-window has elapsed.
    const tA = new Date(now.getTime() - 30 * 60 * 1000);
    // Entry B: timestamp at `now - 25min`. Used to confirm we don't
    // double-count rows just because windows overlap with entry A.
    const tB = new Date(now.getTime() - 25 * 60 * 1000);

    // Seed completed work_queue rows around tA:
    //   - 2 rows in the BEFORE window (tA - W .. tA)
    //   - 3 rows in the AFTER window (tA .. tA + W)
    //   - 1 row well outside both windows (must be ignored)
    //   - 1 row with status='pending' inside the after window (must be ignored)
    const seedRows: Array<typeof workQueue.$inferInsert> = [];
    const insertAt = (offsetMs: number, status: string): void => {
      const completedAt = status === "completed"
        ? new Date(tA.getTime() + offsetMs)
        : null;
      seedRows.push({
        queueName: `${TAG}-q`,
        jobType: `${TAG}-job`,
        workloadClass: `${TAG}-class`,
        status,
        completedAt,
        // ensure dedupe_key is unique per row
        dedupeKey: null,
      });
    };
    // 2 in before-window
    insertAt(-9 * 60 * 1000, "completed");
    insertAt(-1 * 60 * 1000, "completed");
    // 3 in after-window
    insertAt(1 * 60 * 1000, "completed");
    insertAt(5 * 60 * 1000, "completed");
    insertAt(9 * 60 * 1000, "completed");
    // outside both windows (well before before-window)
    insertAt(-30 * 60 * 1000, "completed");
    // pending row inside after-window — must NOT be counted
    seedRows.push({
      queueName: `${TAG}-q`,
      jobType: `${TAG}-job`,
      workloadClass: `${TAG}-class`,
      status: "pending",
      completedAt: new Date(tA.getTime() + 2 * 60 * 1000),
    });

    // (1) Functional: entry A counts match seeded rows.
    //
    // The `work_queue` table is shared with the rest of the dev/test DB and
    // visible (READ COMMITTED) inside this sandbox tx, so pre-existing
    // committed rows can fall inside our [tA - W, tA + W) window and inflate
    // the absolute counts. To pin the SQL behaviour we're actually
    // exercising — "seeding N rows increases the per-bucket count by exactly
    // N" — capture a baseline BEFORE seeding and assert the delta.
    const entriesAB = [
      { id: "A", changedAt: tA },
      { id: "B", changedAt: tB },
    ];
    const baseline = await computeThroughputForEntries(entriesAB, W, now);
    await db.insert(workQueue).values(seedRows);
    const result = await computeThroughputForEntries(entriesAB, W, now);

    const a = result.get("A");
    const aBase = baseline.get("A");
    const aBeforeDelta = (a?.before ?? 0) - (aBase?.before ?? 0);
    const aAfterDelta = (a?.after ?? 0) - (aBase?.after ?? 0);
    assert(a != null, "entry A returned a throughput result");
    assert(a?.windowMs === W, "windowMs is reported on the result");
    assert(aBeforeDelta === 2, `entry A before count == 2 (got ${aBeforeDelta})`);
    assert(aAfterDelta === 3, `entry A after count == 3 (got ${aAfterDelta})`);
    assert(
      a?.status === "ok",
      `entry A status == "ok" (before>0 and after-window elapsed) — got "${a?.status}"`,
    );

    // (2) Pending: an entry whose after-window has NOT elapsed.
    const tPending = new Date(now.getTime() - (W / 2));
    const pendingResult = await computeThroughputForEntries(
      [{ id: "P", changedAt: tPending }],
      W,
      now,
    );
    const p = pendingResult.get("P");
    assert(p?.status === "pending", `pending entry status == "pending" — got "${p?.status}"`);
    assert(p?.after === null, "pending entry exposes after=null (no partial-window number)");

    // (3) no_baseline: an entry whose before-window has zero completions.
    // Use a timestamp far enough in the past that no real work_queue row
    // could possibly fall in [tEmpty - W, tEmpty + W) — the work_queue
    // table is shared with prod-like dev data so a recent "empty" anchor
    // can't guarantee zero rows. 100 years in the past is safe.
    const tEmpty = new Date(now.getTime() - 100 * 365 * 24 * 60 * 60 * 1000);
    const emptyResult = await computeThroughputForEntries(
      [{ id: "E", changedAt: tEmpty }],
      W,
      now,
    );
    const e = emptyResult.get("E");
    assert(e?.before === 0, "no-baseline entry before == 0");
    assert(
      e?.status === "no_baseline",
      `no-baseline entry status == "no_baseline" — got "${e?.status}"`,
    );
  });

  // (4) Multi-window contract (Task #1194 / Task #723): the aggregator
  //     produces the expected per-window before/after slices for every
  //     value the throughput-window selector exposes (5m / 10m / 30m / 1h).
  //     Seeded rows live at fixed offsets around a single audit timestamp
  //     so each window snaps a different subset.
  await runInTxSandbox(async () => {
    const db = getDb();
    const TAG_W = `t1194-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Anchor "now" 2h in the past so even the 1h after-window has elapsed.
    const now = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const t = new Date(now.getTime() - 60 * 60 * 1000);

    // Offsets in minutes relative to t. Chosen so each allowed window
    // snaps a different known count: ±3m fits in 5m, ±8m additionally
    // fits in 10m, ±25m additionally fits in 30m, ±55m additionally fits
    // in 60m. Symmetric on both sides so before === after per window.
    const beforeOffsetsMin = [-55, -25, -8, -3];
    const afterOffsetsMin = [3, 8, 25, 55];

    const seedRows: Array<typeof workQueue.$inferInsert> = [
      ...beforeOffsetsMin,
      ...afterOffsetsMin,
    ].map((mins) => ({
      queueName: `${TAG_W}-q`,
      jobType: `${TAG_W}-job`,
      workloadClass: `${TAG_W}-class`,
      status: "completed",
      completedAt: new Date(t.getTime() + mins * 60 * 1000),
    }));
    // Plus one well-outside row that must be ignored by every window
    // (1h is the largest allowed window, so 90 min away is safely outside).
    seedRows.push({
      queueName: `${TAG_W}-q`,
      jobType: `${TAG_W}-job`,
      workloadClass: `${TAG_W}-class`,
      status: "completed",
      completedAt: new Date(t.getTime() - 90 * 60 * 1000),
    });

    // Expected per-window count of rows whose offset (in minutes) satisfies
    // |offset| < windowMinutes — i.e. the COUNT(*) FILTER half-open range
    // [t - W, t) for `before` and [t, t + W) for `after`.
    const expectedByWindowMin: Record<number, number> = {
      5: 1,   // ±3
      10: 2,  // ±3, ±8
      30: 3,  // ±3, ±8, ±25
      60: 4,  // ±3, ±8, ±25, ±55
    };

    // Capture a per-window baseline BEFORE seeding so pre-existing
    // committed work_queue rows visible via READ COMMITTED don't pollute
    // the per-window before/after numbers we assert. See scenario (1) for
    // the same isolation concern.
    const baselineByWindow = new Map<number, { before: number; after: number }>();
    for (const windowMs of QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS) {
      const windowMin = windowMs / 60_000;
      const r = await computeThroughputForEntries(
        [{ id: `W-${windowMin}`, changedAt: t }],
        windowMs,
        now,
      );
      const got = r.get(`W-${windowMin}`);
      baselineByWindow.set(windowMs, {
        before: got?.before ?? 0,
        after: got?.after ?? 0,
      });
    }

    await db.insert(workQueue).values(seedRows);

    for (const windowMs of QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS) {
      const windowMin = windowMs / 60_000;
      const expected = expectedByWindowMin[windowMin];
      const r = await computeThroughputForEntries(
        [{ id: `W-${windowMin}`, changedAt: t }],
        windowMs,
        now,
      );
      const got = r.get(`W-${windowMin}`);
      const base = baselineByWindow.get(windowMs)!;
      const beforeDelta = (got?.before ?? 0) - base.before;
      const afterDelta = (got?.after ?? 0) - base.after;
      assert(got != null, `window ${windowMin}m returns a result`);
      assert(
        got?.windowMs === windowMs,
        `window ${windowMin}m result echoes windowMs (got ${got?.windowMs})`,
      );
      assert(
        beforeDelta === expected,
        `window ${windowMin}m before == ${expected} (got ${beforeDelta})`,
      );
      assert(
        afterDelta === expected,
        `window ${windowMin}m after == ${expected} (got ${afterDelta})`,
      );
      assert(
        got?.status === "ok",
        `window ${windowMin}m status == "ok" (got "${got?.status}")`,
      );
    }
  });

  // (5) Endpoint window-clamping contract (Task #1194):
  //     /api/integrations/work-queue/timings/history routes its
  //     `windowMs` query param through resolveThroughputWindowMs, which
  //     must accept only the allow-list values and fall back to the 10m
  //     default for anything else (7m, negative, NaN, undefined, string).
  for (const w of QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS) {
    assert(
      resolveThroughputWindowMs(w) === w,
      `allowed window ${w / 60_000}m passes through resolveThroughputWindowMs`,
    );
    // Also check the string form, since req.query values arrive as strings.
    assert(
      resolveThroughputWindowMs(String(w)) === w,
      `allowed window ${w / 60_000}m (as string) passes through resolveThroughputWindowMs`,
    );
  }
  const D = QUEUE_TIMING_THROUGHPUT_WINDOW_MS;
  const clampCases: Array<[unknown, string]> = [
    [7 * 60 * 1000, "7m (not in allow-list)"],
    [-1, "negative number"],
    [0, "zero"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [undefined, "undefined"],
    [null, "null"],
    ["abc", "non-numeric string"],
    ["", "empty string"],
    [{}, "object"],
  ];
  for (const [input, label] of clampCases) {
    assert(
      resolveThroughputWindowMs(input) === D,
      `resolveThroughputWindowMs clamps ${label} to default 10m (got ${resolveThroughputWindowMs(input)})`,
    );
  }
  // Source-shape pin for the route: it must delegate window resolution to
  // the helper rather than reinventing the allow-list check inline.
  const integrationsSrc = readFileSync("server/routes/integrations/workQueue.ts", "utf8");
  assert(
    integrationsSrc.includes("resolveThroughputWindowMs"),
    "server/routes/integrations/workQueue.ts delegates windowMs clamping to resolveThroughputWindowMs",
  );

  // (6) End-to-end endpoint clamping: the
  //     /api/integrations/work-queue/timings/history HTTP route itself
  //     must round-trip a valid windowMs unchanged AND clamp invalid
  //     values back to the 10m default. This pins the contract at the
  //     true endpoint boundary (route + middleware + JSON shape), not
  //     just at the helper.
  const TAG_HTTP = `t1194-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `${TAG_HTTP}-user`;
  let auditId: string | null = null;
  let server: http.Server | null = null;

  try {
    // Seed an account_manager user so the requireAccountManager middleware
    // accepts the request.
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      firstName: "Throughput",
      lastName: "Probe",
      role: "account_manager",
    } as any);

    // Seed an audit row at a fixed past timestamp, then seed completed
    // work_queue rows in known offsets around it. Two before-window rows
    // (-3m, -8m) and one after-window row (+3m) — both inside the 10m
    // window. The +25m row sits outside 10m but inside 30m, so a buggy
    // route that used the user's raw `windowMs` would surface a different
    // `after` count.
    const now = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const t = new Date(now.getTime() - 60 * 60 * 1000);
    const [auditRow] = await db
      .insert(queueTimingAudit)
      .values({ changedBy: null, oldValues: null, newValues: { tag: TAG_HTTP } as any })
      .returning({ id: queueTimingAudit.id });
    auditId = auditRow.id;
    await db.execute(
      sql`UPDATE queue_timing_audit SET changed_at = ${t} WHERE id = ${auditId}`,
    );
    const wqRows: Array<typeof workQueue.$inferInsert> = [
      { queueName: `${TAG_HTTP}-q`, jobType: `${TAG_HTTP}-job`, workloadClass: `${TAG_HTTP}-class`, status: "completed", completedAt: new Date(t.getTime() - 8 * 60 * 1000) },
      { queueName: `${TAG_HTTP}-q`, jobType: `${TAG_HTTP}-job`, workloadClass: `${TAG_HTTP}-class`, status: "completed", completedAt: new Date(t.getTime() - 3 * 60 * 1000) },
      { queueName: `${TAG_HTTP}-q`, jobType: `${TAG_HTTP}-job`, workloadClass: `${TAG_HTTP}-class`, status: "completed", completedAt: new Date(t.getTime() + 3 * 60 * 1000) },
      { queueName: `${TAG_HTTP}-q`, jobType: `${TAG_HTTP}-job`, workloadClass: `${TAG_HTTP}-class`, status: "completed", completedAt: new Date(t.getTime() + 25 * 60 * 1000) },
    ];

    // Build a minimal app with the integration routes and the Clerk test
    // seam so requireAuth + requireAccountManager resolve the seeded user.
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Clerk test seam (server/middlewares/requireAuth.ts): a string
      // authenticates as that user id (committed public-schema users row).
      (req as any).__test_clerkUserId = userId;
      next();
    });
    registerIntegrationRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function getHistory(qs: string): Promise<{ status: number; entry: any }> {
      const r = await fetch(`${baseUrl}/api/integrations/work-queue/timings/history?limit=50${qs}`);
      const body = await r.json();
      const entry = (body?.history ?? []).find((e: any) => e.id === auditId);
      return { status: r.status, entry };
    }

    // The endpoint counts every completed work_queue row in the window,
    // and the dev DB carries pre-existing committed rows that can fall
    // inside [t - W, t + W). Capture each window's baseline BEFORE
    // seeding our four wqRows so we can assert exact deltas instead of
    // absolute counts.
    const baselineDef = await getHistory("");
    const baseline30 = await getHistory(`&windowMs=${30 * 60 * 1000}`);
    const baseBefore10 = baselineDef.entry?.throughput?.before ?? 0;
    const baseAfter10 = baselineDef.entry?.throughput?.after ?? 0;
    const baseBefore30 = baseline30.entry?.throughput?.before ?? 0;
    const baseAfter30 = baseline30.entry?.throughput?.after ?? 0;

    await db.insert(workQueue).values(wqRows);

    // (a) No windowMs query param → default 10m, +2 before / +1 after vs baseline.
    const def = await getHistory("");
    assert(def.status === 200, `endpoint default: status 200 (got ${def.status})`);
    assert(def.entry != null, "endpoint default: seeded audit row appears in history");
    assert(
      def.entry?.throughput?.windowMs === QUEUE_TIMING_THROUGHPUT_WINDOW_MS,
      `endpoint default: throughput.windowMs == 10m (got ${def.entry?.throughput?.windowMs})`,
    );
    {
      const bd = (def.entry?.throughput?.before ?? 0) - baseBefore10;
      const ad = (def.entry?.throughput?.after ?? 0) - baseAfter10;
      assert(
        bd === 2 && ad === 1,
        `endpoint default: before=2 after=1 (got before=${bd} after=${ad})`,
      );
    }

    // (b) Valid 30m window passes through; +2 before / +2 after vs baseline.
    const valid30 = await getHistory(`&windowMs=${30 * 60 * 1000}`);
    assert(
      valid30.entry?.throughput?.windowMs === 30 * 60 * 1000,
      `endpoint windowMs=30m: passes through (got ${valid30.entry?.throughput?.windowMs})`,
    );
    {
      const bd = (valid30.entry?.throughput?.before ?? 0) - baseBefore30;
      const ad = (valid30.entry?.throughput?.after ?? 0) - baseAfter30;
      assert(
        bd === 2 && ad === 2,
        `endpoint windowMs=30m: before=2 after=2 (got before=${bd} after=${ad})`,
      );
    }

    // (c) Invalid windowMs values clamp to the 10m default. Each must
    //     also yield the 10m before/after deltas (2/1) — proving the
    //     route did not pass the user-supplied number into the SQL.
    const invalidCases: Array<[string, string]> = [
      [`&windowMs=${7 * 60 * 1000}`, "7m (not in allow-list)"],
      [`&windowMs=-1`, "negative"],
      [`&windowMs=NaN`, "NaN"],
      [`&windowMs=abc`, "non-numeric string"],
      [`&windowMs=`, "empty"],
    ];
    for (const [qs, label] of invalidCases) {
      const r = await getHistory(qs);
      assert(r.status === 200, `endpoint invalid ${label}: status 200 (got ${r.status})`);
      assert(
        r.entry?.throughput?.windowMs === QUEUE_TIMING_THROUGHPUT_WINDOW_MS,
        `endpoint invalid ${label}: clamps windowMs to 10m (got ${r.entry?.throughput?.windowMs})`,
      );
      const bd = (r.entry?.throughput?.before ?? 0) - baseBefore10;
      const ad = (r.entry?.throughput?.after ?? 0) - baseAfter10;
      assert(
        bd === 2 && ad === 1,
        `endpoint invalid ${label}: counts match 10m slice (got before=${bd} after=${ad})`,
      );
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    try {
      if (auditId) await db.execute(sql`DELETE FROM queue_timing_audit WHERE id = ${auditId}`);
    } catch { /* tolerate */ }
    try {
      await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${`${TAG_HTTP}-q`}`);
    } catch { /* tolerate */ }
    try {
      await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    } catch { /* tolerate */ }
  }

  // (7) Source-shape pin: the in-memory aggregator is gone for good.
  const src = readFileSync("server/routes/integrations/workQueue.ts", "utf8");
  assert(
    !src.includes("completedTimes"),
    "server/routes/integrations/workQueue.ts no longer references in-memory completedTimes array",
  );
  assert(
    !/binary search/.test(src),
    "server/routes/integrations/workQueue.ts no longer contains the in-memory binary-search aggregator",
  );
  assert(
    src.includes("computeThroughputForEntries"),
    "server/routes/integrations/workQueue.ts delegates to computeThroughputForEntries (DB-side count)",
  );

  if (failed > 0) {
    console.error(`queue-timing-throughput-db-count: FAILED (${failed}/${passed + failed})`);
    process.exitCode = 1;
  }
  console.log(`queue-timing-throughput-db-count: PASSED (${passed} assertions)`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("queue-timing-throughput-db-count: ERROR", err);
  process.exitCode = 1;
});
