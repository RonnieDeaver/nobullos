/**
 * Task #4290 — privacy-mode location masking for public report payloads.
 *
 * Privacy mode (report.privacy_mode = true, or a `?private=true` share/preview
 * view) has always masked the firm identity ("Confidential Client") but leaked
 * identifying GEOGRAPHY: GBP location names, heatmap keyword phrases (which
 * embed city names), competitor firm names, and free-text mentions of any of
 * those in verdicts / common issues / next actions.
 *
 * This module is the single serve-time masker:
 *
 *   - `maskReportPayloadForPrivacy(payload, identity)` — mutates a fully-built
 *     public report payload (buildReportResponse output) in place:
 *       • GBP locations   → "Market A", "Market B"… (deterministic: stored
 *         array order, deduped by normalized name, so every slide that names
 *         the same location shows the same label)
 *       • keyword names   → "Keyword A", "Keyword B"… (payload-global dedupe)
 *       • competitor rows → "Competitor A"… ; rows flagged isSubjectBusiness
 *         become "Confidential Client"; locationLabel disambiguators → null
 *       • drops loc.heatmapImageUrl (baked map screenshot: pin label + tiles)
 *         and gbp.shared.blogPostUrl (links to the firm's own site)
 *       • free-text scrub: every string in the payload is swept for exact
 *         known identifiers (firm/contact/location/keyword/competitor names,
 *         word-boundary, case-insensitive) plus distinctive TOKENS of the
 *         location/firm/contact names (≥4 chars, stoplist-filtered) so prose
 *         like "Rankings improved across <City>" is caught too.
 *
 *   - `isSnapshotPrivacyBound(snapshotId)` — the public heatmap endpoints
 *     (`/api/public/heatmaps/:id/meta|geojson`, unauthenticated by design)
 *     ask whether a snapshot id appears in ANY privacy-mode report's
 *     marketing section. When bound — or when the check ERRORS (fail closed:
 *     a cosmetic over-mask beats a leak) — the endpoints serve masked
 *     snapshot meta / a masked business pin. 60s in-module TTL cache keeps
 *     this off the hot path.
 *
 * Deliberately NOT handled here (see audits/report-privacy-mode-checklist-2026-08.md):
 * map tiles/coordinates still show the real geography (out of scope per task —
 * a map of the market is the feature), and novel free-text geography that
 * never appears in any stored identifier cannot be scrubbed by exact match.
 *
 * Leaf module: imports db only; never imported by other services (routes only)
 * so it cannot create an import cycle.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const PRIVACY_MASKED_CLIENT_LABEL = "Confidential Client";
export const PRIVACY_MASKED_CONTACT_LABEL = "the client";

// ---------------------------------------------------------------------------
// Label alphabet: 0 → A, 25 → Z, 26 → AA …
// ---------------------------------------------------------------------------
function indexToLetters(i: number): string {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const normalizeIdentifier = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Generic tokens that must never be masked on their own: masking "north" or
 * "law" would garble ordinary prose without hiding anything. Includes the
 * mask vocabulary itself so replacements can never re-match each other.
 */
const TOKEN_STOPLIST = new Set([
  // geography/structure generics
  "north", "south", "east", "west", "downtown", "midtown", "uptown", "office",
  "offices", "location", "locations", "suite", "street", "avenue", "road",
  "boulevard", "drive", "lane", "highway", "county", "city", "metro", "area",
  "greater", "central", "main", "valley", "heights", "park", "lake", "beach",
  // legal-vertical generics
  "law", "laws", "legal", "firm", "firms", "group", "associates", "partners",
  "attorney", "attorneys", "lawyer", "lawyers", "injury", "accident",
  "compensation", "defense", "justice", "trial", "counsel", "advocates",
  "llc", "llp", "pllc", "ltd", "inc", "office", "practice",
  // mask vocabulary (prevents replacement output re-matching)
  "market", "keyword", "competitor", "confidential", "client",
]);

/** Exact-UUID strings are opaque ids (snapshot ids, row ids) — never scrub. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Replacement {
  /** Original identifier (or token), longest applied first. */
  real: string;
  label: string;
  re: RegExp;
}

