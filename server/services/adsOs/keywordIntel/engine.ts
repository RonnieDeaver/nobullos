/**
 * Keyword Intelligence engine: pull -> protect -> review -> enforce -> dedupe
 * (port of backend/app/keyword_intel/engine.py).
 *
 * Mirrors the audit engine: a 1-hour per-account cache, and a single
 * orchestrator that ties the read-only pulls, the per-client criteria, the
 * OpenAI review, and the deterministic safety filter together into a
 * KeywordIntelReport.
 */

import {
  AUDIT_CACHE_TTL_SECONDS,
  KI_BROAD_MIN_CONFIDENCE,
  KI_CAMPAIGN_LABEL,
  KI_LOOKBACK_DAYS,
  KI_MAX_TERMS,
  KI_MIN_CONFIDENCE,
  KI_MIN_CONFIDENCE_SOFT,
} from "../config";
import { deriveDefaults, effectiveCriteria, loadCriteria } from "../criteriaService";
import { enrolledAccounts, labeledCampaignIds, mccEnabledAccounts } from "../enrollment";
import { KeyedLocks } from "../singleflight";
import { loadTrafficQuality, saveTrafficQuality, snapshotEntryExpired } from "./kiStore";
import type { BlockedConvertingTerm, KeywordIntelReport } from "./models";
import { fetchData, type SearchTermRow } from "./queries";
import {
  brandTokensFromWebsite,
  buildGeoProtected,
  buildProtectedWords,
  dedupeNegatives,
  enforceSafety,
  merge,
  negativeBlocks,
} from "./safety";
import { suggestNegatives } from "./suggest";

function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Analyze EVERY search term in the window (highest-cost first, capped).
 *
 * No impression/volume floor and no "already-negated" skip — the model judges
 * all of them, including $0 terms (catch irrelevant ones before they spend) and
 * converting terms (a "conversion" can be a wrong-number call). search_term_view
 * only lists terms that actually served, so anything blocked by a working
 * negative is already absent. The only bound is KI_MAX_TERMS, which caps the
 * OpenAI payload at the highest-cost terms.
 */
function selectCandidates(terms: SearchTermRow[]): [SearchTermRow[], number] {
  const candidates = [...terms].sort((a, b) => b.cost - a.cost).slice(0, KI_MAX_TERMS);
  const reviewedCost = round2(candidates.reduce((s, t) => s + t.cost, 0));
  return [candidates, reviewedCost];
}

