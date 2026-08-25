/* test-registration
{
  "name": "Competitor standing derivation — averageRank-only ordering, null-rank drops, subject/size gates, masked-name pass-through (Task #4717)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4717: sub-second pure unit suite (no DB, no DOM, no network). The Marketing slide's standing line is the client deck's only competitive frame and its honesty contract lives in this helper: position and name ordering must come from averageRank alone — the metric that reconciles with the map — never the served SoV-ordered rank field or shareOfVoice, whose misleading framing is exactly why Task #4280 killed the leaderboard. Also locks the omit-rather-than-lie gates (null/non-finite/non-positive ranks dropped, missing subject or <3 ranked firms → null) so sparse or legacy snapshots can never render a fabricated standing.",
  "tier": "small"
}
test-registration */
/**
 * Task #4717 — unit contracts for deriveCompetitorStanding.
 *
 * The helper turns ONE per-keyword snapshot's competitor rows into the
 * Marketing slide's standing line ("You rank #2 of 14 firms detected in
 * this market — top competitors: …"). Contracts:
 *
 *  - ORDER BY averageRank ONLY. Fixtures deliberately order the served
 *    `rank` field (SoV-ordered) and shareOfVoice AGAINST averageRank; the
 *    derived position and topCompetitors must follow averageRank.
 *  - Rows without a usable rank are dropped entirely (not counted, not
 *    named). Explicitly includes averageRank: null — Number(null) === 0
 *    would otherwise coerce null into "better than everyone".
 *  - Missing subject row → null. Fewer than 3 ranked firms → null.
 *  - Ties share a position (competition ranking, strictly-lower count).
 *  - Masked names ("Competitor A"…, "Confidential Client") pass through
 *    untouched; duplicate names dedupe case-insensitively; unnamed rows
 *    count toward totalFirms but are never listed.
 *
 * Hermetic: pure function, no DB, no DOM, no network.
 */

import assert from "node:assert/strict";
import { deriveCompetitorStanding } from "../../client/src/pages/publicReport/competitorStanding";

type Row = { rank?: number; name?: unknown; shareOfVoice?: number; averageRank?: unknown; isSubjectBusiness?: unknown };

const row = (name: string, averageRank: unknown, isSubjectBusiness = false, extra: Partial<Row> = {}): Row => ({
  name,
  averageRank,
  isSubjectBusiness,
  ...extra,
});

// ---------------------------------------------------------------------------
// 1) averageRank-only ordering: served rank field + SoV order CONTRADICT
//    averageRank order; the standing must follow averageRank.
// ---------------------------------------------------------------------------
{
  const standing = deriveCompetitorStanding([
    // rank/shareOfVoice say this firm is #1; averageRank says it's mid-pack.
    row("Big Spender Law", 3.1, false, { rank: 1, shareOfVoice: 48 }),
    row("Subject Firm", 2.4, true, { rank: 2, shareOfVoice: 22 }),
    row("Quiet Winner Legal", 1.8, false, { rank: 3, shareOfVoice: 9 }),
    row("Fourth Firm", 4.0, false, { rank: 4, shareOfVoice: 5 }),
  ]);
  assert.ok(standing, "populated snapshot derives a standing");
  assert.equal(standing.position, 2, "position counts strictly-better averageRank rows only (1.8 < 2.4)");
  assert.equal(standing.totalFirms, 4, "all usable-rank rows count");
  assert.deepEqual(
    standing.topCompetitors,
    ["Quiet Winner Legal", "Big Spender Law", "Fourth Firm"],
    "competitor names ordered by averageRank, NOT by served rank/shareOfVoice",
  );
}

// ---------------------------------------------------------------------------
// 2) Unusable ranks dropped entirely — including the Number(null) === 0 trap,
//    non-numeric strings, non-positive values, and booleans.
// ---------------------------------------------------------------------------
{
  const standing = deriveCompetitorStanding([
    row("Subject Firm", 2.0, true),
    row("Solid Rival", 1.5),
    row("Third Firm", 5.0),
    row("Null Rank", null), // Number(null) === 0 — must NOT become "rank 0"
    row("Undefined Rank", undefined),
    row("NaN String", "n/a"),
    row("Empty String", ""),
    row("Zero Rank", 0), // outside the 1-based rank domain
    row("Negative", -3),
    row("Boolean", true), // Number(true) === 1 — type garbage, not a rank
    row("Infinity", Infinity),
  ]);
  assert.ok(standing, "usable rows still derive a standing");
  assert.equal(standing.totalFirms, 3, "dropped rows are not counted");
  assert.equal(standing.position, 2, "dropped rows never affect position (no phantom rank-0 winners)");
  assert.deepEqual(standing.topCompetitors, ["Solid Rival", "Third Firm"], "dropped rows are never named");
}