function buildReplacement(real: string, label: string): Replacement {
  // Word-boundary via lookaround so "Chicago's" and "(Chicago)" match but
  // letters inside longer words / UUID segments do not.
  return {
    real,
    label,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(real)}(?![A-Za-z0-9])`, "gi"),
  };
}

interface MaskingPlan {
  locationLabels: Map<string, string>;
  keywordLabels: Map<string, string>;
  competitorLabels: Map<string, string>;
  /** Phrase + token replacements, phrases longest-first then tokens. */
  replacements: Replacement[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** marketing gbp location arrays across current + legacy shapes, in order. */
function marketingLocationArrays(sections: Array<{ sectionKey: string; data: unknown }>): Array<Record<string, unknown>[]> {
  const out: Array<Record<string, unknown>[]> = [];
  for (const section of sections) {
    if (section.sectionKey !== "marketing" || !isRecord(section.data)) continue;
    const data = section.data;
    const gbp = isRecord(data.gbp) ? data.gbp : undefined;
    if (gbp && Array.isArray(gbp.locations)) out.push(gbp.locations.filter(isRecord));
    if (Array.isArray(data.gbpLocations)) out.push(data.gbpLocations.filter(isRecord));
  }
  return out;
}

function competitorArraysOf(localDominance: unknown): Array<Record<string, unknown>[]> {
  if (!isRecord(localDominance)) return [];
  const out: Array<Record<string, unknown>[]> = [];
  if (Array.isArray(localDominance.competitors)) out.push(localDominance.competitors.filter(isRecord));
  if (Array.isArray(localDominance.keywordSnapshots)) {
    for (const kw of localDominance.keywordSnapshots) {
      if (isRecord(kw) && Array.isArray(kw.competitors)) out.push(kw.competitors.filter(isRecord));
    }
  }
  return out;
}

function buildMaskingPlan(
  sections: Array<{ sectionKey: string; data: unknown }>,
  identity: { firmName: string | null; contactName: string | null },
): MaskingPlan {
  const locationLabels = new Map<string, string>();
  const keywordLabels = new Map<string, string>();
  const competitorLabels = new Map<string, string>();
  // Token → label of the FIRST identifier that contributed it.
  const tokenLabels = new Map<string, string>();
  const phrases: Replacement[] = [];

  const addTokensOf = (name: string, label: string): void => {
    for (const rawToken of name.split(/[^A-Za-z0-9]+/)) {
      const token = rawToken.toLowerCase();
      if (token.length < 4) continue;
      if (/^\d+$/.test(rawToken)) continue;
      if (TOKEN_STOPLIST.has(token)) continue;
      if (!tokenLabels.has(token)) tokenLabels.set(token, label);
    }
  };

  const addPhrase = (real: string, label: string): void => {
    const trimmed = real.trim();
    if (trimmed.length < 3) return;
    phrases.push(buildReplacement(trimmed, label));
  };

  // Locations first: their order defines Market A/B…, and their tokens are
  // the highest-value scrub targets (city names).
  for (const locations of marketingLocationArrays(sections)) {
    for (const loc of locations) {
      if (typeof loc.name !== "string" || loc.name.trim().length === 0) continue;
      const norm = normalizeIdentifier(loc.name);
      if (!locationLabels.has(norm)) {
        const label = `Market ${indexToLetters(locationLabels.size)}`;
        locationLabels.set(norm, label);
        addPhrase(loc.name, label);
        addTokensOf(loc.name, label);
      }
    }
  }

  // Keywords: payload-global dedupe so the same phrase gets one label in
  // every location it appears under.
  for (const locations of marketingLocationArrays(sections)) {
    for (const loc of locations) {
      const ld = loc.localDominance;
      if (!isRecord(ld) || !Array.isArray(ld.keywordSnapshots)) continue;
      for (const kw of ld.keywordSnapshots) {
        if (!isRecord(kw) || typeof kw.keywordName !== "string" || kw.keywordName.trim().length === 0) continue;
        const norm = normalizeIdentifier(kw.keywordName);
        if (!keywordLabels.has(norm)) {
          const label = `Keyword ${indexToLetters(keywordLabels.size)}`;
          keywordLabels.set(norm, label);
          // Whole phrase only — keyword tokens are dominated by generic legal
          // vocabulary; the geographic token inside them is usually shared
          // with a location name and covered above.
          addPhrase(kw.keywordName, label);
        }
      }
    }
  }

  // Competitors: other firms' names still identify the market.
  for (const locations of marketingLocationArrays(sections)) {
    for (const loc of locations) {
      for (const competitors of competitorArraysOf(loc.localDominance)) {
        for (const comp of competitors) {
          if (typeof comp.name !== "string" || comp.name.trim().length === 0) continue;
          if (comp.isSubjectBusiness === true) continue; // masked to the client label instead
          const norm = normalizeIdentifier(comp.name);
          if (!competitorLabels.has(norm)) {
            const label = `Competitor ${indexToLetters(competitorLabels.size)}`;
            competitorLabels.set(norm, label);
            addPhrase(comp.name, label);
          }
        }
      }
    }
  }

  if (identity.firmName && identity.firmName.trim().length >= 3) {
    addPhrase(identity.firmName, PRIVACY_MASKED_CLIENT_LABEL);
    addTokensOf(identity.firmName, PRIVACY_MASKED_CLIENT_LABEL);
  }
  if (identity.contactName && identity.contactName.trim().length >= 3) {
    addPhrase(identity.contactName, PRIVACY_MASKED_CONTACT_LABEL);
    addTokensOf(identity.contactName, PRIVACY_MASKED_CONTACT_LABEL);
  }

  // Longest phrase first so "Chicago North Office" wins over the "chicago"
  // token; tokens run after every phrase.
  phrases.sort((a, b) => b.real.length - a.real.length);
  const tokenReplacements: Replacement[] = [];
  for (const [token, label] of tokenLabels) {
    tokenReplacements.push(buildReplacement(token, label));
  }

  return {
    locationLabels,
    keywordLabels,
    competitorLabels,
    replacements: [...phrases, ...tokenReplacements],
  };
}

function maskCompetitorRow(comp: Record<string, unknown>, plan: MaskingPlan): void {
  if (comp.isSubjectBusiness === true) {
    comp.name = PRIVACY_MASKED_CLIENT_LABEL;
  } else if (typeof comp.name === "string") {
    comp.name = plan.competitorLabels.get(normalizeIdentifier(comp.name)) ?? "Competitor";
  }
  // Read-time-derived city disambiguator (competitor-location-labels) — a
  // bare identifying city string; the client renders nothing when null.
  if ("locationLabel" in comp) comp.locationLabel = null;
}

function maskLocalDominance(localDominance: unknown, plan: MaskingPlan): void {
  if (!isRecord(localDominance)) return;
  if (Array.isArray(localDominance.keywordSnapshots)) {
    for (const kw of localDominance.keywordSnapshots) {
      if (!isRecord(kw)) continue;
      if (typeof kw.keywordName === "string") {
        kw.keywordName = plan.keywordLabels.get(normalizeIdentifier(kw.keywordName)) ?? "Keyword";
      }
    }
  }
  for (const competitors of competitorArraysOf(localDominance)) {
    for (const comp of competitors) maskCompetitorRow(comp, plan);
  }
}

/**
 * Deep string scrub — walks every string VALUE in the payload and applies the
 * plan's replacements. Object keys are left alone (no payload map is keyed by
 * an identifying name; the route-level test's stringify sweep would catch one
 * appearing). Exact-UUID strings are skipped so a pathological identifier can
 * never corrupt snapshot/row ids.
 */
function scrubStringsInPlace(value: unknown, plan: MaskingPlan, seen: Set<object>): unknown {
  if (typeof value === "string") {
    if (value.length === 0 || UUID_RE.test(value)) return value;
    let out = value;
    for (const { re, label } of plan.replacements) {
      re.lastIndex = 0;
      out = out.replace(re, label);
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      value[i] = scrubStringsInPlace(value[i], plan, seen);
    }
    return value;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) {
      value[key] = scrubStringsInPlace(value[key], plan, seen);
    }
    return value;
  }
  return value;
}

export interface PrivacyMaskingSummary {
  locations: number;
  keywords: number;
  competitors: number;
  scrubPatterns: number;
}

/**
 * Mask a fully-built public report payload in place. Call AFTER every other
 * sanitizer (active-products filter, marketing allowlist, localDominance
 * rehydration, seasonalTrends embed) so the scrub sees exactly what will be
 * served. Pure DB-free transform; never throws on malformed shapes — unknown
 * structures simply pass through the string scrub.
 */
export function maskReportPayloadForPrivacy(
  payload: Record<string, unknown>,
  identity: { firmName: string | null; contactName: string | null },
): PrivacyMaskingSummary {
  const sections = Array.isArray(payload.sections)
    ? (payload.sections as Array<{ sectionKey: string; data: unknown }>)
    : [];

  const plan = buildMaskingPlan(sections, identity);

  // Structural pass: canonical fields get their deterministic labels.
  for (const locations of marketingLocationArrays(sections)) {
    for (const loc of locations) {
      if (typeof loc.name === "string") {
        loc.name = plan.locationLabels.get(normalizeIdentifier(loc.name)) ?? "Market";
      }
      // Baked map screenshot: tile labels + pin caption identify the city.
      delete loc.heatmapImageUrl;
      maskLocalDominance(loc.localDominance, plan);
    }
  }
  for (const section of sections) {
    if (section.sectionKey !== "marketing" || !isRecord(section.data)) continue;
    const gbp = isRecord(section.data.gbp) ? section.data.gbp : undefined;
    if (gbp && isRecord(gbp.shared)) {
      // Links to the firm's own blog — identifying by definition.
      delete gbp.shared.blogPostUrl;
    }
  }

  // Free-text pass over the WHOLE payload (sections, slideVerdicts,
  // seasonalTrends.aiAnalysis, ceoPulse letter, next actions, …).
  scrubStringsInPlace(payload, plan, new Set());

  return {
    locations: plan.locationLabels.size,
    keywords: plan.keywordLabels.size,
    competitors: plan.competitorLabels.size,
    scrubPatterns: plan.replacements.length,
  };
}

// ---------------------------------------------------------------------------
// Public heatmap endpoint guard
// ---------------------------------------------------------------------------

const SNAPSHOT_PRIVACY_CACHE_TTL_MS = 60_000;
const SNAPSHOT_PRIVACY_CACHE_MAX = 500;
const snapshotPrivacyCache = new Map<string, { bound: boolean; at: number }>();

export function __resetSnapshotPrivacyCacheForTest(): void {
  snapshotPrivacyCache.clear();
}
registerModuleStateResetForTest(
  "reportPrivacyMasking.snapshotPrivacyCache",
  __resetSnapshotPrivacyCacheForTest,
);

/**
 * Is this heatmap snapshot referenced by ANY privacy-mode report's marketing
 * section? The public heatmap endpoints are unauthenticated (shared reports
 * fetch them from the browser), so this is the only signal that their
 * responses must be masked.
 *
 * FAIL-CLOSED: on any DB error this returns true (mask). A transiently
 * over-masked map label on a normal share is cosmetic; a leaked city name on
 * a privacy share defeats the feature. Errors are logged loudly and NOT
 * cached, so the next request re-probes.
 */
export async function isSnapshotPrivacyBound(snapshotId: string): Promise<boolean> {
  const hit = snapshotPrivacyCache.get(snapshotId);
  const now = Date.now();
  if (hit && now - hit.at < SNAPSHOT_PRIVACY_CACHE_TTL_MS) return hit.bound;
  try {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM reports r
        JOIN report_sections rs ON rs.report_id = r.id
        WHERE r.privacy_mode = true
          AND rs.section_key = 'marketing'
          AND rs.data::text LIKE ${"%" + snapshotId + "%"}
      ) AS bound
    `);
    const bound = (result as unknown as { rows: Array<{ bound?: unknown }> }).rows?.[0]?.bound === true;
    if (snapshotPrivacyCache.size >= SNAPSHOT_PRIVACY_CACHE_MAX) {
      const oldest = snapshotPrivacyCache.keys().next().value;
      if (oldest !== undefined) snapshotPrivacyCache.delete(oldest);
    }
    snapshotPrivacyCache.set(snapshotId, { bound, at: now });
    return bound;
  } catch (err) {
    console.error(
      `[reportPrivacyMasking] privacy-bound check failed for snapshot ${snapshotId} — failing CLOSED (masking):`,
      err,
    );
    return true;
  }
}

/**
 * Masked copy of a public snapshot-meta row: every naming/vendor-reference
 * field nulled; coordinates and grid geometry kept (the map cannot render
 * without them — documented residual, see checklist).
 */
export function maskPublicSnapshotMetaForPrivacy<T extends Record<string, unknown>>(snapshot: T): T {
  return {
    ...snapshot,
    locationName: null,
    businessName: null,
    keywordName: null,
    locationId: null,
    campaignId: null,
    keywordId: null,
    clientId: null,
  };
}

/**
 * Masked copy of a served GeoJSON collection: the business pin's `name`
 * property (rendered as an on-map text label) becomes the confidential
 * label. Cells carry no text; coordinates stay (they ARE the map). Never
 * mutates the input — the service may hand back a cache-derived object.
 */
export function maskPublicGeoJSONForPrivacy<T extends { features?: unknown }>(geojson: T): T {
  if (!geojson || !Array.isArray(geojson.features)) return geojson;
  return {
    ...geojson,
    features: geojson.features.map((f: unknown) => {
      if (!isRecord(f) || !isRecord(f.properties) || f.properties.type !== "business") return f;
      return { ...f, properties: { ...f.properties, name: PRIVACY_MASKED_CLIENT_LABEL } };
    }),
  };
}