export async function runKeywordIntel(
  customerId: string,
  lookbackDays?: number | null,
): Promise<KeywordIntelReport> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || KI_LOOKBACK_DAYS;

  let accountName = cid;
  let currency: string | null = null;
  try {
    const acct = (await mccEnabledAccounts()).get(cid);
    if (acct) {
      accountName = acct.name;
      currency = acct.currency;
    }
  } catch {
    // Account-name lookup is cosmetic — an MCC listing failure must not block the run.
  }

  const ineligible = (note: string, campaigns = 0): KeywordIntelReport => ({
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    lookback_days: lookback,
    candidate_count: 0,
    reviewed_cost: 0,
    waste_terms: 0,
    wasted_spend: 0,
    suggestions: [],
    keyword_spend: 0,
    traffic_quality: null,
    coverage: null,
    eligible: false,
    monitored_campaigns: campaigns,
    scope_note: note,
    has_criteria: false,
    warnings: [],
    from_cache: false,
  });

  // Scope gate: only enrolled accounts are reviewed. Enrollment is the ClickUp Client
  // List (Google CID + Ads Status); the campaign-label filter below still applies.
  const enrolled = await enrolledAccounts("gads");
  if (!enrolled.some((a) => a.cid === cid)) {
    return ineligible(
      "This account isn't enrolled. Add it to the ClickUp Client List (a subtask " +
      "with this account's Google CID) to include it in the Search Term Analyzer.",
    );
  }
  const campaignIds = await labeledCampaignIds(cid, KI_CAMPAIGN_LABEL);
  if (!campaignIds.length) {
    return ineligible(
      `No campaigns carry the '${KI_CAMPAIGN_LABEL}' label in this ` +
      "account. Label the campaigns you want reviewed.",
    );
  }

  const data = await fetchData(cid, lookback, campaignIds);

  const { criteria: stored, hasSaved } = await loadCriteria(cid);
  const derived = deriveDefaults(accountName, data.geo_location_names);
  const crit = effectiveCriteria(stored, derived);

  const protectedWords = merge(
    buildProtectedWords(
      crit.business_name, crit.services_offered, crit.extra_protected_terms,
      data.active_keyword_texts, crit.practice_areas,
    ),
    brandTokensFromWebsite(crit.website),
  );
  const protectedGeo = buildGeoProtected(crit.service_area);
  const protectedAll = merge(protectedWords, protectedGeo);

  const [candidates, reviewedCost] = selectCandidates(data.search_terms);

  const report: KeywordIntelReport = {
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    lookback_days: lookback,
    candidate_count: candidates.length,
    reviewed_cost: reviewedCost,
    waste_terms: 0,
    wasted_spend: 0,
    suggestions: [],
    keyword_spend: data.keyword_spend,
    traffic_quality: null,
    coverage: null,
    eligible: true,
    monitored_campaigns: campaignIds.length,
    scope_note: `Reviewing ${campaignIds.length} labeled campaign(s).`,
    has_criteria: hasSaved,
    warnings: [...data.warnings],
    from_cache: false,
  };

  // Honesty signals so an incomplete review can't masquerade as clean traffic:
  // (1) the cost-cap silently drops the cheap long tail where junk often hides;
  const notReviewed = data.search_terms.length - candidates.length;
  if (notReviewed > 0) {
    report.warnings.push(
      `Reviewed the ${candidates.length} highest-cost search terms; ${notReviewed} ` +
      "lower-cost term(s) were not reviewed this run (raise KI_MAX_TERMS to include them).",
    );
  }
  // (2) saved-but-thin criteria mean the model is judging with little context.
  if (hasSaved && !(
    crit.practice_areas.length ||
    crit.services_not_offered.trim() ||
    crit.competitors.trim()
  )) {
    report.warnings.push(
      "Client criteria are sparse — add practice areas, services not offered, and " +
      "competitors to improve accuracy (the analyzer may miss wrong-service or competitor junk).",
    );
  }

  // Persist the latest traffic-quality summary for the dashboard (captured
  // every time the negatives tool runs). The pending suggested negatives ride
  // along so the New Keywords tool can hold back clashing suggestions — an
  // empty list is meaningful ("reviewed, nothing pending"), distinct from the
  // key being absent ("negatives never run for this account").
  //
  // Snapshots are kept PER LOOKBACK WINDOW ("negatives_by_window"): the tab's
  // auto-run at 7 days must not clobber a deliberate 30-day review (the finder
  // unions all windows). A run at window W supersedes stored entries at <= W
  // days (it re-reviewed everything they covered); larger-window entries are
  // kept until they expire. `incomplete` marks a run where some OpenAI batches
  // failed, so the finder can say its cross-check may be missing clashes.
  //
  // Serialized per account so two overlapping runs at different windows can't
  // each read the old doc and clobber the other's newly-persisted window entry
  // (whole-doc put, no transaction).
  const persistQuality = (incomplete = false): Promise<void> =>
    qualityLocks.withLock(cid, async () => {
      const byWindow: Record<string, any> = {};
      const prev = (await loadTrafficQuality(cid)) ?? {};
      let prevBy: Record<string, any>;
      if (prev.negatives_by_window && typeof prev.negatives_by_window === "object" &&
          !Array.isArray(prev.negatives_by_window)) {
        prevBy = prev.negatives_by_window;
      } else {
        // Migrate a pre-window (flat "negatives") snapshot into its window
        // entry so the first run under this shape doesn't drop it.
        prevBy = {};
        if (prev.negatives != null) {
          const pw = String(prev.lookback_days ?? "").trim();
          if (/^\d+$/.test(pw) && parseInt(pw, 10) > 0) {
            prevBy[String(parseInt(pw, 10))] = {
              negatives: prev.negatives,
              generated_at: prev.generated_at,
              incomplete: false,
            };
          }
        }
      }
      for (const [w, entry] of Object.entries(prevBy)) {
        const ws = String(w).trim();
        if (!/^-?\d+$/.test(ws)) continue;
        const wi = parseInt(ws, 10);
        if (wi <= lookback) continue; // superseded: this run covers that window
        if (snapshotEntryExpired((entry ?? {}).generated_at)) continue; // stale — a month-old review must not keep vetoing
        byWindow[String(wi)] = entry;
      }
      byWindow[String(lookback)] = {
        negatives: report.suggestions.map((s) => ({
          negative: s.negative,
          match_type: s.match_type,
          category: s.category,
          reason: s.reason,
        })),
        generated_at: report.generated_at,
        incomplete,
      };
      await saveTrafficQuality(cid, {
        traffic_quality: report.traffic_quality,
        coverage: report.coverage,
        lookback_days: lookback,
        reviewed_cost: reviewedCost,
        wasted_spend: report.wasted_spend,
        keyword_spend: data.keyword_spend,
        generated_at: report.generated_at,
        negatives_by_window: byWindow,
      });
    });

  if (!candidates.length) {
    // Eligible account, but no search terms served in the window — there's
    // nothing that could be wasteful, so traffic quality is a clean 100%.
    report.traffic_quality = 100.0;
    await persistQuality();
    return report;
  }

  const [raw, suggestWarnings] = await suggestNegatives(
    crit, candidates, protectedWords, protectedGeo, data.active_keyword_texts,
  );
  report.warnings.push(...suggestWarnings);
  // suggestNegatives only warns when review batches failed — that means the
  // suggestion list below is missing terms, and the persisted snapshot must
  // carry that so the finder's cross-check doesn't claim a full vetting.
  const reviewIncomplete = suggestWarnings.length > 0;
  const candidatesByTerm = new Map(candidates.map((t) => [t.search_term, t]));
  const safe = enforceSafety(raw, candidatesByTerm, protectedAll, {
    broadMinConf: KI_BROAD_MIN_CONFIDENCE,
    defaultMinConf: KI_MIN_CONFIDENCE,
    softMinConf: KI_MIN_CONFIDENCE_SOFT,
  });
  report.suggestions = dedupeNegatives(safe);

  // Cross-tool caution: flag any suggested negative that would also block a
  // CONVERTING search term (the New Keywords tool's raw material). The negative
  // still stands — a "conversion" can be a wrong-number call — but the team
  // should sanity-check the criteria call (usually the service area) before
  // adding it. Checked against ALL terms in the window, not just flagged ones:
  // a broad negative from one term can block a different, converting term.
  const converting = data.search_terms.filter((t) => t.conversions > 0);
  for (const sug of report.suggestions) {
    const hits = converting.filter((t) => negativeBlocks(sug.negative, sug.match_type, t.search_term));
    if (!hits.length) continue;
    hits.sort((a, b) => (b.conversions - a.conversions) || (b.cost - a.cost));
    sug.blocks_converting = hits.slice(0, 3).map((t): BlockedConvertingTerm => ({
      search_term: t.search_term,
      conversions: round2(t.conversions),
      cost: round2(t.cost),
      cpa: t.conversions ? round2(t.cost / t.conversions) : 0.0,
    }));
    sug.blocks_converting_more = Math.max(0, hits.length - 3);
  }

  // Waste metrics: distinct search terms that produced a suggestion, and the
  // spend on those terms (each term counted once, even if it yields several negs).
  const wasteByTerm = new Map(safe.map((sn) => [sn.term.search_term, sn.term]));
  report.waste_terms = wasteByTerm.size;
  report.wasted_spend = round2([...wasteByTerm.values()].reduce((s, t) => s + t.cost, 0));

  // Traffic quality = good (non-waste) share of analyzed search-term spend.
  // No wasteful terms found -> a clean 100% (also when the analyzed spend is 0,
  // which simply means there was nothing that could be wasteful).
  // coverage = how much of total keyword spend is even visible at the term level.
  if (reviewedCost > 0) {
    report.traffic_quality = round1((100 * (reviewedCost - report.wasted_spend)) / reviewedCost);
    report.coverage =
      data.keyword_spend > 0 ? round1((100 * reviewedCost) / data.keyword_spend) : null;
  } else {
    report.traffic_quality = 100.0;
  }
  await persistQuality(reviewIncomplete);
  return report;
}