// ---------------------------------------------------------------------------
// 3) Subject gates: no subject row → null; subject with unusable rank → null;
//    multiple subject rows (defensive) → best rank wins.
// ---------------------------------------------------------------------------
{
  assert.equal(
    deriveCompetitorStanding([row("A", 1.0), row("B", 2.0), row("C", 3.0)]),
    null,
    "no subject row → null (no fabricated standing)",
  );
  assert.equal(
    deriveCompetitorStanding([row("Subject", null, true), row("A", 1.0), row("B", 2.0), row("C", 3.0)]),
    null,
    "subject present but unrankable → null",
  );
  const multi = deriveCompetitorStanding([
    row("Subject Downtown", 4.0, true),
    row("Subject Uptown", 1.2, true),
    row("A", 2.0),
    row("B", 3.0),
  ]);
  assert.ok(multi, "multiple subject rows still derive");
  assert.equal(multi.position, 1, "best subject rank wins (1.2 beats 2.0/3.0)");
  assert.equal(multi.totalFirms, 4, "both subject rows count as detected firms");
}

// ---------------------------------------------------------------------------
// 4) Size floor: <3 ranked firms → null; exactly 3 → derives. Unusable rows
//    do not count toward the floor.
// ---------------------------------------------------------------------------
{
  assert.equal(
    deriveCompetitorStanding([row("Subject", 1.0, true), row("Only Rival", 2.0)]),
    null,
    "2 ranked firms is trivially small → null",
  );
  assert.equal(
    deriveCompetitorStanding([row("Subject", 1.0, true), row("Rival", 2.0), row("Null", null)]),
    null,
    "a null-rank row cannot satisfy the size floor",
  );
  const atFloor = deriveCompetitorStanding([row("Subject", 1.0, true), row("A", 2.0), row("B", 3.0)]);
  assert.ok(atFloor, "exactly 3 ranked firms derives");
  assert.equal(atFloor.position, 1);
  assert.equal(atFloor.totalFirms, 3);
}

// ---------------------------------------------------------------------------
// 5) Empty/absent input → null (legacy snapshots without competitor rows).
// ---------------------------------------------------------------------------
{
  assert.equal(deriveCompetitorStanding(undefined), null, "undefined rows → null");
  assert.equal(deriveCompetitorStanding(null), null, "null rows → null");
  assert.equal(deriveCompetitorStanding([]), null, "empty rows → null");
}

// ---------------------------------------------------------------------------
// 6) Ties share a position (competition ranking).
// ---------------------------------------------------------------------------
{
  const tied = deriveCompetitorStanding([
    row("Subject", 2.0, true),
    row("Tied Rival", 2.0),
    row("Leader", 1.0),
    row("Trailer", 9.9),
  ]);
  assert.ok(tied);
  assert.equal(tied.position, 2, "tie with a rival shares position #2 (only the leader is strictly better)");
  assert.equal(tied.totalFirms, 4);
}

// ---------------------------------------------------------------------------
// 7) String coercion: numeric DB columns can serialize ranks as strings.
// ---------------------------------------------------------------------------
{
  const coerced = deriveCompetitorStanding([
    row("Subject", "2.4", true),
    row("A", "1.8"),
    row("B", "3.1"),
  ]);
  assert.ok(coerced, "string averageRank values coerce");
  assert.equal(coerced.position, 2);
  assert.deepEqual(coerced.topCompetitors, ["A", "B"]);
}

// ---------------------------------------------------------------------------
// 8) Names: masked pass-through, case-insensitive dedupe, cap at 3, unnamed
//    rows counted but never listed, stable served order on rank ties.
// ---------------------------------------------------------------------------
{
  const masked = deriveCompetitorStanding([
    row("Competitor A", 1.5, false),
    row("Confidential Client", 2.2, true),
    row("Competitor B", 3.7, false),
  ]);
  assert.ok(masked);
  assert.equal(masked.position, 2);
  assert.deepEqual(
    masked.topCompetitors,
    ["Competitor A", "Competitor B"],
    "server-masked names pass through exactly as served",
  );

  const deduped = deriveCompetitorStanding([
    row("Subject", 3.0, true),
    row("Smith & Jones", 1.0),
    row("SMITH & JONES", 1.5), // same firm, second listing — dedupe, keep best-rank spelling
    row("Baker Law", 2.0),
    row("Chavez Legal", 2.5),
    row("Overflow Firm", 2.8), // 4th unique name — capped out
    row("   ", 1.1), // unnamed (whitespace) — counts, never listed
  ]);
  assert.ok(deduped);
  assert.equal(deduped.totalFirms, 7, "duplicate-name and unnamed rows still count as detected listings");
  assert.deepEqual(
    deduped.topCompetitors,
    ["Smith & Jones", "Baker Law", "Chavez Legal"],
    "case-insensitive dedupe + cap at 3 + unnamed rows never listed",
  );

  const tiedNames = deriveCompetitorStanding([
    row("Subject", 5.0, true),
    row("Served First", 2.0),
    row("Served Second", 2.0),
    row("Filler", 4.0),
  ]);
  assert.ok(tiedNames);
  assert.deepEqual(
    tiedNames.topCompetitors,
    ["Served First", "Served Second", "Filler"],
    "rank ties keep served order (stable sort)",
  );
}

console.log("competitor-standing: PASSED");
