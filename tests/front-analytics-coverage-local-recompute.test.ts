/* test-registration
{
  "name": "Front Analytics local-only count refresh for finalized months (Task #2145)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2145 — local-only count recompute for finalized historical months.
 * Task #2518 — migrated to run inside `runInIsolatedSchema` so the whole
 * backfill family is coverable with deterministic, ISOLATED assertions.
 *
 * `recomputeLocalCountsAllMonths` now resolves its DB handle via `getDb()`
 * (like its sibling `recomputeAllMonths`), so wrapping the test in an
 * isolated schema redirects every read/write — the function's own select,
 * the count helpers, and `upsertMonthRow` — to a fresh, empty schema. That
 * lets us assert ABSOLUTE counts (`attempted` / `changed`) directly instead
 * of the old `onlyMonths` scoping hack that worked around shared-dev-DB rows.
 *
 * Verifies `recomputeLocalCountsAllMonths()`:
 *   1. Recomputes a finalized month's cached `fetched` / `applied` (and
 *      per-direction local) counts from the now-complete local mirror
 *      (front_sync_emails / raw_communication_records), keeping the
 *      existing Front-side denominator untouched.
 *   2. Makes ZERO Front API calls (no setPullOverride needed — if it
 *      pulled, the absence of a real Front client would surface).
 *   3. Is idempotent: a second run reports 0 changed.
 *   4. Skips the current (non-finalized) month.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  frontAnalyticsMonthlyCoverage,
  frontSyncEmails,
  rawCommunicationRecords,
} from "@shared/schema";
import {
  recomputeLocalCountsAllMonths,
  currentMonthLabel,
} from "../server/services/frontAnalyticsCoverage";
import { runInIsolatedSchema } from "./db-sandbox";

const TAG = "task2145-local-recompute";
const FY = 2998;
const M1 = `${FY}-01`; // finalized, stale → should refresh
const M2 = `${FY}-02`; // finalized, already-correct → no change
const CUR = currentMonthLabel(); // current month → must be skipped

type IsoDb = Parameters<
  Parameters<typeof runInIsolatedSchema>[0]
>[0]["db"];

function monthBounds(label: string): { start: Date; end: Date } {
  const [y, m] = label.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return { start, end };
}

async function seedCoverageRow(
  iso: IsoDb,
  opts: {
    month: string;
    isFinalized: boolean;
    fetched: number;
    applied: number;
    frontTotal: number;
    inboundFront?: number | null;
    inboundLocal?: number | null;
    outboundLocal?: number | null;
  },
): Promise<void> {
  const { start, end } = monthBounds(opts.month);
  await iso
    .insert(frontAnalyticsMonthlyCoverage)
    .values({
      month: opts.month,
      monthStart: start,
      monthEnd: end,
      frontTotalMessages: opts.frontTotal,
      fetchedIntoNobull: opts.fetched,
      appliedIntoNobull: opts.applied,
      ingestGap: Math.max(0, opts.frontTotal - opts.fetched),
      applyGap: Math.max(0, opts.fetched - opts.applied),
      fetchedCoveragePct: 0,
      appliedCoveragePct: 0,
      isFinalizedMonth: opts.isFinalized,
      unrecoverable: false,
      denominatorUnit: "conversations_all",
      numeratorUnit: "conversations_all",
      messagesInboundFront: opts.inboundFront ?? null,
      messagesInboundLocal: opts.inboundLocal ?? null,
      messagesOutboundLocal: opts.outboundLocal ?? null,
      pulledAt: new Date("2026-05-20T00:00:00Z"),
    })
    .onConflictDoNothing();
}

async function seedFetched(
  iso: IsoDb,
  month: string,
  n: number,
): Promise<void> {
  const { start } = monthBounds(month);
  const at = new Date(start.getTime() + 24 * 3600_000);
  for (let i = 0; i < n; i++) {
    await iso
      .insert(frontSyncEmails)
      .values({
        conversationId: `${TAG}-${month}-conv-${i}`,
        subject: `${TAG} ${month} ${i}`,
        lastMessageAt: at,
        pipelineState: "applied",
      })
      .onConflictDoNothing();
  }
}

/**
 * Seed `applied` (distinct external_thread_id) + per-direction local
 * counts. We write `inboundN` inbound rows + `outboundN` outbound rows,
 * each with a distinct external_thread_id so the applied count =
 * inboundN + outboundN distinct conversations.
 */
async function seedApplied(
  iso: IsoDb,
  month: string,
  inboundN: number,
  outboundN: number,
): Promise<void> {
  const { start } = monthBounds(month);
  const at = new Date(start.getTime() + 24 * 3600_000);
  let k = 0;
  const mk = (dir: "inbound" | "outbound") => {
    const id = `${TAG}-${month}-thr-${dir}-${k}`;
    k += 1;
    return {
      sourceType: "front_email",
      sourceSubtype: "message",
      title: `${TAG} ${month} ${dir} ${id}`,
      timestamp: at,
      direction: dir,
      externalSourceId: `${id}-msg`,
      externalThreadId: id,
      reviewStatus: "unreviewed" as const,
    };
  };
  for (let i = 0; i < inboundN; i++) {
    await iso
      .insert(rawCommunicationRecords)
      .values(mk("inbound"))
      .onConflictDoNothing();
  }
  for (let i = 0; i < outboundN; i++) {
    await iso
      .insert(rawCommunicationRecords)
      .values(mk("outbound"))
      .onConflictDoNothing();
  }
}

