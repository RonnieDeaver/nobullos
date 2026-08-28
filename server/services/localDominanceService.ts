import { db, dbRetry } from "../db";
import {
  heatmapSnapshots, heatmapMetrics, heatmapPoints,
  heatmapCompetitorSnapshots, semrushLocationCampaigns,
  clientLocations,
  type HeatmapSnapshot, type HeatmapMetric,
  type InsertHeatmapCompetitorSnapshot,
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql, isNull, inArray, or } from "drizzle-orm";
import { normalizeKeyword } from "@shared/keywordNormalization";

/**
 * Build a SQL predicate that matches `heatmap_snapshots.keyword_name` against
 * the canonical normalized form of `keyword`, so a single selected keyword pill
 * surfaces EVERY stored spelling variant ("immigration attorney" vs
 * "Immigration Attorney" vs "immigration  attorney"). The normalization here
 * MUST stay aligned with `normalizeKeyword` in shared/keywordNormalization.ts
 * and the write/match path in heatmapService.ts.
 */
export function keywordNameMatchesSql(keyword: string) {
  const normalized = normalizeKeyword(keyword);
  return sql`lower(regexp_replace(trim(${heatmapSnapshots.keywordName}), '\\s+', ' ', 'g')) = ${normalized}`;
}


function computeShareOfVoiceFromPoints(
  points: Array<{ position: number | null | undefined }>
): number {
  if (points.length === 0) return 0;
  const maxScore = 20;
  let totalScore = 0;
  for (const pt of points) {
    if (pt.position && pt.position > 0 && pt.position <= 20) {
      totalScore += (maxScore + 1 - pt.position);
    }
  }
  const maxPossible = points.length * maxScore;
  return Math.round((totalScore / maxPossible) * 10000) / 100;
}

function computeDistributionBands(
  points: Array<{ position: number | null | undefined }>
): { top3: number; band4to10: number; band11to20: number; outOfTop20: number } {
  const total = points.length || 1;
  let top3 = 0, band4to10 = 0, band11to20 = 0, outOfTop20 = 0;
  for (const pt of points) {
    if (!pt.position || pt.position <= 0) {
      outOfTop20++;
    } else if (pt.position <= 3) {
      top3++;
    } else if (pt.position <= 10) {
      band4to10++;
    } else if (pt.position <= 20) {
      band11to20++;
    } else {
      outOfTop20++;
    }
  }
  return {
    top3: Math.round((top3 / total) * 10000) / 100,
    band4to10: Math.round((band4to10 / total) * 10000) / 100,
    band11to20: Math.round((band11to20 / total) * 10000) / 100,
    outOfTop20: Math.round((outOfTop20 / total) * 10000) / 100,
  };
}

