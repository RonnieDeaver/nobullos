/* test-registration
{
  "name": "Competitor locality-relabel backfill convergence + re-correction (Task #2357)",
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
// Convergence + re-correction regression for the competitor locality-RELABEL
// backfill (Task #2357). Unlike the structured-location backfill (Task #2052),
// which only writes when BOTH `competitor_locality` AND `competitor_street` are
// NULL, this backfill RE-CORRECTS an already-NON-NULL `competitor_locality`
// that an OLD address parse (before the Task #2291 Australian / Irish-Eircode /
// Dutch postal rules) wrongly stored as a region/postal token (e.g. "NSW 2000",
// an Eircode) instead of the real city.
//
// This proves:
//   (A) candidate selection: a row whose stored locality is a region/postal
//       token IS a candidate; a correctly-parsed city is NOT; an already
//       relabel-stamped suspect is excluded (convergence).
//   (B) the fetch→match→re-parse→write→stamp path: given a mocked SEMrush
//       `getTopCompetitors` whose `address` re-parses (under the CURRENT
//       parseCompetitorAddress) to NO locality, the suspect row's wrong
//       "NSW 2000" locality is OVERWRITTEN to NULL and the row is stamped.
//   (C) no name-match: a suspect row whose competitors don't name-match is
//       LEFT unchanged in value but STAMPED attempted so it converges.
//
// DB-backed; runs inside a rollback sandbox so nothing persists. The SEMrush
// `getTopCompetitors` call is redirected to an in-memory stub by the resolve
// hook in `tests/helpers/competitorBackfillSemrushLoader.mjs`, registered via
// `--import ./tests/helpers/competitorBackfillSemrushSetup.mjs` (see the
// run-all.ts entry). The breaker defaults to closed (allowed) in this fresh
// child process, so no breaker mock is needed.
// Usage: tsx --import ./tests/helpers/competitorBackfillSemrushSetup.mjs \
//          tests/competitor-locality-relabel-backfill.test.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { heatmapSnapshots, heatmapCompetitorSnapshots } from "@shared/schema";
import {
  findLocalityRelabelCandidateSnapshots,
  loadSnapshotParents,
  processLocalityRelabelSnapshot,
} from "../server/services/competitorLocalityRelabelBackfill";
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
      competitorLocalityRelabelAttemptedAt: opts.attemptedAt,
    })
    .returning({ id: heatmapCompetitorSnapshots.id });
  return row.id;
}

async function readCompetitor(id: string): Promise<{
  locality: string | null;
  attemptedAt: Date | null;
}> {
  const [row] = await getDb()
    .select({
      locality: heatmapCompetitorSnapshots.competitorLocality,
      attemptedAt: heatmapCompetitorSnapshots.competitorLocalityRelabelAttemptedAt,
    })
    .from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.id, id));
  return row;
}

async function main(): Promise<void> {
  // (A) candidate selection.
  await runInTxSandbox(async () => {
    // Suspect: stored locality is an AU region+postal token, never attempted.
    const sSuspect = await seedSnapshot("suspect");
    await seedCompetitor(sSuspect, { locality: "NSW 2000", attemptedAt: null });

    // Suspect but already relabel-stamped → excluded (convergence).
    const sStamped = await seedSnapshot("stamped");
    await seedCompetitor(sStamped, {
      locality: "NSW 2000",
      attemptedAt: new Date(),
    });

    // Correctly-parsed city → never a candidate (not a region/postal token).
    const sCity = await seedSnapshot("city");
    await seedCompetitor(sCity, { locality: "Chicago", attemptedAt: null });

    // NULL locality → handled by the #2052 structured backfill, not this one.
    const sNull = await seedSnapshot("null");
    await seedCompetitor(sNull, { locality: null, attemptedAt: null });

    const candidates = await findLocalityRelabelCandidateSnapshots(getDb(), {
      sinceDays: 365,
    });
    const ids = new Set(candidates.map((c) => c.snapshotId));

    assert.equal(ids.has(sSuspect), true, "un-attempted suspect locality is a candidate");
    assert.equal(
      ids.has(sStamped),
      false,
      "relabel-stamped suspect is excluded (convergence)",
    );
    assert.equal(ids.has(sCity), false, "a correctly-parsed city is not a candidate");
    assert.equal(ids.has(sNull), false, "a NULL locality is not a relabel candidate");
  });

  // (B) re-correction: a mislabeled "NSW 2000" locality is OVERWRITTEN to NULL
  //     because the re-parse (current rules) yields no locality, and the row
  //     is STAMPED attempted.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => [
      {
        // Under the current parser this Australian address parses to street
        // "1 George St" with NO locality (NSW + postal are recognized as a
        // region/postal token, not the city).
        name: "Acme Law Firm",
        address: "1 George St, NSW 2000, Australia",
        shareOfVoice: 0,
        isSubjectBusiness: false,
      },
    ]);
    try {
      const snapshotId = await seedSnapshot("fix-match");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: "NSW 2000",
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processLocalityRelabelSnapshot(
        {
          db: getDb(),
          caller: "test-fix-match",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "done", "name-matched run completes");
      if (result.kind === "done") {
        assert.equal(result.updates.length, 1, "exactly one row is re-corrected");
        assert.equal(result.updates[0].oldLocality, "NSW 2000", "old mislabel captured");
        assert.equal(
          result.updates[0].newLocality,
          null,
          "re-parse yields NULL — the token was never a real city",
        );
      }

      const row = await readCompetitor(competitorId);
      assert.equal(row.locality, null, "wrong locality is OVERWRITTEN to NULL");
      assert.notEqual(row.attemptedAt, null, "row is STAMPED relabel-attempted");
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (C) no name-match → value left as-is but STAMPED so it converges.
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
      const snapshotId = await seedSnapshot("fix-nomatch");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: "NSW 2000",
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processLocalityRelabelSnapshot(
        {
          db: getDb(),
          caller: "test-fix-nomatch",
          getReportDates: async () => null,
          apply: true,
        },
        parent,
      );

      assert.equal(result.kind, "done", "no-match run still completes (successful fetch)");
      if (result.kind === "done") {
        assert.equal(result.updates.length, 0, "no rows corrected when nothing name-matches");
      }

      const row = await readCompetitor(competitorId);
      assert.equal(
        row.locality,
        "NSW 2000",
        "value left unchanged when there is no SEMrush name-match",
      );
      assert.notEqual(
        row.attemptedAt,
        null,
        "row is STAMPED attempted so it converges (stops being re-counted)",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // ── Task #2395: a TRANSIENT SEMrush failure must NOT stamp the suspect ──
  // A temporary outage (rate-limit, generic fetch error, breaker open) is
  // recoverable, so processLocalityRelabelSnapshot must leave the mislabeled
  // locality UNCHANGED *and* the row UN-stamped so it stays a candidate for the
  // next press / self-heal tick. If it ever stamped on a transient failure, one
  // brief SEMrush hiccup would permanently exclude a recoverable suspect and its
  // wrong "NSW 2000"-style locality would never be re-corrected.

  // (D) Rate-limit (transient) → `rate_limited`, suspect locality unchanged,
  //     NOT stamped.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new SemrushRateLimitError("429 Too Many Requests");
    });
    try {
      const snapshotId = await seedSnapshot("transient-ratelimit");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: "NSW 2000",
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processLocalityRelabelSnapshot(
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
      assert.equal(
        row.locality,
        "NSW 2000",
        "mislabeled locality is left UNCHANGED on a transient failure",
      );
      assert.equal(
        row.attemptedAt,
        null,
        "row is NOT stamped on a transient failure, so it stays a candidate",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  // (E) Generic fetch error (transient) → `fetch_failed`, suspect locality
  //     unchanged, NOT stamped.
  await runInTxSandbox(async () => {
    __setGetTopCompetitors(async () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    try {
      const snapshotId = await seedSnapshot("transient-fetcherr");
      const competitorId = await seedCompetitor(snapshotId, {
        locality: "NSW 2000",
        attemptedAt: null,
        name: "Acme Law Firm",
      });
      const parents = await loadSnapshotParents(getDb(), [snapshotId]);
      const parent = parents.get(snapshotId)!;

      const result = await processLocalityRelabelSnapshot(
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
      assert.equal(
        row.locality,
        "NSW 2000",
        "mislabeled locality is left UNCHANGED on a transient failure",
      );
      assert.equal(
        row.attemptedAt,
        null,
        "row is NOT stamped on a generic fetch error, so it stays a candidate",
      );
    } finally {
      __resetGetTopCompetitors();
    }
  });

  console.log("competitor locality-relabel backfill convergence + re-correction: all assertions passed");
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