async function getRow(iso: IsoDb, month: string) {
  const [row] = await iso
    .select()
    .from(frontAnalyticsMonthlyCoverage)
    .where(eq(frontAnalyticsMonthlyCoverage.month, month));
  return row;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      // M1: finalized but stale — cached 12/12, live mirror has 100 fetched,
      // applied = 60 inbound + 20 outbound = 80 distinct conversations.
      await seedCoverageRow(iso, {
        month: M1,
        isFinalized: true,
        fetched: 12,
        applied: 12,
        frontTotal: 100,
        inboundFront: 70,
        inboundLocal: 5,
      });
      await seedFetched(iso, M1, 100);
      await seedApplied(iso, M1, 60, 20);

      // M2: finalized and already-correct — mirror exactly matches cache.
      await seedCoverageRow(iso, {
        month: M2,
        isFinalized: true,
        fetched: 3,
        applied: 2,
        frontTotal: 10,
        inboundLocal: 1,
        outboundLocal: 1,
      });
      await seedFetched(iso, M2, 3);
      // 2 distinct conversations (1 inbound + 1 outbound).
      await seedApplied(iso, M2, 1, 1);

      // CUR: current month, NOT finalized — must be skipped even if stale.
      await seedCoverageRow(iso, {
        month: CUR,
        isFinalized: false,
        fetched: 0,
        applied: 0,
        frontTotal: 100,
      });
      await seedFetched(iso, CUR, 50);
      await seedApplied(iso, CUR, 10, 5);

      // ── Dry run: reports the drift without writing ────────────────────
      // The isolated schema holds ONLY our three fixture rows, so the
      // run is unscoped (no `onlyMonths`) and `attempted` is absolute:
      // 2 finalized non-current months (M1, M2); CUR is excluded.
      const dry = await recomputeLocalCountsAllMonths({ dryRun: true });
      assert.equal(
        dry.attempted,
        2,
        "exactly two finalized non-current months attempted (M1, M2)",
      );
      assert.equal(dry.changed, 1, "only M1 drifts in dry-run");
      const dryM1 = dry.results.find((r) => r.month === M1);
      assert(dryM1, "dry-run includes M1");
      assert.equal(dryM1!.changed, true, "M1 flagged changed in dry-run");
      assert.equal(dryM1!.after.fetched, 100, "M1 dry-run live fetched=100");
      assert.equal(dryM1!.after.applied, 80, "M1 dry-run live applied=80");
      assert(
        !dry.results.some((r) => r.month === CUR),
        "current month excluded from recompute",
      );
      // Dry run must NOT have written anything yet.
      const m1BeforeApply = await getRow(iso, M1);
      assert.equal(
        m1BeforeApply.fetchedIntoNobull,
        12,
        "dry-run did not mutate M1",
      );

      // ── Apply: writes the refreshed counts ────────────────────────────
      const applied = await recomputeLocalCountsAllMonths({ dryRun: false });
      assert.equal(applied.attempted, 2, "apply attempts both finalized months");
      assert.equal(applied.changed, 1, "exactly one month (M1) changed");
      const m1 = await getRow(iso, M1);
      assert.equal(m1.fetchedIntoNobull, 100, "M1 fetched refreshed to 100");
      assert.equal(m1.appliedIntoNobull, 80, "M1 applied refreshed to 80");
      assert.equal(
        m1.frontTotalMessages,
        100,
        "M1 Front-side denominator preserved (no re-pull)",
      );
      assert.equal(m1.messagesInboundLocal, 60, "M1 inbound local refreshed");
      assert.equal(m1.messagesOutboundLocal, 20, "M1 outbound local refreshed");
      // Coverage % recomputed from preserved denominator: 100/100 = 100.
      assert.equal(
        m1.fetchedCoveragePct,
        100,
        "M1 fetched coverage % recomputed",
      );

      // M2 unchanged (already correct) and current month untouched.
      const m2 = await getRow(iso, M2);
      assert.equal(m2.fetchedIntoNobull, 3, "M2 unchanged");
      const cur = await getRow(iso, CUR);
      assert.equal(cur.fetchedIntoNobull, 0, "current month skipped");

      // ── Idempotency: a second apply reports 0 changed ─────────────────
      const second = await recomputeLocalCountsAllMonths({ dryRun: false });
      assert.equal(second.attempted, 2, "second run still attempts both months");
      assert.equal(second.changed, 0, "second run is a no-op (idempotent)");
    },
    {
      tables: [
        "front_analytics_monthly_coverage",
        "front_sync_emails",
        "raw_communication_records",
      ],
    },
  );

  console.log("front-analytics-coverage-local-recompute.test.ts: OK");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