export async function computeShareOfVoiceRollingAverage(
  campaignId: string,
  keyword: string,
  asOfDate: Date,
  windowDays: number = 90
): Promise<{ avg: number; dataPoints: number }> {
  const windowStart = new Date(asOfDate.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db.select({
    sov: heatmapSnapshots.shareOfVoiceRaw,
  })
    .from(heatmapSnapshots)
    .where(
      and(
        eq(heatmapSnapshots.campaignId, campaignId),
        keywordNameMatchesSql(keyword),
        gte(heatmapSnapshots.reportDate, windowStart),
        lte(heatmapSnapshots.reportDate, asOfDate),
      )
    )
    .orderBy(desc(heatmapSnapshots.reportDate));

  const values = rows
    .map(r => r.sov)
    .filter((v): v is number => v !== null && v !== undefined);

  if (values.length === 0) return { avg: 0, dataPoints: 0 };

  const sum = values.reduce((s, v) => s + v, 0);
  return {
    avg: Math.round((sum / values.length) * 100) / 100,
    dataPoints: values.length,
  };
}

export async function computeShareOfVoiceAnchorIncrease(
  campaignId: string,
  keyword: string,
  current90dAvg: number,
  asOfDate: Date,
  windowDays: number = 90
): Promise<number | null> {
  const priorEnd = new Date(asOfDate.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const priorStart = new Date(priorEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db.select({
    sov: heatmapSnapshots.shareOfVoiceRaw,
  })
    .from(heatmapSnapshots)
    .where(
      and(
        eq(heatmapSnapshots.campaignId, campaignId),
        keywordNameMatchesSql(keyword),
        gte(heatmapSnapshots.reportDate, priorStart),
        lte(heatmapSnapshots.reportDate, priorEnd),
      )
    );

  const values = rows
    .map(r => r.sov)
    .filter((v): v is number => v !== null && v !== undefined);

  if (values.length === 0) return null;

  const priorAvg = values.reduce((s, v) => s + v, 0) / values.length;
  const delta = Math.round((current90dAvg - priorAvg) * 100) / 100;

  return delta > 0 ? delta : null;
}

export function computeRankDistributionBands(
  points: Array<{ position: number | null | undefined }>
): {
  bandTop3Pct: number;
  band4to10Pct: number;
  band11to20Pct: number;
  bandOutOfTop20Pct: number;
} {
  const bands = computeDistributionBands(points);
  return {
    bandTop3Pct: bands.top3,
    band4to10Pct: bands.band4to10,
    band11to20Pct: bands.band11to20,
    bandOutOfTop20Pct: bands.outOfTop20,
  };
}

export interface CompetitorLeaderboardEntry {
  rank: number;
  name: string;
  shareOfVoice: number;
  averageRank: number | null;
  reviewCount: number | null;
  reviewRating: number | null;
  isSubjectBusiness: boolean;
  // Task #1966 — disambiguator for when the same firm has multiple GBP
  // locations both ranking in a market. Derived from `competitor_gbp_url`;
  // null when no GBP URL is stored. Ranking math is unchanged.
  locationLabel: string | null;
}

// US state / territory two-letter codes used to recognize a region token so
// it is not mistaken for the locality (e.g. "IL 60601" or a bare "IL").
const US_STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
  "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc", "pr", "gu", "vi", "as", "mp",
]);

// Canadian province / territory two-letter codes (Task #2051). Recognized so a
// region token like "ON" or "ON M5V 2T6" is not mistaken for the locality.
const CA_PROVINCE_CODES = new Set([
  "on", "qc", "bc", "ab", "mb", "sk", "ns", "nb", "nl", "pe", "nt", "yt", "nu",
]);

// Australian state / territory codes (Task #2291). 2-3 letters. Recognized so a
// region token like "NSW" or "NSW 2000" is not mistaken for the locality. AU
// postcodes are 4 digits and already matched by the numeric-ZIP rule. Note
// "wa" overlaps the US Washington code and "nt" the Canadian Northwest
// Territories code — harmless, both already classify as a region token.
const AU_STATE_CODES = new Set([
  "nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act",
]);

// Common trailing country tokens. Only stripped when removing them still
// leaves a locality candidate (see parseCompetitorAddress), so a short
// "<street>, <country>" input keeps the country as a best-effort locality.
const COUNTRY_TOKENS = new Set([
  "usa", "us", "u.s.a.", "u.s.", "united states", "united states of america",
  "canada", "mexico", "uk", "u.k.", "united kingdom", "england", "scotland",
  "wales", "australia", "new zealand", "ireland", "republic of ireland",
  "netherlands", "the netherlands", "holland",
]);

function isCountryToken(seg: string): boolean {
  return COUNTRY_TOKENS.has(seg.trim().toLowerCase().replace(/\.$/, "").trim())
    || COUNTRY_TOKENS.has(seg.trim().toLowerCase());
}

// A bare postal code in a recognized national format: US/numeric ZIP (also
// covers AU 4-digit postcodes), Canadian "A1A 1A1", UK "SW1A 1AA" / "M1 1AE" /
// "B33 8TH" (Task #2051), Irish Eircode "D02 AF30" / "D6W 1234", or Dutch
// "1011 AB" (Task #2291). The internal space in the alphanumeric formats is
// optional so "M5V2T6" / "1011AB" also match.
function isPostalCode(t: string): boolean {
  if (/^\d{4,10}(-\d{4})?$/.test(t)) return true; // numeric ZIP / postal (incl. AU 4-digit)
  if (/^[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d$/.test(t)) return true; // Canada A1A 1A1
  if (/^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/.test(t)) return true; // UK
  if (/^[A-Za-z]\d[A-Za-z\d]\s*[A-Za-z\d]{4}$/.test(t)) return true; // Ireland Eircode (routing key + 4-char identifier)
  if (/^\d{4}\s*[A-Za-z]{2}$/.test(t)) return true; // Netherlands 1011 AB
  return false;
}

// A region/postal token: a bare postal code, a "<region> <postal>" pair (e.g.
// "IL 60601", "ON M5V 2T6", or "NSW 2000"), or a bare recognized US state /
// Canadian province / Australian state code. Used so a region token is never
// labeled the locality.
//
// Exported (Task #2357) so the locality-relabel backfill can cheaply decide,
// for a stored `competitor_locality`, whether it is a region/postal token that
// an OLD address parse mistakenly stored as the city (e.g. an Eircode or
// "NSW 2000") and should be re-parsed under the current rules.
export function isRegionOrZipToken(seg: string): boolean {
  const t = seg.trim();
  if (t.length === 0) return false;
  if (isPostalCode(t)) return true; // bare postal code (US / CA / UK / IE / NL)
  const lower = t.toLowerCase();
  if (US_STATE_CODES.has(lower)) return true; // bare US state code
  if (CA_PROVINCE_CODES.has(lower)) return true; // bare CA province code
  if (AU_STATE_CODES.has(lower)) return true; // bare AU state code
  // Generic two-letter region + numeric ZIP (kept for backward compatibility).
  if (/^[A-Za-z]{2}\s+\d{4,10}(-\d{4})?$/.test(t)) return true;
  // Recognized region code (US/CA 2-letter, AU 2-3 letter) followed by an
  // international postal code, e.g. "ON M5V 2T6" or "NSW 2000".
  const m = t.match(/^([A-Za-z]{2,3})\s+(.+)$/);
  if (m) {
    const code = m[1].toLowerCase();
    if (
      (US_STATE_CODES.has(code) ||
        CA_PROVINCE_CODES.has(code) ||
        AU_STATE_CODES.has(code)) &&
      isPostalCode(m[2].trim())
    ) {
      return true;
    }
  }
  return false;
}

// A leading "Suite 200" / "Unit 4" / "#3" / "Floor 2" style segment that
// precedes the street line and carries no city/street disambiguating value.
function isUnitToken(seg: string): boolean {
  return /^(suite|ste\.?|unit|apt\.?|apartment|fl\.?|floor|bldg\.?|building|room|rm\.?|level|lvl\.?|no\.?|#)\b/i
    .test(seg.trim());
}

// A segment "looks like" a street line if it carries a house number (any
// digit) or ends with a common street-type suffix. Used to decide whether the
// first remaining segment is the street or — when there is no street — the
// locality itself.
function looksLikeStreet(seg: string): boolean {
  const t = seg.trim();
  if (/\d/.test(t)) return true;
  return /\b(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|hwy|highway|pkwy|parkway|ter|terrace|cir|circle|sq|square)\.?$/i
    .test(t);
}

// Task #2020 / #2042 — best-effort parse of the SEMrush Map Rank Tracker
// business `address` free-text string into structured (locality, street)
// fields. The API exposes location only as a single concatenated string (e.g.
// "123 W Madison St, Chicago, IL 60601, USA"); it does NOT break it into
// sub-fields.
//
// Heuristic (Task #2042 widened it beyond "first=street, second=locality"):
//   1. Drop a trailing country token when ≥3 segments remain (so a locality
//      candidate survives; a short "<street>, <country>" keeps the country).
//   2. Drop a leading suite/unit token (e.g. "Suite 200, 123 Main St, …").
//   3. If the first remaining segment looks like a street, it becomes the
//      street and the locality is the next segment that is NOT a region/ZIP
//      token (so "IL 60601" can't be mistaken for the city).
//   4. Otherwise there is no street: the first segment is the locality
//      (unless it is itself a region/ZIP token).
// Returns `undefined` for any field the source doesn't provide.
export function parseCompetitorAddress(
  address: string | null | undefined,
): { locality?: string; street?: string } {
  if (!address || typeof address !== "string") return {};
  let parts = address
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return {};

  // 1. Drop a trailing country token only when a locality candidate remains.
  if (parts.length >= 3 && isCountryToken(parts[parts.length - 1])) {
    parts = parts.slice(0, -1);
  }

  // 2. Drop a leading suite/unit token.
  if (parts.length > 1 && isUnitToken(parts[0])) {
    parts = parts.slice(1);
  }

  const out: { locality?: string; street?: string } = {};
  if (parts.length === 0) return out;

  const first = parts[0];
  if (looksLikeStreet(first)) {
    out.street = first;
    // 3. Locality = first following segment that is not a region/ZIP token.
    for (let i = 1; i < parts.length; i++) {
      if (!isRegionOrZipToken(parts[i])) {
        out.locality = parts[i];
        break;
      }
    }
  } else if (!isRegionOrZipToken(first)) {
    // 4. No street; first segment is the locality.
    out.locality = first;
  }

  return out;
}

// Normalize for firm-name-leak / dedupe comparisons: lowercase, alnum only.
function normLabelToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Strip a leading firm-name leak (and any trailing separators) from a label
// segment so labels carry only the disambiguating remainder. Returns the
// trimmed remainder, or "" if the segment was nothing but the firm name.
function stripFirmNameLeak(seg: string, firmName: string): string {
  const trimmed = seg.trim();
  if (trimmed.length === 0) return "";
  if (normLabelToken(trimmed) === normLabelToken(firmName)) return "";
  const escaped = firmName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = trimmed
    .replace(new RegExp("^" + escaped + "[,\\s\\-]*", "i"), "")
    .trim();
  return stripped.length > 0 ? stripped : trimmed;
}

// Task #2020 — build a "Locality / Street" label from structured fields,
// stripping firm-name leaks and deduping when locality == street. Returns
// null when neither field carries usable disambiguating content.
function buildStructuredLocationLabel(
  locality: string | null | undefined,
  street: string | null | undefined,
  firmName: string,
): string | null {
  const loc = locality ? stripFirmNameLeak(locality, firmName) : "";
  const str = street ? stripFirmNameLeak(street, firmName) : "";
  const haveLoc = loc.length > 0;
  const haveStr = str.length > 0;
  if (haveLoc && haveStr) {
    // Dedupe when the two segments are effectively the same value.
    if (normLabelToken(loc) === normLabelToken(str)) return loc;
    return `${loc} / ${str}`;
  }
  if (haveLoc) return loc;
  if (haveStr) return str;
  return null;
}

// Task #1966 / #2015 / #2020 — best-effort human-readable disambiguator for a
// competitor row. Precedence:
//   1. Structured locality/street fields ("Locality / Street"), parsed at
//      ingestion from the SEMrush business address (Task #2020).
//   2. An address-like fragment from the GBP URL `/place/<segment>/` path.
//   3. A short stable code derived from the GBP cid / place_id / URL.
//   4. null (only when there is no GBP URL and no structured fields).
//
// Task #2015 — the opaque `GBP <hash>` fallback (step 3) looks like a bug on
// client-facing deliverables (report slides / PDF). Callers that render to
// clients pass `allowOpaqueFallback: false` so they only ever get a friendly
// location string (structured label or `/place/` fragment) or `null`, which
// renders no label. The admin Local Dominance dashboard keeps the default
// (`true`) so duplicate-firm rows stay disambiguated for operators.
export function deriveCompetitorLocationLabel(
  gbpUrl: string | null | undefined,
  firmName: string,
  structured?: { locality?: string | null; street?: string | null },
  options: { allowOpaqueFallback?: boolean } = {},
): string | null {
  const { allowOpaqueFallback = true } = options;
  // 1. Prefer structured fields when present.
  const structuredLabel = buildStructuredLocationLabel(
    structured?.locality,
    structured?.street,
    firmName,
  );
  if (structuredLabel) return structuredLabel;

  if (!gbpUrl) return null;
  try {
    const placeMatch = gbpUrl.match(/\/place\/([^/@?]+)/);
    if (placeMatch) {
      const seg = decodeURIComponent(placeMatch[1].replace(/\+/g, " ")).trim();
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seg.length > 0 && norm(seg) !== norm(firmName)) {
        const escaped = firmName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stripped = seg.replace(new RegExp("^" + escaped + "[,\\s\\-]*", "i"), "").trim();
        const candidate = stripped.length > 0 ? stripped : seg;
        if (candidate.length > 0 && candidate.length <= 80) return candidate;
      }
    }
    if (!allowOpaqueFallback) return null;
    const cid = gbpUrl.match(/[?&]cid=(\d+)/);
    if (cid) return `GBP ${shortGbpHash(cid[1])}`;
    const placeId = gbpUrl.match(/place_id[:=]([A-Za-z0-9_-]+)/);
    if (placeId) return `GBP ${shortGbpHash(placeId[1])}`;
    return `GBP ${shortGbpHash(gbpUrl)}`;
  } catch {
    return null;
  }
}

function shortGbpHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return (Math.abs(h) % 0xfffff).toString(16).padStart(5, "0");
}

export async function buildCompetitorLeaderboard(
  snapshotId: string,
  options: { allowOpaqueFallback?: boolean } = {}
): Promise<CompetitorLeaderboardEntry[]> {
  const { allowOpaqueFallback = true } = options;
  const rows = await db.select()
    .from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.snapshotId, snapshotId))
    .orderBy(desc(heatmapCompetitorSnapshots.competitorShareOfVoice));

  return rows.map((r, idx) => ({
    rank: idx + 1,
    name: r.competitorName,
    shareOfVoice: r.competitorShareOfVoice ?? 0,
    averageRank: r.competitorAverageRank,
    reviewCount: r.competitorReviewCount,
    reviewRating: r.competitorReviewRating,
    isSubjectBusiness: r.isSubjectBusiness,
    locationLabel: deriveCompetitorLocationLabel(
      r.competitorGbpUrl,
      r.competitorName,
      { locality: r.competitorLocality, street: r.competitorStreet },
      { allowOpaqueFallback },
    ),
  }));
}

