/**
 * New-keyword finder (rules-based, no AI)
 * (port of backend/app/keyword_intel/keyword_finder.py).
 *
 * Surfaces converting search terms worth adding as keywords. The rule (per the
 * team): a term qualifies if it generated at least one conversion at a cost per
 * conversion AT or BELOW its campaign's average CPA over the window — and it
 * isn't already an active keyword. Unlike the negatives tool, this one *trusts*
 * conversions, since conversions are the whole signal here.
 *
 * Same enrollment gate (ClickUp Client List) and 1-hour cache discipline as the
 * rest of the analyzer.
 */

import {
  AUDIT_CACHE_TTL_SECONDS,
  KI_CAMPAIGN_LABEL,
  KI_KEYWORD_LOOKBACK_DAYS,
  KI_KEYWORD_MATCH_TYPE,
  KI_MIN_CONVERSIONS,
} from "../config";
import { enrolledAccounts, labeledCampaignIds, mccEnabledAccounts } from "../enrollment";
import { KeyedLocks } from "../singleflight";
import { loadActioned, loadTrafficQuality, snapshotEntryExpired } from "./kiStore";
import type { KeywordFinderReport, KeywordSuggestion } from "./models";
import { fetchKeywordFinderData, keywordTupleKey } from "./queries";
import { formatNegative, negativeBlocks } from "./safety";

/** Stable key for matching a marked-added suggestion across runs. */
export function normTerm(s: string): string {
  return String(s).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmtConv(x: number): string {
  return Number.isInteger(x) ? String(Math.trunc(x)) : String(Math.round(x * 10) / 10);
}

export async function runKeywordFinder(
  customerId: string,
  lookbackDays?: number | null,
): Promise<KeywordFinderReport> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || KI_KEYWORD_LOOKBACK_DAYS;

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

  const ineligible = (note: string): KeywordFinderReport => ({
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    lookback_days: lookback,
    converting_terms: 0,
    actioned_hidden: 0,
    account_blocked: 0,
    suggestions: [],
    conflicts: [],
    negatives_checked: false,
    negatives_generated_at: null,
    negatives_window_days: null,
    eligible: false,
    monitored_campaigns: 0,
    scope_note: note,
    warnings: [],
    from_cache: false,
  });

  // Same scope gate as the negatives tool.
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

  const data = await fetchKeywordFinderData(cid, lookback, campaignIds);
  // Canonicalize the configured match type: formatNegative() and any downstream
  // CSV column both expect lowercase broad/phrase/exact, so a stray case/typo in
  // KI_KEYWORD_MATCH_TYPE can't mis-bake the keyword. Fall back to the narrow default.
  let mt = KI_KEYWORD_MATCH_TYPE.trim().toLowerCase();
  if (mt !== "broad" && mt !== "phrase" && mt !== "exact") mt = "phrase";

  const suggestions: KeywordSuggestion[] = [];
  let accountBlocked = 0;
  for (const t of data.converting_terms) {
    if (t.conversions < KI_MIN_CONVERSIONS || t.conversions <= 0) continue;
    const campCpa = data.campaign_cpa.get(t.campaign_id) ?? 0.0;
    if (campCpa <= 0) continue; // no usable campaign baseline to compare against
    const termCpa = t.cost / t.conversions;
    if (termCpa > campCpa) continue; // not at/below the campaign average — skip
    if (data.active_keyword_keys.has(keywordTupleKey(t.search_term))) {
      continue; // already an active keyword
    }
    if (data.account_negatives.some(([text, negMt]) => negativeBlocks(text, negMt, t.search_term))) {
      // The account's own LIVE negatives block this term (e.g. the team
      // already added the negative the analyzer suggested) — a keyword
      // that can never serve isn't a recommendation. Counted for the UI.
      accountBlocked++;
      continue;
    }
    suggestions.push({
      keyword: formatNegative(t.search_term, mt),
      match_type: mt,
      search_term: t.search_term,
      campaign: t.campaign,
      ad_group: t.ad_group,
      conversions: round2(t.conversions),
      cost: round2(t.cost),
      cpa: round2(termCpa),
      campaign_cpa: round2(campCpa),
      reason:
        `${fmtConv(t.conversions)} conv at ` +
        `${round2(termCpa)} CPA vs campaign avg ${round2(campCpa)}`,
      blocked_by: "",
      blocked_category: "",
      blocked_reason: "",
    });
  }

  // Best first: most conversions, then lowest CPA.
  suggestions.sort((a, b) => (b.conversions - a.conversions) || (a.cpa - b.cpa));

  return {
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    lookback_days: lookback,
    converting_terms: data.converting_terms.length,
    actioned_hidden: 0,
    account_blocked: accountBlocked,
    suggestions,
    conflicts: [],
    negatives_checked: false,
    negatives_generated_at: null,
    negatives_window_days: null,
    eligible: true,
    monitored_campaigns: campaignIds.length,
    scope_note: `Reviewing ${campaignIds.length} labeled campaign(s).`,
    warnings: [...data.warnings],
    from_cache: false,
  };
}

// --- 1-hour per-account cache (same discipline as the other engines) ---
const cache = new Map<string, { at: number; report: KeywordFinderReport }>();
const locks = new KeyedLocks(); // single-flight the Ads pull per (cid, lookback)

