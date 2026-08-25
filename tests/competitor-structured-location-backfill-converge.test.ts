/* test-registration
{
  "name": "Competitor structured-location backfill convergence + fill (Task #2295)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/competitorBackfillSemrushSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
// Convergence regression for the competitor STRUCTURED-location backfill
// (Task #2052). `findStructuredLocationCandidateSnapshots` must EXCLUDE
// competitor rows already stamped with `structuredLocationBackfillAttemptedAt`
// (a successful SEMrush re-fetch that produced no name-match, or a parent
// with no keywordId), and must only consider rows where BOTH
// `competitor_locality` AND `competitor_street` are NULL. Without the
// exclusion those rows stay NULL forever and the
// `backfill_competitor_structured_location` prod-action could never settle
// to "not needed".
//
// It ALSO proves the actual fetch→match→write→stamp path in
// `processStructuredLocationSnapshot` (Task #2295): given a mocked SEMrush
// `getTopCompetitors` response, (a) a name-matched competitor's parsed
// locality/street is WRITTEN to the BOTH-NULL row, and (b) a snapshot whose
// returned competitors don't name-match gets STAMPED
// `structured_location_backfill_attempted_at` (so it converges) with zero
// locality/street values written. The convergence assertions above only
// proved which rows are *selected* as candidates; these prove the rows
// actually get filled, not just queued.
//
// DB-backed; runs inside a rollback sandbox so nothing persists. The SEMrush
// `getTopCompetitors` call is redirected to an in-memory stub by the resolve
// hook in `tests/helpers/competitorBackfillSemrushLoader.mjs`, registered via
// `--import ./tests/helpers/competitorBackfillSemrushSetup.mjs` (see the
// run-all.ts entry). The breaker defaults to closed (allowed) in this fresh
// child process, so no breaker mock is needed.
// Usage: tsx --import ./tests/helpers/competitorBackfillSemrushSetup.mjs \
//          tests/competitor-structured-location-backfill-converge.test.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { heatmapSnapshots, heatmapCompetitorSnapshots } from "@shared/schema";
import {
  findStructuredLocationCandidateSnapshots,
  loadSnapshotParents,
  processStructuredLocationSnapshot,
} from "../server/services/competitorStructuredLocationBackfill";
import { BACKFILL_TRANSIENT_RETRY_BUDGET } from "../server/services/competitorLocationBackfill";
// Same singleton the resolve hook redirects production code to, so setting
// the impl here is observed by `fetchTopCompetitorsForBackfill`.
import {
  __setGetTopCompetitors,
  __resetGetTopCompetitors,
  // Re-exported from the REAL semrushApi by the stub, so it is the exact
  // class `fetchTopCompetitorsForBackfill` uses for its `instanceof` check.
  SemrushRateLimitError,
} from "./helpers/competitorBackfillSemrushStub.mjs";

async function seedSnapshot(suffix: string): Promise<string> {
  const [row] = await getDb()
    .insert(heatmapSnapshots)
    .values({
      locationId: `loc-${suffix}`,
      locationName: `Location ${suffix}`,
      campaignId: `camp-${suffix}`,
      keywordId: `kw-${suffix}`,
      keywordName: `keyword ${suffix}`,
      reportDate: new Date(),
      businessLat: 41.8,
      businessLng: -87.6,
      gridTemplate: "5x5",
      gridUnit: "mi",
      gridDistance: 1,
      baseLat: 41.8,
      baseLng: -87.6,
      rawPayload: {},
    })
    .returning({ id: heatmapSnapshots.id });
  return row.id;
}

async function seedCompetitor(
  snapshotId: string,
  opts: {
    locality: string | null;
    street: string | null;
    attemptedAt: Date | null;
    name?: string;
  },
): Promise<string> {
  const [row] = await getDb()
    .insert(heatmapCompetitorSnapshots)
    .values({
      snapshotId,
      campaignId: "camp",
      keyword: "keyword",
      scanDate: new Date(),
      competitorName: opts.name ?? "Some Competitor",
      competitorLocality: opts.locality,
      competitorStreet: opts.street,
      structuredLocationBackfillAttemptedAt: opts.attemptedAt,
    })
    .returning({ id: heatmapCompetitorSnapshots.id });
  return row.id;
}

async function readCompetitor(id: string): Promise<{
  locality: string | null;
  street: string | null;
  attemptedAt: Date | null;
}> {
  const [row] = await getDb()
    .select({
      locality: heatmapCompetitorSnapshots.competitorLocality,
      street: heatmapCompetitorSnapshots.competitorStreet,
      attemptedAt: heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt,
    })
    .from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.id, id));
  return row;
}

async function main(): Promise<void> {
  await runInTxSandbox(async () => {
    // (A) BOTH NULL, never attempted → a candidate.
    const sFresh = await seedSnapshot("fresh");
    await seedCompetitor(sFresh, { locality: null, street: null, attemptedAt: null });

    // (B) BOTH NULL, already attempted → excluded (proven unfillable).
    const sAttempted = await seedSnapshot("attempted");
    await seedCompetitor(sAttempted, {
      locality: null,
      street: null,
      attemptedAt: new Date(),
    });

    // (C) locality already present → not BOTH-NULL, never a candidate.
    const sLocality = await seedSnapshot("locality");
    await seedCompetitor(sLocality, {
      locality: "Chicago",
      street: null,
      attemptedAt: null,
    });

    // (D) street already present → not BOTH-NULL, never a candidate.
    const sStreet = await seedSnapshot("street");
    await seedCompetitor(sStreet, {
      locality: null,
      street: "123 Main St",
      attemptedAt: null,
    });

    const candidates = await findStructuredLocationCandidateSnapshots(getDb(), {
      sinceDays: 365,
    });
    const ids = new Set(candidates.map((c) => c.snapshotId));

    assert.equal(ids.has(sFresh), true, "un-attempted BOTH-NULL snapshot is a candidate");
    assert.equal(
      ids.has(sAttempted),
      false,
      "attempted-stamped BOTH-NULL snapshot is excluded (convergence)",
    );
    assert.equal(
      ids.has(sLocality),
      false,
      "snapshot with a filled locality is not a candidate",
    );
    assert.equal(
      ids.has(sStreet),
      false,
      "snapshot with a filled street is not a candidate",
    );
  });

  // ── Task #2295: the actual fetch→match→write→stamp path ──────────────
  // (E) Name-matched competitor → parsed locality/street are WRITTEN to the
  //     BOTH-NULL row (not just queued).
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => [
      {
        name: "Acme Law Firm",
        address: "123 Main St, Chicago, IL 60601, USA",
        shareOfVoice: 0,
        isSubjectBusiness: false,
      },
    ]);
    try {
      const snapshotId = await seedSnapshot("fill-match");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        {
          db: getDb(),
          caller: "test-fill-match",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "done", "name-matched run completes");
      if (result.kind === "done") {
        assert.equal(result.updates.length, 1, "exactly one row is updated");
        assert.equal(result.updates[0].locality, "Chicago", "parsed locality on the update");
        assert.equal(result.updates[0].street, "123 Main St", "parsed street on the update");
      }

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, "Chicago", "locality is PERSISTED to the row");
      assert.equal(row.street, "123 Main St", "street is PERSISTED to the row");
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (F) No name-match → row stays BOTH-NULL but is STAMPED attempted so it
  //     converges and stops being re-counted; zero locality/street written.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => [
      {
        name: "Totally Different Competitor",
        address: "456 Oak Ave, Springfield, IL 62701, USA",
        shareOfVoice: 0,
        isSubjectBusiness: false,
      },
    ]);
    try {
      const snapshotId = await seedSnapshot("fill-nomatch");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        {
          db: getDb(),
          caller: "test-fill-nomatch",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "done", "no-match run still completes (successful fetch)");
      if (result.kind === "done") {
        assert.equal(result.updates.length, 0, "no rows updated when nothing name-matches");
      }

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, null, "locality stays NULL with no name-match");
      assert.equal(row.street, null, "street stays NULL with no name-match");
      assert.notEqual(
        row.attemptedAt,
        null,
        "row is STAMPED attempted so it converges (stops being re-counted)",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // ── Task #2376: a TRANSIENT SEMrush failure must NOT stamp the row ──
  // A temporary outage (rate-limit, generic fetch error, breaker open) is
  // recoverable, so processStructuredLocationSnapshot must leave the row
  // BOTH-NULL *and* unstamped so it stays a candidate for the next press /
  // self-heal tick. If it ever stamped on a transient failure, one brief
  // SEMrush hiccup would permanently exclude a recoverable row.

  // (G) Rate-limit (transient) → `rate_limited`, row stays BOTH-NULL, NOT
  //     stamped.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new SemrushRateLimitError("429 Too Many Requests");
    });
    try {
      const snapshotId = await seedSnapshot("transient-ratelimit");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        {
          db: getDb(),
          caller: "test-transient-ratelimit",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "rate_limited", "rate-limit surfaces as transient");

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, null, "locality stays NULL on a transient failure");
      assert.equal(row.street, null, "street stays NULL on a transient failure");
      assert.equal(
        row.attemptedAt,
        null,
        "row is NOT stamped on a transient failure, so it stays a candidate",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (H) Generic fetch error (transient) → `fetch_failed`, row stays
  //     BOTH-NULL, NOT stamped.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    try {
      const snapshotId = await seedSnapshot("transient-fetcherr");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        {
          db: getDb(),
          caller: "test-transient-fetcherr",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "fetch_failed", "generic fetch error is transient");

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, null, "locality stays NULL on a transient failure");
      assert.equal(row.street, null, "street stays NULL on a transient failure");
      assert.equal(
        row.attemptedAt,
        null,
        "row is NOT stamped on a generic fetch error, so it stays a candidate",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // ── Task #2434: bounded transient-retry budget → terminal convergence ──
  // Mirror of the GBP-URL backfill convergence. A campaign that keeps failing
  // TRANSIENTLY must not be re-counted forever: each campaign-specific
  // transient failure bumps the row's retry budget; the row is only STAMPED
  // (terminal) once the budget is exhausted. A campaign PROVEN GONE is stamped
  // at once without spending the budget.

  // (I) A single transient failure below the budget BUMPS the retry count but
  //     does NOT stamp — the row is still a candidate for the next tick.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    try {
      const snapshotId = await seedSnapshot("budget-below");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        { db: getDb(), caller: "test-budget-below", getReportDates: async () => null, apply: true },
        parent,
      );
      assert.equal(result.kind, "fetch_failed", "transient failure surfaces");

      const [row] = await getDb()
        .select({
          attemptedAt: heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt,
          retry: heatmapCompetitorSnapshots.structuredLocationBackfillRetryCount,
        })
        .from(heatmapCompetitorSnapshots)
        .where(eq(heatmapCompetitorSnapshots.id, competitorId));
      assert.equal(row.retry, 1, "transient failure bumps the retry budget by one");
      assert.equal(row.attemptedAt, null, "below budget the row is NOT stamped (still a candidate)");
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (J) The transient failure that EXHAUSTS the budget STAMPS the row so the
  //     prod-action converges (stops re-counting it).
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    try {
      const snapshotId = await seedSnapshot("budget-exhaust");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      // Pre-load the row to one short of the budget so this failure exhausts it.
      await getDb()
        .update(heatmapCompetitorSnapshots)
        .set({ structuredLocationBackfillRetryCount: BACKFILL_TRANSIENT_RETRY_BUDGET - 1 })
        .where(eq(heatmapCompetitorSnapshots.id, competitorId));
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        { db: getDb(), caller: "test-budget-exhaust", getReportDates: async () => null, apply: true },
        parent,
      );
      assert.equal(result.kind, "fetch_failed", "transient failure surfaces");

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, null, "still no locality (the fetch failed)");
      assert.equal(row.street, null, "still no street (the fetch failed)");
      assert.notEqual(
        row.attemptedAt,
        null,
        "exhausting the transient-retry budget STAMPS the row (terminal convergence)",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (K) A campaign PROVEN GONE (isCampaignResolvable → false) is stamped at
  //     once on a transient failure, WITHOUT spending the retry budget.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    try {
      const snapshotId = await seedSnapshot("proven-gone");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: null,
        street: null,
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processStructuredLocationSnapshot(
        {
          db: getDb(),
          caller: "test-proven-gone",
          getReportDates: async () => null,
          apply: true,
          isCampaignResolvable: async () => false,
        },
        parent,
      );
      assert.equal(result.kind, "fetch_failed", "transient failure surfaces");

      const [row] = await getDb()
        .select({
          attemptedAt: heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt,
          retry: heatmapCompetitorSnapshots.structuredLocationBackfillRetryCount,
        })
        .from(heatmapCompetitorSnapshots)
        .where(eq(heatmapCompetitorSnapshots.id, competitorId));
      assert.notEqual(
        row.attemptedAt,
        null,
        "a campaign proven gone is STAMPED at once (terminal convergence)",
      );
      assert.equal(row.retry, 0, "a proven-gone campaign does NOT spend the retry budget");
    } finally {
      __resetGetTopCompetitors();
    }
  });

  console.log("competitor structured-location backfill convergence + fill: all assertions passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