// Task #1722 Phase 1.2 — Bulk variant. The Local Dominance dashboard
// previously fanned out N separate `buildCompetitorLeaderboard` calls
// (one per location's best snapshot). For a client with 10 locations
// that is 10 sequential SELECTs against `heatmap_competitor_snapshots`.
// This helper pulls every relevant row in a single query and groups
// them in JS, preserving the original sort order (DESC by SoV) so the
// returned ranks match the per-snapshot helper exactly.
export async function buildCompetitorLeaderboardsForSnapshots(
  snapshotIds: string[],
  options: { allowOpaqueFallback?: boolean } = {}
): Promise<Map<string, CompetitorLeaderboardEntry[]>> {
  const { allowOpaqueFallback = true } = options;
  const out = new Map<string, CompetitorLeaderboardEntry[]>();
  if (snapshotIds.length === 0) return out;

  const rows = await db.select()
    .from(heatmapCompetitorSnapshots)
    .where(inArray(heatmapCompetitorSnapshots.snapshotId, snapshotIds))
    .orderBy(desc(heatmapCompetitorSnapshots.competitorShareOfVoice));

  // Group preserving the SoV-DESC order from the SQL ORDER BY.
  const perSnapshot = new Map<string, typeof rows>();
  for (const r of rows) {
    let arr = perSnapshot.get(r.snapshotId);
    if (!arr) { arr = []; perSnapshot.set(r.snapshotId, arr); }
    arr.push(r);
  }
  for (const [snapId, snapRows] of perSnapshot) {
    out.set(snapId, snapRows.map((r, idx) => ({
      rank: idx + 1,
      name: r.competitorName,
      shareOfVoice: r.competitorShareOfVoice ?? 0,
      averageRank: r.competitorAverageRank,
      reviewCount: r.competitorReviewCount,
      reviewRating: r.competitorReviewRating,
      isSubjectBusiness: r.isSubjectBusiness,
      locationLabel: deriveCompetitorLocationLabel(
        r.competitorGbpUrl,
        r.competitorName,
        { locality: r.competitorLocality, street: r.competitorStreet },
        { allowOpaqueFallback },
      ),
    })));
  }
  // Snapshots with zero competitor rows are simply absent from the map.
  return out;
}

export async function computeAndStoreDerivedMetrics(
  snapshotId: string,
  expectedRawPayload?: unknown,
): Promise<{ bandsWritten: boolean; sovWritten: boolean; errors: string[] }> {
  const errors: string[] = [];
  let bandsWritten = false;
  let sovWritten = false;

  const currentSnapshotWhere = expectedRawPayload === undefined
    ? eq(heatmapSnapshots.id, snapshotId)
    : and(
        eq(heatmapSnapshots.id, snapshotId),
        eq(heatmapSnapshots.rawPayload, expectedRawPayload as any),
      );
  const snapshot = await db.select().from(heatmapSnapshots)
    .where(currentSnapshotWhere).limit(1);
  if (!snapshot[0]) {
    const msg = expectedRawPayload === undefined
      ? `Snapshot ${snapshotId} not found`
      : `Snapshot ${snapshotId} was superseded before derived metrics ran`;
    console.warn(`[DerivedMetrics] ${msg}`);
    return { bandsWritten: false, sovWritten: false, errors: expectedRawPayload === undefined ? [msg] : [] };
  }

  const snap = snapshot[0];

  const points = await db.select({ position: heatmapPoints.position })
    .from(heatmapPoints)
    .where(eq(heatmapPoints.snapshotId, snapshotId));

  if (points.length === 0) {
    const msg = `No points found for snapshot ${snapshotId}`;
    console.warn(`[DerivedMetrics] ${msg}`);
    return { bandsWritten: false, sovWritten: false, errors: [msg] };
  }

  const bands = computeRankDistributionBands(points);
  const sovRaw = computeShareOfVoiceFromPoints(points);
  const currentScanGuard = expectedRawPayload === undefined
    ? sql`TRUE`
    : sql`EXISTS (
        SELECT 1
        FROM ${heatmapSnapshots} current_snapshot
        WHERE current_snapshot.id = ${snapshotId}
          AND current_snapshot.raw_payload = ${JSON.stringify(expectedRawPayload)}::jsonb
      )`;

  // Task #1722 Phase 1.4 — Single-statement upsert. The previous flow
  // did a SELECT for existence, then an INSERT or UPDATE based on the
  // result (2 round-trips). With no UNIQUE(snapshot_id) on
  // `heatmap_metrics` we cannot use ON CONFLICT, but an UPDATE/INSERT
  // CTE collapses both branches into a single round-trip.
  try {
    await db.execute(sql`
      WITH up AS (
        UPDATE ${heatmapMetrics}
        SET band_top_3_pct = ${bands.bandTop3Pct},
            band_4_to_10_pct = ${bands.band4to10Pct},
            band_11_to_20_pct = ${bands.band11to20Pct},
            band_out_of_top_20_pct = ${bands.bandOutOfTop20Pct}
        WHERE snapshot_id = ${snapshotId}
          AND ${currentScanGuard}
        RETURNING id
      )
      INSERT INTO ${heatmapMetrics}
        (snapshot_id, band_top_3_pct, band_4_to_10_pct, band_11_to_20_pct, band_out_of_top_20_pct)
      SELECT ${snapshotId}, ${bands.bandTop3Pct}, ${bands.band4to10Pct}, ${bands.band11to20Pct}, ${bands.bandOutOfTop20Pct}
      WHERE NOT EXISTS (SELECT 1 FROM up)
        AND ${currentScanGuard}
    `);
    bandsWritten = true;
    console.log(`[DerivedMetrics] Bands written for snapshot ${snapshotId}: top3=${bands.bandTop3Pct}%, 4-10=${bands.band4to10Pct}%, 11-20=${bands.band11to20Pct}%, out=${bands.bandOutOfTop20Pct}%`);
  } catch (err) {
    const msg = `Failed to write bands for snapshot ${snapshotId}: ${err instanceof Error ? err.message : err}`;
    console.error(`[DerivedMetrics] ${msg}`);
    errors.push(msg);
  }

  try {
    await db.update(heatmapSnapshots)
      .set({ shareOfVoiceRaw: sovRaw })
      .where(currentSnapshotWhere);
    sovWritten = true;
    console.log(`[DerivedMetrics] SoV raw written for snapshot ${snapshotId}: ${sovRaw}%`);
  } catch (err) {
    const msg = `Failed to write SoV raw for snapshot ${snapshotId}: ${err instanceof Error ? err.message : err}`;
    console.error(`[DerivedMetrics] ${msg}`);
    errors.push(msg);
  }

  try {
    const { avg: sov90d } = await computeShareOfVoiceRollingAverage(
      snap.campaignId, snap.keywordName, snap.reportDate
    );

    const anchorIncrease = await computeShareOfVoiceAnchorIncrease(
      snap.campaignId, snap.keywordName, sov90d, snap.reportDate
    );

    // Task #1722 Phase 1.4 — Same UPDATE/INSERT CTE pattern as above so
    // the rolling-average write is one round-trip instead of a SELECT
    // followed by an INSERT-or-UPDATE.
    await db.execute(sql`
      WITH up AS (
        UPDATE ${heatmapMetrics}
        SET share_of_voice_90d_avg = ${sov90d},
            share_of_voice_anchor_increase = ${anchorIncrease}
        WHERE snapshot_id = ${snapshotId}
          AND ${currentScanGuard}
        RETURNING id
      )
      INSERT INTO ${heatmapMetrics}
        (snapshot_id, share_of_voice_90d_avg, share_of_voice_anchor_increase)
      SELECT ${snapshotId}, ${sov90d}, ${anchorIncrease}
      WHERE NOT EXISTS (SELECT 1 FROM up)
        AND ${currentScanGuard}
    `);
  } catch (err) {
    const msg = `Failed to compute/store SoV rolling avg for snapshot ${snapshotId}: ${err instanceof Error ? err.message : err}`;
    console.error(`[DerivedMetrics] ${msg}`);
    errors.push(msg);
  }

  return { bandsWritten, sovWritten, errors };
}