export async function runKeywordFinderCached(
  customerId: string,
  lookbackDays?: number | null,
  force = false,
): Promise<{ report: KeywordFinderReport; fromCache: boolean }> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || KI_KEYWORD_LOOKBACK_DAYS;
  const key = `${cid}:${lookback}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const freshBase = (): KeywordFinderReport | null => {
    const cached = cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  let base = force ? null : freshBase();
  let fromCache = base !== null;
  if (base === null) {
    // Single-flight the base build; the actioned/cross-check overlay below still
    // runs live per request regardless of who built the base.
    const built = await locks.withLock(key, async () => {
      let inner = force ? null : freshBase();
      const innerFromCache = inner !== null;
      if (inner === null) {
        inner = await runKeywordFinder(customerId, lookback);
        cache.set(key, { at: Date.now(), report: inner });
      }
      return { inner, innerFromCache };
    });
    base = built.inner;
    fromCache = built.innerFromCache;
  }

  // Hide already-actioned ("added") suggestions, live each request — so a row
  // marked added stays gone without busting the cached metrics.
  const actioned = await loadActioned(cid);
  let kept = base.suggestions.filter((s) => !actioned.has(normTerm(s.search_term)));
  const actionedHidden = base.suggestions.length - kept.length;

  // Cross-check against the Negative Keywords tool (live each request, like the
  // actioned filter, so a fresh negatives run applies without busting this cache).
  // The negatives review is the side with client knowledge (service area,
  // competitors, services not offered), so it wins: a suggestion that a PENDING
  // suggested negative would block is held back into `conflicts`, visibly. If the
  // term is actually good business, fixing the criteria kills the negative on its
  // next run and the suggestion resurfaces here — the tools can't contradict.
  //
  // The snapshot is per lookback window (see engine's persistQuality): the union
  // of all fresh windows is checked, and honesty warnings cover the gaps — no
  // snapshot at all, a review window narrower than this report's, or a review
  // where some OpenAI batches failed.
  const quality = (await loadTrafficQuality(cid)) ?? {};
  let entries: [number, Record<string, any>][] = []; // (window_days, entry)
  const byWindow = quality.negatives_by_window;
  if (byWindow && typeof byWindow === "object" && !Array.isArray(byWindow)) {
    for (const [w, e] of Object.entries(byWindow)) {
      const ws = String(w).trim();
      if (!/^-?\d+$/.test(ws)) continue;
      entries.push([parseInt(ws, 10), (e as Record<string, any>) ?? {}]);
    }
  } else if (quality.negatives != null) {
    // Transitional: a pre-window snapshot (flat "negatives" key).
    const ws = String(quality.lookback_days ?? "0").trim();
    entries.push([/^-?\d+$/.test(ws) ? parseInt(ws, 10) : 0, {
      negatives: quality.negatives,
      generated_at: quality.generated_at,
      incomplete: false,
    }]);
  }
  entries = entries.filter(([, e]) => !snapshotEntryExpired(e.generated_at));

  const conflicts: KeywordSuggestion[] = [];
  const warnings = [...base.warnings];
  const negativesChecked = entries.length > 0;
  const negativesWindow = entries.reduce((m, [w]) => Math.max(m, w), 0);
  const generatedAts = entries
    .map(([, e]) => e.generated_at)
    .filter((g) => g != null && g !== "")
    .map((g) => String(g));
  const negativesGeneratedAt = generatedAts.length
    ? generatedAts.reduce((a, b) => (b > a ? b : a))
    : null;

  if (!negativesChecked) {
    // No usable snapshot (negatives tool never run, or only stale runs) — be
    // honest that these suggestions are unvetted rather than silently passing.
    if (kept.length) {
      warnings.push(
        "Not cross-checked against the Negative Keywords review yet — run that " +
        "tool once for this account so clashing suggestions can be held back.",
      );
    }
  } else {
    // Union of pending negatives across windows (largest window first; first
    // occurrence of a (negative, match type) pair keeps its category/reason).
    const pending: Record<string, any>[] = [];
    const seen = new Set<string>();
    for (const [, e] of [...entries].sort((a, b) => b[0] - a[0])) {
      const negs = Array.isArray(e.negatives) ? e.negatives : [];
      for (const n of negs) {
        const dedupeKey = `${String(n?.negative ?? "")}\u0000${String(n?.match_type ?? "")}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        pending.push(n ?? {});
      }
    }

    const remaining: KeywordSuggestion[] = [];
    for (const s of kept) {
      const hit = pending.find((n) =>
        negativeBlocks(String(n?.negative ?? ""), String(n?.match_type ?? ""), s.search_term),
      );
      if (hit === undefined) {
        remaining.push(s);
      } else {
        conflicts.push({
          ...s,
          blocked_by: String(hit.negative ?? ""),
          blocked_category: String(hit.category ?? ""),
          blocked_reason: String(hit.reason ?? ""),
        });
      }
    }
    kept = remaining;

    if (negativesWindow < lookback && (kept.length || conflicts.length)) {
      warnings.push(
        `The negatives review has only covered the last ${negativesWindow} day(s) — ` +
        `run the Negative Keywords tool at ${lookback} days to fully vet these ` +
        "suggestions.",
      );
    }
    if (entries.some(([, e]) => e.incomplete)) {
      warnings.push(
        "The latest negatives review was incomplete (some review batches failed), " +
        "so this cross-check may be missing clashes — re-run the Negative Keywords tool.",
      );
    }
  }

  const report: KeywordFinderReport = {
    ...base,
    suggestions: kept,
    actioned_hidden: actionedHidden,
    conflicts,
    negatives_checked: negativesChecked,
    negatives_generated_at: negativesGeneratedAt,
    negatives_window_days: negativesWindow || null,
    warnings,
  };
  return { report, fromCache };
}

export function __testResetKeywordFinderCache(): void {
  cache.clear();
}