// --- 1-hour per-account cache (same discipline as the audit engine) ---
const cache = new Map<string, { at: number; report: KeywordIntelReport }>();
const locks = new KeyedLocks(); // single-flight the OpenAI review per (cid, lookback)
const qualityLocks = new KeyedLocks(); // serialize the traffic-quality store RMW per cid

function cacheKey(cid: string, lookback: number): string {
  return `${cid}:${lookback}`;
}

export async function runKeywordIntelCached(
  customerId: string,
  lookbackDays?: number | null,
  force = false,
): Promise<{ report: KeywordIntelReport; fromCache: boolean }> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || KI_LOOKBACK_DAYS;
  const key = cacheKey(cid, lookback);
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): KeywordIntelReport | null => {
    const cached = cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  if (!force) {
    const report = hit();
    if (report !== null) return { report, fromCache: true };
  }
  // Single-flight: one caller builds (an OpenAI review + Ads pulls); duplicates wait.
  return locks.withLock(key, async () => {
    if (!force) {
      const report = hit();
      if (report !== null) return { report, fromCache: true };
    }
    const report = await runKeywordIntel(customerId, lookback);
    cache.set(key, { at: Date.now(), report });
    return { report, fromCache: false };
  });
}

/**
 * Drop this account's cached suggestions (all windows) so the next run uses
 * fresh criteria. Called when criteria are saved.
 */
export function invalidateKeywordIntel(customerId: string): void {
  const cid = customerId.replace(/-/g, "").trim();
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${cid}:`)) cache.delete(key);
  }
}

export function __testResetKeywordIntelCache(): void {
  cache.clear();
}