export async function storeCompetitorData(
  snapshotId: string,
  clientId: string | null,
  campaignId: string,
  keyword: string,
  scanDate: Date,
  competitors: Array<{
    name: string;
    shareOfVoice?: number;
    averageRank?: number;
    reviewCount?: number;
    reviewRating?: number;
    gbpUrl?: string;
    address?: string;
    isSubjectBusiness?: boolean;
  }>,
  expectedRawPayload?: unknown,
): Promise<void> {
  if (competitors.length === 0) return;

  const rows: InsertHeatmapCompetitorSnapshot[] = competitors.map((c, idx) => {
    // Task #2020 — parse the SEMrush free-text address into structured
    // locality/street disambiguators (best-effort; both null when absent).
    const { locality, street } = parseCompetitorAddress(c.address);
    return {
      snapshotId,
      clientId,
      campaignId,
      keyword,
      scanDate,
      competitorName: c.name,
      competitorRankPosition: idx + 1,
      competitorShareOfVoice: c.shareOfVoice ?? null,
      competitorAverageRank: c.averageRank ?? null,
      competitorReviewCount: c.reviewCount ?? null,
      competitorReviewRating: c.reviewRating ?? null,
      competitorGbpUrl: c.gbpUrl ?? null,
      competitorLocality: locality ?? null,
      competitorStreet: street ?? null,
      isSubjectBusiness: c.isSubjectBusiness ?? false,
      // Task #3533 — stamp no-match rows terminal AT INGEST. This row was
      // just produced by a live SEMrush fetch; if that fetch yielded no GBP
      // URL, a later backfill re-fetch of the same campaign/keyword cannot
      // do better (every recent backfill run filled 0). Pre-stamping keeps
      // the daily heatmap-scan trickle out of
      // `backfill_competitor_location_labels`' candidate set so the action
      // converges; rows WITH a URL stay NULL-stamped as before.
      gbpUrlBackfillAttemptedAt: c.gbpUrl ? null : new Date(),
    };
  });

  await db.transaction(async (tx) => {
    const currentSnapshotWhere = expectedRawPayload === undefined
      ? eq(heatmapSnapshots.id, snapshotId)
      : and(
          eq(heatmapSnapshots.id, snapshotId),
          eq(heatmapSnapshots.rawPayload, expectedRawPayload as any),
        );
    const currentSnapshot = await tx.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(currentSnapshotWhere)
      .for("update")
      .limit(1);
    if (currentSnapshot.length === 0) {
      console.log(`[Heatmap] Discarded stale competitor data for superseded snapshot version ${snapshotId}`);
      return;
    }

    await tx.delete(heatmapCompetitorSnapshots)
      .where(eq(heatmapCompetitorSnapshots.snapshotId, snapshotId));
    await tx.insert(heatmapCompetitorSnapshots).values(rows);
  });
}

export async function getLocalDominanceDashboard(
  clientId: string,
  campaignId?: string,
  keyword?: string
): Promise<{
  latestSnapshot: HeatmapSnapshot | null;
  metrics: HeatmapMetric | null;
  sovHistory: Array<{ date: string; sov: number }>;
  competitors: CompetitorLeaderboardEntry[];
  distributionBands: {
    bandTop3Pct: number;
    band4to10Pct: number;
    band11to20Pct: number;
    bandOutOfTop20Pct: number;
  } | null;
}> {
  let conditions = [eq(heatmapSnapshots.clientId, clientId)];
  if (campaignId) conditions.push(eq(heatmapSnapshots.campaignId, campaignId));
  if (keyword) conditions.push(keywordNameMatchesSql(keyword));

  const snapshotsWithMetrics = await db.select({
    snapshot: heatmapSnapshots,
    metricsId: heatmapMetrics.id,
  })
    .from(heatmapSnapshots)
    .leftJoin(heatmapMetrics, eq(heatmapMetrics.snapshotId, heatmapSnapshots.id))
    .where(and(...conditions))
    .orderBy(desc(heatmapSnapshots.reportDate))
    .limit(10);

  const withMetrics = snapshotsWithMetrics.find(s => s.metricsId !== null);
  const latestSnapshot = withMetrics?.snapshot || snapshotsWithMetrics[0]?.snapshot || null;
  if (!latestSnapshot) {
    return { latestSnapshot: null, metrics: null, sovHistory: [], competitors: [], distributionBands: null };
  }

  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const historyConditions = [
    eq(heatmapSnapshots.clientId, clientId),
    gte(heatmapSnapshots.reportDate, sixMonthsAgo),
  ];
  if (campaignId) historyConditions.push(eq(heatmapSnapshots.campaignId, campaignId));
  if (keyword) historyConditions.push(keywordNameMatchesSql(keyword));

  const [metricsRows, history, competitors] = await Promise.all([
    db.select()
      .from(heatmapMetrics)
      .where(eq(heatmapMetrics.snapshotId, latestSnapshot.id))
      .limit(1),
    db.select({
      date: heatmapSnapshots.reportDate,
      sov: heatmapSnapshots.shareOfVoiceRaw,
    })
      .from(heatmapSnapshots)
      .where(and(...historyConditions))
      .orderBy(heatmapSnapshots.reportDate),
    buildCompetitorLeaderboard(latestSnapshot.id),
  ]);

  const metrics = metricsRows[0] || null;

  const sovHistory = history
    .filter(h => h.sov !== null)
    .map(h => ({
      date: h.date.toISOString().split("T")[0],
      sov: h.sov!,
    }));

  const distributionBands = metrics ? {
    bandTop3Pct: metrics.bandTop3Pct ?? 0,
    band4to10Pct: metrics.band4to10Pct ?? 0,
    band11to20Pct: metrics.band11to20Pct ?? 0,
    bandOutOfTop20Pct: metrics.bandOutOfTop20Pct ?? 0,
  } : null;

  return { latestSnapshot, metrics, sovHistory, competitors, distributionBands };
}

// This endpoint serves SoV trend data exclusively from locally synced snapshots.
// Data freshness depends on the sync pipeline (heatmapService.importHeatmap → getCampaignMetrics → shareOfVoiceRaw).
// If a new SEMrush report date has not been imported yet, the chart stops at the last synced date.
export async function getClientSovTrend(
  clientId: string,
  campaignId?: string,
  keyword?: string,
  months: number = 6
): Promise<Array<{
  date: string;
  sovRaw: number;
  sov90dAvg: number | null;
  anchorIncrease: number | null;
}>> {
  const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const conditions = [
    eq(heatmapSnapshots.clientId, clientId),
    gte(heatmapSnapshots.reportDate, cutoff),
  ];
  if (campaignId) conditions.push(eq(heatmapSnapshots.campaignId, campaignId));
  if (keyword) conditions.push(keywordNameMatchesSql(keyword));

  const rows = await db.select({
    date: heatmapSnapshots.reportDate,
    sovRaw: heatmapSnapshots.shareOfVoiceRaw,
    sov90dAvg: heatmapMetrics.shareOfVoice90dAvg,
    anchorIncrease: heatmapMetrics.shareOfVoiceAnchorIncrease,
  })
    .from(heatmapSnapshots)
    .leftJoin(heatmapMetrics, eq(heatmapMetrics.snapshotId, heatmapSnapshots.id))
    .where(and(...conditions))
    .orderBy(heatmapSnapshots.reportDate, desc(heatmapSnapshots.id));

  return buildSovTrendSeries(rows);
}

/**
 * Shared series builder for SoV trends: filters null sovRaw, formats dates,
 * and dedups to one point per date (keep the highest sovRaw; coalesce null
 * metric fields). Rows MUST be pre-sorted by reportDate asc, snapshot id desc.
 * Used by both `getClientSovTrend` (single fetch) and the bulk grouping in
 * `getLocalDominanceDataForReportBulk` so the two paths can never diverge.
 */
function buildSovTrendSeries(
  rows: Array<{ date: Date; sovRaw: number | null; sov90dAvg: number | null; anchorIncrease: number | null }>,
): Array<{ date: string; sovRaw: number; sov90dAvg: number | null; anchorIncrease: number | null }> {
  const rawResults = rows
    .filter(r => r.sovRaw !== null)
    .map(r => ({
      date: r.date.toISOString().split("T")[0],
      sovRaw: r.sovRaw!,
      sov90dAvg: r.sov90dAvg,
      anchorIncrease: r.anchorIncrease,
    }));

  // Dedup: one point per date. For duplicate dates (multiple snapshots per day),
  // keep the highest sovRaw value and coalesce null metric fields from other rows.
  const dateMap = new Map<string, { date: string; sovRaw: number; sov90dAvg: number | null; anchorIncrease: number | null }>();
  for (const r of rawResults) {
    const existing = dateMap.get(r.date);
    if (!existing) {
      dateMap.set(r.date, { ...r });
    } else {
      if (r.sovRaw > existing.sovRaw) existing.sovRaw = r.sovRaw;
      if (existing.sov90dAvg === null && r.sov90dAvg !== null) existing.sov90dAvg = r.sov90dAvg;
      if (existing.anchorIncrease === null && r.anchorIncrease !== null) existing.anchorIncrease = r.anchorIncrease;
    }
  }

  return Array.from(dateMap.values());
}

