/**
 * Task #4717 — honest competitor standing for the Marketing slide's map cards.
 *
 * Task #4280's restructure removed the market-share leaderboard: its
 * share-of-voice % read as a single-digit "market share" right next to a
 * dominant-looking map (the two metrics have different denominators — see
 * .agents/memory/market-share-vs-map-coverage.md). Removing it also removed
 * the deck's only competitive frame. This helper restores that frame from
 * the ONE metric that reconciles with the map by construction: average rank
 * (the leaderboard's averageRank equals the map's avg_rank for the same
 * scan). `shareOfVoice` and the served SoV-ordered `rank` field are
 * deliberately never read — importing either would resurrect the misleading
 * framing #4280 killed.
 *
 * Input = the competitor rows of a SINGLE per-keyword snapshot
 * (`localDominance.keywordSnapshots[].competitors`). Per-keyword snapshots
 * are internally consistent; top-level competitor arrays can mix keywords
 * and must not be passed here.
 *
 * Documented treatments:
 * - Rows without a usable average rank (null, undefined, non-numeric, or
 *   outside the 1-based rank domain) are dropped entirely — not counted in
 *   totalFirms, not named. A firm without an average rank has no honest
 *   place in a ranking BY average rank. Note `Number(null) === 0`: null must
 *   never coerce into "rank 0, better than everyone".
 * - Served numerics may arrive as strings (numeric DB columns serialize as
 *   strings); string ranks are coerced.
 * - `position` uses competition ranking: 1 + count of rows with a STRICTLY
 *   lower average rank. Tie-safe and independent of served row order. With
 *   multiple subject rows (defensive; one snapshot should carry one), the
 *   best subject rank wins.
 * - Fewer than MIN_RANKED_FIRMS usable rows → null. "You rank #1 of 2" is
 *   noise, not a competitive frame; the slide omits the line entirely per
 *   the deck's absent-never-empty convention.
 * - Privacy masking happens server-side (rows arrive as "Competitor A"…);
 *   names pass through untouched. Unnamed rows still count toward
 *   totalFirms (they are detected firms) but are never listed.
 *
 * Leaf module on purpose (no imports): slide components stay hook-free and
 * the derivation stays trivially unit-testable.
 */

export interface CompetitorStandingRow {
  name?: unknown;
  averageRank?: unknown;
  isSubjectBusiness?: unknown;
}

export interface CompetitorStanding {
  /** Subject's 1-based position by average rank (competition ranking). */
  position: number;
  /** Firms with a usable average rank in this snapshot, subject included. */
  totalFirms: number;
  /** Up to 3 non-subject names, best average rank first (masked names pass through). */
  topCompetitors: string[];
}

const MIN_RANKED_FIRMS = 3;
const TOP_COMPETITOR_LIMIT = 3;

/** Finite, positive (1-based rank domain) number or null. Guards the
 * `Number(null) === 0` / `Number("") === 0` coercion traps explicitly. */
function usableRank(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function deriveCompetitorStanding(
  rows: ReadonlyArray<CompetitorStandingRow> | null | undefined,
): CompetitorStanding | null {
  if (!rows || rows.length === 0) return null;

  const ranked: Array<{ name: string; averageRank: number; isSubject: boolean }> = [];
  for (const row of rows) {
    const averageRank = usableRank(row.averageRank);
    if (averageRank === null) continue;
    ranked.push({
      name: typeof row.name === "string" ? row.name.trim() : "",
      averageRank,
      isSubject: row.isSubjectBusiness === true,
    });
  }

  if (ranked.length < MIN_RANKED_FIRMS) return null;

  const subjectRanks = ranked.filter((r) => r.isSubject).map((r) => r.averageRank);
  if (subjectRanks.length === 0) return null;
  const subjectRank = Math.min(...subjectRanks);

  const position = 1 + ranked.filter((r) => r.averageRank < subjectRank).length;

  // Sort is stable (ES2019+), so ties keep served order; dedupe repeated
  // names case-insensitively (multi-listing firms) and skip unnamed rows.
  const seen = new Set<string>();
  const topCompetitors: string[] = [];
  const competitors = ranked
    .filter((r) => !r.isSubject && r.name.length > 0)
    .sort((a, b) => a.averageRank - b.averageRank);
  for (const c of competitors) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topCompetitors.push(c.name);
    if (topCompetitors.length >= TOP_COMPETITOR_LIMIT) break;
  }

  return { position, totalFirms: ranked.length, topCompetitors };
}