export async function getPerLocationSnapshots(
  clientId: string,
  keyword?: string
): Promise<Array<{
  locationId: string;
  locationName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  snapshotId: string | null;
  keywordName: string | null;
  reportDate: string | null;
  shareOfVoice: number | null;
  avgRank: number | null;
  top3Coverage: number | null;
  availableKeywords: string[] | null;
}>> {
  const mappings = await db.select({
    locationId: semrushLocationCampaigns.locationId,
    campaignId: semrushLocationCampaigns.semrushCampaignId,
  })
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.clientId, clientId));

  if (mappings.length === 0) return [];

  const locationIds = [...new Set(mappings.map(m => m.locationId))];
  const campaignIds = [...new Set(mappings.map(m => m.campaignId))];
  const allowedCampaignsByLocation = new Map<string, Set<string>>();
  for (const m of mappings) {
    let s = allowedCampaignsByLocation.get(m.locationId);
    if (!s) { s = new Set(); allowedCampaignsByLocation.set(m.locationId, s); }
    s.add(m.campaignId);
  }

  const [locationRows, snapshotRows] = await Promise.all([
    db.select({
      id: clientLocations.id,
      name: clientLocations.name,
      address: clientLocations.address,
      city: clientLocations.city,
      state: clientLocations.state,
    })
      .from(clientLocations)
      .where(inArray(clientLocations.id, locationIds)),

    (() => {
      const fallbackLocationId = `client-${clientId}`;
      const allLocationIds = [...new Set([...locationIds, fallbackLocationId])];
      const conditions = [
        eq(heatmapSnapshots.clientId, clientId),
        or(
          inArray(heatmapSnapshots.locationId, allLocationIds),
          inArray(heatmapSnapshots.campaignId, campaignIds),
        ),
      ];
      if (keyword) conditions.push(keywordNameMatchesSql(keyword));
      return db.select({
        id: heatmapSnapshots.id,
        locationId: heatmapSnapshots.locationId,
        locationName: heatmapSnapshots.locationName,
        campaignId: heatmapSnapshots.campaignId,
        keywordName: heatmapSnapshots.keywordName,
        reportDate: heatmapSnapshots.reportDate,
        shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
      })
        .from(heatmapSnapshots)
        .where(and(...conditions))
        .orderBy(desc(heatmapSnapshots.reportDate));
    })(),
  ]);

  const locationDetailsMap = new Map(locationRows.map(l => [l.id, l]));

  const snapshotLocationIds = [...new Set(snapshotRows.map(s => s.locationId))];
  const snapshotCampaignIds = [...new Set(snapshotRows.map(s => s.campaignId))];
  console.log(`[LocalDominance] getPerLocationSnapshots: queried locationIds=${JSON.stringify(locationIds)}, campaignIds=${JSON.stringify(campaignIds)}, found ${snapshotRows.length} snapshots with locationIds=${JSON.stringify(snapshotLocationIds)}, campaignIds=${JSON.stringify(snapshotCampaignIds)}`);

  const campaignToLocations = new Map<string, Set<string>>();
  for (const m of mappings) {
    let s = campaignToLocations.get(m.campaignId);
    if (!s) { s = new Set(); campaignToLocations.set(m.campaignId, s); }
    s.add(m.locationId);
  }

  // Canonical per-location resolution rule:
  //   A snapshot belongs to (clientId, locationId, campaignId, keywordName, day).
  //   For each mapped location, the dashboard must surface only snapshots whose
  //   (locationId, campaignId) pair matches one of that location's own
  //   `semrush_location_campaigns` rows. Cross-location fan-out via campaignId
  //   is reserved for legacy snapshots that were imported with the placeholder
  //   locationId `client-${clientId}` (pre-multi-location code paths) — a real
  //   location's snapshot must NEVER be silently re-attributed to another
  //   location, since that mis-routes data when the same keyword text is
  //   tracked in multiple campaigns.
  const fallbackLocationId = `client-${clientId}`;
  const bestSnapshot = new Map<string, typeof snapshotRows[number]>();
  // Two passes: exact (locationId, campaignId) matches first, then legacy
  // fallback fan-out. This guarantees that a correctly-tagged snapshot for
  // loc2 is never overwritten by a stale fallback snapshot.
  const exactMatches: typeof snapshotRows = [];
  const fallbackCandidates: typeof snapshotRows = [];
  for (const snap of snapshotRows) {
    const allowed = allowedCampaignsByLocation.get(snap.locationId);
    if (allowed && allowed.has(snap.campaignId)) {
      exactMatches.push(snap);
    } else if (snap.locationId === fallbackLocationId) {
      fallbackCandidates.push(snap);
    } else {
      // The snapshot is tagged with a real-looking locationId that does not
      // own this campaign. This is either stale data from a prior buggy
      // import or a campaign re-mapping. Skip rather than fan out, so we do
      // not contaminate sibling locations.
      console.warn(`[LocalDominance] getPerLocationSnapshots: snapshot ${snap.id} has (locationId=${snap.locationId}, campaignId=${snap.campaignId}) which is not in semrush_location_campaigns — skipping (not fanning out to other locations)`);
    }
  }
  for (const snap of exactMatches) {
    const existing = bestSnapshot.get(snap.locationId);
    if (!existing || snap.reportDate > existing.reportDate) {
      bestSnapshot.set(snap.locationId, snap);
    }
  }
  // Track which entries in bestSnapshot came from the exact-match pass so that
  // a legacy fallback can never overwrite a correctly-tagged snapshot, even if
  // the fallback's reportDate happens to be newer (e.g. a stale row that was
  // re-imported after a campaign re-mapping).
  const exactWinners = new Set(bestSnapshot.keys());
  for (const snap of fallbackCandidates) {
    const mappedLocs = campaignToLocations.get(snap.campaignId);
    if (!mappedLocs || mappedLocs.size === 0) {
      console.warn(`[LocalDominance] getPerLocationSnapshots: legacy snapshot ${snap.id} (campaignId=${snap.campaignId}) has no current mapping — skipping`);
      continue;
    }
    for (const resolvedLocationId of mappedLocs) {
      if (exactWinners.has(resolvedLocationId)) continue;
      const existing = bestSnapshot.get(resolvedLocationId);
      if (!existing || snap.reportDate > existing.reportDate) {
        bestSnapshot.set(resolvedLocationId, snap);
      }
    }
    console.log(`[LocalDominance] getPerLocationSnapshots: legacy fallback snapshot ${snap.id} attributed to locations=${JSON.stringify(Array.from(mappedLocs))} via campaignId=${snap.campaignId}`);
  }

  const keywordsByLocation = new Map<string, string[]>();
  if (keyword) {
    // Derive `availableKeywords` from the LATEST report date per
    // (locationId, campaignId) only. Building this list from all-time history
    // (the previous behavior) caused keywords removed from a SEMrush campaign
    // months ago to keep appearing in the dashboard, even after the
    // sync-time stale-keyword cleanup ran. By scoping to the latest report
    // date we get the current-availability semantics the UI is asking for
    // while leaving historical snapshots intact for audit/reporting.
    const allSnapsForClient = await db.select({
      locationId: heatmapSnapshots.locationId,
      campaignId: heatmapSnapshots.campaignId,
      keywordName: heatmapSnapshots.keywordName,
      reportDate: heatmapSnapshots.reportDate,
    })
      .from(heatmapSnapshots)
      .where(and(
        eq(heatmapSnapshots.clientId, clientId),
        or(
          inArray(heatmapSnapshots.locationId, [...new Set([...locationIds, `client-${clientId}`])]),
          inArray(heatmapSnapshots.campaignId, campaignIds),
        ),
      ));

    // Group by (locationId, campaignId) and keep only rows from the most
    // recent reportDate within each group.
    const latestByPair = new Map<string, Date>();
    for (const row of allSnapsForClient) {
      const key = `${row.locationId}::${row.campaignId}`;
      const cur = latestByPair.get(key);
      if (!cur || row.reportDate > cur) latestByPair.set(key, row.reportDate);
    }

    // Apply the same canonical per-location resolution rule used above so the
    // "available keywords" hint shown for an empty location only lists keywords
    // that actually belong to that location's mapped campaign(s).
    for (const row of allSnapsForClient) {
      const key = `${row.locationId}::${row.campaignId}`;
      const latest = latestByPair.get(key);
      if (!latest || row.reportDate.getTime() !== latest.getTime()) continue;
      const allowed = allowedCampaignsByLocation.get(row.locationId);
      let resolvedIds: string[];
      if (allowed && allowed.has(row.campaignId)) {
        resolvedIds = [row.locationId];
      } else if (row.locationId === fallbackLocationId) {
        const mapped = campaignToLocations.get(row.campaignId);
        if (!mapped) continue;
        resolvedIds = Array.from(mapped);
      } else {
        continue;
      }
      for (const lid of resolvedIds) {
        let arr = keywordsByLocation.get(lid);
        if (!arr) { arr = []; keywordsByLocation.set(lid, arr); }
        if (row.keywordName && !arr.includes(row.keywordName)) arr.push(row.keywordName);
      }
    }
  }

  const snapshotIds = [...bestSnapshot.values()].map(s => s.id);
  interface FullMetrics {
    avgRank: number | null;
    bestRank: number | null;
    top3Coverage: number | null;
    top10Coverage: number | null;
    sov90dAvg: number | null;
    anchorIncrease: number | null;
    bandTop3Pct: number | null;
    band4to10Pct: number | null;
    band11to20Pct: number | null;
    bandOutOfTop20Pct: number | null;
  }
  let metricsMap = new Map<string, FullMetrics>();
  if (snapshotIds.length > 0) {
    const metricsRows = await db.select({
      snapshotId: heatmapMetrics.snapshotId,
      avgRank: heatmapMetrics.avgRank,
      bestRank: heatmapMetrics.bestRank,
      top3Coverage: heatmapMetrics.top3CoveragePct,
      top10Coverage: heatmapMetrics.top10CoveragePct,
      sov90dAvg: heatmapMetrics.shareOfVoice90dAvg,
      anchorIncrease: heatmapMetrics.shareOfVoiceAnchorIncrease,
      bandTop3Pct: heatmapMetrics.bandTop3Pct,
      band4to10Pct: heatmapMetrics.band4to10Pct,
      band11to20Pct: heatmapMetrics.band11to20Pct,
      bandOutOfTop20Pct: heatmapMetrics.bandOutOfTop20Pct,
    })
      .from(heatmapMetrics)
      .where(inArray(heatmapMetrics.snapshotId, snapshotIds));
    for (const m of metricsRows) {
      metricsMap.set(m.snapshotId, {
        avgRank: m.avgRank,
        bestRank: m.bestRank,
        top3Coverage: m.top3Coverage,
        top10Coverage: m.top10Coverage,
        sov90dAvg: m.sov90dAvg,
        anchorIncrease: m.anchorIncrease,
        bandTop3Pct: m.bandTop3Pct,
        band4to10Pct: m.band4to10Pct,
        band11to20Pct: m.band11to20Pct,
        bandOutOfTop20Pct: m.bandOutOfTop20Pct,
      });
    }
  }

  // Task #1722 Phase 1.2 — Single bulk query for competitor leaderboards
  // across every location's best snapshot, replacing the previous N
  // sequential per-snapshot reads.
  // Task #2036 — the admin Local Dominance dashboard previously kept the
  // opaque `GBP <hash>` fallback so operators retained duplicate-firm
  // disambiguation, but those codes are meaningless to read. Suppress the
  // opaque fallback here too (matching the client-facing report paths): rows
  // now show a friendly `/place/` location fragment where one is available,
  // or no label at all, instead of `GBP <hash>`.
  let competitorsMap = new Map<string, CompetitorLeaderboardEntry[]>();
  if (snapshotIds.length > 0) {
    try {
      const bySnapshot = await buildCompetitorLeaderboardsForSnapshots(snapshotIds, { allowOpaqueFallback: false });
      for (const [locId, snap] of bestSnapshot.entries()) {
        competitorsMap.set(locId, bySnapshot.get(snap.id) ?? []);
      }
    } catch (err: any) {
      console.warn(
        `[LocalDominance] getPerLocationSnapshots: bulk competitor leaderboard load failed: ${err?.message ?? err}`,
      );
      for (const locId of bestSnapshot.keys()) competitorsMap.set(locId, []);
    }
  }

  const results: Array<{
    locationId: string;
    locationName: string;
    address: string | null;
    city: string | null;
    state: string | null;
    snapshotId: string | null;
    campaignId: string | null;
    keywordName: string | null;
    reportDate: string | null;
    shareOfVoice: number | null;
    avgRank: number | null;
    top3Coverage: number | null;
    availableKeywords: string[] | null;
    metrics: FullMetrics | null;
    competitors: CompetitorLeaderboardEntry[];
    distributionBands: {
      bandTop3Pct: number;
      band4to10Pct: number;
      band11to20Pct: number;
      bandOutOfTop20Pct: number;
    } | null;
  }> = [];

  const seenLocationIds = new Set<string>();
  for (const locId of locationIds) {
    if (seenLocationIds.has(locId)) continue;
    seenLocationIds.add(locId);

    const locDetail = locationDetailsMap.get(locId);
    const snap = bestSnapshot.get(locId);
    const fullMetrics = snap ? metricsMap.get(snap.id) ?? null : null;
    const comps = competitorsMap.get(locId) || [];

    const locKeywords = keywordsByLocation.get(locId) || null;
    const distBands = fullMetrics && fullMetrics.bandTop3Pct !== null ? {
      bandTop3Pct: fullMetrics.bandTop3Pct ?? 0,
      band4to10Pct: fullMetrics.band4to10Pct ?? 0,
      band11to20Pct: fullMetrics.band11to20Pct ?? 0,
      bandOutOfTop20Pct: fullMetrics.bandOutOfTop20Pct ?? 0,
    } : null;

    results.push({
      locationId: locId,
      locationName: snap?.locationName ?? locDetail?.name ?? locId,
      address: locDetail?.address ?? null,
      city: locDetail?.city ?? null,
      state: locDetail?.state ?? null,
      snapshotId: snap?.id ?? null,
      campaignId: snap?.campaignId ?? null,
      keywordName: snap?.keywordName ?? null,
      reportDate: snap ? snap.reportDate.toISOString().split("T")[0] : null,
      shareOfVoice: snap?.shareOfVoiceRaw ?? null,
      avgRank: fullMetrics?.avgRank ?? null,
      top3Coverage: fullMetrics?.top3Coverage ?? null,
      availableKeywords: !snap && locKeywords ? locKeywords.sort() : null,
      metrics: fullMetrics,
      competitors: comps,
      distributionBands: distBands,
    });
  }

  return results;
}

export async function backfillRankDistributionBands(): Promise<{ updated: number; skipped: number }> {
  const metricsRows = await db.select({
    snapshotId: heatmapMetrics.snapshotId,
  })
    .from(heatmapMetrics)
    .where(isNull(heatmapMetrics.bandTop3Pct));

  let updated = 0;
  let skipped = 0;

  for (const row of metricsRows) {
    const points = await db.select({ position: heatmapPoints.position })
      .from(heatmapPoints)
      .where(eq(heatmapPoints.snapshotId, row.snapshotId));

    if (points.length === 0) {
      skipped++;
      continue;
    }

    const bands = computeRankDistributionBands(points);
    await db.update(heatmapMetrics)
      .set(bands)
      .where(eq(heatmapMetrics.snapshotId, row.snapshotId));
    updated++;
  }

  return { updated, skipped };
}

export async function backfillAllDerivedMetrics(): Promise<{
  bandsUpdated: number;
  sovUpdated: number;
  skipped: number;
  errors: string[];
}> {
  const allSnapshots = await db.select({
    id: heatmapSnapshots.id,
    shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
  }).from(heatmapSnapshots);

  let bandsUpdated = 0;
  let sovUpdated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const snap of allSnapshots) {
    try {
      const result = await computeAndStoreDerivedMetrics(snap.id);
      if (result.bandsWritten) bandsUpdated++;
      if (result.sovWritten) sovUpdated++;
      if (result.errors.length > 0) {
        errors.push(...result.errors.map(e => `[${snap.id}] ${e}`));
      }
      if (!result.bandsWritten && !result.sovWritten) {
        skipped++;
      }
    } catch (err) {
      const msg = `[${snap.id}] ${err instanceof Error ? err.message : err}`;
      errors.push(msg);
      skipped++;
    }
  }

  console.log(`[Backfill] Complete: ${bandsUpdated} bands updated, ${sovUpdated} SoV updated, ${skipped} skipped, ${errors.length} errors`);
  return { bandsUpdated, sovUpdated, skipped, errors };
}

export interface LocationLocalDominanceData {
  sovHistory: Array<{ date: string; sovRaw: number; sov90dAvg: number | null; anchorIncrease: number | null }>;
  competitors: CompetitorLeaderboardEntry[];
  distributionBands: {
    bandTop3Pct: number;
    band4to10Pct: number;
    band11to20Pct: number;
    bandOutOfTop20Pct: number;
  } | null;
  keywordSnapshots: Array<{
    keywordName: string;
    snapshotId: string;
    reportDate: string;
    shareOfVoice: number | null;
    avgRank: number | null;
    previousAvgRank: number | null;
    rankChange: number | null;
    sovChange: number | null;
    distributionBands: {
      bandTop3Pct: number;
      band4to10Pct: number;
      band11to20Pct: number;
      bandOutOfTop20Pct: number;
    } | null;
    competitors: CompetitorLeaderboardEntry[];
    sovHistory: Array<{ date: string; sovRaw: number; sov90dAvg: number | null; anchorIncrease: number | null }>;
  }>;
}

// Task #1810 — bulk variant for the per-location enrichment loops in
// `server/routes/reports.ts`. The previous shape called
// `getLocalDominanceDataForReport` once per location inside a
// `Promise.all(locations.map(...))`, which fanned out N×(snapshots +
// metrics + competitors + sov-trend + prior-metrics) sequential
// SELECTs per request. This helper does the full join across every
// location's snapshot ids in a fixed number of queries (4 plus one
// `getClientSovTrend` per distinct campaign) and returns a map keyed
// by an opaque caller-supplied location id. Same output shape per
// location as the per-call variant; callers swap in-place.
export async function getLocalDominanceDataForReportBulk(
  clientId: string,
  perLocation: Array<{ locationId: string; snapshotIds: string[] }>
): Promise<Map<string, LocationLocalDominanceData>> {
  const out = new Map<string, LocationLocalDominanceData>();
  if (perLocation.length === 0) return out;

  const allSnapshotIds = Array.from(
    new Set(perLocation.flatMap((p) => p.snapshotIds).filter((s) => !!s)),
  );
  if (allSnapshotIds.length === 0) {
    for (const p of perLocation) {
      out.set(p.locationId, {
        sovHistory: [], competitors: [], distributionBands: null, keywordSnapshots: [],
      });
    }
    return out;
  }

  // 1) Pull every requested snapshot + metrics + competitor row in
  //    three bulk SELECTs.
  const snapshots = await db.select({
    id: heatmapSnapshots.id,
    clientId: heatmapSnapshots.clientId,
    campaignId: heatmapSnapshots.campaignId,
    keywordName: heatmapSnapshots.keywordName,
    reportDate: heatmapSnapshots.reportDate,
    shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
  })
    .from(heatmapSnapshots)
    .where(inArray(heatmapSnapshots.id, allSnapshotIds))
    .orderBy(desc(heatmapSnapshots.reportDate));

  const snapshotById = new Map(snapshots.map((s) => [s.id, s]));

  const allMetricsRows = snapshots.length === 0 ? [] : await db.select({
    snapshotId: heatmapMetrics.snapshotId,
    bandTop3Pct: heatmapMetrics.bandTop3Pct,
    band4to10Pct: heatmapMetrics.band4to10Pct,
    band11to20Pct: heatmapMetrics.band11to20Pct,
    bandOutOfTop20Pct: heatmapMetrics.bandOutOfTop20Pct,
    avgRank: heatmapMetrics.avgRank,
  })
    .from(heatmapMetrics)
    .where(inArray(heatmapMetrics.snapshotId, allSnapshotIds));
  const metricsBySnapshotId = new Map(allMetricsRows.map((m) => [m.snapshotId, m]));

  // Competitor leaderboards keyed by every snapshot id (one DB hit total).
  // Task #2015 — this is a client-facing report path, so suppress the opaque
  // `GBP <hash>` fallback label; clients only ever see a friendly string or
  // no label at all.
  const leaderboardsBySnapshot = await buildCompetitorLeaderboardsForSnapshots(allSnapshotIds, { allowOpaqueFallback: false });

  // 2) Pre-fetch prior snapshots for every (clientId, campaignId, keyword)
  //    tuple the request touches. Single SELECT.
  const tripleKeys = new Set<string>();
  const campaignIds = new Set<string>();
  const keywordNames = new Set<string>();
  for (const s of snapshots) {
    if (!s.campaignId || !s.keywordName) continue;
    tripleKeys.add(`${s.campaignId}::${s.keywordName}`);
    campaignIds.add(s.campaignId);
    keywordNames.add(s.keywordName);
  }
  const priorSnapshots = (campaignIds.size === 0 || keywordNames.size === 0)
    ? []
    : await db.select({
        id: heatmapSnapshots.id,
        campaignId: heatmapSnapshots.campaignId,
        keywordName: heatmapSnapshots.keywordName,
        reportDate: heatmapSnapshots.reportDate,
        shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
      })
        .from(heatmapSnapshots)
        .where(and(
          eq(heatmapSnapshots.clientId, clientId),
          inArray(heatmapSnapshots.campaignId, Array.from(campaignIds)),
          inArray(heatmapSnapshots.keywordName, Array.from(keywordNames)),
        ))
        .orderBy(desc(heatmapSnapshots.reportDate));

  const currentSnapshotIdSet = new Set(allSnapshotIds);
  const priorByTriple = new Map<string, typeof priorSnapshots[number]>();
  for (const ps of priorSnapshots) {
    if (currentSnapshotIdSet.has(ps.id)) continue;
    const k = `${ps.campaignId}::${ps.keywordName}`;
    if (!tripleKeys.has(k)) continue;
    if (!priorByTriple.has(k)) priorByTriple.set(k, ps);
  }

  const priorSnapshotIds = Array.from(priorByTriple.values()).map((p) => p.id);
  const priorMetricsBySnapshotId = priorSnapshotIds.length === 0
    ? new Map<string, { avgRank: number | null }>()
    : new Map(
        (await db.select({
          snapshotId: heatmapMetrics.snapshotId,
          avgRank: heatmapMetrics.avgRank,
        })
          .from(heatmapMetrics)
          .where(inArray(heatmapMetrics.snapshotId, priorSnapshotIds)))
          .map((m) => [m.snapshotId, m]),
      );

  // 3) SoV trends. Task #2695 added a per-(campaignId, keyword) trend for
  //    the keyword-pill sync, which quietly reintroduced the per-unit query
  //    fan-out this bulk helper exists to prevent (one `getClientSovTrend`
  //    round trip per keyword — Task #1810's query-budget test trips as soon
  //    as a handful of keywords exist). Batch instead: ONE SELECT over every
  //    touched campaign within the trend window, then group in JS via the
  //    same `buildSovTrendSeries` used by `getClientSovTrend`. Keyword
  //    matching mirrors `keywordNameMatchesSql` by comparing
  //    `normalizeKeyword` on both sides.
  const TREND_MONTHS = 6;
  const trendCutoff = new Date(Date.now() - TREND_MONTHS * 30 * 24 * 60 * 60 * 1000);
  const trendRows = campaignIds.size === 0 ? [] : await db.select({
    campaignId: heatmapSnapshots.campaignId,
    keywordName: heatmapSnapshots.keywordName,
    date: heatmapSnapshots.reportDate,
    sovRaw: heatmapSnapshots.shareOfVoiceRaw,
    sov90dAvg: heatmapMetrics.shareOfVoice90dAvg,
    anchorIncrease: heatmapMetrics.shareOfVoiceAnchorIncrease,
  })
    .from(heatmapSnapshots)
    .leftJoin(heatmapMetrics, eq(heatmapMetrics.snapshotId, heatmapSnapshots.id))
    .where(and(
      eq(heatmapSnapshots.clientId, clientId),
      inArray(heatmapSnapshots.campaignId, Array.from(campaignIds)),
      gte(heatmapSnapshots.reportDate, trendCutoff),
    ))
    .orderBy(heatmapSnapshots.reportDate, desc(heatmapSnapshots.id));

  const sovTrendByCampaign = new Map<string, Awaited<ReturnType<typeof getClientSovTrend>>>();
  const sovTrendByTriple = new Map<string, Awaited<ReturnType<typeof getClientSovTrend>>>();
  for (const cid of campaignIds) {
    sovTrendByCampaign.set(
      cid,
      buildSovTrendSeries(trendRows.filter((r) => r.campaignId === cid)),
    );
  }
  for (const tripleKey of tripleKeys) {
    const [cid, kw] = tripleKey.split("::");
    const normalizedKw = normalizeKeyword(kw);
    sovTrendByTriple.set(
      tripleKey,
      buildSovTrendSeries(trendRows.filter(
        (r) => r.campaignId === cid && normalizeKeyword(r.keywordName ?? "") === normalizedKw,
      )),
    );
  }

  // 4) Group per location with identical shape to the per-call helper.
  for (const { locationId, snapshotIds } of perLocation) {
    if (snapshotIds.length === 0) {
      out.set(locationId, {
        sovHistory: [], competitors: [], distributionBands: null, keywordSnapshots: [],
      });
      continue;
    }
    const locSnaps = snapshotIds
      .map((id) => snapshotById.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .sort((a, b) => b.reportDate.getTime() - a.reportDate.getTime());
    if (locSnaps.length === 0) {
      out.set(locationId, {
        sovHistory: [], competitors: [], distributionBands: null, keywordSnapshots: [],
      });
      continue;
    }
    const primary = locSnaps[0];
    const competitors = leaderboardsBySnapshot.get(primary.id) ?? [];
    const sovHistory = sovTrendByCampaign.get(primary.campaignId) ?? [];
    const primaryMetrics = metricsBySnapshotId.get(primary.id) ?? null;
    const distributionBands = primaryMetrics ? {
      bandTop3Pct: primaryMetrics.bandTop3Pct ?? 0,
      band4to10Pct: primaryMetrics.band4to10Pct ?? 0,
      band11to20Pct: primaryMetrics.band11to20Pct ?? 0,
      bandOutOfTop20Pct: primaryMetrics.bandOutOfTop20Pct ?? 0,
    } : null;

    const keywordSnapshots = locSnaps.map((s) => {
      const m = metricsBySnapshotId.get(s.id);
      const currentAvgRank = m?.avgRank ?? null;
      const currentSov = s.shareOfVoiceRaw;
      const prior = priorByTriple.get(`${s.campaignId}::${s.keywordName}`);
      let previousAvgRank: number | null = null;
      let rankChange: number | null = null;
      let sovChange: number | null = null;
      if (prior) {
        const priorM = priorMetricsBySnapshotId.get(prior.id);
        previousAvgRank = priorM?.avgRank ?? null;
        if (currentAvgRank !== null && previousAvgRank !== null) {
          rankChange = Math.round((previousAvgRank - currentAvgRank) * 100) / 100;
        }
        if (currentSov !== null && prior.shareOfVoiceRaw !== null) {
          sovChange = Math.round((currentSov - prior.shareOfVoiceRaw) * 100) / 100;
        }
      }
      const kwDistributionBands = m ? {
        bandTop3Pct: m.bandTop3Pct ?? 0,
        band4to10Pct: m.band4to10Pct ?? 0,
        band11to20Pct: m.band11to20Pct ?? 0,
        bandOutOfTop20Pct: m.bandOutOfTop20Pct ?? 0,
      } : null;
      const kwSovHistory = sovTrendByTriple.get(`${s.campaignId}::${s.keywordName}`) ?? [];
      return {
        keywordName: s.keywordName,
        snapshotId: s.id,
        reportDate: s.reportDate.toISOString().split("T")[0],
        shareOfVoice: currentSov,
        avgRank: currentAvgRank,
        previousAvgRank,
        rankChange,
        sovChange,
        distributionBands: kwDistributionBands,
        competitors: leaderboardsBySnapshot.get(s.id) ?? [],
        sovHistory: kwSovHistory,
      };
    });

    out.set(locationId, { sovHistory, competitors, distributionBands, keywordSnapshots });
  }

  return out;
}

export async function getLocalDominanceDataForReport(
  clientId: string,
  snapshotIds: string[]
): Promise<LocationLocalDominanceData> {
  if (snapshotIds.length === 0) {
    return { sovHistory: [], competitors: [], distributionBands: null, keywordSnapshots: [] };
  }

  const snapshots = await db.select({
    id: heatmapSnapshots.id,
    campaignId: heatmapSnapshots.campaignId,
    keywordName: heatmapSnapshots.keywordName,
    reportDate: heatmapSnapshots.reportDate,
    shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
  })
    .from(heatmapSnapshots)
    .where(inArray(heatmapSnapshots.id, snapshotIds))
    .orderBy(desc(heatmapSnapshots.reportDate));

  if (snapshots.length === 0) {
    return { sovHistory: [], competitors: [], distributionBands: null, keywordSnapshots: [] };
  }

  const primarySnapshot = snapshots[0];
  const campaignId = primarySnapshot.campaignId;

  const allMetricsRows = await db.select({
    snapshotId: heatmapMetrics.snapshotId,
    bandTop3Pct: heatmapMetrics.bandTop3Pct,
    band4to10Pct: heatmapMetrics.band4to10Pct,
    band11to20Pct: heatmapMetrics.band11to20Pct,
    bandOutOfTop20Pct: heatmapMetrics.bandOutOfTop20Pct,
    avgRank: heatmapMetrics.avgRank,
  })
    .from(heatmapMetrics)
    .where(inArray(heatmapMetrics.snapshotId, snapshotIds));

  const metricsMap = new Map(allMetricsRows.map(m => [m.snapshotId, m]));

  const [sovHistory, leaderboardsBySnapshot] = await Promise.all([
    getClientSovTrend(clientId, campaignId, undefined, 6),
    // Task #2015 — client-facing report path: suppress opaque `GBP <hash>` labels.
    buildCompetitorLeaderboardsForSnapshots(snapshotIds, { allowOpaqueFallback: false }),
  ]);

  const competitors = leaderboardsBySnapshot.get(primarySnapshot.id) ?? [];

  const primaryMetrics = metricsMap.get(primarySnapshot.id) || null;
  const distributionBands = primaryMetrics ? {
    bandTop3Pct: primaryMetrics.bandTop3Pct ?? 0,
    band4to10Pct: primaryMetrics.band4to10Pct ?? 0,
    band11to20Pct: primaryMetrics.band11to20Pct ?? 0,
    bandOutOfTop20Pct: primaryMetrics.bandOutOfTop20Pct ?? 0,
  } : null;

  const keywordNames = [...new Set(snapshots.map(s => s.keywordName))];
  const priorSnapshots = keywordNames.length > 0 ? await db.select({
    id: heatmapSnapshots.id,
    keywordName: heatmapSnapshots.keywordName,
    reportDate: heatmapSnapshots.reportDate,
    shareOfVoiceRaw: heatmapSnapshots.shareOfVoiceRaw,
  })
    .from(heatmapSnapshots)
    .where(and(
      eq(heatmapSnapshots.clientId, clientId),
      eq(heatmapSnapshots.campaignId, campaignId),
      inArray(heatmapSnapshots.keywordName, keywordNames),
    ))
    .orderBy(desc(heatmapSnapshots.reportDate)) : [];

  const priorByKeyword = new Map<string, typeof priorSnapshots[number]>();
  const currentSnapshotIds = new Set(snapshotIds);
  for (const ps of priorSnapshots) {
    if (currentSnapshotIds.has(ps.id)) continue;
    if (!priorByKeyword.has(ps.keywordName)) {
      priorByKeyword.set(ps.keywordName, ps);
    }
  }

  const priorSnapshotIds = [...priorByKeyword.values()].map(p => p.id);
  let priorMetricsMap = new Map<string, { avgRank: number | null }>();
  if (priorSnapshotIds.length > 0) {
    const priorMetrics = await db.select({
      snapshotId: heatmapMetrics.snapshotId,
      avgRank: heatmapMetrics.avgRank,
    })
      .from(heatmapMetrics)
      .where(inArray(heatmapMetrics.snapshotId, priorSnapshotIds));
    priorMetricsMap = new Map(priorMetrics.map(m => [m.snapshotId, m]));
  }

  // Per-keyword sov trends (one call per unique keyword — parallel).
  const sovTrendByKeyword = new Map<string, Awaited<ReturnType<typeof getClientSovTrend>>>();
  await Promise.all(keywordNames.map(async (kw) => {
    sovTrendByKeyword.set(kw, await getClientSovTrend(clientId, campaignId, kw, 6));
  }));

  const keywordSnapshots = snapshots.map(s => {
    const m = metricsMap.get(s.id);
    const currentAvgRank = m?.avgRank ?? null;
    const currentSov = s.shareOfVoiceRaw;

    const prior = priorByKeyword.get(s.keywordName);
    let previousAvgRank: number | null = null;
    let rankChange: number | null = null;
    let sovChange: number | null = null;

    if (prior) {
      const priorM = priorMetricsMap.get(prior.id);
      previousAvgRank = priorM?.avgRank ?? null;
      if (currentAvgRank !== null && previousAvgRank !== null) {
        rankChange = Math.round((previousAvgRank - currentAvgRank) * 100) / 100;
      }
      if (currentSov !== null && prior.shareOfVoiceRaw !== null) {
        sovChange = Math.round((currentSov - prior.shareOfVoiceRaw) * 100) / 100;
      }
    }

    const kwDistributionBands = m ? {
      bandTop3Pct: m.bandTop3Pct ?? 0,
      band4to10Pct: m.band4to10Pct ?? 0,
      band11to20Pct: m.band11to20Pct ?? 0,
      bandOutOfTop20Pct: m.bandOutOfTop20Pct ?? 0,
    } : null;

    return {
      keywordName: s.keywordName,
      snapshotId: s.id,
      reportDate: s.reportDate.toISOString().split("T")[0],
      shareOfVoice: currentSov,
      avgRank: currentAvgRank,
      previousAvgRank,
      rankChange,
      sovChange,
      distributionBands: kwDistributionBands,
      competitors: leaderboardsBySnapshot.get(s.id) ?? [],
      sovHistory: sovTrendByKeyword.get(s.keywordName) ?? [],
    };
  });

  return { sovHistory, competitors, distributionBands, keywordSnapshots };
}
